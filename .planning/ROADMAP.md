# Roadmap: Principles Disciple

## Milestones

- [x] **v1.9.3** - Remaining lint stabilization (shipped 2026-04-09)
- [x] **v1.12** - Nocturnal Production Stabilization (Phases 16-18, shipped 2026-04-10)
- [x] **v1.13** - Boundary Contract Hardening (Phases 19-23, shipped 2026-04-11) — [Archive](milestones/v1.13-ROADMAP.md)
- [ ] **v1.14** - Evolution Worker Decomposition & Contract Hardening (Phases 24-29)
- [ ] **v1.10** - Thinking Models page optimization (deferred)

## Phases

**Phase Numbering:**
- Integer phases (19-23): v1.13 Boundary Contract Hardening (shipped)
- Integer phases (24-29): v1.14 Evolution Worker Decomposition & Contract Hardening (current)
- Decimal phases (24.1, etc.): Urgent insertions (marked with INSERTED)

- [ ] **Phase 24: Queue Store Extraction** - Extract queue persistence, locking, and migration into EvolutionQueueStore with read/write contracts
- [x] **Phase 25: Pain Flag Detector Extraction** - Extract pain flag detection into PainFlagDetector with entry-point validation (completed 2026-04-11)
- [ ] **Phase 26: Task Dispatcher Extraction** - Extract task dispatch and execution into EvolutionTaskDispatcher with entry-point validation
- [ ] **Phase 27: Workflow Orchestrator Extraction** - Extract workflow watchdog and lifecycle into WorkflowOrchestrator with entry-point validation
- [x] **Phase 28: Context Builder + Service Slim + Fallback Audit** - Extract context building, slim the worker, and audit all 16 silent fallback points (completed 2026-04-11)
- [x] **Phase 29: Integration Verification** - Verify end-to-end flow, public API preservation, test passing, and lifecycle correctness (completed 2026-04-11)

## Phase Details

### Phase 24: Queue Store Extraction
**Goal**: Queue persistence operates through a dedicated module with explicit write/read contracts and centralized lock management
**Depends on**: Phase 23 (v1.13 complete)
**Requirements**: DECOMP-01, CONTRACT-01, CONTRACT-02, CONTRACT-06
**Success Criteria** (what must be TRUE):
  1. Queue items are persisted and read through EvolutionQueueStore -- no queue file I/O remains in evolution-worker.ts
  2. Queue items that fail schema validation on write are rejected with an explicit error (not silently dropped)
  3. Queue items that fail validation on read are flagged before processing (migration or corruption caught)
  4. All lock acquisition and release for queue operations goes through EvolutionQueueStore -- no external lock calls for queue data
  5. Existing queue-dependent tests pass without modification
**Plans**: 2 plans

Plans:
- [ ] 24-01-PLAN.md — Create EvolutionQueueStore with validation, migration, locking, and dedup
- [ ] 24-02-PLAN.md — Wire worker and pd-reflect to store, remove inline queue I/O

### Phase 25: Pain Flag Detector Extraction
**Goal**: Pain flag detection runs through a dedicated module with validated entry points
**Depends on**: Phase 24
**Requirements**: DECOMP-02
**Success Criteria** (what must be TRUE):
  1. Pain flag detection and parsing is handled entirely by PainFlagDetector -- no pain-parsing logic remains in the worker
  2. PainFlagDetector validates inputs at its entry points (following v1.13 contract pattern)
  3. Existing pain-detection tests pass without modification to test expectations
**Plans**: 4 plans

Plans:
- [x] 28-01-PLAN.md — TaskContextBuilder class + EventLog recordSkip/recordDrop methods
- [x] 28-02-PLAN.md — SessionTracker class wrapper
- [x] 28-03-PLAN.md — Worker slim (evolution-worker.ts lifecycle orchestration only)
- [x] 28-04-PLAN.md — Fallback audit (all 16 fallback points classified)

### Phase 26: Task Dispatcher Extraction
**Goal**: Task dispatch and execution logic for pain_diagnosis and sleep_reflection runs through a dedicated module
**Depends on**: Phase 25
**Requirements**: DECOMP-03
**Success Criteria** (what must be TRUE):
  1. pain_diagnosis and sleep_reflection task execution is dispatched by EvolutionTaskDispatcher -- no dispatch logic remains in the worker
  2. EvolutionTaskDispatcher validates task inputs at entry points (following v1.13 contract pattern)
  3. Existing task-execution tests pass without modification to test expectations
