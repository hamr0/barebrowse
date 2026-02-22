/**
 * prune.js — ARIA tree pruning for agent consumption.
 *
 * Ported from mcprune. Pure function: tree in, pruned tree out.
 * Zero deps, zero I/O.
 *
 * Node shape (from CDP Accessibility.getFullAXTree, after buildTree):
 *   { nodeId, role, name, properties: { level, checked, ... }, ignored, children }
 *
 * We adapt mcprune's logic which used:
 *   { role, name, ref, states: { level, checked }, text, children }
 *
 * The mapping:
 *   mcprune.ref       → nodeId
 *   mcprune.states    → properties
 *   mcprune.text      → StaticText child's name (CDP has no inline text)
 */

// --- Role taxonomy (from mcprune/roles.js) ---

const LANDMARKS = new Set([
  'banner', 'main', 'contentinfo', 'navigation', 'complementary',
  'search', 'form', 'region',
]);

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio',
  'combobox', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'slider', 'spinbutton', 'switch', 'tab', 'treeitem',
]);

const GROUPS = new Set([
  'radiogroup', 'tablist', 'menu', 'menubar', 'toolbar',
  'listbox', 'tree', 'treegrid', 'grid',
]);

const STRUCTURAL = new Set([
  'generic', 'group', 'list', 'table', 'row', 'rowgroup', 'cell',
  'directory', 'document', 'application', 'presentation', 'none', 'separator',
  // CDP-specific roles that map to structural
  'LayoutTable', 'LayoutTableRow', 'LayoutTableCell',
]);

const MODE_REGIONS = {
  act: new Set(['main']),
  browse: new Set(['main']),
  navigate: new Set(['main', 'banner', 'navigation', 'search']),
  full: new Set(['main', 'banner', 'navigation', 'contentinfo', 'complementary', 'search']),
};

// Roles that are rendering noise — skip entirely
const SKIP_ROLES = new Set([
  'InlineTextBox', 'LineBreak', 'superscript',
]);

// --- Main export ---

/**
 * Prune an ARIA tree for agent consumption.
 *
 * @param {object} tree - Root node from buildTree() (CDP format)
 * @param {object} [options]
 * @param {'act'|'browse'|'navigate'|'full'} [options.mode='act'] - Pruning mode
 * @param {string} [options.context=''] - Search context for relevance filtering
 * @returns {object|null} Pruned tree
 */
export function prune(tree, options = {}) {
  const { mode = 'act', context = '' } = options;
  const allowedRegions = MODE_REGIONS[mode] || MODE_REGIONS.act;
  const isBrowse = mode === 'browse';
  const keywords = context
    ? context.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
    : [];

  // Wrap as array for pipeline
  let nodes = tree ? [tree] : [];

  // Step 1: Extract landmark regions
  nodes = extractRegions(nodes, allowedRegions);

  // Step 2: Prune nodes
  const ctx = { mode, parentRole: null, keywords };
  nodes = nodes.map((n) => pruneNode(n, ctx)).filter(Boolean);

  // Step 3: Collapse structural wrappers
  nodes = nodes.map((n) => collapse(n)).filter(Boolean);

  // Step 4: Post-clean (combobox trim, orphaned headings)
  nodes = nodes.map((n) => postClean(n, isBrowse)).filter(Boolean);

  // Steps 5-8: E-commerce noise removal (skip in browse mode)
  if (!isBrowse) {
    nodes = dedupLinks(nodes);
    nodes = nodes.map((n) => dropNoiseButtons(n)).filter(Boolean);
    nodes = truncateAfterFooter(nodes);
    nodes = nodes.map((n) => dropFilterGroups(n)).filter(Boolean);
  }

  // Return single root or wrap multiple
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0];
  return { nodeId: '', role: 'root', name: '', properties: {}, ignored: false, children: nodes };
}

// --- Step 1: Region extraction ---

