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
  });
}
