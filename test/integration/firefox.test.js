/**
 * Integration tests for the Firefox / WebDriver BiDi path (connect({ engine:
 * 'firefox' })). CDP is deprecated in Firefox, so Firefox is driven over BiDi
 * with an in-page-reconstructed AX tree (ax-snapshot.js). These tests assert
 * the reconstruction stays faithful to the CDP AX vocabulary that prune.js /
 * aria.js expect, and that the hard cases (iframes, shadow DOM, CSP) hold.
 *
 * Requires a Firefox binary (>= 121). Skips cleanly if none is installed.
 *
 * Run: node --test test/integration/firefox.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from '../../src/index.js';
import { findFirefox } from '../../src/firefox.js';

const data = (html) => 'data:text/html,' + encodeURIComponent(html);
/** Strip the leading `url:` echo line so assertions test the tree only. */
const treeOnly = (snap) => snap.split('\n').filter((l) => !l.startsWith('url:')).join('\n');

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

describe('connect({ engine: firefox }) — BiDi transport + AX reconstruction', { skip: !hasFirefox && 'no Firefox installed' }, () => {
  it('reconstructs accessible names the way getFullAXTree would', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data(`<main>
        <h1>Welcome</h1>
        <img src="x.png" alt="Company logo">
        <label>Email <input id="email" type="text"></label>
        <button aria-labelledby="l1"></button><span id="l1">Submit form</span>
        <a href="/next">Read more</a>
        <div aria-hidden="true"><button>INVISIBLE</button></div>
      </main>`));
      const tree = treeOnly(await page.snapshot({ mode: 'browse' }));

      assert.match(tree, /image "Company logo"/, 'img alt → accessible name');
      assert.match(tree, /textbox "Email/, '<label> → input accessible name');
      assert.match(tree, /button "Submit form"/, 'aria-labelledby → button name');
      assert.match(tree, /link "Read more"/, 'link name from content');
      assert.match(tree, /heading "Welcome"/, 'heading name from content');
      assert.doesNotMatch(tree, /INVISIBLE/, 'aria-hidden subtree filtered out');
    } finally {
      await page.close();
    }
  });

  it('types into a field via faithful BiDi key events', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data(`<label>Q <input id="q" type="text"></label>`));
      const snap = treeOnly(await page.snapshot());
      const ref = snap.match(/textbox[^\n]*\[ref=(\d+)\]/);
      assert.ok(ref, 'snapshot exposes a textbox ref');
      await page.type(ref[1], 'hello@test.com');
      const value = await page.bidi.evaluate(page.context, 'document.getElementById("q").value', false);
      assert.equal(value, 'hello@test.com', 'type() wrote through real key events');
    } finally {
      await page.close();
    }
  });

  it('splices an iframe subtree and routes clicks into it', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data(`<main><h1>Parent</h1>
        <iframe srcdoc="<button>Inner Button</button>"></iframe></main>`));
      await new Promise((r) => setTimeout(r, 400));
      const tree = treeOnly(await page.snapshot({ mode: 'browse' }));
      assert.match(tree, /button "Inner Button"/, 'iframe content spliced into parent tree');
      const ref = tree.match(/button "Inner Button"[^\n]*\[ref=(\d+)\]/);
      assert.ok(ref, 'inner button has a ref');
      // Click must resolve in the child context, not throw "unknown ref".
      await page.click(ref[1]);
    } finally {
      await page.close();
    }
  });

  it('traverses open shadow roots (getFullAXTree parity)', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data(`<div id="host"></div>
        <script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<button>Shadow Button</button>';</script>`));
      await new Promise((r) => setTimeout(r, 200));
      const tree = treeOnly(await page.snapshot({ mode: 'browse' }));
      assert.match(tree, /Shadow Button/, 'shadow-root content is visible in the snapshot');
    } finally {
      await page.close();
    }
  });

  it('reconstructs the tree under a strict CSP (script.evaluate in an isolated realm)', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data(`<head><meta http-equiv="Content-Security-Policy" content="script-src 'none'; default-src 'none'"></head>
        <body><main><h1>CSP Locked</h1><button>Guarded</button></main></body>`));
      const tree = treeOnly(await page.snapshot({ mode: 'browse' }));
      assert.match(tree, /CSP Locked/, 'snapshot works despite script-src none');
      assert.match(tree, /button "Guarded"/, 'interactive element still captured under CSP');
    } finally {
      await page.close();
    }
  });

  it('press / scroll / hover drive real input events', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      // press(Enter) submits a form
      await page.goto(data(`<main><form onsubmit="document.title='SENT';return false"><input id="i" type="text"></form></main>`));
      let ref = treeOnly(await page.snapshot()).match(/textbox[^\n]*\[ref=(\d+)\]/);
      await page.type(ref[1], 'x');
      await page.press('Enter');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(await page.bidi.evaluate(page.context, 'document.title', false), 'SENT', 'press(Enter) submits');

      // scroll() moves the viewport
      await page.goto(data(`<body style="height:5000px"><div style="margin-top:3000px">x</div></body>`));
      await page.scroll(1200);
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(await page.bidi.evaluate(page.context, 'window.scrollY', false) > 500, 'scroll moves viewport');

      // hover() fires mouseover
      await page.goto(data(`<main><button id="b" onmouseover="this.textContent='HOV'">rest</button></main>`));
      const bref = treeOnly(await page.snapshot()).match(/button[^\n]*\[ref=(\d+)\]/);
      await page.hover(bref[1]);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(await page.bidi.evaluate(page.context, 'document.getElementById("b").textContent', false), 'HOV', 'hover fires mouseover');
    } finally {
      await page.close();
    }
  });

  it('keeps a top-level landmark that has no <main> (CDP parity — F: body-wrapper)', async () => {
    // Regression: without the ignored body wrapper, a top-level <form> (a
    // landmark) was treated as a directly-extractable region and dropped in
    // act mode, diverging from CDP which buries it under body.
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data(`<form onsubmit="return false"><input type="text"></form>`));
      const tree = treeOnly(await page.snapshot()); // default act mode
      assert.match(tree, /form/, 'top-level form survives act-mode pruning');
      assert.match(tree, /textbox/, 'its field survives too');
    } finally {
      await page.close();
    }
  });

  it('goto() enforces the navigation guard (blocks local schemes, allows data:)', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await assert.rejects(
        () => page.goto('file:///etc/passwd'),
        /local|file|scheme|navigat|blocked/i,
        'file:// must be blocked — same guard the CDP path enforces',
      );
      // A normal data: URL must still navigate (guard is not over-broad).
      await page.goto('data:text/html,<h1>ok</h1>');
    } finally {
      await page.close();
    }
  });

  it('navigation history: goBack / goForward / reload', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data('<main><h1>Page A</h1></main>'));
      await page.goto(data('<main><h1>Page B</h1></main>'));
      await page.goBack();
      assert.match(await page.snapshot({ mode: 'browse' }), /Page A/, 'goBack');
      await page.goForward();
      assert.match(await page.snapshot({ mode: 'browse' }), /Page B/, 'goForward');
      await page.goto(data('<main><h1 id="h">Fresh</h1><script>document.getElementById("h").textContent="Mutated"</script></main>'));
      await page.reload();
      assert.match(await page.snapshot({ mode: 'browse' }), /Mutated/, 'reload re-runs scripts');
    } finally {
      await page.close();
    }
  });

  it('select / drag / upload act on the right elements', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      // native select
      await page.goto(data('<main><select id="s"><option>Red</option><option>Green</option></select></main>'));
      const sref = treeOnly(await page.snapshot()).match(/combobox[^\n]*\[ref=(\d+)\]/)[1];
      await page.select(sref, 'Green');
      assert.equal(await page.bidi.evaluate(page.context, 'document.getElementById("s").value', false), 'Green');

      // drag between two resolvable elements (does not throw)
      await page.goto(data('<main><button>A</button><button>B</button></main>'));
      const bRefs = [...treeOnly(await page.snapshot()).matchAll(/button[^\n]*\[ref=(\d+)\]/g)].map((m) => m[1]);
      await page.drag(bRefs[0], bRefs[1]);

      // upload
      const dir = mkdtempSync(join(tmpdir(), 'ff-up-'));
      const f = join(dir, 'a.txt'); writeFileSync(f, 'hi');
      await page.goto(data('<main><input id="f" type="file"></main>'));
      const anyRef = [...(await page.snapshot(false)).matchAll(/\[ref=(\d+)\]/g)].map((m) => m[1]).pop();
      await page.upload(anyRef, [f]);
      assert.equal(await page.bidi.evaluate(page.context, 'document.getElementById("f").files.length', false), 1);
    } finally {
      await page.close();
    }
  });

  it('screenshot() and pdf() return valid base64 payloads', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data('<main><h1>Shot</h1></main>'));
      const png = await page.screenshot();
      assert.ok(Buffer.from(png, 'base64').slice(1, 4).toString() === 'PNG', 'PNG magic bytes');
      const pdf = await page.pdf();
      assert.equal(Buffer.from(pdf, 'base64').slice(0, 5).toString(), '%PDF-', 'PDF magic bytes');
    } finally {
      await page.close();
    }
  });

  it('tabs() / switchTab() / waitFor() operate across contexts', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      const created = await page.bidi.send('browsingContext.create', { type: 'tab' });
      await page.bidi.send('browsingContext.navigate', { context: created.context, url: data('<title>Second</title><main><h1>Second</h1></main>'), wait: 'complete' });
      const tabs = await page.tabs();
      assert.ok(tabs.length >= 2, 'lists both tabs');
      await page.switchTab(tabs.findIndex((t) => /Second/.test(t.title)));
      assert.match(await page.snapshot({ mode: 'browse' }), /Second/, 'switchTab retargets snapshot');

      await page.switchTab(0);
      await page.goto(data('<main id="app"><h1>Wait</h1></main><script>setTimeout(()=>app.innerHTML="<button>Ready</button>",300)</script>'));
      await page.waitFor({ text: 'Ready', timeout: 3000 });
      assert.match(await page.snapshot({ mode: 'browse' }), /Ready/, 'waitFor resolves on late text');
    } finally {
      await page.close();
    }
  });

  it('nests multi-level iframes correctly (parent → child → grandchild + sibling)', async () => {
    // Guards the positional iframe-splice on the hard case the single-level
    // test doesn't cover: a grandchild frame plus a sibling frame must each
    // land under their real parent, in document order.
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data(`<main><h1>PARENT</h1>` +
        `<iframe srcdoc="<h1>CHILD</h1><iframe srcdoc='&lt;h1&gt;GRANDCHILD&lt;/h1&gt;'></iframe>"></iframe>` +
        `<iframe srcdoc="<h1>SIBLING</h1>"></iframe></main>`));
      await new Promise((r) => setTimeout(r, 600));
      const tree = treeOnly(await page.snapshot({ mode: 'read' }));
      for (const label of ['PARENT', 'CHILD', 'GRANDCHILD', 'SIBLING']) {
        assert.match(tree, new RegExp(label), `${label} present in the spliced tree`);
      }
      // GRANDCHILD must sit deeper than CHILD (real nesting, not flattened).
      const indent = (l) => (tree.match(new RegExp(`^(\\s*)[^\\n]*${l}`, 'm')) || [, ''])[1].length;
      assert.ok(indent('GRANDCHILD') > indent('CHILD'), 'GRANDCHILD nested under CHILD');
    } finally {
      await page.close();
    }
  });

  it('switchTab() does not leak another tab\'s iframe into the active snapshot', async () => {
    // Regression: allContexts() must be scoped to the active tab. Before the
    // getTree({root}) fix, snapshotting tab B after switchTab spliced tab A's
    // frame (INNER-A) into B's iframe and dropped INNER-B.
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data('<title>TABA</title><main><h1>TABA</h1><iframe srcdoc="<h1>INNER-A</h1>"></iframe></main>'));
      const created = await page.bidi.send('browsingContext.create', { type: 'tab' });
      await page.bidi.send('browsingContext.navigate', { context: created.context, url: data('<title>TABB</title><main><h1>TABB</h1><iframe srcdoc="<h1>INNER-B</h1>"></iframe></main>'), wait: 'complete' });
      await new Promise((r) => setTimeout(r, 400));
      const tabs = await page.tabs();
      await page.switchTab(tabs.findIndex((t) => /TABB/.test(t.title)));
      const tree = treeOnly(await page.snapshot({ mode: 'read' }));
      assert.match(tree, /INNER-B/, 'active tab B shows its own iframe content');
      assert.doesNotMatch(tree, /INNER-A/, 'tab A iframe must NOT leak into tab B snapshot');
    } finally {
      await page.close();
    }
  });

  it('does not expand a collapsed <select> option list into the tree', async () => {
    // Regression: a native single <select> should surface as one combobox with
    // its current value, NOT one node per <option> (a 200-item select bloats).
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data('<select><option>Afghanistan</option><option>Belgium</option><option>Chad</option></select>'));
      const tree = treeOnly(await page.snapshot({ mode: 'read' }));
      assert.match(tree, /combobox/, 'select surfaces as a combobox');
      assert.doesNotMatch(tree, /Belgium|Chad/, 'unselected options must not become nodes');
    } finally {
      await page.close();
    }
  });

  it('keeps bare text directly under <body> (childNodes, not children)', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data('LOOSE-BODY-TEXT<div>wrapped</div>'));
      const tree = treeOnly(await page.snapshot({ mode: 'read' }));
      assert.match(tree, /LOOSE-BODY-TEXT/, 'bare body text must not be dropped');
    } finally {
      await page.close();
    }
  });

  it('goto() rejects (does not hang) when a page never finishes loading', async () => {
    // Regression: goto must honor its timeout. A server that accepts the
    // request but never responds would hang navigate({wait:'complete'}) forever
    // without the timeout race.
    const held = [];
    const server = createServer((_req, res) => { held.push(res); /* never end */ });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      const started = Date.now();
      await assert.rejects(
        () => page.goto(`http://127.0.0.1:${server.address().port}/hang`, 2000),
        /timed out/,
        'goto must reject on a non-completing load',
      );
      assert.ok(Date.now() - started < 6000, 'rejects near the timeout, not much later');
    } finally {
      for (const r of held) { try { r.destroy(); } catch { /* ignore */ } }
      await page.close();
      server.close();
    }
  });

  it('readable() returns the same result shape as the CDP path', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data(`<article><h1>Title</h1><p>${'Real prose. '.repeat(200)}</p></article>`));
      const r = await page.readable();
      assert.equal(typeof r.ok, 'boolean', 'has ok flag');
      if (r.ok) {
        assert.equal(typeof r.text, 'string');
        assert.ok(['high', 'low'].includes(r.confidence), 'advisory confidence present');
      }
    } finally {
      await page.close();
    }
  });
});

