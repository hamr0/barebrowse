/**
 * Unit tests for the CDP client + chromium launcher.
 * Requires Chromium installed.
 *
 * Run: node --test test/unit/cdp.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, launch } from '../../src/chromium.js';
import { createCDP } from '../../src/cdp.js';

describe('findBrowser()', () => {
  it('finds a Chromium-based browser', () => {
    const binary = findBrowser();
    assert.ok(binary.length > 0, 'should return a path');
    assert.ok(binary.includes('chrom') || binary.includes('brave') || binary.includes('edge'),
      `${binary} should be a Chromium browser`);
  });
});

describe('launch()', () => {
  it('launches headless Chromium and returns WebSocket URL', async () => {
    const browser = await launch();
    try {
      assert.ok(browser.wsUrl.startsWith('ws://'), 'should return a ws:// URL');
      assert.ok(browser.port > 0, 'should have a port');
      assert.ok(browser.process.pid > 0, 'should have a process');
    } finally {
      browser.process.kill();
    }
  });
});

describe('createCDP()', () => {
  it('connects to browser and sends commands', async () => {
    const browser = await launch();
    try {
      const cdp = await createCDP(browser.wsUrl);
      try {
        // Get browser version — should work on browser-level connection
        const version = await cdp.send('Browser.getVersion');
        assert.ok(version.product.includes('Chrome') || version.product.includes('Headless'),
          `product should be Chrome, got: ${version.product}`);
      } finally {
        cdp.close();
      }
    } finally {
      browser.process.kill();
    }
  });

  it('creates session-scoped handles', async () => {
    const browser = await launch();
    try {
      const cdp = await createCDP(browser.wsUrl);
      try {
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

        const session = cdp.session(sessionId);
        // Enable Page domain on the session
        await session.send('Page.enable');

        // Navigate — should work on session scope
        await session.send('Page.navigate', { url: 'data:text/html,<h1>hello</h1>' });

        // Clean up
        await cdp.send('Target.closeTarget', { targetId });
      } finally {
        cdp.close();
      }
    } finally {
      browser.process.kill();
    }
  });
});

describe('ARIA tree via CDP', () => {
  it('gets accessibility tree from a page', async () => {
    const browser = await launch();
    try {
      const cdp = await createCDP(browser.wsUrl);
      try {
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        const session = cdp.session(sessionId);

        await session.send('Page.enable');
        const loadPromise = session.once('Page.loadEventFired', 10000);
        await session.send('Page.navigate', { url: 'data:text/html,<h1>Test</h1><button>Click</button>' });
        await loadPromise;

        await session.send('Accessibility.enable');
        const { nodes } = await session.send('Accessibility.getFullAXTree');

        assert.ok(nodes.length > 0, 'should return ARIA nodes');
        const roles = nodes.map((n) => n.role?.value).filter(Boolean);
        assert.ok(roles.includes('heading'), 'should have heading');
        assert.ok(roles.includes('button'), 'should have button');

        await cdp.send('Target.closeTarget', { targetId });
      } finally {
        cdp.close();
      }
    } finally {
      browser.process.kill();
    }
  });
});
