# Findings

Experiments we ran, what they showed, and what not to try again without a new reason.
Each entry: question, setup, result, verdict. Newest first. Numbers are from the day they were measured; sites change.
Standing decisions and lessons moved out of the PRD are at the end, under *Decisions and lessons (from the PRD)*.

---

## 2026-11-18 — Hidden calls, URL knobs and "site maps" for agents

**The question.** Modern sites paint their screens on top of their own JSON calls. Can barebrowse find those calls, replay them, and make sites easier and cheaper for agents (and get blocked less)? Could that grow into a per-site "call map" and a shared index ("Google for bots")?

**Verdict: no feature to build.** Agents already change URLs on their own, rarely use a list of calls, and misuse a fetch tool. The real value of the work was the barebrowse bugs it shook out (N32–N36). The idea is recorded and parked in `docs/product/prd.md` (Medium-term "Action → calls", Long-term "Site call map").

### F1. Can the action → call link be found? (8 shops, headless, typed "laptop" in the search box)

| Shop | Result |
|---|---|
| Target, IKEA | One clear suggestion call. Replay worked in-page **and** from plain Node (no browser). |
| Best Buy | Clear call (`/suggest/v1/fragment/suggest/www?query=laptop…`). In-page replay 200; replay from outside the browser **failed**. |
| Amazon | Got in, but typing fired only tracker pings (9 of 9); no suggestion call seen. Cause unknown. |
| Walmart | Press & Hold wall (got in 1 of 3 tries across modes). |
| Etsy | DataDome slider (403). |
| eBay, Home Depot | Flat 403 on the first document. |

