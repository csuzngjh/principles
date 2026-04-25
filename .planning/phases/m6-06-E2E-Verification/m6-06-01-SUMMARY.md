---
phase: m6-06-E2E-Verification
plan: '01'
subsystem: testing
tags: [vitest, e2e, openclaw-cli, runtime-adapter, fake-cli-process-runner, jest-mock]

# Dependency graph
requires:
  - phase: m6-02
    provides: OpenClawCliRuntimeAdapter with startRun, pollRun, fetchOutput
  - phase: m6-05
    provides: SqliteDiagnosticianCommitter with atomic commit
  - phase: m5-05
    provides: dual-track-e2e.test.ts TestDoubleRuntimeAdapter regression baseline
provides:
  - FakeCliProcessRunner E2E tests for openclaw-cli adapter path (vi.mock interception)
  - Full chain verification: task -> run -> DiagnosticianOutputV1 -> artifact -> candidates
  - HG-3 verification: local mode --local vs gateway mode no --local flag
  - TestDoubleRuntimeAdapter regression verification
affects:
  - m6-06 subsequent plans (E2E verification continuation)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - vi.mock for module-level process runner interception
    - FakeCliProcessRunner factory pattern for test fixture data
    - Schema-valid DiagnosticianOutputV1 fixture with >= 2 kind='principle' recommendations

key-files:
  created:
    - packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-e2e.test.ts
  modified: []

key-decisions:
  - "Used vi.mock('../../utils/cli-process-runner.js') to intercept runCliProcess without spawning real CLI binary"
  - "Schema-valid DiagnosticianOutputV1 fixture passes Value.Check validation"

patterns-established:
  - "FakeCliProcessRunner pattern: vi.mock + mockResolvedValue for controlled CLI output in tests"
  - "Runtime mode argument verification: destructured mock.calls[0][0] to inspect command/args"

requirements-completed: [E2EV-01, E2EV-02, E2EV-03, HG-3]

# Metrics
duration: 7min
completed: 2026-04-25
---

# Phase m6-06 Plan 01 Summary

**FakeCliProcessRunner E2E tests prove openclaw-cli adapter path with full chain verification, HG-3 runtimeMode arg validation, and TestDoubleRuntimeAdapter regression coverage**

## Performance

- **Duration:** 7 min
- **Started:** 2026-04-25T00:52:00Z
- **Completed:** 2026-04-25T00:59:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Created m6-06-e2e.test.ts with 3 scenarios covering E2EV-01, E2EV-02, E2EV-03, HG-3
- vi.mock intercepts runCliProcess — no real openclaw binary spawned during tests
- Full chain verified: task -> run -> DiagnosticianOutputV1 -> artifact -> candidates
- HG-3 confirmed: local mode passes --local flag, gateway mode omits --local
- TestDoubleRuntimeAdapter regression test passes (dual-track-e2e reference)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create m6-06-e2e.test.ts with FakeCliProcessRunner** - `8caee6cf` (test)

## Files Created/Modified
- `packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-e2e.test.ts` - FakeCliProcessRunner E2E tests with 3 scenarios

## Decisions Made
- Used vi.mock('../../utils/cli-process-runner.js') over TestDoubleRuntimeAdapter to specifically test OpenClawCliRuntimeAdapter's CLI invocation
- Schema-valid DiagnosticianOutputV1 fixture with 2 kind='principle' + 1 kind='rule' recommendations

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- **Lint error (import type annotation):** `import()` type annotations forbidden by @typescript-eslint/consistent-type-imports on line 44. Fix: removed explicit type generic from vi.fn(), let TypeScript infer the type.
- **Lint error (array destructuring):** @typescript-eslint/prefer-destructuring required using `const [[firstCall]]` instead of `const firstCall = mock.calls[0]![0]`. Fix: applied array destructuring pattern.
- **vi.mock path resolution:** Mock path `'../utils/cli-process-runner.js'` resolved incorrectly from `__tests__/` directory. Fix: changed to `'../../utils/cli-process-runner.js'` (two levels up to reach src/runtime-v2/utils/).

## Next Phase Readiness
- m6-06-e2e.test.ts ready for m6-06 subsequent plan execution
- OpenClawCliRuntimeAdapter path fully verified via FakeCliProcessRunner
- TestDoubleRuntimeAdapter path regression confirmed

---
*Phase: m6-06-E2E-Verification*
*Completed: 2026-04-25*
