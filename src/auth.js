/**
 * auth.js — Cookie extraction from browser profiles + CDP injection.
 *
 * Extracts cookies from Chromium/Firefox SQLite databases,
 * decrypts Chromium cookies via OS keyring (KWallet or GNOME keyring),
 * and injects them into a CDP session via Network.setCookie.
 *
 * Requires Node >= 22 (node:sqlite built-in).
 */

import { DatabaseSync } from 'node:sqlite';
import { pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

// --- Browser profile paths ---

const HOME = homedir();

const CHROMIUM_PATHS = {
  chromium: `${HOME}/.config/chromium/Default/Cookies`,
  chrome: `${HOME}/.config/google-chrome/Default/Cookies`,
  brave: `${HOME}/.config/BraveSoftware/Brave-Browser/Default/Cookies`,
  edge: `${HOME}/.config/microsoft-edge/Default/Cookies`,
  vivaldi: `${HOME}/.config/vivaldi/Default/Cookies`,
};

/**
 * Find first available Chromium cookie database.
 * @returns {{ path: string, browser: string } | null}
 */
function findChromiumCookieDb() {
  for (const [browser, path] of Object.entries(CHROMIUM_PATHS)) {
    if (existsSync(path)) return { path, browser };
  }
  return null;
}

/**
 * Find Firefox default profile cookies.
 * @returns {string | null} Path to cookies.sqlite
 */
function findFirefoxCookieDb() {
  const base = `${HOME}/.mozilla/firefox`;
  try {
    for (const entry of readdirSync(base)) {
      if (entry.endsWith('.default-release') || entry.endsWith('.default')) {
        const p = `${base}/${entry}/cookies.sqlite`;
        if (existsSync(p)) return p;
      }
    }
  } catch { /* no firefox */ }
  return null;
}

// --- Chromium cookie decryption (Linux) ---

/**
 * Get Chromium encryption password from OS keyring.
 * Tries KWallet (KDE) first, then GNOME keyring, then fallback.
 */
function getChromiumPassword() {
  // KDE / KWallet
  try {
    const b64 = execSync(
      'kwallet-query -r "Chromium Safe Storage" -f "Chromium Keys" kdewallet',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (b64) return Buffer.from(b64, 'base64').toString('binary');
  } catch { /* not KDE or no entry */ }

  // GNOME keyring / libsecret
  try {
    const pw = execSync(
      'secret-tool lookup application chrome',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (pw) return pw;
  } catch { /* not GNOME */ }

  // Fallback when no keyring is configured
  return 'peanuts';
}

/**
 * Derive AES key from Chromium keyring password.
 * Chrome Linux: PBKDF2-SHA1, salt='saltysalt', 1 iteration, 16-byte key.
 */
function deriveKey(password) {
  return pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
}

/**
 * Decrypt a Chromium encrypted cookie value.
 * @param {Uint8Array} encrypted - encrypted_value from SQLite
 * @param {Buffer} aesKey - Derived AES key
 * @returns {string} Decrypted cookie value
 */
function decryptCookie(encrypted, aesKey) {
  const buf = Buffer.from(encrypted);
  if (buf.length === 0) return '';

  const prefix = buf.subarray(0, 3).toString('ascii');
  if (prefix !== 'v10' && prefix !== 'v11') {
    // Not encrypted
    return buf.toString('utf8');
  }

  const iv = Buffer.alloc(16, ' '); // 16 space characters
  const decipher = createDecipheriv('aes-128-cbc', aesKey, iv);
  const payload = buf.subarray(3);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
}

// --- Extractors ---

/**
 * Extract cookies from a Chromium-based browser.
 * @param {string} dbPath - Path to Cookies SQLite database
 * @param {string} [domain] - Filter by domain (e.g. '.github.com')
 * @returns {Array<object>} Cookies in CDP Network.setCookie format
 */
function extractChromiumCookies(dbPath, domain) {
  const password = getChromiumPassword();
  const aesKey = deriveKey(password);

  // immutable=1 bypasses WAL lock on live databases
  const db = new DatabaseSync(`file://${dbPath}?immutable=1`, { readOnly: true });

  let sql = `SELECT host_key, name, value, encrypted_value, path,
    CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly, samesite
    FROM cookies`;
  const params = [];
  if (domain) {
    sql += ` WHERE host_key LIKE ?`;
    params.push(`%${domain}%`);
  }

  const stmt = db.prepare(sql);
  const rows = params.length ? stmt.all(...params) : stmt.all();
  db.close();

  const SAMESITE = { 0: 'None', 1: 'Lax', 2: 'Strict' };

  return rows.map((row) => {
    const rawEnc = row.encrypted_value;
    const enc = rawEnc instanceof Uint8Array ? Buffer.from(rawEnc) : Buffer.alloc(0);
    let value;
    try {
      value = enc.length > 0 ? decryptCookie(enc, aesKey) : row.value;
    } catch {
      value = row.value || '';
    }

    // Chrome timestamp: microseconds since 1601-01-01
    const CHROME_EPOCH = 11644473600000000n;
    const expiresUtc = typeof row.expires_utc === 'string' || typeof row.expires_utc === 'number'
      ? BigInt(row.expires_utc)
      : 0n;
    const expires = expiresUtc > 0n
      ? Number((expiresUtc - CHROME_EPOCH) / 1000000n)
      : -1;

    return {
      name: row.name,
      value,
      domain: row.host_key,
      path: row.path,
      expires,
      secure: row.is_secure === 1,
      httpOnly: row.is_httponly === 1,
      sameSite: SAMESITE[row.samesite] || 'Lax',
    };
  }).filter((c) => c.value); // drop empty cookies
}

/**
 * Extract cookies from Firefox (no encryption).
 * @param {string} dbPath - Path to cookies.sqlite
 * @param {string} [domain] - Filter by domain
 * @returns {Array<object>} Cookies in CDP Network.setCookie format
 */
function extractFirefoxCookies(dbPath, domain) {
  const db = new DatabaseSync(`file://${dbPath}?immutable=1`, { readOnly: true });

  let sql = `SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
    FROM moz_cookies`;
  const params = [];
  if (domain) {
    sql += ` WHERE host LIKE ?`;
    params.push(`%${domain}%`);
  }

  const stmt = db.prepare(sql);
  const rows = params.length ? stmt.all(...params) : stmt.all();
  db.close();

  const SAMESITE = { 0: 'None', 1: 'Lax', 2: 'Strict' };

  return rows.map((row) => ({
    name: row.name,
    value: row.value,
    domain: row.host,
    path: row.path,
    expires: row.expiry || -1,
    secure: row.isSecure === 1,
    httpOnly: row.isHttpOnly === 1,
    sameSite: SAMESITE[row.sameSite] || 'Lax',
  })).filter((c) => c.value);
}

// --- Public API ---

/**
 * Extract cookies from the user's browser, auto-detecting which browser to use.
 * @param {object} [opts]
 * @param {string} [opts.browser] - 'chromium', 'chrome', 'brave', 'edge', 'firefox', or 'auto'
 * @param {string} [opts.domain] - Filter by domain
 * @returns {Array<object>} Cookies in CDP-compatible format
 */
export function extractCookies(opts = {}) {
  const browser = opts.browser || 'auto';
  const domain = opts.domain;

  if (browser === 'firefox') {
    const db = findFirefoxCookieDb();
    if (!db) throw new Error('Firefox cookie database not found');
    return extractFirefoxCookies(db, domain);
  }

  if (browser !== 'auto' && CHROMIUM_PATHS[browser]) {
    const path = CHROMIUM_PATHS[browser];
    if (!existsSync(path)) throw new Error(`${browser} cookie database not found at ${path}`);
    return extractChromiumCookies(path, domain);
  }

  // Auto: try all browsers, merge (last-write-wins by name+domain)
  const all = new Map();
  const chromium = findChromiumCookieDb();
  if (chromium) {
    for (const c of extractChromiumCookies(chromium.path, domain))
      all.set(`${c.name}@${c.domain}`, c);
  }
  const firefox = findFirefoxCookieDb();
  if (firefox) {
    for (const c of extractFirefoxCookies(firefox, domain))
      all.set(`${c.name}@${c.domain}`, c);
  }
  if (all.size === 0) throw new Error('No browser cookie database found');
  return [...all.values()];
}

/**
 * Inject cookies into a CDP session via Network.setCookie.
 * @param {object} session - CDP session handle (from cdp.session())
 * @param {Array<object>} cookies - Cookies from extractCookies()
 */
export async function injectCookies(session, cookies) {
  for (const cookie of cookies) {
    await session.send('Network.setCookie', {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expires: cookie.expires > 0 ? cookie.expires : undefined,
    });
  }
}

/**
 * RFC 6265 domain-match: does `host` belong to a cookie declared for
 * `cookieDomain`? Leading dot on the cookie domain is ignored (host-only
 * vs domain cookies are matched the same here, intentionally — we want
 * parent-domain cookies like .google.com to apply to mail.google.com).
 * @param {string} host - target hostname (e.g. 'mail.google.com')
 * @param {string} cookieDomain - cookie's host_key (e.g. '.google.com')
 * @returns {boolean}
 */
export function cookieDomainMatch(host, cookieDomain) {
  const h = String(host).toLowerCase();
  const d = String(cookieDomain).toLowerCase().replace(/^\./, '');
  if (!d) return false;
  return h === d || h.endsWith('.' + d);
}

/**
 * Select the user's cookies that are in-scope for `url`. Shared by BOTH engines
 * (CDP `authenticate` and Firefox/BiDi `injectCookies`) so they can't drift on
 * scoping — a divergence here re-opens loading the entire cookie jar into an
 * agent session. Returns the filtered cookie array; never injects.
 *
 * Coarse SQL pre-filter strips to a registrable-ish domain so the LIKE query
 * returns a superset (incl. parent-domain cookies). slice(-2) is a cheap
 * heuristic — it over-selects for multi-part eTLDs (co.uk) and as a substring
 * match, so the precise RFC-6265 domain-match is what actually decides which
 * cookies pass. Without it, browsing apple.com would match apple.com.evil.org
 * and every *.co.uk site (verified).
 * @param {string} url - URL whose host the cookies must match
 * @param {object} [opts] - passed to extractCookies (e.g. { browser })
 * @returns {Array<object>} cookies whose domain matches the URL host
 */
export function scopedCookiesForUrl(url, opts = {}) {
  const fullHost = new URL(url).hostname.toLowerCase();
  const noWww = fullHost.replace(/^www\./, '');
  const parts = noWww.split('.');
  const coarseDomain = parts.length > 2 ? parts.slice(-2).join('.') : noWww;
  const candidates = extractCookies({ ...opts, domain: coarseDomain });
  return candidates.filter((c) => cookieDomainMatch(fullHost, c.domain));
}

/**
 * Extract cookies for a URL and inject them into a CDP session.
 * Convenience function combining scopedCookiesForUrl + injectCookies.
 * @param {object} session - CDP session handle
 * @param {string} url - URL to extract cookies for
 * @param {object} [opts] - Options passed to extractCookies
 */
export async function authenticate(session, url, opts = {}) {
  const cookies = scopedCookiesForUrl(url, opts);
  if (cookies.length > 0) {
    await injectCookies(session, cookies);
  }
  return cookies.length;
}
