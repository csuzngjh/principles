# Reviewer B Report — Stage 01-investigate, Round 3

## VERDICT: APPROVE

## DIMENSIONS
DIMENSIONS: evidence_quality=4; assumption_coverage=4; transport_audit_completeness=5

## CONTRACT
- transport_audit status: DONE ✓
- lifecycle_hook_map status: DONE ✓
- openclaw_assumptions_documented status: DONE ✓
- failure_mode_inventory status: DONE ✓

## BLOCKERS
None. All contract deliverables reached DONE status with adequate evidence.

## FINDINGS

### 1. Transport Audit — VERIFIED COMPLETE
- **runtime_direct** confirmed at `empathy-observer-manager.ts:193-200`:
  - Uses `api.runtime.subagent.run()` directly (NOT registry-backed)
  - Direct API calls: `waitForRun`, `getSessionMessages`, `deleteSession` confirmed
- **Comparable implementations**: `deep-reflect.ts:284-304` and `nocturnal-trinity.ts` use identical `runtime_direct` pattern
- No registry backing found

### 2. Lifecycle Hook Map — VERIFIED COMPLETE
- `subagent_spawning` at `index.ts:195-228`: shadow routing only (not empathy-specific)
- `subagent_ended` at `index.ts:232-260`: delegates to `handleSubagentEnded`
- `handleSubagentEnded` at `subagent.ts:175-178`: routes empathy sessions to `empathyObserverManager.reap()`
- Hook routing is correct

### 3. OpenClaw Assumptions — VERIFIED VIA CROSS-REPO READING
**Access**: `D:/Code/openclaw/src/agents/` (SHA: f5431bc07e7321466530cc4b811ac2dc66c84bdc)

**Assumption 1**: `expectsCompletionMessage: true` guarantees `subagent_ended` hook
- VERIFIED at `subagent-registry-lifecycle.ts:521-533`
- `shouldDeferEndedHook` = true when `entry.expectsCompletionMessage === true && triggerCleanup === true`
- Hook fires via `emitCompletionEndedHookIfNeeded()` during cleanup flow (DEFERRED, not immediate)

**Assumption 2**: `subagent_ended` fires with accurate outcome
- VERIFIED at `subagent-registry-completion.ts:32-42`
- `resolveLifecycleOutcomeFromRunOutcome()` maps `SubagentRunOutcome` → `SubagentLifecycleEndedOutcome`

**Assumption 3**: Gateway mode required for subagent runtime
- VERIFIED at `empathy-observer-manager.ts:151-155` via `isSubagentRuntimeAvailable()` check

### 4. Failure Mode Inventory — VERIFIED COMPLETE
| Mode | Confirmed | Evidence |
|------|-----------|----------|
| timeout | ✓ | Lines 269-277: `timedOutAt` set, `deleteSession` NOT called |
| error | ✓ | Lines 258-266: `erroredAt` set, `deleteSession` NOT called |
| getSessionMessages failure | ✓ | Lines 376-394: finalized=false preserves session for fallback |
| deleteSession failure | ✓ | Lines 387-390: finalized=true marks completed anyway |
| double-spawn blocked | ✓ | Lines 156-159: `isActive()` check blocks duplicates |
| race: main vs fallback | ✓ | Lines 306-310: `isCompleted()` check prevents double processing |

### 5. Hypothesis Matrix — ACCURATE

| Hypothesis | Status | Evidence |
|------------|--------|----------|
| empathy_uses_runtime_direct_transport | SUPPORTED | `empathy-observer-manager.ts:193-200` |
| empathy_has_unverified_openclaw_hook_assumptions | REFUTED | Cross-repo verification confirms hook guaranteed (timing deferred) |
| empathy_timeout_leads_to_false_completion | SUPPORTED | Lines 269-277: timeout sets `timedOutAt` but doesn't call `deleteSession` |
| empathy_cleanup_not_idempotent | PARTIAL | `completedSessions` Map prevents double `trackFriction`; `activeRuns` preserved on error/timeout |
| empathy_lacks_dedupe_key | SUPPORTED | Line 198: `${sessionId}:${Date.now()}` uses timestamp (sessionKey provides uniqueness) |

### 6. Test Coverage — ADEQUATE
- `empathy-observer-manager.test.ts`: 393 lines, 15+ test cases
- Covers: ok/error/timeout paths, TTL expiry, fallback recovery, double-write prevention
- **Gap acknowledged**: No integration test verifying actual `subagent_ended` hook triggers `reap()` (unit tests mock hook only)

### 7. Open Risks — ACCURATELY CHARACTERIZED
1. **Hook timing race (Medium)**: Correctly identified — cleanup flow must complete before hook fires
2. **Test gap (Medium)**: Integration test for `subagent_ended` → `reap()` path not present
3. **Scope creep risk (Low)**: nocturnal-trinity uses same pattern but not in scope
4. **SDK type gap (Low)**: `expectsCompletionMessage` missing from `SubagentRunParams` in `openclaw-sdk.d.ts` — type drift only, not runtime issue

## HYPOTHESIS_MATRIX
- empathy_uses_runtime_direct_transport: SUPPORTED — `api.runtime.subagent.run()` at empathy-observer-manager.ts:193-200
- empathy_has_unverified_openclaw_hook_assumptions: REFUTED — Cross-repo verification at subagent-registry-lifecycle.ts:521-533 confirms hook guaranteed for expectsCompletionMessage=true runs
- empathy_timeout_leads_to_false_completion: SUPPORTED — Lines 269-277: timeout sets timedOutAt but does NOT call deleteSession
- empathy_cleanup_not_idempotent: PARTIAL — completedSessions Map prevents double trackFriction; activeRuns entry preserved on error/timeout paths
- empathy_lacks_dedupe_key: SUPPORTED — idempotencyKey at line 198 uses Date.now() (sessionKey provides functional uniqueness)

## CODE_EVIDENCE
- files_verified: empathy-observer-manager.ts, index.ts, hooks/subagent.ts, deep-reflect.ts, nocturnal-trinity.ts, openclaw-sdk.d.ts, subagent-registry-lifecycle.ts (OpenClaw), subagent-registry-completion.ts (OpenClaw), empathy-observer-manager.test.ts
- evidence_source: both
- sha: d83c95af2f5a7be08fc42b7b82c80c46824e9cf7
- evidence_scope: both

## NEXT_FOCUS
For subsequent phases:
1. Verify `subagent-workflow/` helper location matches brief constraint
2. Confirm `deep-reflect` migration is addressed (not just empathy observer)
3. Validate integration test gap is filled or formally accepted
4. Monitor hook timing race condition in practice

## CHECKS
CHECKS: criteria=met;blockers=0;verification=full;evidence=verified_via_cross-repo;hypothesis=accurate;transport_audit=complete;openclaw_assumptions=verified;failure_modes=verified;test_coverage=adequate

---

*Reviewer B — Round 3 complete*  
*All contract deliverables: DONE*  
*All hypotheses: accurately classified*  
*Cross-repo OpenClaw verification: complete*
