# Reviewer B Report - Stage 01-investigate, Round 1

## VERDICT

**APPROVE**

The producer investigation is thorough, evidence-backed, and correctly classifies all five hypotheses. Transport audit confirms runtime_direct transport. OpenClaw hook assumptions are verified via cross-repo source reading. No blockers remain.

---

## BLOCKERS

None. All required hypotheses verified or accurately classified.

---

## FINDINGS

### F1: Transport Type Confirmed
runtime_direct transport via api.runtime.subagent.run() at empathy-observer-manager.ts:193-200. Direct calls: run (193), waitForRun (253), getSessionMessages (321), deleteSession (385). No registry.* calls.

### F2: Lifecycle Hook Mapping Verified
- subagent_spawning: index.ts:195-228 (shadow routing)
- subagent_ended: index.ts:231-260 routes to handleSubagentEnded
- handleSubagentEnded: subagent.ts:175-178 routes empathy sessions to empathyObserverManager.reap()

### F3: OpenClaw Hook Timing �� Verified via Cross-Repo Source
subagent-registry-lifecycle.ts:521-533: shouldDeferEndedHook logic confirms hook guaranteed for expectsCompletionMessage: true runs. Timing DEFERRED to cleanup flow. emitCompletionEndedHookIfNeeded at 137-154 confirms emission.

### F4: SDK Type Gap �� Confirmed
SubagentRunParams in openclaw-sdk.d.ts:86-93 missing expectsCompletionMessage. empathy-observer-manager.ts:199 passes it anyway. Type drift, runtime works.

### F5: Idempotency Key Issue �� Confirmed
empathy-observer-manager.ts:198 uses timestamp in idempotencyKey. Low severity since sessionKey provides uniqueness.

### F6: Timeout Failure Mode �� Confirmed
waitForRun timeout (269-277) sets timedOutAt but does NOT call deleteSession. Session preserved for subagent_ended fallback. 5min TTL block.

### F7: Cleanup Idempotency �� PARTIAL
completedSessions Map prevents double trackFriction. activeRuns entry preserved on error/timeout (correct fallback behavior).

### F8: Test Coverage �� Verified
15 test cases in tests/service/empathy-observer-manager.test.ts (393 lines). Gap: no integration test for hook rechap.

---

## TRANSPORT_ASSESSMENT

Type: runtime_direct (NOT registry_backed). Direct API confirmed. Hook timing verified DEFERRED.

---

## OPENCLAW_ASSUMPTION_REVIEW

All 4 assumptions verified via cross-repo source reading at subagent-registry-lifecycle.ts and subagent-registry-completion.ts.

---

## HYPOTHESIS_MATRIX

- empathy_uses_runtime_direct_transport: SUPPORTED
- empathy_has_unverified_openclaw_hook_assumptions: REFUTED (verified via cross-repo)
- empathy_timeout_leads_to_false_completion: SUPPORTED
- empathy_cleanup_not_idempotent: PARTIAL (correct fallback behavior)
- empathy_lacks_dedupe_key: SUPPORTED (low severity)

---

## NEXT_FOCUS

1. SDK type sync: add expectsCompletionMessage to SubagentRunParams
2. Integration test for hook rechap
3. Idempotency key cleanup

---

## CHECKS

CHECKS: criteria=met;blockers=0;verification=partial

---

## DIMENSIONS

DIMENSIONS: evidence_quality=4; assumption_coverage=5; transport_audit_completeness=4

---

## CODE_EVIDENCE

- files_verified: empathy-observer-manager.ts, index.ts, subagent.ts, subagent-probe.ts, openclaw-sdk.d.ts, empathy-observer-manager.test.ts, subagent-registry-lifecycle.ts, subagent-registry-completion.ts
- evidence_source: both
- sha: d83c95af2f5a7be08fc42b7b82c80c46824e9cf7
- evidence_scope: both
