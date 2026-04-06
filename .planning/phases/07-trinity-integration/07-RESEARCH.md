# Phase 7: Trinity Integration with Event Recording - Research

**Researched:** 2026-04-05
**Domain:** NocturnalWorkflowManager Trinity path + WorkflowStore event recording
**Confidence:** HIGH

## Summary

Phase 7 upgrades NocturnalWorkflowManager from synchronous single-reflector execution (Phase 6) to asynchronous Trinity chain execution (Dreamer -> Philosopher -> Scribe). The key architectural shift is that `startWorkflow` must return immediately with `state='active'` while the Trinity chain runs in the background. When the chain completes, `notifyWaitResult` is called with the result, which triggers state transitions and batch stage event recording.

The implementation requires four coordinated changes: (1) `startWorkflow` launches Trinity asynchronously instead of waiting, (2) `notifyWaitResult` becomes the real completion callback that drives state transitions, (3) stage events are derived post-hoc from `TrinityResult.telemetry` and `TrinityResult.failures[]`, and (4) `NocturnalResult` embeds the full `TrinityResult` (not just telemetry) for downstream consumption.

**Primary recommendation:** Implement `startWorkflow` with `Promise.resolve().then()` to offload Trinity execution to the event loop, immediately returning `state='active'`. Record stage events as a batch after `runTrinityAsync` resolves, using `TrinityResult.telemetry.dreamerPassed/philosopherPassed/scribePassed` to determine success events and `TrinityResult.failures[]` to determine failure events.

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-11:** Inject `OpenClawTrinityRuntimeAdapter` via `NocturnalWorkflowOptions.runtimeAdapter`
- **D-12:** `startWorkflow` returns immediately with `state: 'active'`, async Trinity chain via `runTrinityAsync`
- **D-13:** Stage events recorded AFTER Trinity chain completes (batch from TrinityResult)
- **D-14:** On stage failure, workflow enters `terminal_error` immediately
- **D-15:** State machine: `pending` -> `active` -> `finalizing` -> `completed` OR `terminal_error`
- **D-16:** `NocturnalResult` type mirrors `NocturnalRunResult` with embedded `TrinityResult`

### Claude's Discretion
- Exact async scheduling mechanism (`setTimeout 0`, `Promise.resolve().then()`, `queueMicrotask`)
- Specific event payload structure for `trinity_dreamer_start` etc.
- How to embed `TrinityResult` in `NocturnalResult` (full vs partial)

### Deferred Ideas (OUT OF SCOPE)
- Phase 8: Intermediate persistence (NOC-11, NOC-12, NOC-13)
- Phase 9: Evolution worker integration (NOC-14, NOC-15, NOC-16)

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| NOC-06 | TrinityRuntimeAdapter injection into NocturnalWorkflowManager | `NocturnalWorkflowOptions.runtimeAdapter` already defined; adapter is `TrinityRuntimeAdapter` interface |
| NOC-07 | `runTrinityAsync` integration for Dreamer->Philosopher->Scribe chain | `runTrinityAsync` already exists in `nocturnal-trinity.ts`; accepts `RunTrinityOptions` with `TrinityConfig` and `TrinityRuntimeAdapter` |
| NOC-08 | Stage event recording: `trinity_dreamer_start/complete/failed`, `trinity_philosopher_*`, `trinity_scribe_*` | `TrinityResult.telemetry` has `dreamerPassed/philosopherPassed/scribePassed` booleans; `TrinityResult.failures[]` has `TrinityStageFailure[]` |
| NOC-09 | Stage failure handling: `terminal_error` + `TrinityStageFailure[]` in payload | `TrinityStageFailure` interface: `{ stage: 'dreamer' | 'philosopher' | 'scribe', reason: string }` |
| NOC-10 | Full链路 state machine: `active` -> `finalizing` -> `completed` OR `terminal_error` | `WorkflowState` type already has all needed states |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `nocturnal-trinity.ts` | (existing) | `runTrinityAsync`, `TrinityResult`, `TrinityStageFailure` | Core Trinity chain execution |
| `workflow-store.ts` | (existing) | `WorkflowStore.recordEvent()` | Event recording to SQLite |
| `nocturnal-service.ts` | (existing) | `executeNocturnalReflectionAsync` | Not used for Trinity path; `runTrinityAsync` called directly |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `TrinityRuntimeAdapter` interface | (existing) | Abstract interface for stage invocation | Phase 7 uses real adapter from options |
| `TrinityConfig` | (existing) | `{ useTrinity, maxCandidates, useStubs, runtimeAdapter }` | Configure Trinity execution |

