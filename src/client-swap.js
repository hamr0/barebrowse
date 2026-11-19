/**
 * client-swap.js -- internal (not exported from index.js) hook for "this page
 * is now driven by a different CDP session / BiDi client".
 *
 * connect() pages swap their client on switchTab() and on a hybrid headed
 * relaunch; a fresh client has no event listeners. A consumer such as
 * capture.js registers here once per page and is re-run on every swap, before
 * the page navigates, so nothing the new client sees is lost. Keyed by the
 * page object in a WeakMap: nothing is added to the public page surface.
 */

const hooks = new WeakMap(); // page -> Set<async () => void>

/** Run `fn` after every client swap of `page`. */
export function onClientSwap(page, fn) {
  if (!hooks.has(page)) hooks.set(page, new Set());
  hooks.get(page).add(fn);
}

/**
 * Called by the page after it rebinds to a new client. Best-effort: a failing
 * hook (e.g. the new client died) must not break the navigation or tab switch.
 */
export async function clientSwapped(page) {
  for (const fn of hooks.get(page) || []) {
    try { await fn(); } catch { /* the caller's next command surfaces a dead client */ }
  }
}