// v0.16.0 — Firefox parity Phase 1: anti-detection + consent auto-dismiss.
describe('connect({ engine: firefox }) — stealth (headless anti-detection)', { skip: !hasFirefox && 'no Firefox installed' }, () => {
  it('hides navigator.webdriver before any page script runs', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      // Inline script captures navigator.webdriver at parse time — if the BiDi
      // preload script ran first (as it must), the page sees `undefined`.
      await page.goto(data('<script>window.__wd = navigator.webdriver;</script><p>x</p>'));
      const atParse = await page.bidi.evaluate(page.context, 'window.__wd', false);
      const now = await page.bidi.evaluate(page.context, 'navigator.webdriver', false);
      assert.equal(atParse, undefined, 'preload beat page JS: navigator.webdriver undefined at parse');
      assert.equal(now, undefined, 'navigator.webdriver reads undefined');
    } finally {
      await page.close();
    }
  });

  it('hides webdriver without the hasOwnProperty tell (defeats advanced detection)', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data('<p>x</p>'));
      // A naive own-property override would leave hasOwnProperty === true, which
      // real browsers report false (webdriver lives on Navigator.prototype).
      // The hardened patch deletes it off the prototype, so all three hold.
      const probe = JSON.parse(await page.bidi.evaluate(page.context, `JSON.stringify({
        undef: navigator.webdriver === undefined,
        ownFalse: !Object.prototype.hasOwnProperty.call(navigator, 'webdriver'),
        inFalse: !('webdriver' in navigator),
      })`, false));
      assert.equal(probe.undef, true, 'navigator.webdriver is undefined');
      assert.equal(probe.ownFalse, true, 'no own-property tell (hasOwnProperty false)');
      assert.equal(probe.inFalse, true, "'webdriver' in navigator is false");
    } finally {
      await page.close();
    }
  });

  it('does NOT fake window.chrome (that would be a Firefox spoof tell)', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data('<p>x</p>'));
      const hasChrome = await page.bidi.evaluate(page.context, 'typeof window.chrome', false);
      assert.equal(hasChrome, 'undefined', 'Firefox must not grow a window.chrome object');
    } finally {
      await page.close();
    }
  });
});

