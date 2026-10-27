/**
 * Integration test: snapshot({ links: true }) — link URLs after the quoted name
 * (`link "name" <url> [ref=N]`) in act, read and data modes, both engines.
 * Off (default) is byte-identical to before. A heading that wraps a link (the
 * GitHub issue-list shape) keeps the URL on its own line in act/read.
 *
 * Run: node --test test/integration/links.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect, browse } from '../../src/index.js';
import { findFirefox } from '../../src/firefox.js';

const PAGE = `<!doctype html><html><body><main>
<h1>Issues</h1>
<ul>
  <li><h3><a href="/issues/42">Fix login bug</a></h3><p>opened by ann</p>
    <a href="/labels/bug">bug</a> <a href="/labels/docs">docs</a> <a href="/labels/ui">ui</a>
    <a href="/issues/42">3 comments</a></li>
  <li><h3><a href="/issues/43">Crash on save</a></h3><p>opened by bob</p>
    <a href="/labels/bug">bug</a> <a href="/labels/docs">docs</a> <a href="/labels/ui">ui</a></li>
  <li><h3><a href="/issues/44">Slow search</a></h3><p>opened by cyd</p>
    <a href="/labels/bug">bug</a> <a href="/labels/docs">docs</a> <a href="/labels/ui">ui</a></li>
</ul>
<table>
  <tr><th>Repo</th><th>Owner</th></tr>
  <tr><td><a href="/repos/alpha">alpha</a></td><td>ann</td></tr>
  <tr><td><a href="/repos/beta">beta</a></td><td>bob</td></tr>
</table>
<div><a href="javascript:void(0)">Run script</a></div>
<div><a href="#top">Back to top</a></div>
<div><a href="/search?q=a b<c>d#x y<z>">Odd chars</a></div>
</main></body></html>`;

async function serve() {
  const srv = createServer((q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

// Body of a snapshot: drop the `url:` + stats lines (sizes differ with links on).
const body = (s) => s.split('\n').slice(2).join('\n');
// Remove everything links add: the ` <url>` after a name and the legend note.
const unlink = (s) => s.replace(/ Links: "name" <url>\./, '').replace(/ <https?:\/\/[^<>\s]+>/g, '');
// Link names that must NOT get a URL (javascript:, same-document #fragment).
const NO_URL = new Set(['Run script', 'Back to top']);

for (const engine of ['chromium', 'firefox']) {
  describe(`links — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    let srvr, page;
    const snap = async (mode, links) => body(await page.snapshot({ mode, ...(links === undefined ? {} : { links }) }));

    // One browser for the file; each test only reads.
    it('setup', async () => {
      srvr = await serve();
      page = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true });
      await page.goto(srvr.url + '/');
    });

    it('off (default): no URLs anywhere, and links:false equals omitted', async () => {
      for (const mode of ['act', 'read', 'data']) {
        const dflt = await snap(mode);
        assert.ok(!dflt.includes('<http'), `${mode}: no <http when off`);
        assert.ok(!dflt.includes('Links: "name"'), `${mode}: no legend note when off`);
        assert.equal(await snap(mode, false), dflt, `${mode}: links:false === default`);
      }
      assert.ok(!(await page.snapshot(false)).includes('<http'), 'raw tree too');
    });

    it('on: stripping the URLs gives exactly the off output (links add nothing else)', async () => {
      for (const mode of ['act', 'read', 'data']) {
        assert.equal(unlink(await snap(mode, true)), await snap(mode), `${mode}: on minus urls === off`);
      }
    });

    for (const mode of ['act', 'read', 'data']) {
      it(`on, ${mode}: every link line carries its URL; heading keeps the ticket URL`, async () => {
        const out = await snap(mode, true);
        const base = srvr.url;
        for (const line of out.split('\n').filter((l) => /- link "/.test(l))) {
          const name = /- link "([^"]*)"/.exec(line)[1];
          if (NO_URL.has(name)) assert.ok(!/<[^>]*>/.test(line), `no url for ${name}: ${line}`);
          else assert.match(line, / <https?:\/\/[^<>\s]+> \[ref=\d+\]$/, `link "${name}" lacks its URL: ${line}`);
        }
        if (mode !== 'data') {
          assert.match(out, new RegExp(`- heading "Fix login bug" <${base}/issues/42> \\[level=3\\] \\[ref=\\d+\\]`), 'heading carries the URL');
          assert.match(out, new RegExp(`- heading "Slow search" <${base}/issues/44> `));
        }
        for (const bad of ['javascript:', '#top']) assert.ok(!out.includes(bad), `${bad} absent`);
        assert.ok(out.includes(`<${base}/issues/42>`), 'issue url present');
      });
    }

    it('on, data: table cell, collapsed group, duplicate-once, legend note', async () => {
      const raw = await page.snapshot({ mode: 'data', links: true });
      const out = body(raw);
      const base = srvr.url;
      assert.ok(raw.split('\n').slice(2)[0].endsWith(' Links: "name" <url>.'), 'legend note when on');
      assert.match(out, new RegExp(`Repo: alpha <${base}/repos/alpha> \\[ref=\\d+\\] · Owner: ann|row .*alpha <${base}/repos/alpha> \\[ref=\\d+\\]`), 'table link cell:\n' + out);
      assert.match(out, new RegExp(`bug <${base}/labels/bug> \\[ref=\\d+\\], docs <${base}/labels/docs> \\[ref=\\d+\\], ui <${base}/labels/ui> \\[ref=\\d+\\]`), 'group items:\n' + out);
      // "3 comments" repeats /issues/42 right after the title link: the URL shows once there.
      const item42 = out.split('\n').filter((l) => l.includes('/issues/42>'));
      assert.equal(item42.length, 1, 'duplicate url listed once:\n' + out);
    });

    it('odd href: spaces and angle brackets never reach the output raw', async () => {
      for (const mode of ['act', 'data']) {
        const line = (await snap(mode, true)).split('\n').find((l) => l.includes('Odd chars'));
        assert.ok(line, `${mode}: link present`);
        const m = /Odd chars"? <([^\n]*?)> \[ref=\d+\]/.exec(line);
        assert.ok(m, `${mode}: splits cleanly on " <" and "> ": ${line}`);
        assert.ok(!/[ <>]/.test(m[1]), `${mode}: no raw space/<> in url: ${m[1]}`);
        assert.match(m[1], /\/search\?q=a%20b%3Cc%3Ed/);
      }
    });

    it('connect({ links }) is the snapshot default; per-call false overrides', async () => {
      const p2 = await connect({ engine, mode: 'headless', allowLocalUrls: true, incognito: true, links: true });
      try {
        await p2.goto(srvr.url + '/');
        assert.ok((await p2.snapshot()).includes(`<${srvr.url}/issues/42>`), 'default on');
        assert.ok(!(await p2.snapshot({ links: false })).includes('<http'), 'override off');
      } finally { await p2.close(); }
    });

    if (engine === 'chromium') {
      it('browse(url, { links }) honours the option', async () => {
        const on = await browse(srvr.url + '/', { allowLocalUrls: true, links: true, incognito: true });
        assert.ok(on.includes(`<${srvr.url}/issues/42>`));
        const off = await browse(srvr.url + '/', { allowLocalUrls: true, incognito: true });
        assert.ok(!off.includes('<http'));
      });
    }

    it('teardown', async () => {
      await page.close();
      await srvr.close();
    });
  });
}
