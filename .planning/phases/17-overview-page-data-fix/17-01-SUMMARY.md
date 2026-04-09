---
phase: 17-overview-page-data-fix
plan: "01"
subsystem: api
tags: [webui, data-fix, central-overview, service-layer, sqlite]

# Dependency graph
requires:
  - phase: 16-data-source-tracing
    provides: DATA-FLOW-REPORT.md documenting 11 mismatches in overview page data sources
provides:
  - CentralOverviewService class with getOverview() replacing inline route assembly
  - CentralDatabase gains 5 new query methods (getTaskOutcomes, getPrincipleEventCount, getSampleCountersByStatus, getSamplePreview, getMostRecentSync)
affects:
  - phase: 17-overview-page-data-fix (plan 02 - Health GFI persistence)
  - phase: 18-feedback-page-data-fix
  - phase: 19-frontend-field-mapping

# Tech tracking
tech-stack:
  added: [CentralOverviewService]
  patterns: [Service extraction from inline route assembly, Omit<T> for interface field override]

key-files:
  created:
    - packages/openclaw-plugin/src/service/central-overview-service.ts
  modified:
    - packages/openclaw-plugin/src/service/central-database.ts
    - packages/openclaw-plugin/src/http/principles-console-route.ts

key-decisions:
  - "D-01: Extracted inline assembly to CentralOverviewService class"
  - "D-02: taskOutcomes queried from aggregated_task_outcomes table via getTaskOutcomes()"
  - "D-03: principleEventCount from aggregated_principle_events; gateBlocks=0 with console.warn (no aggregated gate table)"
  - "D-04: sampleQueue.preview from getSamplePreview() (top 5 pending/approved across all workspaces)"
  - "D-05: dataFreshness from getMostRecentSync() (MAX last_sync, not alphabetically first workspace)"
  - "D-06: sampleQueue.counters from getSampleCountersByStatus() (all review statuses, not just 3 hardcoded)"
  - "Used Omit<OverviewResponse, 'dataSource' | 'runtimeControlPlaneSource'> + string override to allow central-specific literal values"

patterns-established:
  - "Service disposal pattern via try/finally in route handler"

requirements-completed: [OVER-01, OVER-02]

# Metrics
duration: 3min
completed: 2026-04-09
---

# Phase 17 Plan 01: Overview Page Data Fix Summary

**CentralOverviewService extracts and fixes /api/central/overview: real taskOutcomes from aggregated_task_outcomes, sample preview from 5 most recent pending/approved across workspaces, dataFreshness from most-recently-synced workspace, and all review statuses in counters**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-09T01:32:51Z
- **Completed:** 2026-04-09T01:35:44Z
- **Tasks:** 3
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments

- Replaced 60-line inline IIFE at `/api/central/overview` route with proper `CentralOverviewService` class
- `taskOutcomes` now comes from `aggregated_task_outcomes` table (was hardcoded to 0)
- `sampleQueue.preview` now shows top 5 most recent pending/approved samples across all workspaces (was `[]`)
- `dataFreshness` now reflects most recently synced workspace (was alphabetically first)
- `sampleQueue.counters` now includes all review statuses from GROUP BY query (was just 3 hardcoded keys)
- `principleEventCount` now queried from `aggregated_principle_events` (was hardcoded 0 with warning)
- `gateBlocks` remains 0 with console.warn (no aggregated gate table exists)

## Task Commits

1. **Task 1: Add 5 query methods to CentralDatabase** - `df95fb3b` (feat)
2. **Task 2: Create CentralOverviewService class** - `2c563981` (feat)
3. **Task 3: Wire CentralOverviewService into route handler** - `15185c89` (refactor)

## Files Created/Modified

- `packages/openclaw-plugin/src/service/central-overview-service.ts` - CentralOverviewService with getOverview() returning CentralOverviewResponse
- `packages/openclaw-plugin/src/service/central-database.ts` - Added getTaskOutcomes(), getPrincipleEventCount(), getSampleCountersByStatus(), getSamplePreview(limit), getMostRecentSync()
- `packages/openclaw-plugin/src/http/principles-console-route.ts` - Replaced inline IIFE with CentralOverviewService call at /api/central/overview

## Decisions Made

- Used `Omit<OverviewResponse, 'dataSource' | 'runtimeControlPlaneSource'>` to override literal-typed fields with `string` in CentralOverviewResponse, allowing 'central_aggregated_db' and 'all_workspaces' values
- OVER-02 (ControlUiQueryService) requires no changes per D-09 - acknowledged as informational Task 0

## Deviations from Plan

None - plan executed exactly as written.

## Auto-fixed Issues

**1. [Rule 2 - Type Override] CentralOverviewResponse literal type incompatibility**
- **Found during:** Task 2 (CentralOverviewService creation)
- **Issue:** OverviewResponse declares dataSource and runtimeControlPlaneSource as literal types ('trajectory_db_analytics' and 'pd_evolution_status'), but CentralOverviewService needs 'central_aggregated_db' and 'all_workspaces'
- **Fix:** Used `Omit<OverviewResponse, 'dataSource' | 'runtimeControlPlaneSource'>` with `string` override in CentralOverviewResponse interface
- **Files modified:** packages/openclaw-plugin/src/service/central-overview-service.ts
- **Verification:** TypeScript compile passes with no errors in changed files
- **Committed in:** `2c563981` (part of Task 2)

## Issues Encountered

- Pre-existing TypeScript errors in `evolution-worker.ts` (evolution-worker.ts:828 missing runtimeAdapter property, :835-836 accessing private store) - unrelated to this plan, logged to deferred-items.md

## Next Phase Readiness

- CentralOverviewService is ready for Phase 17 plan 02 (GFI persistence in HealthQueryService)
- OVER-01 and OVER-02 requirements confirmed satisfied

---
*Phase: 17-overview-page-data-fix plan 01*
*Completed: 2026-04-09*
