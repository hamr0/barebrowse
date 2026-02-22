#!/usr/bin/env node
/**
 * cli.js -- barebrowse CLI entry point.
 *
 * Usage:
 *   npx barebrowse mcp            Start the MCP server (JSON-RPC over stdio)
 *   npx barebrowse install        Auto-configure MCP in Claude Desktop / Cursor / Claude Code
 *   npx barebrowse browse <url>   One-shot browse, print snapshot to stdout
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

const cmd = process.argv[2];

if (cmd === 'mcp') {
  await import('./mcp-server.js');

} else if (cmd === 'install') {
  install();

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
  process.stdout.write(`barebrowse -- CDP-direct browsing for autonomous agents

Usage:
  barebrowse mcp                Start MCP server (JSON-RPC over stdio)
  barebrowse install            Auto-configure MCP for Claude Desktop / Cursor / Claude Code
  barebrowse browse <url>       One-shot browse, print ARIA snapshot

As a library:
  import { browse, connect } from 'barebrowse';

As bareagent tools:
  import { createBrowseTools } from 'barebrowse/bareagent';

More: see README.md or barebrowse.context.md
`);
}

// --- MCP auto-installer ---

function install() {
  const mcpEntry = {
    command: 'npx',
    args: ['barebrowse', 'mcp'],
  };

  const targets = detectTargets();

  if (targets.length === 0) {
    console.log('No MCP clients detected. You can manually add this to your MCP config:\n');
    console.log(JSON.stringify({ mcpServers: { barebrowse: mcpEntry } }, null, 2));
    console.log('\nSupported clients: Claude Desktop, Cursor, Claude Code');
    return;
  }

  let installed = 0;

  for (const target of targets) {
    try {
      const config = readJsonOrEmpty(target.path);
      if (!config.mcpServers) config.mcpServers = {};

      if (config.mcpServers.barebrowse) {
        console.log(`  ${target.name}: already configured`);
        installed++;
        continue;
      }

      config.mcpServers.barebrowse = mcpEntry;

      // Ensure parent dir exists
      const dir = join(target.path, '..');
      mkdirSync(dir, { recursive: true });

      writeFileSync(target.path, JSON.stringify(config, null, 2) + '\n');
      console.log(`  ${target.name}: installed -> ${target.path}`);
      installed++;
    } catch (err) {
      console.log(`  ${target.name}: failed (${err.message})`);
    }
  }

  if (installed > 0) {
    console.log(`\nDone. Restart your MCP client to pick up the new server.`);
    console.log('Tools available: browse, goto, snapshot, click, type, press, scroll');
  }
}

function detectTargets() {
  const home = homedir();
  const os = platform();
  const targets = [];

  // Claude Desktop
  let claudeDesktop;
  if (os === 'darwin') {
    claudeDesktop = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  } else if (os === 'linux') {
    claudeDesktop = join(home, '.config', 'Claude', 'claude_desktop_config.json');
  } else if (os === 'win32') {
    claudeDesktop = join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
  }
  if (claudeDesktop) {
    // Check if Claude Desktop dir exists (even if config doesn't yet)
    const dir = join(claudeDesktop, '..');
    if (existsSync(dir)) {
      targets.push({ name: 'Claude Desktop', path: claudeDesktop });
    }
  }

  // Cursor
  let cursorDir;
  if (os === 'darwin') {
    cursorDir = join(home, '.cursor');
  } else if (os === 'linux') {
    cursorDir = join(home, '.cursor');
  } else if (os === 'win32') {
    cursorDir = join(home, '.cursor');
  }
  if (cursorDir && existsSync(cursorDir)) {
    targets.push({ name: 'Cursor', path: join(cursorDir, 'mcp.json') });
  }

  // Claude Code (project-level .mcp.json in cwd)
  const cwd = process.cwd();
  const claudeCodePath = join(cwd, '.mcp.json');
  // Only suggest if we're in a project directory (has package.json or .git)
  if (existsSync(join(cwd, 'package.json')) || existsSync(join(cwd, '.git'))) {
    targets.push({ name: 'Claude Code (this project)', path: claudeCodePath });
  }

  return targets;
}

function readJsonOrEmpty(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}
