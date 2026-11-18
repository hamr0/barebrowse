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
import { mitigation } from '../../src/navigation.js';

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

  describe('structural: challenge iframe (N27)', () => {
    const node = (role, name, ...children) => ({ role, name, children });
    const frame = (name, role = 'Iframe') => node(role, name, node('RootWebArea', name, node('button', 'Press & Hold Human Challenge')));
    // Pad out so wording alone can't decide (text >= 50 chars, no phrase).
    const pad = (n) => Array.from({ length: n }, (_, i) => leaf(`paragraph number ${i} of ordinary page text`));

    it('flags a small page whose only content is a "Human verification challenge" iframe (Walmart shape)', () => {
      const tree = root(node('link', 'Home'), node('heading', 'Some heading'), frame('Human verification challenge'), ...pad(5));
      assert.equal(isChallengePage(tree, 87), true);
    });

    it('flags it when the iframe sits in a dialog on a big page, even with a close button', () => {
      const dlg = node('dialog', 'Verify', node('button', 'Close'), frame('Human verification challenge'));
      assert.equal(isChallengePage(root(dlg, ...pad(400)), 2000), true);
    });

    it('does NOT flag the same iframe on a big page outside any dialog', () => {
      assert.equal(isChallengePage(root(frame('Human verification challenge'), ...pad(400)), 2000), false);
    });

    it('does NOT flag a reCAPTCHA widget in a form (IframePresentational, 83 nodes)', () => {
      const tree = root(node('form', '', node('textbox', 'Name'), frame('reCAPTCHA', 'IframePresentational'), node('button', 'Submit')), ...pad(5));
      assert.equal(isChallengePage(tree, 83), false);
    });

    it('does NOT flag an hCaptcha widget beside a Submit button on a small page', () => {
      const tree = root(node('form', '', frame('Widget containing checkbox for hCaptcha security challenge'), node('button', 'Submit')), ...pad(5));
      assert.equal(isChallengePage(tree, 86), false);
    });

    it('does NOT flag a login dialog that carries a captcha iframe and a field', () => {
      const dlg = node('dialog', 'Sign in', node('textbox', 'Email'), frame('reCAPTCHA', 'IframePresentational'));
      assert.equal(isChallengePage(root(dlg, ...pad(400)), 2000), false);
    });

    it('does NOT flag an iframe with an unrelated name', () => {
      assert.equal(isChallengePage(root(frame('Embedded video player'), ...pad(5)), 40), false);
    });

    it('flags the HUMAN heading "Robot or human?" (Firefox never renders the iframe)', () => {
      assert.equal(isChallengePage(root(node('heading', 'Robot or human?'), ...pad(5)), 200), true);
    });
  });

  describe('cf-mitigated header (N27)', () => {
    it('flags a content-rich page when the response was mitigated', () => {
      const tree = big(['ordinary text', 'a'.repeat(200)]);
      assert.equal(isChallengePage(tree, 500), false);
      assert.equal(isChallengePage(tree, 500, { mitigated: true }), true);
    });

    it('mitigation() reads CDP object headers and BiDi array headers, case-insensitively', () => {
      assert.deepEqual(mitigation({ 'CF-Mitigated': 'challenge' }), { mitigated: true });
      assert.deepEqual(mitigation([{ name: 'cf-mitigated', value: { type: 'string', value: 'challenge' } }]), { mitigated: true });
      assert.deepEqual(mitigation({ 'cf-mitigated': 'other' }), {});
      assert.deepEqual(mitigation(undefined), {});
    });
  });

  describe('structural frame test counts visible nodes (N34)', () => {
    const ignored = () => ({ role: 'generic', name: '', ignored: true, children: [] });
    // Target "Human verification": outer unnamed Iframe > RootWebArea > text + challenge Iframe
    const humanPage = (pad) => ({
      role: 'RootWebArea', name: '', children: [
        { role: 'Iframe', name: '', children: [
          { role: 'RootWebArea', name: 'Human verification', children: [
            { role: 'generic', name: '', children: [
              leaf('Quick verification'),
              { role: 'Iframe', name: 'Human verification challenge', children: [
                { role: 'RootWebArea', name: 'Human verification challenge', children: [] } ] },
            ] },
            ...pad,
          ] },
        ] },
      ] });

    it('flags the challenge iframe when almost all nodes are ignored', () => {
      const tree = humanPage(Array.from({ length: 380 }, ignored));
      assert.equal(isChallengePage(tree, 418), true);
    });

    it('does NOT flag the same shape on a page with >150 visible nodes', () => {
      const tree = humanPage(Array.from({ length: 160 }, (_, i) => leaf('item ' + i)));
      assert.equal(isChallengePage(tree, 200), false);
    });
  });
});
