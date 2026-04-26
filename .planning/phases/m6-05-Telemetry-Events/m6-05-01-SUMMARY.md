---
phase: m6-05-Telemetry-Events
plan: '01'
subsystem: telemetry
tags: [telemetry, event-types, dependency-injection, runtime-adapter]

# Dependency graph
requires:
  - phase: m5-01
    provides: StoreEventEmitter and storeEmitter singleton from event-emitter.ts
provides:
  - 6 new TelemetryEventType literals (runtime_adapter_selected, runtime_invocation_started, runtime_invocation_succeeded, runtime_invocation_failed, output_validation_succeeded, output_validation_failed)
  - eventEmitter DI support on OpenClawCliRuntimeAdapter with storeEmitter fallback
affects: [m6-05-02, m6-05-03, m6-05-04, m6-05-05, m6-05-06, m6-05-07]

# Tech tracking
tech-stack:
  added: []
  patterns: [TypeBox Literal union for exhaustive event typing, dependency-injection with optional fallback]

key-files:
  created: []
  modified:
    - packages/principles-core/src/telemetry-event.ts
    - packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts

key-decisions:
  - "Optional eventEmitter in OpenClawCliRuntimeAdapterOptions with storeEmitter fallback preserves backward compatibility"

patterns-established:
  - "TypeBox Type.Literal union for exhaustive telemetry event type checking"
  - "Optional DI field with singleton fallback pattern"

requirements-completed: [TELE-01, TELE-02, TELE-03]

# Metrics
duration: 1min 16sec
completed: 2026-04-24
---

# Phase m6-05 Plan 01: Telemetry Event Types + DI Support Summary

**Six new telemetry event types added to TelemetryEventType union; OpenClawCliRuntimeAdapter gains optional eventEmitter DI with storeEmitter fallback**

## Performance

- **Duration:** 1 min 16 sec
- **Started:** 2026-04-24T16:01:12Z
- **Completed:** 2026-04-24T16:02:28Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Added 6 runtime-adapter telemetry event types to TelemetryEventType union (M6 runtime instrumentation)
- OpenClawCliRuntimeAdapter now accepts optional eventEmitter via constructor DI with storeEmitter singleton fallback
- TypeScript compiles clean with no errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Add TELE-01~04 event type literals to TelemetryEventType union** - `0148e7a8` (feat)
2. **Task 2: Add eventEmitter to OpenClawCliRuntimeAdapter constructor (DI)** - `331a623e` (feat)

## Files Created/Modified

- `packages/principles-core/src/telemetry-event.ts` - Added 6 new Type.Literal entries for runtime adapter events; updated JSDoc count from 24 to 30
- `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` - Added StoreEventEmitter import, optional eventEmitter field, constructor DI with storeEmitter fallback

## Decisions Made

- Optional eventEmitter with storeEmitter fallback preserves backward compatibility for existing callers that do not pass an eventEmitter
- Imported StoreEventEmitter as type-only import alongside storeEmitter value import (lint auto-fixed to split into two import lines)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## Next Phase Readiness

- TELE-01, TELE-02, TELE-03 requirements complete
- New event types available for m6-05 subsequent plans (02-07) to emit
- OpenClawCliRuntimeAdapter DI slot ready for m6-05-03 and subsequent adapter plans

---
*Phase: m6-05-Telemetry-Events*
*Completed: 2026-04-24*
