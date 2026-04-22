---
phase: m2-task-run-state-core
plan: "04"
subsystem: database
tags: [lease, recovery, idempotent, telemetry, expired-lease]

# Dependency graph
requires:
  - phase: m2-task-run-state-core
    provides: >
      TaskStore with listTasks (m2-01 via stub expansion),
      LeaseManager with isLeaseExpired (m2-03),
      RetryPolicy with shouldRetry/calculateBackoff (m2-03),
      PDErrorCategorySchema with lease_expired (m2-04)
provides:
  - DefaultRecoverySweep with detectExpiredLeases/recoverTask/recoverAll
  - RecoveryResult interface
  - lease_expired PDErrorCategory
affects:
  - m2-05 (TaskQueue / scheduled recovery sweep integration)
  - m4-diagnostician-runner (uses RecoverySweep for stale task detection)

# Tech tracking
tech-stack:
  added:
    - RecoverySweep interface
    - RecoveryResult type
  patterns:
    - Idempotent recovery (wasLeaseExpired guard prevents double-recovery)
    - Sequential error collection (errors don't stop other recoveries)
    - JSON telemetry event emission for lease_recovered

key-files:
  created:
    - packages/principles-core/src/runtime-v2/store/recovery-sweep.ts
  modified:
    - packages/principles-core/src/runtime-v2/error-categories.ts (added lease_expired)
    - packages/principles-core/src/runtime-v2/store/task-store.ts (added listTasks filter)
    - packages/principles-core/src/runtime-v2/index.ts (new exports)

key-decisions:
  - "recoverTask is idempotent: returns null immediately if task not leased or not expired"
  - "emitTelemetryEvent uses console.log JSON structure (placeholder for real TelemetryEvent system)"
  - "listTasks added to TaskStore interface to support lease scanning"

requirements-completed: [REQ-M2-Recovery]

# Metrics
duration: ~3min
completed: 2026-04-22
---

# Phase m2-04: Recovery Sweep Summary

**Expired lease recovery with idempotent task transition and telemetry events**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-04-22T12:24:00Z
- **Completed:** 2026-04-22T12:27:00Z
- **Tasks:** 2
- **Files created:** 1 new, 3 modified

## Accomplishments

- DefaultRecoverySweep with 3 operations: detectExpiredLeases (scans leased tasks), recoverTask (idempotent single-task recovery), recoverAll (sequential recovery with error collection)
- recovery transitions: retry_wait (if attempts remain) or failed (if maxAttempts exceeded)
- Idempotent via wasLeaseExpired guard — safe to run multiple times
- lease_expired added to PDErrorCategorySchema
- listTasks filter added to TaskStore interface for lease scanning
- telemetry event emitted on every recovery

## Task Commits

Each task was committed atomically:

1. **Task 1+2 combined: RecoverySweep implementation + exports** - `43c249f9` (feat)

## Files Created/Modified

- `packages/principles-core/src/runtime-v2/store/recovery-sweep.ts` - RecoverySweep interface + DefaultRecoverySweep implementation
- `packages/principles-core/src/runtime-v2/error-categories.ts` - Added lease_expired to PDErrorCategorySchema
- `packages/principles-core/src/runtime-v2/store/task-store.ts` - Added listTasks filter to TaskStore interface
- `packages/principles-core/src/runtime-v2/index.ts` - New exports: TaskStore, TaskStoreFilter, DefaultLeaseManager, LeaseManager, AcquireLeaseOptions, DefaultRetryPolicy, RetryPolicy, RetryPolicyConfig, DefaultRecoverySweep, RecoverySweep, RecoveryResult

## Verification Results

| Check | Result |
|-------|--------|
| detectExpiredLeases queries status='leased' | PASS |
| wasLeaseExpired idempotent guard | PASS |
| shouldRetry decides retry_wait vs failed | PASS |
| lastError set to lease_expired or max_attempts_exceeded | PASS |
| recoverAll uses detectExpiredLeases | PASS |
| Errors collected without stopping recovery | PASS |
| Telemetry event emitted on every recovery | PASS |
| npx tsc --noEmit passes | PASS |

## Decisions Made

- Idempotent recovery: recoverTask returns null if the task's lease has already been cleared (wasLeaseExpired = false), so running recoverAll multiple times is safe
- emitTelemetryEvent uses console.log JSON placeholder — aligns with TelemetryEventSchema structure but defers to real TelemetryEvent system for production
- listTasks added to TaskStore interface even though m2-01 hasn't run yet (stub expansion) — enables m2-04 to compile and verify the pattern

## Deviations from Plan

1. **[Rule 2 - Auto-add missing critical functionality]**: Added `listTasks` to TaskStore interface — needed for detectExpiredLeases to scan leased tasks. Without this, RecoverySweep cannot function.

2. **[Rule 2 - Auto-add missing critical functionality]**: Added `lease_expired` to PDErrorCategorySchema — needed because recoverTask sets lastError to 'lease_expired', which must be a valid PDErrorCategory value.

## Issues Encountered

None.

## Next Phase Readiness

- RecoverySweep ready for m2-05 (TaskQueue) to integrate scheduled recovery sweep
- lease_expired error category ready for use by diagnostician-runner

---
*Phase: m2-task-run-state-core*
*Completed: 2026-04-22*