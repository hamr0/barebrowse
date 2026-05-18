#!/usr/bin/env node
/**
 * mcp-server.js — MCP server for barebrowse.
 *
 * Raw JSON-RPC 2.0 over stdio. No SDK dependency.
 * 12 tools: browse, goto, snapshot, click, type, press, scroll, back, forward, drag, upload, pdf.
 *
 * Session tools share a singleton page, lazy-created on first use.
 * Action tools return 'ok' — agent calls snapshot explicitly to observe.
 */

import { browse, connect } from './src/index.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Per-tool timeouts (ms). One blanket 30s was too short for SPA cold loads
 * (goto regularly exceeded it on slow sites) and too long for instant ops
 * like scroll. The split below is the H5 plan:
 *   - navigation (goto/reload): 60s
 *   - browser-history nav (back/forward): 30s
 *   - interactive ops (click/type/press/scroll/hover/select/drag): 15s
 *   - read-only ops (snapshot/tabs/eval/wait_for): 15s (wait_for has its own
 *     internal deadline; this is the outer cap)
 *   - heavy I/O (pdf/screenshot/upload): 45s
 * Exported so tests can pin the contract.
 */
export const TIMEOUTS = {
  goto: 60000,
  reload: 60000,
  back: 30000,
  forward: 30000,
  snapshot: 15000,
  click: 15000,
  type: 15000,
  press: 15000,
  scroll: 15000,
  hover: 15000,
  select: 15000,
  drag: 15000,
  tabs: 5000,
  eval: 15000,
  wait_for: 60000,
  upload: 45000,
  pdf: 45000,
  screenshot: 45000,
};

// Optional: privacy assessment via wearehere
let assessFn = null;
try {
  ({ assess: assessFn } = await import('wearehere'));
} catch {}


function isTransient(err) {
  const m = err.message || '';
  return m.includes('WebSocket') || m.includes('Target closed') || m.includes('Session closed')
    || m.includes('CDP') || m.includes('Timeout waiting for CDP event') || m.includes('timed out');
}

/**
 * Run fn with a per-attempt timeout. On transient failure (CDP death OR
 * timeout), reset the session. If `retry` is true (default), retry once on
 * a fresh page; if false, rethrow without retrying — required for
 * non-idempotent ops (click/type/etc.) where a partial first attempt
 * shouldn't be replayed against a blank fresh page.
 * @param {Function} fn - async function to execute
 * @param {number} timeoutMs - per-attempt timeout in ms
 * @param {object} [opts]
 * @param {boolean} [opts.retry=true] - whether to retry once on transient failure
 */
async function withRetry(fn, timeoutMs, { retry = true } = {}) {
  async function attempt() {
    if (!timeoutMs) return await fn();
    let timer;
    const result = await Promise.race([
      fn(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs); }),
    ]);
    clearTimeout(timer);
    return result;
  }

  try {
    return await attempt();
  } catch (err) {
    if (!isTransient(err)) throw err;
    // Transient failure — reset session so the next request gets a fresh page.
    _page = null;
    if (!retry) throw err;
    return await attempt();
  }
}

const MAX_CHARS_DEFAULT = 30000;
const OUTPUT_DIR = join(process.cwd(), '.barebrowse');

function saveSnapshot(text) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(OUTPUT_DIR, `page-${ts}.yml`);
  writeFileSync(file, text);
  return file;
}

let _page = null;
let _pageConnecting = null;

async function getPage() {
  if (_page) return _page;
  if (_pageConnecting) return _pageConnecting;
  _pageConnecting = connect({ mode: 'hybrid' });
  try {
    _page = await _pageConnecting;
    return _page;
  } catch (err) {
    _page = null;
    throw err;
  } finally {
    _pageConnecting = null;
  }
}

// Concurrency limiter — one assess at a time.
// Headless tabs are fast, but headed fallback uses the user's single browser.
// Running multiple headed navigations simultaneously hangs the browser.
let _assessLock = Promise.resolve();

function acquireAssessSlot() {
  let release;
  const prev = _assessLock;
  _assessLock = new Promise((r) => { release = r; });
  return prev.then(() => release);
}


