/**
 * Unit tests for isChallengePage — the hybrid-fallback gate.
 *
 * Tightened in H9 to avoid two classes of false positives:
 *   (1) any small page (404, simple landing) → was flagged because
 *       nodeCount < 50 alone fired.
 *   (2) any error page containing "access denied" / "unknown error" /
 *       "permission denied" → was flagged because those phrases were in
 *       the always-fire set.
 *
 * Run: node --test test/unit/challenge.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isChallengePage } from '../../src/index.js';

// Minimal tree node shape — only role/name/children matter to the heuristic.
function leaf(name) {
  return { role: 'StaticText', name, children: [] };
}
function root(...kids) {
  return { role: 'RootWebArea', name: '', children: kids };
}
function big(textFragments) {
  // Build a "normal-sized" page tree: enough text to clear the tiny-page
  // gate but otherwise simple.
  return root(...textFragments.map(leaf));
}

describe('isChallengePage (H9)', () => {
  describe('strong phrases fire regardless of page size', () => {
    it('flags Cloudflare "Just a moment" even on a content-rich page', () => {
      const tree = big(['Just a moment...', 'lots of other content', 'a'.repeat(200)]);
      assert.equal(isChallengePage(tree, 200), true);
    });

    it('flags "verify you are human" alone', () => {
      const tree = root(leaf('Please verify you are human to proceed'));
      assert.equal(isChallengePage(tree, 80), true);
    });

    it('flags "attention required" alone', () => {
      const tree = big(['Attention Required!', 'Cloudflare blocked this site']);
      assert.equal(isChallengePage(tree, 100), true);
    });
  });

  describe('generic phrases NO LONGER fire alone on normal pages (H9 fix)', () => {
    it('does NOT flag a real 403 page with "access denied" in its body', () => {
      // Pre-H9: this was flagged because "access denied" was in the
      // always-fire list, kicking hybrid mode into a headed launch for
      // every legitimate 403.
      const tree = big([
        'Access Denied',
        'You do not have permission to view this resource.',
        'Contact your administrator if you believe this is an error.',
        'Reference ID: 12345-abcd-6789',
      ]);
      assert.equal(isChallengePage(tree, 80), false,
        'a normal 403 page with "access denied" must not trip the headed fallback');
    });

    it('does NOT flag a real 500 page with "unknown error" in its body', () => {
      const tree = big([
        'An unknown error occurred',
        'Our team has been notified',
        'Please try again in a few minutes',
        'Error 500',
      ]);
      assert.equal(isChallengePage(tree, 70), false);
    });

    it('DOES still flag "access denied" on a near-empty page (likely a challenge skeleton)', () => {
      // Pre-H9 contract preserved: when the weak phrase appears AND the
      // page is tiny, it's almost certainly a challenge.
      const tree = root(leaf('Access Denied'));
      assert.equal(isChallengePage(tree, 8), true);
    });
  });

  describe('small legitimate pages NO LONGER auto-flag (H9 fix)', () => {
    it('does NOT flag a 5-node legitimate landing page with no challenge phrase', () => {
      // Pre-H9: nodeCount < 50 alone was enough — this triggered hybrid
      // fallback on simple HTML5 landings, status pages, etc.
      const tree = big(['Welcome', 'Sign in', 'Continue']);
      assert.equal(isChallengePage(tree, 6), false,
        'a small but legitimate page with no challenge phrase must not trip the headed fallback');
    });

    it('does NOT flag a minimal 404 page', () => {
      const tree = root(leaf('404'), leaf('Not Found'));
      assert.equal(isChallengePage(tree, 4), false);
    });
  });

  describe('truly empty trees still flag', () => {
    it('flags null tree (AX tree fetch failed)', () => {
      assert.equal(isChallengePage(null, 0), true);
    });
  });
});
