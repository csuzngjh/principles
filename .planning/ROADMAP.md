# Roadmap: Principles Disciple

## Milestones

- [x] **v1.9.3** - Remaining lint stabilization (shipped 2026-04-09)
- [x] **v1.12** - Nocturnal Production Stabilization (Phases 16-18, shipped 2026-04-10)
- [x] **v1.13** - Boundary Contract Hardening (Phases 19-23, shipped 2026-04-11) - [Archive](milestones/v1.13/v1.13-ROADMAP.md)
- [x] **v1.14** - Evolution Worker Decomposition & Contract Hardening (Phases 24-29, baseline complete on branch `fix/bugs-231-228` / PR #245)
- [x] **v1.15** - Runtime & Truth Contract Hardening (Phases 30-33, shipped 2026-04-12)
- [x] **v1.16** - Trinity Training Trajectory Quality Enhancement (Phases 34-37, shipped 2026-04-13)
- [x] **v1.17** - Keyword Learning Engine (Phases 38-41, shipped 2026-04-14)
- [x] **v1.18** - Nocturnal State Safety & Recovery (shipped 2026-04-14)
- [ ] **v1.19** - Tech Debt Remediation (Phases 42-46, current)
- [ ] **v1.10** - Thinking Models page optimization (deferred)

## Phases

**Phase Numbering:**
- Integer phases (42-46): v1.19 Tech Debt Remediation (current)
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

### v1.17 Keyword Learning Engine (Shipped 2026-04-14)

**Milestone Goal:** Create dynamic keyword learning mechanism for correction cue detection, reusing empathy engine abstraction patterns.

- [x] **Phase 38: Foundation** -- Seed store, atomic persistence, cache, integration entry point (completed 2026-04-14)
- [x] **Phase 39: Learning Loop** -- FPR tracking, 6-hour optimization trigger, throttle, weight decay (completed 2026-04-14)
- [x] **Phase 40: LLM Discovery** -- LLM optimizer adds/updates/removes keywords, trajectory flag (completed 2026-04-14)
- [x] **Phase 41: Testing** -- Integration test, atomic write recovery test (completed 2026-04-14)

### v1.19 Tech Debt Remediation (In Progress)

**Milestone Goal:** 逐步清理技术债：拆分 god classes、修复 type safety、添加 queue integration tests、强化安全

- [ ] **Phase 42: Quick Wins** -- busy-wait loop fix, JSON validation, constant-time token compare
- [ ] **Phase 43: Type Safety** -- branded types, discriminated unions, replace `as any` casts
- [ ] **Phase 44: Pre-Split Inventory** -- document module-level mutable state, draw import graph
- [ ] **Phase 45: Queue Tests** -- migration tests, fake-timers unit tests, concurrency tests
- [ ] **Phase 46: God Class Split** -- extract queue-migration, workflow-watchdog, queue-io, sleep-cycle modules

## Progress

**Execution Order:**
Phases execute in numeric order: 42 -> 43 -> 44 -> 45 -> 46

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 42. Quick Wins | v1.19 | 0/N | Not started | - |
| 43. Type Safety | v1.19 | 0/N | Not started | - |
| 44. Pre-Split Inventory | v1.19 | 0/N | Not started | - |
| 45. Queue Tests | v1.19 | 0/N | Not started | - |
| 46. God Class Split | v1.19 | 0/N | Not started | - |

## Coverage

**v1.19 Requirements:** 23 total (QW-01..03, TYPE-01..05, QTEST-01..05, SPLIT-01..07, BUG-01..03, INFRA-01..03)

| Phase | Requirements |
|-------|--------------|
| Phase 42: Quick Wins | QW-01, QW-02, QW-03 |
| Phase 43: Type Safety | TYPE-01, TYPE-02, TYPE-03, TYPE-04, TYPE-05 |
| Phase 44: Pre-Split Inventory | INFRA-01, INFRA-02 |
| Phase 45: Queue Tests | QTEST-01, QTEST-02, QTEST-03, QTEST-04, QTEST-05 |
| Phase 46: God Class Split | SPLIT-01, SPLIT-02, SPLIT-03, SPLIT-04, SPLIT-05, SPLIT-06, SPLIT-07, BUG-01, BUG-02, BUG-03 |

**Coverage:** 23/23 requirements mapped

---

*Last updated: 2026-04-15*
