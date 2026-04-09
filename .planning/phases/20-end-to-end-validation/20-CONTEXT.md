# Phase 20: End-to-End Validation — Context

**Gathered:** 2026-04-09
**Status:** Ready for planning
**Source:** ROADMAP.md + Phase 17/18/19 VERIFICATION + Codebase analysis

## Phase Boundary

Validate all 4 WebUI pages display correct data after fixes (Phases 17, 18, 19). Add regression tests to prevent future data source drift.

## Requirements

- **E2E-01**: Validate all 4 pages display correct data after fixes
- **E2E-02**: Add validation tests to prevent future data source drift

## Background

### Phase 17 Summary (Overview Page Fixes)
- **Status**: COMPLETE (restored via commit 21ad5fcb)
- Created `CentralOverviewService` to replace inline route assembly at `/api/central/overview`
- Added 5 new query methods to `CentralDatabase`: getTaskOutcomes, getPrincipleEventCount, getSampleCountersByStatus, getSamplePreview, getMostRecentSync
- Added GFI persistence to `HealthQueryService` (initGfiState, readGfiState, writeGfiState)
- Added `execute()` and `run()` methods to `ControlUiDatabase` for DDL/parameterized writes
- **Verification**: 17-VERIFICATION.md shows gaps_found (stale — ran before restore)

### Phase 18 Summary (Loop/Samples + Feedback Page Fixes)
- **Status**: COMPLETE
- `/api/samples` (listSamples): 9 fields verified correct, snake_case→camelCase mapping correct
- `/api/samples/:id` (getSampleDetail): All fields verified correct, JSON parsing for recoveryToolSpan correct
- `/api/feedback/gfi`, `/api/feedback/empathy-events`, `/api/feedback/gate-blocks`: All verified correct

### Phase 19 Summary (Gate Monitor + Frontend Field Mapping)
- **Status**: COMPLETE (verification-only phase)
- `/api/gate/stats`: getGateStats() returns correct 11 fields from gate_blocks table
- `/api/gate/blocks`: getGateBlocks() returns correct 7 fields with graceful null handling
- Frontend types and field accessors match backend responses exactly

## 4 Pages to Validate

### 1. Overview Page
- `/api/overview` → ControlUiQueryService.getOverview() → ControlUiDatabase
- `/api/central/overview` → CentralOverviewService.getOverview() → CentralDatabase
- `/api/overview/health` → HealthQueryService.getHealth() → ControlUiDatabase

### 2. Loop/Samples Page
- `/api/samples` → ControlUiQueryService.listSamples() → ControlUiDatabase
- `/api/samples/:id` → ControlUiQueryService.getSampleDetail() → ControlUiDatabase

### 3. Feedback Page
- `/api/feedback/gfi` → EvolutionQueryService.getGfi() → ControlUiDatabase
- `/api/feedback/empathy-events` → HealthQueryService.getEmpathyEvents() → ControlUiDatabase
- `/api/feedback/gate-blocks` → HealthQueryService.getFeedbackGateBlocks() → ControlUiDatabase

### 4. Gate Monitor Page
- `/api/gate/stats` → HealthQueryService.getGateStats() → ControlUiDatabase (gate_blocks table)
- `/api/gate/blocks` → HealthQueryService.getGateBlocks() → ControlUiDatabase (gate_blocks table)

## Regression Test Strategy

Tests should verify:
1. Each API endpoint returns expected fields with correct types
2. Frontend types match backend response shapes
3. Field naming is consistent (camelCase throughout)
4. No hardcoded zeros or fake data

## Out of Scope

- UI visual changes
- Performance testing
- Load testing

## Deferred Ideas

None — E2E validation is the final phase

---

*Phase: 20-end-to-end-validation*
*Context gathered: 2026-04-09*
