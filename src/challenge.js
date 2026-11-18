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
 * Besides phrases, a structural check catches challenges that carry no fixed
 * wording (HUMAN/PerimeterX "Press & Hold": an iframe named "Human verification
 * challenge"): see hasChallengeFrame().
 *
 * @param {object} tree - Nested ARIA tree (from buildTree / ariaTree)
 * @param {number} [nodeCount] - Node count (CDP: getFullAXTree; BiDi: tree walk)
 * @param {{ mitigated?: boolean }} [opts] - mitigated: the main document answered with
 *   Cloudflare's `cf-mitigated: challenge` header (language-free, certain)
 * @returns {boolean}
 */
export function isChallengePage(tree, nodeCount, opts = {}) {
  if (opts.mitigated) return true;
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
    'robot or human?',                           // HUMAN/PerimeterX (Walmart): its heading, also on Firefox where the iframe never renders
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

  return hasChallengeFrame(tree);
}

const FRAME_ROLES = new Set(['Iframe', 'IframePresentational']);
const FRAME_NAME = /challenge|captcha|verif/i;
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'spinbutton', 'slider']);
const SMALL_PAGE = 150;

/**
 * Structural challenge test: an iframe named like a challenge/captcha widget
 * is an interstitial when its surroundings are nothing else, i.e. it sits in a
 * dialog (or, with no dialog, on a small page) that holds no form field of its
 * own outside iframes (on a whole small page, no button either). Page size counts
 * only nodes a snapshot would show: raw trees are mostly ignored nodes (N34). A sign-in form carrying a reCAPTCHA/hCaptcha widget has
 * fields, so it is not flagged.
 */
function hasChallengeFrame(tree) {
  let found = false;
  (function walk(node, scope) {
    if (found) return;
    const here = node.role === 'dialog' || node.role === 'alertdialog' ? node : scope;
    if (FRAME_ROLES.has(node.role) && FRAME_NAME.test(node.name || '')) {
      // A whole small page also counts buttons as form (a "Submit" next to the widget);
      // inside a dialog they don't (a close button is not a form).
      const area = here || (countVisible(tree) < SMALL_PAGE ? tree : null);
      if (area && !hasField(area, !here)) found = true;
      return;
    }
    for (const c of node.children || []) walk(c, here);
  })(tree, null);
  return found;
}

/** Nodes formatTree() would print: not ignored, not InlineTextBox/LineBreak. */
function countVisible(node) {
  let n = node.ignored || node.role === 'InlineTextBox' || node.role === 'LineBreak' ? 0 : 1;
  for (const c of node.children || []) n += countVisible(c);
  return n;
}

/** Any form field in this subtree, not looking inside iframes (their content is the widget's). */
function hasField(node, buttons) {
  if (FIELD_ROLES.has(node.role) || (buttons && node.role === 'button')) return true;
  if (FRAME_ROLES.has(node.role)) return false;
  return (node.children || []).some((c) => hasField(c, buttons));
}

/** The snapshot's first line when a page was flagged (both engines); callers should read page.botBlocked, not match this. */
export const BOT_WARNING = '[BOT CHALLENGE DETECTED — page content may be incomplete or blocked]\n';

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
