/**
 * stealth.js — Anti-detection patches for headless Chromium.
 *
 * Uses Page.addScriptToEvaluateOnNewDocument so patches run before
 * any page scripts (unlike Runtime.evaluate which runs after).
 */

const STEALTH_SCRIPT = `
  // Hide webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

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
