/**
 * Integration tests for connect() session lifecycle and contract.
 * Bug-fix regression tests live here as fixes land.
 *
 * Run: node --test test/integration/connect.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../../src/index.js';

describe('connect() — page handle contract', () => {
  it('exposes page.cdp as a getter so it survives session swaps (F1)', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      const desc = Object.getOwnPropertyDescriptor(page, 'cdp');
      assert.equal(typeof desc.get, 'function',
        'page.cdp must be a getter — a captured value goes stale after hybrid fallback or switchTab swaps the underlying session');
      // Sanity: getter actually returns a live CDP session
      const { product } = await page.cdp.send('Browser.getVersion');
      assert.ok(product, 'cdp.send should reach the live session');
    } finally {
      await page.close();
    }
  });

  it('connect() forwards binary opt to launch (L2)', async () => {
    await assert.rejects(
      () => connect({ binary: '/definitely/not/a/real/browser/binary' }),
      /Failed to launch browser|ENOENT/,
      'a bogus binary path must reach launch() and fail',
    );
  });

  it('connect() forwards userDataDir opt to launch (L2)', async () => {
    const { mkdtempSync, rmSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const userDir = mkdtempSync(join(tmpdir(), 'bb-connect-l2-'));
    let page;
    try {
      page = await connect({ userDataDir: userDir });
      await page.goto('data:text/html,<h1>L2-test</h1>');
      assert.ok(readdirSync(userDir).length > 0,
        'Chromium must populate the user-supplied profile dir — proves connect() forwarded userDataDir');
    } finally {
      if (page) await page.close();
      // Same post-exit race as cleanupBrowser — Chromium may still hold
      // files briefly; retry rmSync on ENOTEMPTY/EBUSY.
      for (let i = 0; i < 10; i++) {
        try { rmSync(userDir, { recursive: true, force: true }); break; }
        catch (e) {
          if (e.code !== 'ENOTEMPTY' && e.code !== 'EBUSY') break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  });

  it('goBack/goForward await navigation before returning (F8)', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      await page.goto('data:text/html,<h1>UNIQUE-PAGE-A</h1>');
      await page.goto('data:text/html,<h1>UNIQUE-PAGE-B</h1>');

      await page.goBack();
      const backSnap = await page.snapshot();
      assert.ok(backSnap.includes('UNIQUE-PAGE-A'),
        `after goBack, snapshot should show A, got:\n${backSnap}`);
      assert.ok(!backSnap.includes('UNIQUE-PAGE-B'),
        'after goBack, snapshot must not still reflect B');

      await page.goForward();
      const fwdSnap = await page.snapshot();
      assert.ok(fwdSnap.includes('UNIQUE-PAGE-B'),
        `after goForward, snapshot should show B, got:\n${fwdSnap}`);
    } finally {
      await page.close();
    }
  });

  it('createTab wires dialog handler so dialogs do not hang navigation (F7)', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      const tab = await page.createTab();
      const url = 'data:text/html,<html><body>hi<script>alert("from-tab")</script></body></html>';
      // Without the dialog handler the alert() blocks script execution and
      // Page.loadEventFired never fires — navigate() would hang to timeout.
      // 10s gives us a clear failure rather than the integration suite's full hang.
      await tab.goto(url, 10000);
      assert.ok(page.dialogLog.some((d) => d.message === 'from-tab'),
        `tab's alert should be captured in dialogLog, got: ${JSON.stringify(page.dialogLog)}`);
      await tab.close();
    } finally {
      await page.close();
    }
  });

  it('goto invalidates refMap so stale refs error clearly (F5)', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      await page.goto('data:text/html,<button>BUTTON-ON-PAGE-A</button>');
      const snapA = await page.snapshot();
      // Pull any ref from page A's snapshot
      const m = snapA.match(/\[ref=([^\]]+)\]/);
      assert.ok(m, `expected at least one [ref=N] marker, got:\n${snapA}`);
      const refFromA = m[1];

      await page.goto('data:text/html,<p>different page B with no buttons</p>');
      // The ref from page A must no longer resolve — clear error, not a
      // silent wrong-element click or a CDP "Node was destroyed" leak.
      await assert.rejects(
        () => page.click(refFromA),
        /No element found for ref/,
        'a ref captured before goto() must be rejected after navigation',
      );
    } finally {
      await page.close();
    }
  });

  it('connect({ port }) attaches to a running browser and leaves it alive on close (H1)', async () => {
    const { launch, cleanupBrowser } = await import('../../src/chromium.js');
    // Stand up a "user's browser" that already exists with a debug port.
    const running = await launch({});
    try {
      const page = await connect({ port: running.port });
      try {
        await page.goto('data:text/html,<h1>ATTACHED-OK</h1>');
        const snap = await page.snapshot();
        assert.ok(snap.includes('ATTACHED-OK'),
          `attached session must navigate + snapshot the running browser, got:\n${snap}`);
      } finally {
        await page.close();
      }

      // The whole point of H1 — close() on an attached session must NOT
      // kill the user's browser or wipe their profile. The launched
      // process must still be running.
      assert.equal(running.process.exitCode, null,
        'connect({ port }).close() must not kill the externally-launched browser');

      // Re-attach to prove the browser is still talking CDP after our close.
      const again = await connect({ port: running.port });
      try {
        await again.goto('data:text/html,<h1>RE-ATTACHED-OK</h1>');
        const snap2 = await again.snapshot();
        assert.ok(snap2.includes('RE-ATTACHED-OK'),
          `second attach must also work — the browser kept running, got:\n${snap2}`);
      } finally {
        await again.close();
      }
      assert.equal(running.process.exitCode, null,
        'second close() must also leave the externally-launched browser alive');
    } finally {
      await cleanupBrowser(running);
    }
  });

  it('downloads array captures Content-Disposition attachments (H7)', async () => {
    const { createServer } = await import('node:http');
    const { existsSync, readFileSync, rmSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');

    const PAYLOAD = 'this-is-the-file-body-' + Math.random().toString(36).slice(2);
    const server = createServer((req, res) => {
      if (req.url === '/file.txt') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="hello.txt"',
        });
        res.end(PAYLOAD);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<a href="/file.txt" download>get</a>');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const dlDir = mkdtempSync(joinPath(tmpdir(), 'bb-h7-test-'));
    const page = await connect({ mode: 'headless', downloadPath: dlDir });
    try {
      // Navigate to a page that auto-triggers the download. We just go
      // straight to the attachment URL — Chromium routes it through the
      // download path because of Content-Disposition.
      page.goto(`http://127.0.0.1:${port}/file.txt`).catch(() => {});

      // Poll for the download to complete (no Page.loadEventFired for raw
      // downloads — page.goto may reject or just stall).
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const d = page.downloads.find((x) => x.state === 'completed');
        if (d) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      assert.ok(page.downloads.length > 0,
        'page.downloads must list every Content-Disposition: attachment response');
      const dl = page.downloads[0];
      assert.equal(dl.suggestedFilename, 'hello.txt',
        `suggestedFilename should reflect Content-Disposition; got: ${dl.suggestedFilename}`);
      assert.equal(dl.state, 'completed',
        `download must reach completed state, got: ${dl.state}`);
      assert.ok(existsSync(dl.savedPath),
        `downloaded file must exist at savedPath=${dl.savedPath}`);
      assert.equal(readFileSync(dl.savedPath, 'utf8'), PAYLOAD,
        'downloaded file body must match what the server sent');
    } finally {
      await page.close();
      try { rmSync(dlDir, { recursive: true, force: true }); } catch {}
      await new Promise((r) => server.close(r));
    }
  });

  it('onDialog handler overrides the default auto-accept (H8)', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      // Page calls confirm() and prompt(); we install a handler that
      // (a) rejects the confirm, (b) supplies a custom string to the prompt.
      // The page writes both results into the document so we can read them
      // back through a snapshot — proves the dialog reply reached the JS.
      const html = `
        <body>
          <div id="c"></div>
          <div id="p"></div>
          <script>
            window.addEventListener('load', () => {
              const c = confirm('really?');
              const p = prompt('name?', 'default');
              document.getElementById('c').textContent = 'CONFIRM-' + c;
              document.getElementById('p').textContent = 'PROMPT-' + p;
            });
          </script>
        </body>`;

      // Install handler BEFORE goto — listener wired at connect() time uses
      // the closure variable so this takes effect immediately.
      const seen = [];
      page.onDialog(({ type, message }) => {
        seen.push({ type, message });
        if (type === 'confirm') return { accept: false };
        if (type === 'prompt') return { accept: true, promptText: 'CUSTOM-VALUE' };
        return undefined; // fall through to defaults
      });

      await page.goto(`data:text/html,${encodeURIComponent(html)}`);

      const snap = await page.snapshot();
      assert.ok(snap.includes('CONFIRM-false'),
        `confirm() must return false when handler returns { accept: false }, got:\n${snap}`);
      assert.ok(snap.includes('PROMPT-CUSTOM-VALUE'),
        `prompt() must receive the handler's promptText, got:\n${snap}`);
      assert.ok(seen.some((d) => d.type === 'confirm' && d.message === 'really?'),
        `handler should have observed the confirm, got: ${JSON.stringify(seen)}`);
      assert.ok(seen.some((d) => d.type === 'prompt' && d.message === 'name?'),
        `handler should have observed the prompt, got: ${JSON.stringify(seen)}`);

      // Removing the handler (null) restores the default auto-accept.
      page.onDialog(null);
      const html2 = `<body><div id="r"></div><script>
        window.addEventListener('load', () => {
          document.getElementById('r').textContent = 'CONFIRM2-' + confirm('again');
        });</script></body>`;
      await page.goto(`data:text/html,${encodeURIComponent(html2)}`);
      const snap2 = await page.snapshot();
      assert.ok(snap2.includes('CONFIRM2-true'),
        `with handler removed, confirm() must auto-accept (return true), got:\n${snap2}`);
    } finally {
      await page.close();
    }
  });

  it('reload() refetches the current page and invalidates refMap (H3)', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      await page.goto('data:text/html,<button>BEFORE-RELOAD</button>');
      const before = await page.snapshot();
      const refMatch = before.match(/\[ref=(\d+)\]/);
      assert.ok(refMatch, `expected a ref pre-reload, got:\n${before}`);
      const staleRef = refMatch[1];

      await page.reload();

      // Same invalidation contract as goto/goBack: refs captured before
      // reload must be rejected. Important: do NOT snapshot before this
      // assertion — snapshot() re-populates refMap and the same ref number
      // may get reissued on a single-element page.
      await assert.rejects(
        () => page.click(staleRef),
        /No element found for ref/,
        'a ref captured before reload() must be rejected after reload',
      );

      // Now confirm reload actually refetched the same URL — content is back.
      const after = await page.snapshot();
      assert.ok(after.includes('BEFORE-RELOAD'),
        `reload must refetch the same URL — expected button still present, got:\n${after}`);

      // ignoreCache: true is also accepted and doesn't blow up.
      await page.reload({ ignoreCache: true });
      const afterNoCache = await page.snapshot();
      assert.ok(afterNoCache.includes('BEFORE-RELOAD'),
        `reload({ ignoreCache: true }) must also succeed, got:\n${afterNoCache}`);
    } finally {
      await page.close();
    }
  });

  it('snapshot surfaces iframe content + clicks resolve to the iframe session (H2)', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      // Outer page hosts an iframe whose body contains a button. With
      // --site-per-process the iframe becomes OOPIF and gets its own CDP
      // session; pre-H2 we never read that session's AX tree, so the iframe
      // was invisible to snapshot and unreachable to click. The button
      // rewrites its own label on click so we can verify the click landed
      // inside the iframe via a re-snapshot (cross-origin DOM access is
      // blocked from the parent, so we can't peek through contentDocument).
      const inner = encodeURIComponent('<html><body><button id="b">CLICK-ME-IN-IFRAME</button>'
        + '<script>document.getElementById("b").addEventListener("click",'
        + '()=>{document.getElementById("b").textContent="CLICKED-IN-IFRAME"})</script>'
        + '</body></html>');
      const outer = encodeURIComponent(`<html><body><h1>OUTER-PAGE</h1>`
        + `<iframe id="f" src="data:text/html,${inner}" width="400" height="200"></iframe>`
        + `</body></html>`);
      await page.goto(`data:text/html,${outer}`);
      // Iframes can finish loading slightly after the outer page's load event;
      // give Target.attachedToTarget a beat to register the child session.
      await new Promise((r) => setTimeout(r, 500));

      const snap = await page.snapshot();
      assert.ok(snap.includes('OUTER-PAGE'),
        `snapshot should include outer page content, got:\n${snap}`);
      assert.ok(snap.includes('CLICK-ME-IN-IFRAME'),
        `snapshot must surface iframe content (H2 — without merge, iframe is invisible), got:\n${snap}`);

      // Pull the button's ref out of the merged snapshot and click it. If the
      // refMap entry's session is wrong (parent vs iframe), the click either
      // hits the wrong element or DOM.getBoxModel returns frame-local coords
      // that don't map to anything in the parent viewport.
      const refMatch = snap.match(/button[^[]*CLICK-ME-IN-IFRAME[^[]*\[ref=(\d+)\]/);
      assert.ok(refMatch, `expected a [ref=N] for the iframe button, got:\n${snap}`);
      await page.click(refMatch[1]);

      // Re-snapshot — the iframe button should now show its post-click label.
      // This proves the click dispatched into the OOPIF (not the parent doc).
      const snap2 = await page.snapshot();
      assert.ok(snap2.includes('CLICKED-IN-IFRAME'),
        `click(ref) must dispatch in the iframe session — expected "CLICKED-IN-IFRAME" in re-snapshot, got:\n${snap2}`);
    } finally {
      await page.close();
    }
  });

  it('switchTab actually swaps the working session (F4)', async () => {
    const page = await connect({ mode: 'headless' });
    try {
      await page.goto('data:text/html,<title>TAB-ONE</title><h1>page one</h1>');

      // Open a second tab from within the page (window.open is suppressed in
      // headless, so use Target.createTarget directly via the escape hatch).
      const { targetId } = await page.cdp.send('Target.createTarget',
        { url: 'data:text/html,<title>TAB-TWO</title><h1>page two</h1>' });
      // Give the new tab a moment to load its data: URL
      await new Promise((r) => setTimeout(r, 300));

      const tabs = await page.tabs();
      const newIdx = tabs.findIndex((t) => t.targetId === targetId);
      assert.ok(newIdx >= 0, 'new tab should be in tabs() list');

      await page.switchTab(newIdx);
      const snap = await page.snapshot();
      assert.ok(snap.includes('page two'),
        `snapshot after switchTab should show new tab content, got:\n${snap}`);
      assert.ok(!snap.includes('page one'),
        'snapshot must NOT still reflect the original tab');
    } finally {
      await page.close();
    }
  });
});
