# Phase 34: Reasoning Deriver Module - Context

**Gathered:** 2026-04-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Build a leaf module `nocturnal-reasoning-deriver.ts` that derives structured reasoning signals (reasoning chain, decision points, contextual factors) from existing snapshot data (assistantTurns, toolCalls, userTurns) without any snapshot schema changes. Three pure functions: `deriveReasoningChain()`, `deriveDecisionPoints()`, `deriveContextualFactors()`.

</domain>

<decisions>
## Implementation Decisions

### Edge Cases & Thresholds
- Confidence signal thresholds: high > 0.6, medium 0.3-0.6, low < 0.3 — consistent with `computeThinkingModelActivation` existing thresholds
- Empty input handling: return empty arrays / default values (DerivedContextualFactors all false/zero) — never throw exceptions
- Module location: `packages/openclaw-plugin/src/core/nocturnal-reasoning-deriver.ts` — alongside all other nocturnal-*.ts modules
- Type exports: interfaces defined inline in same file — matches existing pattern (e.g., `nocturnal-candidate-scoring.ts`)

### Claude's Discretion
- Exact regex pattern refinements for uncertainty markers
- Confidence signal computation algorithm details
- Helper function decomposition within the module

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `nocturnal-trajectory-extractor.ts`: `computeThinkingModelActivation()` — existing regex-based thinking model analysis precedent
- `nocturnal-trajectory-extractor.ts`: `NocturnalAssistantTurn`, `NocturnalToolCall`, `NocturnalUserTurn`, `NocturnalSessionSnapshot` types
- `nocturnal-candidate-scoring.ts`: pattern for inline interface definitions with pure functions

### Established Patterns
- All nocturnal modules in `packages/openclaw-plugin/src/core/` follow `nocturnal-*.ts` naming
- Pure functions with no side effects, no external dependencies
- Graceful edge case handling (return defaults, never throw on empty input)
- Regex-based text analysis for thinking model patterns

### Integration Points
- Dreamer prompt builder (Phase 35) will consume `deriveReasoningChain()` and `deriveContextualFactors()`
- Scribe prompt builder (Phase 37) will consume `deriveDecisionPoints()`
- No integration with service layer — called from Trinity stage builders only

</code_context>

<specifics>
## Specific Ideas

Design doc at `docs/plans/2026-04-12-trinity-quality-enhancement-design.md` contains exact interface definitions and algorithm specifications. Follow those specifications precisely.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>
