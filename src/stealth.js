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

  // Fake chrome object (missing in headless)
  if (!window.chrome) {
    window.chrome = { runtime: {} };
  }

  // Permissions.query: notifications return 'prompt' instead of 'denied'
  const origQuery = Permissions.prototype.query;
  Permissions.prototype.query = function(desc) {
    if (desc.name === 'notifications') {
      return Promise.resolve({ state: 'prompt', onchange: null });
    }
    return origQuery.call(this, desc);
  };
`;

/**
 * Apply stealth patches to a CDP session.
 * Must be called before any navigation.
 *
 * @param {object} session - Session-scoped CDP handle
 */
export async function applyStealth(session) {
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: STEALTH_SCRIPT,
  });
}
