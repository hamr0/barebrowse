/**
 * bareagent.js — Tool adapter for bareagent's Loop.
 *
 * Usage:
 *   import { createBrowseTools } from 'barebrowse/src/bareagent.js';
 *   const { tools, close } = createBrowseTools();
 *   const result = await loop.run(messages, tools);
 *   await close();
 *
 * Action tools auto-return a fresh snapshot so the LLM always sees the result.
 * 300ms settle delay after actions for DOM updates.
 */

import { browse, connect } from './index.js';

// Optional: privacy assessment via wearehere
let assessFn = null;
try {
  ({ assess: assessFn } = await import('wearehere'));
} catch {}

const SETTLE_MS = 300;
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

/**
 * Create bareagent-compatible browse tools.
 * @param {object} [opts] - Options passed to connect() for session tools
 * @returns {{ tools: Array, close: () => Promise<void> }}
 */
export function createBrowseTools(opts = {}) {
  let _page = null;

  async function getPage() {
    if (!_page) _page = await connect(opts);
    return _page;
  }

  async function actionAndSnapshot(fn) {
    const page = await getPage();
    await fn(page);
    await settle();
    return await page.snapshot();
  }

  const tools = [
    {
      name: 'browse',
      description: 'One-shot: navigate to a URL and return a pruned ARIA snapshot. Stateless.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to browse' },
        },
        required: ['url'],
      },
      execute: async ({ url }) => await browse(url, opts),
    },
    {
      name: 'goto',
      description: 'Navigate to a URL and return the page snapshot.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
        },
        required: ['url'],
      },
      execute: async ({ url }) => actionAndSnapshot((page) => page.goto(url)),
    },
    {
      name: 'snapshot',
      description: 'Get the current ARIA snapshot. Returns a YAML-like tree with [ref=N] markers on interactive elements.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const page = await getPage();
        return await page.snapshot();
      },
    },
    {
      name: 'click',
      description: 'Click an element by its ref from the snapshot. Returns the updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot' },
        },
        required: ['ref'],
      },
      execute: async ({ ref }) => actionAndSnapshot((page) => page.click(ref)),
    },
    {
      name: 'type',
      description: 'Type text into an element by its ref. Returns the updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot' },
          text: { type: 'string', description: 'Text to type' },
          clear: { type: 'boolean', description: 'Clear existing content first' },
        },
        required: ['ref', 'text'],
      },
      execute: async ({ ref, text, clear }) => actionAndSnapshot((page) => page.type(ref, text, { clear })),
    },
    {
      name: 'press',
      description: 'Press a special key (Enter, Tab, Escape, etc.). Returns the updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name (Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space)' },
        },
        required: ['key'],
      },
      execute: async ({ key }) => actionAndSnapshot((page) => page.press(key)),
    },
    {
      name: 'scroll',
      description: 'Scroll the page. Returns the updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          deltaY: { type: 'number', description: 'Pixels to scroll (positive=down, negative=up)' },
        },
        required: ['deltaY'],
      },
      execute: async ({ deltaY }) => actionAndSnapshot((page) => page.scroll(deltaY)),
    },
    {
      name: 'select',
      description: 'Select a value in a dropdown/select element. Returns the updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot' },
          value: { type: 'string', description: 'Value or visible text to select' },
        },
        required: ['ref', 'value'],
      },
      execute: async ({ ref, value }) => actionAndSnapshot((page) => page.select(ref, value)),
    },
    {
      name: 'hover',
      description: 'Hover over an element by its ref. Returns the updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot' },
        },
        required: ['ref'],
      },
      execute: async ({ ref }) => actionAndSnapshot((page) => page.hover(ref)),
    },
    {
      name: 'back',
      description: 'Go back in browser history. Returns the updated snapshot.',
      parameters: { type: 'object', properties: {} },
      execute: async () => actionAndSnapshot((page) => page.goBack()),
    },
    {
      name: 'forward',
      description: 'Go forward in browser history. Returns the updated snapshot.',
      parameters: { type: 'object', properties: {} },
      execute: async () => actionAndSnapshot((page) => page.goForward()),
    },
    {
      name: 'drag',
      description: 'Drag one element to another by their refs. Returns the updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          fromRef: { type: 'string', description: 'Source element ref' },
          toRef: { type: 'string', description: 'Target element ref' },
        },
        required: ['fromRef', 'toRef'],
      },
      execute: async ({ fromRef, toRef }) => actionAndSnapshot((page) => page.drag(fromRef, toRef)),
    },
    {
      name: 'upload',
      description: 'Upload files to a file input element. Returns the updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'File input element ref' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths' },
        },
        required: ['ref', 'files'],
      },
      execute: async ({ ref, files }) => actionAndSnapshot((page) => page.upload(ref, files)),
    },
    {
      name: 'tabs',
      description: 'List all open tabs. Returns JSON array of { index, url, title }.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const page = await getPage();
        const tabList = await page.tabs();
        return JSON.stringify(tabList, null, 2);
      },
    },
    {
      name: 'switchTab',
      description: 'Switch to a tab by index. Returns the updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'Tab index (from tabs tool output)' },
        },
        required: ['index'],
      },
      execute: async ({ index }) => actionAndSnapshot((page) => page.switchTab(index)),
    },
    {
      name: 'pdf',
      description: 'Export current page as PDF. Returns base64-encoded PDF data.',
      parameters: {
        type: 'object',
        properties: {
          landscape: { type: 'boolean', description: 'Landscape orientation (default: false)' },
        },
      },
      execute: async ({ landscape } = {}) => {
        const page = await getPage();
        return await page.pdf({ landscape });
      },
    },
    {
      name: 'screenshot',
      description: 'Take a screenshot of the current page. Returns base64-encoded image.',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Image format (default: png)' },
        },
      },
      execute: async ({ format } = {}) => {
        const page = await getPage();
        return await page.screenshot({ format });
      },
    },
  ];

  // Add assess tool if wearehere is installed
  if (assessFn) {
    tools.push({
      name: 'assess',
      description: 'Privacy assessment of a website. Returns risk score (0-100), per-category breakdown, concerns, and recommendation.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to assess' },
          timeout: { type: 'number', description: 'Navigation timeout in ms (default: 30000)' },
          settle: { type: 'number', description: 'Time to wait for trackers to load, in ms (default: 3000)' },
        },
        required: ['url'],
      },
      execute: async ({ url, timeout, settle }) => {
        const page = await connect(opts);
        try {
          const result = await assessFn(page, url, { timeout, settle });
          return JSON.stringify(result, null, 2);
        } finally {
          await page.close().catch(() => {});
        }
      },
    });
  }

  return {
    tools,
    async close() {
      if (_page) {
        await _page.close();
        _page = null;
      }
    },
  };
}
