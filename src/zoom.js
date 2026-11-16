/**
 * zoom.js — map + zoom for `snapshot()`.
 *
 * `map: true` lists the page's big boxes (landmarks, lists, tables, …) with a
 * ref and a size; `within` cuts the snapshot to one or more of them. The agent
 * picks the box — nothing here guesses which part of a page matters. Both
 * engines share this: they build the tree (and resolve any ref selector to a
 * node id in it), this module selects, formats and writes the output.
 *
 * Inside a zoom the box is the whole page: prune's landmark step and data
 * mode's main-only scope are off (`whole`), everything else prunes as usual.
 */

import { formatTree } from './aria.js';
import { prune } from './prune.js';
import { dataSnapshot, stripLegend } from './data.js';

/** Roles the map lists (when big enough, or when a `within` matched them). */
export const BOX_ROLES = new Set([
  'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'form', 'search',
  'list', 'table', 'grid', 'treegrid', 'feed', 'tablist', 'tabpanel', 'dialog',
]);

/** Card groups are never looked for inside these: link columns and menus there are not content. */
const CHROME_ROLES = new Set(['banner', 'navigation', 'contentinfo']);
/** Parents that are already a map box of their own kind: their items are a list or a table, not a card group. */
const NATIVE_BOX = new Set(['list', 'feed', 'table', 'grid', 'treegrid']);
/** Roles that are one cell of something else, never a card. */
const NOT_CARD = new Set(['row', 'tab', 'option', 'menuitem', 'treeitem', 'StaticText', 'heading', 'link', 'button', 'cell', 'gridcell', 'columnheader', 'rowheader', 'separator']);
const NOISE = new Set(['StaticText', 'InlineTextBox', 'LineBreak', 'ListMarker', 'none', 'presentation', 'generic', 'image', 'img']);
/** A card: at least this much text and this many nodes; a group: at least this many alike cards, and half of the parent's substantial children. */
const CARD = { text: 15, nodes: 4, run: 4, similar: 0.6 };

/** A box is listed when its data-mode text is at least this many chars. */
const MAP_MIN = 800;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const kids = (n) => n.children.flatMap((c) => (c.ignored ? kids(c) : [c]));

/**
 * One `within` selector: a ref, or role + optional name / preceding heading.
 * @typedef {{ raw: string, ref?: string, role?: string, name?: string, after?: string }} Selector
 */

/**
 * Parse `within` (one selector or an array).
 * @param {string|number|Array<string|number>} within
 * @returns {Selector[]}
 */
export function parseWithin(within) {
  const list = Array.isArray(within) ? within : [within];
  if (!list.length) throw new Error('within is empty — pass a ref, a role, role "name", or role after "heading"');
  return list.map((w) => {
    const raw = String(w).trim();
    if (/^\d+$/.test(raw)) return { raw, ref: raw };
    const m = raw.match(/^(\w+)(?: "(.*?)")?(?: after "(.*)")?$/);
    if (!m) throw new Error(`within: cannot parse ${JSON.stringify(raw)} — use a ref, a role, role "name", or role after "heading"`);
    /** @type {Selector} */
    const sel = { raw, role: m[1] };
    if (m[2] !== undefined) sel.name = norm(m[2]);
    if (m[3] !== undefined) sel.after = norm(m[3]);
    return sel;
  });
}

/** Every non-ignored node in page order, with the heading right before it among its siblings. */
function index(root) {
  const nodes = [];
  const after = new Map();
  (function walk(n) {
    if (!n.ignored) nodes.push(n);
    let heading = null; // text of the nearest preceding sibling heading; a box between ends it
    for (const c of kids(n)) {
      after.set(c, heading);
      if (c.role === 'heading' && norm(c.name)) heading = norm(c.name);
      else if (BOX_ROLES.has(c.role)) heading = null;
      walk(c);
    }
  })(root);
  let groups = null;
  return { nodes, after, groups: (links) => (groups ??= cardGroups(root, links)) };
}

/**
 * Card groups: a parent whose substantial children are mostly alike (same role, similar
 * child-role sets): a grid of product, listing or video cards that no landmark or list role
 * marks. Structure only. Not looked for inside banner/navigation/contentinfo, and not when
 * the parent is a list, table or the like (already a map box of its own kind). A landmark
 * parent (cards straight in `main`) is a group too; its ref is the landmark's. Returns parent node → { items, size }.
 * @returns {Map<object, {items: object[], size: number}>}
 */
