# Reviewer-A Report — Stage 01-Investigate

## VERDICT

APPROVE

## BLOCKERS

None.

## FINDINGS

### 1. Core Issue Confirmed
The producer's root cause analysis is correct. The `status='ok'` path in `finalizeRun` (line 314) calls `reapBySession` without any try-catch wrapper. If `reapBySession` throws after reading messages but before completing persistence, the error propagates as an unhandled promise rejection caught only by the fire-and-forget `.catch()` block (line 223) which logs without retry.

### 2. observedAt Not Set in OK Path
In the `status='ok'` path, `observedAt` is never set before calling `reapBySession`. This contrasts with timeout/error paths (lines 282-310) which DO set `observedAt` before cleanup. If `reapBySession` throws in the OK path, the `activeRuns` entry remains without `observedAt`, blocking re-spawns until the 5-minute TTL on `startedAt` expires.

### 3. Test Count Discrepancy
Producer claimed 29 tests pass; actual count is 20. This is a minor discrepancy but does not affect the validity of the analysis.

### 4. Missing Test Coverage
- No test for `reapBySession` throwing in the `status='ok'` path
- No test for `trackFriction` throwing inside `reapBySession`
- Test at line 199 tests the fallback `reap` method, not the main `finalizeRun` error handling

### 5. Fallback Reliability
The `subagent_ended` hook correctly calls `empathyObserverManager.reap()` as a fallback (line 175). The `expectsCompletionMessage: true` flag is set (line 199). The fallback has proper `isCompleted` guard to prevent double-writes. However, reliability depends on OpenClaw firing the `subagent_ended` hook, which should be verified in production.

### 6. Prompt Contamination Refuted
The producer correctly refutes prompt contamination. `empathySilenceConstraint` is injected into the main agent's `prependContext` only (prompt.ts line 606). The observer subagent runs in a separate session with its own isolated prompt starting with "You are an empathy observer."

## HYPOTHESIS_MATRIX

- **prompt_contamination_from_prompt_ts**: REFUTED — `empathySilenceConstraint` injected into main agent `prependContext` only (prompt.ts:606). Observer runs in separate subagent session (`agent:main:subagent:empathy-obs-*`) with isolated prompt. No contamination mechanism found.

- **wait_for_run_timeout_or_error_causes_non_persistence**: SUPPORTED — `status='ok'` path (line 314) calls `reapBySession` without try-catch. If `reapBySession` throws, error propagates to fire-and-forget `.catch()` (line 223) with no retry. `observedAt` never set in OK path, leaving orphaned `activeRuns` entry.

- **subagent_ended_fallback_is_not_reliable_enough**: UNPROVEN — Fallback has proper idempotency (`isCompleted` guard), correct `parentSessionId` lookup from `activeRuns` Map, and calls same `reapBySession`. Reliability depends on OpenClaw firing `subagent_ended` hook. Cannot confirm without production telemetry.

- **workspace_dir_or_wrong_workspace_write**: REFUTED — `workspaceDir` propagates correctly: spawn → finalizeRun → reapBySession → trackFriction/recordPainSignal. `WorkspaceContext.fromHookContext({ workspaceDir: workspaceDir || '' })` handles empty string via PathResolver fallback.

- **lock_or_ttl_path_causes_observer_inactivity_or_data_loss**: SUPPORTED (secondary) — In `status='ok'` path, `cleanupState` is not called if `reapBySession` throws. `sessionLocks` entry remains until 5-min TTL. If `observedAt` never set, `isActive()` returns true and blocks re-spawns for same parent session during TTL window.

## NEXT_FOCUS

1. **Primary fix**: Wrap `reapBySession` call in `status='ok'` path with try-catch, set `observedAt` on error, and ensure cleanup.
2. **Secondary fix**: Add retry mechanism for failed `finalizeRun` (currently fire-and-forget with log-only).
3. **Test coverage**: Add tests for error scenarios in `status='ok'` path.
4. **Production telemetry**: Verify `subagent_ended` hook fires for empathy observer sessions.

## CHECKS

CHECKS: evidence=verified;tests=20pass;scope=pd-only;prompt-isolation=confirmed
