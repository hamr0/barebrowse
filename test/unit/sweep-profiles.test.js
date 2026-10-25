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
      const odd = mk(`barebrowse-${dead}-1-x`);
      sweepStaleProfiles(root);
      assert.ok(!existsSync(deadDir), 'dead owner dir removed');
      for (const d of [liveDir, selfDir, dl, ff, odd]) assert.ok(existsSync(d), d);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
