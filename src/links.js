/**
 * links.js — opt-in link URLs for snapshots (`links: true`).
 *
 * `annotateLinks()` stamps `urls: [url]` on every link node that has a usable
 * browser-serialized absolute URL. aria.js, prune.js and data.js print/carry
 * `urls` — they never see the option, so with links off nothing changes.
 */

/**
 * Normalise a link's URL for a snapshot line. Returns '' when it should not be
 * shown: no URL, `javascript:`, or a same-document link (the page URL, only
 * the #fragment differs). A raw space, `<` or `>` (browsers encode them, but
 * not always in the fragment) is percent-encoded so a line splits cleanly on
 * ` <` and `> `.
 *
 * @param {string|undefined} url - Absolute URL as serialized by the browser
 * @param {string} [pageUrl] - URL of the page the link is on
 * @returns {string}
 */
export function linkUrl(url, pageUrl = '') {
  if (typeof url !== 'string') return '';
  const u = url.trim();
  if (!u || /^javascript:/i.test(u)) return '';
  if (pageUrl && u.split('#')[0] === pageUrl.split('#')[0]) return '';
  return u.replace(/ /g, '%20').replace(/</g, '%3C').replace(/>/g, '%3E');
}

/**
 * Copy a tree with `urls` set on its link nodes (input is not mutated).
 *
 * @param {object|null} node - Root from buildTree()
 * @param {string} pageUrl
 * @returns {object|null}
 */
export function annotateLinks(node, pageUrl) {
  if (!node) return node;
  const out = { ...node, children: node.children.map((c) => annotateLinks(c, pageUrl)) };
  if (node.role === 'link') {
    const u = linkUrl(node.properties?.url, pageUrl);
    if (u) out.urls = [u];
  }
  return out;
}

/** ` <u1> <u2>` for a node's urls ('' when none). */
export const urlsText = (urls) => (urls || []).map((u) => ` <${u}>`).join('');
