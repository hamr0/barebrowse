/**
 * consent.js — Auto-dismiss cookie consent dialogs via ARIA tree inspection.
 *
 * Scans the page ARIA tree for consent dialogs and clicks the "accept" button.
 * Works across languages by matching common accept/agree patterns.
 * Runs once after page load — no polling, no mutation observers.
 */

// Button text patterns that mean "accept all" / "I agree" across common languages.
// Order matters: more specific patterns first to avoid false positives.
const ACCEPT_PATTERNS = [
  // English
  /\baccept\s*all\b/i,
  /\ballow\s*all\b/i,
  /\bagree\s*to\s*all\b/i,
  /\byes,?\s*i\s*agree\b/i,
  /\bi\s*agree\b/i,
  /\baccept\s*cookies?\b/i,
  /\ballow\s*cookies?\b/i,
  /\bgot\s*it\b/i,
  // Dutch
  /\balles\s*accepteren\b/i,
  /\balles\s*toestaan\b/i,
  /\bakkoord\b/i,
  // German
  /\balle\s*akzeptieren\b/i,
  /\ballem\s*zustimmen\b/i,
  /\balle\s*cookies?\s*akzeptieren\b/i,
  // French
  /\btout\s*accepter\b/i,
  /\baccepter\s*tout\b/i,
  /\bj['']accepte\b/i,
  // Spanish
  /\baceptar\s*todo\b/i,
  /\baceptar\s*todas?\b/i,
  // Italian
  /\baccetta\s*tutto\b/i,
  /\baccetto\b/i,
  // Portuguese
  /\baceitar\s*tudo\b/i,
  // Generic single-word fallbacks (only matched inside dialogs)
  /^accept$/i,
  /^agree$/i,
  /^ok$/i,
];

// Roles that indicate a consent dialog container.
const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);

// Text patterns in dialog names/headings that confirm it's about consent.
const CONSENT_DIALOG_HINTS = [
  /cookie/i,
  /consent/i,
  /privacy/i,
  /voordat\s*je\s*verdergaat/i,  // Dutch: "Before you continue"
  /before\s*you\s*continue/i,
  /bevor\s*du\s*fortf/i,         // German: "Before you continue"
  /avant\s*de\s*continuer/i,     // French: "Before you continue"
];

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
        await jsClick(session, button.backendDOMNodeId);
        await new Promise((r) => setTimeout(r, 1000));
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
  // Only use the specific multi-word patterns for global search
  const strictPatterns = ACCEPT_PATTERNS.filter((p) => {
    const src = p.source;
    return src.includes('\\s') || src.includes('\\b.*\\b.*\\b');
  });

  // Actually, let's just use all non-single-word patterns
  const safePatterns = ACCEPT_PATTERNS.slice(0, -3); // exclude ^accept$, ^agree$, ^ok$

  for (const pattern of safePatterns) {
    for (const node of nodes) {
      if (node.role?.value !== 'button') continue;
      const name = node.name?.value || '';
      if (name && pattern.test(name) && node.backendDOMNodeId) {
        return jsClick(session, node.backendDOMNodeId)
          .then(() => new Promise((r) => setTimeout(r, 1000)))
          .then(() => true)
          .catch(() => false);
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
