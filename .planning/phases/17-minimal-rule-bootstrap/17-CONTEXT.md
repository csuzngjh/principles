# Phase 17: Minimal Rule Bootstrap - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase)

<domain>
## Phase Boundary

Create a small, reviewable set of live rules so the principle-internalization runtime has real objects to work with.

This phase seeds 1-3 explicit `Rule` entities into production-like state to unblock the code implementation branch.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Use ROADMAP phase goal, success criteria, and codebase conventions to guide decisions.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` — Ledger read/write functions, `PrincipleTreeStore` schema
- `packages/openclaw-plugin/src/core/rule-host-types.ts` — `RuleHostInput`, `RuleHostDecision` contracts
- `packages/openclaw-plugin/src/core/rule-host.ts` — Rule Host execution environment
- `packages/openclaw-plugin/src/core/dictionary.ts` — `PainRule` type definitions

### Established Patterns
- State files stored in `~/.openclaw/workspace-main/.state/principle_training_state.json`
- Current production state: 74 principles, 0 rules, 0 implementations
- Principles use format `P_XXX`, rules use format `R_XXX`
- Ledger tree structure: `PrincipleTreeStore` with `principles: Record<string, Principle>` and `rules: Record<string, Rule>`

### Integration Points
- `principle-tree-ledger.ts` exports `withLock()` for safe state file mutations
- `principle_training_state.json` is the source of truth for production state
- Rule-to-principle linkage via `principleId` field in `Rule` interface
- Principle-to-rule linkage via `ruleIds: string[]` field in `Principle` interface

</code_context>

<specifics>
## Specific Ideas

No specific requirements — infrastructure phase. Refer to ROADMAP phase description and success criteria:
- Production-like state contains at least 1-3 explicit `Rule` entities
- At least one principle has valid `ruleIds` linkage
- Bootstrap scope is documented and intentionally narrow

</specifics>

<deferred>
## Deferred Ideas

None — infrastructure phase.

</deferred>

---
*Phase: 17-minimal-rule-bootstrap*
*Context gathered: 2026-04-10 via infrastructure detection*
