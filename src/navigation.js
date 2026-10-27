/**
 * navigation.js — Shared pieces of the goto() outcome contract, so both
 * engines (CDP in index.js, BiDi in firefox-page.js) report it identically.
 */

/**
 * What goto() resolves to: where the page ended up and how the server answered.
 * `status` is 0 when no HTTP response was observed for the navigation (e.g. an
 * aborted navigation that never got one).
 * @typedef {{ url: string, status: number }} NavigationOutcome
 */

/**
 * Typed error for a navigation that never reached a document (DNS failure,
 * connection refused, TLS error, ...). `code` is 'NAV_FAILED'; `reason` is the
 * browser's raw error string (`net::ERR_NAME_NOT_RESOLVED`,
 * `NS_ERROR_UNKNOWN_HOST`, ...).
 * @param {string} url
 * @param {string} reason
 * @returns {Error & {code: 'NAV_FAILED', reason: string}}
 */
export function navFailed(url, reason) {
  return Object.assign(new Error(`Navigation to ${url} failed: ${reason}`), { code: /** @type {const} */ ('NAV_FAILED'), reason });
}

/**
 * True for a final HTTP status that is not 2xx (0 = unknown is not an error).
 * @param {number|undefined} status
 */
export function isHttpError(status) {
  return !!status && (status < 200 || status >= 300);
}

/**
 * Warning line for a non-2xx final status ('' for 2xx and for unknown 0), in
 * the style of the bot-challenge line, newline-terminated for prepending.
 * @param {number|undefined} status
 * @returns {string}
 */
export function httpWarning(status) {
  return isHttpError(status) ? `[HTTP ${status} — the page may be an error page]\n` : '';
}
