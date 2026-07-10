/**
 * Unit tests for cookie extraction.
 * Tests what's available on this system (Firefox on Fedora/KDE).
 *
 * Run: node --test test/unit/auth.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCookies, cookieDomainMatch, scopedCookiesForUrl } from '../../src/auth.js';

// extractCookies() reads the real on-disk browser cookie database; skip when
// none exists (e.g. a CI runner with no browser profile). The pure
// cookieDomainMatch() suite below always runs.
let COOKIES_AVAILABLE = true;
try { extractCookies(); } catch { COOKIES_AVAILABLE = false; }
const cookiesSkip = COOKIES_AVAILABLE ? false : 'no browser cookie database on this machine';

describe('extractCookies()', { skip: cookiesSkip }, () => {
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

describe('cookieDomainMatch() — precise injection filter', () => {
  it('matches the host and its parent domains', () => {
    assert.equal(cookieDomainMatch('mail.google.com', '.google.com'), true);
    assert.equal(cookieDomainMatch('mail.google.com', 'google.com'), true);
    assert.equal(cookieDomainMatch('www.example.com', 'www.example.com'), true);
  });

  it('rejects look-alike and unrelated domains (the over-match the LIKE pre-filter lets through)', () => {
    assert.equal(cookieDomainMatch('apple.com', 'apple.com.evil.org'), false);
    assert.equal(cookieDomainMatch('apple.com', 'notapple.com'), false);
    // multi-part eTLD: browsing one .co.uk site must not pull another's cookies
    assert.equal(cookieDomainMatch('mybank.co.uk', 'evil.co.uk'), false);
    assert.equal(cookieDomainMatch('x.com', 'y.com'), false);
  });

  it('is case-insensitive', () => {
    assert.equal(cookieDomainMatch('Mail.Google.COM', '.GOOGLE.com'), true);
  });
});

// Shared scoping used by BOTH engines (CDP authenticate + Firefox injectCookies).
// The invariant — every returned cookie matches the URL host — holds regardless
// of which cookies this machine has, and fails loudly if the domain filter is
// ever dropped (the Firefox v0.15.0 whole-jar bug).
describe('scopedCookiesForUrl() — cross-engine cookie scoping', { skip: cookiesSkip }, () => {
  it('returns only cookies whose domain matches the URL host', () => {
    // Pick a host the jar actually owns, so scoping yields a real (non-empty)
    // set — then assert every cookie in it matches that host. Fails loudly if
    // the domain filter is ever dropped (the Firefox whole-jar bug).
    const sample = extractCookies().find((c) => c.domain);
    if (!sample) return;
    const host = sample.domain.replace(/^\./, '');
    const scoped = scopedCookiesForUrl(`https://${host}/`);
    assert.ok(scoped.length > 0, 'a host that owns cookies must yield a non-empty scoped set');
    for (const c of scoped) {
      assert.ok(cookieDomainMatch(host, c.domain),
        `leaked out-of-scope cookie for ${c.domain} when scoping to ${host}`);
    }
  });

  it('yields nothing for a host that owns no cookies', () => {
    // extractCookies throws "No browser cookie database found" when a domain
    // matches zero rows (existing quirk shared with CDP authenticate — callers
    // wrap in try/catch). Either way, the effective scoped set is empty.
    let scoped = [];
    try { scoped = scopedCookiesForUrl('https://no-such-host.invalid-tld-zzz/'); } catch { scoped = []; }
    assert.equal(scoped.length, 0, 'an unowned host must contribute no cookies');
  });
});
