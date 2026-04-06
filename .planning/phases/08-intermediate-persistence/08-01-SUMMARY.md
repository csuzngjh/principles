---
phase: "08"
plan: "01"
subsystem: database
tags: [sqlite, persistence, workflow-store, trinity, idempotency]

# Dependency graph
requires:
  - phase: "06"
    provides: WorkflowStore base with SQLite persistence, TrinityRuntimeAdapter types
provides:
  - subagent_workflow_stage_outputs table with idempotency-keyed stage output persistence
  - recordStageOutput: idempotent INSERT OR IGNORE for NOC-11
  - getStageOutputs: crash-recovery lookup for NOC-13
  - getStageOutputByKey: idempotency check by key for NOC-12
affects:
  - phase-08-trinity-idempotency (will call these methods from NocturnalWorkflowManager)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - INSERT OR IGNORE for SQLite idempotency (avoids unique constraint violation)
    - Stage output JSON serialization via JSON.stringify/JSON.parse
    - Foreign key cascade delete for workflow-scoped stage outputs

key-files:
  created: []
  modified:
    - packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts

key-decisions:
  - "Used INSERT OR IGNORE instead of ON CONFLICT for idempotency — simpler, same semantics"
  - "Unique index on idempotency_key ensures duplicate stage outputs are silently skipped"
  - "CHECK constraint on stage column restricts to 'dreamer'|'philosopher' for data integrity"

patterns-established:
  - "Stage output persistence: recordStageOutput/getStageOutputs/getStageOutputByKey pattern"
  - "Idempotent stage recording: INSERT OR IGNORE with unique idempotency_key"

requirements-completed: [NOC-11, NOC-12, NOC-13]

# Metrics
duration: 5min
completed: 2026-04-06
---

# Phase 08 Plan 01: Stage Output Persistence Summary

**WorkflowStore extended with subagent_workflow_stage_outputs table, recordStageOutput, getStageOutputs, and getStageOutputByKey for Trinity stage output persistence and idempotency (NOC-11/12/13)**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-06T01:39:00Z
- **Completed:** 2026-04-06T01:44:00Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments

- Added `subagent_workflow_stage_outputs` SQLite table with foreign key to workflows and unique index on idempotency_key
- Added `recordStageOutput` method: idempotent INSERT OR IGNORE for NOC-11
- Added `getStageOutputs` method: retrieves all stage outputs for a workflow ordered by created_at for NOC-13 crash recovery
- Added `getStageOutputByKey` method: looks up stage output by idempotency_key for NOC-12 idempotency checks
- Imported DreamerOutput and PhilosopherOutput types from nocturnal-trinity.js

## Task Commits

1. **Task 1: Add subagent_workflow_stage_outputs table schema** - `6532cc2` (feat)
2. **Task 2: Add recordStageOutput, getStageOutputs, getStageOutputByKey methods** - `6532cc2` (feat, same commit)

## Files Created/Modified

- `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts` - Added stage output persistence table and three new methods

## Decisions Made

- Used INSERT OR IGNORE for idempotency: if a row with the same idempotency_key already exists, silently skip instead of erroring
- CHECK constraint restricts stage column to 'dreamer'|'philosopher' to catch invalid data early
- getStageOutputs returns outputs ordered by created_at ASC for consistent ordering on crash recovery

## Deviations from Plan

None - plan executed exactly as written.

## Auto-fixed Issues

None.

## Issues Encountered

- TypeScript error: `getStageOutputByKey` return type declaration did not include `idempotencyKey` but the returned object literal did (per plan spec the return type omits idempotencyKey). Fixed by removing `idempotencyKey` from the returned object to match the declared return type.

## Threat Flags

None - internal SQLite persistence with no external input or secrets.

## Next Phase Readiness

- WorkflowStore now has all methods needed for NOC-11/12/13
- NocturnalWorkflowManager (08-02) can call recordStageOutput after each Trinity stage completes
- getStageOutputByKey ready for idempotency checks before re-running a stage
- getStageOutputs ready for crash recovery to restore workflow state

---
*Phase: 08-intermediate-persistence / 08-01*
*Completed: 2026-04-06*
