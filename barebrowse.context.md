# barebrowse -- Integration Guide

> For AI assistants and developers wiring barebrowse into a project.
> v0.3.0 | Node.js >= 22 | 0 required deps | MIT

## What this is

barebrowse is a CDP-direct browsing library for autonomous agents (~1,800 lines). URL in, pruned ARIA snapshot out. It launches the user's installed Chromium browser, navigates, handles consent/permissions/cookies, and returns a token-efficient ARIA tree with `[ref=N]` markers for interaction.

No Playwright. No bundled browser. No build step. Vanilla JS, ES modules.

```
npm install barebrowse
```

Three integration paths:
1. **Library:** `import { browse, connect } from 'barebrowse'` -- one-shot or interactive session
2. **MCP server:** `barebrowse mcp` -- JSON-RPC over stdio for Claude Desktop, Cursor, etc.
3. **CLI session:** `barebrowse open` / `click` / `snapshot` / `close` -- shell commands, outputs to disk

## Which mode do I need?

| Mode | What it does | When to use |
|---|---|---|
| `headless` (default) | Launches a fresh Chromium, no UI | Scraping, reading, fast automation |
| `headed` | Connects to user's running browser on CDP port | Bot-detected sites, debugging, visual tasks |
| `hybrid` | Tries headless first, falls back to headed if blocked | General-purpose agent browsing |

Headed mode requires the browser to be launched with `--remote-debugging-port=9222`.

## Minimal usage: one-shot browse

```javascript
import { browse } from 'barebrowse';

// Defaults: headless, cookies injected, pruned, consent dismissed
const snapshot = await browse('https://example.com');

// All options
const snapshot = await browse('https://example.com', {
  mode: 'headless',      // 'headless' | 'headed' | 'hybrid'
  cookies: true,         // inject user's browser cookies
  browser: 'firefox',    // cookie source: 'firefox' | 'chromium' (auto-detected)
  prune: true,           // apply ARIA pruning (47-95% token reduction)
  pruneMode: 'act',      // 'act' (interactive elements) | 'read' (all content)
  consent: true,         // auto-dismiss cookie consent dialogs
  timeout: 30000,        // navigation timeout in ms
  port: 9222,            // CDP port for headed/hybrid mode
});
```

## connect() API

`connect(opts)` returns a page handle for interactive sessions. Same opts as `browse()` for mode/port.

| Method | Args | Returns | Notes |
|---|---|---|---|
| `goto(url, timeout?)` | url: string, timeout: number (default 30000) | void | Navigate + wait for load + dismiss consent |
| `snapshot(pruneOpts?)` | false or { mode: 'act'\|'read' } | string | ARIA tree with `[ref=N]` markers. Pass `false` for raw. |
| `click(ref)` | ref: string | void | Scroll into view + mouse press+release at center |
| `type(ref, text, opts?)` | ref: string, text: string, opts: { clear?, keyEvents? } | void | Focus + insert text. `clear: true` replaces existing. |
| `press(key)` | key: string | void | Special key: Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space |
| `scroll(deltaY)` | deltaY: number | void | Mouse wheel. Positive = down, negative = up. |
| `hover(ref)` | ref: string | void | Move mouse to element center |
| `select(ref, value)` | ref: string, value: string | void | Set `<select>` value or click custom dropdown option |
| `screenshot(opts?)` | { format?: 'png'\|'jpeg'\|'webp', quality?: number } | string (base64) | Page screenshot |
| `waitForNavigation(timeout?)` | timeout: number (default 30000) | void | Wait for page load or frame navigation |
| `waitForNetworkIdle(opts?)` | { timeout?: number, idle?: number } | void | Wait until no pending requests for `idle` ms (default 500) |
| `injectCookies(url, opts?)` | url: string, { browser?: string } | void | Extract cookies from user's browser and inject via CDP |
| `cdp` | -- | object | Raw CDP session for escape hatch: `page.cdp.send(method, params)` |
| `close()` | -- | void | Close page, disconnect CDP, kill browser (if headless) |

## Snapshot format

The snapshot is a YAML-like ARIA tree. Each line is one node:

```
- WebArea "Example Domain" [ref=1]
  - heading "Example Domain" [level=1] [ref=3]
  - paragraph [ref=5]
    - StaticText "This domain is for use in illustrative examples." [ref=6]
  - link "More information..." [ref=8]
```

