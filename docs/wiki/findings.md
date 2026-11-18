---
title: Findings — decisions and lessons
slug: findings
sources:
  - docs/archive/prd.md
---

# Findings — decisions and lessons

Decisions and lessons moved out of the barebrowse PRD so the PRD holds only requirements.

## Decisions — why we chose each

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

## Repos studied — what we borrowed and why

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

### The openclaw lesson

openclaw tried to integrate 10+ messaging APIs directly — each with its own auth, format, quirks. It became a maintenance nightmare. multis solved the same problem by using Beeper/Matrix as a single bridge (docs/archive/prd.md:467-467).

barebrowse applies the same lesson: instead of integrating Playwright + Puppeteer + WebDriver + stealth plugins + cookie libraries + proxy managers, we use **one protocol (CDP) to one browser (the user's)**. Everything else is unnecessary (docs/archive/prd.md:469-469).
