# Producer Worklog - Investigate Stage Round 1+2

## Round 1 Summary (from previous worklog)
- Completed initial investigation
- All 4 deliverables documented
- Reviewer A: APPROVE (4/5, 3/5, 4/5)
- Reviewer B: REVISE (4/5, 2/5, 4/5) - critical gap: subagent_ended delivery NOT verified

---

## Round 2 Investigation Start: 2026-04-01T10:15:00Z

### Focus: Address Reviewer B's Critical Blocker

**Reviewer B's Finding:** subagent_ended delivery guarantee NOT verified via cross-repo source reading

**Constraint:** PD-only changes; cannot access OpenClaw source

### Additional Files Examined (Round 2)
- `ops/ai-sprints/specs/subagent-helper-empathy.json` - Sprint spec

### OpenClaw Assumption Analysis (Round 2)

**Critical Assumption: subagent_ended delivery guarantee**

Empathy observer relies on `subagent_ended` hook as fallback recovery:

```typescript
// empathy-observer-manager.ts line 193-200
const result = await api.runtime.subagent.run({
    sessionKey,
    message: prompt,
    lane: 'subagent',
    deliver: false,
    idempotencyKey: `${sessionId}:${Date.now()}`,
    expectsCompletionMessage: true,  // <-- KEY FLAG
} as SubagentRunResult);
```

**Evidence for delivery expectation:**
1. `expectsCompletionMessage: true` is explicitly set
2. SDK type `PluginHookSubagentEndedEvent` is defined with outcomes
3. Hook handler is registered in index.ts
4. Test coverage exists for subagent_ended path

**What CANNOT be verified (PD-only):**
1. Whether runtime actually delivers the hook event
2. Whether `expectsCompletionMessage` guarantees hook delivery
3. Race conditions in hook delivery timing
4. Crash/kill scenarios where hook may not fire

**Mitigation in PD code:**
- TTL-based cleanup (5 min) as safety net
- `completedSessions` map prevents double-write
- `sessionLocks` prevents concurrent spawns
- `isActive()` blocks new spawns if session still tracked

### Updated Hypothesis Matrix

| Hypothesis | Evidence | Verdict |
|---|---|---|
| empathy_uses_runtime_direct_transport | Line 193: api.runtime.subagent.run() | SUPPORTED |
| empathy_has_unverified_openclaw_hook_assumptions | Cannot verify subagent_ended delivery from PD code | UNPROVEN |
| empathy_timeout_leads_to_false_completion | timeout releases lock but session preserved for fallback | SUPPORTED |
| empathy_cleanup_not_idempotent | completedSessions map + isCompleted() check | REFUTED |
| empathy_lacks_dedupe_key | idempotencyKey unique per spawn, BUT completedSessions provides dedup | REFUTED |

### Updated Failure Mode Inventory

| Failure Mode | Main Path | Fallback Path |
|---|---|---|
| waitForRun timeout | cleanupState(false), session preserved | subagent_ended → reap() |
| waitForRun error | cleanupState(false), session preserved | subagent_ended → reap() |
| getSessionMessages fails | finalized=false, NOT deleted | reap() retries |
| deleteSession fails | marks completed anyway | N/A |
| subagent_ended never fires | N/A | TTL 5min → isActive() allows new spawn |

### Key Events

1. **Round 1 completed** - All 4 deliverables documented
2. **Reviewer B gap identified** - subagent_ended delivery unverified
3. **Round 2 clarification** - PD-only scope cannot verify OpenClaw internals
4. **Assumptions clarified** - All OpenClaw hook assumptions documented as UNVERIFIED

---

## Round 2 Investigation Complete: 2026-04-01T10:50:00Z
