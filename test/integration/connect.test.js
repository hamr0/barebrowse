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
});
