/**
 * N45: the bareagent `hold` tool must clamp the LLM-supplied ms to 0..30000 like
 * the MCP server and the daemon. ms: 3e9 exceeds setTimeout's 2^31 limit, so an
 * unclamped value released the press after ~1ms; clamped it holds 30s. The
 * fixture times mousedown -> mouseup in the page itself.
 *
 * Run: node --test test/integration/bareagent-hold.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createBrowseTools } from '../../src/bareagent.js';

const PAGE = `<!doctype html><title>idle</title><button id=b style="margin:40px;padding:20px">Hold me</button><script>
let t0 = 0; const b = document.getElementById('b');
b.addEventListener('mousedown', () => { t0 = performance.now(); });
b.addEventListener('mouseup', () => { b.textContent = 'held:' + Math.round(performance.now() - t0); });
</script>`;

let srv, base;
before(async () => {
  srv = createServer((q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => new Promise((r) => srv.close(r)));

describe('bareagent hold tool (N45)', () => {
  it('clamps an over-limit ms to 30000', { timeout: 90000 }, async () => {
    const { tools, close } = createBrowseTools({ mode: 'headless' });
    try {
      const by = Object.fromEntries(tools.map((t) => [t.name, t]));
      const snap = await by.goto.execute({ url: base + '/' });
      const ref = /button "Hold me" \[ref=(\d+)\]/.exec(snap)?.[1];
      assert.ok(ref, 'button ref in snapshot:\n' + snap);
      const after = await by.hold.execute({ ref, ms: 3e9 });
      const m = /held:(\d+)/.exec(after) || [];
      assert.ok(Number(m[1]) >= 29500 && Number(m[1]) <= 31500, `page saw ${m[1]}ms between mousedown and mouseup`);
    } finally { await close(); }
  });
});
