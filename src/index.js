/**
 * barebrowse — Authenticated web browsing for autonomous agents via CDP.
 *
 * One package. One import. Three modes.
 *
 * Usage:
 *   import { browse, connect } from 'barebrowse';
 *   const snapshot = await browse('https://example.com');
 */

import { launch, getDebugUrl } from './chromium.js';
import { createCDP } from './cdp.js';
import { formatTree } from './aria.js';
import { authenticate } from './auth.js';
import { prune as pruneTree } from './prune.js';
import { click as cdpClick, type as cdpType, scroll as cdpScroll, press as cdpPress, hover as cdpHover, select as cdpSelect, drag as cdpDrag, upload as cdpUpload } from './interact.js';
import { dismissConsent } from './consent.js';
import { applyStealth } from './stealth.js';

/**
 * Browse a URL and return an ARIA snapshot.
 * This is the primary API — URL in, agent-ready snapshot out.
 *
 * @param {string} url - The URL to browse
 * @param {object} [opts]
 * @param {'headless'|'headed'|'hybrid'} [opts.mode='headless'] - Browser mode
 * @param {boolean} [opts.cookies=true] - Inject user's cookies (Phase 2)
 * @param {boolean} [opts.prune=true] - Apply ARIA pruning (Phase 2)
 * @param {number} [opts.timeout=30000] - Navigation timeout in ms
 * @param {number} [opts.port] - CDP port for headed mode
 * @returns {Promise<string>} ARIA snapshot text
 */
export async function browse(url, opts = {}) {
  const mode = opts.mode || 'headless';
  const timeout = opts.timeout || 30000;

  let browser = null;
  let cdp = null;

  try {
    // Step 1: Get a CDP connection
    if (mode === 'headed') {
      const port = opts.port || 9222;
      const wsUrl = await getDebugUrl(port);
      cdp = await createCDP(wsUrl);
    } else {
      // headless or hybrid (start headless)
      browser = await launch({ proxy: opts.proxy });
      cdp = await createCDP(browser.wsUrl);
    }

    // Step 2: Create a new page target and attach
    let page = await createPage(cdp, mode !== 'headed', { viewport: opts.viewport });

    // Step 2.5: Suppress permission prompts
    await suppressPermissions(cdp);

    // Step 3: Cookie injection — extract from user's browser, inject via CDP
    if (opts.cookies !== false) {
      try {
        await authenticate(page.session, url, { browser: opts.browser });
      } catch {
        // No cookies found — continue without auth (public pages still work)
      }
    }

    // Step 4: Navigate and wait for load
    await navigate(page, url, timeout);

    // Step 4.5: Auto-dismiss cookie consent dialogs
    if (opts.consent !== false) {
      await dismissConsent(page.session);
    }

    // Step 5: Get ARIA tree
    let { tree } = await ariaTree(page);

    // Step 5.5: Hybrid fallback — if headless was bot-blocked, retry headed
    if (mode === 'hybrid' && isChallengePage(tree)) {
      await cdp.send('Target.closeTarget', { targetId: page.targetId });
      cdp.close();
      if (browser) { browser.process.kill(); browser = null; }

      const port = opts.port || 9222;
      const wsUrl = await getDebugUrl(port);
      cdp = await createCDP(wsUrl);
      page = await createPage(cdp, false, { viewport: opts.viewport });
      await suppressPermissions(cdp);
      if (opts.cookies !== false) {
        try { await authenticate(page.session, url, { browser: opts.browser }); } catch {}
      }
      await navigate(page, url, timeout);
      if (opts.consent !== false) await dismissConsent(page.session);
      ({ tree } = await ariaTree(page));
    }

    // Step 6: Prune for agent consumption
    const raw = formatTree(tree);
    let snapshot;
    if (opts.prune !== false) {
      const pruned = pruneTree(tree, { mode: opts.pruneMode || 'act' });
      snapshot = formatTree(pruned);
    } else {
      snapshot = raw;
    }
    const stats = `# ${raw.length.toLocaleString()} chars → ${snapshot.length.toLocaleString()} chars (${Math.round((1 - snapshot.length / raw.length) * 100)}% pruned)`;
    snapshot = stats + '\n' + snapshot;

    // Step 7: Clean up
    await cdp.send('Target.closeTarget', { targetId: page.targetId });

    return snapshot;
  } finally {
    if (cdp) cdp.close();
    if (browser) browser.process.kill();
  }
}