function extractRegions(nodes, allowedRegions) {
  // Unwrap RootWebArea
  if (nodes.length === 1 && (nodes[0].role === 'RootWebArea' || nodes[0].role === 'WebArea')) {
    nodes = nodes[0].children;
  }

  const hasLandmarks = nodes.some((n) => LANDMARKS.has(n.role));
  const mainNode = nodes.find((n) => n.role === 'main');
  const hasMain = mainNode ? (hasInteractive(mainNode) || hasHeading(mainNode)) : false;

  const results = [];
  for (const node of nodes) {
    if (LANDMARKS.has(node.role)) {
      if (isRegionAllowed(node, allowedRegions)) results.push(node);
    } else if (hasLandmarks && hasMain) {
      if (allowedRegions.has('navigation')) results.push(node);
    } else if (hasLandmarks && !hasMain) {
      if (hasInteractive(node) || hasHeading(node)) results.push(node);
    } else {
      results.push(node);
    }
  }
  return results;
}

function isRegionAllowed(node, allowedRegions) {
  if (allowedRegions.has(node.role)) return true;
  if (node.role === 'region' && allowedRegions.has('main')) {
    const auxPatterns = /image|review|recommend|related|similar|also viewed|cookie/i;
    if (node.name && auxPatterns.test(node.name)) return false;
    return true;
  }
  return false;
}

// --- Step 2: Node pruning ---

function pruneNode(node, ctx) {
  if (!node) return null;

  // Skip rendering noise
  if (SKIP_ROLES.has(node.role)) return null;

  const isBrowse = ctx.mode === 'browse';
  const level = node.properties?.level;

  // Drop links inside paragraphs in act mode
  if (ctx.mode === 'act' && node.role === 'link' && ctx.parentRole === 'paragraph') {
    return null;
  }

  // Paragraphs: drop in act, keep in browse
  if (node.role === 'paragraph') {
    if (ctx.mode === 'act') return null;
    return { ...node, children: pruneChildren(node.children, ctx) };
  }

  // Navigation inside main: drop in browse (page chrome)
  if (isBrowse && node.role === 'navigation') return null;

  // Code blocks: keep as-is
  if (node.role === 'code') return node;

  // Term/definition: keep + recurse
  if (node.role === 'term' || node.role === 'definition') {
    return { ...node, children: pruneChildren(node.children, ctx) };
  }

  // Strong/emphasis/blockquote: keep in browse
  if (isBrowse && (node.role === 'strong' || node.role === 'emphasis' || node.role === 'blockquote')) {
    return { ...node, children: pruneChildren(node.children, ctx) };
  }

  // Figures in browse: caption text
  if (isBrowse && node.role === 'figure') {
    if (node.name) {
      return { ...node, role: 'StaticText', name: `[Figure: ${node.name}]`, children: [] };
    }
    return null;
  }

  // Interactive elements: always keep
  if (INTERACTIVE.has(node.role)) {
    return { ...node, children: pruneChildren(node.children, ctx) };
  }

  // Context-aware: collapse non-matching product cards
  if (!isBrowse && ctx.keywords.length > 0 && node.role === 'listitem' && hasInteractive(node)) {
    const text = extractText(node).toLowerCase();
    if (!ctx.keywords.some((kw) => text.includes(kw))) {
      return condenseCard(node);
    }
  }

  // Named groups: keep
  if (GROUPS.has(node.role) && node.name) {
    return { ...node, children: pruneChildren(node.children, ctx) };
  }
  if (node.role === 'group' && node.name) {
    if (!isBrowse && /kleuren|colors?|couleurs?|farben/i.test(node.name)) {
      return collapseColors(node);
    }
    return { ...node, children: pruneChildren(node.children, ctx) };
  }

  // Headings
  if (node.role === 'heading') {
    if (!isBrowse && level !== '1' && level !== 1) {
      if (node.name && /about this|description|detail|feature|specification|overview/i.test(node.name)) {
        return null;
      }
    }
    return { ...node, children: [] };
  }

  // StaticText — CDP equivalent of mcprune's "text" nodes
  if (node.role === 'StaticText') {
    return keepText(node, ctx.mode) ? node : null;
  }

  // Images: drop in act, keep named in browse
  if (node.role === 'img' || node.role === 'image') {
    if (isBrowse && node.name) return { ...node, children: [] };
    return null;
  }

  // Separators: drop
  if (node.role === 'separator') return null;

  // Complementary: keep in browse, drop in act
  if (node.role === 'complementary') {
    if (isBrowse) return { ...node, children: pruneChildren(node.children, ctx) };
    return null;
  }

  // Aux regions: drop in act
  if (node.role === 'region' && !isBrowse) {
    if (node.name && /image|review|recommend|related|similar|also viewed/i.test(node.name)) {
      return null;
    }
  }

  // Note/status: keep in browse
  if (isBrowse && (node.role === 'note' || node.role === 'status')) {
    return { ...node, children: pruneChildren(node.children, ctx) };
  }

  // Structural: recurse, keep if has children
  const childCtx = { ...ctx, parentRole: node.role };
  const keptChildren = pruneChildren(node.children, childCtx);

  // Drop text-only lists in act mode
  if (!isBrowse) {
    if (node.role === 'list' && keptChildren.every((c) => !hasInteractive(c))) return null;
    if (node.role === 'listitem' && !hasInteractive(node)) return null;
  }

  if (keptChildren.length > 0) return { ...node, children: keptChildren };
  return null;
}

