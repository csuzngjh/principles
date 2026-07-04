# GEMINI.md — Gemini CLI Instructions

## Mandatory Pre-Task Reading

Before starting ANY coding task on this project, you MUST read `docs/process/error-management/ERROR_PATTERN_INDEX.md`. This compact index maps recurring error patterns to the detailed incidents in `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md`.

Then read the specific handbook entries referenced by the relevant pattern(s). Read `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` in full only when recording a new error, auditing the handbook itself, or when the compact index does not cover the task.

If a code review catches your error, record it in the handbook and tag the Linear issue with `lesson-learned`.

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

## Project Overview

**Principles Disciple** — evolutionary agent framework (Node.js/TypeScript monorepo, npm).

## Critical Rules

1. **Core vs Plugin boundary**: `packages/principles-core/` = pure logic only (no I/O, no fs, no DB, no network). `packages/openclaw-plugin/` = I/O boundary. New pure logic → core. New I/O → plugin.
2. **FROZEN LEGACY (ADR-0005)**: The deprecated god-classes (`nocturnal-trinity.ts`, `nocturnal-arbiter.ts`, `nocturnal-service.ts`) were deleted in PRI-230. Do NOT recreate them.
3. **Architecture regression tests**: `packages/principles-core/tests/architecture-regression.test.ts` — never skip or delete.
4. **ADR compliance**: `docs/adr/` — code contradicting an ADR is a bug.
5. **No `any`**: Use `unknown` for truly unknown types. Strict TypeScript mode.
6. **No AI merge**: Never auto-merge PRs. User must merge manually.
7. **Conventional commits**: `feat()`, `fix()`, `docs()`, `refactor()`, `test()`, `chore()`.

## Build & Test

```bash
cd packages/principles-core && npm run build && npm run test
cd packages/openclaw-plugin && npm run build && npm run test
npm run lint
```

## Linear Workflow

1. Read the issue (including comments) BEFORE writing code
2. Update status to In Progress when you begin
3. Comment your plan on the issue
4. Update status to In Review when done
5. Leave a summary comment

## Error Recording (MANDATORY)

**Rule: Any code review that discovers a real issue (bug, type safety violation, architecture violation, logic error) MUST invoke the `record-error` skill before closing the review.**

This applies to:
- PR reviews (pr-review skill Phase 6.5)
- Self-review after completing a task
- Any review where you find an error you (or another AI) made

The `record-error` skill handles: classify → number → Linear comment → tag `lesson-learned` → edit handbook → update stats → commit & PR.

**Do NOT skip this step.** Reasons like "the fix was trivial", "I'm tired", or "I'll do it later" are not acceptable. Without recording, the same class of error will recur across sessions. The Error Experience Handbook is the project's institutional memory.

## Key Files

- `docs/process/error-management/ERROR_PATTERN_INDEX.md` — Compact error pattern index (READ FIRST)
- `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` — Detailed error incident log (read entries on demand via INDEX)
- `docs/architecture/ARCHITECTURE.md` — Full system architecture
- `docs/adr/` — Architecture Decision Records
- `CLAUDE.md` — Full project guidance (also applies to you)

## Private Docs Access (Symlink)

Private docs live in an independent git repo (example path: `D:/Code/principles-private/` — adjust per your environment) and are accessed transparently via the `docs/.private/` junction:
- `docs/.private/agents/issue-tracker.md` (issue tracker workflow)
- `docs/.private/agents/triage-labels.md` (triage labels)
- `docs/.private/agents/domain.md` (domain workflow)
- `docs/.private/product/emotional-value.md` (emotional value guideline)
- `docs/.private/exemplars/` (PR review exemplars)
- ... etc (see `docs/.private/README.md`)

**CRITICAL: Never run `git clean -fdx`, `git stash -a`, or `git checkout -f` in the main worktree** — these will destroy the junction and untrack private docs.

If `docs/.private/` is missing, run `node scripts/setup-private-docs-symlink.mjs` to recreate.