describe('connect({ engine: firefox }) — consent auto-dismiss', { skip: !hasFirefox && 'no Firefox installed' }, () => {
  // A consent dialog whose Accept-all button flips document.title, so the click
  // is observable from outside. The Reject button flips it differently — if the
  // walker ever clicked the wrong one, the assertion would catch it.
  const consentPage = data(`
    <title>unclicked</title>
    <div role="dialog" aria-label="Cookie consent">
      <h2>We value your privacy</h2>
      <p>We use cookies to improve your experience.</p>
      <button onclick="document.title='ACCEPTED'">Accept all</button>
      <button onclick="document.title='REJECTED'">Reject</button>
    </div>`);

  it('clicks the accept button on goto() by default', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(consentPage);
      const title = await page.bidi.evaluate(page.context, 'document.title', false);
      assert.equal(title, 'ACCEPTED', 'consent Accept-all was clicked');
    } finally {
      await page.close();
    }
  });

  it('leaves the dialog untouched when consent:false (control — proves the test can fail)', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless', consent: false });
    try {
      await page.goto(consentPage);
      const title = await page.bidi.evaluate(page.context, 'document.title', false);
      assert.equal(title, 'unclicked', 'consent:false must not click anything');
    } finally {
      await page.close();
    }
  });
});

// v0.17.0 — Firefox parity Phase 2: observability (waitForNetworkIdle over BiDi
// network.* events). Console/network *log* capture lives in the daemon and is
// unit-tested via attachBiDiCapture (test/unit/daemon.test.js) against the
// measured event shapes; here we prove the page-level idle wait works live.
describe('connect({ engine: firefox }) — waitForNetworkIdle (Phase 2)', { skip: !hasFirefox && 'no Firefox installed' }, () => {
  it('resolves once the page network goes quiet (no longer a CDP-only stub)', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data('<body>idle</body>'));
      // Must resolve, not throw "not supported on Firefox".
      await page.waitForNetworkIdle({ idle: 200, timeout: 5000 });
    } finally {
      await page.close();
    }
  });

  it('waits out an in-flight fetch before resolving', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      // A page that keeps the network busy: a slow same-page fetch kicked off
      // after load. waitForNetworkIdle must not resolve until it settles.
      await page.goto(data(`<body>busy<script>
        fetch('data:text/plain,' + 'x'.repeat(100)).catch(()=>{});
      </script></body>`));
      const t = Date.now();
      await page.waitForNetworkIdle({ idle: 300, timeout: 5000 });
      // At minimum the idle window must have elapsed.
      assert.ok(Date.now() - t >= 290, 'waited at least the idle window');
    } finally {
      await page.close();
    }
  });
});

