---
phase: m4-04
plan: "01"
status: complete
created: "2026-04-23"
---

# Plan m4-04-01: RetryLeaseIntegration — Complete

## Objective
Integration tests verifying DiagnosticianRunner correctly interacts with M2 LeaseManager, RetryPolicy, and RuntimeStateManager across retry/recovery scenarios.

## What was built
3 integration test files (9 test cases total) covering the retry/lease/recovery pipeline end-to-end with real in-memory SQLite stores.

### key-files.created
- `packages/principles-core/src/runtime-v2/runner/__tests__/retry-wait-recovery.integration.test.ts` — retry_wait → leased recovery, attemptCount increments, multi-cycle tracking
- `packages/principles-core/src/runtime-v2/runner/__tests__/max-attempts-exceeded.integration.test.ts` — max_attempts boundary, acquireLease rejection after failure, RetryPolicy integration
- `packages/principles-core/src/runtime-v2/runner/__tests__/lease-expiration-recovery.integration.test.ts` — forceExpire recovery, concurrent lease conflict, runner completion after recovery

## Must-Have Truths Verified

| Truth | Status |
|-------|--------|
| Runner can re-acquire task in retry_wait via acquireLease | ✅ retry-wait-recovery test 1 |
| attemptCount increments correctly on each lease | ✅ retry-wait-recovery tests 1+3 |
| Task fails with max_attempts_exceeded when shouldRetry=false | ✅ max-attempts-exceeded tests 1+2 |
| forceExpire allows another runner to acquire same task | ✅ lease-expiration-recovery test 1 |
| Only one runner holds a lease at any time | ✅ lease-expiration-recovery test 3 |

## Key Links Verified

| From | To | Via | Status |
|------|----|-----|--------|
| DiagnosticianRunner | RuntimeStateManager.acquireLease() | run() line 104 | ✅ |
| DiagnosticianRunner | RuntimeStateManager.markTaskRetryWait() | retryOrFail() | ✅ |
| RuntimeStateManager | DefaultRetryPolicy.shouldRetry() | retryPolicy.shouldRetry() | ✅ |

## Test Results
All 9 tests pass across 3 files. Full integration suite (19 tests) passes with no regressions.

## Deviations
None — all tests follow the existing pattern from diagnostician-runner.integration.test.ts.
