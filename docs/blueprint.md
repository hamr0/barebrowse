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

## Capabilities

Every action returns a **pruned ARIA snapshot** — the agent's view of the page after each move. The snapshot is a YAML-like tree with `[ref=N]` markers on interactive elements. The agent reads the snapshot, picks a ref, acts, then reads the next snapshot. This is the observe→think→act loop.

### Actions

| Action | Method | What It Does | Status |
|--------|--------|-------------|--------|
| Navigate | `page.goto(url)` | Load a URL, wait for page load, dismiss consent | Done |
| Snapshot | `page.snapshot()` | Pruned ARIA tree (47-95% token reduction) | Done |
| Click | `page.click(ref)` | Scroll into view → mouse press+release at element center | Done |
| Type | `page.type(ref, text)` | Focus element → insert text (fast batch mode) | Done |
| Type (clear) | `page.type(ref, text, { clear: true })` | Select-all + delete → type (replaces pre-filled content) | Done |
| Type (key events) | `page.type(ref, text, { keyEvents: true })` | Char-by-char keyDown/keyUp (triggers JS handlers) | Done |
| Press | `page.press(key)` | Special key: Enter, Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/Down, Space | Done |
| Scroll | `page.scroll(deltaY)` | Mouse wheel event (positive=down, negative=up) | Done |
| Wait for nav | `page.waitForNavigation()` | Promise that resolves on `Page.loadEventFired` | Done |
| Inject cookies | `page.injectCookies(url, opts)` | Extract cookies from Firefox/Chromium → inject via CDP | Done |
| Raw CDP | `page.cdp.send(method, params)` | Escape hatch for any CDP command | Done |
| Close | `page.close()` | Close page target, disconnect CDP, kill browser (if headless) | Done |

### Obstacle course — what barebrowse handles automatically

