/**
 * A hard-killed (SIGKILL/crash) Node parent must not orphan Chromium.
 * launch() tethers the browser with --remote-debugging-pipe; the kernel closing
 * the pipe on parent death makes Chromium exit. Needs a real Chromium.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const chromiumUrl = new URL('../../src/chromium.js', import.meta.url).href;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a child script; resolves once it prints "<pid> <profileDir>". */
function runChild(code, detached = false) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'], detached });
  const ready = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/^(\d+) (\S+)\n/);
      if (m) resolve({ pid: Number(m[1]), dir: m[2] });
    });
    child.on('exit', () => reject(new Error('child exited early: ' + out)));
  });
  return { child, ready };
}

describe('launch() parent-death tether', () => {
  it('Chromium exits when the launching process is SIGKILLed', async () => {
    const { child, ready } = runChild(`
      import { launch } from ${JSON.stringify(chromiumUrl)};
      const b = await launch();
      console.log(b.process.pid + ' ' + b.ownedProfileDir);
      setInterval(() => {}, 1000);
    `);
    const { pid, dir } = await ready;
    try {
      assert.ok(alive(pid), 'chromium should be running before the kill');
      child.removeAllListeners('exit');
      child.kill('SIGKILL');
      for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
      assert.ok(!alive(pid), 'chromium must exit after its parent is SIGKILLed');
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Chromium exits when the launcher is killed as a process group (SIGKILL to -pid)', async () => {
    const { child, ready } = runChild(`
      import { launch } from ${JSON.stringify(chromiumUrl)};
      const b = await launch();
      console.log(b.process.pid + ' ' + b.ownedProfileDir);
      setInterval(() => {}, 1000);
    `, true);
    const { pid, dir } = await ready;
    try {
      assert.ok(alive(pid), 'chromium should be running before the kill');
      child.removeAllListeners('exit');
      process.kill(-child.pid, 'SIGKILL');
      for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
      assert.ok(!alive(pid), 'chromium must exit after its launcher group is killed');
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a script that launches then cleans up exits on its own', async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { launch, cleanupBrowser } from ${JSON.stringify(chromiumUrl)};
      const b = await launch();
      await cleanupBrowser(b);
    `], { stdio: 'ignore' });
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); resolve('hung'); }, 15000);
      child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    assert.equal(code, 0, 'clean script must exit by itself (fds 3/4 must not hold the loop)');
  });
});
