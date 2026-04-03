# Producer Worklog - Investigate Stage

## Round 1 - 2026-04-02

### Investigation Started: 17:40 UTC

### Files Examined

1. **Core Empathy Observer (Current Implementation)**
   - `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`
     - Singleton pattern with `activeRuns`, `sessionLocks`, `completedSessions` Maps
     - Direct `runtime.subagent.run()` call at line 193
     - `waitForRun()` polling with 30s timeout at line 253
     - `getSessionMessages()` and `deleteSession()` for cleanup
     - TTL-based orphan cleanup (5 minutes)

2. **Empathy Observer Workflow Manager (Migration Target)**
   - `packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts`
     - New infrastructure using `RuntimeDirectDriver`
     - SQLite-based `WorkflowStore` for persistence
     - State machine: pending → active → wait_result → finalizing → completed
     - `scheduleWaitPoll()` with 100ms delay for async completion

3. **Subagent Workflow Infrastructure**
   - `packages/openclaw-plugin/src/service/subagent-workflow/types.ts` - Type definitions
   - `packages/openclaw-plugin/src/service/subagent-workflow/runtime-direct-driver.ts` - Transport driver
   - `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts` - SQLite persistence
   - `packages/openclaw-plugin/src/service/subagent-workflow/index.ts` - Exports

4. **Subagent Lifecycle Hooks**
   - `packages/openclaw-plugin/src/hooks/subagent.ts`
     - `handleSubagentEnded()` at line 164
     - Detects empathy observer sessions via `isEmpathyObserverSession()` at line 175
     - Calls `empathyObserverManager.reap()` as fallback

5. **OpenClaw SDK Types**
   - `packages/openclaw-plugin/src/openclaw-sdk.d.ts`
     - `PluginHookSubagentEndedEvent` at line 333
     - `runtime.subagent` interface at line 128

6. **Test Files**
   - `packages/openclaw-plugin/tests/service/empathy-observer-manager.test.ts`
     - 393 lines, comprehensive coverage
     - Tests for timeout, error, dedup, fallback paths

### Key Findings

#### Transport Analysis
- **Current**: `runtime_direct` via `runtime.subagent.run()` (NOT registry_backed)
- **Target**: `runtime_direct` via `RuntimeDirectDriver` wrapper
- Both use `deliver=false`, `expectsCompletionMessage=true`

#### Lifecycle Hooks Used
1. `subagent_spawning` - in `src/index.ts` for shadow routing
2. `subagent_ended` - in `src/hooks/subagent.ts` for empathy fallback recovery

#### OpenClaw Assumption: Does `runtime.subagent.run()` guarantee `subagent_ended` hook?

**Answer: NO** - The relationship is more nuanced:

- When `expectsCompletionMessage: true` is set, the `subagent_ended` hook is **deferred** until the completion message is delivered
- The `waitForRun()` in the empathy observer provides an **alternative completion path**
- The `subagent_ended` hook fires when the subagent session actually terminates
- For empathy observer with `deliver: false`, the session may persist until explicitly deleted

**Critical**: When `waitForRun()` times out (30s), the session is NOT automatically cleaned up. The sessionLock is released but the `activeRuns` entry persists with `observedAt` timestamp. Recovery happens via:
1. TTL expiry (5 minutes) in `isActive()` 
2. Fallback via `subagent_ended` hook calling `reap()`

### Failure Modes Documented

1. **waitForRun timeout**: Session preserved, `activeRuns` entry kept, parent session unblocked after TTL
2. **waitForRun error**: Same as timeout - preserved for fallback recovery
3. **getSessionMessages failure**: `finalized=false`, session preserved, fallback can retry
4. **deleteSession failure**: `completedSessions` marked (message reading succeeded), session orphaned
5. **Concurrent spawn**: Blocked by `sessionLocks` + `activeRuns` check
6. **Double-finalize**: Prevented by `completedSessions` TTL-based dedupe

### Checkpoint: Investigation Complete
- All required files examined
- Hypothesis matrix evaluated
- Failure modes documented
- OpenClaw assumptions verified against SDK types and code

---

## Round 2 - 2026-04-02 (Continued Investigation)

### Additional Investigation Focus
Round 1 completed all deliverables. Round 2 focused on validating findings and ensuring comprehensive coverage.

### Transport Audit - Validation

