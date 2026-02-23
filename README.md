```
  ~~~~~~~~~~~~~~~~~~~~
  ~~~ .---------. ~~~
  ~~~ | · clear | ~~~
  ~~~ | · focus | ~~~
  ~~~ '---------' ~~~
  ~~~~~~~~~~~~~~~~~~~~

  barebrowse
```

> Your agent browses like you do -- same browser, same logins, same cookies.
> Prunes pages down to what matters. 40-90% fewer tokens, zero wasted context.

---

## What this is

barebrowse is agentic browsing stripped to the bone. It gives your AI agent eyes and hands on the web -- navigate any page, see what's there, click buttons, fill forms, scroll, and move on. It uses your installed Chromium browser (Chrome, Brave, Edge -- whatever you have), reuses your existing login sessions, and handles all the friction automatically: cookie consent walls, permission prompts, bot detection, GDPR dialogs.

Instead of dumping raw DOM or taking screenshots, barebrowse returns a **pruned ARIA snapshot** -- a compact semantic view of what's on the page and what the agent can interact with. Buttons, links, inputs, headings -- labeled with `[ref=N]` markers the agent uses to act. The pruning pipeline is ported from [mcprune](https://github.com/hamr0/mcprune) and cuts 40-90% of tokens compared to raw page output. Every token your agent reads is meaningful.

No Playwright. No bundled browser. No 200MB download. No broken dependencies. Zero deps. Just CDP over a WebSocket to whatever Chromium you already have.

## Install

```
npm install barebrowse
```

Requires Node.js >= 22 and any installed Chromium-based browser.

## Three ways to use it

### 1. CLI session -- for coding agents and quick testing

```bash
barebrowse open https://example.com    # Start session + navigate
barebrowse snapshot                    # ARIA snapshot → .barebrowse/page-*.yml
barebrowse click 8                     # Click element
barebrowse close                       # End session
```

Outputs go to `.barebrowse/` as files -- agents read them with their file tools, no token waste in tool responses.

**Teach your agent the commands** by installing the skill file (a markdown reference the agent reads as context). The CLI tool itself still needs `npm install barebrowse` -- the skill just teaches the agent how to use it.

**Claude Code:** `.claude/skills/barebrowse/` (project) or `~/.claude/skills/barebrowse/` (global, via `barebrowse install --skill`).

**Other agents:** `.barebrowse/commands/` (project) or `~/.config/barebrowse/commands/` (global). Copy [SKILL.md](.claude/skills/barebrowse/SKILL.md) there.

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

7 tools: `browse`, `goto`, `snapshot`, `click`, `type`, `press`, `scroll`.

### 3. Library -- for agentic automation

