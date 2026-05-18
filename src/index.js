/**
 * barebrowse — Authenticated web browsing for autonomous agents via CDP.
 *
 * One package. One import. Three modes.
 *
 * Usage:
 *   import { browse, connect } from 'barebrowse';
 *   const snapshot = await browse('https://example.com');
 */

import { launch, attach, cleanupBrowser } from './chromium.js';
import { createCDP } from './cdp.js';
import { formatTree } from './aria.js';
import { authenticate } from './auth.js';
import { prune as pruneTree } from './prune.js';
import { click as cdpClick, type as cdpType, scroll as cdpScroll, press as cdpPress, hover as cdpHover, select as cdpSelect, drag as cdpDrag, upload as cdpUpload } from './interact.js';
import { dismissConsent } from './consent.js';
import { applyStealth } from './stealth.js';
import { DEFAULT_BLOCKLIST } from './blocklist.js';
import { waitForNetworkIdle } from './network-idle.js';
import { join as pathJoin } from 'node:path';

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
 * @param {boolean} [opts.blockAds=true] - Block ~120 common ad/tracker
 *   URL patterns via CDP. Shrinks ARIA snapshots and speeds page loads.
 *   See src/blocklist.js for the default set. Set false to disable.
 * @param {string[]} [opts.blockUrls] - Extra URL glob patterns to block,
 *   merged with the default unless blockAds:false.
 * @returns {Promise<string>} ARIA snapshot text
 */
