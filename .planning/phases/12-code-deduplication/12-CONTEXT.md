# Phase 12: Code Deduplication - Context

**Gathered:** 2026-04-07
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — discuss skipped)

<domain>
## Phase Boundary

Reduce code duplication across WorkflowManagers (CLEAN-03) and unify duplicate type definitions (CLEAN-04).

**CLEAN-03: Extract WorkflowManager Base Class**
- EmpathyObserverWorkflowManager, DeepReflectWorkflowManager, and NocturnalWorkflowManager share ~70% code duplication (~1200 lines)
- Extract shared base class containing: workflow lifecycle, state transitions, and store operations
- The three specific managers extend the base class with their specific implementations

**CLEAN-04: Unify Duplicate Type Definitions**
- `PrincipleStatus` type: currently defined in multiple locations → single source in `core/evolution-types.ts`
- `PrincipleDetectorSpec` type: currently defined in multiple locations → single source location
- Update all references to use the unified types

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Use codebase analysis to determine:
- Exact shared methods to extract for the base class
- Migration strategy for extending classes
- Which type definitions to consolidate and where
- Order of operations to avoid breaking changes

</decisions>

<codebase>
## Existing Code Insights

From prior phases' context and codebase analysis:

### WorkflowManager Duplicate Pattern
The three WorkflowManager classes share:
- workflow lifecycle (start, pause, resume, complete, abort)
- state transition logic
- store operations (read/write stage_outputs, checkpoints)
- similar method signatures for `run()`, `executeWave()`, `checkpoint()`

### Duplicate Types
- `PrincipleStatus` likely in: `core/evolution-types.ts`, `service/evolution-worker.ts`, `service/trajectory.ts`
- `PrincipleDetectorSpec` similarly scattered

### Established Patterns from Prior Phases
- Phase 11 context exists — follow same file patterns for verification
- No specific UI or UX decisions needed — pure backend refactor

</codebase>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 12-code-deduplication*
*Context gathered: 2026-04-07 via auto-generated infrastructure context*
