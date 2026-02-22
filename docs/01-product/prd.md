# barebrowse — Product Requirements Document

**Version:** 1.0
**Date:** 2026-02-22
**Status:** POC

---

## What barebrowse is

A standalone vanilla JavaScript library that gives autonomous agents authenticated access to the web through the user's own Chromium browser. One package, one import, three modes.

```js
import { browse } from 'barebrowse';
const snapshot = await browse('https://any-page.com');
```

barebrowse handles: finding the browser, connecting via CDP, injecting cookies, navigating, extracting the ARIA accessibility tree, and pruning it down to what an agent actually needs. The output is a clean, token-efficient snapshot of any web page — authenticated as the real user.

## What barebrowse is NOT

- **Not a framework.** No plugin system, no config files, no lifecycle hooks.
- **Not an MCP server.** But trivially wrappable as one (~30 lines).
- **Not Playwright.** No bundled browser, no cross-engine abstraction, no 200MB download.
- **Not an agent.** No LLM, no planning, no orchestration — that's bareagent's job.
- **Not a scraper.** It browses as the user, not as a bot harvesting data.

---

## The Problem

Every AI agent that needs to read or interact with the web hits the same walls:

1. **Cloudflare / bot detection** — headless browsers get blocked
2. **Authentication** — sites require login, OAuth, session cookies
3. **Token bloat** — raw DOM is 100K+ tokens; agents need ~5K
4. **Two consumers, same need** — research agents (read pages) and personal assistants (click/type) both need an authenticated browser, but existing tools force you to choose one path

Existing solutions (Playwright MCP, sweetlink, open-operator, browser-use) are either too heavy, too opinionated, or solve only half the problem.

## The Insight

The user already has a browser. It's already logged in. It already passes Cloudflare. Instead of fighting the web with headless stealth tricks, **use what's already there**.

CDP (Chrome DevTools Protocol) lets us connect to any Chromium-based browser — the same one the user browses with daily. We get their cookies, their sessions, their anti-detection posture, for free.

---

## Core Architecture

### CDP-Direct (Why No Playwright)

**Decision:** Use CDP over WebSocket directly. No Playwright dependency.

**Why:**
- Playwright downloads a bundled Chromium (~200MB). barebrowse uses the browser already installed on the user's machine.
- Playwright abstracts CDP, but we need CDP directly for all three modes (headless, headed, hybrid) against the user's real browser.
- Every Playwright API call maps 1:1 to a CDP method. The abstraction adds weight without adding capability for our use case.
- CDP gives us everything: `Accessibility.getFullAXTree`, `Page.navigate`, `Runtime.evaluate`, `Input.dispatch*Event`, `Network.setCookie`, `Page.captureScreenshot`.
- The CDP WebSocket client is ~100 lines of vanilla JS. Playwright is ~50,000.

**What we lose:** Cross-engine support (Firefox, WebKit). CDP only works with Chromium-family browsers (Chrome, Chromium, Edge, Brave, Vivaldi, Arc, Opera). This covers ~80% of desktop browsers. Firefox support could come later via WebDriver BiDi.

**What we gain:** Zero heavy deps, uses the user's real browser, same code path for headless/headed/hybrid, drastically simpler codebase.

### ARIA-First (Why Not DOM)

**Decision:** Use `Accessibility.getFullAXTree` (ARIA/accessibility tree) as the primary page representation, not DOM.

**Why:**
- The accessibility tree is the semantic structure of the page — roles, names, states, interactive elements. It's what screen readers see. It's also what agents need.
- DOM is bloated: wrapper divs, styling, tracking pixels, ad scripts. An agent doesn't need any of that.
- mcprune already proved this: ARIA snapshots pruned by role achieve 75-95% token reduction on typical pages while preserving all actionable information.
- CDP's `Accessibility.getFullAXTree` returns the tree directly. No parsing HTML, no building a DOM tree, no traversing nodes.
- ARIA refs map directly to CDP interaction targets — the agent reads a button in the tree and can click it via the same CDP connection.

**The pipeline:** CDP connect → authenticate → navigate → ARIA tree → prune → agent gets clean snapshot.

### Three Modes (Why All Three)

**Decision:** Headless, headed, and hybrid — not as separate packages or optional features, but as a single flag on the same API.

**Why they're not bloat:** The CDP conversation is identical regardless of mode. The only difference is how you get a browser process with a debug port. It's one code path with a different entry point:

```
headless: spawn chromium --headless=new --remote-debugging-port=N
headed:   connect to user's already-running browser on debug port
hybrid:   try headless → detect failure → fall back to headed
```

After connection, every CDP command is the same. Three modes = ~20 extra lines in `chromium.js`, not three implementations.

**When to use each:**

| Mode | Use case | Example |
|---|---|---|
| `headless` | Agent research, background tasks, CI | "Read this article and summarize it" |
| `headed` | Personal assistant, interactive tasks, auth flows | "Book me a flight on this page" |
| `hybrid` | Default for autonomous agents | Try headless; if CF-blocked, fall back to headed |

**Headless is the default.** Most agent tasks are "go read this page." Headed is the escape hatch for when headless fails or the task requires user-visible interaction.

