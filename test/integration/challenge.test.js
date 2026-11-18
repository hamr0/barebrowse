/**
 * Integration test: bot-challenge detection that has no fixed wording (N27), on
 * both engines. A page whose only content is a challenge iframe, and a page
 * Cloudflare marked with `cf-mitigated: challenge`, must set page.botBlocked and
 * show the snapshot marker; an ordinary page must not.
 *
 * Run: node --test test/integration/challenge.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from '../../src/index.js';
import { findFirefox } from '../../src/firefox.js';

const BODY = '<main><h1>Quarterly report</h1>' + '<p>Ordinary prose about revenue and growth.</p>'.repeat(8) + '</main>';
const WIDGET = '<iframe title="Widget containing a Cloudflare security challenge" srcdoc="<p>x</p>"></iframe>';
let solveHits = 0; // /mit-solve: first request is the challenge, the reload gets the real page
const PAGES = {
  '/ok': [200, {}, `<!doctype html><title>t</title>${BODY}`],
  '/mitigated': [403, { 'cf-mitigated': 'challenge' }, `<!doctype html><title>t</title>${BODY}${WIDGET}`],
  '/mit-header': [403, { 'cf-mitigated': 'challenge' }, `<!doctype html><title>t</title>${BODY}`], // header only, no widget
  '/frame-go': [200, {}, `<!doctype html><title>t</title><h1>Hold on</h1><a href="/ok">Continue</a><div><iframe title="Human verification challenge" srcdoc="<p>x</p>"></iframe></div>`],
  '/mit-go': [403, { 'cf-mitigated': 'challenge' }, `<!doctype html><title>t</title>${BODY}${WIDGET}<a href="/ok">Continue</a>`],
  '/iframe': [200, {}, `<!doctype html><title>t</title><h1>Hold on</h1><div><iframe title="Human verification challenge" srcdoc="<button>Press &amp; Hold Human Challenge</button>"></iframe></div>`],
};

let srv, base;
before(async () => {
  srv = createServer((q, res) => {
    if (q.url === '/mit-solve') {
      const first = solveHits++ === 0; // a managed challenge that solves itself and reloads in place
      res.writeHead(first ? 403 : 200, { 'Content-Type': 'text/html', ...(first ? { 'cf-mitigated': 'challenge' } : {}) });
      return res.end(`<!doctype html><title>t</title>${BODY}${first ? WIDGET + '<script>setTimeout(() => location.reload(), 300)</script>' : ''}`);
    }
    const [status, headers, html] = PAGES[q.url] || [404, {}, 'nope'];
    res.writeHead(status, { 'Content-Type': 'text/html', ...headers }); res.end(html);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => new Promise((r) => srv.close(r)));

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

for (const engine of ['chromium', 'firefox']) {
  describe(`challenge detection (${engine})`, { skip: engine === 'firefox' && !hasFirefox }, () => {
    it('flags cf-mitigated, a challenge iframe; leaves an ordinary page alone', async () => {
      const page = await connect({ mode: 'headless', engine });
      try {
        await page.goto(base + '/ok');
        assert.equal(page.botBlocked, false);
        assert.ok(!(await page.snapshot()).includes('BOT CHALLENGE DETECTED'));

        const out = await page.goto(base + '/mitigated');
        assert.equal(out.mitigated, true);
        assert.equal(page.botBlocked, true, 'cf-mitigated header');
        assert.ok((await page.snapshot()).includes('[BOT CHALLENGE DETECTED'));

        await page.goto(base + '/iframe');
        assert.equal(page.botBlocked, true, 'challenge iframe on a small page');

        await page.goto(base + '/ok');
        assert.equal(page.botBlocked, false, 'flag resets');
      } finally { await page.close(); }
    });
  });
}

// N28: botBlocked and the marker follow the page, not the goto.
for (const engine of ['chromium', 'firefox']) {
  describe(`botBlocked follows the page (${engine})`, { skip: engine === 'firefox' && !hasFirefox }, () => {
    const MARK = 'BOT CHALLENGE DETECTED';
    const clickContinue = async (page) => {
      const ref = /link "Continue" \[ref=(\d+)\]/.exec(await page.snapshot())?.[1];
      assert.ok(ref, 'Continue link in snapshot');
      await page.click(ref);
      await new Promise((r) => setTimeout(r, 1000));
    };

    for (const start of ['/frame-go', '/mit-go']) {
      it(`clears after a click leaves ${start}`, async () => {
        const page = await connect({ mode: 'headless', engine });
        try {
          await page.goto(base + start);
          assert.equal(page.botBlocked, true);
          assert.ok((await page.snapshot()).includes(MARK), 'still a challenge: marker stays');
          assert.equal(page.botBlocked, true);
          await clickContinue(page);
          const snap = await page.snapshot();
          assert.ok(snap.includes('Quarterly report'), 'landed on the real page');
          assert.equal(page.botBlocked, false);
          assert.ok(!snap.includes(MARK));
        } finally { await page.close(); }
      });
    }
  });
}

// N29: a challenge that solves itself and reloads in place to the same URL.
for (const engine of ['chromium', 'firefox']) {
  describe(`botBlocked after an in-place solve (${engine})`, { skip: engine === 'firefox' && !hasFirefox }, () => {
    it('does not keep the cf-mitigated flag once the page is real content', async () => {
      solveHits = 0;
      const page = await connect({ mode: 'headless', engine });
      try {
        const out = await page.goto(base + '/mit-solve');
        assert.equal(out.mitigated, true);
        assert.equal(page.botBlocked, true, 'goto saw the challenge');
        await new Promise((r) => setTimeout(r, 1500)); // the page reloads itself
        const snap = await page.snapshot();
        assert.ok(snap.includes('Quarterly report') && !snap.includes('security challenge'), 'real content is showing');
        assert.equal(page.botBlocked, false);
        assert.ok(!snap.includes('BOT CHALLENGE DETECTED'));
      } finally { await page.close(); }
    });
  });
}

// The cf-mitigated header alone (no widget, no wording) must flag at goto.
for (const engine of ['chromium', 'firefox']) {
  describe(`cf-mitigated header alone (${engine})`, { skip: engine === 'firefox' && !hasFirefox }, () => {
    it('flags at goto; the next snapshot recomputes from the tree', async () => {
      const page = await connect({ mode: 'headless', engine });
      try {
        const out = await page.goto(base + '/mit-header');
        assert.equal(out.mitigated, true);
        assert.equal(page.botBlocked, true, 'header-only page flagged at goto');
        // N29 known limit: the header counts at goto only. The tree is ordinary, so snapshot() clears it.
        const snap = await page.snapshot();
        assert.equal(page.botBlocked, false);
        assert.ok(!snap.includes('[BOT CHALLENGE DETECTED'));
      } finally { await page.close(); }
    });
  });
}
