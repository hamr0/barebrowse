# Zoom Plan — Map + Zoom for `snapshot()` (target v0.28.0)

Status: **planned, not built.** Three POCs below run first and may change this
plan. Owner decisions recorded 2026-11-15.

## Problem

The three modes (act / read / data) decide *how* a page is written, and each
one guesses *which part* matters with general rules (main landmark only,
pruning). On cluttered pages the guess carries a lot of noise: an Amazon search
page in data mode with links is 135k chars, most of it filters, sponsored
shelves and footer. Making the rules smarter means fitting them to sites (the
cinema rule R4 was dropped for exactly that).

## Idea

Split *which part* from *how to write it*. The agent, which knows the job,
picks the part; barebrowse only cuts the page there.

1. **Map** — a small outline of the page's big boxes, each with a ref and a size.
2. **Zoom** — a snapshot of one box only, in any mode.
3. **Full** — the whole page, as today.

Order for an agent: zoom first, then mode. The standard full snapshot stays
available.

## Evidence (POC, Chromium, 2026-11-15)

Map + zoom against today's full data-mode snapshot with links:

| Page | Full (data+links) | Map | Zoom (chosen box) | Saved |
|---|---|---|---|---|
| Amazon search "usb c cable" | 134,740 | 2,227 (39 boxes) | product list, 17 items: 38,042 | ~70% |
| Wikipedia "List of largest cities" | 112,092 | 1,190 | `table` in `region "List"`: 31,311 | ~70% |
| GitHub nodejs/node issues | 19,744 | 739 | `list "Issues"`: 14,855 | ~20% |
| Google Flights AMS→LHR | 19,405 | 465 | "Other flights" list, 17 items: 14,045 | ~25% |
| Rotten Tomatoes in theaters | 10,474 | 250 | none: movie tiles are not a list role; main is already the movies | 0% |

Findings:
- The map is 250–2,200 chars (under 2% of the page), and the right box was
  obvious every time it existed.
- Zoom wins big on cluttered pages and little on clean ones; nothing breaks on
  clean pages.
- Bug caught: zooming into a box outside `main` (header, search) gave **empty**
  act/read output, because prune's landmark step keeps `main` only. Inside a
  zoom that step must be off.
- Unmarked lists (div tiles) don't appear in the map. Data mode's
  repeated-sibling rule (R1–R3) could mark them later.
- Separate finding: in the Amazon zoom, 72% of the text is tracking URLs (each
  ~400 chars, repeated 3× per product). Out of scope here; needs its own POC
  (a generic "strip the query" rule breaks sites that need it).

## Consumers (asked 2026-11-15)

- **bareloop** (loop): library only, one call site —
  `connect()` → `goto` → `waitForNetworkIdle` → `snapshot({mode:'act'})`,
  pinned `^0.25.0`. Freezes the whole page text as a run's input; a map there
  would turn every fact check red. Wants Plan A; would not use zoom now (its
  checker needs the whole saved page).
- **fwdloop** (fwd): same shape, library only, pinned `^0.26.0`; freezes the
  full text (sha256) and quotes facts from it; reads goto's `status`; greps for
  `[BOT CHALLENGE DETECTED]`. Wants Plan A. A structural `within` may be useful
  later, but using it changes what a signed job reads → **hamr's ruling**.
  Its ticket reader no longer uses barebrowse (since fwdloop M13 it reads
  tickets through the GitHub MCP); barebrowse MCP reaches fwdloop only when a
  user adds it to a job, and the job's model then calls its tools as-is.

## Decision: Plan A

- **Library (`connect().snapshot()`, `browse()`): default unchanged.** Map and
  zoom only when the caller asks. Both consumers stay safe untouched.
- **MCP and CLI: auto.** A plain snapshot of a big page returns the map instead
  of the content; small pages unchanged.
- One `snapshot` tool with options. No new tools: each tool costs the agent
  attention and needs its own tier and annotations.

## API

```js
page.snapshot({ map: true })                       // outline of boxes
page.snapshot({ within: 563 })                     // one box by ref (from the map)
page.snapshot({ within: 'table' })                 // one box by role
page.snapshot({ within: 'list "Issues"' })         // one box by role + accessible name
page.snapshot({ within: 563, mode: 'data' })       // any mode works inside a zoom
```

MCP `snapshot` gets `within` and `map` params, and `full: true` to skip the
auto map. CLI: `snapshot --within=<ref|role|role "name"> --map --full`.

### Rules

- **Map boxes:** landmarks (`banner`, `navigation`, `main`, `complementary`,
  `contentinfo`, `region`, `form`, `search`), plus `list`, `table`, `grid`,
  `treegrid`, `feed`, `tablist`, `dialog`. Shown when big enough to matter (POC
  used ≥800 chars), nested by depth, each line:
  `role "name" [ref=N] (size, links, items)`. Exact size column: POC decides.
- **Inside a zoom the box is the whole page:** prune's landmark step and data
  mode's main-only scope are off. All other pruning applies as usual.
