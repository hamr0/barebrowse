/**
 * Integration tests for incognito mode — a clean, unauthenticated session that
 * skips ALL auth injection (storageState + injectCookies).
 *
 * Deterministic and self-contained: uses a controlled storageState cookie, not
 * the user's real browser cookies, so results don't depend on machine state.
 *
 * Run: node --test test/integration/incognito.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../../src/index.js';
import { extractCookies } from '../../src/auth.js';
import { findFirefox } from '../../src/firefox.js';

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* firefox arm skips */ }

// A storageState file carrying one known cookie for example.com. Both arms load
// the SAME file — the only difference is the incognito flag, so if the cookie's
// presence differs, incognito is the cause (the test can fail if the gate is a
// no-op).
function writeStorageState() {
  const dir = mkdtempSync(join(tmpdir(), 'bb-incognito-'));
  const file = join(dir, 'state.json');
  const future = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(file, JSON.stringify({
    cookies: [{
      name: 'bb_incognito_probe', value: 'present', domain: 'example.com',
      path: '/', secure: true, httpOnly: false, sameSite: 'None', expires: future,
    }],
  }));
  return file;
}

async function probeCookiePresent(page) {
  const { cookies } = await page.cdp.send('Network.getAllCookies');
  return cookies.some((c) => c.name === 'bb_incognito_probe');
}

describe('incognito mode', () => {
  it('DEFAULT: loads storageState cookies into the session', async () => {
    const storageState = writeStorageState();
    const page = await connect({ mode: 'headless', storageState });
    try {
      assert.equal(await probeCookiePresent(page), true,
        'control: storageState cookie must be present without incognito');
    } finally {
      await page.close();
    }
  });

  it('INCOGNITO: skips storageState — no auth cookie enters the session', async () => {
    const storageState = writeStorageState();
    const page = await connect({ mode: 'headless', storageState, incognito: true });
    try {
      assert.equal(await probeCookiePresent(page), false,
        'incognito must NOT load the storageState cookie');
    } finally {
      await page.close();
    }
  });

  it('INCOGNITO: injectCookies() is a no-op that returns 0', async () => {
    // Deterministic regardless of machine cookies: incognito short-circuits
    // BEFORE authenticate() (which would otherwise throw on no-cookies or
    // inject real ones). A non-incognito session instead reaches authenticate().
    const page = await connect({ mode: 'headless', incognito: true });
    try {
      const before = (await page.cdp.send('Network.getAllCookies')).cookies.length;
      const result = await page.injectCookies('https://example.com/');
      const after = (await page.cdp.send('Network.getAllCookies')).cookies.length;
      assert.equal(result, 0, 'incognito injectCookies() should report 0 injected');
      assert.equal(after, before, 'incognito injectCookies() must not add cookies');
    } finally {
      await page.close();
    }
  });
});

// The Firefox/BiDi engine has its own page object and injectCookies path, so
// incognito parity must be proven there too — this is the gap that paused the
// release. storageState is CDP-only, so the Firefox arm gates injectCookies.
describe('incognito mode — Firefox/BiDi engine', { skip: !hasFirefox && 'no Firefox installed' }, () => {
  it('INCOGNITO: injectCookies() is a no-op — no cookie enters the session', async () => {
    // Control (only if the user has Firefox cookies): non-incognito injection
    // lands cookies, proving the incognito suppression below is meaningful.
    let sample;
    try { sample = extractCookies({ browser: 'firefox' }).find((c) => c.domain && c.name); } catch { /* none */ }

    const incog = await connect({ engine: 'firefox', incognito: true });
    try {
      const n = await incog.injectCookies('https://example.com', { browser: 'firefox' });
      assert.equal(n, 0, 'incognito injectCookies() returns 0 on Firefox');
      const store = await incog.bidi.send('storage.getCookies', {});
      assert.equal(store.cookies.length, 0, 'no cookies entered the incognito Firefox session');
    } finally {
      await incog.close();
    }

    if (sample) {
      const domain = sample.domain.replace(/^\./, '');
      const control = await connect({ engine: 'firefox' });
      try {
        await control.injectCookies('https://' + domain, { browser: 'firefox', domain });
        const store = await control.bidi.send('storage.getCookies', {});
        assert.ok(store.cookies.length > 0,
          'control: non-incognito Firefox injection lands cookies — proves the gate matters');
      } finally {
        await control.close();
      }
    }
  });
});
