/**
 * ref.js — Accept a ref as an agent may write it: 441, "441", "ref=441" or "[ref=441]"
 * (snapshots print `[ref=441]`). Returns the bare id as a string.
 *
 * @param {string|number} ref
 * @returns {string}
 */
export function normRef(ref) {
  return String(ref).trim().replace(/^\[?ref=/, '').replace(/\]$/, '');
}
