# Roadmap: Principles Disciple

## Milestones

- [ ] **v1.21.2** - YAML Funnel 完整 SSOT (Phase 5-7) — TARGET 2026-04-19
- [x] **v1.22** - Dynamic Gate Migration (Phase 1-2) — SHIPPED 2026-04-19
- [x] **v1.21.1** - Workflow Funnel Scaffold (Phase 3-4) — SHIPPED 2026-04-19 (scaffold only; full YAML-driven runtime integration deferred to v1.21.2)
- [x] **v1.21** - PD 工作流可观测化 (Phase 1-2) — SHIPPED 2026-04-19
- [x] **v1.20** - Universal SDK Foundation (Phases 0a-1.5) — SHIPPED 2026-04-17
- [x] **v1.19** - Tech Debt Remediation (Phases 42-46, shipped 2026-04-15)
- [x] **v1.18** - Nocturnal State Safety & Recovery (shipped 2026-04-14)
- [x] **v1.17** - Keyword Learning Engine (shipped 2026-04-14)
- [x] **v1.16** - Trinity Training Quality (shipped 2026-04-13)
- [x] **v1.15** - Runtime & Truth (shipped 2026-04-12)
- [x] **v1.14** - Decomposition (shipped)
- [x] **v1.13** - Boundary Contracts (shipped 2026-04-11)

## Phases

### v1.21.2 — YAML Funnel 完整 SSOT

- [x] **Phase 5: Runtime Wiring** - getSummary() accepts funnels Map, resolves statsField dot-paths, outputs workflowFunnels
- [x] **Phase 6: Display Wiring** - evolution-status.ts wires to loader, uses YAML labels/stage order, graceful degraded mode
- [x] **Phase 7: Integration Testing** - End-to-end tests for YAML-driven flow and degraded scenarios

### v1.21.1 — Workflow Funnel Scaffold

- [x] **Phase 3: Core Integration** - WorkflowFunnelLoader scaffolding + FSWatcher lifecycle + loaderWarnings plumbing — SHIPPED 2026-04-19 (scaffold only; YAML not yet driving RuntimeSummaryService)
- [x] **Phase 4: Testing & Validation** - Error handling + integration tests — SHIPPED 2026-04-19

### v1.21 — PD 工作流可观测化

- [x] **Phase 1: Issue #366 Fix** - diagnostician_report category 三态扩展
- [x] **Phase 2: YAML 工作流框架** - workflows.yaml 配置加载 + Nocturnal/RuleHost 漏斗 (SSOT 为目标，实际为 scaffold 阶段)

### v1.20 — Universal SDK Foundation

- [x] **Phase 0a: Interface & Core** - PainSignal schema, StorageAdapter, hallucination detection
- [x] **Phase 0b: Adapter Abstraction** - PainSignalAdapter, EvolutionHook, TelemetryEvent
- [x] **Phase 1: SDK Core Implementation** - @principles/core with reference adapters
- [x] **Phase 1.5: Cross-Domain Validation** - API freeze after cross-domain stress test

## Phase Details

### v1.21.2 Phase 5: Runtime Wiring
**Goal**: RuntimeSummaryService.getSummary() accepts optional funnels Map, resolves each stage count via statsField dot-path from dailyStats, outputs workflowFunnels array with funnelKey/funnelLabel/stages
**Depends on**: Nothing
**Requirements**: YAML-SSOT-01, YAML-SSOT-02, YAML-SSOT-03, YAML-SSOT-04
**Success Criteria** (what must be TRUE):
1. getSummary() signature accepts optional `funnels: Map<string, WorkflowStage[]>` parameter
2. When funnels is provided, returned summary includes `workflowFunnels: WorkflowFunnelOutput[]` with each entry having funnelKey, funnelLabel, and stages array
3. Each stage count is resolved by traversing dailyStats using the statsField dot-path (e.g., `evolution.nocturnalDreamerCompleted`)
4. When statsField dot-path is missing or unresolvable, stage count is 0 and metadata.warnings contains a visible warning
5. When funnels is not provided (undefined), getSummary() returns without workflowFunnels field (backward compatible)
**Plans**: 1 plan
- [ ] 07-01-PLAN.md — E2E integration tests: real WorkflowFunnelLoader full-flow, degraded fallback, hot-reload

