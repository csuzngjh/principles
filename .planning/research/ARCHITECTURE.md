# Architecture Research: NocturnalWorkflowManager Integration

**Domain:** Subagent Workflow Helper System with Multi-Stage Trinity Chain
**Researched:** 2026-04-05
**Confidence:** HIGH

## Executive Summary

The existing `subagent-workflow` architecture (WorkflowManager + RuntimeDirectDriver + WorkflowStore) is a proven pattern for managing subagent lifecycle with event sourcing. NocturnalWorkflowManager should be a **new file** (not an extension of existing managers) because Nocturnal's Trinity chain is fundamentally different: it runs three sequential subagent stages internally, not one subagent per workflow.

The key integration points are:
1. **Event recording**: Record Trinity stage events to the existing WorkflowStore event log
2. **Runtime adapter**: Pass `OpenClawTrinityRuntimeAdapter` (already exists) to the nocturnal-service
3. **Parent session tracking**: Link Nocturnal artifacts back to the sleep_reflection task via metadata
4. **Result persistence**: NocturnalService handles its own artifact persistence; the workflow manager handles only the outer lifecycle

---

## Standard Architecture (Existing)

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Evolution Worker                                 │
│  (evolution-worker.ts — owns sleep_reflection task queue)           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  WorkflowManager Interface (types.ts)                        │   │
│  │  - startWorkflow, notifyWaitResult, finalizeOnce, sweep     │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│                              │ implements                            │
│  ┌──────────────────────────▼───────────────────────────────────┐   │
│  │  EmpathyObserverWorkflowManager / DeepReflectWorkflowManager  │   │
│  │  - 1 subagent = 1 workflow                                    │   │
│  │  - scheduleWaitPoll, finalizeOnce, persistResult              │   │
│  └──────────┬─────────────────────────┬────────────────────────┘   │
│             │ uses                     │ uses                          │
│  ┌──────────▼──────────┐  ┌───────────▼────────────────────────┐   │
│  │ RuntimeDirectDriver │  │ WorkflowStore (SQLite)              │   │
│  │ - run, wait,        │  │ - createWorkflow, recordEvent,      │   │
│  │   getResult, cleanup│  │   updateWorkflowState               │   │
│  └─────────────────────┘  └────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ NocturnalService                                              │   │
│  │ - executeNocturnalReflectionAsync                            │   │
│  │ - Owns Trinity pipeline (Dreamer→Philosopher→Scribe)        │   │
│  │ - Owns artifact persistence                                   │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│                              │ uses                                  │
│  ┌──────────────────────────▼───────────────────────────────────┐   │
│  │ OpenClawTrinityRuntimeAdapter                                │   │
│  │ - invokeDreamer, invokePhilosopher, invokeScribe            │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Notes |
|-----------|----------------|-------|
| `WorkflowManager` (interface) | Defines contract for workflow lifecycle | Not instantiated directly |
| `EmpathyObserverWorkflowManager` | Manages single-shot empathy subagent workflows | Pattern reference |
| `DeepReflectWorkflowManager` | Manages single-shot deep-reflect subagent workflows | Pattern reference |
| `RuntimeDirectDriver` | Thin wrapper over `PluginRuntimeSubagent` API | run, wait, getResult, cleanup |
| `WorkflowStore` | SQLite persistence for workflows + event log | State machine + event sourcing |
| `NocturnalService` | Owns the Trinity reflection pipeline | Does NOT follow WorkflowManager interface |
| `OpenClawTrinityRuntimeAdapter` | Adapts plugin subagent API to TrinityRuntimeAdapter interface | Already exists in nocturnal-trinity.ts |
| `EvolutionWorker` | Owns sleep_reflection task queue; calls NocturnalService directly | Does NOT use WorkflowManager for Nocturnal |

---

## Recommended Project Structure

```
packages/openclaw-plugin/src/
├── service/
│   ├── subagent-workflow/
│   │   ├── types.ts                    # WorkflowManager interface + specs
│   │   ├── workflow-store.ts           # SQLite event store
│   │   ├── runtime-direct-driver.ts    # Transport driver
│   │   ├── empathy-observer-workflow-manager.ts
│   │   ├── deep-reflect-workflow-manager.ts
│   │   └── nocturnal-workflow-manager.ts   # NEW: Trinity-aware workflow
│   └── nocturnal-service.ts            # Trinity pipeline orchestrator
└── core/
    └── nocturnal-trinity.ts            # TrinityRuntimeAdapter + stages
```

### Structure Rationale

- **`subagent-workflow/`**: Contains all workflow helpers. NocturnalWorkflowManager goes here because it IS a WorkflowManager implementation, even though its internal execution model differs.
- **`nocturnal-workflow-manager.ts`**: NEW file. It wraps NocturnalService to satisfy the WorkflowManager interface, recording Trinity stage events to the shared WorkflowStore.

---

## Architectural Patterns

### Pattern 1: Event-Sourced Workflow State Machine

**What:** Every workflow state transition is recorded as an immutable event in SQLite.

**When to use:** All subagent workflows (empathy, deep-reflect, nocturnal).

