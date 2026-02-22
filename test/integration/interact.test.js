/**
 * Integration tests for interaction primitives (click, type, press, scroll).
 * Uses data: URL fixtures for deterministic testing + real sites for validation.
 *
 * Run: node --test test/integration/interact.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../../src/index.js';

// --- Data URL fixtures ---

const FIXTURE = `data:text/html,${encodeURIComponent(`<!DOCTYPE html>
<html><head><style>
  .offscreen { margin-top: 2000px; }
</style></head>
<body>
  <button id="btn" onclick="document.getElementById('result').textContent='clicked'">Click Me</button>
  <div id="result"></div>

  <input id="text-input" type="text" aria-label="empty-input" value="" />
  <input id="prefilled" type="text" aria-label="prefilled-input" value="old text" />

  <a id="nav-link" href="data:text/html,<h1>Page Two</h1>">Go to page two</a>

  <button id="offscreen-btn" class="offscreen"
    onclick="document.getElementById('offscreen-result').textContent='scrolled-and-clicked'">
    Offscreen Button
  </button>
  <div id="offscreen-result" class="offscreen"></div>

  <form id="form" onsubmit="event.preventDefault(); document.getElementById('form-result').textContent='submitted'">
    <input id="form-input" type="text" aria-label="form-input" />
    <div id="form-result"></div>
  </form>
</body></html>`)}`;

/** Helper: evaluate JS in the page and return the result. */
async function evaluate(page, expression) {
  const { result } = await page.cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  return result.value;
}

/**
 * Find a ref by matching a pattern against the full snapshot text.
 * Uses regex to find [ref=X] near the search term, handling concatenated lines.
 * Matches role "name" [ref=X] pattern closest to the search term.
 */
function findRef(snapshot, search) {
  // Find all occurrences of the search term with a nearby ref
  // Pattern: something "...search..." [ref=X] or search... [ref=X]
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Look for ref right after a chunk containing the search term
  const re = new RegExp(`${escaped}[^\\[]*?\\[ref=([^\\]]+)\\]`);
  const m = snapshot.match(re);
  if (m) return m[1];
  // Fallback: look for ref just before the search term
  const re2 = new RegExp(`\\[ref=([^\\]]+)\\][^\\n]*?${escaped}`);
  const m2 = snapshot.match(re2);
  return m2 ? m2[1] : null;
}

/**
 * Find a ref for a specific role+name combo, e.g. findRoleRef(snap, 'button', 'Click Me').
 */
