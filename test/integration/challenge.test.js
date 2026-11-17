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
const PAGES = {
  '/ok': [200, {}, `<!doctype html><title>t</title>${BODY}`],
  '/mitigated': [403, { 'cf-mitigated': 'challenge' }, `<!doctype html><title>t</title>${BODY}`],
  '/iframe': [200, {}, `<!doctype html><title>t</title><h1>Hold on</h1><div><iframe title="Human verification challenge" srcdoc="<button>Press &amp; Hold Human Challenge</button>"></iframe></div>`],
};

let srv, base;
before(async () => {
  srv = createServer((q, res) => {
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
