# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Principles Disciple** is an owner-governed behavior internalization system built as an OpenClaw plugin (Node.js/TypeScript). It captures repeated, owner-relevant behavior evidence ("pain signals"), distills reviewed principles, and applies approved, reversible behavior changes.

Product boundary: PD does not own general task execution, general memory, tool-call repair, or autonomous value decisions. Read [`PRODUCT_IDENTITY.md`](docs/product/PRODUCT_IDENTITY.md) when creating or planning issues, or when changing product scope, architecture, roadmaps, user journeys, surfaced functionality, activation channels, or public product copy. A narrow implementation, bug, test, or CI fix inside an approved issue may rely on this summary unless it changes those boundaries.

**Main package:** `packages/openclaw-plugin/`
**Package manager:** npm (monorepo with workspaces)

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
└── conductor/               # Product guidelines, tracks, workflow docs
phases/                  # Phase definitions and tracking
docs/                    # Architecture docs, design documents, maps
```

### Core Modules (packages/openclaw-plugin/src/)
- `core/` — Business logic (evolution-engine, pain-context-extractor, local-worker-routing, promotion-gate)
- `hooks/` — OpenClaw lifecycle hooks (prompt.ts, gate.ts, pain.ts, llm.ts, lifecycle.ts)
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

## ⚠️ MANDATORY: Read Error Pattern Index Before Tasks

**Before starting ANY coding task**, you MUST read `docs/process/error-management/ERROR_PATTERN_INDEX.md`. This compact index maps recurring error patterns to the detailed incidents in `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md`.

Then read the specific handbook entries referenced by the relevant pattern(s). Read `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` in full only when recording a new error, auditing the handbook itself, or when the compact index does not cover the task.

### Error Handbook Reading Protocol

**Default: Index-driven loading**
1. Read `docs/process/error-management/ERROR_PATTERN_INDEX.md` (compact, ~110 lines).
2. Match your task to 1-3 EP cards.
3. Read ONLY the detailed entries referenced by those cards (use `grep -n "ERR-XXX" docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` to locate).
4. State which ERR entries you considered and how you avoid them.

**Forbidden: Full-file loading**
Do NOT read `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` in full unless:
- You are recording a new error (record-error skill)
- You are auditing the handbook itself
- The INDEX does not cover your task AND you have confirmed with the user

**Why**: The handbook is 177KB (~44K tokens). Loading it fully consumes ~15% of your context window for marginal benefit — the INDEX already captures all patterns. Full loading degrades your performance on the actual task.

For work subject to the product-boundary gate above, read `docs/product/PRODUCT_IDENTITY.md` and reject work that expands PD into task execution, general memory, generic tool repair, or untriggered post-MVP learning infrastructure.

### Error Handbook Gate

> **See [AGENTS.md](AGENTS.md) > Error Handbook Gate**
>
> 实施前必读 `docs/process/error-management/ERROR_PATTERN_INDEX.md`,匹配 1-3 个 EP 卡片,读取对应 ERR 详细条目;
> 列出至少 3 条相关 ERR ID 并说明本 PR 如何避免每条;
> 修复 bug 时归类到已知 ERR class。

### Error Recording (MANDATORY)

> **See [AGENTS.md](AGENTS.md) > Error Recording (MANDATORY)**
>
> 任何代码评审发现真实问题(bug / 类型安全违规 / 架构违规 / 逻辑错误)必须立即触发 `record-error` skill。
> 流程: classify → number → Linear comment → tag `lesson-learned` → edit handbook → update stats → commit & PR。

## Critical Boundaries

These rules prevent architectural drift. Violating them will break the project.

### Core vs Plugin boundary
- **`packages/principles-core/`** — Pure logic only: no I/O, no filesystem, no database, no network.
  Functions here must be testable with zero mocks.
- **`packages/openclaw-plugin/`** — I/O boundary: filesystem, SQLite, OpenClaw hooks.
  Delegates computation to core; never reimplements logic that core already provides.
- **Rule:** New pure logic (data transforms, state machines, validation, type definitions) goes to `principles-core`.
  New I/O adapters (file readers, DB queries, hook handlers) go to `openclaw-plugin`.
- **FROZEN LEGACY (ADR-0005):** The deprecated god-classes (`nocturnal-trinity.ts`, `nocturnal-arbiter.ts`, `nocturnal-service.ts`) were deleted in PRI-230. Do NOT recreate them. All new internalization logic must go to the Runtime V2 Peer Runners in `@principles/core`.

### Architecture regression tests
- `packages/principles-core/tests/architecture-regression.test.ts` guards the core/plugin boundary.
- Any PR that modifies core exports, plugin imports, or CLI command registration **must** update this test.
- **Never skip or delete these tests.** If a test fails, fix the code, not the test.

### ADR compliance
- Architecture decisions are recorded in `docs/adr/` .
- Code that contradicts an ADR is a bug. Fix the code or update the ADR — never silently ignore.
- See `docs/.private/agents/domain.md` for the full workflow.

## Runtime Contract Rules

> **See [AGENTS.md](AGENTS.md) > Runtime Contract Rules** (`rc-1` to `rc-9`)
>
> 处理不可信数据（parsed JSON / LLM output / DB `diagnosticJson` / artifact metadata）的 9 条规则。
> 规则带稳定 ID（`rc-1-treat-as-unknown` 到 `rc-9-no-silent-fallback`），映射到 Error Experience Handbook。
> 代码评审必须检查每条适用规则；N/A 必须说明理由。

## CLI / Operator Command Gate

> **See [AGENTS.md](AGENTS.md) > CLI / Operator Command Gate** (`cli-1` to `cli-7`)
>
> 适用于 `packages/pd-cli/src/commands/**` 的 7 条规则，带稳定 ID（`cli-1-strict-json` 到 `cli-7-test-wiring`）。

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

> **See [AGENTS.md](AGENTS.md) > PR Pre-Review Gate**
>
> 6 个子段(Review convergence / Self-review loop / Fetch comments / Diff scope / Run tests / Final summary)的完整规则在 AGENTS.md。
> 关键约束:
> - 一次对抗式自检 → 一次广审 → 一次修复收敛(避免反复扩审)
> - 阻塞合并仅限 P0/P1 或违反 issue 验收标准的 P2
> - 多个 finding 共享根因时,Error Handbook 只更新一次
> - 评审输出使用中文

## Key Files

| File | Purpose |
|------|---------|
| `packages/openclaw-plugin/src/index.ts` | Plugin entry point — registers all hooks, commands, services |
| `packages/openclaw-plugin/openclaw.plugin.json` | Plugin manifest — defines routes, hooks, dependencies |
| `conductor/workflow.md` | AI agent orchestration workflow |
| `docs/architecture/ARCHITECTURE.md` | System design and component relationships |
| `MEMORY.md` | Project context and progress tracking |

## Related Documentation

- `docs/architecture/ARCHITECTURE.md` — Full system architecture
- `docs/process/DEVELOPMENT.md` — Local setup, build, test commands
- `docs/process/TESTING.md` — Test patterns and coverage requirements
- `packages/openclaw-plugin/SKILL.md` — AI agent skill definitions

## graphify

This project has a graphify knowledge graph at `.git/graphify/` (git hook auto-rebuilds on commit).

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

1. **On session start**: If answering architecture/codebase questions, check if `.git/graphify/graph.json` is recent (updated after last `git commit`). If stale, run `/graphify --update .` first.

2. **Before exploring new module**: Run `/graphify query "<module or concept>"` to see how it connects before diving into files.

3. **After completing significant code changes**: Run `/graphify --update .` to sync the graph (AST-only, free), or just commit — the git hook handles it.

4. **Graph is the map, files are the terrain**: Use the graph to navigate, use raw files for precision.

### Key files
- `.git/graphify/GRAPH_REPORT.md` — God nodes, surprising connections, suggested questions
- `.git/graphify/graph.json` — Full graph data
- `.git/graphify/graph.html` — Interactive browser visualization
- `.git/graphify/wiki/index.md` — Community-structured notes (if `--wiki` was used)

## Agent skills

### Issue tracker

Linear (`Principles_disciple` team, MCP tools `mcp__plugin_linear_linear__*`).
See `docs/.private/agents/issue-tracker.md`.

**MANDATORY LINEAR WORKFLOW:**
1. **Start**: Use `get_issue` to read the latest comments and updates BEFORE writing any code.
2. **Status**: Update the issue status to `In Progress` when you begin.
3. **Communicate**: Use `create_comment` to document your plan, blockers, or significant architectural choices directly on the issue.
4. **Finish**: Update the issue status to `In Review` or `Done` and leave a summary comment when the work is completed.

### Triage labels

5 canonical labels (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`).
See `docs/.private/agents/triage-labels.md`.

### Domain docs

Multi-context (`CONTEXT-MAP.md` at root → per-package `CONTEXT.md`).
See `docs/.private/agents/domain.md`.

## Private Docs Access (Symlink)

Private docs live in an independent git repo at `D:/Code/principles-private/` and are accessed transparently via the `docs/.private/` junction:
- `docs/.private/agents/issue-tracker.md` (issue tracker workflow)
- `docs/.private/agents/triage-labels.md` (triage labels)
- `docs/.private/agents/domain.md` (domain workflow)
- `docs/.private/product/emotional-value.md` (emotional value guideline)
- `docs/.private/exemplars/` (PR review exemplars)
- ... etc (see `docs/.private/README.md`)

**CRITICAL: Never run `git clean -fdx`, `git stash -a`, or `git checkout -f` in the main worktree** — these will destroy the junction and untrack private docs.

If `docs/.private/` is missing, run `.\scripts\setup-private-docs-symlink.ps1` to recreate.
