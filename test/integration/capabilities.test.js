/**
 * Integration tests for session introspection: page.engine + page.capabilities.
 * These let a caller (or an MCP/CLI session) ask "which engine am I on and what
 * can it do?" without probing for a cdp/bidi escape hatch — the discoverability
 * gap that made a peer session conclude Firefox wasn't supported.
 *
 * These assert the Chromium/CDP shape (engine 'chromium', escapeHatch 'cdp').
 * connect() now falls back to Firefox when no Chromium is installed, so the
 * suite is skipped on a Chromium-less host rather than reporting a false
 * regression. Firefox parity is covered by the FF capability suite.
 *
 * Run: node --test test/integration/capabilities.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../../src/index.js';
import { findBrowser } from '../../src/chromium.js';

const CAP_KEYS = [
  'engine', 'mode', 'attach', 'escapeHatch',
  'reloadIgnoreCache', 'downloads', 'stealth', 'cookieInjection',
];

// findBrowser() throws when no Chromium-based browser is installed; in that
// case connect() falls back to Firefox and these Chromium-shape assertions
// no longer apply, so skip rather than false-fail.
let hasChromium = true;
try { findBrowser(); } catch { hasChromium = false; }

describe('session introspection — page.engine + page.capabilities', { skip: hasChromium ? false : 'no Chromium installed — Chromium-shape assertions N/A' }, () => {
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

  // Regression guard for the "stealth frozen at connect()" bug: capabilities.stealth
  // must be a LIVE getter (reflecting currentlyHeaded), not a value captured once —
  // otherwise it stays stale after a hybrid headed relaunch flips the session headed.
  // The value assertions above can't catch a regression to a frozen value, since a
  // headed-launch session reports `false` under both the frozen and the live formula;
  // only the property descriptor tells them apart.
  it('capabilities.stealth is a live getter, not a frozen value', async () => {
    const page = await connect();
    try {
      const desc = Object.getOwnPropertyDescriptor(page.capabilities, 'stealth');
      assert.equal(typeof desc.get, 'function', 'stealth must be a live getter, not a frozen data property');
    } finally {
      await page.close();
    }
  });
});
