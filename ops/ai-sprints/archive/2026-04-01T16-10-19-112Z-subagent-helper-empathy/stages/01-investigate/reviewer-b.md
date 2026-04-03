# Reviewer B Report - Investigate Stage Round 2

## VERDICT
**APPROVE**

All five hypotheses verified as SUPPORTED or PARTIAL. Producer completed all four deliverables with adequate evidence. The deep-reflect waitForRun bug (confirmed in this round) is a pre-existing bug surfaced during investigation, not a new finding.

## BLOCKERS
None. All contract deliverables reached DONE status.

## FINDINGS

### Scope Control
- PR2 scope correctly bounded: empathy observer + deep-reflect only
- Diagnostician/Nocturnal NOT migrated in this PR (per brief constraint)
- Helper location confirmed: packages/openclaw-plugin/src/service/subagent-workflow/
- No unnecessary architectural expansion detected

### Regression Risk
- **HIGH RISK**: deep-reflect waitForRun bug (line 291) - passes sessionKey instead of runId
  - This causes guaranteed timeout even when subagent processes message successfully
  - The subagent runs to completion but the tool always reports timeout
  - Existing tests do NOT catch this because they mock waitForRun without parameter verification
- **MEDIUM RISK**: empathy-observer timeout path preserves activeRuns entry
  - TTL-based cleanup (5 min) prevents permanent orphaning but is implicit
- **LOW RISK**: timestamp-based idempotencyKey in empathy-observer
  - Makes each spawn unique, but OpenClaw infrastructure deduplication may still apply

### Test Coverage
- empathy-observer-manager.test.ts: 16 tests, comprehensive
- subagent.test.ts: Verifies empathy observer routing via subagent_ended
- deep-reflect.test.ts: Tests mock waitForRun but do NOT verify runId parameter
  - **GAP**: Test at line 94 only checks `toHaveBeenCalled()` not actual parameters
  - This allowed the waitForRun bug to go undetected

## TRANSPORT_ASSESSMENT

### empathy-observer Transport: runtime_direct
- Confirmed via direct code inspection (empathy-observer-manager.ts line 193)
- Uses api.runtime.subagent.run() with deliver: false
- No registry_backed usage found
- Both main path (waitForRun) and fallback path (subagent_ended) use same transport

### deep-reflect Transport: runtime_direct  
- Confirmed via direct code inspection (deep-reflect.ts line 284)
- Uses fire-and-forget run() + waitForRun polling
- **BUG**: return value (SubagentRunResult.runId) discarded; waitForRun called with sessionKey at line 291

### Transport Conclusion
- Both empathy-observer and deep-reflect use runtime_direct transport
- This is consistent with PR2 migration goal (empathy observer → workflow helper)
- No registry involvement found

## OPENCLAW_ASSUMPTION_REVIEW

### Assumption: runtime.subagent.run() guarantees subagent_ended hook fires
**Status: SUPPORTED with caveats**
- OpenClaw fires subagent_ended when subagent session terminates
- empathy-observer relies on this for fallback rescue path (reap())
- If subagent crashes hard without OpenClaw catching it, hook might not fire
- TTL-based 5-min cleanup mitigates orphaned entries
- PluginHookHandlerMap shows void return - no formal SDK contract

### Assumption: subagent_spawning can inject context into subagents
**Status: SUPPORTED**
- Hook is registered (index.ts lines 194-229)
- empathy-observer does NOT use it (no empathy instruction injection)
- Only shadow routing logic uses subagent_spawning for PD_LOCAL_PROFILES

### Assumption: waitForRun(runId) uses runId not sessionKey
**Status: REFUTED for deep-reflect**
- SubagentRunResult.runId is separate from sessionKey
- deep-reflect.ts line 291 passes sessionKey to waitForRun - guarantees timeout
- empathy-observer correctly uses runId from SubagentRunResult (line 200-201)

## HYPOTHESIS_MATRIX

- empathy_uses_runtime_direct_transport: SUPPORTED — api.runtime.subagent.run() called directly in both files. No registry_backed usage found.
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED — subagent_ended fires asynchronously, timing relative to finalizeRun is racy. OpenClaw SDK contract shows void return.
- empathy_timeout_leads_to_false_completion: SUPPORTED — deep-reflect discards runId, passes sessionKey to waitForRun (line 291), guaranteeing timeout.
- empathy_cleanup_not_idempotent: PARTIAL — isCompleted() prevents double-reap within 5-min TTL. After expiry, re-reading messages can re-record pain signals.
- empathy_lacks_dedupe_key: SUPPORTED — empathy uses timestamp-based key; deep-reflect passes no idempotencyKey at all.

## NEXT_FOCUS

1. **CRITICAL**: The deep-reflect waitForRun bug (line 291) must be fixed before PR2 merge
   - Store SubagentRunResult.runId and pass it to waitForRun
   - Add test coverage to verify runId parameter is passed correctly

2. **Verify subagent_ended hook reliability** in production OpenClaw runtime
   - The "racy timing" concern needs empirical validation
   - TTL-based cleanup is mitigation, not guarantee

3. **Document the 5-minute TTL implicit contract** in code comments
   - This is critical for maintenance and future debugging

## CHECKS
CHECKS: criteria=met;blockers=0;verification=partial

## DIMENSIONS
DIMENSIONS: evidence_quality=4; assumption_coverage=4; transport_audit_completeness=4

---

## CONTRACT Verification

From producer report, CONTRACT section declares:

- transport_audit status: DONE ✓
- lifecycle_hook_map status: DONE ✓
- openclaw_assumptions_documented status: DONE ✓
- failure_mode_inventory status: DONE ✓

**Reviewer assessment**: All four deliverables are DONE. Evidence provided in producer report is corroborated by direct code inspection.

## CODE_EVIDENCE

- files_verified: empathy-observer-manager.ts, deep-reflect.ts, subagent.ts, index.ts, openclaw-sdk.d.ts, subagent-probe.ts, empathy-observer-manager.test.ts, subagent.test.ts, deep-reflect.test.ts
- evidence_source: local
- sha: 4138178
- branch/worktree: principles (HEAD)
- evidence_scope: principles