Key rules:
- `[ref=N]` markers appear on interactive and named elements
- Refs are **ephemeral** -- they change on every `snapshot()` call
- Always call `snapshot()` to get fresh refs before interacting
- `click(ref)` / `type(ref, text)` / `hover(ref)` / `select(ref, value)` use these ref strings
- Pruning removes noise (~47-95% token reduction) while keeping all interactive elements

## Interaction loop: observe, think, act

```javascript
import { connect } from 'barebrowse';

const page = await connect();
await page.goto('https://example.com');

// 1. Observe
let snap = await page.snapshot();

// 2. Think (LLM decides what to do based on snapshot)
// 3. Act
await page.click('8');         // click the "More information..." link
await page.waitForNavigation();

// 4. Observe again (refs are now different)
snap = await page.snapshot();

// ... repeat until goal is achieved

await page.close();
```

## Auth / cookie options

barebrowse can inject cookies from the user's real browser sessions, bypassing login walls.

| Source | How | Notes |
|---|---|---|
| Firefox (default) | SQLite `cookies.sqlite`, plaintext | Works on Linux. Auto-detected default profile. |
| Chromium | SQLite `Cookies` + AES decryption via keyring | Linux: KWallet or GNOME Keyring. Profile must not be locked. |
| Manual | `page.injectCookies(url, { browser: 'firefox' })` | Explicit injection on connect() sessions |
| Disabled | `{ cookies: false }` | No cookie injection |

`browse()` auto-injects cookies before navigation. `connect()` exposes `injectCookies()` for manual control.

## Obstacle course -- what barebrowse handles automatically

| Obstacle | How | Mode |
|---|---|---|
| Cookie consent (GDPR) | ARIA scan + jsClick accept button, 7 languages | Both |
| Consent behind iframes | JS `.click()` via DOM.resolveNode bypasses overlays | Both |
| Permission prompts | Launch flags + CDP Browser.setPermission auto-deny | Both |
| Media autoplay blocked | `--autoplay-policy=no-user-gesture-required` | Both |
| Login walls | Cookie extraction from Firefox/Chromium + CDP injection | Both |
| Pre-filled form inputs | `type({ clear: true })` selects all + deletes first | Both |
| Off-screen elements | `DOM.scrollIntoViewIfNeeded` before every click | Both |
| Form submission | `press('Enter')` triggers onsubmit | Both |
| SPA navigation | `waitForNavigation()` uses loadEventFired + frameNavigated | Both |
| Bot detection | Headed mode with real cookies bypasses most checks | Headed |
| `navigator.webdriver` | Stealth patches in headless (webdriver, plugins, chrome obj) | Headless |
| Profile locking | Unique temp dir per headless instance | Headless |
| ARIA noise | 9-step pruning: wrapper collapse, noise removal, landmark promotion | Both |

## bareagent wiring

barebrowse provides a tool adapter for bareagent's Loop:

```javascript
import { Loop } from 'bare-agent';
import { Anthropic } from 'bare-agent/providers';
import { createBrowseTools } from 'barebrowse/src/bareagent.js';

const provider = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const loop = new Loop({ provider });

const { tools, close } = createBrowseTools();

try {
  const result = await loop.run(
    [{ role: 'user', content: 'Search for "barebrowse" on DuckDuckGo and tell me the first result' }],
    tools
  );
  console.log(result.text);
} finally {
  await close();
}
```

`createBrowseTools(opts)` returns:
- `tools` -- array of bareagent-compatible tool objects (browse, goto, snapshot, click, type, press, scroll, select, screenshot)
- `close()` -- cleanup function, call when done

Action tools (click, type, press, scroll, goto) auto-return a fresh snapshot so the LLM always sees the result. 300ms settle delay after actions for DOM updates.

## CLI session mode

For coding agents (Claude Code, Copilot, Cursor) and quick interactive testing. Commands output files to `.barebrowse/` -- agents read them with file tools, avoiding token waste in tool responses.

```bash
barebrowse open https://example.com    # Start daemon + navigate
barebrowse snapshot                    # → .barebrowse/page-<timestamp>.yml
barebrowse click 8                     # Click element ref=8
barebrowse type 12 hello world         # Type into element ref=12
barebrowse screenshot                  # → .barebrowse/screenshot-<timestamp>.png
barebrowse console-logs                # → .barebrowse/console-<timestamp>.json
barebrowse close                       # Kill daemon + browser
```

Session lifecycle: `open` spawns a background daemon holding a `connect()` session. Subsequent commands POST to the daemon over HTTP (localhost). `close` shuts everything down.

