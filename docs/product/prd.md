---
title: barebrowse product requirements
source: docs/archive/prd.md
scope: product requirements only (history, POC results and review findings live in ../logs/findings.md)
---

# barebrowse product requirements

## What barebrowse is

A standalone vanilla JavaScript library that gives autonomous agents authenticated access to the web through the user's own browser. One package, one import, three modes (docs/archive/prd.md:11-11).

```js
import { browse } from 'barebrowse';
const snapshot = await browse('https://any-page.com');
```

It finds the browser, connects over CDP, injects cookies, navigates, extracts the ARIA accessibility tree and prunes it to what an agent needs. The output is a clean, token-efficient snapshot of any page, authenticated as the real user (docs/archive/prd.md:18-18).

## What barebrowse is NOT

- **Not a framework.** No plugin system, config files or lifecycle hooks (docs/archive/prd.md:22-22).
- **Not only an MCP server.** The core is a plain library; an optional MCP wrapper ships on top (docs/archive/prd.md:23-23).
- **Not Playwright.** No bundled browser, no cross-engine abstraction, no 200MB download (docs/archive/prd.md:24-24).
- **Not an agent.** No LLM, planning or orchestration; that is bareagent's job (docs/archive/prd.md:25-25).
- **Not a scraper.** It browses as the user, not as a bot harvesting data (docs/archive/prd.md:26-26).

## The Problem

Every agent that reads or interacts with the web hits the same walls (docs/archive/prd.md:32-37):

1. Bot detection (Cloudflare): headless browsers get blocked.
2. Authentication: sites need login, OAuth, session cookies.
3. Token bloat: raw DOM is 100K+ tokens; agents need about 5K.
4. Two consumers, one need: research agents (read) and personal assistants (click/type) both need an authenticated browser, but existing tools force a choice.

Existing tools (Playwright MCP, sweetlink, open-operator, browser-use) are too heavy, too opinionated, or solve half the problem (docs/archive/prd.md:39-39).

## The Insight

The user already has a browser, already logged in, already passing bot checks. Use what is already there instead of fighting the web with headless stealth (docs/archive/prd.md:43-43). CDP lets us connect to any Chromium-based browser and inherit the user's cookies, sessions and anti-detection posture (docs/archive/prd.md:45-45).

## Core Architecture

### CDP-Direct

Requirement: talk CDP over WebSocket directly, with no Playwright dependency, so the library uses the browser already installed and keeps one code path for headless, headed and hybrid (docs/archive/prd.md:53-58). CDP exposes everything needed: AX tree, navigation, evaluation, input, cookies, screenshots (docs/archive/prd.md:59-59). Scope is the Chromium family (Chrome, Chromium, Edge, Brave, Vivaldi, Arc, Opera); Firefox is covered by a second transport; WebKit is out (docs/archive/prd.md:62-62). Result: no heavy deps, the user's real browser, a small codebase (docs/archive/prd.md:64-64).

### BiDi-Direct (Firefox transport)

Requirement: drive Firefox over W3C WebDriver BiDi as a second transport beside CDP, selected with `connect({ engine: 'firefox' })`, with no geckodriver and no new dependency (it reuses `ws`) (docs/archive/prd.md:68-68). It maps close to 1:1 onto the `page.*` surface, and Firefox cookies are read from the profile and injected back through BiDi (docs/archive/prd.md:72-73).

BiDi has no accessibility-tree call, so Firefox must rebuild a CDP-shaped AX tree in-page (roles, accessible names, hidden filtering, shadow DOM and slots) in the exact shape the pruner and formatter already consume, so both are shared unchanged across engines (docs/archive/prd.md:75-75). Outcome: Firefox as a first-class target with the prune/format/reader pipeline shared verbatim (docs/archive/prd.md:77-77).

### Firefox Parity

**Goal:** practical parity. The capabilities an agent relies on behave the same on both engines, driven by the same `page.*` code: a unified API and the common capability subset, not identical internals (docs/archive/prd.md:81-81).

**Non-goals:** no patched browser builds (stock Firefox over standard BiDi only), and not 100% AX-tree fidelity, since the tree is reconstructed rather than browser-native and the gap is source-tree accuracy only (docs/archive/prd.md:83-83).

