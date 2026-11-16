/**
 * Integration test: a ref taken before a navigation must throw afterwards, on
 * both engines, for every ref-taking method and for snapshot({ within }).
 * Firefox used to rebuild its ref table during goto's own consent pass, so an
 * old ref silently resolved to whatever element now carried that number.
 *
 * Run: node --test test/integration/stale-refs.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from '../../src/index.js';
import { findFirefox } from '../../src/firefox.js';

const PAGE = `<!doctype html><html><body><main><h1>Page</h1>
<button onclick="this.textContent='clicked'">Pick me</button>
<input aria-label="Name"><select aria-label="Size"><option>s</option><option>m</option></select>
<ul><li><a href="/x1">one</a></li><li><a href="/x2">two</a></li></ul>
<p id="out">idle</p></main></body></html>`;

async function serve() {
  const srv = createServer((q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

const navs = {
  goto: (p, u) => p.goto(u + '/again'),
  reload: (p) => p.reload(),
  goBack: async (p, u) => { await p.goto(u + '/again'); await p.goBack(); },
  goForward: async (p, u) => { await p.goto(u + '/again'); await p.goBack(); await p.goForward(); },
};

for (const engine of ['chromium', 'firefox']) {
  describe(`stale refs after navigation — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    for (const [name, nav] of Object.entries(navs)) {
      it(`${name}: every ref-taking method rejects an older ref, nothing is clicked`, async () => {
        const srvr = await serve();
        const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
        try {
          await page.goto(srvr.url + '/');
          const snap = await page.snapshot();
          const ref = (re) => snap.match(re)?.[1];
          const button = ref(/button "Pick me" \[ref=(\d+)\]/);
          const input = ref(/textbox "Name" \[ref=(\d+)\]/);
          const select = ref(/combobox "Size" [^\n]*?\[ref=(\d+)\]/);
          assert.ok(button && input && select, 'refs found:\n' + snap);
          const box = ref(/main \[ref=(\d+)\]/);
          assert.ok(box, 'main ref found:\n' + snap);

          await nav(page, srvr.url); // no snapshot after it

          await assert.rejects(page.click(button), /ref/i);
          await assert.rejects(page.type(input, 'x'), /ref/i);
          await assert.rejects(page.hover(button), /ref/i);
          await assert.rejects(page.select(select, 'm'), /ref/i);
          await assert.rejects(page.drag(button, input), /ref/i);
          await assert.rejects(page.upload(input, []), /ref|upload/i);
          await assert.rejects(page.snapshot({ within: Number(box) }), /ref/i);
          // a fresh snapshot makes refs work again
          const fresh = await page.snapshot();
          await page.click(fresh.match(/button "Pick me" \[ref=(\d+)\]/)[1]);
          assert.match(await page.snapshot(), /button "clicked"/);
        } finally { await page.close(); await srvr.close(); }
      });
    }
  });
}

for (const engine of ['chromium', 'firefox']) {
  describe(`numeric refs — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    it('click, type, hover, select, drag and upload take a number as well as a string', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        await page.goto(srvr.url + '/');
        const snap = await page.snapshot();
        const n = (re) => Number(snap.match(re)[1]);
        const button = n(/button "Pick me" \[ref=(\d+)\]/);
        const input = n(/textbox "Name" \[ref=(\d+)\]/);
        const select = n(/combobox "Size" [^\n]*?\[ref=(\d+)\]/);
        await page.hover(button);
        await page.type(input, 'abc');
        await page.select(select, 'm');
        await page.drag(button, input);
        await page.upload(input, []).catch((e) => { assert.ok(!/No element found|Unknown ref/.test(e.message), e.message); });
        await page.click(button);
        assert.match(await page.snapshot(), /button "clicked"/);
        assert.match(await page.snapshot(), /textbox "Name"[^\n]*abc|abc/);
      } finally { await page.close(); await srvr.close(); }
    });
  });
}
