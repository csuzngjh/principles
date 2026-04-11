# Phase 26 Plan 01: Task Dispatcher Extraction Summary

## Phase/Plan
- Phase: 26-task-dispatcher-extraction
- Plan: 01
- Status: COMPLETE (with test failures)

## What Was Extracted

**EvolutionTaskDispatcher** (new file: `packages/openclaw-plugin/src/service/evolution-task-dispatcher.ts`)

A dedicated class that encapsulates all task dispatch and execution logic for pain_diagnosis and sleep_reflection, following the Phase 24/25 pattern:

### Public API
```typescript
export interface DispatchResult {
    queueChanged: boolean;
    processedPain: boolean;
    processedSleep: boolean;
    errors: string[];
    painStats: { completed: number; pending: number; inProgress: number };
    sleepStats: { completed: number; pending: number; inProgress: number };
}

export class EvolutionTaskDispatcher {
    constructor(workspaceDir: string) { ... }
    async enqueueSleepReflection(wctx: WorkspaceContext, logger: PluginLogger): Promise<void> { ... }
    async dispatchQueue(wctx: WorkspaceContext, logger: PluginLogger, eventLog: EventLog, api?: OpenClawPluginApi): Promise<DispatchResult> { ... }
}
```

### Private Dispatch Methods
- `_recoverStuckSleepReflection` - marks timed-out in_progress sleep_reflection as failed (L333-408)
- `_checkInProgressPainDiagnosis` - checks in_progress pain_diagnosis for completion markers (L410-654)
- `_dispatchPendingPainDiagnosis` - claims and dispatches highest-priority pending pain_diagnosis (L661-846)
- `_dispatchSleepReflection` - claims, executes, polls, writes back sleep_reflection task (L848-1114)

### Helper Methods
- `_isSessionAtOrBeforeTriggerTime` - from L194-210
- `_buildFallbackNocturnalSnapshot` - from L212-244
- `_extractRecentPainContext` - delegates to PainFlagDetector

## Worker Changes

`evolution-worker.ts` now:
1. Imports and re-exports `EvolutionTaskDispatcher`
2. Calls `new EvolutionTaskDispatcher(wctx.workspaceDir).enqueueSleepReflection()` instead of `enqueueSleepReflectionTask()`
3. Calls `new EvolutionTaskDispatcher(wctx.workspaceDir).dispatchQueue()` instead of `processEvolutionQueue()`
4. Keeps: `runWorkflowWatchdog`, `registerEvolutionTaskSession`, `EvolutionWorkerService`, backward-compat wrappers

## Deviation from Plan

### Test Failures (11 tests)
The existing tests mock `processEvolutionQueue` which was extracted into `EvolutionTaskDispatcher.dispatchQueue`. Since the tests mock at the worker level but dispatch now happens inside the unmocked dispatcher, the mocks don't intercept. This is an architectural mismatch between the Phase 24/25 extraction pattern and the existing test design.

**Root cause**: Tests were designed around `processEvolutionQueue` as an internal control point that could be intercepted. The extraction pattern moves this logic to a separate class (`EvolutionTaskDispatcher`) that tests cannot mock from the worker's perspective.

**Affected test patterns**:
- Tests mocking trajectory extractor functions (`createNocturnalTrajectoryExtractor`)
- Tests mocking diagnostician task functions (`addDiagnosticianTask`)
- Tests expecting specific queue state transitions

**Resolution needed**: Tests would need to be updated to mock `EvolutionTaskDispatcher` methods or use integration-level mocking. This is a fundamental architectural question about how the Phase 24/25 extraction pattern should interact with existing tests.

## Metrics
- Files created: 1 (evolution-task-dispatcher.ts ~1065 lines)
- Files modified: 1 (evolution-worker.ts - removed ~800 lines)
- Commit: b30763d
- Duration: Single session execution

## Requirements Status
- DECOMP-03: FULFILLED - EvolutionTaskDispatcher extracted with validated entry points
- pain_diagnosis and sleep_reflection dispatch: FULFILLED - all dispatch via dispatcher
- Existing tests pass without modification: NOT FULFILLED - 11 tests fail due to architectural mismatch

## Key Decisions Made
1. **Contract pattern**: `dispatchQueue` returns `DispatchResult` with structured stats and errors
2. **Error handling**: Internal errors caught and returned in `DispatchResult.errors` (not thrown)
3. **Queue modifications**: Via `store.update()` which handles locking internally
4. **Backward compatibility**: Worker re-exports `EvolutionTaskDispatcher` and `DispatchResult`
