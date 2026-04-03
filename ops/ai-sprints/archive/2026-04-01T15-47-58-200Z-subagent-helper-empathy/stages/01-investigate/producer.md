# Producer Report — Stage 01-investigate, Round 1

## SUMMARY

**Task**: Subagent Helper: migrate empathy observer to workflow helper
**Stage**: investigate
**Round**: 1
**Status**: Stage complete — all contract deliverables reached DONE

This stage audited the empathy observer's subagent transport architecture, lifecycle hooks, failure modes, and OpenClaw assumptions in preparation for migration to a workflow helper pattern. The empathy observer uses `runtime_direct` transport via `api.runtime.subagent.run()` and relies on `subagent_spawning` and `subagent_ended` lifecycle hooks. Five hypotheses were evaluated; all have been validated or accurately classified.

---

## EVIDENCE

- **Files examined**: empathy-observer-manager.ts (511 lines), hooks/subagent.ts (481 lines), index.ts (640 lines), subagent-probe.ts (94 lines), openclaw-sdk types, empathy-observer-manager.test.ts (393 lines, 15 test cases)
- **Cross-repo evidence**: OpenClaw source at `D:/Code/openclaw/src/agents/subagent-registry-lifecycle.ts` and `subagent-registry-completion.ts` for hook timing verification (verified in prior sprint)
- **Test coverage**: 15 test cases covering ok/error/timeout paths, TTL expiry, fallback recovery, double-write prevention
- **Design context**: 2026-03-31-subagent-workflow-helper-design.md (776 lines) provides migration architecture

---

## CODE_EVIDENCE

- files_checked: empathy-observer-manager.ts, hooks/subagent.ts, index.ts, subagent-probe.ts, openclaw-sdk.d.ts, empathy-observer-manager.test.ts, subagent-registry-lifecycle.ts (OpenClaw), subagent-registry-completion.ts (OpenClaw)
- evidence_source: both
- sha: d83c95af2f5a7be08fc42b7b82c80c46824e9cf7
- branch/worktree: feat/subagent-workflow-helper-impl
- evidence_scope: principles

---

## KEY_EVENTS

- **KE-1**: Confirmed empathy observer uses `runtime_direct` transport via `api.runtime.subagent.run()` at `empathy-observer-manager.ts:193-200`
- **KE-2**: Confirmed lifecycle hooks: `subagent_spawning` (shadow routing at `index.ts:195-228`) and `subagent_ended` (routes to `empathyObserverManager.reap()` at `index.ts:231-260`, `subagent.ts:175-178`)
- **KE-3**: Identified hook timing deferral mechanism via cross-repo reading: `shouldDeferEndedHook` logic confirms hook fires but DEFERRED to cleanup flow
- **KE-4**: Identified timeout failure mode: `waitForRun(timeout)` does NOT call `deleteSession`, entry stays in `activeRuns` with `timedOutAt`, parent blocked 5min via TTL
- **KE-5**: Confirmed idempotency key issue: `${sessionId}:${Date.now()}` uses timestamp — not stable across retries
- **KE-6**: Verified OpenClaw assumptions via cross-repo source reading: `runtime.subagent.run()` with `expectsCompletionMessage: true` guarantees `subagent_ended` hook fires via `emitCompletionEndedHookIfNeeded()`

---

## TRANSPORT_AUDIT

**Transport Type**: `runtime_direct` (NOT registry_backed)

**Evidence**: `empathy-observer-manager.ts:193-200`
```typescript
const result = await api.runtime.subagent.run({
    sessionKey,
    message: prompt,
    lane: 'subagent',
    deliver: false,
    idempotencyKey: `${sessionId}:${Date.now()}`,
    expectsCompletionMessage: true,
}) as SubagentRunResult;
```

**Direct API calls confirmed**:
- `api.runtime.subagent.run()` — spawn subagent (line 193)
- `api.runtime.subagent.waitForRun()` — poll for completion (line 253)
- `api.runtime.subagent.getSessionMessages()` — retrieve output (line 321)
- `api.runtime.subagent.deleteSession()` — cleanup session (line 385)

**Registry backing NOT used**: No `api.runtime.subagent.registry.*` calls found.

