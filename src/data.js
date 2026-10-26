/**
 * data.js — "data" snapshot mode: one line per record.
 *
 * For pages that are data, not prose (tables, listings, feeds, search results).
 * Takes the RAW tree from buildTree() (not a pruned one: prune.js collapse()
 * destroys table structure) and returns text. Never touches prune.js/aria.js.
 *
 * Rules, applied in this order:
 *   Clean pass (N1-N6) — per node, bottom-up
 *     N1  drop rendering noise (InlineTextBox, LineBreak, ListMarker, images)
 *     N2  drop StaticText with no letter/digit (whitespace, punctuation)
 *     N3  StaticText keeps only its text (no role word on output)
 *     N4  drop children whose text is already inside a content-derived name
 *         (unless the child is, or holds, something interactive)
 *     N5  unwrap unnamed wrappers; all-text wrappers become one text leaf
 *     N6  drop empty/nameless leaves that say nothing and can't be targeted
 *   Repeated siblings (R1-R3)
 *     R1  a run of >=3 same-shape leaves collapses to "label: a, b, c"
 *     R2  a run of 2 collapses too when a >=3 run of the same shape and
 *         lead-in exists in the same sibling list ("weak pair")
 *     R3  label = lead-in leaves back to a heading/interactive anchor, else the
 *         nearest preceding heading, else the nearest named container
 *   Tables (T1-T4)
 *     T1  header rows (columnheader-only) become the column names
 *     T2  data row -> `row "<row header>": Header: value · Header: value`
 *     T3  header/row width mismatch (CDP exposes no colspan): drop the
 *         positional mapping, print `columns:` once, rows stay header-less
 *     T4  one value filling most cells of a wide row is stated once
 *
 * Scope: the main landmark if there is one, else the whole page.
 * Refs: `[ref=N]` on interactive nodes only (same ids as act/read, so
 * click/type resolve through the same refMap).
 */

