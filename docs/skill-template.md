# Skill Template — Teaching AI Agents to Use CLI Tools

A **skill** is a markdown file that teaches a coding agent (Claude Code, etc.) how to use a CLI tool. No code, no dependencies, no scripts — just a markdown file with YAML frontmatter that the agent reads as context.

## What's in a skill file

```markdown
---
name: your-tool
description: One-liner explaining what the tool does.
allowed-tools: Bash(your-tool:*)
---

# your-tool — Brief Title

One paragraph: what it does, what it's for.

## Quick Start

\```bash
your-tool init           # Setup
your-tool do-thing       # Core action
your-tool status         # Check state
your-tool cleanup        # Teardown
\```

## Commands

| Command | Description |
|---------|-------------|
| `your-tool init` | ... |
| `your-tool do-thing <arg>` | ... |
| `your-tool status` | ... |
| `your-tool cleanup` | ... |

## Output Format

Describe what the tool outputs and where (stdout, files, etc.)
Show a real example so the agent knows what to expect.

## Workflow Pattern

1. Step one
2. Step two
3. Repeat as needed
4. Clean up

## Tips

- Gotchas, edge cases, best practices
- Things the agent should always/never do
```

## Frontmatter fields

| Field | Required | What it does |
|-------|----------|--------------|
| `name` | Yes | Tool identifier. Shown in Claude's skill list. |
| `description` | Yes | One-liner. Shown when Claude lists available skills. |
| `allowed-tools` | Yes | Auto-grants Bash permission. `Bash(your-tool:*)` means any command starting with `your-tool`. |

## How to install

The skill file is just a `.md` file placed where the agent can find it:

### Claude Code

| Scope | Location | How |
|-------|----------|-----|
| **This project only** | `.claude/skills/your-tool/SKILL.md` | Copy file into project |
| **All projects (global)** | `~/.config/claude/skills/your-tool/SKILL.md` | Copy file to home config |

### Other coding agents (Cursor, Windsurf, Copilot, etc.)

| Agent | Project scope | Global scope |
|-------|---------------|--------------|
| **Cursor** | `.cursor/rules/your-tool.md` | `~/.cursor/rules/your-tool.md` |
| **Windsurf** | `.windsurf/rules/your-tool.md` | `~/.windsurf/rules/your-tool.md` |
| **GitHub Copilot** | `.github/copilot-instructions.md` (append) | N/A |
| **Generic** | Drop in project root as `your-tool.context.md` | Varies by agent |

> **Note:** Non-Claude agents ignore the YAML frontmatter — they just read it as markdown context. The `allowed-tools` field is Claude Code specific.

## What the skill does NOT do

- Does not install the CLI tool — `npm install` (or equivalent) is still required
- Does not run any code — it's pure documentation
- Does not replace MCP — it's an alternative integration path (see below)

## Skill vs MCP

| | Skill (CLI) | MCP Server |
|---|---|---|
| **What it is** | Markdown file teaching the agent CLI commands | Long-running JSON-RPC process |
| **How agent calls it** | `bash` tool with shell commands | Native tool calls via MCP protocol |
| **State** | Tool manages its own state (daemon, files, etc.) | MCP server holds state in memory |
| **Install** | Copy a `.md` file | Register server in config JSON |
| **Deps at runtime** | CLI tool must be installed (`npm install`) | CLI tool must be installed (`npx` or global) |
| **Works with** | Claude Code (+ any agent that reads project docs) | Any MCP client (Claude Desktop, Cursor, VS Code, etc.) |
| **Pros** | Simple, debuggable, no process management | Structured schemas, wide MCP client support |
| **Cons** | Agent needs Bash access, less structured | Extra process, protocol overhead |

Both require the underlying tool to be installed. Choose based on your agent's capabilities.

## Example: barebrowse

barebrowse ships its skill at `.claude/skills/barebrowse/SKILL.md`. Install options:

```bash
# Project-local (Claude Code picks it up automatically)
cp node_modules/barebrowse/.claude/skills/barebrowse/SKILL.md .claude/skills/barebrowse/SKILL.md

# Global (all projects)
barebrowse install --skill
# copies to ~/.config/claude/skills/barebrowse/SKILL.md

# For Cursor
cp node_modules/barebrowse/.claude/skills/barebrowse/SKILL.md .cursor/rules/barebrowse.md
```
