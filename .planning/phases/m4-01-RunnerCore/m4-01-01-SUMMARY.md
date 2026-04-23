---
phase: m4-01
plan: 01
subsystem: runner-core
tags: [types, interfaces, contracts, runtime-v2, runner]
dependency_graph:
  requires: [m1-foundation, m2-store, m3-context]
  provides: [RunnerPhase, RunnerResult, DiagnosticianRunnerOptions, DiagnosticianValidator, markTaskRetryWait, updateRunOutput]
  affects: [m4-01-02, m4-01-03]
tech_stack:
  added: [typescript-enum, readonly-interfaces, pass-through-validator-pattern]
  patterns: [discriminated-result-type, options-with-defaults, telemetry-emission]
key_files:
  created:
    - packages/principles-core/src/runtime-v2/runner/runner-phase.ts
    - packages/principles-core/src/runtime-v2/runner/runner-result.ts
    - packages/principles-core/src/runtime-v2/runner/diagnostician-runner-options.ts
    - packages/principles-core/src/runtime-v2/runner/diagnostician-validator.ts
  modified:
    - packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts
decisions:
  - RunnerPhase uses string-valued enum for debuggability and serialization
  - RunnerResult discriminated on status field (succeeded/failed/retried)
  - PassThroughValidator accepts all output as stub for m4-03 full implementation
  - markTaskRetryWait follows same task+run update + telemetry pattern as markTaskSucceeded/markTaskFailed
  - updateRunOutput writes JSON string directly to RunRecord.outputPayload per D-04
metrics:
  duration: 3m
  completed: "2026-04-23"
  tasks: 2
  files: 5
---

# Phase m4-01 Plan 01: Foundation Contracts Summary

Runner type contracts and RuntimeStateManager extensions for DiagnosticianRunner: RunnerPhase enum (9 phases), RunnerResult discriminated type, DiagnosticianRunnerOptions with defaults, DiagnosticianValidator interface with PassThroughValidator stub, and two new RuntimeStateManager methods (markTaskRetryWait, updateRunOutput).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create runner type contracts | 62c15768 | runner/runner-phase.ts, runner/runner-result.ts, runner/diagnostician-runner-options.ts, runner/diagnostician-validator.ts |
| 2 | Extend RuntimeStateManager | a6cfc4d2 | store/runtime-state-manager.ts |

## Key Decisions

1. **RunnerPhase as string enum** -- Each value is a descriptive string (e.g., `'building_context'`) rather than numeric, enabling debuggability in logs and telemetry without lookup tables.
2. **RunnerResult discrimination on status** -- The `status` field (succeeded/failed/retried) is the discriminant; optional fields are documented as set-only-when-relevant rather than using a union type, keeping the interface simpler for consumers.
3. **PassThroughValidator as m4-03 stub** -- Accepts all output unconditionally; the `validate` method signature matches what m4-03 will implement with full schema + semantic validation.
4. **markTaskRetryWait pattern alignment** -- Follows the exact same structure as markTaskSucceeded/markTaskFailed: update task status, clear lease fields, update latest run, emit telemetry. Ensures consistency for downstream consumers.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Lint compliance for PassThroughValidator.validate**
- **Found during:** Task 1 commit (pre-commit hook)
- **Issue:** `@typescript-eslint/class-methods-use-this` and `@typescript-eslint/no-unused-vars` errors on the `validate` method parameters
- **Fix:** Prefixed `output` parameter with underscore (`_output`) and added eslint-disable comment for class-methods-use-this rule
- **Files modified:** runner/diagnostician-validator.ts
- **Commit:** 62c15768

None other -- plan executed as written.

## Verification

- TypeScript compilation: PASS (`npx tsc --noEmit` clean)
- RunnerPhase: 9 enum values verified
- RunnerResult: RunnerResultStatus type + RunnerResult interface exported
- DiagnosticianRunnerOptions: interface + resolved type + defaults + resolver function exported
- DiagnosticianValidator: interface + PassThroughValidator class exported
- RuntimeStateManager: markTaskRetryWait and updateRunOutput methods added
- Lint: PASS (lefthook pre-commit hook clean)

## Known Stubs

| Stub | File | Description | Resolved By |
|------|------|-------------|-------------|
| PassThroughValidator | runner/diagnostician-validator.ts | Accepts all output without validation | m4-01-03 (full validation) |

## Self-Check: PASSED

All 6 files verified present. Both commits (62c15768, a6cfc4d2) found in git log.
