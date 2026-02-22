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
import { click as cdpClick, type as cdpType, scroll as cdpScroll } from './interact.js';

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
      // headless (hybrid fallback logic comes in Phase 4)
      browser = await launch();
      cdp = await createCDP(browser.wsUrl);
    }

    // Step 2: Create a new page target and attach
    const page = await createPage(cdp);

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

    // Step 5: Get ARIA tree
    const { tree } = await ariaTree(page);

    // Step 6: Prune for agent consumption
    let snapshot;
    if (opts.prune !== false) {
      const pruned = pruneTree(tree, { mode: opts.pruneMode || 'act' });
      snapshot = formatTree(pruned);
    } else {
      snapshot = formatTree(tree);
    }

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
    browser = await launch();
    cdp = await createCDP(browser.wsUrl);
  }

  const page = await createPage(cdp);
  let refMap = new Map();

  return {
    async goto(url, timeout = 30000) {
      await navigate(page, url, timeout);
    },

    async snapshot(pruneOpts) {
      const result = await ariaTree(page);
      refMap = result.refMap;
      if (pruneOpts === false) return formatTree(result.tree);
      const pruned = pruneTree(result.tree, { mode: pruneOpts?.mode || 'act' });
      return formatTree(pruned);
    },

    async click(ref) {
      const backendNodeId = refMap.get(ref);
      if (!backendNodeId) throw new Error(`No element found for ref "${ref}"`);
      await cdpClick(page.session, backendNodeId);
    },

    async type(ref, text, opts) {
      const backendNodeId = refMap.get(ref);
      if (!backendNodeId) throw new Error(`No element found for ref "${ref}"`);
      await cdpType(page.session, backendNodeId, text, opts);
    },

    async scroll(deltaY) {
      await cdpScroll(page.session, deltaY);
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
 * Create a new page target and return a session-scoped handle.
 */
async function createPage(cdp) {
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