**Requirement:** Firefox matches Chromium on stealth, consent, console/network capture, ad blocking, dialogs, hybrid mode, `saveState`, navigation waits and downloads; the one known gap is `reload({ignoreCache})`, an upstream BiDi limitation (docs/archive/prd.md:85-99). Callers can check rather than assume: every page exposes its engine and a capabilities map (docs/archive/prd.md:104-104). An engine is chosen explicitly or auto-selected (Chromium preferred, Firefox fallback with a warning), and a missing binary is an error rather than a silent switch (docs/archive/prd.md:104-104). A fidelity harness guards the reconstructed AX tree against the CDP baseline, and accessible-name computation keeps moving toward the W3C algorithm (docs/archive/prd.md:104-106).

### ARIA-First

Requirement: use the accessibility tree, not the DOM, as the primary page representation (docs/archive/prd.md:110-110). It is the semantic structure (roles, names, states, interactive elements) without wrapper divs, styling or tracking noise, and ARIA refs map directly to interaction targets over the same connection (docs/archive/prd.md:113-117). Pipeline: connect, authenticate, navigate, ARIA tree, prune, clean snapshot (docs/archive/prd.md:119-119).

### Three Modes

Requirement: headless, headed and hybrid as one flag on one API, not separate packages. Only the way the browser process is started differs; every CDP command after that is identical (docs/archive/prd.md:123-133).

| Mode | Use case | Example |
|---|---|---|
| `headless` | Research, background tasks, CI | "Read this article and summarize it" |
| `headed` | Personal assistant, interactive tasks, auth flows | "Book me a flight on this page" |
| `hybrid` | Autonomous agents: try headless, fall back to headed per URL when blocked, switch back on the next navigation | Default choice for agents |

(docs/archive/prd.md:137-141). Headless is the default; headed is the escape hatch (docs/archive/prd.md:143-143).

### Cookie Authentication

Requirement: reuse the user's existing sessions by extracting cookies from their browser profile (Chromium decrypted through the OS keyring, Firefox plaintext) and injecting them over CDP; headed mode needs no extraction (docs/archive/prd.md:147-153). Cookies expire, so this covers existing sessions only; fresh logins fall back to headed mode with user interaction (docs/archive/prd.md:157-157).

**Incognito (`incognito: true`):** a clean, unauthenticated session. It skips all auth injection (cookies and `storageState`), is enforced at the page-object level so unconditional injectors cannot bypass it, and is exposed on `browse()`, `connect()`, both engines, MCP and CLI (docs/archive/prd.md:155-155).

### Security Model & Safe Defaults

barebrowse hands an autonomous, prompt-injectable agent an authenticated browser. Threats: page-sourced instructions steering the agent to local/internal resources or file exfiltration, and other users or processes on a shared host. Defaults weigh severity and likelihood against the cost of breaking legitimate use, and a safe default must never force the user to disable another safe default (docs/archive/prd.md:161-161).

| Control | Default | Requirement |
|---|---|---|
| Navigation scheme guard | On; `file:`, `view-source:`, `chrome:`, `devtools:` etc. rejected; `http`, `https`, `data`, `blob`, `about` allowed. Escape hatch: `allowLocalUrls: true` | A web tool must not reach the local filesystem by default (docs/archive/prd.md:165-165) |
| Private-network / SSRF guard | Opt-in (`blockPrivateNetwork`) | Blocking loopback/RFC-1918/metadata by default would break local dev servers (docs/archive/prd.md:166-166) |
| Upload sandbox | Opt-in (`uploadDir`) | Uploads legitimately come from anywhere; when set, paths must resolve inside the directory (docs/archive/prd.md:167-167) |
| Daemon authentication | On; per-session 32-byte token required on `/command`, stored in a `0600` file | Loopback is shared across local users (docs/archive/prd.md:168-168) |
| Artifact permissions | On; output dir `0700`, files `0600`, on daemon and MCP | Authenticated snapshots and saved state must not be world-readable, regardless of umask (docs/archive/prd.md:169-169) |
| MCP `eval` | Opt-in (`BAREBROWSE_MCP_EVAL=1`) | Evaluation in an authenticated session is full access; CLI/connect keep it, the daemon requires the token (docs/archive/prd.md:170-170) |

