# barebrowse — Product Requirements Document

**Version:** 1.5
**Date:** 2026-06-12
**Status:** Phase B (headed enhancements + bot-resistance + MCP completeness) complete @ v0.9.0; pruneMode follow-up shipped @ v0.9.1. v0.10.x added ad/tracker blocking + canvas-noise stealth. **v0.11.0 = security hardening release** — full audit of library + CLI daemon + MCP server; eight findings fixed and regression-tested. See the "Security model & safe defaults" section below and the v0.11.0 CHANGELOG entry. **v0.12.0** adopted the shared JS-library publishing conventions: a JSDoc→`.d.ts` types pipeline (`tsc` checkJs + strictNullChecks, gated in CI), a `files` allowlist, and a push/PR `ci.yml`. **Unreleased** adds `readable()` (clean article extraction via Mozilla Readability), fixes a CDP WebSocket size cap that killed `snapshot()` on large pages (swap to the `ws` package), and extends the `0600`/`0700` artifact-permission invariant to the MCP surface — 168 passing. barebrowse now has two lightweight runtime deps (`ws`, `@mozilla/readability`); see the Decisions Log and CHANGELOG.

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
- **Not *only* an MCP server.** The core is a plain library; an optional MCP wrapper (`mcp-server.js`) ships on top for MCP clients.
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
- The CDP WebSocket client is ~165 lines of vanilla JS (over the `ws` package). Playwright is ~50,000.

**What we lose:** WebKit/Safari. CDP only works with Chromium-family browsers (Chrome, Chromium, Edge, Brave, Vivaldi, Arc, Opera). Firefox — which deprecated CDP — is now supported through a second transport over the same `ws` dependency (see *BiDi-Direct* below), so the CDP path covers Chromium (~80% of desktop) and BiDi covers Firefox.

**What we gain:** Zero heavy deps, uses the user's real browser, same code path for headless/headed/hybrid, drastically simpler codebase.

### BiDi-Direct (Why Firefox Is Its Own Transport)

**Decision:** Drive Firefox over W3C **WebDriver BiDi**, not CDP — a second transport (`src/bidi.js`) beside the CDP client, selected with `connect({ engine: 'firefox' })`. No geckodriver, no new dependency: BiDi rides the same `ws` WebSocket as CDP.

**Why:**
- CDP was deprecated in Firefox; BiDi is the W3C-standard successor (and Chrome implements it too, so this is not a Firefox-only detour).
- A direct BiDi socket at `ws://HOST:PORT/session` speaks `session.new` / `browsingContext.navigate` / `script.evaluate` / `input.performActions` / `storage.setCookie` — a near 1:1 map onto the existing `page.*` surface.
- Firefox cookies are already extracted by `auth.js` (plaintext SQLite, no keyring) and inject back via `storage.setCookie` — same-engine reuse (Firefox → Firefox), strictly more faithful than the cross-engine cookie path.

**The load-bearing risk — and how it was retired:** BiDi has **no `Accessibility.getFullAXTree`**. The entire value prop (a pruned ARIA snapshot) depends on an AX tree. So Firefox reconstructs a **CDP-vocabulary** AX tree *in-page* via one `script.evaluate` (`src/ax-snapshot.js`): implicit ARIA roles, accessible-name computation, `aria-hidden`/visibility filtering, and shadow-DOM/`<slot>` traversal — emitting the exact `{ nodeId, role, name, properties, children, ignored }` shape `prune.js` and `aria.js` already consume, so both are reused unchanged. A POC proved (measured, not asserted) that a 12k-node page serializes as ~1 MB in ~67 ms and the socket survives — the same large-payload failure that forced the `ws` dependency on the CDP side. Fidelity was validated against real CDP snapshots of identical fixtures; the hard cases (nested iframes with cross-context clicks, open shadow DOM, strict CSP, SPA late-DOM) are covered by `test/integration/firefox.test.js`.

