# Phase 41: Startup Reconciliation - Context

**Gathered:** 2026-04-15
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — discuss skipped)

<domain>
## Phase Boundary

Validate state integrity, clear stale cooldowns, and clean orphan files on nocturnal pipeline startup. Depends on Phase 40 (Failure Classification provides cooldown state to reconcile). The pipeline must enter a clean state before the first heartbeat cycle.

Success Criteria:
1. Startup validation checks integrity of all nocturnal state files
2. Stale/expired cooldowns cleared automatically on startup
3. Orphan .tmp files cleaned up on startup
4. Pipeline enters clean state before first heartbeat cycle

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Use ROADMAP phase goal, success criteria, and codebase conventions to guide decisions.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `nocturnal-runtime.ts`: readState/readStateSync/writeState for state file access
- `cooldown-strategy.ts` (Phase 40): isTaskKindInCooldown for checking cooldown expiry
- `atomic-write.ts` (Phase 38): tmp+fsync+rename with orphan cleanup support
- `evolution-worker.ts`: heartbeat cycle entry point where reconciliation should run

### Established Patterns
- State files stored in `{stateDir}/` (nocturnal-runtime.json, evolution-queue.json, etc.)
- Atomic writes use `.tmp` suffix — orphan `.tmp` files may accumulate from crashes
- Cooldown escalation tiers stored in `taskFailureState` with `cooldownUntil` ISO strings

### Integration Points
- Reconciliation runs at heartbeat startup, before any task processing
- Must be callable from the main heartbeat cycle in evolution-worker.ts

</code_context>

<specifics>
## Specific Ideas

No specific requirements — infrastructure phase. Refer to ROADMAP phase description and success criteria.

</specifics>

<deferred>
## Deferred Ideas

None — infrastructure phase.
</deferred>