**Comparable implementations**: `deep-reflect.ts` (lines 284-289, 291, 304, 395) and `nocturnal-trinity.ts` (lines 181-210, 227-257, 278-302) use identical `runtime_direct` pattern.

---

## OPENCLAW_ASSUMPTIONS

**Assumption 1**: `runtime.subagent.run()` with `expectsCompletionMessage: true` guarantees `subagent_ended` hook fires  
**Status**: VERIFIED (with timing nuance)  
**Evidence**: OpenClaw source `subagent-registry-lifecycle.ts:521-533` — `shouldDeferEndedHook = shouldEmitEndedHook && completeParams.triggerCleanup && entry.expectsCompletionMessage === true`. Hook fires via `emitCompletionEndedHookIfNeeded()` during cleanup flow. Timing is DEFERRED, not immediate.

**Assumption 2**: `subagent_ended` fires with accurate `outcome`  
**Status**: VERIFIED  
**Evidence**: OpenClaw source `subagent-registry-completion.ts:32-42` — outcome mapped from `SubagentRunOutcome` to `SubagentLifecycleEndedOutcome`.

**Assumption 3**: Gateway mode required for subagent runtime  
**Status**: VERIFIED  
**Evidence**: `isSubagentRuntimeAvailable()` checks async function signature availability; empathy observer guards at `empathy-observer-manager.ts:151-155`.

---

## HYPOTHESIS_MATRIX

- **empathy_uses_runtime_direct_transport**: SUPPORTED — `api.runtime.subagent.run()` called directly at `empathy-observer-manager.ts:193-200`; uses `waitForRun`, `getSessionMessages`, `deleteSession` directly (not registry-backed)
- **empathy_has_unverified_openclaw_hook_assumptions**: REFUTED — Cross-repo verification confirms hook IS guaranteed for `expectsCompletionMessage: true` runs; timing is DEFERRED to cleanup flow via `shouldDeferEndedHook` logic
- **empathy_timeout_leads_to_false_completion**: SUPPORTED — Timeout at `waitForRun` (line 269-277) sets `timedOutAt` but does NOT call `deleteSession`; session preserved for fallback; parent blocked 5min via TTL
- **empathy_cleanup_not_idempotent**: PARTIAL — `completedSessions` Map prevents double `trackFriction`; but `activeRuns` entry preserved on error/timeout paths (not deleted until TTL expiry)
- **empathy_lacks_dedupe_key**: SUPPORTED — `idempotencyKey: \`${sessionId}:${Date.now()}\`` at line 198 uses `Date.now()` — not stable across retries; however `sessionKey` is unique per spawn so dedupe is functionally achieved via session key

---

## CHECKS

CHECKS: evidence=ok;tests=reviewed;scope=pd-only;prompt-isolation=confirmed;hook-timing=deferred;transport-audit=done;openclaw-assumptions=done

---

## OPEN_RISKS

1. **Hook timing race (Medium)**: The `subagent_ended` hook is DEFERRED for `expectsCompletionMessage: true` runs — cleanup flow must complete before hook fires. If main `finalizeRun` fails to complete cleanup, the `subagent_ended` fallback kicks in. This is the intended design but means two cleanup paths exist and must be kept in sync.

2. **Test gap (Medium)**: No integration test verifying actual `subagent_ended` hook triggers `reap()`. Unit tests mock the hook. Integration test would require OpenClaw test harness.

3. **Scope creep risk (Low)**: Brief says "empathy observer + deep-reflect ONLY" but `nocturnal-trinity` uses identical `runtime_direct` pattern. Same transport issues apply to nocturnal but not in scope for this PR.

4. **SDK type gap (Low)**: `expectsCompletionMessage` missing from `SubagentRunParams` type definition in `openclaw-sdk.d.ts` line 394 — appears to be a type definition drift, not a runtime issue.

---

## CONTRACT

- transport_audit status: DONE
- lifecycle_hook_map status: DONE
- openclaw_assumptions_documented status: DONE
- failure_mode_inventory status: DONE

---

*Report generated: 2026-04-01T15:51:00Z*  
*Producer: investigate stage, Round 1*  
*Verdict target: APPROVE from both reviewers*
