# barebrowse — POC Plan

**Date:** 2026-02-22
**Goal:** Prove that an autonomous agent can get an authenticated, pruned ARIA snapshot of any web page via CDP — no Playwright, no bundled browser.

---

## Repo Structure

```
barebrowse/
├── src/
│   ├── index.js          # Public API: browse(), connect()
│   ├── chromium.js        # Find/launch/connect to Chromium browsers
│   ├── cdp.js             # Vanilla WebSocket CDP client
│   ├── aria.js            # Accessibility.getFullAXTree → structured tree
│   ├── auth.js            # Cookie extraction + CDP Network.setCookie injection
│   ├── prune.js           # ARIA tree pruning (ported from mcprune)
│   ├── interact.js        # Click, type, scroll via CDP Input domain
│   ├── consent.js         # Auto-dismiss cookie consent dialogs
│   └── stealth.js         # Anti-detection patches via Runtime.evaluate (Phase 4)
├── test/
│   ├── integration/
│   │   ├── browse.test.js     # End-to-end: URL → pruned snapshot
│   │   ├── auth.test.js       # Cookie injection → authenticated page
│   │   └── interact.test.js   # Click/type on a live page
│   └── unit/
│       ├── cdp.test.js        # CDP client message handling
│       ├── aria.test.js       # ARIA tree formatting
│       └── prune.test.js      # Pruning logic on sample trees
├── docs/
│   ├── prd.md             # Product requirements (comprehensive)
│   └── poc-plan.md        # This file
├── package.json
└── CLAUDE.md
```

**No build step.** Vanilla JS, ES modules, runs directly with Node.js >= 22.

---

## Phases

### Phase 1 — CDP + ARIA Foundation

**Prove:** Get an ARIA tree from any page via CDP, no Playwright.

**Files:**
- `src/chromium.js` — Find installed Chromium browsers on the system (Chrome, Chromium, Brave, Edge). Launch headless with `--headless=new --remote-debugging-port=<port>`. Parse CDP WebSocket URL from stderr output.
- `src/cdp.js` — Vanilla WebSocket client that speaks CDP. Send JSON commands, receive responses and events. Handle command IDs, promises, event subscriptions. ~100 lines.
- `src/aria.js` — Call `Accessibility.getFullAXTree` via CDP. Transform the raw CDP response (flat array of AXNodes with parentId references) into a nested tree structure. Format as readable output.
- `src/index.js` — Wire chromium → cdp → aria into `browse(url)` function. Minimal, just the pipeline.

**Test:**
```bash
node -e "import { browse } from './src/index.js'; console.log(await browse('https://example.com'))"
```

**DoD:**
- [x] `chromium.js` finds and launches at least one Chromium browser on Fedora Linux
- [x] `cdp.js` connects via WebSocket, sends commands, receives responses
- [x] `aria.js` returns a structured ARIA tree for any public page
- [x] `browse(url)` works end-to-end with zero external dependencies
- [x] Headless Chrome process is cleaned up on close

### Phase 2 — Auth + Prune

**Prove:** Authenticated, pruned ARIA snapshot of a Cloudflare-protected page.

**Files:**
- `src/auth.js` — Extract cookies from user's browser profile (use sweet-cookie or implement minimal extraction from Chrome's Cookies SQLite DB + Linux keyring decryption via `secret-tool`). Inject via CDP `Network.setCookie` before navigation.
- `src/prune.js` — Port mcprune's pruning logic as a pure function. Input: raw ARIA tree. Output: pruned ARIA tree. Role-based: keep landmarks + interactive elements, drop noise/structural wrappers.
- Update `src/index.js` — Add cookie injection and pruning to the `browse()` pipeline.

**Test:**
```bash
# Should return authenticated content, not a login wall or CF challenge
node -e "import { browse } from './src/index.js'; console.log(await browse('https://some-cf-protected-site.com'))"
```

**DoD:**
- [x] `auth.js` extracts cookies from Firefox profile on Linux (also supports Chromium when installed)
- [x] Cookies injected via CDP before navigation
- [ ] CF-protected page returns real content, not challenge page (needs active session to test)
- [x] `prune.js` reduces ARIA tree by 47%+ on HN (minimal site — heavier sites will see 70%+)
- [x] Pruned output preserves all interactive elements and landmarks
- [x] `browse(url)` returns pruned, authenticated snapshot by default

### Phase 3 — Headed Mode + Interaction

**Prove:** Connect to user's running browser and interact with a logged-in page.

**Files:**
- Update `src/chromium.js` — Add `connect()` mode: connect to an already-running browser's debug port instead of launching a new one. Detect running browsers with debug ports.
- `src/interact.js` — Click (`Input.dispatchMouseEvent`), type (`Input.dispatchKeyEvent`), scroll. Resolve ARIA node IDs to DOM coordinates for click targets.
- Update `src/index.js` — Add `connect()` export for long-lived sessions. Add `mode: 'headed'` option.

**Prerequisite:** User must launch their browser with `--remote-debugging-port=9222` flag.

**Test:**
```bash
# User has Chrome open with debug port, logged into GitHub
node -e "
  import { connect } from './src/index.js';
  const page = await connect({ mode: 'headed' });
  await page.goto('https://github.com/notifications');
  console.log(await page.snapshot());
"
```

