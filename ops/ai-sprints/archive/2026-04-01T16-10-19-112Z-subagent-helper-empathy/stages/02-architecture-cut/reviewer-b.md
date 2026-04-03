# Reviewer B Report — Stage 02-architecture-cut, Round 2

## VERDICT

**APPROVE**

Round 2 successfully addressed the 2 blockers from Round 1:
1. **shadow_run_plan**: Previously "outline_only" → Now concrete with quantitative metrics, phase thresholds, rollback triggers, and shadow result schema
2. **helper_interface_draft**: Previously prose in markdown → Now actual TypeScript code artifact at `packages/openclaw-plugin/src/service/subagent-workflow/types.ts`

All contract deliverables are DONE. No remaining blockers.

---

## BLOCKERS

None.

Round 1 blockers were:
1. `shadow_run_plan` was outline-only — **RESOLVED** in Round 2 with concrete metrics
2. `helper_interface_draft` was prose — **RESOLVED** in Round 2 with `types.ts` code artifact

---

## FINDINGS

### 1. OpenClaw Cross-Repo Verification (VERIFIED)

Re-verified all 5 assumptions against OpenClaw source at `D:/Code/openclaw`:

| Assumption | Evidence | Status |
|------------|----------|--------|
| `subagent_ended` fires for `expectsCompletionMessage: true` | `subagent-registry-lifecycle.ts:521-533` | VERIFIED |
| Hook timing is DEFERRED | `subagent-registry-lifecycle.ts:137-154` via `emitCompletionEndedHookIfNeeded` | VERIFIED |
| `runtime.subagent.run()` dispatches to gateway | `server-plugins.ts:327-347` calls `dispatchGatewayMethod("agent", ...)` | VERIFIED |
| Outcome mapping correct | `subagent-registry-completion.ts:32-42` maps error/timeout/ok correctly | VERIFIED |
| Hook deduplication works | `subagent-registry-completion.ts:58-63` checks `endedHookEmittedAt` | VERIFIED |

### 2. Types.ts Analysis (SOUND)

Created at `packages/openclaw-plugin/src/service/subagent-workflow/types.ts` (292 lines):
- **WorkflowTransport**: `runtime_direct | registry_backed` — covers both empathy (runtime_direct) and future diagnostician (registry_backed)
- **WorkflowState**: 7 states with proper transitions matching design doc
- **SubagentWorkflowSpec<TResult>**: Generic spec with `parseResult`, `persistResult`, `shouldFinalizeOnWaitStatus`
- **WorkflowManager**: 5 methods — `startWorkflow`, `notifyWaitResult`, `notifyLifecycleEvent`, `finalizeOnce`, `sweepExpiredWorkflows`
- **EmpathyObserverWorkflowSpec**: Concrete spec with `timeoutMs: 30_000`, `ttlMs: 300_000`
- Re-exports from `openclaw-sdk.js` correctly

### 3. Shadow Run Plan (CONCRETE)

`shadow_run_plan.md` (249 lines) now includes:
- **Phase 1 Shadow Mode**: Quantitative pass criteria — ≥95% result match rate, ≥100 triggers, ≥99% new path success rate, <500ms parse time p95, <1% orphan rate
- **Immediate rollback triggers**: <90% match, any crash, >10% memory increase
- **Canary rollout**: 10% → 90% with error rate <0.5%, latency p95 <2000ms
- **Shadow schema**: SQL table definition for `empathy_shadow_results`
- **Rollback protocol**: Feature flag `helper_empathy_enabled = false` fallback

### 4. Scope Control (CLEAN)

- PR2 scope: empathy observer + deep-reflect ONLY
- Diagnostician/Nocturnal/Routing NOT migrated (confirmed)
- Helper location: `packages/openclaw-plugin/src/service/subagent-workflow/` (matches brief)
- No gold-plating detected

### 5. Test Coverage (EXISTING)

- `empathy-observer-manager.test.ts` (393 lines): Tests concurrency locks, session keys, shouldTrigger, spawn, finalizeRun
- No new `subagent-workflow` tests yet (expected — architecture-cut stage, no implementation)
- Existing tests will need to be augmented post-implementation

### 6. Hypothesis Matrix (APPROPRIATELY MARKED)

| Hypothesis | Status | Validation Method |
|------------|--------|-------------------|
| Migration improves reliability | UNTESTED | Shadow mode ≥95% match |
| State machine handles paths | ASSUMED | Design doc + review |
| Helper reduces session leaks | ASSUMED | TTL-based sweep |
| New path = old path | UNTESTED | Shadow mode |