/**
 * Connect to a browser for a long-lived interactive session.
 *
 * @param {object} [opts]
 * @param {'headless'|'headed'} [opts.mode='headless'] - Browser mode
 * @param {number} [opts.port=9222] - CDP port for headed mode
 * @returns {Promise<object>} Page handle with goto, snapshot, close
 */
export async function connect(opts = {}) {
  const mode = opts.mode || 'headless';
  let browser = null;
  let cdp;

  if (mode === 'headed') {
    const port = opts.port || 9222;
    const wsUrl = await getDebugUrl(port);
    cdp = await createCDP(wsUrl);
  } else {
    browser = await launch({ proxy: opts.proxy });
    cdp = await createCDP(browser.wsUrl);
  }

  const page = await createPage(cdp, mode !== 'headed', { viewport: opts.viewport });
  let refMap = new Map();

  // Suppress permission prompts for all modes
  await suppressPermissions(cdp);

  // Load storage state (cookies + localStorage) from file
  if (opts.storageState) {
    try {
      const { readFileSync } = await import('node:fs');
      const state = JSON.parse(readFileSync(opts.storageState, 'utf8'));
      if (state.cookies?.length) {
        await page.session.send('Network.setCookies', { cookies: state.cookies });
      }
    } catch { /* file not found or invalid — continue without */ }
  }

  // Auto-dismiss JS dialogs (alert, confirm, prompt)
  const dialogLog = [];
  page.session.on('Page.javascriptDialogOpening', async (params) => {
    dialogLog.push({
      type: params.type,
      message: params.message,
      timestamp: new Date().toISOString(),
    });
    await page.session.send('Page.handleJavaScriptDialog', {
      accept: params.type !== 'beforeunload',
      promptText: params.defaultPrompt || '',
    });
  });

  return {
    async goto(url, timeout = 30000) {
      await navigate(page, url, timeout);
      if (opts.consent !== false) {
        await dismissConsent(page.session);
      }
    },

    async goBack() {
      const { currentIndex, entries } = await page.session.send('Page.getNavigationHistory');
      if (currentIndex <= 0) throw new Error('No previous page in history');
      await page.session.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex - 1].id });
      await new Promise((r) => setTimeout(r, 500));
    },

    async goForward() {
      const { currentIndex, entries } = await page.session.send('Page.getNavigationHistory');
      if (currentIndex >= entries.length - 1) throw new Error('No next page in history');
      await page.session.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex + 1].id });
      await new Promise((r) => setTimeout(r, 500));
    },

    async injectCookies(url, cookieOpts) {
      await authenticate(page.session, url, { browser: cookieOpts?.browser });
    },

    async snapshot(pruneOpts) {
      const result = await ariaTree(page);
      refMap = result.refMap;
      const raw = formatTree(result.tree);
      if (pruneOpts === false) return raw;
      const pruned = pruneTree(result.tree, { mode: pruneOpts?.mode || 'act' });
      const out = formatTree(pruned);
      const stats = `# ${raw.length.toLocaleString()} chars → ${out.length.toLocaleString()} chars (${Math.round((1 - out.length / raw.length) * 100)}% pruned)`;
      return stats + '\n' + out;
    },

    async click(ref) {
      const backendNodeId = refMap.get(ref);
      if (!backendNodeId) throw new Error(`No element found for ref "${ref}"`);
      await cdpClick(page.session, backendNodeId);
    },

    async type(ref, text, typeOpts) {
      const backendNodeId = refMap.get(ref);
      if (!backendNodeId) throw new Error(`No element found for ref "${ref}"`);
      await cdpType(page.session, backendNodeId, text, typeOpts);
    },

    async scroll(deltaY) {
      await cdpScroll(page.session, deltaY);
    },

    async press(key) {
      await cdpPress(page.session, key);
    },

    async hover(ref) {
      const backendNodeId = refMap.get(ref);
      if (!backendNodeId) throw new Error(`No element found for ref "${ref}"`);
      await cdpHover(page.session, backendNodeId);
    },

    async select(ref, value) {
      const backendNodeId = refMap.get(ref);
      if (!backendNodeId) throw new Error(`No element found for ref "${ref}"`);
      await cdpSelect(page.session, backendNodeId, value);
    },

    async drag(fromRef, toRef) {
      const fromId = refMap.get(fromRef);
      const toId = refMap.get(toRef);
      if (!fromId) throw new Error(`No element found for ref "${fromRef}"`);
      if (!toId) throw new Error(`No element found for ref "${toRef}"`);
      await cdpDrag(page.session, fromId, toId);
    },

    async upload(ref, files) {
      const backendNodeId = refMap.get(ref);
      if (!backendNodeId) throw new Error(`No element found for ref "${ref}"`);
      await cdpUpload(page.session, backendNodeId, files);
    },

    async pdf(pdfOpts = {}) {
      const { data } = await page.session.send('Page.printToPDF', {
        landscape: pdfOpts.landscape || false,
        printBackground: true,
      });
      return data; // base64
    },

    async tabs() {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos
        .filter((t) => t.type === 'page')
        .map((t, i) => ({ index: i, url: t.url, title: t.title, targetId: t.targetId }));
    },

    async switchTab(index) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const pages = targetInfos.filter((t) => t.type === 'page');
      if (index < 0 || index >= pages.length) throw new Error(`Tab index ${index} out of range (0-${pages.length - 1})`);
      await cdp.send('Target.activateTarget', { targetId: pages[index].targetId });
    },

    async waitFor(waitOpts = {}) {
      const timeout = waitOpts.timeout || 30000;
      const interval = 200;
      const deadline = Date.now() + timeout;

      while (Date.now() < deadline) {
        if (waitOpts.text) {
          const { result } = await page.session.send('Runtime.evaluate', {
            expression: 'document.body?.innerText || ""',
            returnByValue: true,
          });
          if (result.value && result.value.includes(waitOpts.text)) return;
        }
        if (waitOpts.selector) {
          const { result } = await page.session.send('Runtime.evaluate', {
            expression: `!!document.querySelector(${JSON.stringify(waitOpts.selector)})`,
            returnByValue: true,
          });
          if (result.value) return;
        }
        await new Promise((r) => setTimeout(r, interval));
      }
      throw new Error(`waitFor timed out after ${timeout}ms`);
    },

    async saveState(filePath) {
      const { cookies } = await page.session.send('Network.getAllCookies');
      const { result } = await page.session.send('Runtime.evaluate', {
        expression: 'JSON.stringify(Object.fromEntries(Object.entries(localStorage)))',
        returnByValue: true,
      });
      const state = { cookies, localStorage: JSON.parse(result.value || '{}') };
      const { writeFileSync } = await import('node:fs');
      writeFileSync(filePath, JSON.stringify(state, null, 2));
    },

    dialogLog,

    async screenshot(screenshotOpts = {}) {
      const format = screenshotOpts.format || 'png';
      const params = { format };
      if (format === 'jpeg' || format === 'webp') {
        params.quality = screenshotOpts.quality || 80;
      }
      const { data } = await page.session.send('Page.captureScreenshot', params);
      return data;
    },

    async waitForNavigation(timeout = 30000) {
      // Wait for loadEventFired (full page load). If it doesn't fire within
      // timeout, fall back to frameNavigated (SPA pushState/replaceState).
      try {
        await page.session.once('Page.loadEventFired', timeout);
      } catch {
        // Timeout — likely SPA nav with no load event. frameNavigated may
        // have already fired. Give a settle delay for DOM updates.
        await new Promise((r) => setTimeout(r, 500));
      }
    },

    waitForNetworkIdle(idleOpts = {}) {
      return waitForNetworkIdle(page.session, idleOpts);
    },

    /** Raw CDP session for escape hatch */
    cdp: page.session,

    async close() {
      await cdp.send('Target.closeTarget', { targetId: page.targetId });
      cdp.close();
      if (browser) browser.process.kill();
    },
  };
}

