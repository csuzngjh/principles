# Producer Report — Stage 01-Investigate

## SUMMARY

The empathy observer production failure (missing `user_empathy` persistence) was investigated across five required hypotheses. The most likely root cause is **hypothesis #2 (wait_for_run_timeout_or_error_causes_non_persistence)** combined with **hypothesis #5 (lock_or_ttl_path_causes_observer_inactivity)**. 

Key findings:
- The `empathySilenceConstraint` is injected into the **main agent's** prompt only, NOT the observer subagent's prompt. Observer prompt contamination is **unlikely** as a direct cause of data loss.
- `finalizeRun` is **fire-and-forget** (`.catch()` with no retry). If `reapBySession` fails internally after messages are read but before `trackFriction`/`recordPainSignal` completes, the error propagates as unhandled promise rejection and `user_empathy` data is lost with no retry.
- The `subagent_ended` fallback has idempotency protection (`isCompleted` guard) and correctly looks up `parentSessionId` from `activeRuns` Map, but cannot recover if the main path already partially succeeded.
- `workspaceDir` propagation appears correct throughout the chain.
- The 5-minute TTL for orphaned entries is adequate for lock recovery, but the `observedAt` TTL only works if `observedAt` is actually set (not set if `reapBySession` throws before setting it, or if `waitForRun('ok')` path throws before `observedAt` is set).

## CHANGES

No code changes made in this stage (investigate-only).

## EVIDENCE

### CodeReviewed
- `empathy-observer-manager.ts` (lines 1–528): Full implementation reviewed
- `prompt.ts` hook (lines 499–612): Empathy silence constraint injection reviewed
- `subagent.ts` hook (lines 164–178): Fallback `reap()` handler reviewed
- `session-tracker.ts` (lines 261–297): `trackFriction` persistence path reviewed
- `event-log.ts` (lines 57–59, 107–131, 277–287): `recordPainSignal` and flush logic reviewed
- `workspace-context.ts` (lines 113–147): `fromHookContext` workspace resolution reviewed
- `llm.ts` (lines 92–144, 223–230): Legacy V1 empathy extraction + `isEmpathyAuditPayload` reviewed

### TestsRun
- `empathy-observer-manager.test.ts`: **29/29 PASS** — all tests including timeout/error recovery, self-managed cleanup, idempotency, session key sanitization
- `prompt.test.ts`: **54/54 PASS** — prompt hook including empathy silence constraint and minimal mode detection

### KeyCodePatterns

**Fire-and-forget finalizeRun with no retry:**
```typescript
// empathy-observer-manager.ts line 223
this.finalizeRun(api, sessionId, sessionKey, workspaceDir).catch((err) => {
    api.logger.warn(`[PD:EmpathyObserver] finalizeRun failed for ${sessionKey}: ${String(err)}`);
});
```
If `finalizeRun` fails after reading messages but before persisting (or if its internal `reapBySession` throws on `status='ok'`), the error is logged but **not retried**. Data is lost.

**Normal 'ok' path: observedAt is NOT set before reapBySession:**
```typescript
// Lines 313-314
// status === 'ok': 正常回收
await this.reapBySession(api, observerSessionKey, parentSessionId, workspaceDir);
// observedAt is NEVER set in the ok path
```
If `reapBySession` throws on `ok` status, `observedAt` is never set, entry persists in `activeRuns` indefinitely (until 5-min TTL from `startedAt`), and data is lost.

**empathySilenceConstraint injection — main agent only:**
```typescript
// prompt.ts lines 608-612
if (trigger === 'user' && sessionId && api && !isAgentToAgent) {
    prependContext = '### BEHAVIORAL_CONSTRAINTS\n' + empathySilenceConstraint + '\n\n' + prependContext;
    empathyObserverManager.spawn(api, sessionId, latestUserMessage, workspaceDir).catch((err) => api.logger.warn(String(err)));
}
```
Constraint is injected into `prependContext` (main agent prompt). Observer runs in separate session with its own prompt. No direct contamination mechanism found.

**subagent_ended fallback with isCompleted guard:**
```typescript
// subagent.ts lines 175-178
if (isEmpathyObserverSession(targetSessionKey || '')) {
    await empathyObserverManager.reap(ctx.api, targetSessionKey!, workspaceDir);
    return;
}
// empathy-observer-manager.ts lines 326-330
if (this.isCompleted(observerSessionKey)) {
    api.logger.info(`[PD:EmpathyObserver] reapBySession: already processed ${observerSessionKey}, skipping`);
    this.cleanupState(parentSessionId, observerSessionKey);
    return;
}
```
Idempotency is protected. But if main path already succeeded and marked completed, fallback is no-op. If main path failed partway through, fallback runs and should recover.