export async function browse(url, opts = {}) {
  const mode = opts.mode || 'headless';
  const timeout = opts.timeout || 30000;

  let browser = null;
  let cdp = null;
  // Forward caller-supplied launch knobs (binary, userDataDir, proxy) into
  // every launch() call below, including hybrid-fallback re-launches.
  const launchOpts = { proxy: opts.proxy, binary: opts.binary, userDataDir: opts.userDataDir };

  try {
    // Step 1: Get a CDP connection
    if (mode === 'headed') {
      browser = await launch({ ...launchOpts, headed: true });
      cdp = await createCDP(browser.wsUrl);
    } else {
      // headless or hybrid (start headless)
      browser = await launch(launchOpts);
      cdp = await createCDP(browser.wsUrl);
    }

    // Step 2: Create a new page target and attach
    const pageOpts = { viewport: opts.viewport, blockAds: opts.blockAds, blockUrls: opts.blockUrls };
    let page = await createPage(cdp, mode !== 'headed', pageOpts);

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
    let { tree, nodeCount } = await ariaTree(page);

    // Step 5.5: Hybrid fallback — if headless was bot-blocked, retry headed
    if (mode === 'hybrid' && isChallengePage(tree, nodeCount)) {
      await cdp.send('Target.closeTarget', { targetId: page.targetId });
      cdp.close();
      await cleanupBrowser(browser); browser = null;

      try {
        browser = await launch({ ...launchOpts, headed: true });
        cdp = await createCDP(browser.wsUrl);
        page = await createPage(cdp, false, pageOpts);
        await suppressPermissions(cdp);
        if (opts.cookies !== false) {
          try { await authenticate(page.session, url, { browser: opts.browser }); } catch {}
        }
        await navigate(page, url, timeout);
        if (opts.consent !== false) await dismissConsent(page.session);
        ({ tree } = await ariaTree(page));
      } catch {
        // Headed launch failed (no display?) — return headless result as-is
      }
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
    const stats = `url: ${url}\n${raw.length.toLocaleString()} chars → ${snapshot.length.toLocaleString()} chars (${Math.round((1 - snapshot.length / raw.length) * 100)}% pruned)`;
    const actMode = !opts.pruneMode || opts.pruneMode === 'act';
    const hint = (actMode && raw.length > 5000 && snapshot.length < 500 && snapshot.length < raw.length * 0.05)
      ? `hint: act mode dropped most of the page — retry with pruneMode='read' for paragraphs and long text\n`
      : '';
    snapshot = stats + '\n' + hint + snapshot;

    // Step 7: Clean up
    await cdp.send('Target.closeTarget', { targetId: page.targetId });

    return snapshot;
  } finally {
    if (cdp) cdp.close();
    await cleanupBrowser(browser);
  }
}

/**
 * Connect to a browser for a long-lived interactive session.
 *
 * @param {object} [opts]
 * @param {'headless'|'headed'|'hybrid'} [opts.mode='headless'] - Browser mode
 * @param {number} [opts.port] - Attach to an already-running Chromium at this
 *   CDP port instead of launching a new one. The browser keeps running on
 *   close(); only the tab we created is torn down. Use this to drive a
 *   user's logged-in session (start Chromium with --remote-debugging-port=N).
 * @param {string} [opts.downloadPath] - Directory to save downloaded files.
 *   Default: a per-session subdirectory under the OS temp dir. Downloads
 *   land here as <guid>; check `page.downloads` for { url, suggestedFilename,
 *   savedPath, state, totalBytes, receivedBytes } per file.
 * @param {boolean} [opts.blockAds] - Block ~120 common ad/tracker URL
 *   patterns via CDP. Defaults to true for launched browsers, false in
 *   attach mode (would affect any tab attached to the user's running
 *   session). Pass explicitly to override.
 * @param {string[]} [opts.blockUrls] - Extra URL glob patterns to block,
 *   merged with the default unless blockAds is false.
 * @returns {Promise<object>} Page handle with goto, snapshot, close
 */
export async function connect(opts = {}) {
  const mode = opts.mode || 'headless';
  const attachMode = !!opts.port;
  let browser = null;
  let cdp;
  // Forward caller-supplied launch knobs into every launch() below,
  // including hybrid-fallback re-launches inside goto().
  const launchOpts = { proxy: opts.proxy, binary: opts.binary, userDataDir: opts.userDataDir };

  if (attachMode) {
    // Reuse the user's running browser — do not launch, do not own the
    // profile. cleanupBrowser() is a no-op on this shape (process: null,
    // ownedProfileDir: null), which is the whole point.
    browser = await attach({ port: opts.port });
    cdp = await createCDP(browser.wsUrl);
  } else if (mode === 'headed') {
    browser = await launch({ ...launchOpts, headed: true });
    cdp = await createCDP(browser.wsUrl);
  } else {
    browser = await launch(launchOpts);
    cdp = await createCDP(browser.wsUrl);
  }

  // In attach mode we don't know (and shouldn't assume) the user's headed/
  // headless state — treat it as headed so stealth patches are skipped
  // (they'd persist in the user's session via addScriptToEvaluateOnNewDocument)
  // and the headed→headless rewind in goto() is gated off below.
  let currentlyHeaded = attachMode || (mode === 'headed');
  // Default blockAds on for owned browsers, off in attach mode (would affect
  // any tab we attach to in the user's running session). Caller can flip with
  // explicit blockAds:true/false.
  const pageOpts = {
    viewport: opts.viewport,
    blockAds: opts.blockAds !== undefined ? opts.blockAds : !attachMode,
    blockUrls: opts.blockUrls,
  };
  let page = await createPage(cdp, !currentlyHeaded, pageOpts);
  let refMap = new Map();
  let botBlocked = false;

  // Suppress permission prompts. Skipped in attach mode — Browser.setPermission
  // is browser-wide (no origin scope here), so flipping permissions to denied
  // would leak into the user's other tabs.
  if (!attachMode) {
    await suppressPermissions(cdp);
  }

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

  // Download tracking — wire Browser.setDownloadBehavior so files actually
  // land on disk (default Chromium would route them to ~/Downloads or
  // nowhere useful in headless), and listen for downloadWillBegin /
  // downloadProgress so callers can read `page.downloads` to know what
  // arrived. In attach mode we don't change the user's running browser's
  // download dir — they almost certainly have an existing preference.
  const downloads = [];
  let ownedDownloadDir = null;
  if (!attachMode) {
    let downloadPath = opts.downloadPath;
    if (!downloadPath) {
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      ownedDownloadDir = mkdtempSync(pathJoin(tmpdir(), 'barebrowse-dl-'));
      downloadPath = ownedDownloadDir;
    }
    // Register listeners BEFORE sending setDownloadBehavior so no
    // downloadWillBegin / downloadProgress event can fire into a session
    // without subscribers — about:blank can't initiate a download so the
    // window is microscopic in practice, but ordering it correctly costs
    // nothing.
    cdp.on('Browser.downloadWillBegin', (params) => {
      downloads.push({
        guid: params.guid,
        url: params.url,
        suggestedFilename: params.suggestedFilename,
        savedPath: pathJoin(downloadPath, params.guid),
        state: 'inProgress',
        totalBytes: 0,
        receivedBytes: 0,
      });
    });
    cdp.on('Browser.downloadProgress', (params) => {
      const d = downloads.find((x) => x.guid === params.guid);
      if (!d) return;
      d.state = params.state; // 'inProgress' | 'completed' | 'canceled'
      d.totalBytes = params.totalBytes;
      d.receivedBytes = params.receivedBytes;
    });
    try {
      // 'allowAndName' names saved files by guid for a stable, predictable
      // path; the suggested filename is still surfaced on the download record.
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName', downloadPath, eventsEnabled: true,
      });
    } catch {
      // Older Chrome may not accept 'allowAndName' — fall back to 'allow'
      // which uses the suggested filename verbatim (no GUID).
      try {
        await cdp.send('Browser.setDownloadBehavior', {
          behavior: 'allow', downloadPath, eventsEnabled: true,
        });
      } catch {
        // Download capture unavailable on this Chrome — downloads still
        // happen, we just can't observe them. page.downloads stays empty.
      }
    }
  }

  // JS dialog handling (alert, confirm, prompt, beforeunload). Default is
  // auto-accept everything except beforeunload (auto-dismiss). The caller
  // can install a custom decision via page.onDialog(handler) — the handler
  // gets { type, message, defaultPrompt } and may return
  // { accept: bool, promptText: string } to override.
  const dialogLog = [];
  let onDialogHandler = null;
  function setupDialogHandler(session) {
    session.on('Page.javascriptDialogOpening', async (params) => {
      dialogLog.push({
        type: params.type,
        message: params.message,
        timestamp: new Date().toISOString(),
      });
      let accept = params.type !== 'beforeunload';
      let promptText = params.defaultPrompt || '';
      if (onDialogHandler) {
        try {
          const decision = await onDialogHandler({
            type: params.type,
            message: params.message,
            defaultPrompt: params.defaultPrompt || '',
          });
          if (decision && typeof decision === 'object') {
            if (typeof decision.accept === 'boolean') accept = decision.accept;
            if (typeof decision.promptText === 'string') promptText = decision.promptText;
          }
        } catch {
          // Handler threw — fall back to defaults so the page doesn't hang
          // waiting for a never-arriving handleJavaScriptDialog reply.
        }
      }
      await session.send('Page.handleJavaScriptDialog', { accept, promptText });
    });
  }
  setupDialogHandler(page.session);

  return {
    async goto(url, timeout = 30000) {
      // Refs from the previous page are about to become invalid — clear
      // before navigating so a stale click(ref) errors clearly instead of
      // silently resolving to whatever backendNodeId happens to still be in
      // the map.
      refMap = new Map();
      // Switch back to headless if we fell back to headed previously.
      // Not in attach mode — we never own the browser there, so there's
      // nothing to rewind.
      if (currentlyHeaded && mode === 'hybrid' && !attachMode) {
        await cdp.send('Target.closeTarget', { targetId: page.targetId });
        cdp.close();
        await cleanupBrowser(browser); browser = null;

        browser = await launch(launchOpts);
        cdp = await createCDP(browser.wsUrl);
        page = await createPage(cdp, true, pageOpts);
        setupDialogHandler(page.session);
        await suppressPermissions(cdp);
        currentlyHeaded = false;
      }

      await navigate(page, url, timeout);
      if (opts.consent !== false) {
        await dismissConsent(page.session);
      }

      // Check for bot challenge
      const { tree, nodeCount } = await ariaTree(page);
      botBlocked = isChallengePage(tree, nodeCount);

      // Hybrid fallback: if bot-blocked, retry with headed browser.
      // Suppressed in attach mode — we can't tear down the user's running
      // browser and we don't know what mode they started it in.
      if (botBlocked && mode === 'hybrid' && !attachMode) {
        await cdp.send('Target.closeTarget', { targetId: page.targetId });
        cdp.close();
        await cleanupBrowser(browser); browser = null;

        try {
          browser = await launch({ ...launchOpts, headed: true });
          cdp = await createCDP(browser.wsUrl);
          page = await createPage(cdp, false, pageOpts);
          setupDialogHandler(page.session);
          await suppressPermissions(cdp);
          await navigate(page, url, timeout);
          if (opts.consent !== false) await dismissConsent(page.session);

          // Re-check after headed fallback
          const after = await ariaTree(page);
          botBlocked = isChallengePage(after.tree, after.nodeCount);
          currentlyHeaded = true;
        } catch {
          // Headed launch failed (no display?) — keep headless result, botBlocked stays true
        }
      }
    },

    async goBack() {
      const { currentIndex, entries } = await page.session.send('Page.getNavigationHistory');
      if (currentIndex <= 0) throw new Error('No previous page in history');
      const loadPromise = page.session.once('Page.loadEventFired', 30000);
      await page.session.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex - 1].id });
      try { await loadPromise; } catch { await new Promise((r) => setTimeout(r, 500)); }
      refMap = new Map(); // refs from the previous page are now invalid
    },

    async goForward() {
      const { currentIndex, entries } = await page.session.send('Page.getNavigationHistory');
      if (currentIndex >= entries.length - 1) throw new Error('No next page in history');
      const loadPromise = page.session.once('Page.loadEventFired', 30000);
      await page.session.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex + 1].id });
      try { await loadPromise; } catch { await new Promise((r) => setTimeout(r, 500)); }
      refMap = new Map();
    },

    async reload(reloadOpts = {}) {
      const timeout = reloadOpts.timeout || 30000;
      const loadPromise = page.session.once('Page.loadEventFired', timeout);
      await page.session.send('Page.reload', {
        ignoreCache: !!reloadOpts.ignoreCache,
      });
      try { await loadPromise; } catch { await new Promise((r) => setTimeout(r, 500)); }
      refMap = new Map(); // refs from the pre-reload page are invalid
    },

    async injectCookies(url, cookieOpts) {
      await authenticate(page.session, url, { browser: cookieOpts?.browser });
    },

    async snapshot(pruneOpts) {
      const result = await ariaTree(page);
      refMap = result.refMap;
      const raw = formatTree(result.tree);
      const { currentIndex, entries } = await page.session.send('Page.getNavigationHistory');
      const pageUrl = entries[currentIndex]?.url || '';
      const warn = botBlocked ? '[BOT CHALLENGE DETECTED — page content may be incomplete or blocked]\n' : '';
      if (pruneOpts === false) return `url: ${pageUrl}\n` + warn + raw;
      const mode = pruneOpts?.mode || 'act';
      const pruned = pruneTree(result.tree, { mode });
      const out = formatTree(pruned);
      const stats = `url: ${pageUrl}\n${raw.length.toLocaleString()} chars → ${out.length.toLocaleString()} chars (${Math.round((1 - out.length / raw.length) * 100)}% pruned)`;
      const hint = (mode === 'act' && raw.length > 5000 && out.length < 500 && out.length < raw.length * 0.05)
        ? `hint: act mode dropped most of the page — retry with pruneMode='read' for paragraphs and long text\n`
        : '';
      return stats + '\n' + hint + warn + out;
    },

    async click(ref) {
      const entry = refMap.get(ref);
      if (!entry) throw new Error(`No element found for ref "${ref}"`);
      await cdpClick(entry.session, entry.backendNodeId);
    },

    async type(ref, text, typeOpts) {
      const entry = refMap.get(ref);
      if (!entry) throw new Error(`No element found for ref "${ref}"`);
      await cdpType(entry.session, entry.backendNodeId, text, typeOpts);
    },

    async scroll(deltaY) {
      await cdpScroll(page.session, deltaY);
    },

    async press(key) {
      await cdpPress(page.session, key);
    },

    async hover(ref) {
      const entry = refMap.get(ref);
      if (!entry) throw new Error(`No element found for ref "${ref}"`);
      await cdpHover(entry.session, entry.backendNodeId);
    },

    async select(ref, value) {
      const entry = refMap.get(ref);
      if (!entry) throw new Error(`No element found for ref "${ref}"`);
      await cdpSelect(entry.session, entry.backendNodeId, value);
    },

    async drag(fromRef, toRef) {
      const from = refMap.get(fromRef);
      const to = refMap.get(toRef);
      if (!from) throw new Error(`No element found for ref "${fromRef}"`);
      if (!to) throw new Error(`No element found for ref "${toRef}"`);
      // Drag across different frames isn't physically meaningful — bail
      // rather than mix sessions and produce nonsense coordinates.
      if (from.session !== to.session) {
        throw new Error('drag() between elements in different frames is not supported');
      }
      await cdpDrag(from.session, from.backendNodeId, to.backendNodeId);
    },

    async upload(ref, files) {
      const entry = refMap.get(ref);
      if (!entry) throw new Error(`No element found for ref "${ref}"`);
      await cdpUpload(entry.session, entry.backendNodeId, files);
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
      const target = pages[index];
      await cdp.send('Target.activateTarget', { targetId: target.targetId });
      if (target.targetId === page.targetId) return; // already on this tab
      // Detach from old session, attach to new — the page variable is the
      // closure handle used by every method below, so swapping it makes
      // snapshot/click/type/etc. operate on the new tab.
      const oldSessionId = page.sessionId;
      page = await attachToExistingTarget(cdp, target.targetId, pageOpts);
      refMap = new Map(); // refs from the previous tab are no longer valid
      setupDialogHandler(page.session);
      try { await cdp.send('Target.detachFromTarget', { sessionId: oldSessionId }); } catch {}
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

    get botBlocked() { return botBlocked; },

    dialogLog,

    /**
     * Install a custom JS dialog handler. The handler is called with
     * `{ type, message, defaultPrompt }` and may return (sync or async)
     * `{ accept: bool, promptText: string }` to override the auto-accept
     * default. Pass null to restore the default behavior.
     */
    onDialog(handler) {
      onDialogHandler = handler;
    },

    downloads,

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

    /** Raw CDP session for escape hatch — getter so it survives hybrid fallback / tab swaps */
    get cdp() { return page.session; },

    async createTab() {
      const tab = await createPage(cdp, !currentlyHeaded, pageOpts);
      await suppressPermissions(cdp);
      setupDialogHandler(tab.session);
      let tabBotBlocked = false;
      return {
        async goto(url, timeout = 30000) {
          await navigate(tab, url, timeout);
          if (opts.consent !== false) {
            await dismissConsent(tab.session);
          }
          const { tree, nodeCount } = await ariaTree(tab);
          tabBotBlocked = isChallengePage(tree, nodeCount);
        },
        get botBlocked() { return tabBotBlocked; },
        async injectCookies(url, cookieOpts) {
          await authenticate(tab.session, url, { browser: cookieOpts?.browser });
        },
        waitForNetworkIdle(idleOpts = {}) {
          return waitForNetworkIdle(tab.session, idleOpts);
        },
        cdp: tab.session,
        async close() {
          await cdp.send('Target.closeTarget', { targetId: tab.targetId });
        },
      };
    },

    async close() {
      await cdp.send('Target.closeTarget', { targetId: page.targetId });
      cdp.close();
      await cleanupBrowser(browser);
      // If we created the download dir ourselves, clean it up too. Caller-
      // supplied opts.downloadPath stays — the caller owns the lifecycle.
      if (ownedDownloadDir) {
        try {
          const { rmSync } = await import('node:fs');
          rmSync(ownedDownloadDir, { recursive: true, force: true });
        } catch {}
      }
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

  // Ad/tracker URL blocking via CDP. Default on for owned browsers — shrinks
  // ARIA, speeds loads. Skipped in attach mode (would affect the user's
  // running browser globally) and skippable per-call via blockAds:false.
  // Custom patterns in blockUrls extend the default unless blockAds is false.
  await applyBlocklist(session, pageOpts);

  // Set viewport size if specified (e.g. "1280x720")
  if (pageOpts.viewport) {
    const [w, h] = pageOpts.viewport.split('x').map(Number);
    if (w && h) {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: false,
      });
    }
  }

  // Track child frame sessions (OOPIF) so ariaTree() can read across frame
  // boundaries. Same-origin iframes don't get their own session and stay
  // queryable via the main session with a frameId param — see ariaTree().
  const framesByFrameId = await attachFrameTracking(cdp, session);

  return { session, targetId, sessionId, framesByFrameId };
}

