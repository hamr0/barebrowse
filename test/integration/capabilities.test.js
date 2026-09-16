/**
 * Integration tests for session introspection: page.engine + page.capabilities.
 * These let a caller (or an MCP/CLI session) ask "which engine am I on and what
 * can it do?" without probing for a cdp/bidi escape hatch — the discoverability
 * gap that made a peer session conclude Firefox wasn't supported.
 *
 * Chromium-only here (default engine). Firefox parity is asserted structurally
 * in the type-surface + covered by the FF capability suite; launching Firefox
 * from CI is not guaranteed, and these run under the local integration suite.
 *
 * Run: node --test test/integration/capabilities.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../../src/index.js';

const CAP_KEYS = [
  'engine', 'mode', 'attach', 'escapeHatch',
  'reloadIgnoreCache', 'downloads', 'stealth', 'cookieInjection',
];

describe('session introspection — page.engine + page.capabilities', () => {
  it('default connect() reports the chromium engine + its capabilities', async () => {
    const page = await connect();
    try {
      assert.equal(page.engine, 'chromium');
      // engine and capabilities.engine agree — one source of truth for callers.
      assert.equal(page.capabilities.engine, page.engine);

      const cap = page.capabilities;
      // Shape is complete — a caller can rely on every documented key existing.
      for (const k of CAP_KEYS) {
        assert.ok(k in cap, `capabilities missing key: ${k}`);
      }

      // Default owned-headless session: full capabilities, cdp hatch.
      assert.equal(cap.mode, 'headless');
      assert.equal(cap.attach, false);
      assert.equal(cap.escapeHatch, 'cdp');
      assert.equal(cap.reloadIgnoreCache, true); // CDP honors ignoreCache (FF doesn't)
      assert.equal(cap.downloads, true);
      assert.equal(cap.stealth, true);           // headless, non-attach → stealthed
      assert.equal(cap.cookieInjection, true);

      // The named escape hatch is actually present under that name.
      assert.ok(page[cap.escapeHatch], 'escapeHatch names a missing property');
    } finally {
      await page.close();
    }
  });

  it('incognito disables cookie injection in reported capabilities', async () => {
    const page = await connect({ incognito: true });
    try {
      assert.equal(page.capabilities.cookieInjection, false);
    } finally {
      await page.close();
    }
  });

  it('headed session reports stealth disabled', async () => {
    const page = await connect({ mode: 'headed' });
    try {
      assert.equal(page.capabilities.stealth, false);
    } finally {
      await page.close();
    }
  });
});
