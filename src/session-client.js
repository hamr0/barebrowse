/**
 * session-client.js -- HTTP client to talk to the daemon.
 *
 * sendCommand()  — POST a command to the running daemon
 * readSession()  — read session.json from output dir
 * isAlive()      — check if daemon is still responding
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SESSION_FILE = 'session.json';

/**
 * Read session.json from the output directory.
 * @returns {{ port: number, pid: number, startedAt: string } | null}
 */
export function readSession(outputDir) {
  const sessionPath = join(resolve(outputDir), SESSION_FILE);
  if (!existsSync(sessionPath)) return null;
  try {
    return JSON.parse(readFileSync(sessionPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Check if the daemon is alive by hitting GET /status.
 */
export async function isAlive(outputDir) {
  const session = readSession(outputDir);
  if (!session) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${session.port}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Send a command to the running daemon.
 * @returns {Promise<object>} The daemon's response
 */
export async function sendCommand(command, args, outputDir) {
  const session = readSession(outputDir);
  if (!session) throw new Error('No active session. Run `barebrowse open` first.');

  let res;
  try {
    res = await fetch(`http://127.0.0.1:${session.port}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, args }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    // ECONNREFUSED / ECONNRESET — daemon died
    if (command === 'close') {
      // Expected: daemon exited before response
      return { ok: true };
    }
    throw new Error(`Daemon not responding (pid ${session.pid}). Session may be stale.`);
  }

  return res.json();
}
