/**
 * site-lock.js — Optional top-frame site lock (`allowHosts`).
 *
 * Top-level navigations (goto, redirect hops, clicked links, JS jumps, popups)
 * to a host outside the allow list are failed in the browser before any request
 * leaves, so the page stays put. Deliberately NOT locked: subresources
 * (img/script/css/XHR/fetch), iframes, WebSocket — the lock stops an agent
 * being steered to another site, not the page from loading its own assets.
 * The engine wiring lives next to each transport (applySiteLockCDP here,
 * blocklist-firefox.js for BiDi); this file is the shared policy + state.
 */

import { navBlocked } from './navigation.js';

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Validate and normalize an allow list. Entry = `host` or `*.host`; anything
 * else (scheme, port, path, spaces, empty, bare `*`) throws — a typo must never
 * silently widen or drop the lock.
 * @param {string[]} list
 * @returns {string[]} lowercase entries
 */
export function parseAllowHosts(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('allowHosts must be a non-empty array of hostnames');
  return list.map((raw) => {
    const e = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
    const host = typeof e === 'string' && e.startsWith('*.') ? e.slice(2) : e;
    if (typeof host !== 'string' || !HOST_RE.test(host) || host.includes('..')) {
      throw new Error(`allowHosts: invalid entry ${JSON.stringify(raw)} (expected "host" or "*.host", no scheme/port/path)`);
    }
    return e;
  });
}

/**
 * Build a URL matcher from an allow list. Non-http(s) URLs (about:, data:,
 * blob:) are allowed; `host` matches that host exactly, `*.host` matches its
 * strict subdomains only (not `host` itself). An unparseable URL is refused.
 * @param {string[]} list
 * @returns {(url: string) => boolean}
 */
export function makeHostMatcher(list) {
  const entries = parseAllowHosts(list);
  const exact = new Set(entries.filter((e) => !e.startsWith('*.')));
  const suffixes = entries.filter((e) => e.startsWith('*.')).map((e) => e.slice(1)); // ".host"
  return (url) => {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    const host = u.hostname.replace(/\.$/, '');
    return exact.has(host) || suffixes.some((s) => host.endsWith(s));
  };
}

/**
 * The lock's shared state, one per connect()/browse() call, surviving
 * relaunches and new tabs (each transport just keeps calling record()).
 * @param {string[]} list
 */
export function createSiteLock(list) {
  const allowed = makeHostMatcher(list);
  const hostOf = (url) => { try { return new URL(url).hostname; } catch { return url; } };
  /** @type {{url: string, host: string, ctx: string}[]} */
  let gotoBlocks = [];
  // Snapshot notes belong to the tab/context where the block happened, so one
  // tab's (or a popup's, shown if the agent switches to it) never leak into another's.
  /** @type {Map<string, Set<string>>} */
  const noted = new Map();
  return {
    allowed,
    /** @param {string} url @throws NAV_BLOCKED when url is off the list */
    assertAllowed(url) {
      if (!allowed(url)) throw navBlocked(url, hostOf(url));
    },
    /** A top-level document request was refused. ctx = tab/context it belongs to. */
    record(url, ctx) {
      const host = hostOf(url);
      gotoBlocks.push({ url, host, ctx });
      const hosts = noted.get(ctx) ?? new Set();
      noted.set(ctx, hosts.add(host));
    },
    /** Call right before a goto navigates; drops that tab's pending notes too. */
    startGoto(ctx) { gotoBlocks = []; noted.delete(ctx); },
    /**
     * The block that hit this goto's own tab (a popup's block is not the
     * goto's), consumed; it is reported as NAV_BLOCKED, so no snapshot note.
     */
    takeGotoBlock(ctx) {
      const b = gotoBlocks.find((x) => x.ctx === ctx);
      if (!b) return null;
      gotoBlocks = gotoBlocks.filter((x) => x !== b);
      noted.get(ctx)?.delete(b.host);
      return { url: b.url, host: b.host };
    },
    /** Snapshot lines for this tab's in-page blocked jumps since the last call. */
    takeNotes(ctx) {
      const out = [...(noted.get(ctx) ?? [])].map((h) => `[blocked navigation to ${h}]\n`).join('');
      noted.delete(ctx);
      return out;
    },
  };
}

