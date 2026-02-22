## Dev Rules

**POC first.** Always validate logic with a ~15min proof-of-concept before building. Cover happy path + common edges. POC works → design properly → build with tests. Never ship the POC.

**Build incrementally.** Break work into small independent modules. One piece at a time, each must work on its own before integrating.

**Dependency hierarchy — follow strictly:** vanilla language → standard library → external (only when stdlib can't do it in <100 lines). External deps must be maintained, lightweight, and widely adopted. Exception: always use vetted libraries for security-critical code (crypto, auth, sanitization).

**Lightweight over complex.** Fewer moving parts, fewer deps, less config. Simple > clever. Readable > elegant.

**Open-source only.** No vendor lock-in. Every line of code must have a purpose — no speculative code, no premature abstractions.

## Project Specifics

- **Language:** Vanilla JavaScript, ES modules, no build step
- **Runtime:** Node.js >= 22 (built-in WebSocket, sqlite)
- **Protocol:** CDP (Chrome DevTools Protocol) direct — no Playwright
- **Browser:** Any installed Chromium-based browser (chromium, chrome, brave, edge)
- **Key files:** `src/index.js` (API), `src/cdp.js` (CDP client), `src/chromium.js` (browser launch), `src/aria.js` (ARIA formatting)
- **Docs:** `docs/prd.md` (decisions + rationale), `docs/poc-plan.md` (phases + DoD)

For full development and testing standards, see `.claude/memory/AGENT_RULES.md`.
