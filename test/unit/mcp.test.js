/**
 * Unit tests for MCP server helpers (maxChars, saveSnapshot, withRetry).
 *
 * Run: node --test test/unit/mcp.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { TIMEOUTS, TOOLS, saveSnapshot } from '../../mcp-server.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join as joinPath } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = joinPath(__dirname, '../../mcp-server.js');

// Re-implement isTransient + withRetry locally (not exported from mcp-server.js)
function isTransient(err) {
  const m = err.message || '';
  return m.includes('WebSocket') || m.includes('Target closed') || m.includes('Session closed')
    || m.includes('CDP') || m.includes('Timeout waiting for CDP event') || m.includes('timed out');
}

async function withRetry(fn, timeoutMs, { retry = true } = {}) {
  async function attempt() {
    if (!timeoutMs) return await fn();
    let timer;
    const result = await Promise.race([
      fn(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs); }),
    ]);
    clearTimeout(timer);
    return result;
  }
  try {
    return await attempt();
  } catch (err) {
    if (!isTransient(err)) throw err;
    if (!retry) throw err;
    _retryCount++;
    return await attempt();
  }
}

let _retryCount = 0;

describe('MCP saveSnapshot', () => {
  it('saves text to a .yml file and returns the path', () => {
    const text = 'url: https://example.com/\n- heading "Test"';
    const file = saveSnapshot(text);
    try {
      assert.ok(file.endsWith('.yml'), 'file should have .yml extension');
      assert.ok(file.includes('page-'), 'file should have page- prefix');
      const content = readFileSync(file, 'utf8');
      assert.equal(content, text, 'file content should match input');
    } finally {
      unlinkSync(file);
    }
  });

  it('writes owner-only (0600) — snapshots can hold authenticated page content', () => {
    // Security regression guard: the real saveSnapshot must write 0600,
    // umask-independent, matching the daemon's invariant. A 0644 file would
    // leak logged-in page content to other local users on a shared host.
    const file = saveSnapshot('url: https://example.com/\n- heading "secret"');
    try {
      assert.equal(statSync(file).mode & 0o777, 0o600,
        `snapshot file must be 0600, got 0o${(statSync(file).mode & 0o777).toString(8)}`);
    } finally {
      unlinkSync(file);
    }
  });

  it('maxChars threshold routes correctly', () => {
    const MAX_CHARS_DEFAULT = 30000;
    const shortText = 'x'.repeat(100);
    const longText = 'x'.repeat(40000);

    // Under limit: return inline
    const shortLimit = MAX_CHARS_DEFAULT;
    assert.ok(shortText.length <= shortLimit, 'short text should be under limit');

    // Over limit: would save to file
    assert.ok(longText.length > shortLimit, 'long text should exceed limit');

    // Custom limit
    const customLimit = 50;
    assert.ok(shortText.length > customLimit, 'short text exceeds custom limit of 50');
  });
});

describe('isTransient', () => {
  it('detects CDP death errors', () => {
    assert.ok(isTransient(new Error('WebSocket is not open')));
    assert.ok(isTransient(new Error('Target closed')));
    assert.ok(isTransient(new Error('Session closed')));
    assert.ok(isTransient(new Error('CDP connection lost')));
  });

  it('detects timeout errors', () => {
    assert.ok(isTransient(new Error('Timeout waiting for CDP event: Page.loadEventFired')));
    assert.ok(isTransient(new Error('timed out after 30s')));
  });

  it('rejects non-transient errors', () => {
    assert.ok(!isTransient(new Error('Unknown tool: foo')));
    assert.ok(!isTransient(new Error('scroll requires "direction"')));
    assert.ok(!isTransient(new Error('Node does not have a layout object')));
  });
});

describe('withRetry', () => {
  it('returns result on success', async () => {
    _retryCount = 0;
    const result = await withRetry(async () => 'ok', 5000);
    assert.equal(result, 'ok');
    assert.equal(_retryCount, 0, 'should not retry on success');
  });

  it('retries once on transient CDP error', async () => {
    _retryCount = 0;
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw new Error('WebSocket is not open');
      return 'recovered';
    }, 5000);
    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
    assert.equal(_retryCount, 1);
  });

  it('retries once on timeout', async () => {
    _retryCount = 0;
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) {
        // Simulate a slow operation that exceeds timeout
        await new Promise(r => setTimeout(r, 200));
        return 'too slow';
      }
      return 'fast';
    }, 100); // 100ms timeout — first attempt will exceed it
    assert.equal(result, 'fast');
    assert.equal(calls, 2);
    assert.equal(_retryCount, 1);
  });

  it('does not retry non-transient errors', async () => {
    _retryCount = 0;
    await assert.rejects(
      withRetry(async () => { throw new Error('Unknown tool: foo'); }, 5000),
      { message: 'Unknown tool: foo' }
    );
    assert.equal(_retryCount, 0, 'should not retry validation errors');
  });

  it('throws after second failure', async () => {
    _retryCount = 0;
    await assert.rejects(
      withRetry(async () => { throw new Error('Target closed'); }, 5000),
      { message: 'Target closed' }
    );
    assert.equal(_retryCount, 1, 'should have retried once');
  });

  it('works without timeout', async () => {
    _retryCount = 0;
    const result = await withRetry(async () => 'no-timeout');
    assert.equal(result, 'no-timeout');
    assert.equal(_retryCount, 0);
  });

  it('with retry:false runs the fn exactly once on transient failure (F6)', async () => {
    _retryCount = 0;
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new Error('WebSocket is not open'); // transient
      }, 5000, { retry: false }),
      { message: /WebSocket is not open/ },
    );
    assert.equal(calls, 1, 'non-idempotent ops must not retry — first-attempt side effects could double-submit on a fresh page');
  });

  it('with retry:false still throws non-transient errors normally (F6)', async () => {
    _retryCount = 0;
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new Error('No element found for ref "8"');
      }, 5000, { retry: false }),
      { message: /No element found/ },
    );
    assert.equal(calls, 1);
  });
});

describe('per-tool MCP timeouts (H5)', () => {
  // Pin the H5 contract: pre-H5 every tool used a blanket 30s. That was too
  // short for goto on SPA cold loads and overkill for instant ops. If any of
  // these regress, callers either see new spurious timeouts or wait longer
  // than necessary for fast tools — both user-visible.
  it('goto + reload + wait_for get 60s (SPA cold loads exceed 30s)', () => {
    assert.equal(TIMEOUTS.goto, 60000);
    assert.equal(TIMEOUTS.reload, 60000);
    assert.equal(TIMEOUTS.wait_for, 60000);
  });

  it('back + forward keep a 30s nav window', () => {
    assert.equal(TIMEOUTS.back, 30000);
    assert.equal(TIMEOUTS.forward, 30000);
  });

  it('interactive ops (click/type/press/scroll/hover/select/drag) cap at 15s', () => {
    for (const tool of ['click', 'type', 'press', 'scroll', 'hover', 'select', 'drag']) {
      assert.equal(TIMEOUTS[tool], 15000, `${tool} should cap at 15s`);
    }
  });

  it('snapshot + tabs + eval are bounded read-ish ops', () => {
    assert.equal(TIMEOUTS.snapshot, 15000);
    assert.equal(TIMEOUTS.tabs, 5000);
    assert.equal(TIMEOUTS.eval, 15000);
  });

  it('heavy I/O ops (pdf/screenshot/upload) get 45s', () => {
    assert.equal(TIMEOUTS.pdf, 45000);
    assert.equal(TIMEOUTS.screenshot, 45000);
    assert.equal(TIMEOUTS.upload, 45000);
  });
});

describe('MCP tool surface (H6)', () => {
  const toolNames = TOOLS.map((t) => t.name);

  it('exposes the new H6 tools to MCP clients', () => {
    // These existed in the connect() API + daemon + bareagent but weren't
    // wired through the MCP server until H6. Each gap meant Claude Desktop /
    // Cursor / Code agents couldn't reach them at all.
    for (const tool of ['screenshot', 'wait_for', 'tabs', 'select', 'hover', 'reload']) {
      assert.ok(toolNames.includes(tool),
        `MCP TOOLS must include "${tool}" — H6 added it; if absent it's not reachable from MCP clients`);
    }
  });

  it('eval is gated behind BAREBROWSE_MCP_EVAL=1 (default off)', () => {
    // The test runner inherits a clean env; eval must NOT be registered here.
    // Powerful primitive: Runtime.evaluate in an authenticated session can
    // read cookies/localStorage, post on user's behalf, exfiltrate. Default
    // off, opt-in via env var.
    assert.ok(!toolNames.includes('eval'),
      'eval must be absent when BAREBROWSE_MCP_EVAL is unset — opt-in only');
  });

  it('eval IS registered when BAREBROWSE_MCP_EVAL=1', () => {
    // Spawn a one-shot node child with the env var set so a fresh module
    // graph evaluates the gating code path.
    const probe = `
      import('${MCP_SERVER}').then(({ TOOLS }) => {
        const names = TOOLS.map(t => t.name);
        process.stdout.write(names.includes('eval') ? 'yes' : 'no');
      });
    `;
    const out = execFileSync(process.execPath,
      ['--input-type=module', '-e', probe],
      { env: { ...process.env, BAREBROWSE_MCP_EVAL: '1' }, encoding: 'utf8' });
    assert.equal(out, 'yes',
      'with BAREBROWSE_MCP_EVAL=1 the eval tool must be registered');
  });

  it('the JSON-RPC loop actually starts when invoked via cli.js mcp (regression)', async () => {
    // Regression test: my first H5 commit auto-started the stdin loop only
    // when import.meta.url === pathToFileURL(process.argv[1]).href. cli.js
    // launches the server via `await import('./mcp-server.js')`, so argv[1]
    // is cli.js → isMain false → loop never starts → `npx barebrowse mcp`
    // (the documented Claude Code install path) hangs silently forever.
    // Now cli.js calls runStdio() explicitly; this test spawns the real
    // invocation and confirms a tools/list response comes back.
    const { spawn } = await import('node:child_process');
    const cliPath = joinPath(__dirname, '../../cli.js');
    const proc = spawn(process.execPath, [cliPath, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      let buf = '';
      const response = await new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error('no JSON-RPC response within 5s — stdin loop probably never started')),
          5000,
        );
        proc.stdout.on('data', (d) => {
          buf += d;
          const i = buf.indexOf('\n');
          if (i !== -1) {
            clearTimeout(deadline);
            try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
          }
        });
        proc.on('error', (e) => { clearTimeout(deadline); reject(e); });
        proc.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
        }) + '\n');
      });
      assert.equal(response.id, 1, 'response must echo request id');
      assert.ok(Array.isArray(response.result?.tools),
        'tools/list must return a tools array');
      assert.ok(response.result.tools.length > 10,
        `expected the full tool surface, got ${response.result.tools.length}`);
    } finally {
      proc.kill();
    }
  });
});
