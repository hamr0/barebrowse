/**
 * blocklist-firefox.js — Ad/tracker blocking on the Firefox/BiDi engine.
 *
 * The BiDi analogue of index.js's applyBlocklist (CDP Network.setBlockedURLs).
 * BiDi's network.addIntercept can't express our glob patterns — its urlPatterns
 * reject '*' ("forbidden character *") and have no subdomain wildcard — so we
 * register a *catch-all* intercept (empty urlPatterns) at the beforeRequestSent
 * phase and decide per request in-process, matching each URL against the shared
 * blocklist (makeBlockMatcher). Matches are failed (net error, like CDP's
 * ERR_BLOCKED_BY_CLIENT); everything else is continued immediately.
 *
 * Cost vs. CDP: CDP matches browser-side with zero round-trips. Here every
 * request pauses for one continue/fail round-trip to Node. On a typical page
 * (tens–low-hundreds of requests over a local socket) that's negligible, and
 * it's the only route that preserves glob parity without a second list.
 */

import { resolveBlocklistPatterns, makeBlockMatcher } from './blocklist.js';

/**
 * Install ad/tracker blocking on a BiDi session. Idempotent per session is the
 * caller's concern; call once at connect time before the first navigation.
 *
 * @param {object} bidi - BiDi client (send, subscribe, on).
 * @param {object} pageOpts
 * @param {boolean} [pageOpts.blockAds] - false disables the default list.
 * @param {string[]} [pageOpts.blockUrls] - extra CDP-format globs; extend the
 *   default unless blockAds is false, in which case they're the whole list.
 * @returns {Promise<void>}
 */
export async function applyFirefoxBlocklist(bidi, pageOpts = {}) {
  const patterns = resolveBlocklistPatterns(pageOpts);
  if (!patterns.length) return;

  const isBlocked = makeBlockMatcher(patterns);

  await bidi.send('network.addIntercept', {
    phases: ['beforeRequestSent'],
    urlPatterns: [],
  });
  await bidi.subscribe(['network.beforeRequestSent']);

  bidi.on('network.beforeRequestSent', async (e) => {
    // Only paused (intercepted) events need a decision; capture-only listeners
    // see the same event with isBlocked=false and must be ignored here.
    if (!e.isBlocked) return;
    const id = e.request?.request;
    if (!id) return;
    try {
      if (isBlocked(e.request.url)) {
        await bidi.send('network.failRequest', { request: id });
      } else {
        await bidi.send('network.continueRequest', { request: id });
      }
    } catch {
      // "no such request" — the request completed or was cancelled between the
      // event and our reply (redundant nav requests, aborted fetches). Harmless.
    }
  });
}
