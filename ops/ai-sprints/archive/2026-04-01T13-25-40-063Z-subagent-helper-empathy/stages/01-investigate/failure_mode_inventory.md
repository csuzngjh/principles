# Empathy Observer - Failure Mode Inventory

## Overview
This document catalogs all known failure modes for the empathy observer, their paths, and mitigations.

---

## Path A: Happy Path (OK)

**Trigger**: Subagent completes within timeout window

**Steps**:
1. `spawn()` → `api.runtime.subagent.run()`
2. `finalizeRun()` → `api.runtime.subagent.waitForRun()`
3. `waitResult.status === 'ok'`
4. `reapBySession()` → `getSessionMessages()` → `trackFriction()` → `deleteSession()`
5. `markCompleted()` → add to `completedSessions` TTL map
6. `cleanupState(parentSessionId, observerSessionKey, true)` → delete from `activeRuns`

**Outcome**: ✅ Empathy data collected, session cleaned up

---

## Path B: Timeout

**Trigger**: Subagent doesn't complete within 30 seconds (DEFAULT_WAIT_TIMEOUT_MS)

**Steps**:
1. `spawn()` → `api.runtime.subagent.run()`
2. `finalizeRun()` → `api.runtime.subagent.waitForRun()`
3. `waitResult.status === 'timeout'`
4. Set `metadata.timedOutAt = Date.now()`, `metadata.observedAt = Date.now()`
5. `cleanupState(parentSessionId, observerSessionKey, false)` → **DO NOT** delete from `activeRuns`
6. Wait for `subagent_ended` fallback

**Outcome**: ⚠️ Session preserved for fallback; parent blocked for up to 5 minutes

**Failure Mode**: If `subagent_ended` never fires, orphan is cleaned up after 5-minute TTL

---

## Path C: Error

**Trigger**: `waitForRun()` throws exception OR returns `status === 'error'`

**Steps**:
1. `spawn()` → `api.runtime.subagent.run()`
2. `finalizeRun()` → `api.runtime.subagent.waitForRun()`
3. Exception caught OR `waitResult.status === 'error'`
4. Set `metadata.erroredAt = Date.now()`, `metadata.observedAt = Date.now()`
5. `cleanupState(parentSessionId, observerSessionKey, false)` → **DO NOT** delete from `activeRuns`
6. Wait for `subagent_ended` fallback

**Outcome**: ⚠️ Session preserved for fallback; parent blocked for up to 5 minutes

**Failure Mode**: If `subagent_ended` never fires, orphan is cleaned up after 5-minute TTL

---

## Path D: getSessionMessages Failure

**Trigger**: `getSessionMessages()` throws during reap

**Steps**:
1. Main path or fallback triggers `reapBySession()`
2. `getSessionMessages()` throws
3. `finalized = false`
4. `deleteSession()` is **NOT** called (protected by `if (finalized)` check)
5. `cleanupState(parentSessionId, observerSessionKey, false)` → preserve `activeRuns`

**Outcome**: ⚠️ Session preserved; can be retried by `subagent_ended` fallback

**Code Protection** (`empathy-observer-manager.ts` L383-391):
```typescript
if (finalized) {
    try {
        await api.runtime.subagent.deleteSession({ sessionKey: observerSessionKey });
    } catch (error) { ... }
    this.markCompleted(observerSessionKey);
}
```

---

## Path E: deleteSession Failure

**Trigger**: `deleteSession()` throws after messages retrieved

**Steps**:
1. `getSessionMessages()` succeeds
2. `finalized = true`
3. `deleteSession()` throws
4. `markCompleted()` is called anyway
5. `cleanupState(parentSessionId, observerSessionKey, true)`

**Outcome**: ✅ Marked as completed; session may persist but won't be reprocessed (dedupe)

**Code Protection** (`empathy-observer-manager.ts` L384-390):
```typescript
if (finalized) {
    try {
        await api.runtime.subagent.deleteSession({ sessionKey: observerSessionKey });
    } catch (error) { ... }  // Swallowed!
    this.markCompleted(observerSessionKey);  // Still marks complete
}
```

---

## Path F: subagent_ended Never Fires

**Trigger**: `subagent_ended` hook doesn't fire (fire-and-forget, errors swallowed)

**Steps**:
1. Main path fails (timeout/error)
2. `subagent_ended` hook registered but never fires
3. TTL-based orphan detection activates
4. After 5 minutes (`observedAt` + TTL), `isActive()` returns `false`
5. Parent session unblocked

**Outcome**: 🆘 Orphan eventually cleaned up via TTL

