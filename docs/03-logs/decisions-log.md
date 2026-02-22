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
