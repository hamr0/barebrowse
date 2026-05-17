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

  it('createTab wires dialog handler so dialogs do not hang navigation (F7)', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      const tab = await page.createTab();
      const url = 'data:text/html,<html><body>hi<script>alert("from-tab")</script></body></html>';
      // Without the dialog handler the alert() blocks script execution and
      // Page.loadEventFired never fires — navigate() would hang to timeout.
      // 10s gives us a clear failure rather than the integration suite's full hang.
      await tab.goto(url, 10000);
      assert.ok(page.dialogLog.some((d) => d.message === 'from-tab'),
        `tab's alert should be captured in dialogLog, got: ${JSON.stringify(page.dialogLog)}`);
      await tab.close();
    } finally {
      await page.close();
    }
  });

  it('goto invalidates refMap so stale refs error clearly (F5)', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      await page.goto('data:text/html,<button>BUTTON-ON-PAGE-A</button>');
      const snapA = await page.snapshot();
      // Pull any ref from page A's snapshot
      const m = snapA.match(/\[ref=([^\]]+)\]/);
      assert.ok(m, `expected at least one [ref=N] marker, got:\n${snapA}`);
      const refFromA = m[1];

      await page.goto('data:text/html,<p>different page B with no buttons</p>');
      // The ref from page A must no longer resolve — clear error, not a
      // silent wrong-element click or a CDP "Node was destroyed" leak.
      await assert.rejects(
        () => page.click(refFromA),
        /No element found for ref/,
        'a ref captured before goto() must be rejected after navigation',
      );
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
