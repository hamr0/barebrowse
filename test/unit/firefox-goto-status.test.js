/**
 * N44: on a big streamed page Firefox resolves browsingContext.navigate BEFORE
 * network.responseCompleted fires, so goto() reported status 0. The status (and
 * the cf-mitigated header) must then come from network.responseStarted, which
 * always arrives first. Driven against a fake BiDi with that exact ordering.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFirefoxPage } from '../../src/firefox-page.js';

function fakeBidi(onNavigate) {
  const listeners = new Map();
  const emit = (m, e) => listeners.get(m)?.forEach((cb) => cb(e));
  return {
    async send(method) {
      if (method === 'browsingContext.getTree') return { contexts: [{ context: 'ctx1', children: [] }] };
      if (method === 'browsingContext.navigate') return onNavigate(emit);
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
      return JSON.stringify({ tree: { role: 'RootWebArea', name: 'page', children: [], nodeId: '1' }, top: 1 });
    },
    close() {},
  };
}

const ev = (status, headers = []) => ({
  context: 'ctx1', navigation: 'nav1', response: { url: 'http://test.local/s', status, headers },
});

describe('Firefox goto() status while the page is still streaming (N44)', () => {
  it('reads status and url from responseStarted when navigate resolves before responseCompleted', async () => {
    const page = await createFirefoxPage(fakeBidi((emit) => {
      emit('network.responseStarted', ev(200));
      return { navigation: 'nav1' }; // responseCompleted would fire later
    }), { consent: false });
    const r = await page.goto('http://test.local/s');
    assert.equal(r.status, 200);
    assert.equal(r.url, 'http://test.local/s');
  });

  it('honours cf-mitigated through the responseStarted fallback', async () => {
    const page = await createFirefoxPage(fakeBidi((emit) => {
      emit('network.responseStarted', ev(403, [{ name: 'cf-mitigated', value: { type: 'string', value: 'challenge' } }]));
      return { navigation: 'nav1' };
    }), { consent: false });
    const r = await page.goto('http://test.local/s');
    assert.equal(r.status, 403);
    assert.equal(r.mitigated, true);
  });

  it('prefers responseCompleted (the final redirect hop) when it is present', async () => {
    const page = await createFirefoxPage(fakeBidi((emit) => {
      emit('network.responseStarted', ev(302));
      emit('network.responseCompleted', ev(302));
      emit('network.responseStarted', { ...ev(200), response: { url: 'http://test.local/final', status: 200, headers: [] } });
      emit('network.responseCompleted', { ...ev(200), response: { url: 'http://test.local/final', status: 200, headers: [] } });
      return { navigation: 'nav1' };
    }), { consent: false });
    const r = await page.goto('http://test.local/s');
    assert.equal(r.status, 200);
    assert.equal(r.url, 'http://test.local/final');
  });

  it('ignores responseStarted of another navigation id', async () => {
    const page = await createFirefoxPage(fakeBidi((emit) => {
      emit('network.responseStarted', { ...ev(500), navigation: 'other' });
      return { navigation: 'nav1' };
    }), { consent: false });
    assert.equal((await page.goto('http://test.local/s')).status, 0);
  });

  it('reports the final redirect hop when it is still streaming (N46)', async () => {
    const hop = (status, url) => ({ ...ev(status), response: { url, status, headers: [] } });
    const page = await createFirefoxPage(fakeBidi((emit) => {
      emit('network.responseStarted', hop(302, 'http://t/a'));
      emit('network.responseCompleted', hop(302, 'http://t/a'));
      emit('network.responseStarted', hop(200, 'http://t/final')); // no completion yet
      return { navigation: 'nav1' };
    }), { consent: false });
    const r = await page.goto('http://t/a');
    assert.equal(r.status, 200);
    assert.equal(r.url, 'http://t/final');
  });
});
