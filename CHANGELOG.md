# Changelog

## 0.3.2

- Skill install table in README: per-agent instructions for Claude Code, Cursor, Windsurf, Copilot (project + global scope)
- Clarified that `npm install barebrowse` is still required — the skill file is documentation only
- New: `docs/skill-template.md` — generic template for any CLI tool to create a skill file, with frontmatter reference, install locations, and skill-vs-MCP comparison

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
