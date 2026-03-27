# baremobile — Research & Feasibility

## Platform Feasibility

| Platform | Accessibility Tree | Input Injection | Auth/Cookie Reuse | Practical? |
|---|---|---|---|---|
| **Android (non-root)** | uiautomator dump — good XML tree | ADB tap/swipe/input — solid | No. SharedPrefs locked, Keystore hardware-bound | Yes — tree + input work, auth is the gap |
| **Android (rooted)** | Same | Same | Partial — SharedPrefs yes, Keystore still no | Yes — best mobile option |
| **iOS (simulator)** | XCUITest — excellent tree | simctl + WDA | No. Absolute sandboxing | Dev/QA only |
| **iOS (physical)** | Same, but needs Mac+Xcode+signing | Same | No | Impractical for end users |
| **Windows** | UI Automation (UIA) — best desktop tree | SendInput — works well | App-specific, no universal trick | Yes — strongest desktop option |
| **macOS** | AXUIElement — good tree | CGEvent APIs, cliclick | Keychain Access (gated by prompts) | Medium — permission hell |
| **Linux (X11)** | AT-SPI2 — inconsistent coverage | xdotool — trivial | App-specific | Medium — tree quality varies |
| **Linux (Wayland)** | AT-SPI2 — same | ydotool (needs root) | Same | Hard — input injection blocked by design |

## Market Demand

| Platform | Who Wants It | Use Cases | Demand Level |
|---|---|---|---|
| **Android** | Devs, QA teams, end users | Mobile-only apps, testing, data entry, social media automation | **High** — DroidRun got 900 signups in 72h, 2.1M EUR raised |
| **iOS** | QA teams, enterprises | App testing, accessibility audits | **Medium** — gated access kills consumer use |
| **Windows** | Enterprises | Legacy app automation (no API, GUI only) | **High** — Microsoft building UFO (8k stars) |
| **macOS** | Developers, power users | App automation, workflows | **Low-Medium** — most Mac apps have APIs or CLI |
| **Linux desktop** | Almost nobody | Niche automation | **Low** — devs use CLI, not GUI agents |

## Existing Open-Source Competition

| Project | Platform | Stars | Approach | Maturity |
|---|---|---|---|---|
| DroidRun | Android | 3.8k | A11y tree + ADB | Funded (2.1M EUR), active |
| DroidClaw | Android | New | A11y tree + vision fallback | Weeks old |
| agent-device (Callstack) | Android + iOS | Early | A11y tree, TypeScript | Active |
| UFO (Microsoft) | Windows | 8k | UIA + vision | Mature |
| Agent-S (Simular AI) | Cross-platform | 8.5k | Hybrid | Mature, 72% OSWorld |
| Cua | macOS/Linux/Win | 11.8k | Sandbox VMs | YC-backed |

## Auth Problem (Mobile vs Web)

| | Web (barebrowse) | Android Native | iOS Native |
|---|---|---|---|
| Where tokens live | SQLite cookie DB, readable | SharedPrefs (locked) or Keystore (hardware) | Keychain (sandboxed) |
| Can agent read them? | Yes — decrypt with OS keyring | No (non-root), Partial (root) | No |
| Workaround | N/A — it works | Agent logs in via UI, or keeps app session alive | Same |
| WebView content? | N/A | CDP attach possible (debug builds only) | No |

## Strategic Comparison

| Factor | Android | Windows | iOS | macOS | Linux Desktop |
|---|---|---|---|---|---|
| Tree quality | Good | Excellent | Excellent | Good | Inconsistent |
| Input control | Easy (ADB) | Easy | Gated | Permission-heavy | X11 easy, Wayland hard |
| Auth reuse | Bad | App-specific | Impossible | Gated | App-specific |
| Real demand | **High** | **High** | Medium (QA only) | Low-Medium | Low |
| Competition | Active but early | Microsoft owns it | Apple controls it | Niche | Nobody cares |
| Fits barebrowse DNA? | **Yes** | Partial | No | No | No |

## Android Technical Details

### Accessibility Tree via ADB
```bash
adb shell uiautomator dump /dev/tty  # dump XML accessibility tree
```
Returns XML with: bounds, text, class, content-desc, resource-id, clickable, scrollable, focused, enabled, checked, selected. Structurally similar to ARIA — roles, names, states, coordinates.

### Input via ADB
```bash
adb shell input tap 500 300           # tap at coordinates
adb shell input text "hello"          # type text
adb shell input keyevent 66           # Enter key (KEYCODE_ENTER)
adb shell input swipe 300 500 300 100 # swipe gesture
adb shell input keyevent 4            # Back button
```

### Key Limitations
- **WebViews:** uiautomator tree is empty/shallow for WebView content. Flutter apps can crash uiautomator with StackOverflowError.
- **Auth:** Cannot read app tokens on non-rooted devices. Agent must log in through UI or keep sessions alive.
- **Latency:** uiautomator dump takes 1-3 seconds. Screenshot approach is faster per frame but less structured.

### WebView Gap — Potential Differentiator
Android WebViews expose a CDP debug port when the app is built with `WebView.setWebContentsDebuggingEnabled(true)`. If accessible, barebrowse's CDP + ARIA expertise can fill the gap that all other Android agent tools struggle with — structured content inside WebViews instead of falling back to screenshots.

Discovery: `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`

## Windows Technical Details

### UI Automation (UIA)
Windows' accessibility API. Exposes a tree of AutomationElements with: ControlType, Name, AutomationId, BoundingRectangle, IsEnabled, patterns (Invoke, Value, Toggle, Selection, Scroll, etc.).

Best desktop accessibility tree. Covers Win32, WPF, WinForms, UWP, and most Electron apps.

### Input
SendInput API for keyboard/mouse. Or higher-level: `pyautogui`, `robotjs`, `nut.js`.

### Competition
Microsoft's own UFO project (8k stars) dominates this space. They have first-party UIA access and deep investment. Competing here means competing with Microsoft on their own platform's APIs.

## References
- [DroidRun](https://github.com/droidrun/droidrun)
- [DroidClaw](https://github.com/unitedbyai/droidclaw)
- [agent-device](https://github.com/callstackincubator/agent-device)
- [UFO (Microsoft)](https://github.com/microsoft/UFO)
- [Agent-S](https://github.com/simular-ai/Agent-S)
- [Cua](https://github.com/trycua/cua)
- [Android uiautomator](https://developer.android.com/training/testing/other-components/ui-automator)
- [Windows UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32)