Producer honestly marks UNTESTED hypotheses — this is correct for architecture-cut stage.

---

## OPENCLAW_COMPATIBILITY_REVIEW

All OpenClaw assumptions are verified against source code. Key findings:

### Hook Timing Analysis
The `subagent_ended` hook for `expectsCompletionMessage: true` runs is **DEFERRED** to the cleanup flow via `emitCompletionEndedHookIfNeeded()`. This is safe because:
- `EmpathyObserverManager` uses `completedSessions` Map with 5-min TTL for dedup
- If main path (`finalizeRun`) completes before hook fires, `reap()` skips via `isCompleted()` check
- Helper's `finalizeOnce()` must replicate this dedup behavior

### runtime_direct vs registry_backed
- Empathy observer uses `runtime_direct` via `api.runtime.subagent.run()`
- This dispatches to gateway `agent` method (NOT directly to registry)
- Hook fires during cleanup flow (not immediately)
- Design correctly identifies `runtime_direct` for empathy, `registry_backed` for future diagnostician

### Compatibility Risk: LOW
No OpenClaw upgrade risks identified. All assumptions are about stable hook semantics.

---

## ARCHITECTURE_ASSESSMENT

### Decision Quality: 4/5
- Architecture decision (migrate to workflow helper) is sound and well-reasoned
- Design doc alignment (Section 12.1 explicitly identifies empathy as first candidate)
- Transport selection (`runtime_direct`) matches existing implementation
- Slight扣分: No concrete evidence that helper will outperform current EmpathyObserverManager (pending shadow mode)

### OpenClaw Verification Completeness: 5/5
- All 5 assumptions verified via cross-repo source reading
- Evidence cited with exact file:line references
- Round 1 verified, Round 2 confirmed still valid

### Interface Soundness: 4/5
- Types are comprehensive and match design doc
- State machine transitions well-defined
- Generic `SubagentWorkflowSpec<TResult>` allows extensibility
- Minor扣分: `WorkflowRow.metadata_json` uses JSON string (design doc said `metadata` as JSON column — acceptable)

### Extensibility: 4/5
- `registry_backed` transport defined but not implemented (by design — PR2 scope)
- `SubagentWorkflowSpec<TResult>` is generic, supports future workflow types
- Future migraters (diagnostician) can reuse `WorkflowManager` with `registry_backed` transport
- Minor扣分: Future `registry_backed` implementation not designed in this stage

---

## DIMENSIONS

DIMENSIONS: decision_quality=4; openclaw_verification_completeness=5; interface_soundness=4; extensibility=4

---

## HYPOTHESIS_MATRIX

| Hypothesis | Status | Evidence | Remaining Risk |
|------------|--------|----------|----------------|
| Migration improves empathy reliability | UNTESTED | Design doc reasoning | Shadow mode must validate |
| State machine handles timeout/error/cleanup | ASSUMED | Hook timing verified, dedup confirmed | Implementation must replicate dedup |
| Helper reduces session leaks | ASSUMED | TTL-based sweep in plan | Orphan rate <1% threshold must pass |
| New path produces same results as old | UNTESTED | Shadow mode comparison | ≥95% match threshold |
| Hook fires correctly for expectsCompletionMessage=true | VERIFIED | Source code confirmed | LOW — hook semantics stable |

**Competing Explanations**:
- If `subagent_ended` fires before `finalizeRun` completes → race condition → but `completedSessions` dedup prevents double-write
- If `waitForRun` times out but subagent still running → orphan → but `sweepExpiredWorkflows` with TTL handles this

---

## NEXT_FOCUS

For the **implement** stage:

1. **Implement WorkflowManager** with state machine at `workflow-manager.ts`
2. **Implement RuntimeDirectDriver** for empathy observer transport
3. **Wire empathy observer** to use helper (dual-path during shadow)
4. **Add workflow store** (SQLite tables: `subagent_workflows`, `subagent_workflow_events`)
5. **Shadow mode validation**: Run dual paths, collect metrics, validate ≥95% match
6. **Ensure dedup behavior** replicates `EmpathyObserverManager.completedSessions` pattern

---

## CHECKS

CHECKS: criteria=met;blockers=0;verification=complete

---

## CODE_EVIDENCE

- files_verified: empathy-observer-manager.ts, types.ts, shadow_run_plan.md, subagent-registry-lifecycle.ts, server-plugins.ts, subagent-registry-completion.ts
- evidence_source: both (principles + openclaw)
- sha: d83c95af2f5a7be08fc42b7b82c80c46824e9cf7 (OpenClaw verification SHA)
- evidence_scope: both
