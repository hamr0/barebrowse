# barebrowse -- Integration Guide

> For AI assistants and developers wiring barebrowse into a project.
> v0.9.1 | Node.js >= 22 | 0 required deps | Apache-2.0

## What this is

barebrowse is a CDP-direct browsing library for autonomous agents (~3,600 lines in `src/` across 14 modules). URL in, pruned ARIA snapshot out. It launches the user's installed Chromium browser (or attaches to one already running), navigates, handles consent/permissions/cookies, walks iframes, captures downloads, and returns a token-efficient ARIA tree with `[ref=N]` markers for interaction.

No Playwright. No bundled browser. No build step. Vanilla JS, ES modules.

```
npm install barebrowse
```

Three integration paths:
1. **Library:** `import { browse, connect } from 'barebrowse'` -- one-shot or interactive session
2. **MCP server:** `barebrowse mcp` -- JSON-RPC over stdio for Claude Desktop, Cursor, etc.
3. **CLI session:** `barebrowse open` / `click` / `snapshot` / `close` -- shell commands, outputs to disk

## Which mode do I need?

| Mode | What it does | When to use |
|---|---|---|
| `headless` (default) | Launches a fresh Chromium, no UI | Scraping, reading, fast automation |
| `headed` | Auto-launches a visible Chromium window | Bot-detected sites, debugging, visual tasks |
| `hybrid` | Tries headless first, headed fallback per-navigation (switches back to headless next time) | General-purpose agent browsing |
| `connect({ port })` (attach) | Attaches to a Chromium *you* started with `--remote-debugging-port=N` — your real logged-in profile, no clone | When you need the user's real session (auth cookies, localStorage, IndexedDB). `close()` only kills the tab we opened, not the browser. |

