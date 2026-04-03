# Reviewer-A Report - Stage 01-Investigate

## VERDICT

**BLOCK**

The producer failed to produce a valid report. The producer.md file contains a raw session log instead of the required structured report with sections: SUMMARY, EVIDENCE, CODE_EVIDENCE, KEY_EVENTS, TRANSPORT_AUDIT, OPENCLAW_ASSUMPTIONS, CHECKS, and CONTRACT. The producer state shows "round": 0 and "status": "idle", indicating the producer never properly started or completed the investigation.

I performed an independent investigation and can provide findings, but the stage cannot proceed without a proper producer report.

## BLOCKERS

1. **Producer report missing required sections**: No SUMMARY, EVIDENCE, CODE_EVIDENCE, KEY_EVENTS, TRANSPORT_AUDIT, OPENCLAW_ASSUMPTIONS, CHECKS, or CONTRACT sections.
2. **Producer state indicates non-completion**: "round": 0, "status": "idle" - producer never transitioned to active state.
3. **Cannot verify producer deliverables**: The brief required deliverables (transport_audit, lifecycle_hook_map, openclaw_assumptions_documented, failure_mode_inventory) were never produced.

## FINDINGS

### Transport Mechanism
- Empathy observer uses **runtime_direct transport**: calls pi.runtime.subagent.run() directly without any registry abstraction.
- This is confirmed at empathy-observer-manager.ts:166-180 where pi.runtime.subagent.run() is invoked.
- Deep-reflect tool also uses runtime_direct pattern at deep-reflect.ts:247-251.

### Lifecycle Hooks
- Empathy observer does NOT register any lifecycle hooks itself.
- The handleSubagentEnded function in subagent.ts:87-220 is the hook handler for subagent_ended.
- Empathy observer's eap() method is called from handleSubagentEnded when the session key matches the empathy observer prefix.
- **Critical assumption**: Code assumes subagent_ended hook is always called by OpenClaw after untime.subagent.run() completes. This is NOT documented in the SDK.

### Timeout/Error/Failure Modes
- **Timeout path**: waitForRun returns { status: 'timeout' } → sets 	imedOutAt and observedAt, preserves ctiveRuns entry (lines 210-217).
- **Error path**: Similar to timeout → preserves entry for fallback processing (lines 201-209).
- **Cleanup**: TTL-based expiry (5 minutes) for orphaned entries (lines 70-82).
- **Idempotency**: completedSessions map with 5-minute TTL prevents double-processing.
- **Session lock**: Per-session lock prevents concurrent observer spawns for same parent session.

### Dedupe Key Analysis
- Uses ${sessionId}: as idempotencyKey in run params (line 175).
- However, the session-level lock in sessionLocks map is the primary deduplication mechanism.
- shouldTrigger() checks isActive() which verifies no active run exists for the session.

## CODE_EVIDENCE

- files_verified: empathy-observer-manager.ts, subagent.ts, deep-reflect.ts, openclaw-sdk.d.ts, empathy-observer-manager.test.ts
- evidence_source: local
- sha: b1964a55de24111939d6a329eabbdb1badcd5984
- evidence_scope: both

### Key Code Locations

| File | Lines | Finding |
|------|-------|---------|
| empathy-observer-manager.ts | 166-180 | Runtime direct transport: pi.runtime.subagent.run() |
| empathy-observer-manager.ts | 70-82 | TTL-based cleanup for orphaned entries |
| empathy-observer-manager.ts | 210-217 | Timeout path preserves activeRuns entry |
| subagent.ts | 87-100 | handleSubagentEnded hook handler |
| subagent.ts | 101-106 | Empathy observer session detection and reap call |
| openclaw-sdk.d.ts | 91-103 | Subagent runtime API types (no hook guarantees documented) |

## HYPOTHESIS_MATRIX

- empathy_uses_runtime_direct_transport: SUPPORTED — Direct pi.runtime.subagent.run() call at empathy-observer-manager.ts:166-180; no registry abstraction found.
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED — Code relies on subagent_ended hook being called after waitForRun, but SDK types at openclaw-sdk.d.ts:91-103 do not document this guarantee.
- empathy_timeout_leads_to_false_completion: SUPPORTED — Timeout path (lines 210-217) preserves ctiveRuns entry with 	imedOutAt set; session is NOT deleted; fallback relies on TTL expiry.
- empathy_cleanup_not_idempotent: REFUTED — completedSessions map with 5-minute TTL prevents double-processing; tests confirm dedupe behavior.
- empathy_lacks_dedupe_key: PARTIALLY_REFUTED — idempotencyKey is used (:), and session-level lock provides primary deduplication. However, key is timestamp-based (not deterministic) which limits true idempotency.

## NEXT_FOCUS

1. **Producer must resubmit**: The producer needs to generate a proper report with all required sections.
2. **OpenClaw hook guarantee verification**: Reviewer_b should verify via cross-repo source reading whether untime.subagent.run() guarantees subagent_ended hook invocation in all cases (timeout, error, killed, etc.).
3. **Transport migration scope**: Once proper report is available, assess what changes are needed to migrate from runtime_direct to registry_backed pattern.

## CHECKS

CHECKS: criteria=not_met;blockers=3;verification=incomplete

## DIMENSIONS

DIMENSIONS: evidence_quality=4; assumption_coverage=3; transport_audit_completeness=2

### Dimension Explanations

- **evidence_quality (4/5)**: Strong code evidence from direct file reading; line numbers and specific code paths documented. Deducted 1 point because OpenClaw runtime behavior not verified (requires cross-repo source reading).
- **assumption_coverage (3/5)**: All 5 hypotheses addressed, but one remains partially unresolved (dedupe key semantics). The OpenClaw hook guarantee assumption is identified but not verified.
- **transport_audit_completeness (2/5)**: FAIL - Producer did not complete required deliverables. Independent investigation found transport mechanism, but full audit with lifecycle_hook_map, failure_mode_inventory, and openclaw_assumptions_documented was not produced by the responsible party.
