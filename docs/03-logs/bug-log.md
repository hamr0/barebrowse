# Bug Log

Track bugs: symptom, root cause, fix, regression test.

---

## [2026-03-19] Timeout bypasses auto-retry

**Symptom:** `goto` on a slow site (braunhousehold.nl) returned `Tool "goto" timed out after 30s` with no retry. The `withRetry()` mechanism from v0.7.0 was supposed to handle this but never fired.
**Root cause:** The 30s timeout was a `Promise.race` in the MCP transport layer, *outside* `withRetry()`. When it fired, it rejected the entire call — `withRetry` was still blocked inside and its result was discarded. Additionally, `isCdpDead()` didn't match timeout error messages, so even internal CDP timeouts wouldn't trigger a retry.
**Fix:** Moved per-attempt timeout inside `withRetry()` (mcp-server.js:29-48). Renamed `isCdpDead()` to `isTransient()` to also match timeout errors. Removed outer `Promise.race`. Each retry attempt now gets its own deadline.
**Regression test:** `test/unit/mcp.test.js` — "retries once on timeout", "retries once on transient CDP error", "does not retry non-transient errors"

---

## [2026-05-17] page.cdp escape hatch went stale after hybrid fallback (F1)

**Symptom:** `page.cdp` (the raw-CDP escape hatch returned from `connect()`) silently pointed at a closed session after hybrid headless→headed fallback fired. `src/daemon.js` attaches console + network listeners on `page.cdp` at startup, so `--console-logs` and `--network-log` returned empty after any fallback.
**Root cause:** `cdp: page.session` (index.js:393) captured the session by value at object-creation time. Hybrid fallback in `goto()` reassigns the local `page` variable but the data property held the old reference.
**Fix:** Convert to a getter — `get cdp() { return page.session; }` (index.js:393). Reads now resolve via closure on every access.
**Regression test:** `test/integration/connect.test.js` — "exposes page.cdp as a getter so it survives session swaps (F1)"

---

## [2026-05-17] Temp profile dirs leaked on every launch (F2)

**Symptom:** Every `launch()` created `/tmp/barebrowse-${pid}-${ts}` and never removed it. Hybrid mode doubled the leak per session; long-running MCP/daemon servers and test suites accumulated dozens of stale dirs.
**Root cause:** `chromium.js:98` generated the path inline with no record of its existence. Callers killed the process but had no path to clean.
**Fix:** `launch()` now records the dir it owns as `browser.ownedProfileDir` (null for caller-supplied dirs). New `cleanupBrowser(browser)` helper kills the process, awaits exit (up to 2s — Chromium holds files briefly after SIGTERM), then `rmSync`. All `browser.process.kill()` call sites in `src/index.js` and `test/unit/cdp.test.js` replaced with `await cleanupBrowser(browser)`.
**Regression test:** `test/unit/cdp.test.js` — "cleanupBrowser removes the owned temp profile dir (F2)", "cleanupBrowser leaves user-supplied profile dirs alone (F2)"

---

## [2026-05-17] Browser orphaned when parent process crashed (F3)

**Symptom:** If Node SIGKILLed or `uncaughtException` fired (mcp-server.js handler only nulled `_page`), the spawned Chromium kept running indefinitely, holding its CDP port and temp profile dir.
**Root cause:** `chromium.js` had no module-level tracking of spawned browsers and no process-exit handlers.
**Fix:** `chromium.js` now keeps a module-level `activeBrowsers` Set. `launch()` registers `process.once('exit'|'SIGINT'|'SIGTERM'|'SIGHUP')` handlers (one-time per module) that SIGKILL all tracked browsers, poll for actual death (up to 1s), then `rmSync` their owned profile dirs. Browsers auto-untrack on natural exit or `cleanupBrowser()`.
**Regression test:** `test/unit/cdp.test.js` — "reaps the browser when the parent process is signaled (F3)" (spawns `test/fixtures/launch-and-wait.mjs`, SIGTERMs it, asserts the browser PID and profile dir are gone)


