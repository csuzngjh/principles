---
phase: m6-05-Telemetry-Events
plan: '02'
subsystem: telemetry
tags: [telemetry, event-emitter, diagnostician-runner, runtime-adapter]

# Dependency graph
requires:
  - phase: m6-05-01
    provides: StoreEventEmitter DI in OpenClawCliRuntimeAdapter, telemetry event types including runtime_adapter_selected and output_validation_succeeded/failed
provides:
  - TELE-01 event emitted from CLI command handler when OpenClawCliRuntimeAdapter is instantiated
  - TELE-04 events emitted from DiagnosticianRunner after validator.validate() calls
affects: [m6-05-03, m6-05-04, m6-05-05, m6-05-06, m6-05-07]

# Tech tracking
tech-stack:
  added: []
  patterns: [storeEmitter singleton usage for telemetry, emitDiagnosticianEvent helper pattern]

key-files:
  created: []
  modified:
    - packages/pd-cli/src/commands/diagnose.ts
    - packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts

key-decisions:
  - "TELE-01 uses storeEmitter singleton rather than passing eventEmitter to OpenClawCliRuntimeAdapter constructor, keeping the emission at the CLI layer where runtimeKind is known"

patterns-established:
  - "TELE-04 emission via emitDiagnosticianEvent helper (agentId=diagnostician) for consistency with existing diagnostician events"

requirements-completed: [TELE-01, TELE-04]

# Metrics
duration: 3min
completed: 2026-04-24
---

# Phase m6-05 Plan 02: TELE-01 + TELE-04 Event Emission Summary

**TELE-01 (runtime_adapter_selected) emitted from CLI handler on OpenClawCliRuntimeAdapter instantiation; TELE-04 events (output_validation_succeeded/failed) emitted from DiagnosticianRunner after validation**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-24T16:02:28Z
- **Completed:** 2026-04-24T16:05:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- TELE-01 (runtime_adapter_selected) fires in handleDiagnoseRun() immediately after OpenClawCliRuntimeAdapter is constructed, using storeEmitter singleton
- TELE-04 (output_validation_succeeded) fires in run() after validator.validate() returns valid: true
- TELE-04 (output_validation_failed) fires in handleValidationError() before retryOrFail
- TypeScript compiles clean across both packages

## Task Commits

Each task was committed atomically:

1. **Task 1: Emit runtime_adapter_selected (TELE-01) in handleDiagnoseRun()** - `86793ffc` (feat)
2. **Task 2: Emit output_validation_succeeded/failed (TELE-04) after validator.validate()** - `facd65e3` (feat)

## Files Created/Modified

- `packages/pd-cli/src/commands/diagnose.ts` - Added storeEmitter import; TELE-01 emission block after OpenClawCliRuntimeAdapter construction (lines 132-143)
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` - Added TELE-04 emissions: output_validation_succeeded after validation success (lines 194-198), output_validation_failed in handleValidationError (lines 412-416)

## Decisions Made

- Used storeEmitter singleton directly in CLI handler rather than passing eventEmitter through the adapter constructor, keeping TELE-01 at the CLI layer where runtimeKind and runtimeMode are directly known from opts
- TELE-04 uses emitDiagnosticianEvent helper with agentId 'diagnostician' for consistency with existing diagnostician telemetry events

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## Next Phase Readiness

- TELE-01 and TELE-04 requirements complete
- TELE-02 (runtime_invocation_started) and TELE-03 (runtime_invocation_succeeded/failed) remain for subsequent plans
- DiagnosticianRunner event emission pattern established and ready for remaining telemetry plans
