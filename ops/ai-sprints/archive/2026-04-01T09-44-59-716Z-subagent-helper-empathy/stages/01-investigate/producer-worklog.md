# Producer Worklog - Stage 01-investigate

## Round 1 - Subagent Helper: migrate empathy observer to workflow helper

### Investigation Start: 2026-04-01
### Investigator: producer (sprint orchestrator)

---

## Investigation Steps

### Step 1: Read stage brief and sprint.json
- Confirmed task: migrate empathy observer to workflow helper
- Constraints: PD-only changes (no OpenClaw modifications)
- Helper target location: packages/openclaw-plugin/src/service/subagent-workflow/
- PR2 scope: empathy observer + deep-reflect ONLY

### Step 2: Located empathy observer implementation
**File**: `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`

### Step 3: Analyzed transport mechanism
**Finding**: Uses `runtime.subagent.run()` directly (runtime_direct transport)
- Line 193: `const result = await api.runtime.subagent.run({...})`
- NOT registry_backed - directly calls runtime.subagent

### Step 4: Mapped lifecycle hooks
**Empathy observer hooks used**:
- `subagent_ended` - registered in index.ts line 232, calls empathyObserverManager.reap()
- The empathy observer does NOT use `subagent_spawning` or `subagent_spawned` hooks directly
- The `reap()` method (lines 401-428) is the fallback handler triggered by subagent_ended

### Step 5: Documented timeout/error/fallback/cleanup paths

**Main recovery path** (`finalizeRun` lines 234-295):
1. Calls `waitForRun(runId, timeoutMs=30s default)`
2. If status='timeout': marks `timedOutAt`, calls `cleanupState(deleteFromActiveRuns=false)`
3. If status='error': marks `erroredAt`, calls `cleanupState(deleteFromActiveRuns=false)`
4. If status='ok': proceeds to `reapBySession()`

**Fallback recovery path** (`reap()` lines 401-428):
1. Triggered by `subagent_ended` hook
2. Checks `isCompleted()` to skip if already processed
3. Calls `reapBySession()` to do actual cleanup

**Cleanup failure modes identified**:
- When finalized=false (getSessionMessages failed), session is preserved for subagent_ended fallback
- TTL-based cleanup at 5 minutes for orphaned timed-out/error entries
- `isCompleted()` has 5-minute window before clearing

### Step 6: Assessed OpenClaw assumptions

**Assumption being made**: `runtime.subagent.run()` guarantees `subagent_ended` hook will fire

**Evidence**: 
- The empathy observer has no explicit verification of this guarantee
- The hook types (openclaw-sdk.d.ts) show `subagent_ended` is a valid hook name
- But no explicit documentation that run() guarantees the hook

**This is an UNVERIFIED assumption** - needs reviewer verification via cross-repo source reading.

### Step 7: Verified required hypotheses

| Hypothesis | Status | Evidence |
|------------|--------|----------|
| empathy_uses_runtime_direct_transport | **SUPPORTED** | Line 193 uses `api.runtime.subagent.run()` directly |
| empathy_has_unverified_openclaw_hook_assumptions | **SUPPORTED** | Relies on subagent_ended but no verification of guarantee |
| empathy_timeout_leads_to_false_completion | **SUPPORTED** | Timeout path sets `timedOutAt` but subagent may still complete later |
| empathy_cleanup_not_idempotent | **SUPPORTED** | When finalized=false, session preserved for fallback - not fully cleaned up |
| empathy_lacks_dedupe_key | **SUPPORTED** | IdempotencyKey is `${sessionId}:${Date.now()}` - includes timestamp, never dedupes |

### Step 8: Identified additional issues

1. **Duplicate hook registration potential**: Both main path and fallback path can call cleanup
2. **Race condition**: If main path times out but subagent completes quickly, fallback may run before main path
3. **Session key collision possibility**: Timestamp-based session keys could theoretically collide

---

## Files Examined

1. `packages/openclaw-plugin/src/service/empathy-observer-manager.ts` - Primary implementation
2. `packages/openclaw-plugin/src/hooks/subagent.ts` - Lifecycle hook handler
3. `packages/openclaw-plugin/src/index.ts` - Hook registration
4. `packages/openclaw-plugin/src/openclaw-sdk.d.ts` - SDK type definitions
5. `packages/openclaw-plugin/src/utils/subagent-probe.ts` - Runtime availability probe
6. `packages/openclaw-plugin/src/tools/deep-reflect.ts` - Comparison implementation

---

## Checkpoints

- [x] Empathy observer implementation found
- [x] Transport mechanism identified (runtime_direct)
- [x] Lifecycle hooks mapped (subagent_ended only)
- [x] Failure modes documented
- [x] OpenClaw assumptions identified (unverified)
- [x] Required hypotheses verified (5/5 supported)
- [x] SHA collected: b1964a55de24111939d6a329eabbdb1badcd5984
- [x] Report written to producer.md

---

## Blockers

**None identified at this stage.** The investigation is complete and all required deliverables are available.
