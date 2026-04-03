# Reviewer B Report - Investigate Stage (Round 3)

**Role**: reviewer_b
**Stage**: investigate
**Round**: 3
**SHA**: 4138178581043646365326ee42dad4eab4037899

## VERDICT

**REVISE**

The investigate stage has produced solid documentation, but the **test coverage gap for the new workflow manager remains unresolved**. The empathy-observer-workflow-manager.ts (337 lines) has **zero tests**, while the existing empathy-observer-manager.ts has 17+ tests. This is a significant quality risk that must be addressed before implementation proceeds.

Additionally, the `openclaw_assumptions_documented` deliverable has a **minor inaccuracy**: the producer claims the hook is deferred "non-deterministic" but the OpenClaw source shows it's actually deferred until after the announce cleanup flow completes (deterministic outcome, just delayed timing).

## BLOCKERS

1. **CRITICAL: Zero test coverage for empathy-observer-workflow-manager**
   - 337-line new file with no tests
   - Existing empathy-observer-manager.ts has 17+ tests
   - This is a regression risk: no way to verify the migration doesn't break empathy detection

2. **MINOR: OpenClaw hook timing description is imprecise**
   - Producer says "timing is non-deterministic" but code shows deterministic deferral (until cleanup flow completes)
   - Not a blocker but should be clarified

## FINDINGS

### Hypothesis Verification (All now verified via cross-repo source reading)

| Hypothesis | Status | Evidence Source |
|------------|--------|----------------|
| empathy_uses_runtime_direct_transport | SUPPORTED | empathy-observer-manager.ts:193, empathy-observer-workflow-manager.ts:91 |
| empathy_has_unverified_openclaw_hook_assumptions | SUPPORTED | subagent-registry-lifecycle.ts:521-525 confirms hook can be DEFERRED when expectsCompletionMessage=true |
| empathy_timeout_leads_to_false_completion | REFUTED | empathy-observer-manager.ts:269-277 marks timedOutAt/observedAt, no false completion |
| empathy_cleanup_not_idempotent | SUPPORTED | empathy-observer-manager.ts:430-437 cleanupState(deleteFromActiveRuns=false) |
| empathy_lacks_dedupe_key | SUPPORTED | empathy-observer-manager.ts:198 uses `${sessionId}:${Date.now()}` |

### OpenClaw Hook Verification (Cross-Repo Evidence)

From `D:\Code\openclaw\src\agents\subagent-registry-lifecycle.ts:521-533`:

```typescript
const shouldDeferEndedHook =
  shouldEmitEndedHook &&
  completeParams.triggerCleanup &&
  entry.expectsCompletionMessage === true &&
  !suppressedForSteerRestart;
if (!shouldDeferEndedHook && shouldEmitEndedHook) {
  await params.emitSubagentEndedHookForRun({...});
}
```

**Key insight**: When `expectsCompletionMessage: true` and `triggerCleanup: true`, the `subagent_ended` hook is **deferred** (not skipped). It fires after the announce cleanup flow completes. This is NOT non-deterministic - it's a deterministic delay until the cleanup flow finishes.

The producer's conclusion is correct (hook becomes fallback mechanism), but the explanation is imprecise.

### Scope Assessment

**Scope: WELL CONTROLLED**
- PR2 scope: empathy observer + deep-reflect ONLY
- Helper lives in correct location: `packages/openclaw-plugin/src/service/subagent-workflow/`
- No modification to D:/Code/openclaw
- No unnecessary architectural expansion detected

### Transport Assessment

Both current and target use `runtime_direct` transport:
- Current: direct `api.runtime.subagent.run()` at line 193
- Target: `RuntimeDirectDriver.run()` wrapper at line 91

The migration preserves the same transport mechanism while adding SQLite persistence and state machine. This is the minimal sufficient fix.

### Test Coverage Assessment

| File | Lines | Tests | Coverage |
|------|-------|-------|----------|
| empathy-observer-manager.ts | 511 | 17+ | GOOD |
| empathy-observer-workflow-manager.ts | 337 | 0 | **MISSING** |
| runtime-direct-driver.ts | 156 | 0 | MISSING |

## CODE_EVIDENCE

```
files_verified: empathy-observer-manager.ts, empathy-observer-workflow-manager.ts, runtime-direct-driver.ts, openclaw-sdk.d.ts, subagent.ts, index.ts
evidence_source: both
sha: 4138178581043646365326ee42dad4eab4037899
evidence_scope: both
```

## HYPOTHESIS_MATRIX

- empathy_uses_runtime_direct_transport: SUPPORTED — Both current (empathy-observer-manager.ts:193) and target (empathy-observer-workflow-manager.ts:91) use `runtime.subagent.run()` with `deliver: false`, `expectsCompletionMessage: true`
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED — OpenClaw source (subagent-registry-lifecycle.ts:521-525) confirms hook DEFERRED when expectsCompletionMessage=true; fires after announce cleanup flow completes
- empathy_timeout_leads_to_false_completion: REFUTED — Timeout handler (empathy-observer-manager.ts:269-277) marks `timedOutAt`/`observedAt` and preserves session; no false completion emitted
- empathy_cleanup_not_idempotent: SUPPORTED — `cleanupState(deleteFromActiveRuns=false)` (line 430-437) preserves entry for subagent_ended fallback
- empathy_lacks_dedupe_key: SUPPORTED — Idempotency key uses `${sessionId}:${Date.now()}` (line 198), making each spawn unique

## NEXT_FOCUS

1. **Add tests for empathy-observer-workflow-manager** before implementation stage
2. **Clarify OpenClaw hook timing** in documentation - it's deferred deterministically, not non-deterministically
3. **Verify lifecycle hook wiring** - ensure `notifyLifecycleEvent` in new workflow manager properly connects to PD hook registration

## CHECKS

```
CHECKS: criteria=partial;blockers=1;verification=verified
```

## DIMENSIONS

```
DIMENSIONS: evidence_quality=4; assumption_coverage=4; transport_audit_completeness=5
```

**Explanation**:
- **evidence_quality=4**: All local source verified, OpenClaw cross-repo verification complete but hook timing description slightly imprecise
- **assumption_coverage=4**: All 5 hypotheses now verified, but OpenClaw hook deferral timing described as "non-deterministic" when it's actually "deterministically deferred"
- **transport_audit_completeness=5**: Excellent - both current and target fully audited with line-level citations

---

**Verdict: REVISE** — The investigate stage deliverables are substantially complete, but the test coverage gap for the new workflow manager (337 lines, zero tests) is a blocker that must be addressed before implementation proceeds.
