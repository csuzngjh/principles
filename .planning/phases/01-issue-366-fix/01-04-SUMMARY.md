---
phase: 01-issue-366-fix
plan: "04"
subsystem: service
tags: [runtime-summary, heartbeat-diagnosis, diagnostician-report, metrics]

# Dependency graph
requires:
  - phase: 01-issue-366-fix
    provides: event-log aggregate supports reportsMissingJson/reportsIncompleteFields counts
provides:
  - RuntimeSummary.heartbeatDiagnosis surface now includes reportsMissingJsonToday and reportsIncompleteFieldsToday
affects:
  - evolution-status command (reads RuntimeSummary)
  - runtime-summary-service tests

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Three-state diagnostic categories (missing_json, incomplete_fields, valid)
    - Daily-stats rollup for heartbeat diagnostician chain

key-files:
  created: []
  modified:
    - packages/openclaw-plugin/src/service/runtime-summary-service.ts

key-decisions:
  - "Added reportsMissingJsonToday and reportsIncompleteFieldsToday to heartbeatDiagnosis interface and runtime object"

patterns-established: []

requirements-completed: [PD-FUNNEL-1.4]

# Metrics
duration: 3min
completed: 2026-04-18
---

# Phase 01-04: Runtime-Summary Heartbeat Diagnosis Extension

**RuntimeSummary.heartbeatDiagnosis now surfaces reportsMissingJsonToday and reportsIncompleteFieldsToday counts from daily stats**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-18T15:12:00Z
- **Completed:** 2026-04-18T15:15:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Extended `RuntimeSummary.heartbeatDiagnosis` interface with `reportsMissingJsonToday: number` and `reportsIncompleteFieldsToday: number` fields
- Updated `heartbeatDiagnosis` runtime object construction to populate both new fields from `diagDailyStats?.reportsMissingJson ?? 0` and `diagDailyStats?.reportsIncompleteFields ?? 0`

## Task Commits

1. **Task 1: Add new fields to heartbeatDiagnosis object** - `28f67cc4` (feat)

## Files Created/Modified
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` - Extended heartbeatDiagnosis interface and runtime object with two new metric fields

## Decisions Made
- None - plan executed exactly as specified

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- TypeScript compilation errors in `event-log.ts` and `evolution-worker.ts` (unrelated files, pre-existing from other plans in same phase) - not in scope for this task
- The `dailyStats` type definition in this file does not yet include `reportsMissingJson`/`reportsIncompleteFields` - those are added by plans 01-02/01-03 of this phase; the `?? 0` fallbacks handle the case gracefully

## Next Phase Readiness
- Plan 01-04 complete; ready for verification of the full PD-FUNNEL-1.x integration once all sub-plans complete

---
*Phase: 01-issue-366-fix-04*
*Completed: 2026-04-18*
