# Roadmap: Principles Disciple

## Milestones

- [ ] **v1.20** - Universal SDK Foundation (Phases 0a-1.5)
- [x] **v1.19** - Tech Debt Remediation (Phases 42-46, shipped 2026-04-15)
- [x] **v1.18** - Nocturnal State Safety & Recovery (shipped 2026-04-14)
- [x] **v1.17** - Keyword Learning Engine (shipped 2026-04-14)
- [x] **v1.16** - Trinity Training Quality (shipped 2026-04-13)
- [x] **v1.15** - Runtime & Truth (shipped 2026-04-12)
- [x] **v1.14** - Decomposition (shipped)
- [x] **v1.13** - Boundary Contracts (shipped 2026-04-11)

## Phases

- [x] **Phase 0a: Interface & Core** - Define foundational interfaces and harden core logic with observability baselines.
- [ ] **Phase 0b: Adapter Abstraction** - Abstract framework-specific logic and design telemetry.
- [ ] **Phase 1: SDK Core Implementation** - Implement universal SDK core with reference adapters and benchmarks.
- [ ] **Phase 1.5: Cross-Domain Validation** - Stress test universality against an extreme domain before API freeze.

## Phase Details

### Phase 0a: Interface & Core
**Goal**: Define foundational interfaces and harden core logic with observability baselines.
**Depends on**: Nothing
**Requirements**: SDK-CORE-01, SDK-CORE-02, SDK-QUAL-01, SDK-QUAL-02, SDK-QUAL-03, SDK-QUAL-04, SDK-TEST-01, SDK-OBS-01, SDK-OBS-02, SDK-OBS-03, SDK-OBS-04
**Success Criteria** (what must be TRUE):
  1. Universal PainSignal and StorageAdapter interfaces are defined and exported.
  2. Malformed signal validation and LLM hallucination detection are implemented and tested.
  3. Storage failure scenarios are handled gracefully (fail-fast or safe-retry).
  4. System observability baselines (stock, sub-structure, association, internalization) are measured and recorded.
**Plans**: 4 plans
Plans:
- [x] 00a-01-PLAN.md -- PainSignal schema + StorageAdapter interface definition
- [x] 00a-02-PLAN.md -- Malformed signal validation + storage failure handling
- [x] 00a-03-PLAN.md -- Hallucination detection + principle text overflow protection
- [x] 00a-04-PLAN.md -- Observability baselines + storage conformance test suite

### Phase 0b: Adapter Abstraction
**Goal**: Abstract framework-specific logic and design telemetry.
**Depends on**: Phase 0a
**Requirements**: SDK-ADP-01, SDK-ADP-02, SDK-ADP-03, SDK-ADP-04, SDK-ADP-05, SDK-ADP-06, SDK-OBS-05
**Success Criteria** (what must be TRUE):
  1. Framework-agnostic PainSignal capture and principle injection interfaces are implemented.
  2. `EvolutionHook` and generic `StorageAdapter` methods are defined.
  3. Telemetry schema for in-process events is documented.
**Plans**: 3 plans
Plans:
- [x] 00b-01-PLAN.md -- PainSignalAdapter generic interface + contract tests
- [x] 00b-02-PLAN.md -- EvolutionHook callback interface + PrincipleInjector delegation interface + contract tests
- [x] 00b-03-PLAN.md -- TelemetryEvent TypeBox schema + validation tests

### Phase 1: SDK Core Implementation
**Goal**: Implement universal SDK core with reference adapters and performance benchmarks.
**Depends on**: Phase 0b
**Requirements**: SDK-CORE-03, SDK-ADP-07, SDK-ADP-08, SDK-TEST-02, SDK-TEST-03, SDK-MGMT-01, SDK-MGMT-02
**Success Criteria** (what must be TRUE):
  1. SDK is available as `@principles/core` with stable Semver.
  2. Coding adapter and a second domain adapter (e.g. writing/service) are functional.
  3. Adapter conformance test suite validates both reference adapters.
  4. Performance targets (p99 < 50ms for pain, < 100ms for injection) are met and documented.
**Plans**: TBD

### Phase 1.5: Cross-Domain Validation
**Goal**: Stress test universality against an extreme domain before API freeze.
**Depends on**: Phase 1
**Requirements**: SDK-VAL-01, SDK-VAL-02, SDK-VAL-03, SDK-MGMT-03
**Success Criteria** (what must be TRUE):
  1. SDK successfully handles extreme non-coding domain triggers and injection.
  2. Any interface adjustments required by the extreme case are incorporated.
  3. API and Semver frozen after validation.
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 0a: Interface & Core | 4/4 | Completed | 2026-04-17 |
| 0b: Adapter Abstraction | 0/3 | Planning | - |
| 1: SDK Core Implementation | 0/4 | Not started | - |
| 1.5: Cross-Domain Validation | 0/2 | Not started | - |

---
*Last updated: 2026-04-17 for Phase 0b planning*
