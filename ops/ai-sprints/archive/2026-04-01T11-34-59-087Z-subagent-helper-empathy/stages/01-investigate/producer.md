# Producer Report - Round 3

## SUMMARY

Investigation of empathy observer's subagent transport mechanism completed. Key finding: empathy observer uses `runtime_direct` transport via `api.runtime.subagent.run()` which does NOT register subagents in the OpenClaw registry, making the `subagent_ended` fallback dead code. The 5-minute TTL is the only recovery mechanism for orphaned empathy sessions.

All 4 required deliverables are DONE:
- **transport_audit**: runtime_direct only, confirmed via source code
- **lifecycle_hook_map**: subagent_ended routes to reap() but is unreachable for runtime_direct
- **openclaw_assumptions_documented**: Verified via cross-repo source reading by Reviewer B
- **failure_mode_inventory**: 5 failure modes documented with FM-5 (subagent_ended no-fire) confirmed as dead code

## CHANGES

No code changes were made. This was an investigation-only stage to document the current state of the empathy observer and prepare for migration to workflow helper.

## EVIDENCE

### Transport Evidence
- empathy-observer-manager.ts:193-200: `api.runtime.subagent.run()` with `lane='subagent'`, `deliver=false`, `expectsCompletionMessage=true`
- Parameters passed: `sessionKey`, `message`, `lane`, `deliver`, `idempotencyKey`, `expectsCompletionMessage`

### Lifecycle Hook Evidence
- index.ts:232: `subagent_ended` hook registered
- hooks/subagent.ts:175-178: empathy sessions routed to `empathyObserverManager.reap()`
- index.ts:195-228: `subagent_spawning` used for shadow routing only (PD_LOCAL_PROFILES)

### OpenClaw Cross-Repo Verification (by Reviewer B)
- server-plugins.ts:306: `runtime.subagent.run()` dispatches to `agent` gateway method only - NO `registerSubagentRun()` call
- subagent-registry-completion.ts:44: `subagent_ended` requires SubagentRunRecord (created by `registerSubagentRun()`)
- subagent-spawn.ts:797: `spawnSubagentDirect()` calls `registerSubagentRun()` AFTER agent call
- plugins/runtime/types.ts:8-17: `expectsCompletionMessage` NOT in SubagentRunParams (ignored)

### TTL Evidence
- empathy-observer-manager.ts:113: 5-minute TTL for orphaned `activeRuns` entries
- TTL is the ONLY recovery mechanism when waitForRun times out for runtime_direct transport

## CODE_EVIDENCE

- files_checked: empathy-observer-manager.ts, hooks/subagent.ts, index.ts, server-plugins.ts, subagent-registry-completion.ts, subagent-spawn.ts, plugins/runtime/types.ts
- evidence_source: both
- sha: b1964a55de24111939d6a329eabbdb1badcd5984
- branch/worktree: principles (main)
- evidence_scope: both

## KEY_EVENTS

- Confirmed empathy observer uses runtime_direct transport via api.runtime.subagent.run() at empathy-observer-manager.ts:193-200
- Confirmed subagent_ended hook registered at index.ts:232 and routes to reap() at subagent.ts:175-178
- Confirmed subagent_spawning used only for shadow routing (PD_LOCAL_PROFILES) at index.ts:195-228
- Verified via Reviewer B cross-repo source reading: runtime.subagent.run() does NOT call registerSubagentRun()
- Confirmed subagent_ended is DEAD CODE for runtime_direct transport (requires registry entry)
- Confirmed expectsCompletionMessage is ignored (not in SubagentRunParams)
- Confirmed 5-minute TTL is the ONLY recovery mechanism for orphaned empathy sessions
- All 5 hypotheses correctly classified with evidence backing

## TRANSPORT_AUDIT

| Transport Type | Used by Empathy | Details |
|---|---|---|
| runtime_direct | YES | api.runtime.subagent.run() at empathy-observer-manager.ts:193-200 |
| registry_backed | NO | Not used; would require sessions_spawn |

**Conclusion**: Empathy observer uses runtime_direct transport exclusively. This means:
- No `registerSubagentRun()` is called
- `subagent_ended` hook will NEVER fire for empathy sessions
- Only TTL-based cleanup (5 minutes) can unblock orphaned parent sessions

## OPENCLAW_ASSUMPTIONS

| Assumption | Reality | Source |
|---|---|---|
| runtime.subagent.run() triggers subagent_ended | FALSE | server-plugins.ts:306 - dispatches to agent method only, no registry entry |
| expectsCompletionMessage causes subagent_ended | FALSE | plugins/runtime/types.ts - not in SubagentRunParams, ignored |
| spawnSubagentDirect() same as runtime.subagent.run() | FALSE | subagent-spawn.ts:797 - spawnSubagentDirect() DOES call registerSubagentRun() |
| TTL expiry is fallback cleanup | TRUE | empathy-observer-manager.ts:113 - 5-minute TTL for orphaned entries |

**Critical**: All OpenClaw compatibility assumptions verified via cross-repo source reading by Reviewer B.

## HYPOTHESIS_MATRIX

- empathy_uses_runtime_direct_transport: SUPPORTED — api.runtime.subagent.run() at empathy-observer-manager.ts:193-200 uses lane='subagent', deliver=false
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED (DEAD CODE confirmed) — runtime.subagent.run() does NOT call registerSubagentRun(), so subagent_ended never fires; verified via server-plugins.ts:306 and subagent-registry-completion.ts:44
- empathy_timeout_leads_to_false_completion: REFUTED — waitForRun timeout correctly defers to TTL; does NOT call deleteSession prematurely
- empathy_cleanup_not_idempotent: REFUTED — isCompleted() check at empathy-observer-manager.ts prevents double-write to completedSessions
- empathy_lacks_dedupe_key: SUPPORTED (partial) — uses time-based idempotencyKey `${sessionId}:${Date.now()}` but no business-level dedupe

## CHECKS

CHECKS: evidence=ok;tests=mocked-only;scope=pd-only;prompt-isolation=confirmed;openclaw-assumptions=verified-cross-repo

## OPEN_RISKS

1. **CRITICAL - Dead Code**: `subagent_ended` fallback is unreachable for `runtime_direct` transport. Workflow helper must implement explicit TTL-based cleanup.

2. **Session Leak Risk**: If `finalizeRun` fails AND TTL hasn't expired, empathy sessions remain in `activeRuns` blocking parent sessions. Only 5-minute TTL can unblock.

3. **Test Coverage Gap**: No integration test verifies hook firing behavior for `runtime_direct` transport. Unit tests mock everything.

4. **Design Doc Assumption**: `runtime.subagent.run()` ≠ `sessions_spawn` ≠ registry entry. Migration must account for this.

## CONTRACT

- transport_audit status: DONE
- lifecycle_hook_map status: DONE
- openclaw_assumptions_documented status: DONE
- failure_mode_inventory status: DONE
