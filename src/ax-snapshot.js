// @ts-nocheck — AX_FN below is browser-context code (document, getComputedStyle,
// CSS, real regex literals) serialized via .toString() and run inside Firefox,
// never in Node. tsc's Node lib (no DOM) can't meaningfully check it, and the
// readable.js string convention would corrupt its regex backslashes, so the
// file opts out of type-checking. The Node-side exports are trivial.
/**
 * ax-snapshot.js — Reconstruct a CDP-shaped accessibility tree in-page.
 *
 * CDP hands you Accessibility.getFullAXTree; BiDi has no equivalent, so on
 * Firefox we rebuild an equivalent tree inside the page via script.evaluate.
 * The output tree uses the SAME node shape and role vocabulary as
 * buildTree()'s CDP output, so prune.js and aria.js consume it unchanged:
 *
 *   { nodeId, role, name, properties, children, ignored }
 *
 * where `role` is CDP/ARIA vocabulary ('RootWebArea', 'StaticText', 'heading',
 * 'link', 'button', 'img', 'paragraph', 'list', 'navigation', …), NOT tag
 * names. The three things getFullAXTree gave us for free and we reimplement:
 *   1. implicit ARIA role mapping (HTML element → role)
 *   2. accessible-name computation (aria-labelledby → aria-label → native
 *      label/alt/legend/title → text content) — the POC proved textContent
 *      alone is NOT enough (img alt, <label>, aria-labelledby all missed).
 *   3. hidden-subtree filtering (aria-hidden, display:none, visibility:hidden,
 *      the hidden attribute).
 *
 * Each kept element is tagged with a data-bb-ref attribute carrying its ref,
 * so interact-bidi.js can resolve a ref back to its element via querySelector.
 * Refs are assigned from a caller-supplied `base` so they stay globally unique
 * across browsing contexts (iframes), matching CDP's flat integer refs.
 */

/** Attribute used to tag elements for ref → element resolution. */
export const REF_ATTR = 'data-bb-ref';

/**
 * The in-page reconstruction function, as source text. Evaluated in a browsing
 * context with a `base` ref offset; returns JSON { tree, count }. Written as a
 * single self-contained function (no closures over module scope) because it
 * runs in the page, not in Node.
 */
