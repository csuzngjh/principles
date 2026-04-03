# Reviewer A Report - Investigate Stage (Round 3)

## VERDICT
APPROVE

## BLOCKERS
None.

## FINDINGS

### 1. Transport Audit Complete
The producer correctly identified that empathy observer uses **RUNTIME_DIRECT** transport via `api.runtime.subagent.run()` at L193. All four runtime methods (`run`, `waitForRun`, `getSessionMessages`, `deleteSession`) are called directly without registry mediation.

### 2. Configuration Correctness Verified
Empathy observer uses `deliver: false` + `expectsCompletionMessage: true` which is the **correct** configuration for completion mode without announce deferral. This ensures `subagent_ended` hook fires promptly.

### 3. Idempotency Key Issue Confirmed
The `idempotencyKey` at L198 uses `Date.now()` which is unstable for retries:
```typescript
idempotencyKey: `${sessionId}:${Date.now()}`
```
Migration to workflow helper should use stable key: `${sessionId}` only.

### 4. TTL-Based Orphan Detection Verified
The `isActive()` method (L106-130) correctly implements TTL-based cleanup (5 minutes) for orphaned sessions where `subagent_ended` never fires. This provides defense-in-depth against fire-and-forget hook failures.

### 5. Cleanup Idempotency Confirmed
The `completedSessions` TTL map (L92-104) combined with `isCompleted()` check (L306-310) provides idempotent reap protection. Timeout path correctly calls `cleanupState(..., false)` preserving `activeRuns` entry for fallback.

### 6. SDK Type Gap Noted
`expectsCompletionMessage` parameter is NOT in official `SubagentRunParams` type (openclaw-sdk.d.ts L85-109). This requires cross-repo verification (reviewer B responsibility).

### 7. All Contract Deliverables DONE
- transport_audit: Complete with mechanism analysis
- lifecycle_hook_map: Structured documentation with call flows
- openclaw_assumptions_documented: All assumptions with verification status
- failure_mode_inventory: 10 failure paths documented with mitigations

## CODE_EVIDENCE
- files_verified: empathy-observer-manager.ts:193-200, empathy-observer-manager.ts:92-130, empathy-observer-manager.ts:306-310, empathy-observer-manager.ts:246-275, subagent.ts:171-200, openclaw-sdk.d.ts:85-109
- evidence_source: local
- sha: 72681427b70501c02190c64c7c557788022a78bd
- evidence_scope: principles

## HYPOTHESIS_MATRIX
- empathy_uses_runtime_direct_transport: SUPPORTED — Direct `api.runtime.subagent.run()` at L193; no registry_backed alternative
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED — `expectsCompletionMessage` not in SDK type; session-mode `subagent_ended` never fires (cross-repo)
- empathy_timeout_leads_to_false_completion: REFUTED — Timeout calls `cleanupState(..., false)` preserving activeRuns; `timedOutAt` set but no premature completion
- empathy_cleanup_not_idempotent: REFUTED — `completedSessions` TTL map (L92-104) provides dedupe; `isCompleted()` check (L306-310) prevents double-write
- empathy_lacks_dedupe_key: SUPPORTED — `idempotencyKey` uses `Date.now()` at L198; not stable for retries

## NEXT_FOCUS
Migration to workflow helper should:
1. Use stable idempotency key: `${sessionId}` only
2. Document `expectsCompletionMessage` as OpenClaw runtime extension
3. Maintain TTL-based orphan detection as defense-in-depth

## CHECKS
CHECKS: criteria=met;blockers=0;verification=complete

## DIMENSIONS
DIMENSIONS: evidence_quality=4; assumption_coverage=4; transport_audit_completeness=5
