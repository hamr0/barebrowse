/**
 * Unit tests for navigation safety (src/url-guard.js).
 * Run: node --test test/unit/url-guard.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertNavigable, isPrivateHost, assertUploadAllowed } from '../../src/url-guard.js';

describe('assertNavigable() — scheme policy', () => {
  it('allows http/https/data/blob/about by default', () => {
    for (const u of [
      'http://example.com',
      'https://example.com/path?q=1',
      'data:text/html,<h1>x</h1>',
      'about:blank',
    ]) {
      assert.doesNotThrow(() => assertNavigable(u), `${u} should be allowed`);
    }
  });

  it('blocks local-resource and browser-internal schemes by default', () => {
    for (const u of [
      'file:///etc/passwd',
      'file:///tmp/',
      'view-source:https://example.com',
      'chrome://settings',
      'chrome-extension://abc/page.html',
      'filesystem:https://x/temporary/f',
      'devtools://devtools/bundled/x.html',
    ]) {
      assert.throws(() => assertNavigable(u), /Refusing to navigate/, `${u} should be blocked`);
    }
  });

  it('honors allowLocalUrls to bypass the scheme block', () => {
    assert.doesNotThrow(() => assertNavigable('file:///etc/hostname', { allowLocalUrls: true }));
  });

  it('rejects malformed URLs', () => {
    assert.throws(() => assertNavigable('not a url'), /not a valid URL/);
    assert.throws(() => assertNavigable(''), /not a valid URL/);
  });
});

describe('assertNavigable() — private network policy', () => {
  it('allows private hosts by default (localhost dev browsing)', () => {
    for (const u of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://192.168.1.10']) {
      assert.doesNotThrow(() => assertNavigable(u), `${u} should be allowed by default`);
    }
  });

  it('blocks private/internal hosts when blockPrivateNetwork is set', () => {
    for (const u of [
      'http://localhost:3000',
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://192.168.0.1/',
      'http://172.16.5.5/',
      'http://metadata.google.internal/',
      'https://something.internal/',
    ]) {
      assert.throws(() => assertNavigable(u, { blockPrivateNetwork: true }), /private\/internal/, `${u} should be blocked`);
    }
  });

  it('still allows public hosts when blockPrivateNetwork is set', () => {
    assert.doesNotThrow(() => assertNavigable('https://example.com', { blockPrivateNetwork: true }));
    assert.doesNotThrow(() => assertNavigable('https://8.8.8.8', { blockPrivateNetwork: true }));
  });
});

describe('isPrivateHost()', () => {
  it('classifies IPv4 ranges', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.31.255.255', '169.254.169.254', '0.0.0.0']) {
      assert.equal(isPrivateHost(h), true, `${h} should be private`);
    }
    for (const h of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34']) {
      assert.equal(isPrivateHost(h), false, `${h} should be public`);
    }
  });

  it('classifies IPv6 loopback / link-local / ULA', () => {
    assert.equal(isPrivateHost('::1'), true);
    assert.equal(isPrivateHost('[::1]'), true);
    assert.equal(isPrivateHost('fe80::1'), true);
    assert.equal(isPrivateHost('fd00::1'), true);
    assert.equal(isPrivateHost('fc00::1'), true);
    assert.equal(isPrivateHost('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateHost('2606:4700:4700::1111'), false);
  });

  it('does NOT misclassify hostnames that merely start with fc/fd as IPv6 ULA', () => {
    // Regression: the fc00::/7 prefix check must be gated on the host being an
    // IPv6 literal, or "fcbarcelona.com" / "fdic.gov" get wrongly blocked.
    for (const h of ['fcbarcelona.com', 'fdic.gov', 'fd-domain.net', 'fconline.example']) {
      assert.equal(isPrivateHost(h), false, `${h} is a public hostname`);
    }
    assert.doesNotThrow(() => assertNavigable('https://fcbarcelona.com', { blockPrivateNetwork: true }));
    assert.doesNotThrow(() => assertNavigable('https://fdic.gov', { blockPrivateNetwork: true }));
  });
});

describe('assertUploadAllowed()', () => {
  it('is a no-op when no uploadDir is configured', () => {
    assert.doesNotThrow(() => assertUploadAllowed(['/anything/at/all'], null));
    assert.doesNotThrow(() => assertUploadAllowed(['/anything'], undefined));
  });

  it('allows files inside the dir and rejects files outside it', () => {
    const base = mkdtempSync(join(tmpdir(), 'bb-upload-'));
    try {
      const inside = join(base, 'cv.pdf');
      writeFileSync(inside, 'x');
      const outside = mkdtempSync(join(tmpdir(), 'bb-other-'));
      const secret = join(outside, 'secret');
      writeFileSync(secret, 'x');
      try {
        assert.doesNotThrow(() => assertUploadAllowed([inside], base));
        assert.throws(() => assertUploadAllowed([secret], base), /outside the allowed uploadDir/);
        // accepts a single (non-array) path too
        assert.doesNotThrow(() => assertUploadAllowed(inside, base));
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('resolves symlinks in the base dir (no false reject when uploadDir is a symlink)', () => {
    // Mirrors macOS /tmp -> /private/tmp: base path has a symlinked component.
    const real = mkdtempSync(join(tmpdir(), 'bb-real-'));
    const link = real + '-link';
    symlinkSync(real, link);
    try {
      const f = join(real, 'doc.txt');
      writeFileSync(f, 'x');
      // uploadDir given as the symlink; file given via the real path.
      assert.doesNotThrow(() => assertUploadAllowed([f], link));
      // and via the symlink path
      assert.doesNotThrow(() => assertUploadAllowed([join(link, 'doc.txt')], link));
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('rejects a missing file and a missing uploadDir', () => {
    const base = mkdtempSync(join(tmpdir(), 'bb-upload-'));
    try {
      assert.throws(() => assertUploadAllowed([join(base, 'nope')], base), /cannot resolve/);
      assert.throws(() => assertUploadAllowed(['/x'], join(base, 'does-not-exist')), /uploadDir does not exist/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
