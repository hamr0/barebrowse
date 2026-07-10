/**
 * stealth-firefox.js — Anti-detection patches for headless Firefox (BiDi).
 *
 * Deliberately MUCH smaller than the Chromium stealth.js. That isn't laziness —
 * it's what a POC measured stock Firefox-under-BiDi to actually expose:
 *
 *   navigator.webdriver  → true   (the tell — we hide it)
 *   window.chrome        → absent (correct; ADDING it would be a spoof tell)
 *   navigator.plugins    → 5      (realistic PDF set; already normal)
 *   languages / hardwareConcurrency → normal (en-US,en / 8)
 *   User-Agent           → real Firefox, NO "Headless" marker (no rewrite needed)
 *   WebGL vendor/renderer → the REAL GPU, not SwiftShader (spoofing would
 *                           replace a real value with a fake one)
 *
 * So porting Chromium's STEALTH_SCRIPT verbatim would have made Firefox look
 * like a spoofed browser (window.chrome + Chrome plugins on Firefox = obvious
 * tell) — a worse fingerprint than the one removed. The only genuinely
 * engine-agnostic pieces are webdriver-hiding and canvas noise, both reused
 * verbatim from stealth.js so their fixes stay single-sourced.
 *
 * BiDi's script.addPreloadScript is the equivalent of CDP's
 * Page.addScriptToEvaluateOnNewDocument — the POC confirmed it runs BEFORE any
 * page script (navigator.webdriver read at parse time already saw `undefined`).
 */

import { WEBDRIVER_PATCH, CANVAS_NOISE_PATCH } from './stealth.js';

const FIREFOX_STEALTH_SCRIPT = `${WEBDRIVER_PATCH}\n${CANVAS_NOISE_PATCH}`;

/**
 * Register the Firefox stealth patches so they run before any page script.
 * Must be called before the first navigation. addPreloadScript is global
 * (applies to every browsing context / navigation), so a single registration
 * covers the whole session.
 *
 * @param {object} bidi - BiDi client from createBiDi()
 */
export async function applyFirefoxStealth(bidi) {
  await bidi.send('script.addPreloadScript', {
    functionDeclaration: `() => { ${FIREFOX_STEALTH_SCRIPT} }`,
  });
}
