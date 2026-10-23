/**
 * Integration tests for the CLI session (daemon-based).
 * Requires Chromium installed: sudo dnf install chromium
 *
 * Run: node --test test/integration/cli.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { startExamplePage } from '../fixtures/example-page.js';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';

const CLI = resolve(import.meta.dirname, '..', '..', 'cli.js');
const NODE = process.execPath;

function cli(args, opts = {}) {
  return execFileSync(NODE, [CLI, ...args], {
    timeout: 30000,
    encoding: 'utf8',
    cwd: opts.cwd,
    ...opts,
  }).trim();
}

// Async variant: the local page server lives in this process, so the event loop must stay free.
function cliAsync(args, opts = {}) {
  return new Promise((res, rej) => {
    execFile(NODE, [CLI, ...args], { timeout: 30000, encoding: 'utf8', ...opts },
      (err, stdout) => (err ? rej(err) : res(stdout.trim())));
  });
}

describe('CLI session', () => {
  // Use a temp directory so tests don't pollute the project
  const tmpDir = mkdtempSync(join(tmpdir(), 'barebrowse-cli-test-'));
  const sessionDir = join(tmpDir, '.barebrowse');

  let example;
  before(async () => { example = await startExamplePage(); });

  after(async () => {
    await example.close();
    // Ensure daemon is dead
    try { cli(['close'], { cwd: tmpDir }); } catch { /* already closed */ }
    // Clean up
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('open starts a daemon and creates session.json', () => {
    const out = cli(['open', 'about:blank'], { cwd: tmpDir });
    assert.ok(out.includes('Session started'), `expected session started, got: ${out}`);
    assert.ok(existsSync(join(sessionDir, 'session.json')), 'session.json should exist');

    const session = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8'));
    assert.ok(session.port > 0, 'should have a port');
    assert.ok(session.pid > 0, 'should have a pid');
  });

  it('status shows running session', () => {
    const out = cli(['status'], { cwd: tmpDir });
    assert.ok(out.includes('Session running'), `expected running, got: ${out}`);
  });

  it('session.json carries an auth token and is owner-readable only', async () => {
    const { statSync } = await import('node:fs');
    const session = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8'));
    assert.equal(typeof session.token, 'string', 'session should have a token');
    assert.equal(session.token.length, 64, 'token should be 32 random bytes hex');
    const mode = statSync(join(sessionDir, 'session.json')).mode & 0o777;
    assert.equal(mode, 0o600, `session.json should be 0600, got ${mode.toString(8)}`);
  });

  it('daemon rejects /command without the token (no unauthenticated eval)', async () => {
    const session = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8'));
    // No token header — any other local process would be in this position.
    const res = await fetch(`http://127.0.0.1:${session.port}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'eval', args: { expression: '1336+1' } }),
    });
    assert.equal(res.status, 401, 'unauthenticated command must be rejected');
    assert.equal((await res.json()).ok, false);
    // Wrong token is also rejected.
    const res2 = await fetch(`http://127.0.0.1:${session.port}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-barebrowse-token': 'badtoken' },
      body: JSON.stringify({ command: 'status', args: {} }),
    });
    assert.equal(res2.status, 401, 'wrong token must be rejected');
  });

  it('snapshot creates a .yml file', () => {
    const out = cli(['snapshot'], { cwd: tmpDir });
    assert.ok(out.endsWith('.yml'), `expected .yml path, got: ${out}`);
    assert.ok(existsSync(out), 'snapshot file should exist');
    // about:blank is empty after pruning — just verify file was created
  });

  it('readable extracts an article to an .txt file', () => {
    const para = '<p>Web scraping is the automated extraction of data from '
      + 'websites by a bot that downloads pages and parses their content into a '
      + 'structured form, widely used for research and price monitoring.</p>';
    const html = `<html><head><title>CLI Readable Article</title></head><body>`
      + `<nav><a href="/a">Home</a></nav><article><h1>Heading</h1>`
      + para.repeat(8) + `<p>CLI-READABLE-SENTINEL here.</p></article>`
      + `<footer>footer junk</footer></body></html>`;
    cli(['goto', 'data:text/html,' + encodeURIComponent(html)], { cwd: tmpDir, timeout: 60000 });
    const out = cli(['readable'], { cwd: tmpDir });
    assert.ok(out.endsWith('.txt'), `expected .txt path, got: ${out}`);
    const content = readFileSync(out, 'utf8');
    assert.ok(content.includes('title: CLI Readable Article'), 'should carry the title header');
    assert.ok(content.includes('CLI-READABLE-SENTINEL'), 'should include body prose');
    assert.ok(!content.includes('footer junk'), 'should strip footer chrome');
  });

  it('goto navigates and snapshot shows new page content', async () => {
    const out = await cliAsync(['goto', example.url], { cwd: tmpDir, timeout: 60000 });
    assert.ok(out === 'ok', `expected ok, got: ${out}`);

    // Snapshot should now show the example page
    const snapOut = cli(['snapshot'], { cwd: tmpDir });
    const content = readFileSync(snapOut, 'utf8');
    assert.ok(content.includes('Example Domain'), 'should show the new page content');
    assert.ok(content.includes('[ref='), 'should have ref markers');
  });

  it('click sends click command', () => {
    // Get a snapshot first to have valid refs
    const snapOut = cli(['snapshot'], { cwd: tmpDir });
    const content = readFileSync(snapOut, 'utf8');
    // Find a ref in the snapshot
    const refMatch = content.match(/\[ref=(\d+)\]/);
    assert.ok(refMatch, 'snapshot should have refs');

    const out = cli(['click', refMatch[1]], { cwd: tmpDir });
    assert.ok(out === 'ok', `expected ok, got: ${out}`);
  });

  it('eval executes JS and returns result', () => {
    const out = cli(['eval', '1 + 1'], { cwd: tmpDir });
    assert.equal(out, '2');
  });

  it('console-logs creates a .json file', () => {
    // Generate a console log first
    cli(['eval', 'console.log("test-log-message")'], { cwd: tmpDir });
    // Small delay for log capture
    execFileSync('sleep', ['0.5']);

    const out = cli(['console-logs'], { cwd: tmpDir });
    assert.ok(out.includes('.json'), `expected .json path, got: ${out}`);
    const filePath = out.split(' ')[0]; // "path (N entries)"
    assert.ok(existsSync(filePath), 'console log file should exist');
  });

  it('network-log creates a .json file', () => {
    const out = cli(['network-log'], { cwd: tmpDir });
    assert.ok(out.includes('.json'), `expected .json path, got: ${out}`);
  });

  it('reload subcommand round-trips through daemon (H3 via CLI)', async () => {
    // Page is the local example page by now, so reload needs the event loop free (cliAsync).
    // Tests the new `reload` daemon handler + cli subcommand end-to-end.
    const out = await cliAsync(['reload'], { cwd: tmpDir });
    assert.equal(out, 'ok', `reload should print ok, got: ${out}`);
    const outNoCache = await cliAsync(['reload', '--no-cache'], { cwd: tmpDir });
    assert.equal(outNoCache, 'ok', `reload --no-cache should print ok, got: ${outNoCache}`);
  });

  it('downloads subcommand returns the downloads array (H7 via CLI)', () => {
    // No download has been triggered in this test session, so the array
    // should be empty JSON. This pins the wiring — daemon handler exists,
    // cli subcommand exists, cmdProxy serializes the value through.
    const out = cli(['downloads'], { cwd: tmpDir });
    assert.equal(out, '[]', `downloads should print empty JSON array, got: ${out}`);
  });

  it('`bb open --block-urls=PATTERN URL` blocks the matching subresource end-to-end', async () => {
    // End-to-end: cli.js cmdOpen → startDaemon (detached child with spawn
    // args forwarded) → child cli.js --daemon-internal → runDaemon opts →
    // connect({ blockUrls }) → createPage() → Network.setBlockedURLs.
    // Spinning a localhost tracker + page server lets us prove the pattern
    // survives every hop AND the parent's 30s poll deadline.
    //
    // Why this test uses async spawn + await-stdout instead of the synchronous
    // cli() helper: the localhost HTTP servers live in this Node process, so
    // we need the event loop free to serve Chromium's requests. execFileSync
    // (what cli() uses) blocks the loop, the page request stalls, navigation
    // never completes, and the daemon never writes session.json. Other CLI
    // tests don't hit this because they use about:blank / the async-spawned goto.
    const { createServer } = await import('node:http');
    const { spawn } = await import('node:child_process');
    const startSrv = async (handler) => {
      const s = createServer(handler);
      await new Promise((r) => s.listen(0, '127.0.0.1', r));
      return { port: s.address().port, close: () => new Promise((r) => s.close(r)) };
    };
    let trackerHits = 0;
    const tracker = await startSrv((_q, res) => { trackerHits++; res.end('window.__t=1;'); });
    const pageSrv = await startSrv((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><script src="http://127.0.0.1:${tracker.port}/t.js"></script>ok`);
    });
    const subDir = mkdtempSync(join(tmpdir(), 'bb-cli-block-'));

    const openProc = spawn(NODE, [
      CLI, 'open',
      `http://127.0.0.1:${pageSrv.port}/`,
      `--block-urls=*://127.0.0.1:${tracker.port}/*`,
    ], { cwd: subDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    openProc.stdout.on('data', (d) => { stdout += d.toString(); });
    openProc.stderr.on('data', (d) => { stderr += d.toString(); });

    try {
      const exited = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try { openProc.kill(); } catch {}
          reject(new Error(`bb open hung past 45s. stdout: ${stdout}\nstderr: ${stderr}`));
        }, 45000);
        openProc.once('exit', (code) => { clearTimeout(timer); resolve(code); });
        openProc.once('error', (err) => { clearTimeout(timer); reject(err); });
      });
      assert.equal(exited, 0, `bb open exited with ${exited}. stderr: ${stderr}`);
      assert.ok(stdout.includes('Session started'),
        `bb open must accept --block-urls and start the daemon. stdout: ${stdout}`);
      // Daemon writes session.json AFTER page.goto(initialUrl) resolves, so
      // by the time bb open prints "Session started" the navigation is done
      // and any tracker request would have fired (or been blocked).
      assert.equal(trackerHits, 0,
        `--block-urls did not reach connect(): tracker was hit ${trackerHits} times`);
    } finally {
      // close uses cli() (sync), but at this point bb open has exited so
      // there's no in-flight HTTP that needs the test event loop.
      try { cli(['close'], { cwd: subDir }); } catch { /* daemon may have died */ }
      await tracker.close();
      await pageSrv.close();
      rmSync(subDir, { recursive: true, force: true });
    }
  });

  it('close shuts down the daemon', () => {
    const out = cli(['close'], { cwd: tmpDir });
    assert.ok(out.includes('Session closed'), `expected closed, got: ${out}`);
    assert.ok(!existsSync(join(sessionDir, 'session.json')), 'session.json should be removed');
  });

  it('status after close shows no session', () => {
    let threw = false;
    try {
      cli(['status'], { cwd: tmpDir });
    } catch {
      threw = true;
    }
    assert.ok(threw, 'status should exit with non-zero after close');
  });
});