**Plans**: 1 plan

Plans:
- [ ] 26-01-PLAN.md — Extract task dispatch and execution into EvolutionTaskDispatcher

### Phase 27: Workflow Orchestrator Extraction
**Goal**: Workflow watchdog, expiry cleanup, and manager lifecycle operate through a dedicated module
**Depends on**: Phase 26
**Requirements**: DECOMP-04
**Success Criteria** (what must be TRUE):
  1. Workflow watchdog and expiry cleanup run through WorkflowOrchestrator -- no watchdog logic remains in the worker
  2. WorkflowOrchestrator validates inputs at entry points (following v1.13 contract pattern)
  3. Existing workflow lifecycle tests pass without modification to test expectations
**Plans**: 1 plan

Plans:
- [x] 27-01-PLAN.md — Extract workflow watchdog and sweep into WorkflowOrchestrator

### Phase 28: Context Builder + Service Slim + Fallback Audit
**Goal**: Worker is reduced to lifecycle orchestration only, context building is extracted, and all silent fallback points are audited and classified
**Depends on**: Phase 27
**Requirements**: DECOMP-05, DECOMP-06, CONTRACT-03, CONTRACT-04, CONTRACT-05
**Success Criteria** (what must be TRUE):
  1. Context extraction, fallback snapshot building, and session filtering are handled by TaskContextBuilder -- none remains in the worker
  2. evolution-worker.ts contains only start/stop/runCycle lifecycle orchestration, delegating all work to extracted modules
  3. Every extracted module has input validation at entry points following the v1.13 factory/validator pattern (CONTRACT-03 satisfied)
  4. All 16 silent fallback points are classified as either fail-fast (boundary entry) or fail-visible (pipeline middle)
  5. Fail-visible points emit structured skip/drop events that downstream diagnostics can consume
**Plans**: 4 plans

Plans:
- [x] 28-01-PLAN.md — TaskContextBuilder class + EventLog recordSkip/recordDrop methods
- [x] 28-02-PLAN.md — SessionTracker class wrapper
- [x] 28-03-PLAN.md — Worker slim (evolution-worker.ts lifecycle orchestration only)
- [x] 28-04-PLAN.md — Fallback audit (all 16 fallback points classified)

### Phase 29: Integration Verification
**Goal**: The refactored worker passes all integration checks -- end-to-end flow works, public API unchanged, no resource leaks
**Depends on**: Phase 28
**Requirements**: INTEG-01, INTEG-02, INTEG-03, INTEG-04
**Success Criteria** (what must be TRUE):
  1. All existing tests pass after full decomposition without modification to test expectations
  2. Worker service public API is unchanged -- external callers (hooks, commands, HTTP routes) are unaffected
  3. Nocturnal pipeline end-to-end flow (pain -> queue -> nocturnal -> replay) runs correctly through refactored modules
  4. Worker startup/shutdown lifecycle preserves correctness -- no hanging resources or leaked locks
**Plans**: 5 plans

Plans:
- [x] 29-01-PLAN.md — Fix backward-compat export (readRecentPainContext) + run full test suite
- [x] 29-02-PLAN.md — Public API surface verification
- [x] 29-03-PLAN.md — Nocturnal E2E pipeline verification
- [x] 29-04-PLAN.md — Lifecycle verification (start/stop, no resource leaks)
- [x] 29-05-PLAN.md — Gap closure: correct INTEG-02 FallbackAudit documentation error

## Progress

**Execution Order:**
Phases execute in numeric order: 24 -> 25 -> 26 -> 27 -> 28 -> 29

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 24. Queue Store Extraction | v1.14 | 0/2 | Planning complete | - |
| 25. Pain Flag Detector Extraction | v1.14 | 1/1 | Complete    | 2026-04-11 |
| 26. Task Dispatcher Extraction | v1.14 | 0/? | Not started | - |
| 27. Workflow Orchestrator Extraction | v1.14 | 1/1 | Planning complete | - |
| 28. Context Builder + Service Slim + Fallback Audit | v1.14 | 5/5 | Complete    | 2026-04-11 |
| 29. Integration Verification | v1.14 | 5/5 | Complete    | 2026-04-11 |

*Last updated: 2026-04-11*
