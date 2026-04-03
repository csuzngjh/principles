# Reviewer B Worklog

## Role: reviewer_b | Stage: investigate | Round: 1

## Investigation Steps

### Step 1: Read stage brief and producer report
- Read brief.md: Understood task is to audit empathy observer's subagent transport, lifecycle hooks, failure modes, and OpenClaw assumptions
- Read producer.md: Producer claims `runtime_direct` transport, documents 5 hypotheses

### Step 2: Read source files for evidence verification
- Read `empathy-observer-manager.ts` - CONFIRMED transport evidence:
  - Line 193-200: `api.runtime.subagent.run()` ✓
  - Line 253-256: `api.runtime.subagent.waitForRun()` ✓
  - Line 321-324: `api.runtime.subagent.getSessionMessages()` ✓
  - Line 385: `api.runtime.subagent.deleteSession()` ✓
  - Line 198: `idempotencyKey: \`${sessionId}:${Date.now()}\`` - timestamp makes it non-dedupeable ✓
  - Lines 269-277: timeout handling sets `timedOutAt` but does NOT record friction ✓
  
- Read `index.ts` - CONFIRMED lifecycle hooks:
  - Lines 195-228: `subagent_spawning` hook - shadow routing ✓
  - Lines 232-260: `subagent_ended` hook - routes to `empathyObserverManager.reap()` ✓

- Read `hooks/subagent.ts` - CONFIRMED `handleSubagentEnded`:
  - Lines 175-178: Routes empathy observer sessions to `empathyObserverManager.reap()` ✓

- Read `openclaw-sdk.d.ts` - CONFIRMED hook types:
  - Lines 333-343: `PluginHookSubagentEndedEvent` with `outcome?: 'ok' | 'error' | 'timeout' | ...` ✓

### Step 3: Cross-repo OpenClaw verification (D:/Code/openclaw accessible)
- OpenClaw SHA: f5431bc07e7321466530cc4b811ac2dc66c84bdc
- Read `subagent-registry-lifecycle.ts` - FOUND CRITICAL LOGIC:
  - Lines 515-533: `shouldDeferEndedHook` logic
  - When `expectsCompletionMessage === true` AND `triggerCleanup === true`, hook is DEFERRED (not immediate)
  - Hook emission happens via `emitCompletionEndedHookIfNeeded` during cleanup flow
  - Key finding: Hook IS guaranteed for `expectsCompletionMessage: true` runs, but timing is deferred

- Read `subagent-registry-completion.ts`:
  - Lines 44-99: `emitSubagentEndedHookOnce` function
  - Checks: `endedHookEmittedAt`, `inFlightRunIds`, `hasHooks("subagent_ended")`
  - Hook fires if plugins are registered

### Step 4: Test coverage assessment
- Read `empathy-observer-manager.test.ts`:
  - 15 test cases covering: concurrency lock, session key format, spawn without blocking, ok/error/timeout paths, TTL expiry, fallback recovery, double-write prevention
  - Tests verify: deleteSession NOT called on timeout/error, activeRuns preserved for fallback
  - Tests verify: dedupe via `completedSessions` Map
  - MISSING: No test for actual `subagent_ended` hook integration (mock only)
  - MISSING: No test for OpenClaw hook guarantee timing

### Step 5: Scope verification
- Producer confirms: `subagent-workflow/` directory does NOT exist yet (target location)
- PR2 scope: empathy observer + deep-reflect ONLY
- Confirmed: `deep-reflect.ts` uses identical `runtime_direct` pattern (lines 284-289, 291, 304, 395)
- Confirmed: `nocturnal-trinity.ts` uses identical `runtime_direct` pattern (lines 181-210, 227-257, 278-302)

## Key Findings

### OpenClaw Assumption Verification (CROSS-VERIFIED)
1. **Assumption 1**: `runtime.subagent.run()` with `expectsCompletionMessage: true` guarantees `subagent_ended` hook fires
   - VERIFIED: Yes, hook fires, but DEFERRED through cleanup flow (not immediate)
   - Code: `subagent-registry-lifecycle.ts` lines 515-533