**DoD:**
- [x] `connect()` attaches to a running Chromium browser via CDP
- [x] Same ARIA + prune pipeline works on headed browser
- [x] `click()` and `type()` send real input events via CDP
- [x] `press()` sends special keys (Enter, Tab, Escape, arrows) — triggers form submit
- [x] `scrollIntoView` before click ensures off-screen elements are reachable
- [x] `type({ clear: true })` replaces pre-filled input content
- [x] `waitForNavigation()` waits for page load after link clicks
- [x] Interactions tested against real sites: Wikipedia, GitHub, Google, Hacker News, DuckDuckGo, YouTube
- [x] Browser stays open after barebrowse disconnects
- [x] Cookie injection via `page.injectCookies()` for headed mode (Firefox → Chromium)
- [x] Permission prompts suppressed via launch flags + CDP `Browser.setPermission`
- [x] Cookie consent dialogs auto-dismissed across 16+ sites in 7 languages
- [x] YouTube end-to-end: Firefox cookies → search → click → video playback in headed mode

### Phase 4 — Hybrid + bareagent Integration

**Prove:** Agent autonomously browses the web using barebrowse tools.

**Files:**
- Update `src/chromium.js` — Add `mode: 'hybrid'`. Try headless first. If navigation returns a CF challenge or 403, automatically retry in headed mode.
- `src/stealth.js` — Basic anti-detection: patch `navigator.webdriver`, `navigator.plugins`, `window.chrome`. Applied via `Runtime.evaluate` on new page.
- Update `src/index.js` — Final API surface: `browse()`, `connect()`.

**Test:**
```js
import { Loop } from 'bare-agent';
import { browse } from './src/index.js';

const tools = [
  { name: 'browse', execute: ({ url }) => browse(url) },
];

const loop = new Loop({ provider });
await loop.run([
  { role: 'user', content: 'Go to hacker news and tell me the top 3 stories' }
], tools);
```

**DoD:**
- [ ] Hybrid mode automatically falls back when headless is blocked
- [ ] Stealth patches reduce headless detection on common sites
- [ ] bareagent can use `browse()` as a tool in its think/act/observe loop
- [ ] Agent successfully completes a multi-page research task autonomously

---

## Definition of Done — Full POC

The POC is complete when ALL of these are true:

1. **`browse(url)` works end-to-end** — URL in, pruned ARIA snapshot out, authenticated as the user
2. **Zero heavy deps** — no Playwright, no Puppeteer. Only deps: `ws` (WebSocket client, if Node's built-in isn't sufficient) and optionally `sweet-cookie`
3. **Three modes work** — headless (default), headed (connect to running browser), hybrid (auto-fallback)
4. **Works on Fedora Linux** — finds Chrome/Chromium/Brave, launches headless, connects headed
5. **Token-efficient output** — pruned ARIA tree is 70%+ smaller than raw tree
6. **Clean process management** — headless browser spawned and killed cleanly, no orphan processes
7. **Under 1,000 lines total** for core src/ (excluding tests)
8. **Documented** — PRD captures all decisions, this file captures all phases

## What the POC is NOT

- Not production-ready. No error recovery, no retry logic, no edge case handling beyond happy path.
- Not cross-platform tested. Linux first (Fedora). macOS/Windows later.
- Not an MCP server. That's a future wrapper.
- Not a published npm package. Local development only.

---

## Running Tests

```bash
# All tests (47+ tests)
node --test test/unit/*.test.js test/integration/*.test.js

# Unit tests only (fast, no network)
node --test test/unit/prune.test.js    # 16 tests — pruning logic
node --test test/unit/auth.test.js     # 7 tests — cookie extraction (2 fail when Chromium locked)
node --test test/unit/cdp.test.js      # 5 tests — CDP client + browser launch

# Integration tests (needs network + Chromium)
node --test test/integration/browse.test.js    # 11 tests — end-to-end pipeline
node --test test/integration/interact.test.js  # 15 tests — interactions on real sites

# Quick smoke test
node -e "import { browse } from './src/index.js'; console.log(await browse('https://example.com'))"

# Headed mode demos (requires: chromium-browser --remote-debugging-port=9222)
node examples/headed-demo.js    # Wikipedia → DuckDuckGo search
node examples/yt-demo.js        # YouTube: Firefox cookies → search → play video
```

---

## Repos Studied — What We Borrowed vs Built

| steipete repo | What we studied | What we used | Why not more |
|---|---|---|---|
| **sweet-cookie** | Cookie extraction (SQLite + keyring) | **Concept only** — wrote `auth.js` ourselves | Not on npm (different package). Our version is simpler, tailored, vanilla JS |
| **sweetlink** | CDP dual-channel, selector discovery, daemon | **CDP-direct concept only** | Daemon + WebSocket bridge + in-page runtime = bloat. CDP direct is 100 lines vs ~2,000 |
| **canvas** | Stealth/anti-detection patterns | **Noted for Phase 4** `stealth.js` | Not needed yet — headless + real cookies handles most cases |
| **mcprune (own)** | ARIA pruning pipeline | **Full port** — `prune.js` (472 lines) | Proven code, adapted node format from Playwright YAML to CDP tree objects |

### What to explore in later phases

- **Selector discovery** (sweetlink) — crawl ARIA tree, score interactive elements, rank action targets. Phase 3/4.
- **Stealth patches** (canvas) — `navigator.webdriver`, plugins, chrome object spoofing. Phase 4.
- **In-page JS execution** (sweetlink) — `Runtime.evaluate` for complex interactions. Phase 3.
- **Screenshot + visual grounding** — `Page.captureScreenshot` for multimodal agents. Post-POC.

---

## Dev Rules (from AGENT_RULES.md)

- **Vanilla JS only.** No TypeScript, no build step, no transpilation.
- **Dependency hierarchy:** vanilla → stdlib → external. Write it yourself if <50 lines.
- **Simple > clever.** Readable code a junior can follow.
- **POC first.** Validate logic before designing. Never ship the POC — rewrite it.
- **Test behavior, not implementation.** Integration tests over unit tests.
- **No speculative code.** Every line must have a purpose.
