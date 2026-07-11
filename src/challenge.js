/**
 * challenge.js — Bot-challenge / interstitial detection for the hybrid fallback.
 *
 * Extracted from index.js so both engines can share it without a circular
 * import (index.js drives CDP; firefox-page.js drives BiDi, and both need to
 * decide "is this a Cloudflare/hCaptcha wall we should retry headed?"). Pure —
 * operates on the nested ARIA tree that buildTree() / ariaTree() produce, which
 * is identical in shape across engines.
 */

/**
 * Heuristic: does this ARIA tree look like a bot-challenge / block interstitial
 * (Cloudflare "Just a moment", hCaptcha, Akamai) rather than real content?
 *
 * H9 split: STRONG_PHRASES are essentially-unambiguous challenge UI and fire
 * regardless of page size; WEAK_PHRASES only fire when the page is ALSO tiny
 * (so a legitimate-looking error page with "access denied" in its body doesn't
 * trip the fallback).
 *
 * @param {object} tree - Nested ARIA tree (from buildTree / ariaTree)
 * @param {number} [nodeCount] - Node count (CDP: getFullAXTree; BiDi: tree walk)
 * @returns {boolean}
 */
export function isChallengePage(tree, nodeCount) {
  if (!tree) return true; // truly empty AX tree — something went wrong fetching the page

  const text = flattenTreeText(tree);
  const lower = text.toLowerCase();

  // Strong phrases — distinctive enough to identify the challenge product
  // by name. Fire on their own regardless of node count.
  const STRONG_PHRASES = [
    'just a moment',                            // Cloudflare interstitial
    'checking if the site connection is secure', // Cloudflare
    'checking your browser',                     // Various JS challenges
    'verify you are human',                      // hCaptcha / reCAPTCHA
    'prove your humanity',
    'attention required',                        // Cloudflare block page
    'enable javascript and cookies to continue', // Cloudflare
    'please complete the security check',        // Cloudflare/Akamai
  ];
  if (STRONG_PHRASES.some((p) => lower.includes(p))) return true;

  // Weak phrases — show up on real challenge pages but ALSO on legitimate
  // small error pages. Only count when the page is itself tiny (low node
  // count or near-empty text), which is the corroborating signal that
  // separates a real error UI from a challenge skeleton.
  const WEAK_PHRASES = [
    'please wait',
    'request blocked',
    'access denied',
    'permission denied',
    'unknown error',
    'file a ticket',
  ];
  const tinyPage = (nodeCount !== undefined && nodeCount < 30) || text.trim().length < 50;
  if (tinyPage && WEAK_PHRASES.some((p) => lower.includes(p))) return true;

  return false;
}

/** Count every node in a nested ARIA tree (shared node-count for the tinyPage test). */
export function countNodes(node) {
  if (!node) return 0;
  let n = 1;
  for (const c of node.children || []) n += countNodes(c);
  return n;
}

function flattenTreeText(node) {
  if (!node) return '';
  let text = node.name || '';
  for (const child of node.children || []) {
    text += ' ' + flattenTreeText(child);
  }
  return text;
}