2. **Assumption 2**: `subagent_ended` fires with accurate `outcome`
   - VERIFIED: Yes, outcome is mapped from `SubagentRunOutcome` to `SubagentLifecycleEndedOutcome`
   - Code: `subagent-registry-completion.ts` lines 32-42
3. **Assumption 3**: Gateway mode required for subagent runtime
   - VERIFIED: Yes, checked via `isSubagentRuntimeAvailable()` which verifies async function signature

### Hypothesis Matrix Assessment
- empathy_uses_runtime_direct_transport: SUPPORTED ✓
- empathy_has_unverified_openclaw_hook_assumptions: REFUTED (verified via cross-repo reading) - but hook timing is DEFERRED
- empathy_timeout_leads_to_false_completion: SUPPORTED - confirmed via code lines 269-277
- empathy_cleanup_not_idempotent: PARTIAL - `completedSessions` Map prevents double `trackFriction`, but `activeRuns` entry preserved on error/timeout
- empathy_lacks_dedupe_key: SUPPORTED - line 198 uses `${Date.now()}`

### Contract Deliverables Assessment
- transport_audit: DONE - producer correctly identified runtime_direct ✓
- lifecycle_hook_map: DONE - producer documented 2 hooks used ✓
- openclaw_assumptions_documented: DONE - all 3 documented, but timing nuance (deferred) not fully captured
- failure_mode_inventory: DONE - 7 failure modes documented ✓

## Potential Issues
1. **Timing Issue (Medium)**: The `subagent_ended` hook is DEFERRED for `expectsCompletionMessage: true` runs - cleanup flow must complete before hook fires. This means the empathy observer's `reap()` fallback may race with the main cleanup flow.

2. **Dedupe Key Issue (Low)**: `Date.now()` in idempotencyKey makes it always unique - this is acceptable since the sessionKey is already unique per spawn.

3. **Test Gap (Medium)**: No integration test verifying actual `subagent_ended` hook triggers `reap()`. Unit tests mock the hook.

4. **Scope Creep Risk**: Brief says "empathy observer + deep-reflect ONLY" but nocturnal-trinity uses identical pattern. Migration of nocturnal not in scope but same transport issues apply.

## Status: Investigation Complete
Ready to write final report.

## Round 2 Investigation Complete

### Checkpoints:
1. **Transport audit verified**: empathy-observer uses runtime_direct via api.runtime.subagent.run() - confirmed at empathy-observer-manager.ts:193-200
2. **Lifecycle hook map verified**: subagent_spawning (shadow routing) and subagent_ended (calls empathyObserverManager.reap) - confirmed at index.ts:195-260
3. **OpenClaw cross-repo verification done**: 
   - Hook timing deferral mechanism confirmed at subagent-registry-lifecycle.ts:521-533
   - shouldDeferEndedHook logic verified
   - emitCompletionEndedHookIfNeeded verified at lines 137-154
   - triggerCleanup defaults to true confirmed at subagent-registry.ts:166,530
4. **Failure modes verified**: timeout/error/getSessionMessages failure paths all confirmed with code references
5. **Hypothesis matrix verified**: All 5 hypotheses have accurate status based on evidence
6. **Test coverage assessed**: Unit tests comprehensive; integration test gap acknowledged by producer
7. **SDK type gap identified**: expectsCompletionMessage missing from SubagentRunParams in openclaw-sdk.d.ts (non-blocking)
8. **Report written**: reviewer-b.md APPROVE verdict with full evidence

### Round 2 Status: COMPLETED

## Round 3 Investigation Complete

### Checkpoints:
1. **Cross-repo OpenClaw verification COMPLETED**:
   - Hook timing deferral confirmed at subagent-registry-lifecycle.ts:521-533
   - shouldDeferEndedHook = entry.expectsCompletionMessage === true && triggerCleanup === true
   - Hook fires via emitCompletionEndedHookIfNeeded() during cleanup flow (DEFERRED)
   - Outcome mapping verified at subagent-registry-completion.ts:32-42

2. **deep-reflect.ts verified**: Uses identical runtime_direct pattern at lines 284-304

3. **Final verification**: All 5 hypotheses accurately classified, all contract deliverables at DONE

4. **Report written**: reviewer-b.md with APPROVE verdict

### Round 3 Status: COMPLETED
