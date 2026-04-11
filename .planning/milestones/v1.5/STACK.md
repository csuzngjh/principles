# Stack Research: NocturnalWorkflowManager

**Domain:** Multi-stage subagent workflow orchestration (Trinity 3-stage chain)
**Researched:** 2026-04-05
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

No new external dependencies. NocturnalWorkflowManager composes existing validated capabilities:

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `TrinityRuntimeAdapter` | existing (nocturnal-trinity.ts) | Stage invocation interface | Already implemented; OpenClawTrinityRuntimeAdapter is the production adapter |
| `WorkflowStore` | existing (workflow-store.ts) | SQLite event persistence | Already validated; reuse for workflow state machine |
| `WorkflowManager` | existing (types.ts) | Workflow lifecycle interface | Already defined; NocturnalWorkflowManager implements it |
| `RuntimeDirectDriver` | existing (runtime-direct-driver.ts) | Session primitive reuse | Reuse `run()`/`wait()`/`getResult()`/`cleanup()` patterns if adapter delegates to subagent runtime |

### Supporting Libraries

No new supporting libraries needed. All required modules already exist in the codebase:

| Library | Purpose | When to Use |
|---------|---------|-------------|
| `WorkflowStore` | SQLite workflow event persistence | Always — reuse existing, no changes needed |
| `RuntimeDirectDriver` | Session primitive re-use | Only if adapter needs to delegate session management; not required |
| `nocturnal-trinity.ts` | TrinityRuntimeAdapter + runTrinityAsync | Always — core production artifact |
| `nocturnal-candidate-scoring.ts` | Tournament selection | Already called by stub Scribe; no changes |

## What to Build

### 1. New File: `nocturnal-workflow-manager.ts`

Implements `WorkflowManager` interface. Composes `TrinityRuntimeAdapter` rather than wrapping it as a `TransportDriver`.

**Key design points:**
- `startWorkflow()` calls `runTrinityAsync()` (async, not polling-based)
- Does NOT use `RuntimeDirectDriver` polling loop — Trinity stages handle their own session lifecycle internally
- `startWorkflow()` returns immediately with a `WorkflowHandle`; actual Trinity execution is fire-and-forget
- Result is `TrinityResult` (from nocturnal-trinity.ts), not a single-shot parse

```typescript
// Structure
export interface NocturnalWorkflowOptions {
  workspaceDir: string;
  logger: PluginLogger;
  runtimeAdapter: TrinityRuntimeAdapter;  // OpenClawTrinityRuntimeAdapter
}

export class NocturnalWorkflowManager implements WorkflowManager {
  // startWorkflow: calls runTrinityAsync(), stores workflow in WorkflowStore
  // notifyWaitResult: not used (Trinity stages are not polling-based)
  // notifyLifecycleEvent: used for Trinity failure reporting
  // finalizeOnce: reads TrinityResult from store, persists TrinityDraftArtifact
  // sweepExpiredWorkflows: reuses existing WorkflowStore sweep logic
  // getWorkflowDebugSummary: reuses existing WorkflowStore query logic
  // dispose: clears timers, disposes store
}
```

### 2. New Type: `NocturnalWorkflowResult`

Wraps `TrinityResult` (already defined in nocturnal-trinity.ts) for the workflow spec contract:

```typescript
export interface NocturnalWorkflowResult {
  success: boolean;
  artifact?: TrinityDraftArtifact;
  telemetry?: TrinityResult['telemetry'];
  failures: TrinityStageFailure[];
}
```

### 3. Workflow State Machine (reuse existing states)

Reuse `WorkflowState` from `types.ts`. Trinity chain maps to these states:
- `pending` → workflow created, Trinity not yet started
- `active` → Trinity running (Dreamer/Philosopher/Scribe stages)
- `wait_result` → Trinity completed, waiting to finalize
- `finalizing` → parsing result, persisting artifact
- `completed` / `terminal_error` → terminal states

### 4. New `WorkflowTransport` variant? No.

`NocturnalWorkflowManager` does NOT use `TransportDriver`. It calls `TrinityRuntimeAdapter` directly. Adding a `'trinity'` transport variant to `WorkflowTransport` would imply a new driver, which is unnecessary. The manager bypasses `TransportDriver` entirely.

**Do NOT add `'trinity'` to `WorkflowTransport` union type.** That type is for the existing `runtime_direct` paradigm.

## Integration Points

### TrinityRuntimeAdapter (existing)

`OpenClawTrinityRuntimeAdapter` is the production adapter. It already:
- Creates ephemeral sessions per stage (`ne-dreamer-`, `ne-philosopher-`, `ne-scribe-`)
- Runs `run()` → `waitForRun()` → `getSessionMessages()` → `deleteSession()` per stage
- Handles JSON extraction and parsing for each stage output