**What we gain:** Firefox as a first-class target, W3C-standard alignment, no bundled driver, and the pruning/formatting/reader pipeline shared verbatim across engines.

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
headed:   spawn chromium (visible window) --remote-debugging-port=N
hybrid:   try headless → headed if blocked → back to headless next navigation
```

After connection, every CDP command is the same. Three modes = ~20 extra lines in `chromium.js`, not three implementations.

**When to use each:**

| Mode | Use case | Example |
|---|---|---|
| `headless` | Agent research, background tasks, CI | "Read this article and summarize it" |
| `headed` | Personal assistant, interactive tasks, auth flows | "Book me a flight on this page" |
| `hybrid` | Default for autonomous agents | Try headless each time; headed fallback per-URL, auto-switches back |

**Headless is the default.** Most agent tasks are "go read this page." Headed is the escape hatch for when headless fails or the task requires user-visible interaction.

### Cookie Authentication

**Decision:** Extract cookies from the user's browser profile and inject via CDP `Network.setCookie`.

**Why:**
- The user's browser has active sessions for every site they use. We reuse those sessions instead of building new auth flows.
- sweet-cookie isn't published to npm, so `auth.js` is our own focused implementation: it reads Chromium and Firefox cookie SQLite databases and decrypts Chromium cookies via the OS keyring (KWallet on KDE, GNOME keyring / libsecret otherwise); Firefox cookies are plaintext. (Cross-browser injection into the headless Chromium instance — see the Decisions Log "Cookie auth" row.)
- For headed mode, cookies are already present in the browser — no extraction needed.
- For headless mode, we extract from the user's profile and inject into the headless instance.

**Opt-out — incognito (`incognito: true`):** A clean, unauthenticated session. Skips *all* auth injection — no cookie extraction/injection and no `storageState` — so the agent browses logged-out. (The session profile is already a throwaway temp dir; incognito gates the *other* auth source: the user's real browser cookies. It is not Chrome's `--incognito` flag.) The gate is enforced at the page-object level, so it holds even when a caller injects unconditionally (MCP `goto`, the daemon). Exposed on `browse()`, `connect()`, both engines, MCP (`browse` arg + `BAREBROWSE_INCOGNITO=1`), and CLI (`--incognito`).

**Limitation:** Cookies expire. This works for existing sessions, not new logins. For sites requiring fresh auth, headed mode with user interaction is the fallback.

### Security Model & Safe Defaults

**Decision (v0.11.0):** barebrowse hands an autonomous — and therefore prompt-injectable — agent an *authenticated* browser. The threat model is (a) page-sourced instructions steering the agent into local/internal resources or file exfiltration, and (b) other local users/processes on a shared host. Defaults are calibrated to `severity × likelihood` vs. cost-of-breaking-legit-use, and a safe default never forces the user to disable a *different* safe default to get work done.

| Control | Default | Rationale |
|---|---|---|
| **Navigation scheme guard** | **On.** `file:`/`view-source:`/`chrome:`/`filesystem:`/`devtools:`/… rejected; `http`/`https`/`data`/`blob`/`about` allowed | A *web*-browsing tool reaching the local filesystem is almost never intended and is a confirmed file-read / directory-listing vector. `data:` is opaque-origin (no `file://` or cross-origin read) and the test-fixture mechanism, so blocking it would buy nothing and only push users onto `allowLocalUrls` — which *also* re-opens `file://`. One uncoupled escape hatch: `allowLocalUrls: true`. |
| **Private-network / SSRF guard** | **Opt-in** (`blockPrivateNetwork`) | Blocking loopback / RFC-1918 / link-local / cloud-metadata by default would break the common, legitimate case of pointing an agent at a local dev server. Security-conscious deployments enable it; metadata-credential and internal-recon vectors then close. |
| **Upload sandbox** | **Opt-in** (`uploadDir`) | Uploading files is a stated feature (job applications, KYC, media); files legitimately come from anywhere. A default confinement would break that. When set, paths must resolve (symlinks included) inside the directory. |
| **Daemon authentication** | **On.** Per-session 32-byte token, required on `/command` | The CLI daemon binds loopback, but loopback is shared across local users. Without a token any local process could drive the authenticated browser (incl. `eval`). Token lives in `session.json` (mode `0600`); the bundled client sends it transparently. |
| **Artifact permissions** | **On.** output dir `0700`, files `0600`, across both the daemon *and* MCP surfaces | Snapshots/articles/screenshots (authenticated content) and `saveState` output (cookies + localStorage = session tokens) must not be world-readable on a multi-user host. Modes are set explicitly, so they hold regardless of the process umask. (The MCP path previously inherited a `0644`/umask default — closed and regression-guarded.) |
| **MCP `eval`** | **Opt-in** (`BAREBROWSE_MCP_EVAL=1`) | `Runtime.evaluate` in an authenticated session is full access. The agent acts with less judgment than a developer, so the MCP surface gates it; CLI/connect/daemon keep it (developer is the caller) but the daemon now requires the auth token. |

