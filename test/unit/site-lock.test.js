import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowHosts, makeHostMatcher, createSiteLock } from '../../src/site-lock.js';
import { navBlocked } from '../../src/navigation.js';

describe('parseAllowHosts', () => {
  it('normalizes to lowercase and trims', () => {
    assert.deepEqual(parseAllowHosts(['Example.COM', ' *.Foo.org ']), ['example.com', '*.foo.org']);
  });

  it('rejects scheme, port, path, spaces, empty, bare wildcard, non-strings', () => {
    for (const bad of ['http://a.com', 'a.com:8080', 'a.com/x', 'a b.com', '', '  ', '*', '*.', '*.*.a.com', 'a.*.com', '[::1]', 'a.com?x', 42, null]) {
      assert.throws(() => parseAllowHosts([bad]), /allowHosts/, String(bad));
    }
  });

  it('rejects a non-array or empty list (fail closed)', () => {
    assert.throws(() => parseAllowHosts([]), /allowHosts/);
    assert.throws(() => parseAllowHosts('a.com'), /allowHosts/);
  });
});

describe('makeHostMatcher', () => {
  const m = makeHostMatcher(['example.com', '*.docs.example.org']);

  it('exact host matches, case-insensitively, any port/path', () => {
    assert.equal(m('https://example.com/x?y#z'), true);
    assert.equal(m('http://EXAMPLE.com:8080/'), true);
    assert.equal(m('https://example.com./'), true); // trailing-dot FQDN
  });

  it('exact entry does not match subdomains or look-alikes', () => {
    assert.equal(m('https://www.example.com/'), false);
    assert.equal(m('https://example.com.evil.net/'), false);
    assert.equal(m('https://notexample.com/'), false);
    assert.equal(m('https://evil.net/?u=example.com'), false);
    assert.equal(m('https://example.com@evil.net/'), false);
  });

  it('wildcard matches strict subdomains only, not the apex', () => {
    assert.equal(m('https://a.docs.example.org/'), true);
    assert.equal(m('https://x.y.docs.example.org/'), true);
    assert.equal(m('https://docs.example.org/'), false);
    assert.equal(m('https://xdocs.example.org/'), false);
  });

  it('non-http(s) URLs are allowed', () => {
    for (const u of ['about:blank', 'data:text/html,hi', 'blob:https://evil.net/uuid']) assert.equal(m(u), true, u);
  });

  it('an unparseable URL is refused', () => {
    assert.equal(m('http://'), false);
  });
});

describe('createSiteLock', () => {
  it('records a goto block per context and clears it once taken', () => {
    const lock = createSiteLock(['a.com']);
    lock.startGoto();
    lock.record('https://b.com/x', 'ctx2'); // a popup, not the goto's context
    assert.equal(lock.takeGotoBlock('ctx1'), null);
    lock.record('https://c.com/y', 'ctx1');
    assert.deepEqual(lock.takeGotoBlock('ctx1'), { url: 'https://c.com/y', host: 'c.com' });
    assert.equal(lock.takeGotoBlock('ctx1'), null);
  });

  it('notes: one line per distinct host, cleared after reading; a goto block is not noted', () => {
    const lock = createSiteLock(['a.com']);
    lock.record('https://b.com/1', 'x');
    lock.record('https://b.com/2', 'x');
    lock.record('https://c.com/', 'x');
    lock.startGoto();
    lock.record('https://d.com/', 'p');
    lock.takeGotoBlock('p');
    assert.equal(lock.takeNotes(), '[blocked navigation to b.com]\n[blocked navigation to c.com]\n');
    assert.equal(lock.takeNotes(), '');
  });

  it('assertAllowed throws NAV_BLOCKED for an off-site URL only', () => {
    const lock = createSiteLock(['a.com']);
    lock.assertAllowed('https://a.com/');
    assert.throws(() => lock.assertAllowed('https://b.com/p'), { code: 'NAV_BLOCKED', host: 'b.com' });
  });
});

describe('navBlocked', () => {
  it('typed error carrying the host', () => {
    const e = navBlocked('https://b.com/p', 'b.com');
    assert.ok(e instanceof Error);
    assert.equal(e.code, 'NAV_BLOCKED');
    assert.equal(e.host, 'b.com');
    assert.equal(e.message, 'Navigation to https://b.com/p blocked: b.com is not in allowHosts');
  });
});
