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
