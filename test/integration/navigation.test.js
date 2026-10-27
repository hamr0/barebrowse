/**
 * Integration test: goto() resolves to { url, status } (final URL after
 * redirects + main-document HTTP status), page.lastNavigation mirrors it, a
 * non-2xx status puts an [HTTP …] warning line on snapshot()/browse(), and a
 * network failure rejects with code NAV_FAILED. Downloads are not failures.
 * Both engines.
 *
 * Run: node --test test/integration/navigation.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect, browse } from '../../src/index.js';
import { findFirefox } from '../../src/firefox.js';

const HTML = (body) => `<!doctype html><html><body><main><h1>${body}</h1></main></body></html>`;

async function serve() {
  let flips = 0;
  const srv = createServer((q, res) => {
    if (q.url === '/missing') { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end(HTML('Not here')); }
    if (q.url === '/404empty') { res.writeHead(404); return res.end(); }
    if (q.url === '/500empty') { res.writeHead(500); return res.end(); }
    if (q.url === '/old') { res.writeHead(302, { Location: '/ok' }); return res.end(); }
    if (q.url === '/old404') { res.writeHead(301, { Location: '/missing' }); return res.end(); }
    if (q.url === '/flip') { // 404 first, then 200 (a page that got fixed)
      res.writeHead(flips++ === 0 ? 404 : 200, { 'Content-Type': 'text/html' });
      return res.end(HTML('Flip'));
    }
    if (q.url === '/204') { res.writeHead(204); return res.end(); }
    if (q.url === '/dl') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename=a.bin' });
      return res.end('xxxx');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML('Fine'));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

const WARN404 = '[HTTP 404 — the page may be an error page]';

for (const engine of ['chromium', 'firefox']) {
  describe(`navigation outcome — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    it('200: goto resolves { url, status }, lastNavigation mirrors it, no warning', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        assert.equal(page.lastNavigation, null);
        const out = await page.goto(srvr.url + '/ok');
        assert.deepEqual(out, { url: srvr.url + '/ok', status: 200 });
        assert.deepEqual(page.lastNavigation, out);
        assert.ok(!(await page.snapshot()).includes('[HTTP'), 'no warning on 2xx');
      } finally { await page.close(); await srvr.close(); }
    });

    it('404: status 404 and the snapshot starts its body with the HTTP warning', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        const out = await page.goto(srvr.url + '/missing');
        assert.deepEqual(out, { url: srvr.url + '/missing', status: 404 });
        const snap = await page.snapshot();
        const lines = snap.split('\n');
        // url + stats lines, then the warning (same place as the bot-challenge line)
        assert.ok(lines.slice(0, 4).includes(WARN404), 'warning near the top:\n' + snap.slice(0, 300));
        assert.ok(snap.includes('Not here'), 'page content still present');
        assert.ok((await page.snapshot(false)).includes(WARN404), 'raw snapshot carries it too');
      } finally { await page.close(); await srvr.close(); }
    });

    it('redirect: final URL and the final hop status', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        assert.deepEqual(await page.goto(srvr.url + '/old'), { url: srvr.url + '/ok', status: 200 });
        assert.deepEqual(await page.goto(srvr.url + '/old404'), { url: srvr.url + '/missing', status: 404 });
      } finally { await page.close(); await srvr.close(); }
    });

    it('empty-body 404/500: resolved and reported, never thrown (N11)', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        for (const code of [404, 500]) {
          const out = await page.goto(srvr.url + `/${code}empty`);
          assert.deepEqual(out, { url: srvr.url + `/${code}empty`, status: code });
          const snap = await page.snapshot();
          assert.ok(snap.split('\n').slice(0, 4).includes(`[HTTP ${code} — the page may be an error page]`), snap.slice(0, 300));
        }
      } finally { await page.close(); await srvr.close(); }
    });

    it('a later 200 goto clears the previous 404 warning', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        await page.goto(srvr.url + '/missing');
        await page.goto(srvr.url + '/ok');
        assert.ok(!(await page.snapshot()).includes('[HTTP'));
      } finally { await page.close(); await srvr.close(); }
    });

    it('back/forward do not leave a stale outcome or HTTP warning (N9)', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        await page.goto(srvr.url + '/missing');
        await page.goto(srvr.url + '/ok');
        await page.goto(srvr.url + '/missing');
        await page.goBack(); // lands on the healthy /ok page
        assert.equal(page.lastNavigation, null, 'goBack clears the outcome');
        const snap = await page.snapshot();
        assert.ok(snap.includes('Fine') && !snap.includes('[HTTP'), 'no stale warning after goBack:\n' + snap.slice(0, 300));
        await page.goForward(); // the 404 page again: no status is reported, so no warning either
        assert.equal(page.lastNavigation, null, 'goForward clears the outcome');
        await page.goto(srvr.url + '/missing');
        assert.equal(page.lastNavigation.status, 404);
      } finally { await page.close(); await srvr.close(); }
    });

    it('reload of a page that stopped failing drops the old HTTP warning (N9)', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        assert.equal((await page.goto(srvr.url + '/flip')).status, 404);
        assert.ok((await page.snapshot()).includes(WARN404));
        await page.reload(); // server now answers 200
        assert.equal(page.lastNavigation, null);
        const snap = await page.snapshot();
        assert.ok(snap.includes('Flip') && !snap.includes('[HTTP'), 'no stale warning after reload:\n' + snap.slice(0, 300));
      } finally { await page.close(); await srvr.close(); }
    });

    it('unresolvable host rejects with code NAV_FAILED and a raw reason; the page stays usable', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        await assert.rejects(page.goto('http://nonexistent.invalid/'), (e) => {
          assert.equal(e.code, 'NAV_FAILED');
          assert.match(e.reason, engine === 'chromium' ? /ERR_NAME_NOT_RESOLVED/ : /NS_ERROR_UNKNOWN_HOST/);
          return true;
        });
        assert.equal(page.lastNavigation, null, 'a failed goto leaves no outcome');
        assert.deepEqual(await page.goto(srvr.url + '/ok'), { url: srvr.url + '/ok', status: 200 });
      } finally { await page.close(); await srvr.close(); }
    });

    it('a download URL is not NAV_FAILED and does not hang', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        const t = Date.now();
        const out = await page.goto(srvr.url + '/dl');
        assert.ok(Date.now() - t < 10000, 'returned promptly');
        assert.equal(out.status, 200);
      } finally { await page.close(); await srvr.close(); }
    });

    it('204 is not NAV_FAILED and reports status 204 (both engines)', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        await page.goto(srvr.url + '/ok');
        const out = await page.goto(srvr.url + '/204');
        assert.deepEqual(out, { url: srvr.url + '/204', status: 204 });
      } finally { await page.close(); await srvr.close(); }
    });
  });
}

describe('navigation outcome — browse() (chromium)', () => {
  it('prepends the HTTP warning on 404, none on 200', async () => {
    const srvr = await serve();
    try {
      const bad = await browse(srvr.url + '/missing', { allowLocalUrls: true, incognito: true });
      assert.ok(bad.split('\n').slice(0, 4).includes(WARN404), bad.slice(0, 300));
      const ok = await browse(srvr.url + '/ok', { allowLocalUrls: true, incognito: true });
      assert.ok(!ok.includes('[HTTP'));
    } finally { await srvr.close(); }
  });

  it('empty-body 500 resolves with the warning line (N11)', async () => {
    const srvr = await serve();
    try {
      const out = await browse(srvr.url + '/500empty', { allowLocalUrls: true, incognito: true });
      assert.ok(out.split('\n').slice(0, 4).includes('[HTTP 500 — the page may be an error page]'), out.slice(0, 300));
    } finally { await srvr.close(); }
  });

  it('rejects NAV_FAILED for an unresolvable host', async () => {
    await assert.rejects(browse('http://nonexistent.invalid/', { incognito: true }), (e) => e.code === 'NAV_FAILED');
  });
});
