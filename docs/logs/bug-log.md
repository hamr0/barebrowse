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

---

## [2026-05-18] `npx barebrowse mcp` silently hung — H5 isMain guard was too strict

**Symptom:** The MCP server never responded to `tools/list` (or anything) when launched via the documented Claude Code install path `claude mcp add barebrowse -- npx barebrowse mcp`. The server appeared to start (Node was running) but stdin was never read; the client hung waiting for `initialize` to come back. Caught by a Phase B code-review pass.
**Root cause:** My H5 commit guarded the stdio loop with `if (isMain)` where `isMain = import.meta.url === pathToFileURL(process.argv[1]).href`. But `cli.js` line 20 launched the server via `await import('./mcp-server.js')` — `process.argv[1]` is `cli.js`, not `mcp-server.js`, so `isMain` was false and the stdin handler never registered. The H5 unit test only checked that `TIMEOUTS`/`TOOLS` could be imported without spawning the loop, never that the loop actually started in the real invocation.
**Fix:** Refactored mcp-server.js to export `runStdio()`. `cli.js` now calls it explicitly after `import('./mcp-server.js')`. The original "auto-start on direct `node mcp-server.js`" path is preserved (the isMain check still fires `runStdio()` when this file IS argv[1]).
**Regression test:** `test/unit/mcp.test.js` — "the JSON-RPC loop actually starts when invoked via cli.js mcp (regression)" spawns `node cli.js mcp` for real, sends a `tools/list` JSON-RPC line on stdin, asserts a response comes back within 5s with the full tool array. This would have caught the bug.

