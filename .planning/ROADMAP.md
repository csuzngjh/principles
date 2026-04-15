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

- [x] **Phase 42: Quick Wins** -- busy-wait loop fix, JSON validation, constant-time token compare (completed 2026-04-15)
- [x] **Phase 43: Type Safety** -- branded types, discriminated unions, replace `as any` casts (completed 2026-04-15)
- [x] **Phase 44: Pre-Split Inventory** -- document module-level mutable state, draw import graph (completed 2026-04-15)
- [ ] **Phase 45: Queue Tests** -- migration tests, fake-timers unit tests, concurrency tests
- [ ] **Phase 46: God Class Split** -- extract queue-migration, workflow-watchdog, queue-io, sleep-cycle modules

## Progress

**Execution Order:**
Phases execute in numeric order: 42 -> 43 -> 44 -> 45 -> 46

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 42. Quick Wins | v1.19 | 1/1 | Complete    | 2026-04-15 |
| 43. Type Safety | v1.19 | 2/2 | Complete    | 2026-04-15 |
| 44. Pre-Split Inventory | v1.19 | 2/1 | Complete    | 2026-04-15 |
| 45. Queue Tests | v1.19 | 2/2 | Planned | - |
| 46. God Class Split | v1.19 | 0/N | Not started | - |

## Phase Details

### Phase 42: Quick Wins
**Goal**: Fix 3 reliability and security issues: replace busy-wait spin loop with setTimeout backoff, add JSON structure validation before parse, replace string token comparison with constant-time comparison
**Depends on**: Nothing (standalone fixes)
**Requirements**: QW-01, QW-02, QW-03
**Success Criteria** (what must be TRUE):
  1. `src/utils/io.ts`: EPERM/EBUSY retry uses `setTimeout`-based exponential backoff instead of spin loop — synchronous signature preserved
  2. Queue event payload `JSON.parse()` guarded by structure validation checking required fields (`type`, `workspaceId`) before returning parsed object
  3. `principles-console-route.ts` Bearer token comparison uses `crypto.timingSafeEqual` with `Buffer` comparison
**Plans:**
1/1 plans complete

### Phase 44: Pre-Split Inventory
**Goal**: Document module-level mutable state and draw import graph before Phase 46 god class split — pure analysis, no implementation changes
**Depends on**: Phase 43 (type safety types needed for safe extraction boundaries)
**Requirements**: INFRA-01, INFRA-02
**Success Criteria** (what must be TRUE):
  1. Markdown tables list all module-level mutable state (file, export name, type, initialization, mutation pattern)
  2. Mermaid flowchart shows file-level import dependencies for god class candidates
  3. ESLint config has `complexity_max: 15` and `max_file_lines: 500` applied to `packages/openclaw-plugin/src/`
**Plans:**
2/1 plans complete
- [x] 44-02-PLAN.md — Create mutable state inventory and Mermaid import graph

### Phase 45: Queue Tests
**Goal**: Add integration and unit tests for queue enqueue/dequeue/migration paths — catch bugs in queue logic before they reach production
**Depends on**: Phase 44 (inventory ensures modules are cleanly separable for testing)
**Requirements**: QTEST-01, QTEST-02, QTEST-03, QTEST-04, QTEST-05
**Success Criteria** (what must be TRUE):
  1. `migrateToV2` integration test uses `legacy-queue-v1.json` fixture
  2. `loadEvolutionQueue`/`saveEvolutionQueue` unit tests use `vi.useFakeTimers()`
  3. `purgeStaleFailedTasks` deduplication logic has explicit test coverage
  4. `asyncLockQueues` concurrency tests use `Promise.all` for race detection and clear Map state between tests
  5. Snapshot tests verify queue migration state transitions
**Plans:**
2/2 plans complete
- [x] 45-01-PLAN.md — Core migration tests (QTEST-01, QTEST-05): legacy-queue-v1.json fixture + migrateToV2 integration + state transitions
- [x] 45-02-PLAN.md — Queue operations tests (QTEST-02, QTEST-03, QTEST-04): loadEvolutionQueue/saveEvolutionQueue + purgeStaleFailedTasks + asyncLockQueues

### Phase 46: God Class Split
**Goal**: Extract focused modules from `evolution-worker.ts` (2689L) and improve queue file I/O isolation — enable independent testing and reduce merge conflicts
**Depends on**: Phase 44 (inventory), Phase 45 (tests validate extracted behavior)
**Requirements**: SPLIT-01, SPLIT-02, SPLIT-03, SPLIT-04, SPLIT-05, SPLIT-06, SPLIT-07, BUG-01, BUG-02, BUG-03
**Success Criteria** (what must be TRUE):
  1. `queue-migration.ts` extracted from `evolution-worker.ts` (most isolated concern, smallest boundary)
  2. `workflow-watchdog.ts` extracted (well-bounded health monitoring, separate from queue logic)
  3. `queue-io.ts` extracted (file I/O for queue persistence — encapsulate all queue writes)
  4. `withQueueLock()` RAII-style guard prevents lock-leak bugs
  5. `sleep-cycle.ts` extracted (orchestrator for enqueue/keyword-optimization tasks)
  6. `evolution-worker.ts` becomes permanent facade/re-export layer (stable import point, no new logic)
  7. `nocturnal-trinity.ts` split deferred to future milestone (internally cleaner than evolution-worker.ts)
  8. BUG-01: #185 — watchdog marks stale workflows as `terminal_error` after 2x TTL; silent subagent failure path has test
  9. BUG-02: #188 — gateway-safe fallback for child session cleanup
  10. BUG-03: #214/#219 — timeout recovery logic verified still works after queue split

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
