# Implementation Log

Chronological record of what changed and why. For detailed changelogs, see `/CHANGELOG.md`.

---

## v0.2.1 (2026-02-22)

- README rewritten: no code blocks, obstacle table, two usage paths (MCP vs framework)
- MCP auto-installer: `npx barebrowse install` detects Claude Desktop, Cursor, Claude Code
- MCP config uses `npx` instead of local file paths

## v0.2.0 (2026-02-22)

Major release: agent integration layer.

**New modules:**
- `mcp-server.js` -- JSON-RPC 2.0 over stdio, 7 tools, singleton session
- `src/bareagent.js` -- tool adapter for bareagent Loop, 9 tools, auto-snapshot
- `src/stealth.js` -- navigator patches for headless anti-detection
- `cli.js` -- `npx barebrowse mcp|install|browse`

**New features:**
- Hybrid mode (try headless, fallback to headed on bot detection)
- `page.hover(ref)`, `page.select(ref, value)`, `page.screenshot(opts)`
- `page.waitForNetworkIdle(opts)` -- resolve when no pending requests
- SPA-aware `waitForNavigation()`

**Docs:**
- `barebrowse.context.md` -- LLM integration guide
- `docs/testing.md` -- test pyramid, all 54 tests
- `docs/blueprint.md` -- full pipeline, module table

**Tests:** 54 passing (was 47)

## v0.1.0 (2026-02-22)

Initial release. CDP-direct browsing with ARIA snapshots.

**Core modules (7):**
- `src/index.js` -- `browse()`, `connect()` API
- `src/cdp.js` -- WebSocket CDP client
- `src/chromium.js` -- browser discovery and launch
- `src/aria.js` -- ARIA tree formatting
- `src/auth.js` -- cookie extraction (Firefox SQLite, Chromium AES + keyring)
- `src/prune.js` -- 9-step pruning pipeline (ported from mcprune)
- `src/interact.js` -- click, type, press, scroll
- `src/consent.js` -- cookie consent auto-dismiss (7 languages, 16+ sites)

**Tests:** 47 passing across 5 files

---

*Add new entries at the top. Include version, date, and what changed.*
