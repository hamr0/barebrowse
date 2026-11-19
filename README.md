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

> A real browser for AI agents. URL in, pruned page out.
> Same browser, same logins. 40-90% fewer tokens.

## What it's good at

- **Pruned by default.** The agent never sees the raw page. It gets a short accessibility tree with `[ref=N]` handles to click and type on.
- **Pick how to read the page.** `act` for doing, `read` for reading, `data` for clean tables and lists, `readable()` for article text.
- **Zoom.** On a big page, ask for a map of its boxes, then read only the box you need.
- **Your logins.** Cookies come from your own Chromium or Firefox. No login scripts.
- **Gets past bots, reasonably.** Stealth patches, auto fallback to a visible browser, cookie-banner dismissal (29 languages), Press & Hold. A blocked page is flagged, not hidden. Good enough, not unbeatable.
- **Chromium and Firefox, equally.** CDP for Chromium, WebDriver BiDi for Firefox. Same API, same output.
- **Light.** No Playwright, no bundled browser, no 200MB download. Two small deps (`ws`, `@mozilla/readability`).
- **Three ways in.** Library, MCP server, CLI.

## Install

```bash
npm install barebrowse
```

Needs Node.js >= 22 and any Chromium-based browser (Chrome, Chromium, Brave, Edge, Vivaldi) or Firefox >= 121. Ships TypeScript types.

## Use it

**Library**

```js
import { browse, connect } from 'barebrowse';

const snap = await browse('https://news.ycombinator.com');   // one shot

const page = await connect();                                 // a session
await page.goto('https://github.com/nodejs/node/issues');
console.log(await page.snapshot({ mode: 'data' }));
await page.click('12');
await page.close();
```

**MCP** (Claude Code, Claude Desktop, Cursor, VS Code)

```bash
claude mcp add barebrowse -- npx barebrowse mcp   # Claude Code
npx barebrowse install                            # Claude Desktop / Cursor
```

**CLI** (coding agents, quick checks). Output goes to `.barebrowse/` as files.

```bash
barebrowse open https://example.com
barebrowse snapshot
barebrowse click 8
barebrowse close
```

`barebrowse install --skill` teaches Claude Code the CLI. `npx barebrowse doctor` shows what it found on your machine.

## Reading modes

| Mode | Keeps | Use for |
|------|-------|---------|
| `act` (default) | Buttons, links, inputs, labels | Clicking, typing, moving around |
| `read` | All text: headings, paragraphs | Docs, content pages |
| `data` | One line per record: table rows with headers, repeated items grouped | Listings, timetables, search results, issue lists |
| `readable()` | Clean article text (Firefox Reader View engine) | Long articles |

Add `links: true` to any mode to get each link's URL.

**Zoom** works on top of any mode:

```js
await page.snapshot({ map: true });                           // outline of the page's boxes, with sizes
await page.snapshot({ within: 'list "Issues"' });             // just that box
await page.snapshot({ within: 'list after "Top flights"', mode: 'data' });
```

Pick a box by ref, role, role + name, or the heading before it. Card grids (products, listings) show up as groups even when the page doesn't mark them. If more than one box matches, you get the map back. barebrowse never guesses.

## What it saves

| Page | Raw | Pruned (act) | Saved |
|------|-----|--------|-------|
| example.com | 377 chars | 45 | 88% |
| DuckDuckGo | 42,254 | 5,407 | 87% |
| Wikipedia article | 109,479 | 40,566 | 63% |
| Hacker News | 51,726 | 27,197 | 47% |

Zoom on a big page: Amazon search, 134,740 chars full → 2,227 for the map → 38,042 for the results box.

## How it compares

| | barebrowse | Playwright MCP | Cloudflare Kitesurf |
|---|---|---|---|
| Browser | The one you have | Downloads its own | Cloud, stateless |
| Your logins | Yes, read from your browser | Its own profile; you log in there | No |
| What the agent gets | Pruned tree, act/read/data, zoom by box | Accessibility tree | Filtered JSON tree, CSS root picker |
| Clickable refs | Yes, stable on the page | Yes | No |
| Extra deps | `ws` + Readability | Playwright + its browser | Cloud service |

## Good for / not for

**Good for:** agents that browse, read and act on real sites. Logged-in reading. Checking your own app on `localhost` while you build it. Re-running a flow your agent found, as a short script.

**Not for:** large test suites (use Playwright), or scraping at scale (use Crawlee or Scrapy).

### Turn a flow into a script

Once an agent has found a flow, save it as a script and run it again with no agent and no tokens. Find elements by name, not by ref number, since ref numbers can change between runs.

```js
import { connect } from 'barebrowse';

const ref = (snap, name) => snap.match(new RegExp(`"${name}"[^\\n]*\\[ref=(\\d+)\\]`))[1];

const page = await connect();
await page.goto('http://localhost:3000/login');
const snap = await page.snapshot();
await page.type(ref(snap, 'Email'), 'me@test.dev');
await page.click(ref(snap, 'Sign in'));
await page.waitFor({ text: 'Welcome' });
await page.close();
```

The same flow works as CLI commands in a shell script.

## All tools

| Group | Tools |
|------|-------|
| Read | `browse`, `goto`, `snapshot` (modes, map, zoom, links), `readable`, `screenshot`, `pdf` |
| Act | `click`, `type`, `press`, `scroll`, `hover`, `hold`, `select`, `drag`, `upload` |
| Move | `back`, `forward`, `reload`, `tabs`, `switchTab`, `waitFor`, `waitForNavigation`, `waitForNetworkIdle` |
| Session | `injectCookies`, `saveState`, `switch_engine`, `capabilities`, `close` |
| Escape hatch | `page.cdp` (Chromium), `page.bidi` (Firefox), `eval` (opt-in on MCP) |

Browser modes: `headless` (default), `headed` (visible window), `hybrid` (headless, switches to headed when blocked). Or attach to your own running Chrome with `connect({ port: 9222 })`.

## Safe by default

An agent with your logins can be tricked by a page. So:

- `file:`, `chrome:` and similar URLs are blocked.
- Cookies go only to the site they belong to.
- Output files are owner-only. The CLI daemon needs a per-session token.
- Opt-in: site lock (`allowHosts`), private-network block, upload folder sandbox.
- MCP: `BAREBROWSE_TIER=r|rw|rwx` hides tools above the tier. `eval` is off unless you turn it on.
- Browsers close when their parent dies or sits idle (MCP: 15 min).

## Learn more

- **[barebrowse.context.md](barebrowse.context.md)**: the full guide. Every option, the MCP and CLI details, gotchas.
- **[docs/README.md](docs/README.md)**: design notes, decisions, logs.

## The bare ecosystem

Small, local-first pieces for agents. Each works on its own.

- **[bareagent](https://npmjs.com/package/bare-agent)**: the think → act → observe loop.
- **[bareguard](https://npmjs.com/package/bareguard)**: one gate every action passes through.
- **[litectx](https://npmjs.com/package/litectx)**: code and memory context for agents.
- **[barebrowse](https://npmjs.com/package/barebrowse)**: a real browser for agents.
- **[baremobile](https://npmjs.com/package/baremobile)**: Android and iOS control.
- **[beeperbox](https://github.com/hamr0/beeperbox)**: 50+ chat networks through one MCP server.

## License

Apache-2.0. See [LICENSE](LICENSE).
