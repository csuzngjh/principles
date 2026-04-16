---
phase: 46
plan: 03
subsystem: evolution-worker
tags: [god-class-split, queue-io, extraction]
dependency_graph:
  requires:
    - 46-01
    - 46-02
  provides:
    - SPLIT-03
    - SPLIT-04
  affects:
    - evolution-worker.ts
    - queue-io.ts
tech_stack:
  added:
    - queue-io.ts (standalone queue persistence module)
    - queue-io.test.ts (13 Vitest unit tests)
  patterns:
    - Extraction refactoring (god class split pattern)
    - Re-export facade for backward compatibility
    - RAII-style lock guard (withQueueLock)
key_files:
  created:
    - packages/openclaw-plugin/src/service/queue-io.ts
    - packages/openclaw-plugin/tests/service/queue-io.test.ts
  modified:
    - packages/openclaw-plugin/src/service/evolution-worker.ts
decisions: []
---

# Phase 46 Plan 03 Summary: Extract queue-io.ts

## Objective

Extract `queue-io.ts` from `evolution-worker.ts` — the full persistence layer encapsulating queue file locking, atomic writes, and queue format. Combines SPLIT-03 (file I/O extraction) and SPLIT-04 (withQueueLock RAII guard).

## What Was Built

### Artifacts

| Artifact | Lines | Description |
|----------|-------|-------------|
| `src/service/queue-io.ts` | 86 | Standalone queue I/O: `acquireQueueLock`, `withQueueLock`, `loadEvolutionQueue`, `saveEvolutionQueue` + constants |
| `tests/service/queue-io.test.ts` | 160 | 13 Vitest test cases |

### Symbols Extracted

| Symbol | Type | New Location |
|--------|------|--------------|
| `acquireQueueLock` | async function | queue-io.ts |
| `withQueueLock` | async function (RAII guard) | queue-io.ts |
| `loadEvolutionQueue` | sync function | queue-io.ts |
| `saveEvolutionQueue` | sync function | queue-io.ts |
| `EVOLUTION_QUEUE_LOCK_SUFFIX` | const | queue-io.ts |
| `LOCK_MAX_RETRIES` | const | queue-io.ts |
| `LOCK_RETRY_DELAY_MS` | const | queue-io.ts |
| `LOCK_STALE_MS` | const | queue-io.ts |

### Dependencies

- `acquireLockAsync`, `releaseLock` from `file-lock.ts`
- `atomicWriteFileSync` from `io.ts`
- `migrateQueueToV2` from `queue-migration.ts`
- `LockUnavailableError` from `errors.ts`

### Backward Compatibility

- `evolution-worker.ts` re-exports all queue-io symbols
- `requireQueueLock` kept inline (5-line wrapper that adds `LockUnavailableError`)
- All 6 Phase 45 queue tests pass (backward compatibility verified)
- All 13 new queue-io tests pass

## Deviations from Plan

None — plan executed as written.

## Pre-existing Issues (Not Fixed)

- `evolution-worker.ts:941-942`: `Property 'length' does not exist on type '{}'` — pre-existing `payload.failures` typing issue
- `evolution-worker.ts:539,545,551,573`: EvolutionQueueItem type incompatibility across module boundary — pre-existing from 46-01/46-02

## Commits

| Commit | Description |
|--------|-------------|
| `7b5808c8` | feat(46-03): extract queue-io.ts from evolution-worker.ts |
| `7424b55a` | test(46-03): add unit tests for queue-io.ts |
| `f693c3b0` | refactor(46-03): replace inline queue I/O with re-exports from queue-io.ts |

## Verification Results

```
npx tsc --noEmit --skipLibCheck: PASS (only pre-existing 941/942 + 539/545/551/573 type errors)
npx vitest run tests/service/queue-io.test.ts: 13 passed
npx vitest run tests/service/evolution-worker.queue.test.ts: 6 passed (backward compat)
```

## Self-Check

- [x] `queue-io.ts` exists with all required exports
- [x] `queue-io.test.ts` has 13 test cases and passes
- [x] `evolution-worker.ts` re-exports all queue-io symbols
- [x] Inline definitions removed from `evolution-worker.ts`
- [x] All 3 commits created
- [x] Phase 45 queue tests pass (backward compatibility)
- [x] `saveEvolutionQueue` replaces all 9 `atomicWriteFileSync(queuePath, ...)` calls

## Self-Check: PASSED
