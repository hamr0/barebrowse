/**
 * chromium.js — Find, launch, and connect to Chromium-based browsers.
 *
 * Supports: Chrome, Chromium, Brave, Edge, Vivaldi, Arc, Opera.
 * Modes: headless (launch new), headed (connect to running).
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

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
 * Launch a headless Chromium instance with CDP enabled.
 * @param {object} [opts]
 * @param {string} [opts.binary] - Path to browser binary (auto-detected if omitted)
 * @param {number} [opts.port=0] - CDP port (0 = random available port)
 * @param {string} [opts.userDataDir] - Browser profile directory
 * @returns {Promise<{wsUrl: string, process: ChildProcess, port: number}>}
 */
export async function launch(opts = {}) {
  const binary = opts.binary || findBrowser();
  const port = opts.port || 0;

  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--mute-audio',
    '--hide-scrollbars',
    // Suppress permission prompts (location, notifications, camera, mic, etc.)
    '--disable-notifications',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--disable-features=MediaRouter',
  ];

  if (opts.proxy) {
    args.push(`--proxy-server=${opts.proxy}`);
  }

  if (opts.userDataDir) {
    args.push(`--user-data-dir=${opts.userDataDir}`);
  } else {
    // Use a unique temp profile so we don't lock the user's profile
    // or conflict with parallel instances
    args.push(`--user-data-dir=/tmp/barebrowse-${process.pid}-${Date.now()}`);
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

  return { wsUrl, process: child, port: actualPort };
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
