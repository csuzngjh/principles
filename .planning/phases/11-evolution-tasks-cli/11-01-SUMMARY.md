---
phase: "11"
plan: "01"
subsystem: pd-cli
tags:
  - cli
  - evolution-tasks
requires: []
provides: []
affects: []
tech-stack:
  added:
    - "@principles/core/evolution-store"
    - "listEvolutionTasks()"
    - "getEvolutionTask()"
    - "pd evolution tasks list"
patterns: []
key-files:
  created:
    - "packages/principles-core/src/evolution-store.ts"
    - "packages/pd-cli/src/commands/evolution-tasks-list.ts"
  modified:
    - "packages/principles-core/package.json"
    - "packages/pd-cli/src/index.ts"
key-decisions: []
requirements-completed:
  - CLI-FOUNDATION
duration: ~3 min
completed: "2026-04-20T10:05:00.000Z"
---

# Phase 11 Plan 01: SDK + List Command — Summary

## What Was Built

Extracted `listEvolutionTasks()` and `getEvolutionTask()` into `@principles/core/evolution-store.ts` as pure SDK functions (mirrors Phase 10 `trajectory-store.ts` pattern), then wired `pd evolution tasks list` CLI command.

## What

- Created `@principles/core/evolution-store.ts` with:
  - `listEvolutionTasks(workspaceDir, filters)` — list with optional status/dateFrom/dateTo/limit/offset filters
  - `getEvolutionTask(workspaceDir, idOrTaskId)` — fetch single task by numeric id or string taskId
  - `TaskKind`, `TaskPriority`, `EvolutionTaskRecord`, `EvolutionTaskFilters` types (copied from trajectory-types.ts)
  - `getDbPath()` helper → `{workspaceDir}/.state/.trajectory.db`
  - Graceful fallback: returns `[]` or `null` if DB does not exist
- Created `pd-cli/src/commands/evolution-tasks-list.ts`:
  - Output format: `[{status}] {taskId} ({taskKind}) score={score} source={source} enqueued={enqueuedAt}`
  - Delegates to `resolveWorkspaceDir()`
- Added `evolution-store` export entry to `@principles/core/package.json`
- Registered `pd evolution tasks list` in `index.ts` with Commander

## Files

| File | Change |
|------|--------|
| `packages/principles-core/src/evolution-store.ts` | created |
| `packages/pd-cli/src/commands/evolution-tasks-list.ts` | created |
| `packages/principles-core/package.json` | modified (added export) |
| `packages/pd-cli/src/index.ts` | modified (added evolution→tasks→list) |

## Verification

- `pnpm tsc --noEmit` in principles-core — PASS
- `pnpm tsc --noEmit` in pd-cli — PASS
- Output format matches D-01: `[<status>] <taskId> (<taskKind>) score=<score> source=<source> enqueued=<enqueuedAt>`
- `getEvolutionTask` accepts both string taskId and numeric id

## Next

Ready for 11-02: `pd evolution tasks show <id>`
