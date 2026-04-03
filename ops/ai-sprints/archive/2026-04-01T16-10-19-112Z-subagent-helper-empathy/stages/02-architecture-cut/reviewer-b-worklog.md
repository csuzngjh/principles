# reviewer-b worklog — architecture-cut round 1

## Investigation checkpoints

### CP-1: OpenClaw source availability
- Checked: D:/Code/openclaw/src/agents/ directory exists and contains subagent-registry-lifecycle.ts, subagent-registry-completion.ts
- Status: VERIFIED — OpenClaw source is available for cross-repo verification

### CP-2: Producer's OpenClaw claims verification
- Claim 1 (subagent_ended fires for runtime_direct with expectsCompletionMessage: true):
  - Evidence at subagent-registry-lifecycle.ts:521-533: shouldDeferEndedHook check confirms hook fires
  - Status: VERIFIED
- Claim 2 (hook timing DEFERRED):
  - Evidence at subagent-registry-lifecycle.ts:521-533: shouldDeferEndedHook defers to cleanup flow
  - Status: VERIFIED
- Claim 3 (runtime.subagent.run() dispatches to gateway "agent" method):
  - Evidence at server-plugins.ts:327-347: confirmed dispatch to "agent" method
  - Status: VERIFIED
- Claim 4 (outcome mapping correct):
  - Evidence at subagent-registry-completion.ts:32-42: error→error, timeout→timeout, ok→ok
  - Status: VERIFIED
- Claim 5 (hook deduplication via endedHookEmittedAt):
  - Evidence at subagent-registry-completion.ts:58-63: confirmed dedup check
  - Status: VERIFIED

### CP-3: Implementation code existence check
- packages/openclaw-plugin/src/service/subagent-workflow/ — NO SUCH DIRECTORY EXISTS
- EmpathyObserverManager: exists at packages/openclaw-plugin/src/service/empathy-observer-manager.ts (511 lines)
- Existing tests: packages/openclaw-plugin/tests/service/empathy-observer-manager.test.ts (393 lines)
- Status: ARCHITECTURE-DECISION STAGE — no implementation code expected; this is a design-only stage

### CP-4: Existing empathy observer review
- Singleton pattern with manual state: sessionLocks, activeRuns, completedSessions Maps
- Fallback path: subagent_ended hook → handleSubagentEnded → empathyObserverManager.reap()
- Timeout/error handling: sets timedOutAt/erroredAt, observedAt for TTL cleanup
- Dedup: completedSessions with 5-min TTL, activeRuns with 5-min TTL
- Status: WELL-IMPLEMENTED, well-tested

### CP-5: Scope creep check
- PR2 scope: empathy observer + deep-reflect ONLY
- Excluded: Diagnostician, Nocturnal, routing shadow observer
- Status: SCOPE BOUNDARIES CLEAR

### CP-6: Shadow run plan adequacy
- Producer claims shadow mode → metrics → canary → full rollout
- No concrete metrics/thresholds documented in producer report
- Status: PLAN OUTLINE EXISTS, CONCRETE CRITERIA NOT SPECIFIED

### CP-7: OpenClaw SDK types
- openclaw-sdk.d.ts does NOT contain SubagentRunRecord, SubagentLifecycleEndedOutcome types
- expectsCompletionMessage NOT defined in PD's SDK types (confirmed grep returned no matches)
- Producer correctly verified this via OpenClaw cross-repo reading
- Status: RISK — PD SDK types are incomplete relative to OpenClaw source

### CP-8: Hook deduplication analysis
- isCompleted() uses 5-min TTL on completedSessions
- activeRuns TTL is 5 minutes
- Race condition: if finalizeRun completes BEFORE subagent_ended fires, both paths may attempt finalization
- Mitigation in current code: completedSessions prevents double-write
- New risk: workflow helper's state machine must replicate this dedup behavior
- Status: MUST BE VERIFIED IN IMPLEMENTATION

### CP-9: Interface soundness assessment
- EmpathyObserverManager preserved as public API (wrapper pattern)
- 5 API methods: startWorkflow, notifyWaitResult, notifyLifecycleEvent, finalizeOnce, sweepExpiredWorkflows
- Fine-grained state machine: requested→spawned→waiting→result_ready→finalizing→persisted→completed
- Dedup key: workflowType:parentSessionId:logicalTaskId
- Status: INTERFACE DESIGN SOUND, IMPLEMENTATION NOT VERIFIED

### CP-10: Hook timing analysis
- Deferred hook means subagent_ended fires during CLEANUP FLOW (not immediately)
- For empathy observer with 30s wait timeout: if subagent task completes, waitForRun resolves, finalizeRun calls reapBySession, markCompleted called
- When cleanup flow runs (later), subagent_ended fires into handleSubagentEnded → empathyObserverManager.reap()
- Since isCompleted=true, reap() skips
- Status: DEFERRED TIMING IS SAFE given completedSessions dedup

---

# Round 2 Analysis

## Round 1 Blocker Resolution Check

### Blocker 1: shadow_run_plan was "outline_only"
- Round 1 reviewerB said: "No concrete metrics/thresholds documented"
- Round 2 producer response: Created shadow_run_plan.md with 249 lines
- Verification: Phase 1 thresholds defined, rollback triggers defined, shadow schema SQL defined
- Status: RESOLVED

### Blocker 2: interface_draft was prose, not actual code
- Round 1 reviewerB said: "types.ts not created, only prose"
- Round 2 producer response: Created types.ts as actual TypeScript code artifact (292 lines)
- Status: RESOLVED

## OpenClaw Verification Re-confirmation
- All 5 assumptions verified again in Round 2
- Source code exists and is correct at D:/Code/openclaw

## Final Assessment
- All Round 1 blockers resolved
- No new blockers identified
- Ready for APPROVE