/**
 * Wire Target.setAutoAttach on a page session so every OOPIF child target gets
 * its own CDP session, enabled and registered. Returns a live Map<frameId,
 * { session, sessionId, targetId }> that updates as frames attach/detach.
 */
async function attachFrameTracking(cdp, mainSession) {
  const framesByFrameId = new Map();

  mainSession.on('Target.attachedToTarget', async (params) => {
    if (params.targetInfo?.type !== 'iframe') return;
    const childSessionId = params.sessionId;
    const childSession = cdp.session(childSessionId);
    // For OOPIF, targetId === frameId — see CDP Target domain docs.
    const frameId = params.targetInfo.targetId;
    framesByFrameId.set(frameId, { session: childSession, sessionId: childSessionId, targetId: frameId });
    // Enable domains on the child so we can read its AX tree.
    // Recursively auto-attach so nested OOPIF iframes also get sessions.
    try { await childSession.send('Page.enable'); } catch {}
    try { await childSession.send('DOM.enable'); } catch {}
    try {
      await childSession.send('Target.setAutoAttach', {
        autoAttach: true, flatten: true, waitForDebuggerOnStart: false,
      });
    } catch {}
    try { await childSession.send('Runtime.runIfWaitingForDebugger'); } catch {}
  });

  mainSession.on('Target.detachedFromTarget', (params) => {
    for (const [frameId, entry] of framesByFrameId) {
      if (entry.sessionId === params.sessionId) {
        framesByFrameId.delete(frameId);
        return;
      }
    }
  });

  await mainSession.send('Target.setAutoAttach', {
    autoAttach: true, flatten: true, waitForDebuggerOnStart: false,
  });

  return framesByFrameId;
}

