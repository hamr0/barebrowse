# barebrowse -- Documentation

## Navigation

### 00-context/ -- Why and what exists

| File | What's in it |
|------|-------------|
| [vision.md](product/vision.md) | What barebrowse is, what it's not, the core insight, success criteria |
| [assumptions.md](product/assumptions.md) | Hard constraints, assumptions, known limitations, risks |
| [system-state.md](product/system-state.md) | Current architecture, full pipeline, module table, capabilities, tested sites |

### 01-product/ -- What the product must do

| File | What's in it |
|------|-------------|
| [prd.md](product/prd.md) | Product requirements, API design, three modes, pruning strategy, future features |

### 02-features/ -- How features are designed

*Feature-specific docs go here as the project grows.*

### 03-logs/ -- What changed over time

| File | What's in it |
|------|-------------|
| [decisions-log.md](logs/decisions-log.md) | Settled design decisions with rationale (don't re-debate these) |
| [implementation-log.md](logs/implementation-log.md) | What changed per version (summary of CHANGELOG) |
| [bug-log.md](logs/bug-log.md) | Bugs: symptom, root cause, fix, regression test |
| [validation-log.md](logs/validation-log.md) | Test suite results, site validation matrix, token reduction measurements |
| [insights.md](logs/insights.md) | Lessons learned, repos studied, technical patterns |

### 04-process/ -- How to work with this system

| File | What's in it |
|------|-------------|
| [dev-workflow.md](product/dev-workflow.md) | Dev rules, dependency hierarchy, running tests, environment setup |
| [definition-of-done.md](product/definition-of-done.md) | Checklist: when is a feature/fix actually done |
| [testing.md](product/testing.md) | Test pyramid, all 71 tests documented, writing new tests, CI strategy |

### archive/ -- Historical docs

| File | Why archived |
|------|-------------|
| [poc-plan.md](archive/poc-plan.md) | All 4 POC phases completed. Useful bits migrated to system-state.md and testing.md. |

## Also at project root

| File | Purpose |
|------|---------|
| `README.md` | Public-facing project overview |
| `barebrowse.context.md` | LLM-consumable integration guide (full API, gotchas, wiring) |
| `commands/barebrowse.md` | CLI command reference for any agent (same as SKILL.md without frontmatter) |
| `commands/barebrowse/SKILL.md` | CLI command reference for Claude Code (copy to `.claude/skills/`) |
| `CHANGELOG.md` | Detailed version-by-version changelog |
| `CLAUDE.md` | AI agent instructions for this project |
