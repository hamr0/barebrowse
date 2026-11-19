/**
 * attachCapture (CDP) — console capture must include uncaught errors and
 * unhandled rejections (Runtime.exceptionThrown), matching Firefox's shape.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachCapture, formatLogs } from '../../src/capture.js';

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

describe('attachCapture — client swap (hybrid relaunch)', () => {
  it('skips a client already wired, wires a new one into the same sinks', async () => {
    const a = fakeCdp();
    const s = sinks();
    const page = { cdp: a };
    await attachCapture(page, s);
    await attachCapture(page, s); // same client: no second listener
    a.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'one' }] });
    assert.equal(s.consoleLogs.length, 1);

    const b = fakeCdp(); // relaunch: new client, no listeners
    page.cdp = b;
    await attachCapture(page, s);
    b.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'two' }] });
    assert.deepEqual(s.consoleLogs.map((l) => l.args[0]), ['one', 'two']);
  });
});

describe('formatLogs', () => {
  const con = [
    { type: 'error', args: ['Error: boom'] },
    { type: 'warning', args: ['careful', 2] },
  ];
  const net = [
    { status: 200, method: 'GET', url: 'http://a/ok' },
    { status: 404, method: 'GET', url: 'http://127.0.0.1:3000/nope' },
    { status: 0, method: 'GET', url: 'http://x/y', error: 'net::ERR_FAILED' },
  ];

  it('console: one line per entry, oldest first, level filter', () => {
    assert.equal(formatLogs('console', con), '[error] Error: boom\n[warning] careful 2');
    assert.equal(formatLogs('console', con, { level: 'warning' }), '[warning] careful 2');
  });

  it('network: status line, failed filter, error text', () => {
    assert.equal(formatLogs('network', net, { failed: true }),
      '404 GET http://127.0.0.1:3000/nope\n0 GET http://x/y net::ERR_FAILED');
    assert.equal(formatLogs('network', net).split('\n').length, 3);
  });

  it('empty says so', () => {
    assert.equal(formatLogs('console', []), 'no console entries');
    assert.equal(formatLogs('network', net, { failed: true }).includes('404'), true);
    assert.equal(formatLogs('console', con, { level: 'info' }), 'no console entries');
  });

  it('over maxChars keeps the newest and states the dropped count', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ type: 'log', args: [`m${i}`] }));
    const out = formatLogs('console', many, { maxChars: 30 }); // "[log] mN\n" = 9 chars -> 3 fit
    assert.match(out, /^\[7 older entries dropped/);
    assert.ok(out.endsWith('[log] m7\n[log] m8\n[log] m9'));
    assert.ok(!out.includes('m6'));
  });

  it('a newest entry longer than maxChars is truncated, not dropped; older ones are counted', () => {
    const rows = [{ type: 'log', args: ['old'] }, { type: 'error', args: ['x'.repeat(100)] }];
    const out = formatLogs('console', rows, { maxChars: 50 });
    assert.match(out, /^\[1 older entries dropped/);
    assert.ok(out.includes('[error] xxxx'), 'newest entry is shown');
    assert.match(out, /truncated/);
    const only = formatLogs('console', [rows[1]], { maxChars: 50 });
    assert.ok(only.startsWith('[error] xxxx') && !only.includes('dropped'));
  });
});