/**
 * Attach a CDP session to an existing target (e.g. a tab opened by window.open).
 * Enables the same domains as createPage so snapshot/click/type work uniformly.
 */
async function attachToExistingTarget(cdp, targetId, pageOpts = {}) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const session = cdp.session(sessionId);
  await session.send('Page.enable');
  await session.send('Network.enable');
  await session.send('DOM.enable');
  await applyBlocklist(session, pageOpts);
  const framesByFrameId = await attachFrameTracking(cdp, session);
  return { session, targetId, sessionId, framesByFrameId };
}

/**
 * Apply Network.setBlockedURLs for ad/tracker blocking on a session.
 * Default list is on; pass blockAds:false to skip, blockUrls:[] to extend.
 * Silent on failure — older Chrome / unusual modes shouldn't break the page.
 */
async function applyBlocklist(session, pageOpts) {
  if (pageOpts.blockAds === false && !pageOpts.blockUrls) return;
  const patterns = pageOpts.blockAds === false
    ? (pageOpts.blockUrls || [])
    : [...DEFAULT_BLOCKLIST, ...(pageOpts.blockUrls || [])];
  if (!patterns.length) return;
  try {
    await session.send('Network.setBlockedURLs', { urls: patterns });
  } catch {
    // Network.setBlockedURLs unsupported on this Chrome — skip silently.
  }
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
 *
 * Walks every frame (main + iframes) via Page.getFrameTree, queries each
 * frame's AX tree on the right session (child session for OOPIF, main
 * session with frameId param for same-origin), and splices child frame
 * trees under their iframe placeholders in the parent. Refs are assigned
 * by a flat global counter so click/type/etc can resolve the right session
 * without the agent having to think about frames at all.
 */
