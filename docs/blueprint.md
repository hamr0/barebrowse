# barebrowse — Blueprint

Vanilla JS library. CDP-direct. URL in, pruned ARIA snapshot out.
No Playwright, no bundled browser, no build step.

---

## What It Does

Gives autonomous agents authenticated access to the web through the user's own Chromium browser.

```js
import { browse, connect } from 'barebrowse';

// One-shot: read a page
const snapshot = await browse('https://any-page.com');

// Session: navigate, interact, observe
const page = await connect();
await page.goto('https://any-page.com');
console.log(await page.snapshot());
await page.click('8');      // ref from snapshot
await page.type('3', 'hello');
await page.scroll(500);
await page.close();
```

---

## Architecture

```
URL → chromium.js (find/launch browser)
    → cdp.js (WebSocket CDP client)
    → auth.js (extract cookies → inject via CDP)
    → Page.navigate
    → aria.js (Accessibility.getFullAXTree → nested tree)
    → prune.js (9-step role-based pruning)
    → interact.js (click/type/scroll via Input domain)
    → agent-ready snapshot
```

Seven modules, 1,400 lines, zero required dependencies.

| Module | Lines | Purpose |
|---|---|---|
| `src/index.js` | 250 | Public API: `browse()`, `connect()` |
| `src/cdp.js` | 148 | WebSocket CDP client, flattened sessions |
| `src/chromium.js` | 142 | Find/launch Chromium browsers |
| `src/aria.js` | 69 | Format ARIA tree as text |
| `src/auth.js` | 279 | Cookie extraction (Chromium AES + keyring, Firefox), CDP injection |
| `src/prune.js` | 472 | ARIA pruning pipeline (ported from mcprune) |
| `src/interact.js` | 120 | Click (scrollIntoView), type (clear), press (special keys), scroll |

---

## What's Built

### Headless mode — done
Spawn a fresh Chromium, navigate, snapshot, close. Default mode.
- Cookie extraction from user's Firefox or Chromium profile
- Cookie injection via `Network.setCookie` before navigation
- ARIA tree extraction via `Accessibility.getFullAXTree`
- 9-step pruning: landmarks, noise removal, wrapper collapsing, context filtering
- 47-95% token reduction depending on page complexity

### Headed mode — done
Connect to an already-running browser on a CDP debug port.
- Same ARIA + prune pipeline
- No cookie extraction needed (browser already has them)
- User must launch browser with `--remote-debugging-port=9222`

### Interactions — done, real-world tested
On `connect()` sessions: `click(ref)`, `type(ref, text, opts)`, `press(key)`, `scroll(deltaY)`, `waitForNavigation()`.
- Refs come from ARIA snapshot (`[ref=N]` markers)
- Click: `DOM.scrollIntoViewIfNeeded` → `DOM.getBoxModel` → center → `Input.dispatchMouseEvent`
- Type: `DOM.focus` + `Input.insertText` (fast) or `Input.dispatchKeyEvent` (triggers handlers)
- Type with `{ clear: true }`: select-all (Ctrl+A) + delete before typing
- Press: special keys (Enter, Tab, Escape, Backspace, arrows) with proper key/code/keyCode
- Scroll: `Input.dispatchMouseEvent` mouseWheel
- WaitForNavigation: `Page.loadEventFired` promise for post-click page loads

**Real-world tested against:** Google, Wikipedia, GitHub (SPA), Hacker News, DuckDuckGo, example.com

