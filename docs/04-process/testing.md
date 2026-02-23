# barebrowse -- Testing Guide

## Run all tests

```bash
node --test test/unit/*.test.js test/integration/*.test.js
```

64 tests, 6 files, ~60s on a typical machine. No test framework -- uses Node's built-in `node:test` runner.

## Test pyramid

```
          /  E2E  \         15 tests — real websites (Google, Wikipedia, GitHub, etc.)
         /----------\
        / Integration \     21 tests — browse/connect pipeline + CLI session lifecycle
       /----------------\
      /      Unit        \  28 tests — pruning, cookie extraction, CDP client, browser launch
     /--------------------\
```

Unit tests are fast and isolated. Integration tests launch a real headless Chromium. E2E tests (part of interact.test.js) hit live websites — they require internet and may be slower or flaky on CI.

---

## Unit tests (28 tests)

### `test/unit/prune.test.js` -- 16 tests

Tests the 9-step ARIA pruning pipeline in isolation. No browser, no network.

| # | Test | What it validates |
|---|------|-------------------|
| 1 | returns null for empty tree | prune(null) returns null |
| 2 | unwraps RootWebArea | Root container node stripped from output |
| 3 | keeps interactive elements in act mode | Buttons, links, textboxes survive pruning |
| 4 | drops paragraphs in act mode | Non-interactive text removed in act mode |
| 5 | keeps paragraphs in browse mode | Text content preserved in browse/read mode |
| 6 | drops InlineTextBox noise | Low-level rendering nodes always filtered |
| 7 | keeps headings | h1/h2 headings preserved in browse mode |
| 8 | drops description headings in act mode | Only primary h1 kept, secondary headings removed |
| 9 | collapses unnamed structural wrappers | Nested generic divs flattened, children promoted |
| 10 | keeps named groups | Radiogroup/radio elements preserved |
| 11 | drops separators | Separator/hr nodes always removed |
| 12 | drops images in act mode, keeps named in browse | Act strips all images, browse keeps named ones |
| 13 | trims combobox to just name + selected value | Combobox children (options list) stripped |
| 14 | uses context keywords to condense non-matching cards | Context filtering collapses irrelevant list items |
| 15 | extracts main landmark when present | Act mode keeps only main content area |
| 16 | handles pages without landmarks (HN-style) | Pruning works on flat, landmark-less pages |

### `test/unit/auth.test.js` -- 7 tests

Tests cookie extraction from the local filesystem. Reads real browser cookie databases.

| # | Test | What it validates |
|---|------|-------------------|
| 1 | auto-detects a browser and returns cookies | extractCookies() finds Firefox or Chromium and returns array |
| 2 | returns cookies with correct shape | Each cookie has name, value, domain, path, secure, httpOnly, sameSite, expires |
| 3 | filters by domain | Domain filter parameter restricts results |
| 4 | extracts from firefox explicitly | `{ browser: 'firefox' }` parameter works |
| 5 | throws for non-existent browser | Error thrown for unknown browser string |
| 6 | cookies have non-empty values | All returned cookies have non-empty value strings |
| 7 | sameSite is a valid value | sameSite is one of 'None', 'Lax', or 'Strict' |

Note: 2 tests may skip when Chromium profile is locked by a running instance (AES decryption needs keyring access).

### `test/unit/cdp.test.js` -- 5 tests

Tests browser discovery, launch, CDP WebSocket client, and session handling.

| # | Test | What it validates |
|---|------|-------------------|
| 1 | finds a Chromium-based browser | findBrowser() returns path to chromium/chrome/brave/edge |
| 2 | launches headless Chromium and returns WebSocket URL | launch() returns valid ws:// URL, port, and live process |
| 3 | connects to browser and sends commands | createCDP() connects, Browser.getVersion responds |
| 4 | creates session-scoped handles | Target.createTarget + session() dispatches to correct target |
| 5 | gets accessibility tree from a page | Accessibility.getFullAXTree returns nodes with role/name |

---

## Integration tests (11 tests)

### `test/integration/browse.test.js` -- 11 tests

Tests the full `browse()` and `connect()` pipeline end-to-end against real pages.

| # | Suite | Test | What it validates |
|---|-------|------|-------------------|
| 1 | browse() | returns ARIA snapshot for a public page | browse('example.com') returns non-empty snapshot with title |
| 2 | browse() | includes heading and ref markers | Snapshot contains roles and [ref=N] markers |
| 3 | browse() | prunes by default (act mode) | Pruned output smaller than raw ARIA tree |
| 4 | browse() | browse mode preserves paragraphs | pruneMode: 'browse' keeps text content |
| 5 | browse() | act mode drops paragraphs | pruneMode: 'act' removes non-interactive text |
| 6 | browse() | handles complex pages with significant reduction | Hacker News pruned by at least 20% |
| 7 | browse() | can disable cookies | cookies: false works without error |
| 8 | browse() | can disable pruning | prune: false keeps raw RootWebArea |
| 9 | connect() | creates a long-lived session and navigates | connect() + goto() + snapshot() works |
| 10 | connect() | supports multiple navigations in one session | Multiple goto() calls on same page |
| 11 | connect() | snapshot accepts prune: false for raw output | snapshot(false) preserves full tree |

### `test/integration/cli.test.js` -- 10 tests

Tests the full CLI session lifecycle: daemon spawn, command dispatch over HTTP, and cleanup. Uses a temp directory so tests don't pollute the project.