- Headless vs hybrid vs headed made **no difference** to the flat-403 sites: the block comes with the first document, before any page code runs.
- Some "blocked" results were an unclicked step, not a block (Best Buy's country picker).
- Search boxes may need real key presses: `type(ref, text, { keyEvents: true })`. The default paste (`Input.insertText`) did not fire suggestions everywhere.
- In-page `fetch()` to another origin needs `credentials: 'omit'`, or CORS rejects it (IKEA's search host).

### F2. Are the raw call answers a token saving? (results pages: Target, IKEA, Best Buy)

| | Snapshot | Raw results call |
|---|---|---|
| Target | 56k chars | 1,140k chars (20×) |
| IKEA | 37k chars | 141k chars (4×), and it is a POST with the query in the body |
| Best Buy | 25k chars | none — results are server-rendered |

- Filtering by request type + JSON mime: 250–323 requests → 15–22 data calls → 1–4 that hold the results.
- URL knobs on the call worked on Target (`keyword=monitor`, `page=0 → 1`).
- A quick generic shrink (largest list of look-alike objects, short fields only): IKEA 141k → 31k (no better than the snapshot); picked the wrong list on Target.
- **Verdict:** raw responses are not a saving. Never inline a response body by default. A generic JSON shrinker is not planned.
- What costs is what the agent *reads*, not what the browser downloads: a page load downloads more, but the snapshot is trimmed.

### F3. POC "callHints" — tried by peer fwd with a $0 harness (F217) and a real agent (F218)

POC (throwaway worktree, branch `poc/action-calls` @ 25ce555, never merged): with `connect({ callHints: true })`: a `[URL knobs: k=v …]` line under the snapshot's `url:` line; `page.calls()`/`callsText()` listing the JSON calls the last action caused with a size verdict; `page.fetch()` in-page behind the URL guard, big bodies to a 0600 file.

F217 ($0 harness):
- Google Flights: hint showed `curr=USD`; `curr=EUR` + goto gave the same 37 flights in EUR, no UI.
- Amazon: hint showed `page`; `page=2` + goto gave a new page.
- The hint line was the only change to the snapshot.
- Long values cut at 30 chars hid the useful part (`q=Flights from AMS to LHR on 202…`).
- Calls list had nothing usable: Flights' data call is a POST; Amazon is server-rendered, so only telemetry and cart calls — and those were labelled "small — fetch ok".
- On Target the list showed 16 calls incl. 4 bot-check collector POSTs and a survey vendor, all "fetch ok". **A size label does not mean useful or safe.**

F218 (deepseek-flash, neutral prompt, no mention of the feature, 17 samples, $2.43 under a $3 cap, with a hint-off control arm):
- **The hint barely changed behaviour.** URL edits: hint on 5/6, hint off 3/4. Chars fed ~99k vs ~101k per sample. Page loads 3.6 (on) vs 2.6 (off).
- Currency: the `curr` knob was in every hint-on snapshot and was **ignored**; agents always used the UI menu.
- Amazon page 2: the agent built `page=2` itself; the page-1 hint did not even list `page`.
- `calls()` was used in 1 of 7 hint-on samples.
- `fetch()` was misused as an HTML downloader (Best Buy search page 922k chars, then read the file) and ran out of rounds with no answer.
- Once Target started blocking, the agent fetched the block page and read junk from it.
- No sample replayed a POST, a tracker or a cart call.

**Do not repeat** without a new reason: action → calls lists, in-page fetch tools, URL-knob hints, raw-response shrinking, per-site call maps. If revisited, the bar is an agent test with a hint-off control that shows a real difference.

### F4. Bugs this work found in barebrowse

| ID | Bug | Status |
|---|---|---|
| N32 | Chromium snapshots did not read cross-site iframes (only the placeholder showed). The existing test used a `data:` iframe, which stays in-process. | Fixed on `fix/cross-site-iframe-snapshot` |
| N33 | Nested cross-site iframes stayed invisible (attach events were only heard on the main session). | Fixed, same branch |
| N34 | Target's HUMAN "Human verification" page not flagged: the small-page test counted ~400 nodes, nearly all ignored (~30 visible). | Fixed (`1bbeef6`); live: Target block page now flagged |
| N35 | `click("ref=441")` rejected; agents copy the `[ref=441]` form. | Fixed (`3223866`), both engines |
| N36 | A click landing on an overlay failed silently (Amazon's "International Shopping Transition Alert" backdrop covered the page). | Fixed (`87e68b6`): click now throws `click blocked: the point is covered by <div …>`; live-checked on Amazon |

Checked and **not** barebrowse bugs:
- Best Buy search shows only a sponsored product in headless, even after scrolling — the DOM itself holds no product grid (3.7k chars of text). The snapshot matches the DOM. Not checked in headed mode.
- Etsy's DataDome slider is visible after N32, but its handle has no role or name in the accessibility tree, so an agent cannot target it. Left alone ("enough, not perfect").
- fwd's "socket hang up" errors in F218 came from the model provider's connection, not barebrowse.

### Scripts

Saved (git-ignored) in `.claude/stash/poc-2026-11-18/`: `poc-sitemap.mjs` (F1), `poc-calls.mjs` + `shrink.mjs` (F2), `oopif.mjs` + `nested.mjs` (N32/N33 repros). The POC build lives in worktree `/home/hamr/PycharmProjects/bb-calls`. fwd's raw traces and scorer are on fwd's side (F217/F218, branch `poc/f217-bb-calls`).

---

## Decisions and lessons (from the PRD)

Moved here from the PRD on 2026-11-18 so the PRD holds only requirements. Citations point at the archived original, `docs/archive/prd.md`.

### Decisions — why we chose each

This log exists so settled decisions are not re-debated (docs/archive/prd.md:314-314).

| Decision | Choice | Why | Alternative considered | Why not |
|---|---|---|---|---|
| Browser protocol | CDP direct | Uses user's browser, ~165-line client, all 3 modes | Playwright | 200MB download, bundles its own Chromium, abstracts what we need raw |
(docs/archive/prd.md:318-318)

| Decision | Choice | Why | Alternative considered | Why not |
|---|---|---|---|---|
| Page representation | ARIA tree | Semantic, token-efficient, what agents need | DOM/HTML | Bloated, noisy, needs heavy parsing |
| Pruning | Built-in | Agents always need pruned output | Optional/separate | Two deps for one job, pruning isn't optional |
(docs/archive/prd.md:319-320)

| Decision | Choice | Why | Alternative considered | Why not |
|---|---|---|---|---|
| Cookie auth | Own auth.js + CDP inject | User's existing sessions (Firefox or Chromium), cross-browser injection into headless Chromium | OAuth/credential storage | Complex, security liability, reinventing what the browser already solved |
| Three modes | One flag | Same CDP code, ~20 lines difference | Separate packages | Same code, artificial separation |
| Chromium via CDP | CDP constraint | ~80% browser share, user's real browser | Cross-browser (Playwright) | Requires Playwright, loses "use your own browser" benefit |
(docs/archive/prd.md:321-323)

| Decision | Choice | Why | Alternative considered | Why not |
|---|---|---|---|---|
| Firefox via BiDi | `connect({ engine: 'firefox' })` | CDP is deprecated in Firefox; BiDi is the W3C-standard successor. Second transport (`bidi.js`) over the *same* `ws` dep — no geckodriver, no new dependency. Reuses `prune.js`/`aria.js`/`readable.js` verbatim | Playwright / geckodriver / drop Firefox | Playwright = 200MB + abstraction; geckodriver = an extra binary + process; dropping Firefox cedes a real engine |
| BiDi AX tree | In-page reconstruction (`ax-snapshot.js`) | BiDi has no `getFullAXTree`. Rebuild a CDP-vocabulary tree in one `script.evaluate` (implicit roles, accname, hidden-filtering, shadow-DOM) so pruning/formatting are shared unchanged. POC-measured: 12k nodes → ~1 MB / ~67 ms, socket survives | Native AX API / incremental DOM walk | BiDi exposes no AX API; a naive per-node walk is slow and lossy. Validated against real CDP snapshots |
(docs/archive/prd.md:324-325)

| Decision | Choice | Why | Alternative considered | Why not |
|---|---|---|---|---|
| Anti-detection | Runtime.evaluate patches | Minimal stealth for headless mode | Full stealth framework | Over-engineering; headless + real cookies handles 90% |
| Daemon/server | None | CDP is direct, no intermediary needed | sweetlink daemon pattern | Unnecessary complexity for local agent→browser |
| Framework | None (vanilla JS) | Matches bare- philosophy, minimal deps (only `ws` + `@mozilla/readability`, both lightweight) | Express/Fastify wrapper | Not a server, not needed |
(docs/archive/prd.md:326-328)

| Decision | Choice | Why | Alternative considered | Why not |
|---|---|---|---|---|
| Language | Vanilla JavaScript | Node.js ecosystem, same as bareagent, CDP libs available | TypeScript | Added build step for shipped code; instead we ship types via JSDoc→`.d.ts` (see types-pipeline row) with no transpile |
| Types | JSDoc → generated `.d.ts` | Adopters get autocomplete + type errors; the `.js` we author is the `.js` that ships (no build step); `tsc --noEmit` turns JSDoc into a CI-checked contract so it can't drift | Hand-written `.d.ts` / full TypeScript | Hand `.d.ts` go stale; TS needs a transpile step. Generated-and-git-ignored `.d.ts` make drift structurally impossible |
| Naming | chromium.js | Covers all Chromium-family browsers, not just Chrome | chrome.js | Too specific; Brave/Edge/Arc are also targets |
| mcprune integration | Absorb pruning logic | One package does it all, mcprune pruning is a pure function | Keep separate | Agents shouldn't need two packages to browse |
| openclaw lesson | Single bridge protocol | One CDP connection vs many API integrations | Direct multi-API | openclaw proved this fails — bloat, maintenance, fragility |
(docs/archive/prd.md:329-333)

| Decision | Choice | Why | Alternative considered | Why not |
|---|---|---|---|---|
| CDP transport | `ws` package | Node's built-in WebSocket silently caps decompressed messages ~3 MB and *kills the socket* when `getFullAXTree` on a big page exceeds it — no knob to raise it. `ws` exposes `maxPayload` (set 256 MB). First runtime dep; justified by the "external only when stdlib genuinely can't" rule | Built-in WebSocket / incremental `getChildAXNodes` walk | Built-in can't raise the cap; the zero-dep incremental walk was 14 s + 117 MB garbage on a normal page and still crashed (measured) |
| Reading mode | `readable()` via Mozilla Readability | Some tasks need to *read* an article, not act on it — `snapshot()` is noisy and silently lossy on long prose. Readability is the Firefox Reader-View engine, injected in-page over CDP (works on JS-rendered articles). Companion to `snapshot()`, not a replacement | Reuse `read`-mode snapshot / hand-rolled extraction | Read snapshot drops body text on long pages; content extraction is sanitization-adjacent → use the vetted library, not a homegrown parser |
(docs/archive/prd.md:334-335)

### Repos studied — what we borrowed and why

| Repo | What we took | What we skipped |
|---|---|---|
| **steipete/sweet-cookie** | The *approach* — cookie extraction from browser profiles + OS-keyring decryption | The package itself: not published to npm, so `auth.js` reimplements the technique (Chromium KWallet/GNOME + Firefox plaintext) |
| **steipete/sweetlink** | CDP dual-channel concept, selector discovery scoring, click/command patterns | Daemon architecture, WebSocket bridge, in-page runtime injection, HMAC auth |
| **steipete/canvas** | Stealth/anti-detection config patterns | Go implementation (we're JS) |
| **nichochar/open-operator** | AI agent web automation patterns | Full framework, too opinionated |
(docs/archive/prd.md:455-458)

| Repo | What we took | What we skipped |
|---|---|---|
| **AntlerClaw/playwright-mcp** | How to expose browser as MCP tools | Playwright dependency |
| **AntlerClaw/mcp-browser-use** | MCP-native browser patterns | Heavy deps |
| **AitchKay/chromancer** | Accessibility tree extraction approach | Different stack |
| **mcprune (own)** | ARIA pruning logic — role taxonomy, landmark extraction, noise removal, wrapper collapsing | Playwright dependency, MCP proxy architecture |
| **openclaw (own)** | Lesson learned: multi-API direct integration = bloat. Use a single bridge protocol | Everything — the architecture was the cautionary tale |
(docs/archive/prd.md:459-463)

#### The openclaw lesson

openclaw tried to integrate 10+ messaging APIs directly — each with its own auth, format, quirks. It became a maintenance nightmare. multis solved the same problem by using Beeper/Matrix as a single bridge (docs/archive/prd.md:467-467).

barebrowse applies the same lesson: instead of integrating Playwright + Puppeteer + WebDriver + stealth plugins + cookie libraries + proxy managers, we use **one protocol (CDP) to one browser (the user's)**. Everything else is unnecessary (docs/archive/prd.md:469-469).

---

## Moved verbatim from the PRD

Copied word for word from the archived original on 2026-11-18, when the PRD was cut down to requirements. Each block names its source lines in `docs/archive/prd.md`. Headings inside the blocks are demoted so they nest here. Some numbers and statuses are old; check the code before relying on one.

### Status and version history (the old PRD header)

*Source: `docs/archive/prd.md` lines 5–5.*

**Status:** Phase B (headed enhancements + bot-resistance + MCP completeness) complete @ v0.9.0; pruneMode follow-up shipped @ v0.9.1. v0.10.x added ad/tracker blocking + canvas-noise stealth. **v0.11.0 = security hardening release** — full audit of library + CLI daemon + MCP server; eight findings fixed and regression-tested. See the "Security model & safe defaults" section below and the v0.11.0 CHANGELOG entry. **v0.12.0** adopted the shared JS-library publishing conventions: a JSDoc→`.d.ts` types pipeline (`tsc` checkJs + strictNullChecks, gated in CI), a `files` allowlist, and a push/PR `ci.yml`. **Unreleased** adds `readable()` (clean article extraction via Mozilla Readability), fixes a CDP WebSocket size cap that killed `snapshot()` on large pages (swap to the `ws` package), and extends the `0600`/`0700` artifact-permission invariant to the MCP surface — 168 passing. barebrowse now has two lightweight runtime deps (`ws`, `@mozilla/readability`); see the Decisions Log and CHANGELOG.

### CDP-direct: why, what we lose, what we gain

*Source: `docs/archive/prd.md` lines 55–64.*

**Why:**
- Playwright downloads a bundled Chromium (~200MB). barebrowse uses the browser already installed on the user's machine.
- Playwright abstracts CDP, but we need CDP directly for all three modes (headless, headed, hybrid) against the user's real browser.
- Every Playwright API call maps 1:1 to a CDP method. The abstraction adds weight without adding capability for our use case.
- CDP gives us everything: `Accessibility.getFullAXTree`, `Page.navigate`, `Runtime.evaluate`, `Input.dispatch*Event`, `Network.setCookie`, `Page.captureScreenshot`.
- The CDP WebSocket client is ~165 lines of vanilla JS (over the `ws` package). Playwright is ~50,000.

**What we lose:** WebKit/Safari. CDP only works with Chromium-family browsers (Chrome, Chromium, Edge, Brave, Vivaldi, Arc, Opera). Firefox — which deprecated CDP — is now supported through a second transport over the same `ws` dependency (see *BiDi-Direct* below), so the CDP path covers Chromium (~80% of desktop) and BiDi covers Firefox.

**What we gain:** Zero heavy deps, uses the user's real browser, same code path for headless/headed/hybrid, drastically simpler codebase.

### BiDi-direct: why, the AX-tree risk and how it was retired, what we gain

*Source: `docs/archive/prd.md` lines 70–77.*

**Why:**
- CDP was deprecated in Firefox; BiDi is the W3C-standard successor (and Chrome implements it too, so this is not a Firefox-only detour).
- A direct BiDi socket at `ws://HOST:PORT/session` speaks `session.new` / `browsingContext.navigate` / `script.evaluate` / `input.performActions` / `storage.setCookie` — a near 1:1 map onto the existing `page.*` surface.
- Firefox cookies are already extracted by `auth.js` (plaintext SQLite, no keyring) and inject back via `storage.setCookie` — same-engine reuse (Firefox → Firefox), strictly more faithful than the cross-engine cookie path.

**The load-bearing risk — and how it was retired:** BiDi has **no `Accessibility.getFullAXTree`**. The entire value prop (a pruned ARIA snapshot) depends on an AX tree. So Firefox reconstructs a **CDP-vocabulary** AX tree *in-page* via one `script.evaluate` (`src/ax-snapshot.js`): implicit ARIA roles, accessible-name computation, `aria-hidden`/visibility filtering, and shadow-DOM/`<slot>` traversal — emitting the exact `{ nodeId, role, name, properties, children, ignored }` shape `prune.js` and `aria.js` already consume, so both are reused unchanged. A POC proved (measured, not asserted) that a 12k-node page serializes as ~1 MB in ~67 ms and the socket survives — the same large-payload failure that forced the `ws` dependency on the CDP side. Fidelity was validated against real CDP snapshots of identical fixtures; the hard cases (nested iframes with cross-context clicks, open shadow DOM, strict CSP, SPA late-DOM) are covered by `test/integration/firefox.test.js`.

**What we gain:** Firefox as a first-class target, W3C-standard alignment, no bundled driver, and the pruning/formatting/reader pipeline shared verbatim across engines.

### Firefox parity: capability table, shared cores, phase status

*Source: `docs/archive/prd.md` lines 85–106.*

Almost every "Chromium-only" gap turned out to be *wiring*, not R&D — each CDP mechanism has a clean BiDi equivalent:

| Capability | CDP mechanism | BiDi equivalent | Status |
|---|---|---|---|
| Stealth / anti-detection | `Page.addScriptToEvaluateOnNewDocument` | `script.addPreloadScript` | done (v0.16.0) |
| Consent auto-dismiss | ARIA scan + click (engine-agnostic) | run over the BiDi snapshot | done (v0.16.0) |
| Console capture | `Runtime.consoleAPICalled` | `log.entryAdded` | done (v0.17.0) |
| Network capture / idle-wait | `Network.*` events | `network.beforeRequestSent` / `responseCompleted` / `fetchError` | done (v0.17.0) |
| Ad / tracker block | `Network.setBlockedURLs` | `network.addIntercept` (catch-all + in-process match) | done (v0.18.0) |
| Dialog handling | `Page.javascriptDialogOpening` | `browsingContext.userPromptOpened` + `handleUserPrompt` | done (v0.18.0) |
| Hybrid (headless→headed) | relaunch orchestration | relaunch + page rebind on the FF path | done (v0.19.0) |
| `saveState` | `Network.getAllCookies` + localStorage | `storage.getCookies` + `script.evaluate` | done (v0.19.0) |
| `waitForNavigation` | `Page.loadEventFired` | `browsingContext.load` | done (v0.19.0) |
| Downloads | `Browser.downloadWillBegin` | `browsingContext.downloadWillBegin`/`downloadEnd` | done (v0.19.0) |
| `reload({ignoreCache})` | CDP flag | not yet in Firefox BiDi | upstream gap |
| Full AX-tree fidelity | `Accessibility.getFullAXTree` | none — reconstruct in-page | harness done (Phase 5); ongoing |

Two shared cores keep the engines from drifting: `challenge.js` (`isChallengePage`, the hybrid gate) and `dialog.js` (`decideDialog`, the JS-dialog decision).

**Phase 5, done:** an AX-tree **fidelity harness** (`test/integration/ax-fidelity.test.js`) drives a fixture corpus through both engines and asserts the Firefox reconstruction never drops a role+name node the CDP baseline found — repeatable in place of the earlier by-hand comparison, mutation-verified against `src/ax-snapshot.js`. Capability introspection also shipped: `page.engine` + a `page.capabilities` map so a caller can *check* rather than assume, surfaced over MCP (`capabilities` tool + `initialize.instructions` + the `browse` tool description) and via `barebrowse doctor`, which now reports detected engines/cookie sources/effective default and any live session's engine + capabilities. `capabilities.stealth` is a live getter (not frozen at connect time) so it reflects the session's current headed/headless state even after a hybrid bot-challenge relaunch. A loud fallback when no Chromium is installed also shipped: `connect()` with no explicit `engine` prefers Chromium but falls back to Firefox (warning once to stderr) when only Firefox is present, and throws naming both when neither is installed; an explicit `engine` is always honored and errors on a missing binary instead of silently switching.

**Still ahead:** driving `ax-snapshot.js` toward the full W3C accname algorithm by measured divergence.

### ARIA-first: why

*Source: `docs/archive/prd.md` lines 112–117.*

**Why:**
- The accessibility tree is the semantic structure of the page — roles, names, states, interactive elements. It's what screen readers see. It's also what agents need.
- DOM is bloated: wrapper divs, styling, tracking pixels, ad scripts. An agent doesn't need any of that.
- mcprune already proved this: ARIA snapshots pruned by role achieve 75-95% token reduction on typical pages while preserving all actionable information.
- CDP's `Accessibility.getFullAXTree` returns the tree directly. No parsing HTML, no building a DOM tree, no traversing nodes.
- ARIA refs map directly to CDP interaction targets — the agent reads a button in the tree and can click it via the same CDP connection.

### Three modes: cost

*Source: `docs/archive/prd.md` lines 133–133.*

After connection, every CDP command is the same. Three modes = ~20 extra lines in `chromium.js`, not three implementations.

### Cookie authentication: why, and the expiry limitation

*Source: `docs/archive/prd.md` lines 149–157.*

**Why:**
- The user's browser has active sessions for every site they use. We reuse those sessions instead of building new auth flows.
- sweet-cookie isn't published to npm, so `auth.js` is our own focused implementation: it reads Chromium and Firefox cookie SQLite databases and decrypts Chromium cookies via the OS keyring (KWallet on KDE, GNOME keyring / libsecret otherwise); Firefox cookies are plaintext. (Cross-browser injection into the headless Chromium instance — see the Decisions Log "Cookie auth" row.)
- For headed mode, cookies are already present in the browser — no extraction needed.
- For headless mode, we extract from the user's profile and inject into the headless instance.

**Opt-out — incognito (`incognito: true`):** A clean, unauthenticated session. Skips *all* auth injection — no cookie extraction/injection and no `storageState` — so the agent browses logged-out. (The session profile is already a throwaway temp dir; incognito gates the *other* auth source: the user's real browser cookies. It is not Chrome's `--incognito` flag.) The gate is enforced at the page-object level, so it holds even when a caller injects unconditionally (MCP `goto`, the daemon). Exposed on `browse()`, `connect()`, both engines, MCP (`browse` arg + `BAREBROWSE_INCOGNITO=1`), and CLI (`--incognito`).

**Limitation:** Cookies expire. This works for existing sessions, not new logins. For sites requiring fresh auth, headed mode with user interaction is the fallback.

### Security: cookie scoping, site lock, DNS-rebinding limitation

*Source: `docs/archive/prd.md` lines 172–176.*

Cookie injection is scoped by a precise RFC-6265 domain match (not a substring `LIKE`), so browsing one site can't pull look-alike or unrelated-eTLD cookies into the session. Both engines share one `scopedCookiesForUrl` (CDP `authenticate` and Firefox/BiDi `injectCookies`) so they cannot drift — the Firefox path scopes to the target host exactly like CDP rather than loading the whole jar. Every safety control is expressed identically across the library, MCP, bareagent, and CLI surfaces — no entry point is a less-securable path.

**Site lock (`allowHosts`, v0.27.0).** Top-frame only, both engines: Chromium uses a browser-level `Fetch.enable` on Document requests (covers popups and new tabs; blocked requests fail with `Aborted` so the old page stays), Firefox a catch-all BiDi intercept inside the single ad-block decision handler (two handlers on one paused request would race). Known limits, accepted: subresources (img/script/css/XHR/fetch), iframes and WebSocket are not locked; MCP `eval` can still `fetch()` off-site; the match is on the URL hostname, so it does not follow a DNS name to its IP; attach mode is refused. A goto blocked by the lock rejects `NAV_BLOCKED` (checked before Chromium's `ERR_ABORTED` is treated as a download/204); an in-page block shows as a `[blocked navigation to <host>]` line on the next snapshot. MCP adds `BAREBROWSE_TIER` (r/rw/rwx) and tool annotations; invalid config refuses to start.

**Known limitation:** the private-network guard matches the URL hostname; a public DNS name that resolves to a private IP (DNS rebinding) is not caught — that needs connection-time IP inspection.

### Pruning: decision, why, what was ported, modes, links

*Source: `docs/archive/prd.md` lines 180–199.*

**Decision:** Port mcprune's role-based ARIA tree pruning into barebrowse as a built-in step, not an optional module.

**Why:**
- Pruning is not optional for agent consumption. A raw ARIA tree is still too large for most LLM context windows. Pruning is part of the pipeline, not an afterthought.
- mcprune's pruning logic is a pure function: takes an ARIA tree, returns a smaller ARIA tree. No browser dependency, no Playwright coupling. It's ~470 lines of role-based tree surgery.
- By absorbing it, barebrowse becomes a complete "URL in, agent-ready snapshot out" solution. No second package needed.

**What we port from mcprune:**
- Role taxonomy (landmarks, interactive, structural, noise)
- Landmark extraction (main, nav, banner, etc.)
- Noise removal (ads, tracking, legal boilerplate)
- Interactive element preservation (buttons, links, inputs)
- Wrapper collapsing (nested generics, empty groups)
- Context-aware filtering (search relevance, dedup)

**Modes:** `act` (default) keeps interactive elements and short labels — best for clicking/filling. `read` (alias for `browse`) keeps paragraphs, headings, and long text — best for articles, docs, and content extraction. `navigate` and `full` expose progressively more landmarks. `data` (opt-in) is a separate transform (`src/data.js`) over the raw tree rather than a prune.js mode — prune's collapse step destroys table structure. It emits one line per record: tables map cells to headers positionally (with a width-mismatch guard, since CDP exposes no colspan), repeated sibling leaves (runs of 3+, plus same-shape pairs beside such a run) group under a label, and text already inside a parent's name is dropped; scope is the `main` landmark, falling back to the whole page. Refs are the same ids as act, on interactive nodes only. It is larger than act on prose pages — articles stay with `read`/`readable()`. Every public surface — `browse()`, `connect()`'s `page.snapshot()`, the MCP `browse`/`snapshot` tools, the bareagent `browse`/`snapshot` tools, and the CLI's `--mode=` / `--prune-mode=` flags — accepts the same enum. When act mode collapses a content-heavy page well past what a search/e-commerce page would, the snapshot appends a one-line `hint: …` suggesting `pruneMode='read'` so the caller can re-snapshot instead of bailing to a separate HTTP fetch.

**Links (opt-in):** `links: true` (`snapshot({ links: true })`, `browse(url, { links: true })`, a `connect({ links })` default; MCP/bareagent `links` param; CLI `snapshot --links` / `browse <url> --links`) adds each link's absolute URL after its quoted name — `link "name" <url> [ref=N]` — in every mode (`src/links.js`). A heading that wraps a link keeps the URL on its own line; data mode also adds it to table link cells and collapsed-group items, and its legend gains a links note. `javascript:` and same-page `#fragment` links get no URL, every link line carries its own URL (no cross-line dedupe), and URLs never contain a raw space, `<` or `>`. Off by default: output is byte-identical when off (about +23% chars on a GitHub issue list in data mode).

**What stays in mcprune:** The Playwright MCP proxy architecture. mcprune can continue to exist as a Playwright-based MCP server for users who want that path. But for barebrowse consumers, pruning is built in.

### Obstacle course, with version notes and known limits

*Source: `docs/archive/prd.md` lines 201–229.*

##### Obstacle Course — What barebrowse handles automatically

The agent doesn't have to think about any of this:

| Obstacle | How it's handled | Mode |
|----------|-----------------|------|
| **Cookie consent walls** | ARIA tree scan + jsClick accept button, 29 languages | Both |
| **Consent in dialog role** | Detect `dialog`/`alertdialog` with consent hints, click accept inside (a bare `Consent` label counts only here) | Both |
| **Late-rendered consent dialog** (Google Funding Choices) | If `goto()` found no dialog, the first `snapshot()` re-checks once, only on the same document (Chromium `targetId:loaderId`, Firefox `context:timeOrigin`) | Both |
| **Consent outside dialog** (BBC SourcePoint) | Fallback global button scan when dialog has no accept button | Both |
| **Consent behind iframe overlay** | JS click via DOM.resolveNode bypasses z-index/overlay issues, real mouse click fallback for CMPs ignoring synthetic clicks | Both |
| **Permission prompts** (location, camera, mic) | Launch flags + CDP Browser.setPermission auto-deny | Both |
| **Media autoplay blocked** | Autoplay policy flag on launch | Both |
| **Login walls** | Cookie extraction from all browsers (Firefox + Chromium merged), injected via CDP | Both |
| **Pre-filled form inputs** | Select-all + delete before typing | Both |
| **Off-screen elements** | Scrolled into view before every click, JS `.click()` fallback for no-layout elements | Both |
| **Form submission** | Enter key triggers onsubmit | Both |
| **Tab between fields** | Tab key moves focus correctly | Both |
| **SPA navigation** (YouTube, GitHub) | SPA-aware wait: frameNavigated + loadEventFired | Both |
| **Bot detection** (Google, Reddit) | Cloudflare-strong phrases fire regardless of size; generic phrases ("access denied", "unknown error") only fire on near-empty pages — H9 stopped false-flagging legitimate 4xx/5xx pages. `botBlocked` flag + snapshot warning. Stealth patches (headless) + automatic headed fallback | Hybrid |
| **navigator.webdriver / WebGL / hardware / UA leak** | H4 patches: webdriver, plugins, languages, `chrome.runtime` enums, `Notification.permission`/constructor, `hardwareConcurrency=8`, `deviceMemory=8`, WebGL UNMASKED vendor/renderer spoofed to Intel, and `Network.setUserAgentOverride` strips "HeadlessChrome" from the UA in HTTP headers AND `navigator.userAgent` | Headless |
| **Canvas fingerprinting** | v0.10.0: `toDataURL`/`getImageData` apply per-session `crypto.getRandomValues`-seeded XOR noise (~1 byte per 64-byte stride, position-mixed hash). Output stable within a session, different across sessions; bitmap restored after encoding so legitimate canvas use is unaffected | Headless |
| **Ad / tracker URL noise + load drag** | v0.10.0: CDP `Network.setBlockedURLs` with 128 curated patterns covering Google/FB/Amazon/MS/Adobe ads+analytics, major SaaS analytics + session-replay stacks, content-rec, supply-side ad networks, marketing automation. v0.10.1 added long-tail: AppsFlyer/Branch/Adjust (mobile-measurement-on-web), Cloudflare Web Analytics, Matomo Cloud, broader Outbrain (`amplify`/`log`) and PostHog (`/static/array.js`). Default on for launched browsers, off in attach mode. Explicit `blockAds: true` in attach mode follows the session across `switchTab()` (locked in by integration test in v0.10.1). On legacy Chromium lacking the method, a one-time `console.warn` surfaces the fallback (v0.10.1). `opts.blockUrls` extends; `opts.blockAds: false` opts out | Launched |
| **JS dialogs** (alert/confirm/prompt) | Auto-dismiss via CDP, logged in `dialogLog`; H8 added `page.onDialog(handler)` for custom replies | Both |
| **iframe / OOPIF content** (Stripe, reCAPTCHA, embedded forms) | H2: `Target.setAutoAttach({flatten:true})` + per-frame AX trees merged under iframe placeholders. `--site-per-process` forces every iframe (including same-origin) into OOPIF so click coords work. Refs route to the iframe's session via `{ session, backendNodeId }` lookup | Both |
| **Download capture** (`Content-Disposition: attachment`) | H7: `Browser.setDownloadBehavior({behavior:'allowAndName', downloadPath, eventsEnabled:true})` + live `page.downloads` array with `{ guid, url, suggestedFilename, savedPath, state, totalBytes, receivedBytes }` per file | Both (skipped in attach mode) |
| **Profile locking** | Unique temp dir per headless instance. A launch that fails (start timeout, early exit, bad endpoint — both engines) SIGKILLs the browser's whole process group and removes the temp dir before rejecting. **Hard-kill safety (Linux):** if the launcher itself is `kill -9`'d or crashes (no exit handler can run), the browser still dies with it: Chromium is spawned with `--remote-debugging-pipe` and stdio fds 3/4 as a parent-death tether (the kernel closes the pipe, Chromium exits with its helpers); Firefox is spawned through `setpriv --pdeathsig SIGKILL` when `setpriv` exists (Linux only; without it, or off Linux, a hard kill still orphans Firefox). The dead launcher's leftover `barebrowse-*` temp dirs (Chromium profile, Firefox profile, download dirs, all named with the owner pid) are removed by the next launch's sweep, which keeps any dir whose owner pid or browser lock is still live. Known limits: a reused pid keeps its dir; a dir whose Chromium lock names a different hostname (renamed machine, container sharing `/tmp`) is kept forever; a Snap Firefox (its setuid wrapper clears pdeathsig) can still be orphaned, though its profile is kept while it runs | Headless |
| **Shared memory crash** (Linux) | `--disable-dev-shm-usage` prevents `/dev/shm` exhaustion under heavy tab load | Headless |
| **ARIA noise** | 8-step pruning pipeline (ported from mcprune): region extraction, node prune, wrapper collapse, post-clean, then e-commerce noise removal (dedup links, drop sponsored/spec buttons, truncate after footer, drop filter groups) | Both |

### Future features — full original, with "Done" history, Firefox known limitations, and the POC write-ups (Action → calls, Site call map, WebMCP)

*Source: `docs/archive/prd.md` lines 341–447.*

##### Near-term
- **Screenshot capture** — *(Done: `page.screenshot()` returns base64 PNG/JPEG/WebP; v0.9.0 also exposed it as the `screenshot` MCP tool that saves to `.barebrowse/screenshot-*.{png,jpeg,webp}`.)*
- **Wait strategies** — *(Done: `waitForNavigation`, `waitForNetworkIdle`, `waitFor({text|selector})`. F9 in v0.8.0 made network-idle resilient to orphan finish events. v0.9.0 added `wait_for` as an MCP + bareagent tool.)*
- **Tab management** — *(Done: `createTab()`, `tabs()`. F4 in v0.8.0 made `switchTab()` actually swap the working session; F7 wired the dialog handler on sub-tabs. v0.9.0 added `tabs` as an MCP tool with optional `switchTo: N`.)*
- **MCP server wrapper** — *(Done: `mcp-server.js`. v0.9.0 grew to 18+ tools — added `reload`, `screenshot`, `wait_for`, `tabs`, `select`, `hover`, plus the opt-in `eval` gated behind `BAREBROWSE_MCP_EVAL=1`. Later added `switch_engine` (runtime chromium/firefox swap) and a names-only `cookies` field on `capabilities`. Per-tool timeouts replaced the blanket 30s; `runStdio()` exported so `cli.js` can launch it cleanly.)*
- **Attach to a running browser** — *(Done v0.9.0: `connect({ port })` reuses an already-running Chrome session via `attach()` → `getDebugUrl()`. Skips stealth + `Browser.setPermission` + download capture so we don't mutate the user's browser globally. `close()` leaves the underlying process alive — only the tab we created is torn down.)*
- **iframe / OOPIF support** — *(Done v0.9.0: `Target.setAutoAttach({flatten:true})` + per-frame AX trees merged. Refs route to the right session via `{session, backendNodeId}` so clicks inside Stripe / reCAPTCHA / embedded forms work. `--site-per-process` launch flag is now default so even same-origin iframes get OOPIF sessions.)*
- **Reload** — *(Done v0.9.0: `page.reload({ignoreCache, timeout})`, exposed as MCP + bareagent + CLI subcommand.)*
- **Download capture** — *(Done v0.9.0: `page.downloads` live array, `--download-path` CLI flag, `downloads` MCP + bareagent + CLI subcommand.)*
- **Dialog override** — *(Done v0.9.0: `page.onDialog(handler)` lets callers return `{accept, promptText}` instead of the default auto-accept.)*
- **Reading mode** — *(Done: `page.readable()` extracts the main article as clean text via Mozilla Readability injected over CDP. Exposed as `readable` on MCP, bareagent, and the CLI (→ `.barebrowse/article-*.txt`). Never hard-gates — returns text plus an advisory `confidence` and a hint to fall back to `snapshot()` on non-articles.)*
- **Network interception** — `Fetch.enable` + URL patterns for blocking trackers/ads or mocking responses. Still queued.
- **Map + zoom** — `snapshot({ map })` outlines the page's boxes, `snapshot({ within })` returns one box in any mode; MCP/CLI return the map for big pages, library default unchanged. Planned for v0.28.0: [zoom-plan.md](../product/zoom-plan.md).

##### Medium-term
- **Firefox support** — *(Done — the capability matrix, goal/non-goals, and forward plan live under **Firefox Parity** in Core Architecture above.)* `connect({ engine: 'firefox' })` drives Firefox over WebDriver BiDi (`bidi.js` + `firefox.js`), AX tree reconstructed in-page (`ax-snapshot.js`), the full `page.*` surface covered, selectable from MCP (`BAREBROWSE_ENGINE=firefox`) and CLI (`--engine firefox`), and swappable at runtime via MCP `switch_engine` / CLI `switch-engine` (page, tabs and refs reset). Phases 1–4 reached practical parity (stealth/consent → console/network → ad-block/dialogs → hybrid/saveState/waitForNavigation/downloads); only `reload({ignoreCache})` remains gapped (upstream BiDi). Validated in `test/integration/firefox.test.js` + `test/unit/firefox-hybrid.test.js`. Accepted known-limitations follow.

  **Known limitations — Firefox stealth + consent (v0.16.0, validated in a code
  review; slated for Phase 5 revisit with a cross-engine fidelity harness):**
  - *Consent false-positive — **fixed** in v0.16.0.* The page-wide accept-button
    scan now runs **only** for banner-style consent (no dialog container). When a
    consent dialog is detected but has no in-dialog accept button, barebrowse no
    longer scans the whole page — a page-wide match there could auto-click an
    unrelated "Accept all …" control (e.g. a ToS/signup button) on `goto()`.
    Trade-off: the rare pattern of an accept button rendered *outside* its own
    dialog (some SourcePoint deployments) is no longer auto-dismissed on Firefox;
    we accept that miss rather than risk a wrong click. Regression-tested in
    `test/unit/consent-firefox.test.js`. (The CDP path still does the page-wide
    scan and carries the original false-positive risk — unchanged here.)
  - *Consent double AX build (performance).* With consent on (default), each
    `goto()` reconstructs the AX tree once for the consent scan and `snapshot()`
    rebuilds it — two in-page reconstructions per navigate. Bounded latency
    (page-size dependent), no correctness impact; parity with the CDP path's
    `getFullAXTree`-per-navigate. Not optimised because the safe options (a
    cheap consent probe, tree caching) risk consent coverage or stale trees.
  - *Consent single-click, no re-verify.* The Firefox walker clicks the accept
    button once (a real BiDi pointer event) and does not re-check dismissal or
    retry, unlike the CDP path's synthetic-then-real retry. A CMP that ignores
    the first click stays up (the flow "fails open" — page loads, wall remains);
    low likelihood since the click is already a real pointer event. Disable with
    `consent: false` where an auto-click is unacceptable.
  - *webdriver own-property fallback (latent).* `WEBDRIVER_PATCH` deletes
    `navigator.webdriver` off `Navigator.prototype`; if a browser ever exposed
    it as an *own* property instead, the delete would miss it and the
    `defineProperty` fallback would restore the `hasOwnProperty` tell. Does not
    occur on current Chromium/Firefox (prototype property), so it is latent.

  **Known limitations — Firefox ad-block + dialogs (Phase 3, validated in a
  medium code review; two review findings fixed, three recorded here as
  accepted):**
  - *Per-request intercept cost (accepted design).* BiDi's `network.addIntercept`
    can't express our globs (`urlPatterns` reject `*` and have no subdomain
    wildcard), so the Firefox path registers a **catch-all** intercept and
    matches each URL in-process, pausing every request for one continue/fail
    round-trip to Node (CDP matches browser-side with none). Negligible on a
    local socket for a normal page; it is the only route that preserves glob
    parity without a second list. `src/blocklist-firefox.js`.
  - *Suspended request on a missing id (latent).* The block handler acts only on
    a paused event carrying `e.request.request`; if one ever arrived without an
    id it early-returns, leaving that request suspended (no id ⇒ neither
    `continueRequest` nor `failRequest` is callable — there is no safe default).
    Does not occur in practice (paused events always carry an id), so it is
    latent. *(review finding #2 — unfixable without an id; recorded not papered.)*
  - *Dialog-handler coupling (structural).* The BiDi session is created with
    `unhandledPromptBehavior:'ignore'` in `bidi.js` (so a prompt stays open until
    we answer it — otherwise Firefox auto-dismisses before `handleUserPrompt`
    wins). The mandatory responder lives in `firefox-page.setupDialogs()`, wired
    during page construction before any navigation. The capability *must* be set
    at `session.new` time (only `bidi.js` can), so it can't be co-located with
    the handler; the invariant "every FF session that sets `'ignore'` also wires
    a responder" is held by construction (the only `createBiDi` caller is
    `connectFirefox`) rather than enforced in one place. A future `createBiDi`
    caller that skips the handler would hang on any dialog. *(review finding #3.)*
  - *Dialog decision logic duplicated CDP↔BiDi.* **Resolved in Phase 4.** The
    log-push + `onDialog` decision core is now single-sourced in `src/dialog.js`
    (`decideDialog` + `dialogLogEntry`), called by both `index.js`'s
    `setupDialogHandler` (CDP) and `firefox-page.setupDialogs()` (BiDi); only the
    response command and field-name mapping differ at each call site
    (`handleUserPrompt`/`defaultValue`/`userText` vs
    `handleJavaScriptDialog`/`defaultPrompt`/`promptText`). *(review finding #5,
    closed.)*
- **Cookie sync** — In hybrid mode, extract fresh cookies from headed session and cache for future headless use. Self-refreshing auth.
- **Selector discovery** — Port sweetlink's `discoverSelectors` — crawl ARIA tree, score interactive elements, return ranked action targets.
- **Form understanding** — Detect forms in ARIA tree, map fields to semantic purposes, enable agents to fill forms intelligently.
- **Proxy/Tor support** — Route headless browser through proxy for geo-restricted content.
- **Action → calls ("what did my action cause?")** — *(Parked 2026-11-18 after a POC and a real-agent test: agents already edit URLs without a hint, used the calls list in 1 of 7 samples, and misused fetch as an HTML downloader. Full numbers and the do-not-repeat list: [findings.md](findings.md). The design below is kept for reference.)* After a `click`/`type`, let the agent ask which network calls that action fired and what came back. Today only the CLI daemon logs calls, and it does not tie them to actions. Why it stands alone: the agent learns its click did something (a feedback loop instead of click-and-hope), and the answer is often already in the response (a "check stock" button returns `{"inStock":true}`), so no re-snapshot is needed. Companion pieces, each optional:
  - **In-page fetch** — a `page.fetch(url, opts)` that runs inside the real page (same cookies, same browser fingerprint) and goes through the same URL guard as `goto`. Today this needs `eval`, which is gated on MCP.
  - **URLs are knobs** — hand the agent the call URL (and the page URL it already gets on the snapshot's `url:` line) so it can change a parameter and go again without redoing the UI steps: `page=2` for the next page, `currency=USD` → `EUR`, a different `sku`. Next-page-by-call skips a page load, but it is **not** a token saving as-is (see the second POC below); whether it means fewer bot checks is **untested**.
  - **Noise filter** — hide tracker/ads/ping calls so the agent sees the few calls that matter (Best Buy fired 46 calls for one typed word; Amazon's 9 were all tracker pings). Start from the existing ad-blocklist and request type (`Ping`, `Image`); only as a filter on what is shown.
  - **Out of scope here:** r/w/x labelling of calls (rwxlite) — a different tool's job.

  2026-11-18 POC (typed "laptop" into the search box on 8 shops, matched the call whose response held the word, replayed it): Target and IKEA — one clear call, replay worked in-page and also from plain Node with no browser; Best Buy — clear call, in-page replay 200 with no extra headers, replay from outside the browser **failed** (the case in-page fetch exists for); Amazon — got in, the suggestion call never appeared (cause unknown); Walmart (Press & Hold), Etsy (DataDome slider), eBay and Home Depot (flat 403) — blocked at the front door in headless, hybrid and headed alike. Lessons: search boxes may need real key presses (`type(..., {keyEvents:true})`), not the default paste; a "blocked" result is sometimes just an unclicked step (Best Buy's country picker); this helps only on sites the browser can already enter. Build order: this primitive first, then decide about the map below.

  Second POC, same day (loaded the "laptop" results page on Target, IKEA, Best Buy; action = `goto`): filtering by request type and JSON mime cut 250–323 calls to 15–22 data calls, of which 1–4 held the results. In-page replay worked on all three. On Target the knobs worked from the URL (`keyword=monitor` returned monitors; `page=0` → `1` returned a different page). IKEA keeps the query and paging in the POST body (editing it was not tried). Best Buy's results page is server-rendered — no results call; the knob is the page URL the agent already has. **The finding that reshapes this feature:** the raw responses are far bigger than the snapshot — Target 1,140k chars vs a 56k snapshot (20×), IKEA 141k vs 37k (4×). A quick generic shrink (largest list of look-alike objects, short scalar fields only) got IKEA to 31k — no better than the snapshot — and picked the wrong list on Target. So: return a short list of the data calls an action caused (URL, method, status, size — no bodies); never inline a response body by default; if a body is wanted, write it to a file as MCP already does for big outputs. A generic JSON shrinker is unproven and is not planned.

  **How the agent is told which way to use** (design, 2026-11-18; wording untested until a real agent tries it). Rule of thumb: what costs is what the agent *reads*, not what the browser downloads — a page load downloads more but the snapshot is trimmed; a raw fetch downloads less but hands over everything. So lists and results → change the page URL, `goto`, snapshot (works today); small single answers (stock, price) → fetch; big calls → never inline. Three places say so, each at the moment of use, all from sizes and URL shapes only (no site names):
  1. *Snapshot URL hint* — when the page URL has query parameters, one line under `url:` such as `[URL knobs: searchTerm=laptop — change a value and goto() to skip the UI]`. Absent when there are none.
  2. *Calls list carries a verdict* — each data call shows method, URL, status, size and a plain label: `small — fetch ok` or `BIG — use goto + snapshot`; hidden tracker count shown as a number.
  3. *The fetch tool enforces it* — a small response is returned; a big one is written to a file and only path + size come back, so context cannot be flooded even if both hints are ignored. Tool description, one line: fetch = one small data call; for lists or pages change the URL and use goto + snapshot.

##### Long-term
- **Profile management** — Multiple browser profiles for different identities/accounts.
- **Session recording/replay** — Record browsing sessions as CDP commands, replay for testing.
- **Visual grounding** — Combine ARIA tree with screenshot regions for multimodal agents.
- **Agent memory integration** — Remember visited pages, cache snapshots, track which sites need headed mode.
- **Site call map (and a shared index of maps)** — *(Idea only, parked with "Action → calls" above: it rested on hidden calls being useful to agents, and the 2026-11-18 tests point the other way — see [findings.md](findings.md). Would be a separate small tool, not part of barebrowse.)* Most modern sites paint their screens on top of their own JSON calls. Watch an agent use a site once, save "this action → this call → this response shape" as a small per-site file, and the next visit can try the cheapest way first: plain fetch, then in-page fetch, then the UI. It is the same idea as an API scope map, but for sites that publish no spec and never will, and it needs no opt-in from the site (unlike WebMCP or llms.txt). A shared index would simply be a folder of those files that people contribute — an index of *how to use* a site, not of its content. Known problems: maps go stale when sites change; logged-in calls are personal, so a shared map may hold only the call's shape, never cookies or data; signed or per-request tokens defeat replay on heavily guarded sites; old server-rendered sites have no hidden calls (snapshot stays the answer there); and it must never become a crawler — maps are made only when an agent really uses a site (see *What barebrowse is NOT*). barebrowse's part ends at the primitives: action → calls, in-page fetch. Revisit after the next-page POC.
- **WebMCP site tools** — *(Parked until widely adopted.)* Sites register agent tools via `document.modelContext.registerTool()` (was `navigator.modelContext`). Planned surface: opt-in `page.tools()` / `page.callTool(name, args)`. 2026-10-26 POC: a pre-load shim catching `registerTool` works even though Chromium 155 has no native API (origin trial only, Chrome 149–156) — read and called `searchFlights` on Chrome Labs' demo and `search_products` live on target.com. Findings that parked it: ~0 sites ship tools (1 of 6 checked; Google Flights, Expedia, Booking, Etsy, Redfin had none); tools perform actions but don't return data (Target's returned 102 chars, results still needed an 11k-char snapshot), so it does not replace pruning; it does not help with bot blockers (tools run inside the page, which must load first); and a stub `modelContext` on every page is a detectable tell, so it must stay off by default. Revisit when Chrome ships it on by default and major sites ship data-returning tools.