Cookie injection is scoped by an RFC-6265 domain match shared by both engines, so one site cannot pull in look-alike or unrelated cookies. Every safety control is expressed identically across library, MCP, bareagent and CLI (docs/archive/prd.md:172-172).

**Site lock (`allowHosts`):** restricts top-frame navigation to listed hosts on both engines, including popups and new tabs; blocked navigations reject with `NAV_BLOCKED` and an in-page block is noted on the next snapshot. It is refused in attach mode. MCP adds `BAREBROWSE_TIER` (r/rw/rwx) and tool annotations, and invalid config refuses to start (docs/archive/prd.md:174-174).

### Pruning

Requirement: role-based ARIA pruning is a built-in pipeline step, not an optional module, so barebrowse is complete as "URL in, agent-ready snapshot out" (docs/archive/prd.md:180-185). It covers a role taxonomy, landmark extraction, noise removal, interactive-element preservation, wrapper collapsing and context-aware filtering (docs/archive/prd.md:187-193).

Modes (docs/archive/prd.md:195-195):
- `act` (default): interactive elements and short labels, for clicking and filling.
- `read` (alias `browse`): paragraphs, headings and long text, for articles and docs.
- `navigate` and `full`: progressively more landmarks.
- `data` (opt-in): a separate transform that emits one line per record, mapping table cells to headers and grouping repeated sibling items; refs are the same ids as act. It is for structured listings; articles stay with `read` or `readable()`.

Every public surface (`browse()`, `page.snapshot()`, MCP, bareagent, CLI flags) accepts the same mode enum. When act mode collapses a content-heavy page too far, the snapshot appends a one-line `hint:` suggesting `read` (docs/archive/prd.md:195-195).

**Links (opt-in):** `links: true` adds each link's absolute URL after its name in every mode, on every surface. `javascript:` and same-page fragment links get no URL. Output is byte-identical when off (docs/archive/prd.md:197-197).

### Obstacle Course

The agent does not have to think about any of this (docs/archive/prd.md:203-203).

| Obstacle | Handling | Mode |
|---|---|---|
| Cookie consent walls | ARIA scan and click the accept button, 29 languages (docs/archive/prd.md:207-207) | Both |
| Consent in a dialog role | Detect consent dialogs and click accept inside (docs/archive/prd.md:208-208) | Both |
| Late-rendered consent dialog | If `goto()` found none, the first `snapshot()` re-checks once on the same document (docs/archive/prd.md:209-209) | Both |
| Consent outside a dialog | Fallback page-wide button scan when the dialog has no accept button (docs/archive/prd.md:210-210) | Both |
| Consent behind an iframe overlay | JS click bypasses overlays, real mouse click as fallback (docs/archive/prd.md:211-211) | Both |
| Permission prompts, media autoplay | Launch flags and auto-deny (docs/archive/prd.md:212-213) | Both |
| Login walls | Cookie extraction from all browsers, injected over CDP (docs/archive/prd.md:214-214) | Both |
| Pre-filled inputs, form submit, Tab between fields | Select-all and delete before typing; Enter submits; Tab moves focus (docs/archive/prd.md:215-218) | Both |
| Off-screen elements | Scrolled into view before every click, JS click fallback (docs/archive/prd.md:216-216) | Both |
| SPA navigation | SPA-aware wait on frame navigation and load (docs/archive/prd.md:219-219) | Both |
| Bot detection | Challenge detection sets a `botBlocked` flag and snapshot warning, without false-flagging legitimate 4xx/5xx pages; stealth patches plus automatic headed fallback (docs/archive/prd.md:220-220) | Hybrid |
| Headless fingerprint leaks (webdriver, WebGL, hardware, UA) | Patched, including "HeadlessChrome" stripped from the UA in headers and `navigator.userAgent` (docs/archive/prd.md:221-221) | Headless |
| Canvas fingerprinting | Per-session noise on canvas reads, stable within a session, legitimate canvas use unaffected (docs/archive/prd.md:222-222) | Headless |
| Ad / tracker noise and load drag | Curated URL blocklist; default on for launched browsers, off in attach mode; `blockUrls` extends, `blockAds: false` opts out (docs/archive/prd.md:223-223) | Launched |
| JS dialogs | Auto-dismissed and logged in `dialogLog`; `page.onDialog(handler)` for custom replies (docs/archive/prd.md:224-224) | Both |
| iframe / OOPIF content | Per-frame AX trees merged under iframe placeholders; refs route to the right frame session (docs/archive/prd.md:225-225) | Both |
| Downloads | Captured into a live `page.downloads` array; skipped in attach mode (docs/archive/prd.md:226-226) | Both |
| Profile locking and orphans | Unique temp profile per instance; failed launches kill the process group and remove the profile; browsers die with a hard-killed launcher on Linux; leftover temp dirs swept at next launch (docs/archive/prd.md:227-227) | Headless |
| Shared-memory crash (Linux) | `--disable-dev-shm-usage` (docs/archive/prd.md:228-228) | Headless |
| ARIA noise | 8-step pruning pipeline including e-commerce noise removal (docs/archive/prd.md:229-229) | Both |

