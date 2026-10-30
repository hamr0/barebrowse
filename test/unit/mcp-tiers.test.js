/**
 * MCP tool hints (annotations) + access tiers (BAREBROWSE_TIER r|rw|rwx) +
 * site lock config (BAREBROWSE_ALLOW). Bad config must refuse to start, never
 * fall back to rwx / no lock.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOLS, TOOL_TIER, parseTier, toolTier } from '../../mcp-server.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '../../mcp-server.js');
const RANK = { r: 0, rw: 1, rwx: 2 };

// Spawn the server, send requests, resolve once every id has a response.
function rpc(requests, env = {}) {
  const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BAREBROWSE_MCP_EVAL: '1', ...env } });
  const want = new Set(requests.map((r) => r.id));
  const got = {};
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { proc.kill(); reject(new Error('no complete response within 8s')); }, 8000);
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (want.has(m.id)) { got[m.id] = m; want.delete(m.id); }
        if (!want.size) { clearTimeout(deadline); proc.kill(); resolve(got); }
      }
    });
    proc.on('error', reject);
    for (const r of requests) proc.stdin.write(JSON.stringify(r) + '\n');
  });
}
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const list = (id) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
const init = (id) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2024-11-05' } });

// Run the server and capture how it exits (for refuse-to-start cases).
function startExit(env) {
  const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve) => {
    const t = setTimeout(() => { proc.kill(); resolve({ code: 'running', err }); }, 4000);
    proc.on('exit', (code) => { clearTimeout(t); resolve({ code, err }); });
  });
}

describe('tool annotations + tier map', () => {
  const all = [...TOOLS.map((t) => t.name), 'eval', 'assess'];

  it('every tool has annotations and an explicit tier', () => {
    for (const t of TOOLS) {
      assert.ok(t.annotations && typeof t.annotations.readOnlyHint === 'boolean', `${t.name} annotations`);
      assert.ok(TOOL_TIER[t.name], `${t.name} tier`);
    }
    for (const name of all) assert.ok(TOOL_TIER[name], `${name} in tier map`);
  });

  it('tier r  <=>  readOnlyHint true', () => {
    for (const t of TOOLS) assert.equal(TOOL_TIER[t.name] === 'r', t.annotations.readOnlyHint === true, t.name);
  });

  it('the tier table: reads, interactions, upload/eval', () => {
    for (const n of ['browse', 'goto', 'back', 'forward', 'reload', 'scroll', 'snapshot', 'readable', 'screenshot', 'pdf', 'wait_for', 'tabs', 'capabilities']) assert.equal(TOOL_TIER[n], 'r', n);
    for (const n of ['click', 'type', 'press', 'select', 'drag', 'hover', 'switch_engine']) assert.equal(TOOL_TIER[n], 'rw', n);
    for (const n of ['upload', 'eval']) assert.equal(TOOL_TIER[n], 'rwx', n);
  });

  it('destructive/open-world/idempotent hints follow the plan', () => {
    const by = Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations]));
    for (const n of ['click', 'type', 'press', 'select', 'drag', 'upload']) assert.equal(by[n].destructiveHint, true, n);
    for (const n of ['hover', 'switch_engine']) assert.equal(by[n].destructiveHint, false, n);
    for (const t of TOOLS) assert.equal(t.annotations.openWorldHint, t.name === 'capabilities' ? false : true, t.name);
    for (const n of ['snapshot', 'readable', 'screenshot', 'pdf', 'tabs', 'capabilities', 'wait_for']) assert.equal(by[n].idempotentHint, true, n);
    for (const n of ['goto', 'back', 'click']) assert.equal(by[n].idempotentHint, undefined, n);
  });

  it('an unknown tool is treated as rwx (default-deny)', () => {
    assert.equal(toolTier('brand_new_tool'), 'rwx');
  });

  it('parseTier: unset = rwx, valid values pass, anything else throws', () => {
    assert.equal(parseTier(undefined), 'rwx');
    assert.equal(parseTier(''), 'rwx');
    for (const t of ['r', 'rw', 'rwx']) assert.equal(parseTier(t), t);
    for (const bad of ['R', 'ro', 'RWX', 'wx', ' r', 'admin']) assert.throws(() => parseTier(bad), /BAREBROWSE_TIER/, bad);
  });
});

describe('tools/list and tools/call per tier', () => {
  const namesFor = async (tier) => {
    const got = await rpc([list(1)], tier ? { BAREBROWSE_TIER: tier } : {});
    return got[1].result.tools;
  };

  it('default (unset) lists everything, annotations included, even at protocol 2024-11-05', async () => {
    const tools = await namesFor();
    assert.ok(tools.find((t) => t.name === 'eval'));
    assert.ok(tools.find((t) => t.name === 'upload'));
    assert.equal(tools.find((t) => t.name === 'snapshot').annotations.readOnlyHint, true);
  });

  for (const tier of ['r', 'rw', 'rwx']) {
    it(`tier ${tier}: lists exactly the tools at or below it`, async () => {
      const tools = await namesFor(tier);
      assert.ok(tools.length > 0);
      for (const t of tools) assert.ok(RANK[toolTier(t.name)] <= RANK[tier], `${t.name} above tier ${tier}`);
      for (const t of TOOLS) if (RANK[toolTier(t.name)] <= RANK[tier]) assert.ok(tools.find((x) => x.name === t.name), `${t.name} listed`);
    });
  }

  it('tier r: every listed tool is readOnly', async () => {
    for (const t of await namesFor('r')) assert.equal(t.annotations.readOnlyHint, true, t.name);
  });

  it('a hidden tool call is refused exactly like an unknown tool', async () => {
    const got = await rpc([call(1, 'click', { ref: '1' }), call(2, 'no_such_tool'), call(3, 'eval', { expression: '1' })], { BAREBROWSE_TIER: 'r' });
    assert.equal(got[1].result.isError, true);
    assert.equal(got[1].result.content[0].text, 'Error: Unknown tool: click');
    assert.equal(got[2].result.content[0].text, 'Error: Unknown tool: no_such_tool');
    assert.equal(got[3].result.content[0].text, 'Error: Unknown tool: eval');
  });

  it('tier rw hides upload and eval but not click', async () => {
    const got = await rpc([call(1, 'upload', { ref: '1', files: [] }), call(2, 'eval', { expression: '1' })], { BAREBROWSE_TIER: 'rw' });
    assert.equal(got[1].result.content[0].text, 'Error: Unknown tool: upload');
    assert.equal(got[2].result.content[0].text, 'Error: Unknown tool: eval');
  });

  it('capabilities and initialize.instructions report tier and allowHosts', async () => {
    const env = { BAREBROWSE_TIER: 'r', BAREBROWSE_ALLOW: 'Example.com, *.docs.example.org' };
    const got = await rpc([init(1), call(2, 'capabilities')], env);
    const info = JSON.parse(got[2].result.content[0].text);
    assert.equal(info.tier, 'r');
    assert.deepEqual(info.allowHosts, ['example.com', '*.docs.example.org']);
    assert.match(got[1].result.instructions, /read-only/i);
    assert.match(got[1].result.instructions, /example\.com/);
  });

  it('defaults: tier rwx, allowHosts null, no extra instructions sentence', async () => {
    const got = await rpc([init(1), call(2, 'capabilities')]);
    const info = JSON.parse(got[2].result.content[0].text);
    assert.equal(info.tier, 'rwx');
    assert.equal(info.allowHosts, null);
    assert.ok(!/read-only|restricted to/i.test(got[1].result.instructions));
  });
});

describe('fail closed on bad config', () => {
  for (const [name, env, re] of [
    ['invalid tier R', { BAREBROWSE_TIER: 'R' }, /BAREBROWSE_TIER/],
    ['invalid tier ro', { BAREBROWSE_TIER: 'ro' }, /BAREBROWSE_TIER/],
    ['allow entry with scheme', { BAREBROWSE_ALLOW: 'https://a.com' }, /BAREBROWSE_ALLOW/],
    ['allow entry with port', { BAREBROWSE_ALLOW: 'a.com:8080' }, /BAREBROWSE_ALLOW/],
    ['allow bare wildcard', { BAREBROWSE_ALLOW: '*' }, /BAREBROWSE_ALLOW/],
    ['allow empty entry', { BAREBROWSE_ALLOW: 'a.com,,b.com' }, /BAREBROWSE_ALLOW/],
  ]) {
    it(`${name}: exits non-zero with a stderr message`, async () => {
      const { code, err } = await startExit(env);
      assert.ok(typeof code === 'number' && code !== 0, `exit code ${code}`);
      assert.match(err, re);
    });
  }
});
