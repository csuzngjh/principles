# Phase 7: Trinity Integration with Event Recording - Context

**Gathered:** 2026-04-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Enable `useTrinity=true` in NocturnalWorkflowManager to run the full Dreamer→Philosopher→Scribe chain. Inject `OpenClawTrinityRuntimeAdapter` via constructor options. Record per-stage Trinity events to WorkflowStore. Handle stage failures with `terminal_error` state and embedded `TrinityStageFailure[]`.

**In scope:** NOC-06, NOC-07, NOC-08, NOC-09, NOC-10
**Out of scope:** Stage result persistence (Phase 8), evolution-worker integration (Phase 9)
</domain>

<decisions>
## Implementation Decisions

### Trinity runtime injection
- **D-11:** Inject `OpenClawTrinityRuntimeAdapter` via `NocturnalWorkflowOptions.runtimeAdapter`
- Runtime adapter already passed in constructor; no new injection pattern needed
- Phase 6 already composes adapter directly, not via RuntimeDirectDriver

### Trinity async execution path
- **D-12:** `startWorkflow` returns immediately with `state: 'active'`
- Full Trinity chain runs asynchronously (via `runTrinityAsync`)
- `notifyWaitResult` becomes the real async callback (no longer a no-op)
- When Trinity chain completes, `notifyWaitResult('ok')` is called
- On stage failure, `notifyWaitResult('error', reason)` is called

### Stage event recording strategy
- **D-13:** Stage events recorded AFTER Trinity chain completes (batch from TrinityResult)
- Parse `TrinityResult.telemetry` and `TrinityResult.failures[]` to derive stage events
- Events to record:
  - `trinity_dreamer_start` — when Dreamer stage begins
  - `trinity_dreamer_complete` — when Dreamer completes successfully
  - `trinity_dreamer_failed` — when Dreamer fails
  - `trinity_philosopher_start` — when Philosopher stage begins
  - `trinity_philosopher_complete` — when Philosopher completes successfully
  - `trinity_philosopher_failed` — when Philosopher fails
  - `trinity_scribe_start` — when Scribe stage begins
  - `trinity_scribe_complete` — when Scribe completes successfully
  - `trinity_scribe_failed` — when Scribe fails
- No separate callback infrastructure needed — post-hoc parsing of TrinityResult

### Stage failure handling
- **D-14:** On any stage failure, workflow enters `terminal_error` state immediately
- `nocturnal_failed` event includes `TrinityStageFailure[]` in payload (per NOC-09)
- No partial artifact preservation for failed stages (Phase 8 handles persistence)
- No fallback to single-reflector on stage failure

### Workflow state machine transitions
- **D-15:** Trinity chain running = `active` state
- Chain complete successfully → `finalizing` → `completed`
- Any stage failure → `terminal_error`
- Timeout → `terminal_error`
- Full state machine: `pending` → `active` → `finalizing` → `completed` OR `terminal_error`

### TrinityResult integration
- **D-16:** `NocturnalResult` type already mirrors `NocturnalRunResult`
- `TrinityResult` telemetry and failures are embedded in `NocturnalResult.trinityTelemetry`
- `NOC-08` satisfied by parsing `TrinityResult.telemetry` for stage events

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### NocturnalWorkflowManager (Phase 6 foundation)
- `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` — Phase 6 implementation, D-01 through D-10 decisions
- `packages/openclaw-plugin/src/service/subagent-workflow/types.ts` — WorkflowManager interface, SubagentWorkflowSpec, NocturnalResult type

### Trinity Runtime
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — `runTrinityAsync`, `TrinityResult`, `TrinityStageFailure`, `TrinityTelemetry`, `TrinityConfig`
- `packages/openclaw-plugin/src/service/nocturnal-service.ts` — `executeNocturnalReflectionAsync` (single-reflector path)

### Workflow Store
- `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts` — WorkflowStore event recording

### Requirements
- `.planning/REQUIREMENTS.md` §v1.5 — NOC-06 through NOC-10 specifications

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `NocturnalWorkflowManager`: already exists, needs Trinity path added to `startWorkflow`
- `TrinityRuntimeAdapter` interface: already defined and implemented by `OpenClawTrinityRuntimeAdapter`
- `WorkflowStore`: existing event recording API
- `runTrinityAsync`: already exists in `nocturnal-trinity.ts`

### Established Patterns
- Phase 6 `startWorkflow`: synchronous single-reflector, returns completed handle immediately
- Phase 6 `notifyWaitResult`: no-op (needs to become real callback for Phase 7)
- Existing `TrinityStageFailure[]` in `TrinityResult.failures` already captures per-stage errors
- `TrinityTelemetry` already tracks `dreamerPassed`, `philosopherPassed`, `scribePassed` flags

### Integration Points
- `nocturnal-workflow-manager.ts` line 191-202: `useTrinity: false` hardcoded → needs to accept via options/config
- `nocturnal-workflow-manager.ts` line 198-202: `executeNocturnalReflectionAsync` → `runTrinityAsync` for Trinity path
- `notifyWaitResult` (currently no-op) → needs real implementation for async stage reporting

</code_context>

<deferred>
## Deferred Ideas

### Phase 8: Intermediate Persistence
- NOC-11: Persist DreamerOutput and PhilosopherOutput to WorkflowStore
- NOC-12: Stage idempotency key generation
- NOC-13: Crash recovery — skip completed stages on restart

### Phase 9: Evolution Worker Integration
- NOC-14: evolution-worker.ts routing through NocturnalWorkflowManager
- NOC-15: Degrade behavior — Trinity failure → stub fallback

</deferred>

---
*Phase: 07-trinity-integration*
*Context gathered: 2026-04-05*
