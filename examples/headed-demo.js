/**
 * barebrowse headed-mode demo
 *
 * This script demonstrates interactive browsing with a VISIBLE browser window.
 * You watch the browser while barebrowse navigates, clicks, and types.
 *
 * SETUP — run this command first in a separate terminal:
 *
 *   chromium-browser --remote-debugging-port=9222
 *
 * Then run this script:
 *
 *   node examples/headed-demo.js
 *
 * The script connects to the already-running browser via CDP on port 9222.
 * You will see each action happen in real time.
 */

import { connect } from '../src/index.js';

// --- Helpers ---

/** Small delay so you can watch the browser between steps. */
function wait(ms = 1500) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Find a ref by matching role and name in the snapshot text. */
function findRoleRef(snapshot, role, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${role} "${escaped}".*?\\[ref=([^\\]]+)\\]`);
  const m = snapshot.match(re);
  return m ? m[1] : null;
}

/** Find a ref by partial name match (case-insensitive). */
function findRoleRefPartial(snapshot, role, nameFragment) {
  const escaped = nameFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${role} "[^"]*${escaped}[^"]*".*?\\[ref=([^\\]]+)\\]`, 'i');
  const m = snapshot.match(re);
  return m ? m[1] : null;
}

/** Print a snapshot truncated to a character limit. */
function printSnapshot(snapshot, limit = 500) {
  const truncated = snapshot.length > limit
    ? snapshot.slice(0, limit) + `\n... (${snapshot.length - limit} more chars)`
    : snapshot;
  console.log(truncated);
}

// --- Demo ---

async function main() {
  console.log('=== barebrowse headed-mode demo ===\n');
  console.log('Connecting to Chromium on port 9222...');
  console.log('(Make sure you ran: chromium-browser --remote-debugging-port=9222)\n');

  const page = await connect({ mode: 'headed', port: 9222 });

  try {
    // Step 1: Navigate to Wikipedia
    console.log('[Step 1] Navigating to Wikipedia "JavaScript" article...');
    await page.goto('https://en.wikipedia.org/wiki/JavaScript');
    await wait();

    // Step 2: Take a snapshot
    console.log('[Step 2] Taking ARIA snapshot of the page...\n');
    let snap = await page.snapshot();
    printSnapshot(snap);
    console.log();

    // Step 3: Find and click a link
    console.log('[Step 3] Looking for a link to click...');
    // Try to find the "ECMAScript" link — a common one in the JS article
    let linkRef = findRoleRefPartial(snap, 'link', 'ECMAScript');
    if (!linkRef) {
      // Fallback: find any link
      linkRef = findRoleRefPartial(snap, 'link', 'programming');
    }
    if (linkRef) {
      console.log(`  Found link ref=${linkRef}, clicking it...`);
      const navPromise = page.waitForNavigation();
      await page.click(linkRef);

      // Step 4: Wait for navigation
      console.log('[Step 4] Waiting for navigation to complete...');
      await navPromise;
      await wait();
    } else {
      console.log('  No matching link found, skipping click step.');
    }

    // Step 5: New snapshot after navigation
    console.log('[Step 5] Taking snapshot of the new page...\n');
    snap = await page.snapshot();
    printSnapshot(snap);
    console.log();

    // Step 6: Navigate to DuckDuckGo
    console.log('[Step 6] Navigating to DuckDuckGo...');
    await page.goto('https://duckduckgo.com');
    await wait();

    // Step 7: Find search box and type a query
    console.log('[Step 7] Taking snapshot to find the search box...');
    snap = await page.snapshot();
    let searchRef = findRoleRefPartial(snap, 'textbox', 'search')
      || findRoleRefPartial(snap, 'searchbox', 'search')
      || findRoleRefPartial(snap, 'combobox', 'search');

    if (searchRef) {
      console.log(`  Found search box ref=${searchRef}, typing query...`);
      await page.click(searchRef);
      await wait(500);
      await page.type(searchRef, 'barebrowse CDP browser automation');
      await wait();
    } else {
      console.log('  Could not find search box. Snapshot preview:');
      printSnapshot(snap, 300);
      console.log('  Skipping search steps.');
      return;
    }

    // Step 8: Press Enter
    console.log('[Step 8] Pressing Enter to search...');
    const resultsNav = page.waitForNavigation();
    await page.press('Enter');

    // Step 9: Wait for results
    console.log('[Step 9] Waiting for search results...');
    await resultsNav;
    await wait(2000);

    // Step 10: Snapshot the results
    console.log('[Step 10] Taking snapshot of search results...\n');
    snap = await page.snapshot();
    printSnapshot(snap, 800);
    console.log();

    console.log('=== Demo complete ===');
  } finally {
    console.log('Closing session...');
    await page.close();
  }
}

main().catch((err) => {
  if (err.message?.includes('ECONNREFUSED') || err.message?.includes('connect')) {
    console.error('\nError: Could not connect to Chromium on port 9222.');
    console.error('Make sure you have Chromium running with remote debugging:');
    console.error('\n  chromium-browser --remote-debugging-port=9222\n');
  } else {
    console.error('\nError:', err.message || err);
  }
  process.exit(1);
});
