# Changelog

## 0.7.1

Fix: timeout now triggers auto-retry instead of bypassing it.

### Bug fix (`mcp-server.js`)
- **Root cause:** The 30s timeout was a `Promise.race` *outside* `withRetry()`. When a page timed out, the race rejected immediately — `withRetry` never got a chance to reset the session and retry. Timeouts also didn't match `isCdpDead()`, so even if they did reach `withRetry`, they wouldn't be retried.
- **Fix:** Moved per-attempt timeout *inside* `withRetry()`. Each attempt gets its own 30s deadline. On timeout or CDP death, the session resets and a fresh attempt runs. The outer `Promise.race` is removed entirely.
- `isCdpDead()` renamed to `isTransient()` — now also matches timeout errors (`"Timeout waiting for CDP event"`, `"timed out"`)
- Non-transient errors (validation, unknown tool) are still not retried

### Tests
- 11 new unit tests in `test/unit/mcp.test.js`: `isTransient` detection (CDP death, timeouts, non-transient), `withRetry` behavior (success, CDP retry, timeout retry, no-retry for validation, double-failure, no-timeout mode)
- 80 total tests (39 unit + 41 integration)

## 0.7.0

MCP resilience: timeouts, auto-retry, LLM-friendly scroll, and click fallback for hidden elements.

### Timeouts (`mcp-server.js`)
- All MCP tool calls now have a hard timeout: 30s for session tools, 60s for `browse` and `assess`
- Returns a structured error (`Tool "X" timed out after Ns`) instead of hanging silently
- Previously: a hung browser or slow page caused `[Tool result missing due to internal error]` — opaque and unrecoverable

### Auto-retry (`mcp-server.js`)
- `withRetry()` wrapper on all session tools (goto, snapshot, click, type, press, scroll, back, forward, drag, upload, pdf)
- On transient CDP failure (WebSocket closed, target/session closed), resets the session and retries once automatically
- Non-CDP errors (validation, unknown tool) are not retried

### LLM-friendly scroll (`mcp-server.js`, `src/bareagent.js`)
- Scroll tool now accepts `direction: "up"/"down"` in addition to numeric `deltaY`
- LLMs naturally say `scroll(direction: "down")` — this now works instead of crashing with `deltaX/deltaY expected for mouseWheel event`
- `"down"` → `deltaY: 900`, `"up"` → `deltaY: -900`. Numeric `deltaY` still works and takes precedence.
- Clear validation error if neither `direction` nor `deltaY` is provided

### Click JS fallback (`src/interact.js`)
- Click now falls back to JS `element.click()` when `DOM.scrollIntoViewIfNeeded` fails with "Node does not have a layout object"
- This error occurs on elements that exist in the ARIA tree but have no visual layout (display:none, zero-size, collapsed sections, detached nodes)
- Resolves the node via `DOM.requestNode` → `DOM.resolveNode` → `Runtime.callFunctionOn`
- Other click errors still throw normally

### Docs
- Updated barebrowse.context.md, README.md, prd.md with resilience features
- MCP server version string updated to 0.7.0

### Tests
- 71/71 passing — no test changes needed

## 0.6.1

Headed fallback is now a per-navigation escape hatch, not a permanent mode switch. Graceful degradation when headed is unavailable.

### Switch-back to headless (`src/index.js`)
- `connect().goto()` in hybrid mode: if currently headed from a previous fallback, kills the headed browser and launches fresh headless before navigating
- New `currentlyHeaded` runtime state variable tracks actual browser mode (vs `mode` which is user config)
- `createPage()` stealth decision uses runtime mode (`!currentlyHeaded`) instead of config mode (`mode !== 'headed'`)
- `createTab()` also uses `currentlyHeaded` for correct stealth application

