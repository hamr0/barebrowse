/**
 * YouTube headed-mode demo — search and play "Family Portrait Pink"
 *
 * SETUP — run this command first in a separate terminal:
 *
 *   chromium-browser --remote-debugging-port=9222 \
 *     --disable-notifications \
 *     --autoplay-policy=no-user-gesture-required \
 *     --use-fake-device-for-media-stream \
 *     --use-fake-ui-for-media-stream \
 *     --disable-features=MediaRouter
 *
 * Then run this script:
 *
 *   node examples/yt-demo.js
 *
 * Uses Firefox cookies to bypass YouTube consent wall.
 */

import { connect } from '../src/index.js';

function wait(ms = 2000) {
  return new Promise((r) => setTimeout(r, ms));
}

function findRef(snapshot, role, nameFragment) {
  const escaped = nameFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${role} "[^"]*${escaped}[^"]*".*?\\[ref=([^\\]]+)\\]`, 'i');
  const m = snapshot.match(re);
  return m ? m[1] : null;
}

function printSnap(snapshot, limit = 600) {
  const t = snapshot.length > limit
    ? snapshot.slice(0, limit) + `\n... (${snapshot.length - limit} more chars)`
    : snapshot;
  console.log(t);
}

async function main() {
  console.log('=== YouTube Demo — Family Portrait by Pink ===\n');
  console.log('Connecting to Chromium on port 9222...\n');

  const page = await connect({ mode: 'headed', port: 9222 });

  try {
    // Step 1: Inject Firefox cookies for youtube.com (bypasses consent wall)
    console.log('[1] Injecting Firefox cookies for youtube.com...');
    await page.injectCookies('https://www.youtube.com', { browser: 'firefox' });
    await wait(500);

    // Step 2: Navigate to YouTube
    console.log('[2] Navigating to YouTube...');
    await page.goto('https://www.youtube.com');
    await wait(2000);

    // Step 3: Find the search box
    console.log('[3] Taking snapshot to find search box...');
    let snap = await page.snapshot();

    let searchRef = findRef(snap, 'combobox', 'Search')
      || findRef(snap, 'textbox', 'Search')
      || findRef(snap, 'searchbox', 'Search');

    if (!searchRef) {
      console.log('  Could not find search box. Snapshot:');
      printSnap(snap, 1000);
      return;
    }

    // Step 4: Type the search query
    console.log(`[4] Found search box ref=${searchRef}, typing query...`);
    await page.click(searchRef);
    await wait(500);
    await page.type(searchRef, 'Family Portrait Pink', { clear: true });
    await wait(1000);

    // Step 5: Press Enter to search
    // YouTube is an SPA — loadEventFired won't fire, so just wait for results to render
    console.log('[5] Pressing Enter to search...');
    await page.press('Enter');
    await wait(3000);

    // Step 6: Find the video in results
    console.log('[6] Looking for Family Portrait in results...');
    snap = await page.snapshot();

    let videoRef = findRef(snap, 'link', 'Family Portrait')
      || findRef(snap, 'link', 'family portrait');

    if (!videoRef) {
      console.log('  Could not find video link. Trying broader match...');
      printSnap(snap, 1500);
      // Try any link with "Pink" in it
      videoRef = findRef(snap, 'link', 'Pink');
    }

    if (!videoRef) {
      console.log('  No matching video found.');
      return;
    }

    // Step 7: Click the video (SPA nav — no loadEventFired)
    console.log(`[7] Found video ref=${videoRef}, clicking to play...`);
    await page.click(videoRef);
    await wait(4000);

    // Step 8: Snapshot the video page
    console.log('[8] Video page snapshot:\n');
    snap = await page.snapshot();
    printSnap(snap, 800);

    console.log('\n=== Video should be playing! ===');
    console.log('Press Ctrl+C to exit when done watching.\n');

    // Keep alive so user can watch
    await new Promise(() => {});
  } finally {
    await page.close();
  }
}

main().catch((err) => {
  if (err.message?.includes('ECONNREFUSED')) {
    console.error('\nError: Could not connect to Chromium on port 9222.');
    console.error('Start Chromium first:\n');
    console.error('  chromium-browser --remote-debugging-port=9222 \\');
    console.error('    --disable-notifications \\');
    console.error('    --autoplay-policy=no-user-gesture-required \\');
    console.error('    --use-fake-device-for-media-stream \\');
    console.error('    --use-fake-ui-for-media-stream \\');
    console.error('    --disable-features=MediaRouter\n');
  } else {
    console.error('\nError:', err.message || err);
  }
  process.exit(1);
});
