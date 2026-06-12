/**
 * readable.js — extract the main article of a page as clean reading text.
 *
 * Companion to snapshot(): snapshot() yields an *actionable* ARIA tree for
 * clicking/typing; readable() yields the *readable* article (title + body
 * prose, nav/ads/sidebars stripped) for "read/summarise this" tasks, where
 * snapshot() is both noisy and silently lossy on long prose.
 *
 * Runs Mozilla's Readability (the engine behind Firefox Reader View) inside
 * the live page over CDP — so JS-rendered articles work, unlike a raw fetch.
 * `isProbablyReaderable` gives an article-likelihood signal, but it is not
 * reliable on its own (false negatives on minimally-marked-up essays, false
 * positives on link-dense portals), so readable() never hard-gates: it always
 * returns whatever Readability extracted plus an advisory `confidence`. A
 * low-confidence result is the agent's cue to fall back to snapshot().
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Read the self-contained browser builds once at module load and inject their
// source into the page. Both define globals (Readability, isProbablyReaderable)
// when evaluated in a non-module context; the `if (typeof module ...)` tails are
// harmless no-ops in the page.
const READABILITY_SRC = readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8');
const READERABLE_SRC = readFileSync(require.resolve('@mozilla/readability/Readability-readerable.js'), 'utf8');

/** Below this many characters of extracted text, treat as low confidence. */
const MIN_ARTICLE_CHARS = 1500;

// Fully static — interpolates only the two module-level source constants — so
// it's built once at load, not rebuilt (~120 KB) on every readable() call.
const EXTRACT_EXPRESSION = `(() => {
  ${READERABLE_SRC}
  ${READABILITY_SRC}
  try {
    const readerable = isProbablyReaderable(document);
    // Readability mutates the document it parses — clone so the live page
    // (and any later snapshot()/interaction) is untouched.
    const art = new Readability(document.cloneNode(true)).parse();
    if (!art || !art.textContent || !art.textContent.trim()) {
      return { ok: false, readerable };
    }
    return {
      ok: true,
      readerable,
      title: art.title || '',
      byline: art.byline || '',
      text: art.textContent.trim(),
      length: art.length || art.textContent.length,
    };
  } catch (e) {
    return { ok: false, err: String(e && e.message || e) };
  }
})()`;

/**
 * Render a readable() result as a text block: a short header (title / byline /
 * confidence, with the fall-back hint inline when present) then the body. On a
 * failed extraction it returns the hint. Shared by the MCP, bareagent, and
 * CLI/daemon surfaces so their output can't drift apart.
 * @param {object} r - a readable() result.
 * @returns {string}
 */
export function formatReadable(r) {
  if (!r.ok) return r.hint;
  const header = `title: ${r.title}${r.byline ? `\nbyline: ${r.byline}` : ''}\n`
    + `confidence: ${r.confidence}${r.hint ? ` (${r.hint})` : ''}\n\n`;
  return header + r.text;
}

/**
 * Extract the main article from the current page.
 * @param {object} session - CDP session-scoped handle (.send()).
 * @returns {Promise<object>} One of:
 *   { ok: false, hint }                              — no article content found
 *   { ok: true, title, byline, text, length,
 *     confidence: 'high'|'low', readerable, hint? }  — extracted article
 */
export async function readable(session) {
  const { result } = await session.send('Runtime.evaluate', {
    expression: EXTRACT_EXPRESSION,
    returnByValue: true,
    awaitPromise: true,
  });
  const r = result.value || {};

  if (!r.ok) {
    return {
      ok: false,
      hint: r.err
        ? `readable extraction failed (${r.err}); use snapshot()`
        : 'no article content found on this page; use snapshot() instead',
    };
  }

  // Advisory confidence: high only when the reader-view heuristic agrees AND
  // there is a substantial amount of text. Low is not an error — the text is
  // still returned; it just means "verify, or prefer snapshot()".
  const confidence = r.readerable && r.length >= MIN_ARTICLE_CHARS ? 'high' : 'low';
  const out = {
    ok: true,
    title: r.title,
    byline: r.byline,
    text: r.text,
    length: r.length,
    readerable: r.readerable,
    confidence,
  };
  if (confidence === 'low') {
    out.hint = 'low article confidence — this may not be an article; consider snapshot()';
  }
  return out;
}