### Graceful degradation (`src/index.js`)
- `connect().goto()` hybrid fallback wrapped in try/catch — if `launch({ headed: true })` fails (no `$DISPLAY`, no Wayland, CI/Docker), keeps the headless result with `botBlocked: true` and `[BOT CHALLENGE DETECTED]` warning
- `browse()` hybrid fallback also wrapped in try/catch — same graceful degradation for one-shot browsing
- No crash on headless-only environments

### Flow after changes
```
goto(url) in hybrid mode:
  1. If currently headed → kill headed, launch headless, reset currentlyHeaded
  2. Navigate to url
  3. Check bot-blocked
  4. If bot-blocked → TRY launch headed (set currentlyHeaded=true)
                    → CATCH: headed unavailable, keep headless result
```

### Docs
- Updated hybrid mode descriptions in barebrowse.context.md, system-state.md, prd.md

### Tests
- All existing tests pass (tests use headless mode, unaffected by hybrid logic)

## 0.6.0

Self-launching headed fallback. Headed and hybrid modes no longer require a manually-launched browser on port 9222 — barebrowse auto-launches a visible Chromium window via `launch({ headed: true })`.

### Headed mode auto-launch (`src/chromium.js`)
- `launch()` accepts `headed` option — skips `--headless=new` and `--hide-scrollbars` flags
- Same temp profile, same random port, same CDP parsing, same process return

### Hybrid fallback fix (`src/index.js`)
- All 4 `getDebugUrl(port)` call sites replaced with `launch({ headed: true, proxy })` + `createCDP(browser.wsUrl)`
- `browse()` headed branch, `browse()` hybrid fallback, `connect()` headed branch, `connect().goto()` hybrid fallback
- `getDebugUrl` import removed from index.js (still exported from chromium.js for external use)
- Hybrid mode now actually works — previously it tried to connect to port 9222 which nobody ran

### Assess handler simplified (`mcp-server.js`)
- Removed dual-path `runAssess(headed)` function (~60 lines of broken headed fallback)
- Assess now uses the session's hybrid mode: if tab is bot-blocked, triggers headed fallback via main page `goto()`, then retries in a new tab
- One flow, no separate `connect({ mode: 'headed' })` call

### Docs
- Removed all "launch browser with --remote-debugging-port=9222" instructions
- Updated headed/hybrid mode descriptions across barebrowse.context.md, README.md, system-state.md, prd.md

### Tests
- 71/71 passing — no test changes needed (all tests use headless mode)

## 0.5.8

Bot challenge detection for all browsing, not just assess.

### Bot detection (`src/index.js`)
- `isChallengePage()` now checks ARIA node count (<50 = bot-blocked) in addition to text length and phrase matching
- `botBlocked` property exposed on both `connect()` pages and `createTab()` tabs
- `goto()` on main page and tabs sets `botBlocked` after every navigation
- `snapshot()` prepends `[BOT CHALLENGE DETECTED]` warning line when flagged
- Hybrid fallback on main page now uses node count for more reliable detection

### Assess handler (`mcp-server.js`)
- Headed fallback now uses `tab.botBlocked` flag instead of naive score threshold (≤5 + all zeros)
- Previously: sites like Reuters, Home Depot, Leboncoin returned fake-clean scores because the bot challenge page looked "clean" to the scanner
- Now: node count catches every bot-blocked page regardless of score

### Tested
- reuters.com, homedepot.com, leboncoin.fr, idealista.com all correctly flagged `botBlocked: true`
- svt.se, whatsapp.com, google.com correctly flagged `false`
- 71/71 tests passing

## 0.5.7

MCP server crash resilience + process hardening.

### Process hardening (`mcp-server.js`)
- Added `unhandledRejection` and `uncaughtException` handlers — browser OOM/crash no longer kills the MCP server process
- Previously: heavy sites like zalando.de crashed the browser via OOM, the CDP WebSocket close rejected pending promises, unhandled rejections crashed Node
- Now: session resets and next request gets a fresh browser. Server stays alive.