function cardGroups(root, links) {
  const text = new Map();
  const count = new Map();
  (function tally(n) {
    let t = n.role === 'StaticText' ? norm(n.name).length : 0;
    let c = 1;
    for (const k of n.children) { tally(k); t += text.get(k); c += count.get(k); }
    text.set(n, t); count.set(n, c);
  })(root);
  // role set of a node's children and grandchildren, noise left out
  const shape = (n) => {
    const set = new Set();
    for (const c of kids(n)) {
      if (!NOISE.has(c.role)) set.add(c.role);
      for (const g of kids(c)) if (!NOISE.has(g.role)) set.add('>' + g.role);
    }
    return set;
  };
  const jaccard = (a, b) => {
    if (!a.size && !b.size) return 1;
    let both = 0;
    for (const x of a) if (b.has(x)) both++;
    return both / (a.size + b.size - both);
  };
  const isCard = (n) => !NOT_CARD.has(n.role) && text.get(n) >= CARD.text && count.get(n) >= CARD.nodes;

  const groups = new Map();
  (function walk(n) {
    if (!n.ignored && CHROME_ROLES.has(n.role)) return;
    const ks = kids(n);
    // Cluster the cards by role and shape; a group need not be contiguous (an ad between cards does not split it).
    const clusters = [];
    const cards = ks.filter(isCard);
    for (const k of cards) {
      const sh = shape(k);
      const c = clusters.find((x) => x.role === k.role && jaccard(x.shape, sh) >= CARD.similar);
      if (c) c.items.push(k); else clusters.push({ role: k.role, shape: sh, items: [k] });
    }
    const best = clusters.sort((a, b) => b.items.length - a.items.length)[0];
    if (best && best.items.length >= CARD.run && best.items.length >= 0.5 * cards.length) {
      if (!NATIVE_BOX.has(n.role)) {
        const size = best.items.reduce((sum, it) => sum + stripLegend(dataSnapshot(it, { links, whole: true })).length, 0);
        groups.set(n, { items: best.items, size });
      }
      return; // a group's cards are not searched for more groups
    }
    for (const c of ks) walk(c);
  })(root);
  return groups;
}

const label = (n, after, group) => (group ? `group ×${group.items.length}` : `${n.role}${n.name ? ` "${norm(n.name)}"` : after ? ` after "${after}"` : ''}`);
const sizeText = (n) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

/**
 * The map: one line per box, nested by box depth.
 *   - role "name" [ref=N] (14.9k chars)
 *   - list after "Other flights" [ref=N] (3.1k chars)    ← unnamed: its preceding heading
 *   - group ×18 (6.3k chars) [ref=N]                      ← a card group: its parent's ref, the cards' size
 * Size is the box's data-mode text. Boxes in `marked` are listed whatever their size.
 */
function mapLines(root, ix, links, marked = new Set()) {
  const lines = [];
  const groups = ix.groups(links);
  (function walk(n, depth) {
    let d = depth;
    if (!n.ignored && BOX_ROLES.has(n.role)) {
      const size = stripLegend(dataSnapshot(n, { links, whole: true })).length;
      if (size >= MAP_MIN || marked.has(n)) {
        lines.push(`${'  '.repeat(depth)}- ${label(n, ix.after.get(n))} [ref=${n.nodeId}] (${sizeText(size)} chars)${marked.has(n) ? ' <- match' : ''}`);
        d = depth + 1;
      }
    }
    const g = !n.ignored && groups.get(n);
    if (g && (g.size >= MAP_MIN || marked.has(n))) {
      lines.push(`${'  '.repeat(d)}- ${label(n, null, g)} (${sizeText(g.size)} chars) [ref=${n.nodeId}]${marked.has(n) ? ' <- match' : ''}`);
      d += 1;
    }
    for (const c of n.children) walk(c, d);
  })(root, 0);
  return lines;
}

