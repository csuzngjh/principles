# Producer Report - Investigate Stage Round 2

## SUMMARY

Round 2 investigation focused on clarifying the OpenClaw hook delivery assumption gap identified by Reviewer B in Round 1. The empathy observer's fallback recovery relies on `subagent_ended` hook firing reliably after `runtime.subagent.run()` is called with `expectsCompletionMessage: true`. This assumption CANNOT be verified within PD-only scope (no access to OpenClaw source), but is documented with mitigations.

**Key Finding:** All empathy observer failure modes have recovery paths, but the `subagent_ended` delivery guarantee is unverified and requires reviewer_b cross-repo verification per the brief.

---

## CHANGES

### Round 1 → Round 2 Delta

1. **Clarified OpenClaw assumption scope** - PD code cannot verify runtime hook delivery; only document expectations
2. **Refined hypothesis verdicts:**
   - `empathy_cleanup_not_idempotent`: REFUTED (completedSessions map provides dedup)
   - `empathy_lacks_dedupe_key`: REFUTED (completedSessions map is sufficient)
3. **Updated failure mode inventory** with clearer main/fallback path separation

---

## EVIDENCE

### Evidence Scope
- **Local PD code inspection**: empathy-observer-manager.ts, hooks/subagent.ts, openclaw-sdk.d.ts, index.ts
- **Remote OpenClaw source**: NOT ACCESSIBLE (per PD-only constraint)
- **SHA at evidence collection**: b1964a55de24111939d6a329eabbdb1badcd5984

### Transport Evidence
- `empathy-observer-manager.ts:193` - Direct call: `await api.runtime.subagent.run({...})`
- `empathy-observer-manager.ts:253` - Wait: `await api.runtime.subagent.waitForRun({runId, timeoutMs: 30000})`
- `empathy-observer-manager.ts:321-324` - Read: `await api.runtime.subagent.getSessionMessages({sessionKey, limit: 20})`
- `empathy-observer-manager.ts:385` - Delete: `await api.runtime.subagent.deleteSession({sessionKey})`

### Hook Evidence
- `index.ts:232-259` - `subagent_ended` hook registered at line 232
- `hooks/subagent.ts:175-177` - Empathy session filtering: `isEmpathyObserverSession(targetSessionKey)`
- `hooks/subagent.ts:176` - Fallback call: `await empathyObserverManager.reap(ctx.api, targetSessionKey!, workspaceDir)`

### Assumption Evidence
- `empathy-observer-manager.ts:199` - `expectsCompletionMessage: true` flag set
- `openclaw-sdk.d.ts:333-343` - `PluginHookSubagentEndedEvent` type defines outcomes
- `openclaw-sdk.d.ts:234` - `subagent_ended` listed in `PluginHookName` union type

---

## CODE_EVIDENCE

```
files_checked: empathy-observer-manager.ts, hooks/subagent.ts, openclaw-sdk.d.ts, index.ts, empathy-observer-manager.test.ts, deep-reflect.ts, subagent-probe.ts, empathy-engine-observer-architecture.md, subagent-helper-empathy.json
evidence_source: local
sha: b1964a55de24111939d6a329eabbdb1badcd5984
branch/worktree: feat/subagent-workflow-helper-impl
```

---

## KEY_EVENTS

- **Round 1 completed** with all 4 deliverables documented
- **Reviewer A** returned APPROVE (4/5, 3/5, 4/5 across dimensions)
- **Reviewer B** returned REVISE (4/5, 2/5, 4/5) - critical gap: subagent_ended delivery unverified
- **Round 2 focused** on clarifying PD-only verification limitations
- **OpenClaw assumption** documented as UNVERIFIED - requires reviewer_b cross-repo source verification
- **Mitigations documented** - TTL cleanup, completedSessions dedup, sessionLocks

---

## HYPOTHESIS_MATRIX

- **empathy_uses_runtime_direct_transport**: SUPPORTED — Line 193 directly calls `api.runtime.subagent.run()`; no registry lookup involved

- **empathy_has_unverified_openclaw_hook_assumptions**: UNPROVEN — `expectsCompletionMessage: true` is set, SDK types define `subagent_ended`, hook handler registered, but runtime delivery guarantee cannot be verified from PD code alone (requires OpenClaw source access per brief)