- **`within` by role / role + name:** exact match on role and accessible name,
  never text guessing. Zero matches → error naming what was asked. Two or more
  → return the map with the matches marked, never pick one.
- **`within` by ref:** refs are renumbered on every snapshot
  (`refCounter` starts at 1 per `ariaTree`), so a ref from the map is resolved
  through the previous snapshot's `refMap` to its `backendNodeId`, then found in
  the new tree. Gone (page changed) → clear error, never wrong content.
- **MCP/CLI auto threshold:** reuse the existing `maxChars` cap (default
  30,000; today a bigger snapshot is saved to a file and a path is returned).
  New: over the cap, return the map inline, keep saving the full snapshot to
  the file, and say so. No new magic number unless POC 2 shows 30k is wrong.
- Works on both engines, in all three modes, with `links`.

## POCs first (each may overturn the plan)

1. **Firefox:** does the map show the same boxes as Chromium on the 5 pages
   above? How does a ref resolve to a node on BiDi (`refMap` values differ)?
2. **Threshold:** measure ~10 real pages (the 5 above plus news, docs, forum,
   shop product page, search results). Is `maxChars` 30k the right point, or
   does the map pay off lower?
3. **`within` by name:** does `list "Issues"`, `table`, `region "List"` find
   exactly one box on those pages? How often do unnamed boxes make role-only
   matching ambiguous?

### POC results (2026-11-15, 10 pages × both engines)

Pages: Amazon search, Wikipedia list, GitHub issues, Google Flights, Rotten
Tomatoes, BBC News, MDN `<table>`, Hacker News, an Amazon product page,
Stack Overflow (bot-blocked on both engines; excluded).

1. **Firefox:** same boxes as Chromium within a few per page (Amazon 20 vs 18,
   MDN 28 vs 36, product 20 vs 26, others equal). A ref resolved again in a
   fresh tree on 16/16 runs — CDP by `backendDOMNodeId`, BiDi by marking the
   element carrying the old `data-bb-ref` and reading its new ref. Found
   alongside: on Firefox, Google Flights stopped on Google's
   consent.google.com interstitial (Chromium got through) — a separate consent
   bug, not zoom.
2. **Threshold:** keep `maxChars` 30k. Full act sizes: under 30k → RT 22k,
   BBC 19k, HN 21–27k, GitHub 28k (little or nothing to zoom: RT has no list
   box, BBC's lists are ~1k, HN is one table); over 30k → Amazon 45–57k,
   Flights 35k, product 39–50k, MDN 125–158k, Wikipedia 146–193k (all have a
   clear box to zoom into).
3. **`within` by name:** named boxes were unique on every page except the
   Amazon product page (4/7 and 5/8: repeated carousel names) — ambiguity →
   map, as designed. Role alone was almost never unique (`list` ×48 on Amazon;
   only HN's single `table`). Key result lists are often unnamed (Amazon,
   Flights).
4. **"Largest box" is the wrong pick:** on Wikipedia the largest box is
   `region "References"`, not the table; on Flights it is "Other flights",
   which drops "Top flights". Confirms: the agent picks, not a size rule.

**fwdloop side-by-side** (Chromium, fwd's exact read, MAD→FCO, 3 dates): every
flight result in both lists carried all 5 quoted facts ("From <n> US
dollars", "Nonstop", "Leaves Adolfo Suárez Madrid-Barajas Airport",
"arrives at Leonardo da Vinci International Airport", "Departure time:")
inside its own list; none of them outside the lists. Full act 29.6–33.4k;
both lists 22.1–25.3k (~24% less); common parent `tabpanel` 24.2–27.8k (~17%
less). Found alongside: `goto()` returned the consent.google.com URL (status
200) although the snapshot is the flights page.

**Plan changes from the POCs:**
- Add `tabpanel` to the map's box roles (Flights' results live in one).
- Label an unnamed box in the map with the heading right before it, e.g.
  `list (after heading "Other flights") [ref=N]`, so the agent can tell
  look-alike lists apart. Structural (sibling heading), no text guessing;
  `within` by name keeps matching the accessible name only.

## Tests

- Unit: map line format; box selection; `within` by ref / role / role+name;
  ambiguity → map; not found → error; landmark step off inside a zoom (a
  `banner` zoom in act mode is not empty).
- Integration, both engines: local fixture with noise around a table and a
  list; zoom output contains the table rows and none of the noise; stale ref
  after navigation → error; library default unchanged (byte-identical to
  today's snapshot); MCP over-cap returns the map plus a file path.

## Not in scope

- barebrowse picking the box on its own (the agent knows the job; we don't).
- Changing the library default (Plan B) — breaks bareloop and fwdloop.
- Tracking-URL cleanup (separate POC).
- Unmarked repeated tiles in the map (later, via data mode's R1–R3).

## Open (owner)

- May fwdloop's signed jobs use `within`? (fwd will raise it.)
