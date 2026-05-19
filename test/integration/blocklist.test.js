/**
 * Integration tests for ad/tracker URL blocking via CDP Network.setBlockedURLs.
 *
 * Strategy: spin up two localhost servers — one acts as the page, the other
 * as a "tracker" domain. The page embeds a script from the tracker. With
 * the default blockUrls extension that matches the tracker's URL, the
 * tracker request must fail with net::ERR_BLOCKED_BY_CLIENT.
 *
 * Run: node --test test/integration/blocklist.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from '../../src/index.js';

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

describe('Network.setBlockedURLs integration', () => {
  it('blocks a subresource matching blockUrls and does not hit the server', async () => {
    let trackerHits = 0;
    const tracker = await startServer((_req, res) => {
      trackerHits++;
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('window.__tracker_loaded = true;');
    });
    const pageServer = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body>
        <h1>blocklist-probe</h1>
        <script src="${tracker.url}/track.js"></script>
      </body></html>`);
    });

    // Pass the tracker URL pattern via blockUrls so the test doesn't depend
    // on whichever real-world tracker the default list happens to cover.
    const page = await connect({
      mode: 'headless',
      blockUrls: [`*://127.0.0.1:${tracker.port}/*`],
    });
    try {
      await page.goto(pageServer.url);
      // Tracker request must never reach the tracker server.
      assert.equal(trackerHits, 0,
        `tracker received ${trackerHits} hits — Network.setBlockedURLs did not engage`);
      // And the script body must not have executed in the page.
      const { result } = await page.cdp.send('Runtime.evaluate', {
        expression: 'typeof window.__tracker_loaded',
        returnByValue: true,
      });
      assert.equal(result.value, 'undefined',
        'tracker script must not have executed — blocked at network layer');
    } finally {
      await page.close();
      await pageServer.close();
      await tracker.close();
    }
  });

  it('applies blockUrls on switchTab() in attach mode (post-switch session is blocked)', async () => {
    // Regression guard for the v0.10.0 backlog item: when a user attaches to
    // a running browser with explicit blockAds:true / blockUrls:[…], the
    // blocklist must follow page.switchTab() onto a tab that was opened
    // *outside* barebrowse (i.e. a tab the user already had open). The
    // worry the backlog flagged: a switched-into session might miss the
    // applyBlocklist call and let a tracker through silently.
    let trackerHits = 0;
    const tracker = await startServer((_req, res) => {
      trackerHits++;
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('window.__tracker_loaded = true;');
    });
    const pageServer = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body>
        <h1>switch-tab-blocklist-probe</h1>
        <script src="${tracker.url}/track.js"></script>
      </body></html>`);
    });

    const { launch, cleanupBrowser } = await import('../../src/chromium.js');
    const { createCDP } = await import('../../src/cdp.js');
    const { getDebugUrl } = await import('../../src/chromium.js');

    const running = await launch({});
    try {
      // Spin up a SECOND tab in the running browser via raw CDP, bypassing
      // barebrowse entirely — this simulates a tab the user already had
      // open before attach. Without this, switchTab() has only one target
      // to choose from and the test is trivial.
      const wsUrl = await getDebugUrl(running.port);
      const rawCdp = await createCDP(wsUrl);
      const { targetId: extraTargetId } = await rawCdp.send('Target.createTarget', {
        url: 'about:blank',
      });
      rawCdp.close();

      const page = await connect({
        port: running.port,
        blockAds: true,
        blockUrls: [`*://127.0.0.1:${tracker.port}/*`],
      });
      try {
        const tabs = await page.tabs();
        const idx = tabs.findIndex((t) => t.targetId === extraTargetId);
        assert.ok(idx >= 0,
          `extra tab ${extraTargetId} missing from page.tabs(): ${JSON.stringify(tabs)}`);

        await page.switchTab(idx);
        await page.goto(pageServer.url);

        assert.equal(trackerHits, 0,
          `tracker received ${trackerHits} hits after switchTab — blocklist did not follow the session swap`);

        // And the script body must not have executed in the switched-into tab.
        const { result } = await page.cdp.send('Runtime.evaluate', {
          expression: 'typeof window.__tracker_loaded',
          returnByValue: true,
        });
        assert.equal(result.value, 'undefined',
          'tracker script must not have executed in the switched-into tab');
      } finally {
        await page.close();
      }
    } finally {
      await cleanupBrowser(running);
      await pageServer.close();
      await tracker.close();
    }
  });

  it('does not block subresources when blockAds:false and no blockUrls', async () => {
    let trackerHits = 0;
    const tracker = await startServer((_req, res) => {
      trackerHits++;
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('window.__tracker_loaded = true;');
    });
    const pageServer = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body>
        <script src="${tracker.url}/track.js"></script>
      </body></html>`);
    });

    const page = await connect({ mode: 'headless', blockAds: false });
    try {
      await page.goto(pageServer.url);
      assert.equal(trackerHits, 1,
        `with blockAds:false tracker must load freely, got ${trackerHits} hits`);
    } finally {
      await page.close();
      await pageServer.close();
      await tracker.close();
    }
  });
});