No changes needed to `TrinityRuntimeAdapter` or `OpenClawTrinityRuntimeAdapter`.

### nocturnal-service.ts (existing)

`executeNocturnalReflectionAsync()` already accepts `runtimeAdapter: TrinityRuntimeAdapter`. The new `NocturnalWorkflowManager` is a parallel integration path — it wraps the adapter as a `WorkflowManager` rather than being called from `nocturnal-service.ts` directly.

The evolution worker will likely call `NocturnalWorkflowManager.startWorkflow()` instead of (or in addition to) `executeNocturnalReflectionAsync()`.

### WorkflowStore (existing)

Reuse existing `WorkflowStore`:
- `createWorkflow()` — for initial workflow record
- `recordEvent()` — for stage transitions (dreamer_started, philosopher_started, scribe_started, etc.)
- `updateWorkflowState()` — for state transitions
- `getWorkflow()` / `getEvents()` — for `getWorkflowDebugSummary()`
- `getExpiredWorkflows()` — for `sweepExpiredWorkflows()`

No changes to `WorkflowStore` schema.

## Driver Architecture Decision: Extend RuntimeDirectDriver vs. New Class

**Decision: Neither — NocturnalWorkflowManager bypasses TransportDriver entirely.**

Rationale:

1. **TransportDriver is single-shot.** `run()` → `wait()` → `getResult()` → `cleanup()` is a 1:1 mapping between workflow and session. Trinity is 3 sequential stages, each with its own session managed internally by `OpenClawTrinityRuntimeAdapter`.

2. **OpenClawTrinityRuntimeAdapter already handles session lifecycle.** It creates, waits, reads, and deletes sessions for each stage internally. Exposing it as a `TransportDriver` would require unwinding its internal session management, which is anti-architectural.

3. **No polling needed.** `EmpathyObserverWorkflowManager` uses `scheduleWaitPoll()` because it needs to poll for a single subagent completion. Trinity stages each call `waitForRun()` internally during `invokeDreamer()`/`invokePhilosopher()`/`invokeScribe()`. The manager just calls `runTrinityAsync()` and waits for the Promise.

4. **TrinityRuntimeAdapter is already the right abstraction.** It has `invokeDreamer`, `invokePhilosopher`, `invokeScribe` — exactly what the manager needs. Forcing it into `TransportDriver` would be a square-peg/round-hole problem.

**What this means:**
- No new `MultiStageDriver` class
- No extension of `RuntimeDirectDriver`
- `NocturnalWorkflowManager` directly composes `TrinityRuntimeAdapter` and calls `runTrinityAsync()`

## Alternatives Considered

| Approach | Verdict | Why |
|----------|---------|-----|
| Extend `RuntimeDirectDriver` for multi-stage | Avoid | Driver is single-shot by design; multi-stage would require reworking the polling model entirely |
| Create `MultiStageDriver` implementing `TransportDriver` | Avoid | TrinityAdapter manages sessions internally; exposing as driver would require unwinding session lifecycle |
| Force TrinityRuntimeAdapter to implement TransportDriver | Avoid | 3-stage chain semantics don't map to run/wait/getResult/cleanup; adapter would become incoherent |
| New `'trinity'` transport type | Avoid | No existing driver would use it; adds complexity without benefit |

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `MultiStageDriver` class | Unnecessary indirection; TrinityAdapter already handles multi-stage | `NocturnalWorkflowManager` composes `TrinityRuntimeAdapter` directly |
| `'trinity'` in `WorkflowTransport` union | No driver would use it; adds type complexity | Bypass `TransportDriver` entirely |
| Changes to `TrinityRuntimeAdapter` or `OpenClawTrinityRuntimeAdapter` | Already production-ready | No changes needed |
| New `WorkflowStore` schema fields | Existing schema is sufficient | Reuse as-is |
| Polling loop in `NocturnalWorkflowManager` | Trinity stages poll internally via `waitForRun()` | `runTrinityAsync()` returns a Promise; just await it |

## Phase-Specific Notes

**For this milestone (adding NocturnalWorkflowManager to existing subagent-workflow helper system):**

1. No new dependencies — entirely composes existing validated modules
2. Reuse `WorkflowManager` interface, `WorkflowStore`, and `TrinityRuntimeAdapter`
3. Do NOT try to fit Trinity into `SubagentWorkflowSpec` — Trinity is not a single-shot workflow; it has fundamentally different lifecycle semantics
4. The key architectural choice is composition over adaptation: manager → TrinityRuntimeAdapter directly, bypassing `TransportDriver`
