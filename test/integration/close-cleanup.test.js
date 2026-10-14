/**
 * page.close() must always clean up — even when the browser was kill -9'd.
 * The polite tab-close used to be awaited with no timeout before the hard
 * cleanup, so a dead/hung browser leaked its profile dir (and process).
 *
 * Run: node --test test/integration/close-cleanup.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../../src/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = () => execFileSync('ps', ['-eo', 'pid=,args=']).toString().split('\n').filter(Boolean)
  .map((l) => { const m = l.trim().match(/^(\d+)\s+(.*)$/); return m && { pid: +m[1], args: m[2] }; }).filter(Boolean);

let hasFirefox = true;
try { execFileSync('which', ['firefox']); } catch { hasFirefox = false; }

// chromium.js hardcodes its profile dir to /tmp/barebrowse-<pid>-<ts>.
const chromiumProfile = `/tmp/barebrowse-${process.pid}-`;

/** Processes whose cmdline mentions `marker` (execFileSync: no shell, no self-match). */
const using = (marker) => ps().filter((r) => r.args.includes(marker) && r.pid !== process.pid);

async function killedBrowserCloses(opts, isMain) {
  // Short TMPDIR keeps Chromium's socket path under the sun_path limit.
  const tmp = mkdtempSync(join(tmpdir(), 'x-'));
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    const page = await connect({ mode: 'headless', ...opts });
    const mains = [...using(tmp), ...using(chromiumProfile)].filter(isMain);
    assert.equal(mains.length, 1, 'one browser main process');
    process.kill(mains[0].pid, 'SIGKILL');
    await sleep(300);

    let deadline;
    await Promise.race([
      page.close(),
      new Promise((_, rej) => { deadline = setTimeout(() => rej(new Error('close() hung on a dead browser')), 8000); }),
    ]).finally(() => clearTimeout(deadline));

    await sleep(300);
    assert.deepEqual([...using(tmp), ...using(chromiumProfile)], [], 'no processes left using the profile');
    assert.deepEqual([...readdirSync(tmp).filter((d) => !d.startsWith('org.chromium.')), ...readdirSync('/tmp').filter((d) => d.startsWith(chromiumProfile.slice(5)))], [], 'no temp profile/download dirs left');
  } finally {
    for (const r of [...using(tmp), ...using(chromiumProfile)]) { try { process.kill(r.pid, 'SIGKILL'); } catch {} }
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    rmSync(tmp, { recursive: true, force: true });
    for (const d of readdirSync('/tmp').filter((d) => d.startsWith(chromiumProfile.slice(5)))) rmSync(join('/tmp', d), { recursive: true, force: true });
  }
}

describe('page.close() on a dead browser', () => {
  it('Chromium: still reaps profile dir and processes', async () => {
    await killedBrowserCloses({}, (r) => !r.args.includes('--type=') && r.args.includes('--user-data-dir='));
  });

  it('Firefox: still reaps profile dir and processes', { skip: hasFirefox ? false : 'firefox not installed' }, async () => {
    await killedBrowserCloses({ engine: 'firefox' }, (r) => !r.args.includes('-contentproc') && r.args.includes('/barebrowse-ff-'));
  });
});
