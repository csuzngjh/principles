# Producer Report - Stage 01-investigate

## SUMMARY

This investigation audited the empathy observer's current subagent transport mechanism, lifecycle hook usage, timeout/error/fallback/cleanup paths, and OpenClaw assumptions. The empathy observer uses **runtime_direct transport** via `api.runtime.subagent.run()` (not registry_backed). It relies on the `subagent_ended` hook as a fallback recovery path, but this assumption about OpenClaw guaranteeing hook delivery is **unverified** and requires cross-repo source reading by reviewers. Five failure modes were identified: timeout false completion, non-idempotent cleanup, missing deduplication, unverified hook guarantees, and potential race conditions between main and fallback paths.

## CHANGES

No code changes were made in this stage (investigate only). This stage establishes the factual baseline for migration planning.

## EVIDENCE

- **files_checked**: empathy-observer-manager.ts, subagent.ts (hooks), index.ts, openclaw-sdk.d.ts, subagent-probe.ts, deep-reflect.ts, nocturnal-trinity.ts
- **evidence_source**: local
- **sha**: b1964a55de24111939d6a329eabbdb1badcd5984
- **branch/worktree**: principles/main

## CODE_EVIDENCE

**Primary implementation file**: `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`

**Transport mechanism** (line 193):
```typescript
const result = await api.runtime.subagent.run({
    sessionKey,
    message: prompt,
    lane: 'subagent',
    deliver: false,
    idempotencyKey: `${sessionId}:${Date.now()}`,  // timestamp prevents dedup
    expectsCompletionMessage: true,
}) as SubagentRunResult;
```

**Lifecycle hook registration** (index.ts line 232):
```typescript
api.on('subagent_ended', (event, ctx) => {
    // ... shadow observation completion ...
    handleSubagentEnded(event, { ...ctx, workspaceDir, api });
});
```

**Fallback handler** (subagent.ts line 175):
```typescript
if (isEmpathyObserverSession(targetSessionKey || '')) {
    await empathyObserverManager.reap(ctx.api, targetSessionKey!, workspaceDir);
    return;
}
```

**Timeout path** (empathy-observer-manager.ts line 269):
```typescript
if (waitResult.status === 'timeout') {
    const updatedMetadata = this.activeRuns.get(parentSessionId);
    if (updatedMetadata) {
        updatedMetadata.timedOutAt = Date.now();
        updatedMetadata.observedAt = Date.now();
    }
    this.cleanupState(parentSessionId, observerSessionKey, false);  // false = keep entry for fallback
    return;
}
```

**Cleanup non-idempotency** (line 383-394):
```typescript
// Only delete the session if we successfully read messages (finalized=true).
// When finalized=false (getSessionMessages failed), preserve the session so
// the subagent_ended fallback can retry or the TTL expiry can unblock the parent.
if (finalized) {
    await api.runtime.subagent.deleteSession({ sessionKey: observerSessionKey });
    this.markCompleted(observerSessionKey);
}
// Only delete from activeRuns if finalized; otherwise preserve entry for subagent_ended fallback
this.cleanupState(parentSessionId, observerSessionKey, finalized);
```

**TTL cleanup for orphaned entries** (line 113):
```typescript
if (Date.now() - metadata.observedAt > 5 * 60 * 1000) {
    this.activeRuns.delete(parentSessionId);
    // ...
}
```

## KEY_EVENTS

- Located empathy observer implementation in `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`
- Confirmed runtime_direct transport: uses `api.runtime.subagent.run()` directly (not registry_backed)
- Identified `subagent_ended` hook as the sole lifecycle hook used by empathy observer (no subagent_spawned/subagent_spawned hooks)
- Documented main path: `spawn()` → `finalizeRun()` → `waitForRun()` → `reapBySession()`
- Documented fallback path: `subagent_ended` hook → `reap()` → `reapBySession()`
- Identified 5 distinct failure modes in timeout/error/cleanup handling
- Confirmed OpenClaw assumption about `subagent_ended` guarantee is unverified in codebase

## HYPOTHESIS_MATRIX