function pruneChildren(children, ctx) {
  if (!children) return [];
  return children.map((c) => pruneNode(c, ctx)).filter(Boolean);
}

function keepText(node, mode) {
  const t = node.name || '';
  if (!t) return false;

  // Browse: keep all except separator noise
  if (mode === 'browse') {
    if (t.length <= 2 && /^[|»·•→←>\-]$/.test(t.trim())) return false;
    return true;
  }

  // Act: prices, stock, shipping, short labels
  if (/\$[\d,]+\.?\d*|€[\d,]+/.test(t)) return true;
  if (/in stock|out of stock|unavailable|available/i.test(t)) return true;
  if (/delivery|shipping|free/i.test(t)) return true;
  if (t.length < 40 && t.endsWith(':')) return true;
  if (t.length < 30) return true;
  return false;
}

// --- Step 3: Collapse structural wrappers ---

function collapse(node) {
  if (!node) return null;

  node = { ...node, children: node.children.map((c) => collapse(c)).filter(Boolean) };

  const isTableLayout = /^LayoutTable/.test(node.role) ||
    node.role === 'row' || node.role === 'cell' || node.role === 'rowgroup';

  if ((STRUCTURAL.has(node.role) && !node.name) || isTableLayout) {
    if (node.children.length === 1) return node.children[0];
    if (node.children.length > 0) {
      return { ...node, role: '_promote', children: node.children };
    }
    return null;
  }

  return node;
}

// --- Step 4: Post-clean ---

function postClean(node, isBrowse) {
  if (!node) return null;

  if (node.role === 'combobox' || node.role === 'listbox') {
    const selected = node.children.find((c) => c.properties?.selected);
    return { ...node, name: selected?.name || node.name, children: [] };
  }

  node = { ...node, children: node.children.map((c) => postClean(c, isBrowse)).filter(Boolean) };

  if (!isBrowse && node.children) {
    node = { ...node, children: dropOrphanedHeadings(node.children) };
  }

  return node;
}

function dropOrphanedHeadings(children) {
  const result = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const level = child.properties?.level;
    if (child.role === 'heading' && level !== '1' && level !== 1) {
      let found = false;
      for (let j = i + 1; j < children.length; j++) {
        if (children[j].role === 'heading') break;
        if (hasInteractive(children[j])) { found = true; break; }
      }
      if (!found) continue;
    }
    result.push(child);
  }
  return result;
}

// --- Steps 5-8: E-commerce noise ---

function dedupLinks(nodes) {
  const seen = new Map();
  return nodes.map((n) => dedupLinksIn(n, seen)).filter(Boolean);
}

function dedupLinksIn(node, seen) {
  if (!node) return null;
  if (node.role === 'link' && node.name) {
    if (seen.has(node.name)) return null;
    seen.set(node.name, true);
  }
  if (node.role === 'listitem') {
    const local = new Map();
    node = { ...node, children: node.children.map((c) => dedupLinksIn(c, local)).filter(Boolean) };
    return node.children.length > 0 ? node : null;
  }
  node = { ...node, children: node.children.map((c) => dedupLinksIn(c, seen)).filter(Boolean) };
  return node;
}