// --- Internal helpers ---

/**
 * Suppress permission prompts (notifications, geolocation, camera, mic, etc.)
 * via CDP Browser.setPermission. Works for both headless and headed modes.
 */
const DENY_PERMISSIONS = [
  'geolocation', 'notifications', 'midi', 'midiSysex',
  'durableStorage', 'audioCapture', 'videoCapture',
  'backgroundSync', 'sensors', 'idleDetection',
];

async function suppressPermissions(cdp) {
  for (const name of DENY_PERMISSIONS) {
    try {
      await cdp.send('Browser.setPermission', {
        permission: { name },
        setting: 'denied',
      });
    } catch {
      // Permission type not supported in this Chrome version — skip
    }
  }
}

/**
 * Create a new page target and return a session-scoped handle.
 * @param {object} cdp - CDP client
 * @param {boolean} [stealth=false] - Apply stealth patches (headless only)
 */
async function createPage(cdp, stealth = false, pageOpts = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });

  const session = cdp.session(sessionId);

  // Enable required CDP domains on this page
  await session.send('Page.enable');
  await session.send('Network.enable');
  await session.send('DOM.enable');

  // Apply stealth patches before any navigation (headless only)
  if (stealth) {
    await applyStealth(session);
  }

  // Set viewport size if specified (e.g. "1280x720")
  if (pageOpts.viewport) {
    const [w, h] = pageOpts.viewport.split('x').map(Number);
    if (w && h) {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: false,
      });
    }
  }

  return { session, targetId, sessionId };
}

