/**
 * Integration tests for the CLI session (daemon-based).
 * Requires Chromium installed: sudo dnf install chromium
 *
 * Run: node --test test/integration/cli.test.js
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';

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

describe('CLI session', () => {
  // Use a temp directory so tests don't pollute the project
  const tmpDir = mkdtempSync(join(tmpdir(), 'barebrowse-cli-test-'));
  const sessionDir = join(tmpDir, '.barebrowse');

  after(() => {
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

  it('snapshot creates a .yml file', () => {
    const out = cli(['snapshot'], { cwd: tmpDir });
    assert.ok(out.endsWith('.yml'), `expected .yml path, got: ${out}`);
    assert.ok(existsSync(out), 'snapshot file should exist');
    // about:blank is empty after pruning — just verify file was created
  });

  it('goto navigates and snapshot shows new page content', () => {
    const out = cli(['goto', 'https://example.com'], { cwd: tmpDir, timeout: 60000 });
    assert.ok(out === 'ok', `expected ok, got: ${out}`);

    // Snapshot should now show example.com
    const snapOut = cli(['snapshot'], { cwd: tmpDir });
    const content = readFileSync(snapOut, 'utf8');
    assert.ok(content.includes('Example Domain'), 'should show example.com content');
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

  it('reload subcommand round-trips through daemon (H3 via CLI)', () => {
    // Daemon was opened on about:blank — reload should be a no-op success.
    // Tests the new `reload` daemon handler + cli subcommand end-to-end.
    const out = cli(['reload'], { cwd: tmpDir });
    assert.equal(out, 'ok', `reload should print ok, got: ${out}`);
    const outNoCache = cli(['reload', '--no-cache'], { cwd: tmpDir });
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
    // tests don't hit this because they use about:blank / example.com.
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