**Trade-offs:**
- Pros: Full audit trail, debuggability, idempotent state recovery
- Cons: More storage, event replay complexity

**Implementation:**
```typescript
// In WorkflowStore
recordEvent(workflowId, 'state_change', fromState, toState, reason, payload);

// In NocturnalWorkflowManager — record Trinity stages
store.recordEvent(workflowId, 'trinity_dreamer_start', 'active', 'active', 'starting dreamer', { principleId });
store.recordEvent(workflowId, 'trinity_dreamer_complete', 'active', 'active', 'dreamer completed', { candidateCount });
store.recordEvent(workflowId, 'trinity_philosopher_start', 'active', 'active', 'starting philosopher', {});
store.recordEvent(workflowId, 'trinity_artifact_approved', 'active', 'finalizing', 'artifact passed arbiter', { artifactId });
```

### Pattern 2: Transport Driver Abstraction

**What:** `RuntimeDirectDriver` wraps the subagent API. The workflow manager knows nothing about OpenClaw internals.

**When to use:** All subagent workflows.

**Trade-offs:**
- Pros: Swappable transport (future: message queue, remote agent)
- Cons: Another abstraction layer to trace

**Implementation:**
```typescript
// NocturnalWorkflowManager uses OpenClawTrinityRuntimeAdapter internally
// which IS a TrinityRuntimeAdapter, which wraps api.runtime.subagent.*
// So NocturnalWorkflowManager does NOT need its own RuntimeDirectDriver
// because NocturnalService handles Trinity stage execution internally
```

### Pattern 3: Multi-Stage Chain via TrinityRuntimeAdapter

**What:** Nocturnal's Trinity chain (Dreamer -> Philosopher -> Scribe) is orchestrated by `runTrinityAsync` using a `TrinityRuntimeAdapter`. The adapter is injected into NocturnalService.

**When to use:** Nocturnal workflow only. Empathy/deep-reflect are single-stage.

**Trade-offs:**
- Pros: Clean separation between pipeline orchestration and subagent invocation
- Cons: Three subagent sessions means three session lifecycle events

**Key insight:** The TrinityRuntimeAdapter (already implemented as `OpenClawTrinityRuntimeAdapter`) is created in the EvolutionWorker and passed to NocturnalService:
```typescript
// EvolutionWorker line 976
const runtimeAdapter = api ? new OpenClawTrinityRuntimeAdapter(api) : undefined;
await executeNocturnalReflectionAsync(wctx.workspaceDir, wctx.stateDir, { runtimeAdapter });
```

---

## Data Flow

### Current Nocturnal Call Path (EvolutionWorker)

```
EvolutionWorker.tick()
    │
    ├─► For each sleep_reflection task
    │       │
    │       ├─► Create OpenClawTrinityRuntimeAdapter(api)
    │       │
    │       └─► executeNocturnalReflectionAsync(workspaceDir, stateDir, { runtimeAdapter })
    │               │
    │               └─► NocturnalService.runTrinityAsync()
    │                       │
    │                       ├─► adapter.invokeDreamer() ─► subagent.run() ─► wait ─► getSessionMessages
    │                       ├─► adapter.invokePhilosopher() ─► subagent.run() ─► wait ─► getSessionMessages
    │                       └─► adapter.invokeScribe() ─► subagent.run() ─► wait ─► getSessionMessages
    │
    └─► Task marked completed/failed
```

### Proposed NocturnalWorkflowManager Integration

```
External Caller (e.g., EvolutionWorker or a future scheduler)
    │
    └─► NocturnalWorkflowManager.startWorkflow(spec, options)
            │
            ├─► Create workflow record in WorkflowStore
            │       workflow_type: 'nocturnal-trinity'
            │       state: 'active'
            │       metadata: { parentSessionId, principleId, ... }
            │
            ├─► Record 'trinity_chain_start' event
            │
            ├─► Call NocturnalService.executeNocturnalReflectionAsync()
            │       └─► Pass OpenClawTrinityRuntimeAdapter (from api in closure)
            │
            └─► Return WorkflowHandle (workflowId, childSessionKey=null, runId=undefined)
                    // Note: No single runId because Trinity has 3 stages
```

**Wait result handling differs:** NocturnalWorkflowManager does NOT use `scheduleWaitPoll` because Trinity is not a single subagent run. Instead:
- NocturnalService internally waits for each stage
- Final result is obtained synchronously within `executeNocturnalReflectionAsync`
- `notifyWaitResult` maps to the overall Trinity success/failure

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|-------------------|-------|
| OpenClaw Plugin API | `OpenClawTrinityRuntimeAdapter` holds `api` in closure | Already implemented |
| SQLite (WorkflowStore) | Shared database via `WorkflowStore` | Same `.state/subagent_workflows.db` |
| NocturnalService | Injected into NocturnalWorkflowManager | Not changed |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|--------------|-------|
| EvolutionWorker -> NocturnalService | Direct function call | Current path: `executeNocturnalReflectionAsync(..., { runtimeAdapter })` |
| EvolutionWorker -> NocturnalWorkflowManager | WorkflowManager interface | NEW: wraps NocturnalService to satisfy interface |
| NocturnalWorkflowManager -> WorkflowStore | Method calls (createWorkflow, recordEvent) | Records Trinity stage events |
| NocturnalService -> TrinityRuntimeAdapter | Interface method calls | Already defined in nocturnal-trinity.ts |
| TrinityRuntimeAdapter -> OpenClaw API | `api.runtime.subagent.*` | 3 stage sessions, each cleaned up |

