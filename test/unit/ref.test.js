import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normRef } from '../../src/ref.js';

describe('normRef (N35)', () => {
  it('accepts bare, ref=N and [ref=N] forms', () => {
    for (const r of [441, '441', 'ref=441', '[ref=441]', ' ref=441 ']) assert.equal(normRef(r), '441');
  });
  it('leaves other input as a string', () => {
    assert.equal(normRef('abc'), 'abc');
  });
});
