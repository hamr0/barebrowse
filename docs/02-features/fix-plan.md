# Fix Plan — Bug Fixes & Headed-Mode Enhancements

Source: QA review 2026-05-17. Verified against current code before publishing.

Sequencing: **Phase A (fixes)** lands first — each fix is one surgical commit
with a regression test (per AGENT_RULES). **Phase B (headed enhancements)**
opens after Phase A is green.

---

## Phase A — Bug fixes

### F1. `page.cdp` escape hatch goes stale after hybrid fallback

- **File:** `src/index.js:393`
- **Symptom:** Consumers using `page.cdp` (notably `src/daemon.js:84-128` which
  attaches console + network listeners) stop receiving events after a hybrid
  headless→headed switch in `goto()`.
- **Root cause:** `cdp: page.session` captures the session by value at
  `connect()` time. After fallback, the local `page` variable is reassigned
  (lines 186, 210) but the returned object's `cdp` property still points at the
  closed session.
- **Fix:** Convert to a getter — `get cdp() { return page.session; }`.
- **Regression test:** Integration test that triggers hybrid fallback on a
  fixture (or mocks `isChallengePage` to return true once), then asserts
  `page.cdp` equals the new `page.session`.

### F2. Temp profile dirs leak on every launch

- **File:** `src/chromium.js:98`
- **Symptom:** `/tmp/barebrowse-${pid}-${ts}` is created on every launch, never
  removed. Hybrid doubles per session; long-running MCP/daemon servers compound
  the leak.
- **Fix:** Return the temp dir path from `launch()` (already implicit in args)
  and `rmSync(profileDir, { recursive: true, force: true })` in the finally of
  `browse()` (index.js:114) and in `connect().close()` (index.js:422), plus on
  the hybrid fallback paths that kill the old browser.
- **Regression test:** Unit test that calls `launch()` and asserts the temp
  dir exists, then kills the process + runs the cleanup helper, asserts gone.

### F3. Browser process orphans on parent crash

- **Files:** `src/chromium.js`, `src/index.js`, `mcp-server.js:461-466`
- **Symptom:** If Node SIGKILLs or `uncaughtException` fires (current handler
  only nulls `_page`), the spawned Chromium keeps running forever, holding its
  temp dir + CDP port.
- **Fix:** Track spawned PIDs in a module-level Set in `chromium.js`. Register
  one-time `process.on('exit'|'SIGINT'|'SIGTERM')` cleanup that kills all
  tracked PIDs and removes their temp dirs. `launch()` adds; `kill()` helper
  removes.
- **Regression test:** Spawn a test harness that calls `launch()`, then
  `process.exit(0)` — separate test process polls for the child PID and
  asserts it died within 2s.

### F4. `switchTab` doesn't actually switch the working session

- **File:** `src/index.js:319-324`
- **Symptom:** After `switchTab(1)`, subsequent `snapshot()`/`click()` still
  operate on the original tab. The new tab is foregrounded in the UI but the
  session reference doesn't change.
- **Root cause:** `Target.activateTarget` only brings a target to the front.
  Driving a different target requires attaching to it and using its sessionId.
- **Fix:** In `switchTab(index)`: call `Target.attachToTarget` with
  `flatten: true`, get `sessionId`, build a new session-scoped handle, replace
  the outer `page` variable. Reset `refMap`. Wire dialog handler on the new
  session.
- **Regression test:** Integration test that opens two tabs via `window.open`,
  switches, asserts `snapshot()` returns content of the second tab.

### F5. Stale `refMap` after navigation

- **File:** `src/index.js:244` (refMap update) and `goto()` line 192
- **Symptom:** `click(ref)` after `goto()` (without an intervening
  `snapshot()`) resolves to whatever backendNodeId happens to still be in the
  map → wrong-element clicks or "no element found" depending on luck.
- **Fix:** Clear `refMap` at the start of every `goto()` and `switchTab()`.
  Optionally: add a navigation generation counter; reject refs from prior gen
  with a clear error message.
- **Regression test:** Integration test that does `goto(A)` → `snapshot()` →
  `goto(B)` → `click(refFromA)`, asserts a clear error (not a silent
  wrong-element click).

### F6. `withRetry` retries non-idempotent operations

- **File:** `mcp-server.js:47-55`
- **Symptom:** On transient failure mid-`click`/`type`/`upload`/`drag`, the
  retry runs on a brand-new session that has no URL or auth state, potentially
  double-submitting on a partial first attempt.
- **Fix:** Take an `{ idempotent: bool }` flag in `withRetry`. Set true only
  for `goto`/`snapshot`/`back`/`forward`/`pdf`. For mutating ops, fail loudly
  instead of silently retrying on a fresh page.
- **Regression test:** Unit test that wraps a non-idempotent fn that throws a
  transient error, asserts the fn was called exactly once.

### F7. `createTab` skips dialog handler

