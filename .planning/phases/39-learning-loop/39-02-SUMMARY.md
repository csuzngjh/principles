---
phase: "39"
plan: "02"
type: execute
subsystem: keyword-learning
tags:
  - keyword-learning
  - correction-cue
  - optimization-workflow
dependency_graph:
  requires:
    - Plan 39-01 (CorrectionCueLearner with FPR counters)
  provides:
    - CorrectionObserverWorkflowManager for LLM optimization dispatch
    - CorrectionObserver types: Payload, Result, WorkflowSpec
  affects:
    - packages/openclaw-plugin/src/service/subagent-workflow/index.ts
tech_stack:
  added:
    - CorrectionObserverPayload interface
    - CorrectionObserverResult interface
    - CorrectionObserverWorkflowSpec interface
    - CorrectionObserverWorkflowManager class extending WorkflowManagerBase
    - createCorrectionObserverWorkflowManager() factory
    - correctionObserverWorkflowSpec with LLM prompt for keyword optimization
  patterns:
    - Follows EmpathyObserverWorkflowManager pattern
    - Uses WorkflowManagerBase base class
    - Runtime direct transport for LLM subagent dispatch
key_files:
  created:
    - packages/openclaw-plugin/src/service/subagent-workflow/correction-observer-types.ts
    - packages/openclaw-plugin/src/service/subagent-workflow/correction-observer-workflow-manager.ts
  modified:
    - packages/openclaw-plugin/src/service/subagent-workflow/index.ts
decisions:
  - id: CORR-07
    decision: "CorrectionObserverWorkflowManager follows established WorkflowManagerBase pattern"
    rationale: "CORR-07: Reuse proven pattern for LLM subagent workflow dispatch"
  - id: CORR-09
    decision: "Workflow manager returns CorrectionObserverResult; caller applies updates"
    rationale: "CORR-09: Separation between LLM dispatch and store mutation"
metrics:
  duration_minutes: ~8
  completed_date: "2026-04-14"
  tasks_completed: 3
  files_created: 2
  files_modified: 1
  ts_errors: 0 (after import path fixes)
---

# Phase 39 Plan 02: CorrectionObserver Workflow - Summary

## What Was Built

### Types (Task 1)
- `CorrectionObserverPayload`: Input for LLM optimization subagent (workspaceDir, keywordStoreSummary, recentMessages)
- `CorrectionObserverResult`: Optimization decisions from LLM (updates map, summary)
- `CorrectionObserverWorkflowSpec`: Extends SubagentWorkflowSpec with workflowType 'correction_observer'

### Workflow Manager (Task 2)
- `CorrectionObserverWorkflowManager` extends `WorkflowManagerBase`
- `createCorrectionObserverWorkflowManager()` factory function
- `correctionObserverWorkflowSpec` with built prompt asking LLM to recommend ADD/UPDATE/REMOVE actions
- Follows same pattern as EmpathyObserverWorkflowManager

### Barrel Export (Task 3)
- Exports CorrectionObserverWorkflowManager, createCorrectionObserverWorkflowManager, correctionObserverWorkflowSpec
- Exports types: CorrectionObserverPayload, CorrectionObserverResult, CorrectionObserverWorkflowSpec

## Commits

| Hash | Message |
|------|---------|
| `f96ff737` | fix(39-02): correct import paths for correction-observer workflow files |

Note: Commits f74cb0d1, d0f08975, 8869cf61 were created on main branch (wrong location) - content was copied and fixed in f96ff737.

## Verification

- TypeScript: `tsc --noEmit` passes (0 errors)
- grep verifications all pass:
  - `CorrectionObserverPayload` in correction-observer-types.ts
  - `CorrectionObserverResult` in correction-observer-types.ts
  - `CorrectionObserverWorkflowManager` in correction-observer-workflow-manager.ts
  - `createCorrectionObserverWorkflowManager` in barrel export

## Note

evolution-worker.ts integration (keyword_optimization periodic task trigger) was discussed in must_haves but not implemented in this plan. The CorrectionObserverWorkflowManager is ready for integration when evolution-worker.ts is updated in a future phase.
