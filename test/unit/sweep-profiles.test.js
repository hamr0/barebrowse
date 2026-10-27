/** sweepStaleProfiles() removes only dead-owner barebrowse-<pid>-<ms> dirs. Uses a temp dir, never /tmp. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
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

  it('with no argument also sweeps tmpdir() when TMPDIR differs from /tmp', () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-sweep-'));
    try {
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      const dl = join(root, `barebrowse-dl-${dead}-aB3dE9`);
      mkdirSync(dl);
      // Child sees TMPDIR=root, so its no-arg sweep must reach it (it also sweeps /tmp).
      spawnSync(process.execPath, ['--input-type=module', '-e',
        "import { sweepStaleProfiles } from './src/chromium.js'; sweepStaleProfiles();"],
        { env: { ...process.env, TMPDIR: root }, cwd: new URL('../..', import.meta.url) });
      assert.ok(!existsSync(dl), 'dead-owner dir in TMPDIR removed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps a dead-owner profile whose browser lock is still live or foreign', () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-sweep-'));
    try {
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      const alive = process.ppid;
      const mk = (n, file, target) => {
        mkdirSync(join(root, n));
        if (file) symlinkSync(target, join(root, n, file));
        return join(root, n);
      };
      const host = hostname();
      const cLive = mk(`barebrowse-${dead}-1`, 'SingletonLock', `${host}-${alive}`);
      const cDead = mk(`barebrowse-${dead}-2`, 'SingletonLock', `${host}-${dead}`);
      const cForeign = mk(`barebrowse-${dead}-3`, 'SingletonLock', `otherhost-${dead}`);
      const cNone = mk(`barebrowse-${dead}-4`);
      const fLive = mk(`barebrowse-ff-${dead}-aB3dE9`, 'lock', `10.0.0.1:+${alive}`);
      const fDead = mk(`barebrowse-ff-${dead}-aB3dE8`, 'lock', `10.0.0.1:+${dead}`);
      sweepStaleProfiles(root);
      for (const d of [cLive, cForeign, fLive]) assert.ok(existsSync(d), d + ' kept');
      for (const d of [cDead, cNone, fDead]) assert.ok(!existsSync(d), d + ' removed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('parses a hyphenated hostname by splitting the lock at the last "-"', () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-sweep-'));
    try {
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      const alive = process.ppid;
      const host = 'my-host-name';
      const mk = (n, target) => {
        mkdirSync(join(root, n));
        symlinkSync(target, join(root, n, 'SingletonLock'));
        return join(root, n);
      };
      const live = mk(`barebrowse-${dead}-1`, `${host}-${alive}`);
      const gone = mk(`barebrowse-${dead}-2`, `${host}-${dead}`);
      sweepStaleProfiles(root, host);
      assert.ok(existsSync(live), 'own-host live pid kept');
      assert.ok(!existsSync(gone), 'own-host dead pid removed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('treats an unsignalable (EPERM) pid as alive, for both the owner pid and a lock pid', { skip: process.getuid?.() === 0 && 'root can signal pid 1 (no EPERM)' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-sweep-'));
    try {
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      const owner = join(root, 'barebrowse-1-1'); // pid 1 belongs to root: kill(1, 0) -> EPERM
      mkdirSync(owner);
      const lockDir = join(root, `barebrowse-${dead}-1`); // dead owner, lock names pid 1
      mkdirSync(lockDir);
      symlinkSync(`${hostname()}-1`, join(lockDir, 'SingletonLock'));
      sweepStaleProfiles(root);
      assert.ok(existsSync(owner), 'EPERM owner pid kept');
      assert.ok(existsSync(lockDir), 'EPERM lock pid kept');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
