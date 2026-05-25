# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Principles Disciple** is an owner-governed behavior internalization system built as an OpenClaw plugin (Node.js/TypeScript). It captures repeated, owner-relevant behavior evidence ("pain signals"), distills reviewed principles, and applies approved, reversible behavior changes.

Read [`PRODUCT_IDENTITY.md`](PRODUCT_IDENTITY.md) before interpreting product scope. PD does not own general task execution, general memory, tool-call repair, or autonomous value decisions.

**Main package:** `packages/openclaw-plugin/`
**Package manager:** pnpm (monorepo with workspaces)

## Commands

```bash
# Install all dependencies (root)
npm install

# === openclaw-plugin ===
cd packages/openclaw-plugin && npm run build          # Build plugin
cd packages/openclaw-plugin && npm run test            # Run tests
cd packages/openclaw-plugin && npm run test:coverage   # Tests with coverage
npm run lint                                          # Lint (from root)

# === principles-core ===
cd packages/principles-core && npm run build           # Build core
cd packages/principles-core && npm run test            # Run tests

# === pd-cli ===
cd packages/pd-cli && npm run build                    # Build CLI
cd packages/pd-cli && npm run test                     # Run tests

# === pd-console ===
cd packages/pd-console && npm run build                # Build console
cd packages/pd-console && npm run test                 # Run tests

# Release (patch/minor/major)
npm run version:patch  # or minor, major
```

## Architecture

### Directory Structure
```
packages/
├── openclaw-plugin/     # Main plugin (src/, hooks/, core/, commands/, service/)
├── principles-core/      # Core shared logic (pure functions, types, interfaces)
├── pd-cli/              # PD CLI tool
├── pd-console/          # PD Console WebUI
├── create-principles-disciple/  # Installer CLI
└── graphify-out/        # Knowledge graph output (generated)

conductor/               # Product guidelines, tracks, workflow docs
phases/                  # Phase definitions and tracking
docs/                    # Architecture docs, design documents, maps
```

### Core Modules (packages/openclaw-plugin/src/)
- `core/` — Business logic (evolution-engine, pain-context-extractor, local-worker-routing, promotion-gate)
- `hooks/` — OpenClaw lifecycle hooks (prompt.ts, gate.ts, pain.ts, llm.ts, lifecycle.ts, subagent.ts)
- `commands/` — Slash commands (/pd-status, /pd-pain, etc.)
- `service/` — Background services (evolution-worker, trajectory-service, nocturnal-service)
- `types/` — TypeScript type definitions
- `utils/` — I/O, hashing, glob matching utilities

### Data Flow
1. **Tool Call Gate** (`before_tool_call`) — Risk assessment, plan approval, trust level checking
2. **Pain Detection** (`after_tool_call`) — Error classification, pain score computation
3. **Prompt Injection** (`before_prompt_build`) — Thinking OS, pain signals, evolution status injection
4. **Evolution Loop** — Background worker processes pain signals → extracts principles → generates training data

### Storage
- Per-workspace SQLite in `{workspace}/.principles/`
- Central SQLite at `~/.openclaw/principles-console.db` for cross-workspace analytics

## ⚠️ MANDATORY: Read Error Experience Handbook Before Tasks

**Before starting ANY coding task**, you MUST read `docs/ERROR_EXPERIENCE_HANDBOOK.md`. This file records real errors caught in code reviews. Reading it prevents you from repeating mistakes that other AI assistants made on this project.

Before starting product or architecture work, also read `PRODUCT_IDENTITY.md` and reject work that expands PD into task execution, general memory, generic tool repair, or untriggered post-MVP learning infrastructure.

### Error Handbook Gate

Before implementation:

1. Read `docs/ERROR_EXPERIENCE_HANDBOOK.md` **in full**.
2. List the relevant ERR entries for the current task (minimum 3). Reference specific IDs and titles.
3. State how this PR avoids recurrence of each listed ERR. Write this in your implementation brief.
4. If fixing a bug: note which known ERR class the bug belongs to.

After code review (if a real bug is found):

