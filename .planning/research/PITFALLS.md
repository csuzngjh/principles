# Pitfalls Research: Multi-Stage Trinity Workflow Integration

**Domain:** Subagent workflow helpers (single-stage to multi-stage migration)
**Researched:** 2026-04-05
**Confidence:** HIGH (based on code analysis of existing patterns)

## Executive Summary

Adding Trinity (3-stage: Dreamer -> Philosopher -> Scribe) to an existing single-stage workflow architecture (EmpathyObserver, DeepReflect) introduces structural pitfalls that do not exist in single-stage patterns. The core issue: Trinity was designed as a standalone pipeline (`runTrinityAsync`) that bypasses the `WorkflowManager` state machine entirely, while single-stage workflows (`EmpathyObserverWorkflowManager`) integrate fully with `startWorkflow` -> `notifyWaitResult` -> `finalizeOnce` -> `sweepExpiredWorkflows`.

---

## Critical Pitfalls

### Pitfall 1: Trinity Bypasses the WorkflowManager State Machine

**What goes wrong:**
Trinity's `OpenClawTrinityRuntimeAdapter` executes three sequential subagent calls via `invokeDreamer()` / `invokePhilosopher()` / `invokeScribe()`. Each call creates a session, runs, extracts output, and deletes the session. **No state transitions are ever recorded to the WorkflowStore.** The workflow row in SQLite remains `"active"` forever, even after all three stages complete successfully.

**Why it happens:**
The `TrinityRuntimeAdapter` interface was designed as a standalone execution engine (`runTrinityAsync()`) with its own error handling and telemetry. It does not call `notifyWaitResult()`, `notifyLifecycleEvent()`, or any `WorkflowManager` method. The workflow store is unaware Trinity ever ran.

**How to avoid:**
- Trinity must be wrapped by a `NocturnalWorkflowManager` that implements `WorkflowManager` interface
- Each stage completion should trigger appropriate state transitions (`active` -> `dreamer_done` -> `philosopher_done` -> `finalizing` -> `completed`)
- `notifyLifecycleEvent('subagent_ended')` or a new `stage_completed` event must be called after each stage
- Stage outputs (DreamerOutput, PhilosopherOutput) must be persisted to the workflow store as intermediate results

**Warning signs:**
- `sweepExpiredWorkflows()` never cleans up Trinity workflows (they stay "active" forever)
- `getWorkflowDebugSummary()` shows `state: "active"` even after Trinity completes
- No events recorded between `spawned` and `finalized` for Trinity workflows

**Phase to address:** Phase that adds `NocturnalWorkflowManager` must wire up stage events to the WorkflowStore.

---

### Pitfall 2: Stage Failure Leaves Workflow Stuck in "active" State

**What goes wrong:**
If Philosopher fails (times out, throws, or returns invalid JSON), `runTrinityAsync()` returns early with `success: false` and `fallbackOccurred: false`. The workflow remains `"active"` in the database with no mechanism to retry or mark it failed. `sweepExpiredWorkflows()` only expires workflows after `ttlMs`, so a failed Trinity workflow persists indefinitely.

**Why it happens:**
Single-stage workflows have `shouldFinalizeOnWaitStatus()` which determines if a workflow should transition to `terminal_error` on failure. Trinity has no equivalent: if any stage fails, the chain stops but the workflow state is never updated.

**How to avoid:**
- `NocturnalWorkflowManager` must implement stage-level failure handling
- On any stage failure, transition workflow to `terminal_error` and record the `TrinityStageFailure[]` in the event log
- Provide a retry mechanism that can restart from a specific stage (not full restart from Dreamer)

**Warning signs:**
- Workflow with `state: "active"` and `last_observed_at` old but never cleaned up
- `TrinityResult.failures` not recorded to workflow store
- No way to distinguish "still running" from "failed but never updated"

**Phase to address:** Phase that adds `NocturnalWorkflowManager` error handling.

---

### Pitfall 3: No Idempotency for Philosopher and Scribe Stages

**What goes wrong:**
Trinity uses a single `idempotencyKey` only for the Dreamer session (passed via `RuntimeDirectDriver.run()`). Philosopher and Scribe sessions use only `sessionKey` (with unique suffixes like `ne-philosopher-{uuid}`) with **no idempotency protection**. If Philosopher call times out but actually succeeded server-side, re-invoking Philosopher could create duplicate rankings or inconsistent state.

**Why it happens:**
The `TrinityRuntimeAdapter` creates new sessions for each stage with `sessionKey = ne-{stage}-{uuid}`. The idempotency pattern used in single-stage (`options.parentSessionId ? ${parentSessionId}:${Date.now()} : ...`) was not applied to Philosopher and Scribe.

**How to avoid:**
- Each stage should accept an idempotency key derived from parent workflow + stage name + input hash
- Example: `idempotencyKey: ${parentWorkflowId}:philosopher:${hash(dreamerOutput)}`
- Stage implementations should be idempotent (re-fetching Philosopher output with same inputs yields same result)

**Warning signs:**
- Double-invoking Trinity (e.g., after a timeout) produces different `PhilosopherOutput.rank` assignments
- `stageFailures` contains duplicate entries for philosopher
- Non-deterministic tournament results for same Dreamer output