Cookie injection is scoped by a precise RFC-6265 domain match (not a substring `LIKE`), so browsing one site can't pull look-alike or unrelated-eTLD cookies into the session. Both engines share one `scopedCookiesForUrl` (CDP `authenticate` and Firefox/BiDi `injectCookies`) so they cannot drift — the Firefox path scopes to the target host exactly like CDP rather than loading the whole jar. Every safety control is expressed identically across the library, MCP, bareagent, and CLI surfaces — no entry point is a less-securable path.

**Known limitation:** the private-network guard matches the URL hostname; a public DNS name that resolves to a private IP (DNS rebinding) is not caught — that needs connection-time IP inspection.

### Pruning (Absorbed from mcprune)

**Decision:** Port mcprune's role-based ARIA tree pruning into barebrowse as a built-in step, not an optional module.

**Why:**
- Pruning is not optional for agent consumption. A raw ARIA tree is still too large for most LLM context windows. Pruning is part of the pipeline, not an afterthought.
- mcprune's pruning logic is a pure function: takes an ARIA tree, returns a smaller ARIA tree. No browser dependency, no Playwright coupling. It's ~470 lines of role-based tree surgery.
- By absorbing it, barebrowse becomes a complete "URL in, agent-ready snapshot out" solution. No second package needed.

**What we port from mcprune:**
- Role taxonomy (landmarks, interactive, structural, noise)
- Landmark extraction (main, nav, banner, etc.)
- Noise removal (ads, tracking, legal boilerplate)
- Interactive element preservation (buttons, links, inputs)
- Wrapper collapsing (nested generics, empty groups)
- Context-aware filtering (search relevance, dedup)

**Modes:** `act` (default) keeps interactive elements and short labels — best for clicking/filling. `read` (alias for `browse`) keeps paragraphs, headings, and long text — best for articles, docs, and content extraction. `navigate` and `full` expose progressively more landmarks. Every public surface — `browse()`, `connect()`'s `page.snapshot()`, the MCP `browse`/`snapshot` tools, the bareagent `browse`/`snapshot` tools, and the CLI's `--mode=` / `--prune-mode=` flags — accepts the same enum. When act mode collapses a content-heavy page well past what a search/e-commerce page would, the snapshot appends a one-line `hint: …` suggesting `pruneMode='read'` so the caller can re-snapshot instead of bailing to a separate HTTP fetch.

**What stays in mcprune:** The Playwright MCP proxy architecture. mcprune can continue to exist as a Playwright-based MCP server for users who want that path. But for barebrowse consumers, pruning is built in.

### Obstacle Course — What barebrowse handles automatically

The agent doesn't have to think about any of this:

| Obstacle | How it's handled | Mode |
|----------|-----------------|------|
| **Cookie consent walls** | ARIA tree scan + jsClick accept button, 29 languages | Both |
| **Consent in dialog role** | Detect `dialog`/`alertdialog` with consent hints, click accept inside | Both |
| **Consent outside dialog** (BBC SourcePoint) | Fallback global button scan when dialog has no accept button | Both |
| **Consent behind iframe overlay** | JS click via DOM.resolveNode bypasses z-index/overlay issues, real mouse click fallback for CMPs ignoring synthetic clicks | Both |
| **Permission prompts** (location, camera, mic) | Launch flags + CDP Browser.setPermission auto-deny | Both |
| **Media autoplay blocked** | Autoplay policy flag on launch | Both |
| **Login walls** | Cookie extraction from all browsers (Firefox + Chromium merged), injected via CDP | Both |
| **Pre-filled form inputs** | Select-all + delete before typing | Both |
| **Off-screen elements** | Scrolled into view before every click, JS `.click()` fallback for no-layout elements | Both |
| **Form submission** | Enter key triggers onsubmit | Both |
| **Tab between fields** | Tab key moves focus correctly | Both |
| **SPA navigation** (YouTube, GitHub) | SPA-aware wait: frameNavigated + loadEventFired | Both |
| **Bot detection** (Google, Reddit) | Cloudflare-strong phrases fire regardless of size; generic phrases ("access denied", "unknown error") only fire on near-empty pages — H9 stopped false-flagging legitimate 4xx/5xx pages. `botBlocked` flag + snapshot warning. Stealth patches (headless) + automatic headed fallback | Hybrid |
| **navigator.webdriver / WebGL / hardware / UA leak** | H4 patches: webdriver, plugins, languages, `chrome.runtime` enums, `Notification.permission`/constructor, `hardwareConcurrency=8`, `deviceMemory=8`, WebGL UNMASKED vendor/renderer spoofed to Intel, and `Network.setUserAgentOverride` strips "HeadlessChrome" from the UA in HTTP headers AND `navigator.userAgent` | Headless |
| **Canvas fingerprinting** | v0.10.0: `toDataURL`/`getImageData` apply per-session `crypto.getRandomValues`-seeded XOR noise (~1 byte per 64-byte stride, position-mixed hash). Output stable within a session, different across sessions; bitmap restored after encoding so legitimate canvas use is unaffected | Headless |
| **Ad / tracker URL noise + load drag** | v0.10.0: CDP `Network.setBlockedURLs` with 128 curated patterns covering Google/FB/Amazon/MS/Adobe ads+analytics, major SaaS analytics + session-replay stacks, content-rec, supply-side ad networks, marketing automation. v0.10.1 added long-tail: AppsFlyer/Branch/Adjust (mobile-measurement-on-web), Cloudflare Web Analytics, Matomo Cloud, broader Outbrain (`amplify`/`log`) and PostHog (`/static/array.js`). Default on for launched browsers, off in attach mode. Explicit `blockAds: true` in attach mode follows the session across `switchTab()` (locked in by integration test in v0.10.1). On legacy Chromium lacking the method, a one-time `console.warn` surfaces the fallback (v0.10.1). `opts.blockUrls` extends; `opts.blockAds: false` opts out | Launched |
| **JS dialogs** (alert/confirm/prompt) | Auto-dismiss via CDP, logged in `dialogLog`; H8 added `page.onDialog(handler)` for custom replies | Both |
| **iframe / OOPIF content** (Stripe, reCAPTCHA, embedded forms) | H2: `Target.setAutoAttach({flatten:true})` + per-frame AX trees merged under iframe placeholders. `--site-per-process` forces every iframe (including same-origin) into OOPIF so click coords work. Refs route to the iframe's session via `{ session, backendNodeId }` lookup | Both |
| **Download capture** (`Content-Disposition: attachment`) | H7: `Browser.setDownloadBehavior({behavior:'allowAndName', downloadPath, eventsEnabled:true})` + live `page.downloads` array with `{ guid, url, suggestedFilename, savedPath, state, totalBytes, receivedBytes }` per file | Both (skipped in attach mode) |
| **Profile locking** | Unique temp dir per headless instance | Headless |
| **Shared memory crash** (Linux) | `--disable-dev-shm-usage` prevents `/dev/shm` exhaustion under heavy tab load | Headless |
| **ARIA noise** | 8-step pruning pipeline (ported from mcprune): region extraction, node prune, wrapper collapse, post-clean, then e-commerce noise removal (dedup links, drop sponsored/spec buttons, truncate after footer, drop filter groups) | Both |

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
  incognito: false,       // clean, unauthenticated session: skip all auth injection
  prune: true,            // apply ARIA pruning (default: true)
  browser: 'chrome',      // which browser profile for cookies
  timeout: 30000,         // navigation timeout ms
});

