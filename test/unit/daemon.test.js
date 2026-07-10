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
import { buildDaemonArgs } from '../../src/daemon.js';

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
