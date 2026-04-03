# Reviewer A Report — Stage 01-investigate, Round 3

## VERDICT

APPROVE

---

## BLOCKERS

None.

---

## FINDINGS

### 1. Transport Type Verified (SUPPORTED)

The empathy observer uses `runtime_direct` transport via `api.runtime.subagent.run()` at `empathy-observer-manager.ts:193-200`. Confirmed direct calls to `run()`, `waitForRun()`, `getSessionMessages()`, `deleteSession()` — no registry backing.

### 2. Lifecycle Hooks Verified (SUPPORTED)

- `subagent_spawning` hook at `index.ts:195-228` handles shadow routing
- `subagent_ended` hook at `index.ts:232-260` routes to `handleSubagentEnded()`
- `handleSubagentEnded()` at `hooks/subagent.ts:175-178` routes empathy sessions to `empathyObserverManager.reap()`

### 3. Failure Mode Inventory Accurate (SUPPORTED)

All producer claims verified against test file `empathy-observer-manager.test.ts`:
- Timeout: does NOT call `deleteSession` (test line 161-178)
- Error: preserves session for fallback
- `getSessionMessages` failure: `finalized=false`, session preserved
- `deleteSession` failure: still marks completed if message reading succeeded
- Double-spawn blocked via `shouldTrigger()` guard
- Race condition handled via `completedSessions` Map

### 4. TTL Mechanism Verified (SUPPORTED)

`isActive()` at lines 106-130 implements 5-minute TTL for orphaned `activeRuns` entries. After TTL expiry, entry deleted and `sessionLock` released.

### 5. Idempotency Protection Partial (PARTIAL)

- `completedSessions` Map prevents double `trackFriction` (line 62, 92-100)
- BUT: `activeRuns` entry preserved on error/timeout paths (not deleted until TTL expiry)
- Net effect: functionally idempotent for pain tracking, but state leakage possible

### 6. Dedupe Key Unstable (SUPPORTED)

`idempotencyKey: `${sessionId}:${Date.now()}`` at line 198 uses `Date.now()` — not stable across retries. However, `sessionKey` is unique per spawn, so dedupe is functionally achieved via session key.

### 7. SDK Type Gap Confirmed

`expectsCompletionMessage` NOT in `SubagentRunParams` (lines 86-94) but exists in `PluginHookSubagentDeliveryTargetEvent` (line 394). Producer's OPEN_RISKS item 4 correctly identifies this drift.

### 8. Comparable Implementations Verified

- `deep-reflect.ts`: uses identical `runtime_direct` pattern (lines 274, 284, 291, 304, 395)
- `nocturnal-trinity.ts`: uses identical pattern (14 matches for `api.runtime.subagent`)

### 9. Cross-Repo Claims (UNPROVEN)

Producer cites OpenClaw source files (`subagent-registry-lifecycle.ts`, `subagent-registry-completion.ts`) for hook timing verification. These files are in `D:\Code\openclaw`, outside the `D:\Code\principles` workspace. Cannot verify from within workspace boundary. Reviewer B should verify cross-repo claims.

---

## HYPOTHESIS_MATRIX

- empathy_uses_runtime_direct_transport: SUPPORTED — Verified at `empathy-observer-manager.ts:193-200`
- empathy_has_unverified_openclaw_hook_assumptions: UNPROVEN — Cross-repo source files not accessible from workspace; Reviewer B to verify
- empathy_timeout_leads_to_false_completion: SUPPORTED — Verified via test code and `finalizeRun` logic
- empathy_cleanup_not_idempotent: SUPPORTED — `completedSessions` Map exists but `activeRuns` entry preserved on error/timeout
- empathy_lacks_dedupe_key: SUPPORTED — `Date.now()` in idempotency key at line 198

---

## CODE_EVIDENCE

- files_verified: empathy-observer-manager.ts, index.ts, hooks/subagent.ts, deep-reflect.ts, nocturnal-trinity.ts, openclaw-sdk.d.ts, tests/service/empathy-observer-manager.test.ts
- evidence_source: local
- sha: d83c95af2f5a7be08fc42b7b82c80c46824e9cf7
- evidence_scope: principles

---

## NEXT_FOCUS

None for investigate stage. All contract deliverables complete. Ready for design stage.

---

## CHECKS

CHECKS: criteria=met;blockers=0;verification=partial;cross_repo_delegated=true

---

## DIMENSIONS

DIMENSIONS: evidence_quality=4; assumption_coverage=4; transport_audit_completeness=5

---

## CONTRACT REVIEW

| Deliverable | Producer Status | Verified |
|-------------|-----------------|----------|
| transport_audit | DONE | YES |
| lifecycle_hook_map | DONE | YES |
| openclaw_assumptions_documented | DONE | PARTIAL (cross-repo delegated) |
| failure_mode_inventory | DONE | YES |

All deliverables have sufficient evidence for Principles-internal claims. OpenClaw cross-repo claims require Reviewer B verification.

---

*Report generated: 2026-04-01T17:30:00Z*
*Reviewer: reviewer_a, investigate stage, Round 3*
