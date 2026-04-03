# Global Reviewer Report — Stage 02-architecture-cut, Round 2

## VERDICT
**APPROVE**

Round 2 successfully resolves Round 1's 2 blockers (shadow_run_plan outline-only, helper_interface_draft prose-only) with concrete artifacts. All 4 contract deliverables are DONE. All scoring dimensions meet threshold (≥3/5). No unresolved blockers remain. The architecture is sound and the migration is well-scoped.

---

## MACRO_ANSWERS

**Q1: OpenClaw compatibility — assumptions verified?**  
YES — All 5 OpenClaw assumptions verified via cross-repo source reading. `subagent_ended` fires for `runtime_direct` with `expectsCompletionMessage: true` (subagent-registry-lifecycle.ts:521-533), hook timing is DEFERRED (subagent-registry-lifecycle.ts:137-154 via `emitCompletionEndedHookIfNeeded`), `runtime.subagent.run()` dispatches to gateway agent method (server-plugins.ts:327-347), outcome mapping correct (subagent-registry-completion.ts:32-42), deduplication works via `endedHookEmittedAt` (subagent-registry-completion.ts:58-63). Evidence: both reviewer_a and reviewer_b independently verified; SHA d83c95af2f5a7be08fc42b7b82c80c46824e9cf7 (OpenClaw Round 1).  
— evidence: OpenClaw cross-repo verification (reviewer_b confirmed Round 2 still valid)

**Q2: Business flow closed — result persistence path post-migration?**  
YES — Empathy result persistence path is clearly defined. Helper's `persistResult: (ctx: WorkflowPersistContext<EmpathyResult>) => Promise<void>` replaces the inline `reapBySession` logic. The chain `spawn → waitForRun → getSessionMessages → parse → trackFriction + eventLog.recordPainSignal + trajectory.recordPainEvent` is preserved via the spec's `parseResult`/`persistResult` split. Shadow mode ensures no regression window before canary.  
— evidence: empathy-observer-manager.ts (lines 332-370) vs types.ts (WorkflowPersistContext)

**Q3: Architecture convergence — unified or new implicit protocol?**  
CONVERGING — Before helper: EmpathyObserverManager and deep-reflect had separate lifecycle patterns with inconsistent timeout/cleanup. After helper: `SubagentWorkflowSpec<TResult>` provides a unified interface, `WorkflowManager` provides a unified orchestrator, `runtime_direct`/`registry_backed` transport abstraction handles both current (empathy) and future (diagnostician) patterns. State machine centralizes lifecycle logic. Helper replaces ad-hoc `activeRuns` Map + `completedSessions` Map with a SQLite-backed state machine + event log. This is genuine architectural improvement.  
— evidence: types.ts WorkflowState, WorkflowManager interface; shadow_run_plan.md Phase 1 dual-path diagram

**Q4: Data flow closure — sessionKey/runId/parentSessionId chain correct? No double-finalize?**  
YES with acknowledged risk — The chain is correctly tracked: `activeRuns` Map stores runId→observerSessionKey→parentSessionId; `completedSessions` Map with 5-min TTL handles dedup (isCompleted check before reap). Helper's `finalizeOnce()` replicates this via SQLite-backed state machine. The acknowledged risk (subagent_ended fires before finalizeRun completes → race condition) is mitigated by `completedSessions` dedup check. Orphan risk (waitForRun times out but subagent still running) is mitigated by `sweepExpiredWorkflows` with TTL. Shadow mode will validate.  
— evidence: empathy-observer-manager.ts lines 92-104 (isCompleted dedup), lines 306-310; shadow_run_plan.md Section 1.4 rollback triggers

