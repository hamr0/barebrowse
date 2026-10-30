/**
 * MCP end-to-end with BAREBROWSE_TIER=r BAREBROWSE_ALLOW=localhost: reads work
 * on the allowed host, an off-site goto is refused (NAV_BLOCKED) and never
 * reaches the server, and write tools are not callable.
 *
 * Run: node --test test/integration/mcp-tiers.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '../../mcp-server.js');

describe('MCP tier r + BAREBROWSE_ALLOW=localhost', () => {
  it('reads on-site, refuses off-site and write tools', async () => {
    const hits = [];
    const srv = createServer((q, res) => {
      hits.push(`${q.headers.host.split(':')[0]}${q.url}`);
      const port = srv.address().port;
      if (q.url === '/redir') { res.writeHead(302, { Location: `http://127.0.0.1:${port}/target` }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>t</title><main><h1>Hello lock</h1><button>Go</button></main>');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const proc = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BAREBROWSE_TIER: 'r', BAREBROWSE_ALLOW: 'localhost', BAREBROWSE_MODE: 'headless', BAREBROWSE_INCOGNITO: '1' },
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
      assert.match(await call('goto', { url: `http://localhost:${port}/` }), /^ok/);
      assert.match(await call('snapshot'), /Hello lock/);
      const off = await call('goto', { url: `http://127.0.0.1:${port}/target` });
      assert.match(off, /NAV_BLOCKED|blocked: 127\.0\.0\.1 is not in allowHosts/);
      const redir = await call('goto', { url: `http://localhost:${port}/redir` });
      assert.match(redir, /blocked: 127\.0\.0\.1 is not in allowHosts/);
      assert.equal(hits.filter((h) => h.startsWith('127.0.0.1') && h.includes('/target')).length, 0);
      assert.match(await call('snapshot'), /Hello lock/, 'page unchanged after the blocked goto');
      assert.equal(await call('click', { ref: '1' }), 'Error: Unknown tool: click');
      assert.equal(await call('eval', { expression: '1' }), 'Error: Unknown tool: eval');
    } finally {
      proc.kill();
      await new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); });
    }
  });
});
