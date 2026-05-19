/**
 * Unit tests for src/blocklist.js — sanity-checks the default pattern list
 * so a typo doesn't silently disable blocking for a whole tracker family.
 *
 * Run: node --test test/unit/blocklist.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BLOCKLIST } from '../../src/blocklist.js';
import { applyBlocklist, _resetBlocklistWarning } from '../../src/index.js';

describe('DEFAULT_BLOCKLIST', () => {
  it('exports a non-empty array', () => {
    assert.ok(Array.isArray(DEFAULT_BLOCKLIST));
    assert.ok(DEFAULT_BLOCKLIST.length > 0);
  });

  it('stays in the curated band (~100-150 patterns)', () => {
    // Drift guard: if someone wholesale-imports Peter Lowe's ~3k list we lose
    // the per-request matching budget that motivated the curated set. If it
    // shrinks below 80 we've likely deleted a tracker family by accident.
    assert.ok(DEFAULT_BLOCKLIST.length >= 80,
      `blocklist shrunk to ${DEFAULT_BLOCKLIST.length} — did a cluster get deleted?`);
    assert.ok(DEFAULT_BLOCKLIST.length <= 200,
      `blocklist grew to ${DEFAULT_BLOCKLIST.length} — pull tail entries or reconsider curation`);
  });

  it('every pattern starts with a scheme glob and contains a wildcard', () => {
    // CDP setBlockedURLs takes glob patterns; a bare hostname here is almost
    // always a typo (won't match http:// or https:// URL prefixes).
    for (const p of DEFAULT_BLOCKLIST) {
      assert.ok(typeof p === 'string', `pattern not string: ${p}`);
      assert.ok(p.startsWith('*://') || p.startsWith('http://') || p.startsWith('https://'),
        `pattern must start with scheme glob, got: ${p}`);
      assert.ok(p.includes('*'), `pattern must contain wildcard, got: ${p}`);
    }
  });

  it('has no duplicates', () => {
    const seen = new Set();
    for (const p of DEFAULT_BLOCKLIST) {
      assert.ok(!seen.has(p), `duplicate pattern: ${p}`);
      seen.add(p);
    }
  });

  it('covers the long-tail families added in v0.10.x backlog', () => {
    // These were carried in the v0.10.0 backlog as low-risk additive entries.
    // Asserting them explicitly guards against a future re-curation dropping
    // them along with truly low-value patterns.
    const mustCover = [
      'cloudflareinsights.com',
      'matomo.cloud',
      'appsflyer.com',
      'branch.io',
      'adjust.com',
      'amplify.outbrain.com',
      'log.outbrain.com',
      'posthog.com/static/array.js',
    ];
    const joined = DEFAULT_BLOCKLIST.join(' ');
    for (const needle of mustCover) {
      assert.ok(joined.includes(needle), `missing long-tail entry: ${needle}`);
    }
  });

  it('covers the top tracker families by name', () => {
    // High-frequency clusters that must be present — losing any of these is
    // a regression that'd silently drop blocking coverage for the biggest
    // chunks of agent traffic.
    const mustCover = [
      'doubleclick.net',
      'google-analytics.com',
      'googletagmanager.com',
      'connect.facebook.net',
      'amazon-adsystem.com',
      'segment.io',
      'amplitude.com',
      'mixpanel.com',
      'hotjar.com',
      'fullstory.com',
      'criteo.com',
      'taboola.com',
    ];
    const joined = DEFAULT_BLOCKLIST.join(' ');
    for (const needle of mustCover) {
      assert.ok(joined.includes(needle), `missing cluster: ${needle}`);
    }
  });
});

describe('applyBlocklist warn-once on Network.setBlockedURLs reject', () => {
  let origWarn;
  let warnings;

  beforeEach(() => {
    warnings = [];
    origWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    _resetBlocklistWarning();
  });

  afterEach(() => {
    console.warn = origWarn;
    _resetBlocklistWarning();
  });

  it('emits exactly one warn across many rejecting calls', async () => {
    // Mock CDP session whose send() always rejects, simulating a Chromium
    // build old enough to lack Network.setBlockedURLs.
    const rejectingSession = {
      send: async () => { throw new Error("'Network.setBlockedURLs' wasn't found"); },
    };
    for (let i = 0; i < 5; i++) {
      await applyBlocklist(rejectingSession, { blockAds: true });
    }
    assert.equal(warnings.length, 1,
      `expected exactly one warn across 5 rejecting calls, got ${warnings.length}: ${JSON.stringify(warnings)}`);
    assert.ok(warnings[0].includes('barebrowse'),
      `warn message should identify the library, got: ${warnings[0]}`);
    assert.ok(warnings[0].includes('Network.setBlockedURLs'),
      `warn message should name the CDP method, got: ${warnings[0]}`);
  });

  it('does not warn when the session succeeds', async () => {
    const okSession = { send: async () => ({}) };
    for (let i = 0; i < 3; i++) {
      await applyBlocklist(okSession, { blockAds: true });
    }
    assert.equal(warnings.length, 0,
      `no warn expected on successful sessions, got: ${JSON.stringify(warnings)}`);
  });

  it('does not warn when blocking is fully opted out', async () => {
    const rejectingSession = {
      send: async () => { throw new Error('should never reach here'); },
    };
    // blockAds:false with no blockUrls → applyBlocklist returns before send.
    await applyBlocklist(rejectingSession, { blockAds: false });
    assert.equal(warnings.length, 0,
      `opted-out callers shouldn't trigger the warn path, got: ${JSON.stringify(warnings)}`);
  });
});
