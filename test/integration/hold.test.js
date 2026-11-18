/**
 * Integration test: page.hold(ref, ms) presses, waits and releases, on both
 * engines. The fixture times mousedown -> mouseup in the page itself, so the
 * assertion is on what the page saw, not on how long the call took. The button
 * sits inside a srcdoc iframe (as Walmart's "Press & Hold" does) to cover the
 * frame-local coordinate case.
 *
 * Run: node --test test/integration/hold.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from '../../src/index.js';
import { findFirefox } from '../../src/firefox.js';

const BTN = `<button id=b style="margin:40px;padding:20px">Hold me</button><script>
let t0 = 0; const b = document.getElementById('b');
b.addEventListener('mousedown', () => { t0 = performance.now(); });
b.addEventListener('mouseup', () => { window.top.document.title = 'held:' + Math.round(performance.now() - t0); });
</script>`;
const PAGES = {
  '/plain': `<!doctype html><title>idle</title><div style="height:300px"></div>${BTN}`,
  '/framed': `<!doctype html><title>idle</title><h1 style="margin:90px 40px">Frame below</h1><iframe style="margin-left:120px" width=400 height=200 srcdoc="${BTN.replace(/"/g, '&quot;')}"></iframe>`,
};

let srv, base;
before(async () => {
  srv = createServer((q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGES[q.url] || ''); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => new Promise((r) => srv.close(r)));

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

// tabs() title lags the DOM (Chromium's target-info update is async): poll for the held title.
const title = async (page) => {
  let s;
  for (let i = 0; i < 40; i++) {
    s = (await page.tabs()).find((x) => x.url.startsWith(base)).title;
    if (/^held:/.test(s)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return s;
};

for (const engine of ['chromium', 'firefox']) {
  describe(`hold (${engine})`, { skip: engine === 'firefox' && !hasFirefox }, () => {
    for (const path of ['/plain', '/framed']) {
      it(`holds the press for at least ms (${path})`, async () => {
        const page = await connect({ mode: 'headless', engine });
        try {
          await page.goto(base + path);
          const snap = await page.snapshot();
          const ref = /button "Hold me" \[ref=(\d+)\]/.exec(snap)?.[1];
          assert.ok(ref, 'button ref in snapshot:\n' + snap);
          const t = Date.now();
          await page.hold(ref, 1500);
          assert.ok(Date.now() - t >= 1500);
          const m = /^held:(\d+)$/.exec(await title(page));
          assert.ok(m, 'mouseup reached the button; title=' + await title(page));
          assert.ok(Number(m[1]) >= 1450, `page saw ${m[1]}ms between mousedown and mouseup`);
        } finally { await page.close(); }
      });
    }
  });
}
