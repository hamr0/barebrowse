/**
 * Console capture must follow switchTab(): the new tab's session has no
 * listeners, so without the client-swap hook its errors never reach the logs.
 * Run: node --test test/integration/capture-tabs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { connect } from '../../src/index.js';
import { attachCapture } from '../../src/capture.js';

describe('capture follows switchTab (Chromium)', () => {
  it('logs errors thrown in a tab that was switched to', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<h1>tab</h1>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const page = await connect({ mode: 'headless', allowLocalUrls: true });
    try {
      const sinks = { consoleLogs: [], networkLogs: [], pendingRequests: new Map() };
      await attachCapture(page, sinks);
      await page.goto(url);
      const tab = await page.createTab();
      await tab.goto(url);
      const list = await page.tabs();
      assert.equal(list.length, 2);
      await page.switchTab(list.findIndex((t) => t.targetId !== list[0].targetId) || 1);
      await page.cdp.send('Runtime.evaluate', { expression: "setTimeout(() => { throw new Error('tab-boom'); }, 0)" });
      for (let i = 0; i < 20 && !sinks.consoleLogs.length; i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(sinks.consoleLogs.some((l) => l.args[0].includes('tab-boom')), JSON.stringify(sinks.consoleLogs));
    } finally {
      await page.close();
      server.close();
    }
  });
});
