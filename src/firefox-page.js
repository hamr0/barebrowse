/**
 * firefox-page.js — A barebrowse page object backed by WebDriver BiDi (Firefox).
 *
 * Mirrors the core of connect()'s CDP page surface — goto, snapshot, click,
 * type, press, scroll, hover, readable, injectCookies, close — but every
 * operation goes over BiDi instead of CDP. The tree that snapshot() feeds to
 * prune.js/aria.js is reconstructed in-page by ax-snapshot.js (BiDi has no
 * getFullAXTree), and refs resolve to elements through the data-bb-ref
 * attribute those snapshots stamp on.
 *
 * Interactions use faithful BiDi input.performActions with an *element origin*
 * (pointerMove auto-scrolls the element into view, then real pointerDown/Up
 * fire) rather than a synthetic el.click(), so pages that need genuine mouse
 * events behave. Refs are resolved to BiDi element sharedIds per context, so
 * clicks land in the right frame.
 */

import { formatTree } from './aria.js';
import { prune as pruneTree } from './prune.js';
import { axSnapshotExpression, REF_ATTR } from './ax-snapshot.js';
import { EXTRACT_EXPRESSION, finalizeReadable } from './readable.js';
import { scopedCookiesForUrl } from './auth.js';
import { assertNavigable, assertUploadAllowed } from './url-guard.js';
import { dismissConsentFirefox } from './consent-firefox.js';
import { waitForNetworkIdleBiDi } from './network-idle.js';
import { decideDialog, dialogLogEntry } from './dialog.js';
import { isChallengePage, countNodes } from './challenge.js';

/** BiDi/WebDriver normalized key values for named keys (U+E000 block). */
const BIDI_KEYS = {
  Enter: "\uE007", Tab: "\uE004", Escape: "\uE00C", Backspace: "\uE003",
  Delete: "\uE017", ArrowUp: "\uE013", ArrowDown: "\uE015",
  ArrowLeft: "\uE012", ArrowRight: "\uE014", Home: "\uE011", End: "\uE010",
  PageUp: "\uE00E", PageDown: "\uE00F", Space: " ",
};

/**
 * Build a Firefox/BiDi-backed page object.
 * @param {object} bidi - BiDi client from createBiDi()
 * @param {object} [opts]
 * @param {'act'|'browse'|'navigate'|'full'|'read'} [opts.pruneMode='act'] - Default prune mode.
 * @param {{allowLocalUrls?: boolean, blockPrivateNetwork?: boolean}} [opts.urlGuard] - Navigation safety policy, applied on every goto().
 * @param {string} [opts.uploadDir] - When set, upload() rejects files outside this dir.
 * @param {boolean} [opts.incognito=false] - Clean session: injectCookies() is a no-op.
 * @param {boolean} [opts.consent=true] - Auto-dismiss cookie consent dialogs after goto().
 * @param {boolean} [opts.hybrid=false] - Relaunch headed on a bot-challenge page and retry.
 * @param {boolean} [opts.headed=false] - Whether the browser was launched headed (skips hybrid fallback).
 * @param {?function(): Promise<{bidi: object, topContext: string}>} [opts.relaunchHeaded] - Hybrid relaunch hook (from connectFirefox).
 * @returns {Promise<object>} page object
 */
