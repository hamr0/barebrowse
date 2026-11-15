# Decisions Log

Settled decisions. Don't re-debate these -- see rationale column.

## Founding decisions (v0.1.0)

| # | Decision | Choice | Why | Alternative | Why not |
|---|----------|--------|-----|-------------|---------|
| 1 | Browser protocol | CDP direct | Uses user's browser, ~100 lines, all 3 modes | Playwright | 200MB download, bundles its own Chromium, abstracts what we need raw |
| 2 | Page representation | ARIA tree | Semantic, token-efficient, what agents need | DOM/HTML | Bloated, noisy, needs heavy parsing |
| 3 | Pruning | Built-in | Agents always need pruned output | Optional/separate | Two deps for one job, pruning isn't optional |
| 4 | Cookie auth | Own auth.js + CDP inject | User's existing sessions (Firefox or Chromium), cross-browser injection | OAuth/credential storage | Complex, security liability, reinventing what the browser already solved |
| 5 | Three modes | One flag | Same CDP code, ~20 lines difference | Separate packages | Same code, artificial separation |
| 6 | Chromium only | CDP constraint | ~80% browser share, user's real browser | Cross-browser (Playwright) | Requires Playwright, loses "use your own browser" benefit |
| 7 | Framework | None (vanilla JS) | Matches bare- philosophy, zero deps | Express/Fastify wrapper | Not a server, not needed |
| 8 | Language | Vanilla JavaScript | Node.js ecosystem, same as bareagent, CDP libs available | TypeScript | Added build step, not needed; can add types later |
| 9 | mcprune integration | Absorb pruning logic | One package does it all, mcprune pruning is a pure function | Keep separate | Agents shouldn't need two packages to browse |
| 10 | Daemon/server | None | CDP is direct, no intermediary needed | sweetlink daemon pattern | Unnecessary complexity for local agent-to-browser |

## v0.2.0 decisions

| # | Decision | Choice | Why | Alternative | Why not |
|---|----------|--------|-----|-------------|---------|
| 11 | Anti-detection | Runtime.evaluate patches | Minimal stealth for headless mode | Full stealth framework | Over-engineering; headless + real cookies handles 90% |
| 12 | sweet-cookie | Wrote own auth.js | sweet-cookie not on npm (different package). Our version is simpler, tailored, vanilla JS | Use sweet-cookie | Not available as npm package |
| 13 | MCP server | Raw JSON-RPC, no SDK | Zero deps, ~200 lines. SDK adds weight without capability for stdio | @modelcontextprotocol/sdk | Unnecessary dependency for simple JSON-RPC |
| 14 | bareagent adapter | Action tools auto-return snapshot | LLM always sees result without extra tool call. 300ms settle for DOM updates | Return 'ok' like MCP | Different tradeoff -- bareagent tool calls are expensive (LLM round-trip) |
| 15 | MCP action tools | Return 'ok', agent calls snapshot | MCP tool calls are cheap to chain. Avoids double-token output | Auto-return snapshot | Would bloat every action response |

---

*Add new decisions below this line. Include date, context, and rationale.*

| # | Decision | Choice | Why | Alternative | Why not |
|---|----------|--------|-----|-------------|---------|
| 16 | MCP scoping (v0.27.0, 2026-10-30, asked by fwdloop) | barebrowse enforces it: `BAREBROWSE_TIER` r/rw/rwx hides tools, plus MCP annotations on every tool | A hint is advice the client may ignore; barebrowse is the gateway to any site, so it must enforce limits itself | Annotations only | Nothing stops a client that ignores them |
| 17 | Site lock scope (v0.27.0) | Lock top-level page loads only (goto, redirects, clicks, JS jumps, popups), in-browser at the network layer; hosts only, `host` exact, `*.host` subdomains only; bad config refuses to start | Catches every way off the site without breaking pages; Cloudflare Browser Run guardrails (2026-11) use the same host-matching rules | Lock every request (images, scripts, XHR) like Cloudflare | Breaks most sites unless CDN lists are added; in tier r the agent can't type, so subresources add little |
| 18 | Zoom default (planned v0.28.0, 2026-11-15) | Plan A: map/zoom only when asked in the library; MCP/CLI return the map when a snapshot exceeds `maxChars` | bareloop and fwdloop freeze the whole library snapshot as signed input; a map there breaks every check | Plan B: map by default everywhere | Breaks both consumers; see docs/product/zoom-plan.md |
| 19 | Who picks the zoom box (2026-11-15) | The agent picks from the map; barebrowse never guesses | "Largest box" picked References over the table on Wikipedia and dropped Top flights on Google Flights | Auto-pick by size or rule | Wrong on 2 of the measured pages; page-fitting again (cinema R4) |
| 20 | Several boxes + heading selector (2026-11-15, from fwdloop) | `within: [a, b]` and `within: 'list after "<heading>"'` | One-box picks drop evidence (Flights has two unnamed lists); refs change per load | `within: 'lists'`, `parent-of: [a, b]` | Every list = 48 on Amazon, mostly filters; several boxes is smaller than their parent |
