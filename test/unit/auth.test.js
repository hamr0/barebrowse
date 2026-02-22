/**
 * Unit tests for cookie extraction.
 * Tests what's available on this system (Firefox on Fedora/KDE).
 *
 * Run: node --test test/unit/auth.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCookies } from '../../src/auth.js';

describe('extractCookies()', () => {
  it('auto-detects a browser and returns cookies', () => {
    const cookies = extractCookies();
    assert.ok(Array.isArray(cookies), 'should return an array');
    assert.ok(cookies.length > 0, 'should find at least some cookies');
  });

  it('returns cookies with correct shape', () => {
    const cookies = extractCookies();
    const cookie = cookies[0];
    assert.ok('name' in cookie, 'should have name');
    assert.ok('value' in cookie, 'should have value');
    assert.ok('domain' in cookie, 'should have domain');
    assert.ok('path' in cookie, 'should have path');
    assert.ok('secure' in cookie, 'should have secure');
    assert.ok('httpOnly' in cookie, 'should have httpOnly');
    assert.ok('sameSite' in cookie, 'should have sameSite');
    assert.ok('expires' in cookie, 'should have expires');
  });

  it('filters by domain', () => {
    const cookies = extractCookies({ domain: 'google.com' });
    for (const cookie of cookies) {
      assert.ok(cookie.domain.includes('google'), `${cookie.domain} should match google`);
    }
  });

  it('extracts from firefox explicitly', () => {
    const cookies = extractCookies({ browser: 'firefox' });
    assert.ok(cookies.length > 0, 'should find Firefox cookies');
  });

  it('throws for non-existent browser', () => {
    assert.throws(
      () => extractCookies({ browser: 'chrome' }),
      /not found/i,
      'should throw for missing Chrome'
    );
  });

  it('cookies have non-empty values', () => {
    const cookies = extractCookies();
    for (const cookie of cookies) {
      assert.ok(cookie.value.length > 0, `cookie ${cookie.name} should have a value`);
    }
  });

  it('sameSite is a valid value', () => {
    const valid = new Set(['None', 'Lax', 'Strict']);
    const cookies = extractCookies();
    for (const cookie of cookies) {
      assert.ok(valid.has(cookie.sameSite), `${cookie.sameSite} should be valid sameSite`);
    }
  });
});
