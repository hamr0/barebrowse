# Changelog

## [Unreleased]

### Added

- **Firefox/BiDi observability parity (parity plan Phase 2).** The Firefox
  engine now backs the same console/network capture and network-idle wait the
  Chromium/CDP engine has, over WebDriver BiDi events instead of CDP:
  - **`page.waitForNetworkIdle()`** works on Firefox (was a CDP-only stub that
    threw). Wired to `network.beforeRequestSent` / `responseCompleted` /
    `fetchError`, reusing the same orphan-resilient idle core as the CDP path
    (`waitForNetworkIdleBiDi` in `network-idle.js`).
  - **Daemon console + network log capture** on Firefox: the `console-logs`,
    `network-log`, and `wait-idle` CLI commands now return real data for a
    `--engine firefox` session (previously empty / unsupported). Backed by
    `log.entryAdded` + `network.*` events (`attachBiDiCapture` in `daemon.js`),
    mirroring the CDP `Runtime.consoleAPICalled` / `Network.*` capture. BiDi's
    `warn` console level is normalized to CDP's `warning` so `--level` filters
    match cross-engine.

  Event shapes were measured against real Firefox before wiring (per the Phase 1
  lesson). Unit-tested against those shapes in `test/unit/network-idle.test.js`
  and `test/unit/daemon.test.js`; live-verified in `test/integration/firefox.test.js`.
  Still Firefox gaps (Phase 3+): ad/tracker block, dialog capture, `saveState`,
  `waitForNavigation`, hybrid mode.

## [0.16.1] - 2026-07-10

### Fixed

- **Firefox consent auto-dismiss no longer risks clicking an unrelated button.**
  A code review of v0.16.0 found (and reproduced) a false-positive: when a
  consent *dialog* was detected but contained no in-dialog accept button, the
  Firefox walker fell back to a page-wide "accept" scan that could auto-click an
  unrelated `Accept all …` control elsewhere on the page (e.g. a ToS/signup
  button) during `goto()`. The page-wide scan now runs **only** for banner-style
  consent (no dialog container at all). Trade-off: an accept button rendered
  *outside* its own dialog (some SourcePoint deployments) is no longer
  auto-dismissed on Firefox — we accept that miss rather than risk a wrong
  click. Regression-tested in `test/unit/consent-firefox.test.js`.

### Documentation

- **Firefox stealth + consent known limitations** captured in the PRD
  (`docs/01-product/prd.md`), slated for the Phase 5 cross-engine fidelity
  harness: the consent double AX-build per navigate (bounded latency, parity
  with CDP), the single-click-without-re-verify behavior (`consent: false` to
  opt out), and the latent `navigator.webdriver` own-property fallback. All
  three were validated in the same review; none is a correctness defect on
  current engines.

## [0.16.0] - 2026-07-10

### Added

- **Firefox anti-detection + consent auto-dismiss (BiDi parity Phase 1).** The
  two most agent-breaking Firefox gaps are closed: headless bot-detection and
  cookie-consent dialogs that were never dismissed. Both now work on
  `connect({ engine: 'firefox' })` (and therefore the CLI/daemon/MCP Firefox
  paths), behind the same flags as the CDP engine.
  - **Stealth** (`src/stealth-firefox.js`, headless only, via BiDi
    `script.addPreloadScript`). Deliberately *not* a port of Chromium's
    `STEALTH_SCRIPT`: a POC measured stock Firefox-under-BiDi and found it
    already exposes a realistic surface (no `window.chrome`, a real plugin set,
    the real GPU, a UA with no "Headless" marker) — injecting Chromium's
    Chrome-shims would have *created* a spoof tell worse than the one removed.
    Firefox's only real tell is `navigator.webdriver` (`true`), so it gets a
    minimal script: `navigator.webdriver` hiding + canvas-fingerprint noise.
    `WEBDRIVER_PATCH` and `CANVAS_NOISE_PATCH` are now exported from
    `stealth.js` and shared by both engines (single-sourcing the canvas
    double-XOR fix).
