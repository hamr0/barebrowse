#!/usr/bin/env node
/**
 * cli.js — barebrowse CLI entry point.
 *
 * Usage:
 *   npx barebrowse mcp        Start the MCP server (JSON-RPC over stdio)
 *   npx barebrowse browse URL One-shot browse, print snapshot to stdout
 */

const cmd = process.argv[2];

if (cmd === 'mcp') {
  await import('./mcp-server.js');
} else if (cmd === 'browse' && process.argv[3]) {
  const { browse } = await import('./src/index.js');
  const url = process.argv[3];
  const mode = process.argv[4] || 'headless';
  try {
    const snapshot = await browse(url, { mode });
    process.stdout.write(snapshot + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
} else {
  process.stdout.write(`barebrowse — CDP-direct browsing for autonomous agents

Usage:
  barebrowse mcp                Start MCP server (JSON-RPC over stdio)
  barebrowse browse <url>       One-shot browse, print ARIA snapshot

As a library:
  import { browse, connect } from 'barebrowse';

As bareagent tools:
  import { createBrowseTools } from 'barebrowse/bareagent';

More: see README.md or barebrowse.context.md
`);
}
