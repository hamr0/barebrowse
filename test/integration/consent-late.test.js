/**
 * Integration test: a consent dialog that renders ~1.5s AFTER load (Google
 * Funding Choices style) is dismissed by the first snapshot() after goto(),
 * and pages without a dialog pay for exactly one extra consent check per
 * navigation — not per snapshot. Both engines.
 *
 * Run: node --test test/integration/consent-late.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from '../../src/index.js';
import { findFirefox } from '../../src/firefox.js';

const LATE = `<!doctype html><html><body><main><h1 id="out">idle</h1><p>Showtimes</p></main>
<script>setTimeout(() => {
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Example asks for your consent');
  d.innerHTML = '<p>We and our partners use cookies</p><button id="c">Consent</button><button>Manage options</button>';
  d.querySelector('#c').onclick = () => { document.getElementById('out').textContent = 'consent clicked'; d.remove(); };
  document.body.appendChild(d);
}, 1500);</script></body></html>`;
// A has no popup but navigates itself to B after goto() returned; B shows a dialog.
const REDIR = '<!doctype html><html><body><main><h1>A</h1></main><script>setTimeout(() => { location.href = "/b"; }, 1500);</script></body></html>';
const B = LATE.replace('1500', '200');
// No dialog at load; the page changes its history entry (pushState or hash) on the SAME
// document, then renders a late dialog. Still the document the goto landed on.
const SPA = (nav) => `<!doctype html><html><body><main><h1 id="out">idle</h1><p>Showtimes</p></main>
<script>setTimeout(() => { ${nav} }, 800);
setTimeout(() => {
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Example asks for your consent');
  d.innerHTML = '<p>We and our partners use cookies</p><button id="c">Consent</button><button>Manage options</button>';
  d.querySelector('#c').onclick = () => { document.getElementById('out').textContent = 'consent clicked'; d.remove(); };
  document.body.appendChild(d);
}, 1500);</script></body></html>`;
const PLAIN = '<!doctype html><html><body><main><h1>Plain</h1><p>No popup here</p></main></body></html>';

async function serve() {
  const srv = createServer((q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(q.url.startsWith('/push') ? SPA("history.pushState({}, '', '/pushed');") : q.url.startsWith('/hash') ? SPA("location.hash = '#z';") : q.url.startsWith('/late') ? LATE : q.url.startsWith('/redir') ? REDIR : q.url.startsWith('/b') ? B : PLAIN);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

// The AX-tree fetch each engine performs per consent pass / snapshot.
const probe = {
  chromium: { target: (p) => p.cdp, method: 'Accessibility.getFullAXTree' },
  firefox: { target: (p) => p.bidi, method: 'script.evaluate' },
};

for (const engine of ['chromium', 'firefox']) {
  describe(`late consent dialog — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    it('first snapshot after goto dismisses a dialog that appeared after load', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true });
      try {
        await page.goto(srvr.url + '/late');
        await new Promise((r) => setTimeout(r, 2500));
        const snap = await page.snapshot();
        assert.ok(snap.includes('consent clicked'), 'Consent button must have been clicked:\n' + snap);
        assert.ok(!/dialog/.test(snap), 'dialog must be gone from the snapshot:\n' + snap);
      } finally { await page.close(); await srvr.close(); }
    });

    it('no dialog: only the first snapshot after goto re-checks', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true });
      try {
        await page.goto(srvr.url + '/plain');
        const t = probe[engine].target(page);
        const orig = t.send;
        let calls = 0;
        t.send = function (method, ...a) { if (method === probe[engine].method) calls++; return orig.call(this, method, ...a); };
        const count = async () => { calls = 0; await page.snapshot(); return calls; };
        const first = await count();
        const second = await count();
        const third = await count();
        t.send = orig;
        // Chromium: one extra AX-tree fetch. Firefox: one extra document-identity evaluate
        // (the re-check reuses the tree snapshot() already built).
        assert.equal(first, second + 1, `first snapshot adds exactly one round-trip (first=${first}, second=${second})`);
        assert.equal(second, third, 'later snapshots must not re-check');
      } finally { await page.close(); await srvr.close(); }
    });

    for (const kind of ['push', 'hash']) {
      it(`same-document history change (${kind === 'push' ? 'pushState' : 'location.hash'}) still gets the late re-check`, async () => {
        const srvr = await serve();
        const page = await connect({ engine, mode: 'headless', allowLocalUrls: true });
        try {
          await page.goto(srvr.url + '/' + kind);
          await new Promise((r) => setTimeout(r, 2500));
          const snap = await page.snapshot();
          assert.ok(snap.includes('consent clicked'), 'Consent button must have been clicked:\n' + snap);
          assert.ok(!/dialog/.test(snap), 'dialog must be gone from the snapshot:\n' + snap);
        } finally { await page.close(); await srvr.close(); }
      });
    }

    it('a flag set for page A does not auto-accept a dialog on page B reached without goto()', async () => {
      const srvr = await serve();
      const page = await connect({ engine, mode: 'headless', allowLocalUrls: true });
      try {
        await page.goto(srvr.url + '/redir');
        await new Promise((r) => setTimeout(r, 3500)); // A navigates to B, B shows its dialog
        const snap = await page.snapshot();
        assert.ok(snap.includes('/b\n'), 'must be on page B:\n' + snap);
        assert.ok(!snap.includes('consent clicked'), 'must not click B\'s dialog:\n' + snap);
        assert.ok(/dialog/.test(snap), 'B\'s dialog must still be in the snapshot:\n' + snap);
      } finally { await page.close(); await srvr.close(); }
    });
  });
}

describe('late consent dialog — attach mode (chromium)', () => {
  it('goto runs consent in attach mode, so the first snapshot re-checks too', async () => {
    const { launch, cleanupBrowser } = await import('../../src/chromium.js');
    const srvr = await serve();
    const running = await launch({});
    try {
      const page = await connect({ port: running.port, allowLocalUrls: true });
      try {
        await page.goto(srvr.url + '/late');
        await new Promise((r) => setTimeout(r, 2500));
        const snap = await page.snapshot();
        assert.ok(snap.includes('consent clicked'), 'Consent button must have been clicked:\n' + snap);
      } finally { await page.close(); }
    } finally { await cleanupBrowser(running); await srvr.close(); }
  });
});
