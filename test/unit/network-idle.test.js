/**
 * Unit tests for waitForNetworkIdle — Set-based request tracking that's
 * resilient to orphan finish/fail events.
 *
 * Run: node --test test/unit/network-idle.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { waitForNetworkIdle } from '../../src/network-idle.js';

/**
 * Build a fake CDP session whose .on(event, handler) registers a handler
 * and returns an unsub fn. Tests fire events by calling fakeSession.emit().
 */
function fakeSession() {
  const handlers = new Map();
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
    emit(event, params) {
      const set = handlers.get(event);
      if (!set) return;
      for (const h of [...set]) h(params);
    },
  };
}

describe('waitForNetworkIdle', () => {
  it('resolves after the idle window with no events', async () => {
    const session = fakeSession();
    const t = Date.now();
    await waitForNetworkIdle(session, { idle: 50, timeout: 1000 });
    const elapsed = Date.now() - t;
    assert.ok(elapsed >= 45 && elapsed < 500, `expected ~50ms, got ${elapsed}ms`);
  });

  it('waits while a request is in flight, then resolves after idle (F9)', async () => {
    const session = fakeSession();
    const start = Date.now();
    const p = waitForNetworkIdle(session, { idle: 50, timeout: 2000 });

    // Fire a request, then finish it after 100ms
    setTimeout(() => session.emit('Network.requestWillBeSent', { requestId: 'r1' }), 10);
    setTimeout(() => session.emit('Network.loadingFinished', { requestId: 'r1' }), 110);

    await p;
    const elapsed = Date.now() - start;
    // Must wait until at least 110 + 50 idle = 160ms
    assert.ok(elapsed >= 155, `should wait for request + idle, got ${elapsed}ms`);
  });

  it('orphan loadingFinished events do not resolve early (F9)', async () => {
    // The bug: a counter-based impl decrements on orphan finish events
    // (request started before listener attached), going negative, then
    // resolves immediately even when a real request is still in flight.
    const session = fakeSession();
    const start = Date.now();
    const p = waitForNetworkIdle(session, { idle: 50, timeout: 2000 });

    // Three orphan finishes (no prior requestWillBeSent) — must NOT push
    // the tracker negative.
    setTimeout(() => session.emit('Network.loadingFinished', { requestId: 'orphan-1' }), 5);
    setTimeout(() => session.emit('Network.loadingFinished', { requestId: 'orphan-2' }), 10);
    setTimeout(() => session.emit('Network.loadingFailed', { requestId: 'orphan-3' }), 15);

    // Real request that we must wait for
    setTimeout(() => session.emit('Network.requestWillBeSent', { requestId: 'real' }), 20);
    setTimeout(() => session.emit('Network.loadingFinished', { requestId: 'real' }), 200);

    await p;
    const elapsed = Date.now() - start;
    // With the bug, this resolves around 5ms (instant). With the fix, it
    // waits for 'real' to finish + 50ms idle ≈ 250ms.
    assert.ok(elapsed >= 240, `orphan finishes must not short-circuit the wait, got ${elapsed}ms`);
  });

  it('rejects on timeout when requests never finish', async () => {
    const session = fakeSession();
    setTimeout(() => session.emit('Network.requestWillBeSent', { requestId: 'stuck' }), 5);
    await assert.rejects(
      waitForNetworkIdle(session, { idle: 50, timeout: 200 }),
      /timed out after 200ms/,
    );
  });

  it('unsubscribes handlers on resolve and reject', async () => {
    const session = fakeSession();
    const counts = { req: 0, fin: 0, fail: 0 };
    const origOn = session.on;
    session.on = (event, handler) => {
      const wrapped = (p) => {
        if (event === 'Network.requestWillBeSent') counts.req++;
        if (event === 'Network.loadingFinished') counts.fin++;
        if (event === 'Network.loadingFailed') counts.fail++;
        handler(p);
      };
      return origOn(event, wrapped);
    };

    await waitForNetworkIdle(session, { idle: 30, timeout: 500 });

    // After resolve, firing events must reach no handlers
    session.emit('Network.requestWillBeSent', { requestId: 'after' });
    session.emit('Network.loadingFinished', { requestId: 'after' });
    assert.equal(counts.req, 0);
    assert.equal(counts.fin, 0);
  });
});