### No New Dependencies
Phase 7 uses only existing modules. No new packages required.

## Architecture Patterns

### Recommended Project Structure
```
src/service/subagent-workflow/
├── nocturnal-workflow-manager.ts  # Modified: async Trinity path
└── types.ts                       # Modified: NocturnalResult embeds TrinityResult
```

### Pattern 1: Async Fire-and-Forget with Callback

**What:** `startWorkflow` returns immediately with `state='active'` while Trinity runs in background. Completion is signaled via `notifyWaitResult`.

**When to use:** D-12: Trinity chain must not block `startWorkflow`

**Implementation approach:**
```typescript
// In startWorkflow, for Trinity path:
const trinityConfig: TrinityConfig = {
  useTrinity: true,
  maxCandidates: 3,
  useStubs: false,
  runtimeAdapter: this.runtimeAdapter,
  stateDir: this.stateDir,
};

// Launch async and return immediately
Promise.resolve().then(async () => {
  const result = await runTrinityAsync({ snapshot, principleId, config: trinityConfig });
  // After Trinity completes, call notifyWaitResult
  // This triggers state transition and event recording
  await this.notifyWaitResult(workflowId, result.success ? 'ok' : 'error',
    result.failures.map(f => `${f.stage}: ${f.reason}`).join('; '));
});

return { workflowId, childSessionKey, runId: undefined, state: 'active' };
```

**Key insight:** The snapshot and principleId must be obtained BEFORE launching async (pre-flight + selection + snapshot extraction are sync and must succeed before Trinity starts). These values must be stored in instance state or passed through a closure.

### Pattern 2: Batch Stage Event Recording

**What:** All stage events are derived post-hoc from `TrinityResult` after the chain completes, not recorded incrementally during execution.

**When to use:** D-13: Stage events recorded AFTER Trinity chain completes

**Event derivation logic:**
```typescript
// After TrinityResult available:
function recordStageEvents(store: WorkflowStore, workflowId: string, trinityResult: TrinityResult): void {
  const { telemetry, failures } = trinityResult;

  // Dreamer events (always "start" first, then complete or failed)
  store.recordEvent(workflowId, 'trinity_dreamer_start', null, 'active', 'Trinity Dreamer stage began', {});

  if (telemetry.dreamerPassed) {
    store.recordEvent(workflowId, 'trinity_dreamer_complete', 'active', 'active', 'Dreamer completed successfully', {
      candidateCount: telemetry.candidateCount,
    });
  } else {
    const dreamerFailure = failures.find(f => f.stage === 'dreamer');
    store.recordEvent(workflowId, 'trinity_dreamer_failed', 'active', 'active', dreamerFailure?.reason ?? 'Dreamer stage failed', {
      failures: failures.filter(f => f.stage === 'dreamer'),
    });
  }

  // Philosopher events (only if Dreamer passed)
  if (telemetry.dreamerPassed) {
    store.recordEvent(workflowId, 'trinity_philosopher_start', 'active', 'active', 'Trinity Philosopher stage began', {});
    if (telemetry.philosopherPassed) {
      store.recordEvent(workflowId, 'trinity_philosopher_complete', 'active', 'active', 'Philosopher completed successfully', {});
    } else {
      const philosopherFailure = failures.find(f => f.stage === 'philosopher');
      store.recordEvent(workflowId, 'trinity_philosopher_failed', 'active', 'active', philosopherFailure?.reason ?? 'Philosopher stage failed', {
        failures: failures.filter(f => f.stage === 'philosopher'),
      });
    }
  }

  // Scribe events (only if Philosopher passed)
  if (telemetry.philosopherPassed) {
    store.recordEvent(workflowId, 'trinity_scribe_start', 'active', 'active', 'Trinity Scribe stage began', {});
    if (telemetry.scribePassed) {
      store.recordEvent(workflowId, 'trinity_scribe_complete', 'active', 'finalizing', 'Scribe completed successfully', {
        selectedCandidateIndex: telemetry.selectedCandidateIndex,
      });
    } else {
      const scribeFailure = failures.find(f => f.stage === 'scribe');
      store.recordEvent(workflowId, 'trinity_scribe_failed', 'active', 'terminal_error', scribeFailure?.reason ?? 'Scribe stage failed', {
        failures: failures.filter(f => f.stage === 'scribe'),
      });
    }
  }
}
```

