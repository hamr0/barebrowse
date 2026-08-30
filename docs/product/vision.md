# barebrowse -- Vision

## What it is

A standalone vanilla JavaScript library that gives autonomous agents authenticated access to the web through the user's own Chromium browser. One package, one import, three modes.

```js
import { browse } from 'barebrowse';
const snapshot = await browse('https://any-page.com');
```

barebrowse handles: finding the browser, connecting via CDP, injecting cookies, navigating, extracting the ARIA accessibility tree, and pruning it down to what an agent actually needs. The output is a clean, token-efficient snapshot of any web page -- authenticated as the real user.

## What it is NOT

- **Not a framework.** No plugin system, no config files, no lifecycle hooks.
- **Not Playwright.** No bundled browser, no cross-engine abstraction, no 200MB download.
- **Not an agent.** No LLM, no planning, no orchestration -- that's bareagent's job.
- **Not a scraper.** It browses as the user, not as a bot harvesting data.

## The core insight

The user already has a browser. It's already logged in. It already passes Cloudflare. Instead of fighting the web with headless stealth tricks, **use what's already there**.

CDP (Chrome DevTools Protocol) lets us connect to any Chromium-based browser -- the same one the user browses with daily. We get their cookies, their sessions, their anti-detection posture, for free.

## The problem it solves

Every AI agent that needs to read or interact with the web hits the same walls:

1. **Cloudflare / bot detection** -- headless browsers get blocked
2. **Authentication** -- sites require login, OAuth, session cookies
3. **Token bloat** -- raw DOM is 100K+ tokens; agents need ~5K
4. **Two consumers, same need** -- research agents (read pages) and personal assistants (click/type) both need an authenticated browser, but existing tools force you to choose one path

## The bare- ecosystem

```
bareagent  = the brain  (orchestration, LLM loop, memory, retries)
barebrowse = the eyes + hands  (browse, read, interact with the web)
```

barebrowse is a library. bareagent imports it as a capability. barebrowse doesn't know about bareagent. bareagent doesn't know about CDP. Clean boundary. Each ships and tests independently.

## Success criteria

1. `browse(url)` returns a pruned ARIA snapshot of any page, authenticated as the user
2. Zero heavy dependencies -- no Playwright, no Puppeteer, no bundled browser
3. Works with any installed Chromium-based browser
4. Headless for research, headed for interaction, hybrid for autonomous agents
5. Plugs into bareagent as plain tool functions
6. An agent using barebrowse + bareagent can autonomously research the web and act on pages