### v1.21.2 Phase 6: Display Wiring
**Goal**: evolution-status.ts wires loader.getAllFunnels() into getSummary(), display uses YAML labels and stage order, YAML missing/invalid/empty gracefully degrades to stats-only format
**Depends on**: Phase 5
**Requirements**: EVOL-STATUS-01, EVOL-STATUS-02, EVOL-STATUS-03, EVOL-STATUS-04, DEGRADED-01, DEGRADED-02
**Success Criteria** (what must be TRUE):
1. evolution-status.ts calls loader.getAllFunnels() and passes funnels + loaderWarnings to getSummary()
2. Display output uses YAML-defined stage labels (e.g., `dreamer_completed`, `artifact_persisted`) instead of hardcoded field names
3. Stage order in display output matches the order defined in workflows.yaml, not any hardcoded sequence
4. When workflows.yaml is missing or invalid, metadata.status='degraded' and metadata.warnings contains the specific error
5. When funnels Map is empty (all zero counts or loader returned no funnels), no funnel block is rendered; output falls back to old stats-only format without crashing
**Plans**: 1 plan
- [ ] 07-01-PLAN.md — E2E integration tests: real WorkflowFunnelLoader full-flow, degraded fallback, hot-reload

### v1.21.2 Phase 7: Integration Testing
**Goal**: Comprehensive integration tests validating full YAML-driven funnel flow end-to-end and degraded-state behavior
**Depends on**: Phase 6
**Requirements**: TEST-01, TEST-02, TEST-03
**Success Criteria** (what must be TRUE):
1. A test confirms that when workflows.yaml is present with valid funnel definitions, /pd-evolution-status output includes funnel blocks with correct YAML-driven labels and stage order
2. A test confirms that when workflows.yaml is deleted or malformed, status output shows degraded status with warning AND falls back to stats-only format (no crash)
3. A test confirms that modifying workflows.yaml stage labels causes /pd-evolution-status output to reflect the new labels on next invocation (hot-reload observable through watch cycle)
**Plans**: 1 plan
- [ ] 07-01-PLAN.md — E2E integration tests: real WorkflowFunnelLoader full-flow, degraded fallback, hot-reload

### v1.22 Phase 1: Gate Removal
**Goal**: Remove all hardcoded gate modules from PD code, keeping only dynamic rule infrastructure
**Depends on**: Nothing
**Success Criteria** (what must be TRUE):
1. `gfi-gate.ts` removed — GFI calculation remains in `session-tracker.ts` as pain signal source
2. `progressive-trust-gate.ts` removed — EP tier managed via dynamic rules
3. `bash-risk.ts` removed — danger detection via pain learning
4. `thinking-checkpoint.ts` removed — reflection enforcement via dynamic rules
5. `edit-verification.ts` removed — old_string validation via pain learning
6. `gate.ts` simplified to: Rule Host + Edit Verification passthrough
7. All hardcoded block logic gone; Rule Host is the sole gate
8. `npm run test` passes (except pre-existing failures)
9. `npm run lint` passes

**Plans**: SHIPPED 2026-04-19 — commit d62f3dae (5 modules deleted, 4893 lines removed)

### v1.22 Phase 2: Pain Learning Verification
**Goal**: Verify that pain → principle → rule pipeline produces effective gate rules
**Depends on**: Phase 1
**Success Criteria** (what must be TRUE):
1. When a tool fails with high GFI, pain signal is recorded
2. Diagnostician generates a principle from the pain event
3. Compiler produces a rule from the principle
4. Rule Host loads and evaluates the new rule
5. Subsequent similar operations are blocked by the dynamic rule
6. Pain learning pipeline handles the transition gracefully without prolonged "无拦截" gaps

**Plans**: VERIFIED — Pain/principle-compiler/rule-host tests pass (105 tests)
### v1.21.1 Phase 3: Core Integration
**Goal**: Scaffold WorkflowFunnelLoader, establish FSWatcher lifecycle, and plumb loaderWarnings into RuntimeSummaryService (YAML scaffolding only; full funnels Map consumption deferred to v1.21.2)
**Depends on**: Nothing
**Requirements**: YAML-FUNNEL-01, YAML-FUNNEL-02, YAML-FUNNEL-03, YAML-FUNNEL-04, WATCHER-01, WATCHER-02, WATCHER-03, PLAT-01
**Success Criteria** (what must be TRUE):
1. YAML loading scaffolding works: WorkflowFunnelLoader loads workflows.yaml, watch/dispose lifecycle is correct, loaderWarnings are surfaced in metadata (funnel/stage counts remain hardcoded; not yet YAML-driven)
2. YAML parse warnings visible in RuntimeSummaryService.metadata.warnings via loaderWarnings plumbing (funnel/stage counts still hardcoded; not yet YAML-driven)
3. FSWatcher dispose() is called on plugin shutdown / workspace switch with no leaked handles
4. Calling watch() twice on the same loader instance does not leak FSWatcher handles
5. getAllFunnels() returns a deep-copy or immutable structure; consumer mutation has no effect on loader state

**Plans**: 2 plans
- [x] 03-01: Fix workflow-funnel-loader bugs (re-entry guard, deep-clone, rename handling) + YAML-FUNNEL-03
- [x] 03-02: RuntimeSummaryService loaderWarnings param + evolution-status.ts wiring (funnels param deferred to v1.21.2)

