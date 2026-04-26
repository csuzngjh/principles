---
phase: m6-05-Telemetry-Events
plan: '03'
subsystem: telemetry
tags: [telemetry, TELE-02, TELE-03, runtime-adapter, openclaw-cli]

# Dependency graph
requires:
  - m6-05-01
    provides: TelemetryEventType literals (runtime_invocation_started, runtime_invocation_succeeded, runtime_invocation_failed) + eventEmitter DI on OpenClawCliRuntimeAdapter
provides:
  - TELE-02 emission from OpenClawCliRuntimeAdapter.startRun()
  - TELE-03 emission from OpenClawCliRuntimeAdapter.startRun()
affects: [m6-05-04, m6-05-05, m6-05-06, m6-05-07]

# Tech tracking
tech-stack:
  added: []
  patterns: [telemetry event emission at runtime boundaries, error category mapping]

key-files:
  modified:
    - packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts

key-decisions:
  - "TELE-02 fires before CLI process is spawned (pre-runCliProcess call) for correlation"
  - "TELE-03 fires after CLI completes and state is updated, with branching based on cliOutput fields"
  - "errorCategory included in payload only for failed cases (conditional spread)"

requirements-completed: [TELE-02, TELE-03]

# Metrics
duration: 2min 17sec
completed: 2026-04-24
---

# Phase m6-05 Plan 03: TELE-02 and TELE-03 Emission Summary

**OpenClawCliRuntimeAdapter.startRun() now emits TELE-02 before CLI spawn and TELE-03 after completion with correct error category mapping**

## Performance

- **Duration:** 2 min 17 sec
- **Started:** 2026-04-24T16:04:50Z
- **Completed:** 2026-04-24T16:07:07Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- TELE-02 (runtime_invocation_started) fires before `runCliProcess()` with runId, runtimeKind, runtimeMode, timeoutMs
- TELE-03 (runtime_invocation_succeeded/failed) fires after CLI completes with branching logic:
  - ENOENT error → `runtime_invocation_failed` with `errorCategory: 'runtime_unavailable'`
  - timeout → `runtime_invocation_failed` with `errorCategory: 'timeout'`
  - non-zero exit code → `runtime_invocation_failed` with `errorCategory: 'execution_failed'`
  - otherwise → `runtime_invocation_succeeded`
- TypeScript compiles clean; lint passes

## Task Commits

1. **Task 1: Emit runtime_invocation_started (TELE-02) and runtime_invocation_succeeded/failed (TELE-03)** - `2ee5b754` (feat)

## Files Created/Modified

- `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` - Added TELE-02 emission before runCliProcess(), TELE-03 emission after with error category branching; initialized `errorCategory` with `= undefined` to satisfy `@typescript-eslint/init-declarations`

## Decisions Made

- TELE-02 fires before CLI process spawn so monitoring tools can correlate start time with process
- TELE-03 fires after state is updated (cliOutput stored, completed = true) to ensure consistency
- errorCategory only included in payload via spread when defined (conditional spread `...(errorCategory ? { errorCategory } : {})`)
- Used `telemetryEventType` variable name to avoid shadowing the imported event type

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

1. **lint: `@typescript-eslint/init-declarations`** — `errorCategory` declared without initializer conflicted with lint rule requiring initialization. Fixed by adding `= undefined`.

## Next Phase Readiness

- TELE-02, TELE-03 requirements complete
- OpenClawCliRuntimeAdapter telemetry emission complete
- Ready for subsequent plans (m6-05-04~07) to emit other events

---
*Phase: m6-05-Telemetry-Events*
*Completed: 2026-04-24*
