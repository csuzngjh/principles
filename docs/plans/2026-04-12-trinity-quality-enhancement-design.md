# Nocturnal Trinity Training Trajectory Quality Enhancement

Date: 2026-04-12
Status: Approved
Phases: A (P0), B (P1), C (P2 deferred)

## Problem Statement

The Nocturnal Trinity pipeline generates behavioral training artifacts (ORPO samples) from session trajectories. Four quality gaps limit training value:

1. **Context sparsity** — Snapshots contain assistant turns and tool calls but no structured reasoning signals (uncertainty markers, confidence levels, decision points)
2. **Candidate homogeneity** — Dreamer generates candidates without strategic perspective constraints, producing substantively similar alternatives
3. **Evaluation gaps** — Philosopher lacks safety and UX evaluation dimensions; no risk assessment
4. **Contrastive depth** — Scribe produces `badDecision`/`betterDecision` pairs without explaining *why* the bad decision was wrong or *when* the correct decision applies

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Snapshot strategy | Runtime derivation, no schema changes | Backward compatible; existing `sanitizedText` + `toolCalls` are sufficient source data |
| Dreamer diversity enforcement | Prompt constraints + soft post-validation | Single LLM call preserved; candidates flagged not discarded on diversity failure |
| Contrastive analysis storage | Artifact fields + ORPO export integration | Maximizes training value; backward compatible via optional fields |
| Philosopher evaluation | Expand 4→6 dimensions | Add safety (0.20) + UX (0.15); scale existing dimensions proportionally |

## Phase A (P0): Foundation

### A1: Dreamer Candidate Diversity

**File:** `nocturnal-trinity.ts` — `NOCTURNAL_DREAMER_PROMPT`

Add strategic perspective requirements to Dreamer prompt:

```
## Strategic Perspective Requirements

Generate candidates from DISTINCT strategic perspectives:

- **conservative_fix**: Minimal deviation from original approach. Add a
  verification or validation step that was missing.
- **structural_improvement**: Reorder operations or introduce an intermediate
  checkpoint. Change HOW the goal is achieved.
- **paradigm_shift**: Challenge whether the original goal was correct.
  Consider a fundamentally different approach.

Each candidate MUST specify `riskLevel` ("low"|"medium"|"high") and
`strategicPerspective` matching one of the above.

ANTI-PATTERN: Candidates that differ only in wording, not in substance,
will be rejected.
```

Extend `DreamerCandidate` interface (optional fields for backward compat):

```typescript
interface DreamerCandidate {
  candidateIndex: number;
  badDecision: string;
  betterDecision: string;
  rationale: string;
  confidence: number;
  // New optional fields
  riskLevel?: "low" | "medium" | "high";
  strategicPerspective?: "conservative_fix" | "structural_improvement" | "paradigm_shift";
}
```

**File:** `nocturnal-candidate-scoring.ts`

Add `validateCandidateDiversity(candidates)`:

- Check `riskLevel` diversity: `Set(candidate.riskLevel).size >= 2` when candidates >= 2
- Check `betterDecision` keyword overlap: reject if similarity > 0.8 between any pair
- Keyword overlap = intersection / max(|A|, |B|) for words > 3 chars
- Result: soft enforcement — log warning + set telemetry flag, don't discard candidates

### A2: Runtime Reasoning Derivation

**New file:** `nocturnal-reasoning-deriver.ts`

Three pure functions that derive structured signals from existing snapshot data:

#### `deriveReasoningChain(assistantTurns: NocturnalAssistantTurn[]): DerivedReasoningSignal[]`

For each assistant turn:
- Extract `<thinking>` tag content (if present in `sanitizedText`)
- Detect uncertainty markers via patterns: `/let me (check|verify|confirm|understand)/gi`, `/I should (first|probably|maybe)/gi`, `/not sure (if|whether|about)/gi`
- Compute `confidenceSignal`: 'high' | 'medium' | 'low' based on ratio of planning language to execution language

```typescript
interface DerivedReasoningSignal {
  turnIndex: number;
  thinkingContent: string;
  uncertaintyMarkers: string[];
  confidenceSignal: "high" | "medium" | "low";
}
```

#### `deriveDecisionPoints(assistantTurns: NocturnalAssistantTurn[], toolCalls: NocturnalToolCall[]): DerivedDecisionPoint[]`

For each tool call:
- Find the assistant turn immediately before the tool call — extract last 500 chars as `beforeContext`
- If `toolCall.outcome === 'failure'`: find next assistant turn, extract first 300 chars as `afterReflection`
- Compute `confidenceDelta`: difference in confidence signal between before and after turns

```typescript
interface DerivedDecisionPoint {
  toolName: string;
  outcome: "success" | "failure" | "blocked";
  beforeContext: string;
  afterReflection?: string;
  confidenceDelta?: number;
}
```

#### `deriveContextualFactors(snapshot: NocturnalSessionSnapshot): DerivedContextualFactors`

```typescript
interface DerivedContextualFactors {
  fileStructureKnown: boolean;      // any Read before any Write?
  errorHistoryPresent: boolean;     // any prior failed toolCalls?
  userGuidanceAvailable: boolean;   // any userTurn with correctionDetected: true?
  timePressure: boolean;            // >50% of consecutive toolCalls < 2s apart?
}
```

**Integration points:**
- `buildDreamerPrompt()` receives derived signals, injects into "Session Context" section
- `buildScribePrompt()` receives `decisionPoints` for contrastive analysis (Phase B)

## Phase B (P1): Depth

### B1: Philosopher 6-Dimension Evaluation

