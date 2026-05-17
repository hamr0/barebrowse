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

---

## [2026-05-17] switchTab() didn't actually switch the working session (F4)

**Symptom:** After `page.switchTab(1)`, subsequent `snapshot()`/`click()`/`type()` still operated on the original tab. The new tab was foregrounded in the UI but the closure `page` variable still pointed at the original `sessionId`.
**Root cause:** `Target.activateTarget` only brings a target to the front; it does not change which CDP session a caller is using. Driving a different target requires `Target.attachToTarget` and using the resulting sessionId.
**Fix:** `switchTab()` (src/index.js) now attaches to the new target's session via a new `attachToExistingTarget()` helper, reassigns the closure `page` variable, clears `refMap` (refs from the prior tab are invalid), wires the dialog handler on the new session, and detaches from the old session.
**Regression test:** `test/integration/connect.test.js` — "switchTab actually swaps the working session (F4)" (opens a second tab via `Target.createTarget`, switches, asserts `snapshot()` shows the new tab content and not the old)

---

## [2026-05-17] refMap leaked stale refs across navigations (F5)

**Symptom:** `page.click(ref)` after `goto()` (without an intervening `snapshot()`) silently resolved to whatever backendNodeId from the previous page happened to still be in `refMap` — yielding wrong-element clicks or opaque "Node was destroyed" CDP errors instead of a clear failure.
**Root cause:** `refMap` was only repopulated inside `snapshot()` (src/index.js:244). `goto()` did not invalidate it, so refs from the old page persisted until the next snapshot rebuilt the map.
**Fix:** Clear `refMap = new Map()` at the start of `goto()`. (F4 already invalidates on `switchTab`.) `click()`/`type()`/`hover()`/etc. now throw the existing `No element found for ref "X"` clearly.
**Regression test:** `test/integration/connect.test.js` — "goto invalidates refMap so stale refs error clearly (F5)" (goto A → snapshot → goto B → click(refFromA) should reject with "No element found").

Also hardened `cleanupBrowser()` profile-dir rm with a brief ENOTEMPTY/EBUSY retry loop to absorb Chromium's post-exit file flushing — the F2 test was occasionally flaky under load.

---

## [2026-05-17] withRetry replayed non-idempotent ops on transient failures (F6)

**Symptom:** A transient CDP error mid-`click`/`type`/`upload`/`drag`/`press`/`scroll`/`back`/`forward` would null the session and re-execute the same call against a brand-new page that had no URL or auth state. The user got a confusing "no element found" instead of the real CDP error, and any first-attempt side effects (e.g. a partial form submit) could be replayed on a different page state.
**Root cause:** `withRetry(fn, timeoutMs)` in `mcp-server.js` always retried on transient errors. Designed for `goto`/`snapshot` where re-execution is safe — not for state-mutating tools.
**Fix:** `withRetry` now accepts `{ retry = true }`. Idempotent tools (`goto`, `snapshot`, `pdf`) keep the default; state-mutating tools (`click`, `type`, `press`, `scroll`, `back`, `forward`, `drag`, `upload`) pass `{ retry: false }`. The session is still nulled on transient failure so the next request gets a fresh page.
**Regression test:** `test/unit/mcp.test.js` — "with retry:false runs the fn exactly once on transient failure (F6)" and "with retry:false still throws non-transient errors normally (F6)"





