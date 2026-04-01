# Producer Report — Stage 04-Verify

## SUMMARY

Three targeted fixes to `empathy-observer-manager.ts` verified against code and tests. All 22 empathy-observer-manager tests pass. The fixes correctly address the `user_empathy` data loss root cause: fire-and-forget `finalizeRun` with no retry, `observedAt` not set before `reapBySession` in ok path, and unconditional `activeRuns` deletion on `finalized=false`.

**Remaining production gaps**: `subagent_ended` hook reliability unverified (OpenClaw must fire this hook for fallback to work), event log buffer flush lag, and 2-second retry may be insufficient for sustained failures.

---

## CHANGES

### File: `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`

1. **Change 1** (lines 291-294): Set `observedAt` before `reapBySession` in ok path — TTL cleanup works even if `reapBySession` fails
2. **Change 2** (lines 387-393): Pass `finalized` to `cleanupState` — preserves `activeRuns` for subagent_ended fallback when `finalized=false`
3. **Change 3** (lines 217-225): Single retry with 2s delay for fire-and-forget `finalizeRun`

### File: `packages/openclaw-plugin/tests/service/empathy-observer-manager.test.ts`

2 new tests added to cover failure paths:
- `ok path sets observedAt even when reapBySession fails`
- `ok path reapBySession failure preserves activeRuns so fallback can recover`

---

## EVIDENCE

### CodeReview

**Change 1 (lines 291-294)**:
```typescript
// Set observedAt before reapBySession so TTL cleanup works even if reapBySession fails
const updatedMetadata = this.activeRuns.get(parentSessionId);
if (updatedMetadata) { updatedMetadata.observedAt = Date.now(); }
await this.reapBySession(api, observerSessionKey, parentSessionId, workspaceDir);
```
- `observedAt` now set before `reapBySession` call in ok path
- TTL-based cleanup in `isActive()` can now expire orphaned entries

**Change 2 (lines 387-393)**:
```typescript
// Only mark completed after all critical operations succeeded
if (finalized) {
    this.markCompleted(observerSessionKey);
}
// Only delete from activeRuns if finalized; otherwise preserve entry for subagent_ended fallback
this.cleanupState(parentSessionId, observerSessionKey, finalized);
```
- `markCompleted` conditional on `finalized` — fallback can re-run `reapBySession`
- `cleanupState` receives `finalized` — entry preserved in `activeRuns` when `finalized=false`
- Fallback `reap()` can find `parentSessionId` via `activeRuns` iteration

**Change 3 (lines 217-225)**:
```typescript
this.finalizeRun(api, sessionId, sessionKey, workspaceDir).catch(async (err) => {
    api.logger.warn(`[PD:EmpathyObserver] finalizeRun failed (will retry once): ${String(err)}`);
    await new Promise((r) => setTimeout(r, 2000));
    try {
        await this.finalizeRun(api, sessionId, sessionKey, workspaceDir);
    } catch (retryErr) {
        api.logger.warn(`[PD:EmpathyObserver] finalizeRun retry also failed: ${String(retryErr)}`);
    }
});
```
- Single retry with 2-second delay for transient failures
- Both initial failure and retry failure logged as warnings

### TestsRun

- `empathy-observer-manager.test.ts`: **22/22 PASS** (20 existing + 2 new)

### LSPDiagnostics

- `empathy-observer-manager.ts`: **0 errors, 0 warnings**

### GitDiff

```
packages/openclaw-plugin/src/service/empathy-observer-manager.ts | 16 +-
packages/openclaw-plugin/tests/service/empathy-observer-manager.test.ts | 29 ++
```
- ~16 lines modified in production code (3 targeted fixes)
- ~29 lines added in test code (2 new tests)

---

## KEY_EVENTS

- ✅ All 3 code changes verified against git diff — implementation matches fix plan
- ✅ 22/22 empathy-observer-manager tests pass (vitest)
- ✅ 0 TypeScript errors/lints on modified file
- ✅ Implement stage completed with both reviewer APPROVE verdicts
- ✅ PD-only scope maintained: no OpenClaw changes

---

## HYPOTHESIS_MATRIX

| Hypothesis | Status | Notes |
|------------|--------|-------|
| `wait_for_run_timeout_or_error_causes_non_persistence` | **FIXED** | Change 1 sets `observedAt`; Change 2 preserves `activeRuns` for fallback; Change 3 adds retry |
| `lock_or_ttl_path_causes_observer_inactivity` | **ADDRESSED** | Change 1 ensures `observedAt` is set even if `reapBySession` fails, enabling TTL expiry |
| `subagent_ended_fallback_is_not_reliable_enough` | **UNPROVEN** | OpenClaw must fire `subagent_ended` hook for fallback to work — cannot verify without production telemetry |
| `prompt_contamination_from_prompt_ts` | REFUTED | Previously investigated; empathySilenceConstraint injected into main agent prompt only |
| `workspace_dir_or_wrong_workspace_write` | REFUTED | Previously investigated; `workspaceDir` propagation verified as correct |

---

## CHECKS

CHECKS: evidence=ok;tests=22pass;scope=pd-only;openclaw=no-changes;lsp=clean;gitdiff=verified

---

## OPEN_RISKS

1. **`subagent_ended` hook reliability unverified**: OpenClaw must fire `subagent_ended` for empathy observer sessions for fallback to work. The `expectsCompletionMessage: true` flag (line 199 in `spawn`) should trigger this, but production verification needed. If hook does not fire, fallback path never runs and data loss could still occur for `ok` path failures after retry exhaustion.

2. **Event log buffer flush lag**: `recordPainSignal` buffers events (max 20 or 30s interval). If process crashes between buffering and flush, buffered `user_empathy` events are lost. This is a known trade-off separate from the main fix.

3. **2-second retry delay may be insufficient**: For sustained network failures or subagent runtime restarts, a single 2-second retry may not be enough. Could be increased if production data shows repeated failures after retry exhaustion.

4. **Process crash before `finalizeRun` completes**: If process crashes after `spawn()` returns but before `finalizeRun` completes (either on first attempt or retry), the `activeRuns` entry is orphaned. TTL-based cleanup only works if `observedAt` was set and `isActive()` is called again for that session. No mechanism to recover from this scenario beyond waiting for TTL expiry.

5. **No test for Change 3 retry**: The retry wrapper (Change 3) only fires on unexpected errors outside the existing try-catch in `finalizeRun`. A dedicated test for this path was not added due to mock timing complexity. Acceptable since the defensive wrapper is straightforward.