## API Design

### Public API

`browse(url, opts)` is the one-shot call; `connect(opts)` returns a long-lived page (docs/archive/prd.md:237-266).

```js
import { browse, connect } from 'barebrowse';
const tree = await browse('https://example.com', {
  mode: 'hybrid',   // 'headless' (default) | 'headed' | 'hybrid'
  cookies: true,    // inject user's cookies
  incognito: false, // skip all auth injection
  prune: true,      // apply ARIA pruning
  browser: 'chrome',
  timeout: 30000,
});
const page = await connect({ mode: 'headed', allowLocalUrls: false,
  blockPrivateNetwork: false, uploadDir: '/tmp/agent-uploads' });
const { url, status } = await page.goto('https://amazon.com/cart');
await page.click('[data-action="checkout"]');
await page.type('#gift-message', 'Happy birthday!');
const tree2 = await page.snapshot();
await page.close();
```

**Navigation outcome:** `goto()` resolves `{ url, status }` on both engines (status 0 means no HTTP response observed). A non-2xx page still loads and the next snapshot starts with an `[HTTP <status>]` warning. When no document is reachable (DNS, refused, TLS) `goto()` and `browse()` reject with `err.code === 'NAV_FAILED'` and the raw reason in `err.reason`; downloads and 204s are not failures. Status is reported for `goto()` only (docs/archive/prd.md:268-268).

### Design Principles

1. **One package, one import.** `browse()` does everything; `connect()` is for long-lived sessions (docs/archive/prd.md:272-272).
2. **Batteries included.** Cookies, ARIA and pruning happen by default; flags disable them (docs/archive/prd.md:273-273).
3. **Escape hatches.** `connect()` exposes the raw CDP connection (docs/archive/prd.md:274-274).
4. **Progressive complexity.** `browse(url)` for 90% of cases, options for the rest, `connect()` for interaction (docs/archive/prd.md:275-275).

## The bare- Ecosystem

```
bareagent   = the brain  (orchestration, planning, memory, retries, tool loop)
barebrowse  = the eyes + hands  (browse, read, interact with the web)
```

(docs/archive/prd.md:281-284). bareagent runs the think/act/observe loop; barebrowse handles "see the web and act on it." Neither is opinionated about the other, and tools are plain functions such as `{ name: 'browse', execute: ({ url }) => browse(url) }` (docs/archive/prd.md:288-300).

**multis** (personal assistant) uses barebrowse in headed mode, driving the user's Chrome on the assistant's behalf (docs/archive/prd.md:304-304).

**MCP server wrapper:** `mcp-server.js` is a thin raw JSON-RPC 2.0 stdio wrapper with no SDK dependency, exposing the library as MCP tools (`browse`, `goto`, `snapshot`, `readable`, click/type etc., plus opt-in `eval`). `goto` answers `ok` for 2xx and `ok (HTTP <status>)` otherwise; unreachable hosts are errors. The server releases its browser after `BAREBROWSE_IDLE_MINUTES` idle (default 15, `0` = off), closes rather than orphans the browser on transient errors, and deletes its own timestamped output files older than 7 days at startup, never touching `session.json`, `state-*.json` or user files. It replaces Playwright MCP plus the mcprune proxy with one lighter server (docs/archive/prd.md:308-308).

## Future Features (Post-POC)

### Shipped

