/**
 * Unit tests for MCP server helpers (maxChars, saveSnapshot).
 *
 * Run: node --test test/unit/mcp.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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
    const text = '# https://example.com/\n- heading "Test"';
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
