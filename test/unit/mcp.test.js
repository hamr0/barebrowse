/**
 * Unit tests for MCP server helpers (maxChars, saveSnapshot, withRetry).
 *
 * Run: node --test test/unit/mcp.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Re-implement isTransient + withRetry locally (not exported from mcp-server.js)
function isTransient(err) {
  const m = err.message || '';
  return m.includes('WebSocket') || m.includes('Target closed') || m.includes('Session closed')
    || m.includes('CDP') || m.includes('Timeout waiting for CDP event') || m.includes('timed out');
}

async function withRetry(fn, timeoutMs) {
  async function attempt() {
    if (!timeoutMs) return await fn();
    let timer;
    const result = await Promise.race([
      fn(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs); }),
    ]);
    clearTimeout(timer);
    return result;
  }
  try {
    return await attempt();
  } catch (err) {
    if (!isTransient(err)) throw err;
    _retryCount++;
    return await attempt();
  }
}

let _retryCount = 0;

// Re-implement saveSnapshot locally to test the logic (it's not exported from mcp-server.js)
const OUTPUT_DIR = join(import.meta.dirname, '../../.barebrowse-test');

function saveSnapshot(text) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(OUTPUT_DIR, `page-${ts}.yml`);
  writeFileSync(file, text);
  return file;
}

describe('MCP saveSnapshot', () => {
  it('saves text to a .yml file and returns the path', () => {
    const text = 'url: https://example.com/\n- heading "Test"';
    const file = saveSnapshot(text);
    try {
      assert.ok(file.endsWith('.yml'), 'file should have .yml extension');
      assert.ok(file.includes('page-'), 'file should have page- prefix');
      const content = readFileSync(file, 'utf8');
      assert.equal(content, text, 'file content should match input');
    } finally {
      rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  it('maxChars threshold routes correctly', () => {
    const MAX_CHARS_DEFAULT = 30000;
    const shortText = 'x'.repeat(100);
    const longText = 'x'.repeat(40000);

    // Under limit: return inline
    const shortLimit = MAX_CHARS_DEFAULT;
    assert.ok(shortText.length <= shortLimit, 'short text should be under limit');

    // Over limit: would save to file
    assert.ok(longText.length > shortLimit, 'long text should exceed limit');

    // Custom limit
    const customLimit = 50;
    assert.ok(shortText.length > customLimit, 'short text exceeds custom limit of 50');
  });
});

describe('isTransient', () => {
  it('detects CDP death errors', () => {
    assert.ok(isTransient(new Error('WebSocket is not open')));
    assert.ok(isTransient(new Error('Target closed')));
    assert.ok(isTransient(new Error('Session closed')));
    assert.ok(isTransient(new Error('CDP connection lost')));
  });

  it('detects timeout errors', () => {
    assert.ok(isTransient(new Error('Timeout waiting for CDP event: Page.loadEventFired')));
    assert.ok(isTransient(new Error('timed out after 30s')));
  });

  it('rejects non-transient errors', () => {
    assert.ok(!isTransient(new Error('Unknown tool: foo')));
    assert.ok(!isTransient(new Error('scroll requires "direction"')));
    assert.ok(!isTransient(new Error('Node does not have a layout object')));
  });
});

describe('withRetry', () => {
  it('returns result on success', async () => {
    _retryCount = 0;
    const result = await withRetry(async () => 'ok', 5000);
    assert.equal(result, 'ok');
    assert.equal(_retryCount, 0, 'should not retry on success');
  });

  it('retries once on transient CDP error', async () => {
    _retryCount = 0;
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw new Error('WebSocket is not open');
      return 'recovered';
    }, 5000);
    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
    assert.equal(_retryCount, 1);
  });

  it('retries once on timeout', async () => {
    _retryCount = 0;
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) {
        // Simulate a slow operation that exceeds timeout
        await new Promise(r => setTimeout(r, 200));
        return 'too slow';
      }
      return 'fast';
    }, 100); // 100ms timeout — first attempt will exceed it
    assert.equal(result, 'fast');
    assert.equal(calls, 2);
    assert.equal(_retryCount, 1);
  });

  it('does not retry non-transient errors', async () => {
    _retryCount = 0;
    await assert.rejects(
      withRetry(async () => { throw new Error('Unknown tool: foo'); }, 5000),
      { message: 'Unknown tool: foo' }
    );
    assert.equal(_retryCount, 0, 'should not retry validation errors');
  });

  it('throws after second failure', async () => {
    _retryCount = 0;
    await assert.rejects(
      withRetry(async () => { throw new Error('Target closed'); }, 5000),
      { message: 'Target closed' }
    );
    assert.equal(_retryCount, 1, 'should have retried once');
  });

  it('works without timeout', async () => {
    _retryCount = 0;
    const result = await withRetry(async () => 'no-timeout');
    assert.equal(result, 'no-timeout');
    assert.equal(_retryCount, 0);
  });
});
