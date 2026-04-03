# Reviewer A Report - Investigate Stage (Round 3)

## VERDICT

APPROVE

## BLOCKERS

None.

## FINDINGS

### 1. Transport Audit Complete and Accurate

The producer's transport audit is correct:
- **Current implementation** (empathy-observer-manager.ts:193): Direct `api.runtime.subagent.run()` with `deliver: false`, `expectsCompletionMessage: true`
- **Target implementation** (empathy-observer-workflow-manager.ts:91): Same transport via `RuntimeDirectDriver` wrapper
- Both use `runtime_direct` transport, NOT `registry_backed`

### 2. Lifecycle Hook Map Verified

- `subagent_ended` hook registered at index.ts:232
- Hook checks `isEmpathyObserverSession()` and calls `empathyObserverManager.reap()`
- `subagent_spawning` hook at index.ts:196 for shadow routing
- Producer's claim that `subagent_ended` is a fallback mechanism is accurate

### 3. Hypothesis Matrix Validated

| Hypothesis | Producer Claim | Reviewer Finding |
|------------|---------------|------------------|
| empathy_uses_runtime_direct_transport | SUPPORTED | **CONFIRMED** - Both implementations use direct `runtime.subagent.run()` |
| empathy_has_unverified_openclaw_hook_assumptions | SUPPORTED | **CONFIRMED** - `subagent_ended` timing is non-deterministic with `expectsCompletionMessage: true` |
| empathy_timeout_leads_to_false_completion | REFUTED | **CONFIRMED** - Timeout preserves session via `timedOutAt`/`observedAt` markers (lines 269-277) |
| empathy_cleanup_not_idempotent | SUPPORTED | **CONFIRMED** - `cleanupState()` with `deleteFromActiveRuns=false` preserves entry (line 432) |
| empathy_lacks_dedupe_key | SUPPORTED | **CONFIRMED** - Idempotency key uses `Date.now()` making each spawn unique (line 198, workflow-manager line 110) |

### 4. Failure Mode Inventory Comprehensive

Producer documented 6 failure modes with accurate code locations:
1. `waitForRun` timeout (lines 269-277) - preserves session for fallback
2. `waitForRun` error (lines 280-288) - same recovery as timeout
3. `getSessionMessages` failure (lines 376-378) - `finalized=false` prevents deletion
4. `deleteSession` failure (lines 384-389) - orphaned but marked complete
5. Concurrent spawn (line 156) - blocked by `sessionLocks` + `isActive()` check
6. Double-finalize (lines 306-310) - prevented by `completedSessions` Map with 5-min TTL

### 5. Contract Deliverables Verified

All 4 deliverables have convincing evidence:
- **transport_audit**: DONE - Full comparison of current vs target implementations
- **lifecycle_hook_map**: DONE - All hooks documented with file locations
- **openclaw_assumptions_documented**: DONE - Hook timing nuances documented (requires reviewer_b cross-repo verification)
- **failure_mode_inventory**: DONE - 6 failure modes with accurate line citations

### 6. Minor Observation: Idempotency Key Pattern Preserved

Both current and target implementations use the same idempotency key pattern:
- Current: `${sessionId}:${Date.now()}` (line 198)
- Target: `${options.parentSessionId}:${Date.now()}` (workflow-manager line 110)

This is intentionally NOT a session-based dedupe key - each spawn is unique. The producer correctly identified this as `empathy_lacks_dedupe_key: SUPPORTED`.

## TRANSPORT_ASSESSMENT

| Aspect | Current | Target |
|--------|---------|--------|
| Transport Type | runtime_direct | runtime_direct |
| Driver | Direct `api.runtime.subagent` | `RuntimeDirectDriver` wrapper |
| Persistence | In-memory Maps | SQLite via `WorkflowStore` |
| State Machine | None | pending→active→wait_result→finalizing→completed |
| Completion Primary | `waitForRun()` polling | `scheduleWaitPoll()` + `driver.wait()` |
| Completion Fallback | `subagent_ended` hook | Same (preserved) |
| TTL Cleanup | 5 min `isActive()` check | 5 min `sweepExpiredWorkflows()` |

**Assessment**: Transport mechanism is preserved; migration adds SQLite persistence and state machine for reliability.

## OPENCLAW_ASSUMPTION_REVIEW

### Assumption: `subagent_ended` hook timing with `expectsCompletionMessage: true`

**Status**: Documented but requires cross-repo verification

The producer correctly identified that when `expectsCompletionMessage: true` is set with `deliver: false`:
1. Subagent session persists after completion
2. `subagent_ended` hook fires when session is actually terminated
3. For empathy observer, `subagent_ended` is a fallback, not primary completion signal

**Reviewer Note**: This is an OpenClaw runtime behavior that requires `reviewer_b` to verify against OpenClaw source code (D:/Code/openclaw). The producer's analysis is consistent with the SDK type definitions but lacks direct OpenClaw source citation.

## NEXT_FOCUS

No additional investigation needed for this stage. Ready to proceed to design stage with:
1. SQLite-based persistence implementation details
2. State machine transition guards
3. Integration test coverage for failure modes

## CHECKS

CHECKS: criteria=met;blockers=0;verification=complete

## DIMENSIONS

DIMENSIONS: evidence_quality=5; assumption_coverage=4; transport_audit_completeness=5

### Dimension Rationale

- **evidence_quality (5/5)**: All code citations verified against source files; line numbers accurate; hypothesis matrix validated
- **assumption_coverage (4/5)**: OpenClaw hook timing documented but requires reviewer_b cross-repo verification for full confidence
- **transport_audit_completeness (5/5)**: Full comparison of current vs target with parameter-level detail; all transport paths documented

## CODE_EVIDENCE

```
files_verified: empathy-observer-manager.ts, empathy-observer-workflow-manager.ts, runtime-direct-driver.ts, workflow-store.ts, subagent.ts, index.ts
evidence_source: local
sha: 4138178581043646365326ee42dad4eab4037899
evidence_scope: principles
```
