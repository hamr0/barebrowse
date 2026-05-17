// Fixture for F3 regression test: launches a browser, prints its PID,
// then waits for a signal. The parent test SIGTERMs us and checks
// whether the browser PID survived (it shouldn't).
import { launch } from '../../src/chromium.js';

const browser = await launch();
console.log(`BROWSER_PID:${browser.process.pid}`);
console.log(`PROFILE_DIR:${browser.ownedProfileDir}`);

// Keep the event loop alive — wait for a signal to arrive
await new Promise(() => {});
