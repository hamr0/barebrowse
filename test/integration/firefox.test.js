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

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
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
