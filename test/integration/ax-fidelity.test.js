/**
 * AX-fidelity harness (Phase 5).
 *
 * Firefox has no `getFullAXTree`, so the BiDi engine reconstructs a
 * CDP-vocabulary AX tree in-page (src/ax-snapshot.js). The risk is drift: a
 * reconstruction that silently drops or misnames a node an agent needs. Earlier
 * that comparison was done by hand and caught four real bugs (name-from-content
 * fallback, `<label>`→LabelText, `img`→image, the body-wrapper divergence).
 *
 * This harness makes it repeatable: it drives the SAME set of fixture pages
 * through both engines and asserts the Firefox snapshot never DROPS a semantic
 * node that the CDP baseline found. CDP (Chromium's native AX tree) is the
 * source of truth.
 *
 * Deliberately compared on ROLE + NAME only, not property brackets. Property
 * annotations (`[level]`, `[expanded]`, `[value]`, …) and `StaticText` echoes
 * legitimately differ between the engines — the BiDi reconstruction doesn't
 * compute every ARIA state — and are not what an agent navigates by. What must
 * NOT drift is which named, interactive/structural nodes exist. Extra Firefox
 * nodes are reported but not failed on (over-reporting is safe; dropping isn't).
 *
 * Needs BOTH a Chromium binary and a Firefox binary (>= 121). Skips cleanly if
 * either is missing. Local-only (two real browsers) — not part of the CI gate.
 *
 * Run: node --test test/integration/ax-fidelity.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../../src/index.js';
import { findBrowser } from '../../src/chromium.js';
import { findFirefox } from '../../src/firefox.js';

let hasChromium = false, hasFirefox = false;
try { findBrowser(); hasChromium = true; } catch { /* skip */ }
try { findFirefox(); hasFirefox = true; } catch { /* skip */ }
const skip = (!hasChromium || !hasFirefox)
  && 'needs both a Chromium and a Firefox binary';

/**
 * Fixture pages exercising the AX cases most likely to drift between a native
 * CDP tree and the in-page reconstruction. Each is a body-innerHTML fragment.
 */
const FIXTURES = {
  // Accessible-name computation: img alt, <label> wrapping, aria-labelledby,
  // name-from-content (link/heading) — the four sources the manual pass broke on.
  'accessible names': `<main>
    <h1>Welcome</h1>
    <img src="x.png" alt="Company logo">
    <label>Email <input type="text"></label>
    <button aria-labelledby="l1"></button><span id="l1">Submit form</span>
    <a href="/next">Read more</a>
  </main>`,

  // Top-level landmarks with no <main> — CDP wraps body in ignored `none`
  // nodes; the reconstruction must emit that wrapper or these get dropped.
  'landmarks without main': `<nav aria-label="Primary"><a href="/a">Alpha</a></nav>
    <form aria-label="Search"><input aria-label="q" type="text"></form>
    <footer><a href="/about">About</a></footer>`,

  // aria-hidden subtree must be filtered on both engines (no leak).
  'aria-hidden filtered': `<main>
    <button>Visible</button>
    <div aria-hidden="true"><button>Hidden</button></div>
  </main>`,

  // A spread of interactive roles: list, combobox/select, checkbox, textbox.
  'interactive roles': `<main>
    <ul><li>One</li><li>Two</li></ul>
    <select aria-label="pick"><option>x</option><option>y</option></select>
    <input type="checkbox" aria-label="agree">
    <textarea aria-label="notes"></textarea>
  </main>`,

  // Open shadow root — the reconstruction must traverse it like getFullAXTree.
  'open shadow root': `<main><div id="h"></div>
    <script>h.attachShadow({mode:'open'}).innerHTML='<button>Shadow Btn</button><a href="/s">Shadow Link</a>'</script>
  </main>`,

  // Nested landmark + heading structure (document outline fidelity).
  'nested structure': `<main>
    <section aria-label="Intro"><h2>Intro</h2><p>hello</p></section>
    <section aria-label="Details"><h2>Details</h2>
      <button>Expand</button></section>
  </main>`,
};

const treeOnly = (s) =>
  s.split('\n').filter((l) => !l.startsWith('url:') && !/chars →/.test(l)).join('\n');

/**
 * Reduce a snapshot to its set of semantic `role "name"` lines: refs and all
 * `[prop]` brackets stripped, `StaticText`/`generic` echoes dropped, and name
 * whitespace collapsed. This is the engine-independent semantic skeleton.
 */
function semanticSet(snap) {
  const set = [];
  for (let line of treeOnly(snap).split('\n')) {
    line = line.replace(/\s*\[[^\]]*\]/g, '');   // strip [ref=N] + every [prop]
    line = line.replace(/^[\s-]+/, '').trim();   // strip indent + bullet
    if (!line) continue;
    const role = line.split(' ')[0];
    if (role === 'StaticText' || role === 'generic') continue;
    line = line.replace(/"([^"]*)"/, (_, n) => `"${n.replace(/\s+/g, ' ').trim()}"`);
    set.push(line);
  }
  return set;
}

/** Snapshot one fixture on one engine (browse mode = richest semantic tree). */
async function snapshotOn(engine, html) {
  const url = 'data:text/html,' + encodeURIComponent(html);
  const page = await connect(
    engine === 'firefox' ? { engine: 'firefox', mode: 'headless' } : { mode: 'headless' },
  );
  try {
    await page.goto(url);
    // Shadow DOM / srcdoc need a beat to attach before the tree is read.
    await new Promise((r) => setTimeout(r, 300));
    return await page.snapshot({ mode: 'browse' });
  } finally {
    await page.close();
  }
}

/** Multiset difference a \ b (keeps duplicates). */
function missingFrom(baseline, other) {
  const rest = [...other];
  const miss = [];
  for (const x of baseline) {
    const i = rest.indexOf(x);
    if (i === -1) miss.push(x);
    else rest.splice(i, 1);
  }
  return miss;
}

describe('AX fidelity — Firefox/BiDi reconstruction vs CDP baseline', { skip }, () => {
  for (const [name, html] of Object.entries(FIXTURES)) {
    it(`preserves every CDP semantic node: ${name}`, async () => {
      const cdpSnap = await snapshotOn('chromium', html);
      const ffSnap = await snapshotOn('firefox', html);
      const cdp = semanticSet(cdpSnap);
      const ff = semanticSet(ffSnap);

      const missing = missingFrom(cdp, ff);
      const extra = missingFrom(ff, cdp);

      assert.equal(
        missing.length, 0,
        `Firefox dropped ${missing.length} node(s) the CDP baseline found:\n` +
        `  MISSING: ${JSON.stringify(missing)}\n` +
        (extra.length ? `  (extra in FF, allowed: ${JSON.stringify(extra)})\n` : '') +
        `\n--- CDP tree ---\n${treeOnly(cdpSnap)}\n\n--- Firefox tree ---\n${treeOnly(ffSnap)}`,
      );
    });
  }
});
