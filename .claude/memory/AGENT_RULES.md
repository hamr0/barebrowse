# AI Agent Collaboration Guide

## Table of Contents
1. [Operating Flow](#operating-flow)
2. [Communication Protocol](#communication-protocol)
3. [Development Standards](#development-standards)
4. [Testing Standards](#testing-standards)
5. [Security & Robustness Invariants](#security--robustness-invariants)
6. [Guardrails (Enforced, Not Requested)](#guardrails-enforced-not-requested)
7. [Environment](#environment)
8. [Development Workflow](#development-workflow)
9. [Twelve-Factor Checklist](#twelve-factor-checklist)
10. [CLAUDE.md Stub](#claudemd-stub)
11. [AI Agent Instructions](#ai-agent-instructions)

---

## Operating Flow

Every task runs through three layers. Do not skip ahead to code.

1. **Spec — agree on intent before touching anything.** Interview me up front to surface the *real* goal and the context you can't see — prompt the **decision I'm trying to make**, not the literal task I typed. Break the scope into small buckets with checkpoints. **State the load-bearing structural and logic decisions and get my explicit sign-off *before* you execute.** A wrong assumption caught at spec stage costs a sentence; caught after building it costs the build.
2. **Verify — define "good" up front, then prove it.** Write down what success looks like *before* changing code. Prove with measurement and tests, not assertion (see [*Prove, don't assert*](#validate-before-you-build)). Gate security-sensitive work with `/security` and pre-deploy with `/ship`; a second-model pass (`/code-review`) on non-trivial output is worth the round-trip. External signal — a real test run, a real deploy, a gold-standard reference — beats a confident paragraph every time.
3. **Environment — the guardrails are enforced, not requested.** This file is the standing context that primes every session. Critical-path protections (secrets, auth, schema, CI) are enforced by a pre-tool hook on an **Always / Ask / Never** basis — see [Guardrails](#guardrails-enforced-not-requested). Where the hook isn't wired, the same rules still bind you.

> The model is brilliant at execution and blind to intent. You can outsource the typing; you cannot outsource the understanding. Surface assumptions — don't bury them.

---

## Communication Protocol

### Core Rules
- **Spec before build**: Don't wait for ambiguity to block you — interview me up front to extract the real goal and the context you can't see. Prompt the *decision*, not the literal task. Restate what you heard before building
- **Checkpoint before executing**: State the load-bearing structural and logic decisions and get my explicit sign-off *before* you write code. Never run ahead on an unverified assumption — flag it and stop
- **Fact-Based**: Base all recommendations on verified, current information. Prefer external signal (a real run, a real source) over a confident guess
- **Simplicity Advocate**: Call out overcomplications and suggest simpler alternatives
- **Safety First**: Never modify critical systems without explicit understanding and approval. Where the [guardrail hook](#guardrails-enforced-not-requested) is wired, this is enforced before the tool runs, not after

### User Profile
- **Technical Level**: Non-coder but technically savvy
- **Learning Style**: Understands concepts, needs executable instructions
- **Expects**: Step-by-step guidance with clear explanations
- **Comfortable with**: Command-line operations and scripts
- **Builds a lot of web apps** — assume any UI work will be consumed on phones as well as desktop

### Required Safeguards (Always / Ask / Never)

Not courtesies — where the [guardrail hook](#guardrails-enforced-not-requested) is wired these are enforced *before* the tool runs. When it isn't, they still bind you.

- **Always** identify affected files before making changes, and explain what will change and why
- **Ask first** — stop and get explicit sign-off — before modifying authentication systems, database schema or migrations, CI workflows, or `.claude/settings.json`
- **Never** write secrets into the tree (`.env`/`*.env`, keys, credentials). They load from the environment at runtime; only a value-less `.env.example` is committed

---

## Development Standards

### Validate Before You Build

- **POC everything first.** Before committing to a design, build a quick proof-of-concept (~15 min) that validates the core logic. Keep it stupidly simple — manual steps are fine, hardcoded values are fine, no tests needed yet
- **POC scope:** Cover the happy path, 2-3 common edge cases, **and the riskiest assumption (see below) — not just the parts that are easy to check**. If those hold, the idea is sound
- **Graduation criteria:** POC validates logic and covers most common scenarios → stop, design properly, then build with structure, tests, and error handling. Never ship the POC — rewrite it
- **Aim the POC at the load-bearing claim — not the easy part.** Name the riskiest assumption first (does the cheap path actually run cheap? does the library really do X? does the perf hold?), then point the spike straight at *that*. A POC that confirms the happy-path shape while hand-waving the risky mechanism is theater. If you catch yourself writing "production would do X" instead of *doing* X in the spike, the POC has not validated X — go do X
- **Prove, don't assert — a POC's output is evidence you ran, not prose you wrote.** Every claim the design rests on must be something the spike actually exercised and you actually observed. **Measure anything you call "cheap," "fast," "constant," or "negligible"** — never state a cost you didn't time; a guessed number is a bug with a confident voice. State conclusions only at the confidence the evidence supports: if you didn't test it, say so plainly instead of rounding up to "it works." Better a small honest finding than a big-mouthed claim that measurement later falsifies
- **The test must be able to FAIL — pre-flight check, not an afterthought.** Before trusting a POC's numbers, confirm three things: **(1) Can the test produce the negative?** A fixture you authored to contain the phenomenon you're testing can only confirm it — prefer real, uncrafted data over synthetic inputs; if synthetic is unavoidable, construct it so it *could* show no effect. **(2) Is the harness free of confounds?** A surprising or degenerate result is often an artifact of the setup, not a real finding — when output looks wrong, debug the test before believing it. **(3) Did the test actually exercise the variable?** If two conditions that should differ produce identical output, the variable isn't wired in — that's a finding, not noise. Run this checklist every time, especially when a result confirms what you hoped
- **Build incrementally.** After POC graduates, break the work into small, independent modules. Focus on one at a time. Each piece must work on its own before integrating with the next

### Dependency Hierarchy

Always exhaust the simpler option before reaching for the next:

1. **Vanilla language** — Write it yourself using only language primitives. If it's <50 lines and not security-critical, this is the answer
2. **Standard library** — Use built-in modules (`os`, `json`, `pathlib`, `http`, `fs`, `crypto`). The stdlib is tested, maintained, and has zero supply chain risk
3. **External library** — Only when both vanilla and stdlib are insufficient. Must pass the checklist below

### External Dependency Checklist

Before adding any external dependency, all of these must be true:
- **Necessity:** Can't reasonably implement this with stdlib in <100 lines
- **Maintained:** Active commits in the last 6 months, responsive maintainer
- **Lightweight:** Few transitive dependencies (check the dep tree, not just the top-level)
- **Established:** Widely used, not a single-maintainer hobby project for production-critical code
- **Security-aware:** For security-critical domains (crypto, auth, sanitization, parsing untrusted input), a vetted library is *required* — never roll your own

### Language Selection

- **Use widely-adopted languages only** — Python, JavaScript/TypeScript, Go, Rust. No niche languages unless the domain demands it
- **Pick the lightest language that fits the domain:** shell scripts for automation, Python for data/backend/CLI, TypeScript for web, Go for systems/infra, Rust for performance-critical
- **Minimize the polyglot tax.** Every language in the stack adds CI config, tooling, and onboarding friction. Do not add a new language for one microservice — use what's already in the stack unless there's a compelling reason
- **Vanilla over frameworks.** Express over NestJS, Flask over Django, unless the project genuinely needs the framework's structure. Structure can always be added later; removing a framework is painful

### Build Rules

- **Open-source only.** Always use open-source solutions. No vendor lock-in
- **Lightweight over complex.** If two solutions solve the same problem, use the one with fewer moving parts, fewer dependencies, and less configuration
- **Every line must have a purpose.** No speculative code, no "might need this later", no abstractions for one use case
- **Simple > clever.** Readable code that a junior can follow beats elegant code that requires a PhD to debug
- **Containerize only when necessary.** Start with a virtualenv or bare metal. Docker adds value for deployment parity and isolation — not for running a script
- **Responsive web UI is mandatory in dev projects.** Any web UI must be usable on mobile by default — fluid layouts, viewport meta tag, breakpoints for narrow screens, no horizontal scroll. Test in DevTools device emulation before declaring a UI task done. POCs are exempt (validate the idea first), but the moment a POC graduates to a real project this becomes a hard requirement
- **Surgical changes only.** Touch what the task requires; nothing else. Don't "improve" adjacent code, comments, or formatting. Match existing style even if you'd do it differently. Only clean up orphans your own change created — leave pre-existing dead code alone unless asked. Every changed line should trace directly to the request

### Red Flags — Stop and Flag These
- Over-engineering simple problems
- Adding external dependencies for trivial operations
- Frameworks where a library or stdlib would suffice
- Vendor-specific implementations when open alternatives exist
- Skipping POC validation for unproven ideas
- POC-ing only the easy part while hand-waving the risky mechanism, or claiming a cost ("cheap"/"fast"/"constant") you never measured
- Authoring a fixture/corpus that *guarantees* the result (a test that can't return the negative), or trusting a degenerate-looking number without auditing the harness for confounds — use real uncrafted data; the test must be able to fail

---

## Testing Standards

### Rules

**Test behavior, not implementation.** A test suite must give you confidence to refactor freely. If changing internal code (without changing behavior) breaks tests, those tests are liabilities, not assets.

**Follow the Testing Trophy** (not the Testing Pyramid):
- Few unit tests — only for pure logic, algorithms, and complex calculations
- Many integration tests — the sweet spot; test real components working together
- Some E2E tests — cover critical user journeys end-to-end
- Static analysis — types and linters catch bugs cheaper than tests

### When to Write Tests

- **After the design stabilizes, not during exploration.** Do not TDD a prototype — you'll write 500 tests for code you delete tomorrow. First make it work (POC), then make it right (refactor + tests), then make it fast
- **Write tests when the code has users.** If a function is called by other modules or exposed to users, it needs tests. Internal helpers that only serve one caller don't need their own test file
- **Write tests for bugs.** Every bug fix must include a regression test that fails before the fix and passes after. This is the highest-value test you can write
- **Write tests before refactoring.** Before changing working code, write characterization tests first to lock in current behavior, then refactor with confidence
- **Do not write tests for glue code.** Code that just wires components together (calls A then B then C) is tested at the integration level, not unit level

### TDD: When It Works and When It Doesn't

- **TDD works for:** Pure functions, algorithms, parsers, validators, data transformations — anything with clear inputs and outputs
- **TDD does not work for:** Exploring a design, building a POC, or unstable interfaces. Writing tests for unstable APIs creates churn and false confidence
- **The rule:** You must understand what you're building before you TDD it. TDD is a design tool for known problems, not a discovery tool for unknown ones
- **Red-green-refactor discipline:** If you do TDD, follow the cycle strictly. Write a failing test, write minimal code to pass, refactor. Do not write 20 tests then implement — that's front-loading waste

### What Makes a Good Test

- **Tests real behavior.** Call the public API, assert on observable output. Do not reach into internals
- **Fails for the right reason.** A good test fails when the feature is broken, not when the implementation changes
- **Reads like a spec.** Someone unfamiliar with the code must understand what the feature does by reading the test
- **Self-contained.** Each test sets up its own state, runs, and cleans up. No ordering dependencies between tests
- **Fast and deterministic.** Flaky tests erode trust. If a test depends on timing, network, or global state, fix that dependency

### Anti-Patterns — Do Not Do These

- **Mocking more than 60% of the test.** If most of the test is mock setup, you're testing mocks, not code. Use real implementations with `tmp_path`, `:memory:` SQLite, or test containers
- **Smoke tests.** `assert result is not None` proves nothing. Assert on specific values, structure, or side effects
- **Testing private methods.** If you need to test a private method, either it should be public or the public method's tests should cover it
- **Mirroring implementation.** Tests that replicate the source code line-by-line break on every refactor and catch zero bugs
- **Test-only production code.** Never add methods, flags, or branches to production code solely for testing. Use dependency injection instead

### Test Organization

- **Co-locate tests with packages:** `packages/<pkg>/tests/` not a root `tests/` directory. Each package owns its tests
- **Separate by type:**
  ```
  packages/<pkg>/tests/
    unit/           # Fast, isolated, mocked deps, <1s each
    integration/    # Real DB, filesystem, multi-component, <10s each
    e2e/            # Full workflows, subprocess calls, <60s each
    conftest.py     # Shared fixtures for this package
  ```
- **One test file per module** (not per function). `test_auth.py` tests the auth module, not `test_login.py` + `test_logout.py` + `test_session.py`
- **No duplicate test files.** Before creating a new test file, check if one already exists for that module

### Markers and Signals

| Marker | Purpose | CI Behavior |
|--------|---------|-------------|
| `@pytest.mark.slow` | Runtime > 5s | Run in full suite, skip in quick checks |
| `@pytest.mark.ml` | Requires ML deps (torch, etc.) | Skip if deps not installed |
| `@pytest.mark.real_api` | Calls external APIs | Skip in CI — run manually before release |

**CI runs for fast signals:**
- `pytest -m "not slow and not ml and not real_api"` — fast gate on every push (~30s)
- `pytest` — full suite on PR merge or nightly
- Package-level runs for targeted debugging: `pytest packages/core/tests/`

### Coverage and Ratios

- **Do not chase a coverage number.** 80% coverage with meaningless tests is worse than 40% with behavior-testing integration tests
- **Cover the critical path first.** Data layer, auth, payment, core business logic — before helper utilities
- **Coverage tells you what's NOT tested, not what IS tested.** High coverage with bad assertions is false confidence
- **Delete tests that don't catch bugs.** If a test has never failed (or only fails on refactors), it's not providing value

**Target ratio:** ~20% unit, ~60% integration, ~15% E2E, ~5% manual/exploratory

### Test Tooling Standards

- Use `tmp_path` for filesystem tests, `:memory:` or `tmp_path` SQLite for DB tests
- Use dependency injection over `@patch` — it's more readable and survives refactors
- Tests must be self-sufficient — no dependency on project directories, user config, or environment state
- Use factories or builders for test data, not raw constructors with 15 arguments
- Keep test fixtures close to where they're used. Shared fixtures in `conftest.py`, not a global test utilities package

---

## Security & Robustness Invariants

These are the failure classes that show up in nearly every quickly-built app, regardless of stack or language. Treat them as **build-time invariants** — satisfy them as you write the code, not as a cleanup pass. Apply each where it fits the thing you're building (a library has no endpoints; a CLI has no tenant isolation) — skip what genuinely doesn't apply, never skip what does.

Throwaway POCs are exempt while you validate logic (per **POC first** above) — hardcoded values and missing error handling are fine in a 15-minute spike. The moment a POC graduates to a real build, every applicable invariant becomes mandatory. The one item that holds even for a POC: never commit a real secret.

1. **No secrets in the repo.** Keys, tokens, and credentials load from the environment / a secret store at runtime — never hardcoded, never logged. `.env` is gitignored; only a value-less `.env.example` is committed. Scan history before trusting a repo. One leaked key is a breached database or a runaway bill.
2. **Scope every data access to its owner.** Each record read or written is constrained to the requesting principal — via DB-level rules (RLS / row policies) and/or an application-layer ownership check. Never trust a client-supplied id without a gate. If the storage layer offers row-level policies, enabling them is not optional, and "on but too broad" still fails.
3. **Bound every reachable endpoint.** Rate-limit public routes AND authenticated mutation/write routes AND abuse-prone inbound paths (mail, webhooks). An unbounded route is a free DoS and bill amplifier — a script in a loop should not be able to take the service down.
4. **Handle the unhappy path.** Every IO / network / DB / third-party call has an explicit failure path. Nothing fails silently. Internal detail (stack traces, queries, secrets) never reaches the client. Async/background work carries its own catch.
5. **Authorization is not authentication.** "Logged in" never implies "allowed". Every state-changing or privileged action checks ownership AND role/permission. If swapping an id in a request would expose or mutate someone else's data, it's a bug — return 403.
6. **Data access scales.** No queries inside loops, no per-render repeated round-trips, indexes on every filtered/joined column. Code that's fine at 10 users and collapses at 1,000 is a latent outage.

Also hold the line on: input validation at every trust boundary (untrusted uploads, inbound mail, webhooks, and spoofable headers like `X-Forwarded-For` — trust them only behind a vetted proxy); parameterized queries (never string-built SQL); vetted libraries for crypto / auth / sanitization (never roll your own); and least-privilege binding (loopback, not `0.0.0.0`, unless the port is deliberately public).

**Verify at two moments, not one.**
- **While building** — this list shapes the code as it's written.
- **Before deploy/merge** — run **`/security`** on security-sensitive changes and **`/ship`** as the pre-deploy gate. A Critical/High finding blocks the ship; lower-severity findings get logged and triaged, not silently shipped. Proactively remind the user to run them whenever a change touches auth, data access, endpoints, secrets, or untrusted input.

---

## Guardrails (Enforced, Not Requested)

A prompt rule is a request the model can rationalise past. For anything that actually matters — secrets, auth, schema — don't rely on soft instruction. Enforce it with a **pre-tool hook** that intercepts the call *before* it runs and decides on an **Always / Ask / Never** basis:

- **Never** — writing `.env`/`*.env`, keys, or credential files is blocked outright (secrets load from the environment, never the tree). Destructive shell (`rm -rf` of a root-ish target, redirecting into a secret) is blocked too.
- **Ask** — touching auth, DB schema/migrations, CI workflows, or `.claude/settings.json` forces a human confirmation. Same for force-push / push to a default branch.
- **Always / allow** — everything else proceeds through the normal permission flow; the hook stays out of the way.

The reference implementation ships in this repo at [`.claude/hooks/guardrails.py`](.claude/hooks/guardrails.py) — stdlib only, no deps, fails open on a malformed event so it can never wedge the agent. The Never/Ask lists are constants at the top; **tune them per project**. To wire it up, add to the project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
        "hooks": [
          { "type": "command", "command": "python3 .claude/hooks/guardrails.py" }
        ]
      }
    ]
  }
}
```

The hook is the hard line; the prose rules above are why it exists. Keep them in sync — when you tighten one, tighten the other.

---

## Environment

- **OS**: Fedora Linux (use `dnf` for packages, `systemctl` for services)
- **Testing**: pytest (Python), Jest/Vitest (JS/TS), Playwright (browser automation)

---

## Development Workflow

### Environments
- **Development**: Local machines
- **Staging**: VPS with isolated database
- **Production**: VPS with containerized setup

### Deployment Strategy

**Simple Projects:** `Local → GitHub → VPS (direct deployment)`

**Complex Projects:** `Local → GitHub → GHCR → VPS (containerized)`

---

## Twelve-Factor Checklist

The [Twelve-Factor App](https://12factor.net) methodology for modern, scalable applications:

| # | Factor | Rule |
|---|--------|------|
| 1 | Codebase | One repo per app, multiple deploys from same codebase |
| 2 | Dependencies | Explicitly declare and isolate all dependencies |
| 3 | Config | Store config in environment variables, never in code |
| 4 | Backing Services | Treat databases, caches, queues as attached resources |
| 5 | Build, Release, Run | Strict separation between build, release, and run stages |
| 6 | Processes | Run as stateless processes, persist state externally |
| 7 | Port Binding | Apps are self-contained, export services via port binding |
| 8 | Concurrency | Scale out via the process model, not bigger instances |
| 9 | Disposability | Fast startup, graceful shutdown, idempotent operations |
| 10 | Dev/Prod Parity | Keep dev, staging, and production as similar as possible |
| 11 | Logs | Treat logs as event streams to stdout |
| 12 | Admin Processes | Run admin/maintenance tasks as one-off processes |

---

## CLAUDE.md Stub

Copy this to any project's CLAUDE.md. These are mandatory rules, not suggestions.

```markdown
## Dev Rules

**POC first.** Always validate logic with a ~15min proof-of-concept before building. Cover happy path + common edges. POC works → design properly → build with tests. Never ship the POC. **Aim the spike at the riskiest assumption, not the easy part; prove, don't assert — measure anything you call "cheap"/"fast"/"constant," and claim only what the evidence supports (no big-mouthed conclusions measurement can falsify). The test must be able to FAIL: prefer real uncrafted data over a fixture you authored to contain the result, audit a degenerate number for harness confounds before believing it, and treat two should-differ conditions that match as a finding.**

**Build incrementally.** Break work into small independent modules. One piece at a time, each must work on its own before integrating.

**Dependency hierarchy — follow strictly:** vanilla language → standard library → external (only when stdlib can't do it in <100 lines). External deps must be maintained, lightweight, and widely adopted. Exception: always use vetted libraries for security-critical code (crypto, auth, sanitization).

**Lightweight over complex.** Fewer moving parts, fewer deps, less config. Express over NestJS, Flask over Django, unless the project genuinely needs the framework. Simple > clever. Readable > elegant.

**Open-source only.** No vendor lock-in. Every line of code must have a purpose — no speculative code, no premature abstractions.

**Responsive web UI is mandatory.** Any web UI must work on mobile by default — fluid layouts, viewport meta, breakpoints, no horizontal scroll. Verify in DevTools device emulation before claiming a UI task is done. POCs exempt; real projects are not.

For full development and testing standards, see `.claude/memory/AGENT_RULES.md`.
```

---

## AI Agent Instructions

When working with this user:
1. **Interview before building** — extract the real goal and surface load-bearing decisions for sign-off before you execute (see [Operating Flow](#operating-flow))
2. **Provide step-by-step** instructions with clear explanations
3. **Include ready-to-run** scripts and commands
4. **Explain the "why"** behind technical recommendations
5. **Flag potential issues** before they become problems — name the assumption, don't bury it
6. **Suggest simpler alternatives** when appropriate
7. **Ask first** before touching auth, DB schema/migrations, CI, or settings; **never** commit secrets — enforced by the [guardrail hook](#guardrails-enforced-not-requested) where wired
8. **Always identify** which files will be affected by changes
