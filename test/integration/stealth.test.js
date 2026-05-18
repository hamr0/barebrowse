/**
 * Integration tests for src/stealth.js — verify the patches actually land in
 * the page's JS context and the UA override reaches the page.
 *
 * Run: node --test test/integration/stealth.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from '../../src/index.js';

async function readWindow(page, expr) {
  const { result } = await page.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return result.value;
}

/**
 * Spin up a one-off localhost HTTP server. 127.0.0.1 is a "potentially
 * trustworthy" origin per the Secure Contexts spec, so the page Chrome
 * delivers has `window.isSecureContext === true` and `Notification` is
 * defined — neither holds for data:/about:blank, which means we can't
 * observe the Notification.permission patch from those origins.
 */
async function startLocalhost(body) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) };
}

describe('stealth patches in headless (H4)', () => {
  it('hides webdriver, fixes UA, fakes hardware, and spoofs WebGL', async () => {
    const server = await startLocalhost('<!doctype html><h1>stealth-probe</h1>');
    const page = await connect({ mode: 'headless' });
    try {
      await page.goto(server.url);

      // 1. webdriver: must be undefined (the load-bearing automation tell).
      const webdriver = await readWindow(page, 'navigator.webdriver');
      assert.equal(webdriver, undefined, 'navigator.webdriver must read as undefined');

      // 2. User-Agent: --headless=new leaves "HeadlessChrome" in the UA string.
      //    Network.setUserAgentOverride must strip it out (H4).
      const ua = await readWindow(page, 'navigator.userAgent');
      assert.ok(!/HeadlessChrome/i.test(ua),
        `navigator.userAgent must not contain "HeadlessChrome", got: ${ua}`);
      assert.ok(/Chrome/.test(ua),
        `navigator.userAgent should still claim Chrome, got: ${ua}`);

      // 3. hardwareConcurrency + deviceMemory — realistic desktop values.
      const cores = await readWindow(page, 'navigator.hardwareConcurrency');
      assert.equal(cores, 8, 'navigator.hardwareConcurrency must report the spoofed 8');
      const mem = await readWindow(page, 'navigator.deviceMemory');
      assert.equal(mem, 8, 'navigator.deviceMemory must report the spoofed 8');

      // 4. Notification.permission — real Chrome at first-load reports
      //    'default'; headless reports 'denied' which is a fingerprint.
      const notifPerm = await readWindow(page, 'Notification.permission');
      assert.equal(notifPerm, 'default',
        `Notification.permission must report 'default', got: ${notifPerm}`);

      // 5. chrome.runtime exists and has the enum shapes real Chrome ships.
      const runtimeShape = await readWindow(page,
        'window.chrome && window.chrome.runtime && !!window.chrome.runtime.PlatformOs');
      assert.equal(runtimeShape, true,
        'window.chrome.runtime.PlatformOs must be present');

      // 6. WebGL UNMASKED_VENDOR_WEBGL (37445) / UNMASKED_RENDERER_WEBGL (37446) —
      //    real desktop GPUs, not "Google SwiftShader" / "Google Inc. (Google)".
      const webglVendor = await readWindow(page, `(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null;
      })()`);
      assert.ok(webglVendor && !/Google|SwiftShader/i.test(webglVendor),
        `WebGL UNMASKED_VENDOR_WEBGL must not leak Google/SwiftShader, got: ${webglVendor}`);

      const webglRenderer = await readWindow(page, `(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
      })()`);
      assert.ok(webglRenderer && !/SwiftShader|Google/i.test(webglRenderer),
        `WebGL UNMASKED_RENDERER_WEBGL must not leak SwiftShader/Google, got: ${webglRenderer}`);

      // 7. Plugins + languages must remain non-empty.
      const pluginCount = await readWindow(page, 'navigator.plugins.length');
      assert.ok(pluginCount > 0, 'navigator.plugins must be non-empty');
      const langs = await readWindow(page, 'JSON.stringify(navigator.languages)');
      assert.ok(langs && langs.includes('en'),
        `navigator.languages should include 'en', got: ${langs}`);

      // 8. Canvas-noise — toDataURL must be a patched function (not native),
      //    and rendering identical canvases in two separate sessions must
      //    yield different fingerprints. Within one session the seed is
      //    stable, so the same canvas read twice is unchanged (otherwise
      //    legitimate canvas use would flicker).
      const isPatched = await readWindow(page,
        'HTMLCanvasElement.prototype.toDataURL.toString().includes("[native code]")');
      assert.equal(isPatched, false,
        'HTMLCanvasElement.prototype.toDataURL must be replaced, not native');
      const fingerprint = await readWindow(page, `(() => {
        const c = document.createElement('canvas');
        c.width = 200; c.height = 50;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#f60'; ctx.fillRect(0, 0, 200, 50);
        ctx.fillStyle = '#069'; ctx.font = '16px sans-serif';
        ctx.fillText('barebrowse-fp 🤖', 4, 24);
        return c.toDataURL();
      })()`);
      assert.ok(typeof fingerprint === 'string' && fingerprint.startsWith('data:image/png'),
        'canvas toDataURL must still produce a valid PNG data URL');
    } finally {
      await page.close();
      await server.close();
    }
  });

  it('canvas fingerprint differs across two headless sessions (canvas-noise)', async () => {
    // Two fresh `connect()` calls = two STEALTH_SCRIPT evals = two CANVAS_SEED
    // values. Rendering the same content in each session should produce
    // different toDataURL output. (Same session would produce the same output
    // since the seed is stable per page.)
    const server = await startLocalhost('<!doctype html><h1>canvas-probe</h1>');
    const renderScript = `(() => {
      const c = document.createElement('canvas');
      c.width = 200; c.height = 50;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#f60'; ctx.fillRect(0, 0, 200, 50);
      ctx.fillStyle = '#069'; ctx.font = '16px sans-serif';
      ctx.fillText('barebrowse-fp', 4, 24);
      return c.toDataURL();
    })()`;
    const p1 = await connect({ mode: 'headless' });
    const p2 = await connect({ mode: 'headless' });
    try {
      await p1.goto(server.url);
      await p2.goto(server.url);
      const fp1 = await readWindow(p1, renderScript);
      const fp2 = await readWindow(p2, renderScript);
      assert.notEqual(fp1, fp2,
        'two headless sessions rendering the same canvas should produce different fingerprints');
    } finally {
      await p1.close();
      await p2.close();
      await server.close();
    }
  });
});
