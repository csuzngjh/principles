# Producer Report - Investigate Stage (Round 2)

## SUMMARY

Round 1 completed all four deliverables. Round 2 verifies those findings through direct code inspection and surfaces additional evidence, particularly a pre-existing bug in `deep-reflect.ts` that was implicitly included in PR2 scope.

**All deliverables: DONE.** All five hypotheses are SUPPORTED or PARTIAL-SUPPORTED.

## EVIDENCE

- empathy-observer-manager.ts (511 lines) — core empathy observer singleton
- deep-reflect.ts (410 lines) — deep-reflect tool with confirmed waitForRun bug
- subagent.ts (481 lines) — subagent lifecycle hook handler
- index.ts (640 lines) — hook registration, plugin entry
- openclaw-sdk.d.ts (464 lines) — SDK type definitions
- subagent-probe.ts (94 lines) — runtime availability detection

## CODE_EVIDENCE

- files_checked: empathy-observer-manager.ts, deep-reflect.ts, subagent.ts, index.ts, openclaw-sdk.d.ts, subagent-probe.ts
- evidence_source: local
- sha: 4138178
- branch/worktree: principles (HEAD)
- evidence_scope: principles

## KEY_EVENTS

- Confirmed runtime_direct transport for empathy-observer (api.runtime.subagent.run(), line 193 of empathy-observer-manager.ts)
- Confirmed runtime_direct transport for deep-reflect (api.runtime.subagent.run(), line 284 of deep-reflect.ts)
- Identified deep-reflect waitForRun bug: sessionKey passed as runId (line 291), not the returned runId from SubagentRunResult
- Confirmed subagent_ended is the primary cleanup trigger for empathy-observer fallback path
- Verified subagent_spawning and subagent_ended hooks are the only subagent lifecycle hooks used
- Confirmed idempotencyKey in empathy-observer uses timestamp (`${sessionId}:${Date.now()}`) — not session-level idempotent
- Confirmed isCompleted() TTL of 5 minutes for deduplication window
- Verified empathy-observerManager.reap() is called from handleSubagentEnded when sessionKey matches observer prefix

## TRANSPORT_AUDIT

**empathy-observer**: `runtime_direct` via `api.runtime.subagent.run({ sessionKey, message, lane, deliver: false, idempotencyKey, expectsCompletionMessage: true })`. No registry involvement. waitForRun with 30s timeout drives main path; subagent_ended fallback drives rescue path.

**deep-reflect**: `runtime_direct` via `api.runtime.subagent.run({ sessionKey, message, extraSystemPrompt, deliver: false })`. **BUG**: return value (SubagentRunResult.runId) is discarded; waitForRun called with `sessionKey` as runId (line 291), guaranteeing timeout. The subagent runs to completion but the tool always reports timeout.

**Both**: Use fire-and-forget run() + waitForRun polling, not the session-mode delivery.

## OPENCLAW_ASSUMPTIONS

**Assumption: runtime.subagent.run() guarantees subagent_ended hook fires**

- SUPPORTED with caveats: OpenClaw fires subagent_ended when subagent session terminates normally or abnormally. empathy-observer relies on this for its fallback rescue path (reap()). If subagent crashes hard without OpenClaw catching it, the hook might not fire, leaving orphaned entries. TTL-based cleanup (5 min) mitigates this.

**Assumption: subagent_spawning can be used to inject context into subagents**

- SUPPORTED: subagent_spawning hook is registered in index.ts (lines 194-229). empathy-observer does NOT use it (no injection of empathy instructions per subagent). Only shadow routing logic uses it.

**Assumption: waitForRun(runId) uses runId not sessionKey**

- REFUTED for deep-reflect: SubagentRunResult.runId is a separate field from sessionKey. deep-reflect passes sessionKey to waitForRun (line 291), guaranteeing timeout. Empathy-observer correctly uses runId from SubagentRunResult (line 200-201).

## HYPOTHESIS_MATRIX

- empathy_uses_runtime_direct_transport: SUPPORTED — api.runtime.subagent.run() called directly in both empathy-observer (line 193) and deep-reflect (line 284). No registry_backed usage found.
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED — empathy relies on subagent_ended firing for fallback cleanup; OpenClaw does not formally guarantee this in its SDK contract (openclaw-sdk.d.ts PluginHookHandlerMap shows void return). Hook fires asynchronously after subagent terminates; timing relative to finalizeRun is racy.
- empathy_timeout_leads_to_false_completion: SUPPORTED — finalizeRun timeout (line 269-277) sets timedOutAt/observedAt but does NOT call markCompleted; activeRuns entry is preserved for fallback. This means a timed-out observer does not record pain signals even if the subagent eventually processes the message. The fallback can recover if subagent_ended fires, but if it doesn't, the session is silently dropped.
- empathy_cleanup_not_idempotent: PARTIAL — isCompleted() check (line 306-310) prevents double-reap within a 5-minute TTL window. After TTL expiry, a new reapBySession call would re-read messages and re-record pain signals. The 5-min window is an implicit contract not documented in code.
- empathy_lacks_dedupe_key: SUPPORTED — idempotencyKey format is `${sessionId}:${Date.now()}` (line 198), includes timestamp making every spawn attempt unique. OpenClaw may deduplicate at infrastructure level, but the key is not session-level stable.

## CHECKS

CHECKS: evidence=ok;tests=not-run;scope=pd-only;prompt-isolation=confirmed

## CONTRACT

- transport_audit status: DONE
- lifecycle_hook_map status: DONE
- openclaw_assumptions_documented status: DONE
- failure_mode_inventory status: DONE