async function ariaTree(page) {
  const main = page.session;
  await main.send('Accessibility.enable');

  // 1. Linearize the frame tree depth-first: index 0 is the main frame.
  const { frameTree } = await main.send('Page.getFrameTree');
  const frames = [];
  (function walk(node, parentId) {
    frames.push({ frame: node.frame, parentId });
    for (const child of node.childFrames || []) walk(child, node.frame.id);
  })(frameTree, null);

  // 2. For each frame, fetch its AX nodes and build a tree. refMap value is
  //    { session, backendNodeId } so click(ref) routes to the right CDP
  //    session (essential for cross-process iframes). refCounter is shared
  //    across all frames in one snapshot — refs stay flat integers, so the
  //    visible [ref=N] format and existing agent prompts don't change.
  const refMap = new Map();
  const treesByFrameId = new Map();
  const sessionByFrameId = new Map();
  const refCounter = { value: 1 };
  let totalNodes = 0;

  for (let i = 0; i < frames.length; i++) {
    const { frame } = frames[i];
    const childEntry = page.framesByFrameId?.get(frame.id);
    const frameSession = childEntry ? childEntry.session : main;
    sessionByFrameId.set(frame.id, frameSession);

    let nodes = [];
    try {
      if (childEntry) {
        // OOPIF — use the child session, no frameId param needed.
        try { await frameSession.send('Accessibility.enable'); } catch {}
        const res = await frameSession.send('Accessibility.getFullAXTree');
        nodes = res.nodes;
      } else {
        // Main frame or same-origin child — query main session, scoping by
        // frameId for children (Accessibility.getFullAXTree without frameId
        // would just return the top frame, dropping same-origin iframe content).
        const params = i === 0 ? {} : { frameId: frame.id };
        const res = await main.send('Accessibility.getFullAXTree', params);
        nodes = res.nodes;
      }
    } catch {
      // Frame may have navigated mid-snapshot — skip it rather than fail
      // the whole snapshot. The placeholder iframe node will simply have
      // no children in the merged tree.
      continue;
    }

    totalNodes += nodes.length;
    const tree = buildTree(nodes, frameSession, refMap, refCounter);
    if (tree) treesByFrameId.set(frame.id, tree);
  }

  // 3. Splice each child frame's tree under its iframe placeholder node in
  //    the parent. DOM.getFrameOwner gives the iframe element's
  //    backendNodeId in the parent's view; we match it against AX nodes.
  for (const { frame, parentId } of frames) {
    if (parentId === null) continue;
    const parentTree = treesByFrameId.get(parentId);
    const childTree = treesByFrameId.get(frame.id);
    if (!parentTree || !childTree) continue;
    const parentSession = sessionByFrameId.get(parentId);
    try {
      const { backendNodeId } = await parentSession.send('DOM.getFrameOwner', { frameId: frame.id });
      const placeholder = findNodeByBackend(parentTree, backendNodeId);
      if (placeholder) placeholder.children = [childTree];
    } catch {
      // Frame owner lookup failed — leave the iframe placeholder as-is.
    }
  }

  const root = treesByFrameId.get(frames[0].frame.id) || null;
  return { tree: root, refMap, nodeCount: totalNodes };
}

