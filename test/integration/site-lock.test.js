/**
 * Integration test: allowHosts site lock. Allowed host is `localhost`, the
 * off-site host is `127.0.0.1` (same local server, told apart by Host header).
 * Top-level navigations to the off-site host must never reach the server;
 * iframes and images (not locked by design) still load. Both engines.
 *
 * Run: node --test test/integration/site-lock.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect, browse } from '../../src/index.js';
import { findFirefox } from '../../src/firefox.js';

async function serve() {
  const hits = [];
  const srv = createServer((q, res) => {
    const host = q.headers.host.split(':')[0];
    hits.push(`${host}${q.url}`);
    const port = srv.address().port;
    const off = `http://127.0.0.1:${port}`;
    if (q.url === '/redir') { res.writeHead(302, { Location: `${off}/target?redir` }); return res.end(); }
    if (q.url === '/redir-in') { res.writeHead(302, { Location: `http://localhost:${port}/ok` }); return res.end(); }
    if (q.url.startsWith('/home')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><title>home</title><main><h1>Home</h1>
        <a href="${off}/target?click">offlink</a>
        <button onclick="location='${off}/target?js'">jump</button>
        <button onclick="window.open('${off}/target?pop')">popup</button>
        <iframe src="${off}/frame"></iframe><img src="${off}/img"></main>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>ok</title><main><h1>Fine</h1></main>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return {
    hits, port, url: `http://localhost:${port}`, off: `http://127.0.0.1:${port}`,
    offDocHits: () => hits.filter((h) => h.startsWith('127.0.0.1') && h.includes('/target')),
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }),
  };
}

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const refOf = (snap, re) => {
  const m = re.exec(snap);
  assert.ok(m, `no match for ${re} in:\n${snap}`);
  return m[1];
};
const lock = (engine, extra = {}) => connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true, allowHosts: ['localhost'], ...extra });

for (const engine of ['chromium', 'firefox']) {
  describe(`site lock — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    it('goto an off-site URL: NAV_BLOCKED before navigating (pre-check)', async () => {
      const s = await serve();
      const page = await lock(engine);
      try {
        await page.goto(s.url + '/ok');
        await assert.rejects(page.goto(s.off + '/target?direct'), { code: 'NAV_BLOCKED', host: '127.0.0.1' });
        assert.equal(s.offDocHits().length, 0);
        assert.match(await page.snapshot(), /^url: http:\/\/localhost:/);
      } finally { await page.close(); await s.close(); }
    });

    it('goto whose redirect leaves the site: NAV_BLOCKED, page unchanged, 0 off-site hits', async () => {
      const s = await serve();
      const page = await lock(engine);
      try {
        await page.goto(s.url + '/ok');
        await assert.rejects(page.goto(s.url + '/redir'), { code: 'NAV_BLOCKED', host: '127.0.0.1' });
        await wait(300);
        assert.equal(s.offDocHits().length, 0);
        const snap = await page.snapshot();
        assert.match(snap, /^url: http:\/\/localhost:\d+\/ok/);
        assert.ok(!snap.includes('[blocked navigation'), 'a goto block is an error, not a snapshot note');
      } finally { await page.close(); await s.close(); }
    });

    it('goto whose redirect stays on-site works', async () => {
      const s = await serve();
      const page = await lock(engine);
      try {
        const out = await page.goto(s.url + '/redir-in');
        assert.equal(out.status, 200);
        assert.equal(out.url, s.url + '/ok');
      } finally { await page.close(); await s.close(); }
    });

    it('clicked off-site link / JS jump: page stays, next snapshot carries one line per host', async () => {
      const s = await serve();
      const page = await lock(engine);
      try {
        await page.goto(s.url + '/home');
        let snap = await page.snapshot();
        await page.click(refOf(snap, /link "offlink".*\[ref=(\d+)\]/));
        await wait(1000);
        snap = await page.snapshot();
        assert.match(snap, /^url: http:\/\/localhost:\d+\/home/);
        assert.equal(snap.split('[blocked navigation to 127.0.0.1]').length - 1, 1);
        await page.click(refOf(snap, /button "jump".*\[ref=(\d+)\]/));
        await wait(1000);
        snap = await page.snapshot();
        assert.match(snap, /^url: http:\/\/localhost:\d+\/home/);
        assert.equal(snap.split('[blocked navigation to 127.0.0.1]').length - 1, 1);
        assert.ok(!(await page.snapshot()).includes('[blocked navigation'), 'notes are cleared once shown');
        assert.equal(s.offDocHits().length, 0);
      } finally { await page.close(); await s.close(); }
    });

    it('window.open popup to an off-site host never reaches the server', async () => {
      const s = await serve();
      const page = await lock(engine);
      try {
        await page.goto(s.url + '/home');
        const snap = await page.snapshot();
        await page.click(refOf(snap, /button "popup".*\[ref=(\d+)\]/));
        await wait(1500);
        assert.equal(s.offDocHits().length, 0);
      } finally { await page.close(); await s.close(); }
    });

    it('off-site iframe and image still load (top frame only, by design)', async () => {
      const s = await serve();
      const page = await lock(engine);
      try {
        await page.goto(s.url + '/home');
        await wait(500);
        assert.ok(s.hits.some((h) => h === '127.0.0.1/frame'), 'iframe loaded');
        assert.ok(s.hits.some((h) => h === '127.0.0.1/img'), 'img loaded');
      } finally { await page.close(); await s.close(); }
    });

    it('without allowHosts nothing is locked', async () => {
      const s = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        const out = await page.goto(s.url + '/redir');
        assert.equal(out.url, s.off + '/target?redir');
        assert.equal(s.offDocHits().length, 1);
      } finally { await page.close(); await s.close(); }
    });

    it('browse(): off-site URL and off-site redirect reject with NAV_BLOCKED', { skip: engine !== 'chromium' && 'browse() is Chromium-only' }, async () => {
      const s = await serve();
      try {
        const opts = { allowLocalUrls: true, incognito: true, allowHosts: ['localhost'] };
        await assert.rejects(browse(s.off + '/target?b1', opts), { code: 'NAV_BLOCKED' });
        await assert.rejects(browse(s.url + '/redir', opts), { code: 'NAV_BLOCKED' });
        assert.equal(s.offDocHits().length, 0);
        assert.match(await browse(s.url + '/ok', opts), /Fine/);
      } finally { await s.close(); }
    });
  });
}

describe('site lock — chromium only', () => {
  it('a new tab is locked too', async () => {
    const s = await serve();
    const page = await lock('chromium');
    try {
      const tab = await page.createTab();
      await assert.rejects(tab.goto(s.off + '/target?tab'), { code: 'NAV_BLOCKED' });
      await assert.rejects(tab.goto(s.url + '/redir'), { code: 'NAV_BLOCKED' });
      assert.equal(s.offDocHits().length, 0);
      await tab.goto(s.url + '/ok');
      await tab.close();
    } finally { await page.close(); await s.close(); }
  });

  it('attach mode refuses allowHosts (it would touch the user\'s own tabs)', async () => {
    await assert.rejects(connect({ port: 9, allowHosts: ['localhost'] }), /allowHosts.*attach/i);
  });

  it('invalid allowHosts rejects before launching a browser', async () => {
    await assert.rejects(connect({ allowHosts: ['http://a.com'] }), /allowHosts/);
  });
});
