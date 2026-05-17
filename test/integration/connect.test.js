/**
 * Integration tests for connect() session lifecycle and contract.
 * Bug-fix regression tests live here as fixes land.
 *
 * Run: node --test test/integration/connect.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../../src/index.js';

describe('connect() — page handle contract', () => {
  it('exposes page.cdp as a getter so it survives session swaps (F1)', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      const desc = Object.getOwnPropertyDescriptor(page, 'cdp');
      assert.equal(typeof desc.get, 'function',
        'page.cdp must be a getter — a captured value goes stale after hybrid fallback or switchTab swaps the underlying session');
      // Sanity: getter actually returns a live CDP session
      const { product } = await page.cdp.send('Browser.getVersion');
      assert.ok(product, 'cdp.send should reach the live session');
    } finally {
      await page.close();
    }
  });

  it('switchTab actually swaps the working session (F4)', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      await page.goto('data:text/html,<title>TAB-ONE</title><h1>page one</h1>');

      // Open a second tab from within the page (window.open is suppressed in
      // headless, so use Target.createTarget directly via the escape hatch).
      const { targetId } = await page.cdp.send('Target.createTarget',
        { url: 'data:text/html,<title>TAB-TWO</title><h1>page two</h1>' });
      // Give the new tab a moment to load its data: URL
      await new Promise((r) => setTimeout(r, 300));

      const tabs = await page.tabs();
      const newIdx = tabs.findIndex((t) => t.targetId === targetId);
      assert.ok(newIdx >= 0, 'new tab should be in tabs() list');

      await page.switchTab(newIdx);
      const snap = await page.snapshot();
      assert.ok(snap.includes('page two'),
        `snapshot after switchTab should show new tab content, got:\n${snap}`);
      assert.ok(!snap.includes('page one'),
        'snapshot must NOT still reflect the original tab');
    } finally {
      await page.close();
    }
  });
});