- **File:** `src/index.js:395-420`
- **Symptom:** A JS dialog (alert/confirm/prompt/beforeunload) in a sub-tab
  hangs forever — navigation never completes.
- **Fix:** Call `setupDialogHandler(tab.session)` in `createTab()`.
- **Regression test:** Integration test that opens a tab, navigates to a data:
  URL with `<script>alert(1)</script>`, asserts no hang and dialog appears in
  `dialogLog`.

### F8. `goBack`/`goForward` use fixed 500ms sleep

- **File:** `src/index.js:230, 237`
- **Symptom:** Race: snapshot taken after `goBack()` may run on the prior page
  if navigation took >500ms; or wastes time on instant SPA navs.
- **Fix:** Wrap nav in `waitForNavigation()` (try/catch as the existing impl
  does at line 376).
- **Regression test:** Integration test that navigates A→B→back, asserts
  `snapshot()` immediately after `goBack()` shows A's content.

### F9. `waitForNetworkIdle` counter can desync

- **File:** `src/index.js:577-613`
- **Symptom:** Pending counter goes negative on requests started before the
  listener attached; resolves prematurely.
- **Fix:** Track requestIds in a `Set` instead of a counter. Increment on
  `requestWillBeSent` (add id), decrement on finish/fail (delete id). Idle
  when set is empty.
- **Regression test:** Unit-style test using a mock session that emits
  `loadingFinished` for unknown id (no prior `requestWillBeSent`), asserts the
  counter doesn't go negative.

### L1. Dead code in `consent.js`

- **File:** `src/consent.js:292-300`
- `strictPatterns` is built then immediately superseded by `safePatterns`.
  Remove the dead block + "Actually, let's just use all..." scratch comment.
- **No regression test needed** (pure deletion of unreachable code).

### L2. `connect()` ignores documented opts

- **File:** `src/index.js:127`
- `opts.port`, `opts.binary`, `opts.userDataDir` are not read. Either honor or
  remove from docs. Defer the `port` honoring to **H1** (attach-to-running) —
  the others should be wired or stripped now.
- **Regression test:** Unit test asserting `binary` and `userDataDir` reach
  the launch call.

---

## Phase B — Headed-mode enhancements (after Phase A is green)

Ranked by leverage. Each lands as its own commit + tests.

### H1. Attach to a running browser (the headed-mode story)

- **Today:** `connect({ mode: 'headed' })` always spawns a fresh Chromium with
  an empty temp profile. The user's logged-in browser session can't be reused.
