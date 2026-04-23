---
phase: m4-05
plan: "01"
subsystem: TelemetryCLI
tags: [m4, telemetry, cli, diagnostician-runner]
dependency_graph:
  requires:
    - m4-03 (Validator schema)
    - m4-04 (RetryLeaseIntegration)
  provides:
    - REQ-2.7 (telemetry events)
    - REQ-2.8 (CLI surface)
  affects:
    - runtime-v2/runner/diagnostician-runner.ts
    - telemetry-event.ts
tech_stack:
  added:
    - 8 new TelemetryEventType literals (diagnostician_*)
    - emitDiagnosticianEvent() helper in DiagnosticianRunner
    - cli/diagnose.ts (run/status library functions)
  patterns:
    - Event emission at runner phase transitions
    - Thin CLI wrapper over existing infrastructure
key_files:
  created:
    - packages/principles-core/src/runtime-v2/cli/diagnose.ts
    - packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-telemetry.test.ts
    - packages/principles-core/src/runtime-v2/runner/__tests__/diagnose.test.ts
  modified:
    - packages/principles-core/src/telemetry-event.ts
    - packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts
    - packages/principles-core/src/runtime-v2/index.ts
decisions:
  - id: D-01
    description: "8 new diagnostician_ prefixed event types added to TelemetryEventType union"
  - id: D-02
    description: "CLI module exports library functions (run/status), no CLI framework dependency"
  - id: D-03
    description: "status() returns 5 key TaskRecord fields: taskId, status, attemptCount, maxAttempts, lastError"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-23T09:23:53Z"
---

# Phase m4-05 Plan 01: TelemetryCLI Summary

## One-liner

8 diagnostician telemetry events wired into DiagnosticianRunner phase transitions, plus thin CLI library functions (run/status) for external consumers.

## What was built

### Task 1: 8 diagnostician_ telemetry event types added to TelemetryEventType union

**Files modified:** `packages/principles-core/src/telemetry-event.ts`

- Added 8 new literal types to `TelemetryEventType` union:
  - `diagnostician_task_leased` - runner acquired lease on a task
  - `diagnostician_context_built` - context assembly completed
  - `diagnostician_run_started` - runtime invocation started
  - `diagnostician_run_failed` - runtime execution failed
  - `diagnostician_output_invalid` - output validation failed
  - `diagnostician_task_succeeded` - task marked succeeded
  - `diagnostician_task_retried` - task sent to retry_wait
  - `diagnostician_task_failed` - task permanently failed
- Updated header comment to reflect 21 total event types (3 core + 8 M2 + 1 M3 + 8 M4)
- TypeScript compilation passes

**Commit:** `903a2fb3`

### Task 2: 8 telemetry emit calls wired in DiagnosticianRunner + tests

**Files modified:** `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts`
**Files created:** `packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-telemetry.test.ts`

- Added `emitDiagnosticianEvent()` private helper method to DiagnosticianRunner
- Wire emit calls at 8 state transition points:
  1. After `acquireLease` succeeds - `diagnostician_task_leased`
  2. After `buildContext` succeeds - `diagnostician_context_built`
  3. Before `invokeRuntime` - `diagnostician_run_started`
  4. In `handleRuntimeFailure` - `diagnostician_run_failed`
  5. In `handleValidationError` - `diagnostician_output_invalid`
  6. In `succeedTask` - `diagnostician_task_succeeded`
  7. In `retryOrFail` (retry branch) - `diagnostician_task_retried`
  8. In `retryOrFail` (fail branch, 2 paths) - `diagnostician_task_failed`
- Created `diagnostician-telemetry.test.ts` with 5 test scenarios:
  - Happy path: 4 events emitted (leased, context_built, run_started, task_succeeded)
  - Runtime failure: 5 events (adds run_failed + task_retried)
  - Validation failure: 5 events (adds output_invalid + task_retried)
  - Max attempts exceeded: 5 events (task_failed with max_attempts_exceeded)
  - Permanent error: 2 events (task_failed with workspace_invalid)
- All 5 new tests pass; 11 existing runner tests pass without regression

**Commit:** `77504957`

### Task 3: CLI module (diagnose.ts) + status/run exports + tests