1. **New error class**: Create a new ERR entry in the handbook with full details.
2. **Recurring error class**: Update the existing entry's Recurrence field with the new date and issue.
3. Tag the Linear issue with `lesson-learned` label.
4. Mention handbook updates in the PR body.

### Error Recording (MANDATORY)

**Rule**: Any code review (pr-review skill, self-review, or ad-hoc review) that discovers a real issue (bug, type safety violation, architecture violation, logic error) MUST invoke `record-error` before closing.

You MUST invoke the `record-error` skill immediately. This is not optional — even if the fix was trivial. The skill handles the full workflow: classify → number → Linear comment → tag `lesson-learned` → edit handbook → update stats → commit & PR.

**Do NOT skip this step** with excuses like "the fix was trivial" or "I'll do it later". Without recording, the same class of error will recur across sessions.

## Critical Boundaries

These rules prevent architectural drift. Violating them will break the project.

### Core vs Plugin boundary
- **`packages/principles-core/`** — Pure logic only: no I/O, no filesystem, no database, no network.
  Functions here must be testable with zero mocks.
- **`packages/openclaw-plugin/`** — I/O boundary: filesystem, SQLite, OpenClaw hooks.
  Delegates computation to core; never reimplements logic that core already provides.
- **Rule:** New pure logic (data transforms, state machines, validation, type definitions) goes to `principles-core`.
  New I/O adapters (file readers, DB queries, hook handlers) go to `openclaw-plugin`.
- **FROZEN LEGACY CODE (ADR-0005):** Do NOT modify or add new features to `nocturnal-trinity.ts`, `nocturnal-arbiter.ts`, or `nocturnal-service.ts`. These are deprecated god-classes. All new internalization logic must go to the Runtime V2 Peer Runners in `@principles/core`.

### Architecture regression tests
- `packages/principles-core/tests/architecture-regression.test.ts` guards the core/plugin boundary.
- Any PR that modifies core exports, plugin imports, or CLI command registration **must** update this test.
- **Never skip or delete these tests.** If a test fails, fix the code, not the test.

### ADR compliance
- Architecture decisions are recorded in `docs/adr/` .
- Code that contradicts an ADR is a bug. Fix the code or update the ADR — never silently ignore.
- See `docs/agents/domain.md` for the full workflow.

## Runtime Contract Rules

All code that handles untrusted data (parsed JSON, LLM output, DB `diagnosticJson`, artifact metadata) must follow these 9 rules. Each rule maps to real error patterns in the Error Experience Handbook. Review these rules during implementation AND during code review.

| # | Rule | Key constraint | ERR ref |
|---|------|----------------|---------|
| 1 | Treat parsed JSON / LLM output / DB `diagnosticJson` / artifact metadata as `unknown` | Never use `any`; require runtime validation before use | ERR-001 |
| 2 | Do not use `as` to bypass runtime validation | Use `typeof`, `Array.isArray()`, or type guards for runtime checks | ERR-001, ERR-005 |
| 3 | Required fields must fail loud when missing or malformed | Use `if (!valid) { error }` pattern, not `if (valid) { skip }` | ERR-009, ERR-010 |
| 4 | Validate array element types | Use `filter(isString)` or element-wise `typeof` on unknown arrays | ERR-005, ERR-007 |
| 5 | Use `Object.hasOwn()`, not `in`, for untrusted object keys | `in` matches inherited properties (toString, constructor) | ERR-013 |
| 6 | Lineage and evidence fields must come from the same source; add mismatch tests | sourceTaskId/sourceRunIds/sourcePainId must be internally consistent | ERR-004, ERR-008 |
| 7 | Retry/repair loops must distinguish current, next, and recorded state | Get fresh errors each iteration; record with current-iteration data | ERR-015, ERR-018, ERR-019 |
| 8 | Preview and telemetry paths must be bounded and use safe serialization | Use `safeStringifyPreview`; never raw `JSON.stringify` on unknown values | ERR-014, ERR-016, ERR-017 |
| 9 | Graceful degradation must include a reason via structured error, notes, telemetry, or logs | Silent fallback = bug. Observability is mandatory. | ERR-002 |

**Enforcement**: Code review must check every rule that applies to the changed code. If a rule doesn't apply, state why.