function findRoleRef(snapshot, role, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${role} "${escaped}" \\[ref=([^\\]]+)\\]`);
  const m = snapshot.match(re);
  return m ? m[1] : null;
}

/**
 * Find a ref for a textbox by its aria-label name.
 */
function findTextboxRef(snapshot, name) {
  return findRoleRef(snapshot, 'textbox', name);
}

// ===== Round 1: Controlled fixture (data: URL) =====

describe('interact — data: URL fixture', () => {
  it('click sets button result text', async () => {
    const page = await connect();
    try {
      await page.goto(FIXTURE);
      const snap = await page.snapshot();
      const ref = findRoleRef(snap, 'button', 'Click Me');
      assert.ok(ref, 'should find Click Me button ref');
      await page.click(ref);
      await new Promise(r => setTimeout(r, 100));
      const result = await evaluate(page, 'document.getElementById("result").textContent');
      assert.equal(result, 'clicked');
    } finally {
      await page.close();
    }
  });

  it('type fills an empty input', async () => {
    const page = await connect();
    try {
      await page.goto(FIXTURE);
      const snap = await page.snapshot();
      const ref = findTextboxRef(snap, 'empty-input');
      assert.ok(ref, 'should find empty-input textbox ref');
      await page.type(ref, 'hello world');
      const value = await evaluate(page, 'document.getElementById("text-input").value');
      assert.equal(value, 'hello world');
    } finally {
      await page.close();
    }
  });

  it('type with clear replaces existing text', async () => {
    const page = await connect();
    try {
      await page.goto(FIXTURE);
      const snap = await page.snapshot();
      const ref = findTextboxRef(snap, 'prefilled-input');
      assert.ok(ref, 'should find prefilled-input textbox ref');
      await page.type(ref, 'new text', { clear: true });
      const value = await evaluate(page, 'document.getElementById("prefilled").value');
      assert.equal(value, 'new text');
    } finally {
      await page.close();
    }
  });

  it('click on offscreen element scrolls into view first', async () => {
    const page = await connect();
    try {
      await page.goto(FIXTURE);
      const snap = await page.snapshot();
      const ref = findRoleRef(snap, 'button', 'Offscreen Button');
      assert.ok(ref, 'should find offscreen button ref');
      await page.click(ref);
      await new Promise(r => setTimeout(r, 100));
      const result = await evaluate(page, 'document.getElementById("offscreen-result").textContent');
      assert.equal(result, 'scrolled-and-clicked');
    } finally {
      await page.close();
    }
  });

  it('press Enter submits a form', async () => {
    const page = await connect();
    try {
      await page.goto(FIXTURE);
      const snap = await page.snapshot();
      const ref = findTextboxRef(snap, 'form-input');
      assert.ok(ref, 'should find form-input textbox ref');
      await page.type(ref, 'test');
      await page.press('Enter');
      await new Promise(r => setTimeout(r, 100));
      const result = await evaluate(page, 'document.getElementById("form-result").textContent');
      assert.equal(result, 'submitted');
    } finally {
      await page.close();
    }
  });

  it('press throws on unknown key', async () => {
    const page = await connect();
    try {
      await page.goto(FIXTURE);
      await assert.rejects(() => page.press('FakeKey'), /Unknown key/);
    } finally {
      await page.close();
    }
  });

  it('link click + waitForNavigation navigates to new page', async () => {
    // Use example.com with browse mode to get link refs (act mode prunes them)
    const page = await connect();
    try {
      await page.goto('https://example.com');
      const snap = await page.snapshot({ mode: 'browse' });
      const ref = findRoleRef(snap, 'link', 'Learn more');
      assert.ok(ref, 'should find "Learn more" link ref');
      const navPromise = page.waitForNavigation(10000);
      await page.click(ref);
      await navPromise;
      const snap2 = await page.snapshot({ mode: 'browse' });
      // IANA page has different content than example.com (e.g. "IANA" or navigation elements)
      assert.ok(snap2.length > 100, 'new page should have content');
      assert.ok(
        snap2.includes('IANA') || snap2.includes('iana') || !snap2.includes('This domain is for use'),
        'should have navigated to IANA page',
      );
    } finally {
      await page.close();
    }
  });
});

// ===== Round 2: Google Search =====

describe('interact — Google Search', () => {
  it('search and navigate results', async () => {
    const page = await connect();
    try {
      await page.goto('https://www.google.com');
      let snap = await page.snapshot();

      // Handle cookie consent dialog if present
      const acceptRef = findRoleRef(snap, 'button', 'Accept all')
        || findRoleRef(snap, 'button', 'Alles accepteren')
        || findRoleRef(snap, 'button', 'Tout accepter')
        || findRoleRef(snap, 'button', 'Alle akzeptieren');
      if (acceptRef) {
        await page.click(acceptRef);
        // Consent acceptance may reload the page
        await page.waitForNavigation(5000).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
        snap = await page.snapshot();
      }

      // Find the search box — could be combobox or textbox, various names
      let searchRef = null;
      const searchPattern = /(?:combobox|textbox).*?\[ref=([^\]]+)\]/g;
      let m;
      while ((m = searchPattern.exec(snap)) !== null) {
        searchRef = m[1];
        break;
      }
      assert.ok(searchRef, `should find search box ref. Snapshot start: ${snap.substring(0, 500)}`);

      await page.type(searchRef, 'barebrowse github');
      const navPromise = page.waitForNavigation(15000);
      await page.press('Enter');
      await navPromise;
      // Settle time for results to render
      await new Promise(r => setTimeout(r, 1000));

      snap = await page.snapshot();
      // Google may block headless browsers with captcha, but navigation should succeed
      assert.ok(snap.length > 0, 'should have navigated to results/captcha page');
    } finally {
      await page.close();
    }
  });
});

// ===== Round 3: Wikipedia =====

describe('interact — Wikipedia', () => {
  it('navigate article links', async () => {
    const page = await connect();
    try {
      await page.goto('https://en.wikipedia.org/wiki/Web_browser');
      let snap = await page.snapshot();
      assert.ok(snap.toLowerCase().includes('web browser'), 'should load Wikipedia article');

      // Find any article link to click
      let linkRef = null;
      const linkPattern = /link "[^"]*(?:software|internet|HTML|World Wide Web)[^"]*" \[ref=([^\]]+)\]/i;
      const lm = snap.match(linkPattern);
      if (lm) linkRef = lm[1];
      assert.ok(linkRef, 'should find an article link');

      const navPromise = page.waitForNavigation(10000);
      await page.click(linkRef);
      await navPromise;

      snap = await page.snapshot();
      assert.ok(snap.length > 100, 'new page should have content');
    } finally {
      await page.close();
    }
  });
});

// ===== Round 4: GitHub (SPA) =====

describe('interact — GitHub', () => {
  it('navigate SPA repo links', async () => {
    const page = await connect();
    try {
      await page.goto('https://github.com/anthropics');
      let snap = await page.snapshot();
      assert.ok(snap.toLowerCase().includes('anthropic'), 'should load GitHub org page');

      // Find a repo link — match link with repo-like names
      let repoRef = null;
      const repoPattern = /link "(?:claude|anthropic|sdk)[^"]*" \[ref=([^\]]+)\]/i;
      const rm = snap.match(repoPattern);
      if (rm) repoRef = rm[1];
      assert.ok(repoRef, 'should find a repo link');

      await page.click(repoRef);
      // GitHub SPAs may not fire loadEventFired; use settle time
      await new Promise(r => setTimeout(r, 3000));

      snap = await page.snapshot();
      assert.ok(snap.length > 100, 'repo page should have content');
    } finally {
      await page.close();
    }
  });
});