const SKIP = new Set(['InlineTextBox', 'LineBreak', 'ListMarker', 'image', 'img']);
const CELLS = new Set(['cell', 'gridcell', 'columnheader', 'rowheader']);
const TABLES = new Set(['table', 'grid', 'treegrid']);
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton', 'switch', 'tab', 'treeitem']);
// Roles whose accessible name is computed from content (ARIA name-from-content):
// a child whose text is already inside the name is redundant.
const NFC = new Set(['link', 'button', 'heading', 'generic', 'cell', 'gridcell', 'columnheader', 'rowheader', 'listitem', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'checkbox', 'radio', 'switch', 'StaticText', 'Abbr', 'strong', 'emphasis', 'LabelText', 'caption', 'term', 'definition', 'paragraph', 'LayoutTableCell', 'LayoutTableRow']);
// Unnamed wrappers that carry no semantics of their own.
const WRAP = new Set(['generic', 'none', 'group', 'presentation', 'paragraph', 'sectionheader', 'rowgroup', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell', 'list', 'Section', 'div', 'document']);
const MIN_RUN = 3;

/** First line of every data-mode snapshot: tells an agent with no docs how to read it. */
export const LEGEND = '# data mode: one line per record. Tables: row "<label>": <column>: <value> · …  Groups: <label>: a, b, c.  A title line followed by detail lines is one block, up to the next title line.';

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const hasInteractive = (n) => INTERACTIVE.has(n.role) || (n.children || []).some(hasInteractive);
const isLeaf = (n) => n.text === undefined && !n.children.length && n.name;
const showRef = (n) => !!n.ref && INTERACTIVE.has(n.role);
const withRef = (n) => (showRef(n) ? `${n.name} [ref=${n.ref}]` : n.name);
// Leaves carrying state (checked, level, value...) never merge into a run.
const plain = (n) => !(n.props.checked !== undefined || n.props.expanded !== undefined || n.props.selected || n.props.level || n.props.required || (n.props.value !== undefined && n.props.value !== ''));
// Run key: leaves with the same key are "the same kind of item". `g` = the
// multi-child wrapper they came from, `sig` = raw child roles (+ '*' when the
// name overrides the content, e.g. aria-label).
const kindOf = (n) => (isLeaf(n) && n.role !== 'StaticText' && n.role !== 'heading' && plain(n) && !TABLES.has(n.role) && !CELLS.has(n.role))
  ? n.role + (n.props.disabled ? '!' : '') + '|' + (n.g ?? '') + '|' + n.sig
  : null;

// Flat text of a cleaned node; with refs, interactive nodes get their [ref=N].
function inline(n, refs) {
  if (n.text !== undefined) return n.text;
  const sub = n.children.length ? n.children.map((c) => inline(c, refs)).filter(Boolean).join(' ') : n.name;
  const v = (n.name && !n.children.length) || INTERACTIVE.has(n.role) && n.name && refs ? n.name : sub;
  const out = n.children.length && n.name && n.role !== 'StaticText' && !sub ? n.name : v;
  return refs && n.ref && INTERACTIVE.has(n.role) ? `${out} [ref=${n.ref}]` : out;
}

/**
 * Render a raw ARIA tree in data mode.
 *
 * @param {object} root - Root node from buildTree() (CDP vocabulary)
 * @returns {string} LEGEND line, then one line per record, YAML-ish like formatTree()
 */
export function dataSnapshot(root) {
  if (!root) return '';
  let gid = 0;
  const rawKids = (n) => n.children.flatMap((c) => (c.ignored ? rawKids(c) : [c]));

  // ---------- Clean pass (N1-N6) ----------
  function clean(n) {
    if (n.ignored) return n.children.flatMap(clean);
    if (SKIP.has(n.role)) return [];                                                  // N1
    if (n.role === 'StaticText') {
      const t = norm(n.name);
      return t && /[\p{L}\p{N}]/u.test(t) ? [{ role: 'StaticText', name: t, children: [], props: {} }] : [];   // N2
    }
    let kids = n.children.flatMap(clean);
    const name = norm(n.name);
    const childText = kids.map((k) => inline(k, false)).filter(Boolean).join(' ');
    const sig = rawKids(n).map((c) => c.role).join(',') + (name && childText && childText !== name ? '*' : '');
    const props = n.properties || {};
    // N4: a name that is just the concatenation of interactive children is hidden
    // (children stay, they carry the refs); otherwise redundant children go.
    const nameRedundant = !!(name && NFC.has(n.role) && kids.length && !INTERACTIVE.has(n.role)
      && kids.every((k) => { const t = inline(k, false); return t && name.includes(t); }) && kids.some(hasInteractive));
    if (name && NFC.has(n.role) && !nameRedundant) {
      kids = kids.filter((c) => { const t = inline(c, false); return !(t && !hasInteractive(c) && name.includes(t)); });
    }
    const nm = nameRedundant ? '' : name;
    if (!nm && WRAP.has(n.role)) {                                                    // N5
      if (kids.length === 0) return [];
      if (n.role === 'generic' && kids.every((k) => k.role === 'StaticText')) {
        return [{ role: 'generic', name: kids.map((k) => k.name).join(' '), children: [], props, ref: n.nodeId, sig }];
      }
      if (kids.length === 1) return kids;
      const id = ++gid;                  // multi-child wrapper: promote, tagged so runs don't merge across wrappers
      kids.forEach((k) => { if (k.g === undefined) k.g = id; });
      return kids;
    }
    if (!nm && kids.length === 0 && (n.role === 'link' || n.role === 'button')) return [];   // N6
    if (!nm && kids.length === 0 && !INTERACTIVE.has(n.role) && !CELLS.has(n.role) && n.role !== 'row') return [];
    if (n.role === 'listitem' && !nm && kids.length === 1) return kids;
    return [{ role: n.role, name: nm, children: kids, props, ref: n.nodeId, sig }];
  }

  // ---------- Transforms, bottom-up with the ancestor chain for labels ----------
  function xform(n, chain) {
    if (n.text !== undefined) return n;
    if (TABLES.has(n.role)) return xformTable(n, chain);
    const newKids = n.children.map((k, i) => xform(k, [...chain, { sibs: n.children, i, node: n }]));
    return { ...n, children: collapseRuns({ ...n, children: newKids }, chain) };
  }
  function dedupe(kids) {
    const out = [];
    for (const k of kids) {
      const p = out[out.length - 1];
      if (p && isLeaf(p) && isLeaf(k) && p.role === k.role && p.name === k.name) continue;
      out.push(k);
    }
    return out;
  }

  // R3: label for the run starting at kids[i]. Returns {label, consume} (consume =
  // preceding siblings absorbed into the label), null for no label, undefined for
  // "don't collapse" (a content-named container already says it).
  function labelFor(parent, kids, i, chain) {
    // lead-in: preceding text leaves back to an anchor (heading / interactive leaf)
    const lead = []; let k = i - 1, found = false;
    while (k >= 0 && lead.length < 3) {
      const s = kids[k];
      if (s.text !== undefined || s.children.length) break;
      if (s.g !== kids[i].g) break;
      if (s.role === 'heading' || INTERACTIVE.has(s.role)) {
        if (!lead.length && s.role === kids[i].role) break;       // an adjacent same-role item is a peer, not a title
        lead.unshift(withRef(s)); found = true; break;
      }
      lead.unshift(s.name); k--;
    }
    if (found) {
      let extra = 0; const a = kids[k];
      while (k - 1 - extra >= 0 && isLeaf(kids[k - 1 - extra]) && kids[k - 1 - extra].role === a.role && kids[k - 1 - extra].name === a.name) extra++;   // image-link twin of the anchor
      return { label: [...new Set(lead)].join(' · '), consume: lead.length + extra };
    }
    // else: nearest preceding heading at this level, then the level's named container, then climb
    const up = chain.slice().reverse(); let sibs = kids, idx = i, node = parent, m = 0;
    for (;;) {
      for (let j = idx - 1; j >= 0; j--) if (sibs[j].role === 'heading' && sibs[j].name) return { label: sibs[j].name, consume: 0 };
      if (node.name && node.role !== 'root') return NFC.has(node.role) ? undefined : { label: node.name, consume: 0 };
      if (m >= up.length) return null;
      ({ sibs, i: idx, node } = up[m++]);
    }
  }
  // Roles of the lead-in leaves back to the anchor; null if there is no anchor.
  function leadShape(kids, i) {
    const shape = [];
    for (let k = i - 1; k >= 0 && shape.length < 3; k--) {
      const s = kids[k];
      if (s.text !== undefined || s.children.length || s.g !== kids[i].g) return null;
      if (!shape.length && s.role === kids[i].role) return null;
      shape.unshift(s.role + (s.props.disabled ? '!' : ''));
      if (s.role === 'heading' || INTERACTIVE.has(s.role)) return shape.join('+');
    }
    return null;
  }

  // R1-R3
  function collapseRuns(parent, chain) {
    const kids = parent.children;
    const out = [];
    // R2 evidence: kinds that form a >=MIN_RUN run (with a lead-in shape) in this sibling list
    const strong = new Set();
    for (let i = 0; i < kids.length;) {
      const kd = kindOf(kids[i]); let j = i;
      if (kd) while (j + 1 < kids.length && kindOf(kids[j + 1]) === kd) j++;
      if (kd && j - i + 1 >= MIN_RUN) { const sh = leadShape(kids, i); if (sh) strong.add(kd + '#' + sh); }
      i = j + 1;
    }
    for (let i = 0; i < kids.length;) {
      const kd = kindOf(kids[i]);
      let j = i;
      if (kd) while (j + 1 < kids.length && kindOf(kids[j + 1]) === kd) j++;
      const len = j - i + 1;
      const weak = kd && len === 2 && strong.has(kd + '#' + leadShape(kids, i));
      if (kd && (len >= MIN_RUN || weak)) {
        const items = kids.slice(i, j + 1);
        const lf = labelFor(parent, kids, i, chain);
        if (lf === undefined) { out.push(...items); i = j + 1; continue; }
        if (lf && lf.consume) out.splice(out.length - lf.consume, lf.consume);   // lead-in leaves now live in the label
        const dis = items[0].props.disabled ? ' (disabled)' : '';
        const body = items.map(withRef).join(', ');
        out.push({ role: '_line', name: '', children: [], props: {}, text: lf ? `${lf.label}${dis}: ${body}` : body });
        i = j + 1;
      } else { out.push(kids[i]); i++; }
    }
    return dedupe(out);
  }

  // ---------- Tables (T1-T4) ----------
  function xformTable(t, chain) {
    const rows = [];
    (function walk(n) { for (const c of n.children) { if (c.role === 'row' || c.role === 'LayoutTableRow') rows.push(c); else if (c.text === undefined) walk(c); } })(t);
    const cellsOf = (r) => r.children.filter((c) => CELLS.has(c.role) || c.role === 'LayoutTableCell');
    const isHeaderRow = (r) => { const cs = cellsOf(r); return cs.some((c) => c.role === 'columnheader') && !cs.some((c) => (c.role === 'cell' || c.role === 'gridcell') && (c.name || c.children.length)); };
    const xcell = (c) => xform(c, [...chain, { sibs: [t], i: 0, node: t }]);
    const out = [];
    for (const c of t.children.filter((c) => !rows.includes(c) && c.role !== 'rowgroup')) out.push(xform(c, [...chain, { sibs: t.children, i: 0, node: t }]));
    // T1: leading header rows (multi-row headers are merged per column)
    const hdrRows = []; let hdrDone = false;
    for (const r of rows) { if (!hdrDone && isHeaderRow(r)) hdrRows.push(r); else if (hdrRows.length) hdrDone = true; }
    let headers = null;
    if (hdrRows.length) {
      const w = Math.max(...hdrRows.map((r) => cellsOf(r).length));
      headers = Array.from({ length: w }, (_, i) => [...new Set(hdrRows.map((r) => { const c = cellsOf(r)[i]; return c ? inline(xcell(c), false) : ''; }).filter(Boolean))].join(' / '));
    }
    const dataRows = rows.filter((r) => !hdrRows.includes(r));
    // T3: positional mapping only when every row is exactly as wide as the header
    const useHdr = headers && dataRows.every((r) => cellsOf(r).length === headers.length) ? headers : null;
    if (headers && !useHdr) out.push({ role: '_line', children: [], props: {}, text: `columns: ${headers.filter(Boolean).join(' · ')}   [header/row width mismatch: positional mapping unsafe]` });
    const firstRef = (n) => (showRef(n) ? n.ref : (n.children || []).map(firstRef).find(Boolean));
    for (const r of dataRows) {
      // T2
      const cs = cellsOf(r);
      const labelCells = cs.filter((c) => c.role === 'rowheader' || c.role === 'columnheader');
      const lcx = labelCells.map(xcell);
      const label = lcx.map((c) => inline(c, false)).filter(Boolean).join(' / ');
      const labelRef = lcx.map(firstRef).find(Boolean);
      const vals = [];
      cs.forEach((c, idx) => {
        if (labelCells.includes(c)) return;
        const v = inline(xcell(c), true);
        if (v) vals.push({ h: useHdr ? useHdr[idx] : '', v });
      });
      // T4: modal-value compression for wide rows
      let tail = '';
      if (vals.length >= 6) {
        const cnt = new Map(); vals.forEach((x) => cnt.set(x.v, (cnt.get(x.v) || 0) + 1));
        const [mv, mc] = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
        if (mc >= 4 && mc >= vals.length * 0.3) {
          tail = ` (other ${mc} columns: ${mv})`;
          for (let i = vals.length - 1; i >= 0; i--) if (vals[i].v === mv) vals.splice(i, 1);
        }
      }
      if (!vals.length && !label) continue;      // header-only / empty rows
      const body = vals.map((x) => (x.h ? `${x.h}: ` : '') + x.v).join(' · ');
      out.push({ role: '_line', children: [], props: {}, text: `row${label ? ` "${label}"` : ''}${labelRef ? ` [ref=${labelRef}]` : ''}${tail}${body ? ': ' + body : ''}` });
    }
    return { ...t, children: out };
  }

  // ---------- Run ----------
  let tops = clean(root);
  if (tops.length === 1 && (tops[0].role === 'RootWebArea' || tops[0].role === 'WebArea')) tops = tops[0].children;
  const find = (ns, role) => { for (const n of ns) { if (n.role === role) return n; const f = find(n.children, role); if (f) return f; } return null; };
  const main = find(tops, 'main');
  if (main && main.children.length) tops = [main];
  const res = xform({ role: 'root', name: '', children: tops, props: {} }, []);

  const lines = [];
  function emit(c, d) {
    const ind = '  '.repeat(d);
    if (c.text !== undefined) { lines.push(`${ind}- ${c.text}`); return; }
    if (isLeaf(c) && (c.role === 'StaticText' || c.role === 'generic')) { lines.push(`${ind}- ${c.name}`); return; }
    let l = `${ind}- ${c.role}`;
    if (c.name) l += ` "${c.name}"`;
    const p = c.props, pp = [];
    if (p.checked !== undefined) pp.push(`checked=${p.checked}`);
    if (p.disabled) pp.push('disabled');
    if (p.expanded !== undefined) pp.push(`expanded=${p.expanded}`);
    if (p.level) pp.push(`level=${p.level}`);
    if (p.selected) pp.push('selected');
    if (p.required && !CELLS.has(c.role)) pp.push('required');
    if (p.value !== undefined && p.value !== '') pp.push(`value="${p.value}"`);
    if (pp.length) l += ` [${pp.join(', ')}]`;
    if (showRef(c)) l += ` [ref=${c.ref}]`;
    lines.push(l);
    for (const k of c.children) emit(k, d + 1);
  }
  for (const c of res.children) emit(c, 0);
  return [LEGEND, ...lines].join('\n');
}
