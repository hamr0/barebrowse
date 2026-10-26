/**
 * Integration test for snapshot({ mode: 'data' }) on a real browser, both
 * engines: table with headers + repeated links render as records, and a ref
 * taken from the data snapshot clicks like one from act.
 *
 * Run: node --test test/integration/data-mode.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from '../../src/index.js';
import { findFirefox } from '../../src/firefox.js';

const HTML = `<!doctype html><html><body><main>
<h1 id="out">idle</h1>
<table><thead><tr><th>Stop</th><th>Arrives</th><th>Platform</th></tr></thead><tbody>
<tr><th scope="row"><a href="#" onclick="out.textContent='clicked Boston';return false">Boston</a></th><td>6:02 AM</td><td>2</td></tr>
<tr><th scope="row">Quincy</th><td>6:20 AM</td><td>1</td></tr>
</tbody></table>
<h2>Lines</h2>
<a href="#" onclick="return false">Red</a> <a href="#" onclick="return false">Green</a> <a href="#" onclick="return false">Blue</a>
</main></body></html>`;

async function serve() {
  const srv = createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

for (const engine of ['chromium', 'firefox']) {
  describe(`snapshot({ mode: 'data' }) — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    it('renders table rows and grouped items, and refs click like act', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true });
      try {
        await page.goto(srvr.url);
        const snap = await page.snapshot({ mode: 'data' });
        const bos = snap.split('\n').find((l) => l.includes('row "Boston"'));
        assert.ok(bos && bos.includes('Arrives: 6:02 AM') && bos.includes('Platform: 2'), snap);
        const sl = snap.split('\n'); // line 0 is the url/stats header; the legend opens the data body
        assert.ok(sl[2].startsWith('# data mode:') && sl.filter((l) => l.startsWith('# data mode:')).length === 1, snap);
        assert.ok(snap.split('\n').some((l) => l.includes('Lines:') && l.includes('Red') && l.includes('Blue')), snap);
        assert.ok(!snap.includes('StaticText'));

        const ref = bos.match(/\[ref=(\d+)\]/)[1];
        await page.click(ref);
        const after = await page.snapshot({ mode: 'data' });
        assert.ok(after.includes('clicked Boston'), 'a ref from data mode must click through the same refMap as act');

        // act is still act: records are not grouped into rows
        const act = await page.snapshot();
        assert.ok(!act.includes('row "Boston"'));
      } finally {
        await page.close();
        await srvr.close();
      }
    });

    it('connect({pruneMode}) is the snapshot() default; explicit mode wins; unset stays act', async () => {
      const srvr = await serve();
      const dataPage = await connect({ engine, mode: 'headless', allowLocalUrls: true, pruneMode: 'data' });
      const actPage = await connect({ engine, mode: 'headless', allowLocalUrls: true });
      try {
        await dataPage.goto(srvr.url);
        assert.ok((await dataPage.snapshot()).includes('# data mode:'), 'pruneMode:data default must apply');
        assert.ok(!(await dataPage.snapshot({ mode: 'act' })).includes('# data mode:'), 'explicit mode wins');
        await actPage.goto(srvr.url);
        assert.ok(!(await actPage.snapshot()).includes('# data mode:'), 'no pruneMode stays act');
      } finally {
        await dataPage.close(); await actPage.close(); await srvr.close();
      }
    });

    it('the % pruned stat excludes the legend (tiny page is not negative)', async () => {
      const srv = createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><main><p>hi</p></main>'); });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true });
      try {
        await page.goto(`http://127.0.0.1:${srv.address().port}`);
        const snap = await page.snapshot({ mode: 'data' });
        assert.ok(snap.includes('# data mode:'), snap);
        const m = snap.match(/([\d,]+) chars → ([\d,]+) chars(?: \((-?\d+)% pruned\))?/);
        const [raw, out] = [m[1], m[2]].map((x) => Number(x.replace(/,/g, '')));
        const body = snap.slice(snap.indexOf('\n# data mode:') + 1).split('\n').slice(1).join('\n');
        assert.equal(out, body.length, `stat must count the body only:\n${snap}`);
        assert.ok(out < raw, snap);
      } finally { await page.close(); await new Promise((r) => srv.close(r)); }
    });
  });
}
