/**
 * Unit tests for the daemon child-arg contract (buildDaemonArgs).
 *
 * Regression guard for the v0.15.0 bug where `--incognito` was never forwarded
 * to the detached daemon child, so `barebrowse open <url> --incognito` silently
 * ran a fully-authenticated session. A dropped forward here is now a red test,
 * not a silent auth leak.
 *
 * Run: node --test test/unit/daemon.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDaemonArgs, attachBiDiCapture } from '../../src/daemon.js';

const CLI = '/x/cli.js';

describe('buildDaemonArgs', () => {
  it('forwards --incognito when opts.incognito is set', () => {
    const args = buildDaemonArgs({ incognito: true }, '/out', undefined, CLI);
    assert.ok(args.includes('--incognito'), 'incognito must reach the daemon child');
  });

  it('omits --incognito when not set (default authenticated session)', () => {
    const args = buildDaemonArgs({}, '/out', undefined, CLI);
    assert.ok(!args.includes('--incognito'), 'no incognito flag by default');
  });

  it('forwards --no-cookies (the sibling auth-suppression flag)', () => {
    const args = buildDaemonArgs({ cookies: false }, '/out', undefined, CLI);
    assert.ok(args.includes('--no-cookies'));
  });

  it('carries the core plumbing: cli path, daemon-internal, output dir, url', () => {
    const args = buildDaemonArgs({ engine: 'firefox', mode: 'headed' }, '/out', 'https://e.com', CLI);
    assert.equal(args[0], CLI);
    assert.ok(args.includes('--daemon-internal'));
    assert.deepEqual(args.slice(args.indexOf('--output-dir'), args.indexOf('--output-dir') + 2), ['--output-dir', '/out']);
    assert.deepEqual(args.slice(args.indexOf('--url'), args.indexOf('--url') + 2), ['--url', 'https://e.com']);
    assert.deepEqual(args.slice(args.indexOf('--engine'), args.indexOf('--engine') + 2), ['--engine', 'firefox']);
  });
});

/**
 * Firefox/BiDi console + network capture (Phase 2). Fake bidi whose emit()
 * replays the exact event shapes measured against real Firefox
 * (log.entryAdded / network.beforeRequestSent / responseCompleted /
 * fetchError). Guards the mapping: warn→warning normalization, arg
 * extraction, response/error pairing, and orphan safety.
 */
function fakeBiDi() {
  const handlers = new Map();
  return {
    subscribed: [],
    async subscribe(events) { this.subscribed.push(...events); },
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method)?.delete(handler);
    },
    emit(method, params) {
      const set = handlers.get(method);
      if (set) for (const h of [...set]) h(params);
    },
  };
}

describe('attachBiDiCapture — Firefox console/network log capture', () => {
  it('subscribes the console + network events', async () => {
    const bidi = fakeBiDi();
    await attachBiDiCapture(bidi, { consoleLogs: [], networkLogs: [], pendingRequests: new Map() });
    assert.deepEqual(bidi.subscribed, [
      'log.entryAdded',
      'network.beforeRequestSent',
      'network.responseCompleted',
      'network.fetchError',
    ]);
  });

  it('normalizes console levels and extracts arg values (warn→warning)', async () => {
    const bidi = fakeBiDi();
    const consoleLogs = [];
    await attachBiDiCapture(bidi, { consoleLogs, networkLogs: [], pendingRequests: new Map() });

    bidi.emit('log.entryAdded', {
      type: 'console', method: 'warn', level: 'warn',
      args: [{ type: 'string', value: 'hi' }, { type: 'number', value: 42 }],
      text: 'hi 42',
    });
    bidi.emit('log.entryAdded', {
      type: 'console', method: 'log', level: 'info',
      args: [{ type: 'string', value: 'plain' }], text: 'plain',
    });
    // Uncaught JS error: no console method, args often absent → fall back to level + text.
    bidi.emit('log.entryAdded', { type: 'javascript', level: 'error', text: 'ReferenceError: x' });

    assert.equal(consoleLogs[0].type, 'warning', 'BiDi warn maps to CDP warning');
    assert.deepEqual(consoleLogs[0].args, ['hi', 42]);
    assert.equal(consoleLogs[1].type, 'log');
    assert.deepEqual(consoleLogs[1].args, ['plain']);
    assert.equal(consoleLogs[2].type, 'error', 'javascript entry uses level');
    assert.deepEqual(consoleLogs[2].args, ['ReferenceError: x'], 'no args → [text]');
  });

  it('pairs responseCompleted with its pending request', async () => {
    const bidi = fakeBiDi();
    const networkLogs = [];
    const pendingRequests = new Map();
    await attachBiDiCapture(bidi, { consoleLogs: [], networkLogs, pendingRequests });

    bidi.emit('network.beforeRequestSent', { request: { request: 'r1', url: 'http://e.com/', method: 'GET' } });
    assert.equal(pendingRequests.size, 1, 'request tracked in flight');
    bidi.emit('network.responseCompleted', {
      request: { request: 'r1' },
      response: { status: 200, statusText: 'OK', mimeType: 'text/html' },
    });

    assert.equal(networkLogs.length, 1);
    assert.deepEqual(networkLogs[0], {
      url: 'http://e.com/', method: 'GET', timestamp: networkLogs[0].timestamp,
      status: 200, statusText: 'OK', mimeType: 'text/html',
    });
    assert.equal(pendingRequests.size, 0, 'completed request cleared');
  });

  it('records fetchError as status 0 + errorText', async () => {
    const bidi = fakeBiDi();
    const networkLogs = [];
    const pendingRequests = new Map();
    await attachBiDiCapture(bidi, { consoleLogs: [], networkLogs, pendingRequests });

    bidi.emit('network.beforeRequestSent', { request: { request: 'bad', url: 'http://nope.invalid/', method: 'GET' } });
    bidi.emit('network.fetchError', { request: { request: 'bad' }, errorText: 'NS_ERROR_UNKNOWN_HOST' });

    assert.equal(networkLogs.length, 1);
    assert.equal(networkLogs[0].status, 0);
    assert.equal(networkLogs[0].error, 'NS_ERROR_UNKNOWN_HOST');
  });

  it('ignores orphan responses with no matching pending request', async () => {
    const bidi = fakeBiDi();
    const networkLogs = [];
    await attachBiDiCapture(bidi, { consoleLogs: [], networkLogs, pendingRequests: new Map() });
    // response for a request whose start we never saw — must not push a log.
    bidi.emit('network.responseCompleted', { request: { request: 'ghost' }, response: { status: 200 } });
    bidi.emit('network.fetchError', { request: { request: 'ghost2' }, errorText: 'x' });
    assert.equal(networkLogs.length, 0);
  });
});
