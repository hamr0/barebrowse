/**
 * navigation.js — Shared pieces of the goto() outcome contract, so both
 * engines (CDP in index.js, BiDi in firefox-page.js) report it identically.
 */

/**
 * What goto() resolves to: where the page ended up and how the server answered.
 * `status` is 0 when no HTTP response was observed for the navigation (e.g. an
 * aborted navigation that never got one). `mitigated` is present (true) only when
 * the document carried Cloudflare's `cf-mitigated: challenge` header.
 * @typedef {{ url: string, status: number, mitigated?: true }} NavigationOutcome
 */

/**
 * The outcome's `mitigated` flag from a main-document response's headers
 * (CDP: `{name: value}` object; BiDi: `[{name, value: {value}}]` array).
 * @param {object|Array<{name: string, value: {value: string}}>} [headers]
 * @returns {{ mitigated: true } | {}}
 */
export function mitigation(headers) {
  const entries = Array.isArray(headers) ? headers.map((h) => [h.name, h.value?.value]) : Object.entries(headers || {});
  return entries.some(([k, v]) => /^cf-mitigated$/i.test(k) && /challenge/i.test(String(v))) ? { mitigated: true } : {};
}

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
 * Typed error for a top-level navigation the site lock (`allowHosts`) refused:
 * the target, or a redirect hop of it, is off the allowed list. `code` is
 * 'NAV_BLOCKED'; `host` is the refused hostname. The page stays where it was.
 * @param {string} url - The refused URL (the redirect target, if it was a hop).
 * @param {string} host
 * @returns {Error & {code: 'NAV_BLOCKED', host: string}}
 */
export function navBlocked(url, host) {
  return Object.assign(new Error(`Navigation to ${url} blocked: ${host} is not in allowHosts`), { code: /** @type {const} */ ('NAV_BLOCKED'), host });
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
