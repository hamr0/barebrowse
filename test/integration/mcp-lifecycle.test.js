/**
 * Integration tests for the MCP server's browser lifecycle: a transient error
 * must close the browser it forgets (not orphan it), and an idle server must
 * release its browser. Spawns the real `node mcp-server.js` over stdio.
 *
 * Run: node --test test/integration/mcp-lifecycle.test.js
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mcp-server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps() {
  return execFileSync('ps', ['-eo', 'pid=,ppid=,args=']).toString().split('\n').filter(Boolean)
    .map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], args: m[3] }; })
    .filter(Boolean);
}

/** Main browser processes (not renderer/GPU helpers) owned by a server. */
function ownedBrowsers(serverPid, engine = 'chromium') {
  const rows = ps();
  if (engine === 'firefox') {
    // Firefox profile dirs carry no pid: take descendants of the server instead.
    const kids = new Set([serverPid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const r of rows) if (kids.has(r.ppid) && !kids.has(r.pid)) { kids.add(r.pid); grew = true; }
    }
    return rows.filter((r) => kids.has(r.pid) && r.args.includes('/barebrowse-ff-') && !r.args.includes('-contentproc'));
  }
  return rows.filter((r) => r.args.includes(`--user-data-dir=/tmp/barebrowse-${serverPid}-`) && !r.args.includes('--type='));
}

function profileDirs(serverPid) {
  return readdirSync('/tmp').filter((d) => d.startsWith(`barebrowse-${serverPid}-`));
}

/** Spawn the MCP server in a fresh cwd; returns a JSON-RPC `call` helper + cleanup. */
async function startServer(env = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'bb-mcp-test-'));
  // TMPDIR inside cwd: download/Firefox-profile temp dirs land there and go with it.
  mkdirSync(join(cwd, 'tmp'));
  const child = spawn('node', [SERVER], {
    cwd, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, BAREBROWSE_MODE: 'headless', TMPDIR: join(cwd, 'tmp'), ...env },
  });
  const pending = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg); pending.delete(msg.id);
    }
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { isError: !!r.result?.isError, text: r.result?.content?.[0]?.text ?? '' };
  };
  const stop = async () => {
    for (const b of ownedBrowsers(child.pid, env.BAREBROWSE_ENGINE)) { try { process.kill(b.pid, 'SIGKILL'); } catch {} }
    child.kill('SIGKILL');
    await sleep(300);
    for (const d of profileDirs(child.pid)) rmSync(join('/tmp', d), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  };
  return { pid: child.pid, call, stop };
}

let site;
let siteUrl;
const cleanups = [];
async function withSite() {
  if (site) return;
  site = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    // /late adds the awaited text after ~5s (a call that outlives the idle TTL).
    res.end(req.url === '/late'
      ? '<h1>late</h1><script>setTimeout(()=>{document.body.append("arrived-late")},5000)</script>'
      : '<h1>lifecycle fixture</h1><p>hello</p>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
}

after(async () => {
  for (const c of cleanups) await c();
  site?.close();
});

async function boot(env) {
  await withSite();
  const s = await startServer(env);
  cleanups.push(s.stop);
  return s;
}

describe('MCP server browser lifecycle', () => {
  it('a transient error closes the old browser instead of orphaning it', async () => {
    const s = await boot();
    assert.equal((await s.call('goto', { url: siteUrl })).isError, false);
    assert.equal(ownedBrowsers(s.pid).length, 1);

    // "waitFor timed out" counts as transient -> session reset.
    const w = await s.call('wait_for', { text: 'never-appears', timeout: 500 });
    assert.equal(w.isError, true);

    // Next call opens a fresh browser; the old one must be gone.
    await s.call('goto', { url: siteUrl });
    const snap = await s.call('snapshot', {});
    assert.match(snap.text, /lifecycle fixture|\.yml|ok/i);
    await sleep(1500); // close() is fire-and-forget
    assert.equal(ownedBrowsers(s.pid).length, 1);
  });
});

// BAREBROWSE_IDLE_MINUTES=0.05 -> 3s TTL.
const IDLE = { BAREBROWSE_IDLE_MINUTES: '0.05' };
let hasFirefox = true;
try { execFileSync('which', ['firefox']); } catch { hasFirefox = false; }

async function idleReleases(env, engine) {
  const s = await boot({ ...IDLE, ...env });
  assert.equal((await s.call('goto', { url: siteUrl })).isError, false);
  assert.equal(ownedBrowsers(s.pid, engine).length, 1);

  await sleep(6000);
  assert.equal(ownedBrowsers(s.pid, engine).length, 0);
  if (engine !== 'firefox') assert.deepEqual(profileDirs(s.pid), []);

  // Next call is a new job: a fresh browser opens transparently.
  assert.equal((await s.call('goto', { url: siteUrl })).isError, false);
  const snap = await s.call('snapshot', {});
  assert.equal(snap.isError, false);
  assert.equal(ownedBrowsers(s.pid, engine).length, 1);
}

describe('MCP server idle TTL', () => {
  it('releases the browser after the idle TTL and reopens on the next call', async () => {
    await idleReleases({});
  });

  it('does not cut off a call that outlasts the TTL', async () => {
    const s = await boot(IDLE);
    await s.call('goto', { url: `${siteUrl}/late` });
    const w = await s.call('wait_for', { text: 'arrived-late', timeout: 10000 });
    assert.equal(w.isError, false, w.text);
    assert.equal(ownedBrowsers(s.pid).length, 1);
  });

  it('releases a Firefox browser too', { skip: hasFirefox ? false : 'firefox not installed' }, async () => {
    await idleReleases({ BAREBROWSE_ENGINE: 'firefox' }, 'firefox');
  });
});
