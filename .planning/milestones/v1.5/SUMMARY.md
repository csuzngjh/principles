# Project Research Summary

**Project:** NocturnalWorkflowManager (v1.5)
**Domain:** Multi-stage subagent workflow orchestration (Trinity 3-stage chain)
**Researched:** 2026-04-05
**Confidence:** HIGH

## Executive Summary

NocturnalWorkflowManager is a new WorkflowManager implementation that wraps Trinity (Dreamer -> Philosopher -> Scribe) to integrate it into the existing subagent-workflow helper system. Trinity was designed as a standalone pipeline that bypasses the WorkflowManager state machine entirely; this integration bridges that gap by recording Trinity stage events to the shared WorkflowStore and providing the same lifecycle interface (startWorkflow, notifyWaitResult, finalizeOnce, sweepExpiredWorkflows) used by EmpathyObserver and DeepReflect.

The recommended approach is composition over adaptation: NocturnalWorkflowManager composes TrinityRuntimeAdapter directly rather than forcing Trinity into the TransportDriver abstraction. No new dependencies are needed -- all required modules (TrinityRuntimeAdapter, WorkflowStore, WorkflowManager interface) already exist. The key architectural constraint is that NocturnalWorkflowManager is a net-new file that implements WorkflowManager independently; it does NOT extend EmpathyObserverWorkflowManager because Trinity has fundamentally different lifecycle semantics (3 sequential stages, no single runId, fire-and-forget async).

The primary risk is that Trinity stages currently bypass the WorkflowManager state machine entirely, leaving workflows stuck in "active" forever. This must be addressed in the initial implementation, not added later. The secondary risk is missing idempotency for Philosopher and Scribe stages, which could cause non-deterministic artifacts on retry.

## Key Findings

### Recommended Stack

No new external dependencies. NocturnalWorkflowManager composes existing validated modules from the plugin codebase. The key architectural decision is bypassing TransportDriver entirely -- TrinityRuntimeAdapter handles its own session lifecycle internally, so forcing it into RuntimeDirectDriver would be anti-architectural.

**Core technologies:**
- `TrinityRuntimeAdapter` (via `OpenClawTrinityRuntimeAdapter`) -- stage invocation interface for Dreamer/Philosopher/Scribe; already production-ready, no changes needed
- `WorkflowStore` -- SQLite event persistence reused for Trinity stage events; no schema changes needed
- `WorkflowManager` interface (from `types.ts`) -- NocturnalWorkflowManager implements this contract
- `runTrinityAsync` (from `nocturnal-service.ts`) -- async Trinity execution path with adapter; the manager calls this, not the polling-based driver pattern

**What to build:**
- New file: `nocturnal-workflow-manager.ts` implementing WorkflowManager, composing TrinityRuntimeAdapter
- New type: `NocturnalWorkflowResult` wrapping `TrinityResult` for workflow spec contract
- New `TrinityStageEvent` payload types for WorkflowStore event recording
- Do NOT add `'trinity'` to `WorkflowTransport` union type -- that type is for runtime_direct paradigm only

### Expected Features

**Must have (table stakes):**
- Single-reflector fallback mode -- wraps existing `invokeStubReflector`; reuses `TrinityConfig.useTrinity: false` path from service (LOW complexity)
- Basic workflow lifecycle -- implements `startWorkflow`, `notifyWaitResult`, `finalizeOnce`, `sweepExpiredWorkflows` using existing WorkflowStore and patterns (LOW complexity)
- Trinity stage result parsing -- adapter already extracts DreamerOutput/PhilosopherOutput/Scribe artifact; manager routes through arbiter/executability pipeline (MEDIUM complexity)
- Trinity telemetry propagation -- `TrinityTelemetry` already constructed by `runTrinityAsync`; manager passes through `NocturnalRunDiagnostics` (LOW complexity)

**Should have (competitive):**
- Full Trinity chain with real subagent execution -- requires runtimeAdapter in options; `runTrinityAsync` with `OpenClawTrinityRuntimeAdapter` (HIGH complexity but adapter already exists)
- Tournament selection with threshold validation -- deterministic winner from ranked candidates via `runTournament()` (MEDIUM complexity, internal to stub Scribe)
- Multi-stage progress tracking -- track Dreamer -> Philosopher -> Scribe separately with fail-closed on stage failure (MEDIUM complexity)

**Defer (v2+):**
- Real-time stage progress callbacks -- requires extending WorkflowManager interface or adding callbacks; not aligned with current API patterns
- Partial result salvage on Philosopher failure -- would add complexity; current design is fail-closed intentionally
- Tournament trace visibility -- `TournamentTraceEntry[]` in workflow debug summary for explainability

