# AGENTS.md — OpenAI Codex CLI Instructions

## Mandatory Pre-Task Reading

Before starting ANY coding task on this project, you MUST read `docs/ERROR_EXPERIENCE_HANDBOOK.md`. This file records real errors caught in code reviews. Reading it prevents you from repeating mistakes.

If a code review catches your error, record it in the handbook and tag the Linear issue with `lesson-learned`.

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

> **Why this matters**: Without the Handbook Gate, agents repeat the same error classes across sessions (ERR-001/ERR-005/ERR-007/ERR-009 all share the "as bypasses validation" pattern, and ERR-015/ERR-018/ERR-019 all share the "stale loop state" pattern). Explicitly naming ERR entries forces the agent to recognize the pattern group, not just the individual bug.

## Project Overview

**Principles Disciple** — evolutionary agent framework (Node.js/TypeScript monorepo, pnpm).

## Critical Rules

1. **Core vs Plugin boundary**: `packages/principles-core/` = pure logic only (no I/O, no fs, no DB, no network). `packages/openclaw-plugin/` = I/O boundary. New pure logic → core. New I/O → plugin.
2. **FROZEN LEGACY (ADR-0005)**: Do NOT modify `nocturnal-trinity.ts`, `nocturnal-arbiter.ts`, or `nocturnal-service.ts`.
3. **Architecture regression tests**: `packages/principles-core/tests/architecture-regression.test.ts` — never skip or delete.
4. **ADR compliance**: `docs/adr/` — code contradicting an ADR is a bug.
5. **No `any`**: Use `unknown` for truly unknown types. Strict TypeScript mode.
6. **No AI merge**: Never use `gh pr merge` or auto-merge PRs. User must merge manually.
7. **Conventional commits**: `feat()`, `fix()`, `docs()`, `refactor()`, `test()`, `chore()`.
8. **MANDATORY: Check PR comments first**: When asked to review/fix an existing PR, **FIRST** fetch and read **all PR comments/reviews** before doing ANY work. Retry at least 2 times if GitHub API fails. If no other way, ask user to copy-paste PR comments.

## Runtime Contract Rules

All code that handles untrusted data (parsed JSON, LLM output, DB `diagnosticJson`, artifact metadata) must follow these 9 rules. Each rule maps to real error patterns in the Error Experience Handbook.

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

**Enforcement**: Code review must check every rule that applies to the changed code. If a rule is N/A, state why.

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

## PR Pre-Review Gate

Before handing off a PR (pushing, creating PR, or reporting completion), execute this checklist:

**Fetch and resolve PR comments**
- `gh pr view <PR> --comments` and `gh pr review <PR> --comments`
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
- PR comments handled (count and resolution)
- Tests run (which commands, what results)
- Remaining risk (known issues, skipped coverage, trade-offs)

## Key Files

- `docs/ERROR_EXPERIENCE_HANDBOOK.md` — Error experience handbook (READ FIRST)
- `docs/ARCHITECTURE.md` — Full system architecture
- `docs/adr/` — Architecture Decision Records
- `CLAUDE.md` — Full project guidance (also applies to you)
