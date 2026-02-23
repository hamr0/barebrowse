# Validation Log

What's been tested against the real world. Updated when new sites or features are validated.

---

## Test suite (64 tests, 6 files)

| File | Tests | Type | What it covers |
|------|-------|------|----------------|
| `test/unit/prune.test.js` | 16 | Unit | 9-step pruning pipeline in isolation |
| `test/unit/auth.test.js` | 7 | Unit | Cookie extraction from Firefox/Chromium |
| `test/unit/cdp.test.js` | 5 | Unit | Browser discovery, launch, CDP client, sessions |
| `test/integration/browse.test.js` | 11 | Integration | Full `browse()` and `connect()` pipeline |
| `test/integration/cli.test.js` | 10 | Integration | CLI session lifecycle: open/snapshot/goto/click/eval/console/network/close |
| `test/integration/interact.test.js` | 15 | E2E | Real interactions on data: fixtures + live sites |

Run all: `node --test test/unit/*.test.js test/integration/*.test.js`

## Site validation matrix

Tested across 16+ sites, 8 countries, 7 languages.

| Site | Consent | Cookies | Interactions | Notes |
|------|---------|---------|-------------|-------|
| google.com | NL dialog dismissed | Firefox injection | Search (combobox + Enter) | Bot-blocks headless |
| youtube.com | Bypassed via cookies | Firefox injection | Search + video playback | Full e2e demo, SPA nav |
| bbc.com | SourcePoint dismissed | -- | -- | Button outside dialog |
| wikipedia.org | -- | -- | Link click + navigation | Clean, no consent |
| github.com | -- | -- | SPA navigation | Needs settle time |
| duckduckgo.com | -- | -- | Search + results | Headless-friendly |
| news.ycombinator.com | -- | -- | Story link click | Clean, simple DOM |
| amazon.de | Banner dismissed | -- | -- | |
| theguardian.com | CMP dismissed | -- | -- | |
| spiegel.de | CMP dismissed | -- | -- | German |
| lemonde.fr | CMP dismissed | -- | -- | French |
| elpais.com | CMP dismissed | -- | -- | Spanish |
| corriere.it | CMP dismissed | -- | -- | Italian |
| nos.nl | CMP dismissed | -- | -- | Dutch |
| bild.de | CMP dismissed | -- | -- | German |
| nu.nl | CMP dismissed | -- | -- | Dutch |
| booking.com | Banner dismissed | -- | -- | |
| nytimes.com | -- | -- | -- | No consent wall |
| stackoverflow.com | Footer link only | -- | -- | Not blocking |
| cnn.com | -- | -- | -- | No consent wall |
| reddit.com | -- | -- | Fallback to old.reddit | Bot-blocks headless |

## Token reduction measurements

| Page | Raw ARIA | Pruned | Reduction |
|------|----------|--------|-----------|
| example.com | 377 chars | 45 chars | 88% |
| Hacker News | 51,726 chars | 27,197 chars | 47% |
| Wikipedia (article) | 109,479 chars | 40,566 chars | 63% |
| DuckDuckGo | 42,254 chars | 5,407 chars | 87% |

---

## CLI manual validation (v0.3.0)

Full end-to-end validation of every CLI command against real websites.

### Session lifecycle

| Command | Result |
|---------|--------|
| `barebrowse open https://example.com` | Session started, pid+port printed, session.json created |
| `barebrowse status` | Shows running pid, port, start time |
| `barebrowse close` | "Session closed", session.json removed, daemon exited |
| `status` after close | "No session found", exit code 1 |
| `click 5` with no session | "No active session. Run `barebrowse open` first.", exit 1 |
| double `open` | "Session already running. Use `barebrowse close` first.", exit 1 |

### Navigation + snapshots (example.com, HN)

| Command | Result |
|---------|--------|
| `snapshot` (example.com) | `.barebrowse/page-*.yml` created, clean formatting |
| `snapshot --mode=read` | Read mode includes paragraphs, each node on own line |
| `goto https://news.ycombinator.com` | "ok" |
| `snapshot` (HN) | Clean ARIA tree with refs, proper newline separation |
| `screenshot` | Valid 780x493 PNG file |

### Interactions (DuckDuckGo search)

