# Roadmap: Principles Disciple

## Milestones

- [ ] **v1.22** - Dynamic Gate Migration (Phase 1-2)
- [x] **v1.21.1** - Workflow Funnel Runtime Integration (Phase 3-4) — SHIPPED 2026-04-19
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

### v1.21.1 — Workflow Funnel Runtime Integration

- [ ] **Phase 3: Core Integration** - WORKFLOWS_YAML wiring + FSWatcher lifecycle
- [ ] **Phase 4: Testing & Validation** - Error handling + integration tests

### v1.21 — PD 工作流可观测化

- [x] **Phase 1: Issue #366 Fix** - diagnostician_report category 三态扩展
- [x] **Phase 2: YAML 工作流框架** - workflows.yaml SSOT + Nocturnal/RuleHost 漏斗

### v1.20 — Universal SDK Foundation

- [x] **Phase 0a: Interface & Core** - PainSignal schema, StorageAdapter, hallucination detection
- [x] **Phase 0b: Adapter Abstraction** - PainSignalAdapter, EvolutionHook, TelemetryEvent
- [x] **Phase 1: SDK Core Implementation** - @principles/core with reference adapters
- [x] **Phase 1.5: Cross-Domain Validation** - API freeze after cross-domain stress test

## Phase Details

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

**Plans**: TBD

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

**Plans**: TBD

### v1.21.1 Phase 3: Core Integration
**Goal**: Wire WorkflowFunnelLoader into the runtime so workflows.yaml drives funnel summary
**Depends on**: Nothing
**Requirements**: YAML-FUNNEL-01, YAML-FUNNEL-02, YAML-FUNNEL-03, YAML-FUNNEL-04, WATCHER-01, WATCHER-02, WATCHER-03, PLAT-01
**Success Criteria** (what must be TRUE):
1. `/pd-evolution-status` output shows funnel stages defined in workflows.yaml, not hardcoded mappings
2. Editing `.state/workflows.yaml` hot-reloads into status output within 1 second (FSWatcher debounce)
3. FSWatcher dispose() is called on plugin shutdown / workspace switch with no leaked handles
4. Calling watch() twice on the same loader instance does not leak FSWatcher handles
5. getAllFunnels() returns a deep-copy or immutable structure; consumer mutation has no effect on loader state

**Plans**: TBD

### v1.21.1 Phase 4: Testing & Validation
**Goal**: Validate error handling, Windows compatibility, and integration behavior end-to-end
**Depends on**: Phase 3
**Requirements**: ERR-01, ERR-02, ERR-03, TEST-01, TEST-02, TEST-03, TEST-04
**Success Criteria** (what must be TRUE):
1. When workflows.yaml is missing or malformed, status output shows explicit "degraded" state with warning in metadata
2. YAML parse warnings are visible in RuntimeSummaryService.metadata.warnings (not just console.warn)
3. When YAML is replaced with invalid content, the loader preserves last-known-good funnel definitions
4. A test suite runs that covers watch()/dispose() lifecycle with no FSWatcher leaks
5. A test suite covers YAML invalid scenarios: degraded state, warnings surfaced, last-known-good retained
6. A test suite covers Windows-style rename/rewrite event sequences on the watcher
7. A test suite confirms consumer mutation of getAllFunnels() output does not corrupt loader state

**Plans**: TBD

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
**Goal**: 建立可扩展的工作流漏斗登记机制，用 YAML 作为单一真相来源
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

*Last updated: 2026-04-19 after v1.22 milestone created*