### Pattern 3: State Machine Transition via notifyWaitResult

**What:** `notifyWaitResult` becomes the state transition driver for the Trinity path.

**When to use:** D-15: State machine transitions

**Transition logic in notifyWaitResult:**
```typescript
async notifyWaitResult(workflowId: string, status: 'ok' | 'error' | 'timeout', error?: string): Promise<void> {
  const workflow = this.store.getWorkflow(workflowId);
  if (!workflow || workflow.state !== 'active') return;

  if (status === 'ok') {
    // Trinity succeeded: -> finalizing -> completed
    this.store.updateWorkflowState(workflowId, 'finalizing');
    this.store.recordEvent(workflowId, 'trinity_completed', 'active', 'finalizing', 'Trinity chain completed successfully', {});
    // ... persist result ...
    this.store.updateWorkflowState(workflowId, 'completed');
    this.store.recordEvent(workflowId, 'nocturnal_completed', 'finalizing', 'completed', 'artifact persisted', {});
  } else {
    // Any stage failure: -> terminal_error immediately (D-14)
    const trinityFailures = this.pendingTrinityFailures.get(workflowId) ?? [];
    this.store.updateWorkflowState(workflowId, 'terminal_error');
    this.store.recordEvent(workflowId, 'nocturnal_failed', 'active', 'terminal_error', error ?? 'Trinity stage failed', {
      failures: trinityFailures,
    });
  }

  this.markCompleted(workflowId);
}
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Trinity chain execution | Custom async runner | `runTrinityAsync` from `nocturnal-trinity.ts` | Handles adapter lifecycle, stage sequencing, failure short-circuiting |
| Stage telemetry tracking | Custom telemetry object | `TrinityResult.telemetry` | Already tracks `dreamerPassed`, `philosopherPassed`, `scribePassed`, `stageFailures` |
| Stage failure representation | Custom failure type | `TrinityStageFailure[]` from `TrinityResult.failures` | Already structured with `stage` and `reason` |

**Key insight:** `runTrinityAsync` already implements the full async stage chain with proper error handling. The workflow manager's job is orchestration (scheduling, state management, event recording) not stage execution.

## Common Pitfalls

### Pitfall 1: Blocking startWorkflow with await
**What goes wrong:** `await runTrinityAsync(...)` inside `startWorkflow` makes the method synchronous from the caller's perspective. The `WorkflowHandle.state` will be `'completed'` not `'active'`.

**Why it happens:** The natural instinct is to `await` the Trinity result before returning.

**How to avoid:** Use `Promise.resolve().then(async () => { ... })()` to schedule the async work without awaiting it in `startWorkflow`. Return the handle with `state: 'active'` before the promise resolves.

### Pitfall 2: Forgetting to store snapshot/principleId for async closure
**What goes wrong:** Snapshot extraction is synchronous but needs to be captured for the async Trinity call.

**Why it happens:** Snapshot is obtained via `extractor.getNocturnalSessionSnapshot()` which must be called before `startWorkflow` returns.

**How to avoid:** Extract snapshot (via `executeNocturnalReflectionAsync` pre-flight+selection path) BEFORE launching the async Trinity chain. The Phase 6 code already does this synchronously.

### Pitfall 3: Recording stage events before Trinity completes
**What goes wrong:** `trinity_dreamer_start` etc. are recorded during async execution, which may not complete before the workflow is queried.

**Why it happens:** Wanting to record `_start` events immediately when each stage begins.

**How to avoid:** Per D-13, all stage events are recorded in a batch AFTER `runTrinityAsync` resolves. The `_start` events are derived retroactively from the telemetry (a stage that completed must have started).

### Pitfall 4: Not handling Trinity failure in `notifyWaitResult`
**What goes wrong:** `notifyWaitResult` is still a no-op for the Trinity path.

**Why it happens:** Phase 6 left `notifyWaitResult` as no-op (D-10). Phase 7 must make it the real completion callback.

**How to avoid:** Implement `notifyWaitResult` to drive state transitions. The `status` parameter indicates success/failure; `error` contains the failure reason string.

### Pitfall 5: Missing `finalizing` state transition
**What goes wrong:** Going directly from `active` to `completed` on Trinity success.

**Why it happens:** Phase 6 returned `'completed'` directly. Phase 7 requires `active` -> `finalizing` -> `completed` (D-15).

**How to avoid:** In `notifyWaitResult` with `status === 'ok'`, first transition to `finalizing`, then to `completed`.

## Code Examples

### TrinityResult structure (source: nocturnal-trinity.ts)
```typescript
interface TrinityResult {
  success: boolean;
  artifact?: TrinityDraftArtifact;
  telemetry: TrinityTelemetry;
  failures: TrinityStageFailure[];
  fallbackOccurred: boolean;
}

