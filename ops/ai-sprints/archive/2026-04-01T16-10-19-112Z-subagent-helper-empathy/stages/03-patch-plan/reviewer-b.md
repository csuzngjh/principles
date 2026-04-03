# Reviewer B Report — patch-plan Stage

**Role**: reviewer_b  
**Stage**: patch-plan  
**Round**: 1  
**Date**: 2026-04-02  
**Sprint**: subagent-helper-empathy  
**SHA**: 4138178581043646365326ee42dad4eab4037899

---

## VERDICT

**APPROVE**

All four deliverables are present, well-structured, and meet the patch-plan stage criteria. OpenClaw cross-repo verification confirms the three key runtime behavior assumptions. Scope is correctly bounded to empathy observer only (deep-reflect excluded per PR2 scope). The plan presents a minimal, sound approach to migration with appropriate shadow-run safety measures and rollback defined.

---

## BLOCKERS

**None.** All critical path items are addressed. Minor observations noted in FINDINGS.

---

## FINDINGS

### 1. OpenClaw Cross-Repo Verification Complete ✅

Verified all three compatibility assumptions against OpenClaw source at `D:/Code/openclaw`:

| Assumption | Claimed | Verified Location | Status |
|------------|---------|------------------|--------|
| `runtime.subagent.run()` returns `{runId}` | Yes | `server-plugins.ts:343-347` | ✅ CONFIRMED |
| `waitForRun()` returns `status: 'ok' \| 'error' \| 'timeout'` | Yes | `runtime/types.ts:28-31` | ✅ CONFIRMED |
| `expectsCompletionMessage: true` delays `subagent_ended` | Yes | `subagent-registry-lifecycle.ts:521-526` | ✅ CONFIRMED |

The `shouldDeferEndedHook` logic in `subagent-registry-lifecycle.ts:521-526` explicitly requires `entry.expectsCompletionMessage === true` to defer the hook, confirming the empathy observer's `deliver=false` + `expectsCompletionMessage=true` pattern is semantically correct.

### 2. SQLite Workflow Store — Implementation Gap (Non-Blocking)

The `workflow_spec.md` defines a complete SQLite schema (`subagent_workflows`, `subagent_workflow_events`), but no implementation exists yet. This is acceptable for patch-plan stage — the spec correctly designs for SQLite, but the actual persistence layer will be implemented in `implement-pass-1`.

**Observation**: The shadow-run plan uses an in-memory `processedDedupeKeys` Set, which is appropriate for shadow mode since it only needs to prevent dual finalize during a single session. Production rollout would require SQLite-backed dedupe.

### 3. Feature Flag Configuration Structure Inconsistency

The empathy_observer_spec.md uses:
```json
{
  "empathy_engine": {
    "workflow_helper": { "enabled": false, "shadow_only": true }
  }
}
```

But `shadow_run_plan.md` defines `shadow_mode` at the same level as `empathy_engine`:
```json
{
  "empathy_engine": { "enabled": true },
  "shadow_mode": { "enabled": true, "shadow_only": true }
}
```

**Impact**: Low. These are two separate configuration approaches documented. The implementer will need to reconcile or choose one. Not a blocker for patch-plan.

### 4. Sweep Timing Reliance on Evolution Worker

The `cleanup_pending` and `expired` states rely on `sweepExpiredWorkflows()` being called by the Evolution Worker (every 15 minutes per project knowledge). This TTL-based cleanup is a fallback mechanism, and the 5-minute TTL (`ttlMs: 300_000`) is shorter than the poll interval. In practice, orphaned workflows may persist longer than ideal before sweep catches them.

**Risk**: Low. This matches the existing empathy observer's TTL cleanup behavior (`5 * 60 * 1000` in `empathy-observer-manager.ts:113, 122`).

### 5. Scope Compliance ✅

PR2 scope states: "empathy observer + deep-reflect ONLY. Diagnostician/Nocturnal NOT migrated."

The patch-plan correctly:
- Limits `EmpathyObserverWorkflowSpec` to empathy-observer workflowType
- Does not mention diagnostician or nocturnal
- Documents only empathy observer migration path

**Confirmed**: No scope creep.

### 6. Contract Deliverables Status

| Deliverable | Status | Evidence |
|-------------|--------|----------|
| empathy_observer_spec | ✅ DONE | `empathy_observer_spec.md` (234 lines, complete spec) |
| workflow_spec | ✅ DONE | `workflow_spec.md` (352 lines, full interface + state machine) |
| shadow_run_plan | ✅ DONE | `shadow_run_plan.md` (314 lines, dual-path + dedupe) |
| rollback_steps | ✅ DONE | `rollback_steps.md` (369 lines, cleanup states + empathy-check.json) |