### Cookie Authentication

**Decision:** Extract cookies from the user's browser profile and inject via CDP `Network.setCookie`.

**Why:**
- The user's browser has active sessions for every site they use. We reuse those sessions instead of building new auth flows.
- sweet-cookie (npm package) already extracts cookies from Chrome/Firefox/Safari SQLite databases with OS keychain decryption. We use it or vendor the relevant parts.
- For headed mode, cookies are already present in the browser — no extraction needed.
- For headless mode, we extract from the user's profile and inject into the headless instance.

**Limitation:** Cookies expire. This works for existing sessions, not new logins. For sites requiring fresh auth, headed mode with user interaction is the fallback.

### Pruning (Absorbed from mcprune)

**Decision:** Port mcprune's role-based ARIA tree pruning into barebrowse as a built-in step, not an optional module.

**Why:**
- Pruning is not optional for agent consumption. A raw ARIA tree is still too large for most LLM context windows. Pruning is part of the pipeline, not an afterthought.
- mcprune's pruning logic is a pure function: takes an ARIA tree, returns a smaller ARIA tree. No browser dependency, no Playwright coupling. It's ~300 lines of role-based tree surgery.
- By absorbing it, barebrowse becomes a complete "URL in, agent-ready snapshot out" solution. No second package needed.

**What we port from mcprune:**
- Role taxonomy (landmarks, interactive, structural, noise)
- Landmark extraction (main, nav, banner, etc.)
- Noise removal (ads, tracking, legal boilerplate)
- Interactive element preservation (buttons, links, inputs)
- Wrapper collapsing (nested generics, empty groups)
- Context-aware filtering (search relevance, dedup)

**What stays in mcprune:** The Playwright MCP proxy architecture. mcprune can continue to exist as a Playwright-based MCP server for users who want that path. But for barebrowse consumers, pruning is built in.

---

## API Design

### Public API

```js
import { browse, connect } from 'barebrowse';

// One-shot: URL in, pruned ARIA snapshot out
const tree = await browse('https://example.com');

// With options
const tree = await browse('https://example.com', {
  mode: 'hybrid',        // 'headless' (default) | 'headed' | 'hybrid'
  cookies: true,          // inject user's cookies (default: true)
  prune: true,            // apply ARIA pruning (default: true)
  browser: 'chrome',      // which browser profile for cookies
  timeout: 30000,         // navigation timeout ms
});

// Long-lived session for interaction
const page = await connect({ mode: 'headed' });
await page.goto('https://amazon.com/cart');
await page.click('[data-action="checkout"]');
await page.type('#gift-message', 'Happy birthday!');
const tree = await page.snapshot();  // ARIA + prune
await page.close();
```

### Design Principles

1. **One package, one import.** No picking pieces. `browse()` does everything. Power users get `connect()` for long-lived sessions.
2. **Batteries included.** Cookies, ARIA, pruning — all happen inside by default. Disable with flags if you want raw access.
3. **Escape hatches.** `connect()` returns an object with the raw CDP connection accessible. If you need something we don't wrap, you can send CDP commands directly.
4. **Progressive complexity.** `browse(url)` for 90% of use cases. Options object for the rest. `connect()` for interactive sessions.

---

## The bare- Ecosystem

```
bareagent   = the brain  (orchestration, planning, memory, retries, tool loop)
barebrowse  = the eyes + hands  (browse, read, interact with the web)
```

**Integration with bareagent:**

```js
import { Loop } from 'bare-agent';
import { browse } from 'barebrowse';

const tools = [
  { name: 'browse', execute: ({ url }) => browse(url) },
];

const loop = new Loop({ provider });
await loop.run([{ role: 'user', content: 'Find the cheapest flight to Tokyo' }], tools);
```

bareagent handles the think/act/observe loop. barebrowse handles "see the web and act on it." Neither is opinionated about the other. Tools are plain functions.

**Integration with multis:**

multis (personal assistant) uses barebrowse in headed mode for interactive tasks. The multis proxy is already running, providing a desktop session. barebrowse connects to the user's Chrome and drives it on behalf of the assistant.

**MCP server wrapper (future):**

barebrowse is not an MCP server, but wrapping it as one is ~30 lines. This would replace Playwright MCP + mcprune proxy with a single, lighter MCP server.

---

## Decisions Log — Why We Chose Each

This section exists so we don't re-debate settled decisions.