## CLI / Operator Command Gate

Apply this gate to every change touching `packages/pd-cli/src/commands/**`, CLI registration, remediation commands, queue/run commands, or operator workflows.

1. **JSON mode is strict**: `--json` output must be exactly one parseable JSON object on stdout. No banners, headings, explanatory text, or mixed stdout logs.
2. **Exit paths must stop execution**: after `process.exit(...)` inside an async handler, immediately `return` or throw. Tests that stub `process.exit` must prove no later DB/ledger/artifact side effects happen.
3. **Negated flags need parser tests**: Commander `--no-*` flags must be registered as `--no-name` and read as `opts.name === false`. Add parser-level tests, not only handler tests.
4. **Dry-run/confirm semantics are mandatory**: commands that can mutate state must default to dry-run unless the established command contract says otherwise. `--dry-run` and `--confirm` must be mutually exclusive when both exist.
5. **Failure paths must not mutate state**: failed diagnoses, failed validation, unsupported runners, missing input, and non-succeeded upstream stages must not intake, enqueue, write artifacts, update ledger, or create successors.
6. **Operator output needs next action**: every degraded/refused/failed CLI result must include a structured reason and next action in JSON output.
7. **Test the real command wiring**: when behavior depends on Commander options, add a command-registration or parser test that exercises the actual flags.

## Key Conventions

### File Naming
- PascalCase for components, types, interfaces
- camelCase for functions, variables, hooks
- kebab-case for directories and config files

### TypeScript
- Strict mode enabled
- Prefer explicit types over `any`
- Use `unknown` when type is truly unknown

### Git Workflow
- **Pre-flight Check**: ALWAYS run `git log -n 5` to check recently merged PRs, and ALWAYS consult the `graphify` knowledge graph for dependency mapping before coding. Blind grepping is forbidden.
- Branch format: `feature/<name>`, `fix/<issue-id>-<name>`
- Conventional commits: `feat()`, `fix()`, `docs()`, `refactor()`, `test()`, `chore()`
- Main branch is `main` — direct pushes prohibited

### Pull Request Merging
- **禁止 AI 直接合并 PR** — 所有 PR 必须由用户手动完成合并，不得使用 `gh pr merge` 或任何 git 命令自动合并
- AI 可创建 PR、推送分支、同步 Linear 状态，但合并操作必须由用户执行
- 如需合并提示，应明确告知用户前往 GitHub 页面手动完成

## PR Pre-Review Gate

Before handing off a PR (pushing, creating PR, or reporting completion), execute this checklist:

**Review convergence and throughput**
- Perform one adversarial self-review before first handoff. Check every applicable Runtime Contract rule and CLI / Operator rule against the entire diff, then fix all in-scope P0/P1/P2 findings in one batch.
- The first external review is the single broad review pass. When responding to review fixes, verify the named blockers and modified regression surface only; do not expand into unrelated improvements.
- Block merge only for P0/P1 issues or P2 issues that violate the current Linear issue acceptance criteria. Capture other observations as follow-up issues without modifying this PR.
- When multiple findings share a root cause, update the Error Handbook once after the fix cycle rather than generating one lesson per comment.
- During review iterations run targeted tests for changed behavior; before handoff run the required merge gate once. Avoid expanding the test matrix for unrelated observations.

**Self-review/fix loop**
- A PR is not ready just because code was pushed. It is ready only after the fetch → fix → verify → re-fetch loop has no valid unresolved P0/P1/P2 findings and required checks are green.
- After every push that addresses review feedback, fetch PR reviews/comments/checks again. Do not ask the user to relay comments unless GitHub API access fails after at least 2 retries.
- Classify each review comment as: fixed, deferred with reason, duplicate, or misunderstanding with evidence. Put this classification in the PR comment or completion report.
- If a real bug was found, run the Error Recording workflow before final handoff.