---

## CODE_EVIDENCE

- files_verified: `empathy_observer_spec.md`, `workflow_spec.md`, `shadow_run_plan.md`, `rollback_steps.md`, `packages/openclaw-plugin/src/service/subagent-workflow/types.ts`, `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`, `packages/openclaw-plugin/tests/service/empathy-observer-manager.test.ts`
- evidence_source: both
- sha: 4138178581043646365326ee42dad4eab4037899
- evidence_scope: principles

### OpenClaw Cross-Repo Verification (remote source):
- `D:/Code/openclaw/src/plugins/runtime/types.ts` — SubagentWaitResult type confirmed
- `D:/Code/openclaw/src/gateway/server-plugins.ts` — run() returns {runId} confirmed
- `D:/Code/openclaw/src/agents/subagent-registry-lifecycle.ts` — shouldDeferEndedHook with expectsCompletionMessage confirmed

---

## INTERFACE_ASSESSMENT

The `SubagentWorkflowSpec` interface is well-designed:

1. **Transport abstraction** (`runtime_direct` vs `registry_backed`) correctly isolates the two invocation patterns
2. **State machine** (`pending → active → wait_result → finalizing → completed`) with terminal error branches is coherent
3. **Idempotency** via `completedWorkflows` Set is the correct dedupe strategy
4. **parseResult/persistResult separation** is clean — parse extracts structured data, persist handles side effects
5. **shouldFinalizeOnWaitStatus** correctly prevents finalize on timeout/error (empathy observer skips finalize on non-ok status)

The `EmpathyObserverWorkflowSpec` correctly constrains to `runtime_direct` transport with 30s timeout and 5-minute TTL.

**Minor note**: `sweepExpiredWorkflows` is documented in rollback_steps.md as being called by the Evolution Worker, but no explicit confirmation that Evolution Worker poll interval (15min) aligns with the 5-minute TTL. This is a runtime concern for implement-pass-1.

---

## HYPOTHESIS_MATRIX

| Hypothesis | Status | Notes |
|------------|--------|-------|
| empathy uses runtime_direct transport | ✅ CONFIRMED | Direct `runtime.subagent.run()` call in `empathy-observer-manager.ts:193` |
| shadow run dedupeKey prevents dual finalize | 🔄 PLausible | In-memory Set acceptable for shadow mode; production needs SQLite |
| cleanup_pending state satisfies recovery needs | ✅ SOUND | SweepExpiredWorkflows handles after TTL expiry |
| empathy-check.json format satisfies validation | ✅ SOUND | Covers all critical fields: damageDetected, painSignalRecorded, trajectoryRecorded, sessionDeleted |
| OpenClaw hook semantics verified | ✅ CONFIRMED | `expectsCompletionMessage: true` correctly defers `subagent_ended` |

---

## NEXT_FOCUS

For the next stage (`implement-pass-1`), reviewer_b recommends:

1. **Verify SQLite implementation**: Ensure `subagent_workflows` table creation is integrated into the plugin's database migration
2. **Check Evolution Worker integration**: Confirm `sweepExpiredWorkflows` is called and the 5-minute TTL won't cause issues with 15-minute poll interval
3. **Test shadow run dedupe**: Verify the in-memory `processedDedupeKeys` Set correctly prevents dual finalize when old and shadow paths run concurrently
4. **Validate parseResult null handling**: Ensure null returns from `parseResult` are handled gracefully and don't cause state machine violations

---

## CHECKS

CHECKS: criteria=met;blockers=0;verification=complete

---

## DIMENSIONS

DIMENSIONS: plan_completeness=4; interface_soundness=4; shadow_run_safety=4; rollback_defined=4

**Rationale**:
- **plan_completeness=4**: All 4 deliverables present with thorough detail. Minor gap: SQLite persistence not yet implemented but correctly designed for implementation phase.
- **interface_soundness=4**: `SubagentWorkflowSpec` is well-typed with clean separation of concerns. `EmpathyObserverWorkflowSpec` correctly constrains to `runtime_direct`. Minor: sweep timing reliance on Evolution Worker not explicitly confirmed.
- **shadow_run_safety=4**: Dedup mechanism correctly designed. In-memory Set acceptable for shadow mode. Migration stages (Shadow → Canary → Full) provide appropriate progressive rollout with clear exit criteria.
- **rollback_defined=4**: Cleanup states fully defined (`completed`, `completed_with_cleanup_error`, `cleanup_pending`, `expired`, `terminal_error`). Rollback triggers and procedures documented. `empathy-check.json` format provides validation mechanism.

All dimensions meet threshold (≥3/5). No blockers.