### Validated at scale
- Scanned 149 sites across NL/US/EU with zero server crashes
- Only 1 genuine timeout (rtv.nl) — all former crashers (zalando.de, otto.de, bijenkorf.nl, jumbo.com, klm.nl) now return results
- Full results: `wearehere-scan-results.md`

## 0.5.6

Assess now works on bot-blocking EU sites. Headed fallback + consent fix.

### Assess headed fallback (`mcp-server.js`)
- Assess tries headless first; if result looks bot-blocked (score ≤5, all zeros), retries with a separate `connect({ mode: 'headed' })` session
- Previously all assess scans ran headless-only — sites like Lufthansa, Coolblue, Rabobank returned score 5 (empty page behind bot wall)
- Now: Lufthansa 50/high, Coolblue 55/high, Rabobank 75/critical

### Consent dismissal improvements (`src/consent.js`)
- Tab `goto()` now runs `dismissConsent()` (was missing — consent walls blocked all trackers from loading, making assess see a clean page)
- Added `/\baccepteren\b/i` Dutch pattern (Rabobank uses bare "ACCEPTEREN" without "alles")
- realClick fallback: if jsClick doesn't dismiss the CMP (button disappears from ARIA but overlay stays), retries with real `Input.dispatchMouseEvent` mouse click
- Both dialog-scoped and global consent paths now have the jsClick→realClick fallback

### createTab consent (`src/index.js`)
- `createTab().goto()` now dismisses consent after navigation (same as main page `goto()`)

## 0.5.5

Fix assess tab leak and Linux shared memory crash.

### Assess tab leak (`mcp-server.js`)
- Fixed: successful assess calls never closed the tab — tabs accumulated, eating RAM until Chromium crashed
- `tab.close()` now called in the success path (was only in error/timeout paths)
- This was the root cause of crashes on heavy EU cookie consent sites (zalando.de, otto.de, etc.) — not the CMPs themselves

### Chromium launch (`src/chromium.js`)
- Added `--disable-dev-shm-usage` flag — prevents shared memory crashes on Linux systems with limited `/dev/shm`

