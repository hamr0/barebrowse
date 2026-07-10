/**
 * network-idle.js — wait until the page's network has been idle for N ms.
 *
 * Tracks in-flight requests by requestId in a Set, so an orphan
 * finish/fail event (for a request whose start event arrived before our
 * listener attached) is a harmless no-op instead of driving a counter
 * negative and resolving prematurely.
 *
 * Two engines, one core: `waitForNetworkIdle` wires the CDP `Network.*`
 * events, `waitForNetworkIdleBiDi` wires the WebDriver BiDi `network.*`
 * events. Both feed the same orphan-resilient idle waiter (`idleWaiter`).
 */

/**
 * Shared idle-detection loop. `attach` registers the engine-specific event
 * listeners, calling onStart(id) when a request begins and onEnd(id) when it
 * finishes/fails, and pushing each listener's unsub fn into `unsubs`.
 * @param {object} cfg
 * @param {number} cfg.timeout - Max wait before reject
 * @param {number} cfg.idle - Required quiet duration before resolve
 * @param {(hooks: {onStart: (id:any)=>void, onEnd: (id:any)=>void, unsubs: Array<()=>void>}) => void} cfg.attach
 * @returns {Promise<void>}
 */
function idleWaiter({ timeout, idle, attach }) {
  return new Promise((resolve, reject) => {
    const pending = new Set();
    let timer = null;
    const unsubs = [];

    const done = () => {
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
      for (const unsub of unsubs) unsub();
      resolve();
    };

    const check = () => {
      clearTimeout(timer);
      if (pending.size === 0) {
        timer = setTimeout(done, idle);
      }
    };

    const onStart = (id) => { pending.add(id); clearTimeout(timer); };
    // delete() on a Set is a no-op for unknown keys — orphan finish/fail
    // events from requests started before we attached can't push us negative.
    const onEnd = (id) => { pending.delete(id); check(); };

    attach({ onStart, onEnd, unsubs });

    const deadlineTimer = setTimeout(() => {
      for (const unsub of unsubs) unsub();
      reject(new Error(`waitForNetworkIdle timed out after ${timeout}ms`));
    }, timeout);

    // Start check immediately (might already be idle)
    check();
  });
}

/**
 * CDP: wait for network idle over `Network.*` events.
 * @param {object} session - CDP session-scoped handle with .on() returning unsub
 * @param {object} [opts]
 * @param {number} [opts.timeout=30000] - Max wait time before reject
 * @param {number} [opts.idle=500] - Required idle duration before resolve
 * @returns {Promise<void>}
 */
export function waitForNetworkIdle(session, opts = {}) {
  return idleWaiter({
    timeout: opts.timeout || 30000,
    idle: opts.idle || 500,
    attach: ({ onStart, onEnd, unsubs }) => {
      unsubs.push(session.on('Network.requestWillBeSent', (p) => onStart(p.requestId)));
      unsubs.push(session.on('Network.loadingFinished', (p) => onEnd(p.requestId)));
      unsubs.push(session.on('Network.loadingFailed', (p) => onEnd(p.requestId)));
    },
  });
}

/**
 * Firefox/BiDi: wait for network idle over `network.*` events. Subscribes the
 * events first (idempotent — safe even if the daemon already subscribed for
 * log capture), then runs the same orphan-resilient idle loop. The in-flight
 * key is `params.request.request` (the BiDi request id).
 * @param {object} bidi - BiDi client with async .subscribe() and .on() returning unsub
 * @param {object} [opts]
 * @param {number} [opts.timeout=30000] - Max wait time before reject
 * @param {number} [opts.idle=500] - Required idle duration before resolve
 * @returns {Promise<void>}
 */
export async function waitForNetworkIdleBiDi(bidi, opts = {}) {
  await bidi.subscribe(['network.beforeRequestSent', 'network.responseCompleted', 'network.fetchError']);
  return idleWaiter({
    timeout: opts.timeout || 30000,
    idle: opts.idle || 500,
    attach: ({ onStart, onEnd, unsubs }) => {
      unsubs.push(bidi.on('network.beforeRequestSent', (p) => onStart(p.request.request)));
      unsubs.push(bidi.on('network.responseCompleted', (p) => onEnd(p.request.request)));
      unsubs.push(bidi.on('network.fetchError', (p) => onEnd(p.request.request)));
    },
  });
}
