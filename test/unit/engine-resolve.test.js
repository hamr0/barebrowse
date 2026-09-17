import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEngine } from '../../src/index.js';

test('explicit engine:firefox is honored even when chromium is available', () => {
  const result = resolveEngine(
    { engine: 'firefox' },
    { hasChromium: () => true, hasFirefox: () => true },
  );
  assert.deepEqual(result, { engine: 'firefox', fellBack: false });
});

test('explicit engine:chromium is honored even when only firefox is present', () => {
  const result = resolveEngine(
    { engine: 'chromium' },
    { hasChromium: () => false, hasFirefox: () => true },
  );
  assert.deepEqual(result, { engine: 'chromium', fellBack: false });
});

test('attach mode (port set, no engine) is always chromium', () => {
  const result = resolveEngine(
    { port: 9222 },
    { hasChromium: () => false, hasFirefox: () => false },
  );
  assert.deepEqual(result, { engine: 'chromium', fellBack: false });
});

test('default with chromium available picks chromium and short-circuits firefox probe', () => {
  let firefoxProbed = false;
  const result = resolveEngine(
    {},
    {
      hasChromium: () => true,
      hasFirefox: () => {
        firefoxProbed = true;
        return true;
      },
    },
  );
  assert.deepEqual(result, { engine: 'chromium', fellBack: false });
  assert.equal(firefoxProbed, false);
});

test('default with only firefox available falls back to firefox', () => {
  const result = resolveEngine(
    {},
    { hasChromium: () => false, hasFirefox: () => true },
  );
  assert.deepEqual(result, { engine: 'firefox', fellBack: true });
});

test('default with neither browser installed throws', () => {
  assert.throws(
    () => resolveEngine({}, { hasChromium: () => false, hasFirefox: () => false }),
    /No supported browser/,
  );
});
