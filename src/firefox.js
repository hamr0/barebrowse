/**
 * firefox.js — Find and launch Firefox with WebDriver BiDi enabled.
 *
 * The BiDi counterpart to chromium.js. Firefox deprecated CDP, so it's driven
 * over the W3C BiDi protocol instead. `--remote-debugging-port` starts
 * Firefox's remote agent, which prints its BiDi endpoint to stderr:
 *   "WebDriver BiDi listening on ws://127.0.0.1:PORT"
 * The direct-connection socket (no geckodriver / WebDriver-classic handshake)
 * is that URL + "/session" — createBiDi() appends it. No new dependency:
 * BiDi rides the same `ws` transport as CDP.
 *
 * Like chromium.js we launch a fresh temp profile (never the user's live
 * profile — that would profile-lock their running Firefox) and reap the
 * process + profile dir on parent crash.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Block the current thread for `ms` (sync, for the 'exit' reaper). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Reap launched Firefoxes on parent crash — mirrors chromium.js.
const activeBrowsers = new Set();
let exitHandlersRegistered = false;

function reapAllSync() {
  const toReap = [...activeBrowsers];
  activeBrowsers.clear();
  for (const b of toReap) {
    try { if (!b.process.killed) b.process.kill('SIGKILL'); } catch {}
    try { process.kill(-b.process.pid, 'SIGKILL'); } catch {}
  }
  for (const b of toReap) {
    for (let i = 0; i < 20; i++) {
      try { process.kill(b.process.pid, 0); } catch { break; }
      sleepSync(50);
    }
    if (b.ownedProfileDir) {
      try { rmSync(b.ownedProfileDir, { recursive: true, force: true }); } catch {}
    }
  }
}

function registerExitHandlers() {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;
  process.once('exit', reapAllSync);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { reapAllSync(); process.kill(process.pid, sig); });
  }
}

const CANDIDATES = [
  'firefox',
  'firefox-esr',
  'firefox-developer-edition',
  'librewolf',
  '/Applications/Firefox.app/Contents/MacOS/firefox',
];

/**
 * Find the first available Firefox binary on the system.
 * @returns {string} Path to the binary
 * @throws {Error} If no Firefox is found
 */
export function findFirefox() {
  for (const candidate of CANDIDATES) {
    try {
      if (candidate.startsWith('/')) {
        execFileSync('test', ['-f', candidate]);
        return candidate;
      }
      const path = execFileSync('which', [candidate], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (path) return path;
    } catch { /* try next */ }
  }
  throw new Error(
    'No Firefox binary found. Install Firefox (>= 121 for stable BiDi).\n' +
    'On Fedora: sudo dnf install firefox'
  );
}

/**
 * Launch Firefox with WebDriver BiDi enabled and return its session WS URL.
 *
 * @param {object} [opts]
 * @param {string} [opts.binary] - Firefox binary (auto-detected if omitted)
 * @param {number} [opts.port=0] - Remote-agent port (0 = OS-assigned)
 * @param {boolean} [opts.headed=false] - Launch with a visible window
 * @param {string} [opts.proxy] - Proxy 'host:port' or 'scheme://host:port'
 *   (http/https → HTTP+SSL proxy; socks/socks5/socks4 → SOCKS), via prefs
 * @param {{width:number,height:number}} [opts.viewport] - Initial window size
 * @returns {Promise<{wsUrl: string, process: import('node:child_process').ChildProcess, port: number, ownedProfileDir: string}>}
 */
export async function launchFirefox(opts = {}) {
  const binary = opts.binary || findFirefox();
  const port = opts.port || 0;
  const profileDir = mkdtempSync(join(tmpdir(), 'barebrowse-ff-'));

  // Proxy + prompt-suppressing prefs go in user.js (read at profile load).
  const prefs = [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("dom.webnotifications.enabled", false);',
    'user_pref("permissions.default.desktop-notification", 1);',
    'user_pref("media.navigator.permission.disabled", true);',
    'user_pref("geo.prompt.testing", true);',
    'user_pref("geo.prompt.testing.allow", true);',
  ];
  if (opts.proxy) {
    // Honor the scheme: a socks:// proxy must be wired as SOCKS, not HTTP —
    // otherwise SOCKS traffic is silently sent to an HTTP proxy and fails.
    const raw = String(opts.proxy);
    const scheme = (raw.match(/^(\w+):\/\//)?.[1] || '').toLowerCase();
    const [host, pport] = raw.replace(/^\w+:\/\//, '').split(':');
    const isSocks = scheme.startsWith('socks');
    const port = Number(pport) || (isSocks ? 1080 : 8080);
    prefs.push('user_pref("network.proxy.type", 1);');
    if (isSocks) {
      prefs.push(
        `user_pref("network.proxy.socks", "${host}");`,
        `user_pref("network.proxy.socks_port", ${port});`,
        `user_pref("network.proxy.socks_version", ${scheme === 'socks4' ? 4 : 5});`,
        'user_pref("network.proxy.socks_remote_dns", true);',
      );
    } else {
      prefs.push(
        `user_pref("network.proxy.http", "${host}");`,
        `user_pref("network.proxy.http_port", ${port});`,
        `user_pref("network.proxy.ssl", "${host}");`,
        `user_pref("network.proxy.ssl_port", ${port});`,
        'user_pref("network.proxy.share_proxy_settings", true);',
      );
    }
  }
  writeFileSync(join(profileDir, 'user.js'), prefs.join('\n'));

  const args = [
    '--remote-debugging-port', String(port),
    '--no-remote', '--new-instance',
    '--profile', profileDir,
  ];
  if (!opts.headed) args.push('--headless');
  if (opts.viewport) args.push('--width', String(opts.viewport.width), '--height', String(opts.viewport.height));
  args.push('about:blank');

  // detached:true → own process group, so cleanup can signal the whole tree.
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

  // Firefox prints the BiDi endpoint to stderr. Wait for it (or die trying).
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timeout = setTimeout(() => reject(new Error(`Firefox BiDi did not start within 20s. stderr: ${buf}`)), 20000);
    const scan = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timeout); resolve(m[1].replace(/\/?$/, '') + '/session'); }
    };
    child.stderr.on('data', scan);
    child.stdout.on('data', scan);
    child.on('error', (err) => { clearTimeout(timeout); reject(new Error(`Failed to launch Firefox: ${err.message}`)); });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (!buf.includes('WebDriver BiDi')) reject(new Error(`Firefox exited with code ${code}. stderr: ${buf}`));
    });
  });

  const actualPort = parseInt(new URL(wsUrl.replace('/session', '')).port, 10);
  const browser = { wsUrl, process: child, port: actualPort, ownedProfileDir: profileDir };

  registerExitHandlers();
  activeBrowsers.add(browser);
  child.once('exit', () => activeBrowsers.delete(browser));

  return browser;
}

/**
 * Kill a launched Firefox and remove its temp profile dir.
 * @param {{process: import('node:child_process').ChildProcess, ownedProfileDir?: string}} browser
 */
export async function cleanupFirefox(browser) {
  if (!browser) return;
  activeBrowsers.delete(browser);
  const pid = browser.process.pid;
  try { if (!browser.process.killed) browser.process.kill('SIGKILL'); } catch {}
  if (pid != null) try { process.kill(-pid, 'SIGKILL'); } catch {}
  // Wait for death so rmSync doesn't race Firefox's profile file handles.
  for (let i = 0; pid != null && i < 40; i++) {
    try { process.kill(pid, 0); } catch { break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (browser.ownedProfileDir) {
    try { rmSync(browser.ownedProfileDir, { recursive: true, force: true }); } catch {}
  }
}