export const TOOLS = [
  {
    name: 'browse',
    description: 'One-shot headless browse — fetches a URL through a real browser (executes JS, injects cookies, dismisses consent, evades bot detection). Only when plain HTTP fetch can\'t render the page. Returns a pruned ARIA snapshot with [ref=N] markers. Stateless — for multi-step interaction use goto.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to browse' },
        mode: { type: 'string', enum: ['headless', 'headed', 'hybrid'], description: 'Browser mode (default: headless)' },
        maxChars: { type: 'number', description: 'Max chars to return inline. Larger snapshots are saved to .barebrowse/ and a file path is returned instead. Default: 30000.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'goto',
    description: 'Open URL in a persistent interactive browser session (pair with snapshot/click/type/press for multi-step flows). Use when the task needs clicking, typing, or form submission. Injects auth cookies. Returns ok — call snapshot to observe.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'snapshot',
    description: 'Get the current ARIA snapshot of the session page. Returns a YAML-like tree with [ref=N] markers on interactive elements.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Max chars to return inline. Larger snapshots are saved to .barebrowse/ and a file path is returned instead. Default: 30000.' },
      },
    },
  },
  {
    name: 'click',
    description: 'Click an element by its ref from the snapshot. Returns ok — call snapshot to observe.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from snapshot (e.g. "8")' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'type',
    description: 'Type text into an element by its ref. Returns ok — call snapshot to observe.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from snapshot' },
        text: { type: 'string', description: 'Text to type' },
        clear: { type: 'boolean', description: 'Clear existing content first (default: false)' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'press',
    description: 'Press a special key (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space). Returns ok.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name' },
      },
      required: ['key'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page up or down. Pass direction ("up"/"down") or a numeric deltaY. Returns ok.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction — "up" or "down" (scrolls ~3 screen-heights)' },
        deltaY: { type: 'number', description: 'Pixels to scroll (positive=down, negative=up). Overrides direction if both given.' },
      },
    },
  },
  {
    name: 'back',
    description: 'Go back in browser history. Returns ok.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'forward',
    description: 'Go forward in browser history. Returns ok.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'drag',
    description: 'Drag one element to another by refs from the snapshot. Returns ok.',
    inputSchema: {
      type: 'object',
      properties: {
        fromRef: { type: 'string', description: 'Source element ref' },
        toRef: { type: 'string', description: 'Target element ref' },
      },
      required: ['fromRef', 'toRef'],
    },
  },
  {
    name: 'upload',
    description: 'Upload files to a file input element by ref. Returns ok.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'File input element ref' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths' },
      },
      required: ['ref', 'files'],
    },
  },
  {
    name: 'pdf',
    description: 'Export current page as PDF. Returns base64-encoded PDF data.',
    inputSchema: {
      type: 'object',
      properties: {
        landscape: { type: 'boolean', description: 'Landscape orientation (default: false)' },
      },
    },
  },
  {
    name: 'reload',
    description: 'Reload the current page in the session. Returns ok — call snapshot to observe.',
    inputSchema: {
      type: 'object',
      properties: {
        ignoreCache: { type: 'boolean', description: 'Bypass HTTP cache (hard reload). Default: false.' },
      },
    },
  },
  {
    name: 'screenshot',
    description: 'Capture a screenshot of the current page. Saves to .barebrowse/screenshot-*.png (or .jpeg/.webp) and returns the file path. Use the file with your image tools.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Image format (default: png)' },
        quality: { type: 'number', description: 'JPEG/WebP quality 0-100 (default: 80, ignored for PNG)' },
      },
    },
  },
  {
    name: 'wait_for',
    description: 'Wait for visible text or a CSS selector to appear on the current page. Returns ok when found, throws on timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Substring that must appear in document.body.innerText' },
        selector: { type: 'string', description: 'CSS selector that must match document.querySelector' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' },
      },
    },
  },
  {
    name: 'tabs',
    description: 'List open tabs in the session, or switch to one by index. Returns JSON array of { index, url, title } or "ok" after switch.',
    inputSchema: {
      type: 'object',
      properties: {
        switchTo: { type: 'number', description: 'Tab index to activate. Omit to just list tabs.' },
      },
    },
  },
  {
    name: 'select',
    description: 'Set the value of a <select> dropdown (or custom listbox) by ref. Returns ok.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from snapshot' },
        value: { type: 'string', description: 'Option value or visible text to select' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'hover',
    description: 'Hover over an element by ref (triggers tooltips, hover menus). Returns ok.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from snapshot' },
      },
      required: ['ref'],
    },
  },
];

// Powerful escape hatch — guarded behind an explicit env-var opt-in.
// Runtime.evaluate in the user's authenticated session lets an agent read
// cookies/localStorage, dispatch arbitrary events, hit any endpoint, etc.
// Off by default; flip BAREBROWSE_MCP_EVAL=1 to enable.
if (process.env.BAREBROWSE_MCP_EVAL === '1') {
  TOOLS.push({
    name: 'eval',
    description: 'Run a JavaScript expression in the current page and return the result. POWERFUL: full access to the authenticated session — DOM, cookies, localStorage, fetch. Enabled because BAREBROWSE_MCP_EVAL=1 is set.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate' },
      },
      required: ['expression'],
    },
  });
}

