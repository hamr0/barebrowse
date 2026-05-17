/**
 * Unit tests for the CDP client + chromium launcher.
 * Requires Chromium installed.
 *
 * Run: node --test test/unit/cdp.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, launch, cleanupBrowser } from '../../src/chromium.js';
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
      await cleanupBrowser(browser);
    }
  });

  it('cleanupBrowser removes the owned temp profile dir (F2)', async () => {
    const { existsSync } = await import('node:fs');
    const browser = await launch();
    const dir = browser.ownedProfileDir;
    assert.ok(dir && dir.startsWith('/tmp/barebrowse-'),
      'launch should record the temp profile dir it created');
    assert.ok(existsSync(dir), 'profile dir should exist while browser runs');
    await cleanupBrowser(browser);
    // Give the kernel a beat to release files (Chromium may still hold handles momentarily)
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!existsSync(dir), `profile dir should be removed after cleanup, still at ${dir}`);
  });

  it('reaps the browser when the parent process is signaled (F3)', async () => {
    const { spawn } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = join(here, '..', 'fixtures', 'launch-and-wait.mjs');

    const child = spawn('node', [fixture], { stdio: ['ignore', 'pipe', 'inherit'] });

    // Read BROWSER_PID + PROFILE_DIR from the fixture's stdout
    const { browserPid, profileDir } = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('fixture did not report PID within 15s')), 15000);
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        const pidMatch = buf.match(/BROWSER_PID:(\d+)/);
        const dirMatch = buf.match(/PROFILE_DIR:(\S+)/);
        if (pidMatch && dirMatch) {
          clearTimeout(timer);
          resolve({ browserPid: parseInt(pidMatch[1], 10), profileDir: dirMatch[1] });
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`fixture exited prematurely with code ${code}`));
      });
    });

    assert.ok(browserPid > 0);
    // Confirm browser is alive (kill with signal 0 = existence check)
    assert.doesNotThrow(() => process.kill(browserPid, 0), 'browser should be running');

    // SIGTERM the parent — our exit handler should reap the browser
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));

    // Give the kernel a beat for SIGKILL to propagate + dir to unlink
    await new Promise((r) => setTimeout(r, 500));

    let stillAlive = false;
    try { process.kill(browserPid, 0); stillAlive = true; } catch {}
    assert.equal(stillAlive, false, `browser PID ${browserPid} should be reaped after parent SIGTERM`);
    assert.ok(!existsSync(profileDir), `profile dir ${profileDir} should be removed by exit handler`);
  });

  it('cleanupBrowser leaves user-supplied profile dirs alone (F2)', async () => {
    const { existsSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const userDir = mkdtempSync(join(tmpdir(), 'user-profile-'));
    const browser = await launch({ userDataDir: userDir });
    try {
      assert.equal(browser.ownedProfileDir, null,
        'caller-supplied dirs must not be marked as owned');
    } finally {
      await cleanupBrowser(browser);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(existsSync(userDir), 'user-supplied dir must survive cleanup');
      // Test cleanup
      const { rmSync } = await import('node:fs');
      rmSync(userDir, { recursive: true, force: true });
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
      await cleanupBrowser(browser);
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
      await cleanupBrowser(browser);
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
      await cleanupBrowser(browser);
    }
  });
});
