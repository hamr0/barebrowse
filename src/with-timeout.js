/**
 * Reject if `p` doesn't settle within `ms`. BiDi commands have no built-in
 * timeout, so a navigate/reload/traverse whose `wait:'complete'` never fires
 * (a page that never loads) would otherwise hang the call forever. Also bounds
 * the best-effort tab close on both engines.
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
export function withTimeout(p, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