### Phase 4: Testing & Validation
**Goal**: Validate error handling, Windows compatibility, and integration behavior end-to-end
**Depends on**: Phase 3
**Requirements**: ERR-01, ERR-02, ERR-03, TEST-01, TEST-02, TEST-03, TEST-04
**Success Criteria** (what must be TRUE):
1. When workflows.yaml is missing or malformed, status output shows explicit "degraded" state with warning in metadata (funnel/stage counts still show hardcoded values; not yet YAML-driven)
2. YAML parse warnings visible in RuntimeSummaryService.metadata.warnings via loaderWarnings plumbing (funnel/stage counts still hardcoded; not yet YAML-driven)
3. When YAML is replaced with invalid content, the loader preserves last-known-good funnel definitions
4. A test suite runs that covers watch()/dispose() lifecycle with no FSWatcher leaks
5. A test suite covers YAML invalid scenarios: degraded state, warnings surfaced, last-known-good retained
6. A test suite covers Windows-style rename/rewrite event sequences on the watcher
7. A test suite confirms consumer mutation of getAllFunnels() output does not corrupt loader state

**Plans**: 1 plan
- [ ] 07-01-PLAN.md — E2E integration tests: real WorkflowFunnelLoader full-flow, degraded fallback, hot-reload
### v1.21 Phase 1: Issue #366 Fix — diagnostician_report 三态扩展
**Goal**: 修复 Issue #366，让 stats 能感知 JSON 缺失/不完整/成功三种情况
**Depends on**: Nothing
**Success Criteria**:
1. `DiagnosticianReportEventData.category` 是三值 `success | missing_json | incomplete_fields`
2. `aggregateEventsIntoStats` 正确统计三种 category 的次数
3. `runtime-summary-service.ts` 的 heartbeatDiagnosis 展示对应字段
4. daily-stats.json 中各漏斗级计数正确递增

**Plans**: 1 plan
- [x] 01-01: Diagnostician JSON 三态扩展

### v1.21 Phase 2: YAML 工作流漏斗框架
**Goal**: 建立可扩展的工作流漏斗登记机制，用 YAML 作为配置来源（SSOT 目标；v1.21.1 实现 scaffold，v1.21.2 完成运行时集成）
**Depends on**: Phase 1
**Success Criteria**:
1. `WORKFLOW_FUNNELS` 定义表现在内存中，支持多工作流注册
2. `workflows.yaml` 加载逻辑可用
3. Nocturnal 漏斗补充了关键 stage event
4. RuleHost 漏斗补充了 evaluate/block/allow 分布统计

**Plans**: 5 plans
- [x] 02-01: js-yaml dependency + WorkflowFunnelLoader class
- [x] 02-02: event-types.ts: 6 new EventData + EventType + EventCategory
- [x] 02-03: event-log.ts: 6 recordXxx() methods + 6 updateStats() branches
- [x] 02-04: Nocturnal: emit 3 stage events
- [x] 02-05: RuleHost: emit 3 events from gate.ts

### v1.20 Phase 0a: Interface & Core
**Goal**: Define foundational interfaces and harden core logic with observability baselines.
**Depends on**: Nothing
**Plans**: 4 plans
- [x] 00a-01: PainSignal schema + StorageAdapter interface definition
- [x] 00a-02: Malformed signal validation + storage failure handling
- [x] 00a-03: Hallucination detection + principle text overflow protection
- [x] 00a-04: Observability baselines + storage conformance test suite

### v1.20 Phase 0b: Adapter Abstraction
**Goal**: Abstract framework-specific logic and design telemetry.
**Depends on**: Phase 0a
**Plans**: 3 plans
- [x] 00b-01: PainSignalAdapter generic interface + contract tests
- [x] 00b-02: EvolutionHook callback interface + PrincipleInjector delegation interface
- [x] 00b-03: TelemetryEvent TypeBox schema + validation tests

### v1.20 Phase 1: SDK Core Implementation
**Goal**: Implement universal SDK core with reference adapters and performance benchmarks.
**Depends on**: Phase 0b
**Plans**: 7 plans
- [x] 01-01: Package scaffold + move 6 interface files from openclaw-plugin
- [x] 01-02: PainSignal validation logic tests
- [x] 01-03: Coding adapter (OpenClawPainAdapter) implementation
- [x] 01-04: Writing adapter (WritingPainAdapter) implementation
- [x] 01-05: Conformance test factories
- [x] 01-06: Performance benchmarks with p99 targets
- [x] 01-07: Semver setup, CHANGELOG, package smoke test

### v1.20 Phase 1.5: Cross-Domain Validation
**Goal**: Stress test universality against an extreme domain before API freeze.
**Depends on**: Phase 1
**Plans**: 3 plans
- [x] 01.5-01 through 01.5-03 (cross-domain validation)

---

*Last updated: 2026-04-19 after v1.21.2 milestone roadmap created*