| Obstacle | How It's Handled | Mode |
|----------|-----------------|------|
| **Cookie consent walls** (GDPR) | ARIA tree scan → jsClick accept button. 7 languages: EN, NL, DE, FR, ES, IT, PT | Both |
| **Consent in dialog role** | Detect `dialog`/`alertdialog` with consent hints → click accept inside | Both |
| **Consent outside dialog** (BBC SourcePoint) | Fallback global button scan when dialog has no accept button | Both |
| **Consent behind iframe overlay** | JS `.click()` via `DOM.resolveNode` bypasses z-index/overlay issues | Both |
| **Permission prompts** (location, notifications, camera, mic) | Launch flags + CDP `Browser.setPermission` → auto-denied | Both |
| **Media autoplay blocked** | `--autoplay-policy=no-user-gesture-required` | Both |
| **Login walls** | Firefox cookie extraction → CDP injection (user's real sessions) | Both |
| **Pre-filled form inputs** | `type({ clear: true })` → Ctrl+A + Backspace before typing | Both |
| **Off-screen elements** | `DOM.scrollIntoViewIfNeeded` before every click | Both |
| **Form submission** | `press('Enter')` with proper `text: '\r'` triggers onsubmit | Both |
| **Tab between fields** | `press('Tab')` with `text: '\t'` moves focus | Both |
| **SPA navigation** (YouTube, GitHub) | No `loadEventFired` — use timed waits or snapshot polling | Both |
| **Bot detection** (Google, Reddit) | Headed mode with real cookies bypasses most checks | Headed |
| **Profile locking** | Unique temp dir per headless instance (`/tmp/barebrowse-<pid>-<ts>`) | Headless |
| **ARIA noise** | 9-step pruning: wrapper collapse, noise removal, landmark promotion | Both |

### Not yet handled

| Obstacle | What's Needed | Difficulty |
|----------|--------------|------------|
| Dropdown/select elements | Arrow keys after focus, or click option directly | Low |
| File upload | `Input.setFiles` via CDP | Low |
| Drag and drop | `Input.dispatchDragEvent` sequence | Medium |
| Hover/tooltip | `Input.dispatchMouseEvent` type=mouseMoved | Low |
| Infinite scroll | Scroll + wait for new content strategy | Medium |
| CAPTCHAs | Cannot solve — headed mode lets user solve manually | N/A |
| Cross-origin iframes | Frame tree traversal via CDP | Medium |
| Canvas/WebGL | Opaque to ARIA — needs screenshot + vision model | Hard |

### Tested sites (16+ sites, 8 countries, all consent dismissed)

| Site | Consent | Cookies | Interactions | Notes |
|------|---------|---------|-------------|-------|
| google.com | NL dialog dismissed | Firefox injection | Search (combobox + Enter) | Bot-blocks headless |
| youtube.com | Bypassed via cookies | Firefox injection | Search + video playback | Full e2e demo, SPA nav |
| bbc.com | SourcePoint dismissed | — | — | Button outside dialog |
| wikipedia.org | — | — | Link click + navigation | Clean, no consent |
| github.com | — | — | SPA navigation | Needs settle time |
| duckduckgo.com | — | — | Search + results | Headless-friendly |
| news.ycombinator.com | — | — | Story link click | Clean, simple DOM |
| amazon.de | Banner dismissed | — | — | |
| theguardian.com | CMP dismissed | — | — | |
| spiegel.de | CMP dismissed | — | — | German |
| lemonde.fr | CMP dismissed | — | — | French |
| elpais.com | CMP dismissed | — | — | Spanish |
| corriere.it | CMP dismissed | — | — | Italian |
| nos.nl | CMP dismissed | — | — | Dutch |
| bild.de | CMP dismissed | — | — | German |
| nu.nl | CMP dismissed | — | — | Dutch |
| booking.com | Banner dismissed | — | — | |
| nytimes.com | — | — | — | No consent wall |
| stackoverflow.com | Footer link only | — | — | Not blocking |
| cnn.com | — | — | — | No consent wall |
| reddit.com | — | — | Fallback to old.reddit | Bot-blocks headless |

---

## Architecture

```
URL → chromium.js (find/launch browser, permission flags)
    → cdp.js (WebSocket CDP client)
    → Browser.setPermission (suppress prompts)
    → auth.js (extract cookies → inject via CDP)
    → Page.navigate
    → consent.js (detect + dismiss cookie dialogs)
    → aria.js (Accessibility.getFullAXTree → nested tree)
    → prune.js (9-step role-based pruning)
    → interact.js (click/type/scroll via Input domain)
    → agent-ready snapshot
```

Eight modules, ~1,600 lines, zero required dependencies.

| Module | Lines | Purpose |
|---|---|---|
| `src/index.js` | 280 | Public API: `browse()`, `connect()`, permission suppression |
| `src/cdp.js` | 148 | WebSocket CDP client, flattened sessions |
| `src/chromium.js` | 148 | Find/launch Chromium browsers, permission-suppressing flags |
| `src/aria.js` | 69 | Format ARIA tree as text |
| `src/auth.js` | 279 | Cookie extraction (Chromium AES + keyring, Firefox), CDP injection |
| `src/prune.js` | 472 | ARIA pruning pipeline (ported from mcprune) |
| `src/interact.js` | 120 | Click (scrollIntoView), type (clear), press (special keys), scroll |
| `src/consent.js` | 200 | Auto-dismiss cookie consent dialogs across languages |

---

## What's Built

### Headless mode — done
Spawn a fresh Chromium, navigate, snapshot, close. Default mode.
- Cookie extraction from user's Firefox or Chromium profile
- Cookie injection via `Network.setCookie` before navigation
- ARIA tree extraction via `Accessibility.getFullAXTree`
- 9-step pruning: landmarks, noise removal, wrapper collapsing, context filtering
- 47-95% token reduction depending on page complexity
- Permission prompts auto-suppressed (notifications, geolocation, camera, mic)

### Headed mode — done
Connect to an already-running browser on a CDP debug port.
- Same ARIA + prune pipeline
- Manual cookie injection via `page.injectCookies(url, { browser })` (e.g. inject Firefox cookies into headed Chromium)
- Permission prompts suppressed via CDP `Browser.setPermission`
- User must launch browser with `--remote-debugging-port=9222`

### Interactions — done, real-world tested
On `connect()` sessions: `click(ref)`, `type(ref, text, opts)`, `press(key)`, `scroll(deltaY)`, `waitForNavigation()`, `injectCookies(url, opts)`.
- Refs come from ARIA snapshot (`[ref=N]` markers)
- Click: `DOM.scrollIntoViewIfNeeded` → `DOM.getBoxModel` → center → `Input.dispatchMouseEvent`
- Type: `DOM.focus` + `Input.insertText` (fast) or `Input.dispatchKeyEvent` (triggers handlers)
- Type with `{ clear: true }`: select-all (Ctrl+A) + delete before typing
- Press: special keys (Enter, Tab, Escape, Backspace, arrows) with proper key/code/keyCode
- Scroll: `Input.dispatchMouseEvent` mouseWheel
- WaitForNavigation: `Page.loadEventFired` promise for post-click page loads

**Real-world tested against:** Google, Wikipedia, GitHub (SPA), Hacker News, DuckDuckGo, YouTube (search + video playback), example.com

### Cookie consent auto-dismiss — done
Automatically detects and dismisses GDPR/cookie consent dialogs after page load.
- Scans ARIA tree for `dialog`/`alertdialog` with consent-related content
- Falls back to global button scan for sites that don't use dialog roles (e.g. BBC SourcePoint)
- Uses JS `.click()` via `DOM.resolveNode` + `Runtime.callFunctionOn` to bypass iframe overlays
- Multi-language: EN, NL, DE, FR, ES, IT, PT button text patterns
- Opt-out via `{ consent: false }`
- Works in both headless and headed modes

**Tested against 16 sites across 8 countries, 0 consent dialogs remaining:**

| Site | Country | Consent Type | Result |
|------|---------|-------------|--------|
| google.com | NL | Native dialog ("Alles accepteren") | Dismissed |
| bbc.com | UK | SourcePoint CMP ("Yes, I agree") | Dismissed |
| youtube.com | NL | Google consent (with Firefox cookies) | Bypassed |
| nytimes.com | US | — | Clean |
| stackoverflow.com | US | Footer link only | Clean |
| amazon.de | DE | Cookie banner | Dismissed |
| theguardian.com | UK | CMP | Dismissed |
| twitch.tv | US | — | Clean |
| spotify.com | SE | Footer link only | Clean |
| booking.com | NL | Cookie banner | Dismissed |
| reuters.com | US | Footer link only | Clean |
| spiegel.de | DE | CMP | Dismissed |
| lemonde.fr | FR | CMP | Dismissed |
| elpais.com | ES | CMP | Dismissed |
| corriere.it | IT | CMP | Dismissed |
| nos.nl | NL | CMP | Dismissed |
| bild.de | DE | CMP | Dismissed |
| nu.nl | NL | CMP | Dismissed |
| cnn.com | US | — | Clean |

### Permission suppression — done
Chrome permission prompts (location, notifications, camera, mic, etc.) are suppressed automatically.
- Headless: launch flags (`--disable-notifications`, `--autoplay-policy=no-user-gesture-required`, `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, `--disable-features=MediaRouter`)
- Both modes: CDP `Browser.setPermission` denies geolocation, notifications, midi, audioCapture, videoCapture, sensors, idleDetection, etc.
- No user prompt ever appears — agents browse without interruption

### Cross-browser cookie injection — done
Firefox cookies (user's default browser) extracted from SQLite → injected into headless or headed Chromium via CDP `Network.setCookie`. No need to use Chromium as daily browser.
- `browse()`: auto-injects cookies before navigation (opt-out with `{ cookies: false }`)
- `connect()`: manual injection via `page.injectCookies(url, { browser: 'firefox' })`
- Proven: YouTube login session transferred from Firefox → headed Chromium → video playback

### Tests — 47+ passing
- 16 unit tests (pruning logic)
- 7 unit tests (cookie extraction — 2 fail when Chromium profile locked, pre-existing)
- 5 unit tests (CDP client + browser launch)
- 11 integration tests (end-to-end browse pipeline)
- 15 integration tests (real-world interactions: data: URL fixture + live sites)

---

## What's Not Built

### 1. Complex interactions — partially done

**Working:** click, type (with clear), press (14 special keys), scroll, form submission (Enter/Tab), link navigation, SPA navigation, search flows (Google, DuckDuckGo, YouTube).

**Not yet implemented:**
- Dropdown/select elements (need `DOM.focus` + arrow key or option click)
- File upload (`Input.setFiles` via CDP)
- Drag and drop (`Input.dispatchDragEvent`)
- Hover/tooltip interactions
- Multi-step login forms (works in principle, untested end-to-end)

**Not yet tested:**
- Shopping/checkout flows
- iframes (ARIA tree may not traverse into cross-origin iframes)
- Shadow DOM (CDP ARIA tree does traverse shadow roots)
- Infinite scroll (scroll works, but no "wait for new content" strategy)
- Canvas/WebGL (opaque to ARIA — needs screenshot + vision)

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
│   ├── index.js       # Public API: browse(), connect(), permission suppression
│   ├── cdp.js         # WebSocket CDP client
│   ├── chromium.js    # Find/launch Chromium, permission flags
│   ├── aria.js        # ARIA tree formatting
│   ├── auth.js        # Cookie extraction + injection
│   ├── prune.js       # ARIA pruning (9-step pipeline)
│   ├── interact.js    # Click, type, press, scroll
│   └── consent.js     # Auto-dismiss cookie consent dialogs
├── test/
│   ├── unit/          # prune, auth, cdp tests
│   └── integration/   # browse + interact tests (real sites)
├── examples/
│   ├── headed-demo.js # Interactive demo: Wikipedia → DuckDuckGo
│   └── yt-demo.js     # YouTube demo: Firefox cookies → search → play video
├── docs/
│   ├── prd.md         # Decisions + rationale (reference)
│   ├── poc-plan.md    # Original POC phases + DoD
│   └── blueprint.md   # This file
├── package.json
└── CLAUDE.md
```