export async function createFirefoxPage(bidi, opts = {}) {
  const defaultPruneMode = opts.pruneMode || 'act';
  const urlGuard = opts.urlGuard || {};
  const uploadDir = opts.uploadDir || null;
  const incognito = !!opts.incognito;
  const consent = opts.consent !== false;
  // Hybrid mode: on a bot-challenge page, relaunch headed and retry. The
  // relaunch tears down this Firefox+BiDi and returns a fresh one, so the
  // browser lifecycle is owned by connectFirefox, which supplies relaunchHeaded.
  const hybrid = !!opts.hybrid;
  const relaunchHeaded = opts.relaunchHeaded || null;
  let currentlyHeaded = !!opts.headed; // already headed → no fallback needed
  let botBlocked = false;
  // Last injectCookies(url, opts) args, so a hybrid relaunch (a brand-new
  // Firefox profile) can re-inject them — otherwise the headed retry loads
  // unauthenticated, defeating hybrid on an auth-gated challenge page.
  let lastInject = null;
  // The active browsing context. Starts at the initial tab; switchTab() points
  // it at another top-level context, so it's mutable and read via a getter.
  const { contexts } = await bidi.send('browsingContext.getTree', {});
  let topContext = contexts[0].context;

  // ref (string int) → owning browsing-context id, rebuilt every snapshot so a
  // click after a snapshot routes to the frame the element actually lives in.
  let refContexts = new Map();

  /**
   * Depth-first list of the ACTIVE tab's contexts (main frame + descendant
   * frames). Scoped to `topContext` via getTree's `root` param — without it
   * getTree returns every open tab flat, and after switchTab() to a non-first
   * tab the positional iframe-splice in snapshot() grafts another tab's frame
   * into the active tab (verified: INNER1 leaked into TAB2). Root-scoping keeps
   * topContext at index 0 so the splice stays aligned and cross-tab-safe.
   */
  async function allContexts() {
    const { contexts: tree } = await bidi.send('browsingContext.getTree', { root: topContext });
    const flat = [];
    (function walk(nodes) {
      for (const n of nodes) { flat.push(n.context); walk(n.children || []); }
    })(tree);
    return flat;
  }

  /**
   * Build the spliced AX tree for the active tab (main frame + child frames)
   * and (re)populate refContexts so a subsequent click routes to the right
   * frame. Returns the top context's root node, or null if it couldn't be
   * snapshotted. Shared by snapshot() and the consent auto-dismiss so the
   * iframe-splice logic lives in one place.
   */
  async function buildTree() {
    const contextIds = await allContexts();
    refContexts = new Map();

    // Snapshot each context, assigning refs from a shared running counter so
    // they're globally unique (matching CDP's flat integer refs).
    let base = 0;
    const treesByContext = new Map();
    for (const ctx of contextIds) {
      let raw;
      try {
        raw = await bidi.evaluate(ctx, axSnapshotExpression(base), false);
      } catch { continue; } // frame navigated mid-snapshot — skip it
      const { tree, count } = JSON.parse(raw);
      for (let r = base + 1; r <= base + count; r++) refContexts.set(String(r), ctx);
      base += count;
      treesByContext.set(ctx, tree);
    }

    // Splice each child frame's tree under an <iframe> (role 'Iframe')
    // placeholder in its parent, matched by document order — BiDi getTree
    // lists children in frame order, and the AX walk emits Iframe nodes in
    // the same order.
    const iframeNodes = (tree) => {
      const out = [];
      (function walk(n) { if (n.role === 'Iframe') out.push(n); for (const c of n.children) walk(c); })(tree);
      return out;
    };
    for (let i = 1; i < contextIds.length; i++) {
      const childTree = treesByContext.get(contextIds[i]);
      if (!childTree) continue;
      // Attach to the next unfilled Iframe placeholder in the top tree.
      const holders = iframeNodes(treesByContext.get(topContext) || { role: '', children: [] });
      const holder = holders[i - 1];
      if (holder) holder.children = [childTree];
    }

    return treesByContext.get(topContext) || null;
  }

  /** Resolve a ref to a BiDi element sharedId in its owning context. */
  async function resolveRef(ref) {
    const context = refContexts.get(String(ref));
    if (!context) throw new Error(`Unknown ref: ${ref} (snapshot first, or it's stale)`);
    const res = await bidi.send('script.evaluate', {
      expression: `document.querySelector('[${REF_ATTR}="${ref}"]')`,
      target: { context }, awaitPromise: false, resultOwnership: 'root',
    });
    if (res.type === 'exception' || !res.result || res.result.type !== 'node') {
      throw new Error(`Could not resolve element for ref ${ref}`);
    }
    return { context, sharedId: res.result.sharedId };
  }

  async function pointerClick(ref) {
    const { context, sharedId } = await resolveRef(ref);
    await bidi.send('input.performActions', {
      context,
      actions: [{
        type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId } } },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
  }

  async function keyType(context, text) {
    const actions = [];
    for (const ch of text) { actions.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch }); }
    await bidi.send('input.performActions', {
      context, actions: [{ type: 'key', id: 'kbd', actions }],
    });
  }

  /**
   * Reject if `p` doesn't settle within `ms`. BiDi commands have no built-in
   * timeout, so a navigate/reload/traverse whose `wait:'complete'` never fires
   * (a page that never loads) would otherwise hang the call forever.
   */
  function withTimeout(p, ms, label) {
    let timer;
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }

  // Download tracking, parity with the CDP `page.downloads` array. Firefox
  // downloads land in `downloadDir` (a throwaway dir the caller sets via launch
  // prefs — see connectFirefox / firefox.js), so `savedPath` is a real path the
  // caller can read. BiDi emits browsingContext.downloadWillBegin (start) +
  // downloadEnd (finish, with the actual filepath + status) — measured against
  // real Firefox. Records mirror the CDP shape:
  // { url, suggestedFilename, savedPath, state, totalBytes, receivedBytes }.
  const downloads = [];
  async function setupDownloads() {
    await bidi.subscribe(['browsingContext.downloadWillBegin', 'browsingContext.downloadEnd']);
    bidi.on('browsingContext.downloadWillBegin', (e) => {
      downloads.push({
        url: e.url,
        suggestedFilename: e.suggestedFilename || '',
        savedPath: null,
        state: 'inProgress',
        totalBytes: 0,
        receivedBytes: 0,
      });
    });
    bidi.on('browsingContext.downloadEnd', (e) => {
      // Correlate to the most recent still-in-progress record for this URL.
      const d = [...downloads].reverse().find((x) => x.url === e.url && x.state === 'inProgress');
      if (!d) return;
      // BiDi status is 'complete' | 'canceled'; normalize 'complete' to CDP's
      // 'completed' so callers can branch on one vocabulary across engines.
      d.state = e.status === 'complete' ? 'completed' : e.status || 'completed';
      d.savedPath = e.filepath || null;
    });
  }

  // JS dialog handling (alert/confirm/prompt/beforeunload), parity with the
  // CDP path in index.js. The BiDi session is created with
  // unhandledPromptBehavior:'ignore' (see bidi.js) so prompts stay open until
  // we respond; setupDialogs() must run before the first navigation or an
  // 'ignore' prompt would hang the page. Default: accept everything except
  // beforeunload (dismiss = stay), mirroring the CDP default. A caller can
  // override per-dialog via page.onDialog(handler).
  const dialogLog = [];
  let onDialogHandler = null;
  async function setupDialogs() {
    await bidi.subscribe(['browsingContext.userPromptOpened']);
    bidi.on('browsingContext.userPromptOpened', async (e) => {
      dialogLog.push(dialogLogEntry(e.type, e.message));
      // Shared decision core with the CDP path (dialog.js). BiDi's userText is
      // the CDP promptText; its defaultValue is the CDP defaultPrompt.
      const { accept, promptText } = await decideDialog(
        { type: e.type, message: e.message, defaultPrompt: e.defaultValue },
        onDialogHandler,
      );
      try {
        await bidi.send('browsingContext.handleUserPrompt', {
          context: e.context, accept, userText: promptText,
        });
      } catch {
        // Prompt already gone (closed by page JS / navigation). Nothing to do.
      }
    });
  }

  /**
   * Wire all event subscriptions (dialogs, downloads, load) on the CURRENT
   * bidi connection. Run once at construction, and again after a hybrid
   * relaunch swaps in a fresh connection. Dialogs must be wired before any
   * navigation (the 'ignore' capability would otherwise hang a prompt).
   */
  async function setupSubscriptions() {
    await setupDialogs();
    await setupDownloads();
    await bidi.subscribe(['browsingContext.load']);
  }

  /**
   * Post-navigation routine shared by goto() and the hybrid retry: settle for
   * dynamic content, auto-dismiss consent (best-effort), then report whether
   * the resulting page looks like a bot challenge.
   */
  async function afterNavigate() {
    await new Promise((r) => setTimeout(r, 500));
    // Build the tree ONCE and use it for both consent dismissal and challenge
    // detection. A challenge page (Cloudflare/hCaptcha) never carries a consent
    // banner, so dismissing consent can't flip the challenge verdict — reusing
    // the pre-dismiss tree avoids a second full AX reconstruction per goto.
    let root = null;
    try { root = await buildTree(); } catch { /* null → treated as challenge */ }
    if (consent && root) {
      try { await dismissConsentFirefox(root, (ref) => pointerClick(ref)); }
      catch { /* consent dismissal is best-effort */ }
    }
    return isChallengePage(root, countNodes(root));
  }

  const page = {
    /** The BiDi escape hatch, analogous to connect()'s page.cdp. */
    get bidi() { return bidi; },
    /** The active browsing-context id (getter so it tracks switchTab). */
    get context() { return topContext; },
    /** Whether the last goto() landed on a bot-challenge page (parity w/ CDP). */
    get botBlocked() { return botBlocked; },

    async goto(url, timeout = 30000) {
      // Same navigation guard the CDP path enforces — block file:/chrome:/
      // view-source: and (optionally) private-network hosts before navigating.
      assertNavigable(url, urlGuard);
      refContexts = new Map(); // refs from the previous page are now stale
      await withTimeout(
        bidi.send('browsingContext.navigate', { context: topContext, url, wait: 'complete' }),
        timeout, `goto(${url})`);
      // Settle + consent + challenge detection (mirrors the CDP path).
      botBlocked = await afterNavigate();

      // Hybrid fallback: on a bot-challenge page, relaunch headed once and
      // retry — a real display often clears an interstitial headless can't.
      // Only when hybrid mode and we're still headless. relaunchHeaded (from
      // connectFirefox) tears down this Firefox+BiDi and returns a fresh one.
      if (botBlocked && hybrid && !currentlyHeaded && relaunchHeaded) {
        try {
          const relaunched = await relaunchHeaded();
          bidi = relaunched.bidi;          // rebind the closure — all inner fns follow
          topContext = relaunched.topContext;
          currentlyHeaded = true;
          refContexts = new Map();
          await setupSubscriptions();      // re-wire dialogs/downloads/load on the new bidi
          // Re-inject cookies into the fresh profile BEFORE navigating, so the
          // headed retry is authenticated (the relaunch is a new Firefox profile
          // — the pre-relaunch session's cookies are gone).
          if (lastInject) {
            try { await page.injectCookies(lastInject.url, lastInject.cookieOpts); } catch { /* best-effort */ }
          }
          await withTimeout(
            bidi.send('browsingContext.navigate', { context: topContext, url, wait: 'complete' }),
            timeout, `goto(${url})`);
          botBlocked = await afterNavigate();
        } catch {
          // Headed relaunch failed (no display?) — keep the headless result;
          // botBlocked stays true so the caller can see it didn't clear.
        }
      }
    },

    async snapshot(pruneOpts) {
      const root = await buildTree();
      if (!root) return '';

      const pageUrl = await bidi.evaluate(topContext, 'location.href', false).catch(() => '');
      const raw = formatTree(root);
      if (pruneOpts === false) return `url: ${pageUrl}\n` + raw;

      const mode = pruneOpts?.mode || defaultPruneMode;
      const pruned = pruneTree(root, { mode });
      const out = pruned ? formatTree(pruned) : '';
      const stats = `url: ${pageUrl}\n${raw.length.toLocaleString()} chars → ${out.length.toLocaleString()} chars`
        + ` (${raw.length ? Math.round((1 - out.length / raw.length) * 100) : 0}% pruned)`;
      return stats + '\n' + out;
    },

    async readable() {
      const raw = await bidi.evaluate(topContext, `JSON.stringify(${EXTRACT_EXPRESSION})`, true);
      return finalizeReadable(JSON.parse(raw));
    },

    async click(ref) { await pointerClick(ref); },

    async type(ref, text, typeOpts = {}) {
      const { context, sharedId } = await resolveRef(ref);
      // Focus the field (and optionally clear it) in-page, then send real key
      // events so input handlers fire.
      await bidi.send('script.callFunction', {
        functionDeclaration: `function(clear){ this.focus(); if(clear){ if('value' in this) this.value=''; else this.textContent=''; this.dispatchEvent(new Event('input',{bubbles:true})); } }`,
        arguments: [{ type: 'boolean', value: !!typeOpts.clear }],
        this: { sharedId },
        target: { context }, awaitPromise: false,
      });
      await keyType(context, text);
    },

    async press(key) {
      const value = BIDI_KEYS[key] || (key.length === 1 ? key : null);
      if (!value) throw new Error(`Unknown key: "${key}". Valid: ${Object.keys(BIDI_KEYS).join(', ')}`);
      await bidi.send('input.performActions', {
        context: topContext,
        actions: [{ type: 'key', id: 'kbd', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }],
      });
    },

    async scroll(deltaY) {
      await bidi.evaluate(topContext, `window.scrollBy(0, ${Number(deltaY)})`, false);
    },

    async hover(ref) {
      const { context, sharedId } = await resolveRef(ref);
      await bidi.send('input.performActions', {
        context,
        actions: [{
          type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
          actions: [{ type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId } } }],
        }],
      });
    },

    /**
     * Inject cookies from the user's real browser into this Firefox session,
     * via BiDi storage.setCookie. Scoped to the URL host via the SHARED
     * scopedCookiesForUrl (same as the CDP path) — never the whole jar.
     */
    async injectCookies(url, cookieOpts) {
      if (incognito) return 0;
      lastInject = { url, cookieOpts }; // remember for a hybrid re-inject
      const cookies = scopedCookiesForUrl(url, { browser: cookieOpts?.browser });
      let injected = 0;
      for (const c of cookies) {
        const cookie = {
          name: c.name,
          value: { type: 'string', value: String(c.value ?? '') },
          domain: String(c.domain || '').replace(/^\./, ''),
          path: c.path || '/',
        };
        if (c.secure) cookie.secure = true;
        if (c.httpOnly) cookie.httpOnly = true;
        if (c.sameSite) cookie.sameSite = String(c.sameSite).toLowerCase();
        if (c.expires && c.expires > 0) cookie.expiry = Math.floor(c.expires);
        try { await bidi.send('storage.setCookie', { cookie }); injected++; } catch { /* skip bad cookie */ }
      }
      return injected;
    },

    async select(ref, value) {
      const { context, sharedId } = await resolveRef(ref);
      // Native <select>: set value + fire change. Custom dropdown: open then
      // click the matching option. Mirrors interact.js's two strategies.
      const handled = await bidi.send('script.callFunction', {
        functionDeclaration: `function(v){
          if (this.tagName === 'SELECT') {
            const opt = Array.from(this.options).find(o => o.value === v || o.textContent.trim() === v);
            if (opt) { this.value = opt.value; this.dispatchEvent(new Event('change',{bubbles:true})); return true; }
            return false;
          }
          this.click();
          return false;
        }`,
        arguments: [{ type: 'string', value }],
        this: { sharedId }, target: { context }, awaitPromise: false,
      });
      if (handled.type === 'success' && handled.result?.value === true) return;
      // Custom dropdown fallback: click a matching option after it opens.
      await new Promise((r) => setTimeout(r, 300));
      await bidi.evaluate(context, `(() => {
        for (const o of document.querySelectorAll('[role="option"],[role="menuitem"],li[role="option"]')) {
          if (o.textContent.trim() === ${JSON.stringify(value)}) { o.click(); return true; }
        }
        return false;
      })()`, false);
    },

    async drag(fromRef, toRef) {
      const from = await resolveRef(fromRef);
      const to = await resolveRef(toRef);
      if (from.context !== to.context) {
        throw new Error('drag() between elements in different frames is not supported');
      }
      await bidi.send('input.performActions', {
        context: from.context,
        actions: [{
          type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId: from.sharedId } } },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId: to.sharedId } } },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      });
    },

    async upload(ref, files) {
      // Same upload sandbox the CDP path enforces: every path must resolve
      // (symlinks included) inside uploadDir when set.
      assertUploadAllowed(files, uploadDir);
      const { context, sharedId } = await resolveRef(ref);
      await bidi.send('input.setFiles', { context, element: { sharedId }, files });
    },

    async goBack() { await traverse(-1); },
    async goForward() { await traverse(1); },

    async reload() {
      // Note: Firefox BiDi does not yet support the ignoreCache argument, so
      // (unlike the CDP path) reload() always does a normal reload.
      await withTimeout(
        bidi.send('browsingContext.reload', { context: topContext, wait: 'complete' }),
        30000, 'reload');
      refContexts = new Map();
      await new Promise((r) => setTimeout(r, 300));
    },

    async screenshot(screenshotOpts = {}) {
      const fmt = screenshotOpts.format || 'png';
      const type = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
      const format = { type };
      if (type !== 'image/png') format.quality = (screenshotOpts.quality || 80) / 100;
      const { data } = await bidi.send('browsingContext.captureScreenshot', { context: topContext, format });
      return data; // base64
    },

    async pdf(pdfOpts = {}) {
      const { data } = await bidi.send('browsingContext.print', {
        context: topContext,
        background: true,
        orientation: pdfOpts.landscape ? 'landscape' : 'portrait',
      });
      return data; // base64
    },

    async tabs() {
      const { contexts: tree } = await bidi.send('browsingContext.getTree', {});
      const out = [];
      for (let i = 0; i < tree.length; i++) {
        const title = await bidi.evaluate(tree[i].context, 'document.title', false).catch(() => '');
        out.push({ index: i, url: tree[i].url, title, context: tree[i].context });
      }
      return out;
    },

    async switchTab(index) {
      const { contexts: tree } = await bidi.send('browsingContext.getTree', {});
      if (index < 0 || index >= tree.length) throw new Error(`Tab index ${index} out of range (0-${tree.length - 1})`);
      topContext = tree[index].context;
      refContexts = new Map(); // refs from the previous tab are invalid
      await bidi.send('browsingContext.activate', { context: topContext }).catch(() => {});
    },

    async waitFor(waitOpts = {}) {
      const timeout = waitOpts.timeout || 30000;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (waitOpts.text) {
          const t = await bidi.evaluate(topContext, 'document.body ? document.body.innerText : ""', false).catch(() => '');
          if (t && t.includes(waitOpts.text)) return;
        }
        if (waitOpts.selector) {
          const found = await bidi.evaluate(topContext, `!!document.querySelector(${JSON.stringify(waitOpts.selector)})`, false).catch(() => false);
          if (found) return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`waitFor timed out after ${timeout}ms`);
    },

    /**
     * Wait until the network has been idle for `idle` ms, over BiDi
     * network.* events. Parity with the CDP page.waitForNetworkIdle (Phase 2).
     */
    async waitForNetworkIdle(idleOpts = {}) {
      return waitForNetworkIdleBiDi(bidi, idleOpts);
    },

    /** Downloads that began in this session (Phase 4 — see setupDownloads). */
    get downloads() { return downloads; },

    dialogLog,

    /**
     * Install a custom JS dialog handler, mirroring connect()'s page.onDialog.
     * Called with `{ type, message, defaultPrompt }`; may return (sync or async)
     * `{ accept: bool, promptText: string }` to override the auto-accept
     * default. Pass null to restore default behavior.
     */
    onDialog(handler) {
      onDialogHandler = handler;
    },

    /**
     * Persist cookies + localStorage to a JSON file (parity with the CDP
     * saveState). Cookies come from BiDi storage.getCookies (whose value is a
     * `{type,value}` object) and are flattened to the CDP-symmetric shape so the
     * file format matches across engines. Written 0600 — it holds session
     * tokens, so a multi-user host must not be able to read another user's.
     */
    async saveState(filePath) {
      const { cookies } = await bidi.send('storage.getCookies', {});
      const flat = cookies.map((c) => {
        const out = {
          name: c.name,
          value: c.value && typeof c.value === 'object' ? c.value.value : c.value,
          domain: c.domain,
          path: c.path,
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
        };
        if (c.sameSite && c.sameSite !== 'default') out.sameSite = c.sameSite;
        if (c.expiry && c.expiry > 0) out.expires = c.expiry;
        return out;
      });
      const lsRaw = await bidi
        .evaluate(topContext, 'JSON.stringify(Object.fromEntries(Object.entries(localStorage)))', false)
        .catch(() => '{}'); // opaque-origin pages (about:blank) throw — treat as empty
      const state = { cookies: flat, localStorage: JSON.parse(lsRaw || '{}') };
      const { writeFileSync, chmodSync } = await import('node:fs');
      writeFileSync(filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
      try { chmodSync(filePath, 0o600); } catch { /* best effort if pre-existing */ }
    },

    /**
     * Resolve when the active tab fires its next load event (parity with the
     * CDP waitForNavigation → Page.loadEventFired). Scoped to topContext so a
     * subframe load can't resolve it early. Falls back to a short settle delay
     * for SPA navigations that fire no load event.
     */
    async waitForNavigation(timeout = 30000) {
      try {
        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
          const timer = setTimeout(() => { unsub(); reject(new Error('waitForNavigation timed out')); }, timeout);
          const unsub = bidi.on('browsingContext.load', (e) => {
            if (e.context !== topContext) return;
            clearTimeout(timer); unsub(); resolve();
          });
        }));
        refContexts = new Map(); // the DOM changed — old refs are stale
      } catch {
        // No load event (SPA pushState/replaceState) — settle for DOM updates.
        await new Promise((r) => setTimeout(r, 500));
      }
    },

    async close() {
      try { await bidi.send('browsingContext.close', { context: topContext }); } catch {}
      bidi.close();
    },
  };

  /** Walk session history by delta and settle (BiDi has no load-wait here). */
  async function traverse(delta) {
    await withTimeout(
      bidi.send('browsingContext.traverseHistory', { context: topContext, delta }),
      30000, 'history navigation');
    refContexts = new Map();
    await new Promise((r) => setTimeout(r, 500));
  }

  // Wire event subscriptions before returning — dialogs must precede any
  // navigation so an 'ignore' prompt (see bidi.js capability) is never hung.
  await setupSubscriptions();

  return page;
}