**Fetch and resolve PR comments**
- `gh pr view <PR> --json comments,reviews,latestReviews,files,statusCheckRollup`
- `gh api repos/:owner/:repo/pulls/<PR>/comments --paginate`
- `gh api repos/:owner/:repo/issues/<PR>/comments --paginate`
- Fetch ALL comments (not just the first page). Retry at least 2 times on API failure.
- Fix every valid P0/P1/P2 finding. For each handled comment, note the fix.
- If a comment cannot be fixed, explain why in the PR body.

**Check diff scope**
- `gh pr diff <PR> --name-only` (or `git diff origin/main --name-only`)
- Confirm no unrelated files were modified.
- Confirm no stale-main rollback of already-merged code (see ERR-012).

**Run tests**
- `cd packages/principles-core && npm run test`
- `cd packages/openclaw-plugin && npm run test`
- `npm run lint` (if available)
- `npm run verify:merge` (if available)

**Final summary**
Include in the PR body or completion report:
- Relevant ERR checklist (which ERR entries were considered and how avoided)
- PR comments handled (total fetched, valid fixed, deferred, duplicates/misunderstandings)
- Tests run (which commands, what results)
- For CLI/operator changes: JSON-mode check, exit-path check, flag-wiring tests, and mutation/no-mutation evidence
- Remaining risk (known issues, skipped coverage, trade-offs)

## Key Files

| File | Purpose |
|------|---------|
| `packages/openclaw-plugin/src/index.ts` | Plugin entry point — registers all hooks, commands, services |
| `packages/openclaw-plugin/openclaw.plugin.json` | Plugin manifest — defines routes, hooks, dependencies |
| `conductor/workflow.md` | AI agent orchestration workflow |
| `docs/ARCHITECTURE.md` | System design and component relationships |
| `MEMORY.md` | Project context and progress tracking |

## Related Documentation

- `docs/ARCHITECTURE.md` — Full system architecture
- `docs/DEVELOPMENT.md` — Local setup, build, test commands
- `docs/TESTING.md` — Test patterns and coverage requirements
- `packages/openclaw-plugin/SKILL.md` — AI agent skill definitions

## graphify

This project has a graphify knowledge graph at `graphify-out/` (git hook auto-rebuilds on commit).

### When to use the graph (NOT raw files)

**Prefer the graph for:**
- "Which files/modules handle X?" — use `/graphify path` or `/graphify query`
- "How does X relate to Y?" — use `/graphify path "X" "Y"`
- Understanding module boundaries and dependencies
- Finding isolated or over-coupled components
- Identifying unexpected cross-module connections

**Prefer raw files for:**
- Reading specific implementation details (exact function logic)
- Writing or modifying code (need full context)
- Debugging specific errors
- Files not yet in the graph (new files)

### Workflow

1. **On session start**: If answering architecture/codebase questions, check if `graphify-out/graph.json` is recent (updated after last `git commit`). If stale, run `/graphify --update .` first.

2. **Before exploring new module**: Run `/graphify query "<module or concept>"` to see how it connects before diving into files.

3. **After completing significant code changes**: Run `/graphify --update .` to sync the graph (AST-only, free), or just commit — the git hook handles it.

4. **Graph is the map, files are the terrain**: Use the graph to navigate, use raw files for precision.

### Key files
- `graphify-out/GRAPH_REPORT.md` — God nodes, surprising connections, suggested questions
- `graphify-out/graph.json` — Full graph data
- `graphify-out/graph.html` — Interactive browser visualization
- `graphify-out/wiki/index.md` — Community-structured notes (if `--wiki` was used)

## Agent skills

### Issue tracker

Linear (`Principles_disciple` team, MCP tools `mcp__plugin_linear_linear__*`).
See `docs/agents/issue-tracker.md`.

**MANDATORY LINEAR WORKFLOW:**
1. **Start**: Use `get_issue` to read the latest comments and updates BEFORE writing any code.
2. **Status**: Update the issue status to `In Progress` when you begin.
3. **Communicate**: Use `create_comment` to document your plan, blockers, or significant architectural choices directly on the issue.
4. **Finish**: Update the issue status to `In Review` or `Done` and leave a summary comment when the work is completed.

### Triage labels

5 canonical labels (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`).
See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context (`CONTEXT-MAP.md` at root → per-package `CONTEXT.md`).
See `docs/agents/domain.md`.
