/**
 * chromium.js — Find, launch, and connect to Chromium-based browsers.
 *
 * Supports: Chrome, Chromium, Brave, Edge, Vivaldi, Arc, Opera.
 * Modes: headless (launch new, no UI), headed (launch new, visible window).
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

// Track launched browsers so we can clean them up if the parent crashes.
// Registered exit handlers (one-time) iterate this set on shutdown.
const activeBrowsers = new Set();
let exitHandlersRegistered = false;

function reapAllSync() {
  const toReap = [...activeBrowsers];
  activeBrowsers.clear();
  // Send SIGKILL to everything first so the kernel reaps in parallel
  for (const b of toReap) {
    try { if (!b.process.killed) b.process.kill('SIGKILL'); } catch {}
  }
  // Then poll each for actual death before removing its profile dir —
  // Chromium can hold file handles briefly even after SIGKILL, which would
  // race rmSync. Cap the wait so a stuck process can't hang shutdown.
  for (const b of toReap) {
    for (let i = 0; i < 20; i++) {
      try { process.kill(b.process.pid, 0); } catch { break; }
      try { execSync('sleep 0.05'); } catch {}
    }
    if (b.ownedProfileDir) {
      try { rmSync(b.ownedProfileDir, { recursive: true, force: true }); } catch {}
    }
  }
}

function registerExitHandlers() {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;
  // 'exit' is sync-only — must use synchronous APIs (SIGKILL, rmSync)
  process.once('exit', reapAllSync);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      reapAllSync();
      // Re-raise default behavior so the parent's exit code matches the signal
      process.kill(process.pid, sig);
    });
  }
}

// Common Chromium binary paths by platform (Linux focus for POC)
const CANDIDATES = [
  // Linux
  'chromium-browser',
  'chromium',
  'google-chrome-stable',
  'google-chrome',
  'brave-browser-stable',
  'brave-browser',
  'microsoft-edge-stable',
  'microsoft-edge',
  'vivaldi-stable',
  'vivaldi',
  // macOS (future)
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

/**
 * Find the first available Chromium binary on the system.
 * @returns {string} Path to the binary
 * @throws {Error} If no Chromium browser is found
 */
export function findBrowser() {
  for (const candidate of CANDIDATES) {
    try {
      // Absolute path — check directly
      if (candidate.startsWith('/')) {
        if (existsSync(candidate)) return candidate;
        continue;
      }
      // Relative name — check via which
      const path = execSync(`which ${candidate} 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (path) return path;
    } catch {
      // Not found, try next
    }
  }
  throw new Error(
    'No Chromium-based browser found. Install Chrome, Chromium, Brave, or Edge.\n' +
    'On Fedora: sudo dnf install chromium'
  );
}

/**
 * Launch a Chromium instance with CDP enabled.
 * @param {object} [opts]
 * @param {string} [opts.binary] - Path to browser binary (auto-detected if omitted)
 * @param {number} [opts.port=0] - CDP port (0 = random available port)
 * @param {string} [opts.userDataDir] - Browser profile directory
 * @param {boolean} [opts.headed=false] - Launch in headed mode (with visible window)
 * @returns {Promise<{wsUrl: string, process: ChildProcess, port: number}>}
 */
export async function launch(opts = {}) {
  const binary = opts.binary || findBrowser();
  const port = opts.port || 0;

  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--mute-audio',
    // Force every iframe (same-origin included) into its own renderer so it
    // gets a dedicated CDP session via Target.setAutoAttach. Without this,
    // same-origin iframes stay in the parent process — getFullAXTree still
    // works via frameId, but Input.dispatchMouseEvent on the parent session
    // uses parent-viewport coords while DOM.getBoxModel for iframe-internal
    // nodes returns frame-local coords, so clicks land off-target. The OOPIF
    // path side-steps that: each frame has its own Input domain.
    '--site-per-process',
    // Headless-only flags
    ...(!opts.headed ? ['--headless=new', '--hide-scrollbars'] : []),
    // Suppress permission prompts (location, notifications, camera, mic, etc.)
    '--disable-notifications',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--disable-features=MediaRouter',
    '--disable-dev-shm-usage',
  ];

  if (opts.proxy) {
    args.push(`--proxy-server=${opts.proxy}`);
  }

  // Track the temp profile dir only when we create one — caller-supplied dirs
  // are the caller's to manage. ownedProfileDir gets rm'd in cleanupBrowser.
  let ownedProfileDir = null;
  if (opts.userDataDir) {
    args.push(`--user-data-dir=${opts.userDataDir}`);
  } else {
    ownedProfileDir = `/tmp/barebrowse-${process.pid}-${Date.now()}`;
    args.push(`--user-data-dir=${ownedProfileDir}`);
  }

  // about:blank as initial page
  args.push('about:blank');

  const child = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Parse the WebSocket URL from stderr
  // Chrome prints: "DevTools listening on ws://127.0.0.1:PORT/devtools/browser/UUID"
  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Browser failed to start within 10s. stderr: ${stderr}`));
    }, 10000);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/ws:\/\/[^\s]+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to launch browser: ${err.message}`));
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (!stderr.includes('ws://')) {
        reject(new Error(`Browser exited with code ${code}. stderr: ${stderr}`));
      }
    });
  });

  // Extract port from wsUrl
  const actualPort = parseInt(new URL(wsUrl).port, 10);

  const browser = { wsUrl, process: child, port: actualPort, ownedProfileDir };

  // Register for parent-crash reaping. Auto-untrack on natural exit so
  // a normally-exited browser doesn't leave a stale entry around.
  registerExitHandlers();
  activeBrowsers.add(browser);
  child.once('exit', () => activeBrowsers.delete(browser));

  return browser;
}

/**
 * Kill a launched browser and remove its temp profile dir (if we created one).
 * Waits up to 2s for the process to actually exit before unlinking the dir —
 * Chromium can still hold files briefly after SIGTERM, which races rmSync.
 * Safe to call on partially-failed launches or already-dead processes.
 * @returns {Promise<void>}
 */
export async function cleanupBrowser(browser) {
  if (!browser) return;
  activeBrowsers.delete(browser);
  if (browser.process && !browser.process.killed && browser.process.exitCode === null) {
    const exited = new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      browser.process.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    try { browser.process.kill(); } catch {}
    await exited;
  }
  if (browser.ownedProfileDir) {
    // Chromium can still flush files for ~hundreds of ms after exit;
    // retry briefly on ENOTEMPTY/EBUSY before giving up.
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(browser.ownedProfileDir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (err.code !== 'ENOTEMPTY' && err.code !== 'EBUSY') break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
}

/**
 * Get the CDP WebSocket URL for a browser already running with --remote-debugging-port.
 * @param {number} port - The debug port
 * @returns {Promise<string>} WebSocket URL
 */
export async function getDebugUrl(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) throw new Error(`Cannot reach browser debug port at ${port}: ${res.status}`);
  const data = await res.json();
  return data.webSocketDebuggerUrl;
}

/**
 * Attach to a Chromium already running with --remote-debugging-port=<port>.
 * Returns the same shape as launch() but with process: null and
 * ownedProfileDir: null — cleanupBrowser() becomes a no-op so we never
 * kill a browser we did not start or remove a profile we do not own.
 * @param {object} opts
 * @param {number} opts.port - The debug port the running browser is listening on
 * @returns {Promise<{wsUrl: string, process: null, port: number, ownedProfileDir: null}>}
 */
export async function attach({ port }) {
  if (!port) throw new Error('attach({ port }) requires a port number');
  const wsUrl = await getDebugUrl(port);
  return { wsUrl, process: null, port, ownedProfileDir: null };
}
