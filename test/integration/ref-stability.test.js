/**
 * Integration test: within one document an element keeps its ref across snapshots, a ref is
 * never reused for another element, and a ref whose element is gone throws a clear error
 * instead of clicking something else (N37). Both engines.
 *
 * Run: node --test test/integration/ref-stability.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from '../../src/index.js';
import { findFirefox } from '../../src/firefox.js';

const LIST = (items) => items.map((t) => `<button onclick="document.title='CLICKED-${t}'">${t}</button>`).join('');
const CASES = {
  // framework-style re-render: the whole list is replaced, a promo lands on top (Safe is a NEW element)
  rerender: { html: `<div id="l">${LIST(['Safe', 'Delete'])}</div>`, mutate: `document.getElementById('l').innerHTML=${JSON.stringify(LIST(['Promo', 'Safe', 'Delete']))}`, survives: false },
  // an element above is removed
  remove: { html: `<div id="ad"><button>Ad</button><button>Ad2</button></div>${LIST(['Safe', 'Delete'])}`, mutate: `document.getElementById('ad').remove()`, survives: true },
  // a banner is inserted at the very top of body
  banner: { html: LIST(['Safe', 'Delete']), mutate: `{const d=document.createElement('div');d.innerHTML='<button>Accept</button><button>Reject</button>';document.body.prepend(d)}`, survives: true },
};

async function serve() {
  const srv = createServer((q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>t</title><body>${CASES[q.url.slice(1)]?.html ?? ''}</body>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

for (const engine of ['chromium', 'firefox']) {
  describe(`ref stability across snapshots (N37) — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    const run = (page, expr) => page.bidi ? page.bidi.evaluate(page.context, expr, false) : page.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }).then((r) => r.result.value);
    const safeRef = (s) => s.match(/button "Safe"[^\n]*\[ref=(\d+)\]/)?.[1];

    for (const [name, c] of Object.entries(CASES)) {
      it(`${name}: an old ref clicks the same element or throws, never another`, async () => {
        const srvr = await serve();
        const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
        try {
          await page.goto(`${srvr.url}/${name}`);
          const ref = safeRef(await page.snapshot());
          assert.ok(ref, 'Safe ref found');
          await run(page, c.mutate);
          await page.snapshot();
          let err = '';
          await page.click(ref).catch((e) => { err = e.message; });
          const title = await run(page, 'document.title');
          assert.ok(title === 't' || title === 'CLICKED-Safe', `clicked another element: ${title}`);
          if (c.survives) assert.equal(title, 'CLICKED-Safe', err);
          else assert.match(err, /no longer on the page/);
        } finally { await page.close(); await srvr.close(); }
      });
    }

    it('a ref whose element was re-rendered away throws the clear error even without a new snapshot', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        await page.goto(`${srvr.url}/rerender`);
        const ref = safeRef(await page.snapshot());
        await run(page, CASES.rerender.mutate);
        await assert.rejects(() => page.click(ref), /no longer on the page/);
      } finally { await page.close(); await srvr.close(); }
    });

    it('drag with a gone target (or source) throws the clear error, not a raw protocol error (N41)', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        await page.goto(`${srvr.url}/remove`);
        const snap = await page.snapshot();
        const ref = (n) => snap.match(new RegExp(`button "${n}"[^\\n]*\\[ref=(\\d+)\\]`))[1];
        const [ad, safe] = [ref('Ad'), ref('Safe')];
        await run(page, `document.getElementById('ad').remove()`);
        await assert.rejects(() => page.drag(safe, ad), new RegExp('ref "' + ad + '"'), 'gone target names the target');
        await assert.rejects(() => page.drag(ad, safe), new RegExp('ref "' + ad + '"'), 'gone source names the source');
      } finally { await page.close(); await srvr.close(); }
    });

    it('two snapshots of an unchanged page give identical refs; new elements get higher numbers', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        await page.goto(`${srvr.url}/banner`);
        const a = await page.snapshot();
        const b = await page.snapshot();
        assert.equal(b, a);
        await run(page, CASES.banner.mutate);
        const c = await page.snapshot();
        const refs = (s) => [...s.matchAll(/\[ref=(\d+)\]/g)].map((m) => +m[1]);
        const max = Math.max(...refs(a));
        assert.equal(safeRef(c), safeRef(a));
        assert.ok(/button "Accept"[^\n]*\[ref=(\d+)\]/.exec(c)[1] > max, 'new element numbered above the old ones');
      } finally { await page.close(); await srvr.close(); }
    });
  });
}
