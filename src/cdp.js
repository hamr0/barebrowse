/**
 * cdp.js — Minimal Chrome DevTools Protocol client over WebSocket.
 *
 * Sends JSON-RPC commands, receives responses and events.
 * Uses Node 22's built-in WebSocket (no external deps).
 *
 * Supports flattened sessions: when a sessionId is provided,
 * it's sent at the top level of the message (not inside params).
 * Events from sessions are also dispatched by sessionId.
 */

/**
 * Create a CDP client connected to the given WebSocket URL.
 * @param {string} wsUrl - WebSocket URL (ws://127.0.0.1:PORT/devtools/...)
 * @returns {Promise<CDPClient>}
 */
export async function createCDP(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();   // id → { resolve, reject }
  const listeners = new Map(); // "method" or "sessionId:method" → Set<callback>

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP connection timeout (5s)')), 5000);
    ws.onopen = () => { clearTimeout(timeout); resolve(); };
    ws.onerror = (e) => {
      clearTimeout(timeout);
      reject(new Error(`CDP WebSocket connection failed: ${e.message || 'unknown error'}`));
    };
  });

  ws.onmessage = (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());

    // Response to a command (has id)
    if (msg.id !== undefined) {
      const handler = pending.get(msg.id);
      if (handler) {
        pending.delete(msg.id);
        if (msg.error) {
          handler.reject(new Error(`CDP error: ${msg.error.message} (${msg.error.code})`));
        } else {
          handler.resolve(msg.result);
        }
      }
      return;
    }

    // Event (has method, optionally sessionId for flattened sessions)
    if (msg.method) {
      // Dispatch to session-scoped listeners first
      if (msg.sessionId) {
        const key = `${msg.sessionId}:${msg.method}`;
        const scoped = listeners.get(key);
        if (scoped) {
          for (const cb of scoped) cb(msg.params);
        }
      }
      // Also dispatch to global listeners
      const global = listeners.get(msg.method);
      if (global) {
        for (const cb of global) cb(msg.params, msg.sessionId);
      }
    }
  };

  ws.onerror = (e) => {
    for (const [id, handler] of pending) {
      handler.reject(new Error(`CDP WebSocket error: ${e.message || 'unknown'}`));
      pending.delete(id);
    }
  };

  const client = {
    /**
     * Send a CDP command and wait for the response.
     * @param {string} method - CDP method (e.g. 'Page.navigate')
     * @param {object} [params] - Command parameters
     * @param {string} [sessionId] - Target session (for flattened mode)
     * @returns {Promise<object>} Response result
     */
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(msg));
      });
    },

    /**
     * Subscribe to a CDP event.
     * @param {string} method - Event name (e.g. 'Page.loadEventFired')
     * @param {function} callback - Event handler
     * @param {string} [sessionId] - Scope to a specific session
     * @returns {function} Unsubscribe function
     */
    on(method, callback, sessionId) {
      const key = sessionId ? `${sessionId}:${method}` : method;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(callback);
      return () => listeners.get(key).delete(callback);
    },

    /**
     * Wait for a specific CDP event to fire once.
     * @param {string} method - Event name
     * @param {number} [timeout=30000] - Timeout in ms
     * @param {string} [sessionId] - Scope to a specific session
     * @returns {Promise<object>} Event params
     */
    once(method, timeout = 30000, sessionId) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          unsub();
          reject(new Error(`Timeout waiting for CDP event: ${method}`));
        }, timeout);
        const unsub = client.on(method, (params) => {
          clearTimeout(timer);
          unsub();
          resolve(params);
        }, sessionId);
      });
    },

    /**
     * Create a session-scoped handle for a specific target.
     * All send/on/once calls are automatically scoped to the session.
     * @param {string} sessionId
     * @returns {object} Session-scoped CDP handle
     */
    session(sessionId) {
      return {
        send: (method, params = {}) => client.send(method, params, sessionId),
        on: (method, callback) => client.on(method, callback, sessionId),
        once: (method, timeout = 30000) => client.once(method, timeout, sessionId),
      };
    },

    /** Close the WebSocket connection. */
    close() {
      ws.close();
    },
  };

  return client;
}