const NOISE_BUTTONS = /energieklasse|energy\s*class|productinformatieblad|product\s*information\s*sheet|gesponsorde|sponsored|ad\s*feedback|sterren.*details.*beoordeling|stars.*rating\s*detail/i;
const NOISE_LINKS = /^opties bekijken$|^view options$|^see options$|^voir les options$/i;
const FOOTER_LINKS = /gebruiks.*voorwaarden|conditions.*use|privacy|cookie|contactgegevens|contact\s*info|advertenties|interest.*ads|lees\s*meer\s*over\s*deze\s*resultaten/i;

function dropNoiseButtons(node) {
  if (!node) return null;
  if (node.role === 'button' && node.name && NOISE_BUTTONS.test(node.name)) return null;
  if (node.role === 'link' && node.name && (NOISE_LINKS.test(node.name) || FOOTER_LINKS.test(node.name))) return null;
  node = { ...node, children: node.children.map((c) => dropNoiseButtons(c)).filter(Boolean) };
  return node;
}

function truncateAfterFooter(nodes) {
  const result = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (isFooterMarker(node)) break;
    if (isSkippable(node)) continue;
    if (node.children?.length > 0) {
      const trimmed = { ...node, children: truncateAfterFooter(node.children) };
      if (trimmed.children.length === 0 && STRUCTURAL.has(trimmed.role)) continue;
      result.push(trimmed);
    } else {
      result.push(node);
    }
  }
  return result;
}

function isFooterMarker(node) {
  if (node.role === 'button' && node.name && /terug naar boven|back to top/i.test(node.name)) return true;
  const level = node.properties?.level;
  if (node.role === 'heading' && (level === '6' || level === 6)) return true;
  if (node.role === 'heading' && node.name && /gerelateerde zoek|related search|hulp nodig|need help/i.test(node.name)) return true;
  return false;
}

function isSkippable(node) {
  return node.role === 'dialog' && node.name && /filter/i.test(node.name);
}

const FILTER_GROUP = /toepassen om de resultaten|filter.*to narrow|apply.*filter|refine by/i;

function dropFilterGroups(node) {
  if (!node) return null;
  if (node.role === 'group' && node.name && FILTER_GROUP.test(extractText(node))) return null;
  node = { ...node, children: node.children.map((c) => dropFilterGroups(c)).filter(Boolean) };
  if (STRUCTURAL.has(node.role) && !node.name && node.children.length === 0) return null;
  return node;
}

// --- Helpers ---

function hasInteractive(node) {
  if (INTERACTIVE.has(node.role) || GROUPS.has(node.role)) return true;
  return node.children?.some((c) => hasInteractive(c)) ?? false;
}

function hasHeading(node) {
  if (node.role === 'heading') return true;
  return node.children?.some((c) => hasHeading(c)) ?? false;
}

function extractText(node) {
  let text = node.name || '';
  for (const child of (node.children || [])) text += ' ' + extractText(child);
  return text;
}

function flatten(nodes) {
  const result = [];
  for (const n of nodes) {
    result.push(n);
    if (n.children) result.push(...flatten(n.children));
  }
  return result;
}

function condenseCard(node) {
  const all = flatten([node]);
  const link = all.find((n) => n.role === 'link' && n.name);
  if (!link) return null;
  return {
    nodeId: node.nodeId, role: 'listitem', name: '', properties: {},
    ignored: false, children: [{ ...link, children: [] }],
  };
}

function collapseColors(node) {
  const all = flatten([node]);
  const colors = all.filter((n) => n.role === 'link' && n.name && !n.name.startsWith('+'))
    .map((n) => n.name);
  if (colors.length === 0) {
    const plus = all.find((n) => n.role === 'link' && n.name);
    return plus ? { ...plus, children: [] } : null;
  }
  return {
    nodeId: node.nodeId, role: 'StaticText', name: `colors(${colors.length}): ${colors.join(', ')}`,
    properties: {}, ignored: false, children: [],
  };
}
