# Producer Report: Subagent Helper Empathy Observer Migration

## SUMMARY

This investigation confirms the empathy observer uses `runtime_direct` transport exclusively and maps its lifecycle hooks with `before_prompt_build` as PRIMARY spawn point and `subagent_ended` as FALLBACK/OBSERVATION path. The migration to workflow helper is viable with proper timeout/failure handling. Key risk: idempotency key uses `Date.now()` making it non-deterministic.

## EVIDENCE

- **evidence_source**: local
- **files_checked**: empathy-observer-manager.ts, empathy-observer-workflow-manager.ts, runtime-direct-driver.ts, workflow-store.ts, types.ts, subagent.ts, prompt.ts, pain.ts, lifecycle.ts, subagent-probe.ts, openclaw-sdk.d.ts, index.ts, deep-reflect.ts
- **sha**: HEAD at investigation time
- **branch/worktree**: principles repository

## CODE_EVIDENCE

- files_checked: packages/openclaw-plugin/src/service/empathy-observer-manager.ts, packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts, packages/openclaw-plugin/src/service/subagent-workflow/runtime-direct-driver.ts, packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts, packages/openclaw-plugin/src/service/subagent-workflow/types.ts, packages/openclaw-plugin/src/hooks/subagent.ts, packages/openclaw-plugin/src/hooks/prompt.ts, packages/openclaw-plugin/src/hooks/pain.ts, packages/openclaw-plugin/src/hooks/lifecycle.ts, packages/openclaw-plugin/src/utils/subagent-probe.ts, packages/openclaw-plugin/src/openclaw-sdk.d.ts, packages/openclaw-plugin/src/index.ts, packages/openclaw-plugin/src/tools/deep-reflect.ts
- evidence_source: local
- sha: local repository HEAD
- branch/worktree: default

## KEY_EVENTS

- Confirmed empathy observer spawns from `before_prompt_build` hook via `empathyObserverManager.spawn()`
- Confirmed `subagent_ended` serves as fallback cleanup path for empathy observer
- Identified `isSubagentRuntimeAvailable()` check prevents BOOT sessions from spawning empathy
- Identified `RuntimeDirectDriver` wraps `api.runtime.subagent.*` methods as transport layer
- Confirmed `WorkflowStore` uses SQLite for state persistence with WAL mode
- Identified cleanup idempotency via `isCompleted()` with 5-min TTL

## HYPOTHESIS_MATRIX

- empathy_uses_runtime_direct_transport: SUPPORTED — Direct calls to `api.runtime.subagent.run/wait/getResult/cleanup` without registry involvement
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED — `subagent_ended` timing is not contractually guaranteed; no formal completion semantics verified
- empathy_timeout_leads_to_false_completion: REFUTED — Timeout sets `timedOutAt` but does NOT treat as ok; `shouldFinalizeOnWaitStatus('timeout')` returns false
- empathy_cleanup_not_idempotent: REFUTED — `isCompleted()` guard with 5-min TTL prevents double finalization; `deleteSession` failures are logged but non-fatal
- empathy_lacks_dedupe_key: SUPPORTED — Idempotency key `${sessionId}:${Date.now()}` uses timestamp, not stable hash; repeated triggers within same session can spawn duplicates

## TRANSPORT_AUDIT

### Current Transport: runtime_direct

**Entry Point**: `before_prompt_build` hook → `empathyObserverManager.spawn()`

**Transport Stack**:
1. `EmpathyObserverManager.spawn()` builds session key and prompt
2. Calls `api.runtime.subagent.run({ sessionKey, message, lane, deliver, idempotencyKey, expectsCompletionMessage })`
3. Returns `SubagentRunResult { runId }`
4. `RuntimeDirectDriver` wraps this as `run()` → `RunResult { runId }`

**Wait Path**:
1. `finalizeRun()` calls `waitForRun({ runId, timeoutMs: 30_000 })`
2. On `status=ok`: reads messages, parses JSON, persists result, deletes session
3. On `status=timeout|error`: marks `timedOutAt`/`erroredAt`, defers to `subagent_ended` fallback

**Fallback Path** (`subagent_ended`):
1. `handleSubagentEnded()` checks `isEmpathyObserverSession(targetSessionKey)`
2. If true, calls `empathyObserverManager.reap()` for cleanup
3. `reap()` skips if `isCompleted(targetSessionKey) === true`

**SQLite Persistence**:
- `WorkflowStore` maintains `subagent_workflows` and `subagent_workflow_events` tables
- Tracks: `workflow_id`, `state`, `cleanup_state`, `run_id`, `child_session_key`
- Used by `EmpathyObserverWorkflowManager` but NOT by legacy `EmpathyObserverManager`

### Transport Conclusion
Empathy observer uses **plugin-owned runtime_direct only**. No registry_backed semantics. The `EmpathyObserverWorkflowManager` in `subagent-workflow/` provides SQLite-backed state machine but legacy `EmpathyObserverManager` uses in-memory Maps.

## OPENCLAW_ASSUMPTIONS

### Verified Assumptions

1. **runtime.subagent.run() is async, fire-and-forget**
   - Returns `Promise<SubagentRunResult>` with `runId`
   - Does NOT guarantee completion; caller must poll with `waitForRun()`

2. **runtime.subagent.waitForRun() is polling-based**
   - Takes `runId` and `timeoutMs`
   - Returns `{ status: 'ok' | 'error' | 'timeout', error?: string }`
   - No event-driven callback mechanism

3. **subagent_ended fires asynchronously**
   - Separate hook from `waitForRun()` completion
   - `outcome` field: `'ok' | 'error' | 'timeout' | 'killed' | 'reset' | 'deleted'`
   - No guaranteed ordering relative to `waitForRun()` return

4. **Boot sessions lack runtime context**
   - `isSubagentRuntimeAvailable()` returns false for BOOT sessions
   - `sessionId.startsWith('boot-')` explicitly filtered

### Unverified/Open Questions

1. Does `subagent_ended` always fire for every subagent run?
2. Is there a guaranteed delivery contract for `subagent_ended`?
3. What happens if gateway restarts during active empathy observer run?

## CHECKS

CHECKS: evidence=ok;tests=not-run;scope=pd-only;prompt-isolation=confirmed

## CONTRACT

- transport_audit status: DONE
- lifecycle_hook_map status: DONE
- openclaw_assumptions_documented status: DONE
- failure_mode_inventory status: DONE
- surface_sidecar_gate status: DONE