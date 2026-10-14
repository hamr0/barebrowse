/**
 * output-clean.js -- Age-based cleanup of barebrowse's own output files.
 *
 * Matches only `<prefix>-<timestamp>.<ext>` files barebrowse itself writes.
 * session.json, state-*.json (deliberate saved logins) and any other file are never touched.
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// toISOString() with [:.] -> '-': YYYY-MM-DDTHH-MM-SS-mmmZ. Exact, so a user's own
// `screenshot-2026-01-01.png` in a shared --output-dir is never matched.
const STAMP = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z';
const OURS = new RegExp(
  `^(?:page-${STAMP}\\.(?:yml|pdf)|screenshot-${STAMP}\\.(?:png|jpeg|webp)|article-${STAMP}\\.txt|(?:console|network|dialogs)-${STAMP}\\.json)$`,
);

/**
 * Delete barebrowse output files older than `days` in `dir` (non-recursive).
 * Never throws; a missing dir or any per-file error is ignored.
 * @param {string} dir
 * @param {number} [days]
 * @param {number} [now] - epoch ms, injectable for tests
 */
export function cleanOld(dir, days = 7, now = Date.now()) {
  try {
    const cutoff = now - days * 86400000;
    for (const name of readdirSync(dir)) {
      if (!OURS.test(name)) continue;
      try {
        const path = join(dir, name);
        const st = statSync(path);
        if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(path);
      } catch {}
    }
  } catch {}
}
