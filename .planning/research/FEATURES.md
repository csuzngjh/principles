# Feature Research

**Domain:** NocturnalWorkflowManager - multi-stage nocturnal reflection helper
**Researched:** 2026-04-05
**Confidence:** HIGH (code analysis of existing implementations)

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Single-reflector fallback mode | Phase 6 design: Trinity must degrade gracefully when `useTrinity: false` | LOW | Reuses `invokeStubReflector` from `nocturnal-service.ts`. Uses same `TrinityConfig.useTrinity: false` path. |
| Basic workflow lifecycle management | Existing helpers (EmpathyObserver, DeepReflect) all implement `WorkflowManager` interface with `startWorkflow`, `notifyWaitResult`, `finalizeOnce`, `sweepExpiredWorkflows` | LOW | `NocturnalWorkflowManager` must implement same interface for consistency |
| Trinity stage result parsing | Trinity output is structured JSON (DreamerOutput, PhilosopherOutput, Scribe artifact). `OpenClawTrinityRuntimeAdapter.parseDreamerOutput`, `parsePhilosopherOutput`, `parseScribeOutput` extract results | MEDIUM | Parse logic already exists in adapter. Manager needs to route parsed results through arbiter/executability pipeline |
| Trinity telemetry recording | `TrinityTelemetry` tracks `chainMode`, `dreamerPassed`, `philosopherPassed`, `scribePassed`, `candidateCount`, `stageFailures` | LOW | Telemetry already constructed by `runTrinity` / `runTrinityAsync`. Manager just needs to propagate it through `NocturnalRunDiagnostics` |
| Async Trinity execution | Real subagent execution via `runTrinityAsync` + `TrinityRuntimeAdapter`. `executeNocturnalReflectionAsync` in service shows the pattern | MEDIUM | Requires adapter to be passed through manager options. Sync path (`runTrinity`) only works with stubs |

### Differentiators (Competitive Advantage)

Features that set the product apart. Not required, but valuable.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Full Trinity chain with real subagent execution | Dreamer generates candidates, Philosopher ranks them, Scribe synthesizes. Higher quality artifacts than single-reflector | HIGH | Requires `TrinityRuntimeAdapter` (already exists as `OpenClawTrinityRuntimeAdapter`). Not stub-only. Stage timeout is 180s per stage |
| Tournament selection with threshold validation | Deterministic winner selection from ranked candidates. `runTournament()` in `nocturnal-candidate-scoring.ts` applies `ScoringWeights` + threshold checks | MEDIUM | Tournament is internal to stub Scribe. Real adapter Scribe does synthesis, not tournament (tournament logic stays in stub path) |
| Multi-stage progress tracking | Track Dreamer → Philosopher → Scribe separately. Fail fast on stage failure (fail-closed design) | MEDIUM | Current `WorkflowManager` interface has no multi-stage concept. Each Trinity stage is a separate subagent invocation with its own session |
| Configurable chain mode | `useTrinity: true/false` controls whether multi-stage or single-reflector. `maxCandidates` controls candidate count | LOW | Already in `TrinityConfig`. Manager just needs to accept and pass through config |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Reusing single-stage `WorkflowManager` for Trinity | Apparent code reuse, simpler implementation | Trinity is a 3-stage pipeline, not 3 separate single-stage workflows. State machine, timeouts, and finalization all differ fundamentally | Create separate `NocturnalWorkflowManager` that wraps Trinity internally, not extending existing managers |
| Trinity-to-single-reflector fallback on stage failure | Resilience, "something works" mentality | Phase 6 design: malformed Trinity output fails the entire chain closed. This is intentional - low quality from fallback is worse than no artifact | Let Trinity fail. `nocturnal-service.ts` already implements fail-closed. Manager should not implement fallback |
| Managing Trinity stages as independent `WorkflowHandle`s | Makes each stage independently observable | Stages are dependent - Philosopher needs Dreamer output, Scribe needs both. Independent handles break the dependency chain | Single `WorkflowHandle` for the whole Trinity run. Internal stage status tracked in `TrinityTelemetry` not in workflow store |
| Real-time streaming of stage outputs | Better UX, visibility into progress | Current runtime API (`waitForRun`) is blocking. Streaming would require different API surface. Not aligned with existing patterns | Log stage completion at INFO level. Telemetry records stage outcomes |

