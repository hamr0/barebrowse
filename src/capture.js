/**
 * capture.js -- console + network log capture for a connect() page.
 * Shared by the CLI daemon and the MCP server: both push into caller-owned
 * arrays so the logs belong to the page's session.
 */

/**
 * Wire Firefox/BiDi console + network capture onto the daemon's log arrays.
 * The BiDi analogue of the CDP `Runtime.consoleAPICalled` / `Network.*`
 * capture — measured event shapes: `log.entryAdded` carries {method, level,
 * args:[{type,value}], text}; the network events key in-flight requests by
 * `request.request` and expose `response.{status,statusText,mimeType}` /
 * top-level `errorText`. Pure + exported so the shape mapping (warn→warning
 * normalization, arg extraction, orphan-safe response/error pairing) is
 * unit-testable against a fake bidi without launching Firefox.
 *
 * @param {object} bidi - BiDi client (async .subscribe(), .on(method, cb))
 * @param {object} sinks
 * @param {Array} sinks.consoleLogs - push-target for console entries
 * @param {Array} sinks.networkLogs - push-target for completed/failed requests
 * @param {Map} sinks.pendingRequests - in-flight request bookkeeping
 * @returns {Promise<void>}
 */
export async function attachBiDiCapture(bidi, { consoleLogs, networkLogs, pendingRequests }) {
  await bidi.subscribe([
    'log.entryAdded',
    'network.beforeRequestSent',
    'network.responseCompleted',
    'network.fetchError',
  ]);

  bidi.on('log.entryAdded', (e) => {
    consoleLogs.push({
      // Map BiDi's console method (or level for uncaught JS errors) to CDP's
      // `type` vocabulary so `console-logs --level warning` matches on both
      // engines — BiDi says 'warn', CDP says 'warning'.
      type: e.method === 'warn' ? 'warning' : (e.method || e.level),
      timestamp: new Date().toISOString(),
      // Primitive args carry a usable `.value`; objects/arrays/functions carry a
      // nested {type,value} serialization we must NOT splat into the log (it's
      // deep junk) — fall back to the type name, mirroring the CDP capture which
      // logs a RemoteObject's `.description` ("Object") for non-primitives.
      args: Array.isArray(e.args) && e.args.length
        ? e.args.map((a) => (a.value !== undefined && typeof a.value !== 'object' ? a.value : a.type))
        : [e.text],
    });
  });

  bidi.on('network.beforeRequestSent', (e) => {
    pendingRequests.set(e.request.request, {
      url: e.request.url,
      method: e.request.method,
      timestamp: new Date().toISOString(),
    });
  });

  bidi.on('network.responseCompleted', (e) => {
    const req = pendingRequests.get(e.request.request);
    if (req) {
      networkLogs.push({
        ...req,
        status: e.response.status,
        statusText: e.response.statusText,
        mimeType: e.response.mimeType,
      });
      pendingRequests.delete(e.request.request);
    }
  });

  bidi.on('network.fetchError', (e) => {
    const req = pendingRequests.get(e.request.request);
    if (req) {
      networkLogs.push({ ...req, status: 0, error: e.errorText });
      pendingRequests.delete(e.request.request);
    }
  });
}

const wired = new WeakSet();

/**
 * Wire console + network capture onto a page (CDP or BiDi) and push into the
 * caller's sinks.
 *
 * @param {object} page - connect() page (has .cdp or .bidi)
 * @param {object} sinks
 * @param {Array} sinks.consoleLogs
 * @param {Array} sinks.networkLogs
 * @param {Map} sinks.pendingRequests
 * @returns {Promise<void>}
 */
export async function attachCapture(page, { consoleLogs, networkLogs, pendingRequests }) {
  // A hybrid headed relaunch swaps in a new CDP/BiDi client with no listeners.
  // Callers re-run this after goto(); a client already wired is skipped.
  const client = page.cdp || page.bidi;
  if (!client || wired.has(client)) return;
  wired.add(client);
  if (page.cdp) {
    await page.cdp.send('Runtime.enable');
    page.cdp.on('Runtime.consoleAPICalled', (params) => {
      consoleLogs.push({
        type: params.type,
        timestamp: new Date().toISOString(),
        args: params.args.map((a) => a.value ?? a.description ?? a.type),
      });
    });

    // Uncaught errors and unhandled rejections never reach consoleAPICalled.
    // Same shape Firefox logs: {type:'error', args:['Error: boom']}.
    page.cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
      consoleLogs.push({
        type: 'error',
        timestamp: new Date().toISOString(),
        args: [(d.exception?.description || d.text || 'Uncaught').split('\n')[0]],
      });
    });

    // Network log capture (Network.enable already called by connect)
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
        networkLogs.push({ ...req, status: 0, error: params.errorText });
        pendingRequests.delete(params.requestId);
      }
    });
  } else if (page.bidi) {
    await attachBiDiCapture(page.bidi, { consoleLogs, networkLogs, pendingRequests });
  }
}

/**
 * One text line per entry, oldest first. Over `maxChars` the NEWEST entries
 * are kept and the dropped count is stated; a newest entry over `maxChars` is truncated.
 *
 * @param {'console'|'network'} kind
 * @param {Array} entries
 * @param {{level?: string, failed?: boolean, maxChars?: number}} [o]
 * @returns {string}
 */
export function formatLogs(kind, entries, { level, failed, maxChars = 30000 } = {}) {
  let rows = entries;
  if (kind === 'console' && level) rows = rows.filter((l) => l.type === level);
  if (kind === 'network' && failed) rows = rows.filter((l) => l.status === 0 || l.status >= 400);
  if (!rows.length) return `no ${kind} entries`;
  const lines = rows.map((l) => kind === 'console'
    ? `[${l.type}] ${l.args.join(' ')}`
    : `${l.status} ${l.method} ${l.url}${l.error ? ` ${l.error}` : ''}`);
  let kept = lines.length;
  let size = 0;
  while (kept > 0 && size + lines[kept - 1].length + 1 <= maxChars) size += lines[--kept].length + 1;
  const shown = lines.slice(kept);
  // The newest entry alone exceeds maxChars: show its start rather than nothing.
  if (!shown.length) {
    const last = lines[lines.length - 1];
    shown.push(`${last.slice(0, maxChars)} …[truncated, ${last.length - maxChars} more chars]`);
    kept--;
  }
  const dropped = kept;
  return (dropped ? `[${dropped} older entries dropped, over maxChars ${maxChars}]\n` : '') + shown.join('\n');
}
