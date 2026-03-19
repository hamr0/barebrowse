# Bug Log

Track bugs: symptom, root cause, fix, regression test.

---

## [2026-03-19] Timeout bypasses auto-retry

**Symptom:** `goto` on a slow site (braunhousehold.nl) returned `Tool "goto" timed out after 30s` with no retry. The `withRetry()` mechanism from v0.7.0 was supposed to handle this but never fired.
**Root cause:** The 30s timeout was a `Promise.race` in the MCP transport layer, *outside* `withRetry()`. When it fired, it rejected the entire call — `withRetry` was still blocked inside and its result was discarded. Additionally, `isCdpDead()` didn't match timeout error messages, so even internal CDP timeouts wouldn't trigger a retry.
**Fix:** Moved per-attempt timeout inside `withRetry()` (mcp-server.js:29-48). Renamed `isCdpDead()` to `isTransient()` to also match timeout errors. Removed outer `Promise.race`. Each retry attempt now gets its own deadline.
**Regression test:** `test/unit/mcp.test.js` — "retries once on timeout", "retries once on transient CDP error", "does not retry non-transient errors"
