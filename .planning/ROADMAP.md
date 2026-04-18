# Roadmap: Principles Disciple

## Milestones

- [ ] **v1.21** - PD 工作流可观测化 (Phase 1-2)
- [x] **v1.20** - Universal SDK Foundation (Phases 0a-1.5)
- [x] **v1.19** - Tech Debt Remediation (Phases 42-46, shipped 2026-04-15)
- [x] **v1.18** - Nocturnal State Safety & Recovery (shipped 2026-04-14)
- [x] **v1.17** - Keyword Learning Engine (shipped 2026-04-14)
- [x] **v1.16** - Trinity Training Quality (shipped 2026-04-13)
- [x] **v1.15** - Runtime & Truth (shipped 2026-04-12)
- [x] **v1.14** - Decomposition (shipped)
- [x] **v1.13** - Boundary Contracts (shipped 2026-04-11)

## Phases

- [ ] **Phase 1: Issue #366 Fix** - diagnostician_report category 三态扩展
- [ ] **Phase 2: YAML 工作流框架** - workflows.yaml 加载 + Nocturnal/RuleHost 漏斗补充
- [x] **Phase 0a: Interface & Core** - Define foundational interfaces and harden core logic with observability baselines.
- [ ] **Phase 0b: Adapter Abstraction** - Abstract framework-specific logic and design telemetry.
- [ ] **Phase 1: SDK Core Implementation** - Implement universal SDK core with reference adapters and benchmarks.
- [ ] **Phase 1.5: Cross-Domain Validation** - Stress test universality against an extreme domain before API freeze.

## Phase Details

### Phase 1: Issue #366 Fix — diagnostician_report 三态扩展
**Goal**: 修复 Issue #366，让 stats 能感知 JSON 缺失/不完整/成功三种情况
**Depends on**: Nothing
**Requirements**: PD-FUNNEL-1.1, PD-FUNNEL-1.2, PD-FUNNEL-1.3, PD-FUNNEL-1.4
**Success Criteria** (what must be TRUE):
  1. `DiagnosticianReportEventData.category` 是三值 `success | missing_json | incomplete_fields`
  2. `aggregateEventsIntoStats` 正确统计三种 category 的次数
  3. `runtime-summary-service.ts` 的 heartbeatDiagnosis 展示 reportsMissingJsonToday 和 reportsIncompleteFieldsToday
  4. 手动触发 pain signal 后，daily-stats.json 中各漏斗级计数正确递增

### Phase 2: YAML 工作流漏斗框架
**Goal**: 建立可扩展的工作流漏斗登记机制，用 YAML 作为单一真相来源
**Depends on**: Phase 1
**Requirements**: PD-FUNNEL-2.1, PD-FUNNEL-2.2, PD-FUNNEL-2.3, PD-FUNNEL-2.4
**Success Criteria** (what must be TRUE):
  1. `WORKFLOW_FUNNELS` 定义表现在内存中，支持多工作流注册
  2. `workflows.yaml` 加载逻辑可用，放在 `.state/` 目录
  3. Nocturnal 漏斗补充了关键 stage event
  4. RuleHost 漏斗补充了 evaluate/block/allow 分布统计
  5. 新增工作流只需修改 YAML，不改代码

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
**Plans**: 7 plans
Plans:
- [ ] 01-01-PLAN.md -- Package scaffold + move 6 interface files from openclaw-plugin
- [ ] 01-02-PLAN.md -- PainSignal validation logic (validatePainSignal, deriveSeverity) tests
- [ ] 01-03-PLAN.md -- Coding adapter (OpenClawPainAdapter) implementation
- [ ] 01-04-PLAN.md -- Writing adapter (WritingPainAdapter) implementation
- [ ] 01-05-PLAN.md -- Conformance test factories (describePainAdapterConformance, describeInjectorConformance)
- [ ] 01-06-PLAN.md -- Performance benchmarks with p99 targets
- [ ] 01-07-PLAN.md -- Semver setup, CHANGELOG, package smoke test

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

| Milestone/Phase | Status | Completed |
|-----------------|--------|-----------|
| v1.21 Phase 1: Issue #366 Fix | Planning | - |
| v1.21 Phase 2: YAML Framework | Not started | - |
| Phase 0a: Interface & Core | Completed | 2026-04-17 |
| Phase 0b: Adapter Abstraction | Planning | - |
| Phase 1: SDK Core Implementation | Planning | - |
| Phase 1.5: Cross-Domain Validation | Not started | - |

---
*Last updated: 2026-04-18 for v1.21 milestone*
