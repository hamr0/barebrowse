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

---

## [2026-05-17] createTab() skipped the dialog handler (F7)

**Symptom:** A JS dialog (alert/confirm/prompt) fired inside a sub-tab hung navigation forever — `Page.loadEventFired` never fired because the script that triggered the dialog blocked, and nothing was there to handle/dismiss it.
**Root cause:** `setupDialogHandler()` was wired on the main page's session (and on every hybrid-fallback session) but `createTab()` (src/index.js) created a new target/session without calling it.
**Fix:** Add `setupDialogHandler(tab.session)` after `createPage`/`suppressPermissions` in `createTab()`. The `dialogLog` closure is shared, so dialogs from tabs land in the outer `page.dialogLog`.
**Regression test:** `test/integration/connect.test.js` — "createTab wires dialog handler so dialogs do not hang navigation (F7)" (creates a tab, navigates to `data:text/html,<script>alert("from-tab")</script>` with a 10s timeout, asserts the alert is captured in `dialogLog`).

---

## [2026-05-17] goBack/goForward used a fixed 500ms sleep instead of awaiting navigation (F8)

**Symptom:** `snapshot()` immediately after `goBack()` could capture the prior page when the back navigation took >500ms; on instant SPA navs the 500ms was wasted latency.
**Root cause:** Both methods called `Page.navigateToHistoryEntry` then `setTimeout(500)` — no listener on `Page.loadEventFired`.
**Fix:** Subscribe to `Page.loadEventFired` (30s timeout) before sending the history-nav command; await it after. On timeout (SPA pushState/replaceState — no load event), fall back to the original 500ms settle. Also clear `refMap` (refs from the prior page are now invalid — same reason as F5).
**Regression test:** `test/integration/connect.test.js` — "goBack/goForward await navigation before returning (F8)" (goto A → goto B → goBack, assert snapshot shows A and not B; goForward, assert snapshot shows B).

---

## [2026-05-17] waitForNetworkIdle counter could desync and resolve early (F9)

