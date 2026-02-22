# barebrowse -- Assumptions & Constraints

## Hard constraints

| Constraint | Detail |
|-----------|--------|
| **Chromium-only** | CDP protocol. Covers Chrome, Chromium, Edge, Brave, Vivaldi, Arc, Opera (~80% desktop share). Firefox later via WebDriver BiDi. |
| **Node >= 22** | Built-in WebSocket (`globalThis.WebSocket`), built-in SQLite (`node:sqlite`). No polyfills. |
| **Linux first** | Tested on Fedora/KDE/Wayland. macOS/Windows cookie extraction paths exist in auth.js but are untested. |
| **Zero required deps** | Everything uses Node stdlib. Vanilla JS, ES modules, no build step. |
| **Not a server** | Library that agents import. MCP wrapper included, HTTP wrapper is DIY. |

## Assumptions

- **User has Chromium installed.** At least one of: chromium-browser, google-chrome, brave-browser, microsoft-edge. `chromium.js` searches common paths.
- **Cookie extraction needs unlocked profile.** Chromium cookies are AES-encrypted with a keyring key (KWallet on KDE, GNOME Keyring on GNOME). Firefox cookies are plaintext SQLite and always accessible.
- **Headed mode requires manual browser launch.** User must start their browser with `--remote-debugging-port=9222`. barebrowse connects to it -- does not launch it.
- **Hybrid fallback needs a running headed browser.** If headless is bot-blocked, hybrid kills headless and connects to headed on port 9222. That browser must already be running.
- **Cookies expire.** Cookie injection works for existing sessions, not new logins. For sites requiring fresh auth, headed mode with user interaction is the fallback.
- **One page per connect().** Each `connect()` call creates one page. For multiple tabs, call `connect()` multiple times.

## Known limitations

| Limitation | Impact | Workaround |
|-----------|--------|------------|
| No Firefox/WebKit support | ~20% of desktop users can't use native browser | Use Chromium as the automation target, Firefox as cookie source |
| No file upload | Can't interact with file inputs | Not yet implemented (`Input.setFiles` via CDP) |
| No drag and drop | Can't use drag-based UIs | Not yet implemented |
| No cross-origin iframes | Content inside iframes invisible to ARIA tree | Frame tree traversal via CDP (medium effort) |
| No CAPTCHAs | Cannot solve challenge pages | Headed mode lets user solve manually |
| Canvas/WebGL opaque | No ARIA representation | Needs screenshot + vision model |
| macOS/Windows untested | Cookie paths exist but may not work | Linux-only for now |

## Risks

- **CDP is not a stable API.** Chrome team can change it across versions. Mitigation: we use well-established domains (Accessibility, Input, Page, Network, DOM) that rarely break.
- **Cookie consent patterns evolve.** New consent frameworks may not be detected by `consent.js`. Mitigation: best-effort, opt-out with `{ consent: false }`.
- **Stealth patches are an arms race.** Bot detection evolves. Mitigation: headed mode with real browser profile is the ultimate fallback.