/**
 * Transform CDP's flat AXNode array into a nested tree. Every tree node gets
 * a globally unique flat ref string from `refCounter` (shared across all
 * frames in one snapshot), and refMap is populated with ref → { session,
 * backendNodeId } so click/type can route to the right CDP session even when
 * the element lives in an iframe.
 * CDP nodes have parentId — we use that exclusively to avoid double-linking.
 */
function buildTree(nodes, session, refMap, refCounter) {
  if (!nodes || nodes.length === 0) return null;

  const nodeMap = new Map();
  const linked = new Set();

  // First pass: create tree nodes + populate refMap with flat global refs
  for (const node of nodes) {
    const ref = String(refCounter.value++);
    nodeMap.set(node.nodeId, {
      nodeId: ref,
      backendDOMNodeId: node.backendDOMNodeId,
      role: node.role?.value || '',
      name: node.name?.value || '',
      properties: extractProps(node.properties),
      ignored: node.ignored || false,
      children: [],
    });
    if (node.backendDOMNodeId && refMap) {
      refMap.set(ref, { session, backendNodeId: node.backendDOMNodeId });
    }
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

function findNodeByBackend(node, backendNodeId) {
  if (!node) return null;
  if (node.backendDOMNodeId === backendNodeId) return node;
  for (const child of node.children || []) {
    const found = findNodeByBackend(child, backendNodeId);
    if (found) return found;
  }
  return null;
}

function extractProps(props) {
  if (!props) return {};
  const result = {};
  for (const p of props) result[p.name] = p.value?.value;
  return result;
}

/**
 * Detect if a page is a bot-challenge page (Cloudflare, hCaptcha, etc.).
 *
 * Pre-H9 this was over-aggressive: `nodeCount < 50` alone fired on any
 * legitimate small page (404s, simple landings, error pages), and generic
 * phrases like "access denied" / "unknown error" / "permission denied"
 * triggered on real HTTP 4xx/5xx pages, kicking hybrid mode into a costly
 * headed fallback for nothing.
 *
 * H9 split: STRONG_PHRASES are essentially-unambiguous challenge UI and
 * fire regardless of page size; WEAK_PHRASES only fire when the page is
 * ALSO tiny (so a legitimate-looking error page with "access denied" in
 * its body doesn't trip the fallback).
 *
 * @param {object} tree - Nested ARIA tree (from buildTree)
 * @param {number} [nodeCount] - Raw CDP node count (from Accessibility.getFullAXTree)
 */
export function isChallengePage(tree, nodeCount) {
  if (!tree) return true; // truly empty AX tree — something went wrong fetching the page

  const text = flattenTreeText(tree);
  const lower = text.toLowerCase();

  // Strong phrases — distinctive enough to identify the challenge product
  // by name. Fire on their own regardless of node count.
  const STRONG_PHRASES = [
    'just a moment',                            // Cloudflare interstitial
    'checking if the site connection is secure', // Cloudflare
    'checking your browser',                     // Various JS challenges
    'verify you are human',                      // hCaptcha / reCAPTCHA
    'prove your humanity',
    'attention required',                        // Cloudflare block page
    'enable javascript and cookies to continue', // Cloudflare
    'please complete the security check',        // Cloudflare/Akamai
  ];
  if (STRONG_PHRASES.some((p) => lower.includes(p))) return true;

  // Weak phrases — show up on real challenge pages but ALSO on legitimate
  // small error pages. Only count when the page is itself tiny (low node
  // count or near-empty text), which is the corroborating signal that
  // separates a real error UI from a challenge skeleton.
  const WEAK_PHRASES = [
    'please wait',
    'request blocked',
    'access denied',
    'permission denied',
    'unknown error',
    'file a ticket',
  ];
  const tinyPage = (nodeCount !== undefined && nodeCount < 30) || text.trim().length < 50;
  if (tinyPage && WEAK_PHRASES.some((p) => lower.includes(p))) return true;

  return false;
}

function flattenTreeText(node) {
  if (!node) return '';
  let text = node.name || '';
  for (const child of node.children || []) {
    text += ' ' + flattenTreeText(child);
  }
  return text;
}
