# Development Workflow

## Dev rules

**POC first.** Always validate logic with a ~15min proof-of-concept before building. Cover happy path + common edges. POC works -> design properly -> build with tests. Never ship the POC.

**Build incrementally.** Break work into small independent modules. One piece at a time, each must work on its own before integrating.

**Dependency hierarchy -- follow strictly:**
1. Vanilla language -- write it yourself if <50 lines and not security-critical
2. Standard library -- `node:test`, `node:fs`, `node:crypto`, `node:sqlite`
3. External -- only when stdlib can't do it in <100 lines. Must be maintained, lightweight, widely adopted

**Exception:** Always use vetted libraries for security-critical code (crypto, auth, sanitization).

**Lightweight over complex.** Fewer moving parts, fewer deps, less config. Simple > clever. Readable > elegant.

**Open-source only.** No vendor lock-in. Every line of code must have a purpose -- no speculative code, no premature abstractions.

## Language and runtime

- Vanilla JavaScript, ES modules, no build step
- Node.js >= 22 (built-in WebSocket, built-in SQLite)
- No TypeScript -- can add types later if needed

## Running tests

```bash
# All 54 tests
node --test test/unit/*.test.js test/integration/*.test.js

# Unit only (fast, no network)
node --test test/unit/prune.test.js
node --test test/unit/auth.test.js
node --test test/unit/cdp.test.js

# Integration (needs Chromium + network)
node --test test/integration/browse.test.js
node --test test/integration/interact.test.js

# Quick smoke test
node -e "import { browse } from './src/index.js'; console.log(await browse('https://example.com'))"
```

## Testing standards

- **Test behavior, not implementation.** Call the public API, assert on observable output.
- **Integration tests are the sweet spot.** Real components working together.
- **No test framework deps.** `node:test` and `node:assert/strict` only.
- **Always `page.close()` in a `finally` block** to avoid leaked browser processes.
- **Use `data:` URL fixtures** for deterministic tests (no network dependency).
- **Real-site tests** go in `interact.test.js`, grouped by site.

See `docs/04-process/testing.md` for the full test guide.

## Git workflow

- Main branch: `main`
- Commit messages: conventional (`fix:`, `feat:`, `chore:`, `docs:`, `release:`)
- No force pushes to main

## Environment

- OS: Fedora Linux, KDE Plasma, Wayland
- Node: 22.22.0
- Browser: `/usr/bin/chromium-browser`
- Default browser: Firefox (cookies extracted from `~/.mozilla/firefox/*.default-release/cookies.sqlite`)
- KWallet has Chromium Safe Storage key
