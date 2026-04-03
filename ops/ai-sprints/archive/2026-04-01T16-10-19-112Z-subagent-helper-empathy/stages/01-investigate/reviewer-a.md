# Reviewer A Report - Investigate Stage (Round 2)

## VERDICT

APPROVE

## BLOCKERS

None. All deliverables complete with accurate evidence.

## FINDINGS

### 1. Transport Audit Confirmed
Both empathy-observer and deep-reflect use `runtime_direct` transport via `api.runtime.subagent.run()`. No registry_backed usage found. This is accurate per the producer's report.

### 2. Deep-Reflect Bug Confirmed (CRITICAL)
**File**: `packages/openclaw-plugin/src/tools/deep-reflect.ts`
- Line 287: `subagentRuntime.run()` is called but return value is discarded
- Line 289: `waitForRun({ runId: sessionKey })` passes `sessionKey` as `runId`
- **Root cause**: The SDK contract defines `SubagentRunResult.runId` as a separate field from `sessionKey`. deep-reflect incorrectly conflates them.
- **Impact**: waitForRun always times out because `sessionKey` is not a valid `runId`. The subagent runs to completion, but the tool reports timeout.

### 3. Empathy-Observer Correct Implementation
**File**: `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`
- Lines 193-201: Correctly extracts `runId` from `SubagentRunResult` and uses it for `waitForRun`
- This demonstrates the correct pattern that deep-reflect should follow

### 4. Lifecycle Hook Map Verified
- `subagent_spawning` (index.ts:194): Registered, used only for shadow routing, NOT for empathy context injection
- `subagent_ended` (index.ts:232): Registered, triggers `handleSubagentEnded()` which calls `empathyObserverManager.reap()` for fallback cleanup
- No other subagent lifecycle hooks are used

### 5. OpenClaw Assumptions
- Assumption: `subagent_ended` hook always fires → SUPPORTED with caveat
- Caveat: If subagent crashes hard without OpenClaw catching it, hook may not fire
- Mitigation: 5-minute TTL-based cleanup (lines 56-66 in empathy-observer-manager.ts)

### 6. Idempotency Analysis
- `idempotencyKey` format: `${sessionId}:${Date.now()}` (line 198)
- Includes timestamp, making each spawn attempt unique
- NOT session-level stable - SUPPORTED
- `isCompleted()` 5-minute TTL provides temporary idempotency for reap operations

## TRANSPORT_ASSESSMENT

| Component | Transport | Registry | Method |
|-----------|-----------|----------|--------|
| empathy-observer | runtime_direct | No | `api.runtime.subagent.run()` |
| deep-reflect | runtime_direct | No | `api.runtime.subagent.run()` |

Both components use fire-and-forget `run()` + `waitForRun()` polling pattern. Neither uses session-mode delivery.

## OPENCLAW_ASSUMPTION_REVIEW

| Assumption | Status | Evidence |
|------------|--------|----------|
| `run()` returns `{ runId }` distinct from `sessionKey` | VERIFIED | openclaw-sdk.d.ts:95-98 |
| `waitForRun` requires `runId` not `sessionKey` | VERIFIED | openclaw-sdk.d.ts:99-103 |
| `subagent_ended` fires on termination | SUPPORTED | index.ts:232 registration |
| Hook timing vs finalizeRun is racy | UNPROVEN | No direct evidence, theoretical concern |

## HYPOTHESIS_MATRIX

- empathy_uses_runtime_direct_transport: SUPPORTED — Both empathy-observer (line 193) and deep-reflect (line 284) call `api.runtime.subagent.run()` directly. No registry involvement.
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED — empathy relies on `subagent_ended` firing for fallback cleanup; OpenClaw SDK does not formally guarantee this (void return type in hook handler). TTL-based cleanup mitigates orphaned entries.
- empathy_timeout_leads_to_false_completion: SUPPORTED — `finalizeRun` timeout (lines 269-277) sets `timedOutAt`/`observedAt` but preserves `activeRuns` entry for fallback. The timed-out observer does not record pain signals unless fallback fires.
- empathy_cleanup_not_idempotent: PARTIAL — `isCompleted()` check (lines 306-310) prevents double-reap within 5-minute TTL. After TTL expiry, re-reap is possible but unlikely in practice.
- empathy_lacks_dedupe_key: SUPPORTED — `idempotencyKey` format `${sessionId}:${Date.now()}` includes timestamp, making each spawn unique. Not session-level stable.

## NEXT_FOCUS

The deep-reflect bug is a pre-existing issue that falls within PR2 scope. The migration to workflow helper should:

1. Fix the `waitForRun` bug in deep-reflect (use `runId` from `SubagentRunResult`)
2. Ensure the helper pattern correctly handles the `runId` vs `sessionKey` distinction
3. Add explicit documentation about the transport contract

## CHECKS

CHECKS: criteria=met;blockers=0;verification=complete

## DIMENSIONS

DIMENSIONS: evidence_quality=5; assumption_coverage=4; transport_audit_completeness=5

## CODE_EVIDENCE

- files_verified: empathy-observer-manager.ts, deep-reflect.ts, subagent.ts, index.ts, openclaw-sdk.d.ts, subagent-probe.ts
- evidence_source: local
- sha: 4138178
- evidence_scope: principles