// Long-lived session for interaction
const page = await connect({
  mode: 'headed',
  // Safety controls (v0.11.0):
  allowLocalUrls: false,       // default: file:/chrome:/etc. navigation is blocked
  blockPrivateNetwork: false,  // opt-in SSRF guard (loopback/RFC-1918/metadata)
  uploadDir: '/tmp/agent-uploads', // opt-in: confine upload() to this directory
});
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

**MCP server wrapper (shipped):**

barebrowse ships `mcp-server.js` — a thin wrapper (raw JSON-RPC 2.0 over stdio, no SDK dependency) exposing the same library as MCP tools (`browse`, `goto`, `snapshot`, `readable`, click/type/etc., plus the opt-in `eval`). It replaces Playwright MCP + the mcprune proxy with a single, lighter MCP server.

---

## Decisions Log — Why We Chose Each

This section exists so we don't re-debate settled decisions.

| Decision | Choice | Why | Alternative considered | Why not |
|---|---|---|---|---|
| Browser protocol | CDP direct | Uses user's browser, ~165-line client, all 3 modes | Playwright | 200MB download, bundles its own Chromium, abstracts what we need raw |
| Page representation | ARIA tree | Semantic, token-efficient, what agents need | DOM/HTML | Bloated, noisy, needs heavy parsing |
| Pruning | Built-in | Agents always need pruned output | Optional/separate | Two deps for one job, pruning isn't optional |
| Cookie auth | Own auth.js + CDP inject | User's existing sessions (Firefox or Chromium), cross-browser injection into headless Chromium | OAuth/credential storage | Complex, security liability, reinventing what the browser already solved |
| Three modes | One flag | Same CDP code, ~20 lines difference | Separate packages | Same code, artificial separation |
| Chromium via CDP | CDP constraint | ~80% browser share, user's real browser | Cross-browser (Playwright) | Requires Playwright, loses "use your own browser" benefit |
| Firefox via BiDi | `connect({ engine: 'firefox' })` | CDP is deprecated in Firefox; BiDi is the W3C-standard successor. Second transport (`bidi.js`) over the *same* `ws` dep — no geckodriver, no new dependency. Reuses `prune.js`/`aria.js`/`readable.js` verbatim | Playwright / geckodriver / drop Firefox | Playwright = 200MB + abstraction; geckodriver = an extra binary + process; dropping Firefox cedes a real engine |
| BiDi AX tree | In-page reconstruction (`ax-snapshot.js`) | BiDi has no `getFullAXTree`. Rebuild a CDP-vocabulary tree in one `script.evaluate` (implicit roles, accname, hidden-filtering, shadow-DOM) so pruning/formatting are shared unchanged. POC-measured: 12k nodes → ~1 MB / ~67 ms, socket survives | Native AX API / incremental DOM walk | BiDi exposes no AX API; a naive per-node walk is slow and lossy. Validated against real CDP snapshots |
| Anti-detection | Runtime.evaluate patches | Minimal stealth for headless mode | Full stealth framework | Over-engineering; headless + real cookies handles 90% |
| Daemon/server | None | CDP is direct, no intermediary needed | sweetlink daemon pattern | Unnecessary complexity for local agent→browser |
| Framework | None (vanilla JS) | Matches bare- philosophy, minimal deps (only `ws` + `@mozilla/readability`, both lightweight) | Express/Fastify wrapper | Not a server, not needed |
| Language | Vanilla JavaScript | Node.js ecosystem, same as bareagent, CDP libs available | TypeScript | Added build step for shipped code; instead we ship types via JSDoc→`.d.ts` (see types-pipeline row) with no transpile |
| Types | JSDoc → generated `.d.ts` | Adopters get autocomplete + type errors; the `.js` we author is the `.js` that ships (no build step); `tsc --noEmit` turns JSDoc into a CI-checked contract so it can't drift | Hand-written `.d.ts` / full TypeScript | Hand `.d.ts` go stale; TS needs a transpile step. Generated-and-git-ignored `.d.ts` make drift structurally impossible |
| Naming | chromium.js | Covers all Chromium-family browsers, not just Chrome | chrome.js | Too specific; Brave/Edge/Arc are also targets |
| mcprune integration | Absorb pruning logic | One package does it all, mcprune pruning is a pure function | Keep separate | Agents shouldn't need two packages to browse |
| openclaw lesson | Single bridge protocol | One CDP connection vs many API integrations | Direct multi-API | openclaw proved this fails — bloat, maintenance, fragility |
| CDP transport | `ws` package | Node's built-in WebSocket silently caps decompressed messages ~3 MB and *kills the socket* when `getFullAXTree` on a big page exceeds it — no knob to raise it. `ws` exposes `maxPayload` (set 256 MB). First runtime dep; justified by the "external only when stdlib genuinely can't" rule | Built-in WebSocket / incremental `getChildAXNodes` walk | Built-in can't raise the cap; the zero-dep incremental walk was 14 s + 117 MB garbage on a normal page and still crashed (measured) |
| Reading mode | `readable()` via Mozilla Readability | Some tasks need to *read* an article, not act on it — `snapshot()` is noisy and silently lossy on long prose. Readability is the Firefox Reader-View engine, injected in-page over CDP (works on JS-rendered articles). Companion to `snapshot()`, not a replacement | Reuse `read`-mode snapshot / hand-rolled extraction | Read snapshot drops body text on long pages; content extraction is sanitization-adjacent → use the vetted library, not a homegrown parser |