- **Hardened `navigator.webdriver` hiding on both engines.** The shared
  `WEBDRIVER_PATCH` now *deletes* the getter off `Navigator.prototype` instead
  of shadowing it with an own property. A naive override hid the value but left
  `navigator.hasOwnProperty('webdriver') === true` — a tell that advanced
  anti-bot checks (e.g. sannysoft's "WebDriver New") detect. After the change
  `navigator.webdriver` is `undefined` and both `hasOwnProperty` and
  `'webdriver' in navigator` read `false`, matching a stock browser
  (POC-verified on Chromium and Firefox). This improves the Chromium engine
  too, not just Firefox.
  - **Consent** (`src/consent-firefox.js`). A walker over the reconstructed
    nested AX tree that clicks the "accept" button via the existing BiDi
    `pointerClick`. The multilingual accept/dialog patterns were extracted to
    `src/consent-patterns.js`, now imported by both the CDP (`consent.js`) and
    BiDi walkers, so language coverage stays single-sourced. Runs after
    `goto()` behind the same `consent !== false` flag as CDP.
  - **Tests:** `test/unit/consent-firefox.test.js` (pure walker: dialog
    scoping, pattern priority, non-English, banner fallback, false-positive
    guard) plus Firefox integration tests (webdriver hidden at page-parse time,
    no `window.chrome` spoof, consent auto-dismiss + a `consent: false` control
    that proves the test can fail).

### Known gaps (Firefox engine)

- `hybrid` mode, ad/tracker blocking, and console/network log capture remain
  Chromium-only (BiDi parity Phases 2–4). `saveState`, `waitForNavigation`,
  and `waitForNetworkIdle` still throw a clear "not supported on the
  Firefox/BiDi engine" error; download/dialog logs read empty.
- `reload()` still cannot honour `ignoreCache` (Firefox BiDi does not support
  it yet).
- Consent auto-dismiss clicks once without re-verifying dismissal (the CDP
  path's synthetic→real retry is unnecessary here — BiDi `pointerClick` is
  already a real pointer event). Accessible-name computation remains a
  high-value subset of the full W3C accname spec.

## [0.15.0] - 2026-07-10

### Added

- **Firefox support via WebDriver BiDi (`connect({ engine: 'firefox' })`).** CDP
  is deprecated in Firefox, so Firefox is driven over the W3C-standard BiDi
  protocol — a second transport (`src/bidi.js`) over the *same* `ws` dependency,
  with no geckodriver and no new package. Selectable from the CLI
  (`barebrowse open <url> --engine firefox`) and MCP (`BAREBROWSE_ENGINE=firefox`).
  - New modules: `bidi.js` (BiDi JSON-RPC transport), `firefox.js` (launch/find/
    reap), `ax-snapshot.js` (reconstructs a CDP-vocabulary ARIA tree in-page —
    BiDi has no `getFullAXTree` — with implicit roles, accessible-name
    computation, `aria-hidden`/visibility filtering, and shadow-DOM/`<slot>`
    traversal), `firefox-page.js` (the BiDi-backed page object).
  - `prune.js`, `aria.js`, and `readable.js` are reused unchanged across engines
    (readable.js refactored to share `EXTRACT_EXPRESSION` + `finalizeReadable`).
  - Covers `goto`, `snapshot`, `click`, `type`, `press`, `scroll`, `hover`,
    `select`, `drag`, `upload`, `goBack`/`goForward`, `reload`, `screenshot`,
    `pdf`, `tabs`/`switchTab`, `waitFor`, `readable`, `injectCookies`, `close`.
    The navigation guard and upload sandbox are enforced on the Firefox path for
    parity with CDP.
  - Fidelity validated against real CDP snapshots; iframes (incl. nested +
    multi-tab), shadow DOM, CSP, and SPA timing covered in
    `test/integration/firefox.test.js` (18 tests).
  - `goto`/`reload`/history navigation honour a timeout (a page that never
    finishes loading rejects instead of hanging). Proxy honours the URL scheme
    (`http`/`https` → HTTP+SSL, `socks`/`socks5`/`socks4` → SOCKS). Cookie
    injection is host-scoped like CDP (shared `scopedCookiesForUrl`, not the
    whole jar). Snapshot fidelity: a collapsed `<select>` surfaces as its value
    (not every `<option>`), and bare text directly under `<body>` is kept.

- **Incognito mode — a clean, unauthenticated session (`incognito: true`).**
  Skips ALL auth injection: no cookie extraction/injection and no
  `storageState` loading, so the agent browses logged-out even though the
  default throwaway profile is unchanged. The gate lives at the page-object
  level, so it holds even when a caller (MCP `goto`, the daemon) injects
  unconditionally. Available on `browse()`, `connect()`, both engines, MCP
  (`browse` tool arg + `BAREBROWSE_INCOGNITO=1`), and CLI (`--incognito`).
  Cookie injection is scoped to the target host on **both** engines via a
  shared `scopedCookiesForUrl` (the Firefox path no longer loads the whole
  cookie jar).

### Known gaps (Firefox engine)

- Consent auto-dismiss, stealth patches, and `hybrid` mode remain Chromium-only.
- `reload()` cannot honour `ignoreCache` (Firefox BiDi does not support it yet).
- The CLI daemon's console/network log capture is CDP-only, so those logs are
  empty for a Firefox session. `saveState`, `waitForNavigation`, and
  `waitForNetworkIdle` are CDP-only too — on Firefox they throw a clear
  "not supported on the Firefox/BiDi engine" error, and download/dialog logs
  read empty. Accessible-name computation is a high-value subset of the full
  W3C accname spec.

## [0.14.0] - 2026-06-15

### Documentation

- **README — "The bare ecosystem" section recast from a 4-column table to a Core / Optional-reach list.** Now covers all six modules — core `bareagent` · `bareguard` · `litectx`, optional reach `barebrowse` · `baremobile` · `beeperbox` — in a scannable row form that also renders cleanly on npm. README only; no package change.

## [0.13.0] - 2026-06-12

### Added
- **`readable()` — clean article extraction.** New read mode that returns the
  main article of a page as clean text (title + body prose, nav/ads/sidebars
  stripped) via Mozilla Readability injected in-page over CDP. Companion to
  `snapshot()`, not a replacement: `snapshot()` is the *actionable* ARIA tree
  for clicking/typing; `readable()` is for *reading/summarising* article-like
  pages (news, blogs, docs, wiki), where `snapshot()` is noisy and silently
  lossy on long prose. Article detection is unreliable, so `readable()` never
  hard-gates — it always returns the text plus an advisory `confidence`
  (`high`/`low`) and a hint to fall back to `snapshot()` on non-article pages.
  Exposed everywhere: `page.readable()`, MCP `readable` tool, bareagent
  `readable` tool, and `barebrowse readable` CLI (→ `.barebrowse/article-*.txt`).

### Fixed
- **Large pages no longer kill the CDP connection.** Node's built-in WebSocket
  (undici) silently caps decompressed messages at ~3 MB and *permanently* tears
  down the socket when a single `Accessibility.getFullAXTree` response exceeds
  it — which broke `snapshot()` (and consent dismissal during `goto()`) on big
  pages (e.g. long Wikipedia articles). `cdp.js` now uses the `ws` package with
  a 256 MB `maxPayload`; the built-in exposes no way to raise the limit.
  Regression test: `connect.test.js` snapshots a 12k-node page that tripped the
  old cap.

### Security
- **MCP output files are now owner-only (`0600`).** `saveSnapshot()` and the
  screenshot tool previously wrote snapshots / articles / screenshots with
  default perms (`0644` in a `0755` dir under the standard umask) —
  authenticated page content readable by other local users on a shared host.
  They now write `0600` files in a `0700` dir, umask-independent, matching the
  daemon's existing invariant. Regression-guarded by a test that fails on a
  `0644` write.
- **Daemon hardening:** `GET /status` (the only pre-auth endpoint) no longer
  returns the pid; `/command` now caps the request body at 16 MB (→ `413`).

### Changed
- **Two runtime dependencies (previously zero):** `ws` (CDP transport, above)
  and `@mozilla/readability` (`readable()`). Both are lightweight, widely
  adopted, and actively maintained, per the project's dependency rule (external
  only when the stdlib genuinely can't do the job).

## [0.12.0] - 2026-05-29

### Added
- **Shipped TypeScript types, generated from JSDoc.** The package now ships
  `.d.ts` declarations so adopters get autocomplete and type errors out of the
  box — no `@types/barebrowse`. The `.js` we author is still the `.js` that
  ships; there is **no build step for runtime code**. Types are generated by
  `tsc` (`checkJs` + `strictNullChecks`), emitted to a git-ignored `types/`, and
  built into the tarball at publish via `prepublishOnly`. Because they are
  generated-and-never-committed, the JSDoc, the `.d.ts`, and CI cannot drift.
  `exports` now carries a `types` condition on every subpath.
- **`ci.yml` (push/PR gate):** `npm ci → typecheck → build:types → test`. A
  JSDoc/code mismatch is now a type error that blocks merge. No lint step — `tsc`
  covers the bug class that matters for a vanilla-ESM lib.
- Dev-only tooling: `typescript` + `@types/node` (devDependencies; never
  shipped), `tsconfig.json`, and `typecheck` / `build:types` / `prepublishOnly`
  scripts.

### Changed
- **`publish.yml` is now manual-only (`workflow_dispatch`) — npm OIDC trusted publishing with provenance, idempotent, and verifies the registry end-state.**
- **Packaging now uses a `files` allowlist** (`src/`, generated `types/`,
  `cli.js`, `mcp-server.js`, and the doc set) instead of the old `.npmignore`
  denylist, which was removed. Repo-only files (`test/`, `docs/`, `CLAUDE.md`)
  are excluded from the tarball.

### Fixed
- **`auth.js`: cookie databases are now opened with `readOnly: true`.** The
  previous `readonly` (lowercase) key is silently ignored by `node:sqlite`;
  surfaced by the new `tsc` typecheck. Read-only was already enforced via the
  `?immutable=1` connection URI, so observable behavior is unchanged — this
  honors the intended option. Added minimal, behavior-preserving null/type
  guards in a few spots (`server.address()`, SQLite row values) flagged by
  `strictNullChecks`.

## 0.11.0

### Security hardening — audit findings fixed, safe-by-default

A full security audit of the library + CLI daemon + MCP server. Eight
findings were reproduced with live PoCs, fixed, and locked in with 14 new
regression tests (143 → 157 passing). Two new opt-in controls; two new
defaults that change behavior (see **Breaking** below).

- **Daemon authentication (was: unauthenticated `eval` over loopback).**
  The CLI daemon's HTTP server bound to `127.0.0.1` but had no auth — and
  loopback is shared across local users, so any local process could POST
  `/command` (including `eval` = arbitrary JS in the authenticated browser).
  Now every daemon mints a 32-byte random token at startup, written into
  `session.json` (mode `0600`) and required on `/command` via the
  `x-barebrowse-token` header (constant-time compare). `session-client.js`
  reads and sends it transparently — no caller change. `GET /status` stays
  open as a liveness ping returning only `{ ok, pid }`.
- **Artifact permissions.** The session dir is now created `0700` and all
  daemon artifacts (`session.json`, snapshots, screenshots, PDFs, console /
  network / dialog logs) plus `page.saveState()` output are written `0600`.
  `saveState` holds cookies + localStorage (session tokens), so this stops a
  multi-user host from reading another user's credentials off disk.
- **Navigation scheme guard (new module `src/url-guard.js`).** `goto()` /
  `browse()` now reject local-resource and browser-internal schemes
  (`file:`, `view-source:`, `chrome:`, `chrome-extension:`, `filesystem:`,
  `devtools:`, …) by default — closing a confirmed local-file-read /
  directory-listing vector for a prompt-injected agent. `http`/`https`/
  `data`/`blob`/`about` stay allowed (`data:` is opaque-origin and the
  test-fixture mechanism — not a read/SSRF vector). Override with
  `{ allowLocalUrls: true }`.
- **SSRF guard (opt-in `blockPrivateNetwork`).** When set, `goto()`/
  `browse()` refuse loopback / RFC-1918 / link-local / cloud-metadata
  (`169.254.169.254`) / `*.internal` hosts. Off by default so localhost
  dev-server browsing keeps working. Exposed as `--block-private-network`.
- **Upload sandbox (opt-in `uploadDir`).** `upload()` confirmed it would
  attach any absolute path to a file input (exfil vector under prompt
  injection). When `uploadDir` is set, every path must resolve (symlinks
  included, via `realpath`) inside it. Default unrestricted — nothing breaks
  unless you opt in. Exposed as `--upload-dir=DIR`. Both new opts pass
  through `connect()` → MCP / bareagent / CLI daemon uniformly.
- **Cookie injection scoped precisely (was: over-broad substring match).**
  `authenticate()` matched `host_key LIKE '%domain%'`, so browsing
  `apple.com` injected cookies for `apple.com.evil.org` / `notapple.com`,
  and `mybank.co.uk` (→ `co.uk`) pulled every `*.co.uk` cookie. The LIKE
  query is now only a coarse pre-filter; a precise RFC-6265
  `cookieDomainMatch()` decides what actually gets injected (parent-domain
  cookies like `.google.com` still apply to `mail.google.com`).
- **Hardening:** browser discovery uses `execFileSync('which', [name])`
  (no shell) instead of an interpolated `execSync` string; the cleanup
  busy-wait drops a `sleep` subprocess for `Atomics.wait`. Added
  `.gitignore` (was missing — `.barebrowse/` state/snapshots could be
  accidentally committed). Pinned `wearehere` to exact `1.0.0`.
- **Tests:** 157 total (14 new) — `test/unit/url-guard.test.js` (19
  assertions over scheme/private-host policy), `cookieDomainMatch` cases in
  `test/unit/auth.test.js`, daemon token + `0600` perms in
  `test/integration/cli.test.js`.

**Breaking:** (1) `file:`/`chrome:`/etc. navigation now throws by default —
pass `allowLocalUrls: true` to restore. (2) The CLI daemon now requires the
token; this is transparent via the bundled `session-client`, but any
third-party client hitting the daemon's HTTP API directly must send
`x-barebrowse-token` from `session.json`.

## 0.10.1

### Blocklist long-tail additions + legacy-Chrome warn + switchTab attach-mode test

Carry-forward items from the v0.10.0 backlog. All additive, no behavior
change on supported Chrome.

- **8 new patterns in `src/blocklist.js`** (120 → 128, still in the
  curated 80–200 band):
  - Mobile-measurement-on-web cluster (increasingly served from web
    pages, not just SDKs): `*.appsflyer.com`, `*.branch.io`,
    `*.adjust.com`.
  - Privacy-friendly analytics that still tracks from an agent POV:
    `static.cloudflareinsights.com` (Cloudflare Web Analytics),
    `*.matomo.cloud` (Matomo Cloud's hosted tier).
  - Broader Outbrain coverage: `amplify.outbrain.com`,
    `log.outbrain.com` (in addition to the existing
    `widgets.outbrain.com` and `*.outbrain.com/utils/*`).
  - Broader PostHog: `*.posthog.com/static/array.js*` (the snippet
    loader, in addition to the existing `/e/` and `/decide/` endpoints).
- **One-time `console.warn` when `Network.setBlockedURLs` rejects.**
  Legacy Chromium builds lacking the method previously failed silently
  inside `applyBlocklist`; now a single warn per process surfaces the
  reason so callers don't wonder why blocking isn't engaging. Stays
  silent on supported Chrome (success path), stays silent when
  `blockAds: false` opts out entirely. Module-scoped flag —
  intentionally not per-session, since the failure mode is the
  browser, not the session.
- **`switchTab()` + `blockAds:true` attach-mode integration test.**
  The v0.10.0 JSDoc claimed blocklist follows `switchTab()` in attach
  mode but had no automated guard. New test in
  `test/integration/blocklist.test.js` launches a real browser, opens
  a second tab via raw CDP (bypassing barebrowse so the tab simulates
  one the user already had open), attaches with explicit
  `blockAds: true` + `blockUrls: [pattern]`, switches into that tab,
  and asserts the tracker server gets zero hits and the tracker script
  never executed. Locks in the post-switch `applyBlocklist` call site
  that was added in v0.10.0.
- **Tests:** 143 total (5 new). 4 new unit tests in
  `test/unit/blocklist.test.js` (long-tail coverage drift guard +
  3-subtest warn-once suite covering rejection, success path, and
  opted-out paths); 1 new integration test as above.

## 0.10.0

### Ad/tracker URL blocking + canvas-noise stealth + Chromium pgid reap fix

Scrapling-inspired additions to make every snapshot quieter and every
headless session less fingerprintable, plus a flake fix surfaced by the
new work.

- **Ad/tracker URL blocking via CDP `Network.setBlockedURLs`.** New
  `src/blocklist.js` ships ~120 hand-curated glob patterns covering the
  high-frequency tracker families: Google ads + analytics, Facebook
  Pixel, Amazon ads, MS Clarity/Bing, Adobe Marketing Cloud, the
  consumer-pixel cluster (LinkedIn/Twitter/TikTok/Snap/Pinterest), the
  SaaS analytics stacks (Segment/Amplitude/Mixpanel/Heap/PostHog),
  session-replay (Hotjar/FullStory/LogRocket/Crazy Egg/Mouseflow),
  content recommendation (Criteo/Taboola/Outbrain), supply-side ad
  networks (AppNexus/Rubicon/PubMatic/OpenX/Trade Desk), and marketing
  automation (HubSpot/Marketo/Pardot/Intercom/Drift). Curated by traffic
  frequency rather than pulled wholesale from Peter Lowe — CDP does
  linear pattern matching per request, so the long tail of regional
  networks was measurable cost (~10ms cumulative on a 100-request page)
  for ~5% extra coverage we'd rarely hit in agent traffic. Net effect:
  smaller ARIA snapshots and faster page loads.
- **`opts.blockAds` and `opts.blockUrls` on `connect()` and `browse()`.**
  `blockAds` defaults to `true` for launched browsers and `false` in
  attach mode (would otherwise affect any tab in the user's running
  browser). Explicit `blockAds: true` in attach mode is honored and
  follows the session across `switchTab()`. `blockUrls` accepts extra
  glob patterns merged with the default unless `blockAds: false`.
- **CLI flags on `bb open`: `--no-block-ads` and `--block-urls=PATTERN`**
  (the latter repeatable). Plumbed through `cli.js`, `src/daemon.js`
  startDaemon args, and `runDaemon` → `connect()`. Not exposed via MCP
  or bareagent on purpose — agents inside a session shouldn't be
  reconfiguring infra per tool call; the decision belongs at session
  start.
- **Canvas fingerprint noise** in `src/stealth.js`. After WebGL
  (already spoofed in v0.9.0), canvas `toDataURL` / `getImageData` is
  the second-most-checked fingerprint vector — the pixel output of
  rendered text/shapes depends on GPU, driver, and font rasterizer in
  ways that are stable per machine but unique across machines, which
  makes it a tracking signal that survives cookie clearing. The patch
  XORs ~1 bit per 64-byte stride into the read pixels, with the bit
  derived from a position-mixed hash of a per-session
  `crypto.getRandomValues`-seeded value. Output is stable within a
  session (so legitimate canvas use doesn't flicker) and different
  across sessions (so fingerprinters see a fresh hash on every visit).
  The canvas bitmap is snapshotted and restored around encoding so any
  downstream legitimate read sees the original pixels.
- **Pre-existing Chromium subprocess reap flake fixed.** Chromium
  spawns renderer/GPU/network/utility subprocesses that, under
  `--site-per-process` (v0.9.0 H2), can outlive SIGTERM on the
  Chromium parent by seconds while still holding profile-dir file
  handles. Without `detached: true`, all of them shared Node's process
  group — there was no way to signal the whole Chromium tree without
  enumerating PIDs. `src/chromium.js` now spawns with `detached: true`
  so each Chromium becomes its own process-group leader, and
  `cleanupBrowser` / `reapAllSync` send SIGKILL to the negative PID
  (the whole group) before `rmSync`. Latent in `main`, but the new
  blocklist's added CDP setup overlapped the cleanup window enough to
  hit ~1-in-3 under parallel test load. Side effect: terminal SIGINT
  now goes to Node's pgid only — `registerExitHandlers`' SIGINT
  reaper is what kills Chromium under Ctrl-C and must not be removed.
- **`startDaemon` poll deadline 15s → 30s** for cold-boot margin on
  slower hardware (CI / older boxes) now that the blocklist adds a
  small amount of CDP setup time to the session-startup path.
- **Tests:** 138 total (10 new). New: 5-test unit suite for
  `DEFAULT_BLOCKLIST` (shape/coverage drift guards, must-cover
  tracker families, no dups); 2-test integration suite that proves
  `Network.setBlockedURLs` actually drops the matching subresource
  and that `blockAds:false` lets it through; 2 new canvas-noise
  subtests (patch installed, stable within session, different across
  sessions); 1 end-to-end `bb open --block-urls=PATTERN URL` test
  that proves the flag survives every hop through `cli.js` →
  `startDaemon` → daemon-internal → `connect()` → `setBlockedURLs`
  and that the tracker server sees zero hits.

## 0.9.1

### Pruning — `pruneMode` reaches MCP / bareagent and `read` finally works

- **`mode: 'read'` is now a real alias for `mode: 'browse'`** in `prune()`.
  Previously, the CLI (`barebrowse snapshot --mode=read`) and the SKILL.md
  advertised a `read` mode that did not exist — `MODE_REGIONS[mode] ||
  MODE_REGIONS.act` silently fell back to act-mode pruning. Articles, docs,
  and blog posts therefore came back gutted no matter which mode the agent
  asked for, which is why Claude tended to give up and fall back to
  WebFetch. One-line alias at the top of `prune()` fixes it; `act|browse|
  navigate|full` still behave unchanged.
- **MCP `browse` and `snapshot` tools gained a `pruneMode: 'act'|'read'`
  parameter** (mcp-server.js). Before this, the MCP surface had no way to
  ask for any mode other than `act` — `browse`'s `mode` param was browser
  mode (headless/headed/hybrid), and `snapshot` accepted only `maxChars`.
  Tool descriptions now tell the caller when to pick `read` (content-heavy
  pages: articles, docs, blogs).
- **bareagent `browse` and `snapshot` tools gained the same `pruneMode`
  parameter** (`src/bareagent.js`) with identical semantics. The `browse`
  handler preserves any caller-supplied default `opts.pruneMode` when the
  tool is called without an arg (`pruneMode ? { ...opts, pruneMode } : opts`).
- **Auto-hint when act-mode looks suspect.** When `page.snapshot()` or
  `browse()` is called in act mode against a substantial page (raw > 5 KB)
  and the pruned output collapses to under 500 chars AND under 5% of raw,
  the result includes a one-line `hint: act mode dropped most of the page
  — retry with pruneMode='read' …` directly between the stats line and the
  tree. Thresholds are deliberately conservative: an e-commerce or
  search-results page (many interactive elements kept) won't trigger it;
  a paragraph-heavy article will.
- **Regression test:** `test/unit/prune.test.js` — "aliases mode='read' to
  browse mode" pins the alias contract by asserting `prune(tree, {mode:
  'read'})` deep-equals `prune(tree, {mode: 'browse'})` and that paragraphs
  survive (the act-mode-style stripping that previously masqueraded as
  read-mode is gone).

## 0.9.0

Phase B — every H1–H9 from `docs/02-features/fix-plan.md` shipped one
commit each, plus the post-Phase-B code-review fixes. Two new modules
of functionality (iframe pipeline, download capture), two new public
API methods (`reload`, `onDialog`), six new MCP tools, opt-in `eval`,
per-tool MCP timeouts, full stealth coverage, and a tightened bot-
detection heuristic. 23 new regression tests. 123/123 tests pass.

See `docs/02-features/fix-plan.md` (Phase B section) and the per-fix
entries in `docs/03-logs/bug-log.md`. Headlines:

### Iframe / OOPIF support (H2)
- `Accessibility.getFullAXTree` stops at frame boundaries; pre-H2,
  Stripe, reCAPTCHA, embedded login forms, and most ads were invisible.
- `createPage()` now wires `Target.setAutoAttach({autoAttach: true,
  flatten: true})` and listens for `Target.attachedToTarget` to register
  every iframe's CDP session in a `framesByFrameId` map (recursive).
- `ariaTree()` walks `Page.getFrameTree`, fetches each frame's AX tree
  on the right session (child for OOPIF, main with `frameId` param for
  same-origin), splices children under iframe placeholders identified
  via `DOM.getFrameOwner`.
- Refs are globally unique via a flat counter shared across frames;
  refMap stores `{session, backendNodeId}` so `click`/`type`/`hover`/
  `select`/`upload` route to the correct CDP session. Visible
  `[ref=N]` format unchanged.
- `--site-per-process` added to launch flags so every iframe (including
  same-origin) becomes OOPIF with a dedicated session — required
  because `DOM.getBoxModel` returns frame-local coords while
  `Input.dispatchMouseEvent` on the parent session uses parent-viewport
  coords; OOPIF gives each frame its own Input domain.
- `drag()` between elements in different frames now errors rather than
  mixing sessions.

### Attach to a running browser (H1)
- `connect({port: 9222})` attaches to a Chromium the user already
  started (`chromium --remote-debugging-port=9222`). New
  `attach({port})` helper in `chromium.js` returns a browser handle
  with `process: null, ownedProfileDir: null` so `cleanupBrowser` is
  a no-op — we never kill or clean up a browser we didn't start.
- Attach mode skips stealth (would persist via
  `addScriptToEvaluateOnNewDocument`), `Browser.setPermission`
  (browser-wide — would leak deny-states), download capture (don't
  override the user's preference), and the two hybrid-fallback rewind
  branches in `goto()` (we don't own the browser).
- `close()` still closes the tab we created; the browser keeps running.

### Downloads (H7)
- `Browser.setDownloadBehavior({behavior: 'allowAndName',
  downloadPath, eventsEnabled: true})` wired in `connect()`. Falls
  back to `'allow'` on older Chrome; silent if neither works (downloads
  still happen, just unobserved).
- Per-session `mkdtemp('/tmp/barebrowse-dl-*')` cleaned up on `close()`;
  caller-supplied `opts.downloadPath` left alone.
- Live `page.downloads` array of `{guid, url, suggestedFilename,
  savedPath, state, totalBytes, receivedBytes}`. Listeners registered
  BEFORE `setDownloadBehavior` is sent (event ordering).
- Skipped entirely in attach mode.

### Stealth completeness (H4)
- `Network.setUserAgentOverride` strips "HeadlessChrome" from the UA in
  HTTP request headers AND `navigator.userAgent`. UA read from
  `Browser.getVersion` so version/platform fields stay accurate across
  Chromium releases.
- New JS patches: `WebGLRenderingContext`/`WebGL2` `getParameter`
  spoofs `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL` to
  Intel pair (the single most-used headless fingerprint);
  `navigator.hardwareConcurrency` = 8; `navigator.deviceMemory` = 8;
  full `chrome.runtime` enum shape (PlatformOs, OnInstalledReason,
  etc.); `Notification` constructor + `permission: 'default'`;
  `Permissions.query('notifications')` mirrors `Notification.permission`
  instead of returning hardcoded `'prompt'`.

### Bot-detection heuristic tightened (H9)
- Pre-H9 `nodeCount < 50` alone flagged any minimal legitimate page;
  generic phrases `access denied`/`unknown error`/`permission denied`
  flagged real HTTP 4xx/5xx pages, kicking hybrid into a costly
  headed launch for nothing.
- Split into STRONG_PHRASES (Cloudflare's "Just a moment", "Attention
  Required", "verify you are human" etc. — fire alone regardless of
  size) and WEAK_PHRASES (generic phrases — only fire when ALSO
  tiny: `nodeCount < 30` or `text.length < 50`). Pure low-node-count
  without a phrase no longer flags. `isChallengePage` exported so
  tests can pin the contract.

### New connect() methods
- **H3** `page.reload({ignoreCache, timeout})` — `Page.reload` wrapper
  with same SPA-fallback semantics as `goBack`/`goForward`. Clears
  `refMap` so pre-reload refs reject.
- **H8** `page.onDialog(handler)` — handler receives
  `{type, message, defaultPrompt}` and may return `{accept, promptText}`
  to override the default auto-accept. Pass `null` to restore.
  Persistent across hybrid fallback / `switchTab` / `createTab` —
  every `setupDialogHandler` reads the same closure.
- **H7** `page.downloads` — live array (see above).

### MCP server (H5 + H6)
- **H5:** new `TIMEOUTS` table replacing the blanket 30s — `goto`/
  `reload`/`wait_for` 60s; `back`/`forward` 30s; `click`/`type`/
  `press`/`scroll`/`hover`/`select`/`drag`/`snapshot`/`eval` 15s;
  `tabs` 5s; `pdf`/`screenshot`/`upload` 45s.
- **H6:** six new tools — `reload`, `screenshot`, `wait_for`, `tabs`
  (with optional `switchTo: N`), `select`, `hover`. All wired through
  the right `TIMEOUTS[name]`; mutating tools use `{retry: false}`.
- **H6 opt-in:** `eval` tool registered only when
  `BAREBROWSE_MCP_EVAL=1` is set. `Runtime.evaluate` in an
  authenticated session is the load-bearing risk (cookies/localStorage
  exfiltration). CLI/connect()/daemon keep `eval`; MCP gates it.
- `TIMEOUTS` and `TOOLS` exported; `runStdio()` exported so `cli.js`
  can launch the JSON-RPC loop explicitly (the earlier auto-start
  isMain guard broke `npx barebrowse mcp` — caught in code review).
- `serverInfo.version` now reads from `package.json` (was hardcoded
  '0.7.1' — drift caught in same review).

### CLI / daemon parity
- `barebrowse reload [--no-cache]` and `barebrowse downloads`
  subcommands added.
- `--download-path=DIR` flag plumbs through `startDaemon` →
  `runDaemonInternal` → `connect()`.

### bareagent adapter
- Three new tools: `reload`, `wait_for`, `downloads`. `onDialog`
  intentionally stays connect()-only (callback shape doesn't fit
  tool loop).

### MCP config diagnostics (post-Phase-B follow-up)
- **`barebrowse doctor`** scans every known MCP config location
  (Claude Code user/project/local, Claude Desktop, Cursor, VS Code)
  for `barebrowse` entries. Prints CONFLICT + both endpoint paths
  when scopes diverge. Closes the "Conflicting scopes" warning
  Claude Code surfaces but barebrowse itself was silent about.
- **`barebrowse install`** detects existing entries with a different
  endpoint and refuses to overwrite without `--force` — was
  silently clobbering, which is how scope conflicts accumulated in
  the first place.
- **`barebrowse mcp`** writes a one-line stderr banner at startup
  (`barebrowse mcp v<X.Y.Z> | serving from <abs path> | pid <N>`)
  so a stuck agent is diagnosable from the MCP log.

### Test infrastructure
- **`cleanupBrowser` profile-dir rm hardened** to 25×100ms±jitter
  (was 10×100ms). `--site-per-process` from H2 spawns a renderer
  per iframe; under parallel test load the old 1s window wasn't
  always enough to absorb post-exit file flushing.

### Tests
- 27 new regression tests across `connect.test.js` (H1, H2, H3, H7,
  H8), `stealth.test.js` (H4 — new file), `mcp.test.js` (H5 timeouts,
  H6 tool surface + eval env-var gating, npx cli.js mcp regression),
  `challenge.test.js` (H9 — new file, 9 cases), `cli.test.js`
  (reload + downloads subcommands, plus the four MCP-config-
  diagnostics tests for doctor + install --force + mcp banner).
  Total: 127 (54 unit + 73 integration).

## 0.8.0

Stability release — 11 fixes from the QA review of 2026-05-17. Adds a
new module (`network-idle.js`), introduces `cleanupBrowser()` helper,
and forwards `binary`/`userDataDir` opts through `connect()`/`browse()`.
17 new regression tests. 97/97 tests pass.

See `docs/02-features/fix-plan.md` for the full scope and the per-fix
entries in `docs/03-logs/bug-log.md`. Headlines:

### Lifecycle & cleanup
- **F2/F3:** Temp profile dirs no longer leak. New `cleanupBrowser()` helper
  awaits process exit, retries `rmSync` on ENOTEMPTY/EBUSY. On parent
  crash, module-level `process.on('exit'|'SIGINT'|'SIGTERM'|'SIGHUP')`
  handlers SIGKILL all tracked browsers and reap their dirs.
- **F1:** `page.cdp` escape hatch is now a getter — survives hybrid
  fallback / `switchTab` swapping the underlying session. Previously
  `daemon.js` console + network listeners silently died after any
  fallback.

### Correctness fixes
- **F4:** `switchTab(idx)` now actually swaps the working CDP session
  (re-attaches and rebinds the closure). Was only foregrounding the tab.
- **F5:** `goto()` invalidates `refMap` so stale refs from the prior page
  error clearly instead of resolving wrong-element clicks.
- **F8:** `goBack()`/`goForward()` await `Page.loadEventFired` instead of
  a fixed 500ms sleep — snapshots taken immediately after now reliably
  reflect the new page. Also invalidate `refMap`.
- **F9:** `waitForNetworkIdle` extracted to `src/network-idle.js`; uses a
  Set of requestIds so orphan finish events can't drive the tracker
  negative and resolve early.

### MCP server
- **F6:** `withRetry({ retry: false })` for state-mutating tools
  (`click`/`type`/`press`/`scroll`/`back`/`forward`/`drag`/`upload`).
  Idempotent tools (`goto`/`snapshot`/`pdf`) keep the retry default.
  Mutating ops no longer double-submit on a fresh blank page after a
  partial first attempt.
- `browse`/`goto` tool descriptions reworded to position `browse` as the
  headless fallback (not a competitor to WebFetch) and `goto` as the
  explicit interactive-session entrypoint.

### Tab handling
- **F7:** `createTab()` wires the dialog handler on the new tab's
  session — JS dialogs in sub-tabs no longer hang navigation forever.

### API
- **L2:** `connect()`/`browse()` now honor `binary` and `userDataDir`
  opts (forwarded through all `launch()` calls including hybrid
  fallback). `port` opt for attach-to-running-browser is queued for the
  next release (H1 in `fix-plan.md`).
- **L1:** Dropped dead `strictPatterns` block in `consent.js`.

### Tests
- 17 new regression tests across `cdp.test.js`, `mcp.test.js`,
  `network-idle.test.js`, `connect.test.js` + a subprocess fixture
  (`test/fixtures/launch-and-wait.mjs`). Total: 97 (44 unit + 53
  integration).

## 0.7.1

Fix: timeout now triggers auto-retry instead of bypassing it.

### Bug fix (`mcp-server.js`)
- **Root cause:** The 30s timeout was a `Promise.race` *outside* `withRetry()`. When a page timed out, the race rejected immediately — `withRetry` never got a chance to reset the session and retry. Timeouts also didn't match `isCdpDead()`, so even if they did reach `withRetry`, they wouldn't be retried.
- **Fix:** Moved per-attempt timeout *inside* `withRetry()`. Each attempt gets its own 30s deadline. On timeout or CDP death, the session resets and a fresh attempt runs. The outer `Promise.race` is removed entirely.
- `isCdpDead()` renamed to `isTransient()` — now also matches timeout errors (`"Timeout waiting for CDP event"`, `"timed out"`)
- Non-transient errors (validation, unknown tool) are still not retried

### Tests
- 11 new unit tests in `test/unit/mcp.test.js`: `isTransient` detection (CDP death, timeouts, non-transient), `withRetry` behavior (success, CDP retry, timeout retry, no-retry for validation, double-failure, no-timeout mode)
- 80 total tests (39 unit + 41 integration)

## 0.7.0

MCP resilience: timeouts, auto-retry, LLM-friendly scroll, and click fallback for hidden elements.

### Timeouts (`mcp-server.js`)
- All MCP tool calls now have a hard timeout: 30s for session tools, 60s for `browse` and `assess`
- Returns a structured error (`Tool "X" timed out after Ns`) instead of hanging silently
- Previously: a hung browser or slow page caused `[Tool result missing due to internal error]` — opaque and unrecoverable

### Auto-retry (`mcp-server.js`)
- `withRetry()` wrapper on all session tools (goto, snapshot, click, type, press, scroll, back, forward, drag, upload, pdf)
- On transient CDP failure (WebSocket closed, target/session closed), resets the session and retries once automatically
- Non-CDP errors (validation, unknown tool) are not retried

### LLM-friendly scroll (`mcp-server.js`, `src/bareagent.js`)
- Scroll tool now accepts `direction: "up"/"down"` in addition to numeric `deltaY`
- LLMs naturally say `scroll(direction: "down")` — this now works instead of crashing with `deltaX/deltaY expected for mouseWheel event`
- `"down"` → `deltaY: 900`, `"up"` → `deltaY: -900`. Numeric `deltaY` still works and takes precedence.
- Clear validation error if neither `direction` nor `deltaY` is provided

### Click JS fallback (`src/interact.js`)
- Click now falls back to JS `element.click()` when `DOM.scrollIntoViewIfNeeded` fails with "Node does not have a layout object"
- This error occurs on elements that exist in the ARIA tree but have no visual layout (display:none, zero-size, collapsed sections, detached nodes)
- Resolves the node via `DOM.requestNode` → `DOM.resolveNode` → `Runtime.callFunctionOn`
- Other click errors still throw normally

### Docs
- Updated barebrowse.context.md, README.md, prd.md with resilience features
- MCP server version string updated to 0.7.0

### Tests
- 71/71 passing — no test changes needed

## 0.6.1

Headed fallback is now a per-navigation escape hatch, not a permanent mode switch. Graceful degradation when headed is unavailable.

### Switch-back to headless (`src/index.js`)
- `connect().goto()` in hybrid mode: if currently headed from a previous fallback, kills the headed browser and launches fresh headless before navigating
- New `currentlyHeaded` runtime state variable tracks actual browser mode (vs `mode` which is user config)
- `createPage()` stealth decision uses runtime mode (`!currentlyHeaded`) instead of config mode (`mode !== 'headed'`)
- `createTab()` also uses `currentlyHeaded` for correct stealth application

### Graceful degradation (`src/index.js`)
- `connect().goto()` hybrid fallback wrapped in try/catch — if `launch({ headed: true })` fails (no `$DISPLAY`, no Wayland, CI/Docker), keeps the headless result with `botBlocked: true` and `[BOT CHALLENGE DETECTED]` warning
- `browse()` hybrid fallback also wrapped in try/catch — same graceful degradation for one-shot browsing
- No crash on headless-only environments

### Flow after changes
```
goto(url) in hybrid mode:
  1. If currently headed → kill headed, launch headless, reset currentlyHeaded
  2. Navigate to url
  3. Check bot-blocked
  4. If bot-blocked → TRY launch headed (set currentlyHeaded=true)
                    → CATCH: headed unavailable, keep headless result
```

### Docs
- Updated hybrid mode descriptions in barebrowse.context.md, system-state.md, prd.md

### Tests
- All existing tests pass (tests use headless mode, unaffected by hybrid logic)

## 0.6.0

Self-launching headed fallback. Headed and hybrid modes no longer require a manually-launched browser on port 9222 — barebrowse auto-launches a visible Chromium window via `launch({ headed: true })`.

### Headed mode auto-launch (`src/chromium.js`)
- `launch()` accepts `headed` option — skips `--headless=new` and `--hide-scrollbars` flags
- Same temp profile, same random port, same CDP parsing, same process return

### Hybrid fallback fix (`src/index.js`)
- All 4 `getDebugUrl(port)` call sites replaced with `launch({ headed: true, proxy })` + `createCDP(browser.wsUrl)`
- `browse()` headed branch, `browse()` hybrid fallback, `connect()` headed branch, `connect().goto()` hybrid fallback
- `getDebugUrl` import removed from index.js (still exported from chromium.js for external use)
- Hybrid mode now actually works — previously it tried to connect to port 9222 which nobody ran

### Assess handler simplified (`mcp-server.js`)
- Removed dual-path `runAssess(headed)` function (~60 lines of broken headed fallback)
- Assess now uses the session's hybrid mode: if tab is bot-blocked, triggers headed fallback via main page `goto()`, then retries in a new tab
- One flow, no separate `connect({ mode: 'headed' })` call

### Docs
- Removed all "launch browser with --remote-debugging-port=9222" instructions
- Updated headed/hybrid mode descriptions across barebrowse.context.md, README.md, system-state.md, prd.md

### Tests
- 71/71 passing — no test changes needed (all tests use headless mode)

## 0.5.8

Bot challenge detection for all browsing, not just assess.

### Bot detection (`src/index.js`)
- `isChallengePage()` now checks ARIA node count (<50 = bot-blocked) in addition to text length and phrase matching
- `botBlocked` property exposed on both `connect()` pages and `createTab()` tabs
- `goto()` on main page and tabs sets `botBlocked` after every navigation
- `snapshot()` prepends `[BOT CHALLENGE DETECTED]` warning line when flagged
- Hybrid fallback on main page now uses node count for more reliable detection

### Assess handler (`mcp-server.js`)
- Headed fallback now uses `tab.botBlocked` flag instead of naive score threshold (≤5 + all zeros)
- Previously: sites like Reuters, Home Depot, Leboncoin returned fake-clean scores because the bot challenge page looked "clean" to the scanner
- Now: node count catches every bot-blocked page regardless of score

### Tested
- reuters.com, homedepot.com, leboncoin.fr, idealista.com all correctly flagged `botBlocked: true`
- svt.se, whatsapp.com, google.com correctly flagged `false`
- 71/71 tests passing

## 0.5.7

MCP server crash resilience + process hardening.

### Process hardening (`mcp-server.js`)
- Added `unhandledRejection` and `uncaughtException` handlers — browser OOM/crash no longer kills the MCP server process
- Previously: heavy sites like zalando.de crashed the browser via OOM, the CDP WebSocket close rejected pending promises, unhandled rejections crashed Node
- Now: session resets and next request gets a fresh browser. Server stays alive.

### Validated at scale
- Scanned 149 sites across NL/US/EU with zero server crashes
- Only 1 genuine timeout (rtv.nl) — all former crashers (zalando.de, otto.de, bijenkorf.nl, jumbo.com, klm.nl) now return results
- Full results: `wearehere-scan-results.md`

## 0.5.6

Assess now works on bot-blocking EU sites. Headed fallback + consent fix.

### Assess headed fallback (`mcp-server.js`)
- Assess tries headless first; if result looks bot-blocked (score ≤5, all zeros), retries with a separate `connect({ mode: 'headed' })` session
- Previously all assess scans ran headless-only — sites like Lufthansa, Coolblue, Rabobank returned score 5 (empty page behind bot wall)
- Now: Lufthansa 50/high, Coolblue 55/high, Rabobank 75/critical

### Consent dismissal improvements (`src/consent.js`)
- Tab `goto()` now runs `dismissConsent()` (was missing — consent walls blocked all trackers from loading, making assess see a clean page)
- Added `/\baccepteren\b/i` Dutch pattern (Rabobank uses bare "ACCEPTEREN" without "alles")
- realClick fallback: if jsClick doesn't dismiss the CMP (button disappears from ARIA but overlay stays), retries with real `Input.dispatchMouseEvent` mouse click
- Both dialog-scoped and global consent paths now have the jsClick→realClick fallback

### createTab consent (`src/index.js`)
- `createTab().goto()` now dismisses consent after navigation (same as main page `goto()`)

## 0.5.5

Fix assess tab leak and Linux shared memory crash.

### Assess tab leak (`mcp-server.js`)
- Fixed: successful assess calls never closed the tab — tabs accumulated, eating RAM until Chromium crashed
- `tab.close()` now called in the success path (was only in error/timeout paths)
- This was the root cause of crashes on heavy EU cookie consent sites (zalando.de, otto.de, etc.) — not the CMPs themselves

### Chromium launch (`src/chromium.js`)
- Added `--disable-dev-shm-usage` flag — prevents shared memory crashes on Linux systems with limited `/dev/shm`

### Tests
- New: `createTab()` suite in browse.test.js (2 tests)
  - Creates 5 tabs, navigates each, closes all, verifies no zombie tabs remain
  - Tab close is idempotent (double-close doesn't throw)
- 71/71 passing (was 69)

## 0.5.4

Assess tool hardened: session reuse, concurrency, self-healing.

### Assess handler (`mcp-server.js`)
- Session reuse: assess now opens tabs in the existing session browser via `createTab()` instead of spawning a new browser per scan
- Concurrency: semaphore limits to 3 concurrent assess tabs, queues the rest
- 30s hard timeout per scan with force tab close on expiry
- Auto-retry once on failure with 2s backoff; resets session on CDP crash
- Removed debug logging added during development

### CDP resilience (`src/cdp.js`)
- `ws.onclose` handler rejects all pending CDP promises — prevents zombie promises on browser crash

### Library API (`src/index.js`)
- `createTab()` added to `connect()` return object — creates new tab in same browser session
- Returns `{ goto, injectCookies, waitForNetworkIdle, cdp, close }`, tab close doesn't affect main page

### Message loop (`mcp-server.js`)
- `getPage()` is concurrency-safe with promise dedup (prevents duplicate browser launches)
- Message loop changed from sequential `await` to concurrent `.then()` fire-and-forget — multiple tool calls no longer block each other

### Tests
- 69/69 passing
- Verified: 10 concurrent assess calls through MCP client, all succeed (3-at-a-time semaphore confirmed)

## 0.5.3

Improved bot detection for hybrid mode fallback.

### Challenge detection (`src/index.js`)
- `isChallengePage()` now catches near-empty pages (< 50 chars of text) as blocks
- Added challenge phrases: "unknown error", "access denied", "permission denied", "request blocked"
- Sites like CNN that return generic error pages instead of Cloudflare challenges now correctly trigger hybrid → headed fallback

## 0.5.2

Clean npm tarball + bareagent tool parity.

### npm package
- `.npmignore` updated: excluded `.barebrowse/`, `.mcp.json`, `baremobile.md`, `CLAUDE.md`, `docs/` from tarball
- Package size: 41 files / 390KB → 21 files / 180KB

### bareagent adapter
- Added `hover`, `tabs`, `switchTab`, `pdf` tools (was 13 + assess, now 17 + assess)
- bareagent now exposes the full connect() API surface

### Tests
- Fixed 2 snapshot URL prefix assertions (`# url` → `url: url`) to match 0.4.7 format change
- 69/69 passing

## 0.5.0

Privacy assessment via wearehere integration.

### New: `assess` tool
- Scans any URL for privacy risks: cookies, trackers, fingerprinting, dark patterns, data brokers, form surveillance, link tracking, and toxic terms of service
- Returns compact JSON: score (0-100), risk level (low/moderate/high/critical), per-category breakdown (10 categories with score/max/summary), concerns list, and recommendation
- Available in MCP server (13th tool) and bareagent adapter (14th tool)
- Conditionally loaded: only available when `wearehere` npm package is installed
- Uses a dedicated `connect()` page per scan (isolated from the session page)

### Integration
- `wearehere` added as optional dependency in package.json
- MCP server: dynamic `import('wearehere')` with try/catch fallback
- bareagent adapter: same dynamic import pattern
- Zero impact when wearehere is not installed — all existing tools work unchanged

### Version
- Package version: 0.5.0
- MCP server version string updated

## 0.4.8

- Fix: `browse()` one-shot also had `#` prefix (missed in 0.4.7)
- MCP server version string updated

## 0.4.7

Snapshot URL prefix format changed from `# <url>` to `url: <url>`.

- Fix: MCP clients (Claude Code) stripped `#`-prefixed lines as comments, making the URL invisible to agents
- Snapshot first line is now `url: <current-page-url>` (was `# <current-page-url>`)
- Stats line no longer prefixed with `#`

## 0.4.6

- README wording fix

## 0.4.5

- README: "What this is" rewritten — concise, no implementation details exposed

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