| # | Test | What it validates |
|---|------|-------------------|
| 1 | open starts a daemon and creates session.json | `barebrowse open about:blank` spawns daemon, writes session.json with port+pid |
| 2 | status shows running session | `barebrowse status` reports pid, port, start time |
| 3 | snapshot creates a .yml file | `barebrowse snapshot` writes .barebrowse/page-*.yml |
| 4 | goto navigates and snapshot shows new page content | `barebrowse goto example.com` + snapshot contains "Example Domain" + refs |
| 5 | click sends click command | `barebrowse click <ref>` returns "ok" |
| 6 | eval executes JS and returns result | `barebrowse eval 1+1` returns "2" |
| 7 | console-logs creates a .json file | After eval with console.log, `console-logs` writes JSON |
| 8 | network-log creates a .json file | `network-log` writes JSON with request entries |
| 9 | close shuts down the daemon | `barebrowse close` removes session.json, daemon exits |
| 10 | status after close shows no session | `barebrowse status` exits non-zero when no session |

Note: Tests run sequentially within the suite (each depends on the session opened in test 1). The `after()` hook ensures daemon cleanup even if tests fail.

---

## E2E tests (15 tests)

### `test/integration/interact.test.js` -- 15 tests

Tests real interactions: clicking, typing, scrolling, form submission, and navigation. Uses a local `data:` URL fixture for deterministic tests, plus live websites for real-world coverage.

#### Data URL fixture tests (7 tests)

| # | Test | What it validates |
|---|------|-------------------|
| 1 | click sets button result text | page.click(ref) triggers onclick handler |
| 2 | type fills an empty input | page.type(ref, text) fills empty textbox |
| 3 | type with clear replaces existing text | { clear: true } replaces prefilled input |
| 4 | click on offscreen element scrolls into view first | Auto-scroll before click on element at 3000px |
| 5 | press Enter submits a form | page.press('Enter') triggers form onsubmit |
| 6 | press throws on unknown key | Error thrown for unrecognized key names |
| 7 | link click + waitForNavigation navigates | Cross-page navigation via click + waitForNavigation |

#### Live website tests (8 tests)

| # | Site | Test | What it validates |
|---|------|------|-------------------|
| 1 | Google | search and navigate results | type() + press('Enter') + waitForNavigation() on Google |
| 2 | Wikipedia | navigate article links | click() + waitForNavigation() on Wikipedia article links |
| 3 | GitHub | navigate SPA repo links | click() works for SPA navigation (no loadEventFired) |
| 4 | DuckDuckGo | search query and verify results | type() + press('Enter') + navigation on DDG |
| 5 | Hacker News | load homepage and navigate to a story | click() + waitForNavigation() on HN story links |
| 6 | Reddit (old) | load and navigate to a post | Page navigation with fallback to www.reddit.com |
| 7 | Firefox cookies | extract and inject into CDP session | extractCookies() + injectCookies() workflow |
| 8 | Firefox cookies | extractCookies with firefox returns array | Explicit browser parameter returns proper array |

---

## Manual validation (v0.4.0 features)

Features added in v0.4.0 are manually validated but not yet in the automated test suite. See `docs/03-logs/validation-log.md` for full results.

| Feature | Validation method | Result |
|---------|-------------------|--------|
| `back` / `forward` | example.com → wikipedia → back → forward | ok |
| `upload <ref> <files..>` | data: URL with file input, verified onchange fired | ok |
| `pdf` | Wikipedia export, 200KB PDF | ok |
| `tabs` | Listed 2 tabs with urls/titles | ok |
| `wait-for --text` | Found "Wikipedia" text | ok |
| `wait-for --selector` | Found `body` selector | ok |
| `dialog-log` | alert() auto-dismissed, 1 entry logged | ok |
| `save-state` | 2.8KB cookies + localStorage JSON | ok |
| `--viewport=WxH` | 800x600, confirmed via innerWidth/innerHeight | ok |
| `drag` | Wired through all layers, needs drag UI to visually test |
| `--proxy` | Wired to Chromium launch arg, needs proxy to test |
| `--storage-state` | Wired to Network.setCookies, loads from save-state output |

---

## Writing new tests

Follow the existing pattern:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../../src/index.js';

describe('my feature', () => {
  it('does the thing', async () => {
    const page = await connect();
    try {
      await page.goto('https://example.com');
      const snap = await page.snapshot();
      assert.ok(snap.includes('Example Domain'));
    } finally {
      await page.close();
    }
  });
});
```

Key conventions:
- Always `page.close()` in a `finally` block to avoid leaked browser processes
- Use `data:` URL fixtures for deterministic tests (no network dependency)
- Real-site tests go in interact.test.js, grouped by site in `describe()` blocks
- Use `assert.ok()` and `assert.strictEqual()` from `node:assert/strict`
- No test framework dependencies -- `node:test` only

### Data URL fixture pattern

For testing interactions without network:

```javascript
const FIXTURE = `data:text/html,${encodeURIComponent(`
<html><body>
  <button onclick="document.getElementById('r').textContent='clicked'">Click Me</button>
  <div id="r"></div>
</body></html>
`)}`;

it('clicks the button', async () => {
  const page = await connect();
  try {
    await page.goto(FIXTURE);
    const snap = await page.snapshot({ mode: 'browse' });
    const ref = findRef(snap, 'button', 'Click Me');
    await page.click(ref);
    const snap2 = await page.snapshot({ mode: 'browse' });
    assert.ok(snap2.includes('clicked'));
  } finally {
    await page.close();
  }
});
```

---

## CI considerations

- Unit tests: fast, no network, always safe to run
- Integration tests: need Chromium installed, no network (uses example.com/HN but tolerates failures)
- E2E tests: need internet, may be flaky (sites change, rate limits, geo-blocks)
- Recommended CI split: run unit + integration always, E2E on manual trigger or nightly
- Each test launches/kills its own browser instance -- no shared state between tests
- Auth tests may skip when Chromium profile is locked by a running instance
