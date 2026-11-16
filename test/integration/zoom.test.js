/**
 * Integration test: snapshot({ map }) and snapshot({ within }) on a local page
 * with noise around a table and two unnamed lists with sibling headings.
 * Both engines.
 *
 * Run: node --test test/integration/zoom.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from '../../src/index.js';
import { findFirefox } from '../../src/firefox.js';

const li = (tag, n) => Array.from({ length: n }, (_, i) => `<li><a href="/${tag}${i}">${tag} item ${i} with some words</a></li>`).join('');
const PAGE = `<!doctype html><html><body>
<header><a href="/">Home</a> <a href="/about">About us</a></header>
<aside aria-label="Filters"><ul><li><a href="/f1">Filter one</a></li></ul></aside>
<main>
  <h1>Cities</h1>
  <table aria-label="Cities"><tr><th>City</th><th>Pop</th></tr>
  ${Array.from({ length: 30 }, (_, i) => `<tr><td>city ${i}</td><td>pop ${i * 1000}</td></tr>`).join('')}</table>
  <h2>Top picks</h2><ul>${li('top', 25)}</ul>
  <h2>Other picks</h2><ul>${li('other', 25)}<li><button onclick="document.getElementById('out').textContent='picked'">Pick me</button></li></ul>
</main>
<footer><a href="/terms">Terms of use</a></footer>
<p id="out">idle</p>
</body></html>`;
const OTHER = '<!doctype html><html><body><main><h1>Elsewhere</h1><p>nothing</p></main></body></html>';

async function serve() {
  const srv = createServer((q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(q.url.startsWith('/other') ? OTHER : PAGE);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

const refOf = (snap, re) => snap.match(re)?.[1];
const NOISE = /Home|About us|Filter one|Terms of use/;

for (const engine of ['chromium', 'firefox']) {
  describe(`snapshot map + zoom — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    async function withPage(fn) {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try { await page.goto(srvr.url + '/'); await fn(page, srvr); } finally { await page.close(); await srvr.close(); }
    }

    it('map lists the big boxes with refs and sizes, and not the small ones', () => withPage(async (page) => {
      const map = await page.snapshot({ map: true });
      assert.match(map, /- main \[ref=\d+\] \(\d+(\.\d)?k chars\)/);
      assert.match(map, /table "Cities" \[ref=\d+\]/);
      assert.match(map, /list after "Top picks" \[ref=\d+\]/);
      assert.match(map, /list after "Other picks" \[ref=\d+\]/);
      assert.ok(!/Filters|contentinfo|banner/.test(map), 'small boxes are not listed:\n' + map);
      assert.ok(!NOISE.test(map) && !map.includes('city 3'), 'the map carries no content');
    }));

    it('zoom on a table has the rows and none of the noise (data mode)', () => withPage(async (page) => {
      // Data mode reads table cells on both engines.
      const out = await page.snapshot({ within: 'table "Cities"', mode: 'data' });
      assert.ok(out.includes('city 3') && out.includes('pop 3000'), out.slice(0, 400));
      assert.ok(!NOISE.test(out) && !out.includes('top item 1'), 'noise in the zoom');
    }));

    it('zoom on a list works in every mode and drops the noise', () => withPage(async (page) => {
      for (const mode of ['act', 'read', 'data']) {
        const out = await page.snapshot({ within: 'list after "Top picks"', mode });
        assert.ok(out.includes('top item 3'), `${mode}:\n${out.slice(0, 400)}`);
        assert.ok(!NOISE.test(out) && !out.includes('other item 1') && !out.includes('city 3'), `${mode} carries noise`);
      }
    }));

    it('the heading selector finds the right unnamed list, by ref too', () => withPage(async (page) => {
      const other = await page.snapshot({ within: 'list after "Other picks"', links: true });
      assert.ok(other.includes('other item 3') && !other.includes('top item 3'), other.slice(0, 300));
      assert.ok(other.includes('/other3'), 'links apply inside a zoom');
      const map = await page.snapshot({ map: true });
      const ref = refOf(map, /list after "Top picks" \[ref=(\d+)\]/);
      const top = await page.snapshot({ within: Number(ref) });
      assert.ok(top.includes('top item 3') && !top.includes('other item 3'), 'ref from the map, after a renumbering snapshot');
    }));

    it('a banner zoom in act mode is not empty (landmark step off)', () => withPage(async (page) => {
      const out = await page.snapshot({ within: 'banner' });
      assert.ok(out.includes('Home') && out.includes('About us'), out);
      assert.ok(out.includes('zoom banner') && !out.includes('top item'), 'only the banner');
    }));

    it('several boxes come out in page order', () => withPage(async (page) => {
      const out = await page.snapshot({ within: ['list after "Other picks"', 'table "Cities"'], mode: 'data' });
      assert.ok(out.includes('zoom table') && out.indexOf('city 3') > 0 && out.indexOf('city 3') < out.indexOf('other item 3'), out.slice(0, 200));
    }));

    it('ambiguity returns the map with the matches marked; unknown names throw', () => withPage(async (page) => {
      const out = await page.snapshot({ within: 'list' });
      assert.match(out, /more than one box/);
      assert.ok((out.match(/<- match/g) || []).length >= 3, out);
      await assert.rejects(page.snapshot({ within: 'table "Nope"' }), /nothing matches table "Nope"/);
    }));

    it('refs printed in a zoom are clickable', () => withPage(async (page) => {
      const out = await page.snapshot({ within: 'list after "Other picks"' });
      const ref = refOf(out, /button "Pick me" \[ref=(\d+)\]/);
      assert.ok(ref && !out.includes('top item'), out);
      await page.click(ref);
      const full = await page.snapshot({ mode: 'read' });
      assert.ok(full.includes('picked'), 'click landed');
    }));

    it('a ref from before a navigation is an error, not wrong content', () => withPage(async (page, srvr) => {
      const map = await page.snapshot({ map: true });
      const ref = refOf(map, /table "Cities" \[ref=(\d+)\]/);
      await page.goto(srvr.url + '/other');
      await assert.rejects(page.snapshot({ within: Number(ref) }), /not in the last snapshot|no longer on the page/);
      await page.snapshot(); // refs of the new page
      await assert.rejects(page.snapshot({ within: Number(ref) }), /not in the last snapshot|no longer on the page|nothing matches/);
    }));

    it('a ref whose element was removed from the page is an error', () => withPage(async (page) => {
      const map = await page.snapshot({ map: true });
      const ref = refOf(map, /list after "Top picks" \[ref=(\d+)\]/);
      const kill = 'document.querySelectorAll("ul")[1].remove()'; // the "Top picks" list (0 is the filter list)
      if ('cdp' in page) await page.cdp.send('Runtime.evaluate', { expression: kill });
      else await page.bidi.evaluate(page.context, kill, false);
      await assert.rejects(page.snapshot({ within: Number(ref) }), /no longer on the page/);
    }));

    it('without map/within the snapshot is the same as ever', () => withPage(async (page) => {
      const plain = await page.snapshot();
      assert.equal(await page.snapshot({}), plain);
      assert.equal(await page.snapshot({ map: false, within: undefined }), plain);
      assert.match(plain, /^url: [^\n]+\n[\d,]+ chars → [\d,]+ chars \(\d+% pruned\)\n/);
      assert.ok(!plain.includes('map:') && !plain.includes('zoom '));
    }));
  });
}

const CARDS = `<!doctype html><html><body>
<header><nav><a href="/">Home</a></nav></header>
<main><h1>Stays</h1><div>
${Array.from({ length: 14 }, (_, i) => `<article><h3>Stay ${i}</h3><p>Apartment number ${i} in a quiet street near the old town, rated very highly by guests</p><a href="/s${i}">View stay ${i}</a><button>Save ${i}</button></article>`).join('\n')}
</div></main>
<footer><div>${Array.from({ length: 6 }, (_, i) => `<article><h3>Col ${i}</h3><p>Footer text for column number ${i} of links</p><a href="/c${i}">Link ${i}</a><button>Go ${i}</button></article>`).join('')}</div></footer>
</body></html>`;

for (const engine of ['chromium', 'firefox']) {
  describe(`card groups — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    it('the map lists the card grid (not the footer one), within its ref and within "group" zoom to the cards', async () => {
      const srv = createServer((q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(CARDS); });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      try {
        await page.goto(`http://127.0.0.1:${srv.address().port}/`);
        const before = await page.snapshot();
        const map = await page.snapshot({ map: true });
        assert.match(map, /\n {2}- group ×14 \(\d+\.\dk chars\) \[ref=(\d+)\]/, map);
        assert.equal(map.match(/group ×/g).length, 1, 'the footer grid is skipped:\n' + map);
        const ref = map.match(/group ×14 [^\n]*\[ref=(\d+)\]/)[1];
        const byRef = await page.snapshot({ within: Number(ref) });
        // Chromium drops the wrapper div, so the cards' parent is main itself and its ref zooms main
        assert.match(byRef, /zoom (group ×14|main) \[ref=/);
        assert.ok(byRef.includes('View stay 0') && byRef.includes('View stay 13') && !byRef.includes('Link 0'), byRef.slice(0, 300));
        const byRole = await page.snapshot({ within: 'group' });
        assert.match(byRole, /zoom (group ×14|main)/);
        assert.ok(byRole.includes('View stay 13') && !byRole.includes('Link 0'));
        assert.equal(await page.snapshot(), before, 'the default snapshot is unchanged by the map calls');
        assert.ok(!before.includes('group ×'), 'no group line outside the map');
      } finally { await page.close(); srv.close(); }
    });
  });
}
