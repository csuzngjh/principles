---
phase: m4-01
plan: 03
subsystem: runner-core
tags: [integration-test, real-sqlite, tdd, runner, runtime-v2]

# Dependency graph
requires:
  - phase: m4-01-01
    provides: RunnerPhase, RunnerResult, DiagnosticianRunnerOptions, DiagnosticianValidator
  - phase: m4-01-02
    provides: DiagnosticianRunner class with full lifecycle
  - phase: m2-store
    provides: RuntimeStateManager, SqliteConnection, stores
  - phase: m3-context
    provides: SqliteContextAssembler, SqliteHistoryQuery
provides:
  - Integration test for full DiagnosticianRunner pipeline with real SQLite stores
  - Runner type exports from runtime-v2/index.ts
  - resolveStoreRunId() method in DiagnosticianRunner
affects: [m4-02, m4-03, m4-04]

# Tech tracking
tech-stack:
  added: []
  patterns: [real-sqlite-integration-test, stub-runtime-adapter, diagnostic-json-serialization]

key-files:
  created:
    - packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-runner.integration.test.ts
  modified:
    - packages/principles-core/src/runtime-v2/index.ts
    - packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts
    - packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-runner.test.ts

key-decisions:
  - "resolveStoreRunId separates store runId from adapter RunHandle.runId"
  - "Integration tests use diagnostic_json column for diagnostician-specific fields"

patterns-established:
  - "Integration test pattern: real RuntimeStateManager + SqliteContextAssembler, only mock PDRuntimeAdapter"
  - "StubRuntimeAdapter with configurable output/status for integration tests"

requirements-completed: [M4-REQ-2.1, M4-REQ-2.2, M4-REQ-2.4, M4-REQ-2.6]

# Metrics
duration: 15m
completed: "2026-04-23"
---

# Phase m4-01 Plan 03: Integration Tests + Runner Exports Summary

Integration tests proving DiagnosticianRunner works end-to-end with real SQLite stores (not mocked store layer), exposing a store runId mismatch bug that required adding resolveStoreRunId() to bridge acquireLease's store-side runId with the adapter's RunHandle.runId.

## Performance

- **Duration:** 15 min
- **Started:** 2026-04-23T04:43:15Z
- **Completed:** 2026-04-23T04:58:00Z
- **Tasks:** 1 (TDD with RED/GREEN phases)
- **Files modified:** 4

## Accomplishments
- 4 integration test scenarios passing with real SQLite: happy path, run history context, openclaw-history compatibility (REQ-2.6), validation failure retry_wait
- All runner types exported from runtime-v2/index.ts
- Discovered and fixed store runId mismatch bug in DiagnosticianRunner

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED (failing tests) | 5d64d8e0 | PASS -- 3 integration tests fail (store runId not found) |
| GREEN (all tests pass) | 679aa81c | PASS -- all 15 runner tests pass (11 unit + 4 integration) |
| REFACTOR | N/A | No structural changes needed after GREEN |

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Integration tests + index.ts exports** - `5d64d8e0` (test)
2. **Task 1 GREEN: Fix store runId mismatch** - `679aa81c` (fix)

## Files Created/Modified
- `src/runtime-v2/runner/__tests__/diagnostician-runner.integration.test.ts` - 4 integration test scenarios with StubRuntimeAdapter and FailingValidator, using real RuntimeStateManager
- `src/runtime-v2/index.ts` - Added runner type exports (DiagnosticianRunner, RunnerPhase, PassThroughValidator, resolveRunnerOptions, DEFAULT_RUNNER_OPTIONS, + type exports)
- `src/runtime-v2/runner/diagnostician-runner.ts` - Added resolveStoreRunId() method to look up store's runId after acquireLease
- `src/runtime-v2/runner/__tests__/diagnostician-runner.test.ts` - Added getRunsByTask mock to unit test MockStateful interface

## Decisions Made
1. **resolveStoreRunId separates store vs adapter runIds** -- acquireLease creates a run record with a deterministic ID (`run_{taskId}_{attempt}`), while the adapter's startRun returns its own RunHandle.runId. The runner needs the store's ID for updateRunOutput and markTaskSucceeded operations. Rather than changing the adapter interface, a simple lookup after lease acquisition resolves the mapping.
2. **diagnostic_json column for diagnostician-specific fields** -- Integration tests serialize workspaceDir, reasonSummary, etc. into the diagnostic_json column, matching how SqliteContextAssembler.reconstructDiagnosticianRecord() reads them back.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Store runId mismatch in DiagnosticianRunner.succeedTask**
- **Found during:** GREEN phase -- integration tests failed with "Run not found: stub-run-..."
- **Issue:** succeedTask used adapter's RunHandle.runId to call stateManager.updateRunOutput(), but the actual run in the store was created by acquireLease with a different deterministic ID
- **Fix:** Added resolveStoreRunId() method that looks up the latest run for the task from the store after acquireLease. The runner now uses the store's runId for all store operations (updateRunOutput, succeedTask resultRef)
- **Files modified:** runner/diagnostician-runner.ts, runner/__tests__/diagnostician-runner.test.ts
- **Commit:** 679aa81c

**2. [Rule 3 - Blocking] Unit test mock missing getRunsByTask**
- **Found during:** GREEN phase -- unit tests failed after adding resolveStoreRunId()
- **Issue:** MockStateful interface and mock factory didn't include getRunsByTask, causing "not a function" errors
- **Fix:** Added getRunsByTask to MockStateful interface and mock factory returning a default run record
- **Files modified:** runner/__tests__/diagnostician-runner.test.ts
- **Commit:** 679aa81c

**3. [Rule 3 - Blocking] Lint compliance for integration test file**
- **Found during:** RED phase commit (pre-commit hook)
- **Issue:** max-params (4 > 3), class-methods-use-this (4 methods), unused var (input), init-declarations (6 vars), no-non-null-assertion (6 sites)
- **Fix:** Collapsed makeDiagnosticianTaskInput to single options parameter, added eslint-disable sections for StubRuntimeAdapter class methods, prefixed unused param with underscore, initialized describe-scope variables with dummy values, added eslint-disable-next-line for non-null assertions after explicit null checks
- **Files modified:** runner/__tests__/diagnostician-runner.integration.test.ts
- **Commit:** 5d64d8e0

---

**Total deviations:** 3 auto-fixed (1 bug, 2 blocking)
**Impact on plan:** Bug fix was critical -- runner could not work with real stores without it. All auto-fixes necessary for correctness and lint compliance. No scope creep.

## Issues Encountered
- None beyond the deviations documented above

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Full runner pipeline verified with real stores
- Runner types exported and consumable from runtime-v2/index.ts
- Ready for m4-02 (TestDoubleRuntimeAdapter) and m4-03 (full validation)

## Self-Check: PASSED

- [x] `packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-runner.integration.test.ts` exists
- [x] `packages/principles-core/src/runtime-v2/index.ts` exists with runner exports
- [x] `.planning/phases/m4-01-RunnerCore/m4-01-03-SUMMARY.md` exists
- [x] Commit 5d64d8e0 (RED) found in git log
- [x] Commit 679aa81c (GREEN) found in git log

---
*Phase: m4-01-RunnerCore*
*Completed: 2026-04-23*
