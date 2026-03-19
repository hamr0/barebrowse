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
 * Retry-once wrapper with per-attempt timeout.
 * On transient failure (CDP death OR timeout), resets session and retries once.
 * @param {Function} fn - async function to execute
 * @param {number} timeoutMs - per-attempt timeout in ms
 */
async function withRetry(fn, timeoutMs) {
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
    // Transient failure — reset session and retry once
    _page = null;
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


const TOOLS = [
  {
    name: 'browse',
    description: 'Browse a URL in a real browser. Use instead of web fetch when the page needs JavaScript, login cookies, consent dismissal, or bot detection. Returns a pruned ARIA snapshot with [ref=N] markers for interaction. Stateless — does not use the session page.',
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
    description: 'Navigate the session page to a URL. Injects cookies from the user\'s browser for authenticated access. Returns ok — call snapshot to observe.',
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
];

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
    }, 30000);
    case 'snapshot': return withRetry(async () => {
      const page = await getPage();
      const text = await page.snapshot();
      const limit = args.maxChars ?? MAX_CHARS_DEFAULT;
      if (text.length > limit) {
        const file = saveSnapshot(text);
        return `Snapshot (${text.length} chars) saved to ${file}`;
      }
      return text;
    }, 30000);
    case 'click': return withRetry(async () => {
      const page = await getPage();
      await page.click(args.ref);
      return 'ok';
    }, 30000);
    case 'type': return withRetry(async () => {
      const page = await getPage();
      await page.type(args.ref, args.text, { clear: args.clear });
      return 'ok';
    }, 30000);
    case 'press': return withRetry(async () => {
      const page = await getPage();
      await page.press(args.key);
      return 'ok';
    }, 30000);
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
    }, 30000);
    case 'back': return withRetry(async () => {
      const page = await getPage();
      await page.goBack();
      return 'ok';
    }, 30000);
    case 'forward': return withRetry(async () => {
      const page = await getPage();
      await page.goForward();
      return 'ok';
    }, 30000);
    case 'drag': return withRetry(async () => {
      const page = await getPage();
      await page.drag(args.fromRef, args.toRef);
      return 'ok';
    }, 30000);
    case 'upload': return withRetry(async () => {
      const page = await getPage();
      await page.upload(args.ref, args.files);
      return 'ok';
    }, 30000);
    case 'pdf': return withRetry(async () => {
      const page = await getPage();
      return await page.pdf({ landscape: args.landscape });
    }, 30000);
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
process.on('unhandledRejection', (err) => {
  _page = null;
});
process.on('uncaughtException', (err) => {
  _page = null;
});

// Clean up on exit
process.on('SIGINT', async () => {
  if (_page) await _page.close().catch(() => {});
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (_page) await _page.close().catch(() => {});
  process.exit(0);
});
