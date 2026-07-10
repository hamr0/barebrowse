/**
 * consent-firefox.js — Auto-dismiss cookie consent dialogs on the Firefox/BiDi
 * engine, by walking the reconstructed AX tree (ax-snapshot.js).
 *
 * The CDP walker (consent.js) can't be reused verbatim: it consumes CDP's flat
 * getFullAXTree (nodes[] with parentId / role.value / backendDOMNodeId) and
 * clicks via DOM.resolveNode + Input.dispatchMouseEvent. The Firefox tree is a
 * DIFFERENT shape — nested `children`, string `role`/`name`, and each node's
 * `nodeId` IS its ref (stamped as data-bb-ref) — and clicks go through
 * input.performActions. So this is a parallel walker sharing only the language
 * patterns (consent-patterns.js).
 *
 * It's written as a PURE function over (root tree, click(ref)) so it can be
 * unit-tested against fixture trees with no browser: the caller (firefox-page)
 * injects a real click that routes ref → pointerClick. The nested tree also
 * makes "descendant of dialog" a plain subtree walk — no parentMap needed.
 */

import { ACCEPT_PATTERNS, DIALOG_ROLES, CONSENT_DIALOG_HINTS } from './consent-patterns.js';

/** Roles whose text confirms a container is a consent dialog. */
const CONSENT_TEXT_ROLES = new Set(['heading', 'StaticText', 'generic']);

/** Depth-first walk yielding every node in the subtree rooted at `node`. */
function* walk(node) {
  if (!node) return;
  yield node;
  for (const child of node.children || []) yield* walk(child);
}

/** True if any node in this subtree carries consent-hint text. */
function hasConsentContent(dialog) {
  for (const node of walk(dialog)) {
    if (node === dialog) continue;
    if (CONSENT_TEXT_ROLES.has(node.role) && CONSENT_DIALOG_HINTS.some((p) => p.test(node.name || ''))) {
      return true;
    }
  }
  return false;
}

/**
 * Find the best "accept" button inside a dialog subtree, honouring
 * ACCEPT_PATTERNS priority (most specific first).
 */
function findAcceptButton(dialog) {
  for (const pattern of ACCEPT_PATTERNS) {
    for (const node of walk(dialog)) {
      if (node.role === 'button' && node.name && pattern.test(node.name)) return node;
    }
  }
  return null;
}

/**
 * Fallback when no consent dialog container is found: scan the whole tree for a
 * button matching a STRONG (multi-word) accept pattern. Excludes the bare
 * ^accept$/^agree$/^ok$ fallbacks (last 3) so we don't false-match unrelated
 * page buttons — mirrors consent.js's tryGlobalConsentButton.
 */
function findGlobalAcceptButton(root) {
  const safePatterns = ACCEPT_PATTERNS.slice(0, -3);
  for (const pattern of safePatterns) {
    for (const node of walk(root)) {
      if (node.role === 'button' && node.name && pattern.test(node.name)) return node;
    }
  }
  return null;
}

/**
 * Try to dismiss a cookie consent dialog in a reconstructed Firefox AX tree.
 *
 * @param {object} root - Spliced AX tree root (from firefox-page's buildTree).
 * @param {(ref: string) => Promise<void>} click - Clicks the element for a ref
 *   (firefox-page injects one that routes to pointerClick / performActions).
 * @returns {Promise<boolean>} true if an accept button was found and clicked.
 */
export async function dismissConsentFirefox(root, click) {
  if (!root) return false;

  // Find dialog containers that look like consent dialogs.
  const consentDialogs = [];
  for (const node of walk(root)) {
    if (!DIALOG_ROLES.has(node.role)) continue;
    const name = node.name || '';
    if (CONSENT_DIALOG_HINTS.some((p) => p.test(name)) || hasConsentContent(node)) {
      consentDialogs.push(node);
    }
  }

  // Accept button inside a consent dialog (preferred — scoped, low false-positive).
  for (const dialog of consentDialogs) {
    const button = findAcceptButton(dialog);
    if (button?.nodeId) {
      try {
        await click(button.nodeId);
        return true;
      } catch {
        // Click failed (stale ref / navigated) — try the next dialog.
      }
    }
  }

  // No dialog (banner-style consent) or dialog with no in-scope button: fall
  // back to a page-wide strong-pattern scan.
  const global = findGlobalAcceptButton(root);
  if (global?.nodeId) {
    try {
      await click(global.nodeId);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
