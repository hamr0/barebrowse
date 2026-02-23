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
import { mkdtempSync } from 'node:fs';

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
