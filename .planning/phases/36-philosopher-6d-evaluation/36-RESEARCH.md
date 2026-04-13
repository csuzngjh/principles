# Phase 36: Philosopher 6D Evaluation — Research

**Researched:** 2026-04-13
**Status:** Complete

## Current State

### NOCTURNAL_PHILOSOPHER_PROMPT (lines 175–252)
- 78-line system prompt with 4 scoring dimensions
- Current weights: Principle Alignment (0.35), Specificity (0.25), Actionability (0.25), Executability (0.15)
- Output JSON format expects: `valid`, `judgments[]` (with candidateIndex, critique, principleAligned, score, rank), `overallAssessment`, `generatedAt`
- No `scores` or `risks` objects in current output schema

### PhilosopherJudgment interface (lines 1373–1384)
```typescript
export interface PhilosopherJudgment {
  candidateIndex: number;
  critique: string;
  principleAligned: boolean;
  score: number;
  rank: number;
}
```
- 5 flat fields, no nested objects
- Consumed by: `parsePhilosopherOutput()`, tournament scoring via `scoreCandidate()`, Scribe prompt builder

### buildPhilosopherPrompt() (lines 908–979)
- Receives: `dreamerOutput: DreamerOutput`, `principleId: string`, `snapshot: NocturnalSessionSnapshot`
- Builds sections: Target Principle, Session Violation Summary (failures, pains, blocks, userCues), Dreamer's Candidates, Task instructions
- Candidates JSON passed via `JSON.stringify(dreamerOutput.candidates, null, 2)`
- **Key observation:** Does NOT currently pass Dreamer's `riskLevel` or `strategicPerspective` per candidate to Philosopher — this is required by D-08

### parsePhilosopherOutput() (lines 1120–1168)
- Uses `extractJson()` to get JSON string, then `JSON.parse()`
- Validates `valid` (boolean) and `judgments` (array) presence
- Returns `PhilosopherOutput` with parsed fields
- **Key observation:** Passes `parsed.judgments` as-is — new optional fields on judgment objects will flow through automatically (JSON.parse preserves unknown keys)

### invokeStubPhilosopher() (lines 1652–1721)
- Heuristic scoring: rationale length, actionable verbs, generic pattern detection
- Produces `PhilosopherJudgment[]` with candidateIndex, critique, principleAligned, score, rank
- **Key observation:** Needs update per D-09 to produce deterministic 6D scores + risks per candidate type

### DreamerCandidate interface (lines 1341–1355)
- Already has optional `riskLevel` and `strategicPerspective` from Phase 35
- Philosopher receives DreamerOutput.candidates which includes these fields

### TrinityTelemetry interface (lines 1428–1455)
- Already has `diversityCheckPassed?: boolean` and `candidateRiskLevels?: string[]` from Phase 35
- Needs new optional `philosopher6D` field per D-11

## Validation Architecture

### Dimension Coverage

| Dimension | Weight | How to Verify |
|-----------|--------|---------------|
| Principle Alignment | 0.20 | Prompt text contains exact weight, test checks prompt string |
| Specificity | 0.15 | Prompt text contains exact weight |
| Actionability | 0.15 | Prompt text contains exact weight |
| Executability | 0.15 | Prompt text contains exact weight (unchanged criteria) |
| Safety Impact | 0.20 | Prompt text contains new dimension + guidance |
| UX Impact | 0.15 | Prompt text contains new dimension + guidance |
| **Total** | **1.00** | Sum of weights equals 1.0 |

### Risk Assessment Coverage

| Field | Type | How to Verify |
|-------|------|---------------|
| falsePositiveEstimate | 0–1 float | Interface has field, stub produces value in [0,1] |
| implementationComplexity | "low"\|"medium"\|"high" | Interface has field, stub produces valid enum |
| breakingChangeRisk | boolean | Interface has field, stub produces boolean |

### Backward Compatibility

| Constraint | How to Verify |
|------------|---------------|
| New fields are optional (`?`) | TypeScript compiles without `?` removal |
| `scoreCandidate()` unchanged | No diff in nocturnal-candidate-scoring.ts |
| `DEFAULT_SCORING_WEIGHTS` unchanged | No diff in nocturnal-candidate-scoring.ts |
| Existing tests pass | `vitest run` passes without modification |
| Pre-enhancement PhilosopherJudgment works | Old-style objects accepted by consuming code |

### Integration Points

| Consumer | Impact | Risk |
|----------|--------|------|
| `scoreCandidate()` in nocturnal-candidate-scoring.ts | None — new fields ignored | Low |
| Scribe prompt builder (Phase 37) | Will use `scores` and `risks` later | Low — optional fields |
| TrinityTelemetry | New optional `philosopher6D` field | Low |
| `parsePhilosopherOutput()` | Auto-passes new JSON keys via JSON.parse | Low |
| Stub pipeline (`invokeStubPhilosopher`) | Must produce new fields | Medium — stub logic changes |

## Key Findings

1. **parsePhilosopherOutput needs targeted update** — It passes `parsed.judgments` as-is which preserves unknown keys, but the PhilosopherOutput interface itself doesn't expose the new fields. The parsed judgments need to map through the optional `scores` and `risks` fields.

2. **buildPhilosopherPrompt must inject Dreamer metadata** — Per D-08, needs to include each candidate's `riskLevel` and `strategicPerspective` from Phase 35. Currently only passes raw candidates JSON.

3. **Prompt rewrite is significant but bounded** — The evaluation criteria section (lines 221–241) needs full rewrite from 4D to 6D with new dimension descriptions and weight rebalancing. Output format example (lines 204–219) needs `scores` and `risks` objects added.

4. **Stub update is straightforward** — Deterministic mapping from Phase 35 D-07 (gateBlocks→conservative_fix, pain→structural_improvement, failures→paradigm_shift) already exists. Extend to produce 6D scores and risk assessments per candidate type.

5. **Nocturnal-candidate-scoring.ts is off-limits** — PHILO-03 explicitly protects tournament scoring. All changes stay in nocturnal-trinity.ts.

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| LLM ignores new dimensions in prompt | Medium | Test with real adapter validates output structure |
| Prompt becomes too long | Low | Current prompt is 78 lines, adding ~30 lines is acceptable |
| Stub 6D scores don't exercise edge cases | Low | Use Phase 35 D-07 mapping to create realistic distributions |
| parsePhilosopherOutput drops new fields | Medium | Explicit mapping of optional fields, not just pass-through |

## RESEARCH COMPLETE