### Cross-browser cookie injection — done
Firefox cookies (user's default browser) extracted from SQLite → injected into headless Chromium via CDP `Network.setCookie`. No need to use Chromium as daily browser.

### Tests — 49+ passing
- 16 unit tests (pruning logic)
- 7 unit tests (cookie extraction)
- 5 unit tests (CDP client + browser launch)
- 11 integration tests (end-to-end browse pipeline)
- 10+ integration tests (real-world interactions: data: URL fixture + live sites)

---

## What's Not Built

### 1. Real-world interaction testing — DONE

Tested against Google, Wikipedia, GitHub (SPA), Hacker News, DuckDuckGo, example.com. Found and fixed:
- Off-screen elements needed `DOM.scrollIntoViewIfNeeded` before click
- Special keys (Enter/Tab) needed `text` field in keyDown for form submission
- Pre-filled inputs needed select-all + delete before typing (`{ clear: true }`)
- Post-click navigation needed `waitForNavigation()` (Page.loadEventFired)
- Google/Reddit block headless browsers — headed mode is the fix
- Cookie consent dialogs need locale-aware button matching

**Still untested (future rounds):**
- Shopping/checkout flows, dropdowns, file uploads
- iframes, Shadow DOM, Canvas/WebGL
- Infinite scroll, modals/dialogs
- Login form submission (needs headed mode manual test)

### 2. Hybrid mode

Try headless first. If CF-blocked or 403'd, fall back to headed automatically.

- Detection: check if navigated page is a challenge page (heuristic on ARIA tree)
- Fallback: connect to user's running browser, re-navigate
- One flag: `mode: 'hybrid'`
- ~30 lines in `chromium.js` + `index.js`

### 3. Stealth patches

Basic anti-detection for headless mode via `Runtime.evaluate`:
- Patch `navigator.webdriver`
- Spoof `navigator.plugins`
- Chrome object presence

Small `src/stealth.js` module. Not a priority — real cookies + headed fallback handles most cases.

### 4. Wait strategies — partially done

`waitForNavigation()` done (Page.loadEventFired). Still needed:
- Wait for network idle (no pending requests for N ms)
- Wait for element presence (poll ARIA tree for a ref/role)
- SPA-aware navigation (Page.frameNavigated for non-full-page-load transitions)

### 5. Screenshot capture

`Page.captureScreenshot` via CDP. Useful for:
- Visual verification (did the click land?)
- Multimodal agents that combine ARIA + vision
- Debugging interaction failures

---

## Ecosystem

```
bareagent  = the brain  (orchestration, LLM loop, memory, retries)
barebrowse = the eyes + hands  (browse, read, interact with the web)
```

**barebrowse is a library.** bareagent imports it as a capability — a plain function passed as a tool:

```js
import { Loop } from 'bare-agent';
import { browse, connect } from 'barebrowse';

const tools = [
  { name: 'browse', execute: ({ url }) => browse(url) },
  // connect-based tools for interactive sessions
];

const loop = new Loop({ provider });
await loop.run(messages, tools);
```

barebrowse doesn't know about bareagent. bareagent doesn't know about CDP. Clean boundary. Each ships and tests independently.

**MCP wrapper** (~30 lines, not built yet): expose `browse`, `click`, `type`, `scroll` as MCP tools. Replaces Playwright MCP + mcprune combo.

---

## Constraints

- **Chromium-only.** CDP protocol. Covers Chrome, Chromium, Edge, Brave, Vivaldi, Arc, Opera (~80% desktop share). Firefox later via WebDriver BiDi.
- **Linux first.** Tested on Fedora/KDE. macOS/Windows cookie extraction paths exist in auth.js but untested.
- **Node >= 22.** Built-in WebSocket, built-in SQLite.
- **Not a server.** Library that agents import. Wrap as MCP/HTTP if needed.
- **Not cross-platform tested.** Local development only, not published to npm.

---

## File Map

```
barebrowse/
├── src/
│   ├── index.js       # Public API: browse(), connect()
│   ├── cdp.js         # WebSocket CDP client
│   ├── chromium.js    # Find/launch Chromium
│   ├── aria.js        # ARIA tree formatting
│   ├── auth.js        # Cookie extraction + injection
│   ├── prune.js       # ARIA pruning (9-step pipeline)
│   └── interact.js    # Click, type, scroll
├── test/
│   ├── unit/          # prune, auth, cdp tests
│   └── integration/   # browse + interact tests (real sites)
├── examples/
│   └── headed-demo.js # Interactive demo with visible browser
├── docs/
│   ├── prd.md         # Decisions + rationale (reference)
│   ├── poc-plan.md    # Original POC phases + DoD
│   └── blueprint.md   # This file
├── package.json
└── CLAUDE.md
```
