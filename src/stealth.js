/**
 * stealth.js — Anti-detection patches for headless Chromium.
 *
 * Uses Page.addScriptToEvaluateOnNewDocument so patches run before
 * any page scripts (unlike Runtime.evaluate which runs after).
 */

/**
 * navigator.webdriver hiding — the one automation tell shared by every engine
 * (Chromium headless AND Firefox-under-BiDi both report `true`). Split out so
 * the Firefox stealth path (stealth-firefox.js) reuses the exact same patch
 * instead of duplicating it. Measured baseline on both engines: `true`.
 */
export const WEBDRIVER_PATCH = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
`;

/**
 * Canvas-fingerprint noise — browser-agnostic (standard Canvas2D API), so both
 * the Chromium and Firefox stealth scripts compose it. This block carries the
 * subtle double-XOR-cancellation fixes (see git history / project memory); keep
 * it SINGLE-SOURCED here so a fix never has to be made in two places.
 */
export const CANVAS_NOISE_PATCH = `
  // Canvas fingerprinting — sites render standard text/shapes, then read
  // pixels via toDataURL or getImageData. The output is stable per machine
  // (GPU, font rasterizer, anti-aliasing) but unique across machines, which
  // makes it the second-most-common fingerprint after WebGL. Defense: nudge
  // a few RGB channels by ±1 per session so the hash changes each visit
  // while the canvas still looks identical to the human eye. The per-tab
  // seed keeps reads stable within a session so legitimate canvas use
  // (image processing, games) doesn't flicker.
  // crypto.getRandomValues is guaranteed unique per browsing context; using
  // Math.random alone can collide when two fresh V8 contexts start within
  // microseconds of each other (real-world: parallel tests, real-world hit:
  // we observed it). performance.now adds a wall-clock anchor as a belt-and-
  // braces guard against contexts where crypto is somehow stubbed.
  const _seedBuf = new Uint32Array(1);
  crypto.getRandomValues(_seedBuf);
  const CANVAS_SEED = (_seedBuf[0] ^ ((performance.now() * 1e6) | 0)) >>> 0;
  function shiftPixels(data) {
    // Touch ~1 byte per 64-byte stride. The bit we XOR with is taken from a
    // position-dependent SLICE of a seed-mixed hash, not its low bit — a
    // naive 'mix & 1' collapses to only two possible outputs per seed
    // parity because every stride index is even (the position multiplier
    // is odd, so the low bit only depends on seed parity). Indexing the
    // hash by (i/64) mod 32 makes every stride position sample a different
    // bit, so two distinct seeds produce different mask patterns.
    for (let i = 0; i < data.length; i += 64) {
      const h = ((CANVAS_SEED * 2654435761) ^ (i * 1597334677)) >>> 0;
      const bit = (h >>> ((i >>> 6) & 31)) & 1;
      data[i] = (data[i] ^ bit) & 0xff;
    }
    return data;
  }
  // Capture originals BEFORE replacing — toDataURL must read pixels via the
  // native getImageData (not the patched one), otherwise the patch double-
  // applies and the second XOR cancels the first, leaving output unchanged.
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function() {
    const ctx = this.getContext('2d');
    if (ctx && this.width > 0 && this.height > 0) {
      try {
        const img = origGetImageData.call(ctx, 0, 0, this.width, this.height);
        // Snapshot the original bytes so we can restore them after encoding.
        // Without this, repeated toDataURL() alternates noisy/clean: call 1
        // XORs the canvas in place, call 2 reads the noisy canvas and XORs
        // again (self-inverse), call 3 again, etc. Same XOR-cancellation
        // class as the earlier double-apply bug, just through canvas state
        // rather than method composition. The restore also keeps the
        // bitmap idempotent for any downstream legitimate canvas reads.
        const original = new Uint8ClampedArray(img.data);
        shiftPixels(img.data);
        ctx.putImageData(img, 0, 0);
        const result = origToDataURL.apply(this, arguments);
        img.data.set(original);
        ctx.putImageData(img, 0, 0);
        return result;
      } catch {
        // Tainted canvas (cross-origin image) — can't read; skip the nudge
        // and fall through to the original call so the page sees the
        // expected SecurityError instead of silent corruption.
      }
    }
    return origToDataURL.apply(this, arguments);
  };
  CanvasRenderingContext2D.prototype.getImageData = function() {
    const img = origGetImageData.apply(this, arguments);
    shiftPixels(img.data);
    return img;
  };
