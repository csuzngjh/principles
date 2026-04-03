# reviewer-b worklog

## Checkpoint 1: Role state initialized
- Status: idle → investigating
- Round: 0 → 1
- Focus: scope control, regression risk, test coverage, OpenClaw assumption verification

## Checkpoint 2: Source verification started
- Read empathy-observer-manager.ts (511 lines)
- Read subagent.ts hooks (481 lines)
- Read index.ts hook registration (640 lines)
- Read openclaw-sdk.d.ts for hook types (464 lines)
- Verified: empathy uses `runtime_direct` via `api.runtime.subagent.run()` at lines 193-200
- Verified: `expectsCompletionMessage: true` is set at line 199
- Verified: `subagent_ended` hook routes empathy sessions to `reap()` at subagent.ts:175-178

## Checkpoint 3: OpenClaw cross-repo verification
- Accessed: D:/Code/openclaw/src/gateway/server-plugins.ts (lines 296-377)
- Accessed: D:/Code/openclaw/src/agents/subagent-spawn.ts (lines 1-912)
- Accessed: D:/Code/openclaw/src/agents/subagent-registry-completion.ts (lines 1-99)
- CONFIRMED: `runtime.subagent.run()` (server-plugins.ts:306) dispatches to `agent` gateway method only - NO `registerSubagentRun()` call
- CONFIRMED: `subagent_ended` hook is emitted by `emitSubagentEndedHookOnce()` (subagent-registry-completion.ts:44) which requires registry entry
- CONFIRMED: `spawnSubagentDirect()` (subagent-spawn.ts:797) DOES call `registerSubagentRun()` AFTER agent call
- CRITICAL FINDING: empathy observer's `reap()` fallback via `subagent_ended` is DEAD CODE for `runtime_direct` transport

## Checkpoint 4: Design doc verification
- Read subagent-workflow-helper-design.md (776 lines)
- Design doc section 2.3 (Fact 1) states: "插件 runtime `subagent.run()` 实际只是把调用转发到 gateway `agent` 方法"
- Design doc confirms: `runtime.subagent.run()` ≠ `sessions_spawn` ≠ registry entry
- Design doc confirms: `subagent_ended` comes from registry completion

## Checkpoint 5: Hypothesis verification
- empathy_uses_runtime_direct_transport: SUPPORTED (confirmed)
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED (verified via source)
- empathy_timeout_leads_to_false_completion: REFUTED (producer correct - timeout does NOT call deleteSession)
- empathy_cleanup_not_idempotent: REFUTED (producer correct - isCompleted() prevents double-write)
- empathy_lacks_dedupe_key: SUPPORTED (confirmed - time-based idempotencyKey)

## Checkpoint 6: Test coverage assessment
- Read empathy-observer-manager.test.ts (393 lines)
- 15 tests covering: concurrency lock, session key format, non-blocking spawn, ok/error/timeout paths, TTL expiry, double-write prevention, parent session attribution
- COVERAGE GAP: No test verifies `subagent_ended` fallback behavior
- COVERAGE GAP: No test verifies `runtime.subagent.run()` actually triggers `subagent_ended` for empathy sessions
- Tests mock everything - no integration test for hook triggering

## Key Findings Summary
1. Producer's OpenClaw assumption assessment is CORRECT - `subagent_ended` will NOT fire for `runtime_direct` transport
2. empathy observer's `reap()` fallback is architecturally dead code
3. The 5-minute TTL is the only recovery mechanism for orphaned empathy sessions
4. Producer correctly identified critical unverified assumption

SHA verified: b1964a55de24111939d6a329eabbdb1badcd5984
## Checkpoint 1: OpenClaw Source Verification

**Producer Claims Verified:**
1. ✅ `runtime.subagent.run()` dispatches to "agent" gateway method ONLY - CONFIRMED
   - server-plugins.ts:327-347 shows dispatchGatewayMethod("agent", ...) returns {runId}
   - NO registerSubagentRun() call in this path

2. ✅ `subagent_ended` requires registry entry via registerSubagentRun() - CONFIRMED
   - subagent-registry-completion.ts:44-99 shows emitSubagentEndedHookOnce requires SubagentRunRecord
   - This record is created only by registerSubagentRun()

3. ✅ spawnSubagentDirect() calls registerSubagentRun() AFTER agent call - CONFIRMED
   - subagent-spawn.ts:797 registers AFTER line ~780's agent call

4. ✅ `expectsCompletionMessage` is NOT in SubagentRunParams - CONFIRMED
   - plugins/runtime/types.ts:8-17 SubagentRunParams lacks expectsCompletionMessage
   - empathy-observer-manager.ts:199 passes it but it's ignored

**TTL Mechanism Verified:**
- empathy-observer-manager.ts:113: 5-minute TTL for orphaned entries
- TTL is the ONLY recovery mechanism for runtime_direct transport