**Files created:** `packages/principles-core/src/runtime-v2/cli/diagnose.ts`, `packages/principles-core/src/runtime-v2/runner/__tests__/diagnose.test.ts`
**Files modified:** `packages/principles-core/src/runtime-v2/index.ts`

- Created `cli/diagnose.ts` exporting:
  - `run(options: DiagnoseRunOptions): Promise<RunnerResult>` - thin wrapper over DiagnosticianRunner.run()
  - `status(options: DiagnoseStatusOptions): Promise<DiagnoseStatusResult | null>` - returns 5 key TaskRecord fields per D-03
- Exported types: `DiagnoseRunOptions`, `DiagnoseStatusOptions`, `DiagnoseStatusResult`
- Added CLI exports to `runtime-v2/index.ts` under `// CLI surface (M4)` section
- Created `diagnose.test.ts` with 3 test scenarios:
  - run() delegates to runner.run() and returns RunnerResult
  - status() returns taskId, status, attemptCount, maxAttempts, lastError
  - status() returns null when task not found
- All 3 tests pass; TypeScript compilation passes (only pre-existing start-run-input.test.ts error)

**Commit:** `18630ce6`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test payload assertion accessed wrong field path**
- **Found during:** Task 2 test verification
- **Issue:** Test assertions for task_failed event tried to read `lastEvent.errorCategory` directly, but errorCategory is nested inside the `payload` object per TelemetryEventSchema
- **Fix:** Changed assertion to read `lastEvent.payload.errorCategory`
- **Files modified:** `diagnostician-telemetry.test.ts`
- **Commit:** `77504957`

**2. [Rule 1 - Bug] vi.fn<> generic syntax caused TypeScript errors in test files**
- **Found during:** Task 2 & 3 test TypeScript checking
- **Issue:** `vi.fn<[string], Promise<T>>()` syntax incompatible with project's TypeScript/vitest configuration (errors: "Expected 0-1 type arguments")
- **Fix:** Simplified to `vi.fn<() => Promise<T>>()` with explicit function signature
- **Files modified:** `diagnose.test.ts`, `diagnostician-telemetry.test.ts`
- **Commits:** `77504957`, `18630ce6`

**3. [Rule 3 - Blocking] diagnose.test.ts outside vitest include paths**
- **Found during:** Task 3 test execution
- **Issue:** vitest.config.ts only includes `src/runtime-v2/runner/**/*.test.ts` and `tests/**/*.test.ts`. Original test location `cli/__tests__/` was not covered.
- **Fix:** Moved test to `src/runtime-v2/runner/__tests__/diagnose.test.ts` and adjusted import paths
- **Files modified:** `diagnose.test.ts` (relocated from `cli/__tests__/`)
- **Commit:** `18630ce6`

## Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| TelemetryEventType has 21 members (13 + 8 M4) | PASS - `grep -c "diagnostician_" telemetry-event.ts` = 16 (8 in comments + 8 in code) |
| DiagnosticianRunner has 9 emitDiagnosticianEvent (1 def + 8 calls) | PASS - `grep -c "emitDiagnosticianEvent" diagnostician-runner.ts` = 10 |
| diagnostician-telemetry.test.ts has 5 passing tests | PASS - all 5 tests green via vitest |
| diagnose.test.ts has 3 passing tests | PASS - all 3 tests green via vitest |
| cli/diagnose.ts exports run() and status() | PASS |
| status() returns 5 fields (taskId, status, attemptCount, maxAttempts, lastError) | PASS |
| index.ts exports CLI module | PASS |
| TypeScript compilation (pre-existing errors excluded) | PASS |
| Existing runner tests pass without regression | PASS - 11/11 tests green |

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| N/A | - | No new trust boundary surface introduced. Events are in-process observation only. CLI callers provide taskId which runner validates via acquireLease. |

## Self-Check: PASSED

- Task 1 commit `903a2fb3` found in git log
- Task 2 commit `77504957` found in git log
- Task 3 commit `18630ce6` found in git log
- All 3 files exist: telemetry-event.ts, diagnostician-runner.ts, cli/diagnose.ts
- All 8 diagnostician_ types registered in telemetry-event.ts
- All 8 emit calls wired in diagnostician-runner.ts
- CLI exports present in index.ts
