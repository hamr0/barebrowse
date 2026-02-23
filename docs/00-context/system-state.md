# barebrowse -- Blueprint

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

Every action returns a **pruned ARIA snapshot** -- the agent's view of the page after each move. The snapshot is a YAML-like tree with `[ref=N]` markers on interactive elements. The agent reads the snapshot, picks a ref, acts, then reads the next snapshot. This is the observe-think-act loop.

### Actions

| Action | Method | What It Does | Status |
|--------|--------|-------------|--------|
| Navigate | `page.goto(url)` | Load a URL, wait for page load, dismiss consent | Done |
| Snapshot | `page.snapshot()` | Pruned ARIA tree (47-95% token reduction) | Done |
| Click | `page.click(ref)` | Scroll into view, mouse press+release at element center | Done |
| Type | `page.type(ref, text)` | Focus element, insert text (fast batch mode) | Done |
| Type (clear) | `page.type(ref, text, { clear: true })` | Select-all + delete, then type (replaces pre-filled content) | Done |
| Type (key events) | `page.type(ref, text, { keyEvents: true })` | Char-by-char keyDown/keyUp (triggers JS handlers) | Done |
| Press | `page.press(key)` | Special key: Enter, Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/Down, Space | Done |
| Scroll | `page.scroll(deltaY)` | Mouse wheel event (positive=down, negative=up) | Done |
| Hover | `page.hover(ref)` | Move mouse to element center (triggers hover styles/tooltips) | Done |
| Select | `page.select(ref, value)` | Set `<select>` value or click custom dropdown option | Done |
| Screenshot | `page.screenshot(opts)` | `Page.captureScreenshot`, returns base64 string | Done |
| Wait for nav | `page.waitForNavigation()` | Promise.race of loadEventFired + frameNavigated (SPA-aware) | Done |
| Wait for idle | `page.waitForNetworkIdle(opts)` | Resolve when no pending requests for N ms (default 500) | Done |
| Wait for content | `page.waitFor({ text, selector })` | Poll for text or CSS selector to appear on page | Done |
| Back / Forward | `page.goBack()` / `page.goForward()` | Browser history navigation via `Page.getNavigationHistory` | Done |
| Drag | `page.drag(fromRef, toRef)` | Mouse down on source, move to target, release | Done |
| Upload | `page.upload(ref, files)` | Set files on file input via `DOM.setFileInputFiles` | Done |
| PDF | `page.pdf(opts)` | Export page as PDF via `Page.printToPDF` | Done |
| Tabs | `page.tabs()` / `page.switchTab(index)` | List and switch between browser tabs | Done |
| Dialog handling | Auto | JS alert/confirm/prompt auto-dismissed, logged to `page.dialogLog` | Done |
| Save state | `page.saveState(filePath)` | Export cookies + localStorage to JSON for later `--storage-state` | Done |
| Inject cookies | `page.injectCookies(url, opts)` | Extract cookies from Firefox/Chromium, inject via CDP | Done |
| Raw CDP | `page.cdp.send(method, params)` | Escape hatch for any CDP command | Done |
| Close | `page.close()` | Close page target, disconnect CDP, kill browser (if headless) | Done |

### Obstacle course -- what barebrowse handles automatically