describe('MCP config diagnostics (no daemon)', () => {
  // These exercise barebrowse doctor + install collision detection without
  // touching a real browser. Isolated by running with HOME redirected to a
  // tmpdir so they can't read or modify the developer's actual config.

  it('doctor prints "no scope conflict" on a clean home (MCP-DIAG 3)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'bb-doctor-clean-'));
    try {
      const out = execFileSync(NODE, [CLI, 'doctor'], {
        cwd: fakeHome, encoding: 'utf8', env: { ...process.env, HOME: fakeHome },
      });
      assert.ok(/0 registrations? found/.test(out) || /No conflict/.test(out),
        `clean home should report no conflict, got:\n${out}`);
    } finally {
      try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    }
  });

  it('doctor flags CONFLICT when two scopes point at different endpoints (MCP-DIAG 3)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'bb-doctor-conflict-'));
    try {
      // Plant two entries pointing at different absolute paths — exactly the
      // scenario Claude Code's own warning surfaced for the user.
      writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({
        mcpServers: { barebrowse: { command: 'node', args: ['/path/A/mcp-server.js'] } },
      }));
      writeFileSync(join(fakeHome, '.mcp.json'), JSON.stringify({
        mcpServers: { barebrowse: { command: 'node', args: ['/path/B/mcp-server.js'] } },
      }));
      const out = execFileSync(NODE, [CLI, 'doctor'], {
        cwd: fakeHome, encoding: 'utf8', env: { ...process.env, HOME: fakeHome },
      });
      assert.ok(out.includes('CONFLICT'),
        `divergent endpoints must trigger CONFLICT warning, got:\n${out}`);
      assert.ok(out.includes('/path/A/mcp-server.js') && out.includes('/path/B/mcp-server.js'),
        `output must surface both endpoint paths so the user can pick which to remove, got:\n${out}`);
    } finally {
      try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    }
  });

  it('doctor reports the runtime environment incl. both engines (MCP-DIAG 4)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'bb-doctor-env-'));
    try {
      const out = execFileSync(NODE, [CLI, 'doctor'], {
        cwd: fakeHome, encoding: 'utf8', env: { ...process.env, HOME: fakeHome },
      });
      assert.ok(out.includes('runtime environment'), `missing environment section:\n${out}`);
      assert.ok(/Default engine: chromium/.test(out), `default engine should be chromium:\n${out}`);
      // The Firefox line must appear — its absence was what made a session
      // conclude Firefox wasn't a barebrowse capability at all.
      assert.ok(out.includes('Firefox/BiDi:'), `Firefox engine must be reported:\n${out}`);
      assert.ok(out.includes('Cookie sources:'), `cookie sources must be reported:\n${out}`);
    } finally {
      try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    }
  });

  it('doctor reflects BAREBROWSE_ENGINE=firefox as the default engine (MCP-DIAG 4)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'bb-doctor-ff-'));
    try {
      const out = execFileSync(NODE, [CLI, 'doctor'], {
        cwd: fakeHome, encoding: 'utf8',
        env: { ...process.env, HOME: fakeHome, BAREBROWSE_ENGINE: 'firefox' },
      });
      assert.ok(/Default engine: firefox/.test(out),
        `BAREBROWSE_ENGINE=firefox must be surfaced as the active engine:\n${out}`);
    } finally {
      try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    }
  });

  it('install refuses to clobber a different existing endpoint without --force (MCP-DIAG 2)', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'bb-install-conflict-'));
    try {
      // Pretend Cursor already has a different barebrowse pointing at a
      // worktree path. install() must not silently overwrite — that was
      // exactly how scope conflicts started accumulating.
      const cursorDir = join(fakeHome, '.cursor');
      mkdirSync(cursorDir, { recursive: true });
      const cursorPath = join(cursorDir, 'mcp.json');
      writeFileSync(cursorPath, JSON.stringify({
        mcpServers: { barebrowse: { command: 'node', args: ['/old/path/mcp-server.js'] } },
      }));
      const out = execFileSync(NODE, [CLI, 'install'], {
        cwd: fakeHome, encoding: 'utf8', env: { ...process.env, HOME: fakeHome },
      });
      assert.ok(/CONFLICT/.test(out),
        `install must surface CONFLICT instead of silently overwriting, got:\n${out}`);
      // Existing entry stays untouched without --force
      const after = JSON.parse(readFileSync(cursorPath, 'utf8'));
      assert.deepEqual(after.mcpServers.barebrowse.args, ['/old/path/mcp-server.js'],
        'existing entry must be preserved without --force');

      // With --force, it does overwrite.
      const out2 = execFileSync(NODE, [CLI, 'install', '--force'], {
        cwd: fakeHome, encoding: 'utf8', env: { ...process.env, HOME: fakeHome },
      });
      assert.ok(/REPLACED/.test(out2), `--force must replace, got:\n${out2}`);
      const after2 = JSON.parse(readFileSync(cursorPath, 'utf8'));
      assert.deepEqual(after2.mcpServers.barebrowse, { command: 'npx', args: ['barebrowse', 'mcp'] },
        'with --force the entry should be the canonical npx one');
    } finally {
      try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    }
  });

  it('mcp startup writes a banner to stderr with version + serving path (MCP-DIAG 1)', async () => {
    const { spawn } = await import('node:child_process');
    const proc = spawn(NODE, [CLI, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const banner = await new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error('no stderr banner within 3s — runStdio() probably never started')),
          3000,
        );
        proc.stderr.on('data', (d) => {
          const line = d.toString().split('\n')[0];
          if (line.includes('barebrowse mcp')) {
            clearTimeout(deadline);
            resolve(line);
          }
        });
      });
      assert.ok(/barebrowse mcp v\d+\.\d+\.\d+/.test(banner),
        `banner must include version, got: ${banner}`);
      assert.ok(banner.includes('mcp-server.js'),
        `banner must include the absolute serving path, got: ${banner}`);
      assert.ok(/pid \d+/.test(banner),
        `banner must include pid, got: ${banner}`);
    } finally {
      proc.kill();
    }
  });
});