/**
 * Write the map or a zoom of `tree`. Returns the finished snapshot text
 * (`head` is the url/warning prefix the engine builds), or throws.
 *
 * @param {object} tree - Pruning-ready tree (links already annotated)
 * @param {object} o
 * @param {string} o.head - Text placed first (url line, warnings)
 * @param {boolean} [o.map] - Write the map (ignored when `within` is set)
 * @param {Selector[]} [o.selectors] - parseWithin() result
 * @param {Map<string,string|null>} [o.refNodes] - ref selector → node id in `tree` (null: gone)
 * @param {'act'|'browse'|'navigate'|'full'|'read'|'data'} o.mode - Pruning mode
 * @param {boolean} o.links
 */
export function zoomSnapshot(tree, { head, map, selectors, refNodes = new Map(), mode, links }) {
  const ix = index(tree);
  const mapText = (lines, intro) => `${head}${intro}\n${lines.join('\n')}`;
  if (!selectors) {
    const lines = mapLines(tree, ix, links);
    return mapText(lines, `map: ${lines.length} boxes, size = chars in data mode. Zoom with within=<ref | role | role "name" | role after "heading"> (an array takes several boxes); any mode and links apply inside a zoom.`);
  }

  const found = selectors.map((s) => {
    if (s.ref) {
      const id = refNodes.get(s.ref);
      return id ? ix.nodes.filter((n) => n.nodeId === id) : [];
    }
    // a bare `group` names the card groups the map lists (the real group nodes only when there are none)
    if (s.role === 'group' && s.name === undefined && s.after === undefined && ix.groups(links).size) return [...ix.groups(links).keys()];
    return ix.nodes.filter((n) => n.role === s.role
      && (s.name === undefined || norm(n.name) === s.name)
      && (s.after === undefined || ix.after.get(n) === s.after));
  });
  const none = selectors.findIndex((_, i) => !found[i].length);
  if (none >= 0) {
    throw new Error(`within: nothing matches ${selectors[none].raw} — take a ref, role or name from snapshot({ map: true })`);
  }
  const many = selectors.filter((_, i) => found[i].length > 1);
  if (many.length) {
    const marked = new Set(found.filter((f) => f.length > 1).flat());
    const what = many.map((s) => `${s.raw} (${found[selectors.indexOf(s)].length})`).join(', ');
    return mapText(mapLines(tree, ix, links, marked),
      `within matched more than one box: ${what}. Marked "<- match" below; pick by ref, or add a name or after "heading".`);
  }

  // Page order, and a box inside another selected box is not repeated.
  const picked = new Set(found.flat());
  const boxes = [];
  (function walk(n) {
    if (picked.has(n)) { boxes.push(n); return; }
    for (const c of n.children) walk(c);
  })(tree);
  const parts = boxes.map((b) => ({
    raw: formatTree(b),
    out: mode === 'data'
      ? dataSnapshot(b, { links, whole: true })
      : formatTree(prune(b, { mode, links, whole: true })),
  }));
  const body = parts.map((p, i) => (i && mode === 'data' ? stripLegend(p.out) : p.out)).filter(Boolean).join('\n');
  const rawLen = parts.reduce((s, p) => s + p.raw.length, 0);
  const sized = parts.reduce((s, p) => s + stripLegend(p.out).length, 0);
  const what = boxes.map((b) => `${label(b, ix.after.get(b), !BOX_ROLES.has(b.role) && ix.groups(links).get(b))} [ref=${b.nodeId}]`).join(', ');
  return `${head}zoom ${what}: ${rawLen.toLocaleString()} chars → ${sized.toLocaleString()} chars (${rawLen ? Math.round((1 - sized / rawLen) * 100) : 0}% pruned)\n${body}`;
}

/**
 * Why a zoom/map came back as a file path only: it is over the inline cap.
 * @param {'zoom'|'map'} kind
 * @param {number} chars
 * @param {number} limit
 * @param {boolean} [cli] - flag spelling (--max-chars, --map) instead of tool arguments
 */
export function overNote(kind, chars, limit, cli = false) {
  const cap = cli ? '--max-chars' : 'maxChars';
  const fix = kind === 'zoom' ? `raise ${cap}, or zoom a smaller box (from ${cli ? '--map' : 'map:true'})` : `raise ${cap}`;
  return `The ${kind} was ${chars} chars, over ${cap} (${limit}): ${fix} to get it inline.`;
}
