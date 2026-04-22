---
phase: m2-task-run-state-core
plan: "03"
subsystem: database
tags: [sqlite, lease, retry, backoff, exponential-backoff, jitter]

# Dependency graph
requires:
  - phase: m2-task-run-state-core
    provides: >
      SqliteConnection (m2-01), TaskStore interface (m2-01),
      RunStore interface (m2-02), RunRecord schema (m2-02)
provides:
  - DefaultLeaseManager with atomic acquire/release/renew/expire
  - DefaultRetryPolicy with exponential backoff + jitter
affects:
  - m2-04 (TaskQueue / lease-based task selection)
  - m2-05 (Recovery sweep / expired lease detection)
  - m4-diagnostician-runner (uses LeaseManager + RetryPolicy)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - SQLite transaction-wrapped atomic operations
    - Exponential backoff with jitter
    - Lease owner verification before release/renew
    - Force-expire for crash recovery (no owner check)

key-files:
  created:
    - packages/principles-core/src/runtime-v2/store/lease-manager.ts
    - packages/principles-core/src/runtime-v2/store/retry-policy.ts
  modified:
    - packages/principles-core/src/runtime-v2/store/task-store.ts (stub)
    - packages/principles-core/src/runtime-v2/store/run-store.ts (stub)
    - packages/principles-core/src/runtime-v2/store/sqlite-connection.ts (stub)

key-decisions:
  - "Stub files created for task-store/run-store/sqlite-connection — replaced when m2-01/m2-02 run in their own worktree context"
  - "RetryPolicy markRetryWait/markFailed are passthrough (return error context) — caller applies state via TaskStore per D-09 architecture decision"

patterns-established:
  - "SQLite db.transaction() wrapping SELECT + conditional UPDATE for atomic lease acquisition"
  - "Owner verification check before lease release/renew using string comparison"
  - "Exponential backoff formula: cap(min(baseDelay * multiplier^(attempt-1), maxDelay), jitter)"

requirements-completed: [REQ-M2-Lease, REQ-M2-Retry]

# Metrics
duration: ~2.5min
completed: 2026-04-22
---

# Phase m2-03: Lease Lifecycle + Retry Policy Summary

**LeaseManager with atomic acquire/release/renew + RetryPolicy with exponential backoff and jitter**

## Performance

- **Duration:** ~2.5 min
- **Started:** 2026-04-22T04:19:25Z
- **Completed:** 2026-04-22T04:21:49Z
- **Tasks:** 2
- **Files created:** 6 (4 new + 2 modified stubs)

## Accomplishments

- DefaultLeaseManager with 5 operations: acquireLease (atomic with Run record creation), releaseLease (owner-verified), renewLease (owner+state-verified), isLeaseExpired (time comparison), forceExpire (recovery use)
- DefaultRetryPolicy with exponential backoff (base=30s, max=60s, multiplier=2) + jitter (20%)
- All methods throw PDRuntimeError with appropriate PDErrorCategory
- Stub files (task-store.ts, run-store.ts, sqlite-connection.ts) created as type placeholders

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement LeaseManager** - `8f47a93b` (feat)
2. **Task 2: Implement RetryPolicy** - `18f9e69d` (feat)

## Files Created/Modified

- `packages/principles-core/src/runtime-v2/store/lease-manager.ts` - LeaseManager interface + DefaultLeaseManager with atomic acquire/release/renew/expire
- `packages/principles-core/src/runtime-v2/store/retry-policy.ts` - RetryPolicy interface + DefaultRetryPolicy with exponential backoff + jitter
- `packages/principles-core/src/runtime-v2/store/task-store.ts` - Stub TaskStore interface (placeholder, replaced by m2-01)
- `packages/principles-core/src/runtime-v2/store/run-store.ts` - Stub RunStore interface + RunRecord (placeholder, replaced by m2-02)
- `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts` - Stub SqliteConnection (placeholder, replaced by m2-01)

## Decisions Made

- Stub files for task-store/run-store/sqlite-connection were created to satisfy TypeScript `import type` references. When m2-01 and m2-02 execute (in their own worktree context), these stubs are replaced with full implementations that include the actual SQLite logic.
- markRetryWait/markFailed on RetryPolicy return `{ taskId, errorCategory }` for the caller to apply via TaskStore — this keeps RetryPolicy focused on calculation logic only, consistent with D-09 architecture decision.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness

- LeaseManager and RetryPolicy are ready for m2-04 (TaskQueue) and m2-05 (Recovery sweep) to consume
- Stub files must be replaced when m2-01/m2-02 run in their own worktree context

---
*Phase: m2-task-run-state-core*
*Completed: 2026-04-22*