- **empathy_uses_runtime_direct_transport**: SUPPORTED — Line 193 uses `api.runtime.subagent.run()` directly with no registry lookup
- **empathy_has_unverified_openclaw_hook_assumptions**: SUPPORTED — No verification exists that `runtime.subagent.run()` guarantees `subagent_ended` hook; relies on OpenClaw internals not verified in PD codebase
- **empathy_timeout_leads_to_false_completion**: SUPPORTED — Timeout sets `timedOutAt` but subagent may still complete; fallback path can race with main path
- **empathy_cleanup_not_idempotent**: SUPPORTED — When `finalized=false` (getSessionMessages failed), session preserved for fallback; if fallback also fails, TTL of 5 minutes kicks in
- **empathy_lacks_dedupe_key**: SUPPORTED — IdempotencyKey is `${sessionId}:${Date.now()}` which includes a timestamp, guaranteeing every call is unique (no deduplication)

## TRANSPORT_AUDIT

**Current transport**: runtime_direct

- Uses `api.runtime.subagent.run()` directly (not registry_backed)
- No agent registry lookup required
- Requires Gateway mode (checked via `isSubagentRuntimeAvailable()`)

**Lifecycle hooks used by empathy observer**:

| Hook | Used | Purpose |
|------|------|---------|
| subagent_ended | YES | Fallback recovery when main path fails |
| subagent_spawned | NO | Not used by empathy observer |
| subagent_spawning | NO | Not used by empathy observer |

**Recovery path state machine**:

```
spawn() → activeRuns entry created
    ↓
finalizeRun() → waitForRun(runId, 30s timeout)
    ├── status='ok' → reapBySession() → deleteSession() → cleanupState(deleteFromActiveRuns=true)
    ├── status='timeout' → cleanupState(deleteFromActiveRuns=false) → [waiting for subagent_ended fallback]
    └── status='error' → cleanupState(deleteFromActiveRuns=false) → [waiting for subagent_ended fallback]
    
subagent_ended hook → isEmpathyObserverSession() → reap()
    └── isCompleted()? skip : reapBySession() [retry if needed, else TTL cleanup at 5min]
```

## OPENCLAW_ASSUMPTIONS

**Assumption 1**: `runtime.subagent.run()` guarantees `subagent_ended` hook fires
- **Status**: UNVERIFIED in PD codebase
- **Evidence**: No explicit verification in empathy-observer-manager.ts; relies on OpenClaw behavior
- **Required action**: Reviewer must verify via cross-repo source reading in OpenClaw core

**Assumption 2**: `waitForRun(timeoutMs=30s)` is sufficient for empathy observer completion
- **Status**: UNVERIFIED
- **Evidence**: No explicit timeout value documentation; 30s default used
- **Risk**: If subagent takes >30s, main path times out and relies on fallback

**Assumption 3**: `isCompleted()` 5-minute window prevents duplicate processing
- **Status**: VERIFIED (implemented)
- **Evidence**: Lines 96-104 in empathy-observer-manager.ts

## FAILURE_MODE_INVENTORY

| ID | Failure Mode | Trigger | Impact | Current Mitigation |
|----|--------------|---------|--------|-------------------|
| FM1 | Timeout false positive | waitForRun times out but subagent still running | Main path exits; fallback runs | subagent_ended hook catches late completion |
| FM2 | Non-idempotent cleanup | getSessionMessages fails, finalized=false | Session not deleted; orphan remains | TTL cleanup at 5min |
| FM3 | Race condition | Main path times out, fallback runs before main path completes | Duplicate processing possible | isCompleted() prevents duplicate reap |
| FM4 | No deduplication | Same sessionId re-triggers empathy | Duplicate pain signals | isCompleted() prevents duplicate, but idempotencyKey includes timestamp |
| FM5 | Unverified hook guarantee | OpenClaw bug/misconfiguration | subagent_ended never fires | TTL cleanup at 5min eventually clears orphans |

## CHECKS

CHECKS: evidence=ok; tests=not-run; scope=pd-only; prompt-isolation=confirmed; hook-guarantee=unverified

## OPEN_RISKS

1. **Hook guarantee unverified**: Cannot confirm `runtime.subagent.run()` guarantees `subagent_ended`. Reviewer must verify via cross-repo source reading.
2. **Timeout value arbitrary**: 30 seconds may be insufficient for complex empathy analysis.
3. **IdempotencyKey includes timestamp**: Every spawn call generates unique key, defeating deduplication purpose.
4. **Fallback depends on hook delivery**: If OpenClaw doesn't guarantee hook, orphaned sessions may accumulate.
5. **TTL cleanup is passive**: No active retry mechanism; orphaned entries wait 5 minutes for automatic cleanup.

## CONTRACT

- transport_audit status: DONE
- lifecycle_hook_map status: DONE
- openclaw_assumptions_documented status: DONE
- failure_mode_inventory status: DONE
