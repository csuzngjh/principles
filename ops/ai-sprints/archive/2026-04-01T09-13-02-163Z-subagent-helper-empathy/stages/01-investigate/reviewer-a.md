# Reviewer A Report: Empathy Observer Investigation

## VERDICT
BLOCK

## BLOCKERS
1. **Producer report is empty/invalid** - The producer.md file contains only a raw session log that ends abruptly after reading the brief. No actual investigation was performed.
2. **No CONTRACT section** - Required deliverables not assessed.
3. **No deliverables completed** - transport_audit, lifecycle_hook_map, openclaw_assumptions_documented, failure_mode_inventory all missing.

## FINDINGS

### 1. Transport Audit (Independent Investigation)
Empathy observer uses **RUNTIME_DIRECT** transport:
- Calls `api.runtime.subagent.run()` directly without registry backing
- Session key format: `agent:main:subagent:empathy-obs-{safeParentSessionId}-{timestamp}`
- No idempotency key pattern that could enable deduplication

### 2. Lifecycle Hooks Used
- `before_prompt_build`: Triggers `empathyObserverManager.spawn()` on user messages
- `subagent_ended`: Fallback reaping via `empathyObserverManager.reap()`

### 3. Failure Modes Identified

| Failure Mode | Description | Current Handling |
|--------------|-------------|------------------|
| waitForRun timeout | 30s timeout expires | Sets timedOutAt, preserves session for subagent_ended fallback |
| waitForRun error | Subagent crashes | Sets erroredAt, preserves session for fallback |
| getSessionMessages fails | Session not readable | finalized=false, no deleteSession, activeRuns preserved |
| deleteSession fails | Cleanup error | finalized=true, marks completed anyway |
| subagent_ended never fires | Orphaned session | TTL expiry after 5 minutes unblocks parent |

### 4. OpenClaw Assumptions (Critical)
**UNVERIFIED ASSUMPTION**: `subagent_ended` hook fires after `run()` completes in all cases.

The code assumes:
1. If `waitForRun` returns 'ok', `subagent_ended` may or may not fire (acceptable)
2. If `waitForRun` returns 'timeout'/'error', `subagent_ended` will eventually fire to clean up

**This assumption is NOT verified in the OpenClaw SDK**. If OpenClaw's subagent runtime does NOT fire `subagent_ended` for timed-out/errored sessions, orphaned entries will block future spawns for 5 minutes (TTL fallback).

### 5. Deep-Reflect Comparison
Deep-reflect uses a **simpler synchronous pattern**:
- `run()` → `waitForRun()` → `getSessionMessages()` → `deleteSession()` in finally block
- No `subagent_ended` dependency
- No async cleanup race conditions
- Session always deleted in finally block

### 6. Missing Dedupe Key
Empathy observer does NOT have a stable deduplication key:
- Uses timestamp in session key: `{parentSessionId}-{timestamp}`
- `idempotencyKey` passed to `run()` is `${sessionId}:${Date.now()}` - also timestamp-based
- Cannot detect/recover from duplicate spawns for same parent session

## HYPOTHESIS_MATRIX
- empathy_uses_runtime_direct_transport: SUPPORTED — Direct `api.runtime.subagent.run()` calls, no registry.
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED — Assumes `subagent_ended` fires for all terminal states; not verified in SDK.
- empathy_timeout_leads_to_false_completion: SUPPORTED — Timeout sets timedOutAt but does NOT call deleteSession; relies on subagent_ended or TTL.
- empathy_cleanup_not_idempotent: REFUTED — `isCompleted()` check prevents double-processing; `markCompleted()` is idempotent.
- empathy_lacks_dedupe_key: SUPPORTED — Session key and idempotencyKey both use timestamp; no stable dedupe per parent session.

## CODE_EVIDENCE
- files_verified: empathy-observer-manager.ts, deep-reflect.ts, subagent.ts, prompt.ts, openclaw-sdk.d.ts, subagent-probe.ts, nocturnal-service.ts, empathy-observer-manager.test.ts
- evidence_source: local
- sha: b1964a55de24111939d6a329eabbdb1badcd5984
- evidence_scope: both

## DIMENSIONS
DIMENSIONS: evidence_quality=4; assumption_coverage=3; transport_audit_completeness=4

## NEXT_FOCUS
1. Verify in OpenClaw source whether `subagent_ended` fires for timed-out sessions
2. Design registry-backed transport to enable proper deduplication
3. Consider deep-reflect's simpler pattern (synchronous finally block) for workflow helper

## CHECKS
CHECKS: criteria=not_met;blockers=1;verification=complete