**File:** `nocturnal-trinity.ts` — `NOCTURNAL_PHILOSOPHER_PROMPT`

Expand scoring from 4 to 6 dimensions:

| Dimension | Old Weight | New Weight | Description |
|-----------|-----------|------------|-------------|
| Principle Alignment | 0.35 | 0.20 | Unchanged criteria |
| Specificity | 0.25 | 0.15 | Unchanged criteria |
| Actionability | 0.25 | 0.15 | Unchanged criteria |
| Executability | 0.15 | 0.15 | Unchanged criteria (Arbiter gate) |
| Safety Impact | — | 0.20 | **New**: Reduces data loss/corruption risk? Avoids new failure modes? |
| UX Impact | — | 0.15 | **New**: Reduces user frustration? Improves response reliability? |

Add risk assessment block to Philosopher output:

```typescript
interface PhilosopherRiskAssessment {
  falsePositiveEstimate: number;  // 0-1
  implementationComplexity: "low" | "medium" | "high";
  breakingChangeRisk: boolean;
}
```

`PhilosopherJudgment` interface gains optional fields:
```typescript
interface PhilosopherJudgment {
  candidateIndex: number;
  critique: string;
  principleAligned: boolean;
  score: number;
  rank: number;
  // New optional fields
  scores?: {
    principleAlignment: number;
    specificity: number;
    actionability: number;
    executability: number;
    safetyImpact: number;
    uxImpact: number;
  };
  risks?: PhilosopherRiskAssessment;
}
```

Backward compatible: existing tournament scoring in `nocturnal-candidate-scoring.ts` continues to work — new dimensions exist only in Philosopher output for Scribe consumption.

### B2: Scribe Contrastive Analysis + ORPO Integration

**File:** `nocturnal-trinity.ts` — `NOCTURNAL_SCRIBE_PROMPT`

Add contrastive analysis requirement section:

```
## Contrastive Analysis Requirements

After selecting the rank-1 candidate, provide:

### rejectedAnalysis
- whyRejected: What mental model led to the bad decision?
- warningSignals: Observable signals that should trigger caution
- correctiveThinking: The correct reasoning path

### chosenJustification
- whyChosen: What principle does the better decision embody?
- keyInsights: 1-3 transferable insights
- limitations: When this approach might not apply

### contrastiveAnalysis
- criticalDifference: The ONE key insight separating good from bad
- decisionTrigger: "When X, do Y" pattern
- preventionStrategy: Systematic way to avoid this mistake
```

New interface:

```typescript
interface ContrastiveAnalysis {
  rejectedAnalysis: {
    whyRejected: string;
    warningSignals: string[];
    correctiveThinking: string;
  };
  chosenJustification: {
    whyChosen: string;
    keyInsights: string[];
    limitations: string[];
  };
  contrastiveAnalysis: {
    criticalDifference: string;
    decisionTrigger: string;
    preventionStrategy: string;
  };
}
```

`TrinityDraftArtifact` gains optional `contrastiveAnalysis?: ContrastiveAnalysis`.

**File:** `nocturnal-export.ts` — ORPO export enhancement

Enhance `buildEvidenceBoundedRejected()`, `buildEvidenceBoundedRationale()`, and `buildEvidenceBoundedChosen()` to incorporate contrastive analysis when available:

- `prompt`: Enhanced with `decisionTrigger` pattern ("When encountering `[signal]`, do not `[badDecision]`")
- `chosen`: Enhanced with `keyInsights` (`betterDecision` + "Key: `[insight]`")
- `rejected`: Enhanced with `warningSignals` (base rejection + "Warning signals: `[signals]`")
- `rationale`: Enhanced with `contrastiveAnalysis.criticalDifference`

Backward compatible: check `artifact.contrastiveAnalysis` existence before incorporating. Pre-enhancement artifacts export unchanged.

## Phase C (P2): Deferred

These items from the original proposal are deferred until Phase A/B results are validated:

- **C1: Execution feasibility validation** — Simulate whether `betterDecision` would actually prevent the observed error
- **C2: Historical case retrieval** — Inject similar past artifacts into Dreamer prompt for pattern-based learning

## File Change Summary

| Phase | File | Change Type | Est. Lines |
|-------|------|-------------|------------|
| A | `nocturnal-trinity.ts` | Modify: Dreamer prompt + candidate schema | ~50 prompt, ~10 interface |
| A | `nocturnal-reasoning-deriver.ts` | **New**: 3 derive functions | ~120 |
| A | `nocturnal-candidate-scoring.ts` | Modify: add `validateCandidateDiversity()` | ~30 |
| B | `nocturnal-trinity.ts` | Modify: Philosopher prompt (6-dim + risks) | ~40 prompt, ~15 interface |
| B | `nocturnal-trinity.ts` | Modify: Scribe prompt + ContrastiveAnalysis interface | ~60 prompt, ~25 interface |
| B | `nocturnal-export.ts` | Modify: ORPO enhancement with contrastive analysis | ~40 |

## Not Modified

- `NocturnalSessionSnapshot` schema — no changes
- `nocturnal-trajectory-extractor.ts` — no changes
- `nocturnal-arbiter.ts` validation rules — no changes
- `nocturnal-service.ts` orchestration — no changes (deriver called from Trinity stage builders)
- Stub implementations — no changes (new fields only used in real adapter path)

## Telemetry

Each phase emits telemetry for adaptive threshold monitoring:
- Dreamer: `candidateRiskLevels`, `diversityCheckPassed`
- Philosopher: `dimensionScores` (6D), `riskAssessments`
- Scribe: `contrastiveAnalysisPresent`, `contrastiveAnalysisCompleteness`
