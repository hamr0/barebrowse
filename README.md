# barebrowse

**URL in, agent-ready snapshot out.** Zero dependencies. Uses your own browser.

barebrowse gives autonomous agents eyes and hands on the web. It launches your installed Chromium, navigates to any page, and returns a pruned ARIA snapshot — a compact, semantic representation of what's on screen. The agent reads the snapshot, picks an element by ref, acts, and reads the next snapshot. Observe, think, act.

No Playwright. No bundled browser. No 200MB download. Just CDP over a WebSocket to whatever Chromium you already have.

## The idea

LLMs don't need DOM. They need to know what's on the page and what they can interact with. That's exactly what the browser's accessibility tree provides — every heading, button, link, input, and landmark, structured semantically.

But raw ARIA trees are noisy. A typical page produces 50-100KB of ARIA data. Most of it is decorative wrappers, hidden elements, and structural noise. barebrowse includes a 9-step pruning pipeline (ported from [mcprune](https://github.com/nickvdyck/mcprune)) that strips 47-95% of tokens while keeping every interactive element and meaningful label. A page that costs $0.15 in tokens raw costs $0.02-0.08 pruned.

The snapshot format uses `[ref=N]` markers on interactive elements. The agent says "click ref 8" and barebrowse scrolls the element into view, calculates coordinates, and dispatches real mouse events. No CSS selectors. No XPath. Just semantic refs from the ARIA tree.

## Install

```
npm install barebrowse
```

Requires Node.js >= 22 and any installed Chromium-based browser (Chrome, Chromium, Brave, Edge, Vivaldi).

## Quick start

```javascript
import { browse } from 'barebrowse';

// One line. That's it.
const snapshot = await browse('https://news.ycombinator.com');
console.log(snapshot);
```

Output (pruned, ~50% smaller than raw):
```
- WebArea "Hacker News" [ref=1]
  - link "Hacker News" [ref=4]
  - link "new" [ref=7]
  - link "past" [ref=9]
  - link "comments" [ref=11]
  ...
  - link "Show HN: I built a thing" [ref=42]
  - link "197 comments" [ref=45]
```

## Two ways to use it

### 1. As a library (framework mode)

Import and call directly. You control the loop.

**One-shot** — read a page and get the snapshot:

```javascript
import { browse } from 'barebrowse';

const snapshot = await browse('https://example.com', {
  mode: 'headless',      // 'headless' | 'headed' | 'hybrid'
  cookies: true,         // inject cookies from your browser
  prune: true,           // ARIA pruning (47-95% token reduction)
  consent: true,         // auto-dismiss cookie consent dialogs
});
```

**Session** — navigate and interact across multiple pages:

```javascript
import { connect } from 'barebrowse';

const page = await connect();
await page.goto('https://duckduckgo.com');

let snap = await page.snapshot();
// Agent sees: combobox "Search" [ref=5]

await page.type('5', 'barebrowse github');
await page.press('Enter');
await page.waitForNavigation();

snap = await page.snapshot();
// Agent sees search results with clickable refs

await page.click('12');  // click first result
await page.close();
```

### 2. As an MCP server

For Claude Desktop, Cursor, Windsurf, or any MCP client.

```bash
npx barebrowse mcp
```

Or add to your MCP config (`.mcp.json`, `claude_desktop_config.json`, etc.):

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

This exposes 7 tools: `browse`, `goto`, `snapshot`, `click`, `type`, `press`, `scroll`. The LLM calls `goto` to navigate, `snapshot` to observe, and action tools to interact. Action tools return `'ok'` — the LLM calls `snapshot` explicitly to see what changed.

## Three modes

| Mode | Flag | What happens | Use for |
|------|------|-------------|---------|
| **Headless** | `mode: 'headless'` (default) | Launches a fresh Chromium, no UI | Scraping, reading, fast automation |
| **Headed** | `mode: 'headed'` | Connects to your running browser via CDP port | Bot-detected sites, visual debugging |
| **Hybrid** | `mode: 'hybrid'` | Tries headless first, falls back to headed if bot-blocked | General-purpose agent browsing |

Headed mode requires your browser running with `--remote-debugging-port=9222`.

## What it handles automatically

You don't need to write code for any of this:

- **Cookie consent dialogs** — ARIA scan + jsClick across 7 languages (EN, NL, DE, FR, ES, IT, PT). Tested on 16+ sites.
- **Permission prompts** — notifications, geolocation, camera, mic all auto-denied via CDP
- **Login walls** — cookies extracted from your Firefox or Chromium profile, injected via CDP
- **Off-screen elements** — scrolled into view before every click
- **Bot detection** — stealth patches in headless (navigator.webdriver, plugins, chrome object)
- **Profile locking** — unique temp dir per headless instance
- **ARIA noise** — 9-step pruning pipeline strips decorative wrappers, hidden nodes, structural noise

## connect() API reference

| Method | Description |
|--------|-------------|
| `goto(url)` | Navigate + wait for load + dismiss consent |
| `snapshot()` | Pruned ARIA tree with `[ref=N]` markers |
| `click(ref)` | Scroll into view + mouse click at element center |
| `type(ref, text, opts?)` | Focus + insert text. `{ clear: true }` replaces existing. |
| `press(key)` | Special key: Enter, Tab, Escape, Backspace, Delete, arrows, Space |
| `scroll(deltaY)` | Mouse wheel. Positive = down, negative = up. |
| `hover(ref)` | Move mouse to element center |
| `select(ref, value)` | Set `<select>` value or click custom dropdown option |
| `screenshot(opts?)` | Returns base64 PNG/JPEG/WebP |
| `waitForNavigation()` | Wait for page load (SPA-aware) |
| `waitForNetworkIdle()` | Wait until no pending requests for 500ms |
| `injectCookies(url)` | Extract + inject cookies from your browser |
| `cdp` | Raw CDP session escape hatch |
| `close()` | Clean up everything |

## bareagent integration

barebrowse ships a tool adapter for [bareagent](https://github.com/nickvdyck/bareagent):

```javascript
import { Loop } from 'bare-agent';
import { Anthropic } from 'bare-agent/providers';
import { createBrowseTools } from 'barebrowse/bareagent';

const provider = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const loop = new Loop({ provider });

const { tools, close } = createBrowseTools();
try {
  const result = await loop.run(
    [{ role: 'user', content: 'Find the top story on Hacker News' }],
    tools
  );
  console.log(result.text);
} finally {
  await close();
}
```

`createBrowseTools(opts)` returns 9 tools: browse, goto, snapshot, click, type, press, scroll, select, screenshot. Action tools auto-return a fresh snapshot after each action so the LLM always sees the result.

You can pass any `connect()` options to `createBrowseTools()` — mode, port, cookies, consent.

## How it works

```
URL -> chromium.js     find/launch browser, permission-suppressing flags
    -> cdp.js          WebSocket CDP client, flattened sessions
    -> stealth.js      navigator.webdriver patches (headless only)
    -> Browser.setPermission    suppress all prompts
    -> auth.js         extract cookies from Firefox/Chromium -> inject via CDP
    -> Page.navigate   go to URL, wait for load
    -> consent.js      detect + dismiss cookie consent dialogs
    -> aria.js         Accessibility.getFullAXTree -> nested tree
    -> prune.js        9-step pruning: wrappers, noise, landmarks
    -> interact.js     click/type/scroll/hover/select via CDP Input domain
    -> snapshot        agent-ready ARIA text with [ref=N] markers
```

11 modules, 2,400 lines, zero dependencies.

## Token savings

Real-world measurements on the pruning pipeline:

| Page | Raw ARIA | Pruned (act) | Reduction | Est. cost saved |
|------|----------|-------------|-----------|----------------|
| Hacker News | 52K chars | 27K chars | 47% | ~$0.04/call |
| Wikipedia article | 180K chars | 12K chars | 93% | ~$0.25/call |
| Amazon product | 95K chars | 8K chars | 92% | ~$0.13/call |
| Google results | 45K chars | 5K chars | 89% | ~$0.06/call |

Two pruning modes:
- **act** (default) — keeps interactive elements + visible labels. For clicking, typing, navigating.
- **read** — keeps all text content. For reading articles, extracting information.

## Context file

`barebrowse.context.md` in the repo root is an LLM-consumable integration guide. Feed it to an AI assistant that needs to wire barebrowse into a project — it covers the full API, snapshot format, interaction loop, auth options, and gotchas.

## Requirements

- Node.js >= 22 (built-in WebSocket, built-in SQLite)
- Any Chromium-based browser installed (Chrome, Chromium, Brave, Edge, Vivaldi)
- Linux tested (Fedora/KDE). macOS/Windows cookie paths exist but untested.

## License

MIT
