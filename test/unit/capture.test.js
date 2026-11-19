/**
 * attachCapture (CDP) — console capture must include uncaught errors and
 * unhandled rejections (Runtime.exceptionThrown), matching Firefox's shape.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachCapture } from '../../src/capture.js';

function fakeCdp() {
  const handlers = new Map();
  return {
    sent: [],
    async send(m) { this.sent.push(m); },
    on(method, h) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(h);
    },
    emit(method, params) { for (const h of handlers.get(method) || []) h(params); },
  };
}
const sinks = () => ({ consoleLogs: [], networkLogs: [], pendingRequests: new Map() });

describe('attachCapture — Chromium uncaught errors (N47)', () => {
  it('logs Runtime.exceptionThrown as {type:error, args:[first description line]}', async () => {
    const cdp = fakeCdp();
    const s = sinks();
    await attachCapture({ cdp }, s);
    cdp.emit('Runtime.exceptionThrown', {
      timestamp: 1,
      exceptionDetails: {
        text: 'Uncaught',
        exception: { type: 'object', description: 'Error: boom\n    at http://x/:1:7' },
      },
    });
    assert.equal(s.consoleLogs.length, 1);
    assert.equal(s.consoleLogs[0].type, 'error');
    assert.deepEqual(s.consoleLogs[0].args, ['Error: boom']);
    assert.ok(s.consoleLogs[0].timestamp);
  });

  it('falls back to exceptionDetails.text when there is no exception object', async () => {
    const cdp = fakeCdp();
    const s = sinks();
    await attachCapture({ cdp }, s);
    cdp.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught SyntaxError: x' } });
    assert.deepEqual(s.consoleLogs[0].args, ['Uncaught SyntaxError: x']);
  });

  it('still logs console API calls', async () => {
    const cdp = fakeCdp();
    const s = sinks();
    await attachCapture({ cdp }, s);
    cdp.emit('Runtime.consoleAPICalled', { type: 'warning', args: [{ value: 'careful' }] });
    assert.deepEqual(s.consoleLogs.map((l) => [l.type, l.args]), [['warning', ['careful']]]);
  });
});
