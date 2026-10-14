import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanOld } from '../../src/output-clean.js';

const TS = '2026-01-01T10-00-00-000Z';
const OURS = [`page-${TS}.yml`, `page-${TS}.pdf`, `screenshot-${TS}.png`, `screenshot-${TS}.jpeg`,
  `screenshot-${TS}.webp`, `article-${TS}.txt`, `console-${TS}.json`, `network-${TS}.json`, `dialogs-${TS}.json`];
const KEEP = ['session.json', `state-${TS}.json`, 'state-x.json', 'notes.txt', 'page-mine.md'];

test('cleanOld removes only old barebrowse outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-clean-'));
  try {
    const now = Date.now();
    const old = new Date(now - 8 * 86400000);
    const fresh = new Date(now - 1 * 86400000);
    for (const n of [...OURS, ...KEEP]) {
      writeFileSync(join(dir, n), 'x');
      utimesSync(join(dir, n), old, old);
    }
    const freshName = `page-2026-02-02T10-00-00-000Z.yml`;
    writeFileSync(join(dir, freshName), 'x');
    utimesSync(join(dir, freshName), fresh, fresh);
    mkdirSync(join(dir, `page-${TS}.yml.d`));
    mkdirSync(join(dir, `page-sub.yml`));
    utimesSync(join(dir, `page-sub.yml`), old, old);

    assert.equal(cleanOld(dir, 7, now), undefined);

    for (const n of OURS) assert.equal(existsSync(join(dir, n)), false, `${n} should be removed`);
    for (const n of [...KEEP, freshName, 'page-sub.yml']) assert.equal(existsSync(join(dir, n)), true, `${n} should survive`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanOld on a missing dir is a no-op', () => {
  assert.doesNotThrow(() => cleanOld(join(tmpdir(), 'bb-clean-does-not-exist-xyz')));
});