Same pass also cleaned up two unrelated nits flagged by the same review: `mcp-server.js` `serverInfo.version` no longer hardcodes "0.7.1" (reads from `package.json` at startup); `src/index.js` download-event listeners are now registered BEFORE `Browser.setDownloadBehavior` is sent, eliminating a theoretical race (microscopic — about:blank can't initiate a download — but ordering it correctly costs nothing).

---

## [2026-05-18] H3/H7 features unreachable from CLI / daemon / bareagent (Phase B loose end)

**Symptom:** H3 added `page.reload()`, H7 added `page.downloads`, H8 added `page.onDialog()` — all reachable from `connect()` directly, but the CLI session daemon (`src/daemon.js`) had no handlers for them and `cli.js` had no subcommands. `barebrowse open ...` then `barebrowse reload` was a no-op error; downloads triggered during a CLI session were silently lost. `src/bareagent.js` likewise hadn't been extended, so the bareagent Loop adapter was missing 4 tools relative to the MCP server.
**Fix:** `src/daemon.js` gained `reload({ ignoreCache })` and `downloads()` handlers; `cli.js` gained `barebrowse reload [--no-cache]` and `barebrowse downloads` subcommands plus `--download-path=DIR` flag forwarding through `startDaemon` → `runDaemonInternal` → `connect()`. `src/bareagent.js` gained `reload`, `wait_for`, and `downloads` tools (with the same shape as their MCP counterparts). `onDialog` is a callback-shape primitive that doesn't fit the request/response CLI model — `dialog-log` (read-only history) already covers the CLI use case, and bareagent users wanting to override dialogs should drop to `import { connect }` directly. Usage text updated.
**Regression test:** `test/integration/cli.test.js` — two new tests: "reload subcommand round-trips through daemon (H3 via CLI)" and "downloads subcommand returns the downloads array (H7 via CLI)".

---

## [2026-05-18] `mode: 'read'` was a documented-but-fake pruning mode + MCP/bareagent could not request it anyway

**Symptom:** Agents using barebrowse via the MCP server (and CLI users following SKILL.md's `--mode=read` advice) consistently saw paragraph-heavy pages — blog posts, docs, wikis — come back nearly empty in the snapshot. Claude regularly fell back to WebFetch after a single barebrowse round-trip, even though the page had legitimate content. The CLI subcommand `barebrowse snapshot --mode=read` documented in `commands/barebrowse/SKILL.md` (and `cli.js:464` `--prune-mode=act|read` help text) appeared to do nothing different from `--mode=act`.
**Root cause:** Two compounding bugs. (1) `read` mode was never wired in `prune()` — `src/prune.js:67-70` defined `MODE_REGIONS = { act, browse, navigate, full }` and used `MODE_REGIONS[mode] || MODE_REGIONS.act` as a fallback. Passing `mode: 'read'` hit the fallback (act regions) AND missed the `isBrowse = mode === 'browse'` check, so every `if (ctx.mode === 'act')` branch fired. Output was bit-identical to act mode. The SKILL.md, CLI help, and `commands/barebrowse.md` had all advertised `read` since v0.3, but it never existed in code. (2) The MCP `browse`/`snapshot` tools and bareagent `browse`/`snapshot` tools had no `pruneMode` param at all — `mcp-server.js:147-156, 170-179` only accepted `mode` (browser mode, not prune mode) and `maxChars`. Handlers called `browse(args.url, { mode: args.mode })` and `page.snapshot()` with no second arg, so prune mode was always 'act'. Same shape in `src/bareagent.js:45-57, 71-78`. Only the CLI exposed the knob — and even then it was a knob with no spindle.
**Fix:** `src/prune.js` — alias `read` → `browse` at the top of `prune()`: `let { mode = 'act', context = '' } = options; if (mode === 'read') mode = 'browse';`. One line, zero other changes — `act|browse|navigate|full` are untouched. `mcp-server.js` — `browse` and `snapshot` tools gained `pruneMode: { type: 'string', enum: ['act', 'read'] }` with descriptions that tell the agent when to pick `read` (articles, docs, content extraction); handlers forward it. `src/bareagent.js` — same param shape on both tools; the `browse` handler defends against clobbering a caller-supplied `opts.pruneMode` when the tool is invoked without the arg via `pruneMode ? { ...opts, pruneMode } : opts`. `src/index.js` — both snapshot paths (`browse()` and the `page.snapshot()` method) now emit a single `hint: act mode dropped most of the page — retry with pruneMode='read' …` line between stats and tree when the heuristic fires: `actMode && raw.length > 5000 && pruned.length < 500 && pruned.length < raw.length * 0.05`. Thresholds chosen so an e-commerce/search-results page (where act mode legitimately keeps a few KB of interactive elements) does not trigger; a paragraph-heavy article (where act drops the body) does. False-positive cost is one extra tool call; miss cost was the WebFetch fallback.
**Regression test:** `test/unit/prune.test.js` — "aliases `mode='read'` to browse mode" asserts `prune(tree, {mode: 'read'})` deep-equals `prune(tree, {mode: 'browse'})` on a tree with a paragraph + button, and that paragraphs survive in the result (the act-mode-style stripping that previously masqueraded as read-mode is gone). 17 prune tests pass (was 16). Full unit suite 68/68 green; browse integration 16/16 green.










---

## [2026-10-14] MCP server orphaned its browser on every transient error (M1)

**Symptom:** Long-lived Claude windows each run one `barebrowse mcp` server; 8 idle headless browsers (~9 GB) were found held for 1–30h, one server owning 3. Repro: `goto` a page → `wait_for {text:'never-appears', timeout:500}` (error "waitFor timed out" is transient) → `snapshot` → the server owns 2 browsers.
**Root cause:** The five session-reset sites in `mcp-server.js` (`withRetry`, `assess` catch, `handleMessage` catch, `unhandledRejection`, `uncaughtException`) did `_page = null`, forgetting the page without closing it. The browser kept running and the next `getPage()` launched another.
**Fix:** New `resetPage()` takes `_page`, nulls it, and fire-and-forget `close()`s it; all five sites use it. `isTransient` and `wait_for` semantics are unchanged.
**Regression test:** `test/integration/mcp-lifecycle.test.js` — "a transient error closes the old browser instead of orphaning it" (spawns the real server, counts its browser processes via `--user-data-dir=/tmp/barebrowse-<pid>-`; red with 2 before the fix, 1 after)

---

## [2026-10-14] MCP server held an idle browser indefinitely (M2)

**Symptom:** A Claude window left open for days kept its `barebrowse mcp` server's headless browser alive (1–30h idle, ~1 GB each) long after the conversation moved on.
**Root cause:** The browser lived as long as the server; nothing released it when no tool was being called.
**Fix:** Idle TTL in `mcp-server.js`: `BAREBROWSE_IDLE_MINUTES` (default 15, `0` = off, invalid/negative → default, fractional allowed). Tracks in-flight `tools/call`s; the timer is stopped during a call and re-armed when it finishes; on fire, with nothing in flight and a page open, `resetPage()` closes it. Timer is `unref()`ed. The next call opens a fresh browser via `getPage()` (a new job, no resume). Uses only `page.close()`, so both engines work.
**Known, deliberately NOT fixed:** the server does not exit on stdin EOF (Claude already terminates its MCP servers); `kill -9` of a barebrowse process orphans its detached browser (since fixed on Linux: L3-L9); download temp dirs survive a SIGTERM stop of library users (since swept at next launch: L7).
**Regression test:** `test/integration/mcp-lifecycle.test.js` — "releases the browser after the idle TTL and reopens on the next call", "does not cut off a call that outlasts the TTL", "releases a Firefox browser too" (red without the fix: browser count stays 1 after idle)

---

## [2026-10-14] BAREBROWSE_IDLE_MINUTES parse: huge value closed the browser after every call, empty value disabled the TTL (M3)

**Symptom:** `BAREBROWSE_IDLE_MINUTES=50000` made the browser close right after every call (0 browsers 1.5s after a `goto`, confirmed on the live server). `BAREBROWSE_IDLE_MINUTES=` (empty/whitespace) silently turned the TTL off instead of using the 15-minute default.
**Root cause:** The parse was `Number(env ?? 15)` with a finite/non-negative check. (1) `50000 * 60_000` exceeds 2^31-1, so `setTimeout` overflows (TimeoutOverflowWarning) and fires after 1ms. (2) `Number('')` is `0`, which means "off".
**Fix:** Exported pure helper `idleMs(raw)` in `mcp-server.js`: undefined/blank/non-finite/negative → 15 min; `0` → 0 (off); otherwise `min(n * 60_000, 2**31-1)`.
**Regression test:** `test/unit/mcp.test.js` — "idleMs (BAREBROWSE_IDLE_MINUTES parse)" (red against the old formula for `''`, `'   '` and `'50000'`)

---

## [2026-10-14] page.close() leaked the profile dir and browser when the browser was dead or hung (M4)

**Symptom:** After a browser was `kill -9`'d (MCP repro: headless, `goto`, kill Chromium's main pid, `snapshot`), `/tmp/barebrowse-<serverpid>-*` stayed behind. With a hung-but-connected browser the whole process leaked too. Both engines.
**Root cause:** `close()` awaited the polite step (`Target.closeTarget` on Chromium, `browsingContext.close` on Firefox) with no timeout *before* the hard cleanup (`cleanupBrowser`/`cleanupFirefox`, owned download dir removal). A dead socket rejects (Chromium: uncaught, so cleanup was skipped) and a hung one never settles, so the cleanup never ran.
**Fix:** The polite step is best-effort and bounded (2.5s race; error swallowed; Firefox reuses its `withTimeout`), and the hard cleanup always runs (try/finally). Attach mode is unchanged: `cleanupBrowser` is a no-op there (`process: null`, `ownedProfileDir: null`), so a user's browser is never killed.
**Regression test:** `test/integration/close-cleanup.test.js` — "Chromium/Firefox: still reaps profile dir and processes" (kill -9 the browser main pid, `close()` must resolve within 8s and leave no processes or profile/download dirs; red before the fix: "close() hung on a dead browser", both engines)

---

## [2026-10-14] An ordinary wait_for timeout reset the MCP page (M5)

**Symptom:** `wait_for` for text that never appeared returned its error and also threw the agent's page away (next `snapshot` showed `about:blank`; the browser was closed and relaunched).
**Root cause:** `isTransient` in `mcp-server.js` matches `'timed out'`, which also matches `page.waitFor`'s own `waitFor timed out after Nms`. A wait that didn't find its text is a normal result, not a broken browser.
**Fix:** `isTransient` returns false for messages starting `waitFor timed out`. `withRetry`'s own per-attempt `timed out after Ns` and every other transient case are unchanged.
**Regression test:** `test/integration/mcp-lifecycle.test.js` — "an ordinary wait_for timeout keeps the page and browser" (same browser pid, snapshot still has the page; red before the fix: `about:blank`). The M1 test "a transient error closes the old browser…" used this timeout as its trigger and would have passed vacuously; it now kills the browser (`kill -9`) so the next call hits a dead socket, and asserts the old process and profile dir are gone (also red without M4).

## [2026-10-14] wait_for with timeout >= 60s still reset the MCP page (M6)

**Symptom:** `wait_for {text:'NOPE', timeout:65000}` returned `timed out after 60s` and the page and browser were wiped (profile dir gone seconds later). Found by self-review of M5.
**Root cause:** the outer `withRetry` deadline was the fixed `TIMEOUTS.wait_for` (60000) while `page.waitFor` honours the requested timeout. For requests >= 60s the outer `timed out after 60s` fires first, and that message is still transient, so `resetPage()` ran.
**Fix:** new exported pure helper `waitForDeadline(timeout)` = `max(TIMEOUTS.wait_for, (timeout || 30000) + 5000)`; the `wait_for` handler uses it. A genuinely hung browser is still caught by the outer deadline, just later for long waits. `isTransient` untouched.
**Regression test:** `test/unit/mcp.test.js` — "waitForDeadline" (60000 -> 65000, 90000 -> 95000 red against the old fixed 60000).
**Known, deliberately deferred limitation:** `isTransient` classifies by error-message text, and a timeout is ambiguous (slow-but-healthy page vs hung browser). The root fix, on a timeout ping the browser with a short deadline and reset only if it doesn't answer, was considered and deferred to avoid growing this branch.

---

## [2026-10-14] example.com integration tests broke on external page change (T1)

**Symptom:** 7 integration tests failed (`browse.test.js` browse()/connect(), `cli.test.js` "goto navigates"): the pruned snapshot had no heading and no "Example Domain" text.
**Cause:** example.com changed its page (no `<h1>`, six multilingual paragraphs, injected "Learn more" link) and says not to rely on it for testing. Not a barebrowse bug.
**Fix:** `test/fixtures/example-page.js` serves a local copy of the old page on 127.0.0.1; browse.test.js and the cli.test.js goto test use it. In cli.test.js the goto and reload calls moved to an async `cliAsync` helper, because the sync `cli()` blocks the event loop the in-process server needs. The Hacker News step stays as real-internet coverage.

## [2026-10-14] wait_for with an absurd timeout overflowed setTimeout and reset the MCP page (M7)

**Symptom:** `wait_for {text:'x', timeout:3000000000}` failed at once with `timed out after 3000s`, and `resetPage()` wiped the page.
**Root cause:** `waitForDeadline` returned `timeout + 5000` uncapped; above 2^31-1 ms `setTimeout` overflows and fires after ~1ms, and that "timed out" message is transient.
**Fix:** cap the result at `MAX_TIMER_MS` (2^31-1), the same cap `idleMs` uses (now a shared const). Unchanged below ~24.8 days.
**Regression test:** `test/unit/mcp.test.js` — "waitForDeadline" 3e9 -> 2147483647 (red against the uncapped code).

## [2026-10-14] Autoclean could delete a user's own date-named files in --output-dir (C1)

**Symptom:** with `barebrowse open --output-dir ~/Pictures`, the 7-day autoclean could delete a user's own `screenshot-2026-01-01.png` or `page-2025-03-04.pdf`.
**Root cause:** `OURS` in `src/output-clean.js` accepted any `[\dTZ-]+` after the prefix, far looser than the stamp barebrowse writes.
**Fix:** require the exact `toISOString()` stamp (`YYYY-MM-DDTHH-MM-SS-mmmZ`) via one shared sub-pattern, same prefix/extension pairing. All writer sites (mcp-server.js, src/daemon.js) emit exactly that stamp with no suffix.
**Regression test:** `test/unit/output-clean.test.js` — old `screenshot-2026-01-01.png`, `page-2025-03-04.pdf`, `page-20250304.yml` must survive (red against the old regex).

## [2026-10-23] Default cookie merge dropped same-name cookies on different paths (K1)

**Symptom:** with the default `auto` cookie source, dash.cloudflare.com got 16 cookies injected vs 18 with `browser:'firefox'` — one of two `curr-account` cookies was silently dropped. Not the cause of the Cloudflare logout that prompted the investigation: that was Cloudflare revoking the session after Firefox's session cookie was sent from the Chromium engine (different fingerprint). Re-tested on the Firefox engine, both old and fixed code stay logged in. Cross-engine cookie reuse stays the default by design; sites that bind sessions to the browser may reject it.
**Root cause:** the `auto` merge in `extractCookies()` keyed its Map by `name@domain`, but cookie identity is name + domain + path (RFC 6265). Two `curr-account` cookies on different paths collapsed into one.
**Fix:** the merge moved into an exported `mergeCookies(lists)` keyed by name + domain + path; last-write-wins across browsers is kept for identical cookies.
**Regression test:** `test/unit/auth.test.js` — "mergeCookies()" keeps both paths (red against the old key).

## [2026-10-23] wait_for with a non-numeric timeout reset the MCP page (M8)

**Symptom:** `wait_for {text:'x', timeout:'abc'}` failed at once with a "timed out" error, and `resetPage()` wiped the page.
**Root cause:** MCP doesn't enforce schema types. `waitForDeadline` computed `('abc' || 30000) + 5000` = `'abc5000'`, which `Math.max`/`Math.min` turned into NaN; `setTimeout(NaN)` fires after ~1ms, and that "timed out" message is transient.
**Fix:** new `waitTimeout()` coerces with `Number()` and falls back to 30000 when not finite or <= 0. `waitForDeadline` uses it, and the `wait_for` handler passes the same coerced value to `page.waitFor`.
**Regression test:** `test/unit/mcp.test.js` — "waitForDeadline" `'abc'` -> 60000 (red against the old code: NaN), plus NaN/-5/''/Infinity/null and `waitTimeout`.

## [2026-10-23] Partitioned Firefox cookies could shadow the top-level cookie (K2)

**Symptom:** a partitioned (CHIPS) Firefox cookie sharing name + domain + path with the top-level cookie could replace it in the injected set, so a site saw the embed's value instead of its login cookie.
**Root cause:** `extractFirefoxCookies()` ignored `originAttributes`. Partitioned cookies carry `partitionKey` there (e.g. `^partitionKey=%28https%2Ccloudflare.com%29`), and `mergeCookies` (keyed name + domain + path) keeps whichever comes last.
**Fix:** the `moz_cookies` query now excludes rows whose `originAttributes` contain `partitionKey=`; only top-level cookies are injected (a deliberate drop, since CDP/BiDi injection here has no partition key to attach). `extractFirefoxCookies` is now exported for the test.
**Regression test:** `test/unit/auth.test.js` — temp sqlite DB with two same-name cookies, one partitioned; only the top-level value comes out (red against the old query).

## [2026-10-23] A browser that failed to start was never killed (L1)

**Symptom:** on an overloaded machine `launch()` rejected with `Browser failed to start within 10s`, but the Chromium it spawned kept running with its `/tmp/barebrowse-<pid>-*` profile, and a full `npm test` hung 30 min (the piped stderr kept the event loop alive). 9 orphan Chromiums were left after one run. `launchFirefox()` had the same gap (20s timeout).
**Root cause:** the browser is added to `activeBrowsers` (the exit/signal reaper) only after the ws endpoint is parsed. Every failure between `spawn` and that point (start timeout, spawn error, early exit, `new URL()` throw) rejected without killing the detached process group or removing the profile dir.
**Fix:** `launch()` and `launchFirefox()` wrap that window in try/catch and call `cleanupBrowser` / `cleanupFirefox` on a stand-in `{process, ownedProfileDir}` before rethrowing. Successful launches are unchanged.
**Regression test:** `test/unit/launch-failure.test.js` — fake browser script that ignores SIGTERM and never prints an endpoint; after the rejection the process must be dead and its profile dir gone (red against the old code on both engines).

## [2026-10-23] A failed Chromium's helper processes survived its exit (L2)

**Symptom:** `launch()` rejected with `Browser exited with code 1`, but a helper the browser had forked stayed running (and kept holding the profile dir that was then deleted underneath it).
**Root cause:** related to L1. `cleanupBrowser()` ran the process-group SIGKILL only inside the `!killed && exitCode === null` guard, so once the Chromium parent had already exited the group was never signalled. Helpers share the parent's pgid (`detached:true`) and outlive it. `cleanupFirefox` already killed the group unconditionally.
**Fix:** the `process.kill(-pid, 'SIGKILL')` in `cleanupBrowser` (src/chromium.js) now runs whenever the browser has a pid, outside the guard (ESRCH still swallowed). The SIGTERM + 2s wait stays inside the guard. Successful launches are unchanged.
**Regression test:** `test/unit/launch-failure.test.js` — fake browser forks `sleep 300 &` then `exit 1`; after the rejection the helper must be dead and the profile dir gone (red against the old code: helper still running).

## [2026-10-25] A hard-killed parent orphaned Chromium forever (L3)

**Symptom:** when the Node process that called `launch()` was SIGKILLed or crashed, Chromium (and its helpers) lived on, reparented to init, with its `/tmp/barebrowse-<pid>-<ms>` profile dir. A peer project found 42 such orphans.
**Root cause:** the only reapers were in-process exit/signal handlers (`registerExitHandlers`), which cannot run on SIGKILL, and the MCP idle TTL, which only covers MCP-launched browsers. Nothing tied the browser's lifetime to the parent's.
**Fix:** `launch()` adds `--remote-debugging-pipe` (keeping `--remote-debugging-port=0`, so the ws URL on stderr and the ws CDP path are unchanged) and spawns with `stdio: ['ignore','pipe','pipe','pipe','pipe']`. fds 3/4 are never read or written; when the parent dies the kernel closes them, Chromium sees EOF and exits with its helpers. Our ends are destroyed on child exit so they can't hold the event loop. Firefox is not changed (it survives the same kill; see decisions).
**Regression test:** `test/integration/orphan-kill.test.js` — child script launches, parent SIGKILLs it, Chromium pid must be gone within 10s (red without the flag: still alive); plus a launch->cleanup script must exit on its own.

## [2026-10-25] A hard-killed launcher left its profile dir in /tmp forever (L4)

**Symptom:** after L3, a SIGKILLed launcher's Chromium now exits, but `/tmp/barebrowse-<ownerpid>-<ms>` stays behind (nothing is left alive to delete it).
**Root cause:** profile cleanup only runs in-process (`cleanupBrowser`, exit handlers), which a hard kill skips.
**Fix:** `launch()` calls new `sweepStaleProfiles(dir='/tmp')` before creating its own profile dir (never for caller-supplied `userDataDir`). It `rmSync`s only dirs named exactly `barebrowse-<pid>-<ms>` whose owner pid is dead (`ESRCH`; `EPERM` counts as alive), skipping its own pid. It never signals processes and ignores `barebrowse-dl-*`, `barebrowse-ff-*` and anything else. Test runs sweep the real /tmp too, which is fine: with the tether a dead-owner dir is garbage. Known limit: if a dead owner's pid was reused, its dir is kept; harmless, it just stays.
**Regression test:** `test/unit/sweep-profiles.test.js` — temp dir with dead-owner, live-owner, own-pid, `-dl-`, `-ff-` and malformed dirs; only the dead-owner dir goes (red when the removal is disabled).

## [2026-10-25] A hard-killed parent orphaned Firefox forever (L5)

**Symptom:** same as L3 for the Firefox engine: after `kill -9` of the Node launcher, all ~11 processes of Firefox's group lived on, reparented to init.
**Root cause:** Firefox has no `--remote-debugging-pipe` equivalent, so the L3 tether does not apply; the in-process exit handlers cannot run on SIGKILL.
**Fix:** on Linux, when `setpriv` exists (`/usr/bin/setpriv` or `/bin/setpriv`), `launchFirefox()` spawns `setpriv --pdeathsig SIGKILL <firefox> ...args`. setpriv execs Firefox, so `child.pid` is still Firefox's pid; the kernel SIGKILLs it when the launcher dies and its children follow (POC: 11 procs left plain, 0 with setpriv). Other platforms, or no setpriv, spawn exactly as before (still orphan-prone). `detached:true` and cleanup paths unchanged.
**Regression test:** `test/integration/orphan-kill.test.js` Firefox cases (skipped without Firefox/setpriv) — launcher SIGKILLed, launcher group SIGKILLed: Firefox pid must be gone within 10s (red with the wrap disabled); plus launch->cleanup exits on its own.

## [2026-10-25] A hard-killed launcher left its Firefox profile dir in /tmp (L6)

**Symptom:** after L5, a SIGKILLed launcher's Firefox exits but `/tmp/barebrowse-ff-XXXXXX` stays behind.
**Root cause:** the Firefox profile name carried no owner pid, so the L4 sweep could not tell a dead launcher's dir from a live one's.
**Fix:** profiles are now `mkdtemp('barebrowse-ff-<pid>-')`; `sweepStaleProfiles` also removes `barebrowse-ff-<pid>-<6 alnum>` dirs under the same dead-owner rules (ESRCH only, own pid skipped, EPERM = alive, never signals). `launchFirefox()` runs it before creating its profile (always our own). `barebrowse-dl-*` / `barebrowse-ff-dl-*` download dirs and old pid-less `barebrowse-ff-XXXXXX` dirs are never matched.
**Regression test:** `test/unit/sweep-profiles.test.js` — adds dead/live/own-pid/download/malformed ff dirs; only the dead-owner one goes.

## [2026-10-25] A hard-killed launcher left its empty download dir in /tmp (L7)

**Symptom:** after L5/L6, `/tmp/barebrowse-dl-XXXXXX` (Chromium) and `/tmp/barebrowse-ff-dl-XXXXXX` (Firefox) stayed behind after `kill -9` of the launcher.
**Root cause:** download-dir names carried no owner pid, so the sweep could not tell dead from live.
**Fix:** names are now `barebrowse-dl-<pid>-XXXXXX` / `barebrowse-ff-dl-<pid>-XXXXXX` (`src/index.js`); `sweepStaleProfiles` also removes those forms when the owner is dead (same rules as L4/L6). Existing launch-time sweep call sites suffice: attach mode creates no download dir, and both engines sweep during launch. Old pid-less dl dirs are never matched.
**Regression test:** `test/unit/sweep-profiles.test.js` — dead/live/own-pid/old pid-less dl dirs; only dead-owner ones go.

## [2026-10-25] The sweep only looked in /tmp, but half the dirs live in tmpdir() (L8)

**Symptom:** with `TMPDIR=/var/tmp/x`, a hard-killed launcher's `barebrowse-dl-<pid>-*` / `barebrowse-ff-*` dirs sat in `$TMPDIR` and the next Chromium launch (which swept only `/tmp`) never removed them; reverse, a Firefox launch swept `tmpdir()` and never reached Chromium's `/tmp/barebrowse-<pid>-<ms>`.
**Root cause:** `sweepStaleProfiles` defaulted to the literal `/tmp`, while download dirs and the Firefox profile are created under `tmpdir()` and the Chromium profile under `/tmp`.
**Fix:** called with no argument it sweeps `/tmp` and `tmpdir()` (deduped when equal); both launch sites now call it with no argument. The `dir` parameter still works for tests.
**Regression test:** `test/unit/sweep-profiles.test.js` — child process with `TMPDIR` pointing at a temp dir holding a dead-owner dl dir; the no-arg sweep must remove it (red before the fix).

## [2026-10-25] The sweep deleted the profile of a browser that outlived its launcher (L9)

**Symptom:** when a launcher is hard-killed but its browser survives (no `setpriv`, non-Linux, Snap Firefox), the next launch's sweep `rmSync`ed the profile dir the live browser was still using.
**Root cause:** the sweep judged only the launcher pid embedded in the dir name, never whether a browser held the profile.
**Fix:** before removing a dead-owner dir, `sweepStaleProfiles` reads the browser's lock symlink: Chromium `SingletonLock` (`<hostname>-<pid>`, seen `hamr-1853329`) and Firefox `lock` (`<ip>:+<pid>`, seen `192.168.178.220:+1853530`). The dir is kept if that pid is alive (EPERM counts as alive) or, for Chromium, the hostname differs from `os.hostname()`. No lock (download dirs, never-started browsers) keeps the old rule.
**Known tradeoff:** the foreign-host rule means a dead launcher's dir is kept forever if the hostname changed (renamed machine, container with a random hostname sharing `/tmp`), a deliberate leak-over-delete choice.
**Regression test:** `test/unit/sweep-profiles.test.js` — fake lock symlinks: live pid kept, foreign hostname kept, dead pid removed, no lock removed (red with the check disabled).

## [2026-10-26] A bare "Consent" button in a consent dialog was never clicked (N1)

**Symptom:** on moviefone.com a Google Funding Choices dialog (`dialog "Moviefone asks for your consent…"`, buttons `Consent` / `Manage options`) stayed open on both engines.
**Root cause:** the accept button's label is just "Consent", which matched no `ACCEPT_PATTERNS` entry.
**Fix:** new `DIALOG_ONLY_ACCEPT_PATTERNS = [/^consent$/i]` in `src/consent-patterns.js`, searched after `ACCEPT_PATTERNS` by `findAcceptButton` in both walkers. It is a separate list, so the page-wide fallbacks (`ACCEPT_PATTERNS.slice(0, -3)`) never see it. Anchored: "Manage consent", "Consent settings", "Do not consent", "Consent preferences" do not match.
**Regression test:** `test/unit/consent.test.js` — pattern accept/reject cases; both walkers click it inside a consent dialog and never page-wide (red without the change).

## [2026-10-26] A consent dialog rendered 1-3s after load was never dismissed (N2)

**Symptom:** on moviefone.com the Funding Choices dialog stayed in `snapshot()` output on both engines even with the N1 label fix.
**Root cause:** consent runs once right after navigation; the dialog does not exist yet at that moment, and nothing ever looks again.
**Fix:** `goto()` records whether that pass dismissed anything (`consentRecheck`, only when consent is enabled; attach mode included, since goto() runs consent there too). The FIRST `snapshot()` after that goto re-runs the consent pass once and, if it clicked something, builds the snapshot from the fresh tree. Cleared by the first snapshot, and by goBack/goForward/reload (no consent pass runs there). No added waiting. Chromium cost: one extra `getFullAXTree` on the first snapshot per navigation; Firefox re-checks on the tree snapshot() already built (no extra round-trips unless something was dismissed).
**Known limits:** `createTab().goto()` is unchanged (no snapshot-time hook there; not trivial). `browse()` (one-shot) goes goto -> snapshot immediately: a re-check just before its snapshot only helps for a dialog that appears in the ~20-30ms between the two passes, so it was NOT added (cannot be tested deterministically, no real-world gain without a wait). A dialog later than the first snapshot is not caught.
**Regression test:** `test/integration/consent-late.test.js` — local server injects the dialog after 1.5s; goto, wait, snapshot: dialog gone, button clicked; plain page: only the first snapshot pays the extra check. Both engines, plus an attach-mode case (`connect({port})`); red without the change.

## [2026-10-26] Chromium snapshot() ignored connect({pruneMode}) (N3)

**Symptom:** `connect({ pruneMode: 'data' })` (or `'read'`, ...) returned act-pruned output from `snapshot()` on Chromium; Firefox honoured it.
**Root cause:** Chromium `snapshot()` used `pruneOpts?.mode || 'act'`, never consulting the connect() option (Firefox falls back to `defaultPruneMode`).
**Fix:** `pruneOpts?.mode || opts.pruneMode || 'act'`: explicit `snapshot({mode})` wins, then the connect() default, then act. The act-mode hint and stats use the resolved mode. `browse()` already used `opts.pruneMode || 'act'` consistently.
**Behaviour change:** Chromium callers who set `connect({pruneMode: 'read'|'browse'|...})` now get that mode from a bare `snapshot()`; that is the documented behaviour, previously silently ignored.
**Regression test:** `test/integration/data-mode.test.js` — `connect({pruneMode:'data'})` bare snapshot has the legend, explicit mode wins, unset stays act (red on Chromium before the fix).

## [2026-10-26] The late-consent re-check could fire on a different page than the goto's (N4)

**Symptom:** `goto(A)` (no popup) then a navigation not made through `goto()` (page's own redirect, a click, Enter on a link, switchTab) to page B: the first `snapshot()` re-ran the consent pass on B and auto-accepted B's dialog. A `navigate()` that threw also left the previous page's flag set.
**Root cause:** `consentRecheck` was a boolean cleared only by the first snapshot and by goBack/goForward/reload; nothing tied it to the document the goto landed on.
**Fix:** the flag now holds the document identity the goto's consent pass saw: Chromium `targetId:loaderId` (main frame, `Page.getFrameTree`; see N6, it was first the history entry), Firefox `context:performance.timeOrigin`. The first snapshot re-checks only if the identity is unchanged, then clears the flag either way. `goto()` also clears it before navigating. Chosen over clearing in click/press/select/createTab because it covers every path, including navigations the page starts itself, with one comparison instead of a hook per action.
**Cost:** one extra round-trip on the first snapshot after a goto that dismissed nothing (Chromium `Page.getFrameTree`; Firefox one `script.evaluate`, and one more at goto time).
**Regression test:** `test/integration/consent-late.test.js` — page A redirects itself to B (late dialog); snapshot must still show B's dialog, both engines (red before the fix). The round-trip count test now expects +1 on both engines.

## [2026-10-26] The data-mode legend counted toward "% pruned", and an empty result was a lone legend (N5)

**Symptom:** a tiny page (`<main><p>hi</p></main>`) reported a negative `% pruned` in data mode because the ~190-char legend outweighed the content; an empty main produced only the legend line.
**Root cause:** the stats measured `dataSnapshot()`'s whole output, legend included; `dataSnapshot` always prepended the legend.
**Fix:** `dataSnapshot` returns `''` when there are no records (same as the other modes on an empty tree). New `stripLegend()` in `src/data.js`; `browse()`, Chromium `snapshot()` and Firefox `snapshot()` compute the stat on the stripped body. The legend stays in the output.
**Regression test:** `test/integration/data-mode.test.js` (stat counts the body only, both engines) and `test/unit/data.test.js` (empty tree gives `''`); both red before the fix.

## [2026-10-26] Chromium's late-consent key was per history entry, so pushState skipped the re-check (N6)

**Symptom:** goto a page with no dialog, the page calls `history.pushState` (or sets `location.hash`) and later renders a consent dialog: the first `snapshot()` left it up on Chromium; Firefox accepted it. SPAs often pushState right after load.
**Root cause:** N4 keyed Chromium on `targetId:history-entry-id`. pushState and hash changes create a new history entry on the SAME document, so the key looked like a different page. Firefox's `performance.timeOrigin` key was already per document.
**Fix:** Chromium keys on `targetId:loaderId` of the main frame (`Page.getFrameTree`). POC on real Chromium: loaderId (and timeOrigin) unchanged across pushState, hash change and replaceState, changed across a self-redirect. loaderId chosen: one round-trip, no page-side script. N4's redirect protection is unchanged.
**Cost:** none beyond N4 (`getFrameTree` replaces `getNavigationHistory` in the key).
**Regression test:** `test/integration/consent-late.test.js` — pushState and location.hash variants, then a late dialog; first snapshot must dismiss it, both engines (red on Chromium before the fix, Firefox already green).

## [2026-10-26] `barebrowse install --skill` failed for every npm install: commands/ not packaged (N7)

**Symptom:** `npx barebrowse install --skill` from a published package could not find the skill file; `--help` points at `commands/barebrowse.md`, also absent. The 0.25.0 and 0.24.1 tarballs contain no `commands/` files.
**Root cause:** `package.json` `files` allowlist omitted `commands/`; `cli.js` reads `commands/barebrowse/SKILL.md` relative to the package dir. It worked from a git checkout, so nothing local caught it.
**Fix:** added `"commands/"` to `files` (ships `commands/barebrowse.md` and `commands/barebrowse/SKILL.md`, the only tracked files there).
**Regression test:** `test/unit/package-files.test.js`: `npm pack --dry-run --json` must list both files (red before the fix; unit, so CI runs it).

## [2026-10-27] Chromium `goto()` ignored `Page.navigate`'s `errorText`: unreachable hosts "succeeded" (N8)

**Symptom:** `goto('http://nonexistent.invalid/')` on Chromium resolved normally and the snapshot was Chrome's error page; Firefox rejected with a raw `BiDi error`. A 404 was also indistinguishable from a 200 on both engines, and a download URL made Chromium wait the full 30s for a load event that never comes.
**Root cause:** `navigate()` awaited `Page.loadEventFired` and discarded the `Page.navigate` result, whose `errorText` (`net::ERR_NAME_NOT_RESOLVED`) is the only failure signal; nothing read the main document's response either.
**Fix:** `navigate()` checks `errorText` right after `Page.navigate`, cancels its load waiter, and throws a typed `NAV_FAILED` error (`code`, raw `reason`). `net::ERR_ABORTED` is exempt: POC on real Chromium showed it comes with `isDownload:true` for a download and with no flag for a 204; neither fires a load event, so goto returns at once instead of timing out. Firefox's `browsingContext.navigate` rejection is rewrapped into the same error (`NS_BINDING_ABORTED`, its 204/abort, is exempt the same way). Both engines now resolve `goto()` to `{ url, status }` from the main-document response (Chromium `Network.responseReceived` type Document, matched on the navigation's loaderId; Firefox the last `network.responseCompleted` for the navigation id) and add an `[HTTP n …]` line to snapshots after a non-2xx goto.
**Cost:** one extra event listener per navigation on each engine.
**Regression test:** `test/integration/navigation.test.js` (both engines: 200, 404, redirects, NAV_FAILED, download; `browse()`), `test/unit/navigation.test.js`; red before the fix.

## [2026-10-27] Stale `[HTTP n]` warning and `lastNavigation` after back/forward/reload (N9)

**Symptom:** goto(`/404`) → goto(`/ok`) → goto(`/404`) → `goBack()`: the snapshot of the healthy `/ok` page started with `[HTTP 404 …]`. A `reload()` of a 404 that now returned 200 kept the warning. Both engines.
**Root cause:** `lastNavigation` (which the warning is built from) was written only by `goto()`; history traversal and reload changed the page without touching it.
**Fix:** `goBack`, `goForward`, `reload` and `switchTab` reset `lastNavigation` to `null` on both engines (`src/index.js`, `src/firefox-page.js`). Status stays a `goto()`/`browse()` feature; nothing new is read for traversals.
**Cost:** none.
**Regression test:** `test/integration/navigation.test.js` (both engines: goBack/goForward and reload); red before the fix. `switchTab` is not covered by a test (needs a second tab).

## [2026-10-27] Data mode stripped the URL from a link that shared one with a neighbour (N10)

**Symptom:** with `links: true` in data mode, `<li><a href=/p1><img alt=pic></a> <a href=/p1>Title one</a> <a href=/p2>Title two</a></li>` printed `link "Title one" [ref=36]` with no URL, and a group printed `three <…/p3> [ref=40], three again [ref=41]`. A consumer reading "every link line carries its URL" got links it could not resolve.
**Root cause:** `urlPart`/`inline`/`withRef` threaded a `seen` set through a group, table row and (via `emit`'s `scope` + `lineUrls`) a whole list item, dropping any URL already shown on the line or item.
**Fix:** removed the cross-line/cross-item dedupe in `src/data.js` (`seen`, `scope`, `lineUrls`): a node prints its own `urls` (already unique per node by prune.js), so every link line, group item and row cell carries its URL. Duplicates collapse only inside a single node's own url list.
**Cost:** a URL repeats where two links share it (the old dedupe was the saving).
**Regression test:** `test/integration/links.test.js`, new "a link sharing a URL with a neighbour still carries its own URL" (both engines; card list + group); red before. The old "duplicate url listed once" assertion in "on, data: table cell, collapsed group, …" was replaced by it (it asserted the removed behavior).

## [2026-10-27] Empty-body 4xx/5xx rejected NAV_FAILED on Chromium (N11)

**Symptom:** `goto()`/`browse()` of a 404/500 with a zero-length body rejected `NAV_FAILED: net::ERR_HTTP_RESPONSE_CODE_FAILURE` on Chromium instead of resolving `{status}` with the `[HTTP n …]` warning (v0.25.0 loaded it; Firefox was fine; a 404 with a body was fine).
**Root cause:** for an empty-body error response Chromium's `Page.navigate` returns that `errorText`, and N8's `navigate()` treated every `errorText` except `ERR_ABORTED` as a network failure.
**Fix:** `ERR_HTTP_RESPONSE_CODE_FAILURE` is not a failure in `navigate()`. POC on real Chromium (404/500/403/401/410/503): the Document `responseReceived` carries the status and the same `loaderId` as `Page.navigate`'s result, and `Page.loadEventFired` fires (Chromium renders its error page), so the load wait stays and the existing loaderId match yields the status. No other HTTP-status `errorText` exists in the POC: 204 and 304 give `ERR_ABORTED` (already exempt).
**Cost:** none.
**Regression test:** `test/integration/navigation.test.js` (`/404empty`, `/500empty` on both engines; `browse()` on `/500empty`); red on Chromium before the fix.
