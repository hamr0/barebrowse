/**
 * Integration tests for page.readable() — clean article extraction.
 * Runs Mozilla Readability inside a real page, so a browser is required.
 *
 * Run: node --test test/integration/readable.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../../src/index.js';

// A self-contained article so the core assertions don't depend on the network.
// Enough real prose (>1500 chars, paragraph-structured) for Readability to
// extract and for isProbablyReaderable to fire.
const PARA = 'Web scraping is the automated extraction of data from websites, '
  + 'typically performed by a bot or crawler that downloads pages and parses '
  + 'their content into a structured form. It is widely used for research, '
  + 'price monitoring, and feeding machine learning pipelines with fresh data. ';
const ARTICLE = 'data:text/html,' + encodeURIComponent(
  `<html><head><title>The Title Of The Article</title></head><body>
    <nav><a href="/a">Home</a><a href="/b">About</a><a href="/c">Contact</a></nav>
    <article><h1>The Heading Inside</h1>
      ${Array.from({ length: 8 }, () => `<p>${PARA}</p>`).join('\n')}
      <p>UNIQUE-SENTINEL-PHRASE appears exactly once in the body.</p>
    </article>
    <footer>copyright nav ads sidebar junk</footer>
  </body></html>`);

const NON_ARTICLE = 'data:text/html,' + encodeURIComponent(
  `<html><head><title>App</title></head><body>
    <button>Login</button><input placeholder="search"><a href="/x">link</a>
  </body></html>`);

describe('page.readable()', () => {
  it('extracts clean article text and strips nav/footer chrome', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      await page.goto(ARTICLE);
      const r = await page.readable();
      assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
      assert.match(r.title, /The Title Of The Article/);
      assert.ok(r.text.includes('UNIQUE-SENTINEL-PHRASE'),
        'body prose must be present');
      assert.ok(!r.text.includes('copyright nav ads sidebar junk'),
        'footer chrome must be stripped');
      assert.ok(!/About|Contact/.test(r.text),
        'nav links must be stripped from reading text');
      assert.equal(r.confidence, 'high',
        `a real article should read as high confidence, got ${r.confidence}`);
    } finally {
      await page.close();
    }
  });

  it('returns low confidence (not an error) on a non-article page', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      await page.goto(NON_ARTICLE);
      const r = await page.readable();
      // Either no article was found, or it parsed but flagged low confidence.
      if (r.ok) {
        assert.equal(r.confidence, 'low',
          'a thin app page must not read as a high-confidence article');
        assert.match(r.hint, /snapshot/);
      } else {
        assert.match(r.hint, /snapshot/,
          'a failed extraction must point the agent back to snapshot()');
      }
    } finally {
      await page.close();
    }
  });

  it('extracts a real-world article (Wikipedia)', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      await page.goto('https://en.wikipedia.org/wiki/Web_scraping', 45000);
      const r = await page.readable();
      assert.equal(r.ok, true);
      assert.match(r.title, /Web scraping/);
      assert.ok(r.length > 5000, `expected substantial text, got ${r.length}`);
      assert.equal(r.confidence, 'high');
    } finally {
      await page.close();
    }
  });
});
