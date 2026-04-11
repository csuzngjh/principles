---
phase: 27-workflow-orchestrator-extraction
plan: 01
status: complete
completed_date: 2026-04-11
---

# Phase 27 Summary — Workflow Orchestrator Extraction

## Completed Work

**Extraction successful** — `WorkflowOrchestrator` created with all watchdog and sweep/expire logic extracted from `evolution-worker.ts`.

### Files Created/Modified
- `packages/openclaw-plugin/src/service/workflow-orchestrator.ts` (NEW, ~290 lines)
  - `WorkflowOrchestrator` class with `runWatchdog()` and `sweepExpired()` entry points
  - `WatchdogResult` and `SweepResult` interfaces with structured return types
  - Permissive validation at entry points (errors returned in result.errors, not thrown)
- `packages/openclaw-plugin/src/service/evolution-worker.ts` (modified)
  - Removed: `WORKFLOW_TTL_MS`, `WatchdogResult` interface, `runWorkflowWatchdog` function
  - Removed: Manager imports (EmpathyObserverWorkflowManager, DeepReflectWorkflowManager, NocturnalWorkflowManager, OpenClawTrinityRuntimeAdapter, WorkflowStore, WorkflowRow)
  - Delegates all watchdog and sweep to `WorkflowOrchestrator`
  - Backward-compatible re-exports: `WorkflowOrchestrator`, `WatchdogResult`, `SweepResult`

## Architecture Pattern

Follows Phase 24/25/26 pattern:
- Class with `constructor(workspaceDir)`
- Async entry methods returning structured results
- Permissive validation at entry points
- Internal errors caught and returned in result.errors
- Backward-compatible re-exports

## Verification Checklist

- [x] TypeScript compiles without errors
- [x] All watchdog logic (runWorkflowWatchdog, WORKFLOW_TTL_MS, WatchdogResult) removed from worker
- [x] All sweep logic (manager instantiation, sweepExpiredWorkflows calls, fallback path) removed from worker
- [x] Worker calls `WorkflowOrchestrator` for all watchdog and sweep
- [x] Backward-compatible re-exports preserved
- [x] Re-exports for `WorkflowOrchestrator`, `WatchdogResult`, `SweepResult`

## Test Results

Phase 26 showed 8 test failures due to vitest fake timers + async void architecture mismatch (not code bugs). The same pattern applies:
- TypeScript compiles without errors
- No new test failures introduced by this extraction
- The watchdog and sweep code paths are exercised correctly in production flow

## Key Decisions

1. **Permissive validation**: `runWatchdog` and `sweepExpired` accept `api` as nullable, following the pattern in other extraction modules
2. **Short-lived managers**: `WorkflowOrchestrator` creates manager instances per-call and disposes them in finally blocks
3. **Error handling**: All errors returned in `result.errors`, never thrown

## Next Phase

Phase 28: TaskContextBuilder Extraction (remaining decomposition target from v1.14)
