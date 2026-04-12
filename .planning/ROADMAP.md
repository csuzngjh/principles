# Roadmap: Principles Disciple

## Milestones

- [x] **v1.9.3** - Remaining lint stabilization (shipped 2026-04-09)
- [x] **v1.12** - Nocturnal Production Stabilization (Phases 16-18, shipped 2026-04-10)
- [x] **v1.13** - Boundary Contract Hardening (Phases 19-23, shipped 2026-04-11) - [Archive](milestones/v1.13/v1.13-ROADMAP.md)
- [x] **v1.14** - Evolution Worker Decomposition & Contract Hardening (Phases 24-29, baseline complete on branch `fix/bugs-231-228` / PR #245)
- [ ] **v1.15** - Runtime & Truth Contract Hardening (Phases 30-33)
- [ ] **v1.10** - Thinking Models page optimization (deferred)

## Phases

**Phase Numbering:**
- Integer phases (19-23): v1.13 Boundary Contract Hardening (shipped)
- Integer phases (24-29): v1.14 Evolution Worker Decomposition & Contract Hardening (baseline complete on PR #245)
- Integer phases (30-33): v1.15 Runtime & Truth Contract Hardening (current)
- Decimal phases (24.1, etc.): Urgent insertions (marked with INSERTED)

- [x] **Phase 24: Queue Store Extraction** - Extract queue persistence, locking, and migration into EvolutionQueueStore with read/write contracts
- [x] **Phase 25: Pain Flag Detector Extraction** - Extract pain flag detection into PainFlagDetector with entry-point validation (completed 2026-04-11)
- [x] **Phase 26: Task Dispatcher Extraction** - Extract task dispatch and execution into EvolutionTaskDispatcher with entry-point validation
- [x] **Phase 27: Workflow Orchestrator Extraction** - Extract workflow watchdog and lifecycle into WorkflowOrchestrator with entry-point validation
- [x] **Phase 28: Context Builder + Service Slim + Fallback Audit** - Extract context building, slim the worker, and audit all 16 silent fallback points (completed 2026-04-11)
- [x] **Phase 29: Integration Verification** - Verify end-to-end flow, public API preservation, test passing, and lifecycle correctness (completed 2026-04-11)
- [x] **Phase 30: Runtime & Truth Contract Framing** - Convert post-deployment failures into explicit boundary definitions, invariants, and merge-gate criteria (completed 2026-04-12)
- [x] **Phase 31: Runtime Adapter Contract Hardening** - Contract embedded runtime invocation, model/provider resolution, workspace/session artifact ingress, and fail-fast behavior (completed 2026-04-12)
- [ ] **Phase 32: Evidence-Bound Export and Dataset Hardening** - Ensure exports, datasets, and promotion-facing facts are grounded in observed evidence only
- [ ] **Phase 33: Production Invariants and Merge-Gate Verification** - Verify invariants, replay key production flows, and certify the stacked baseline for merge

## Phase Details

### Phase 30: Runtime & Truth Contract Framing
**Goal**: Turn the post-v1.14 production failures into explicit boundary contracts, success criteria, and a stack-safe plan on top of `PR #245`
**Depends on**: Phase 29, baseline branch `fix/bugs-231-228` remaining merge-gate fixes
**Requirements**: RT-01, RT-02, TRUTH-01, OBS-01, MERGE-01
**Success Criteria** (what must be TRUE):
  1. The project distinguishes runtime-contract failures from file/schema-contract failures in planning artifacts
  2. A canonical contract matrix exists for workspace/session/runtime/model/export boundaries in the nocturnal production path
  3. Merge-gate fixes that must land on top of `PR #245` are explicitly separated from future milestone work
  4. Phase 31 and 32 can be planned without re-litigating the diagnosis
**Plans**: 1 plan

Plans:
- [x] 30-01-PLAN.md - Create runtime/truth contract matrix, merge-gate checklist, and milestone framing

### Phase 31: Runtime Adapter Contract Hardening
**Goal**: Replace guessed runtime behavior with explicit adapter contracts and fail-fast handling
**Depends on**: Phase 30
**Requirements**: RT-01, RT-02, RT-03, RT-04
**Success Criteria** (what must be TRUE):
  1. Runtime calls that depend on OpenClaw semantics go through a narrow adapter boundary
  2. Workspace resolution, session artifact lookup, and model/provider selection are contract-checked before execution
  3. Unsupported runtime behavior fails explicitly with actionable diagnostics instead of hidden fallback
  4. Contract tests cover the runtime behaviors that previously drifted in production
**Plans**: 2 plans

Plans:
- [x] 31-01-PLAN.md - Define and implement runtime adapter ingress contracts
- [x] 31-02-PLAN.md - Add contract tests and fail-fast diagnostics for runtime boundary drift

### Phase 32: Evidence-Bound Export and Dataset Hardening
**Goal**: Ensure every export, dataset row, and promotion-facing narrative is grounded in observed evidence
**Depends on**: Phase 30
**Requirements**: TRUTH-01, TRUTH-02, TRUTH-03
**Success Criteria** (what must be TRUE):
  1. Exported samples never claim pain, failure, or violation unless evidence exists in source metadata
  2. Missing evidence is represented structurally (`unknown`, `not_observed`, or omission) rather than narrated as fact
  3. Tests cover zero-evidence and mixed-evidence cases so future regressions are caught automatically
**Plans**: 2 plans

Plans:
- [ ] 32-01-PLAN.md - Harden nocturnal export and dataset builders against fabricated facts
- [ ] 32-02-PLAN.md - Add evidence-trace tests for export and promotion-facing artifacts

### Phase 33: Production Invariants and Merge-Gate Verification
**Goal**: Prove the stacked baseline is merge-safe using machine-checkable invariants and focused production-path verification
**Depends on**: Phase 31, Phase 32
**Requirements**: OBS-01, OBS-02, MERGE-01, MERGE-02
**Success Criteria** (what must be TRUE):
  1. Key invariants for workspace, queue, runtime, and export boundaries are emitted and checkable
  2. The production critical path can be replayed locally or in staging with observable state transitions
  3. Merge-gate criteria for `PR #245` plus stacked fixes are satisfied and documented
  4. Remaining known risks are explicit, bounded, and accepted rather than hidden in silent degradation
**Plans**: 2 plans

Plans:
- [ ] 33-01-PLAN.md - Implement invariant checks and focused end-to-end verification
- [ ] 33-02-PLAN.md - Run merge-gate audit and produce operator-facing verification report

## Progress

**Execution Order:**
Phases execute in numeric order: 30 -> 31 -> 32 -> 33

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 30. Runtime & Truth Contract Framing | v1.15 | 1/1 | Complete | 2026-04-12 |
| 31. Runtime Adapter Contract Hardening | v1.15 | 2/2 | Complete | 2026-04-12 |
| 32. Evidence-Bound Export and Dataset Hardening | v1.15 | 0/2 | Ready to plan | - |
| 33. Production Invariants and Merge-Gate Verification | v1.15 | 0/2 | Not started | - |

*Last updated: 2026-04-12*
