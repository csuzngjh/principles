---
phase: "09"
status: ready_for_planning
source: STATE.md accumulated context
---

# Phase 09: Fallback and Evolution Worker Integration — Context

**Status:** Ready for planning
**Source:** STATE.md accumulated context + ROADMAP.md

## Phase Boundary

Phase 09 completes the NocturnalWorkflowManager by integrating the Fallback worker (NOC-14) and Evolution worker (NOC-15, NOC-16). This is the final integration phase for v1.5.

## Requirements (from STATE.md)

| NOC | Description |
|-----|-------------|
| NOC-14 | Fallback worker integration |
| NOC-15 | Evolution worker — principle learning |
| NOC-16 | Evolution worker — trajectory extraction |

## Key Context (from STATE.md Accumulated Context)

- NocturnalWorkflowManager composes TrinityRuntimeAdapter directly (not via TransportDriver)
- TransportDriver NOT used for Trinity — manager composes TrinityRuntimeAdapter directly via options
- Fallback degrades to stub (not EmpathyObserver/DeepReflect)
- NocturnalWorkflowManager does NOT extend EmpathyObserverWorkflowManager
- No new dependencies — all existing modules
- Do NOT add 'trinity' to WorkflowTransport union type

## Implementation Decisions

### Phase 9 Architecture
- Fallback worker: stub-based fallback when Trinity stages fail
- Evolution worker: principle learning from session trajectories; trajectory extraction for future session optimization

### Constraints
- No new dependencies
- Must work within existing NocturnalWorkflowManager structure
- Integration with existing WorkflowStore for state persistence

## Canonical References

- `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` — NocturnalWorkflowManager (modified in Phase 08)
- `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts` — WorkflowStore with stage output persistence (Phase 08)
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — TrinityRuntimeAdapter interface
