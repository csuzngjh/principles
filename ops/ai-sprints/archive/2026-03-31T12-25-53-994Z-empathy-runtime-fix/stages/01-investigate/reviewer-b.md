# Reviewer B Report — Stage 01-Investigate

## VERDICT

APPROVE

## BLOCKERS

None. The producer correctly identified the root cause chain without over-engineering a solution.

## FINDINGS

### 1. Root Cause Confirmation (AGREE with Producer)

The primary data-loss risk is **hypothesis #2 (wait_for_run_timeout_or_error_causes_non_persistence)**. In the `status='ok'` path:
- `observedAt` is never set before `reapBySession` is called
- If `reapBySession` throws after reading messages but before persistence completes, the error propagates as unhandled promise rejection
- `finalizeRun` is fire-and-forget (`.catch()` log-only, no retry)
- `cleanupState` is not called in the error path, leaving stale locks

### 2. Test Coverage Gaps

The existing 29 tests cover happy paths and some error scenarios (e.g., `getSessionMessages` throwing), but **miss critical failure paths**:

| Scenario | Test Coverage |
|----------|---------------|
| `getSessionMessages` fails | ✅ Covered (line 172) |
| `trackFriction` throws in `reapBySession` | ❌ Not covered |
| `recordPainSignal` throws in `reapBySession` | ❌ Not covered |
| `WorkspaceContext.fromHookContext` throws | ❌ Not covered |
| `reapBySession` partial success (messages read, persistence fails) | ❌ Not covered |

**Recommendation**: Add tests for these failure paths before implementing the fix.

### 3. Scope Control (GOOD)

- Producer made **zero code changes** — correct for investigate stage
- No scope creep or unnecessary architectural expansion
- Producer correctly identified the fire-and-forget pattern as the primary risk
- Producer correctly ruled out prompt contamination (hypothesis #1) through code review

### 4. Regression Risk (LOW)

The identified issues are **pre-existing bugs**, not introduced by recent changes. The proposed fix direction (retry mechanism, proper cleanup on error) would be defensive additions, not behavior changes. Low regression risk.

### 5. Production Verification Needed

The `subagent_ended` fallback relies on `expectsCompletionMessage: true` being correctly propagated to OpenClaw. This should be verified in production logs:
- Does `handleSubagentEnded` actually fire for empathy observer sessions?
- Is `targetSessionKey` correctly populated?

## HYPOTHESIS_MATRIX

- **prompt_contamination_from_prompt_ts**: REFUTED — `empathySilenceConstraint` is injected into main agent's `prependContext` only. Observer runs in separate subagent session with isolated prompt starting with "You are an empathy observer." No contamination mechanism found. Independent code review confirms producer's finding.

- **wait_for_run_timeout_or_error_causes_non_persistence**: SUPPORTED — Critical issue confirmed. In `status='ok'` path (lines 313-314), `observedAt` is never set before `reapBySession`. If `reapBySession` throws after messages read but before `trackFriction`/`recordPainSignal` completes, error propagates as unhandled promise rejection. `finalizeRun` is fire-and-forget with no retry. Data lost silently. Test coverage gap identified for these failure paths.

- **subagent_ended_fallback_is_not_reliable_enough**: UNPROVEN — Fallback has proper idempotency (`isCompleted` guard) and correct `parentSessionId` lookup. However, reliability depends on `subagent_ended` hook actually firing for empathy observer sessions. Requires production verification of `expectsCompletionMessage: true` propagation.

- **workspace_dir_or_wrong_workspace_write**: REFUTED — `workspaceDir` propagates correctly through spawn → finalizeRun → reapBySession → trackFriction/eventLog.recordPainSignal. `WorkspaceContext.fromHookContext({ workspaceDir: workspaceDir || '' })` handles empty string via PathResolver fallback. All paths use same `workspaceDir`.

- **lock_or_ttl_path_causes_observer_inactivity_or_data_loss**: SUPPORTED (secondary) — In `status='ok'` path, if `reapBySession` throws, `cleanupState` is not called, leaving `sessionLocks` entry in place. 5-minute TTL on `startedAt` eventually cleans it, but during that window new observers for same parent session are blocked. Also, `observedAt` never set means orphaned entry persists in `activeRuns` until TTL.

## NEXT_FOCUS

1. **Add missing test coverage** for `trackFriction`/`recordPainSignal` throwing in `reapBySession` before implementing fix
2. **Verify production logs** for `subagent_ended` hook firing on empathy observer sessions
3. **Implement fix**: Add retry mechanism to `finalizeRun`, set `observedAt` before `reapBySession` in `status='ok'` path, ensure `cleanupState` is called on all error paths

## CHECKS

CHECKS: criteria=met;blockers=0;verification=partial