- **Plan:** When `connect({ port })` is set, call `getDebugUrl(port)` (already
  exists at `chromium.js:149`) and skip `launch()`. Skip profile cleanup on
  close (we didn't create it). Add a top-level README example.
- **Why this matters:** Turns headed mode from "spawn a clone" into the actual
  promise — drive the user's logged-in session.

### H2. iframe / OOPIF support

- **Today:** `Accessibility.getFullAXTree` does NOT cross frame boundaries.
  Stripe, reCAPTCHA, embedded forms, most ads are invisible to snapshots.
- **Plan:** Call `Target.setAutoAttach({ autoAttach: true, flatten: true,
  waitForDebuggerOnStart: false })` at page setup. Track child sessions per
  page. In `ariaTree()`, walk frame tree via `Page.getFrameTree`, call
  `getFullAXTree` on each child session, merge into root with ref namespacing
  (`ref="3.7"` for frame 3 / nodeId 7).
- **Why this matters:** Biggest blocker to real-world automation today.

### H3. `reload(ignoreCache)`

- Trivial wrapper on `Page.reload`. Add to public API + MCP. ~10 lines.

### H4. Stealth completeness

- **File:** `src/stealth.js`
- Missing patches: `WebGL.getParameter` UNMASKED_VENDOR/RENDERER,
  `navigator.hardwareConcurrency`, `navigator.deviceMemory`,
  `Notification.permission`, `chrome.runtime`. Most importantly: headless UA
  still contains `HeadlessChrome` — override via `--user-agent=`.
- Not exhaustive (Cloudflare-grade detection will still flag) but cleans up
  the obvious leaks.

### H5. Per-tool MCP timeouts

- **File:** `mcp-server.js`
- Blanket 30s is too short for `goto` (SPA cold loads exceed it) and too long
  for instant ops. Split: `goto` 60s, `snapshot`/`click`/`type`/`press`/
  `scroll` 15s, `pdf`/`screenshot` 45s.

### H6. Missing MCP tools

- Add: `screenshot`, `eval`, `wait_for`, `tabs`, `select`, `hover`, `reload`.
  These exist in `connect()` API + daemon but aren't exposed via MCP.
- `eval` particularly powerful for ad-hoc inspection. Guard behind opt-in?
  (Discuss before adding.)

### H7. Download handling

- `Browser.setDownloadBehavior({ behavior: 'allow', downloadPath })` +
  `Browser.downloadProgress` events. Surface via `page.downloads` array.

### H8. Dialog handler override

- Infra exists (`setupDialogHandler`). Auto-accepts everything today; consumer
  can read `dialogLog` but can't override. Add `page.onDialog(handler)` —
  handler returns `{ accept, promptText }`.

### H9. `isChallengePage` false positives

- **File:** `src/index.js:621-643`
- `nodeCount < 50` + generic phrases (`access denied`, `unknown error`)
  trigger headed fallback on legitimate small/error pages. Tighten the
  heuristic (require BOTH low-node-count AND a challenge phrase, or
  challenge-specific patterns only).

---

## Follow-ups noted during Phase B

### MCP Config Diagnostics *(shipped in v0.9.0 — all three mitigations landed)*

- **Observed:** Claude Code surfaces a "Conflicting scopes" warning when the
  same MCP server name is registered in two scopes pointing at two
  absolute paths — e.g. `barebrowse` registered in *user* scope at
  `~/PycharmProjects/barebrowse/mcp-server.js` AND in *project* scope at
  `~/Documents/PycharmProjects/barebrowse/mcp-server.js`. OAuth tokens are
  stored per endpoint, so a token issued to one path does not carry over
  to the other; this silently splits sessions and confuses agents.
- **What barebrowse now does:**
  - **`barebrowse install`** detects existing `mcpServers.barebrowse`
    entries with a different command/args and prints a `CONFLICT`
    warning showing both endpoints instead of silently overwriting.
    Pass `--force` to replace.
  - **`barebrowse mcp`** writes a one-line stderr banner at startup
    (`barebrowse mcp v<X.Y.Z> | serving from <abs/path/mcp-server.js> | pid <N>`)
    so a stuck agent is diagnosable from the MCP client's log.
  - **`barebrowse doctor`** scans every known MCP config location
    (Claude Code user/project/local, Claude Desktop, Cursor, VS Code)
    and prints which `barebrowse` entries are configured + where they
    point. Flags `CONFLICT` when two scopes point at different endpoints
    and prints `claude mcp remove barebrowse -s <scope>` remediation.
- **Regression tests:** `test/integration/cli.test.js` — "MCP config
  diagnostics (no daemon)" describe block: clean home shows no conflict;
  divergent endpoints across two scopes trigger CONFLICT with both paths
  in output; install refuses to clobber without `--force` but does
  overwrite with it; the `mcp` startup banner matches the expected
  format with version + path + pid.

### Pruning reach: MCP/bareagent + `read` mode *(shipped — fix landed post-v0.9.0)*

- **Observed:** Agents calling barebrowse via the MCP server (and CLI
  users following SKILL.md) saw paragraph-heavy pages collapse to near-
  empty snapshots. Claude commonly fell back to WebFetch after a single
  barebrowse round-trip on articles/docs/blogs. Two compounding causes:
  (1) `prune.js` recognised `act|browse|navigate|full` but not the
  publicly-advertised `read` — passing `mode: 'read'` silently fell back
  to act-mode pruning; (2) MCP `browse`/`snapshot` and bareagent
  `browse`/`snapshot` had no `pruneMode` parameter at all, so even if
  `read` worked it could not be requested from those surfaces.
- **What barebrowse now does:**
  - **`prune()`** treats `mode: 'read'` as an alias for `mode: 'browse'`
    via a one-line normalization at the top of the function.
  - **MCP `browse` and `snapshot` tools** gained a `pruneMode:
    'act'|'read'` enum parameter, with tool descriptions that tell the
    agent when to pick `read` (content-heavy pages — articles, docs,
    blogs). Handlers forward it to the library.
  - **bareagent `browse` and `snapshot` tools** gained the same
    parameter with identical semantics. The `browse` execute defends
    against clobbering a caller-supplied `opts.pruneMode` when the tool
    is invoked without the arg.
  - **Auto-hint** in `page.snapshot()` and `browse()`: when act mode is
    active and a substantial page (`raw > 5 KB`) collapses to under
    500 chars AND under 5% of raw, the result includes a single `hint:
    act mode dropped most of the page — retry with pruneMode='read' …`
    line between the stats and the tree. Thresholds are conservative so
    interactive-heavy pages (e-commerce, search results) do not trigger
    it. Cost of a false positive is one extra tool call; miss cost was
    the WebFetch fallback.
- **Regression test:** `test/unit/prune.test.js` — "aliases
  `mode='read'` to browse mode" asserts `prune(tree, {mode: 'read'})`
  deep-equals `prune(tree, {mode: 'browse'})` on a paragraph+button
  fixture and that paragraphs survive. 17 prune tests pass (was 16).
  Full unit suite 68/68 green; browse integration 16/16 green.

## Out of scope (noted, not planned)

- Tests/style nits, TypeScript migration, build tooling — intentionally
  vanilla per project rules.
- IndexedDB persistence in `saveState` — too complex for the value.
- Firefox support — settled "later via BiDi" in MEMORY.md.
