# Changelog

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
