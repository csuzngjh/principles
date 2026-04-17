---
phase: 00a-interface-core
plan: "02"
subsystem: interface-core
tags: ["storage-adapter", "pain-signal", "validation", "typebox", "evolution-worker"]

# Dependency graph
requires:
  - phase: 00a-01
    provides: "StorageAdapter interface, PainSignal schema, validatePainSignal"
provides:
  - "FileStorageAdapter: file-backed StorageAdapter implementation with retry + backoff"
  - "PainSignal validation gate in evolution-worker doEnqueuePainTask"
  - "EvolutionQueueItem validation in processEvolutionQueue"
affects: ["evolution-worker", "queue-io", "evolution-types"]

# Tech tracking
tech-stack:
  added: []
  patterns: ["StorageAdapter implementation with withLockAsync + exponential backoff", "validatePainSignal gate before queue enqueue", "queue item field validation before cycle processing"]

key-files:
  created:
    - path: "packages/openclaw-plugin/src/core/file-storage-adapter.ts"
      provides: "FileStorageAdapter class implementing StorageAdapter"
    - path: "packages/openclaw-plugin/tests/core/file-storage-adapter.test.ts"
      provides: "9 tests covering load, save, mutate, async, atomicity, compatibility"
  modified:
    - path: "packages/openclaw-plugin/src/service/evolution-worker.ts"
      provides: "validatePainSignal integration in doEnqueuePainTask, queue item validation in processEvolutionQueue"

key-decisions:
  - "Direct atomicWriteFileSync inside withLockAsync lock to avoid deadlock with principle-tree-ledger's own locking"
  - "PainSignal validation runs before queue lock acquisition to fail fast on malformed signals"
  - "Queue item validation uses simple field checks (not TypeBox) for performance in the hot cycle path"
  - "Malformed queue items are logged+skipped, never crash the evolution cycle"

patterns-established:
  - "StorageAdapter implementation: lock -> read -> mutate -> atomic write with retry backoff"
  - "Pain signal validation gate: validatePainSignal before enqueue, log+skip on failure"
  - "Queue item validation: field presence checks before processing, filter malformed out"

requirements-completed: ["SDK-QUAL-01", "SDK-QUAL-03"]

# Metrics
duration: 7min
completed: "2026-04-17T00:29:36Z"
---

# Phase 00a Plan 02: Harden Core Evolution Components Summary

FileStorageAdapter with lock retry/backoff + PainSignal validation gate in evolution-worker pipeline

## Performance

- **Duration:** 7 min
- **Started:** 2026-04-17T00:22:36Z
- **Completed:** 2026-04-17T00:29:36Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- FileStorageAdapter wraps principle-tree-ledger with async StorageAdapter interface, 5 retries with exponential backoff for lock contention
- PainSignal validation via validatePainSignal in doEnqueuePainTask rejects malformed signals before they enter the queue
- EvolutionQueueItem validation in processEvolutionQueue filters items missing required fields (id, source, score, status, taskKind, retryCount, maxRetries)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create FileStorageAdapter** - `40a1e13c` (feat)
2. **Task 2: Integrate PainSignal validation into evolution-worker** - `3656643f` (feat)

## Files Created/Modified
- `packages/openclaw-plugin/src/core/file-storage-adapter.ts` - FileStorageAdapter implementing StorageAdapter with withLockAsync, retry, backoff, SystemLogger
- `packages/openclaw-plugin/tests/core/file-storage-adapter.test.ts` - 9 tests covering load, save, mutate, async, atomicity, cross-compat with low-level ledger
- `packages/openclaw-plugin/src/service/evolution-worker.ts` - validatePainSignal import + gate in doEnqueuePainTask, queue item validation in processEvolutionQueue

## Decisions Made
- **Direct write inside lock (not saveLedgerSync):** saveLedger/saveLedgerSync internally call mutateLedger which tries to acquire the same file lock, causing deadlock. FileStorageAdapter.mutateLedger writes directly via atomicWriteFileSync while holding the lock.
- **Validation before lock:** PainSignal validation runs before the queue lock is acquired, so malformed signals fail fast without holding any lock.
- **Simple field checks for queue items:** Queue item validation uses typeof checks rather than TypeBox schema for minimal overhead in the hot cycle path.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- serializeLedger is not exported from principle-tree-ledger.ts. Resolved by replicating the serialization logic (merge trainingStore + tree with TREE_NAMESPACE key) inside FileStorageAdapter.
- Pre-existing Windows EPERM test failure in evolution-worker.compilation-backfill.test.ts (temp dir cleanup) — confirmed on baseline, unrelated to this plan.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- FileStorageAdapter ready for use by higher-level modules as StorageAdapter implementation
- Pain signal validation gate active in production pain pipeline
- Queue item validation active in evolution cycle — malformed items no longer cause cycle crashes

---
*Phase: 00a-interface-core*
*Completed: 2026-04-17*

## Self-Check: PASSED

- [x] `packages/openclaw-plugin/src/core/file-storage-adapter.ts` exists
- [x] `packages/openclaw-plugin/tests/core/file-storage-adapter.test.ts` exists
- [x] `packages/openclaw-plugin/src/service/evolution-worker.ts` exists (modified)
- [x] `.planning/phases/00a-interface-core/00a-02-SUMMARY.md` exists
- [x] Commit `40a1e13c` found in git log
- [x] Commit `3656643f` found in git log
- [x] TypeScript compilation passes (tsc --noEmit clean)
- [x] 9/9 FileStorageAdapter tests passing
- [x] 254/254 service/queue tests passing (6 pre-existing Windows EPERM failures unrelated)
