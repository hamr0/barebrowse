```
  ~~~~~~~~~~~~~~~~~~~~
  ~~~ .---------. ~~~
  ~~~ | · clear | ~~~
  ~~~ | · focus | ~~~
  ~~~ '---------' ~~~
  ~~~~~~~~~~~~~~~~~~~~

  barebrowse
```

<p align="center">
  <a href="https://github.com/hamr0/barebrowse/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/hamr0/barebrowse/ci.yml?label=CI" alt="CI"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/barebrowse?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

> Your agent browses like you do -- same browser, same logins, same cookies.
> Prunes pages down to what matters. 40-90% fewer tokens, zero wasted context.

---

## What this is

barebrowse gives your AI agent a real browser. Navigate, read, interact, move on.

It uses the browser you already have -- your sessions, your cookies. Pages come back stripped to what matters -- 40-90% fewer tokens than raw output.

No Playwright. No bundled browser. No 200MB download. Two tiny dependencies (`ws` + Mozilla Readability).

## Install

```
npm install barebrowse
```

Requires Node.js >= 22 and any installed Chromium-based browser.

Ships with TypeScript types (generated from JSDoc) — autocomplete and type-checking work out of the box, no `@types/barebrowse` needed. The library is vanilla JS with no build step.

## Three ways to use it

### 1. CLI session -- for coding agents and quick testing

```bash
barebrowse open https://example.com    # Start session + navigate
barebrowse snapshot                    # ARIA snapshot → .barebrowse/page-*.yml
barebrowse readable                    # Clean article text → .barebrowse/article-*.txt
barebrowse click 8                     # Click element
barebrowse close                       # End session
```

Outputs go to `.barebrowse/` as files -- agents read them with their file tools, no token waste in tool responses.

**Teach your agent the commands** by installing the skill file (a markdown reference the agent reads as context). The CLI tool itself still needs `npm install barebrowse` -- the skill just teaches the agent how to use it.

**Claude Code:** Copy `commands/barebrowse/SKILL.md` to `.claude/skills/barebrowse/SKILL.md` (project) or run `barebrowse install --skill` (global).

**Other agents:** Copy `commands/barebrowse.md` to your agent's command/skill directory.

For writing your own skill files for other CLI tools: [docs/skill-template.md](docs/skill-template.md).

### 2. MCP server -- for Claude Desktop, Cursor, and other MCP clients

**Claude Code:**
```bash
claude mcp add barebrowse -- npx barebrowse mcp
```

**Claude Desktop / Cursor:**
```bash
npx barebrowse install
```

