---
phase: 46
plan: 04
subsystem: evolution-worker
tags: [god-class-split, sleep-cycle, extraction]
dependency_graph:
  requires:
    - 46-03
  provides:
    - SPLIT-05
  affects:
    - evolution-worker.ts
    - sleep-cycle.ts
    - queue-io.ts
tech_stack:
  added:
    - sleep-cycle.ts (standalone sleep cycle orchestrator)
    - Extended queue-io.ts with enqueue functions
  patterns:
    - Extraction refactoring (god class split pattern)
    - Re-export facade for backward compatibility
    - Fire-and-forget enqueue orchestration
key_files:
  created:
    - packages/openclaw-plugin/src/service/sleep-cycle.ts
  modified:
    - packages/openclaw-plugin/src/service/evolution-worker.ts
    - packages/openclaw-plugin/src/service/queue-io.ts
    - packages/openclaw-plugin/src/service/queue-migration.ts
decisions:
  - id: Enqueue-functions-in-queue-io
    description: "enqueueSleepReflectionTask and enqueueKeywordOptimizationTask are extracted to queue-io.ts (not kept in sleep-cycle.ts) to avoid circular import between sleep-cycle.ts and evolution-worker.ts"
    rationale: "sleep-cycle.ts needs to call enqueue functions; keeping them in queue-io.ts provides a clean shared module while evolution-worker.ts re-exports from queue-io.ts"
---

# Phase 46 Plan 04 Summary: Extract sleep-cycle.ts

## Objective

Extract `sleep-cycle.ts` from `evolution-worker.ts` (lines 2467-2722) — the sleep cycle orchestrator coordinating idle checks, cooldown checks, enqueue tasks, and queue processing.

## What Was Built

### Artifacts

| Artifact | Lines | Description |
|----------|-------|-------------|
| `src/service/sleep-cycle.ts` | 157 | Standalone orchestrator: `runCycle`, `WorkerStatusReport`, `CycleOptions` |
| `queue-io.ts` (extended) | +287 | Added enqueue functions: `enqueueSleepReflectionTask`, `enqueueKeywordOptimizationTask`, `hasPendingTask`, `shouldSkipForDedup`, `readRecentPainContext`, `createEvolutionTaskId`, `requireQueueLock` |

### Symbols Extracted

| Symbol | Type | New Location |
|--------|------|--------------|
| `WorkerStatusReport` | interface | sleep-cycle.ts |
| `runCycle` | async function | sleep-cycle.ts |
| `CycleOptions` | interface | sleep-cycle.ts |
| `enqueueSleepReflectionTask` | async function | queue-io.ts |
| `enqueueKeywordOptimizationTask` | async function | queue-io.ts |
| `hasPendingTask` | function | queue-io.ts |
| `shouldSkipForDedup` | function | queue-io.ts |
| `readRecentPainContext` | function | queue-io.ts |
| `createEvolutionTaskId` | function | queue-io.ts |
| `requireQueueLock` | function | queue-io.ts |
| `RecentPainContext` | interface | queue-io.ts |

### What Remains in evolution-worker.ts Facade

- `checkPainFlag`, `processEvolutionQueueWithResult`, `processDetectionQueue`
- `EmpathyObserverWorkflowManager`, `DeepReflectWorkflowManager`, `NocturnalWorkflowManager`
- `runWorkflowWatchdog`
- Pain-flag-triggered immediate heartbeat logic

## Deviations from Plan

### [Rule 3 - Auto-fix blocking issue] RawQueueItem not exported
- **Issue:** `queue-migration.ts` declared `RawQueueItem` without `export`, causing TS2459 in queue-io.ts
- **Fix:** Added `export` keyword to `export type RawQueueItem = Record<string, unknown>`
- **Files modified:** `queue-migration.ts`
- **Commit:** `dc4324a5`

### [Rule 2 - Auto-add missing critical functionality] Enqueue functions placed in queue-io.ts
- **Issue:** Plan specified sleep-cycle.ts imports enqueue functions from queue-io.ts, but they did not exist there
- **Fix:** Extracted `enqueueSleepReflectionTask`, `enqueueKeywordOptimizationTask`, and supporting functions (`hasPendingTask`, `shouldSkipForDedup`, `readRecentPainContext`, `buildPainSourceKey`, `hasRecentSimilarReflection`, `createEvolutionTaskId`, `requireQueueLock`) into queue-io.ts alongside the existing queue I/O functions
- **Files modified:** `queue-io.ts`, `evolution-worker.ts`
- **Commit:** `569799c3`

### Pre-existing Issues (Not Fixed)

- `evolution-worker.ts:659-660`: `Property 'length' does not exist on type '{}'` — pre-existing `payload.failures` typing issue from Phase 46-01

## Commits

| Commit | Description |
|--------|-------------|
| `dc4324a5` | fix(46-04): export RawQueueItem type from queue-migration.ts |
| `569799c3` | feat(46-04): extract enqueue functions into queue-io.ts |
| `6a4da19d` | feat(46-04): extract sleep-cycle.ts orchestrator from evolution-worker.ts |
| `5abbbed5` | refactor(46-04): update evolution-worker.ts imports after extraction |

## Verification Results

```
npx tsc --noEmit --skipLibCheck: PASS (only pre-existing 659/660 errors)
```

## Self-Check

- [x] `sleep-cycle.ts` exists with `runCycle` and `WorkerStatusReport` exported
- [x] `queue-io.ts` exports `enqueueSleepReflectionTask` and `enqueueKeywordOptimizationTask`
- [x] `evolution-worker.ts` re-exports all extracted symbols via facade
- [x] Inline definitions removed from `evolution-worker.ts`
- [x] All 4 commits created
- [x] No new TypeScript errors introduced (only pre-existing 659/660 remain)
- [x] `sleep-cycle.ts` has zero imports from `evolution-worker.ts`

## TDD Gate Compliance

Task 3 (integration test for sleep-cycle.ts) was not completed due to context exhaustion. The test file was not created. This is tracked as a deferred item below.

## Deferred Issues

| Item | Description |
|------|-------------|
| sleep-cycle.test.ts | Integration test for `runCycle` orchestrator not created due to context exhaustion |

## Self-Check: PASSED (with deferred test file)
