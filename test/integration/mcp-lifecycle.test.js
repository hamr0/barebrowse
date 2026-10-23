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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
async function startServer(env = {}, seed) {
  const cwd = mkdtempSync(join(tmpdir(), 'bb-mcp-test-'));
  seed?.(cwd);
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
    // Either engine may be live: switch_engine changes it mid-test.
    for (const b of [...ownedBrowsers(child.pid, 'chromium'), ...ownedBrowsers(child.pid, 'firefox')]) { try { process.kill(b.pid, 'SIGKILL'); } catch {} }
    child.kill('SIGKILL');
    await sleep(300);
    for (const d of profileDirs(child.pid)) rmSync(join('/tmp', d), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  };
  return { pid: child.pid, cwd, call, stop };
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

describe('MCP server autoclean wiring', () => {
  it('runStdio() removes old output files at start, keeps fresh ones and state-*.json', async () => {
    const old = new Date(Date.now() - 10 * 86400000);
    const stamp = (d) => d.toISOString().replace(/[:.]/g, '-');
    const names = {
      old: 'page-2025-01-01T00-00-00-000Z.yml',
      fresh: `page-${stamp(new Date())}.yml`,
      state: 'state-2025-01-01T00-00-00-000Z.json',
    };
    const s = await startServer({}, (cwd) => {
      const dir = join(cwd, '.barebrowse');
      mkdirSync(dir);
      for (const n of Object.values(names)) writeFileSync(join(dir, n), 'x');
      for (const n of [names.old, names.state]) utimesSync(join(dir, n), old, old);
    });
    cleanups.push(s.stop);
    // startServer returns after the initialize response, which follows runStdio()'s cleanOld.
    const dir = join(s.cwd, '.barebrowse');
    assert.equal(existsSync(join(dir, names.old)), false, 'old page file removed');
    assert.equal(existsSync(join(dir, names.fresh)), true, 'fresh page file kept');
    assert.equal(existsSync(join(dir, names.state)), true, 'state file kept');
  });
});

describe('MCP server browser lifecycle', () => {
  it('a transient error closes the old browser instead of orphaning it', async () => {
    const s = await boot();
    assert.equal((await s.call('goto', { url: siteUrl })).isError, false);
    const [old] = ownedBrowsers(s.pid);
    assert.ok(old, 'one browser running');
    assert.equal(profileDirs(s.pid).length, 1);

    // A real transient: the browser dies, the next call hits a dead CDP socket -> session reset.
    process.kill(old.pid, 'SIGKILL');
    await s.call('snapshot', {});

    // Next call runs on a fresh browser; the old one and its profile dir must be gone.
    await s.call('goto', { url: siteUrl });
    const snap = await s.call('snapshot', {});
    assert.equal(snap.isError, false, snap.text);
    // close() is fire-and-forget and bounded (~2.5s) on a dead socket: poll.
    for (let i = 0; i < 40 && profileDirs(s.pid).length > 1; i++) await sleep(250);
    const now = ownedBrowsers(s.pid);
    assert.equal(now.length, 1);
    assert.notEqual(now[0].pid, old.pid);
    assert.equal(profileDirs(s.pid).length, 1, 'old profile dir removed');
    assert.ok(!ps().some((r) => r.pid === old.pid), 'old browser process gone');
  });

  it('an ordinary wait_for timeout keeps the page and browser', async () => {
    const s = await boot();
    assert.equal((await s.call('goto', { url: siteUrl })).isError, false);
    const [before] = ownedBrowsers(s.pid);

    const w = await s.call('wait_for', { text: 'never-appears', timeout: 500 });
    assert.equal(w.isError, true);

    const snap = await s.call('snapshot', {});
    assert.equal(snap.isError, false, snap.text);
    assert.match(snap.text, /hello|lifecycle fixture/i); // not about:blank
    const after = ownedBrowsers(s.pid);
    assert.equal(after.length, 1);
    assert.equal(after[0].pid, before.pid, 'same browser');
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

describe('MCP capabilities cookies field', () => {
  const caps = async (s) => JSON.parse((await s.call('capabilities', {})).text);

  it('is null before a goto, reports the last injection after, null again after idle release', async () => {
    const s = await boot(IDLE);
    assert.equal((await caps(s)).cookies, null);
    assert.equal((await s.call('goto', { url: siteUrl })).isError, false);
    const c = (await caps(s)).cookies;
    assert.equal(c.url, siteUrl);
    assert.equal(typeof c.injected, 'number');
    assert.ok(Array.isArray(c.cookies) && c.cookies.length === c.injected);
    for (const e of c.cookies) assert.match(e, /^.+ @ .+\//); // 'name @ domain/path', no value
    await sleep(6000);
    assert.equal((await caps(s)).cookies, null, 'released browser leaves no stale report');
  });

  it('says so under incognito', async () => {
    const s = await boot({ BAREBROWSE_INCOGNITO: '1' });
    assert.equal((await s.call('goto', { url: siteUrl })).isError, false);
    assert.deepEqual((await caps(s)).cookies, { url: siteUrl, injected: 0, incognito: true });
  });
});

describe('MCP switch_engine', { skip: hasFirefox ? false : 'firefox not installed' }, () => {
  const caps = async (s) => JSON.parse((await s.call('capabilities', {})).text);
  const gone = async (pid) => { for (let i = 0; i < 40 && ps().some((r) => r.pid === pid); i++) await sleep(250); return !ps().some((r) => r.pid === pid); };

  it('swaps chromium -> firefox -> chromium; the old browser exits and the new one browses', async () => {
    const s = await boot();
    assert.equal((await s.call('goto', { url: siteUrl })).isError, false);
    assert.equal((await caps(s)).activeEngine, 'chromium');
    const [chromium] = ownedBrowsers(s.pid);
    assert.ok(chromium, 'chromium running');

    const sw = await s.call('switch_engine', { engine: 'firefox' });
    assert.equal(sw.isError, false, sw.text);
    assert.match(sw.text, /switched to firefox/);
    const c = await caps(s);
    assert.equal(c.activeEngine, 'firefox');
    assert.equal(c.connected, false, 'new browser launches lazily');
    assert.ok(await gone(chromium.pid), 'old chromium process gone');

    assert.equal((await s.call('goto', { url: siteUrl })).isError, false);
    const snap = await s.call('snapshot', {});
    assert.equal(snap.isError, false, snap.text);
    assert.match(snap.text, /lifecycle fixture/);
    assert.equal(ownedBrowsers(s.pid, 'firefox').length, 1);
    assert.equal((await caps(s)).cookies.url, siteUrl);

    const [ff] = ownedBrowsers(s.pid, 'firefox');
    assert.equal((await s.call('switch_engine', { engine: 'chromium' })).isError, false);
    assert.ok(await gone(ff.pid), 'old firefox process gone');
    assert.equal((await caps(s)).activeEngine, 'chromium');
    assert.equal((await s.call('goto', { url: siteUrl })).isError, false);
    assert.equal(ownedBrowsers(s.pid).length, 1);
  });

  it('the same engine is a no-op that leaves the browser alone', async () => {
    const s = await boot();
    await s.call('goto', { url: siteUrl });
    const [before] = ownedBrowsers(s.pid);
    const sw = await s.call('switch_engine', { engine: 'chromium' });
    assert.equal(sw.isError, false);
    assert.match(sw.text, /already on chromium/);
    assert.equal(ownedBrowsers(s.pid)[0].pid, before.pid);
    assert.equal((await s.call('switch_engine', { engine: 'netscape' })).isError, true);
  });

  it('a switch during a launch in flight closes that browser instead of leaking it', async () => {
    const s = await boot();
    const first = s.call('goto', { url: siteUrl }); // starts the chromium launch
    await sleep(150);
    const sw = await s.call('switch_engine', { engine: 'firefox' });
    assert.equal(sw.isError, false, sw.text);
    await first; // the call may fail or retry on the new engine; the chromium it launched must not survive
    for (let i = 0; i < 40 && (ownedBrowsers(s.pid).length || profileDirs(s.pid).length); i++) await sleep(250);
    assert.equal(ownedBrowsers(s.pid).length, 0, 'stale chromium closed');
    assert.deepEqual(profileDirs(s.pid), [], 'stale profile dir removed');
    assert.equal((await caps(s)).activeEngine, 'firefox');
    assert.equal((await s.call('goto', { url: siteUrl })).isError, false);
    assert.equal(ownedBrowsers(s.pid, 'firefox').length, 1);
    assert.equal(ownedBrowsers(s.pid).length, 0, 'still no chromium');
  });
});