---

## Future Features (Post-POC)

### Near-term
- **Screenshot capture** — *(Done: `page.screenshot()` returns base64 PNG/JPEG/WebP; v0.9.0 also exposed it as the `screenshot` MCP tool that saves to `.barebrowse/screenshot-*.{png,jpeg,webp}`.)*
- **Wait strategies** — *(Done: `waitForNavigation`, `waitForNetworkIdle`, `waitFor({text|selector})`. F9 in v0.8.0 made network-idle resilient to orphan finish events. v0.9.0 added `wait_for` as an MCP + bareagent tool.)*
- **Tab management** — *(Done: `createTab()`, `tabs()`. F4 in v0.8.0 made `switchTab()` actually swap the working session; F7 wired the dialog handler on sub-tabs. v0.9.0 added `tabs` as an MCP tool with optional `switchTo: N`.)*
- **MCP server wrapper** — *(Done: `mcp-server.js`. v0.9.0 grew to 18+ tools — added `reload`, `screenshot`, `wait_for`, `tabs`, `select`, `hover`, plus the opt-in `eval` gated behind `BAREBROWSE_MCP_EVAL=1`. Per-tool timeouts replaced the blanket 30s; `runStdio()` exported so `cli.js` can launch it cleanly.)*
- **Attach to a running browser** — *(Done v0.9.0: `connect({ port })` reuses an already-running Chrome session via `attach()` → `getDebugUrl()`. Skips stealth + `Browser.setPermission` + download capture so we don't mutate the user's browser globally. `close()` leaves the underlying process alive — only the tab we created is torn down.)*
- **iframe / OOPIF support** — *(Done v0.9.0: `Target.setAutoAttach({flatten:true})` + per-frame AX trees merged. Refs route to the right session via `{session, backendNodeId}` so clicks inside Stripe / reCAPTCHA / embedded forms work. `--site-per-process` launch flag is now default so even same-origin iframes get OOPIF sessions.)*
- **Reload** — *(Done v0.9.0: `page.reload({ignoreCache, timeout})`, exposed as MCP + bareagent + CLI subcommand.)*
- **Download capture** — *(Done v0.9.0: `page.downloads` live array, `--download-path` CLI flag, `downloads` MCP + bareagent + CLI subcommand.)*
- **Dialog override** — *(Done v0.9.0: `page.onDialog(handler)` lets callers return `{accept, promptText}` instead of the default auto-accept.)*
- **Reading mode** — *(Done: `page.readable()` extracts the main article as clean text via Mozilla Readability injected over CDP. Exposed as `readable` on MCP, bareagent, and the CLI (→ `.barebrowse/article-*.txt`). Never hard-gates — returns text plus an advisory `confidence` and a hint to fall back to `snapshot()` on non-articles.)*
- **Network interception** — `Fetch.enable` + URL patterns for blocking trackers/ads or mocking responses. Still queued.

