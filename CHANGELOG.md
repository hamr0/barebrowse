# Changelog

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
