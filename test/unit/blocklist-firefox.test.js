/**
 * blocklist-firefox.test.js — Firefox/BiDi ad-block (Phase 3).
 *
 * BiDi can't express our glob patterns natively (network.addIntercept rejects
 * '*'), so the Firefox path registers a catch-all intercept and matches each
 * request URL in-process. These tests guard both halves: the glob→predicate
 * compiler (makeBlockMatcher) and the intercept/decision wiring
 * (applyFirefoxBlocklist), driven by a fake BiDi replaying the measured
 * network.beforeRequestSent shape (isBlocked flag + request.request id).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeBlockMatcher, resolveBlocklistPatterns, DEFAULT_BLOCKLIST } from '../../src/blocklist.js';
import { applyFirefoxBlocklist } from '../../src/blocklist-firefox.js';

describe('makeBlockMatcher — CDP glob → URL predicate', () => {
  it('matches subdomain wildcards like the CDP list', () => {
    const m = makeBlockMatcher(['*://*.doubleclick.net/*']);
    assert.equal(m('https://stats.g.doubleclick.net/collect'), true);
    assert.equal(m('http://ad.doubleclick.net/x'), true);
    // Bare apex is NOT matched by *.doubleclick.net — faithful to CDP, whose
    // identical pattern also requires a subdomain (real traffic is subdomained).
    assert.equal(m('http://doubleclick.net/'), false);
    assert.equal(m('https://example.com/'), false);
  });

  it("'*' and '?' are the glob wildcards; other chars are literal", () => {
    const m = makeBlockMatcher(['*://*.facebook.com/tr*']);
    assert.equal(m('https://www.facebook.com/tr?id=1'), true);
    assert.equal(m('https://www.facebook.com/tr/'), true);
    assert.equal(m('https://www.facebook.com/home'), false);
    // A '.' in the pattern must not act as a regex wildcard.
    assert.equal(makeBlockMatcher(['*://a.b/*'])('https://axb/x'), false);
  });

  it("'?' matches exactly one character (CDP parity), not a literal '?'", () => {
    const m = makeBlockMatcher(['*://ads?.example.com/*']);
    assert.equal(m('https://ads1.example.com/x'), true);  // ? = one char
    assert.equal(m('https://adsX.example.com/x'), true);
    assert.equal(m('https://ads.example.com/x'), false);  // ? requires a char
    assert.equal(m('https://ads12.example.com/x'), false); // ? is not '*'
  });

  it('the real DEFAULT_BLOCKLIST blocks GA and passes normal hosts', () => {
    const m = makeBlockMatcher(DEFAULT_BLOCKLIST);
    assert.equal(m('https://www.google-analytics.com/collect?v=1'), true);
    assert.equal(m('https://www.googletagmanager.com/gtm.js'), true);
    assert.equal(m('https://en.wikipedia.org/wiki/Main_Page'), false);
    assert.equal(m('https://example.com/'), false);
  });
});

describe('resolveBlocklistPatterns — shared blockAds/blockUrls merge (CDP + BiDi)', () => {
  it('blockAds on (default): default list, extended by blockUrls', () => {
    assert.deepEqual(resolveBlocklistPatterns({}), DEFAULT_BLOCKLIST);
    const ext = resolveBlocklistPatterns({ blockUrls: ['*://x.test/*'] });
    assert.equal(ext.length, DEFAULT_BLOCKLIST.length + 1);
    assert.equal(ext.at(-1), '*://x.test/*');
  });

  it('blockAds:false drops the default list', () => {
    assert.deepEqual(resolveBlocklistPatterns({ blockAds: false }), []);
    assert.deepEqual(resolveBlocklistPatterns({ blockAds: false, blockUrls: ['*://x.test/*'] }), ['*://x.test/*']);
  });
});

/** Fake BiDi capturing send() calls and replaying beforeRequestSent events. */
function fakeBiDi() {
  const handlers = new Map();
  return {
    sent: [],
    subscribed: [],
    async send(method, params) { this.sent.push({ method, params }); return {}; },
    async subscribe(events) { this.subscribed.push(...events); },
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method)?.delete(handler);
    },
    emit(method, params) {
      const set = handlers.get(method);
      if (set) for (const h of [...set]) h(params);
    },
  };
}

