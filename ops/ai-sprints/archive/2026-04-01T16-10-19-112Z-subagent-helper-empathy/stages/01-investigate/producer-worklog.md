# Producer Worklog - Investigate Stage

## Round 2 - Investigation Session

### Investigation Steps

1. **Read Stage Brief** - Confirmed Round 2 goals: verify Round 1 findings, focus on stage goals
2. **Examined empathy-observer-manager.ts** (511 lines) - Confirmed runtime_direct transport (line 193: api.runtime.subagent.run()), idempotencyKey with timestamp (line 198), waitForRun with 30s timeout (line 253-256), subagent_ended fallback via reap() (lines 401-428)
3. **Examined deep-reflect.ts** (410 lines) - Found CRITICAL BUG at line 291: `waitForRun({ runId: sessionKey })` passes sessionKey instead of result.runId. run() return value (SubagentRunResult) is discarded. This guarantees timeout. deep-reflect IS in PR2 scope despite being implicit.
4. **Examined subagent.ts** (481 lines) - handleSubagentEnded routes empathy sessions to empathyObserverManager.reap() (lines 175-178). Only subagent_ended hook used for empathy cleanup.
5. **Examined index.ts** (640 lines) - subagent_spawning (lines 194-229) and subagent_ended (lines 231-260) hooks registered. Empathy observer NOT connected via subagent_spawning (no per-subagent empathy injection).
6. **Examined openclaw-sdk.d.ts** (464 lines) - SubagentRunResult.runId is a separate field from sessionKey. PluginHookHandlerMap shows subagent_ended returns void (not guaranteed synchronous).
7. **Examined subagent-probe.ts** (94 lines) - Distinguishes gateway mode (AsyncFunction) from embedded mode (throws synchronously). No transport change implications.

### Key Findings

- Transport: runtime_direct confirmed for both empathy-observer and deep-reflect
- Deep-reflect bug: waitForRun always times out because sessionKey is passed instead of runId
- Lifecycle hooks: subagent_spawning (shadow routing only), subagent_ended (empathy fallback + diagnostician)
- OpenClaw assumption risk: subagent_ended fires asynchronously; race with finalizeRun is mitigated by 5-min TTL
- Cleanup idempotency: PARTIAL — 5-min TTL window is implicit, not documented
- IdempotencyKey: timestamp-based, not session-level stable

### Deliverable Status (Round 2 Verification)
- transport_audit: DONE — runtime_direct confirmed, deep-reflect bug documented
- lifecycle_hook_map: DONE — subagent_spawning, subagent_ended documented with usages
- openclaw_assumptions_documented: DONE — subagent_ended timing/race condition caveat
- failure_mode_inventory: DONE — timeout→false-completion, orphan sessions, non-idempotent cleanup

### Timestamp: 2026-04-02T00:15:00Z
