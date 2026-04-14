# Roadmap: Principles Disciple

## Milestones

- [x] **v1.9.3** - Remaining lint stabilization (shipped 2026-04-09)
- [x] **v1.12** - Nocturnal Production Stabilization (Phases 16-18, shipped 2026-04-10)
- [x] **v1.13** - Boundary Contract Hardening (Phases 19-23, shipped 2026-04-11) - [Archive](milestones/v1.13/v1.13-ROADMAP.md)
- [x] **v1.14** - Evolution Worker Decomposition & Contract Hardening (Phases 24-29, baseline complete on branch `fix/bugs-231-228` / PR #245)
- [x] **v1.15** - Runtime & Truth Contract Hardening (Phases 30-33, shipped 2026-04-12)
- [x] **v1.16** - Trinity Training Trajectory Quality Enhancement (Phases 34-37, shipped 2026-04-13)
- [ ] **v1.18** - Nocturnal State Safety & Recovery (Phases 38-41)
- [ ] **v1.10** - Thinking Models page optimization (deferred)

## Phases

**Phase Numbering:**
- Integer phases (30-33): v1.15 Runtime & Truth Contract Hardening (shipped)
- Integer phases (34-37): v1.16 Trinity Training Trajectory Quality Enhancement (shipped)
- Integer phases (38-41): v1.18 Nocturnal State Safety & Recovery (current)

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

### v1.16 Trinity Training Trajectory Quality Enhancement (In Progress)

**Milestone Goal:** Improve Nocturnal Trinity pipeline's training artifact quality through Dreamer diversity, runtime reasoning derivation, Philosopher multi-dimension evaluation, and Scribe contrastive analysis.

- [x] **Phase 34: Reasoning Deriver Module** - Build leaf module for runtime reasoning derivation from existing snapshot data (completed 2026-04-13)
- [x] **Phase 35: Dreamer Enhancement** - Enhance Dreamer prompt for candidate diversity with deriver integration and soft post-validation (completed 2026-04-13)
- [x] **Phase 36: Philosopher 6D Evaluation** - Expand Philosopher evaluation to 6 dimensions with risk assessment (completed 2026-04-13)
- [x] **Phase 37: Scribe Contrastive Analysis** - Add contrastive analysis to Scribe output with backward-compatible optional fields (completed 2026-04-13)

### v1.18 Nocturnal State Safety & Recovery (In Progress)

**Milestone Goal:** Ensure nocturnal pipeline state files are crash-safe through atomic writes, transient failure recovery, and startup reconciliation.

- [x] **Phase 38: Atomic Write Utility** - Leaf utility with tmp+fsync+rename, Windows retry, orphan cleanup (completed 2026-04-14)
- [x] **Phase 39: Nocturnal Write Migration** - Migrate all writeFileSync call sites to atomic writes (completed 2026-04-14)
- [x] **Phase 40: Failure Classification & Cooldown Recovery** - Classify failures as transient/persistent with appropriate cooldowns (completed 2026-04-14)
- [ ] **Phase 41: Startup Reconciliation** - Validate state integrity, clear stale cooldowns, clean orphans on startup

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

### Phase 38: Atomic Write Utility
**Goal**: Crash-safe JSON file writes via tmp+fsync+rename with Windows NTFS retry and orphan cleanup
**Depends on**: Nothing (leaf utility)
**Requirements**: AW-01, AW-02, AW-04
**Success Criteria** (what must be TRUE):
  1. `atomicWriteJsonSync()` writes via tmp+fsync+rename so a crash mid-write never leaves a partial state file
  2. `atomicWriteJsonSync()` retries EPERM/EACCES/EBUSY up to 3 times with 100/200/400ms exponential backoff
  3. On write failure, the orphan .tmp file is deleted before AtomicWriteError propagates
  4. `cleanupOrphanTmpFiles(dir)` removes .tmp files where age > 30s OR PID is dead, returns list of deleted files
  5. `AtomicWriteError` includes filePath, originalError, retryAttempts, and code fields

Plans:
- [x] 38-01: Create Atomic Write Utility Module

### Phase 39: Nocturnal Write Migration
**Goal**: All writeFileSync call sites in the nocturnal pipeline use atomic writes via the Phase 38 utility
**Depends on**: Phase 38 (Atomic Write Utility)
**Success Criteria** (what must be TRUE):
  1. All writeFileSync call sites in nocturnal pipeline modules migrated to atomicWriteJsonSync()
  2. Existing nocturnal state files remain backward-compatible with the migration
  3. All existing tests pass after migration
**Plans**: 4/4 complete

Plans:
- [x] 39-01: TBD
- [x] 39-02: TBD
- [x] 39-03: TBD
- [x] 39-04: TBD

### Phase 40: Failure Classification & Cooldown Recovery
**Goal**: Nocturnal pipeline task failures classified as transient or persistent with tiered cooldown escalation persisted to nocturnal-runtime.json
**Depends on**: Phase 38 (Atomic Write Utility), Phase 39 (Nocturnal Write Migration)
**Success Criteria** (what must be TRUE):
  1. failure-classifier.ts classifies task failures as transient or persistent based on 3 consecutive failure threshold
  2. cooldown-strategy.ts implements three-tier stepped escalation: 30min → 4h → 24h
  3. Consecutive failure counters tracked per task kind (sleep_reflection, keyword_optimization, deep_reflect) independently
  4. Counter resets to 0 on any successful task completion
  5. Cooldown state persisted to nocturnal-runtime.json surviving process restarts
  6. Integration with existing checkCooldown() in nocturnal-runtime.ts for enforcement
**Plans**: TBD

### Phase 41: Startup Reconciliation
**Goal**: Validate state integrity, clear stale cooldowns, and clean orphan files on nocturnal pipeline startup
**Depends on**: Phase 40 (Failure Classification provides cooldown state to reconcile)
**Success Criteria** (what must be TRUE):
  1. Startup validation checks integrity of all nocturnal state files
  2. Stale/expired cooldowns cleared automatically on startup
  3. Orphan .tmp files cleaned up on startup
  4. Pipeline enters clean state before first heartbeat cycle
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 38 -> 39 -> 40 -> 41

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 38. Atomic Write Utility | v1.18 | 1/1 | Complete | 2026-04-14 |
| 39. Nocturnal Write Migration | v1.18 | 4/4 | Complete    | 2026-04-14 |
| 40. Failure Classification | v1.18 | 3/3 | Complete    | 2026-04-14 |
| 41. Startup Reconciliation | v1.18 | 0/? | Pending | |

*Last updated: 2026-04-14*
