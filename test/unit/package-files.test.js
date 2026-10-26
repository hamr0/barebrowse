/**
 * The npm tarball must contain the files cli.js reads at runtime.
 * `install --skill` copies commands/barebrowse/SKILL.md from the package dir;
 * a `files` allowlist without commands/ broke it for every npm install.
 *
 * Run: node --test test/unit/package-files.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

describe('npm package contents', () => {
  it('ships the skill and command files that cli.js install --skill reads', async () => {
    const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: new URL('../..', import.meta.url).pathname });
    const paths = JSON.parse(stdout)[0].files.map((f) => f.path);
    assert.ok(paths.includes('commands/barebrowse/SKILL.md'), 'commands/barebrowse/SKILL.md missing from tarball');
    assert.ok(paths.includes('commands/barebrowse.md'), 'commands/barebrowse.md missing from tarball');
  });
});
