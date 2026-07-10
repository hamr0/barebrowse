/**
 * consent.js — Auto-dismiss cookie consent dialogs via ARIA tree inspection.
 *
 * Scans the page ARIA tree for consent dialogs and clicks the "accept" button.
 * Works across languages by matching common accept/agree patterns.
 * Runs once after page load — no polling, no mutation observers.
 *
 * The multilingual pattern sets live in consent-patterns.js (shared with the
 * Firefox/BiDi walker in consent-firefox.js); this file owns the CDP-specific
 * tree walk + click.
 */

import { ACCEPT_PATTERNS, DIALOG_ROLES, CONSENT_DIALOG_HINTS } from './consent-patterns.js';

/**
 * Click a node via JavaScript .click() instead of mouse events.
 * Bypasses iframe overlays and z-index issues that block coordinate-based clicks.
 */
async function jsClick(session, backendNodeId) {
  const { object } = await session.send('DOM.resolveNode', { backendNodeId });
  await session.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function() { this.click(); }',
  });
}

/**
 * Click a node via real mouse events (scrollIntoView → getBoxModel → mousePressed/Released).
 * Some CMPs ignore synthetic .click() and only respond to real Input events.
 */
async function realClick(session, backendNodeId) {
  await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
  const { model } = await session.send('DOM.getBoxModel', { backendNodeId });
  const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
  const cx = (x1 + x3) / 2;
  const cy = (y1 + y3) / 2;
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
}

/**
 * Try to dismiss a cookie consent dialog on the current page.
 * Inspects the ARIA tree for dialog elements with consent-related content,
 * then clicks the "accept" button.
 *
 * @param {object} session - Session-scoped CDP handle
 * @returns {Promise<boolean>} true if a consent dialog was dismissed
 */
export async function dismissConsent(session) {
  await session.send('Accessibility.enable');
  const { nodes } = await session.send('Accessibility.getFullAXTree');

  // Build a parent lookup: nodeId → parentId
  const parentMap = new Map();
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
    if (node.parentId) parentMap.set(node.nodeId, node.parentId);
  }

  // Find dialog nodes that look like consent dialogs
  const consentDialogs = new Set();
  for (const node of nodes) {
    const role = node.role?.value;
    if (!DIALOG_ROLES.has(role)) continue;

    const name = node.name?.value || '';
    // Check if dialog name hints at consent
    if (CONSENT_DIALOG_HINTS.some((p) => p.test(name))) {
      consentDialogs.add(node.nodeId);
      continue;
    }

    // Check children for consent-related headings/text
    if (hasConsentContent(node.nodeId, nodes, nodeMap, parentMap)) {
      consentDialogs.add(node.nodeId);
    }
  }

  // If no consent dialog found, scan for consent-related buttons anywhere
  // (some sites use banners, not dialogs)
  if (consentDialogs.size === 0) {
    return tryGlobalConsentButton(nodes, session);
  }

  // Find accept buttons inside consent dialogs
  for (const dialogId of consentDialogs) {
    const button = findAcceptButton(dialogId, nodes, nodeMap, parentMap);
    if (button?.backendDOMNodeId) {
      try {
        // Try jsClick first (bypasses iframe overlays)
        await jsClick(session, button.backendDOMNodeId);
        await new Promise((r) => setTimeout(r, 1000));
        // Check if consent actually dismissed — some CMPs ignore synthetic clicks
        const { nodes: nodesAfter } = await session.send('Accessibility.getFullAXTree');
        const stillThere = nodesAfter.some((n) =>
          n.role?.value === 'button' && n.name?.value === button.name?.value
        );
        if (stillThere) {
          // Retry with real mouse event
          await realClick(session, button.backendDOMNodeId);
          await new Promise((r) => setTimeout(r, 1000));
        }
        return true;
      } catch {
        // Click failed — try next dialog
      }
    }
  }

  // Dialog found but no accept button inside it — some sites put the button
  // outside the dialog (e.g. BBC's SourcePoint). Fall through to global scan.
  return tryGlobalConsentButton(nodes, session);
}

/**
 * Check if a dialog contains consent-related content in its descendants.
 */
function hasConsentContent(dialogId, nodes, nodeMap, parentMap) {
  for (const node of nodes) {
    if (!isDescendantOf(node.nodeId, dialogId, parentMap)) continue;
    const role = node.role?.value;
    const name = node.name?.value || '';

    // Check headings and static text within the dialog
    if (role === 'heading' || role === 'StaticText' || role === 'generic') {
      if (CONSENT_DIALOG_HINTS.some((p) => p.test(name))) return true;
    }
  }
  return false;
}

/**
 * Find the best "accept" button inside a dialog subtree.
 */
function findAcceptButton(dialogId, nodes, nodeMap, parentMap) {
  for (const pattern of ACCEPT_PATTERNS) {
    for (const node of nodes) {
      if (node.role?.value !== 'button') continue;
      const name = node.name?.value || '';
      if (!name || !pattern.test(name)) continue;
      if (!isDescendantOf(node.nodeId, dialogId, parentMap)) continue;
      return node;
    }
  }
  return null;
}

/**
 * Fallback: look for consent buttons anywhere on the page.
 * Only matches strong patterns (not single-word fallbacks) to avoid false positives.
 */
function tryGlobalConsentButton(nodes, session) {
  // Multi-word patterns only — exclude the bare ^accept$/^agree$/^ok$ from
  // ACCEPT_PATTERNS so we don't false-match unrelated buttons page-wide.
  const safePatterns = ACCEPT_PATTERNS.slice(0, -3);

  for (const pattern of safePatterns) {
    for (const node of nodes) {
      if (node.role?.value !== 'button') continue;
      const name = node.name?.value || '';
      if (name && pattern.test(name) && node.backendDOMNodeId) {
        return (async () => {
          try {
            await jsClick(session, node.backendDOMNodeId);
            await new Promise((r) => setTimeout(r, 1000));
            // Check if button still exists — retry with real click if so
            const { nodes: nodesAfter } = await session.send('Accessibility.getFullAXTree');
            const stillThere = nodesAfter.some((n) =>
              n.role?.value === 'button' && n.name?.value === name
            );
            if (stillThere) {
              await realClick(session, node.backendDOMNodeId);
              await new Promise((r) => setTimeout(r, 1000));
            }
            return true;
          } catch {
            return false;
          }
        })();
      }
    }
  }

  return Promise.resolve(false);
}

/**
 * Check if nodeId is a descendant of ancestorId by walking parentMap.
 */
function isDescendantOf(nodeId, ancestorId, parentMap) {
  let current = parentMap.get(nodeId);
  while (current) {
    if (current === ancestorId) return true;
    current = parentMap.get(current);
  }
  return false;
}
