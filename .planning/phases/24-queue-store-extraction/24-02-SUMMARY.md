---
phase: 24-queue-store-extraction
plan: 02
status: complete
started: 2026-04-11
completed: 2026-04-11
---

# Plan 02: Wire Worker to EvolutionQueueStore — Summary

## Objective
Wire `evolution-worker.ts` and `pd-reflect.ts` to use `EvolutionQueueStore`, removing inline queue I/O and external lock acquisition. Complete the extraction from Plan 01.

## What Was Built

### `pd-reflect.ts` Migration (71 lines)
- Removed `acquireQueueLock` and `EVOLUTION_QUEUE_LOCK_SUFFIX` imports
- Now uses `EvolutionQueueStore(workspaceDir)` + `store.load()` + `store.add()`
- Queue path resolved via `resolvePdPath` internally in store

### `evolution-worker.ts` Modifications

**`registerEvolutionTaskSession`** (L1454-1469):
- Restored `workspaceResolve: (key: string) => string` parameter (required for test backward compat)
- Added `queuePathOverride` to `EvolutionQueueStore` constructor so the store reads/writes the actual path from `workspaceResolve`
- Derives `workspaceDir` via `path.dirname(path.dirname(queuePath))`

**`processEvolutionQueue`** (L567+):
- Uses `store.load()` for queue retrieval
- Stuck recovery (sleep_reflection timeout) modifies queue and sets `queueChanged = true`
- Added fallback save: `if (queueChanged) { await store.save(queue); }` after sleep task block
- This ensures queue changes are persisted even when there are no sleep tasks to process

**`processEvolutionQueueWithResult`** (L1505):
- Uses `store.load()` + `store.purge()` + `store.save()` instead of direct file I/O
- Re-loads queue after `processEvolutionQueue()` to get accurate final counts

### `EvolutionQueueStore` Constructor Enhancement
- Added optional `queuePathOverride?: string` parameter
- When provided, uses this path instead of computing via `resolvePdPath(workspaceDir, 'EVOLUTION_QUEUE')`
- This supports test mocks where `workspaceResolve` returns a custom path

### Test Results
```
evolution-worker.test.ts:               19 passed (was 15 passed, 4 failed)
evolution-queue-store.test.ts:         32 passed
evolution-worker.nocturnal.test.ts:      7 passed
Total:                                  58 passed
```

## Key Decisions

1. **`queuePathOverride` for backward compat**: The `registerEvolutionTaskSession` test passes a mock `workspaceResolve` that returns a path outside the `.state/` hierarchy. Using `queuePathOverride` lets the store use the exact path the caller expects.

2. **Fallback save for `queueChanged`**: The original code only saved when there were sleep tasks to process. But stuck recovery and pain_diagnosis changes happen before the sleep task block. Added a save after the sleep block to catch all cases.

## Requirements Addressed
- DECOMP-01: All queue I/O delegated to EvolutionQueueStore
- CONTRACT-06: Lock management centralized in store (no external lock calls for queue operations)

## Self-Check: PASSED
- All 58 queue-related tests pass
- TypeScript compilation clean (`tsc --noEmit`)
- `pd-reflect.ts` has no `acquireQueueLock` import
- `evolution-worker.ts` imports `EvolutionQueueStore`

## Deviations from Plan
- The Plan 02 code used `store.load()` inside `processEvolutionQueue` rather than the complex `withLock()` + direct file I/O pattern described in the plan. This works correctly because `store.load()` is auto-locking.
- Stuck recovery and queueChanged save issues were discovered during test execution and fixed directly.

## Remaining Work
- Full test suite regression gate (pre-existing failures in unrelated tests)
- Phase verification