// Add assess tool if wearehere is installed
if (assessFn) {
  TOOLS.push({
    name: 'assess',
    description: 'Privacy assessment of any website. Navigates to the URL, scans for cookies, trackers, fingerprinting, dark patterns, data brokers, form surveillance, link tracking, and toxic terms. Returns a compact JSON with risk score (0-100), per-category breakdown, and recommendation. Powered by wearehere.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to assess (e.g. "https://example.com")' },
        timeout: { type: 'number', description: 'Navigation timeout in ms (default: 30000)' },
        settle: { type: 'number', description: 'Time to wait for trackers to load after page load, in ms (default: 3000)' },
      },
      required: ['url'],
    },
  });
}

async function handleToolCall(name, args) {
  switch (name) {
    case 'browse': {
      let timer;
      const text = await Promise.race([
        browse(args.url, { mode: args.mode }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('browse timed out after 60s')), 60000); }),
      ]);
      clearTimeout(timer);
      const limit = args.maxChars ?? MAX_CHARS_DEFAULT;
      if (text.length > limit) {
        const file = saveSnapshot(text);
        return `Snapshot (${text.length} chars) saved to ${file}`;
      }
      return text;
    }
    case 'goto': return withRetry(async () => {
      const page = await getPage();
      try { await page.injectCookies(args.url); } catch {}
      await page.goto(args.url);
      return 'ok';
    }, TIMEOUTS.goto);
    case 'snapshot': return withRetry(async () => {
      const page = await getPage();
      const text = await page.snapshot();
      const limit = args.maxChars ?? MAX_CHARS_DEFAULT;
      if (text.length > limit) {
        const file = saveSnapshot(text);
        return `Snapshot (${text.length} chars) saved to ${file}`;
      }
      return text;
    }, TIMEOUTS.snapshot);
    case 'click': return withRetry(async () => {
      const page = await getPage();
      await page.click(args.ref);
      return 'ok';
    }, TIMEOUTS.click, { retry: false });
    case 'type': return withRetry(async () => {
      const page = await getPage();
      await page.type(args.ref, args.text, { clear: args.clear });
      return 'ok';
    }, TIMEOUTS.type, { retry: false });
    case 'press': return withRetry(async () => {
      const page = await getPage();
      await page.press(args.key);
      return 'ok';
    }, TIMEOUTS.press, { retry: false });
    case 'scroll': return withRetry(async () => {
      const page = await getPage();
      let dy = args.deltaY;
      if (dy == null && args.direction) {
        dy = args.direction === 'up' ? -900 : 900;
      }
      if (dy == null || typeof dy !== 'number') {
        throw new Error('scroll requires "direction" ("up"/"down") or numeric "deltaY"');
      }
      await page.scroll(dy);
      return 'ok';
    }, TIMEOUTS.scroll, { retry: false });
    case 'back': return withRetry(async () => {
      const page = await getPage();
      await page.goBack();
      return 'ok';
    }, TIMEOUTS.back, { retry: false });
    case 'forward': return withRetry(async () => {
      const page = await getPage();
      await page.goForward();
      return 'ok';
    }, TIMEOUTS.forward, { retry: false });
    case 'drag': return withRetry(async () => {
      const page = await getPage();
      await page.drag(args.fromRef, args.toRef);
      return 'ok';
    }, TIMEOUTS.drag, { retry: false });
    case 'upload': return withRetry(async () => {
      const page = await getPage();
      await page.upload(args.ref, args.files);
      return 'ok';
    }, TIMEOUTS.upload, { retry: false });
    case 'pdf': return withRetry(async () => {
      const page = await getPage();
      return await page.pdf({ landscape: args.landscape });
    }, TIMEOUTS.pdf);
    case 'reload': return withRetry(async () => {
      const page = await getPage();
      await page.reload({ ignoreCache: !!args.ignoreCache });
      return 'ok';
    }, TIMEOUTS.reload);
    case 'screenshot': return withRetry(async () => {
      const page = await getPage();
      const format = args.format || 'png';
      const b64 = await page.screenshot({ format, quality: args.quality });
      mkdirSync(OUTPUT_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(OUTPUT_DIR, `screenshot-${ts}.${format}`);
      writeFileSync(file, Buffer.from(b64, 'base64'));
      return file;
    }, TIMEOUTS.screenshot);
    case 'wait_for': return withRetry(async () => {
      const page = await getPage();
      await page.waitFor({ text: args.text, selector: args.selector, timeout: args.timeout });
      return 'ok';
    }, TIMEOUTS.wait_for, { retry: false });
    case 'tabs': return withRetry(async () => {
      const page = await getPage();
      if (typeof args.switchTo === 'number') {
        await page.switchTab(args.switchTo);
        return 'ok';
      }
      const list = await page.tabs();
      return JSON.stringify(list, null, 2);
    }, TIMEOUTS.tabs, { retry: false });
    case 'select': return withRetry(async () => {
      const page = await getPage();
      await page.select(args.ref, args.value);
      return 'ok';
    }, TIMEOUTS.select, { retry: false });
    case 'hover': return withRetry(async () => {
      const page = await getPage();
      await page.hover(args.ref);
      return 'ok';
    }, TIMEOUTS.hover, { retry: false });
    case 'eval': {
      // Only reachable when BAREBROWSE_MCP_EVAL=1 — the tool isn't registered
      // otherwise, but this guard is the second line of defense in case the
      // env var changes between tools/list and tools/call.
      if (process.env.BAREBROWSE_MCP_EVAL !== '1') {
        throw new Error('eval is disabled. Set BAREBROWSE_MCP_EVAL=1 to enable.');
      }
      return withRetry(async () => {
        const page = await getPage();
        const { result, exceptionDetails } = await page.cdp.send('Runtime.evaluate', {
          expression: args.expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (exceptionDetails) {
          throw new Error(exceptionDetails.text + (exceptionDetails.exception?.description ? `: ${exceptionDetails.exception.description}` : ''));
        }
        return result.value === undefined ? 'undefined' : JSON.stringify(result.value);
      }, TIMEOUTS.eval, { retry: false });
    }
    case 'assess': {
      if (!assessFn) throw new Error('wearehere is not installed. Run: npm install wearehere');
      const releaseSlot = await acquireAssessSlot();
      try {
        const page = await getPage();
        const tab = await page.createTab();
        let timer;
        try {
          await tab.injectCookies(args.url).catch(() => {});
          const result = await Promise.race([
            assessFn(tab, args.url, { timeout: args.timeout, settle: args.settle }),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('assess timeout')), 30000); }),
          ]);
          clearTimeout(timer);
          if (tab.botBlocked) {
            // Bot-blocked — trigger hybrid fallback via main page, retry in new tab
            await tab.close().catch(() => {});
            await page.goto(args.url);
            const tab2 = await page.createTab();
            let timer2;
            try {
              await tab2.injectCookies(args.url).catch(() => {});
              const r2 = await Promise.race([
                assessFn(tab2, args.url, { timeout: args.timeout, settle: args.settle }),
                new Promise((_, rej) => { timer2 = setTimeout(() => rej(new Error('assess timeout')), 30000); }),
              ]);
              clearTimeout(timer2);
              if (tab2.botBlocked) r2._warning = 'Bot-blocked in both modes. Score may be unreliable.';
              await tab2.close().catch(() => {});
              return JSON.stringify(r2, null, 2);
            } catch (err2) {
              clearTimeout(timer2);
              await tab2.close().catch(() => {});
              throw err2;
            }
          }
          await tab.close().catch(() => {});
          return JSON.stringify(result, null, 2);
        } catch (err) {
          clearTimeout(timer);
          await tab.close().catch(() => {});
          if (isTransient(err)) _page = null;
          throw err;
        }
      } finally {
        releaseSlot();
      }
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function jsonrpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonrpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return jsonrpcResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'barebrowse', version: '0.7.1' },
    });
  }

  if (method === 'notifications/initialized') {
    return null; // notification, no response
  }

  if (method === 'tools/list') {
    return jsonrpcResponse(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    try {
      const result = await handleToolCall(name, args || {});
      return jsonrpcResponse(id, {
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
      });
    } catch (err) {
      if (isTransient(err)) _page = null;
      return jsonrpcResponse(id, {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      });
    }
  }

  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}

// --- Stdio transport ---
//
// Guarded by isMain so tests can `import { TIMEOUTS } from 'mcp-server.js'`
// without spawning the stdin loop, exit handlers, or signal handlers — the
// loop would consume stdin meant for the test harness, the signal handlers
// would intercept Ctrl-C, and process.exit calls would kill the test process.

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;

    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line);

        handleMessage(msg).then((response) => {
          if (response) {
            process.stdout.write(response + '\n');
          }
        }).catch((err) => {
          process.stdout.write(jsonrpcError(msg.id, -32700, `Error: ${err.message}`) + '\n');
        });
      } catch (err) {
        process.stdout.write(jsonrpcError(null, -32700, `Parse error: ${err.message}`) + '\n');
      }
    }
  });

  // Prevent unhandled rejections and uncaught exceptions from crashing the server.
  // Browser OOM/crash rejects all pending CDP promises — some may not be awaited.
  process.on('unhandledRejection', () => { _page = null; });
  process.on('uncaughtException', () => { _page = null; });

  // Clean up on exit
  process.on('SIGINT', async () => {
    if (_page) await _page.close().catch(() => {});
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    if (_page) await _page.close().catch(() => {});
    process.exit(0);
  });
}