### Architecture Approach

NocturnalWorkflowManager is a net-new file in `subagent-workflow/` that implements WorkflowManager independently from EmpathyObserver/DeepReflect. The core architectural constraint: Trinity is a 3-stage pipeline with fundamentally different lifecycle semantics than single-shot workflows -- it has no single runId, uses fire-and-forget async, and NocturnalService handles its own artifact persistence. Attempting to extend RuntimeDirectDriver or force Trinity into TransportDriver creates anti-patterns.

**Major components:**
1. `NocturnalWorkflowManager` (NEW) -- implements WorkflowManager, composes TrinityRuntimeAdapter, records Trinity stage events to WorkflowStore, manages outer lifecycle (pending -> active -> finalizing -> completed/terminal_error)
2. `NocturnalService` (existing) -- owns Trinity pipeline orchestration and artifact persistence; wrapped by manager, NOT modified in behavior
3. `OpenClawTrinityRuntimeAdapter` (existing) -- adapts plugin subagent API to TrinityRuntimeAdapter interface; creates/waits/deletes sessions per stage internally
4. `WorkflowStore` (existing) -- SQLite persistence reused for Trinity stage events (trinity_dreamer_start, trinity_philosopher_complete, etc.)

### Critical Pitfalls

1. **Trinity bypasses WorkflowManager state machine** -- Trinity's OpenClawTrinityRuntimeAdapter executes stages without recording state transitions. Workflows stay "active" forever. Prevention: NocturnalWorkflowManager must call recordEvent() after each stage and update workflow state appropriately.

2. **Stage failure leaves workflow stuck in "active"** -- if Philosopher fails, runTrinityAsync returns early with success:false but WorkflowStore never updates. Prevention: implement stage-level failure handling that transitions workflow to terminal_error and records TrinityStageFailure[].

3. **No idempotency for Philosopher and Scribe** -- only Dreamer session uses idempotencyKey. If Philosopher times out but succeeded server-side, re-invoking creates duplicate rankings. Prevention: derive idempotency keys per-stage from parent workflow + stage + input hash.

4. **No intermediate result persistence between stages** -- DreamerOutput passed in-memory to Philosopher. Crash after Dreamer success loses output, re-running regenerates new candidates. Prevention: persist each stage output to WorkflowStore after completion; reload on restart.

5. **No observable chain execution for external monitors** -- runTrinityAsync is fire-and-forget; external callers see no progress between "active" and finalization. Prevention: emit lifecycle events after each stage (stage_dreamer_completed, etc.).

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Foundation and Single-Reflector Mode
**Rationale:** Start with the lowest-risk path that validates the manager pattern works. Single-reflector mode (useTrinity: false) reuses existing invokeStubReflector logic and does not require TrinityRuntimeAdapter integration. This establishes the WorkflowManager interface contract without multi-stage complexity.

**Delivers:** NocturnalWorkflowManager implementing WorkflowManager with single-reflector path. Basic lifecycle (startWorkflow, finalizeOnce, sweepExpiredWorkflows). Same artifact persistence pattern as service.

**Addresses:** Single-reflector NocturnalWorkflowManager (P1), Basic workflow lifecycle (P1), Nocturnal artifact persistence (P1) from FEATURES.

**Avoids:** Stage-related pitfalls (2-5) are not yet relevant; no multi-stage execution yet.

### Phase 2: Trinity Integration with Event Recording
**Rationale:** Now integrate real Trinity via runTrinityAsync. The critical implementation requirement: every Trinity stage must record events to WorkflowStore. This addresses Pitfall 1 (Trinity bypasses state machine) and sets up stage failure handling. Cannot skip this because workflows would be stuck active forever.

**Delivers:** NocturnalWorkflowManager with TrinityRuntimeAdapter injection. Trinity stage events recorded (trinity_dreamer_start, trinity_dreamer_complete, trinity_philosopher_start, etc.). Workflow state transitions (active -> finalizing -> completed/terminal_error). Basic stage failure handling.

**Uses:** OpenClawTrinityRuntimeAdapter, runTrinityAsync, WorkflowStore recordEvent().

**Avoids:** Pitfall 1 (Trinity bypasses state machine) -- each stage now records events. Pitfall 7 (no observability) -- stage events enable external monitoring.

**Research flag:** Phase 2 likely needs deeper research on stage failure recovery paths (exact state transitions when Philosopher fails mid-chain).