Or manually add to your config (`claude_desktop_config.json`, `.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "barebrowse": {
      "command": "npx",
      "args": ["barebrowse", "mcp"]
    }
  }
}
```

**VS Code (`.vscode/mcp.json`):**
```json
{
  "servers": {
    "barebrowse": {
      "command": "npx",
      "args": ["barebrowse", "mcp"]
    }
  }
}
```

MCP tools: `browse`, `goto`, `snapshot`, `readable`, `click`, `type`, `press`, `scroll`, `hover`, `select`, `back`, `forward`, `reload`, `drag`, `upload`, `pdf`, `screenshot`, `wait_for`, `tabs`. Plus `assess` (privacy scan) if [wearehere](https://github.com/hamr0/wearehere) is installed. Plus opt-in `eval` (`BAREBROWSE_MCP_EVAL=1`) — runs JS in the authenticated session, off by default because it can read cookies/localStorage. Session runs in hybrid mode with automatic cookie injection. Per-tool timeouts (goto/reload/wait_for 60s, back/forward 30s, interactive ops 15s, pdf/screenshot/upload 45s) with auto-retry on transient failures (idempotent only — mutating tools fail loudly to avoid double-submits).

`browse` and `snapshot` accept `pruneMode: 'act'|'read'`. `act` (default) keeps interactive elements — best for clicking/filling. `read` keeps paragraphs, headings, and long text — best for articles, docs, and content extraction. If act-mode collapses a content-heavy page near-totally, the snapshot includes a `hint: …` line suggesting `pruneMode='read'` so the agent doesn't bail to a separate HTTP fetch.

Troubleshooting MCP setup: `npx barebrowse doctor` scans every known config location and flags scope conflicts. `npx barebrowse install --force` overwrites an existing entry pointing at a different endpoint.

### 3. Library -- for agentic automation

Import barebrowse in your agent code. One-shot reads, interactive sessions, full observe-think-act loops. Works with any LLM orchestration library. Ships with a ready-made adapter for [bareagent](https://www.npmjs.com/package/bare-agent) (auto-snapshot after every action).

For code examples, API reference, and wiring instructions, see **[barebrowse.context.md](barebrowse.context.md)** -- the full integration guide.

## Three modes

| Mode | What happens | Best for |
|------|-------------|----------|
| **Headless** (default) | Launches a fresh browser, no UI | Fast automation, scraping, reading pages |
| **Headed** | Auto-launches a visible browser window | Bot-detected sites, visual debugging, CAPTCHAs |
| **Hybrid** | Tries headless first, auto-launches headed if blocked | General-purpose agent browsing |

All three work on both engines (Chromium/CDP and Firefox/BiDi).

### Attach to your already-running browser

Start Chromium yourself with a debug port, then drive your real logged-in session:

```bash
chromium --remote-debugging-port=9222
```

```js
import { connect } from 'barebrowse';
const page = await connect({ port: 9222 });
await page.goto('https://your-logged-in-app.example.com');
const snap = await page.snapshot();
await page.close(); // closes only the tab barebrowse opened — your browser keeps running
```

### Firefox (WebDriver BiDi)

CDP is deprecated in Firefox, so barebrowse drives it over the W3C WebDriver
BiDi protocol — a second transport over the same `ws` dependency, no extra
download. Same `page.*` API (the ARIA snapshot is reconstructed in-page since
BiDi has no `getFullAXTree`):

```js
const page = await connect({ engine: 'firefox' });
```

CLI: `barebrowse open <url> --engine firefox`. MCP: `BAREBROWSE_ENGINE=firefox`.
Firefox cookies (plaintext) reuse into the same engine.

Firefox is at practical parity with Chromium: stealth, consent auto-dismiss,
ad/tracker blocking, JS dialogs, console/network capture, hybrid fallback,
`saveState`, `waitForNavigation`, and download tracking all work the same way.
Chromium (CDP) stays the default; the only remaining gap is
`reload({ignoreCache})` (upstream BiDi limitation).

### Incognito (clean session)

Pass `incognito: true` for a clean, **unauthenticated** session — barebrowse
skips *all* auth injection (cookies + storage state), so the agent browses
logged out. It is not Chrome's `--incognito` flag: the session already runs in
a throwaway profile, so this gates the *other* auth source — your real browser
cookies. Works on both engines:

```js
const page = await connect({ incognito: true });
```

From the CLI: `barebrowse open <url> --incognito`. From MCP: set
`BAREBROWSE_INCOGNITO=1`.

## What it handles automatically

Cookie consent walls (29 languages, with real mouse click fallback for stubborn CMPs), login walls (cookie extraction from your browsers), bot detection (challenge-phrase + node-count heuristic + stealth patches + automatic headed fallback — snapshot shows `[BOT CHALLENGE DETECTED]` warning when blocked), permission prompts, SPA navigation, JS dialogs, off-screen elements, pre-filled inputs, ARIA noise, and profile locking. The agent doesn't think about any of it.

## Safe by default

barebrowse hands an autonomous — and therefore prompt-injectable — agent an *authenticated* browser, so the defaults are calibrated for that threat:

- **Local-resource schemes blocked.** `file:`, `view-source:`, `chrome:`, etc. are rejected by default (a confirmed local-file-read vector); `http`/`https`/`data` stay allowed. Override with `allowLocalUrls: true`.
- **Cookie injection scoped** to a precise RFC-6265 domain match — browsing one site can't pull look-alike or unrelated cookies into the session.
- **CLI daemon authenticated** with a per-session token (loopback alone isn't an authorization boundary); snapshots and saved state are written owner-only (`0600`).
- **Opt-in hardening** for stricter deployments: `blockPrivateNetwork` (SSRF guard for loopback/RFC-1918/cloud-metadata) and `uploadDir` (confine `upload()` to one directory). Both available on the library, MCP, bareagent, and CLI (`--block-private-network`, `--upload-dir`).

See `barebrowse.context.md` and the PRD's "Security Model & Safe Defaults" for the full rationale.

## What the agent sees

Raw ARIA output from a page is noisy -- decorative wrappers, hidden elements, structural junk. The pruning pipeline (ported from [mcprune](https://github.com/hamr0/mcprune)) strips it down to what matters.

| Page | Raw | Pruned | Reduction |
|------|-----|--------|-----------|
| example.com | 377 chars | 45 chars | 88% |
| Hacker News | 51,726 chars | 27,197 chars | 47% |
| Wikipedia (article) | 109,479 chars | 40,566 chars | 63% |
| DuckDuckGo | 42,254 chars | 5,407 chars | 87% |

Two pruning modes: **act** (default) keeps interactive elements and visible labels -- for clicking, typing, navigating. **read** keeps all text content -- for reading articles and extracting information.

## Actions

Everything the agent can do through barebrowse:

| Action | What it does |
|--------|-------------|
| **Navigate** | Load a URL, wait for page load, auto-dismiss consent |
| **Back / Forward** | Browser history navigation |
| **Snapshot** | Pruned ARIA tree with `[ref=N]` markers. Two modes: `act` (buttons, links, inputs) and `read` (full text). 40-90% token reduction. |
| **Readable** | Clean article text (title + body, chrome stripped — Reader-View engine). For *reading* article-like pages, not interacting. Advisory `confidence`; falls back to snapshot on non-articles. |
| **Click** | Scroll into view + mouse click at element center, JS fallback for hidden elements |
| **Type** | Focus + insert text, with option to clear existing content first |
| **Press** | Special keys: Enter, Tab, Escape, Backspace, Delete, arrows, Space |
| **Scroll** | Mouse wheel up or down (accepts direction or pixels) |
| **Hover** | Move mouse to element center (triggers tooltips, hover states) |
| **Select** | Set dropdown value (native select or custom dropdown) |
| **Drag** | Drag one element to another (Kanban boards, sliders) |
| **Upload** | Set files on a file input element |
| **Screenshot** | Page capture as base64 PNG/JPEG/WebP |
| **PDF** | Export page as PDF |
| **Assess** | Privacy scan: score (0-100), risk level, 10-category breakdown. Tries headless first, falls back to headed if bot-blocked. Consent auto-dismissed before scan. Max 3 concurrent, 30s timeout, tabs cleaned up. Requires `npm install wearehere`. |
| **Tabs** | List open tabs, switch between them |
| **Wait for content** | Poll for text or CSS selector to appear on page |
| **Wait for navigation** | SPA-aware: works for full page loads and pushState |
| **Wait for network idle** | Resolve when no pending requests for 500ms |
| **Dialog handling** | Auto-dismiss JS alert/confirm/prompt dialogs |
| **Save state** | Export cookies + localStorage to JSON |
| **Inject cookies** | Extract from Firefox/Chromium and inject into the session (CDP or BiDi) |
| **Raw CDP / BiDi** | Escape hatch: `page.cdp` (Chromium) or `page.bidi` (Firefox) for any low-level command |

## Tested against

16+ sites across 8 countries, all consent dialogs dismissed, all interactions working:

Google, YouTube, BBC, Wikipedia, GitHub, DuckDuckGo, Hacker News, Amazon DE, The Guardian, Spiegel, Le Monde, El Pais, Corriere, NOS, Bild, Nu.nl, Booking, NYT, Stack Overflow, CNN, Reddit

## How it works

```
URL -> find/launch browser (chromium.js)
    -> WebSocket CDP connection (cdp.js)
    -> stealth patches before page scripts (stealth.js, headless only)
    -> suppress all permission prompts (Browser.setPermission)
    -> extract + inject cookies from your browser (auth.js)
    -> navigate to URL, wait for load
    -> detect + dismiss cookie consent dialogs (consent.js)
    -> get full ARIA accessibility tree (aria.js)
    -> pruning pipeline from mcprune (prune.js)
    -> dispatch real input events: click/type/scroll (interact.js)
    -> agent-ready snapshot with [ref=N] markers
```

Firefox follows the same flow over WebDriver BiDi (`bidi.js`), with the AX tree
reconstructed in-page (`ax-snapshot.js`) and pruning/formatting shared verbatim.

A small set of focused modules, two small dependencies (`ws`, `@mozilla/readability`).

## Requirements

- Node.js >= 22 (built-in WebSocket, built-in SQLite)
- Any Chromium-based browser installed (Chrome, Chromium, Brave, Edge, Vivaldi) — or Firefox (>= 121) for the `engine: 'firefox'` BiDi path
- Linux tested (Fedora/KDE). macOS/Windows cookie paths exist but untested.

## The bare ecosystem

Local-first, composable agent infrastructure. Same API patterns throughout —
mix and match, each module works standalone.

**Core** — the brain, the gate, the memory.

- **[bareagent](https://npmjs.com/package/bare-agent)** — the think→act→observe loop. *Goal in → coordinated actions out.* Replaces LangChain, CrewAI, AutoGen.
- **[bareguard](https://npmjs.com/package/bareguard)** — the single gate every action passes through. *Action in → allow / deny / ask-a-human out.* Replaces hand-rolled allowlists and scattered policy code.
- **[litectx](https://npmjs.com/package/litectx)** — tree-sitter code + memory graph with activation decay, plus lightweight context engineering (write · select · compress · isolate). *Query in → ranked context out.*

**Optional reach** — give the agent hands.

- **[barebrowse](https://npmjs.com/package/barebrowse)** — a real browser for agents. *URL in → pruned snapshot out.* Replaces Playwright, Selenium, Puppeteer.
- **[baremobile](https://npmjs.com/package/baremobile)** — Android + iOS device control. *Screen in → pruned snapshot out.* Replaces Appium, Espresso, XCUITest.
- **[beeperbox](https://github.com/hamr0/beeperbox)** — 50+ messaging networks via one MCP server (headless Beeper Desktop in Docker). *Chat in → unified message stream out.* Replaces Twilio, per-platform bot APIs.

**What you can build:**

- **Headless automation** — scrape sites, fill forms, extract data, monitor pages on a schedule
- **QA & testing** — automated test suites for web and Android apps without heavyweight frameworks
- **Personal AI assistants** — chatbots that browse the web or control your phone on your behalf
- **Remote device control** — manage Android devices over WiFi, including on-device via Termux
- **Agentic workflows** — multi-step tasks where an AI plans, browses, and acts across web and mobile

**Why this exists:** Most automation stacks ship 200MB of opinions before you write a line of code. These don't. Install, import, go.

## License

Apache-2.0 — see [LICENSE](LICENSE).
