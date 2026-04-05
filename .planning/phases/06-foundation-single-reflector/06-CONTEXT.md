# Phase 6: Foundation and Single-Reflector Mode - Context

**Gathered:** 2026-04-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Create `NocturnalWorkflowManager` that wraps `OpenClawTrinityRuntimeAdapter` in the `WorkflowManager` interface, enabling unified subagent lifecycle management for nocturnal reflection. The manager implements the single-reflector path (useTrinity=false) in Phase 6 — Trinity integration comes in Phase 7.

**In scope:** NOC-01, NOC-02, NOC-03, NOC-04, NOC-05
**Out of scope:** Trinity multi-stage chain (Phase 7), Phase 8 persistence, Phase 9 evolution-worker integration

</domain>

<decisions>
## Implementation Decisions

### Transport type
- **D-01:** Use existing `'runtime_direct'` transport type
- NocturnalWorkflowManager follows the same transport pattern as Empathy/DeepReflect
- RuntimeDirectDriver won't actually spawn sessions (TrinityRuntimeAdapter manages its own), but transport type stays uniform

### Result type
- **D-02:** Single unified `NocturnalResult` type (not discriminated union)
- Structure mirrors what `executeNocturnalReflectionAsync` returns today:
  - `success: boolean`
  - `artifact?: TrinityDraftArtifact`
  - `diagnostics: { persistedPath, sessionSnapshot, ... }`
  - `skipReason?: string`
  - `noTargetSelected?: boolean`
  - `validationFailures?: string[]`
- Simpler than discriminated union, direct mapping from existing code

### Timeout and TTL
- **D-03:** `timeoutMs: 15 * 60 * 1000` (15 minutes)
- **D-04:** `ttlMs: 30 * 60 * 1000` (30 minutes)
- Rationale: Trinity chain = 3 stages × 180s = 9min minimum. 15min timeout accommodates model latency. 30min TTL before orphan sweep gives buffer for snapshot extraction, artifact writing, and cleanup.

### WorkflowStore event types
- **D-05:** Use nocturnal-specific event types (not generic 'workflow_*')
- Events to record:
  - `nocturnal_started` — when workflow is created and TrinityRuntimeAdapter is invoked
  - `nocturnal_completed` — when artifact is successfully persisted
  - `nocturnal_failed` — when chain fails or validation fails
  - `nocturnal_fallback` — when single-reflector fallback is triggered
  - `nocturnal_expired` — when sweepExpiredWorkflows marks workflow as expired

### sweepExpiredWorkflows behavior
- **D-06:** On expiration: mark state as 'expired' in WorkflowStore + clean partial artifact files
- Partial artifacts identified by workflowId prefix in stateDir
- TrinityRuntimeAdapter handles its own internal session cleanup — no external session cleanup needed
- No degrade signal emission on sweep (Phase 9 handles fallback integration)

### NocturnalWorkflowSpec definition
- **D-07:** `workflowType: 'nocturnal'`
- **D-08:** `transport: 'runtime_direct'`
- **D-09:** `shouldDeleteSessionAfterFinalize: false` (no external session to delete)
- `buildPrompt` returns empty string ( Nocturnal doesn't use prompt injection — it extracts from trajectory)
- `parseResult` extracts from `executeNocturnalReflectionAsync` result structure
- `persistResult` writes artifact to WorkflowStore trajectory

### NocturnalWorkflowManager composition
- **D-10:** Does NOT extend EmpathyObserverWorkflowManager
- Composes `TrinityRuntimeAdapter` directly via constructor options (not via RuntimeDirectDriver)
- Implements full `WorkflowManager` interface: `startWorkflow`, `notifyWaitResult`, `finalizeOnce`, `sweepExpiredWorkflows`, `getWorkflowDebugSummary`, `dispose`
- `notifyWaitResult` is a no-op for nocturnal (no wait-on-run pattern — TrinityRuntimeAdapter is synchronous within its own session management)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Workflow Manager Interface
- `packages/openclaw-plugin/src/service/subagent-workflow/types.ts` — WorkflowManager interface, SubagentWorkflowSpec, WorkflowState types

### Existing Workflow Manager Patterns
- `packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` — Pattern for implementing WorkflowManager
- `packages/openclaw-plugin/src/service/subagent-workflow/runtime-direct-driver.ts` — RuntimeDirectDriver pattern
- `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts` — WorkflowStore for event persistence

### Nocturnal Trinity
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — OpenClawTrinityRuntimeAdapter, TrinityRuntimeAdapter interface, TrinityConfig
- `packages/openclaw-plugin/src/service/nocturnal-service.ts` — executeNocturnalReflectionAsync function

### Evolution Worker (current caller)
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — Current direct call to executeNocturnalReflectionAsync (will be updated in Phase 9)

### Requirements
- `.planning/REQUIREMENTS.md` §v1.5 — NOC-01 through NOC-05 specifications

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `WorkflowManager` interface: already defined, NocturnalWorkflowManager implements it
- `WorkflowStore`: existing SQLite persistence for workflow events
- `RuntimeDirectDriver`: not directly used by nocturnal (adapter composed directly) but pattern reference
- `OpenClawTrinityRuntimeAdapter`: already exists, will be injected into NocturnalWorkflowManager

### Established Patterns
- EmpathyObserverWorkflowManager: 30s timeout, 5min TTL — reference for lifecycle
- DeepReflectWorkflowManager: same pattern
- Both use RuntimeDirectDriver for session management (nocturnal deviates — adapter manages sessions internally)

### Integration Points
- `evolution-worker.ts` (line ~975-981): currently calls `executeNocturnalReflectionAsync` directly — Phase 9 will route through NocturnalWorkflowManager instead
- `nocturnal-service.ts`: provides `executeNocturnalReflectionAsync` which NocturnalWorkflowManager wraps for single-reflector path

</code_context>

<specifics>
## Specific Ideas

- "NocturnalWorkflowManager is a NEW file in `subagent-workflow/`" (from STATE.md Accumulated Context)
- "Manager composes `TrinityRuntimeAdapter` directly, not via TransportDriver" (from STATE.md Key Constraints)
- "NocturnalWorkflowManager does NOT extend EmpathyObserverWorkflowManager" (from STATE.md Key Constraints)
- "Fallback degrades to stub (not EmpathyObserver/DeepReflect)" (from STATE.md Key Constraints)

</specifics>

<deferred>
## Deferred Ideas

### Phase 7: Trinity Integration
- Trinity multi-stage chain (Dreamer → Philosopher → Scribe) — NOC-06 through NOC-10
- NocturnalWorkflowManager will need `runTrinityAsync` path in addition to single-reflector
- `nocturnal_failed` event should include `TrinityStageFailure[]` in payload

### Phase 9: Evolution Worker Integration
- NOC-14: evolution-worker.ts switching from direct `executeNocturnalReflectionAsync` call to `NocturnalWorkflowManager.startWorkflow()`
- NOC-15: Degrade behavior definition — Trinity failure → stub fallback

</deferred>

---
*Phase: 06-foundation-single-reflector*
*Context gathered: 2026-04-05*