### Medium-term
- **Firefox support** — *(Done: `connect({ engine: 'firefox' })` drives Firefox over WebDriver BiDi via `bidi.js` + `firefox.js`, with the AX tree reconstructed in-page by `ax-snapshot.js`. Covers `goto`, `snapshot`, `click`, `type`, `press`, `scroll`, `hover`, `select`, `drag`, `upload`, `goBack`/`goForward`, `reload`, `screenshot`, `pdf`, `tabs`/`switchTab`, `waitFor`, `readable`, `injectCookies`, `close`. Selectable from MCP via `BAREBROWSE_ENGINE=firefox` and from the CLI via `barebrowse open --engine firefox`. Verified for accname fidelity, iframes, shadow DOM, CSP, SPA timing, navigation, capture, and the CLI/MCP paths in `test/integration/firefox.test.js` + smoke tests. **Known gaps:** consent auto-dismiss and stealth landed on Firefox in v0.16.0 (BiDi parity Phase 1); the daemon's console/network capture and `waitForNetworkIdle` landed in v0.17.0 (Phase 2, over BiDi `log.entryAdded`/`network.*` events); hybrid fallback and ad/tracker blocking remain chromium-only; accname is a high-value subset of the W3C spec; and `reload` can't honour `ignoreCache` (Firefox BiDi doesn't support it yet).)*

  **Known limitations — Firefox stealth + consent (v0.16.0, validated in a code
  review; slated for Phase 5 revisit with a cross-engine fidelity harness):**
  - *Consent false-positive — **fixed** in v0.16.0.* The page-wide accept-button
    scan now runs **only** for banner-style consent (no dialog container). When a
    consent dialog is detected but has no in-dialog accept button, barebrowse no
    longer scans the whole page — a page-wide match there could auto-click an
    unrelated "Accept all …" control (e.g. a ToS/signup button) on `goto()`.
    Trade-off: the rare pattern of an accept button rendered *outside* its own
    dialog (some SourcePoint deployments) is no longer auto-dismissed on Firefox;
    we accept that miss rather than risk a wrong click. Regression-tested in
    `test/unit/consent-firefox.test.js`. (The CDP path still does the page-wide
    scan and carries the original false-positive risk — unchanged here.)
  - *Consent double AX build (performance).* With consent on (default), each
    `goto()` reconstructs the AX tree once for the consent scan and `snapshot()`
    rebuilds it — two in-page reconstructions per navigate. Bounded latency
    (page-size dependent), no correctness impact; parity with the CDP path's
    `getFullAXTree`-per-navigate. Not optimised because the safe options (a
    cheap consent probe, tree caching) risk consent coverage or stale trees.
  - *Consent single-click, no re-verify.* The Firefox walker clicks the accept
    button once (a real BiDi pointer event) and does not re-check dismissal or
    retry, unlike the CDP path's synthetic-then-real retry. A CMP that ignores
    the first click stays up (the flow "fails open" — page loads, wall remains);
    low likelihood since the click is already a real pointer event. Disable with
    `consent: false` where an auto-click is unacceptable.
  - *webdriver own-property fallback (latent).* `WEBDRIVER_PATCH` deletes
    `navigator.webdriver` off `Navigator.prototype`; if a browser ever exposed
    it as an *own* property instead, the delete would miss it and the
    `defineProperty` fallback would restore the `hasOwnProperty` tell. Does not
    occur on current Chromium/Firefox (prototype property), so it is latent.
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
| **steipete/sweet-cookie** | The *approach* — cookie extraction from browser profiles + OS-keyring decryption | The package itself: not published to npm, so `auth.js` reimplements the technique (Chromium KWallet/GNOME + Firefox plaintext) |
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
2. No heavy dependencies — no Playwright, no Puppeteer, no bundled browser; only two lightweight runtime deps (`ws`, `@mozilla/readability`)
3. Works with any installed Chromium-based browser
4. Headless for research, headed for interaction, hybrid for autonomous agents
5. Plugs into bareagent as plain tool functions
6. The source stays small and readable — low thousands of lines across focused modules, versus Playwright's ~50,000
7. An agent using barebrowse + bareagent can autonomously research the web and act on pages