/**
 * Navigate to a URL and wait for the page to load.
 */
async function navigate(page, url, timeout = 30000) {
  const loadPromise = page.session.once('Page.loadEventFired', timeout);
  await page.session.send('Page.navigate', { url });
  await loadPromise;
  // Brief settle time for dynamic content
  await new Promise((r) => setTimeout(r, 500));
}

/**
 * Get the ARIA accessibility tree for a page as a nested object.
 */
async function ariaTree(page) {
  await page.session.send('Accessibility.enable');
  const { nodes } = await page.session.send('Accessibility.getFullAXTree');
  const tree = buildTree(nodes);

  // Build ref → backendDOMNodeId map in one pass over raw CDP nodes
  const refMap = new Map();
  for (const node of nodes) {
    if (node.backendDOMNodeId) {
      refMap.set(node.nodeId, node.backendDOMNodeId);
    }
  }

  return { tree, refMap };
}

/**
 * Transform CDP's flat AXNode array into a nested tree.
 * CDP nodes have parentId — we use that exclusively to avoid double-linking.
 */
function buildTree(nodes) {
  if (!nodes || nodes.length === 0) return null;

  const nodeMap = new Map();
  const linked = new Set(); // track which nodes have been linked to a parent

  // First pass: create tree nodes
  for (const node of nodes) {
    nodeMap.set(node.nodeId, {
      nodeId: node.nodeId,
      backendDOMNodeId: node.backendDOMNodeId,
      role: node.role?.value || '',
      name: node.name?.value || '',
      properties: extractProps(node.properties),
      ignored: node.ignored || false,
      children: [],
    });
  }

  // Second pass: link via parentId only (avoids duplicates from childIds)
  let root = null;
  for (const node of nodes) {
    const treeNode = nodeMap.get(node.nodeId);
    if (node.parentId && !linked.has(node.nodeId)) {
      const parent = nodeMap.get(node.parentId);
      if (parent) {
        parent.children.push(treeNode);
        linked.add(node.nodeId);
      }
    } else if (!node.parentId && !root) {
      root = treeNode;
    }
  }

  return root;
}

function extractProps(props) {
  if (!props) return {};
  const result = {};
  for (const p of props) result[p.name] = p.value?.value;
  return result;
}

/**
 * Wait until no network requests are pending for `idle` ms.
 * @param {object} session - Session-scoped CDP handle
 * @param {object} [opts]
 * @param {number} [opts.timeout=30000] - Max wait time
 * @param {number} [opts.idle=500] - Idle threshold in ms
 */
function waitForNetworkIdle(session, opts = {}) {
  const timeout = opts.timeout || 30000;
  const idle = opts.idle || 500;

  return new Promise((resolve, reject) => {
    let pending = 0;
    let timer = null;
    const unsubs = [];

    const done = () => {
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
      for (const unsub of unsubs) unsub();
      resolve();
    };

    const check = () => {
      clearTimeout(timer);
      if (pending <= 0) {
        pending = 0;
        timer = setTimeout(done, idle);
      }
    };

    unsubs.push(session.on('Network.requestWillBeSent', () => { pending++; clearTimeout(timer); }));
    unsubs.push(session.on('Network.loadingFinished', () => { pending--; check(); }));
    unsubs.push(session.on('Network.loadingFailed', () => { pending--; check(); }));

    const deadlineTimer = setTimeout(() => {
      for (const unsub of unsubs) unsub();
      reject(new Error(`waitForNetworkIdle timed out after ${timeout}ms`));
    }, timeout);

    // Start check immediately (might already be idle)
    check();
  });
}

/**
 * Detect if a page is a bot-challenge page (Cloudflare, etc.).
 * Heuristic: very short ARIA tree + known challenge phrases.
 */
function isChallengePage(tree) {
  if (!tree) return true;
  const text = flattenTreeText(tree);
  const challengePhrases = [
    'just a moment',
    'checking if the site connection is secure',
    'checking your browser',
    'please wait',
    'verify you are human',
    'attention required',
  ];
  const lower = text.toLowerCase();
  return challengePhrases.some((p) => lower.includes(p));
}

function flattenTreeText(node) {
  if (!node) return '';
  let text = node.name || '';
  for (const child of node.children || []) {
    text += ' ' + flattenTreeText(child);
  }
  return text;
}