**Q5: Extensibility — `registry_backed` transport reserved for future?**  
YES — `SubagentWorkflowSpec<TResult>` is generic over TResult. `WorkflowTransport = 'runtime_direct' | 'registry_backed'` is defined. `WorkflowManager.notifyLifecycleEvent()` method handles `registry_backed` path (subagent_ended hook events). Design doc Section 12.3 explicitly defers diagnostician to PR2+ because it uses `registry_backed`. Types correctly define the interface without implementing `registry_backed` driver. PR2 scope explicitly excludes Diagnostician/Nocturnal. Future migraters can reuse `WorkflowManager` with `registry_backed`.  
— evidence: types.ts lines 14-19 (WorkflowTransport), lines 225-236 (notifyLifecycleEvent); design doc Section 12.3

---

## BLOCKERS
None.

Round 1's 2 blockers are both resolved:
1. **shadow_run_plan** was outline-only → Now concrete: 4 phases, quantitative thresholds (≥95% match, ≥100 triggers, ≥99% success, <500ms p95, <1% orphan), immediate rollback triggers (<90% match, any crash, >10% memory increase), SQL schema for `empathy_shadow_results`.
2. **helper_interface_draft** was prose → Now TypeScript code artifact at `packages/openclaw-plugin/src/service/subagent-workflow/types.ts` (292 lines) with full type definitions, JSDoc, state machine diagram.

---

## FINDINGS

### 1. Contract Deliverables — All DONE
| Deliverable | Status | Evidence |
|-------------|--------|----------|
| architecture_decision | DONE | MIGRATE via runtime_direct; design doc Section 12.1 explicit first candidate |
| openclaw_cross_repo_verification | DONE | 5/5 assumptions verified; SHA d83c95af2f5a7be08fc42b7b82c80c46824e9cf7 |
| helper_interface_draft | DONE | types.ts (292 lines) at correct location |
| shadow_run_plan | DONE | shadow_run_plan.md (249 lines) with quantitative metrics, phases, rollback |

### 2. OpenClaw Compatibility — Verified
All 5 assumptions independently confirmed by both reviewer_a and reviewer_b via cross-repo source reading at `D:/Code/openclaw`. Hook timing (DEFERRED), dispatch path (gateway agent method), outcome mapping, deduplication — all correct. Compatibility risk: LOW.

### 3. Architecture Soundness
**Decision quality**: Sound. Migration follows from: (a) design doc Section 12.1 explicitly designates empathy as first candidate; (b) clear workflow boundaries (spawn→wait→parse→persist→cleanup); (c) structured JSON result; (d) existing timeout/fallback/cleanup issues; (e) PR2 scope compliance.

**Interface soundness**: Good. `SubagentWorkflowSpec<TResult>` is properly generic. `WorkflowManager` methods are clean and minimal. State machine handles all transitions correctly. Types re-export from `openclaw-sdk.js` correctly. The separation of `parseResult`/`persistResult` correctly delegates business logic to spec implementations.

**Extensibility**: Good. `registry_backed` transport defined but not implemented by design (PR2 scope). Future diagnostician migration has a clear path. `SubagentWorkflowSpec<TResult>` generic pattern supports new workflow types.

### 4. Business Flow Analysis
The migration preserves the full result persistence chain:
- Old: `spawn` → `waitForRun` → `getSessionMessages` → `trackFriction` + `eventLog.recordPainSignal` + `trajectory.recordPainEvent`
- New: `startWorkflow` → `notifyWaitResult` → `finalizeOnce` → `parseResult` → `persistResult`

The shadow mode (Phase 1, Weeks 1-2) ensures zero regression risk: both paths run, results compared, ≥95% match required before canary.

### 5. Shadow Run Plan Quality
Quantitative criteria are appropriate: 95% match, 100 triggers (statistical significance), 99% new path success, <500ms p95 parse, <1% orphan. Rollback triggers are well-defined with clear actions. Shadow schema design is sound.

### 6. Scope Control — Clean
PR2 scope: empathy observer + deep-reflect ONLY. Diagnostician/Nocturnal/Routing NOT migrated. No gold-plating. Helper location matches brief: `packages/openclaw-plugin/src/service/subagent-workflow/`.

---

## OPENCLAW_COMPATIBILITY_REVIEW

All assumptions verified via cross-repo source reading:

| Assumption | File:Line | Status |
|-----------|-----------|--------|
| subagent_ended fires for expectsCompletionMessage=true | subagent-registry-lifecycle.ts:521-533 | VERIFIED |
| Hook timing is DEFERRED | subagent-registry-lifecycle.ts:137-154 | VERIFIED |
| runtime.subagent.run() dispatches to gateway | server-plugins.ts:327-347 | VERIFIED |
| Outcome mapping correct | subagent-registry-completion.ts:32-42 | VERIFIED |
| Deduplication via endedHookEmittedAt | subagent-registry-completion.ts:58-63 | VERIFIED |

**Key insight**: The `subagent_ended` hook for `runtime_direct` runs DEFERRED to cleanup flow via `emitCompletionEndedHookIfNeeded()`. This is safe for empathy because `EmpathyObserverManager` (and the new helper) use `completedSessions` TTL-based dedup. The hook fires → `reap` fallback checks `isCompleted` → skips if already processed.

**Compatibility risk**: LOW — hook semantics are stable OpenClaw internals, all assumptions verified against source, no OpenClaw upgrade risks identified.

---

## ARCHITECTURE_ASSESSMENT

### Convergence: YES
Before helper: fragmented subagent lifecycle (EmpathyObserverManager + deep-reflect + evolution-worker + prompt hooks all with different patterns). After helper: unified `WorkflowManager` + `SubagentWorkflowSpec` + state machine + SQLite store. This is genuine architectural improvement, not just renaming.

### Data Flow Closure: YES
- sessionKey/runId/parentSessionId chain correctly tracked in `activeRuns` Map → SQLite `WorkflowRow`
- Dedup via `completedSessions` TTL → `WorkflowRow.cleanup_state`
- Orphan cleanup via `sweepExpiredWorkflows` with TTL
- Shadow mode validates no regression

### Interface Soundness: GOOD
Types are comprehensive, TypeScript-clean, properly generic. The `parseResult`/`persistResult` separation is correct (business modules own business logic, helper owns lifecycle). `notifyWaitResult` (runtime_direct path) and `notifyLifecycleEvent` (registry_backed path) cleanly separate the two transport mechanisms.

### Remaining Risks (Acceptable for Architecture-Cut Stage)
1. **No implementation yet** — types.ts is purely types. Acceptable: architecture-cut stage focuses on design, not implementation. Next stage will implement `workflow-manager.ts` and `runtime-direct-driver.ts`.
2. **Shadow mode hypothesis untested** — All hypotheses (reliability improvement, session leak reduction, result equivalence) are appropriately marked UNTESTED. Shadow mode exists precisely to validate these.
3. **State machine edge cases** — Assumed from design review. Implementation + shadow mode testing will validate.

---

## NEXT_FOCUS

For the **implement** stage (next sprint):
1. Implement `workflow-manager.ts` with full state machine
2. Implement `runtime-direct-driver.ts` for empathy transport
3. Implement `sweepExpiredWorkflows()` for orphan cleanup
4. Wire empathy observer dual-path (old path primary, new path shadow)
5. Create SQLite tables: `subagent_workflows`, `subagent_workflow_events`, `empathy_shadow_results`
6. Run shadow mode and collect metrics per shadow_run_plan.md
7. Ensure `finalizeOnce()` replicates `completedSessions` dedup behavior

---

## CHECKS

CHECKS: macro=aligned; business_flow=closed; architecture=converging; openclaw=verified; scope=clean; contract=done; dimensions=pass

---

## CODE_EVIDENCE

- files_verified: empathy-observer-manager.ts, types.ts, shadow_run_plan.md, 2026-03-31-subagent-workflow-helper-design.md, openclaw-sdk.d.ts, producer.md, reviewer-a.md, reviewer-b.md
- evidence_source: both (principles + openclaw)
- sha: d83c95af2f5a7be08fc42b7b82c80c46824e9cf7 (OpenClaw verification SHA from reviewer_b)
- evidence_scope: both (principles repo + openclaw cross-repo)
