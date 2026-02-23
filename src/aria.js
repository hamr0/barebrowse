/**
 * aria.js — Format ARIA accessibility tree nodes for agent consumption.
 *
 * Takes a nested tree (built from CDP's Accessibility.getFullAXTree)
 * and formats it as readable YAML-like text, similar to Playwright's ariaSnapshot.
 */

/**
 * Format a nested ARIA tree as readable text output.
 *
 * Output format (one node per line, indented):
 *   - role "name" [props] [ref=nodeId]
 *
 * @param {object} node - Tree node { role, name, properties, children, ignored, nodeId }
 * @param {number} [depth=0] - Current indentation depth
 * @returns {string} Formatted ARIA tree text
 */
export function formatTree(node, depth = 0) {
  if (!node) return '';

  // Skip ignored nodes but still process their children
  if (node.ignored) {
    return node.children.map((c) => formatTree(c, depth)).filter(Boolean).join('\n');
  }

  // Skip low-level rendering nodes that are noise for agents
  const SKIP_ROLES = new Set(['InlineTextBox', 'LineBreak']);
  if (SKIP_ROLES.has(node.role)) return '';

  const indent = '  '.repeat(depth);
  const lines = [];

  // Build line: "- role "name" [properties] [ref=id]"
  let line = `${indent}- ${node.role || 'none'}`;

  if (node.name) {
    line += ` "${node.name}"`;
  }

  // Notable properties that agents care about
  const props = node.properties || {};
  const propParts = [];
  if (props.checked !== undefined) propParts.push(`checked=${props.checked}`);
  if (props.disabled) propParts.push('disabled');
  if (props.expanded !== undefined) propParts.push(`expanded=${props.expanded}`);
  if (props.level) propParts.push(`level=${props.level}`);
  if (props.selected) propParts.push('selected');
  if (props.required) propParts.push('required');
  if (props.value !== undefined && props.value !== '') propParts.push(`value="${props.value}"`);

  if (propParts.length > 0) {
    line += ` [${propParts.join(', ')}]`;
  }

  // Node ID as ref — agents use this to target interactions
  if (node.nodeId) {
    line += ` [ref=${node.nodeId}]`;
  }

  lines.push(line);

  // Recurse into children
  for (const child of node.children) {
    const childText = formatTree(child, depth + 1);
    if (childText) lines.push(childText);
  }

  return lines.join('\n');
}
