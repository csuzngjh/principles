# Worklog


# Worklog — Stage 02-architecture-cut, Round 1

## 2026-04-01T16:05:00Z — Initializing architecture-cut stage

### Context from previous stage (investigate):
- empathy observer uses `runtime_direct` transport via `api.runtime.subagent.run()`
- Lifecycle hooks: `subagent_spawning` (shadow routing) and `subagent_ended` (routes to `reap()`)
- Hook timing is DEFERRED for `expectsCompletionMessage: true` runs
- Design doc: `2026-03-31-subagent-workflow-helper-design.md` provides migration architecture

### Key design decisions needed:
1. **Migrate or keep existing?** → Based on design doc, empathy is the best first candidate
2. **Interface definition**: startWorkflow(), finalizeOnce(), etc.
3. **OpenClaw cross-repo verification**: Verify hook assumptions
4. **Shadow run plan**: How to validate migration safely

### Architecture decision rationale:
- **MIGRATE empathy to workflow helper** using `runtime_direct` transport
- Rationale:
  - Empathy observer already uses `runtime_direct` (confirmed in investigate)
  - Clear workflow boundaries with structured JSON result
  - Strong idempotency and cleanup requirements
  - Already exposes timeout/fallback/cleanup issues that helper addresses
  - Design doc section 12.1 explicitly identifies empathy as first candidate

### OpenClaw verification needed:
- `subagent_ended` hook timing for `runtime_direct` transport
- `expectsCompletionMessage` guarantee verification
- Cross-repo source reading in OpenClaw


## 2026-04-01T16:20:00Z — OpenClaw Cross-Repo Verification

### Verified Assumptions:

1. **Hook emission for `expectsCompletionMessage: true` runs**
   - Location: `subagent-registry-lifecycle.ts:521-533`
   - `shouldDeferEndedHook` logic confirms hook fires during cleanup flow
   - Hook timing: DEFERRED (not immediate)
   - Code: `shouldDeferEndedHook = shouldEmitEndedHook && completeParams.triggerCleanup && entry.expectsCompletionMessage === true`

2. **Plugin runtime `subagent.run()` dispatch**
   - Location: `server-plugins.ts:296-348`
   - Confirms `runtime.subagent.run()` dispatches to `"agent"` gateway method
   - NOT a direct registry call

3. **Hook emission mechanism**
   - Location: `subagent-registry-lifecycle.ts:137-154` (`emitCompletionEndedHookIfNeeded`)
   - Called during cleanup flow (lines 148, 176, 289, 351)

4. **`subagent_ended` outcome mapping**
   - Verified: `subagent-registry-completion.ts` maps `SubagentRunOutcome` to `SubagentLifecycleEndedOutcome`

### Conclusion:
Migration is architecturally sound. The `runtime_direct` transport for empathy observer does properly trigger `subagent_ended` hook via registry cleanup flow when `expectsCompletionMessage: true` is set.

