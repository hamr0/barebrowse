#!/usr/bin/env node
/**
 * cli.js -- barebrowse CLI entry point.
 *
 * See `barebrowse` (no args) for full command reference.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const cmd = args[0];

// Hidden internal flag: --daemon-internal
if (args.includes('--daemon-internal')) {
  await runDaemonInternal();
} else if (cmd === 'mcp') {
  await import('./mcp-server.js');
} else if (cmd === 'install') {
  install();
} else if (cmd === 'browse' && args[1]) {
  await oneShot();
} else if (cmd === 'open') {
  await cmdOpen();
} else if (cmd === 'close') {
  await cmdProxy('close');
} else if (cmd === 'status') {
  await cmdStatus();
} else if (cmd === 'goto' && args[1]) {
  await cmdProxy('goto', { url: args[1], timeout: parseFlag('--timeout') });
} else if (cmd === 'snapshot') {
  await cmdProxy('snapshot', { mode: parseFlag('--mode') });
} else if (cmd === 'screenshot') {
  await cmdProxy('screenshot', { format: parseFlag('--format') });
} else if (cmd === 'click' && args[1]) {
  await cmdProxy('click', { ref: args[1] });
} else if (cmd === 'type' && args[1] && args[2]) {
  await cmdProxy('type', { ref: args[1], text: args.slice(2).filter(a => !a.startsWith('--')).join(' '), clear: hasFlag('--clear') });
} else if (cmd === 'fill' && args[1] && args[2]) {
  await cmdProxy('fill', { ref: args[1], text: args.slice(2).filter(a => !a.startsWith('--')).join(' ') });
} else if (cmd === 'press' && args[1]) {
  await cmdProxy('press', { key: args[1] });
} else if (cmd === 'scroll' && args[1]) {
  await cmdProxy('scroll', { deltaY: Number(args[1]) });
} else if (cmd === 'hover' && args[1]) {
  await cmdProxy('hover', { ref: args[1] });
} else if (cmd === 'select' && args[1] && args[2]) {
  await cmdProxy('select', { ref: args[1], value: args[2] });
} else if (cmd === 'eval' && args[1]) {
  await cmdProxy('eval', { expression: args.slice(1).join(' ') });
} else if (cmd === 'wait-idle') {
  await cmdProxy('wait-idle', { timeout: parseFlag('--timeout') });
} else if (cmd === 'console-logs') {
  await cmdProxy('console-logs', { level: parseFlag('--level'), clear: hasFlag('--clear') });
} else if (cmd === 'network-log') {
  await cmdProxy('network-log', { failed: hasFlag('--failed') });
} else if (cmd === 'back') {
  await cmdProxy('back');
} else if (cmd === 'forward') {
  await cmdProxy('forward');
} else if (cmd === 'drag' && args[1] && args[2]) {
  await cmdProxy('drag', { fromRef: args[1], toRef: args[2] });
} else if (cmd === 'upload' && args[1] && args[2]) {
  await cmdProxy('upload', { ref: args[1], files: args.slice(2).filter(a => !a.startsWith('--')).map(f => resolve(f)) });
} else if (cmd === 'pdf') {
  await cmdProxy('pdf', { landscape: hasFlag('--landscape') });
} else if (cmd === 'tabs') {
  await cmdProxy('tabs');
} else if (cmd === 'tab' && args[1]) {
  await cmdProxy('tab', { index: Number(args[1]) });
} else if (cmd === 'wait-for') {
  await cmdProxy('wait-for', { text: parseFlag('--text'), selector: parseFlag('--selector'), timeout: parseFlag('--timeout') });
} else if (cmd === 'save-state') {
  await cmdProxy('save-state');
} else if (cmd === 'dialog-log') {
  await cmdProxy('dialog-log');
} else {
  printUsage();
}


// --- Command implementations ---

async function cmdOpen() {
  const { startDaemon } = await import('./src/daemon.js');
  const { isAlive } = await import('./src/session-client.js');
  const outputDir = resolve('.barebrowse');

  // Check for existing session
  if (await isAlive(outputDir)) {
    process.stdout.write('Session already running. Use `barebrowse close` first.\n');
    process.exit(1);
  }

  const url = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  const opts = {
    mode: parseFlag('--mode') || 'headless',
    port: parseFlag('--port'),
    cookies: !hasFlag('--no-cookies'),
    browser: parseFlag('--browser'),
    timeout: parseFlag('--timeout'),
    pruneMode: parseFlag('--prune-mode') || 'act',
    consent: !hasFlag('--no-consent'),
    proxy: parseFlag('--proxy'),
    viewport: parseFlag('--viewport'),
    storageState: parseFlag('--storage-state'),
  };

  try {
    const session = await startDaemon(opts, outputDir, url);
    process.stdout.write(`Session started (pid ${session.pid}, port ${session.port})\n`);
    if (url) process.stdout.write(`Navigated to ${url}\n`);
    process.stdout.write(`Output dir: ${outputDir}\n`);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

async function cmdStatus() {
  const { readSession, isAlive } = await import('./src/session-client.js');
  const outputDir = resolve('.barebrowse');
  const session = readSession(outputDir);

  if (!session) {
    process.stdout.write('No session found.\n');
    process.exit(1);
  }

  const alive = await isAlive(outputDir);
  if (alive) {
    process.stdout.write(`Session running (pid ${session.pid}, port ${session.port}, started ${session.startedAt})\n`);
  } else {
    process.stdout.write(`Session stale (pid ${session.pid} not responding). Run \`barebrowse close\` to clean up.\n`);
    process.exit(1);
  }
}

async function cmdProxy(command, cmdArgs) {
  const { sendCommand, readSession } = await import('./src/session-client.js');
  const { unlinkSync } = await import('node:fs');
  const outputDir = resolve('.barebrowse');

  try {
    const result = await sendCommand(command, cmdArgs, outputDir);

    if (!result.ok) {
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(1);
    }

    // Print result
    if (result.file && result.count !== undefined) {
      process.stdout.write(`${result.file} (${result.count} entries)\n`);
    } else if (result.file) {
      process.stdout.write(`${result.file}\n`);
    } else if (result.value !== undefined) {
      process.stdout.write(JSON.stringify(result.value) + '\n');
    } else if (command === 'close') {
      // Clean up session.json in case daemon didn't
      const sessionPath = join(outputDir, 'session.json');
      try { unlinkSync(sessionPath); } catch { /* already gone */ }
      process.stdout.write('Session closed.\n');
    } else {
      process.stdout.write('ok\n');
    }
  } catch (err) {
    if (command === 'close') {
      // Daemon may have exited before responding — that's fine
      const sessionPath = join(outputDir, 'session.json');
      try { unlinkSync(sessionPath); } catch { /* already gone */ }
      process.stdout.write('Session closed.\n');
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
  }
}