/** Read a window global from the active top context via the BiDi escape hatch. */
async function readGlobal(page, expr) {
  const ctx = (await page.bidi.send('browsingContext.getTree', {})).contexts[0].context;
  return page.bidi.evaluate(ctx, expr, false).catch(() => 'eval-error');
}

describe('connect({ engine: firefox }) — ad/tracker block (Phase 3)', { skip: !hasFirefox && 'no Firefox installed' }, () => {
  // A CORS-enabled local server stands in for a tracker host: when NOT blocked
  // the fetch genuinely succeeds (200 + CORS), so the 'THROUGH'/'BLOCKED'
  // sentinel is unambiguous — a rejection can ONLY come from our block, never
  // from CORS (which was the flaw in a real cross-origin tracker). We match it
  // via blockUrls so the test owns the pattern rather than depending on the
  // default list hitting the network.
  let server, origin, marker;
  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
    marker = `${origin}/tracker.gif`;
  });

  const trackerPage = () => data(`<body>ads<script>
    fetch(${JSON.stringify(marker)})
      .then(() => window.__t = 'THROUGH').catch(() => window.__t = 'BLOCKED');
  </script></body>`);

  it('blocks a matched request (via blockUrls)', async () => {
    const page = await connect({
      engine: 'firefox', mode: 'headless',
      blockUrls: [`*://127.0.0.1:*/tracker*`],
    });
    try {
      await page.goto(trackerPage());
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(await readGlobal(page, 'window.__t'), 'BLOCKED');
    } finally {
      await page.close();
    }
  });

  it('lets the same request through when blockAds:false (control — proves it can fail)', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless', blockAds: false });
    try {
      await page.goto(trackerPage());
      await new Promise((r) => setTimeout(r, 1500));
      // Nothing installed → the CORS-enabled fetch succeeds.
      assert.equal(await readGlobal(page, 'window.__t'), 'THROUGH');
    } finally {
      await page.close();
    }
  });

  after(() => server?.close());
});

