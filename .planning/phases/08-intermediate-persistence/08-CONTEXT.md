# Phase 8: Intermediate Persistence and Idempotency - Context

**Gathered:** 2026-04-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Persist Trinity intermediate outputs (DreamerOutput, PhilosopherOutput) to WorkflowStore so interrupted workflows can resume from completed stages on restart. Enable deterministic stage skipping via idempotency keys.

**In scope:** NOC-11, NOC-12, NOC-13
**Out of scope:** Evolution worker integration (Phase 9), real-time stage progress callbacks (NOC-17), partial result salvage on Philosopher failure (NOC-18)
</domain>

<decisions>
## Implementation Decisions

### Stage output storage (NOC-11)
- **D-17:** New `subagent_workflow_stage_outputs` SQLite table in WorkflowStore
- Schema: `workflow_id TEXT`, `stage TEXT` ('dreamer'|'philosopher'), `output_json TEXT`, `idempotency_key TEXT`, `created_at INTEGER`
- `workflow_id` is a foreign key to `subagent_workflows(workflow_id)`
- `idempotency_key` is indexed for fast lookups before stage re-run
- `output_json` stores the full `DreamerOutput` / `PhilosopherOutput` JSON
- Phase 7 already records stage events; this adds output payload persistence

### Idempotency key strategy (NOC-12)
- **D-18:** Deterministic key = `SHA-256(workflowId + stage + inputDigest)`
- `inputDigest` for Dreamer: `SHA-256(snapshot.sessionId + principleId + maxCandidates)`
- `inputDigest` for Philosopher: `SHA-256(workflowId + dreamerOutputJson)` (includes dreamer output)
- On stage start, query `stage_outputs` for matching `idempotency_key`. If found, skip stage and use stored output.
- Idempotency key is stored alongside output in `stage_outputs` row

### Crash recovery trigger (NOC-13)
- **D-19:** On `startWorkflow`, before launching Trinity chain:
  1. Query `stage_outputs` for any existing rows with this `workflow_id`
  2. If rows found: derive completed stages from stored outputs (Dreamer → Philosopher → Scribe chain)
  3. Skip completed stages by feeding stored outputs directly into next stage
  4. Only run stages whose outputs are not yet in `stage_outputs`
- Recovery is idempotent: if outputs exist, they are reused; no double-execution risk
- If `workflow_id` has no rows in `stage_outputs`, run full Trinity chain from scratch

### WorkflowStore schema additions
- **D-20:** Add `subagent_workflow_stage_outputs` table to WorkflowStore
- New method: `recordStageOutput(workflowId, stage, output, idempotencyKey)` — stores stage output
- New method: `getStageOutputs(workflowId)` — returns all stored outputs for a workflow
- New method: `getStageOutputByKey(idempotencyKey)` — returns output for a given idempotency key

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### NocturnalWorkflowManager (Phase 6-7 foundation)
- `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` — Phase 6-7 implementation; NOC-11/12/13 add stage output persistence to `startWorkflow` and `notifyWaitResult`
- `packages/openclaw-plugin/src/service/subagent-workflow/types.ts` — WorkflowManager interface, SubagentWorkflowSpec, WorkflowState types

### Trinity Runtime
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — `runTrinityAsync`, `DreamerOutput`, `PhilosopherOutput`, `TrinityDraftArtifact`, `TrinityStageFailure`, `TrinityTelemetry`
- `DreamerOutput`: `{ valid, candidates, reason, generatedAt }` — NOC-11 persist candidates array
- `PhilosopherOutput`: `{ valid, judgments, overallAssessment, reason, generatedAt }` — NOC-11 persist judgments array

### Workflow Store
- `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts` — Current schema: `subagent_workflows`, `subagent_workflow_events`; NOC-11 adds `subagent_workflow_stage_outputs` table

### Requirements
- `.planning/REQUIREMENTS.md` §v1.5 — NOC-11, NOC-12, NOC-13 specifications

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `WorkflowStore`: existing SQLite persistence layer — needs new table + new methods
- `NocturnalWorkflowManager.startWorkflow`: already has Trinity async path; needs stage output persistence added
- `runTrinityAsync`: already called in Phase 7; needs output capture + storage injected

### Established Patterns
- Phase 7 `recordStageEvents`: batch records events from `TrinityResult.telemetry` after chain completes
- Phase 7 stores `pendingTrinityResults` in Map for use by `notifyWaitResult`
- `TrinityRuntimeAdapter.invokeDreamer/invokePhilosopher/invokeScribe` return structured JSON types already defined

### Integration Points
- `nocturnal-workflow-manager.ts`: `startWorkflow` → after Trinity chain completes → store outputs in `stage_outputs` before `notifyWaitResult`
- `nocturnal-workflow-manager.ts`: `startWorkflow` → before Trinity chain starts → check `stage_outputs` for recovered outputs → skip completed stages
- `workflow-store.ts`: new `recordStageOutput`, `getStageOutputs`, `getStageOutputByKey` methods

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---
*Phase: 08-intermediate-persistence*
*Context gathered: 2026-04-06*
