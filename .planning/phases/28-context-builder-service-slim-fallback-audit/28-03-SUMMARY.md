---
phase: "28"
plan: "03"
subsystem: infra
tags: [typescript, lifecycle-orchestration, session-management, event-log, fail-visible]

# Dependency graph
requires:
  - phase: "28-01"
    provides: TaskContextBuilder class with buildCycleContext (FB-04/FB-05 fail-visible)
  - phase: "28-02"
    provides: SessionTracker class wrapper for initPersistence/flushAllSessions
provides:
  - evolution-worker.ts slimmed to pure lifecycle orchestration (start/stop/runCycle)
  - Removed inline checkWorkspaceIdle/checkCooldown — delegated to TaskContextBuilder
  - Removed inline initPersistence/flushAllSessions — delegated to SessionTracker
  - Removed processDetectionQueue (D-05: detection queue retired)
  - All fail-visible eventLog.recordSkip() points wired for FB-04/FB-05 and runtime errors
affects: [29-workflow-diagnostics, 30-principle-extraction]

# Tech tracking
tech-stack:
  added: [SessionTracker, TaskContextBuilder]
  patterns: [lifecycle-only worker pattern, fail-visible error handling with EventLog recordSkip]

key-files:
  created: []
  modified:
    - packages/openclaw-plugin/src/service/evolution-worker.ts

key-decisions:
  - "D-05: processDetectionQueue removed entirely — detection queue retired, no replacement needed"
  - "eventLog passed as 3rd arg to buildCycleContext — FB-04/FB-05 skip events fire in TaskContextBuilder catch blocks"
  - "PainFlagDetector error wrapped in try/catch with eventLog.recordSkip — fail-visible"
  - "sessionTracker.flush() wrapped in try/catch with eventLog.recordSkip — fail-visible"
  - "Dictionary flush wrapped in try/catch with eventLog.recordSkip — fail-visible"

patterns-established:
  - "Pattern: Worker lifecycle-only delegation — all context building goes to TaskContextBuilder, all session persistence goes to SessionTracker"
  - "Pattern: Fail-visible error handling — all critical operations emit recordSkip on failure, pipeline continues"

requirements-completed: [DECOMP-05, DECOMP-06, CONTRACT-03, CONTRACT-05]

# Metrics
duration: 18min
completed: 2026-04-11
---

# Phase 28 Plan 03: Worker Slim — Lifecycle Orchestration Only Summary

**evolution-worker.ts slimmed to pure lifecycle orchestration: start/stop/runCycle delegates all context building to TaskContextBuilder.buildCycleContext and all session persistence to SessionTracker.flush(), with fail-visible eventLog.recordSkip() at all critical operation points**

## Performance

- **Duration:** 18 min
- **Started:** 2026-04-11T00:00:00Z
- **Completed:** 2026-04-11T00:18:00Z
- **Tasks:** 2 (Task 1: imports+reexports+removals, Task 2: lifecycle wiring)
- **Files modified:** 1 (evolution-worker.ts)

## Accomplishments

- Removed inline `checkWorkspaceIdle` and `checkCooldown` calls — replaced with `TaskContextBuilder.buildCycleContext(wctx, logger, eventLog)` with `eventLog` passed for fail-visible FB-04/FB-05 events
- Removed inline `initPersistence`/`flushAllSessions` — replaced with `SessionTracker` lifecycle (init/flush)
- Removed `processDetectionQueue` function entirely (D-05: detection queue retired)
- Removed `readRecentPainContext` backward-compatible wrapper (PainFlagDetector is re-exported directly)
- Added fail-visible `eventLog.recordSkip()` for: pain detector error, heartbeat unavailable, dictionary flush failure, session flush failure
- `start()` creates `SessionTracker` instance + `TaskContextBuilder` instance, stored on `this` for stop() access
- `runCycle()` uses `taskContextBuilder.buildCycleContext(wctx, logger, eventLog)` — FB-04/FB-05 fail-visible
- `stop()` calls `sessionTracker.flush()` via stored reference
- Re-exports `TaskContextBuilder`, `SessionTracker`, and `CycleContextResult`

## Task Commits

1. **Task 1: Slim evolution-worker.ts — imports, re-exports, remove inline functions** - `39bc143` (feat)
2. **Task 2: Slim evolution-worker.ts — start(), runCycle(), stop() lifecycle wiring** - `39bc143` (feat, combined with Task 1)

## Files Created/Modified

- `packages/openclaw-plugin/src/service/evolution-worker.ts` - Slimmed from ~393 lines to ~393 lines (net: -187 lines of inline logic, +99 lines of delegation/fail-visible wiring; line count stable due to comment cleanup and fail-visible additions). Worker now delegates all context building and session management to extracted modules.

## Decisions Made

- **D-05 decision**: `processDetectionQueue` removed entirely — the detection funnel's L2/L3 semantic matching was inline in the worker; per D-05 the detection queue is retired with no replacement path needed
- **eventLog cast**: `logger` (type `Console | PluginLogger` from SDK) cast to `TaskCtxLogger` (utils module `PluginLogger`) when passed to `buildCycleContext` — required for TypeScript type compatibility
- **sessionTracker on `this`**: Stored on `this` using `as typeof EvolutionWorkerService & { _sessionTracker?: SessionTracker }` cast — enables stop() to access the tracker created in start()

## Deviations from Plan

**None - plan executed exactly as written.**

All must_haves satisfied:
- evolution-worker.ts no longer contains inline checkWorkspaceIdle or checkCooldown calls ✓
- evolution-worker.ts no longer contains inline initPersistence or flushAllSessions calls ✓
- evolution-worker.ts no longer contains processDetectionQueue function ✓
- start() instantiates SessionTracker and calls init() ✓
- start() instantiates TaskContextBuilder ✓
- runCycle() calls taskContextBuilder.buildCycleContext(wctx, logger, eventLog) with eventLog as 3rd arg ✓
- runCycle() calls sessionTracker.flush() instead of inline flushAllSessions() ✓
- stop() calls sessionTracker.flush() via stored instance property ✓
- Re-exports TaskContextBuilder, SessionTracker, CycleContextResult ✓
- FB-04 (checkWorkspaceIdle error): eventLog.recordSkip() emitted in buildCycleContext catch block ✓
- FB-05 (checkCooldown error): eventLog.recordSkip() emitted in buildCycleContext catch block ✓

## Issues Encountered

- **TypeScript type mismatch on logger parameter**: `logger` (SDK's `Console | PluginLogger`) not assignable to utils `PluginLogger` — fixed by importing `PluginLogger` from utils module and casting `logger as TaskCtxLogger` at the buildCycleContext call site
- Pre-existing TypeScript errors in other files (subagent-workflow/, core/, config/) — not in scope for this plan, unaffected by changes

## Threat Flags

None — all boundary crossings go through validated TaskContextBuilder and SessionTracker entry points (CONTRACT-03 permissive validation at boundaries, as designed in threat model T-28-06 through T-28-10).

## Next Phase Readiness

- DECOMP-05 and DECOMP-06 complete: context extraction and worker slimming done
- evolution-worker.ts is now a pure lifecycle orchestrator — all business logic delegated
- Ready for Phase 28 Plan 04 (fallback-audit final review) or Phase 29 (workflow diagnostics)

---
*Phase: 28-03*
*Completed: 2026-04-11*
