# Roadmap: Principles Disciple

## Milestones

- [x] **v1.9.3** - Remaining lint stabilization (shipped 2026-04-09)
- [x] **v1.12** - Nocturnal Production Stabilization (Phases 16-18, shipped 2026-04-10)
- [x] **v1.13** - Boundary Contract Hardening (Phases 19-23, shipped 2026-04-11) - [Archive](milestones/v1.13/v1.13-ROADMAP.md)
- [x] **v1.14** - Evolution Worker Decomposition & Contract Hardening (Phases 24-29, baseline complete on branch `fix/bugs-231-228` / PR #245)
- [x] **v1.15** - Runtime & Truth Contract Hardening (Phases 30-33, shipped 2026-04-12)
- [x] **v1.16** - Trinity Training Trajectory Quality Enhancement (Phases 34-37, shipped 2026-04-13)
- [ ] **v1.17** - Keyword Learning Engine (Phases 38-41, current)
- [ ] **v1.10** - Thinking Models page optimization (deferred)

## Phases

**Phase Numbering:**
- Integer phases (38-41): v1.17 Keyword Learning Engine (current)
- Decimal phases: Urgent insertions (marked with INSERTED)

<details>
<summary>Shipped milestones (Phases 1-37)</summary>

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
- [x] **Phase 34: Reasoning Deriver Module** - Build leaf module for runtime reasoning derivation from existing snapshot data (completed 2026-04-13)
- [x] **Phase 35: Dreamer Enhancement** - Enhance Dreamer prompt for candidate diversity with deriver integration and soft post-validation (completed 2026-04-13)
- [x] **Phase 36: Philosopher 6D Evaluation** - Expand Philosopher evaluation to 6 dimensions with risk assessment (completed 2026-04-13)
- [x] **Phase 37: Scribe Contrastive Analysis** - Add contrastive analysis to Scribe output with backward-compatible optional fields (completed 2026-04-13)

</details>

### v1.17 Keyword Learning Engine (In Progress)

**Milestone Goal:** Create dynamic keyword learning mechanism for correction cue detection, reusing empathy engine abstraction patterns.

- [ ] **Phase 38: Foundation** -- Seed store, atomic persistence, cache, integration entry point
- [ ] **Phase 39: Learning Loop** -- FPR tracking, 6-hour optimization trigger, throttle, weight decay
- [ ] **Phase 40: LLM Discovery** -- LLM optimizer adds/updates/removes keywords, trajectory flag
- [ ] **Phase 41: Testing** -- Integration test, atomic write recovery test

## Phase Details

### Phase 38: Foundation
**Goal**: Keyword store persists to disk with atomic writes, seed keywords load on startup, cache stays consistent, and CorrectionCueLearner replaces detectCorrectionCue.
**Depends on**: Nothing (first phase)
**Requirements**: CORR-01, CORR-03, CORR-04, CORR-05, CORR-11
**Success Criteria** (what must be TRUE):
  1. Seed 15 correction keywords from detectCorrectionCue are persisted to `correction_keywords.json` on first load
  2. Keyword store loads from disk on startup with in-memory cache fully populated
  3. Cache reflects disk state after every write (cache invalidation confirmed on disk write)
  4. Store rejects keyword additions beyond 200 terms maximum
  5. Calling `CorrectionCueLearner.match()` in prompt.ts returns results equivalent to original `detectCorrectionCue()`
**Plans**: TBD

### Phase 39: Learning Loop
**Goal**: Match calls track FPR feedback separately, optimization triggers time-based every 6 hours, throttle enforces max 4 calls per day, and confirmed false positives decay keyword weight.
**Depends on**: Phase 38
**Requirements**: CORR-02, CORR-06, CORR-07, CORR-08, CORR-10
**Success Criteria** (what must be TRUE):
  1. `match()` returns match result with confidence score derived from keyword weights
  2. Each keyword tracks `hitCount`, `truePositiveCount`, and `falsePositiveCount` as separate counters
  3. LLM optimization subagent workflow triggers every 6 hours based on wall-clock time (not turn-based)
  4. Optimization calls are throttled to maximum 4 per day across all triggers
  5. Keyword weight decreases when confirmed false positive is recorded
**Plans**: TBD

### Phase 40: LLM Discovery
**Goal**: LLM optimizer can mutate keyword set based on match history and FPR, and trajectory recording includes correction detection flag.
**Depends on**: Phase 39
**Requirements**: CORR-09, CORR-12
**Success Criteria** (what must be TRUE):
  1. LLM optimizer receives match history and FPR statistics and returns keyword mutations (add/update/remove)
  2. Mutated keyword set is persisted and immediately available for matching
  3. Trajectory records include `correctionDetected: boolean` flag from keyword matcher
**Plans**: TBD

### Phase 41: Testing
**Goal**: Full integration cycle verifiable, atomic write recovery verified.
**Depends on**: Phase 40
**Requirements**: CORR-13, CORR-14
**Success Criteria** (what must be TRUE):
  1. Integration test runs complete cycle: matching -> feedback tracking -> optimization trigger -> persistence -> reload
  2. Atomic write recovery test kills process mid-save, verifies `correction_keywords.json` is recoverable via temp-file rename
  3. All 14 v1 requirements are verifiable end-to-end
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 38 -> 39 -> 40 -> 41

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 38. Foundation | v1.17 | 0/N | Not started | - |
| 39. Learning Loop | v1.17 | 0/N | Not started | - |
| 40. LLM Discovery | v1.17 | 0/N | Not started | - |
| 41. Testing | v1.17 | 0/N | Not started | - |

## Coverage

**v1.17 Requirements:** 14 total (CORR-01 through CORR-14)

| Phase | Requirements |
|-------|--------------|
| Phase 38: Foundation | CORR-01, CORR-03, CORR-04, CORR-05, CORR-11 |
| Phase 39: Learning Loop | CORR-02, CORR-06, CORR-07, CORR-08, CORR-10 |
| Phase 40: LLM Discovery | CORR-09, CORR-12 |
| Phase 41: Testing | CORR-13, CORR-14 |

**Coverage:** 14/14 requirements mapped

---

*Last updated: 2026-04-14*