## Feature Dependencies

```
[TrinityRuntimeAdapter]
    └──provides──> [invokeDreamer / invokePhilosopher / invokeScribe]

[NocturnalWorkflowManager]
    └──uses──> [TrinityRuntimeAdapter] (when useStubs: false)
    └──uses──> [runTrinityAsync] (async path with adapter)
    └──uses──> [runTrinity] (sync path, stubs only)

[NocturnalService]
    └──calls──> [NocturnalWorkflowManager.startWorkflow]
    └──calls──> [TrinityRuntimeAdapter.invokeDreamer/Philosopher/Scribe] (via runTrinityAsync)

[Single-reflector mode]
    └──uses──> [invokeStubReflector] (not a workflow, direct call in service)

[Trinity chain] ──conflicts──> [Single-reflector fallback]
    (cannot run both simultaneously; useTrinity flag selects one)
```

### Dependency Notes

- **TrinityRuntimeAdapter requires RuntimeDirectDriver-subagent:** `OpenClawTrinityRuntimeAdapter` uses `api.runtime.subagent.run/waitForRun/getSessionMessages/deleteSession`. This is the same API surface as `RuntimeDirectDriver` but wrapped differently
- **NocturnalWorkflowManager needs TrinityRuntimeAdapter:** Unlike EmpathyObserver/DeepReflect which use `RuntimeDirectDriver` directly, Nocturnal wraps Trinity which wraps the adapter
- **Single-reflector bypasses manager:** When `useTrinity: false`, `nocturnal-service.ts` calls `invokeStubReflector` directly, not `NocturnalWorkflowManager`. This is an internal service call, not a workflow
- **Trinity fail-closed eliminates manager fallback responsibility:** Manager does not need to implement fallback logic - the service already fails the chain if Trinity fails

## MVP Definition

### Launch With (v1)

Minimum viable product - what is needed to validate the concept.

- [ ] **Single-reflector NocturnalWorkflowManager** - Wraps existing `invokeStubReflector` behavior. Implements `WorkflowManager` interface. `workflowType: 'nocturnal-single'`. Minimal since this path already exists in service
- [ ] **Basic workflow lifecycle** - `startWorkflow`, `notifyWaitResult`, `finalizeOnce`, `sweepExpiredWorkflows` using existing `WorkflowStore` and `RuntimeDirectDriver` patterns
- [ ] **Nocturnal artifact persistence** - Same as service: write approved artifact to `.state/nocturnal/samples/{artifactId}.json`, register via `registerSample`

### Add After Validation (v1.x)

Features to add once core is working.

