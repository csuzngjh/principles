# Reviewer A Report — patch-plan Stage

**Role**: reviewer_a  
**Stage**: patch-plan  
**Round**: 1  
**Date**: 2026-04-02  
**Sprint**: subagent-helper-empathy  
**SHA**: 4138178581043646365326ee42dad4eab4037899

---

## VERDICT

APPROVE

---

## BLOCKERS

None.

---

## FINDINGS

### 1. Producer Deliverables Complete

All four required deliverables are present and substantively complete:
- `empathy_observer_spec.md`: Detailed spec with code examples, state machine, dedup strategy
- `workflow_spec.md`: Full interface definitions, state machine invariants, lifecycle diagrams
- `shadow_run_plan.md`: Dual-path architecture, dedupeKey mechanism, migration stages, exit criteria
- `rollback_steps.md`: Cleanup state definitions, rollback triggers, empathy-check.json format

### 2. Code Citations Verified

Producer claims verified:
- `empathy-observer-manager.ts`: 512 lines, uses memory Maps (sessionLocks, activeRuns, completedSessions) - CONFIRMED
- `types.ts`: SubagentWorkflowSpec and EmpathyObserverWorkflowSpec interfaces defined - CONFIRMED
- Test coverage: 394 lines with 15 test cases - CONFIRMED
- Current transport: `runtime_direct` (direct calls to runtime.subagent.*) - CONFIRMED

### 3. Interface Soundness Assessment

The proposed EmpathyObserverWorkflowSpec correctly extends SubagentWorkflowSpec:
- `workflowType: 'empathy-observer'` - matches types.ts definition
- `transport: 'runtime_direct'` - consistent with current implementation
- `timeoutMs: 30_000` - matches DEFAULT_WAIT_TIMEOUT_MS constant
- `ttlMs: 300_000` - matches existing 5-minute orphan cleanup

State machine transitions are well-defined:
- `pending → active → wait_result → finalizing → completed`
- Timeout/error branches to `timeout_pending` / `error_pending`
- Cleanup states: `completed_with_cleanup_error`, `cleanup_pending`

### 4. Shadow Run Safety

DedupeKey strategy addresses the critical concern of dual-finalize prevention:
- Format: `empathy:{parentSessionId}:{timestampOrWorkflowId}`
- Shared `processedDedupeKeys` Set between old and new paths
- Migration stages properly sequenced: Shadow → Canary → Full

Exit criteria are measurable:
- Critical diff = 0 (different pain signals written)
- Non-critical diff < 5%
- Shadow path timing < 2x old path

### 5. Rollback Defined

Rollback procedures are comprehensive:
- Immediate rollback for critical issues (duplicate pain signals, session leaks)
- Gradual rollback for non-critical issues (latency increase)
- Rollback triggers with thresholds defined
- empathy-check.json format enables persistence validation

### 6. Gaps Identified (Non-Blocking)

1. **SQLite workflow store not implemented**: Deferred to implement-pass-1, which is appropriate
2. **OpenClaw assumptions not cross-verified**: Expected to be verified by reviewer_b via cross-repo source reading
3. **DedupeKey sharing mechanism**: In-memory Set implementation planned; needs runtime verification in implement-pass-1

---

## CODE_EVIDENCE

- files_verified: `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`, `packages/openclaw-plugin/src/service/subagent-workflow/types.ts`, `packages/openclaw-plugin/tests/service/empathy-observer-manager.test.ts`, `docs/design/2026-03-31-subagent-workflow-helper-design.md`, `ops/ai-sprints/specs/subagent-helper-empathy.json`
- evidence_source: local
- sha: 4138178581043646365326ee42dad4eab4037899
- evidence_scope: principles

---

## INTERFACE_ASSESSMENT

### Strengths

1. **Type alignment**: EmpathyObserverWorkflowSpec correctly extends SubagentWorkflowSpec<EmpathyResult>
2. **Backward compatibility**: Shadow mode allows validation without production impact
3. **Idempotency design**: finalizeOnce() with dedupe check prevents double-write
4. **State machine clarity**: All transitions documented with failure paths

### Concerns

1. **In-memory dedupe limitation**: Shared Set only works within single process; multi-instance deployment would need external coordination
2. **Cleanup state persistence**: `cleanup_pending` state requires SQLite store for durability (not yet implemented)

### Recommendations for implement-pass-1

1. Prioritize SQLite workflow store implementation for state durability
2. Add integration test for shadow run dedupeKey scenario
3. Consider Redis/external store for dedupe if multi-instance deployment is planned

---

## HYPOTHESIS_MATRIX

| Hypothesis | Status | Evidence |
|------------|--------|----------|
| empathy uses runtime_direct transport | ✅ Confirmed | empathy-observer-manager.ts calls api.runtime.subagent.* directly |
| shadow run dedupeKey prevents dual finalize | 🟡 Plausible | Design is sound; needs runtime verification |
| cleanup_pending state satisfies recovery needs | ✅ Confirmed | Sweep logic defined in rollback_steps.md |
| empathy-check.json format sufficient | ✅ Confirmed | Covers all critical fields for validation |
| SQLite store required for state durability | ✅ Confirmed | In-memory Maps are not durable across restarts |

---

## NEXT_FOCUS

For implement-pass-1:
1. Implement WorkflowManager with startWorkflow(), notifyWaitResult(), finalizeOnce()
2. Add SQLite workflow store (subagent_workflows table)
3. Implement shadow mode with dedupeKey sharing
4. Add integration tests for shadow run comparison

---

## CHECKS

CHECKS: criteria=met;blockers=0;verification=complete

---

## DIMENSIONS

DIMENSIONS: plan_completeness=5; interface_soundness=4; shadow_run_safety=4; rollback_defined=5

**Rationale**:
- plan_completeness=5: All deliverables present, detailed, and internally consistent
- interface_soundness=4: Type alignment good; in-memory dedupe is limitation for multi-instance
- shadow_run_safety=4: Dedupe strategy sound; needs runtime verification
- rollback_defined=5: Comprehensive rollback procedures with clear triggers