| Decision | Choice | Why | Alternative considered | Why not |
|---|---|---|---|---|
| Browser protocol | CDP direct | Uses user's browser, ~100 lines, all 3 modes | Playwright | 200MB download, bundles its own Chromium, abstracts what we need raw |
| Page representation | ARIA tree | Semantic, token-efficient, what agents need | DOM/HTML | Bloated, noisy, needs heavy parsing |
| Pruning | Built-in | Agents always need pruned output | Optional/separate | Two deps for one job, pruning isn't optional |
| Cookie auth | Own auth.js + CDP inject | User's existing sessions (Firefox or Chromium), cross-browser injection into headless Chromium | OAuth/credential storage | Complex, security liability, reinventing what the browser already solved |
| Three modes | One flag | Same CDP code, ~20 lines difference | Separate packages | Same code, artificial separation |
| Chromium only | CDP constraint | ~80% browser share, user's real browser | Cross-browser (Playwright) | Requires Playwright, loses "use your own browser" benefit |
| Anti-detection | Runtime.evaluate patches | Minimal stealth for headless mode | Full stealth framework | Over-engineering; headless + real cookies handles 90% |
| Daemon/server | None | CDP is direct, no intermediary needed | sweetlink daemon pattern | Unnecessary complexity for local agent→browser |
| Framework | None (vanilla JS) | Matches bare- philosophy, zero deps | Express/Fastify wrapper | Not a server, not needed |
| Language | Vanilla JavaScript | Node.js ecosystem, same as bareagent, CDP libs available | TypeScript | Added build step, not needed for POC; can add types later |
| Naming | chromium.js | Covers all Chromium-family browsers, not just Chrome | chrome.js | Too specific; Brave/Edge/Arc are also targets |
| mcprune integration | Absorb pruning logic | One package does it all, mcprune pruning is a pure function | Keep separate | Agents shouldn't need two packages to browse |
| openclaw lesson | Single bridge protocol | One CDP connection vs many API integrations | Direct multi-API | openclaw proved this fails — bloat, maintenance, fragility |

---

## Future Features (Post-POC)

### Near-term
- **Screenshot capture** — `Page.captureScreenshot` via CDP. Useful for visual verification and multimodal agents.
- **Network interception** — `Network.requestWillBeSent` / `Network.responseReceived` for monitoring page loads. Detect redirects, blocked resources, API calls.
- **Wait strategies** — `waitForNavigation()` done (Page.loadEventFired). Still needed: network idle, element presence polling.
- **Tab management** — Multiple pages in one browser session. CDP `Target.createTarget` / `Target.attachToTarget`.
- **MCP server wrapper** — Expose browse/click/type as MCP tools. Replaces Playwright MCP + mcprune combo.

### Medium-term
- **Firefox support** — Via WebDriver BiDi protocol (cross-browser standard, still maturing). Second protocol adapter alongside CDP.
- **Cookie sync** — In hybrid mode, extract fresh cookies from headed session and cache for future headless use. Self-refreshing auth.
- **Selector discovery** — Port sweetlink's `discoverSelectors` — crawl ARIA tree, score interactive elements, return ranked action targets.
- **Form understanding** — Detect forms in ARIA tree, map fields to semantic purposes, enable agents to fill forms intelligently.
- **Proxy/Tor support** — Route headless browser through proxy for geo-restricted content.

### Long-term
- **Profile management** — Multiple browser profiles for different identities/accounts.
- **Session recording/replay** — Record browsing sessions as CDP commands, replay for testing.
- **Visual grounding** — Combine ARIA tree with screenshot regions for multimodal agents.
- **Agent memory integration** — Remember visited pages, cache snapshots, track which sites need headed mode.

---

## Repos Studied — What We Borrowed and Why

| Repo | What we took | What we skipped |
|---|---|---|
| **steipete/sweet-cookie** | Cookie extraction from browser profiles, OS keychain decryption | Nothing — clean, focused library |
| **steipete/sweetlink** | CDP dual-channel concept, selector discovery scoring, click/command patterns | Daemon architecture, WebSocket bridge, in-page runtime injection, HMAC auth |
| **steipete/canvas** | Stealth/anti-detection config patterns | Go implementation (we're JS) |
| **nichochar/open-operator** | AI agent web automation patterns | Full framework, too opinionated |
| **AntlerClaw/playwright-mcp** | How to expose browser as MCP tools | Playwright dependency |
| **AntlerClaw/mcp-browser-use** | MCP-native browser patterns | Heavy deps |
| **AitchKay/chromancer** | Accessibility tree extraction approach | Different stack |
| **mcprune (own)** | ARIA pruning logic — role taxonomy, landmark extraction, noise removal, wrapper collapsing | Playwright dependency, MCP proxy architecture |
| **openclaw (own)** | Lesson learned: multi-API direct integration = bloat. Use a single bridge protocol | Everything — the architecture was the cautionary tale |

### The openclaw lesson

openclaw tried to integrate 10+ messaging APIs directly — each with its own auth, format, quirks. It became a maintenance nightmare. multis solved the same problem by using Beeper/Matrix as a single bridge.

barebrowse applies the same lesson: instead of integrating Playwright + Puppeteer + WebDriver + stealth plugins + cookie libraries + proxy managers, we use **one protocol (CDP) to one browser (the user's)**. Everything else is unnecessary.

---

## Success Criteria

barebrowse succeeds when:

1. `browse(url)` returns a pruned ARIA snapshot of any page, authenticated as the user
2. Zero heavy dependencies — no Playwright, no Puppeteer, no bundled browser
3. Works with any installed Chromium-based browser
4. Headless for research, headed for interaction, hybrid for autonomous agents
5. Plugs into bareagent as plain tool functions
6. Total source under 1,000 lines for core functionality
7. An agent using barebrowse + bareagent can autonomously research the web and act on pages