**Symptom:** When `Network.loadingFinished` arrived for a request whose `Network.requestWillBeSent` was never seen by the listener (e.g. request started before `waitForNetworkIdle` attached), the pending-request counter went negative, and the `pending <= 0` guard could resolve before a real in-flight request finished.
**Root cause:** Plain integer counter in `src/index.js:577-613` had no per-request bookkeeping.
**Fix:** Extracted to `src/network-idle.js` (matches project's module split pattern). Track requestIds in a `Set` — `pending.add()` on `requestWillBeSent`, `pending.delete()` on `loadingFinished`/`loadingFailed`. `delete()` on an unknown key is a no-op, so orphan finish events are harmless. Resolve only when the set is empty for `idle` ms.
**Regression test:** `test/unit/network-idle.test.js` — five cases including the load-bearing one: "orphan loadingFinished events do not resolve early (F9)" (fires three orphan finishes then a real request/finish, asserts the wait correctly held until the real request completed).

---

## [2026-05-17] connect()/browse() silently ignored binary + userDataDir opts (L2)

**Symptom:** Documented `binary` and `userDataDir` options on `connect()` (MEMORY.md) had no effect — `findBrowser()` always ran and a random `/tmp/barebrowse-*` profile was always created. Callers wanting a specific browser binary or persistent profile dir had no path.
**Root cause:** Neither `browse()` (src/index.js:32-118) nor `connect()` (src/index.js:127-138) read these options off `opts`. They built `launch({ proxy, headed })` and dropped everything else.
**Fix:** Both functions now build a `launchOpts = { proxy, binary, userDataDir }` once and forward to every `launch()` call — including the two hybrid-fallback re-launches inside `goto()`. (The `port` option for attach-to-running-browser is deferred to H1.)
**Regression test:** `test/integration/connect.test.js` — "connect() forwards binary opt to launch (L2)" (bogus binary path rejects with ENOENT) and "connect() forwards userDataDir opt to launch (L2)" (Chromium populates the caller's dir, proving the option reached launch).

---

## [2026-05-17] connect() spawned a clone instead of driving the user's running browser (H1)

**Symptom:** `connect({ mode: 'headed' })` always launched a fresh Chromium with an empty temp profile. There was no way to attach to a browser the user had already started (e.g. `chromium --remote-debugging-port=9222`), so headed mode could not actually drive the user's logged-in session — defeating the entire promise of headed mode. `getDebugUrl(port)` already existed at `chromium.js:149` but was never imported anywhere.
**Root cause:** `connect()` had no port path; it ignored `opts.port` (an L2 leftover, deliberately deferred to H1) and hardcoded `launch()` for every mode.
**Fix:** New `attach({ port })` helper in `src/chromium.js` returns a browser handle with `process: null, ownedProfileDir: null` — `cleanupBrowser()` is intentionally a no-op on that shape so we never kill a browser we didn't start. `connect()` now detects `opts.port` and uses `attach()` instead of `launch()`. In attach mode: stealth is skipped (it would persist via `addScriptToEvaluateOnNewDocument` in the user's session), `Browser.setPermission` is skipped (it's browser-wide here — would leak deny-states into the user's other tabs), and the two hybrid-fallback branches in `goto()` are gated off (we can't tear down a browser we don't own). `close()` still closes the tab we created via `Target.closeTarget` — only the browser process is left alone.
**Regression test:** `test/integration/connect.test.js` — "connect({ port }) attaches to a running browser and leaves it alive on close (H1)" (launches a Chromium with a known port, attaches via `connect({ port })`, navigates + snapshots, asserts the underlying process's `exitCode` is still `null` after `close()`, then re-attaches and repeats to prove the browser kept running).

---

## [2026-05-17] Iframes were invisible to snapshot and unclickable (H2)

**Symptom:** `Accessibility.getFullAXTree` stops at frame boundaries. Stripe checkouts, reCAPTCHA, embedded login widgets, embedded ads — any meaningful third-party iframe — never appeared in `snapshot()` output. Clicks targeting elements inside iframes either failed outright or hit the wrong DOM node.
**Root cause:** The original `ariaTree()` called `Accessibility.getFullAXTree` once on the page session and called it done. No traversal of child frames, no per-frame session routing, no merging.
**Fix:** Full OOPIF pipeline. `createPage()` now calls `Target.setAutoAttach({ autoAttach: true, flatten: true })` and listens for `Target.attachedToTarget` events to register each iframe's child session in a `framesByFrameId` map (recursively, so nested iframes also attach). `ariaTree()` walks `Page.getFrameTree`, fetches each frame's AX tree on its child session (or main session with frameId param for same-origin), and splices child trees under their iframe placeholders identified via `DOM.getFrameOwner` (NOT `Page.getFrameOwner` — that one doesn't exist; cost me one wasted iteration). Refs become globally unique via a flat counter shared across frames; refMap now maps ref → `{ session, backendNodeId }` so `click()`/`type()`/`hover()`/`select()`/`upload()` route to the correct CDP session — essential because each OOPIF frame has its own Input domain with its own viewport coords. `drag()` rejects cross-frame drags rather than mixing sessions. The visible `[ref=N]` format is unchanged so existing agent prompts and CLI parsers (`/\[ref=(\d+)\]/`) keep working.

Also added `--site-per-process` to launch flags so every iframe — including same-origin — becomes OOPIF with its own session. Without this, same-origin iframes stay in the parent process: `getFullAXTree({ frameId })` works for reading, but `DOM.getBoxModel` for iframe-internal nodes returns frame-local coords while `Input.dispatchMouseEvent` on the parent session uses parent-viewport coords, so clicks miss. The OOPIF path sidesteps that: each frame has its own Input domain that natively handles its own coords.

**Regression test:** `test/integration/connect.test.js` — "snapshot surfaces iframe content + clicks resolve to the iframe session (H2)" (outer data: URL with an iframe whose button rewrites its own label on click; asserts iframe content is visible in the merged snapshot, pulls the button's ref out, calls `click(ref)`, and re-snapshots to confirm the new label appears — proving the click dispatched in the iframe session, not the parent).

---

## [2026-05-17] connect() had no reload() method (H3)

**Symptom:** No way to refetch the current page short of `goto(currentUrl)` (which loses query state) or dropping to `page.cdp.send('Page.reload')` manually. A trivial gap in the public API.
**Fix:** New `page.reload({ ignoreCache, timeout })` method on the connect() handle. Subscribes to `Page.loadEventFired` (configurable timeout, default 30s), sends `Page.reload({ ignoreCache })`, awaits the load event with the same SPA-fallback as `goBack`/`goForward` (500ms settle if no load fires), and clears `refMap` so refs captured pre-reload are rejected by `click()`/`type()`/etc — same invalidation contract as `goto`. MCP exposure deferred to H6.
**Regression test:** `test/integration/connect.test.js` — "reload() refetches the current page and invalidates refMap (H3)" (snapshots, captures a ref, reloads, asserts click(stale-ref) rejects with "No element found", then snapshots again to confirm content is back; runs once with default options and once with `{ ignoreCache: true }`).









