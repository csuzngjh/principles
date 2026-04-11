# Phase 29: Integration Verification - Context

**Gathered:** 2026-04-11
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — verification criteria are all technical)

<domain>
## Phase Boundary

Verify the refactored worker passes all integration checks — end-to-end flow works, public API unchanged, no resource leaks.

**Success Criteria:**
1. All existing tests pass after full decomposition without modification to test expectations
2. Worker service public API is unchanged — external callers (hooks, commands, HTTP routes) are unaffected
3. Nocturnal pipeline end-to-end flow (pain -> queue -> nocturnal -> replay) runs correctly through refactored modules
4. Worker startup/shutdown lifecycle preserves correctness — no hanging resources or leaked locks

**Requirements:** INTEG-01, INTEG-02, INTEG-03, INTEG-04

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All verification approaches are at Claude's discretion — pure infrastructure phase. Use existing test infrastructure, standard integration testing patterns, and the codebase's established verification conventions.

</decisions>

<code_context>
## Existing Code Insights

### Integration Points
- TaskContextBuilder: buildCycleContext(wctx, logger, eventLog) → CycleContextResult
- SessionTracker: init(stateDir), flush() — wraps module-level functions
- FallbackAudit: FALLBACK_AUDIT registry with 16 classified fallbacks
- EventLog: recordSkip/recordDrop methods for fail-visible diagnostics
- evolution-worker.ts: lifecycle-only (start/stop/runCycle), delegates to extracted modules

### Test Infrastructure
- Evolution worker tests: packages/openclaw-plugin/tests/service/evolution-worker.test.ts
- Existing integration test patterns should be preserved

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard integration verification approaches.

</specifics>

<deferred>
## Deferred Ideas

None — infrastructure phase.

</deferred>
