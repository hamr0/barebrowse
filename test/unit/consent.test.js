/**
 * Unit tests for the bare "Consent" accept label (Google Funding Choices) —
 * dialog-scoped only — on both walkers, with fixture trees and no browser.
 *
 * Run: node --test test/unit/consent.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dismissConsent } from '../../src/consent.js';
import { dismissConsentFirefox } from '../../src/consent-firefox.js';
import { ACCEPT_PATTERNS, DIALOG_ONLY_ACCEPT_PATTERNS } from '../../src/consent-patterns.js';

describe('DIALOG_ONLY_ACCEPT_PATTERNS', () => {
  const matches = (s) => DIALOG_ONLY_ACCEPT_PATTERNS.some((p) => p.test(s));
  it('matches exactly "Consent"', () => {
    assert.ok(matches('Consent'));
    assert.ok(matches('consent'));
  });
  for (const no of ['Manage consent', 'Consent settings', 'Do not consent', 'Consent preferences', 'Manage options']) {
    it(`rejects "${no}"`, () => assert.equal(matches(no), false));
  }
  it('is not part of ACCEPT_PATTERNS (so the global fallback cannot use it)', () => {
    assert.equal(ACCEPT_PATTERNS.some((p) => p.test('Consent')), false);
  });
});

// --- CDP walker: fake session serving a flat AX tree ---
function cdpSession(nodes) {
  const clicked = [];
  return {
    clicked,
    async send(method, params) {
      if (method === 'Accessibility.getFullAXTree') return { nodes: clicked.length ? [] : nodes };
      if (method === 'DOM.resolveNode') return { object: { objectId: String(params.backendNodeId) } };
      if (method === 'Runtime.callFunctionOn') { clicked.push(params.objectId); return {}; }
      return {};
    },
  };
}
const ax = (nodeId, role, name, parentId, backendDOMNodeId) =>
  ({ nodeId, role: { value: role }, name: { value: name }, parentId, backendDOMNodeId });

describe('dismissConsent (CDP) — bare "Consent" button', () => {
  it('clicks it inside a consent dialog', async () => {
    const s = cdpSession([
      ax('1', 'RootWebArea', '', undefined, 1),
      ax('2', 'dialog', 'Moviefone asks for your consent', '1', 2),
      ax('3', 'button', 'Manage options', '2', 3),
      ax('4', 'button', 'Consent', '2', 4),
    ]);
    assert.equal(await dismissConsent(s), true);
    assert.deepEqual(s.clicked, ['4']);
  });
  it('never clicks it page-wide when there is no consent dialog', async () => {
    const s = cdpSession([
      ax('1', 'RootWebArea', '', undefined, 1),
      ax('2', 'button', 'Consent', '1', 2),
    ]);
    assert.equal(await dismissConsent(s), false);
    assert.deepEqual(s.clicked, []);
  });
});

// --- Firefox walker ---
let c = 0;
const n = (role, name, children = []) => ({ nodeId: String(++c), role, name, children });

describe('dismissConsentFirefox — bare "Consent" button', () => {
  it('clicks it inside a consent dialog', async () => {
    const btn = n('button', 'Consent');
    const root = n('RootWebArea', '', [n('dialog', 'Moviefone asks for your consent', [n('button', 'Manage options'), btn])]);
    const clicked = [];
    assert.equal(await dismissConsentFirefox(root, async (r) => { clicked.push(r); }), true);
    assert.deepEqual(clicked, [btn.nodeId]);
  });
  it('never clicks it page-wide when there is no consent dialog', async () => {
    const root = n('RootWebArea', '', [n('button', 'Consent')]);
    const clicked = [];
    assert.equal(await dismissConsentFirefox(root, async (r) => { clicked.push(r); }), false);
    assert.deepEqual(clicked, []);
  });
});