### Tests
- New: `createTab()` suite in browse.test.js (2 tests)
  - Creates 5 tabs, navigates each, closes all, verifies no zombie tabs remain
  - Tab close is idempotent (double-close doesn't throw)
- 71/71 passing (was 69)

## 0.5.4

Assess tool hardened: session reuse, concurrency, self-healing.

### Assess handler (`mcp-server.js`)
- Session reuse: assess now opens tabs in the existing session browser via `createTab()` instead of spawning a new browser per scan
- Concurrency: semaphore limits to 3 concurrent assess tabs, queues the rest
- 30s hard timeout per scan with force tab close on expiry
- Auto-retry once on failure with 2s backoff; resets session on CDP crash
- Removed debug logging added during development

### CDP resilience (`src/cdp.js`)
- `ws.onclose` handler rejects all pending CDP promises — prevents zombie promises on browser crash

### Library API (`src/index.js`)
- `createTab()` added to `connect()` return object — creates new tab in same browser session
- Returns `{ goto, injectCookies, waitForNetworkIdle, cdp, close }`, tab close doesn't affect main page

### Message loop (`mcp-server.js`)
- `getPage()` is concurrency-safe with promise dedup (prevents duplicate browser launches)
- Message loop changed from sequential `await` to concurrent `.then()` fire-and-forget — multiple tool calls no longer block each other

### Tests
- 69/69 passing
- Verified: 10 concurrent assess calls through MCP client, all succeed (3-at-a-time semaphore confirmed)

## 0.5.3

Improved bot detection for hybrid mode fallback.

### Challenge detection (`src/index.js`)
- `isChallengePage()` now catches near-empty pages (< 50 chars of text) as blocks
- Added challenge phrases: "unknown error", "access denied", "permission denied", "request blocked"
- Sites like CNN that return generic error pages instead of Cloudflare challenges now correctly trigger hybrid → headed fallback

## 0.5.2

Clean npm tarball + bareagent tool parity.

### npm package
- `.npmignore` updated: excluded `.barebrowse/`, `.mcp.json`, `baremobile.md`, `CLAUDE.md`, `docs/` from tarball
- Package size: 41 files / 390KB → 21 files / 180KB

### bareagent adapter
- Added `hover`, `tabs`, `switchTab`, `pdf` tools (was 13 + assess, now 17 + assess)
- bareagent now exposes the full connect() API surface

### Tests
- Fixed 2 snapshot URL prefix assertions (`# url` → `url: url`) to match 0.4.7 format change
- 69/69 passing

## 0.5.0

Privacy assessment via wearehere integration.

### New: `assess` tool
- Scans any URL for privacy risks: cookies, trackers, fingerprinting, dark patterns, data brokers, form surveillance, link tracking, and toxic terms of service
- Returns compact JSON: score (0-100), risk level (low/moderate/high/critical), per-category breakdown (10 categories with score/max/summary), concerns list, and recommendation
- Available in MCP server (13th tool) and bareagent adapter (14th tool)
- Conditionally loaded: only available when `wearehere` npm package is installed
- Uses a dedicated `connect()` page per scan (isolated from the session page)

### Integration
- `wearehere` added as optional dependency in package.json
- MCP server: dynamic `import('wearehere')` with try/catch fallback
- bareagent adapter: same dynamic import pattern
- Zero impact when wearehere is not installed — all existing tools work unchanged

### Version
- Package version: 0.5.0
- MCP server version string updated

## 0.4.8

- Fix: `browse()` one-shot also had `#` prefix (missed in 0.4.7)
- MCP server version string updated

## 0.4.7

Snapshot URL prefix format changed from `# <url>` to `url: <url>`.

- Fix: MCP clients (Claude Code) stripped `#`-prefixed lines as comments, making the URL invisible to agents
- Snapshot first line is now `url: <current-page-url>` (was `# <current-page-url>`)
- Stats line no longer prefixed with `#`

## 0.4.6

- README wording fix

## 0.4.5

- README: "What this is" rewritten — concise, no implementation details exposed

## 0.4.4

Snapshot URL prefix and MCP large-snapshot handling.

### Snapshot URL (`src/index.js`)
- First line of every snapshot is now `# <current-page-url>`
- Works in both `browse()` (uses the url param) and `connect().snapshot()` (uses `Page.getNavigationHistory`)

### MCP maxChars (`mcp-server.js`)
- `browse` and `snapshot` tools accept `maxChars` param (default 30000)
- If snapshot exceeds limit: saved to `.barebrowse/page-<timestamp>.yml`, returns file path message
- If under limit: returned inline as before

### Docs
- barebrowse.context.md: snapshot format updated with URL line, maxChars documented
- commands/barebrowse.md + SKILL.md: snapshot example updated
- docs/00-context/system-state.md: pipeline step 8 updated, MCP maxChars noted

## 0.4.3

Cookie consent expanded to 29 languages.

- Added: RU, UK, PL, CS, TR, RO, HU, EL, SV, DA, NO, FI, AR, FA, ZH, JA, KO, VI, TH, HI, ID/MS
- Dialog hints for 11 more languages
- `.npmignore`: added `.idea/` (leaked in 0.4.2 tarball)

## 0.4.2

Authenticated browsing improvements. MCP sessions now auto-inject cookies and fall back to headed mode when bot-detected.

### MCP server
- Session uses `mode: 'hybrid'` — headless by default, automatic headed fallback on challenge pages
- `goto` tool now injects cookies from user's browsers before navigation (Chromium + Firefox merged)
- Tool descriptions updated with trigger words for better agent tool selection

### Cookie extraction (`src/auth.js`)
- `extractCookies()` auto mode merges all browsers (Chromium + Firefox, last-write-wins by `name@domain`)
- `authenticate()` strips subdomains (`mail.google.com` → `google.com`) so parent-domain cookies are included

### Challenge detection (`src/index.js`)
- `isChallengePage()` detects Reddit block pages ("prove your humanity", "file a ticket")
- `connect()` hybrid fallback triggers on `goto()` when challenge detected

### Skill files
- New: `commands/barebrowse.md` — CLI command reference for non-Claude agents (same as SKILL.md)
- Moved: `SKILL.md` from `.claude/skills/barebrowse/` to `commands/barebrowse/SKILL.md`
- `install --skill` reads from new `commands/` path

### Docs
- README: MCP tool count 7→12, bareagent tools 9→13, skill install paths updated
- barebrowse.context.md: v0.4.2, hybrid for connect(), MCP cookie injection
- docs/00-context/system-state.md: bareagent 13 tools, CLI 27 commands, file map updated, published to npm
- docs/03-logs/validation-log.md: full MCP validation results (Gmail, YouTube, LinkedIn, Reddit, Amazon, GitHub)

## 0.4.1

- Docs: testing guide updated with v0.4.0 manual validation table
- Docs: barebrowse.context.md — CLI examples expanded, open flags listed, MCP tool count 7→12
- Docs: validation-log.md — full manual test results for all 10 new features

## 0.4.0

10 new features inspired by Playwright MCP. All validated manually against live sites.

### New commands
- `back` / `forward` — Browser history navigation via `Page.getNavigationHistory`
- `drag <fromRef> <toRef>` — Drag-and-drop between elements (Kanban boards, sliders)
- `upload <ref> <files..>` — File upload via `DOM.setFileInputFiles`
- `pdf [--landscape]` — PDF export via `Page.printToPDF`
- `tabs` / `tab <index>` — List and switch between browser tabs
- `wait-for --text=X --selector=Y` — Poll for content to appear on page
- `save-state` — Export cookies + localStorage to JSON
- `dialog-log` — View auto-dismissed JS dialog history

### New open flags
- `--proxy=URL` — HTTP/SOCKS proxy server (pass-through to Chromium launch args)
- `--viewport=WxH` — Set viewport dimensions via `Emulation.setDeviceMetricsOverride`
- `--storage-state=FILE` — Load cookies/localStorage from previously saved JSON

### Built-in behavior
- JS dialog auto-dismiss — alert/confirm/prompt handled via `Page.handleJavaScriptDialog`, logged to `dialogLog`

### Library API additions (connect())
- `goBack()`, `goForward()`, `drag(fromRef, toRef)`, `upload(ref, files)`
- `pdf(opts)`, `tabs()`, `switchTab(index)`, `waitFor({ text, selector, timeout })`
- `saveState(filePath)`, `dialogLog` array
- New connect opts: `proxy`, `viewport`, `storageState`

### MCP server
- 5 new tools: `back`, `forward`, `drag`, `upload`, `pdf` (12 total, was 7)

### bareagent adapter
- 4 new tools: `back`, `forward`, `drag`, `upload` (13 total, was 9)

### Docs
- SKILL.md updated with all new commands and flags
- README: new actions table, dialog handling in obstacle course
- barebrowse.context.md: full connect() API table updated
- docs/00-context/system-state.md: actions + obstacle tables updated

## 0.3.3

- Simplified skill install paths: Claude Code (`.claude/` project, `~/.claude/` global), other agents (`.barebrowse/commands/` project, `~/.config/barebrowse/commands/` global)

## 0.3.2

- Skill install instructions in README, clarified `npm install` still required — skill is documentation only
- New: `docs/skill-template.md` — generic template for any CLI tool to create a skill file

## 0.3.1

- Fix `.npmignore`: exclude `.claude/memory/`, `.claude/stash/`, `.claude/settings.local.json` from package (leaked in 0.3.0)

## 0.3.0

CLI session mode. Shell commands that output to disk — coding agents read files when needed instead of getting full snapshots in every tool response. ~4x more token-efficient than MCP for multi-step browsing flows.

### New: CLI session commands
- `barebrowse open [url] [flags]` — spawn background daemon holding a `connect()` session
- `barebrowse close` / `status` — session lifecycle
- `barebrowse goto <url>` — navigate
- `barebrowse snapshot [--mode=act|read]` — ARIA snapshot → `.barebrowse/page-*.yml`
- `barebrowse screenshot [--format]` — screenshot → `.barebrowse/screenshot-*.png`
- `barebrowse click/type/fill/press/scroll/hover/select` — all interactions from connect() API
- Open flags: `--mode`, `--port`, `--no-cookies`, `--browser`, `--timeout`, `--prune-mode`, `--no-consent`

### New: agent self-sufficiency
- `barebrowse eval <expression>` — run JS in page context via `Runtime.evaluate`
- `barebrowse console-logs [--level --clear]` — dump captured console logs → `.barebrowse/console-*.json`
- `barebrowse network-log [--failed]` — dump network requests → `.barebrowse/network-*.json`
- `barebrowse wait-idle [--timeout]` — wait for network idle

### New: daemon architecture (`src/daemon.js` + `src/session-client.js`)
- Background HTTP server on random localhost port, holding a `connect()` session
- Spawned as detached child process, communicates via `session.json`
- Console capture via `Runtime.consoleAPICalled`
- Network capture via `Network.requestWillBeSent` / `responseReceived` / `loadingFailed`
- Graceful shutdown on `close` command or SIGTERM

### New: SKILL.md for Claude Code
- `.claude/skills/barebrowse/SKILL.md` — skill definition + full CLI command reference
- `barebrowse install --skill` — copies SKILL.md to `~/.config/claude/skills/barebrowse/`

### Fixed: MCP setup instructions
- README now has per-client instructions: Claude Code (`claude mcp add`), Claude Desktop/Cursor (`npx barebrowse install`), VS Code (`.vscode/mcp.json`)
- `install` command no longer writes `.mcp.json` for Claude Code — prints `claude mcp add` hint instead

### Fixed: ARIA tree formatting (`src/aria.js`)
- Ignored nodes joined children with empty string instead of newline, causing sibling subtrees to concatenate on one line
- Fixed to `.filter(Boolean).join('\n')`

### Changed
- `cli.js` — expanded from 3 commands to full dispatch table (20+ commands)
- `barebrowse.context.md` — added CLI as third integration path, updated MCP setup
- `README.md` — "Two ways" → "Three ways", added CLI section

### Docs
- `docs/04-process/testing.md` — updated to 64 tests, added CLI test section
- `docs/00-context/system-state.md` — added daemon/session-client to module table, CLI to integrations
- `docs/03-logs/validation-log.md` — full CLI manual validation results

### Tests
- 64 tests passing (was 54 in 0.2.x)
- New: `test/integration/cli.test.js` (10 tests) — full open → snapshot → goto → click → eval → console → network → close cycle
- All existing 54 tests unchanged and passing

## 0.2.1

- README rewritten: no code blocks, full obstacle course table with mode column, two usage paths (MCP vs framework), mcprune credited, measured token savings, context.md as code reference
- MCP auto-installer: `npx barebrowse install` detects Claude Desktop, Cursor, Claude Code and writes config
- MCP config uses `npx barebrowse mcp` instead of local file paths (works for npm consumers)
- CLI help updated with install command

## 0.2.0

Agent integration release. MCP server, bareagent adapter, and interaction features that make barebrowse usable as a standalone tool or embedded browsing layer.

### New: MCP server
- Raw JSON-RPC 2.0 over stdio, zero SDK dependencies
- 7 tools: `browse`, `goto`, `snapshot`, `click`, `type`, `press`, `scroll`
- Singleton session page, lazy-created on first session tool call
- `npx barebrowse mcp` to start, `npx barebrowse install` to auto-configure

### New: MCP auto-installer
- `npx barebrowse install` detects Claude Desktop, Cursor, and Claude Code
- Writes MCP config automatically -- no manual JSON editing
- Reports status for each detected client

### New: bareagent tool adapter
- `import { createBrowseTools } from 'barebrowse/bareagent'`
- Returns `{ tools, close }` with 9 bareagent-compatible tools
- Action tools auto-return fresh snapshot after each action (300ms settle)
- Tools: browse, goto, snapshot, click, type, press, scroll, select, screenshot

### New: stealth patches
- `src/stealth.js` -- anti-detection for headless mode
- Uses `Page.addScriptToEvaluateOnNewDocument` (runs before page scripts)
- Patches: `navigator.webdriver`, `navigator.plugins`, `navigator.languages`, `window.chrome`, `Permissions.prototype.query`
- Auto-applied in headless mode

### New: interactions
- `page.hover(ref)` -- mouse move to element center, triggers hover styles/tooltips
- `page.select(ref, value)` -- native `<select>` (set value + change event) or custom dropdown (click + find option)
- `page.screenshot(opts)` -- `Page.captureScreenshot`, returns base64 (png/jpeg/webp)

### New: wait strategies
- `page.waitForNetworkIdle(opts)` -- resolve when no pending requests for N ms (default 500)
- `page.waitForNavigation()` now SPA-aware -- falls back gracefully when no `loadEventFired` fires

### New: hybrid mode
- `mode: 'hybrid'` in `browse()` -- tries headless, detects challenge pages (Cloudflare, etc.), falls back to headed
- Challenge detection via ARIA tree heuristic ("Just a moment", "Checking your browser", etc.)

### New: CLI
- `npx barebrowse mcp` -- start MCP server
- `npx barebrowse install` -- auto-configure MCP clients
- `npx barebrowse browse <url>` -- one-shot browse, print snapshot to stdout

### New: documentation
- `README.md` -- complete guide: idea, token savings, modes, library vs MCP, bareagent wiring
- `barebrowse.context.md` -- LLM-consumable integration guide for AI assistants
- `docs/testing.md` -- test pyramid, all 54 tests documented, CI guidance
- `docs/blueprint.md` -- updated with full 10-step pipeline, module table, integration sections

### Changed
- `package.json` -- subpath exports (`./bareagent`), `bin` entry, keywords
- `src/index.js` -- stealth auto-applied in headless via `createPage()`, `type()` param renamed to avoid shadowing
- `src/interact.js` -- `getCenter()` reused by new `hover()` function

### Tests
- 54 tests passing (was 47 in 0.1.0)
- All existing tests unchanged and passing

---

## 0.1.0

Initial release. CDP-direct browsing with ARIA snapshots.

### Core
- `browse(url, opts)` -- one-shot: URL in, pruned ARIA snapshot out
- `connect(opts)` -- session: navigate, interact, observe across pages
- Three modes: headless (default), headed (connect to running browser)
- Zero required dependencies, vanilla JS, ES modules, Node >= 22

### Modules
- `src/cdp.js` -- WebSocket CDP client with flattened session support
- `src/chromium.js` -- find/launch any installed Chromium browser
- `src/aria.js` -- format ARIA tree as YAML-like text
- `src/auth.js` -- cookie extraction from Firefox (SQLite) and Chromium (AES + keyring)
- `src/prune.js` -- 9-step ARIA pruning pipeline (47-95% token reduction)
- `src/interact.js` -- click, type (with clear), press (14 special keys), scroll
- `src/consent.js` -- auto-dismiss cookie consent dialogs (7 languages, 16+ sites tested)

### Features
- Cookie injection from Firefox/Chromium into headless CDP sessions
- Permission suppression (notifications, geolocation, camera, mic) via launch flags + CDP
- Cookie consent auto-dismiss across EN, NL, DE, FR, ES, IT, PT
- `waitForNavigation()` for post-click page loads
- Unique temp dirs per headless instance to avoid profile locking

### Tests
- 47 tests across 5 files (unit: prune, auth, cdp; integration: browse, interact)
- Real-site testing: Google, Wikipedia, GitHub, DuckDuckGo, YouTube, HN, Reddit
