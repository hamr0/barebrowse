/**
 * MCP and CLI settle once before the first snapshot after a goto: a page that
 * fetches content just after load is complete in that first snapshot. The
 * library's own goto/snapshot timing is unchanged (not covered here).
 * Both engines.
 *
 * Run: node --test test/integration/settle.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findFirefox } from '../../src/firefox.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PAGE = `<!doctype html><title>t</title><main><h1>Feed</h1><button>First</button></main>
<script>addEventListener('load', () => setTimeout(() => fetch('/late').then((r) => r.text()).then((t) => {
  const b = document.createElement('button'); b.textContent = t; document.querySelector('main').append(b);
}), 1000));</script>`;

async function serve() {
  const srv = createServer((q, res) => {
    if (q.url === '/late') return setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Late arrival'); }, 300);
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv;
}

let hasFirefox = false;
try { findFirefox(); hasFirefox = true; } catch { /* skip below */ }

for (const engine of ['chromium', 'firefox']) {
  describe(`first snapshot after goto settles — ${engine}`, { skip: engine === 'firefox' && !hasFirefox && 'no Firefox installed' }, () => {
    it('MCP: the first snapshot holds content a page fetches just after load', async () => {
      const srv = await serve();
      const cwd = mkdtempSync(join(tmpdir(), 'bb-'));
      const proc = spawn(process.execPath, [join(ROOT, 'mcp-server.js')], {
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
        assert.match(await call('snapshot'), /Late arrival/, 'first snapshot after goto');
      } finally { proc.kill('SIGKILL'); srv.close(); rmSync(cwd, { recursive: true, force: true }); }
    });

    it('CLI: the first snapshot holds content a page fetches just after load', async () => {
      const srv = await serve();
      const dir = mkdtempSync(join(tmpdir(), 'bb-cli-'));
      const run = (args) => new Promise((res, rej) => {
        execFile(process.execPath, [join(ROOT, 'cli.js'), ...args], { timeout: 60000, encoding: 'utf8', cwd: dir },
          (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout.trim())));
      });
      try {
        await run(['open', 'about:blank', `--engine=${engine}`, '--mode=headless', '--incognito']);
        assert.equal(await run(['goto', `http://127.0.0.1:${srv.address().port}/`]), 'ok');
        assert.match(readFileSync((await run(['snapshot'])).split('\n')[0], 'utf8'), /Late arrival/, 'first snapshot after goto');
      } finally {
        await run(['close']).catch(() => {});
        srv.close(); rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