/** Let the async event handler's awaited send() calls settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('applyFirefoxBlocklist — intercept + per-request decision', () => {
  it('registers a catch-all beforeRequestSent intercept', async () => {
    const bidi = fakeBiDi();
    await applyFirefoxBlocklist(bidi, { blockAds: true });
    const intercept = bidi.sent.find((c) => c.method === 'network.addIntercept');
    assert.ok(intercept, 'addIntercept was called');
    assert.deepEqual(intercept.params.phases, ['beforeRequestSent']);
    assert.deepEqual(intercept.params.urlPatterns, [], 'catch-all (empty patterns)');
    assert.ok(bidi.subscribed.includes('network.beforeRequestSent'));
  });

  it('fails a blocklisted request and continues an allowed one', async () => {
    const bidi = fakeBiDi();
    await applyFirefoxBlocklist(bidi, { blockAds: true });
    bidi.emit('network.beforeRequestSent', {
      isBlocked: true,
      request: { request: 'r1', url: 'https://www.google-analytics.com/collect' },
    });
    bidi.emit('network.beforeRequestSent', {
      isBlocked: true,
      request: { request: 'r2', url: 'https://example.com/page' },
    });
    await tick();
    const fail = bidi.sent.find((c) => c.method === 'network.failRequest');
    const cont = bidi.sent.find((c) => c.method === 'network.continueRequest');
    assert.deepEqual(fail?.params, { request: 'r1' }, 'tracker failed');
    assert.deepEqual(cont?.params, { request: 'r2' }, 'allowed continued');
  });

  it('ignores non-intercepted (isBlocked=false) capture events', async () => {
    const bidi = fakeBiDi();
    await applyFirefoxBlocklist(bidi, { blockAds: true });
    bidi.emit('network.beforeRequestSent', {
      isBlocked: false,
      request: { request: 'r3', url: 'https://www.google-analytics.com/x' },
    });
    await tick();
    assert.equal(bidi.sent.filter((c) => c.method === 'network.failRequest').length, 0);
    assert.equal(bidi.sent.filter((c) => c.method === 'network.continueRequest').length, 0);
  });

  it('swallows a "no such request" race on the reply', async () => {
    const bidi = fakeBiDi();
    bidi.send = async (method) => {
      if (method === 'network.failRequest') throw new Error('BiDi error: no such request');
      return {};
    };
    await applyFirefoxBlocklist(bidi, { blockAds: true });
    // Must not reject the (unawaitable) handler — just assert we get here.
    bidi.emit('network.beforeRequestSent', {
      isBlocked: true,
      request: { request: 'gone', url: 'https://doubleclick.net/x' },
    });
    await tick();
    assert.ok(true, 'no unhandled rejection from the swallowed race');
  });

  it('blockAds:false with no blockUrls installs nothing', async () => {
    const bidi = fakeBiDi();
    await applyFirefoxBlocklist(bidi, { blockAds: false });
    assert.equal(bidi.sent.length, 0);
    assert.equal(bidi.subscribed.length, 0);
  });

  it('blockUrls extend the default list', async () => {
    const bidi = fakeBiDi();
    await applyFirefoxBlocklist(bidi, { blockAds: true, blockUrls: ['*://custom.tracker.test/*'] });
    bidi.emit('network.beforeRequestSent', {
      isBlocked: true,
      request: { request: 'c1', url: 'https://custom.tracker.test/beacon' },
    });
    await tick();
    assert.ok(bidi.sent.find((c) => c.method === 'network.failRequest')?.params.request === 'c1');
  });

  it('blockAds:false + blockUrls blocks ONLY the custom patterns', async () => {
    const bidi = fakeBiDi();
    await applyFirefoxBlocklist(bidi, { blockAds: false, blockUrls: ['*://custom.tracker.test/*'] });
    // A default-list host is NOT blocked now.
    bidi.emit('network.beforeRequestSent', {
      isBlocked: true,
      request: { request: 'ga', url: 'https://www.google-analytics.com/collect' },
    });
    bidi.emit('network.beforeRequestSent', {
      isBlocked: true,
      request: { request: 'c1', url: 'https://custom.tracker.test/x' },
    });
    await tick();
    assert.equal(bidi.sent.find((c) => c.params?.request === 'ga')?.method, 'network.continueRequest');
    assert.equal(bidi.sent.find((c) => c.params?.request === 'c1')?.method, 'network.failRequest');
  });
});