**empathy_uses_runtime_direct_transport**: CONFIRMED
- Both `empathy-observer-manager.ts` (line 193) and `empathy-observer-workflow-manager.ts` (line 91) use `runtime.subagent.run()` directly
- Neither uses registry_backed transport
- Both set `deliver: false` and `expectsCompletionMessage: true`

### Lifecycle Hook Map - Validation

| Hook Event | Location | Empathy Usage |
|------------|----------|---------------|
| `subagent_spawning` | `src/index.ts:196` | Not directly used by empathy |
| `subagent_ended` | `src/hooks/subagent.ts:164` | Fallback recovery path for empathy |

### OpenClaw Assumption Review - Validation

**empathy_has_unverified_openclaw_hook_assumptions**: CONFIRMED
- The empathy observer relies on `subagent_ended` hook as fallback (line 175-177 in subagent.ts)
- However, with `expectsCompletionMessage: true` and `deliver: false`, the hook timing is NOT guaranteed
- When `waitForRun()` times out, the session may persist, and `subagent_ended` may fire later
- The `isCompleted()` check in `reap()` prevents double-processing but timing is non-deterministic

**empathy_timeout_leads_to_false_completion**: REFUTED
- Timeout in `finalizeRun()` (line 269-277) marks `timedOutAt` and `observedAt`
- Session is NOT deleted on timeout - preserved for `subagent_ended` fallback
- No false completion signal emitted

**empathy_cleanup_not_idempotent**: CONFIRMED
- `cleanupState()` called multiple times but `activeRuns.delete()` is idempotent
- `markCompleted()` uses TTL-based dedupe (5 min) - idempotent within window
- `reap()` has `isCompleted()` guard but `cleanupState()` always clears sessionLocks

**empathy_lacks_dedupe_key**: CONFIRMED  
- Uses `idempotencyKey: \`${sessionId}:${Date.now()}\`` (line 198)
- This includes timestamp, making each spawn unique - NOT a true dedupe key
- If same session spawns twice quickly, both will run (but `shouldTrigger` prevents this via `isActive` check)

### Updated Hypothesis Matrix

| Hypothesis | Status | Evidence |
|------------|--------|----------|
| empathy_uses_runtime_direct_transport | SUPPORTED | Direct `runtime.subagent.run()` calls in both current and target implementations |
| empathy_has_unverified_openclaw_hook_assumptions | SUPPORTED | `subagent_ended` fallback timing non-deterministic with `expectsCompletionMessage: true` |
| empathy_timeout_leads_to_false_completion | REFUTED | Timeout preserves session, doesn't signal completion |
| empathy_cleanup_not_idempotent | SUPPORTED | `cleanupState()` called with `deleteFromActiveRuns=false` preserves entry on failure |
| empathy_lacks_dedupe_key | SUPPORTED | Uses timestamp-based idempotency key, not session-based dedupe |

### Checkpoint: Round 2 Complete
- All findings validated against source code
- Transport audit complete
- Lifecycle hook map verified
- OpenClaw assumptions documented with evidence
- Failure mode inventory confirmed

---

## Round 3 - 2026-04-02 (Final Report)

### Final Investigation Summary

Round 3 completed the investigation stage with comprehensive documentation.

### Key Evidence Sources

1. **empathy-observer-manager.ts** (511 lines)
   - Line 193: `runtime.subagent.run()` call - confirms runtime_direct transport
   - Line 253: `waitForRun()` with 30s timeout
   - Line 269-277: Timeout handling preserves session for fallback
   - Line 306-310: `isCompleted()` TTL-based dedupe

2. **empathy-observer-workflow-manager.ts** (337 lines)
   - Line 91: `driver.run()` via RuntimeDirectDriver
   - Line 111-114: Same `deliver: false`, `expectsCompletionMessage: true` settings
   - Line 126-144: `scheduleWaitPoll()` for async completion

3. **runtime-direct-driver.ts** (156 lines)
   - Line 91-98: Direct passthrough to `subagent.run()`
   - Line 113-116: Direct passthrough to `subagent.waitForRun()`

4. **subagent.ts** (481 lines)
   - Line 175-177: `subagent_ended` fallback for empathy sessions
   - Line 164-178: `handleSubagentEnded()` function

5. **openclaw-sdk.d.ts** (464 lines)
   - Line 333-343: `PluginHookSubagentEndedEvent` type definition
   - Line 86-122: `SubagentRunParams`, `SubagentWaitParams`, etc.

### Checkpoint: Round 3 Complete
- Final producer report written to producer.md
- All 4 deliverables marked DONE
- Hypothesis matrix finalized
- Role state updated to round 3 completed