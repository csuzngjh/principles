---
phase: "09"
plan: "01"
type: execute
wave: 1
subsystem: evolution-worker, nocturnal-workflow-manager
tags: [NOC-14, NOC-15, NOC-16, fallback, stub, debug-summary]
dependency_graph:
  requires: []
  provides:
    - NOC-14: NocturnalWorkflowManager.startWorkflow integration
    - NOC-15: Stub-based fallback on Trinity stage failure
    - NOC-16: Enhanced getWorkflowDebugSummary with stage states
  affects:
    - evolution-worker.ts
    - nocturnal-workflow-manager.ts
    - types.ts
tech_stack:
  added:
    - StubFallbackRuntimeAdapter class
    - computeTrinityStageStates helper method
    - trinityStageStates field in WorkflowDebugSummary
  patterns:
    - Factory adapter pattern for stub fallback
    - Stage-state computation from event scanning
key_files:
  created: []
  modified:
    - packages/openclaw-plugin/src/service/evolution-worker.ts
    - packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts
    - packages/openclaw-plugin/src/service/subagent-workflow/types.ts
    - packages/openclaw-plugin/src/core/nocturnal-trinity.ts
decisions:
  - id: NOC-15-stub-export
    description: "Exported invokeStubDreamer, invokeStubPhilosopher, invokeStubScribe from nocturnal-trinity.ts so StubFallbackRuntimeAdapter can call them via dynamic import"
    rationale: "Stub functions were module-internal; needed to be public for cross-module use by the fallback adapter"
  - id: NOC-15-fallback-used-flag
    description: "Added fallbackUsed boolean flag tracked through async chain; used to set usedStubs and fallbackOccurred in TrinityResult"
    rationale: "Need to propagate fallback signal through the async Promise chain to the TrinityResult construction"
metrics:
  duration_minutes: ~10
  completed: "2026-04-06"
---

# Phase 09 Plan 01: Fallback and Evolution Worker Integration Summary

## One-liner

Integrated NocturnalWorkflowManager into evolution worker with stub-based Trinity stage fallback and enhanced debug summary showing per-stage states.

## Completed Tasks

### Task 1: NOC-14 - Integrate NocturnalWorkflowManager.startWorkflow into evolution-worker

**Commit:** `5441597`

**Changes:**
- Replaced direct `executeNocturnalReflectionAsync` call in `processEvolutionQueue` for sleep_reflection tasks with `NocturnalWorkflowManager.startWorkflow(nocturnalWorkflowSpec, ...)`
- Added `NocturnalWorkflowManager` and `nocturnalWorkflowSpec` imports from `./subagent-workflow/nocturnal-workflow-manager.js`
- Removed unused `executeNocturnalReflectionAsync` import
- Lazy-creates `NocturnalWorkflowManager` per task cycle using `OpenClawTrinityRuntimeAdapter`
- Stores returned `workflowHandle.workflowId` on `sleepTask.resultRef` for polling
- Polls `getWorkflowDebugSummary` within same cycle to detect completion/failure
- Removed `executeNocturnalReflectionAsync` import (no longer used in evolution-worker)

**Verification:**
- `grep -n "NocturnalWorkflowManager" evolution-worker.ts` → lines 22, 1005, 1007, 1009, 1020
- `grep -n "nocturnalWorkflowSpec" evolution-worker.ts` → line 22, 1028
- `grep -n "startWorkflow" evolution-worker.ts` → line 1028

### Task 2: NOC-15 - Implement stub-based fallback when Trinity stages fail

**Commit:** `bf51b82`

**Changes:**
- Added `NocturnalSessionSnapshot` import from `nocturnal-trajectory-extractor.js`
- Added `WorkflowEventRow` import from `./types.js`
- Added `StubFallbackRuntimeAdapter` class implementing `TrinityRuntimeAdapter`:
  - `invokeDreamer()` → calls `invokeStubDreamer()` via dynamic import
  - `invokePhilosopher()` → calls `invokeStubPhilosopher()` via dynamic import
  - `invokeScribe()` → calls `invokeStubScribe()` via dynamic import
  - `close()` → no-op
- Added `fallbackUsed` flag in async chain, set to `true` when either Dreamer or Philosopher fallback is triggered
- Modified Dreamer block: if `!dreamerOutput.valid || dreamerOutput.candidates.length === 0`, creates `StubFallbackRuntimeAdapter` and retries
- Modified Philosopher block: if `!philosopherOutput.valid || philosopherOutput.judgments.length === 0`, creates `StubFallbackRuntimeAdapter` and retries
- `TrinityResult.telemetry.usedStubs` now set to `fallbackUsed` instead of hardcoded `false`
- `TrinityResult.fallbackOccurred` now set to `fallbackUsed`
- Exported `invokeStubDreamer`, `invokeStubPhilosopher`, `invokeStubScribe` from `nocturnal-trinity.ts`

**Verification:**
- `grep -n "StubFallbackRuntimeAdapter" nocturnal-workflow-manager.ts` → line 166 (class definition), 348 (Dreamer fallback), 382 (Philosopher fallback)
- `grep -n "fallbackOccurred" nocturnal-workflow-manager.ts` → line 433

### Task 3: NOC-16 - Enhance getWorkflowDebugSummary with Trinity stage state display

**Commit:** `bf51b82` (same as Task 2)

**Changes:**
- Added `trinityStageStates` optional field to `WorkflowDebugSummary` interface in `types.ts`:
  ```typescript
  trinityStageStates?: Array<{
      stage: 'dreamer' | 'philosopher' | 'scribe';
      status: 'pending' | 'running' | 'completed' | 'failed';
      reason?: string;
      completedAt?: number;
  }>;
  ```
- Modified `getWorkflowDebugSummary` to:
  - Fetch `allEvents` (not just `recentEvents`) from store
  - Call `this.computeTrinityStageStates(allEvents)` to compute per-stage states
  - Include `trinityStageStates` in returned summary object
- Added `computeTrinityStageStates` private method:
  - Scans events for `trinity_${stage}_start`, `trinity_${stage}_complete`, `trinity_${stage}_failed`
  - Returns array with `status: 'pending'|'running'|'completed'|'failed'` per stage
  - Extracts `reason` and `completedAt` from failed/completed events

**Verification:**
- `grep -n "trinityStageStates" types.ts` → line 344
- `grep -n "computeTrinityStageStates" nocturnal-workflow-manager.ts` → line 624 (call), 680 (method definition)

## Deviations from Plan

None - plan executed exactly as written.

## Threat Surface Scan

| Flag | File | Description |
|------|------|-------------|
| NOC-15: StubFallbackRuntimeAdapter | nocturnal-workflow-manager.ts | New adapter class calling internal stub functions; stubs are pure CPU local computation, no external I/O |

## Self-Check

- [x] evolution-worker.ts: NocturnalWorkflowManager import + startWorkflow call verified
- [x] nocturnal-workflow-manager.ts: StubFallbackRuntimeAdapter + fallbackOccurred verified
- [x] types.ts: trinityStageStates in WorkflowDebugSummary verified
- [x] nocturnal-trinity.ts: invokeStubDreamer/Philosopher/Scribe exported verified
- [x] Commit 5441597: NOC-14 changes exist
- [x] Commit bf51b82: NOC-15+NOC-16 changes exist
- [x] TypeScript compiles without errors in modified files

## Test Infrastructure

Pre-existing errors in `src/hooks/subagent.ts` (TS2339: `debug` property, TS2304: `LEGACY_FALLBACK_MAX_AGE_MS`) are outside plan scope and not addressed.