| Command | Result |
|---------|--------|
| `type 12 barebrowse npm` | "ok", multi-word text correctly joined |
| `press Enter` | "ok", search submitted |
| `wait-idle` | "ok", waited for network settle |
| `eval "document.title"` | `"barebrowse npm at DuckDuckGo"` |
| `snapshot` | Search results page, clean formatting with refs |
| `fill 2583 hello world` | "ok", cleared search box + typed new text |
| `hover 2402` | "ok" |
| `scroll 300` | "ok" |

### Debugging commands

| Command | Result |
|---------|--------|
| `eval "1 + 1"` | `2` |
| `eval "document.location.href"` | `"https://news.ycombinator.com/news"` |
| `eval "console.log('test'); console.error('err')"` | `ok` (undefined return) |
| `console-logs` | `.json (2 entries)` — log + error captured with types and timestamps |
| `network-log` | `.json (15 entries)` — all requests with URL, method, status |
| `network-log --failed` | `.json (1 entries)` — filtered to failed/4xx+ only |

### Legacy + install commands

| Command | Result |
|---------|--------|
| `browse https://example.com` | One-shot snapshot to stdout |
| `install` | "No MCP clients detected" + Claude Code hint |
| `install --skill` | SKILL.md copied to `~/.config/claude/skills/barebrowse/` |
| (no args) | Clean help output with all commands |

### Bug found and fixed during validation

**`src/aria.js` line 23**: ignored nodes joined children with `''` instead of `'\n'`, causing sibling subtrees to concatenate on one line (e.g. `[ref=15]- _promote`). Fixed to `.filter(Boolean).join('\n')`. All 64 tests pass with the fix.

---

## New features manual validation (v0.4.0)

All tested against live sites via CLI session from `/tmp`.

### Navigation: back/forward

| Command | Result |
|---------|--------|
| `open https://example.com` | Session started |
| `goto https://wikipedia.org` | "ok" |
| `back` | "ok" — returned to example.com |
| `forward` | "ok" — returned to wikipedia.org |

### File upload

| Command | Result |
|---------|--------|
| `goto 'data:text/html,<input type="file" id="f"><script>...</script>'` | "ok" |
| `snapshot` | `button "Choose File" [ref=7]` |
| `upload 7 /tmp/test-upload.txt` | "ok" |
| `eval 'document.title'` | `"uploaded"` — onchange fired, confirmed working |

### PDF export

| Command | Result |
|---------|--------|
| (on wikipedia.org) `pdf` | `.barebrowse/page-*.pdf` — 200,716 bytes |

### Tabs

| Command | Result |
|---------|--------|
| `tabs` | `[{"index":0,"url":"https://www.wikipedia.org/","title":"Wikipedia",...}, {"index":1,"url":"about:blank",...}]` |

### Wait-for

| Command | Result |
|---------|--------|
| `wait-for --text=Wikipedia` | "ok" — found text immediately |
| `wait-for --selector=body` | "ok" — found selector immediately |

### JS dialog auto-dismiss

| Command | Result |
|---------|--------|
| `eval 'alert("hello from dialog"); "done"'` | `"done"` — alert auto-dismissed, eval continued |
| `dialog-log` | `.barebrowse/dialogs-*.json (1 entries)` — dialog logged with type, message, timestamp |

### Save state

| Command | Result |
|---------|--------|
| `save-state` | `.barebrowse/state-*.json` — 2,836 bytes (cookies + localStorage) |

### Viewport flag

| Command | Result |
|---------|--------|
| `open https://example.com --viewport=800x600` | Session started |
| `eval 'window.innerWidth + "x" + window.innerHeight'` | `"800x600"` — confirmed |

### Drag (wired, needs drag-and-drop UI for visual test)

Wired through interact.js → index.js → daemon.js → cli.js. Mouse event sequence: mousePressed at source → mouseMoved to midpoint → mouseMoved to target → mouseReleased at target. Requires a drag-and-drop UI to validate visually.

### Proxy flag

Wired through cli.js → daemon.js → chromium.js → `--proxy-server` Chromium launch arg. Requires a proxy server to validate.

### Storage-state flag

Wired through cli.js → daemon.js → connect() → `Network.setCookies` on startup. Loads from JSON file produced by `save-state`.

---

*Add new validation entries when testing against new sites or features.*