**Phase to address:** Phase that adds stage-level idempotency to Trinity adapter.

---

### Pitfall 4: No Intermediate Result Persistence Between Stages

**What goes wrong:**
`runTrinityAsync()` passes DreamerOutput directly to `invokePhilosopher()` and PhilosopherOutput directly to `invokeScribe()` — in-memory only. If the process crashes after Dreamer succeeds but before Philosopher completes, the Dreamer output is lost. Re-running Trinity regenerates new Dreamer candidates, potentially yielding a different final artifact.

**Why it happens:**
Single-stage workflows have `parseResult()` + `persistResult()` which save output to storage. Trinity has no equivalent: stage outputs are function return values, not persisted records.

**How to avoid:**
- `NocturnalWorkflowManager` must persist each stage's output to the workflow store after completion
- DreamerOutput saved as workflow event with `event_type: 'dreamer_completed'`
- PhilosopherOutput saved as workflow event with `event_type: 'philosopher_completed'`
- On restart/retry, reload previous stage outputs instead of regenerating

**Warning signs:**
- Same parent session produces different Trinity artifacts on each run
- `telemetry.candidateCount` varies between runs with same input
- No `dreamer_completed` / `philosopher_completed` events in workflow history

**Phase to address:** Phase that adds intermediate result persistence.

---

### Pitfall 5: Fallback Path Bypasses Single-Stage Workflow Manager

**What goes wrong:**
When Trinity's chain fails or `useTrinity: false`, it falls back to `runTrinityWithStubs()` which uses stub implementations — **not** the existing `EmpathyObserverWorkflowManager` or `DeepReflectWorkflowManager`. This means "fallback" is a completely different code path, not a graceful degradation to the existing single-stage helper system.

**Why it happens:**
Trinity was designed as a standalone module with its own stub/fallback logic. The "single-reflector fallback" in the design refers to stub implementations within Trinity, not to delegating to the established `RuntimeDirectDriver` workflow system.

**How to avoid:**
- If Trinity fails, the `NocturnalWorkflowManager` should have the option to fall back to a registered single-stage workflow manager
- This requires Trinity + single-stage workflows to share a common `WorkflowManager` registry
- Alternatively, document that Trinity fallback is stub-only and not a production recovery path

**Warning signs:**
- Trinity failure leads to stub output that bypasses all workflow store tracking
- `fallbackOccurred: true` in TrinityResult but no corresponding workflow state transition
- Stub output looks like valid artifact but was never persisted via `persistResult()`

**Phase to address:** Phase that defines fallback behavior for NocturnalWorkflowManager.

---

### Pitfall 6: Session Isolation Between Stages Prevents Context Sharing

**What goes wrong:**
Each Trinity stage creates a new session (`ne-dreamer-{uuid}`, `ne-philosopher-{uuid}`, `ne-scribe-{uuid}`). These sessions are **independent** — Philosopher cannot see Dreamer's session history, Scribe cannot see Philosopher's. All context must be passed via prompt text, and previous stage outputs must be serialized/deserialized between calls.

**Why it happens:**
`OpenClawTrinityRuntimeAdapter` follows the same session-per-call pattern as `RuntimeDirectDriver`. But unlike single-stage workflows where the workflow has one session and one result, Trinity's stages need to share working state.

**How to avoid:**
- Document that inter-stage context is passed via prompt serialization only
- DreamerOutput and PhilosopherOutput must be JSON-serializable
- Consider a shared session key prefix if stages need to see each other's messages (future enhancement, not in current design)

**Warning signs:**
- Large DreamerOutput causes prompt bloat in Philosopher/Scribe calls
- JSON serialization failures in stage outputs propagate as chain failures
- No audit trail of what each stage "saw" in previous stages' context

**Phase to address:** Design phase — current design is intentional (context via serialization), but should be documented.

---

### Pitfall 7: No Observable Chain Execution for External Monitors

**What goes wrong:**
External callers monitoring workflow lifecycle via `notifyLifecycleEvent()` or `getWorkflowDebugSummary()` receive no updates during Trinity execution. They see: workflow `"active"` at start, then nothing until `finalizeOnce()` (if ever called). Stage progress (`dreamerPassed`, `philosopherPassed`) is only available in the returned `TrinityResult` object.

**Why it happens:**
`runTrinityAsync()` is a fire-and-forget pipeline. It does not emit lifecycle events between stages. The caller receives a `Promise<TrinityResult>` only when the entire chain completes (success or failure).

**How to avoid:**
- `NocturnalWorkflowManager` should emit lifecycle events after each stage: `notifyLifecycleEvent(workflowId, 'stage_dreamer_completed')`, etc.
- Consider adding a `stageProgress` callback option to TrinityConfig for real-time progress
- `getWorkflowDebugSummary()` should include current stage and completed stages from telemetry

**Warning signs:**
- Polling `getWorkflowDebugSummary()` shows no progress between `active` and final state
- External dashboards can't show "Trinity stage 2/3" progress
- `recentEvents` array empty between spawn and finalize