interface TrinityTelemetry {
  chainMode: 'trinity' | 'single-reflector';
  usedStubs: boolean;
  dreamerPassed: boolean;
  philosopherPassed: boolean;
  scribePassed: boolean;
  candidateCount: number;
  selectedCandidateIndex: number;
  stageFailures: string[];
}

interface TrinityStageFailure {
  stage: 'dreamer' | 'philosopher' | 'scribe';
  reason: string;
}
```

### TrinityConfig for real execution (source: nocturnal-trinity.ts)
```typescript
interface TrinityConfig {
  useTrinity: boolean;        // true for Trinity path
  maxCandidates: number;       // 3 (default)
  useStubs: boolean;          // false for real subagent execution
  runtimeAdapter: TrinityRuntimeAdapter;  // Required for useStubs=false
  scoringWeights?: ScoringWeights;
  thresholds?: ThresholdValues;
  stateDir?: string;
}
```

### WorkflowStore event recording signature (source: workflow-store.ts)
```typescript
recordEvent(
  workflowId: string,
  eventType: string,
  fromState: WorkflowState | null,
  toState: WorkflowState,
  reason: string,
  payload: Record<string, unknown>
): void
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Sync execution in `startWorkflow` | Async via `Promise.resolve().then()` offload | Phase 7 | `startWorkflow` returns immediately with `state='active'` |
| No-op `notifyWaitResult` | Completion callback driving state transitions | Phase 7 | Trinity completion triggers state machine |
| No stage events | Batch stage events from TrinityResult | Phase 7 | Full audit trail of Trinity stages |
| `NocturnalResult` via `executeNocturnalReflectionAsync` | Direct `runTrinityAsync` call | Phase 7 | Workflow manager controls Trinity directly |

**Deprecated/outdated:**
- `useTrinity: false` path in `startWorkflow` — still needed for single-reflector fallback (Phase 7 still supports single-reflector via `executeNocturnalReflectionAsync`)
- `nocturnal_failed` event without `failures` array — Phase 7 adds `TrinityStageFailure[]` payload

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `runTrinityAsync` accepts `RunTrinityOptions` with `{ snapshot, principleId, config }` | NOC-07 | Verified in nocturnal-trinity.ts:1082 `runTrinityAsync(options: RunTrinityOptions)` |
| A2 | `TrinityResult.telemetry.dreamerPassed` is `true` when Dreamer succeeded | NOC-08 | Verified in nocturnal-trinity.ts:1139 `telemetry.dreamerPassed = true` after successful invoke |
| A3 | `TrinityResult.failures[]` is populated only on stage failure | NOC-09 | Verified in nocturnal-trinity.ts:1131-1136 failures.push() on invalid output |
| A4 | `nocturnal-service.ts` snapshot extraction is synchronous | Architecture | Verified: `extractor.getNocturnalSessionSnapshot()` is sync call |

## Open Questions