Full command reference: `.claude/skills/barebrowse/SKILL.md`

## MCP wrapper

barebrowse ships an MCP server for direct use with Claude Desktop, Cursor, or any MCP client.

**Claude Code:** `claude mcp add barebrowse -- npx barebrowse mcp`

**Claude Desktop / Cursor:** `npx barebrowse install` (auto-detects and writes config)

**Manual config** (`claude_desktop_config.json`, `.cursor/mcp.json`):
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

7 tools exposed: `browse` (one-shot), `goto`, `snapshot`, `click`, `type`, `press`, `scroll`.

Action tools return `'ok'` -- the agent calls `snapshot` explicitly to observe. This avoids double-token output since MCP tool calls are cheap to chain.

Session tools (goto, snapshot, click, type, press, scroll) share a singleton page, lazy-created on first use.

## Architecture

```
URL -> chromium.js (find/launch browser, permission flags)
    -> cdp.js (WebSocket CDP client)
    -> stealth.js (navigator.webdriver patches, headless only)
    -> Browser.setPermission (suppress prompts)
    -> auth.js (extract cookies -> inject via CDP)
    -> Page.navigate
    -> consent.js (detect + dismiss cookie dialogs)
    -> aria.js (Accessibility.getFullAXTree -> nested tree)
    -> prune.js (9-step role-based pruning)
    -> interact.js (click/type/scroll/hover/select via Input domain)
    -> agent-ready snapshot
```

| Module | Lines | Purpose |
|---|---|---|
| `src/index.js` | ~370 | Public API: `browse()`, `connect()`, screenshot, network idle, hybrid |
| `src/cdp.js` | 148 | WebSocket CDP client, flattened sessions |
| `src/chromium.js` | 148 | Find/launch Chromium browsers, permission-suppressing flags |
| `src/aria.js` | 69 | Format ARIA tree as text |
| `src/auth.js` | 279 | Cookie extraction (Chromium AES + keyring, Firefox), CDP injection |
| `src/prune.js` | 472 | ARIA pruning pipeline (ported from mcprune) |
| `src/interact.js` | ~170 | Click, type, press, scroll, hover, select |
| `src/consent.js` | 200 | Auto-dismiss cookie consent dialogs across languages |
| `src/stealth.js` | ~40 | Navigator patches for headless anti-detection |
| `src/bareagent.js` | ~120 | Tool adapter for bareagent Loop |
| `mcp-server.js` | ~170 | MCP server (JSON-RPC over stdio) |

## Gotchas

1. **Refs are ephemeral.** Every `snapshot()` call generates new refs. Always snapshot before interacting. Never cache refs across snapshots.

2. **SPA navigation has no loadEventFired.** For single-page apps (React, YouTube, GitHub), use `waitForNetworkIdle()` or a timed wait after click instead of `waitForNavigation()`.

3. **Pruning modes matter.** `act` mode (default) keeps interactive elements + visible labels. `read` mode keeps all text content. Use `read` for content extraction, `act` for form filling and navigation.

4. **Headed mode requires manual browser launch.** Start your browser with `--remote-debugging-port=9222`. barebrowse connects to it -- it does not launch it.

5. **Cookie extraction needs unlocked profile.** Chromium cookies are AES-encrypted with a keyring key. If Chromium is running, the profile may be locked. Firefox cookies are plaintext and always accessible.

6. **Hybrid mode kills and relaunches.** If headless is bot-blocked, hybrid mode kills the headless browser and connects to headed on port 9222. The headed browser must already be running.

7. **One page per connect().** Each `connect()` call creates one page. For multiple tabs, call `connect()` multiple times.

8. **Consent dismiss is best-effort.** It handles 16+ tested sites across 7 languages but novel consent implementations may need manual handling. Disable with `{ consent: false }`.

9. **Screenshot returns base64.** Write to file with `fs.writeFileSync('shot.png', Buffer.from(base64, 'base64'))` or pass directly to a vision model.

10. **Chromium-only.** CDP protocol limits us to Chrome, Chromium, Edge, Brave, Vivaldi (~80% desktop share). Firefox support via WebDriver BiDi is not yet implemented.

## Constraints

- **Node >= 22** -- built-in WebSocket, built-in SQLite
- **Chromium-only** -- CDP protocol
- **Linux first** -- tested on Fedora/KDE, macOS/Windows cookie paths exist but untested
- **Not a server** -- library that agents import. Wrap as MCP (included) or HTTP if needed.
- **Zero required deps** -- everything uses Node stdlib
