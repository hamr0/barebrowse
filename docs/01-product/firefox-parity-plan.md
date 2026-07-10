# Firefox/BiDi Parity Plan

Roadmap to bring the Firefox (WebDriver BiDi) engine to practical parity with
the Chromium (CDP) engine — **without patched browser builds**. Written after
v0.15.0 shipped the core Firefox engine.

## Goal & non-goals

**Goal:** *practical* parity — the common capabilities an autonomous agent
relies on work the same on both engines, and the same code behaves the same
way. This is the **Playwright kind of parity** (unified API + the common
capability subset), NOT identical internals.

**Non-goals:**
- **Patched browser builds.** Playwright ships a custom Firefox with its own
  protocol (~200 MB). barebrowse's entire premise is "your installed browser,
  no download," so we drive stock Firefox over the W3C BiDi standard only.
- **100% AX-tree fidelity.** CDP's `getFullAXTree` is browser-native; Firefox
  BiDi has no equivalent, so we reconstruct in-page. We narrow the gap; we
  never fully close it cheaply. (Pruning itself is already identical — the gap
  is only source-tree accuracy.)

## Why parity is mostly *wiring*, not R&D

Almost every "Chromium-only" gap has a clean BiDi equivalent — it's unwired,
not impossible:

| Capability | CDP mechanism | BiDi equivalent | Status |
|---|---|---|---|
| Stealth / anti-detection | `Page.addScriptToEvaluateOnNewDocument` | `script.addPreloadScript` | port |
| Consent auto-dismiss | ARIA scan + jsClick (engine-agnostic) | run over the BiDi snapshot | reuse |
| Ad / tracker block | `Network.setBlockedURLs` | `network.addIntercept` | port |
| Console capture | `Runtime.consoleAPICalled` | `log.entryAdded` | port |
| Network capture / idle-wait | `Network.*` events | `network.beforeRequestSent` / `responseCompleted` / `fetchError` | port |
| Dialog handling | `Page.javascriptDialogOpening` | `browsingContext.userPromptOpened/Closed` | port |
| Hybrid (headless→headed) | orchestration (engine-agnostic) | same logic on FF path | reuse |
| Downloads | `Browser.downloadWillBegin` | BiDi download events (Firefox: partial) | partial |
| `reload({ignoreCache})` | CDP flag | not yet in Firefox BiDi | upstream |
| **Full AX-tree fidelity** | `Accessibility.getFullAXTree` | none — reconstruct in-page | ongoing |

## Current state (v0.15.0)

**Done:** BiDi transport (`bidi.js`), launch/reap (`firefox.js`), in-page AX
reconstruction (`ax-snapshot.js`), a page object with the full method surface
(`firefox-page.js`); `prune.js`/`aria.js`/`readable.js` reused verbatim;
navigation guard + upload sandbox enforced; incognito + host-scoped cookie
injection (shared `scopedCookiesForUrl`); nav timeouts; iframe/select/body-text
snapshot fixes.

**Gaps (documented known-limitations):** stealth, consent, ad-block, hybrid,
console/network capture, dialogs, `saveState`, `waitForNavigation`,
`waitForNetworkIdle`, downloads, `reload({ignoreCache})`.

## Phased roadmap

Ordered by (value ÷ cost). Each phase is independently shippable and mirrors
the CDP integration tests on the Firefox path.

### Phase 1 — Anti-detection + consent  *(highest visible value)*
Fixes the two most agent-breaking gaps: Firefox headless getting bot-blocked,
and consent dialogs never dismissed.
- **Stealth:** register the existing `stealth.js` patches via
  `script.addPreloadScript` (BiDi's `addScriptToEvaluateOnNewDocument`).
- **Consent:** reuse `consent.js`'s ARIA-scan-then-click over the BiDi
  snapshot; the logic is already engine-agnostic — only the click/eval calls
  need the BiDi resolveRef path.
- **Test:** bot-challenge fixture stays act-able; a 7-language consent fixture
  auto-dismisses.

### Phase 2 — Observability parity *(restores CLI/daemon)*
- **Console:** subscribe `log.entryAdded` → `consoleLogs`.
- **Network:** subscribe `network.beforeRequestSent` / `responseCompleted` /
  `fetchError` → `networkLogs`, mirroring the CDP request/response bookkeeping.
- **`waitForNetworkIdle`:** in-flight counter over those events (same shape as
  `network-idle.js`), replacing the current "not supported" stub.
- **Daemon:** drop the `console-logs`/`network-log`/`wait-idle` "Firefox skips
  these" caveat once wired.

### Phase 3 — Noise reduction + dialogs
- **Ad/tracker block:** feed the existing `blocklist.js` patterns into
  `network.addIntercept` (block-phase), matching the CDP `blockAds` default.
- **Dialogs:** subscribe `browsingContext.userPromptOpened`, auto-handle +
  record into `dialogLog`; replace that stub.

### Phase 4 — Resilience + remaining methods
- **Hybrid-equivalent:** on a detected challenge page, relaunch headed — reuse
  the CDP orchestration; it's engine-agnostic.
- **`saveState`:** cookies via `storage.getCookies` + localStorage via
  `script.evaluate`; replace that stub.
- **`waitForNavigation`:** resolve on `browsingContext.navigationStarted` →
  `load`; replace that stub.
- **Downloads:** wire BiDi download events where Firefox supports them; document
  residual gaps.
- **`reload({ignoreCache})`:** track the Firefox BiDi feature; enable when
  available (upstream-blocked, no local fix).

### Phase 5 — AX-tree fidelity *(ongoing, never 100%)*
- **Fidelity harness:** snapshot a fixture corpus on **both** engines, diff the
  reconstructed FF tree against the CDP native tree, and drive work by measured
  divergence (roles, accessible names, states) — evidence, not guesswork.
- **Coverage:** expand `ax-snapshot.js` toward the full W3C accname algorithm
  (label/description precedence, `aria-describedby`, hidden-ref rules), richer
  ARIA state props, table/grid semantics, more implicit-role mappings.

## Cross-cutting

- **Capability introspection:** expose `page.engine` and a `page.capabilities`
  map (e.g. `{ stealth, consent, adBlock, networkCapture, hybrid }`) so an
  autonomous agent can *check* rather than assume — the mitigation for silent
  capability divergence. Snapshot header can echo the engine.
- **Loud fallback-on-absence:** when no engine is specified and no Chromium is
  installed, fall back to Firefox with a clear one-line warning naming the
  unavailable capabilities; explicit `engine:'chromium'` never falls back
  (reproducible/CI contract). `doctor` reports detected engines + the effective
  default. (See the engine-selection discussion.)
- **Testing discipline:** every ported capability gets a Firefox integration
  test mirroring its CDP counterpart; the Phase-5 harness guards fidelity.

## Effort / value summary

| Phase | Effort | Value | Notes |
|---|---|---|---|
| 1 Anti-detection + consent | M | **High** | fixes bot-block + stuck consent |
| 2 Observability | M | Med-High | restores daemon/CLI parity |
| 3 Ad-block + dialogs | M | Med | de-noises the action tree |
| 4 Resilience + methods | M–L | Med | hybrid, saveState, waits, downloads |
| 5 AX fidelity | L (ongoing) | Med | correctness; never 100% |

**Recommended first cut:** Phase 1 as v0.16.0 — it removes the two gaps most
likely to make an agent silently fail on Firefox, and both are near-direct
ports of code we already have.
