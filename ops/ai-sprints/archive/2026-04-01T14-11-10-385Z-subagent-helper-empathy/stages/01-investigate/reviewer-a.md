# Reviewer A Report — Investigate Stage (Round 3)

## VERDICT

APPROVE

## BLOCKERS

None.

## FINDINGS

### 1. Transport Audit Complete

Producer correctly identified runtime_direct transport. Verified 4 direct `api.runtime.subagent.*` API calls:
- `run()` at empathy-observer-manager.ts:193
- `waitForRun()` at empathy-observer-manager.ts:253
- `getSessionMessages()` at empathy-observer-manager.ts:321
- `deleteSession()` at empathy-observer-manager.ts:385

No registry_backed transport usage found.

### 2. Lifecycle Hook Map Accurate

Hook registration verified at index.ts:231-260. Handler routing confirmed:
- `subagent_ended` hook fires → `handleSubagentEnded()` at subagent.ts:164
- `isEmpathyObserverSession()` check at subagent.ts:175 correctly identifies empathy sessions
- Routes to `empathyObserverManager.reap()` at subagent.ts:176

### 3. Failure Mode Inventory Validated

All 6 failure modes have test coverage:
1. **Timeout** — Test 161-179: no deleteSession, no friction tracking, preserves activeRuns
2. **Error** — Test 141-159: deferred cleanup, preserved for fallback
3. **getSessionMessages failure** — Test 199-213: finalized=false, session preserved
4. **deleteSession failure** — Test 215-230: idempotent via completedSessions
5. **Concurrent spawn** — Test 88-97: blocked by sessionLocks
6. **TTL expiry** — Test 181-197: 5-min TTL cleanup

### 4. OpenClaw Assumptions

**A1: subagent_ended fires for empathy sessions** — SUPPORTED by code inspection. Hook registration follows standard pattern, handler correctly routes empathy sessions.

**A2: subagent_ended fires when waitForRun times out** — SUPPORTED by code inspection. Timeout path (line 269-276) sets timedOutAt/observedAt but does NOT call deleteSession, preserving session for fallback.

**Type discrepancy noted**: `expectsCompletionMessage` is in `PluginHookSubagentDeliveryTargetEvent` (openclaw-sdk.d.ts:397) but NOT in `SubagentRunParams` (openclaw-sdk.d.ts:87-93). Producer correctly identified this as a type-level concern; TypeScript's structural typing allows extra properties at runtime. Runtime behavior is correct.

### 5. Test Count Discrepancy

Producer claimed 17 tests but actual count is 22 tests. This discrepancy does NOT affect validity — all claimed failure modes are covered. Updated count reflects additional tests for session key format, sanitization, and edge cases.

## HYPOTHESIS_MATRIX

- empathy_uses_runtime_direct_transport: SUPPORTED — 4 direct API calls verified in source
- empathy_has_unverified_openclaw_hook_assumptions: PARTIALLY SUPPORTED — Type discrepancy exists; runtime behavior confirmed via hook wiring
- empathy_timeout_leads_to_false_completion: REFUTED — Test 161-179 confirms no friction tracking on timeout
- empathy_cleanup_not_idempotent: REFUTED — Test 286-301 confirms completedSessions Map prevents double processing
- empathy_lacks_dedupe_key: PARTIALLY SUPPORTED — idempotencyKey passed but unique per spawn; Map-based deduplication is primary mechanism

## CODE_EVIDENCE

```
files_verified: empathy-observer-manager.ts, subagent.ts, index.ts, openclaw-sdk.d.ts, empathy-observer-manager.test.ts
evidence_source: local
sha: 10bcc2022b6f6b6f021fbf6a574dba9e6af0e8fe
evidence_scope: principles
```

## NEXT_FOCUS

Migration planning can proceed. Key considerations:
1. `expectsCompletionMessage` parameter — verify OpenClaw runtime behavior during migration
2. Transport abstraction — helper should encapsulate runtime_direct vs registry_backed detection
3. Hook handler — migrate `handleSubagentEnded` routing logic to helper

## CHECKS

CHECKS: criteria=met;blockers=0;verification=complete;test_count_discrepancy=noted_but_non_blocking

## DIMENSIONS

DIMENSIONS: evidence_quality=5; assumption_coverage=4; transport_audit_completeness=5

## CONTRACT REVIEW

All 4 deliverables meet DONE criteria:
- transport_audit: DONE — 4 API calls documented with line numbers
- lifecycle_hook_map: DONE — Hook registration and routing verified
- openclaw_assumptions_documented: DONE — A1/A2 assessed with evidence
- failure_mode_inventory: DONE — 6 modes with test line references

## ACCURACY CORRECTIONS

1. Test count: 22 tests (not 17 as claimed)
2. Deduplication: Primary mechanism is `completedSessions` Map, not `idempotencyKey`
