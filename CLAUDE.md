## Dev Rules

**POC first.** Always validate logic with a ~15min proof-of-concept before building. Cover happy path + common edges. POC works → design properly → build with tests. Never ship the POC.

**Build incrementally.** Break work into small independent modules. One piece at a time, each must work on its own before integrating.

**Dependency hierarchy — follow strictly:** vanilla language → standard library → external (only when stdlib can't do it in <100 lines). External deps must be maintained, lightweight, and widely adopted. Exception: always use vetted libraries for security-critical code (crypto, auth, sanitization).

**Lightweight over complex.** Fewer moving parts, fewer deps, less config. Simple > clever. Readable > elegant.

**Open-source only.** No vendor lock-in. Every line of code must have a purpose — no speculative code, no premature abstractions.

## Project Specifics

- **What:** Vanilla JS library — CDP-direct browsing for autonomous agents. URL in, pruned ARIA snapshot out.
- **Language:** Vanilla JavaScript, ES modules, no build step
- **Runtime:** Node.js >= 22 (built-in WebSocket, sqlite)
- **Protocol:** CDP (Chrome DevTools Protocol) direct — no Playwright
- **Browser:** Any installed Chromium-based browser (chromium, chrome, brave, edge)
- **Modules:** 11 files in `src/`, ~2,400 lines, zero required deps
- **Tests:** 54 passing — run with `node --test test/unit/*.test.js test/integration/*.test.js`
- **Docs:** `docs/README.md` (navigation guide to all documentation)

For full development and testing standards, see `.claude/memory/AGENT_RULES.md`.
