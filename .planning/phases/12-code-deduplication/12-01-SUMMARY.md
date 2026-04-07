---
phase: "12"
plan: "01"
type: execute
subsystem: openclaw-plugin
tags: [refactor, inheritance, workflow-manager, typescript]
dependency_graph:
  requires: []
  provides:
    - id: "workflow-manager-base"
      path: "packages/openclaw-plugin/src/service/subagent-workflow/workflow-manager-base.ts"
      type: "shared-base-class"
  affects:
    - "packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts"
    - "packages/openclaw-plugin/src/service/subagent-workflow/deep-reflect-workflow-manager.ts"
tech_stack:
  added:
    - TypeScript class inheritance pattern
  patterns:
    - Template Method pattern (protected hooks for subclass customization)
    - Shared base class for duplicate code elimination
key_files:
  created:
    - path: "packages/openclaw-plugin/src/service/subagent-workflow/workflow-manager-base.ts"
      lines: 555
      provides: "Shared base class with all workflow lifecycle, state management, and store operations"
  modified:
    - path: "packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts"
      before: 674
      after: 307
      delta: -367
    - path: "packages/openclaw-plugin/src/service/subagent-workflow/deep-reflect-workflow-manager.ts"
      before: 581
      after: 197
      delta: -384
decisions:
  - id: "base-class-hooks"
    decision: "Use protected createWorkflowMetadata hook instead of passing metadata builder to constructor"
    rationale: "Keeps constructor simple while allowing subclasses to customize metadata content"
  - id: "surface-checks-override"
    decision: "Subclasses override startWorkflow to perform surface-degrade checks before calling super.startWorkflow()"
    rationale: "Clean separation - base class doesn't know about type-specific surface degrades"
  - id: "generate-workflow-id-override"
    decision: "Subclasses override generateWorkflowId for their specific ID prefix pattern"
    rationale: "EmpathyObserver uses 'wf_' prefix, DeepReflect uses 'wf_dr_' prefix - different patterns"
completed: "2026-04-07T03:31:23Z"
duration: "~3 minutes"
---

# Phase 12 Plan 01: WorkflowManagerBase Extraction Summary

## Objective

Extract a `WorkflowManagerBase` class from the shared code of `EmpathyObserverWorkflowManager` and `DeepReflectWorkflowManager`. Both managers implement the same polling-based workflow lifecycle with `RuntimeDirectDriver`. The base class contains all shared state, lifecycle methods, and store operations, reducing ~750 lines of duplicated code across the two managers.

## What Was Built

**WorkflowManagerBase** (555 lines) - shared base class providing:
- **Constructor** accepts `workflowType`, `sessionPrefix`, `defaultTimeoutMs`, `defaultTtlMs` as params
- **Protected fields**: `store`, `driver`, `logger`, `workspaceDir`, `workflowType`, `activeWorkflows`, `completedWorkflows`, `workflowSpecs`
- **Shared methods**:
  - `startWorkflow` - full workflow creation + polling setup
  - `buildRunParams` - builds RunParams for driver.run()
  - `scheduleWaitPollWithRetry` - dynamic timeout with exponential backoff
  - `notifyWaitResult` - handles wait completion, calls finalizeOnce
  - `notifyLifecycleEvent` - delegates to notifyWaitResult on subagent_ended
  - `finalizeOnce` - reads result, parses, persists, cleans up
  - `sweepExpiredWorkflows` - orphan TTL cleanup
  - `getWorkflowDebugSummary` - compact debug view
  - `generateWorkflowId` - protected, subclasses override for prefix
  - `buildChildSessionKey` - builds child session key from parent
  - `isCompleted` - 1-minute dedup window check
  - `markCompleted` - clears timeout, sets timestamp, deletes spec
  - `dispose` - clears all timeouts and maps, disposes store
- **Protected hooks**: `createWorkflowMetadata` and `createWorkflowRecord` for subclass customization

**EmpathyObserverWorkflowManager** refactored (674 → 307 lines, -367):
- Now extends `WorkflowManagerBase`
- Removed: private fields, all lifecycle methods, dynamic-timeout imports
- Override `startWorkflow` for surface-degrade checks (boot session, subagent availability)
- Override `createWorkflowMetadata` for EmpathyObserver-specific metadata
- Override `generateWorkflowId` returns `wf_` prefix
- Retained: `extractAssistantText`, `parseEmpathyPayload`, `buildEmpathyPrompt`, `empathyObserverWorkflowSpec`, helper functions

**DeepReflectWorkflowManager** refactored (581 → 197 lines, -384):
- Now extends `WorkflowManagerBase`
- Removed: private fields, all lifecycle methods, dynamic-timeout/workflow-store imports
- Override `startWorkflow` for surface-degrade checks (boot session, subagent availability, transport check)
- Override `generateWorkflowId` returns `wf_dr_` prefix
- Retained: `deepReflectWorkflowSpec`, `DeepReflectTaskInput`, `DeepReflectBuildPromptContext` interfaces

## Commits

| Hash | Task | Files |
|------|------|-------|
| `5b7d28a` | Task 1: Create WorkflowManagerBase class | workflow-manager-base.ts (new, 555 lines) |
| `267f32a` | Task 2: Refactor EmpathyObserverWorkflowManager to extend base | empathy-observer-workflow-manager.ts (674→307, -367 lines) |
| `cbac734` | Task 3: Refactor DeepReflectWorkflowManager to extend base | deep-reflect-workflow-manager.ts (581→197, -384 lines) |

## Verification

- TypeScript compilation passes with no errors
- Both managers correctly extend `WorkflowManagerBase`
- All lifecycle methods delegated to base class
- No duplicate private fields remain in either manager
- EmpathyObserver-specific and DeepReflect-specific code retained
- Surface-degrade checks preserved in subclass overrides

## Deviations from Plan

None - plan executed exactly as written.

## Threat Surface

No new security surface introduced. This is a pure refactoring (inheritance extraction) with no behavioral changes.