**workspaceDir propagation:**
```typescript
// spawn passes workspaceDir → finalizeRun → reapBySession → trackFriction/eventLog.recordPainSignal
// In reapBySession line 353:
const wctx = WorkspaceContext.fromHookContext({ workspaceDir: workspaceDir || '' });
```
Appears correct. Empty string falls back to PathResolver.

## KEY_EVENTS

- ✅ EmpathyObserverManager code reviewed (all 528 lines)
- ✅ Prompt hook empathySilenceConstraint injection reviewed
- ✅ Subagent hook fallback reap handler reviewed
- ✅ Session tracker trackFriction persistence reviewed
- ✅ Event log recordPainSignal + flush logic reviewed
- ✅ Workspace context resolution reviewed
- ✅ 29/29 empathy-observer-manager unit tests PASS
- ✅ 54/54 prompt hook unit tests PASS
- ✅ Git history analyzed: latest commit ef14ec1 added `expectsCompletionMessage` and self-managed recovery
- ✅ No direct prompt contamination mechanism found for observer session
- ✅ Fire-and-forget finalizeRun with no retry confirmed as primary data-loss risk

## HYPOTHESIS_MATRIX

- **prompt_contamination_from_prompt_ts**: REFUTED — `empathySilenceConstraint` is injected into main agent's `prependContext` only. Observer runs in a separate subagent session (`agent:main:subagent:empathy-obs-*`) with its own isolated prompt starting with "You are an empathy observer." No mechanism found by which the main agent's silence constraint reaches the observer subagent's context.

- **wait_for_run_timeout_or_error_causes_non_persistence**: SUPPORTED — In the `status='ok'` path, `observedAt` is NEVER set before calling `reapBySession`. If `reapBySession` throws (e.g., `trackFriction` or `wctx.eventLog.recordPainSignal` throws), the error propagates as unhandled promise rejection. `finalizeRun` is fire-and-forget with `.catch()` log-only — no retry, no second path. Data lost with no recovery. The timeout/error paths DO set `observedAt` and call `reapBySession` with try/catch, so they are somewhat better protected.

- **subagent_ended_fallback_is_not_reliable_enough**: UNPROVEN — The fallback has proper idempotency (`isCompleted` guard), correct `parentSessionId` lookup from `activeRuns` Map, and calls `reapBySession` which is the same recovery function. However, it cannot recover if the main path already succeeded (no double-write due to `isCompleted`) or if the main path failed after marking completed but before actual persistence. Reliability seems adequate for crash scenarios; the real risk is main-path unhandled exception.

- **workspace_dir_or_wrong_workspace_write**: REFUTED — `workspaceDir` propagates correctly through spawn → finalizeRun → reapBySession → trackFriction/eventLog.recordPainSignal. `WorkspaceContext.fromHookContext({ workspaceDir: workspaceDir || '' })` handles empty string via PathResolver fallback. All paths use the same `workspaceDir`.

- **lock_or_ttl_path_causes_observer_inactivity_or_data_loss**: SUPPORTED (secondary) — In the `status='ok'` path, `cleanupState` is NOT called if `reapBySession` throws (error propagates, catch block only wraps `waitForRun` call itself). This leaves the `sessionLocks` entry in place. The 5-minute TTL on `startedAt` eventually cleans it, but during that window new observers for the same parent session are blocked. More critically, if `observedAt` is never set (ok path throws), the orphaned entry persists in `activeRuns` until the 5-min `startedAt` TTL, during which `isActive()` returns true and blocks re-spawns.

## CHECKS

CHECKS: evidence=ok;tests=29+54pass;scope=pd-only;prompt-isolation=confirmed

## OPEN_RISKS

1. **Unhandled promise rejection in `status='ok'` path** — If `trackFriction` or `wctx.eventLog.recordPainSignal` throws inside `reapBySession`, the error propagates uncaught from the fire-and-forget `finalizeRun`. No retry mechanism. `user_empathy` data lost silently.

2. **No retry for failed `finalizeRun`** — The fire-and-forget pattern means if anything fails in the async `finalizeRun` (whether timeout/error/ok path), there is no automatic retry. The `subagent_ended` hook can recover only if it fires and the session is not already marked `completed`.

3. **Potential gap: does `subagent_ended` actually fire for empathy observer sessions?** — The commit message for ef14ec1 says `expectsCompletionMessage: true` was added to trigger the `subagent_ended` hook. This should be verified in production. If the hook never fires (e.g., the flag is not correctly propagated to OpenClaw), the fallback path never runs.

4. **Event log flush lag** — `recordPainSignal` buffers events (max 20 or 30s interval). If the process crashes between buffering and flush, `user_empathy` events in the buffer are lost. This is a known trade-off but worth noting for critical production paths.
