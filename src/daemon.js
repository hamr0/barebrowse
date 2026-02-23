/**
 * daemon.js -- Background HTTP server holding a connect() session.
 *
 * startDaemon()  — spawn a detached child process running the daemon
 * runDaemon()    — the actual HTTP server (called via --daemon-internal)
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect } from './index.js';

const SESSION_FILE = 'session.json';

/**
 * Spawn a detached child process that runs the daemon.
 * Parent polls for session.json, then exits.
 */
export async function startDaemon(opts, outputDir, initialUrl) {
  const absDir = resolve(outputDir);
  mkdirSync(absDir, { recursive: true });

  // Clean stale session
  const sessionPath = join(absDir, SESSION_FILE);
  if (existsSync(sessionPath)) unlinkSync(sessionPath);

  // Build child args
  const args = [join(import.meta.dirname, '..', 'cli.js'), '--daemon-internal'];
  args.push('--output-dir', absDir);
  if (initialUrl) args.push('--url', initialUrl);
  if (opts.mode) args.push('--mode', opts.mode);
  if (opts.port) args.push('--port', String(opts.port));
  if (opts.cookies === false) args.push('--no-cookies');
  if (opts.browser) args.push('--browser', opts.browser);
  if (opts.timeout) args.push('--timeout', String(opts.timeout));
  if (opts.pruneMode) args.push('--prune-mode', opts.pruneMode);
  if (opts.consent === false) args.push('--no-consent');

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  // Poll for session.json (50ms interval, 15s timeout)
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (existsSync(sessionPath)) {
      try {
        const data = JSON.parse(readFileSync(sessionPath, 'utf8'));
        if (data.port && data.pid) return data;
      } catch { /* partial write, retry */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Daemon failed to start within 15s');
}

/**
 * Run the daemon HTTP server. Called by cli.js --daemon-internal.
 * Holds a connect() session and serves commands over HTTP.
 */
export async function runDaemon(opts, outputDir, initialUrl) {
  const absDir = resolve(outputDir);
  mkdirSync(absDir, { recursive: true });

  // Connect to browser
  const page = await connect({
    mode: opts.mode || 'headless',
    port: opts.port ? Number(opts.port) : undefined,
    consent: opts.consent,
  });

  // Console log capture
  const consoleLogs = [];
  await page.cdp.send('Runtime.enable');
  page.cdp.on('Runtime.consoleAPICalled', (params) => {
    consoleLogs.push({
      type: params.type,
      timestamp: new Date().toISOString(),
      args: params.args.map((a) => a.value ?? a.description ?? a.type),
    });
  });

  // Network log capture (Network.enable already called by connect)
  const networkLogs = [];
  const pendingRequests = new Map();

  page.cdp.on('Network.requestWillBeSent', (params) => {
    pendingRequests.set(params.requestId, {
      url: params.request.url,
      method: params.request.method,
      timestamp: new Date().toISOString(),
    });
  });

  page.cdp.on('Network.responseReceived', (params) => {
    const req = pendingRequests.get(params.requestId);
    if (req) {
      networkLogs.push({
        ...req,
        status: params.response.status,
        statusText: params.response.statusText,
        mimeType: params.response.mimeType,
      });
      pendingRequests.delete(params.requestId);
    }
  });

  page.cdp.on('Network.loadingFailed', (params) => {
    const req = pendingRequests.get(params.requestId);
    if (req) {
      networkLogs.push({
        ...req,
        status: 0,
        error: params.errorText,
      });
      pendingRequests.delete(params.requestId);
    }
  });

  // Navigate to initial URL if provided
  if (initialUrl) {
    if (opts.cookies !== false) {
      try { await page.injectCookies(initialUrl, { browser: opts.browser }); } catch { /* no cookies */ }
    }
    await page.goto(initialUrl, opts.timeout ? Number(opts.timeout) : 30000);
  }

  // Default prune mode
  const defaultPruneMode = opts.pruneMode || 'act';

  // Command handlers
  const handlers = {
    async goto({ url, timeout }) {
      await page.goto(url, timeout || 30000);
      return { ok: true };
    },

    async snapshot({ mode }) {
      const pruneMode = mode || defaultPruneMode;
      const text = await page.snapshot({ mode: pruneMode });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(absDir, `page-${ts}.yml`);
      writeFileSync(file, text);
      return { ok: true, file };
    },

    async screenshot({ format }) {
      const data = await page.screenshot({ format: format || 'png' });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const ext = format || 'png';
      const file = join(absDir, `screenshot-${ts}.${ext}`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      return { ok: true, file };
    },

    async click({ ref }) {
      await page.click(String(ref));
      return { ok: true };
    },

    async type({ ref, text, clear }) {
      await page.type(String(ref), text, clear ? { clear: true } : undefined);
      return { ok: true };
    },

    async fill({ ref, text }) {
      await page.type(String(ref), text, { clear: true });
      return { ok: true };
    },

    async press({ key }) {
      await page.press(key);
      return { ok: true };
    },

    async scroll({ deltaY }) {
      await page.scroll(Number(deltaY));
      return { ok: true };
    },

    async hover({ ref }) {
      await page.hover(String(ref));
      return { ok: true };
    },

    async select({ ref, value }) {
      await page.select(String(ref), value);
      return { ok: true };
    },

    async eval({ expression }) {
      const result = await page.cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        return { ok: false, error: result.exceptionDetails.text || 'eval error' };
      }
      return { ok: true, value: result.result.value };
    },

    async 'wait-idle'({ timeout }) {
      await page.waitForNetworkIdle({ timeout: timeout || 30000 });
      return { ok: true };
    },

    async 'wait-nav'({ timeout }) {
      await page.waitForNavigation(timeout || 30000);
      return { ok: true };
    },

    async 'console-logs'({ level, clear }) {
      let logs = consoleLogs;
      if (level) logs = logs.filter((l) => l.type === level);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(absDir, `console-${ts}.json`);
      writeFileSync(file, JSON.stringify(logs, null, 2));
      if (clear) consoleLogs.length = 0;
      return { ok: true, file, count: logs.length };
    },

    async 'network-log'({ failed }) {
      let logs = networkLogs;
      if (failed) logs = logs.filter((l) => l.status === 0 || l.status >= 400);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(absDir, `network-${ts}.json`);
      writeFileSync(file, JSON.stringify(logs, null, 2));
      return { ok: true, file, count: logs.length };
    },

    async close() {
      await page.close();
      // Clean up session file
      const sessionPath = join(absDir, SESSION_FILE);
      if (existsSync(sessionPath)) unlinkSync(sessionPath);
      // Respond before exiting
      return { ok: true };
    },

    async status() {
      return { ok: true, pid: process.pid, uptime: process.uptime() };
    },
  };

  // Start HTTP server on random port
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/command') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      return;
    }

    const { command, args } = parsed;
    const handler = handlers[command];
    if (!handler) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Unknown command: ${command}` }));
      return;
    }

    try {
      const result = await handler(args || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));

      // Exit after close command
      if (command === 'close') {
        server.close();
        process.exit(0);
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const port = server.address().port;

  // Write session.json so parent/clients can find us
  const sessionPath = join(absDir, SESSION_FILE);
  writeFileSync(sessionPath, JSON.stringify({
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }));

  // Handle SIGTERM gracefully
  process.on('SIGTERM', async () => {
    try { await page.close(); } catch { /* already closed */ }
    if (existsSync(sessionPath)) unlinkSync(sessionPath);
    server.close();
    process.exit(0);
  });
}
