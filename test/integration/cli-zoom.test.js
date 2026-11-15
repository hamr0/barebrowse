/**
 * CLI end-to-end: snapshot --map / --within / --full, and the auto map when a
 * snapshot is over --max-chars. Both engines.
 *
 * Run: node --test test/integration/cli-zoom.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { findFirefox } from '../../src/firefox.js';

const CLI = resolve(import.meta.dirname, '..', '..', 'cli.js');
const items = Array.from({ length: 40 }, (_, i) => `<li><a href="/p${i}">product number ${i} with a long name</a></li>`).join('');
const PAGE = `<!doctype html><title>t</title><header><a href="/">Home</a></header><main><h1>Shop</h1><h2>Results</h2><ul>${items}</ul><h2>Related</h2><ul><li><a href="/r">related one</a></li></ul></main><footer><a href="/t">Terms</a></footer>`;

// The page server lives in this process, so the CLI must run async.
const run = (cwd, args) => new Promise((res, rej) => {
  execFile(process.execPath, [CLI, ...args], { timeout: 60000, encoding: 'utf8', cwd },
    (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout.trim())));
});

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

for (const engine of ['chromium', 'firefox']) {
  describe(`CLI snapshot map + zoom — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    it('--map, --within (one, repeated, by ref), --full and the auto map', async () => {
      const srv = createServer((q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const dir = mkdtempSync(join(tmpdir(), 'bb-cli-'));
      const read = (out) => readFileSync(out.split('\n')[0], 'utf8');
      try {
        await run(dir, ['open', 'about:blank', `--engine=${engine}`, '--mode=headless', '--incognito']);
        assert.equal(await run(dir, ['goto', `http://127.0.0.1:${srv.address().port}/`]), 'ok');

        const plain = await run(dir, ['snapshot']);
        assert.ok(/\.yml$/.test(plain), 'under the cap: the path alone, as before:\n' + plain);

        const map = await run(dir, ['snapshot', '--map']);
        assert.ok(existsSync(map.split('\n')[0]));
        const mapText = read(map);
        assert.match(mapText, /map: \d+ boxes/);
        assert.match(mapText, /list after "Results" \[ref=(\d+)\]/);
        assert.ok(!mapText.includes('product number 3 '));

        const one = read(await run(dir, ['snapshot', '--within=list after "Results"']));
        assert.ok(one.includes('product number 3 ') && !one.includes('Terms') && !one.includes('related one'), one.slice(0, 200));
        const two = read(await run(dir, ['snapshot', '--within', 'list after "Related"', '--within=list after "Results"', '--mode=read']));
        assert.ok(two.indexOf('product number 3 ') < two.indexOf('related one'), 'several boxes, page order');
        const ref = mapText.match(/list after "Results" \[ref=(\d+)\]/)[1];
        assert.ok(read(await run(dir, ['snapshot', `--within=${ref}`])).includes('product number 3 '));
        await assert.rejects(run(dir, ['snapshot', '--within=table "Nope"']), /nothing matches table "Nope"/);

        const over = await run(dir, ['snapshot', '--max-chars=500']);
        const [file, note, ...rest] = over.split('\n');
        assert.ok(readFileSync(file, 'utf8').includes('product number 39'), 'the file is the full snapshot');
        assert.match(note, /here is the map/);
        assert.match(rest.join('\n'), /map: \d+ boxes/);
        assert.ok(!/product number 3 /.test(rest.join('\n')), 'inline is the map');
        assert.match(await run(dir, ['snapshot', '--max-chars=500', '--full']), /^\S+\.yml$/, '--full: the path alone');
      } finally {
        await run(dir, ['close']).catch(() => {});
        srv.close(); rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