**Phase to address:** Phase that adds observable stage progression.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Fire-and-forget Trinity (no WorkflowManager integration) | Fast to implement, Trinity works standalone | Workflows never complete, no observability, no cleanup | Never in production |
| In-memory stage outputs (no persistence) | Simpler code, no DB writes | Data loss on crash, non-deterministic retries | Only in Phase 1 stub mode |
| Stub-only fallback (not delegating to single-stage) | Self-contained Trinity module | Fallback bypasses established workflow system | Only if stub mode is truly temporary |
| Single idempotencyKey for entire chain | Simpler session management | Philosopher/Scribe not idempotent | Only if stages are truly idempotent (they are not) |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Trinity + WorkflowStore | Assuming Trinity writes events like EmpathyObserver does | It does not — `NocturnalWorkflowManager` must bridge this |
| Trinity + RuntimeDirectDriver | Assuming RuntimeDirectDriver can run Trinity stages | Trinity uses its own adapter pattern, not RuntimeDirectDriver |
| Trinity + lifecycle events | Assuming `subagent_ended` fires per stage | It fires once per session, Trinity has 3 sessions per workflow |
| Trinity + idempotency | Using same idempotencyKey for all stages | Each stage needs its own key based on parent workflow + stage |
| Trinity + sweep | Expecting sweep to clean up completed Trinity workflows | They stay "active" forever — sweep only handles TTL expiry |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Three sequential subagent calls | 3x latency vs single-stage | Async parallel where possible, cache stage outputs | At scale if each stage is 30s+ |
| No result caching | Regenerating same artifacts | Persist intermediate results | On retry/replay scenarios |
| Large prompt serialization | Philosopher/Scribe prompts grow with candidate count | Limit `maxCandidates`, truncate rationale fields | When candidates have long rationales |
| Session accumulation on adapter.close() failure | Orphaned sessions if close() throws | Always `.catch(() => {})` on deleteSession | On adapter errors |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Passing full DreamerOutput in Philosopher prompt | Prompt injection if candidates contain adversarial content | Sanitize candidate content before serialization |
| Sharing session keys between stages | One stage's output leaking to another | Each stage gets isolated session with unique key suffix |
| No authorization on stage sessions | Unauthorized access to stage context | Trinity sessions inherit parent workflow's auth context |

---

## "Looks Done But Isn't" Checklist

- [ ] **NocturnalWorkflowManager:** Exists but does not record stage events to WorkflowStore — verify `recordEvent()` called after each stage
- [ ] **Stage idempotency:** Stages re-run with same inputs produce same outputs — verify with crash-recovery test
- [ ] **Intermediate persistence:** DreamerOutput/PhilosopherOutput survive process restart — verify with crash simulation
- [ ] **Workflow cleanup:** Completed Trinity workflows transition to `completed` state — verify `sweepExpiredWorkflows()` handles them
- [ ] **Fallback delegation:** Trinity failure falls back to single-stage workflow, not stub — verify with failure injection test
- [ ] **Lifecycle observability:** External monitors receive stage progress events — verify with event polling test

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Workflow stuck in "active" after stage failure | MEDIUM | Run `sweepExpiredWorkflows()` with short TTL, implement manual `finalizeOnce()` fallback |
| Lost Dreamer output (crash after stage 1) | HIGH | Restart from Dreamer (new candidates, potentially different artifact) — no recovery possible |
| Double-invoked Philosopher (non-idempotent) | MEDIUM | Use deterministic Philosopher (same inputs = same output), ignore duplicates via rank comparison |
| Fallback to stub (wrong path) | LOW | Fix code path routing, stub fallback should only be for testing |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Trinity bypasses WorkflowManager | Phase adding NocturnalWorkflowManager | Code review: all Trinity stages emit WorkflowStore events |
| Stage failure leaves workflow stuck | Phase adding NocturnalWorkflowManager error handling | Unit test: Philosopher failure -> workflow state = terminal_error |
| No idempotency for Philosopher/Scribe | Phase adding TrinityRuntimeAdapter idempotency | Integration test: re-run same stage with same input = same output |
| No intermediate persistence | Phase adding result persistence | Crash-recovery test: kill process after Dreamer, restart, verify DreamerOutput reused |
| Fallback bypasses single-stage | Phase defining fallback behavior | Code review: fallback path delegates to WorkflowManager, not stubs |
| No observability | Phase adding stage progress events | Event polling test: verify stage events appear in workflow history |
| Session isolation | Design phase (current design is intentional) | Documentation: confirm this is known limitation |

---

## Sources

- Code analysis: `empathy-observer-workflow-manager.ts` (lines 1-604)
- Code analysis: `runtime-direct-driver.ts` (lines 1-167)
- Code analysis: `nocturnal-trinity.ts` (lines 1-1385)
- Review findings: `ops/ai-sprints/.../reviewer-b.md` (runtime_path_closure: 4/5)
- Design reference: `docs/design/2026-03-31-subagent-workflow-helper-design.md` (referenced in types.ts)

---

*Pitfalls research for: Multi-stage Trinity workflow integration*
*Researched: 2026-04-05*
