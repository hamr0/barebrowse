/**
 * A browser that never reports its debug endpoint must not outlive the failed
 * launch. A fake binary (shell script) records its pid + profile dir and then
 * sleeps without ever printing a ws:// line, so launch() hits its start
 * timeout (10s Chromium, 20s Firefox — hardcoded, so these tests wait it out).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '../../src/chromium.js';
import { launchFirefox } from '../../src/firefox.js';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let work, fake;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'bb-lf-'));
  fake = join(work, 'fake-browser.sh');
  // Records $$ and the profile dir (Chromium: --user-data-dir=X, Firefox:
  // --profile X), then ignores SIGTERM and sleeps forever.
  writeFileSync(fake, `#!/bin/sh
echo $$ > "${work}/pid"
prev=
for a in "$@"; do
  case "$a" in --user-data-dir=*) d="\${a#*=}"; echo "$d" > "${work}/dir"; mkdir -p "$d";; esac
  [ "$prev" = "--profile" ] && echo "$a" > "${work}/dir"
  prev="$a"
done
trap '' TERM
while :; do sleep 1; done
`);
  chmodSync(fake, 0o755);
});
after(() => {
  try { process.kill(Number(readFileSync(join(work, 'pid'), 'utf8')), 'SIGKILL'); } catch {}
  rmSync(work, { recursive: true, force: true });
});

for (const [name, fn, re] of [
  ['launch()', launch, /failed to start within 10s/],
  ['launchFirefox()', launchFirefox, /did not start within 20s/],
]) {
  describe(name, () => {
    it('kills the child and removes its profile dir when startup times out', { timeout: 40000 }, async () => {
      await assert.rejects(fn({ binary: fake, headed: false }), re);
      const pid = Number(readFileSync(join(work, 'pid'), 'utf8'));
      const dir = readFileSync(join(work, 'dir'), 'utf8').trim();
      // Give SIGKILL a moment to land before judging.
      for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
      const stillAlive = alive(pid);
      const dirExists = existsSync(dir);
      if (stillAlive) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
      if (dirExists) rmSync(dir, { recursive: true, force: true });
      assert.equal(stillAlive, false, 'fake browser still running after failed launch');
      assert.equal(dirExists, false, 'profile dir left behind after failed launch');
    });
  });
}