Attach mode skips three things vs. spawn modes: stealth patches (would persist via `addScriptToEvaluateOnNewDocument`), `Browser.setPermission` calls (browser-wide — would leak deny-states into the user's other tabs), and `Browser.setDownloadBehavior` (don't override the user's download preference). Stealth is unnecessary anyway because the user's real browser doesn't look headless.

## Minimal usage: one-shot browse

```javascript
import { browse } from 'barebrowse';

// Defaults: headless, cookies injected, pruned, consent dismissed
const snapshot = await browse('https://example.com');

// All options
const snapshot = await browse('https://example.com', {
  mode: 'headless',      // 'headless' | 'headed' | 'hybrid'
  cookies: true,         // inject user's browser cookies
  browser: 'firefox',    // cookie source: 'firefox' | 'chromium' (auto-detected)
  prune: true,           // apply ARIA pruning (47-95% token reduction)
  pruneMode: 'act',      // 'act' (interactive elements) | 'read' (all content)
  consent: true,         // auto-dismiss cookie consent dialogs
  blockAds: true,        // block 128 ad/tracker URL patterns (default on for owned browsers)
  blockUrls: [],         // extra URL globs to block (merged with the default)
  timeout: 30000,        // navigation timeout in ms
});
```

## connect() API

`connect(opts)` returns a page handle for interactive sessions. Same opts as `browse()` for mode. Supports `hybrid` mode — starts headless, auto-launches headed on bot detection (same as `browse()`).

| Method | Args | Returns | Notes |
|---|---|---|---|
| `goto(url, timeout?)` | url: string, timeout: number (default 30000) | void | Navigate + wait for load + dismiss consent |
| `goBack()` | -- | void | Navigate back in browser history |
| `goForward()` | -- | void | Navigate forward in browser history |
| `reload(opts?)` | { ignoreCache?: boolean, timeout?: number } | void | Reload the current page. Clears refMap (refs from pre-reload reject). |
| `snapshot(pruneOpts?)` | false or { mode: 'act'\|'read' } | string | ARIA tree with `[ref=N]` markers. Pass `false` for raw. |
| `click(ref)` | ref: string | void | Scroll into view + mouse press+release at center |
| `type(ref, text, opts?)` | ref: string, text: string, opts: { clear?, keyEvents? } | void | Focus + insert text. `clear: true` replaces existing. |
| `press(key)` | key: string | void | Special key: Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space |
| `scroll(deltaY)` | deltaY: number | void | Mouse wheel. Positive = down, negative = up. MCP/bareagent also accept `direction: "up"/"down"`. |
| `hover(ref)` | ref: string | void | Move mouse to element center |
| `select(ref, value)` | ref: string, value: string | void | Set `<select>` value or click custom dropdown option |
| `drag(fromRef, toRef)` | fromRef: string, toRef: string | void | Drag from one element to another |
| `upload(ref, files)` | ref: string, files: string[] | void | Set files on a file input (absolute paths) |
| `screenshot(opts?)` | { format?: 'png'\|'jpeg'\|'webp', quality?: number } | string (base64) | Page screenshot |
| `pdf(opts?)` | { landscape?: boolean } | string (base64) | Export page as PDF |
| `tabs()` | -- | Array<{index, url, title, targetId}> | List open browser tabs |
| `switchTab(index)` | index: number | void | Switch to tab by index |
| `waitFor(opts)` | { text?: string, selector?: string, timeout?: number } | void | Poll for content to appear on page |
| `waitForNavigation(timeout?)` | timeout: number (default 30000) | void | Wait for page load or frame navigation |
| `waitForNetworkIdle(opts?)` | { timeout?: number, idle?: number } | void | Wait until no pending requests for `idle` ms (default 500) |
| `saveState(filePath)` | filePath: string | void | Export cookies + localStorage to JSON file |
| `injectCookies(url, opts?)` | url: string, { browser?: string } | void | Extract cookies from user's browser and inject via CDP |
| `botBlocked` | -- | boolean | True if last `goto()` hit a bot challenge. Heuristic tightened in v0.9.0 (H9): Cloudflare-strong phrases fire alone; generic phrases ("access denied"/"unknown error") only fire on near-empty pages. Resets on each navigation. |
| `dialogLog` | -- | Array<{type, message, timestamp}> | Auto-dismissed JS dialog history |
| `onDialog(handler)` | handler: ({type, message, defaultPrompt}) => {accept, promptText} \| undefined, or null to remove | void | Override the auto-accept default. Handler receives the dialog params; return `{accept: false}` to cancel, `{accept: true, promptText: 'x'}` to supply prompt input. Pass `null` to restore defaults. |
| `downloads` | -- | Array<{guid, url, suggestedFilename, savedPath, state, totalBytes, receivedBytes}> | Live array of every `Content-Disposition: attachment` download captured during this session. `state`: `inProgress` → `completed` \| `canceled`. |
| `cdp` | -- | object | Raw CDP session (getter — survives hybrid fallback and switchTab) for escape hatch: `page.cdp.send(method, params)` |
| `createTab()` | -- | tab handle | New tab in same browser. Returns `{ goto, botBlocked, injectCookies, waitForNetworkIdle, cdp, close }`. Tab close doesn't affect session. |
| `close()` | -- | void | Close page, disconnect CDP, kill browser (if headless) |

**connect() options** (in addition to mode/port/consent):
- `port: 9222` — Attach to a Chromium already running with `--remote-debugging-port=N` instead of spawning one. The browser keeps running on `close()`. Stealth + permission denial + download capture are skipped to avoid mutating the user's running browser.
- `proxy: 'http://...'` — HTTP/SOCKS proxy for browser
- `viewport: '1280x720'` — Set viewport dimensions
- `storageState: 'file.json'` — Load cookies/localStorage from saved state
- `downloadPath: '/abs/dir'` — Where downloads land. Default: per-session `mkdtemp` under `/tmp/barebrowse-dl-*` that gets removed on `close()`. Caller-supplied paths are not cleaned up — caller owns the lifecycle.
- `blockAds: true|false` — CDP-level URL blocking of 128 common ad/tracker patterns (Google ads/analytics, FB/Amazon/MS/Adobe ad+analytics, Segment/Amplitude/Mixpanel/Heap/PostHog, Hotjar/FullStory/LogRocket, Criteo/Taboola/Outbrain, the consumer-pixel cluster, AppNexus/Rubicon/PubMatic supply, marketing automation; v0.10.1 added AppsFlyer/Branch/Adjust, Cloudflare Web Analytics, Matomo Cloud). Default `true` for launched browsers, `false` in attach mode (would affect any tab in the user's running browser). Explicit `true` in attach mode is honored and follows the session across `switchTab()` (regression-tested). Shrinks ARIA snapshots and speeds page loads. On legacy Chromium lacking `Network.setBlockedURLs` a one-time `console.warn` surfaces the fallback.
- `blockUrls: ['*://foo.com/*', ...]` — Extra glob patterns (CDP `Network.setBlockedURLs` format) to block in addition to the default. Merged with the default unless `blockAds: false`.

## Snapshot format

The snapshot is a YAML-like ARIA tree. First line is the page URL, second is pruning stats, then the tree:

```
url: https://example.com/
# 379 chars → 45 chars (88% pruned)
- heading "Example Domain" [level=1] [ref=3]
- link "More information..." [ref=8]
```

Key rules:
- `[ref=N]` markers appear on interactive and named elements
- Refs are **ephemeral** -- they change on every `snapshot()` call
- Always call `snapshot()` to get fresh refs before interacting
- `click(ref)` / `type(ref, text)` / `hover(ref)` / `select(ref, value)` use these ref strings
- Pruning removes noise (~47-95% token reduction) while keeping all interactive elements

## Interaction loop: observe, think, act

```javascript
import { connect } from 'barebrowse';

const page = await connect();
await page.goto('https://example.com');

// 1. Observe
let snap = await page.snapshot();

// 2. Think (LLM decides what to do based on snapshot)
// 3. Act
await page.click('8');         // click the "More information..." link
await page.waitForNavigation();

// 4. Observe again (refs are now different)
snap = await page.snapshot();

// ... repeat until goal is achieved

await page.close();
```

## Auth / cookie options

barebrowse can inject cookies from the user's real browser sessions, bypassing login walls.

| Source | How | Notes |
|---|---|---|
| Firefox (default) | SQLite `cookies.sqlite`, plaintext | Works on Linux. Auto-detected default profile. |
| Chromium | SQLite `Cookies` + AES decryption via keyring | Linux: KWallet or GNOME Keyring. Profile must not be locked. |
| Manual | `page.injectCookies(url, { browser: 'firefox' })` | Explicit injection on connect() sessions |
| Disabled | `{ cookies: false }` | No cookie injection |

`browse()` auto-injects cookies before navigation. `connect()` exposes `injectCookies()` for manual control.

## Obstacle course -- what barebrowse handles automatically

| Obstacle | How | Mode |
|---|---|---|
| Cookie consent | ARIA scan + jsClick accept button, 29 languages | Both |
| Consent behind iframes | JS `.click()` via DOM.resolveNode bypasses overlays, real mouse click fallback for CMPs that ignore synthetic clicks | Both |
| Permission prompts | Launch flags + CDP Browser.setPermission auto-deny | Both |
| Media autoplay blocked | `--autoplay-policy=no-user-gesture-required` | Both |
| Login walls | Cookie extraction from Firefox/Chromium + CDP injection | Both |
| Pre-filled form inputs | `type({ clear: true })` selects all + deletes first | Both |
| Off-screen elements | `DOM.scrollIntoViewIfNeeded` before every click, JS `.click()` fallback for no-layout elements | Both |
| Form submission | `press('Enter')` triggers onsubmit | Both |
| SPA navigation | `waitForNavigation()` uses loadEventFired + frameNavigated | Both |
| Bot detection | v0.9.0 (H9): Cloudflare-strong phrases ("Just a moment", "Attention Required", "verify you are human") fire alone; generic phrases ("access denied", "unknown error") only fire on near-empty pages — no more false-positive headed-launches on legitimate 4xx/5xx pages. `botBlocked` flag set after every `goto()`. Hybrid fallback switches to headed. Snapshot shows `[BOT CHALLENGE DETECTED]` warning. | Hybrid |
| Stealth (headless tells) | v0.9.0 (H4): `Network.setUserAgentOverride` strips "HeadlessChrome" from UA in HTTP headers AND `navigator.userAgent`; JS patches for webdriver, plugins, languages, full `chrome.runtime` enum shape, `Notification` constructor + `permission: 'default'`, `hardwareConcurrency: 8`, `deviceMemory: 8`, WebGL `UNMASKED_VENDOR_WEBGL`/`UNMASKED_RENDERER_WEBGL` spoofed to Intel. v0.10.0: canvas fingerprint noise — `toDataURL`/`getImageData` XOR a per-session `crypto.getRandomValues`-seeded mask into ~1 byte per 64-byte stride (stable within a session, different across sessions; bitmap is restored after encoding so legitimate canvas use is unaffected). | Headless |
| Ad / tracker URL blocking | v0.10.0: CDP `Network.setBlockedURLs` with 128 curated patterns (Google/FB/Amazon/MS/Adobe ad+analytics, the major SaaS analytics + session-replay stacks, content-rec, supply-side ad networks, marketing automation). v0.10.1 added long-tail: AppsFlyer/Branch/Adjust, Cloudflare Web Analytics, Matomo Cloud, broader Outbrain (`amplify`/`log`) and PostHog (`/static/array.js`). Default on for launched browsers, off in attach mode. `opts.blockUrls` extends; `opts.blockAds: false` disables. Shrinks ARIA snapshots and speeds loads. v0.10.1: regression-tested across `switchTab()` in attach mode; one-time `console.warn` if Chromium lacks the CDP method. | Launched |
| iframe / OOPIF content (Stripe, reCAPTCHA, embedded forms) | v0.9.0 (H2): `Target.setAutoAttach({flatten:true})` registers a CDP session per iframe; `ariaTree()` walks `Page.getFrameTree`, fetches each frame's AX tree on the right session, splices children under iframe placeholders via `DOM.getFrameOwner`. Refs route via `{session, backendNodeId}` so clicks dispatch in the iframe's Input domain. `--site-per-process` launch flag forces every iframe — including same-origin — into OOPIF so coords work. | Both |
| Downloads | v0.9.0 (H7): `Browser.setDownloadBehavior({behavior:'allowAndName', downloadPath, eventsEnabled:true})` + listeners populate `page.downloads`. Files land at `savedPath` (under `--download-path` if supplied, else per-session `/tmp/barebrowse-dl-*`). | Headless + Headed (skipped in attach mode) |
| Profile locking | Unique temp dir per headless instance | Headless |
| Shared memory crash (Linux) | `--disable-dev-shm-usage` flag prevents `/dev/shm` exhaustion | Headless |
| ARIA noise | 9-step pruning: wrapper collapse, noise removal, landmark promotion | Both |

## bareagent wiring

barebrowse provides a tool adapter for bareagent's Loop:

```javascript
import { Loop } from 'bare-agent';
import { Anthropic } from 'bare-agent/providers';
import { createBrowseTools } from 'barebrowse/src/bareagent.js';

const provider = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const loop = new Loop({ provider });

const { tools, close } = createBrowseTools();

try {
  const result = await loop.run(
    [{ role: 'user', content: 'Search for "barebrowse" on DuckDuckGo and tell me the first result' }],
    tools
  );
  console.log(result.text);
} finally {
  await close();
}
```

`createBrowseTools(opts)` returns:
- `tools` -- array of bareagent-compatible tool objects: `browse`, `goto`, `snapshot`, `click`, `type`, `press`, `scroll`, `select`, `hover`, `back`, `forward`, `reload` (v0.9.0), `drag`, `upload`, `tabs`, `switchTab`, `pdf`, `screenshot`, `wait_for` (v0.9.0), `downloads` (v0.9.0), plus `assess` if wearehere installed
- `close()` -- cleanup function, call when done

Action tools (click, type, press, scroll, hover, goto, back, forward, reload, drag, upload, select, switchTab, wait_for) auto-return a fresh snapshot so the LLM always sees the result. 300ms settle delay after actions for DOM updates.

`onDialog` is intentionally not exposed as a tool — it's a callback shape that doesn't fit a request/response tool loop. If your bareagent flow needs to override a confirm/prompt, drop to `import { connect }` directly and pass the page through.

## CLI session mode

For coding agents (Claude Code, Copilot, Cursor) and quick interactive testing. Commands output files to `.barebrowse/` -- agents read them with file tools, avoiding token waste in tool responses.

```bash
barebrowse open https://example.com    # Start daemon + navigate
barebrowse snapshot                    # → .barebrowse/page-<timestamp>.yml
barebrowse click 8                     # Click element ref=8
barebrowse type 12 hello world         # Type into element ref=12
barebrowse back                        # Go back in history
barebrowse reload [--no-cache]         # v0.9.0 — reload current page (bypass cache optional)
barebrowse downloads                   # v0.9.0 — JSON array of captured downloads (savedPath, state...)
barebrowse upload 7 /path/to/file.pdf  # Upload file to file input
barebrowse pdf                         # → .barebrowse/page-<timestamp>.pdf
barebrowse wait-for --text="Success"   # Wait for content to appear
barebrowse tabs                        # List open tabs
barebrowse save-state                  # → .barebrowse/state-<timestamp>.json
barebrowse close                       # Kill daemon + browser
```

**Open flags:** `--mode=headless|headed|hybrid`, `--port=N` (attach to running browser), `--proxy=URL`, `--viewport=WxH`, `--storage-state=FILE`, `--download-path=DIR` (v0.9.0), `--no-cookies`, `--browser=firefox|chromium`, `--timeout=N`

Session lifecycle: `open` spawns a background daemon holding a `connect()` session. Subsequent commands POST to the daemon over HTTP (localhost). `close` shuts everything down. JS dialogs (alert/confirm/prompt) are auto-dismissed and logged.

Full command reference: `commands/barebrowse/SKILL.md` (Claude Code) or `commands/barebrowse.md` (other agents)

## MCP wrapper

barebrowse ships an MCP server for direct use with Claude Desktop, Cursor, or any MCP client.

**Claude Code:** `claude mcp add barebrowse -- npx barebrowse mcp`

**Claude Desktop / Cursor:** `npx barebrowse install` (auto-detects and writes config; pass `--force` to overwrite an existing entry pointing at a different endpoint)

**Diagnose scope conflicts:** `npx barebrowse doctor` scans every known MCP config location (Claude Code user/project/local, Claude Desktop, Cursor, VS Code) and prints which `barebrowse` entries are registered + where they point. Flags `CONFLICT` when two scopes point at different paths — OAuth tokens are stored per endpoint, so a split silently breaks auth. The MCP server itself also writes a one-line banner to stderr at startup (`barebrowse mcp v<X.Y.Z> | serving from <abs path> | pid <N>`) so a stuck agent is diagnosable from the MCP client log.

**Manual config** (`claude_desktop_config.json`, `.cursor/mcp.json`):
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

18 core tools as of v0.9.0: `browse` (one-shot), `goto`, `snapshot`, `click`, `type`, `press`, `scroll`, `hover`, `select`, `back`, `forward`, `reload`, `drag`, `upload`, `pdf`, `screenshot`, `wait_for`, `tabs`. Plus `assess` (privacy scan) if `wearehere` is installed (`npm install wearehere`). Plus the **opt-in `eval` tool** gated by `BAREBROWSE_MCP_EVAL=1` (default OFF) — `Runtime.evaluate` in the user's authenticated session can read cookies/localStorage and hit any same-origin endpoint, so opt-in only.

Action tools return `'ok'` -- the agent calls `snapshot` explicitly to observe. This avoids double-token output since MCP tool calls are cheap to chain.

`browse` and `snapshot` accept a `maxChars` param (default 30000). If the snapshot exceeds the limit, it's saved to `.barebrowse/page-<timestamp>.yml` and a short message with the file path is returned instead. `screenshot` always saves to `.barebrowse/screenshot-<timestamp>.{png,jpeg,webp}` and returns the file path (raw base64 in a JSON-RPC response would blow `maxChars`). `tabs` returns the JSON array, or with `switchTo: N` it switches and returns `'ok'`.

`browse` and `snapshot` also accept `pruneMode: 'act'|'read'`. `act` (the default) keeps interactive elements and short labels — best for clicking/filling. `read` keeps paragraphs, headings, and long text — best for articles, docs, and content extraction. Same surface on the bareagent adapter. If act mode collapses a content-heavy page (raw > 5 KB → pruned < 500 chars AND < 5% of raw), the result includes a `hint: act mode dropped most of the page — retry with pruneMode='read' …` line between the stats and the tree so the caller knows to re-snapshot in read mode instead of bailing to a separate HTTP fetch.

Session runs in hybrid mode (headless with automatic headed fallback on bot detection). `goto` injects cookies from the user's browser before navigation for authenticated access.

Session tools share a singleton page, lazy-created on first use. All session tools have auto-retry on transient failures (browser crash, WebSocket close, navigation timeout) on a per-tool deadline (v0.9.0 H5): `goto`/`reload`/`wait_for` 60s, `back`/`forward` 30s, interactive ops (`click`/`type`/`press`/`scroll`/`hover`/`select`/`drag`/`snapshot`/`eval`) 15s, `tabs` 5s, heavy I/O (`pdf`/`screenshot`/`upload`) 45s — replaces the prior blanket 30s. Session resets between attempts. Idempotent tools retry once; mutating tools (`click`/`type`/`upload`/etc.) `{ retry: false }` so partial first attempts don't replay on a fresh page. Scroll accepts `direction: "up"/"down"` in addition to numeric `deltaY`. Click falls back to JS `.click()` when elements have no layout. `browse` has a 60s timeout (no retry — stateless). Assess tries headless first; if bot-blocked, retries headed. Browser OOM/crash auto-recovers (session resets, server stays alive).

## Architecture

```
URL -> chromium.js (find/launch browser, permission flags)
    -> cdp.js (WebSocket CDP client)
    -> stealth.js (navigator.webdriver patches, headless only)
    -> Browser.setPermission (suppress prompts)
    -> auth.js (extract cookies -> inject via CDP)
    -> Page.navigate
    -> consent.js (detect + dismiss cookie dialogs)
    -> aria.js (Accessibility.getFullAXTree -> nested tree)
    -> prune.js (9-step role-based pruning)
    -> interact.js (click/type/scroll/hover/select via Input domain)
    -> agent-ready snapshot
```

| Module | Lines | Purpose |
|---|---|---|
| `src/index.js` | ~940 | Public API: `browse()`, `connect()`, attach mode, iframe frame-tree walking, downloads, onDialog, isChallengePage |
| `src/cdp.js` | 148 | WebSocket CDP client, flattened sessions |
| `src/chromium.js` | ~160 | Find/launch Chromium browsers, `attach({port})`, `cleanupBrowser`, permission-suppressing flags, `--site-per-process` |
| `src/aria.js` | 69 | Format ARIA tree as text |
| `src/auth.js` | 279 | Cookie extraction (Chromium AES + keyring, Firefox), CDP injection |
| `src/prune.js` | 472 | ARIA pruning pipeline (ported from mcprune) |
| `src/interact.js` | ~170 | Click, type, press, scroll, hover, select |
| `src/consent.js` | 200 | Auto-dismiss cookie consent dialogs across languages |
| `src/stealth.js` | ~110 | UA override + JS patches (webdriver, WebGL, hardware, Notification, chrome.runtime) |
| `src/network-idle.js` | ~50 | Set-based network-idle wait (extracted in v0.8.0, F9) |
| `src/bareagent.js` | ~330 | Tool adapter for bareagent Loop (21 tools) |
| `mcp-server.js` | ~660 | MCP server (JSON-RPC over stdio, `runStdio()`, `TIMEOUTS`/`TOOLS` exports, opt-in eval, assess session reuse + concurrency) |

## Privacy assessment (optional)

Install `wearehere` to add an `assess` tool to both the MCP server and bareagent adapter:

```bash
npm install wearehere
```

The `assess` tool opens a new tab in the session browser via `createTab()` (reusing cookies and headed fallback), scans for 10 privacy categories (cookies, trackers, fingerprinting, dark patterns, data brokers, form surveillance, link tracking, toxic terms, stored data, network traffic), and returns a compact JSON assessment. Max 3 concurrent scans (queued beyond that), 30s hard timeout per scan, auto-retry once on failure with 2s backoff (session reset on CDP crash):

```json
{
  "site": "example.com",
  "score": 62,
  "risk": "high",
  "recommendation": "Significant privacy risks. Avoid sharing personal info here.",
  "concerns": ["Heavy hidden tracking", "Aggressive device fingerprinting"],
  "categories": {
    "cookies":      { "score": 10, "max": 15, "summary": "7 third-party cookies" },
    "trackers":     { "score": 20, "max": 20, "summary": "14 hidden elements" },
    "profiling":    { "score": 10, "max": 20, "summary": "Canvas + WebGL" },
    "terms":        { "score": 15, "max": 15, "summary": "Binding arbitration" }
  }
}
```

Useful for agent threshold decisions: "skip sites above score 40", "warn if terms score >= 10", etc. When wearehere is not installed, the tool simply doesn't appear — no errors, no impact.

## Gotchas

1. **Refs are ephemeral.** Every `snapshot()` call generates new refs. Always snapshot before interacting. Never cache refs across snapshots.

2. **SPA navigation has no loadEventFired.** For single-page apps (React, YouTube, GitHub), use `waitForNetworkIdle()` or a timed wait after click instead of `waitForNavigation()`.

3. **Pruning modes matter.** `act` mode (default) keeps interactive elements + visible labels. `read` mode keeps all text content. Use `read` for content extraction, `act` for form filling and navigation.

4. **Headed mode auto-launches Chromium.** No need to start a browser manually — barebrowse launches a headed Chromium instance with CDP enabled automatically.

5. **Cookie extraction needs unlocked profile.** Chromium cookies are AES-encrypted with a keyring key. If Chromium is running, the profile may be locked. Firefox cookies are plaintext and always accessible.

6. **Hybrid mode is per-navigation.** If headless is bot-blocked, hybrid kills headless and launches headed for that URL. On the next `goto()`, it switches back to headless automatically. If headed can't launch (no display — CI, Docker), it degrades gracefully with the headless result and a `[BOT CHALLENGE DETECTED]` warning.

7. **One page per connect(), but tabs are supported.** Each `connect()` call creates one page. Use `createTab()` for additional tabs in the same browser.

8. **Consent dismiss is best-effort.** It handles 16+ tested sites across 29 languages but novel consent implementations may need manual handling. Disable with `{ consent: false }`.

9. **Screenshot returns base64.** Write to file with `fs.writeFileSync('shot.png', Buffer.from(base64, 'base64'))` or pass directly to a vision model.

10. **Chromium-only.** CDP protocol limits us to Chrome, Chromium, Edge, Brave, Vivaldi (~80% desktop share). Firefox support via WebDriver BiDi is not yet implemented.

11. **`--site-per-process` is on by default (v0.9.0).** Required for iframe support — without it, same-origin iframes stay in the parent process and `Input.dispatchMouseEvent` coords don't match `DOM.getBoxModel` coords for iframe-internal elements. Memory cost: +50-150MB per cross-origin frame. Real Chrome does this for cross-origin by default; we just extend it to all iframes. If you attach via `connect({port})`, the user's browser is whatever they launched it as — for iframe interaction reliability, start it with `--site-per-process` too.

12. **Attach mode (`connect({port})`) skips three things on purpose.** No stealth (would inject persistent JS via `addScriptToEvaluateOnNewDocument`), no `Browser.setPermission` (browser-wide — would leak deny-states into the user's other tabs), no `Browser.setDownloadBehavior` (don't override the user's download preference). The trade-off: `page.downloads` is always empty in attach mode. If you need download capture in an attached session, start the browser with `--remote-debugging-port=N` *and* configure download preferences in the browser UI first.

13. **Refs are globally flat across frames.** v0.9.0 (H2) assigns refs from a shared counter across the merged frame tree, so a `[ref=42]` from an iframe and a `[ref=43]` from the parent come from one address space. The visible `[ref=N]` format is unchanged. refMap stores `{session, backendNodeId}` so `click(ref)` automatically dispatches in the right frame's session.

14. **`eval` MCP tool is opt-in.** Set `BAREBROWSE_MCP_EVAL=1` to register it. Default off because `Runtime.evaluate` in an authenticated session can read cookies/localStorage, post on the user's behalf, hit any same-origin endpoint. CLI/connect()/daemon all keep `eval` because the developer is the caller; MCP gates it because the agent acts with less judgment.

## Constraints

- **Node >= 22** -- built-in WebSocket, built-in SQLite
- **Chromium-only** -- CDP protocol
- **Linux first** -- tested on Fedora/KDE, macOS/Windows cookie paths exist but untested
- **Not a server** -- library that agents import. Wrap as MCP (included) or HTTP if needed.
- **Zero required deps** -- everything uses Node stdlib
