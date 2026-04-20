---
phase: "11"
plan: "02"
subsystem: pd-cli
tags:
  - cli
  - evolution-tasks
requires: []
provides: []
affects: []
tech-stack:
  added:
    - "pd evolution tasks show"
patterns: []
key-files:
  created:
    - "packages/pd-cli/src/commands/evolution-tasks-show.ts"
  modified:
    - "packages/pd-cli/src/index.ts"
key-decisions: []
requirements-completed:
  - CLI-FOUNDATION
duration: ~2 min
completed: "2026-04-20T10:06:00.000Z"
---

# Phase 11 Plan 02: Show Subcommand — Summary

## What Was Built

Implemented `pd evolution tasks show <id>` to display full task details.

## What

- Created `pd-cli/src/commands/evolution-tasks-show.ts`:
  - Calls `getEvolutionTask(workspaceDir, opts.id)` — accepts both numeric id and string taskId
  - Output: multi-line, one field per line with labels
  - All fields shown: id, taskId, traceId, source, reason, score, status, enqueuedAt, startedAt, completedAt, resolution, taskKind, priority, retryCount, maxRetries, lastError, resultRef, createdAt, updatedAt
  - Null fields printed as "null" (not omitted)
  - Task not found → `console.error()` + `process.exit(1)`
  - DB missing → graceful "No evolution tasks found."
- Registered `pd evolution tasks show <id>` in `index.ts` under `tasksCmd`

## Files

| File | Change |
|------|--------|
| `packages/pd-cli/src/commands/evolution-tasks-show.ts` | created |
| `packages/pd-cli/src/index.ts` | modified (added show subcommand) |

## Verification

- `pnpm tsc --noEmit` in pd-cli — PASS
- Commander argument `<id>` accepts string taskId or numeric id
- Exit code 1 when task not found

## Next

Phase complete — both `pd evolution tasks list` and `pd evolution tasks show` ready.