## Checkpoint 2: Lifecycle Hook Verification

- index.ts:232 registers subagent_ended hook
- hooks/subagent.ts:175-178 routes to empathyObserverManager.reap() for empathy sessions
- BUT: This fallback is DEAD CODE for runtime_direct because subagent_ended never fires

## Checkpoint 3: Hypothesis Matrix Review

Producer claims:
- empathy_uses_runtime_direct_transport: SUPPORTED ✅
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED (refined: DEAD CODE not just unverified) ✅
- empathy_timeout_leads_to_false_completion: REFUTED ✅ (waitForRun timeout correctly defers to TTL)
- empathy_cleanup_not_idempotent: REFUTED ✅ (completedSessions map prevents double-write)
- empathy_lacks_dedupe_key: SUPPORTED (partial) ✅ (uses time-based idempotencyKey)

All 5 hypotheses are correctly classified.

## Checkpoint 4: Test Coverage Assessment

**Test Files Found:**
- tests/service/empathy-observer-manager.test.ts (393 lines)
- tests/hooks/subagent.test.ts (408 lines)

**Coverage Gap Confirmed:**
- Tests mock `api.runtime.subagent.run()` and `waitForRun`
- NO test verifies that `subagent_ended` hook DOES or DOES NOT fire for `runtime_direct` transport
- This is an integration test gap that requires actual OpenClaw runtime verification

**Test Design Analysis:**
- Unit tests exist and appear well-designed for mocked scenarios
- The mock-heavy approach means architecture-level assumptions are NOT tested
- Producer correctly identifies this as a verification gap

## Checkpoint 5: Scope Control Review

**PR2 Scope (per brief):**
- empathy observer + deep-reflect ONLY
- Diagnostician/Nocturnal NOT migrated
- Helper lives in packages/openclaw-plugin/src/service/subagent-workflow/

**Current State:**
- No subagent-workflow directory exists yet (migration not started, this is investigate stage)
- Brief confirms PD-only changes; do not modify D:/Code/openclaw

**Assessment:** Scope is correctly bounded. No gold-plating detected.

## Checkpoint 6: Contract Deliverables Review

**Required Deliverables (from brief):**
1. transport_audit - producer status: DONE ✅
2. lifecycle_hook_map - producer status: DONE ✅
3. openclaw_assumptions_documented - producer status: DONE ✅
4. failure_mode_inventory - producer status: DONE ✅

**Evidence Quality:**
- transport_audit: Supported by source code citations (server-plugins.ts, subagent-spawn.ts, subagent-registry-completion.ts)
- lifecycle_hook_map: Documents subagent_spawning (shadow-only), subagent_ended (dead fallback)
- openclaw_assumptions_documented: Table format with Reality/Source columns - HIGH QUALITY
- failure_mode_inventory: FM-5 correctly upgraded from UNVERIFIED to CONFIRMED DEAD CODE

All 4 deliverables have concrete evidence backing their DONE status.

## Checkpoint 7: OpenRisks Review

**Producer's Open Risks:**
1. CRITICAL - Dead Code: subagent_ended unreachable for runtime_direct ✅ VERIFIED
2. Session Leak Risk: If finalizeRun fails + TTL hasn't expired ✅ VERIFIED (realistic)
3. Test Coverage Gap: No integration test for hook firing ✅ VERIFIED
4. Design Doc Assumption: runtime.subagent.run() ≠ sessions_spawn ✅ VERIFIED

All open risks are legitimate and documented with appropriate severity levels.

## Summary of Verification

**Producer's Claims - VERIFIED:**
- empathy_uses_runtime_direct_transport: ✅ CONFIRMED via empathy-observer-manager.ts:193
- empathy_has_unverified_openclaw_hook_assumptions: ✅ CONFIRMED - DEAD CODE, not just unverified
- subagent_ended fallback is unreachable: ✅ CONFIRMED - No registerSubagentRun() in runtime.subagent.run() path
- expectsCompletionMessage is ignored: ✅ CONFIRMED - Not in SubagentRunParams
- 5-minute TTL is only recovery mechanism: ✅ CONFIRMED

**Hypothesis Matrix Assessment:**
All 5 hypotheses correctly classified with proper evidence:
- empathy_uses_runtime_direct_transport: SUPPORTED ✅
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED (DEAD CODE confirmed) ✅
- empathy_timeout_leads_to_false_completion: REFUTED ✅
- empathy_cleanup_not_idempotent: REFUTED ✅
- empathy_lacks_dedupe_key: SUPPORTED (partial) ✅

**DIMENSIONS Assessment:**
- evidence_quality: 4/5 - Cross-repo source verification is solid
- assumption_coverage: 4/5 - All 5 hypotheses addressed with evidence
- transport_audit_completeness: 4/5 - Complete audit of runtime_direct vs registry_backed

All dimensions above 3/5 threshold. No failures detected.