/** @typedef {ReturnType<typeof createSiteLock>} SiteLock */

/**
 * Chromium: lock every page target of this browser. A BROWSER-level
 * Fetch.enable (root client, no sessionId) pauses document requests of every
 * target, popups included, so one handler covers tabs we create later and
 * windows the page opens itself. A request is top-level when its frameId is a
 * page target id (OOPIF iframes are 'iframe' targets, subframes share their
 * parent's id space). 'Aborted' (not BlockedByClient) fails the request but
 * keeps the old page instead of swapping in a chrome-error:// page.
 * Call once per CDP connection, before the first navigation.
 * @param {object} cdp - root CDP client
 * @param {SiteLock} lock
 */
export async function applySiteLockCDP(cdp, lock) {
  const pageTargets = new Set();
  const subframes = new Set(); // ids a refresh proved are not page targets
  cdp.on('Target.targetCreated', ({ targetInfo }) => {
    if (targetInfo.type === 'page') pageTargets.add(targetInfo.targetId);
  });
  cdp.on('Target.targetDestroyed', ({ targetId }) => pageTargets.delete(targetId));
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  cdp.on('Fetch.requestPaused', async (p, sessionId) => {
    // A popup's create event can lag its first request: ask the browser
    // before treating an unknown frame as a subframe (and if that fails,
    // fail closed: treat it as top-level).
    if (!pageTargets.has(p.frameId) && !subframes.has(p.frameId)) {
      try {
        const { targetInfos } = await cdp.send('Target.getTargets');
        for (const t of targetInfos) if (t.type === 'page') pageTargets.add(t.targetId);
        if (!pageTargets.has(p.frameId)) subframes.add(p.frameId);
      } catch { pageTargets.add(p.frameId); }
    }
    const ok = !pageTargets.has(p.frameId) || lock.allowed(p.request.url);
    if (!ok) lock.record(p.request.url, p.frameId);
    try {
      if (ok) await cdp.send('Fetch.continueRequest', { requestId: p.requestId }, sessionId);
      else await cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' }, sessionId);
    } catch { /* target closed between the pause and our reply */ }
  });
  await cdp.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] });
}

/**
 * Firefox/BiDi: build the "is this paused request a locked top-level load?"
 * check that blocklist-firefox.js's single intercept handler calls (two
 * catch-all handlers on one paused request would race — one continues before
 * the other fails). A request is a top-level document load when it carries a
 * navigation id and its context has no parent. Context ids are tracked from
 * contextCreated and refreshed from getTree when an unknown one shows up, so a
 * popup whose create event lags its first request can't slip through; one that
 * is still unknown after the refresh is treated as top-level (fail closed).
 * Redirect hops arrive as their own beforeRequestSent, so each is checked.
 * @param {object} bidi - BiDi client
 * @param {SiteLock} lock
 * @returns {Promise<(e: object) => Promise<boolean>>} true = fail this request
 */
export async function createFirefoxLockCheck(bidi, lock) {
  const tops = new Set();
  const known = new Set();
  async function refresh() {
    const { contexts } = await bidi.send('browsingContext.getTree', {});
    (function walk(nodes, top) {
      for (const n of nodes) { known.add(n.context); if (top) tops.add(n.context); walk(n.children || [], false); }
    })(contexts, true);
  }
  bidi.on('browsingContext.contextCreated', (c) => { known.add(c.context); if (!c.parent) tops.add(c.context); });
  bidi.on('browsingContext.contextDestroyed', (c) => { known.delete(c.context); tops.delete(c.context); });
  await bidi.subscribe(['browsingContext.contextCreated', 'browsingContext.contextDestroyed']);
  await refresh();
  return async (e) => {
    if (e.navigation == null) return false; // subresource
    if (!known.has(e.context)) { try { await refresh(); } catch { tops.add(e.context); } }
    if (known.has(e.context) && !tops.has(e.context)) return false; // iframe
    if (lock.allowed(e.request.url)) return false;
    lock.record(e.request.url, e.context);
    return true;
  };
}
