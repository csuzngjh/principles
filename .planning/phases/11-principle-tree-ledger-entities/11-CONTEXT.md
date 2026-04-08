# Phase 11: Principle Tree Ledger Entities - Context

**Gathered:** 2026-04-07 (auto mode)
**Status:** Ready for planning

<domain>
## Phase Boundary

Make `Rule` and `Implementation` first-class records in the principle-tree ledger so `Principle -> Rule -> Implementation` becomes real persisted structure rather than schema-only design. This phase does not add runtime Rule Host behavior, replay promotion, or nocturnal code-artifact generation.

</domain>

<decisions>
## Implementation Decisions

### Ledger authority and storage shape
- **D-01:** Phase 11 will treat the principle tree as the semantic source of truth and persist `Rule` and `Implementation` alongside `Principle`, rather than introducing a separate parallel ledger for code implementations.
- **D-02:** The first persistence target should extend the existing `.state/principle_training_state.json` / principle-tree store path already implied by [`packages/openclaw-plugin/src/core/principle-training-state.ts`](/D:/Code/principles/packages/openclaw-plugin/src/core/principle-training-state.ts) and [`packages/openclaw-plugin/src/types/principle-tree-schema.ts`](/D:/Code/principles/packages/openclaw-plugin/src/types/principle-tree-schema.ts), instead of inventing a new top-level state file in this phase.
- **D-03:** `Rule` remains the semantic trunk and `Implementation` remains the leaf. This phase must not collapse them into a single script-oriented record.

### Scope and migration constraints
- **D-04:** Phase 11 is ledger-only. It must not wire `Rule Host`, replay evaluation, promotion automation, or nocturnal code artifact flow. Those belong to later phases.
- **D-05:** Existing `EvolutionReducer` principle lifecycle behavior stays in place for this phase. The ledger work should integrate without forcing a broad refactor of candidate/probation/active principle flows.
- **D-06:** Migration must preserve existing principle training state and avoid breaking any code that already reads `.state/principle_training_state.json`.

### Service boundaries
- **D-07:** Ledger CRUD should follow the repo's existing service/store pattern: small core persistence module plus access through workspace-scoped services rather than ad hoc file writes from hooks.
- **D-08:** `WorkspaceContext` should become the main integration point for future principle-tree ledger access, because it already centralizes workspace-specific services and path resolution.
- **D-09:** File writes for the ledger must continue to use the project's existing lock discipline (`withLock` / `withLockAsync`) to avoid corrupting shared state.

### Data model expectations
- **D-10:** A single `Principle` may reference multiple `Rule` records, and a single `Rule` may reference multiple `Implementation` records. This multiplicity is a hard requirement in Phase 11, not a later enhancement.
- **D-11:** `Implementation(type=code)` is only one implementation form. Phase 11 must keep the schema open for `skill`, `prompt`, `lora`, and `test` implementations even if only code-oriented work is planned later.
- **D-12:** The existing schema fields in `principle-tree-schema.ts` are the starting contract, but planner/researcher may refine storage shape if needed so long as the Principle/Rule/Implementation hierarchy remains explicit and queryable.

### the agent's Discretion
- Exact repository/module naming for the ledger store layer
- Whether CRUD is exposed as one service or split into focused repositories
- Whether migration is implemented as in-place upgrade or read-with-defaults plus write-back

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone framing
- `docs/design/2026-04-07-principle-internalization-system.md` - top-level Principle Internalization System framing and phase boundaries
- `docs/design/2026-04-07-principle-internalization-roadmap.md` - technical milestone mapping and `M1`/Phase 11 intent
- `docs/design/2026-04-06-dynamic-harness-evolution-engine.md` - confirms DHSE is not the Phase 11 center of gravity

### Principle tree semantics
- `docs/architecture-governance/PRINCIPLE-TREE-ARCHITECTURE.md` - canonical Principle/Rule/Implementation hierarchy
- `packages/openclaw-plugin/src/types/principle-tree-schema.ts` - current schema contract for `Principle`, `Rule`, `Implementation`, and `PrincipleTreeStore`

### Existing persistence and lifecycle code
- `packages/openclaw-plugin/src/core/principle-training-state.ts` - current state-store pattern and migration defaults around `principle_training_state.json`
- `packages/openclaw-plugin/src/core/evolution-reducer.ts` - current principle lifecycle behavior that must not be broken by ledger entity work
- `packages/openclaw-plugin/src/core/workspace-context.ts` - workspace-scoped service integration point
- `packages/openclaw-plugin/src/core/paths.ts` - canonical PD path definitions and state file placement rules

### GSD planning source of truth
- `.planning/PROJECT.md` - milestone framing, constraints, and key decisions
- `.planning/REQUIREMENTS.md` - `TREE-01` through `TREE-04`
- `.planning/ROADMAP.md` - Phase 11 goal and success criteria
- `.planning/STATE.md` - current milestone state and immediate next-step context

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/openclaw-plugin/src/types/principle-tree-schema.ts`: already defines the intended ledger entities and top-level store shape
- `packages/openclaw-plugin/src/core/principle-training-state.ts`: already implements locked JSON persistence, migration defaults, and single-principle update helpers
- `packages/openclaw-plugin/src/core/workspace-context.ts`: already provides workspace-scoped lazy service access and is the natural place to expose a future ledger service
- `packages/openclaw-plugin/src/core/paths.ts`: already defines canonical state-file locations and should remain the only path-resolution authority

### Established Patterns
- State persistence is file-based, JSON-backed, and protected with `withLock` / `withLockAsync`
- Workspace-scoped stateful modules use singleton/factory access through service wrappers or `WorkspaceContext`
- Path access should go through PD path helpers instead of hardcoded workspace-relative strings
- Existing principle lifecycle logic is reducer/event driven; Phase 11 should attach ledger persistence without rewriting that lifecycle yet

### Integration Points
- Future ledger reads should be reachable from `WorkspaceContext`
- Existing pain/evolution/nocturnal code that already depends on principles will later consume the new Rule/Implementation entities
- Phase 12 can build `Rule Host` on top of the persisted `Implementation(type=code)` entities introduced here

</code_context>

<specifics>
## Specific Ideas

- The phase should feel like “making the principle tree real,” not “starting runtime code execution early.”
- The main success condition is queryable structure, not UI or automation.
- Preserving semantic separation between Principle, Rule, and Implementation is non-negotiable.

</specifics>

<deferred>
## Deferred Ideas

- Runtime `Rule Host` integration - Phase 12
- Versioned code implementation asset layout and manifests - Phase 12
- Replay evaluation and manual promotion loop - Phase 13
- Nocturnal `RuleImplementationArtifact` generation - Phase 14
- Coverage, adherence, and internalization routing - Phase 15

</deferred>

---

*Phase: 11-principle-tree-ledger-entities*
*Context gathered: 2026-04-07*