---

## New vs. Modified Files

| File | Action | Reason |
|------|--------|--------|
| `subagent-workflow/nocturnal-workflow-manager.ts` | **NEW** | Cannot extend EmpathyObserver/DeepReflect; Trinity is fundamentally different (3 stages, no single runId) |
| `subagent-workflow/types.ts` | MODIFY | Add `NocturnalWorkflowOptions` interface, `NocturnalResult` type, `TrinityStageEvent` payload type |
| `nocturnal-service.ts` | MODIFY | Add `NocturnalWorkflowResult` type that wraps `NocturnalRunResult`; no behavioral changes |
| `evolution-worker.ts` | MODIFY | Replace direct `executeNocturnalReflectionAsync` call with `nocturnalWorkflowManager.startWorkflow()` |

---

## Suggested Build Order

1. **types.ts** — Add Nocturnal-specific types to shared interface file
2. **nocturnal-workflow-manager.ts** — Implement new WorkflowManager that wraps NocturnalService
3. **evolution-worker.ts** — Swap direct NocturnalService call for workflow manager (backward-compatible refactor)

**Why this order:** Types first (no deps), NocturnalWorkflowManager depends on types, EvolutionWorker is the consumer and changes last.

---

## Trinity Stage Events for WorkflowStore

Record these events to provide full auditability of Trinity chain execution:

| Event Type | When | Payload |
|------------|------|---------|
| `trinity_chain_start` | Before Dreamer | `{ principleId, sessionId }` |
| `trinity_dreamer_start` | Dreamer invoked | `{ principleId }` |
| `trinity_dreamer_complete` | Dreamer returns | `{ valid, candidateCount, reason? }` |
| `trinity_dreamer_failed` | Dreamer throws/errors | `{ error }` |
| `trinity_philosopher_start` | Philosopher invoked | `{}` |
| `trinity_philosopher_complete` | Philosopher returns | `{ valid, judgmentCount }` |
| `trinity_philosopher_failed` | Philosopher throws/errors | `{ error }` |
| `trinity_scribe_start` | Scribe invoked | `{}` |
| `trinity_scribe_complete` | Scribe returns | `{ artifactProduced: boolean }` |
| `trinity_artifact_approved` | Passed arbiter | `{ artifactId }` |
| `trinity_artifact_rejected` | Failed arbiter | `{ failures: string[] }` |
| `trinity_finalized` | Complete | `{ success, artifactId?, skipReason? }` |

---

## Anti-Patterns

### Anti-Pattern 1: Trying to Make NocturnalWorkflowManager Extend EmpathyObserverWorkflowManager

**What people do:** Inheritance attempt because both are WorkflowManagers.

**Why it's wrong:** EmpathyObserverWorkflowManager assumes a single subagent run with one runId, one wait, one parse. Trinity has 3 sequential subagent invocations, no single runId, and NocturnalService handles its own artifact persistence.

**Do this instead:** Create a new class that implements WorkflowManager independently, reusing only WorkflowStore and the interface contract.

### Anti-Pattern 2: Calling NocturnalService Directly from Business Logic

**What people do:** Bypass WorkflowManager interface for Nocturnal because it "doesn't fit the pattern."

**Why it's wrong:** Breaks observability (no events recorded), makes testing harder, and introduces inconsistency with other workflows.

**Do this instead:** Wrap NocturnalService in NocturnalWorkflowManager to satisfy the interface, even though the internal execution differs.

### Anti-Pattern 3: Recording Trinity Stage Events in NocturnalService Instead of WorkflowManager

**Why it's wrong:** NocturnalService should remain portable (could be called from tests without a WorkflowManager). Events are the workflow manager's responsibility.

**Do this instead:** NocturnalService returns structured result; NocturnalWorkflowManager records relevant events to WorkflowStore.

---

## Sources

- `packages/openclaw-plugin/src/service/subagent-workflow/types.ts` — WorkflowManager interface definition
- `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts` — Event recording + SQLite schema
- `packages/openclaw-plugin/src/service/subagent-workflow/runtime-direct-driver.ts` — TransportDriver interface
- `packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` — Concrete implementation pattern
- `packages/openclaw-plugin/src/service/subagent-workflow/deep-reflect-workflow-manager.ts` — Concrete implementation pattern
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — TrinityRuntimeAdapter interface + OpenClawTrinityRuntimeAdapter
- `packages/openclaw-plugin/src/service/nocturnal-service.ts` — NocturnalService.executeNocturnalReflectionAsync
- `packages/openclaw-plugin/src/service/evolution-worker.ts` (line 975) — Current Nocturnal call site