`;

const STEALTH_SCRIPT = `
  // Hide webdriver flag
  ${WEBDRIVER_PATCH}

  // Fake plugins (headless has 0)
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', filename: 'internal-nacl-plugin' },
    ],
  });

  // Fake languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });

  // Realistic CPU + memory. Headless under containers can report 1 or odd
  // values that real desktops rarely have, which is its own fingerprint.
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

  // chrome / chrome.runtime — headless either omits the object entirely or
  // gives an empty {}; real Chrome has the enum shapes below even before any
  // extension is installed. Fingerprinters check that chrome.runtime exists
  // AND that these enums are present.
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
      OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
      PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
      PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
      PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
      RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
    };
  }

  // Notification — headless Chrome doesn't expose the Notification API at
  // all (even on secure contexts), while real Chrome always does and reports
  // 'default' before any prompt. Fingerprinters check both \`typeof
  // Notification\` and \`Notification.permission\`, so we fake both: the
  // constructor when missing, and only the permission getter when it's
  // present (some Chrome versions ship a non-configurable getter and
  // defineProperty would throw — swallowed so the rest of the script runs).
  if (typeof Notification === 'undefined') {
    window.Notification = function Notification() {};
    window.Notification.permission = 'default';
    window.Notification.requestPermission = () => Promise.resolve('default');
  } else {
    try {
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    } catch {}
  }

  // Permissions.query for notifications: keep it consistent with the
  // Notification.permission override above instead of returning 'prompt'
  // unconditionally (the prior hardcoded value was a tell of its own).
  const origQuery = Permissions.prototype.query;
  Permissions.prototype.query = function(desc) {
    if (desc && desc.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission, onchange: null });
    }
    return origQuery.call(this, desc);
  };

  // WebGL UNMASKED_VENDOR_WEBGL (37445) and UNMASKED_RENDERER_WEBGL (37446) —
  // headless returns "Google Inc. (Google)" / "Google SwiftShader" which
  // is the single most-used headless fingerprint. Spoof a realistic
  // Intel integrated GPU pair (works on macOS and Linux user agents).
  const SPOOFED_VENDOR = 'Intel Inc.';
  const SPOOFED_RENDERER = 'Intel Iris OpenGL Engine';
  const origGetParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(p) {
    if (p === 37445) return SPOOFED_VENDOR;
    if (p === 37446) return SPOOFED_RENDERER;
    return origGetParam.apply(this, arguments);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return SPOOFED_VENDOR;
      if (p === 37446) return SPOOFED_RENDERER;
      return origGetParam2.apply(this, arguments);
    };
  }

  ${CANVAS_NOISE_PATCH}
`;

/**
 * Apply stealth patches to a CDP session.
 * Must be called before any navigation.
 *
 * Splits into two layers:
 *   1. Network.setUserAgentOverride strips "HeadlessChrome" from the UA
 *      that ships in HTTP request headers AND that navigator.userAgent
 *      reports — `--headless=new` leaves "HeadlessChrome" in there.
 *   2. Page.addScriptToEvaluateOnNewDocument injects the JS-level patches
 *      before any page script runs.
 *
 * @param {object} session - Session-scoped CDP handle
 */
export async function applyStealth(session) {
  // 1. UA override — read whatever the running browser actually claims, then
  //    rewrite the "Headless" marker out. Doing it this way (vs hardcoding a
  //    string) keeps the version + platform fields accurate across Chromium
  //    releases. Network.setUserAgentOverride is per-session, so it also
  //    cleans up the value navigator.userAgent reports inside the page.
  try {
    const { userAgent } = await session.send('Browser.getVersion');
    if (userAgent && userAgent.includes('HeadlessChrome')) {
      await session.send('Network.setUserAgentOverride', {
        userAgent: userAgent.replace(/HeadlessChrome/g, 'Chrome'),
      });
    }
  } catch {
    // Browser.getVersion not reachable from this session — skip UA override
    // and rely on the JS-level patches alone.
  }

  // 2. JS-level patches
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: STEALTH_SCRIPT,
  });
}
