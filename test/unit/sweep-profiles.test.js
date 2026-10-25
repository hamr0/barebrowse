/** sweepStaleProfiles() removes only dead-owner barebrowse-<pid>-<ms> dirs. Uses a temp dir, never /tmp. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sweepStaleProfiles } from '../../src/chromium.js';

describe('sweepStaleProfiles', () => {
  it('removes dead-owner dirs only', () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-sweep-'));
    try {
      const dead = spawnSync(process.execPath, ['-e', '']).pid; // exited, so dead
      const mk = (n) => { mkdirSync(join(root, n)); return join(root, n); };
      const deadDir = mk(`barebrowse-${dead}-1`);
      const liveDir = mk(`barebrowse-${process.ppid}-1`);
      const selfDir = mk(`barebrowse-${process.pid}-1`);
      const dl = mk(`barebrowse-dl-${dead}`);
      const ff = mk(`barebrowse-ff-${dead}`);
      const ffDead = mk(`barebrowse-ff-${dead}-aB3dE9`);
      const ffLive = mk(`barebrowse-ff-${process.ppid}-aB3dE9`);
      const ffSelf = mk(`barebrowse-ff-${process.pid}-aB3dE9`);
      const ffDl = mk(`barebrowse-ff-dl-aB3dE9`);
      const dlDead = mk(`barebrowse-dl-${dead}-aB3dE9`);
      const ffDlDead = mk(`barebrowse-ff-dl-${dead}-aB3dE9`);
      const dlLive = mk(`barebrowse-dl-${process.ppid}-aB3dE9`);
      const ffDlLive = mk(`barebrowse-ff-dl-${process.ppid}-aB3dE9`);
      const dlSelf = mk(`barebrowse-dl-${process.pid}-aB3dE9`);
      const ffDlSelf = mk(`barebrowse-ff-dl-${process.pid}-aB3dE9`);
      const dlOld = mk(`barebrowse-dl-aB3dE9`);
      const ffOdd = mk(`barebrowse-ff-${dead}-x`);
      const odd = mk(`barebrowse-${dead}-1-x`);
      sweepStaleProfiles(root);
      assert.ok(!existsSync(deadDir), 'dead owner dir removed');
      for (const d of [ffDead, dlDead, ffDlDead]) assert.ok(!existsSync(d), d + ' removed');
      for (const d of [liveDir, selfDir, dl, ff, odd, ffLive, ffSelf, ffDl, ffOdd, dlLive, ffDlLive, dlSelf, ffDlSelf, dlOld]) assert.ok(existsSync(d), d);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
