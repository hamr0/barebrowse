# Insights

Lessons learned, patterns discovered, things to remember.

---

## The openclaw lesson

openclaw tried to integrate 10+ messaging APIs directly -- each with its own auth, format, quirks. It became a maintenance nightmare. multis solved the same problem by using Beeper/Matrix as a single bridge.

barebrowse applies the same lesson: instead of integrating Playwright + Puppeteer + WebDriver + stealth plugins + cookie libraries + proxy managers, we use **one protocol (CDP) to one browser (the user's)**. Everything else is unnecessary.

**Takeaway:** When possible, find a single bridge protocol instead of N direct integrations.

## Repos studied -- what we took and what we skipped

| Repo | What we took | What we skipped | Why |
|------|-------------|-----------------|-----|
| **steipete/sweet-cookie** | Cookie extraction concept (SQLite + keyring) | Nothing | Not on npm. Wrote our own auth.js -- simpler, tailored, vanilla JS |
| **steipete/sweetlink** | CDP-direct concept | Daemon, WebSocket bridge, in-page runtime, HMAC auth | CDP direct is 100 lines vs ~2,000 |
| **steipete/canvas** | Stealth/anti-detection patterns | Go implementation | Noted for stealth.js |
| **mcprune (own)** | Full pruning pipeline port | Playwright dependency, MCP proxy | prune.js is 472 lines, adapted from Playwright YAML to CDP tree |
| **openclaw (own)** | Cautionary tale | Everything | Multi-API direct integration = bloat |

## Key technical insights

- **ARIA tree > DOM** for agent consumption. Semantic, compact, interactive elements are first-class. Token reduction of 47-95% is real.
- **Cookie consent is solvable** with ARIA tree scanning + a button text corpus in 7 languages. Dialog role detection + global fallback covers >95% of sites.
- **Headed mode is the ultimate fallback.** When stealth fails, when cookies expire, when CAPTCHAs appear -- connecting to the user's real browser session handles it.
- **CDP flattened sessions** are the way to go. One WebSocket, multiple targets. The session ID header routes commands to the right tab.
- **`Page.addScriptToEvaluateOnNewDocument`** runs before any page scripts -- perfect for stealth patches without race conditions.

---

*Add new insights as they emerge. These should be durable lessons, not session notes.*
