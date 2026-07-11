/**
 * Unit tests for the Firefox/BiDi hybrid fallback orchestration (Phase 4).
 *
 * The challenge heuristic itself is covered by challenge.test.js; here we drive
 * createFirefoxPage.goto() against a fake BiDi to prove the WIRING: a
 * bot-challenge page triggers relaunchHeaded() exactly once, the page rebinds
 * to the fresh connection and re-navigates, and the fallback is suppressed when
 * it shouldn't fire (non-hybrid, already headed, or clean page). No real
 * browser or display needed — the risky part is the orchestration, not the
 * transport.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFirefoxPage } from '../../src/firefox-page.js';

/**
 * Minimal fake BiDi whose snapshot always reconstructs a single RootWebArea
 * named `treeName` — so "just a moment" reads as a challenge and anything else
 * reads as clean content.
 */
function fakeBidi(treeName) {
  const listeners = new Map();
  return {
    _name: treeName,
    async send(method) {
      if (method === 'browsingContext.getTree') return { contexts: [{ context: 'ctx1', children: [] }] };
      return {};
    },
    async subscribe() {},
    on(m, cb) {
      if (!listeners.has(m)) listeners.set(m, new Set());
      listeners.get(m).add(cb);
      return () => listeners.get(m)?.delete(cb);
    },
    async evaluate(_ctx, expr) {
      if (expr === 'location.href') return 'http://test.local/';
      // Stand in for axSnapshotExpression — return the {tree,count} shape.
      return JSON.stringify({ tree: { role: 'RootWebArea', name: this._name, children: [] }, count: 1 });
    },
    close() {},
  };
}

describe('Firefox hybrid fallback orchestration (Phase 4)', () => {
  it('relaunches headed once on a challenge page, then reports cleared', async () => {
    let relaunchCalls = 0;
    const clean = fakeBidi('Welcome home');
    const page = await createFirefoxPage(fakeBidi('just a moment...'), {
      consent: false, hybrid: true, headed: false,
      relaunchHeaded: async () => { relaunchCalls++; return { bidi: clean, topContext: 'ctx1' }; },
    });
    await page.goto('http://blocked.example/');
    assert.equal(relaunchCalls, 1, 'relaunched headed exactly once');
    assert.equal(page.botBlocked, false, 'headed retry cleared the challenge');
    assert.equal(page.bidi, clean, 'page rebound to the fresh connection');
  });

  it('does NOT relaunch when hybrid is off (botBlocked stays true)', async () => {
    let relaunchCalls = 0;
    const page = await createFirefoxPage(fakeBidi('just a moment...'), {
      consent: false, hybrid: false, headed: false,
      relaunchHeaded: async () => { relaunchCalls++; return { bidi: fakeBidi('x'), topContext: 'ctx1' }; },
    });
    await page.goto('http://blocked.example/');
    assert.equal(relaunchCalls, 0, 'no relaunch without hybrid mode');
    assert.equal(page.botBlocked, true, 'challenge surfaced, not silently cleared');
  });

  it('does NOT relaunch when already headed', async () => {
    let relaunchCalls = 0;
    const page = await createFirefoxPage(fakeBidi('just a moment...'), {
      consent: false, hybrid: true, headed: true,
      relaunchHeaded: async () => { relaunchCalls++; return { bidi: fakeBidi('x'), topContext: 'ctx1' }; },
    });
    await page.goto('http://blocked.example/');
    assert.equal(relaunchCalls, 0, 'already headed — nothing to escalate to');
    assert.equal(page.botBlocked, true);
  });

  it('does NOT relaunch on a clean page', async () => {
    let relaunchCalls = 0;
    const page = await createFirefoxPage(fakeBidi('Welcome home'), {
      consent: false, hybrid: true, headed: false,
      relaunchHeaded: async () => { relaunchCalls++; return { bidi: fakeBidi('x'), topContext: 'ctx1' }; },
    });
    await page.goto('http://ok.example/');
    assert.equal(relaunchCalls, 0, 'clean page never triggers fallback');
    assert.equal(page.botBlocked, false);
  });

  it('keeps the headless result if the headed relaunch fails', async () => {
    const page = await createFirefoxPage(fakeBidi('just a moment...'), {
      consent: false, hybrid: true, headed: false,
      relaunchHeaded: async () => { throw new Error('no display'); },
    });
    await page.goto('http://blocked.example/');
    assert.equal(page.botBlocked, true, 'relaunch failure leaves the challenge visible, no crash');
  });
});
