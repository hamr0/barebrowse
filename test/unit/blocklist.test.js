/**
 * Unit tests for src/blocklist.js — sanity-checks the default pattern list
 * so a typo doesn't silently disable blocking for a whole tracker family.
 *
 * Run: node --test test/unit/blocklist.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BLOCKLIST } from '../../src/blocklist.js';

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
