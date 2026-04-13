# Phase 36: Philosopher 6D Evaluation - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Expand Philosopher stage from 4-dimension to 6-dimension candidate evaluation with calibrated weights, add per-candidate risk assessment (falsePositiveEstimate, implementationComplexity, breakingChangeRisk), and wire new fields backward-compatibly into the Trinity pipeline. Covers PHILO-01, PHILO-02, PHILO-03.

</domain>

<decisions>
## Implementation Decisions

### 6D Scoring Strategy
- **D-01:** New 6D scores from Philosopher are informational only — stored in optional `scores` field on PhilosopherJudgment. Existing tournament scoring in `scoreCandidate()` / `DEFAULT_SCORING_WEIGHTS` continues unchanged (PHILO-03)
- **D-02:** 6D weights are for the LLM prompt evaluation criteria, not for tournament ranking. The prompt asks the LLM to evaluate each dimension and return per-dimension scores + overall score
- **D-03:** Weights per PHILO-01: Principle Alignment (0.20), Specificity (0.15), Actionability (0.15), Executability (0.15), Safety Impact (0.20), UX Impact (0.15)

### Risk Assessment
- **D-04:** Per PHILO-02: each candidate judgment gets optional `risks` with falsePositiveEstimate (0-1 float), implementationComplexity ("low"|"medium"|"high"), breakingChangeRisk (boolean)
- **D-05:** Risk fields are for Scribe consumption (Phase 37) and telemetry — they do not affect tournament ranking or candidate selection

### Philosopher Prompt Extension
- **D-06:** Extend NOCTURNAL_PHILOSOPHER_PROMPT to add Safety Impact and UX Impact as new evaluation criteria with specific guidance on what to evaluate
- **D-07:** Update the JSON output format example to include the new `scores` and `risks` objects per candidate
- **D-08:** Update buildPhilosopherPrompt() to include Dreamer's riskLevel and strategicPerspective per candidate so Philosopher can evaluate strategic alignment

### Stub Philosopher Updates
- **D-09:** Update invokeStubPhilosopher to produce deterministic 6D scores and risk assessments per stub candidate type:
  - conservative_fix candidates: high principleAlignment, low safetyImpact risk, low implementationComplexity
  - structural_improvement candidates: medium across all dimensions, medium implementationComplexity
  - paradigm_shift candidates: high innovation but higher breakingChangeRisk, high implementationComplexity

### Integration Points
- **D-10:** PhilosopherJudgment interface gains optional `scores` and `risks` fields — existing code without these fields continues working
- **D-11:** TrinityTelemetry gains optional `philosopher6D` field with aggregate 6D score breakdown (informational)
- **D-12:** parsePhilosopherOutput() updated to extract new optional fields from LLM JSON response (pass-through, no validation of scores range)

### Claude's Discretion
- Exact wording for Safety Impact and UX Impact evaluation criteria in prompt
- How to present 6D scores in telemetry (flat fields vs nested object)
- How stub Philosopher computes deterministic 6D scores
- Whether buildPhilosopherPrompt needs to pass riskLevel/strategicPerspective per candidate or if Philosopher infers from content
- Test structure and naming conventions

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design Specification
- `docs/plans/2026-04-12-trinity-quality-enhancement-design.md` — Full technical spec for Phase B (Philosopher 6D + Scribe contrastive)
- `docs/plans/2026-04-12-trinity-quality-enhancement-design.md` §B — Philosopher 6D evaluation: dimension weights, risk assessment, interface changes

### Requirements Traceability
- `.planning/REQUIREMENTS.md` — PHILO-01 to PHILO-03 acceptance criteria

### Prior Phase Context
- `.planning/phases/35-dreamer-enhancement/35-CONTEXT.md` — Phase 35 decisions: D-07 stub mapping (riskLevel/strategicPerspective), soft enforcement pattern, telemetry patterns

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `nocturnal-trinity.ts` → `NOCTURNAL_PHILOSOPHER_PROMPT` (lines 175-252): Current 78-line system prompt to extend with 2 new dimensions
- `nocturnal-trinity.ts` → `PhilosopherJudgment` interface (lines 1373-1384): Add optional `scores` and `risks` fields
- `nocturnal-trinity.ts` → `buildPhilosopherPrompt()` (lines 908-979): Pass Dreamer's candidate riskLevel/strategicPerspective to Philosopher
- `nocturnal-trinity.ts` → `invokeStubPhilosopher()` (lines 1652-1721): Update heuristic scoring to produce 6D scores + risks
- `nocturnal-trinity.ts` → `parsePhilosopherOutput()`: Extract new optional fields from LLM response
- `nocturnal-candidate-scoring.ts` → `DEFAULT_SCORING_WEIGHTS`: DO NOT MODIFY — existing tournament scoring unchanged per PHILO-03
- `nocturnal-candidate-scoring.ts` → `scoreCandidate()`: DO NOT MODIFY — backward compatibility requirement

### Established Patterns
- Optional fields on interfaces for backward compatibility (`?` suffix)
- Embedded prompt constants at file top, builder methods in adapter class
- Pure functions with graceful edge case handling
- Stub candidates use deterministic mapping from Phase 35 D-07
- Telemetry fields are optional and informational

### Integration Points
- Philosopher receives DreamerOutput (which now includes riskLevel/strategicPerspective per candidate from Phase 35)
- PhilosopherJudgment consumed by tournament scoring (scoreCandidate) — new fields must not break this
- PhilosopherJudgment consumed by Scribe (Phase 37) — new 6D scores and risks feed into contrastive analysis
- TrinityTelemetry captures Philosopher results for observability

</code_context>

<specifics>
## Specific Ideas

- Design doc specifies exact 6D weight distribution — follow it precisely
- Design doc specifies exact PhilosopherRiskAssessment interface — follow it precisely
- New dimensions (Safety Impact, UX Impact) evaluation criteria should be clear and actionable for the LLM
- Stub 6D scores should produce realistic distributions that test different diversity scenarios

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 36-philosopher-6d-evaluation*
*Context gathered: 2026-04-13*