- Screenshots: `page.screenshot()` returns base64 PNG/JPEG/WebP; the MCP `screenshot` tool saves to `.barebrowse/` (docs/archive/prd.md:342-342).
- Wait strategies: `waitForNavigation`, `waitForNetworkIdle`, `waitFor({text|selector})`, also as MCP and bareagent `wait_for` (docs/archive/prd.md:343-343).
- Tab management: `createTab()`, `tabs()`, `switchTab()` swapping the working session, also an MCP `tabs` tool (docs/archive/prd.md:344-344).
- MCP server wrapper with the full tool set, per-tool timeouts and runtime `switch_engine` between Chromium and Firefox (docs/archive/prd.md:345-345).
- Attach to a running browser: `connect({ port })` reuses a running Chrome, skips stealth, permissions and download capture, and leaves the process alive on close (docs/archive/prd.md:346-346).
- iframe / OOPIF support with refs routed to the right frame session; `--site-per-process` is a default launch flag (docs/archive/prd.md:347-347).
- Reload: `page.reload({ignoreCache, timeout})` on MCP, bareagent and CLI (docs/archive/prd.md:348-348).
- Download capture: live `page.downloads`, `--download-path`, `downloads` subcommand (docs/archive/prd.md:349-349).
- Dialog override: `page.onDialog(handler)` returns `{accept, promptText}` (docs/archive/prd.md:350-350).
- Reading mode: `page.readable()` returns the main article as clean text via Mozilla Readability, on MCP, bareagent and CLI. It never hard-gates; it returns an advisory `confidence` and a hint to fall back to `snapshot()` (docs/archive/prd.md:351-351).
- Firefox support: `connect({ engine: 'firefox' })` over BiDi with the full `page.*` surface, selectable from MCP (`BAREBROWSE_ENGINE`) and CLI (`--engine`), swappable at runtime with `switch_engine` / `switch-engine`; see Firefox Parity above (docs/archive/prd.md:356-356).

### Planned

- **Network interception** (near-term): `Fetch.enable` with URL patterns to block trackers/ads or mock responses (docs/archive/prd.md:352-352).
- **Map + zoom** (near-term): `snapshot({ map })` outlines the page's boxes and `snapshot({ within })` returns one box in any mode; MCP/CLI return the map for big pages, library default unchanged (docs/archive/prd.md:353-353).
- **Cookie sync**: in hybrid mode, extract fresh cookies from the headed session and cache them for later headless use (docs/archive/prd.md:422-422).
- **Selector discovery**: crawl the ARIA tree, score interactive elements, return ranked action targets (docs/archive/prd.md:423-423).
- **Form understanding**: detect forms in the ARIA tree and map fields to semantic purposes (docs/archive/prd.md:424-424).
- **Proxy/Tor support**: route the headless browser through a proxy for geo-restricted content (docs/archive/prd.md:425-425).
- **Profile management** (long-term): multiple browser profiles for different identities (docs/archive/prd.md:442-442).
- **Session recording/replay**: record sessions as CDP commands and replay for testing (docs/archive/prd.md:443-443).
- **Visual grounding**: combine the ARIA tree with screenshot regions for multimodal agents (docs/archive/prd.md:444-444).
- **Agent memory integration**: remember visited pages, cache snapshots, track which sites need headed mode (docs/archive/prd.md:445-445).

### Parked

- **Action to calls** ("what did my action cause?"): parked; reasons in [findings](../logs/findings.md) (docs/archive/prd.md:426-426).
- **Site call map** (and a shared index of maps): parked idea, would be a separate tool; reasons in [findings](../logs/findings.md) (docs/archive/prd.md:446-446).
- **WebMCP site tools** (`page.tools()` / `page.callTool()`): parked until widely adopted; reasons in [findings](../logs/findings.md) (docs/archive/prd.md:447-447).

## Success Criteria

barebrowse succeeds when (docs/archive/prd.md:475-483):

1. `browse(url)` returns a pruned ARIA snapshot of any page, authenticated as the user.
2. No heavy dependencies: no Playwright, Puppeteer or bundled browser; only two lightweight runtime deps (`ws`, `@mozilla/readability`).
3. It works with any installed Chromium-based browser.
4. Headless for research, headed for interaction, hybrid for autonomous agents.
5. It plugs into bareagent as plain tool functions.
6. The source stays small and readable: low thousands of lines across focused modules.
7. An agent using barebrowse + bareagent can autonomously research the web and act on pages.
