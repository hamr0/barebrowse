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
  const noted = new Set();
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
      noted.add(host);
    },
    /** Call right before a goto navigates. */
    startGoto() { gotoBlocks = []; },
    /**
     * The block that hit this goto's own tab (a popup's block is not the
     * goto's), consumed; it is reported as NAV_BLOCKED, so no snapshot note.
     */
    takeGotoBlock(ctx) {
      const b = gotoBlocks.find((x) => x.ctx === ctx);
      if (!b) return null;
      gotoBlocks = gotoBlocks.filter((x) => x !== b);
      noted.delete(b.host);
      return { url: b.url, host: b.host };
    },
    /** Snapshot lines for in-page blocked jumps since the last call. */
    takeNotes() {
      const out = [...noted].map((h) => `[blocked navigation to ${h}]\n`).join('');
      noted.clear();
      return out;
    },
  };
}
