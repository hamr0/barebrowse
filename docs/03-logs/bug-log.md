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

---

## [2026-05-17] Stealth was incomplete — UA, WebGL, hardware, Notification all leaked headless (H4)

**Symptom:** `src/stealth.js` only patched `navigator.webdriver`, plugins, languages, a stub `window.chrome`, and `Permissions.query`. Five obvious headless tells remained: (1) `navigator.userAgent` still contained "HeadlessChrome" because `--headless=new` doesn't strip it; (2) WebGL `UNMASKED_VENDOR_WEBGL` returned "Google Inc. (Google)" and `UNMASKED_RENDERER_WEBGL` returned "Google SwiftShader" — the single most-used headless fingerprint; (3) `navigator.hardwareConcurrency` and (4) `navigator.deviceMemory` reported container defaults that real desktops rarely have; (5) `typeof Notification === 'undefined'` in headless Chrome regardless of secure context, while real Chrome always exposes the constructor and reports `Notification.permission === 'default'` before any prompt.
**Fix:** `applyStealth()` now also runs `Network.setUserAgentOverride` with the real UA returned by `Browser.getVersion`, just with `HeadlessChrome` rewritten to `Chrome` — keeps the version + platform fields accurate across Chromium releases instead of hardcoding a stale UA. The injected `STEALTH_SCRIPT` now also patches: `WebGLRenderingContext.prototype.getParameter` (and `WebGL2`) to return `Intel Inc.` / `Intel Iris OpenGL Engine` for parameters 37445 and 37446; `navigator.hardwareConcurrency` and `navigator.deviceMemory` to 8; the full `chrome.runtime` enum shape (PlatformOs, OnInstalledReason, …) that real Chrome ships even with no extensions; and the Notification API — when missing entirely we fake the constructor + `permission: 'default'` + a no-op `requestPermission()`; when present we just override the `permission` getter. `Permissions.query` for notifications now reflects `Notification.permission` instead of returning a hardcoded `'prompt'` (which was itself a tell).
**Regression test:** `test/integration/stealth.test.js` — new file. Spins up a localhost HTTP server (`127.0.0.1` is a "potentially trustworthy" origin per the Secure Contexts spec, so `Notification` is observable from there — `data:`/`about:blank` are insecure and the API is hidden) and asserts `navigator.webdriver`, the cleaned UA, `hardwareConcurrency`, `deviceMemory`, `Notification.permission`, `chrome.runtime.PlatformOs`, both WebGL UNMASKED params, plugin count, and languages all read as the spoofed values.

---

## [2026-05-17] Blanket 30s MCP timeout was wrong in both directions (H5)

**Symptom:** Every MCP tool shared a single 30s `withRetry` deadline. `goto` regularly exceeded it on SPA cold loads (the v0.7.0 fix surfaced this — see "Timeout bypasses auto-retry" above), while `scroll`/`press`/`click` waited 30s before failing on dead sessions when they should give up in <15s.
**Fix:** New `TIMEOUTS` table in `mcp-server.js`, exported so tests can pin it. Split: `goto`/`reload`/`wait_for` get 60s (SPA cold loads); `back`/`forward` get 30s (navigation); `click`/`type`/`press`/`scroll`/`hover`/`select`/`drag`/`snapshot`/`eval` get 15s (interactive/read ops); `tabs` gets 5s (instant); `pdf`/`screenshot`/`upload` get 45s (heavy I/O). Every `handleToolCall` site now reads `TIMEOUTS[name]` instead of a hardcoded literal.

Also wrapped the stdin transport + `unhandledRejection` / `uncaughtException` / `SIGINT` / `SIGTERM` handlers in an `if (isMain)` block (URL match between `import.meta.url` and `pathToFileURL(process.argv[1])`). Without this, `import { TIMEOUTS } from 'mcp-server.js'` from a test would attach a stdin reader that consumes the test runner's stdin, install signal handlers that intercept Ctrl-C, and register `process.exit(0)` callbacks. Same isMain pattern baremobile uses for its MCP server.

**Regression test:** `test/unit/mcp.test.js` — new "per-tool MCP timeouts (H5)" describe block with five assertions pinning each timeout. Reverts to the blanket 30s fail loudly.

---

## [2026-05-18] MCP was missing half its surface — screenshot/eval/wait_for/tabs/select/hover/reload (H6)

**Symptom:** `connect()` API, daemon, CLI, and `bareagent` adapter all exposed `screenshot`/`wait_for`/`tabs`/`select`/`hover`/`reload` (and the powerful `eval` escape hatch in CLI/daemon), but the MCP server only registered 12 tools — none of these. Claude Desktop / Cursor / Code agents couldn't reach them at all, forcing snapshot-only workflows and round-trips through `back`/`forward` instead of `reload`.
**Fix:** Added all six as MCP tools in `mcp-server.js` with matching schemas, hooked into the `TIMEOUTS` table from H5 (`reload`: 60s; `screenshot`: 45s; `wait_for`: 60s; `tabs`: 5s; `select`/`hover`: 15s). `screenshot` saves the image to `.barebrowse/screenshot-*.{png,jpeg,webp}` and returns the file path (consistent with the snapshot save-to-file convention; raw base64 in a JSON-RPC response would blow `maxChars`). `tabs` either returns the JSON list or accepts `switchTo: N` to switch — one tool, two behaviors. Mutating tools use `{ retry: false }` since `withRetry` would replay them on a fresh page.

