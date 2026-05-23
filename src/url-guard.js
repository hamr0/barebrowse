/**
 * url-guard.js — Navigation safety checks for goto()/browse().
 *
 * Closes two confirmed vectors for an autonomous (and therefore
 * prompt-injectable) agent:
 *   1. Local-resource schemes (file:, view-source:, chrome:, …) that let a
 *      page-sourced instruction read local files or browser internals.
 *   2. Optional private-network blocking (loopback, RFC-1918, link-local,
 *      cloud-metadata) to stop SSRF to internal services.
 *
 * Scheme blocking is on by default; private-network blocking is opt-in
 * (blockPrivateNetwork) so localhost dev-server browsing keeps working.
 *
 * Limitation: private-network checks match the URL hostname only. A public
 * DNS name that resolves to a private IP (DNS rebinding) is NOT caught here —
 * that needs connection-time IP inspection. Documented, not silently assumed.
 */

import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// Schemes safe to navigate to. Everything else is treated as a local-resource
// or browser-internal scheme and blocked unless allowLocalUrls is set.
// data:/blob:/about: stay allowed: opaque origins, no file:// or cross-origin
// read, and data: is the library's test-fixture mechanism.
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'data:', 'blob:', 'about:']);

/**
 * @param {string} host - hostname (no brackets for IPv6)
 * @returns {boolean} true if it names a private/loopback/link-local/internal host
 */
function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  // Internal hostnames
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal') return true;

  // IPv4 (incl. ranges)
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true;                 // loopback 127.0.0.0/8
    if (a === 10) return true;                   // 10.0.0.0/8
    if (a === 0) return true;                    // 0.0.0.0/8
    if (a === 169 && b === 254) return true;     // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;     // 192.168.0.0/16
    return false;
  }

  // IPv6 — gated on the host actually being an IPv6 literal (contains a
  // colon). Without this gate, ordinary hostnames like "fcbarcelona.com" or
  // "fdic.gov" would match the fc00::/7 ULA prefix check and be wrongly blocked.
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;        // loopback / unspecified
    if (h.startsWith('fe80:')) return true;            // link-local fe80::/10
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 ULA
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
    const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateHost(mapped[1]);
    return false;
  }

  return false;
}

/**
 * Throw if `url` is unsafe to navigate to under the given policy.
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.allowLocalUrls=false] - permit file:/chrome:/etc.
 * @param {boolean} [opts.blockPrivateNetwork=false] - reject loopback/RFC-1918/metadata.
 */
export function assertNavigable(url, opts = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing to navigate: not a valid URL (${String(url).slice(0, 80)})`);
  }

  if (!opts.allowLocalUrls && !ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `Refusing to navigate to "${parsed.protocol}" URL — local-resource and ` +
      `browser-internal schemes are blocked (reads local files / browser state). ` +
      `Pass { allowLocalUrls: true } to override.`
    );
  }

  if (
    opts.blockPrivateNetwork &&
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.hostname &&
    isPrivateHost(parsed.hostname)
  ) {
    throw new Error(
      `Refusing to navigate to private/internal host "${parsed.hostname}" — ` +
      `blockPrivateNetwork is enabled (SSRF guard). ` +
      `Unset it to allow localhost / internal browsing.`
    );
  }
}

/**
 * Throw if any file in `files` resolves outside `uploadDir`. Both the base
 * dir and each file are resolved through realpath, so symlinks (in either the
 * base path — e.g. macOS /tmp → /private/tmp — or the file) can't be used to
 * escape the sandbox or to false-reject a legitimate file.
 * No-op when `uploadDir` is falsy (no restriction configured).
 * @param {string|string[]} files
 * @param {string|null} uploadDir
 */
export function assertUploadAllowed(files, uploadDir) {
  if (!uploadDir) return;
  let baseReal;
  try {
    baseReal = realpathSync(resolve(uploadDir));
  } catch {
    throw new Error(`upload: uploadDir does not exist or is unreadable (${uploadDir})`);
  }
  const list = Array.isArray(files) ? files : [files];
  for (const f of list) {
    let real;
    try {
      real = realpathSync(resolve(String(f)));
    } catch {
      throw new Error(`upload: cannot resolve "${f}" (must exist inside uploadDir)`);
    }
    if (real !== baseReal && !real.startsWith(baseReal + sep)) {
      throw new Error(`upload: "${f}" is outside the allowed uploadDir (${uploadDir})`);
    }
  }
}

// Exported for unit tests.
export { isPrivateHost };
