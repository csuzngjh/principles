---
phase: 46
plan: 05
subsystem: evolution-worker
tags: [god-class-split, facade, verification]
dependency_graph:
  requires:
    - 46-01
    - 46-02
    - 46-03
    - 46-04
  provides:
    - SPLIT-06
  affects:
    - evolution-worker.ts
    - queue-migration.ts
    - workflow-watchdog.ts
    - queue-io.ts
    - sleep-cycle.ts
tech_stack:
  patterns:
    - Extraction refactoring (god class split pattern)
    - Re-export facade for backward compatibility
key_files:
  modified:
    - packages/openclaw-plugin/src/service/evolution-worker.ts (facade layer)
decisions: []
---

# Phase 46 Plan 05 Summary: Finalize evolution-worker.ts facade

## Objective

Finalize `evolution-worker.ts` as a pure facade/re-export layer (SPLIT-06). Verify all extracted symbols are properly re-exported, no new logic remains in the facade, and BUG-03 fix is preserved after the queue split.

## What Was Verified

### Facade Completeness

All symbols from extracted modules are re-exported from `evolution-worker.ts`:

| Module | Symbols Re-exported |
|--------|---------------------|
| queue-migration.ts | `migrateToV2`, `isLegacyQueueItem`, `migrateQueueToV2`, `LegacyEvolutionQueueItem`, `DEFAULT_TASK_KIND`, `DEFAULT_PRIORITY`, `DEFAULT_MAX_RETRIES`, `RawQueueItem` |
| workflow-watchdog.ts | `runWorkflowWatchdog`, `WatchdogResult` |
| queue-io.ts | `loadEvolutionQueue`, `saveEvolutionQueue`, `withQueueLock`, `acquireQueueLock`, `requireQueueLock`, `enqueueSleepReflectionTask`, `enqueueKeywordOptimizationTask`, `EVOLUTION_QUEUE_LOCK_SUFFIX`, `LOCK_MAX_RETRIES`, `LOCK_RETRY_DELAY_MS`, `LOCK_STALE_MS`, `RecentPainContext`, `createEvolutionTaskId`, `hasPendingTask`, `shouldSkipForDedup`, `readRecentPainContext` |
| sleep-cycle.ts | `runCycle`, `WorkerStatusReport` |

### BUG-03 Verification

BUG-03 (nocturnal snapshot validation for `pain_context_fallback` with zero stats) is present in `workflow-watchdog.ts` at lines 122-137:
- `dataSource === 'pain_context_fallback'` detection
- Zero-stats check: `stats.totalToolCalls === 0 && stats.totalGateBlocks === 0 && stats.failureCount === 0`
- Covered by 2 test cases in `workflow-watchdog.test.ts`

## Verification Results

```
npx tsc --noEmit --skipLibCheck: PASS (only pre-existing 659/660 errors)
npx vitest run tests/service/evolution-worker.queue.test.ts tests/core/queue-purge.test.ts tests/queue/async-lock.test.ts tests/service/workflow-watchdog.test.ts: 32 passed
```

## Pre-existing Issues

- `evolution-worker.ts:659-660`: `Property 'length' does not exist on type '{}'` — pre-existing `payload.failures` typing issue

## Commits

| Commit | Description |
|--------|-------------|
| `c9dae464` | feat(46-05): verify evolution-worker.ts facade completeness |

## Self-Check

- [x] `evolution-worker.ts` is a complete facade with all symbols re-exported
- [x] All TypeScript compilation passes (only pre-existing errors remain)
- [x] All 32 backward compatibility + BUG-03 tests pass
- [x] BUG-03 fix verified in `workflow-watchdog.ts`
- [x] SPLIT-06 requirement satisfied

## Self-Check: PASSED