describe('CLI daemon autoclean wiring', () => {
  it('open removes old output files at daemon start, keeps fresh ones and state-*.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-clean-'));
    const out = join(dir, '.barebrowse');
    const old = new Date(Date.now() - 10 * 86400000);
    const names = {
      old: 'page-2025-01-01T00-00-00-000Z.yml',
      fresh: `page-${new Date().toISOString().replace(/[:.]/g, '-')}.yml`,
      state: 'state-2025-01-01T00-00-00-000Z.json',
    };
    mkdirSync(out);
    for (const n of Object.values(names)) writeFileSync(join(out, n), 'x');
    for (const n of [names.old, names.state]) utimesSync(join(out, n), old, old);
    try {
      cli(['open', 'about:blank'], { cwd: dir });
      assert.equal(existsSync(join(out, names.old)), false, 'old page file removed');
      assert.equal(existsSync(join(out, names.fresh)), true, 'fresh page file kept');
      assert.equal(existsSync(join(out, names.state)), true, 'state file kept');
    } finally {
      try { cli(['close'], { cwd: dir }); } catch { /* not started */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function psRows() {
  return execFileSync('ps', ['-eo', 'pid=,ppid=,args=']).toString().split('\n').filter(Boolean)
    .map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], args: m[3] }; })
    .filter(Boolean);
}