async function oneShot() {
  const { browse } = await import('./src/index.js');
  const url = args[1];
  const mode = args[2] || 'headless';
  try {
    const snapshot = await browse(url, { mode });
    process.stdout.write(snapshot + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

async function runDaemonInternal() {
  const { runDaemon } = await import('./src/daemon.js');
  const opts = {
    mode: parseFlag('--mode') || 'headless',
    port: parseFlag('--port'),
    cookies: !hasFlag('--no-cookies'),
    browser: parseFlag('--browser'),
    timeout: parseFlag('--timeout'),
    pruneMode: parseFlag('--prune-mode') || 'act',
    consent: !hasFlag('--no-consent'),
    proxy: parseFlag('--proxy'),
    viewport: parseFlag('--viewport'),
    storageState: parseFlag('--storage-state'),
  };
  const outputDir = parseFlag('--output-dir') || resolve('.barebrowse');
  const url = parseFlag('--url');
  await runDaemon(opts, outputDir, url || undefined);
}


// --- Flag parsing helpers ---

function parseFlag(name) {
  // --name=value or --name value
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(name + '=')) return args[i].slice(name.length + 1);
    if (args[i] === name && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  }
  return undefined;
}

function hasFlag(name) {
  return args.includes(name);
}


// --- MCP auto-installer ---

function install() {
  // Handle --skill flag
  if (hasFlag('--skill')) {
    installSkill();
    return;
  }

  const mcpEntry = {
    command: 'npx',
    args: ['barebrowse', 'mcp'],
  };

  const targets = detectTargets();

  if (targets.length === 0) {
    console.log('No MCP clients detected.\n');
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
  }

  // Always print Claude Code hint (it uses `claude mcp add`, not JSON config)
  console.log(`\nClaude Code: run this instead of install:`);
  console.log(`  claude mcp add barebrowse -- npx barebrowse mcp\n`);
}

function installSkill() {
  const thisDir = fileURLToPath(new URL('.', import.meta.url));
  const src = join(thisDir, '.claude', 'skills', 'barebrowse', 'SKILL.md');

  if (!existsSync(src)) {
    console.error('SKILL.md not found in package. Reinstall barebrowse.');
    process.exit(1);
  }

  const dest = join(homedir(), '.config', 'claude', 'skills', 'barebrowse', 'SKILL.md');
  const destDir = join(dest, '..');
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log(`Skill installed: ${dest}`);
  console.log('Claude Code will now see barebrowse as an available skill.');
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
    const dir = join(claudeDesktop, '..');
    if (existsSync(dir)) {
      targets.push({ name: 'Claude Desktop', path: claudeDesktop });
    }
  }

  // Cursor
  const cursorDir = join(home, '.cursor');
  if (existsSync(cursorDir)) {
    targets.push({ name: 'Cursor', path: join(cursorDir, 'mcp.json') });
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


// --- Usage ---

function printUsage() {
  process.stdout.write(`barebrowse -- CDP-direct browsing for autonomous agents

Session:
  barebrowse open [url] [flags]     Open browser session
  barebrowse close                  Close session
  barebrowse status                 Check session status

  Open flags:
    --mode=headless|headed|hybrid   Browser mode (default: headless)
    --port=N                        CDP port for headed mode
    --no-cookies                    Skip cookie injection
    --browser=firefox|chromium      Cookie source browser
    --timeout=N                     Navigation timeout in ms
    --prune-mode=act|read           Default pruning mode
    --no-consent                    Skip consent dismissal
    --proxy=URL                     HTTP/SOCKS proxy server
    --viewport=WxH                  Viewport size (e.g. 1280x720)
    --storage-state=FILE            Load cookies/localStorage from JSON file

Navigation:
  barebrowse goto <url>             Navigate to URL
  barebrowse back                   Go back in history
  barebrowse forward                Go forward in history
  barebrowse snapshot [--mode=M]    ARIA snapshot -> .barebrowse/page-*.yml
  barebrowse screenshot [--format]  Screenshot -> .barebrowse/screenshot-*.png
  barebrowse pdf [--landscape]      PDF export -> .barebrowse/page-*.pdf

Interaction:
  barebrowse click <ref>            Click element
  barebrowse type <ref> <text>      Type text (--clear to replace)
  barebrowse fill <ref> <text>      Clear + type
  barebrowse press <key>            Press key (Enter, Tab, Escape, ...)
  barebrowse scroll <deltaY>        Scroll (positive=down)
  barebrowse hover <ref>            Hover element
  barebrowse select <ref> <value>   Select dropdown value
  barebrowse drag <from> <to>       Drag element to another
  barebrowse upload <ref> <files..> Upload files to file input

Tabs:
  barebrowse tabs                   List open tabs
  barebrowse tab <index>            Switch to tab by index

Debugging:
  barebrowse eval <expression>      Run JS in page context
  barebrowse wait-idle [--timeout]  Wait for network idle
  barebrowse wait-for [opts]        Wait for text/selector to appear
    --text=STRING                   Wait for text in page body
    --selector=CSS                  Wait for CSS selector to match
    --timeout=N                     Max wait time in ms (default: 30000)
  barebrowse console-logs           Console logs -> .barebrowse/console-*.json
  barebrowse network-log            Network log -> .barebrowse/network-*.json
  barebrowse dialog-log             JS dialog log -> .barebrowse/dialogs-*.json
  barebrowse save-state             Cookies + localStorage -> .barebrowse/state-*.json

One-shot:
  barebrowse browse <url> [mode]    Browse + print snapshot to stdout

MCP:
  barebrowse mcp                    Start MCP server (JSON-RPC over stdio)
  barebrowse install                Auto-configure MCP for Claude Desktop / Cursor
  barebrowse install --skill        Install SKILL.md for Claude Code

As a library:
  import { browse, connect } from 'barebrowse';

More: see README.md or barebrowse.context.md
`);
}
