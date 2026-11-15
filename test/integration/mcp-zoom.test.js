/**
 * MCP end-to-end: the snapshot tool's map + zoom. A snapshot over maxChars
 * returns the page map inline and still saves the full snapshot to a file;
 * full:true gives the path alone; within zooms; map:true returns the map.
 * Both engines.
 *
 * Run: node --test test/integration/mcp-zoom.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findFirefox } from '../../src/firefox.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '../../mcp-server.js');
const items = Array.from({ length: 40 }, (_, i) => `<li><a href="/p${i}">product number ${i} with a long name</a></li>`).join('');
const PAGE = `<!doctype html><title>t</title><header><a href="/">Home</a></header><main><h1>Shop</h1><h2>Results</h2><ul>${items}</ul><h2>Related</h2><ul><li><a href="/r">related one</a></li></ul></main><footer><a href="/t">Terms</a></footer>`;

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

for (const engine of ['chromium', 'firefox']) {
  describe(`MCP snapshot map + zoom — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    it('over maxChars: map inline + full file; full:true: path only; within zooms; map:true', async () => {
      const srv = createServer((q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const cwd = mkdtempSync(join(tmpdir(), 'bb-'));
      const proc = spawn(process.execPath, [SERVER], {
        cwd, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, BAREBROWSE_ENGINE: engine, BAREBROWSE_MODE: 'headless', BAREBROWSE_INCOGNITO: '1', BAREBROWSE_ALLOW: 'localhost' },
      });
      let buf = '';
      const waiters = new Map();
      proc.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          waiters.get(m.id)?.(m);
        }
      });
      let nextId = 1;
      const call = (name, args = {}) => new Promise((resolve, reject) => {
        const id = nextId++;
        const t = setTimeout(() => reject(new Error(`${name}: no response`)), 60000);
        waiters.set(id, (m) => { clearTimeout(t); resolve(m.result.content[0].text); });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      });
      try {
        assert.match(await call('goto', { url: `http://localhost:${srv.address().port}/` }), /^ok/);
        assert.match(await call('snapshot'), /product number 3 /, 'under the cap: content inline, no map');

        const over = await call('snapshot', { maxChars: 500 });
        const file = over.match(/saved to (\S+\.yml)/)?.[1];
        assert.ok(file && existsSync(file), 'full snapshot saved:\n' + over.slice(0, 300));
        assert.ok(readFileSync(file, 'utf8').includes('product number 39'), 'the file holds the full snapshot');
        assert.match(over, /map: \d+ boxes/);
        assert.match(over, /list after "Results" \[ref=\d+\]/);
        assert.ok(!over.includes('product number 3 '), 'the inline answer is the map, not the content');

        const path = await call('snapshot', { maxChars: 500, full: true });
        assert.match(path, /^Snapshot \(\d+ chars\) saved to \S+$/, 'full:true keeps the old path-only answer');

        const ref = over.match(/list after "Results" \[ref=(\d+)\]/)[1];
        const zoom = await call('snapshot', { within: Number(ref) });
        assert.ok(zoom.includes('product number 3 ') && !zoom.includes('Terms') && !zoom.includes('related one'), zoom.slice(0, 300));
        const named = await call('snapshot', { within: ['list after "Related"', 'list after "Results"'], pruneMode: 'read' });
        assert.ok(named.indexOf('product number 3 ') < named.indexOf('related one'), 'several boxes, page order');
        assert.match(await call('snapshot', { map: true }), /^url: [^\n]+\nmap: \d+ boxes/);
        assert.match(await call('snapshot', { within: 'table "Nope"' }), /nothing matches table "Nope"/);
      } finally {
        proc.kill('SIGKILL'); srv.close(); rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
}
