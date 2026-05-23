---
name: barebrowse
description: Browser automation using the user's real browser with real cookies. Handles consent walls, login sessions, and bot detection automatically.
allowed-tools: Bash(barebrowse:*)
---

# barebrowse CLI — Browser Automation for Agents

Browse any URL using the user's real browser with real cookies. Returns pruned ARIA snapshots (40-90% smaller than raw) with `[ref=N]` markers for interaction. Handles cookie consent, login sessions, JS dialogs, and bot detection automatically.

## Quick Start

```bash
barebrowse open https://example.com    # Start session + navigate
barebrowse snapshot                    # Get ARIA snapshot → .barebrowse/page-*.yml
barebrowse click 8                     # Click element with ref=8
barebrowse snapshot                    # See result
barebrowse close                       # End session
```

All output files go to `.barebrowse/` in the current directory. Read them with the Read tool when needed.

## Commands

### Session Lifecycle

| Command | Description |
|---------|-------------|
| `barebrowse open [url] [flags]` | Start browser session. Optionally navigate to URL. |
| `barebrowse close` | Close session and kill browser. |
| `barebrowse status` | Check if session is running. |

**Open flags:**
- `--mode=headless|headed|hybrid` — Browser mode (default: headless)
- `--no-cookies` — Skip cookie injection
- `--browser=firefox|chromium` — Cookie source
- `--prune-mode=act|read` — Default pruning mode
- `--timeout=N` — Navigation timeout in ms
- `--proxy=URL` — HTTP/SOCKS proxy server
- `--viewport=WxH` — Viewport size (e.g. 1280x720)
- `--storage-state=FILE` — Load cookies/localStorage from JSON file
- `--block-private-network` — SSRF guard: refuse loopback / RFC-1918 / link-local / cloud-metadata hosts (v0.11.0)
- `--upload-dir=DIR` — Sandbox uploads to DIR; reject files outside it (v0.11.0)

> Security (v0.11.0): `file:`/`chrome:`/etc. navigation is blocked by default, and the daemon requires a per-session token (handled transparently by the CLI). Snapshots and saved state are written owner-only (`0600`).

### Navigation

| Command | Output |
|---------|--------|
| `barebrowse goto <url>` | Navigates, waits for load, dismisses consent. Prints "ok". |
| `barebrowse back` | Go back in browser history. |
| `barebrowse forward` | Go forward in browser history. |
| `barebrowse snapshot` | ARIA snapshot → `.barebrowse/page-<timestamp>.yml` |
| `barebrowse snapshot --mode=read` | Read mode: keeps all text (for content extraction) |
| `barebrowse screenshot` | Screenshot → `.barebrowse/screenshot-<timestamp>.png` |
| `barebrowse pdf [--landscape]` | PDF export → `.barebrowse/page-<timestamp>.pdf` |

### Interaction

| Command | Description |
|---------|-------------|
| `barebrowse click <ref>` | Click element (scrolls into view first) |
| `barebrowse type <ref> <text>` | Type text into element |
| `barebrowse fill <ref> <text>` | Clear existing content + type new text |
| `barebrowse press <key>` | Press key: Enter, Tab, Escape, Backspace, Delete, arrows, Space |
| `barebrowse scroll <deltaY>` | Scroll page (positive=down, negative=up) |
| `barebrowse hover <ref>` | Hover over element (triggers tooltips) |
| `barebrowse select <ref> <value>` | Select dropdown option |
| `barebrowse drag <fromRef> <toRef>` | Drag element to another element |
| `barebrowse upload <ref> <files..>` | Upload file(s) to a file input element |

### Tabs

| Command | Description |
|---------|-------------|
| `barebrowse tabs` | List open tabs (index, url, title) |
| `barebrowse tab <index>` | Switch to tab by index |

### Debugging

| Command | Output |
|---------|--------|
| `barebrowse eval <expression>` | Evaluate JS in page, print result |
| `barebrowse wait-idle` | Wait for network idle (no requests for 500ms) |
| `barebrowse wait-for [opts]` | Wait for content to appear on page |
| `barebrowse console-logs` | Console logs → `.barebrowse/console-<timestamp>.json` |
| `barebrowse network-log` | Network log → `.barebrowse/network-<timestamp>.json` |
| `barebrowse network-log --failed` | Only failed/4xx/5xx requests |
| `barebrowse dialog-log` | JS dialog log → `.barebrowse/dialogs-<timestamp>.json` |
| `barebrowse save-state` | Cookies + localStorage → `.barebrowse/state-<timestamp>.json` |

**wait-for flags:**
- `--text=STRING` — Wait for text to appear in page body
- `--selector=CSS` — Wait for CSS selector to match
- `--timeout=N` — Max wait time in ms (default: 30000)

## Snapshot Format

The snapshot is a YAML-like ARIA tree. Each line is one node:

```
# https://example.com/
# 379 chars → 45 chars (88% pruned)
- heading "Example Domain" [level=1] [ref=3]
```

- `[ref=N]` — Use this number with click, type, fill, hover, select, drag, upload
- Refs change on every snapshot — always take a fresh snapshot before interacting
- **act mode** (default): interactive elements + labels — for clicking, typing, navigating
- **read mode**: all text content — for reading articles, extracting data

## Workflow Pattern

1. `barebrowse open <url>` — start session
2. `barebrowse snapshot` — observe page (read the .yml file)
3. Decide action based on snapshot content
4. `barebrowse click/type/fill/press/scroll/drag/upload <ref>` — act
5. `barebrowse snapshot` — observe result (refs are now different!)
6. Repeat 3-5 until goal achieved
7. `barebrowse close` — clean up

## Tips

- **Always snapshot before interacting** — refs are ephemeral and change every time
- **Use `fill` instead of `type`** when replacing existing text in input fields
- **Use `--mode=read`** for snapshot when you need to extract article content or data
- **Use `back`/`forward`** to navigate browser history instead of re-entering URLs
- **Use `upload`** for file inputs — pass absolute paths to the files
- **Use `wait-for`** when content loads asynchronously — more reliable than `wait-idle`
- **Check `dialog-log`** if JS alerts/confirms were auto-dismissed during your session
- **Use `save-state`** to persist cookies/localStorage for later sessions via `--storage-state`
- **Check `console-logs`** when page behavior seems wrong — JS errors show up there
- **Check `network-log --failed`** to debug missing content or broken API calls
- **Use `eval`** as an escape hatch when ARIA tree doesn't show what you need
- **One session per project** — `.barebrowse/` is project-scoped
- For bot-detected sites, use `--mode=headed` (requires browser with `--remote-debugging-port=9222`)
