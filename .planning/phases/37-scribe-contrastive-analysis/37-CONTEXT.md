---
phase: 37
status: ready-for-planning
---

# Phase 37: Scribe Contrastive Analysis - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning

<decisions>

## Implementation Decisions

### Output Structure
- **D-01:** Scribe generates `rejectedAnalysis` with whyRejected, warningSignals, correctiveThinking
- **D-02:** Scribe generates `chosenJustification` with whyChosen, keyInsights, limitations
- **D-03:** Scribe generates `contrastiveAnalysis` with criticalDifference, decisionTrigger, preventionStrategy

### Backward Compatibility
- **D-04:** All new fields are optional on TrinityDraftArtifact — pre-enhancement artifacts export unchanged
- **D-05:** Existing tournament scoring in nocturnal-candidate-scoring.ts is OFF-LIMITS (PHILO-03)

### Scope Constraints
- **D-06:** No changes to existing Scribe prompt or tournament selection logic (only output structure)
- **D-07:** Real Scribe adapter only — stub Scribe unchanged (per roadmap)

</decisions>

<canonical_refs>

## Canonical References

### Design Spec
- `docs/plans/2026-04-12-trinity-quality-enhancement-design.md` §B2 — Scribe contrastive analysis design

### Requirements
- `.planning/REQUIREMENTS.md` — SCRIBE-01, SCRIBE-02, SCRIBE-03, SCRIBE-04

### Prior Phase Context
- `.planning/phases/36-philosopher-6d-evaluation/36-CONTEXT.md` — Philosopher 6D output (scores, risks) available for Scribe consumption
- `.planning/phases/35-dreamer-enhancement/35-CONTEXT.md` — Dreamer strategic perspectives

</canonical_refs>

<codebase_context>

## Existing Code Insights

### Integration Points
- `TrinityDraftArtifact` interface (nocturnal-trinity.ts) — add optional contrastiveAnalysis field
- Real Scribe adapter path (runTrinityAsync) — produce contrastive analysis after tournament selection
- `nocturnal-candidate-scoring.ts` — OFF-LIMITS per PHILO-03

### Reusable Patterns
- Existing Scribe prompt builder pattern from buildScribePrompt()
- Philosopher 6D scores/risk assessment from Phase 36 (available but not required for contrastive analysis)

</codebase_context>

<specifics>

## Requirements (from ROADMAP.md)

**Phase 37 Goal:** Scribe produces contrastive analysis that distinguishes chosen vs rejected reasoning paths, enabling richer training signals

**Depends on:** Phase 34 (decision points), Phase 36 (6D judgments inform contrastive depth)

**SCRIBE-01:** Scribe generates rejectedAnalysis with whyRejected, warningSignals, correctiveThinking
**SCRIBE-02:** Scribe generates chosenJustification with whyChosen, keyInsights, limitations
**SCRIBE-03:** Scribe generates contrastiveAnalysis with criticalDifference, decisionTrigger, preventionStrategy
**SCRIBE-04:** All new fields optional — backward compatible

</specifics>

<deferred>

## Deferred Ideas

None — Phase 37 scope is self-contained.

</deferred>
