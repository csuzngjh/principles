---
phase: m6-06
plan: '03'
subsystem: runtime-v2
tags: [e2e, regression, openclaw-history, legacy]
dependency_graph:
  requires:
    - m6-01 CliProcessRunner + RuntimeKind
    - m6-04 PD CLI Extension + Error Mapping
    - m6-05 Telemetry Events
  provides:
    - E2EV-08 Legacy openclaw-history import path regression test
  affects:
    - DiagnosticianRunner
    - SqliteContextAssembler
    - RuntimeStateManager
tech_stack:
  added:
    - m6-06-legacy.test.ts (vitest)
  patterns:
    - Regression test mirroring dual-track-e2e.test.ts Scenario 4
    - TestDoubleRuntimeAdapter for adapter simulation
    - In-memory SQLite via RuntimeStateManager
key_files:
  created:
    - packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-legacy.test.ts
decisions:
  - Used mockCommitter inline rather than importing from dual-track-e2e.test.ts for self-contained test
  - Mirrored exact Scenario 4 pattern from dual-track-e2e.test.ts for regression coverage
metrics:
  duration: ~3 minutes
  completed_date: '2026-04-25T00:59:00Z'
---

# Phase m6-06 Plan 03: Legacy openclaw-history Import Regression Test (E2EV-08)

## One-liner

E2E regression test verifying DiagnosticianRunner handles openclaw-history runtime kind without errors.

## Requirement

**E2EV-08**: Legacy openclaw-history import path regression.

## What Was Done

Created `m6-06-legacy.test.ts` — a regression test that verifies DiagnosticianRunner can handle tasks with pre-existing openclaw-history run records (imported from existing openclaw conversations) without crashing or producing errors.

**Test scenario (E2EV-08):**
1. Create temp dir + RuntimeStateManager (in-memory SQLite)
2. Create diagnostician task
3. Acquire lease with `runtimeKind: 'openclaw-history'` to simulate imported history
4. Mark task succeeded, then reset to pending (mimics pre-existing run)
5. Configure TestDoubleRuntimeAdapter for success
6. Run DiagnosticianRunner.run(taskId)
7. Assert: result.status === 'succeeded', contextHash non-empty, output.valid === true, task status 'succeeded' in store, at least one openclaw-history run exists

**Test result:** 1 passed, 0 failed.

## Success Criteria

- [x] m6-06-legacy.test.ts exists
- [x] Scenario passes: DiagnosticianRunner handles openclaw-history imported context without errors
- [x] Task completes successfully with contextHash non-empty and output.valid === true
- [x] At least one run with runtimeKind === 'openclaw-history' exists in store

## Deviations from Plan

None.

## Commit

- `f575a1e5` — test(m6-06): add E2EV-08 legacy openclaw-history import regression test

## Self-Check: PASSED

- m6-06-legacy.test.ts found at `packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-legacy.test.ts`
- Commit `f575a1e5` exists in git log
- Test passes: 1 passed, 0 failed