### Phase 3: Intermediate Persistence and Idempotency
**Rationale:** After Trinity integration works end-to-end, add crash recovery capability. Persist DreamerOutput and PhilosopherOutput to WorkflowStore so restart/retry does not regenerate candidates. Add per-stage idempotency keys. This addresses Pitfalls 3 and 4 which are not acceptable for production.

**Delivers:** Stage output persistence to WorkflowStore. Per-stage idempotency keys. Crash-recovery path that resumes from last completed stage.

**Avoids:** Pitfall 3 (no idempotency for Philosopher/Scribe). Pitfall 4 (no intermediate persistence). Dreamer output loss on crash.

**Research flag:** Phase 3 needs validation of idempotency assumptions (are Philosopher/Scribe truly idempotent with same inputs?).

### Phase 4: Fallback and Evolution Worker Integration
**Rationale:** Replace direct executeNocturnalReflectionAsync call in evolution-worker.ts with NocturnalWorkflowManager.startWorkflow(). Define fallback behavior when Trinity fails. Current design falls back to stubs within Trinity, not to single-stage WorkflowManager -- Phase 4 should decide if this is acceptable or if fallback should delegate to EmpathyObserver/DeepReflect.

**Delivers:** EvolutionWorker uses NocturnalWorkflowManager exclusively for sleep_reflection tasks. Fallback behavior documented and implemented. getWorkflowDebugSummary includes Trinity stage status.

**Avoids:** Pitfall 5 (fallback bypasses single-stage manager) -- either document as acceptable or implement proper delegation.

### Phase Ordering Rationale

- Phase 1 (single-reflector) before Phase 2 (Trinity) -- validate manager contract without multi-stage complexity
- Phase 2 before Phase 3 -- must have working Trinity before worrying about crash recovery
- Phase 3 before Phase 4 -- idempotency and persistence must exist before integrating into evolution worker
- All phases use existing modules (no new dependencies), so no separate dependency resolution phase needed

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3:** Stage idempotency validation -- need to verify Philosopher/Scribe produce same output on re-invocation with same inputs. May need code changes to adapter if not currently deterministic.
- **Phase 4:** Fallback behavior decision -- current design (stub-only fallback) may be intentional; needs explicit decision from product requirements.

Phases with standard patterns (skip research-phase):
- **Phase 1:** Single-reflector workflow lifecycle follows established EmpathyObserver/DeepReflect patterns exactly.
- **Phase 2:** Trinity stage event recording follows existing WorkflowStore event pattern; state machine transitions are well-defined in types.ts.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All modules exist and are production-validated; no new dependencies. Architecture decision (bypass TransportDriver) is well-reasoned in STACK.md |
| Features | HIGH | Based on code analysis of existing nocturnal-service.ts, nocturnal-trinity.ts, empathy-observer-workflow-manager.ts |
| Architecture | HIGH | Clear component boundaries; build order (types -> manager -> evolution-worker) is logical and non-cyclic |
| Pitfalls | HIGH | Based on code analysis of runtime-direct-driver.ts, nocturnal-trinity.ts, and review of runtime_path_closure (4/5) |

**Overall confidence:** HIGH

### Gaps to Address

- **TrinityRuntimeAdapter idempotency for Philosopher/Scribe:** Current adapter was not analyzed for idempotent re-invocation. Phase 3 must validate or implement this.
- **Fallback behavior specification:** Whether Trinity failure should fall back to single-stage workflow manager is an open product decision, not a technical gap. Needs requirements input.
- **Stage timeout configuration:** Trinity stage timeout is 180s per stage (per FEATURES). Not clear if this is configurable or hardcoded. Should be surfaced in options.

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` -- TrinityRuntimeAdapter interface, OpenClawTrinityRuntimeAdapter, runTrinityAsync (1300+ lines)
- `packages/openclaw-plugin/src/service/nocturnal-service.ts` -- executeNocturnalReflectionAsync, Trinity vs single-reflector decision logic
- `packages/openclaw-plugin/src/service/subagent-workflow/types.ts` -- WorkflowManager interface, SubagentWorkflowSpec
- `packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` -- Existing WorkflowManager implementation pattern
- `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts` -- SQLite schema, event recording
- `packages/openclaw-plugin/src/service/subagent-workflow/runtime-direct-driver.ts` -- TransportDriver pattern

### Secondary (HIGH confidence)
- `ops/ai-sprints/.../reviewer-b.md` -- runtime_path_closure: 4/5, relevant architectural review findings
- `docs/design/2026-03-31-subagent-workflow-helper-design.md` -- referenced design doc for workflow helper system

---
*Research completed: 2026-04-05*
*Ready for roadmap: yes*