**Code Protection** (`empathy-observer-manager.ts` L106-130):
```typescript
private isActive(parentSessionId: string): boolean {
    const metadata = this.activeRuns.get(parentSessionId);
    if (!metadata) return false;
    if (metadata.timedOutAt || metadata.erroredAt) {
        if (!metadata.observedAt) return true;
        // TTL-based cleanup of orphaned timed-out/error entries
        if (Date.now() - metadata.observedAt > 5 * 60 * 1000) {
            this.activeRuns.delete(parentSessionId);
            ...
            return false;
        }
        return true;
    }
    ...
}
```

---

## Path G: Multiple Concurrent Spawns (Same Session)

**Trigger**: `spawn()` called multiple times for same parent session

**Steps**:
1. First `spawn()`: `shouldTrigger()` returns `true`, sets `sessionLocks`
2. Second `spawn()`: `shouldTrigger()` returns `false` (session is active)
3. Second call returns `null` early

**Outcome**: ✅ Blocked by `isActive()` check

**Code Protection** (`empathy-observer-manager.ts` L156-158):
```typescript
if (this.isActive(sessionId)) {
    api.logger?.warn?.(`[PD:EmpathyObserver] shouldTrigger=false: session ${sessionId} has active run`);
    return false;
}
```

---

## Path H: finalizeRun Retry

**Trigger**: `finalizeRun()` fails on first attempt

**Steps**:
1. `spawn()` calls `finalizeRun().catch()`
2. First `finalizeRun()` fails
3. 2-second delay
4. Retry `finalizeRun()`
5. If retry fails, error is logged and swallowed

**Code** (`empathy-observer-manager.ts` L217-225):
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

---

## Path I: Race Between Main Path and Fallback

**Trigger**: Main path completes just as `subagent_ended` fires

**Steps**:
1. `finalizeRun()` completes successfully
2. `reapBySession()` processes session
3. `markCompleted()` adds to `completedSessions`
4. `subagent_ended` fires (slightly delayed)
5. `reap()` checks `isCompleted()` → returns early

**Outcome**: ✅ Idempotent via `completedSessions` TTL map

**Code Protection** (`empathy-observer-manager.ts` L306-310):
```typescript
if (this.isCompleted(observerSessionKey)) {
    api.logger.info(`[PD:EmpathyObserver] reapBySession: already processed ${observerSessionKey}, skipping`);
    this.cleanupState(parentSessionId, observerSessionKey);
    return;
}
```

---

## Path J: workspaceDir Mismatch in Fallback

**Trigger**: `subagent_ended` provides different `workspaceDir` than original spawn

**Steps**:
1. Original spawn with `workspaceDir = '/path/A'`
2. `subagent_ended` fires with `workspaceDir = '/path/B'`
3. `reap()` called with `/path/B`
4. Uses `/path/B` for `trackFriction()` and event logging

**Risk**: MEDIUM - Wrong workspace may receive pain signals

**Code** (`empathy-observer-manager.ts` L401-428):
```typescript
async reap(
    api: EmpathyObserverApi | null | undefined,
    targetSessionKey: string,
    workspaceDir?: string  // May not match original!
): Promise<void> {
    ...
    await this.reapBySession(api, targetSessionKey, parentSessionId, workspaceDir);
}
```

**Mitigation**: Fallback finds original `workspaceDir` from `activeRuns` metadata when possible

---

## Summary Table

| Path | Trigger | Outcome | Protection |
|------|---------|---------|------------|
| A (OK) | Normal completion | ✅ Success | N/A |
| B (Timeout) | 30s timeout | ⚠️ Fallback | TTL orphan detection |
| C (Error) | waitForRun error | ⚠️ Fallback | TTL orphan detection |
| D (getSessionMessages fail) | API error | ⚠️ Retry | `finalized` flag |
| E (deleteSession fail) | API error | ✅ Dedupe | `completedSessions` |
| F (Hook never fires) | Fire-and-forget | 🆘 TTL | 5-min orphan TTL |
| G (Concurrent spawns) | Same session | ✅ Blocked | `isActive()` check |
| H (finalizeRun fail) | Retry logic | ⚠️ Retry | 2s retry delay |
| I (Race) | Main + fallback | ✅ Idempotent | `completedSessions` |
| J (workspaceDir mismatch) | Fallback workspace | ⚠️ Risk | Metadata fallback |

---

## TTL Constants

| Constant | Value | Location |
|----------|-------|----------|
| `completedSessions` TTL | 5 minutes | L99, L113 |
| `activeRuns` orphan TTL | 5 minutes | L113, L122 |
| `finalizeRun` retry delay | 2 seconds | L219 |
| `DEFAULT_WAIT_TIMEOUT_MS` | 30 seconds | L9 |

---

## Evidence

**Files Examined**:
- `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`
- `packages/openclaw-plugin/src/hooks/subagent.ts`