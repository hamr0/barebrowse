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
import { extractCookies } from './auth.js';
import { assertNavigable, assertUploadAllowed } from './url-guard.js';

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
 * @returns {Promise<object>} page object
 */
export async function createFirefoxPage(bidi, opts = {}) {
  const defaultPruneMode = opts.pruneMode || 'act';
  const urlGuard = opts.urlGuard || {};
  const uploadDir = opts.uploadDir || null;
  const incognito = !!opts.incognito;
  // The active browsing context. Starts at the initial tab; switchTab() points
  // it at another top-level context, so it's mutable and read via a getter.
  const { contexts } = await bidi.send('browsingContext.getTree', {});
  let topContext = contexts[0].context;

  // ref (string int) → owning browsing-context id, rebuilt every snapshot so a
  // click after a snapshot routes to the frame the element actually lives in.
  let refContexts = new Map();

  /** Depth-first list of every browsing context (main + descendant frames). */
  async function allContexts() {
    const { contexts: tree } = await bidi.send('browsingContext.getTree', {});
    const flat = [];
    (function walk(nodes) {
      for (const n of nodes) { flat.push(n.context); walk(n.children || []); }
    })(tree);
    return flat;
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

  const page = {
    /** The BiDi escape hatch, analogous to connect()'s page.cdp. */
    get bidi() { return bidi; },
    /** The active browsing-context id (getter so it tracks switchTab). */
    get context() { return topContext; },

    async goto(url, timeout = 30000) {
      // Same navigation guard the CDP path enforces — block file:/chrome:/
      // view-source: and (optionally) private-network hosts before navigating.
      assertNavigable(url, urlGuard);
      await bidi.send('browsingContext.navigate', { context: topContext, url, wait: 'complete' });
      // Brief settle for dynamic/SPA content, matching the CDP path.
      await new Promise((r) => setTimeout(r, 500));
    },

    async snapshot(pruneOpts) {
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

      const root = treesByContext.get(topContext);
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
     * via BiDi storage.setCookie. Same-engine reuse: Firefox cookies → Firefox.
     */
    async injectCookies(url, cookieOpts) {
      if (incognito) return 0;
      const cookies = extractCookies({ browser: cookieOpts?.browser, domain: cookieOpts?.domain });
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
        try { await bidi.send('storage.setCookie', { cookie }); } catch { /* skip bad cookie */ }
      }
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
      await bidi.send('browsingContext.reload', { context: topContext, wait: 'complete' });
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

    async close() {
      try { await bidi.send('browsingContext.close', { context: topContext }); } catch {}
      bidi.close();
    },
  };

  /** Walk session history by delta and settle (BiDi has no load-wait here). */
  async function traverse(delta) {
    await bidi.send('browsingContext.traverseHistory', { context: topContext, delta });
    refContexts = new Map();
    await new Promise((r) => setTimeout(r, 500));
  }

  return page;
}
