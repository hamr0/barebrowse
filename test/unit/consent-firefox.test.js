/**
 * Unit tests for src/consent-firefox.js — the pure Firefox/BiDi consent walker.
 *
 * It operates on a reconstructed AX tree (nested { role, name, nodeId, children })
 * and an injected click(ref). No browser needed: we hand it fixture trees and a
 * spy click, and assert which ref (if any) gets clicked. This is where the
 * dialog-scoping and priority logic is verified; firefox.test.js covers the
 * real end-to-end wiring.
 *
 * Run: node --test test/unit/consent-firefox.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dismissConsentFirefox } from '../../src/consent-firefox.js';

/** Terse node builder mirroring ax-snapshot's output shape. */
let counter = 0;
const node = (role, name, children = []) => ({
  nodeId: String(++counter), role, name, properties: {}, children, ignored: false,
});

/** A click spy that records the ref it was asked to click. */
function spyClick() {
  const clicked = [];
  const fn = async (ref) => { clicked.push(ref); };
  return { fn, clicked };
}

describe('dismissConsentFirefox — dialog-scoped consent', () => {
  it('clicks the Accept-all button inside a cookie dialog', async () => {
    counter = 0;
    const accept = node('button', 'Accept all');
    const root = node('RootWebArea', '', [
      node('dialog', 'Cookie consent', [
        node('heading', 'We value your privacy'),
        accept,
        node('button', 'Reject'),
      ]),
    ]);
    const { fn, clicked } = spyClick();
    const ok = await dismissConsentFirefox(root, fn);
    assert.equal(ok, true);
    assert.deepEqual(clicked, [accept.nodeId], 'clicked the Accept-all button, not Reject');
  });

  it('detects consent by descendant text when the dialog itself is unnamed', async () => {
    counter = 0;
    const accept = node('button', 'I agree');
    const root = node('RootWebArea', '', [
      node('alertdialog', '', [
        node('StaticText', 'This site uses cookies to personalise content.'),
        accept,
      ]),
    ]);
    const { fn, clicked } = spyClick();
    assert.equal(await dismissConsentFirefox(root, fn), true);
    assert.deepEqual(clicked, [accept.nodeId]);
  });

  it('honours ACCEPT_PATTERNS priority (Accept all beats a bare OK)', async () => {
    counter = 0;
    const ok = node('button', 'OK');
    const acceptAll = node('button', 'Accept all cookies');
    // OK appears first in document order, but "accept all" is higher priority.
    const root = node('RootWebArea', '', [
      node('dialog', 'Privacy', [ok, acceptAll]),
    ]);
    const spy = spyClick();
    await dismissConsentFirefox(root, spy.fn);
    assert.deepEqual(spy.clicked, [acceptAll.nodeId], 'preferred the stronger pattern');
  });

  it('matches a non-English accept button (German)', async () => {
    counter = 0;
    const accept = node('button', 'Alle akzeptieren');
    const root = node('RootWebArea', '', [
      node('dialog', 'Cookie-Einstellungen', [accept]),
    ]);
    const spy = spyClick();
    assert.equal(await dismissConsentFirefox(root, spy.fn), true);
    assert.deepEqual(spy.clicked, [accept.nodeId]);
  });
});

describe('dismissConsentFirefox — banner fallback', () => {
  it('falls back to a page-wide strong-pattern button when there is no dialog', async () => {
    counter = 0;
    const accept = node('button', 'Accept all');
    const root = node('RootWebArea', '', [
      node('banner', '', [node('StaticText', 'This website uses cookies'), accept]),
    ]);
    const spy = spyClick();
    assert.equal(await dismissConsentFirefox(root, spy.fn), true);
    assert.deepEqual(spy.clicked, [accept.nodeId]);
  });

  it('does NOT fire on a bare single-word button page-wide (false-positive guard)', async () => {
    counter = 0;
    // A lone "OK" button with no consent dialog: the global scan excludes the
    // single-word fallbacks, so nothing should be clicked.
    const root = node('RootWebArea', '', [
      node('button', 'OK'),
      node('button', 'Submit'),
    ]);
    const spy = spyClick();
    assert.equal(await dismissConsentFirefox(root, spy.fn), false);
    assert.deepEqual(spy.clicked, [], 'no click on an ordinary OK button');
  });

  it('does NOT page-wide scan when a dialog was detected but had no accept button', async () => {
    counter = 0;
    // Regression for the validated false-positive: a consent dialog IS detected
    // (cookie text) but has no in-dialog accept button, while an UNRELATED
    // "Accept all terms" button sits elsewhere on the page. The page-wide scan
    // must NOT fire here — clicking that unrelated button would be an automatic
    // wrong mutation. (We accept missing the rare outside-the-dialog button.)
    const unrelated = node('button', 'Accept all terms');
    const root = node('RootWebArea', '', [
      node('dialog', 'Cookie notice', [
        node('StaticText', 'We use cookies.'),
        node('button', 'Manage preferences'), // no accept-pattern match
      ]),
      node('form', 'Signup', [unrelated]),
    ]);
    const spy = spyClick();
    assert.equal(await dismissConsentFirefox(root, spy.fn), false);
    assert.deepEqual(spy.clicked, [], 'must not click the unrelated Accept-all-terms button');
  });
});

describe('dismissConsentFirefox — no-op cases', () => {
  it('returns false and clicks nothing on a page with no consent UI', async () => {
    counter = 0;
    const root = node('RootWebArea', '', [
      node('heading', 'News'),
      node('link', 'Home'),
      node('button', 'Search'),
    ]);
    const spy = spyClick();
    assert.equal(await dismissConsentFirefox(root, spy.fn), false);
    assert.deepEqual(spy.clicked, []);
  });

  it('returns false on a null tree (failed snapshot)', async () => {
    const spy = spyClick();
    assert.equal(await dismissConsentFirefox(null, spy.fn), false);
    assert.deepEqual(spy.clicked, []);
  });

  it('swallows a click failure and reports false', async () => {
    counter = 0;
    const root = node('RootWebArea', '', [
      node('dialog', 'Cookies', [node('button', 'Accept all')]),
    ]);
    const throwing = async () => { throw new Error('stale ref'); };
    assert.equal(await dismissConsentFirefox(root, throwing), false);
  });
});