describe('connect({ engine: firefox }) — JS dialogs (Phase 3)', { skip: !hasFirefox && 'no Firefox installed' }, () => {
  it('auto-accepts and records alert/prompt/confirm in dialogLog', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data('<body>hi</body>'));
      const ctx = (await page.bidi.send('browsingContext.getTree', {})).contexts[0].context;
      const alertR = await page.bidi.evaluate(ctx, 'alert("a"); "after"', true);
      const promptR = await page.bidi.evaluate(ctx, 'prompt("q","deflt")', true);
      const confirmR = await page.bidi.evaluate(ctx, 'confirm("ok?")', true);
      // Default handling: alert dismissed (JS resumes), prompt accepts the
      // default value, confirm accepts (true) — mirroring the CDP path.
      assert.equal(alertR, 'after');
      assert.equal(promptR, 'deflt');
      assert.equal(confirmR, true);
      assert.deepEqual(page.dialogLog.map((d) => d.type), ['alert', 'prompt', 'confirm']);
      assert.equal(page.dialogLog[0].message, 'a');
    } finally {
      await page.close();
    }
  });

  it('honors a custom onDialog handler (override text + reject)', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data('<body>hi</body>'));
      page.onDialog((d) => (d.type === 'confirm' ? { accept: false } : { accept: true, promptText: 'custom' }));
      const ctx = (await page.bidi.send('browsingContext.getTree', {})).contexts[0].context;
      const promptR = await page.bidi.evaluate(ctx, 'prompt("q","x")', true);
      const confirmR = await page.bidi.evaluate(ctx, 'confirm("ok?")', true);
      assert.equal(promptR, 'custom', 'prompt returned the handler text');
      assert.equal(confirmR, false, 'confirm was rejected');
    } finally {
      await page.close();
    }
  });
});

