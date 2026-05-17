/**
 * network-idle.js — wait until the page's network has been idle for N ms.
 *
 * Tracks in-flight requests by requestId in a Set, so an orphan
 * loadingFinished/Failed (event for a request whose requestWillBeSent
 * arrived before our listener attached) is a harmless no-op instead of
 * driving a counter negative and resolving prematurely.
 */

/**
 * @param {object} session - CDP session-scoped handle with .on() returning unsub
 * @param {object} [opts]
 * @param {number} [opts.timeout=30000] - Max wait time before reject
 * @param {number} [opts.idle=500] - Required idle duration before resolve
 */
export function waitForNetworkIdle(session, opts = {}) {
  const timeout = opts.timeout || 30000;
  const idle = opts.idle || 500;

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

    unsubs.push(session.on('Network.requestWillBeSent', (p) => {
      pending.add(p.requestId);
      clearTimeout(timer);
    }));
    unsubs.push(session.on('Network.loadingFinished', (p) => {
      // delete() on a Set is a no-op for unknown keys — orphan events from
      // requests started before we attached the listener can't push us negative.
      pending.delete(p.requestId);
      check();
    }));
    unsubs.push(session.on('Network.loadingFailed', (p) => {
      pending.delete(p.requestId);
      check();
    }));

    const deadlineTimer = setTimeout(() => {
      for (const unsub of unsubs) unsub();
      reject(new Error(`waitForNetworkIdle timed out after ${timeout}ms`));
    }, timeout);

    // Start check immediately (might already be idle)
    check();
  });
}
