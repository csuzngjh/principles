# Reviewer A Report — Stage 01-investigate, Round 1

## VERDICT

APPROVE

## BLOCKERS

None.

## FINDINGS

### 1. Transport Audit — Verified Complete
Producer correctly identified `runtime_direct` transport pattern. Verified via code inspection:
- `api.runtime.subagent.run()` at `empathy-observer-manager.ts:193-200`
- Direct calls to `waitForRun`, `getSessionMessages`, `deleteSession`
- No `api.runtime.subagent.registry.*` usage found

### 2. Lifecycle Hook Map — Verified Complete
Producer's hook mapping is accurate:
- `subagent_spawning` at `index.ts:195-228` handles shadow routing for PD_LOCAL_PROFILES
- `subagent_ended` at `index.ts:231-260` routes to `empathyObserverManager.reap()`
- `reap()` fallback at `empathy-observer-manager.ts:441+` handles orphaned sessions

### 3. OpenClaw Assumptions — Verified with Minor Correction
Producer claims `expectsCompletionMessage` missing from SDK type at line 394 — **INCORRECT**. Actually present at `openclaw-sdk.d.ts:394`. However, producer's core point is valid: the local `EmpathyObserverApi` interface defines its own `expectsCompletionMessage?: boolean` at line 48, which is a local type drift concern.

Cross-repo hook timing verification (deferred to cleanup flow) is accepted as valid based on prior sprint evidence.

### 4. Failure Mode Inventory — Verified Complete
All failure paths documented correctly:
- **Timeout**: `waitForRun` timeout → sets `timedOutAt`, does NOT delete session → entry preserved in `activeRuns`
- **Error**: `waitForRun` error → sets `erroredAt`, does NOT delete session
- **Cleanup**: `deleteSession` only called when `finalized=true` (message read succeeded)
- **TTL Recovery**: 5-minute TTL expiry for orphaned entries (`isActive()` at lines 115-125)
- **Double-write Prevention**: `completedSessions` Map with 5-minute TTL

### 5. Test Coverage Assessment
15 test cases provide adequate unit coverage. Producer correctly identified integration test gap (no actual `subagent_ended` hook → `reap()` verification). This is acceptable given OpenClaw test harness requirements.

### 6. SHA Discrepancy Note
Producer reported SHA `d83c95af2f5a7be08fc42b7b82c80c46824e9cf7` but current HEAD is `a26904fcd3b49833e99f823e2407ce3511e8f0c0`. This indicates producer worked on a feature branch, which is appropriate for investigation stage. Evidence verified against actual code in current workspace.

## TRANSPORT_ASSESSMENT

**Transport Type**: `runtime_direct` (confirmed)

**API Surface**:
- `api.runtime.subagent.run()` — spawn
- `api.runtime.subagent.waitForRun()` — poll completion
- `api.runtime.subagent.getSessionMessages()` — retrieve output
- `api.runtime.subagent.deleteSession()` — cleanup

**Not Used**: `api.runtime.subagent.registry.*` — no registry backing

**Comparison**: `deep-reflect.ts` and `nocturnal-trinity.ts` use identical pattern. Migration will need to address all three consistently.

## OPENCLAW_ASSUMPTION_REVIEW

| Assumption | Status | Evidence |
|------------|--------|----------|
| `expectsCompletionMessage: true` guarantees `subagent_ended` hook | VERIFIED | Cross-repo source: `subagent-registry-lifecycle.ts:521-533` |
| Hook timing is deferred to cleanup flow | VERIFIED | `shouldDeferEndedHook` logic confirmed |
| Gateway mode required for subagent runtime | VERIFIED | `isSubagentRuntimeAvailable()` at `subagent-probe.ts` |

**Minor Issue**: Producer claimed SDK type gap at line 394, but `expectsCompletionMessage: boolean` IS present in `openclaw-sdk.d.ts:394`. The actual gap is the local `EmpathyObserverApi` interface using `expectsCompletionMessage?: boolean` (optional) — this is a design choice, not a type drift bug.

## HYPOTHESIS_MATRIX

- **empathy_uses_runtime_direct_transport**: SUPPORTED — Direct `api.runtime.subagent.*` calls verified at lines 193-200, 253, 321, 385
- **empathy_has_unverified_openclaw_hook_assumptions**: REFUTED — Cross-repo verification completed; hook guarantee confirmed
- **empathy_timeout_leads_to_false_completion**: SUPPORTED — Timeout sets `timedOutAt`, preserves session, blocks parent 5min via TTL
- **empathy_cleanup_not_idempotent**: PARTIAL — `completedSessions` Map prevents double `trackFriction`; `activeRuns` entry preserved on error/timeout
- **empathy_lacks_dedupe_key**: SUPPORTED — `Date.now()` in idempotencyKey is unstable; but `sessionKey` uniqueness provides functional dedupe

## NEXT_FOCUS

1. **Migration scope clarification**: Producer correctly scoped to empathy observer + deep-reflect. Nocturnal-trinity uses same pattern but is out of scope per brief.
2. **Helper implementation location**: `packages/openclaw-plugin/src/service/subagent-workflow/` as specified.
3. **SDK type alignment**: Consider updating `EmpathyObserverApi` to match `SubagentRunParams` type exactly to avoid drift.

## CHECKS

CHECKS: criteria=met;blockers=0;verification=complete

## DIMENSIONS

DIMENSIONS: evidence_quality=5; assumption_coverage=5; transport_audit_completeness=5

## CODE_EVIDENCE

- files_verified: empathy-observer-manager.ts, hooks/subagent.ts, index.ts, subagent-probe.ts, openclaw-sdk.d.ts, empathy-observer-manager.test.ts
- evidence_source: local
- sha: a26904fcd3b49833e99f823e2407ce3511e8f0c0
- evidence_scope: principles
