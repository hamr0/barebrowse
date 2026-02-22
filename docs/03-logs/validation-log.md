# Validation Log

What's been tested against the real world. Updated when new sites or features are validated.

---

## Test suite (54 tests, 5 files)

| File | Tests | Type | What it covers |
|------|-------|------|----------------|
| `test/unit/prune.test.js` | 16 | Unit | 9-step pruning pipeline in isolation |
| `test/unit/auth.test.js` | 7 | Unit | Cookie extraction from Firefox/Chromium |
| `test/unit/cdp.test.js` | 5 | Unit | Browser discovery, launch, CDP client, sessions |
| `test/integration/browse.test.js` | 11 | Integration | Full `browse()` and `connect()` pipeline |
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

*Add new validation entries when testing against new sites or features.*