**eval is gated behind `BAREBROWSE_MCP_EVAL=1`** — default off. Per the H6 discussion, `Runtime.evaluate` in the user's authenticated session is the load-bearing risk: an LLM agent with eval can read cookies/`localStorage`, hit any same-origin endpoint, post on the user's behalf. CLI/connect() keep it because the developer is the caller; MCP exposes the same primitive to an agent acting with less judgment. The opt-in env var makes the operator make a deliberate choice. The tool is registered conditionally at module load, AND the handler re-checks the env var as a second line of defense.

**Regression test:** `test/unit/mcp.test.js` — new "MCP tool surface (H6)" describe block. (1) Asserts every new tool name is in the exported `TOOLS` array. (2) Asserts `eval` is absent when `BAREBROWSE_MCP_EVAL` is unset (the normal test run). (3) Spawns a child node with `BAREBROWSE_MCP_EVAL=1` set and a one-shot probe that imports `mcp-server.js` and stdouts whether `eval` is registered — proves the opt-in actually flips the registration.

---

## [2026-05-18] Downloads were silently going nowhere useful (H7)

**Symptom:** Any `Content-Disposition: attachment` response (file downloads from forms, "Export" buttons, etc.) was either dropped (headless Chromium default = no download path configured) or routed to the Chromium default location which is unpredictable from the caller's perspective. There was no way for the agent to know a download happened, let alone where the file landed.
**Fix:** `connect()` now wires `Browser.setDownloadBehavior({ behavior: 'allowAndName', downloadPath, eventsEnabled: true })` at setup. If the caller doesn't supply `opts.downloadPath`, we create a per-session directory under `/tmp/barebrowse-dl-*` and clean it up on `close()` (caller-supplied paths stay — caller owns the lifecycle). Subscribes to `Browser.downloadWillBegin` and `Browser.downloadProgress`. Exposes a live `page.downloads` array of `{ guid, url, suggestedFilename, savedPath, state, totalBytes, receivedBytes }` — `state` cycles through `inProgress` → `completed`/`canceled`. Falls back to `'allow'` if `'allowAndName'` isn't accepted by older Chrome; falls back to silent if neither works (downloads still happen, we just can't observe them). Skipped entirely in attach mode — we don't override the user's running browser's download preference.
**Regression test:** `test/integration/connect.test.js` — "downloads array captures Content-Disposition attachments (H7)" (spins up a localhost server that returns `Content-Disposition: attachment; filename="hello.txt"` with a known payload; navigates to it; polls `page.downloads` until a `completed` entry shows up; asserts `suggestedFilename`, `state`, and that the file at `savedPath` contains the exact server payload).

---

## [2026-05-18] Dialog handler auto-accepted everything with no override (H8)

**Symptom:** The infrastructure existed (`setupDialogHandler` wired `Page.javascriptDialogOpening` and called `Page.handleJavaScriptDialog`) but the decision was hardcoded — accept everything except `beforeunload`. Callers could read `dialogLog` after the fact but couldn't influence the dialog reply. Use cases blocked: rejecting a confirm() to test the "cancel" branch, supplying a known string to a prompt(), exercising beforeunload accept logic.
**Fix:** `setupDialogHandler` now checks a closure variable `onDialogHandler` after pushing the log entry. If set, calls it with `{ type, message, defaultPrompt }`, awaits the result, and uses `{ accept, promptText }` to override the defaults. Handler exceptions are swallowed back to defaults so a buggy handler doesn't hang the page on a never-replied dialog. New `page.onDialog(handler)` method on the connect() return — pass `null` to restore the default. Handler is persistent across hybrid fallback, switchTab, createTab (every `setupDialogHandler` call reads the same closure variable).
**Regression test:** `test/integration/connect.test.js` — "onDialog handler overrides the default auto-accept (H8)" (installs a handler that rejects confirm and supplies a custom string to prompt; the page writes both results back into the DOM via `document.getElementById('c').textContent = 'CONFIRM-' + c`; snapshot proves the dialog replies reached the JS context; then removes the handler with `page.onDialog(null)` and confirms a fresh dialog auto-accepts again).

---

## [2026-05-18] isChallengePage flagged legitimate small + error pages as bot challenges (H9)

**Symptom:** The hybrid-fallback gate `isChallengePage(tree, nodeCount)` had two false-positive classes: (1) `nodeCount < 50` alone triggered on any minimal legitimate page — 404s, simple landings, status pages, single-button consent pages — kicking hybrid mode into a costly headed-browser launch for nothing; (2) generic phrases `'access denied'`, `'permission denied'`, `'unknown error'`, `'file a ticket'` in the always-fire list flagged real HTTP 4xx/5xx error pages as challenges, again forcing the headed fallback on legitimate errors.
**Fix:** Split into STRONG_PHRASES (essentially-unambiguous challenge UI like Cloudflare's "Just a moment", "Attention Required", "verify you are human", "checking your browser") that fire alone regardless of page size, and WEAK_PHRASES (the previously over-eager phrases) that only fire when the page is ALSO tiny (`nodeCount < 30` OR `text.length < 50`). Pure low-node-count without any phrase no longer flags — that path was the noisiest source of false fallbacks. `tree === null` still flags as a sentinel for "AX tree fetch failed". Exported `isChallengePage` so the unit tests can pin the contract.
**Regression test:** `test/unit/challenge.test.js` — new file, nine tests. Three sections: strong phrases fire on content-rich pages (Just-a-moment, verify-you-are-human, Attention-Required); generic phrases do NOT flag a real 403 with "access denied" body or a real 500 with "unknown error" body (the load-bearing pre-H9 false positives) but DO still flag when on a near-empty page; small legitimate pages (5-node landing, 4-node 404) no longer auto-flag; null tree still flags.









