import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { navFailed, httpWarning, isHttpError } from '../../src/navigation.js';

describe('navigation outcome helpers', () => {
  it('isHttpError: only a known non-2xx status counts', () => {
    for (const s of [200, 204, 299, 0, undefined]) assert.equal(isHttpError(s), false, String(s));
    for (const s of [301, 404, 500, 503]) assert.equal(isHttpError(s), true, String(s));
  });

  it('httpWarning: a line for non-2xx, empty otherwise', () => {
    assert.equal(httpWarning(404), '[HTTP 404 — the page may be an error page]\n');
    assert.equal(httpWarning(200), '');
    assert.equal(httpWarning(0), '');
    assert.equal(httpWarning(undefined), '');
  });

  it('navFailed: typed error carrying the raw reason', () => {
    const e = navFailed('http://x.invalid/', 'net::ERR_NAME_NOT_RESOLVED');
    assert.ok(e instanceof Error);
    assert.equal(e.code, 'NAV_FAILED');
    assert.equal(e.reason, 'net::ERR_NAME_NOT_RESOLVED');
    assert.match(e.message, /x\.invalid.*ERR_NAME_NOT_RESOLVED/);
  });
});