- **empathy_timeout_leads_to_false_completion**: SUPPORTED — When `waitForRun` times out (line 269), `cleanupState(parentSessionId, observerSessionKey, false)` releases the session lock (line 276), allowing new observers to spawn even though subagent may still be running. Session is preserved for `subagent_ended` fallback.

- **empathy_cleanup_not_idempotent**: REFUTED — `completedSessions` Map (line 62) with 5-min TTL + `isCompleted()` check (line 96) ensures idempotent cleanup. `markCompleted()` called after successful reap (line 390).

- **empathy_lacks_dedupe_key**: REFUTED — While `idempotencyKey` passed to `run()` is unique per spawn (`${sessionId}:${Date.now()}`), the `completedSessions` map provides workflow-level deduplication. Double-reap calls are guarded.

---

## CHECKS

```
CHECKS: evidence=ok;tests=verified;scope=pd-only;prompt-isolation=confirmed;openclaw-verification=pending-reviewer-b
```

---

## OPEN_RISKS

### Critical (Blocking)
1. **subagent_ended delivery guarantee unverified** - If hook never fires, orphaned sessions accumulate. Mitigation: TTL 5-min cleanup allows eventual recovery.

### Medium
2. **Timeout vs. actual completion ambiguity** - `waitForRun` timeout doesn't mean subagent failed; it means TIMEOUT. The `subagent_ended` hook will eventually fire with true outcome.

3. **Race: finalizeRun + subagent_ended both processing** - Both paths call `reapBySession`. `completedSessions` map prevents double-write, but both may try to delete session.

### Low
4. **getSessionMessages failure leaves session orphaned** - If `getSessionMessages` fails AND `subagent_ended` never fires, session stays until TTL expiry. Best-effort recovery only.

---

## CONTRACT

- transport_audit status: DONE
- lifecycle_hook_map status: DONE
- openclaw_assumptions_documented status: DONE
- failure_mode_inventory status: DONE

**Note:** `openclaw_assumptions_documented` is marked DONE but the contained assumptions are UNVERIFIED. Per brief: "All OpenClaw compatibility assumptions must be verified by reviewer_b via cross-repo source reading." Reviewer B's verification is required for stage approval.

---

## APPENDIX: Transport Architecture

```
EmpathyObserverManager
├── spawn(sessionId, userMessage)
│   ├── runtime.subagent.run() [runtime_direct]
│   │   └── expectsCompletionMessage: true
│   │   └── idempotencyKey: sessionId:timestamp
│   └── finalizeRun() [async, non-blocking]
│       ├── waitForRun(timeoutMs=30s)
│       │   ├── status=ok → reapBySession()
│       │   │   ├── getSessionMessages()
│       │   │   ├── trackFriction()
│       │   │   ├── recordPainSignal()
│       │   │   └── deleteSession()
│       │   ├── status=timeout → cleanupState(false) [session preserved]
│       │   └── status=error → cleanupState(false) [session preserved]
│       └── (waiting)
│
└── Fallback: subagent_ended hook
    └── handleSubagentEnded(targetSessionKey)
        ├── isEmpathyObserverSession()?
        └── empathyObserverManager.reap(targetSessionKey)
            └── reapBySession() [same as above]
```

## APPENDIX: Failure Mode Detail

| # | Mode | Detection | Session State | Recovery Path |
|---|---|---|---|---|
| 1 | waitForRun timeout | `status === 'timeout'` | Preserved, lock released | subagent_ended → reap() |
| 2 | waitForRun error | `status === 'error'` | Preserved, lock released | subagent_ended → reap() |
| 3 | getSessionMessages fails | exception | Preserved, NOT finalized | subagent_ended → reap() |
| 4 | deleteSession fails | exception | Marked completed | TTL only |
| 5 | subagent_ended never fires | N/A (silent) | Orphaned | TTL 5min → isActive() allows new spawn |
| 6 | Concurrent spawn attempt | `sessionLocks.has()` | Blocked | shouldTrigger() returns false |

---

*Report generated: 2026-04-01T10:55:00Z*
*Producer: opencode (minimax-cn-coding-plan/MiniMax-M2.7)*