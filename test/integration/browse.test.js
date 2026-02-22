/**
 * Integration tests for the browse() pipeline.
 * Requires Chromium installed: sudo dnf install chromium
 *
 * Run: node --test test/integration/browse.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { browse, connect } from '../../src/index.js';

describe('browse()', () => {
  it('returns ARIA snapshot for a public page', async () => {
    const snapshot = await browse('https://example.com');
    assert.ok(snapshot.length > 0, 'snapshot should not be empty');
    assert.ok(snapshot.includes('Example Domain'), 'should contain page title');
  });

  it('includes heading and ref markers', async () => {
    const snapshot = await browse('https://example.com');
    assert.ok(snapshot.includes('heading'), 'should have heading role');
    assert.ok(snapshot.includes('[ref='), 'should have ref markers for interaction');
    // In browse mode, links should also be present
    const browseSnap = await browse('https://example.com', { pruneMode: 'browse' });
    assert.ok(browseSnap.includes('link'), 'browse mode should have link role');
  });

  it('prunes by default (act mode)', async () => {
    const pruned = await browse('https://example.com');
    const raw = await browse('https://example.com', { prune: false });
    // Pruned should be smaller or equal (example.com is tiny, may not differ much)
    assert.ok(pruned.length <= raw.length, 'pruned should not be larger than raw');
  });

  it('browse mode preserves paragraphs', async () => {
    const snapshot = await browse('https://example.com', { pruneMode: 'browse' });
    assert.ok(snapshot.includes('paragraph'), 'browse mode should keep paragraphs');
    assert.ok(snapshot.includes('documentation examples'), 'should keep paragraph text');
  });

  it('act mode drops paragraphs', async () => {
    const snapshot = await browse('https://example.com', { pruneMode: 'act' });
    // Act mode on example.com: only heading survives (no interactive elements)
    assert.ok(snapshot.includes('heading'), 'should keep heading');
    // paragraph content should be gone
    assert.equal(snapshot.includes('documentation examples'), false, 'should drop paragraph text');
  });

  it('handles complex pages with significant token reduction', async () => {
    const pruned = await browse('https://news.ycombinator.com');
    const raw = await browse('https://news.ycombinator.com', { prune: false });
    const reduction = 1 - (pruned.length / raw.length);
    console.log(`  HN reduction: ${Math.round(reduction * 100)}% (${raw.length} → ${pruned.length})`);
    assert.ok(reduction > 0.2, `should reduce by at least 20%, got ${Math.round(reduction * 100)}%`);
  });

  it('can disable cookies', async () => {
    // Should not throw even with cookies: false
    const snapshot = await browse('https://example.com', { cookies: false });
    assert.ok(snapshot.includes('Example Domain'));
  });

  it('can disable pruning', async () => {
    const snapshot = await browse('https://example.com', { prune: false });
    assert.ok(snapshot.includes('Example Domain'));
    // Raw output should have InlineTextBox filtered by aria.js but not tree-pruned
    assert.ok(snapshot.includes('RootWebArea'), 'raw should keep RootWebArea');
  });
});

describe('connect()', () => {
  it('creates a long-lived session and navigates', async () => {
    const page = await connect();
    try {
      await page.goto('https://example.com');
      const snapshot = await page.snapshot();
      assert.ok(snapshot.includes('Example Domain'), 'should see page content');
    } finally {
      await page.close();
    }
  });

  it('supports multiple navigations in one session', async () => {
    const page = await connect();
    try {
      await page.goto('https://example.com');
      const snap1 = await page.snapshot();
      assert.ok(snap1.includes('Example Domain'));

      await page.goto('https://news.ycombinator.com');
      const snap2 = await page.snapshot();
      assert.ok(snap2.includes('Hacker News'));
    } finally {
      await page.close();
    }
  });

  it('snapshot accepts prune: false for raw output', async () => {
    const page = await connect();
    try {
      await page.goto('https://example.com');
      const raw = await page.snapshot(false);
      assert.ok(raw.includes('RootWebArea'), 'raw should keep RootWebArea');
    } finally {
      await page.close();
    }
  });
});