const AX_FN = function reconstructAX(base, REF_ATTR) {
  let ref = base;

  // Roles whose accessible name comes from descendant text (so we must NOT
  // also emit child StaticText nodes — CDP folds the text into the name).
  const NAME_FROM_CONTENT = new Set([
    'button', 'link', 'heading', 'cell', 'columnheader', 'rowheader',
    'tab', 'menuitem', 'option', 'treeitem', 'switch', 'checkbox', 'radio',
  ]);

  // HTML tag → implicit ARIA role (the common, high-value subset).
  const TAG_ROLE = {
    A: (el) => (el.hasAttribute('href') ? 'link' : 'generic'),
    BUTTON: () => 'button',
    NAV: () => 'navigation', MAIN: () => 'main', ASIDE: () => 'complementary',
    HEADER: (el) => (isTopLevelLandmark(el) ? 'banner' : 'generic'),
    FOOTER: (el) => (isTopLevelLandmark(el) ? 'contentinfo' : 'generic'),
    FORM: () => 'form', SEARCH: () => 'search',
    SECTION: (el) => (accName(el) ? 'region' : 'generic'),
    ARTICLE: () => 'article',
    H1: () => 'heading', H2: () => 'heading', H3: () => 'heading',
    H4: () => 'heading', H5: () => 'heading', H6: () => 'heading',
    P: () => 'paragraph',
    UL: () => 'list', OL: () => 'list', LI: () => 'listitem',
    DL: () => 'list', DT: () => 'term', DD: () => 'definition',
    IMG: (el) => (el.getAttribute('alt') === '' ? 'none' : 'image'),
    FIGURE: () => 'figure', FIGCAPTION: () => 'Figcaption',
    TABLE: () => 'table', TR: () => 'row', TD: () => 'cell',
    TH: (el) => (el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader'),
    THEAD: () => 'rowgroup', TBODY: () => 'rowgroup', TFOOT: () => 'rowgroup',
    SELECT: (el) => (el.multiple ? 'listbox' : 'combobox'),
    TEXTAREA: () => 'textbox',
    OPTION: () => 'option',
    LABEL: () => 'LabelText', SPAN: () => 'generic', DIV: () => 'generic',
    STRONG: () => 'strong', EM: () => 'emphasis', B: () => 'strong', I: () => 'emphasis',
    BLOCKQUOTE: () => 'blockquote', CODE: () => 'code', PRE: () => 'generic',
    HR: () => 'separator',
    IFRAME: () => 'Iframe', FRAME: () => 'Iframe',
    INPUT: (el) => {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return ({
        button: 'button', submit: 'button', reset: 'button', image: 'button',
        checkbox: 'checkbox', radio: 'radio', range: 'slider',
        search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox',
        text: 'textbox', password: 'textbox', number: 'spinbutton',
        hidden: 'none',
      })[t] || 'textbox';
    },
  };

  function isTopLevelLandmark(el) {
    // <header>/<footer> are landmarks only when not scoped inside article/section/main/aside.
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (/^(ARTICLE|SECTION|MAIN|ASIDE|NAV)$/.test(p.tagName)) return false;
    }
    return true;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const fn = TAG_ROLE[el.tagName];
    return fn ? fn(el) : 'generic';
  }

  function isHidden(el) {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute('hidden')) return true;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return true;
    return false;
  }

  // Accessible-name computation (compact subset of the accname spec, covering
  // the cases the POC proved textContent misses).
  function accName(el, depth) {
    depth = depth || 0;
    // 1. aria-labelledby (resolve id refs → their text)
    const lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb && depth < 2) {
      const txt = lb.split(/\s+/).map((id) => {
        const t = document.getElementById(id);
        return t ? accName(t, depth + 1) || t.textContent.trim() : '';
      }).filter(Boolean).join(' ').trim();
      if (txt) return txt;
    }
    // 2. aria-label
    const al = el.getAttribute && el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    const tag = el.tagName;
    // 3. native naming
    if (tag === 'IMG' || tag === 'AREA') {
      const alt = el.getAttribute('alt');
      if (alt) return alt.trim();
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      // associated <label> (for= or wrapping ancestor)
      if (el.id) {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) return lab.textContent.trim();
      }
      const wrap = el.closest && el.closest('label');
      if (wrap) return wrap.textContent.trim();
      const ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) return ph.trim();
    }
    if (tag === 'FIELDSET') {
      const lg = el.querySelector && el.querySelector('legend');
      if (lg) return lg.textContent.trim();
    }
    if (tag === 'TABLE') {
      const cap = el.querySelector && el.querySelector('caption');
      if (cap) return cap.textContent.trim();
    }
    // 4. title attribute
    const title = el.getAttribute && el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    return '';
  }

  function props(el, role) {
    const p = {};
    if (role === 'checkbox' || role === 'radio' || role === 'switch') p.checked = !!el.checked;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') p.disabled = true;
    const exp = el.getAttribute('aria-expanded');
    if (exp !== null) p.expanded = exp === 'true';
    if (role === 'heading') p.level = Number(el.getAttribute('aria-level')) || Number(el.tagName[1]) || 2;
    if (el.getAttribute('aria-selected') === 'true') p.selected = true;
    if (el.required || el.getAttribute('aria-required') === 'true') p.required = true;
    if ((role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton') && el.value) {
      p.value = el.value;
    }
    return p;
  }

  function makeNode(role, name, properties) {
    return { nodeId: String(++ref), role, name: name || '', properties: properties || {}, children: [], ignored: false };
  }

  // Walk a DOM element → AX node (or null if hidden/irrelevant). Text runs
  // become StaticText children unless the parent names from content.
  function walk(el) {
    if (isHidden(el)) return null;
    let role = roleOf(el);
    if (role === 'none') return collapseChildren(el); // presentational: keep kids

    // Accessible name: explicit sources first, then fall back to descendant
    // text for roles that name from content (button/link/heading/…), matching
    // CDP — otherwise those nodes come back nameless.
    let name = accName(el);
    if (!name && NAME_FROM_CONTENT.has(role)) {
      name = el.textContent.replace(/\s+/g, ' ').trim();
    }
    const node = makeNode(role, name, props(el, role));
    el.setAttribute(REF_ATTR, node.nodeId);

    if (!NAME_FROM_CONTENT.has(role)) {
      for (const child of kidsOf(el)) {
        if (child.nodeType === 3) {
          const t = child.textContent.replace(/\s+/g, ' ').trim();
          if (t) node.children.push(makeNode('StaticText', t, {}));
        } else if (child.nodeType === 1) {
          const c = walk(child);
          if (c) Array.isArray(c) ? node.children.push(...c) : node.children.push(c);
        }
      }
    } else {
      // name-from-content: still recurse into element children for nested
      // interactives (e.g. a link inside a heading), but drop bare text.
      for (const child of kidsOf(el)) {
        if (child.nodeType !== 1) continue;
        const c = walk(child);
        if (c) Array.isArray(c) ? node.children.push(...c) : node.children.push(c);
      }
    }
    return node;
  }

  // Effective children to traverse: shadow-root content when the element hosts
  // an open shadow tree (that is what actually renders — CDP's AX tree includes
  // it), assigned light nodes for a <slot>, else plain light-DOM childNodes.
  function kidsOf(el) {
    if (el.tagName === 'SLOT') {
      const assigned = el.assignedNodes ? el.assignedNodes({ flatten: true }) : [];
      return assigned.length ? assigned : [...el.childNodes];
    }
    if (el.shadowRoot) return [...el.shadowRoot.childNodes];
    return [...el.childNodes];
  }

  // Presentational element (role=none/presentation): emit its children only.
  function collapseChildren(el) {
    const out = [];
    for (const child of kidsOf(el)) {
      if (child.nodeType === 3) {
        const t = child.textContent.replace(/\s+/g, ' ').trim();
        if (t) out.push(makeNode('StaticText', t, {}));
      } else if (child.nodeType === 1 && !isHidden(child)) {
        const c = walk(child);
        if (c) Array.isArray(c) ? out.push(...c) : out.push(c);
      }
    }
    return out;
  }

  // Clear stale refs from a prior snapshot so resolution never hits a ghost.
  for (const old of document.querySelectorAll('[' + REF_ATTR + ']')) old.removeAttribute(REF_ATTR);

  // Wrap body content in an ignored 'none' node, mirroring the html/body
  // wrappers CDP's getFullAXTree emits. prune.js's region extraction only
  // inspects RootWebArea's DIRECT children for landmarks, so without this
  // wrapper a top-level <form>/<nav> (no <main>) would be treated as a
  // directly-extractable region and dropped in act mode — a divergence from
  // CDP, where the same landmark is buried under body and flows through.
  const root = makeNode('RootWebArea', document.title || '', {});
  const body = makeNode('none', '', {});
  body.ignored = true;
  for (const child of document.body ? document.body.children : []) {
    const c = walk(child);
    if (c) Array.isArray(c) ? body.children.push(...c) : body.children.push(c);
  }
  root.children.push(body);
  return JSON.stringify({ tree: root, count: ref - base });
};

/**
 * Build the script.evaluate expression that reconstructs the AX tree in a
 * context, assigning refs from `base`.
 * @param {number} base - Starting ref offset (exclusive; first ref is base+1)
 * @returns {string} JS expression returning JSON { tree, count }
 */
export function axSnapshotExpression(base) {
  return `(${AX_FN.toString()})(${Number(base)}, ${JSON.stringify(REF_ATTR)})`;
}
