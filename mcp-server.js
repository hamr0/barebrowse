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

let _page = null;

async function getPage() {
  if (!_page) _page = await connect({ mode: 'hybrid' });
  return _page;
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
    inputSchema: { type: 'object', properties: {} },
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
    description: 'Scroll the page. Positive deltaY scrolls down, negative scrolls up. Returns ok.',
    inputSchema: {
      type: 'object',
      properties: {
        deltaY: { type: 'number', description: 'Pixels to scroll (positive=down, negative=up)' },
      },
      required: ['deltaY'],
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

async function handleToolCall(name, args) {
  switch (name) {
    case 'browse':
      return await browse(args.url, { mode: args.mode });

    case 'goto': {
      const page = await getPage();
      try { await page.injectCookies(args.url); } catch {}
      await page.goto(args.url);
      return 'ok';
    }
    case 'snapshot': {
      const page = await getPage();
      return await page.snapshot();
    }
    case 'click': {
      const page = await getPage();
      await page.click(args.ref);
      return 'ok';
    }
    case 'type': {
      const page = await getPage();
      await page.type(args.ref, args.text, { clear: args.clear });
      return 'ok';
    }
    case 'press': {
      const page = await getPage();
      await page.press(args.key);
      return 'ok';
    }
    case 'scroll': {
      const page = await getPage();
      await page.scroll(args.deltaY);
      return 'ok';
    }
    case 'back': {
      const page = await getPage();
      await page.goBack();
      return 'ok';
    }
    case 'forward': {
      const page = await getPage();
      await page.goForward();
      return 'ok';
    }
    case 'drag': {
      const page = await getPage();
      await page.drag(args.fromRef, args.toRef);
      return 'ok';
    }
    case 'upload': {
      const page = await getPage();
      await page.upload(args.ref, args.files);
      return 'ok';
    }
    case 'pdf': {
      const page = await getPage();
      return await page.pdf({ landscape: args.landscape });
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
      serverInfo: { name: 'barebrowse', version: '0.4.2' },
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
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;

    try {
      const msg = JSON.parse(line);
      const response = await handleMessage(msg);
      if (response) {
        process.stdout.write(response + '\n');
      }
    } catch (err) {
      process.stdout.write(jsonrpcError(null, -32700, `Parse error: ${err.message}`) + '\n');
    }
  }
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