/** Main browser processes (not helpers) of one daemon, by engine. */
function daemonBrowsers(daemonPid, engine) {
  const rows = psRows();
  if (engine === 'firefox') {
    const kids = new Set([daemonPid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const r of rows) if (kids.has(r.ppid) && !kids.has(r.pid)) { kids.add(r.pid); grew = true; }
    }
    return rows.filter((r) => kids.has(r.pid) && r.args.includes('/barebrowse-ff-') && !r.args.includes('-contentproc'));
  }
  return rows.filter((r) => r.args.includes(`--user-data-dir=/tmp/barebrowse-${daemonPid}-`) && !r.args.includes('--type='));
}

let hasFirefoxBin = true;
try { execFileSync('which', ['firefox']); } catch { hasFirefoxBin = false; }

describe('CLI switch-engine', { skip: hasFirefoxBin ? false : 'firefox not installed' }, () => {
  // Short TMPDIR: Chromium aborts on long socket paths.
  const tmp = mkdtempSync('/tmp/bb-sw-');
  const dir = join(tmp, 'w');
  mkdirSync(dir);
  const fakeBin = join(tmp, 'bin');
  const env = { ...process.env, TMPDIR: tmp };
  const run = (args, o = {}) => cliAsync(args, { cwd: dir, env, timeout: 60000, ...o });
  const session = () => JSON.parse(readFileSync(join(dir, '.barebrowse', 'session.json'), 'utf8'));
  const fresh = (what) => readdirSync(join(dir, '.barebrowse')).filter((f) => f.startsWith(what)).sort().pop();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let site;
  let url;

  before(async () => {
    const { createServer } = await import('node:http');
    site = createServer((_q, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<h1>switch fixture</h1><script>console.log("hello-from-new-page")</script>');
    });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${site.address().port}`;
  });
  after(async () => {
    site.close();
    try { await run(['close']); } catch { /* already closed */ }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('swaps the browser in place: same daemon, new engine, capture follows, close leaves nothing', async () => {
    await run(['open', 'about:blank']);
    const before = session();
    assert.equal(before.engine, 'chromium');
    const [chromium] = daemonBrowsers(before.pid, 'chromium');
    assert.ok(chromium, 'chromium running');
    await run(['goto', url]);
    await run(['eval', 'console.log("old-engine-log")']);

    assert.match(await run(['switch-engine', 'firefox']), /switched to firefox/);
    const after = session();
    assert.equal(after.engine, 'firefox');
    for (const k of ['port', 'pid', 'token', 'startedAt']) assert.equal(after[k], before[k], `${k} kept`);
    assert.match(await run(['status']), /Session running/);
    for (let i = 0; i < 40 && psRows().some((r) => r.pid === chromium.pid); i++) await sleep(250);
    assert.ok(!psRows().some((r) => r.pid === chromium.pid), 'old chromium gone');
    assert.equal(daemonBrowsers(before.pid, 'firefox').length, 1, 'firefox running');

    await run(['goto', url]);
    const snap = await run(['snapshot']);
    assert.match(readFileSync(snap, 'utf8'), /switch fixture/);
    await run(['console-logs']);
    const logs = JSON.parse(readFileSync(join(dir, '.barebrowse', fresh('console-')), 'utf8'));
    assert.ok(logs.some((l) => l.args.includes('hello-from-new-page')), 'captures from the new page');
    assert.ok(!logs.some((l) => l.args.includes('old-engine-log')), 'old page logs dropped');
    await run(['network-log']);
    const net = JSON.parse(readFileSync(join(dir, '.barebrowse', fresh('network-')), 'utf8'));
    assert.ok(net.some((n) => n.url.startsWith(url)), 'network captured from the new page');

    assert.match(await run(['switch-engine', 'firefox']), /already on firefox/);
    assert.match(await run(['switch-engine', 'chromium']), /switched to chromium/);
    assert.equal(session().engine, 'chromium');

    await run(['close']);
    await sleep(1500);
    assert.ok(!existsSync(join(dir, '.barebrowse', 'session.json')));
    assert.ok(!psRows().some((r) => r.pid === before.pid), 'daemon gone');
    assert.equal(daemonBrowsers(before.pid, 'chromium').length, 0, 'no chromium left');
    assert.equal(psRows().filter((r) => r.args.includes(tmp) && !r.args.includes('ps -eo')).length, 0, 'no firefox left');
  });

  it('a failed launch of the new engine keeps the old page serving', async () => {
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'firefox'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const e = { ...env, PATH: `${fakeBin}:${process.env.PATH}` };
    await run(['open', 'about:blank'], { env: e });
    await assert.rejects(() => run(['switch-engine', 'firefox'], { env: e }), /Firefox exited/);
    assert.equal(session().engine, 'chromium', 'session.json unchanged');
    await run(['goto', url], { env: e });
    assert.match(readFileSync(await run(['snapshot'], { env: e }), 'utf8'), /switch fixture/);
    await run(['close'], { env: e });
  });
});
