---
phase: "43"
plan: "02"
subsystem: Type-Safety
tags: [typescript, type-safety, refactor, openclaw-plugin]
dependency_graph:
  requires:
    - "43-01"
  provides: []
  affects:
    - "packages/openclaw-plugin/src/hooks/prompt.ts"
    - "packages/openclaw-plugin/src/tools/deep-reflect.ts"
    - "packages/openclaw-plugin/src/hooks/subagent.ts"
    - "packages/openclaw-plugin/src/commands/promote-impl.ts"
    - "packages/openclaw-plugin/src/commands/rollback.ts"
    - "packages/openclaw-plugin/src/commands/pain.ts"
    - "packages/openclaw-plugin/src/hooks/message-sanitize.ts"
    - "packages/openclaw-plugin/src/service/subagent-workflow/runtime-direct-driver.ts"
tech_stack:
  added:
    - TypeScript type assertion function (toWorkflowSubagent)
    - Type predicate functions (isCandidateOrDisabled, isAssistantMessageWithContent)
    - Extended interface (SessionAwareCommandContext)
  patterns:
    - Type assertion via `as unknown as T` for cross-namespace type compatibility
    - Type predicate narrowing for runtime-augmented object properties
    - Interface extension for framework-injected properties
key_files:
  created: []
  modified:
    - "packages/openclaw-plugin/src/hooks/prompt.ts"
    - "packages/openclaw-plugin/src/tools/deep-reflect.ts"
    - "packages/openclaw-plugin/src/hooks/subagent.ts"
    - "packages/openclaw-plugin/src/commands/promote-impl.ts"
    - "packages/openclaw-plugin/src/commands/rollback.ts"
    - "packages/openclaw-plugin/src/commands/pain.ts"
    - "packages/openclaw-plugin/src/hooks/message-sanitize.ts"
    - "packages/openclaw-plugin/src/service/subagent-workflow/runtime-direct-driver.ts"
decisions: []
metrics:
  duration: "~5 minutes"
  completed: "2026-04-15"
  tasks_completed: 5
---

# Phase 43 Plan 02: Type-Safety Cast Removal Summary

Replace 7 `as any`/`as unknown` casts across 7 files with proper TypeScript types. TypeScript compilation passes cleanly after all changes.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Fix subagent casts in prompt.ts and deep-reflect.ts (TYPE-03) | `c4de1bf5` | prompt.ts, deep-reflect.ts, runtime-direct-driver.ts |
| 2 | Fix PluginLogger cast in subagent.ts (TYPE-04) | `921480e4` | subagent.ts |
| 3 | Fix lifecycleState casts in promote-impl.ts (TYPE-05) | `fbf8c653` | promote-impl.ts |
| 4 | Fix sessionId casts in rollback.ts and pain.ts (TYPE-05) | `63debcd3` | rollback.ts, pain.ts |
| 5 | Fix content casts in message-sanitize.ts (TYPE-05) | `8d72aeee` | message-sanitize.ts |

## What Was Changed

### Task 1: subagent casts (TYPE-03)

- **prompt.ts**: Added `toWorkflowSubagent()` type assertion function that converts `NonNullable<OpenClawPluginApi['runtime']>['subagent']` to `PluginRuntimeSubagent` via `as unknown as PluginRuntimeSubagent`. Replaced two cast sites at lines 594 and 630.
- **deep-reflect.ts**: Added identical `toWorkflowSubagent()` function. Replaced cast at line 169.
- **runtime-direct-driver.ts**: Exported `PluginRuntimeSubagent` type alias (was local-only, not reachable for import). This was a deviation from the plan which assumed the type was already exported.

### Task 2: PluginLogger cast (TYPE-04)

- **subagent.ts**: Removed `as unknown as PluginLogger` cast from `loggerAdapter` object. The explicit `PluginLogger` type annotation is sufficient since the object shape already matches.

### Task 3: lifecycleState casts (TYPE-05)

- **promote-impl.ts**: Added `isCandidateOrDisabled` type predicate that narrows `Implementation` to `Implementation & { lifecycleState: ImplementationLifecycleState }`. Replaced filter callback at line 48 with `isCandidateOrDisabled`. Replaced `currentState` assignment at line 145 with direct property access. Removed eslint-disable comments.

### Task 4: sessionId casts (TYPE-05)

- **rollback.ts** and **pain.ts**: Added `SessionAwareCommandContext` interface that extends `PluginCommandContext` with `sessionId: string`. Replaced `ctx as any` cast with `ctx as SessionAwareCommandContext`. Removed eslint-disable comments.

### Task 5: content casts (TYPE-05)

- **message-sanitize.ts**: Added `isAssistantMessageWithContent` type predicate that narrows `unknown` to `{ role: 'assistant'; content: string }`. Replaced string content branch (lines 26-31) and array content branch (lines 35-43). Removed eslint-disable comments.

## Verification

- `pnpm exec tsc --noEmit` passes with zero errors in openclaw-plugin
- All targeted `as any` casts removed from active code paths
- No new `as any` casts introduced

## Deviations from Plan

**1. [Rule 2 - Auto-add missing critical functionality] PluginRuntimeSubagent not exported**

- **Found during:** Task 1 (type check phase)
- **Issue:** `PluginRuntimeSubagent` was declared as a local type alias in `runtime-direct-driver.ts` (line 59) but was not exported. The plan assumed it was already exported from the module.
- **Fix:** Exported the type by changing `type PluginRuntimeSubagent = {` to `export type PluginRuntimeSubagent = {`
- **Files modified:** `packages/openclaw-plugin/src/service/subagent-workflow/runtime-direct-driver.ts`
- **Commit:** `c4de1bf5`

## TDD Gate Compliance

This plan does not use TDD (`type: execute`), so TDD gate commits are not applicable.

## Self-Check

- [x] All 5 tasks executed and committed individually
- [x] TypeScript compilation passes cleanly
- [x] All targeted casts removed from active code
- [x] eslint-disable comments removed from replaced cast locations
- [x] Deviation documented (PluginRuntimeSubagent export)

## Self-Check: PASSED