describe('connect({ engine: firefox }) — saveState (Phase 4)', { skip: !hasFirefox && 'no Firefox installed' }, () => {
  // A real (non-opaque) origin so cookies persist and localStorage is writable
  // — data: URLs have an opaque origin where both fail (measured in the POC).
  let server, origin;
  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'set-cookie': 'sess=abc123; Path=/; SameSite=Lax', 'content-type': 'text/html' });
      res.end('<script>localStorage.setItem("token","xyz")</script>hello');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}/`;
  });
  after(() => server?.close());

  it('writes cookies + localStorage to a 0600 JSON file (CDP-symmetric shape)', async () => {
    const { mkdtempSync, readFileSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'bb-state-')), 'state.json');
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(origin);
      await page.saveState(file);
      const state = JSON.parse(readFileSync(file, 'utf8'));
      // Flattened cookie shape (value is a plain string, not BiDi's {type,value}).
      const c = state.cookies.find((x) => x.name === 'sess');
      assert.ok(c, 'session cookie captured');
      assert.equal(c.value, 'abc123', 'cookie value flattened to a string');
      assert.equal(c.domain, '127.0.0.1');
      // sameSite capitalized to CDP's vocabulary (Lax, not BiDi's 'lax') so the
      // state file reloads via connect()'s CDP-only storageState loader.
      assert.equal(c.sameSite, 'Lax', 'sameSite capitalized for CDP setCookies');
      assert.equal(state.localStorage.token, 'xyz', 'localStorage captured');
      // Owner-only — it holds session tokens (security invariant).
      assert.equal(statSync(file).mode & 0o777, 0o600, 'state file is 0600');
    } finally {
      await page.close();
    }
  });
});

describe('connect({ engine: firefox }) — waitForNavigation (Phase 4)', { skip: !hasFirefox && 'no Firefox installed' }, () => {
  // A real http origin: Firefox blocks top-level data: navigation from links,
  // so a data:→data: click never fires a load. Two same-origin routes let a
  // real click drive a real navigation whose load event we wait on.
  let server, origin;
  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(req.url.startsWith('/second')
        ? '<body>SECOND PAGE</body>'
        : '<body><a id="go" href="/second">go</a></body>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}/`;
  });
  after(() => server?.close());

  it('resolves on the next top-context load event', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(origin);
      const ref = (await page.snapshot()).match(/link[^\n]*\[ref=(\d+)\]/);
      assert.ok(ref, 'link ref present');
      // Kick off the nav and wait for its load — must resolve, not time out.
      const waited = page.waitForNavigation(10000);
      await page.click(ref[1]);
      await waited;
      const body = await page.bidi.evaluate(page.context, 'document.body.innerText', false);
      assert.match(body, /SECOND PAGE/, 'navigation completed');
    } finally {
      await page.close();
    }
  });

  it('falls back to a settle delay when no load event fires (SPA)', async () => {
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data('<body>spa</body>'));
      // No navigation triggered → short timeout → resolves via settle, no throw.
      await page.waitForNavigation(600);
    } finally {
      await page.close();
    }
  });
});

describe('connect({ engine: firefox }) — downloads (Phase 4)', { skip: !hasFirefox && 'no Firefox installed' }, () => {
  it('records a completed download with a savedPath in the throwaway dir', async () => {
    const { readFileSync } = await import('node:fs');
    const page = await connect({ engine: 'firefox', mode: 'headless' });
    try {
      await page.goto(data('<a id="d" href="data:application/octet-stream,helloworld" download="f.bin">dl</a>'));
      const ref = (await page.snapshot()).match(/link[^\n]*\[ref=(\d+)\]/);
      assert.ok(ref, 'download link ref present');
      await page.click(ref[1]);
      // Wait for downloadEnd to populate the record.
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !(page.downloads[0] && page.downloads[0].state === 'completed')) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const d = page.downloads[0];
      assert.ok(d, 'a download was recorded');
      assert.equal(d.suggestedFilename, 'f.bin');
      assert.equal(d.state, 'completed', 'normalized to CDP-style "completed"');
      assert.ok(d.savedPath, 'savedPath filled from downloadEnd filepath');
      assert.equal(readFileSync(d.savedPath, 'utf8'), 'helloworld', 'file landed on disk');
    } finally {
      await page.close();
    }
  });
});