1. **How does the caller of `startWorkflow` know Trinity completed?**
   - What we know: `notifyWaitResult` is called internally. External callers use `getWorkflowDebugSummary` or poll `store.getWorkflow()`.
   - What's unclear: Is there a callback mechanism for external callers to be notified?
   - Recommendation: Not in scope for Phase 7. Phase 8/9 may add progress callbacks.

2. **Where is the `snapshot` extracted in the Trinity path?**
   - What we know: Phase 6 calls `executeNocturnalReflectionAsync` which does pre-flight + selection + snapshot extraction.
   - What's unclear: Should `startWorkflow` call the pre-flight/selection logic directly, or should it receive a pre-extracted snapshot?
   - Recommendation: `startWorkflow` calls a helper that runs pre-flight + selection + snapshot synchronously, then launches Trinity async.

## Environment Availability

Step 2.6: SKIPPED (no external dependencies identified — Phase 7 is pure code orchestration within existing modules)

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | `packages/openclaw-plugin/vitest.config.ts` |
| Quick run command | `cd packages/openclaw-plugin && npx vitest run tests/service/nocturnal-workflow-manager.test.ts` |
| Full suite command | `cd packages/openclaw-plugin && npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|------------------|--------------|
| NOC-06 | TrinityRuntimeAdapter injection via options | unit | `vitest run tests/service/nocturnal-workflow-manager.test.ts -t "NOC-06"` | YES |
| NOC-07 | `runTrinityAsync` called in Trinity path | unit | `vitest run tests/service/nocturnal-workflow-manager.test.ts -t "NOC-07"` | YES (partial) |
| NOC-08 | Stage events recorded from TrinityResult | unit | `vitest run tests/service/nocturnal-workflow-manager.test.ts -t "NOC-08"` | NO (new) |
| NOC-09 | `terminal_error` + `TrinityStageFailure[]` on failure | unit | `vitest run tests/service/nocturnal-workflow-manager.test.ts -t "NOC-09"` | NO (new) |
| NOC-10 | `active` -> `finalizing` -> `completed` state transitions | unit | `vitest run tests/service/nocturnal-workflow-manager.test.ts -t "NOC-10"` | NO (new) |

### Wave 0 Gaps
- [ ] `tests/service/nocturnal-workflow-manager.test.ts` — Add tests for NOC-07 (mock `runTrinityAsync`), NOC-08 (stage event recording), NOC-09 (failure handling), NOC-10 (state transitions)
- [ ] `tests/core/nocturnal-trinity.test.ts` — Already exists, covers `runTrinityAsync` behavior
- None — existing test infrastructure covers Phase 7 requirements with new test cases needed in existing files

## Security Domain

### Applicable ASVS Categories
Phase 7 modifies internal workflow orchestration. No new attack surface introduced.

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V4 Access Control | no | WorkflowManager is internal API |
| V5 Input Validation | partial | `TrinityResult.failures` parsed but not used for security decisions |

### Known Threat Patterns for Trinity Workflow

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|--------------------|
| Malformed TrinityResult tampering | Tampering | Phase 7 reads TrinityResult from `runTrinityAsync` return (internal); not from external input |
| Workflow ID collision | Information Disclosure | `generateWorkflowId()` uses `Date.now() + random` (existing pattern) |

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — `runTrinityAsync`, `TrinityResult`, `TrinityStageFailure`, `TrinityTelemetry`, `TrinityConfig` — all verified
- `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` — Phase 6 foundation, D-01 through D-10 decisions
- `packages/openclaw-plugin/src/service/subagent-workflow/types.ts` — `WorkflowState`, `WorkflowManager` interface, `NocturnalResult` type
- `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts` — `recordEvent()` API signature

### Secondary (MEDIUM confidence)
- `packages/openclaw-plugin/tests/service/nocturnal-workflow-manager.test.ts` — Phase 6 test patterns, will be extended for Phase 7

### Tertiary (LOW confidence)
- None — all primary sources verified

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all modules already exist and are verified
- Architecture: HIGH — locked decisions (D-11 through D-16) provide clear blueprint
- Pitfalls: MEDIUM — async patterns are well-understood but specific implementation details (exact offload mechanism) are TBD

**Research date:** 2026-04-05
**Valid until:** 2026-05-05 (30 days — architecture is stable given locked decisions)