| Obstacle | How It's Handled | Mode |
|----------|-----------------|------|
| **Cookie consent walls** | ARIA tree scan, jsClick accept button. 29 languages | Both |
| **Consent in dialog role** | Detect `dialog`/`alertdialog` with consent hints, click accept inside | Both |
| **Consent outside dialog** (BBC SourcePoint) | Fallback global button scan when dialog has no accept button | Both |
| **Consent behind iframe overlay** | JS `.click()` via `DOM.resolveNode` bypasses z-index/overlay issues | Both |
| **Permission prompts** (location, notifications, camera, mic) | Launch flags + CDP `Browser.setPermission` auto-deny | Both |
| **Media autoplay blocked** | `--autoplay-policy=no-user-gesture-required` | Both |
| **Login walls** | All-browser cookie merge (Firefox + Chromium), CDP injection (user's real sessions) | Both |
| **Pre-filled form inputs** | `type({ clear: true })` selects all + deletes before typing | Both |
| **Off-screen elements** | `DOM.scrollIntoViewIfNeeded` before every click | Both |
| **Form submission** | `press('Enter')` with proper `text: '\r'` triggers onsubmit | Both |
| **Tab between fields** | `press('Tab')` with `text: '\t'` moves focus | Both |
| **SPA navigation** (YouTube, GitHub) | `waitForNavigation()` uses frameNavigated + loadEventFired race | Both |
| **Bot detection** (Google, Reddit) | Stealth patches (headless) + headed mode with real cookies | Both |
| **`navigator.webdriver`** | Stealth patches: webdriver, plugins, languages, chrome object | Headless |
| **JS dialogs** (alert/confirm/prompt) | Auto-dismiss via `Page.handleJavaScriptDialog`, logged to `dialogLog` | Both |
| **Profile locking** | Unique temp dir per headless instance (`/tmp/barebrowse-<pid>-<ts>`) | Headless |
| **ARIA noise** | 9-step pruning: wrapper collapse, noise removal, landmark promotion | Both |

### Not yet handled

| Obstacle | What's Needed | Difficulty |
|----------|--------------|------------|
| Infinite scroll | Scroll + wait for new content strategy | Medium |
| CAPTCHAs | Cannot solve -- headed mode lets user solve manually | N/A |
| Cross-origin iframes | Frame tree traversal via CDP | Medium |
| Canvas/WebGL | Opaque to ARIA -- needs screenshot + vision model | Hard |

### Tested sites (16+ sites, 8 countries, all consent dismissed)

| Site | Consent | Cookies | Interactions | Notes |
|------|---------|---------|-------------|-------|
| google.com | NL dialog dismissed | Firefox injection | Search (combobox + Enter) | Bot-blocks headless |
| youtube.com | Bypassed via cookies | Firefox injection | Search + video playback | Full e2e demo, SPA nav |
| bbc.com | SourcePoint dismissed | -- | -- | Button outside dialog |
| wikipedia.org | -- | -- | Link click + navigation | Clean, no consent |
| github.com | -- | -- | SPA navigation | Needs settle time |
| duckduckgo.com | -- | -- | Search + results | Headless-friendly |
| news.ycombinator.com | -- | -- | Story link click | Clean, simple DOM |
| amazon.de | Banner dismissed | -- | -- | |
| theguardian.com | CMP dismissed | -- | -- | |
| spiegel.de | CMP dismissed | -- | -- | German |
| lemonde.fr | CMP dismissed | -- | -- | French |
| elpais.com | CMP dismissed | -- | -- | Spanish |
| corriere.it | CMP dismissed | -- | -- | Italian |
| nos.nl | CMP dismissed | -- | -- | Dutch |
| bild.de | CMP dismissed | -- | -- | German |
| nu.nl | CMP dismissed | -- | -- | Dutch |
| booking.com | Banner dismissed | -- | -- | |
| nytimes.com | -- | -- | -- | No consent wall |
| stackoverflow.com | Footer link only | -- | -- | Not blocking |
| cnn.com | -- | -- | -- | No consent wall |
| reddit.com | -- | -- | Fallback to old.reddit | Bot-blocks headless |

---

## Architecture

### Full pipeline: browse(url) or connect() -> goto(url)

```
1. LAUNCH            chromium.js finds installed browser
                     Headless: spawn fresh Chromium with permission flags
                     Headed: connect to running browser on CDP port
                     Hybrid: try headless, detect challenge page, fallback to headed

2. CDP CONNECTION    cdp.js opens WebSocket to browser
                     Creates page target, attaches flattened session
                     Enables Page, Network, DOM domains

3. STEALTH           stealth.js (headless only)
                     Page.addScriptToEvaluateOnNewDocument before any page scripts
                     Patches: navigator.webdriver, plugins, languages, chrome object

4. PERMISSIONS       Browser.setPermission denies all prompts
                     geo, notifications, camera, mic, midi, sensors, idle

5. AUTH              auth.js extracts cookies from user's browser
                     Firefox: SQLite cookies.sqlite (plaintext)
                     Chromium: SQLite Cookies + AES decrypt via keyring
                     Injects via Network.setCookie before navigation

6. NAVIGATE          Page.navigate(url), wait for Page.loadEventFired
                     500ms settle for dynamic content

7. CONSENT           consent.js scans ARIA tree post-load
                     Finds dialog/alertdialog with consent hints
                     Falls back to global button scan (BBC SourcePoint pattern)
                     jsClick via DOM.resolveNode (bypasses iframe overlays)

8. SNAPSHOT          Accessibility.getFullAXTree -> nested tree (aria.js)
                     prune.js: 9-step pipeline (47-95% token reduction)
                     Output: URL + pruning stats + YAML-like text with [ref=N] markers

9. INTERACT          interact.js dispatches real CDP Input events
                     click: scrollIntoView -> getBoxModel -> mousePressed/Released
                     type: DOM.focus -> insertText or keyDown/keyUp per char
                     press: special keys (Enter, Tab, Escape, arrows, etc.)
                     scroll: mouseWheel events
                     hover: mouseMoved at element center
                     select: set <select> value or click custom dropdown option

10. OBSERVE AGAIN    Back to step 8. Refs are ephemeral -- fresh snapshot needed.
```

### Module table

Thirteen modules, zero required dependencies.

| Module | Lines | Purpose |
|---|---|---|
| `src/index.js` | 434 | Public API: `browse()`, `connect()`, screenshot, network idle, hybrid |
| `src/cdp.js` | 148 | WebSocket CDP client, flattened sessions |
| `src/chromium.js` | 148 | Find/launch Chromium browsers, permission-suppressing flags |
| `src/aria.js` | 69 | Format ARIA tree as YAML-like text |
| `src/auth.js` | 279 | Cookie extraction (Chromium AES + keyring, Firefox), CDP injection |
| `src/prune.js` | 472 | ARIA pruning pipeline (9-step, ported from mcprune) |
| `src/interact.js` | 208 | Click, type, press, scroll, hover, select |
| `src/consent.js` | ~280 | Auto-dismiss cookie consent dialogs, 29 languages |
| `src/stealth.js` | 51 | Navigator patches for headless anti-detection |
| `src/bareagent.js` | 161 | Tool adapter for bareagent Loop |
| `src/daemon.js` | ~230 | Background HTTP server holding connect() session for CLI mode |
| `src/session-client.js` | ~60 | HTTP client to daemon (sendCommand, readSession, isAlive) |
| `mcp-server.js` | 216 | MCP server (JSON-RPC 2.0 over stdio) |

---

## What's Built

### Headless mode -- done
Spawn a fresh Chromium, navigate, snapshot, close. Default mode.
- Cookie extraction from user's Firefox or Chromium profile
- Cookie injection via `Network.setCookie` before navigation
- ARIA tree extraction via `Accessibility.getFullAXTree`
- 9-step pruning: landmarks, noise removal, wrapper collapsing, context filtering
- 47-95% token reduction depending on page complexity
- Permission prompts auto-suppressed (notifications, geolocation, camera, mic)
- Stealth patches: `navigator.webdriver`, plugins, languages, chrome object

### Headed mode -- done
Connect to an already-running browser on a CDP debug port.
- Same ARIA + prune pipeline
- Manual cookie injection via `page.injectCookies(url, { browser })` (e.g. inject Firefox cookies into headed Chromium)
- Permission prompts suppressed via CDP `Browser.setPermission`
- User must launch browser with `--remote-debugging-port=9222`

### Hybrid mode -- done
Try headless first. If bot-blocked (Cloudflare, etc.), fall back to headed automatically.
- Detection: heuristic on ARIA tree for challenge phrases ("Just a moment", "Checking your browser")
- Fallback: kill headless, connect to user's running browser on port 9222, re-navigate
- One flag: `mode: 'hybrid'`

### Interactions -- done, real-world tested
On `connect()` sessions: `click(ref)`, `type(ref, text, opts)`, `press(key)`, `scroll(deltaY)`, `hover(ref)`, `select(ref, value)`, `screenshot()`, `waitForNavigation()`, `waitForNetworkIdle()`, `injectCookies(url, opts)`.
- Refs come from ARIA snapshot (`[ref=N]` markers)
- Click: `DOM.scrollIntoViewIfNeeded` -> `DOM.getBoxModel` -> center -> `Input.dispatchMouseEvent`
- Type: `DOM.focus` + `Input.insertText` (fast) or `Input.dispatchKeyEvent` (triggers handlers)
- Type with `{ clear: true }`: select-all (Ctrl+A) + delete before typing
- Press: special keys (Enter, Tab, Escape, Backspace, arrows) with proper key/code/keyCode
- Scroll: `Input.dispatchMouseEvent` mouseWheel
- Hover: `DOM.scrollIntoViewIfNeeded` -> `Input.dispatchMouseEvent` mouseMoved
- Select: native `<select>` (set value + change event) or custom dropdown (click + find option)
- Screenshot: `Page.captureScreenshot` -> base64 string (png/jpeg/webp)
- WaitForNavigation: `Promise.race` of `Page.loadEventFired` + `Page.frameNavigated` (SPA-aware)
- WaitForNetworkIdle: track pending requests, resolve when 0 for N ms

**Real-world tested against:** Google, Wikipedia, GitHub (SPA), Hacker News, DuckDuckGo, YouTube (search + video playback), example.com

### Cookie consent auto-dismiss -- done
Automatically detects and dismisses cookie consent dialogs after page load.
- Scans ARIA tree for `dialog`/`alertdialog` with consent-related content
- Falls back to global button scan for sites that don't use dialog roles (e.g. BBC SourcePoint)
- Uses JS `.click()` via `DOM.resolveNode` + `Runtime.callFunctionOn` to bypass iframe overlays
- 29 languages: EN, NL, DE, FR, ES, IT, PT, RU, UK, PL, CS, TR, RO, HU, EL, SV, DA, NO, FI, AR, FA, ZH, JA, KO, VI, TH, HI, ID/MS
- Opt-out via `{ consent: false }`
- Works in both headless and headed modes

**Tested against 16+ sites across 8 countries, 0 consent dialogs remaining.**

### Permission suppression -- done
Chrome permission prompts (location, notifications, camera, mic, etc.) are suppressed automatically.
- Headless: launch flags (`--disable-notifications`, `--autoplay-policy=no-user-gesture-required`, `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, `--disable-features=MediaRouter`)
- Both modes: CDP `Browser.setPermission` denies geolocation, notifications, midi, audioCapture, videoCapture, sensors, idleDetection, etc.
- No user prompt ever appears -- agents browse without interruption

### Cross-browser cookie injection -- done
Auto mode merges cookies from all detected browsers (Chromium + Firefox, last-write-wins by name+domain). No need to use Chromium as daily browser.
- `browse()`: auto-injects merged cookies before navigation (opt-out with `{ cookies: false }`)
- `connect()`: manual injection via `page.injectCookies(url, { browser: 'firefox' })`
- MCP `goto`: auto-injects cookies before every navigation
- Proven: YouTube login session transferred from Firefox -> headed Chromium -> video playback

### Stealth patches -- done
Anti-detection for headless mode via `Page.addScriptToEvaluateOnNewDocument` (runs before page scripts).
- `navigator.webdriver` -> undefined
- `navigator.plugins` -> fake 3 plugins
- `navigator.languages` -> `['en-US', 'en']`
- `window.chrome` -> fake object
- `Permissions.prototype.query` -> notifications return 'prompt'
- Applied automatically in headless mode

### Tests -- 64 passing
- 16 unit tests (pruning logic)
- 7 unit tests (cookie extraction -- 2 skip when Chromium profile locked)
- 5 unit tests (CDP client + browser launch)
- 11 integration tests (end-to-end browse pipeline)
- 10 integration tests (CLI session lifecycle: open/snapshot/goto/click/eval/console/network/close)
- 15 integration tests (real-world interactions: data: URL fixture + live sites)

---

## Integrations

### bareagent -- tool adapter

`createBrowseTools(opts)` returns bareagent-compatible tools for the Loop:

```js
import { Loop } from 'bare-agent';
import { Anthropic } from 'bare-agent/providers';
import { createBrowseTools } from 'barebrowse/src/bareagent.js';

const { tools, close } = createBrowseTools();
const loop = new Loop({ provider: new Anthropic({ apiKey }) });
const result = await loop.run(messages, tools);
await close();
```

13 tools: browse, goto, snapshot, click, type, press, scroll, select, back, forward, drag, upload, screenshot.
Action tools auto-return snapshot (300ms settle delay). The LLM always sees the result.

### MCP server

Raw JSON-RPC 2.0 over stdio. Zero SDK dependencies. `npm install barebrowse` then:

```json
{
  "mcpServers": {
    "barebrowse": {
      "command": "npx",
      "args": ["barebrowse", "mcp"]
    }
  }
}
```

12 tools: browse (one-shot), goto, snapshot, click, type, press, scroll, back, forward, drag, upload, pdf.
Action tools return `'ok'` -- agent calls `snapshot` explicitly (MCP tool calls are cheap to chain).
`browse` and `snapshot` accept `maxChars` (default 30000) — large snapshots are saved to `.barebrowse/` and a file path is returned.
Session runs in hybrid mode (headless + automatic headed fallback on bot detection). `goto` injects cookies from the user's browser before navigation.
Session tools share a singleton page, lazy-created on first use.

### CLI session -- for coding agents + human devs

Shell commands that output to disk. Coding agents (Claude Code, Copilot, Cursor) read output files with their file tools -- no tokens wasted in tool responses.

```bash
barebrowse open https://example.com    # Start daemon + navigate
barebrowse snapshot                    # → .barebrowse/page-*.yml
barebrowse click 8                     # Click element
barebrowse console-logs                # → .barebrowse/console-*.json
barebrowse close                       # Kill daemon + browser
```

Architecture: `open` spawns a detached child process running an HTTP server on a random localhost port. Session state stored in `.barebrowse/session.json`. Subsequent commands POST to the daemon. `close` sends shutdown, daemon calls `page.close()` + `process.exit(0)`.

Full commands: open, close, status, goto, back, forward, snapshot, screenshot, pdf, click, type, fill, press, scroll, hover, select, drag, upload, tabs, tab, eval, wait-idle, wait-for, console-logs, network-log, dialog-log, save-state.

Self-sufficiency features (console/network capture, eval) let agents debug without guessing -- they see JS errors and failed requests directly.

SKILL.md (`commands/barebrowse/SKILL.md`) teaches Claude Code the CLI commands. Install with `barebrowse install --skill`.

---

## Ecosystem

```
bareagent  = the brain  (orchestration, LLM loop, memory, retries)
barebrowse = the eyes + hands  (browse, read, interact with the web)
```

**barebrowse is a library.** bareagent imports it as a capability. barebrowse doesn't know about bareagent. bareagent doesn't know about CDP. Clean boundary. Each ships and tests independently.

---

## Constraints

- **Chromium-only.** CDP protocol. Covers Chrome, Chromium, Edge, Brave, Vivaldi, Arc, Opera (~80% desktop share). Firefox later via WebDriver BiDi.
- **Linux first.** Tested on Fedora/KDE. macOS/Windows cookie extraction paths exist in auth.js but untested.
- **Node >= 22.** Built-in WebSocket, built-in SQLite.
- **Not a server.** Library that agents import. Wrap as MCP (included) or HTTP if needed.
- **Not cross-platform tested.** Tested on Linux only. Published to npm as `barebrowse`.

---

## File Map

```
barebrowse/
├── src/
│   ├── index.js       # Public API: browse(), connect(), screenshot, network idle, hybrid
│   ├── cdp.js         # WebSocket CDP client
│   ├── chromium.js    # Find/launch Chromium, permission flags
│   ├── aria.js        # ARIA tree formatting
│   ├── auth.js        # Cookie extraction + injection
│   ├── prune.js       # ARIA pruning (9-step pipeline)
│   ├── interact.js    # Click, type, press, scroll, hover, select
│   ├── consent.js     # Auto-dismiss cookie consent dialogs
│   ├── stealth.js     # Navigator patches for headless anti-detection
│   ├── bareagent.js   # Tool adapter for bareagent Loop
│   ├── daemon.js      # Background HTTP server for CLI session
│   └── session-client.js  # HTTP client to daemon
├── test/
│   ├── unit/          # prune, auth, cdp tests
│   └── integration/   # browse, interact, cli tests
├── examples/
│   ├── headed-demo.js # Interactive demo: Wikipedia → DuckDuckGo
│   └── yt-demo.js     # YouTube demo: Firefox cookies → search → play video
├── docs/
│   ├── README.md             # Documentation navigation guide
│   ├── 00-context/           # vision, assumptions, system-state (this file)
│   ├── 01-product/           # prd.md
│   ├── 03-logs/              # decisions, implementation, bugs, validation, insights
│   ├── 04-process/           # dev-workflow, definition-of-done, testing (64 tests)
│   └── archive/              # poc-plan.md
├── mcp-server.js      # MCP server (JSON-RPC 2.0 over stdio)
├── cli.js             # CLI entry: session commands, MCP, browse, install
├── .mcp.json          # MCP server config for Claude Desktop / Cursor
├── barebrowse.context.md  # LLM-consumable integration guide
├── commands/
│   ├── barebrowse.md         # CLI command reference (any agent)
│   └── barebrowse/
│       └── SKILL.md          # CLI command reference (Claude Code skill)
├── package.json
├── README.md
└── CLAUDE.md
```