Import barebrowse in your agent code. One-shot reads, interactive sessions, full observe-think-act loops. Works with any LLM orchestration library. Ships with a ready-made adapter for [bareagent](https://www.npmjs.com/package/bare-agent) (9 tools, auto-snapshot after every action).

For code examples, API reference, and wiring instructions, see **[barebrowse.context.md](barebrowse.context.md)** -- the full integration guide.

## Three modes

| Mode | What happens | Best for |
|------|-------------|----------|
| **Headless** (default) | Launches a fresh Chromium, no UI | Fast automation, scraping, reading pages |
| **Headed** | Connects to your running browser on CDP port | Bot-detected sites, visual debugging, CAPTCHAs |
| **Hybrid** | Tries headless first, falls back to headed if blocked | General-purpose agent browsing |

## What it handles automatically

This is the obstacle course your agent doesn't have to think about:

| Obstacle | How it's handled | Mode |
|----------|-----------------|------|
| **Cookie consent walls** (GDPR) | ARIA tree scan + jsClick accept button, 7 languages (EN, NL, DE, FR, ES, IT, PT) | Both |
| **Consent in dialog role** | Detect `dialog`/`alertdialog` with consent hints, click accept inside | Both |
| **Consent outside dialog** (BBC SourcePoint) | Fallback global button scan when dialog has no accept button | Both |
| **Consent behind iframe overlay** | JS click via DOM.resolveNode bypasses z-index/overlay issues | Both |
| **Permission prompts** (location, camera, mic) | Launch flags + CDP Browser.setPermission auto-deny | Both |
| **Media autoplay blocked** | Autoplay policy flag on launch | Both |
| **Login walls** | Cookie extraction from Firefox/Chromium, injected via CDP | Both |
| **Pre-filled form inputs** | Select-all + delete before typing | Both |
| **Off-screen elements** | Scrolled into view before every click | Both |
| **Form submission** | Enter key triggers onsubmit | Both |
| **Tab between fields** | Tab key moves focus correctly | Both |
| **SPA navigation** (YouTube, GitHub) | SPA-aware wait: frameNavigated + loadEventFired | Both |
| **Bot detection** (Google, Reddit) | Stealth patches (headless) + headed fallback with real cookies | Both |
| **navigator.webdriver leak** | Patched before page scripts run: webdriver, plugins, languages, chrome object | Headless |
| **JS dialogs** (alert/confirm/prompt) | Auto-dismiss via CDP, logged for inspection | Both |
| **Profile locking** | Unique temp dir per headless instance | Headless |
| **ARIA noise** | 9-step pruning pipeline (ported from mcprune): wrapper collapse, noise removal, landmark promotion | Both |

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
| **Click** | Scroll into view + mouse click at element center |
| **Type** | Focus + insert text, with option to clear existing content first |
| **Press** | Special keys: Enter, Tab, Escape, Backspace, Delete, arrows, Space |
| **Scroll** | Mouse wheel up or down |
| **Hover** | Move mouse to element center (triggers tooltips, hover states) |
| **Select** | Set dropdown value (native select or custom dropdown) |
| **Drag** | Drag one element to another (Kanban boards, sliders) |
| **Upload** | Set files on a file input element |
| **Screenshot** | Page capture as base64 PNG/JPEG/WebP |
| **PDF** | Export page as PDF |
| **Tabs** | List open tabs, switch between them |
| **Wait for content** | Poll for text or CSS selector to appear on page |
| **Wait for navigation** | SPA-aware: works for full page loads and pushState |
| **Wait for network idle** | Resolve when no pending requests for 500ms |
| **Dialog handling** | Auto-dismiss JS alert/confirm/prompt dialogs |
| **Save state** | Export cookies + localStorage to JSON |
| **Inject cookies** | Extract from Firefox/Chromium and inject via CDP |
| **Raw CDP** | Escape hatch for any Chrome DevTools Protocol command |

## Tested against

16+ sites across 8 countries, all consent dialogs dismissed, all interactions working:

Google, YouTube, BBC, Wikipedia, GitHub, DuckDuckGo, Hacker News, Amazon DE, The Guardian, Spiegel, Le Monde, El Pais, Corriere, NOS, Bild, Nu.nl, Booking, NYT, Stack Overflow, CNN, Reddit

## Context file

**[barebrowse.context.md](barebrowse.context.md)** is the full integration guide. Feed it to an AI assistant or read it yourself -- it covers the complete API, snapshot format, interaction loop, auth options, bareagent wiring, MCP setup, and gotchas. Everything you need to wire barebrowse into a project.

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
    -> 9-step pruning pipeline from mcprune (prune.js)
    -> dispatch real input events: click/type/scroll (interact.js)
    -> agent-ready snapshot with [ref=N] markers
```

11 modules, 2,400 lines, zero dependencies.

## Requirements

- Node.js >= 22 (built-in WebSocket, built-in SQLite)
- Any Chromium-based browser installed (Chrome, Chromium, Brave, Edge, Vivaldi)
- Linux tested (Fedora/KDE). macOS/Windows cookie paths exist but untested.

## License

MIT
