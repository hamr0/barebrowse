# Findings

Experiments we ran, what they showed, and what not to try again without a new reason.
Each entry: question, setup, result, verdict. Newest first. Numbers are from the day they were measured; sites change.

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
