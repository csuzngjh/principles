# Roadmap: Principles Disciple

## Milestones

- [x] **v1.9.3** - Remaining lint stabilization (shipped 2026-04-09)
- [x] **v1.12** - Nocturnal Production Stabilization (Phases 16-18, shipped 2026-04-10)
- [x] **v1.13** - Boundary Contract Hardening (Phases 19-23, shipped 2026-04-11) - [Archive](milestones/v1.13/v1.13-ROADMAP.md)
- [x] **v1.14** - Evolution Worker Decomposition & Contract Hardening (Phases 24-29, baseline complete on branch `fix/bugs-231-228` / PR #245)
- [x] **v1.15** - Runtime & Truth Contract Hardening (Phases 30-33, shipped 2026-04-12)
- [x] **v1.16** - Trinity Training Trajectory Quality Enhancement (Phases 34-37, shipped 2026-04-14)
- [ ] **v1.10** - Thinking Models page optimization (deferred)

## Phases

**Phase Numbering:**
- Integer phases (30-33): v1.15 Runtime & Truth Contract Hardening (shipped)
- Integer phases (34-37): v1.16 Trinity Training Trajectory Quality Enhancement (shipped 2026-04-14)
- Decimal phases: Urgent insertions (marked with INSERTED)

<details>
<summary>Shipped milestones (Phases 1-33)</summary>

- [x] **Phase 24: Queue Store Extraction** - Extract queue persistence, locking, and migration into EvolutionQueueStore with read/write contracts
- [x] **Phase 25: Pain Flag Detector Extraction** - Extract pain flag detection into PainFlagDetector with entry-point validation (completed 2026-04-11)
- [x] **Phase 26: Task Dispatcher Extraction** - Extract task dispatch and execution into EvolutionTaskDispatcher with entry-point validation
- [x] **Phase 27: Workflow Orchestrator Extraction** - Extract workflow watchdog and lifecycle into WorkflowOrchestrator with entry-point validation
- [x] **Phase 28: Context Builder + Service Slim + Fallback Audit** - Extract context building, slim the worker, and audit all 16 silent fallback points (completed 2026-04-11)
- [x] **Phase 29: Integration Verification** - Verify end-to-end flow, public API preservation, test passing, and lifecycle correctness (completed 2026-04-11)
- [x] **Phase 30: Runtime & Truth Contract Framing** - Create runtime/truth contract matrix, merge-gate checklist, and milestone framing (completed 2026-04-12)
- [x] **Phase 31: Runtime Adapter Contract Hardening** - Contract embedded runtime invocation, model/provider resolution, fail-fast behavior (completed 2026-04-12)
- [x] **Phase 32: Evidence-Bound Export and Dataset Hardening** - Harden export/dataset against fabricated facts (completed 2026-04-12)
- [x] **Phase 33: Production Invariants and Merge-Gate Verification** - Invariant checks, merge-gate audit (completed 2026-04-12, audit=defer)

</details>

### v1.16 Trinity Training Trajectory Quality Enhancement (SHIPPED 2026-04-14)

**Milestone Goal:** Improve Nocturnal Trinity pipeline's training artifact quality through Dreamer diversity, runtime reasoning derivation, Philosopher multi-dimension evaluation, and Scribe contrastive analysis.

- [x] **Phase 34: Reasoning Deriver Module** - Build leaf module for runtime reasoning derivation from existing snapshot data (completed 2026-04-14)
- [x] **Phase 35: Dreamer Enhancement** - Enhance Dreamer prompt for candidate diversity with deriver integration and soft post-validation (completed 2026-04-14)
- [x] **Phase 36: Philosopher 6D Evaluation** - Expand Philosopher evaluation to 6 dimensions with risk assessment (completed 2026-04-14)
- [x] **Phase 37: Scribe Contrastive Analysis** - Add contrastive analysis to Scribe output with backward-compatible optional fields (completed 2026-04-14)

## Phase Details

### Phase 34: Reasoning Deriver Module
**Goal**: Derived reasoning signals are available to Trinity pipeline stages without any snapshot schema changes
**Depends on**: Nothing (leaf module, no downstream dependencies)
**Requirements**: DERIV-01, DERIV-02, DERIV-03
**Success Criteria** (what must be TRUE):
  1. `deriveReasoningChain()` extracts thinking content (from `<thinking>` tags), uncertainty markers (3 regex patterns), and confidence signal (high/medium/low) from assistant turns in existing snapshot data
  2. `deriveDecisionPoints()` extracts before-context (last 500 chars), after-reflection (first 300 chars on failure), and confidence delta per tool call from existing snapshot data
  3. `deriveContextualFactors()` computes fileStructureKnown, errorHistoryPresent, userGuidanceAvailable, and timePressure from existing snapshot data
  4. All three functions are pure TypeScript with zero new dependencies and handle edge cases (missing tags, empty turns, missing tool calls) gracefully
**Plans**: TBD

Plans:
- [x] 34-01: TBD
- [x] 34-02: TBD

### Phase 35: Dreamer Enhancement
**Goal**: Dreamer generates strategically diverse candidates with derived reasoning context, validated by soft diversity checks
**Depends on**: Phase 34
**Requirements**: DIVER-01, DIVER-02, DIVER-03, DIVER-04, DERIV-04
**Success Criteria** (what must be TRUE):
  1. Dreamer prompt includes strategic perspective requirements (conservative_fix / structural_improvement / paradigm_shift) with explicit anti-pattern warnings
  2. DreamerCandidate interface has optional `riskLevel` ("low"|"medium"|"high") and `strategicPerspective` fields -- existing candidates without these fields continue to work
  3. Derived reasoning signals (reasoning chain + contextual factors) are injected into the Dreamer prompt builder from the new deriver module
  4. `validateCandidateDiversity()` checks risk level diversity (Set.size >= 2) and keyword overlap similarity (reject at > 0.8) on generated candidates
  5. Diversity validation failures log telemetry warnings with `diversityCheckPassed: false` and do not hard-gate the pipeline -- best available candidate proceeds
**Plans**: TBD

Plans:
- [x] 35-01: TBD
- [x] 35-02: TBD

### Phase 36: Philosopher 6D Evaluation
**Goal**: Philosopher evaluates candidates across 6 calibrated dimensions with per-candidate risk assessment
**Depends on**: Phase 35 (Dreamer produces strategic perspectives that Philosopher evaluates)
**Requirements**: PHILO-01, PHILO-02, PHILO-03
**Success Criteria** (what must be TRUE):
  1. Philosopher prompt evaluates candidates across 6 dimensions with calibrated weights: Principle Alignment (0.20), Specificity (0.15), Actionability (0.15), Executability (0.15), Safety Impact (0.20), UX Impact (0.15)
  2. Philosopher output includes risk assessment per candidate: falsePositiveEstimate (0-1), implementationComplexity (low/medium/high), breakingChangeRisk (boolean)
  3. New PhilosopherJudgment fields (scores, risks) are optional -- existing tournament scoring in nocturnal-candidate-scoring.ts continues unchanged
**Plans**: TBD

Plans:
- [x] 36-01: TBD
- [x] 36-02: TBD

### Phase 37: Scribe Contrastive Analysis
**Goal**: Scribe produces contrastive analysis that distinguishes chosen vs rejected reasoning paths, enabling richer training signals
**Depends on**: Phase 34 (decision points for rejected analysis), Phase 36 (6D judgments inform contrastive depth)
**Requirements**: SCRIBE-01, SCRIBE-02, SCRIBE-03, SCRIBE-04
**Success Criteria** (what must be TRUE):
  1. Scribe generates rejectedAnalysis with whyRejected (mental model that led to mistake), warningSignals (observable caution triggers), and correctiveThinking (correct reasoning path)
  2. Scribe generates chosenJustification with whyChosen (embodied principle), keyInsights (1-3 transferable insights), and limitations (when approach does not apply)
  3. Scribe generates contrastiveAnalysis with criticalDifference (ONE key insight), decisionTrigger ("When X, do Y" pattern), and preventionStrategy (systematic avoidance)
  4. ContrastiveAnalysis is optional on TrinityDraftArtifact -- pre-enhancement artifacts export unchanged and backward compatible
**Plans**: TBD

Plans:
- [x] 37-01: TBD
- [ ] 37-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 34 -> 35 -> 36 -> 37

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 34. Reasoning Deriver Module | v1.16 | 2/2 | Complete    | 2026-04-14 |
| 35. Dreamer Enhancement | v1.16 | 2/2 | Complete    | 2026-04-14 |
| 36. Philosopher 6D Evaluation | v1.16 | 2/2 | Complete    | 2026-04-14 |
| 37. Scribe Contrastive Analysis | v1.16 | 1/1 | Complete    | 2026-04-14 |

*Last updated: 2026-04-14*