- [ ] **Async Trinity with runtimeAdapter** - When `runtimeAdapter` is provided in options, NocturnalWorkflowManager calls `runTrinityAsync` instead of stub path. Pass adapter through manager options
- [ ] **Trinity telemetry propagation** - Expose `TrinityTelemetry` through `NocturnalRunDiagnostics` in workflow result. Already constructed by `runTrinity` - manager just needs to pass it through
- [ ] **Multi-stage session cleanup** - Each Trinity stage (`ne-dreamer-*`, `ne-philosopher-*`, `ne-scribe-*`) creates and deletes its own session. Already handled by `OpenClawTrinityRuntimeAdapter.close()`

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] **Real-time stage progress callbacks** - Notify caller as each Trinity stage completes (Dreamer done, Philosopher done, Scribe done). Would require extending `WorkflowManager` interface or adding callbacks
- [ ] **Partial result salvage on Philosopher failure** - If Philosopher fails but Dreamer produced valid candidates, could retry Philosopher with same Dreamer output. Currently fail-closed, but could be a config option
- [ ] **Tournament trace visibility** - Expose `TournamentTraceEntry[]` in workflow debug summary for explainability

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Single-reflector NocturnalWorkflowManager | HIGH - validates manager pattern works | LOW - reuses existing service logic | P1 |
| Basic workflow lifecycle | HIGH - required for evolution worker integration | LOW - copy from EmpathyObserver/DeepReflect | P1 |
| Nocturnal artifact persistence | HIGH - core value delivery | LOW - same as service persistence | P1 |
| Async Trinity with runtimeAdapter | MEDIUM - full Trinity value | MEDIUM - adapter already exists, needs wiring | P2 |
| Trinity telemetry propagation | MEDIUM - debugging, observability | LOW - pass-through | P2 |
| Multi-stage session cleanup | MEDIUM - resource management | LOW - adapter.close() already handles | P2 |
| Stage progress callbacks | LOW - nice visibility | HIGH - interface change needed | P3 |
| Partial result salvage | LOW - edge case | MEDIUM - would add complexity | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## Competitor Feature Analysis

This is internal infrastructure (plugin helper system), not a user-facing product. Competitor analysis is N/A for this domain.

Instead, the relevant comparison is **Trinity vs Single-Reflector**:

| Aspect | Trinity | Single-Reflector |
|--------|---------|-------------------|
| Stages | 3 (Dreamer, Philosopher, Scribe) | 1 (stub reflector) |
| Candidate generation | Multiple alternatives (up to 3) | Single artifact |
| Selection mechanism | Philosopher ranking + tournament | Direct generation |
| Quality | Higher (principle-grounded critique) | Lower (synthetic, no critique) |
| Failure mode | Fail-closed on any stage malformation | Fallback to synthetic |
| Real execution | Requires runtimeAdapter | Always available (stub) |
| Complexity | HIGH (3 subagent invocations) | LOW (direct generation) |

## Key Architectural Differences from Existing Helpers

### EmpathyObserverWorkflowManager / DeepReflectWorkflowManager
- Single subagent invocation
- `RuntimeDirectDriver` manages lifecycle directly
- `SubagentWorkflowSpec` drives prompt building, parsing, persistence
- `shouldFinalizeOnWaitStatus: (status) => status === 'ok'`

### NocturnalWorkflowManager (Trinity mode)
- Three sequential subagent invocations via `TrinityRuntimeAdapter`
- `runTrinityAsync` orchestrates the chain internally
- Does NOT use `SubagentWorkflowSpec` (Trinity has its own config/spec system)
- Does NOT use `RuntimeDirectDriver` directly (adapter wraps it)
- Result is `NocturnalRunResult` (includes artifact, diagnostics, telemetry)
- Arbiter + executability validation happens inside service, not manager

### NocturnalWorkflowManager (Single-reflector mode)
- Can reuse `invokeStubReflector` directly (no subagent call needed)
- OR can wrap in single-shot workflow using `RuntimeDirectDriver`
- Simpler than Trinity mode

## Sources

- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` - TrinityRuntimeAdapter interface, stage contracts, runTrinityAsync
- `packages/openclaw-plugin/src/service/nocturnal-service.ts` - Pipeline orchestration, stub reflector, Trinity vs single-reflector decision logic
- `packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` - Existing WorkflowManager pattern
- `packages/openclaw-plugin/src/service/subagent-workflow/deep-reflect-workflow-manager.ts` - Second existing WorkflowManager pattern
- `packages/openclaw-plugin/src/service/subagent-workflow/types.ts` - SubagentWorkflowSpec, WorkflowManager interface

---
*Feature research for: NocturnalWorkflowManager - Trinity multi-stage helper*
*Researched: 2026-04-05*
