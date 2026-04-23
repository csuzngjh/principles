---
phase: m4-01
plan: 02
subsystem: runner-core
tags: [runner, lifecycle, tdd, runtime-v2, diagnostician]
dependency_graph:
  requires: [m4-01-01, m1-foundation, m2-store, m3-context]
  provides: [DiagnosticianRunner, DiagnosticianRunnerDeps]
  affects: [m4-01-03, m4-02, m4-04]
tech_stack:
  added: [deps-object-di-pattern, context-object-parameter-pattern]
  patterns: [phase-based-step-pipeline, polling-loop-with-timeout, error-classification-transient-vs-permanent]
key_files:
  created:
    - packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts
    - packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-runner.test.ts
  modified:
    - packages/principles-core/vitest.config.ts
decisions:
  - DiagnosticianRunnerDeps object pattern for constructor to satisfy max-params lint rule
  - Context objects (FailureContext, SucceedContext, ValidationErrorContext) for multi-param methods
  - handleLeaseOrPhaseError creates synthetic TaskRecord when acquireLease fails before returning one
  - All 11 test scenarios use vi.fn() mock objects cast via unknown to satisfy TypeScript strict checks
metrics:
  duration: 12m
  completed: "2026-04-23"
  tasks: 1
  files: 3
---

# Phase m4-01 Plan 02: DiagnosticianRunner Lifecycle Summary

DiagnosticianRunner class with phase-based step pipeline (lease -> context -> invoke -> poll -> output -> validate -> succeed/fail), dependency injection via DiagnosticianRunnerDeps, and 11 unit tests covering happy path, polling, timeout, runtime failure, context build failures, validation, StartRunInput construction, lease conflict, max attempts, and openclaw-history compatibility.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | TDD: DiagnosticianRunner with full lifecycle | 6e3aec10 (RED), 7dd3d5e7 (GREEN) | runner/diagnostician-runner.ts, runner/__tests__/diagnostician-runner.test.ts, vitest.config.ts |

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED (failing tests) | 6e3aec10 | PASS -- tests fail because DiagnosticianRunner class does not exist |
| GREEN (all tests pass) | 7dd3d5e7 | PASS -- all 11 tests pass |
| REFACTOR | N/A | No structural changes needed after GREEN |

## Key Decisions

1. **DiagnosticianRunnerDeps object pattern** -- Constructor takes a single deps object plus options object, keeping the parameter count at 2 instead of 6 to satisfy `max-params` lint rule. This also makes dependency injection more explicit and extensible.
2. **Context objects for multi-param methods** -- `succeedTask`, `handleValidationError`, and `retryOrFail` use typed context objects (SucceedContext, ValidationErrorContext, FailureContext) instead of positional parameters, satisfying `max-params` rule while maintaining readability.
3. **handleLeaseOrPhaseError for pre-lease failures** -- When `acquireLease` throws (e.g., lease_conflict), there is no TaskRecord to pass to `retryOrFail`. The handler creates a synthetic TaskRecord with attemptCount=1 and maxAttempts=3 so retry policy evaluation can proceed.
4. **Mock typing via unknown cast** -- Test mocks use `vi.fn()` without generic parameters and cast through `unknown` to the target interface type. This avoids TypeScript `never` type inference issues with vitest mock function generics while maintaining type safety at the integration boundary.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Lease conflict not caught by try/catch**
- **Found during:** GREEN phase -- test 9 (lease conflict) failed
- **Issue:** Plan's code placed `acquireLease` outside the try/catch block, so lease conflict errors propagated uncaught
- **Fix:** Moved `acquireLease` inside the try/catch and added `handleLeaseOrPhaseError` method that creates a synthetic TaskRecord for retry policy evaluation
- **Files modified:** runner/diagnostician-runner.ts
- **Commit:** 7dd3d5e7

**2. [Rule 3 - Blocking] Lint compliance for max-params and class-methods-use-this**
- **Found during:** GREEN phase commit (pre-commit hook)
- **Issue:** Constructor had 6 parameters (max 3), several methods had 4-5 parameters, and `classifyError`/`mapRunStatusToErrorCategory`/`sleep` triggered class-methods-use-this
- **Fix:** Introduced DiagnosticianRunnerDeps interface + context objects for multi-param methods; added eslint-disable comments for legitimate class-methods-use-this cases (instance methods kept for future extensibility)
- **Files modified:** runner/diagnostician-runner.ts
- **Commit:** 7dd3d5e7

**3. [Rule 3 - Blocking] Lint compliance for non-null assertions in test file**
- **Found during:** GREEN phase commit (pre-commit hook)
- **Issue:** `mockFn.mock.calls[0]![0]`, `startInput.contextItems[0]!`, `contextItem!` triggered no-non-null-assertion rule
- **Fix:** Added eslint-disable-next-line comments at each site (non-null assertions are unavoidable for mock call argument extraction)
- **Files modified:** runner/__tests__/diagnostician-runner.test.ts
- **Commit:** 7dd3d5e7

## Verification

- Unit tests: PASS (11/11 scenarios)
- TypeScript compilation: PASS (`npx tsc --noEmit` clean)
- Lint: PASS (lefthook pre-commit hook clean)
- Forbidden imports: PASS (no imports from evolution-worker.ts or prompt.ts)
- vitest.config.ts updated to include `src/runtime-v2/runner/**/*.test.ts`

## Known Stubs

None -- no stubs introduced in this plan.

## Self-Check: PASSED

- [x] `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` exists
- [x] `packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-runner.test.ts` exists
- [x] `packages/principles-core/vitest.config.ts` updated
- [x] Commit 6e3aec10 (RED) found in git log
- [x] Commit 7dd3d5e7 (GREEN) found in git log
