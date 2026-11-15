/**
 * Integration test: pointer actions on an element below the fold. BiDi's
 * input.performActions does not scroll, so on Firefox a click/hover/drag whose
 * target sat outside the viewport threw "move target out of bounds" (Chromium
 * scrolls first). A consent dialog whose accept button is below the fold must
 * be dismissed too. Both engines (Chromium is the control).
 *
 * Run: node --test test/integration/offscreen-click.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from '../../src/index.js';
import { findFirefox } from '../../src/firefox.js';

const TALL = `<!doctype html><html><body><main><h1 id="out">idle</h1>
<div style="height:3000px">spacer</div>
<button id="a" onclick="out.textContent='clicked'" onmouseover="out.textContent='hovered'">Far button</button>
<div style="height:3000px">spacer</div>
<button id="b" onmouseup="out.textContent='dropped'">Farther button</button>
</main></body></html>`;
const CONSENT = `<!doctype html><html><body><main><h1 id="out">idle</h1><p>Content</p></main>
<div role="dialog" aria-label="Example asks for your consent"><p>We and our partners use cookies</p>
<div style="height:3000px"></div>
<button onclick="out.textContent='consent clicked';this.parentNode.remove()">Accept all</button><button>Manage options</button></div>
</body></html>`;

async function serve() {
  const srv = createServer((q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(q.url.startsWith('/consent') ? CONSENT : TALL);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

// Input events reach the page asynchronously on a loaded box: poll instead of reading once.
async function sees(page, text) {
  for (let i = 0; i < 20; i++) {
    if ((await page.snapshot()).includes(text)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const refOf = (snap, name) => snap.match(new RegExp(`button "${name}" \\[ref=(\\d+)\\]`))[1];

for (const engine of ['chromium', 'firefox']) {
  describe(`off-screen pointer actions — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    it('click / hover / drag reach an element below the fold', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        await page.goto(srvr.url + '/tall');
        let snap = await page.snapshot();
        await page.click(refOf(snap, 'Far button'));
        assert.ok(await sees(page, 'clicked'), 'click must land');
        await page.goto(srvr.url + '/tall');
        snap = await page.snapshot();
        await page.hover(refOf(snap, 'Far button'));
        assert.ok(await sees(page, 'hovered'), 'hover must land');
        await page.goto(srvr.url + '/tall');
        snap = await page.snapshot();
        await page.drag(refOf(snap, 'Far button'), refOf(snap, 'Farther button'));
        assert.ok(await sees(page, 'dropped'), 'drag must reach the second element');
      } finally { await page.close(); await srvr.close(); }
    });

    it('dismisses a consent dialog whose accept button is below the fold', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        await page.goto(srvr.url + '/consent');
        const snap = await page.snapshot();
        assert.ok(snap.includes('consent clicked'), 'Accept all must have been clicked:\n' + snap);
      } finally { await page.close(); await srvr.close(); }
    });
  });
}
