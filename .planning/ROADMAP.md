# Roadmap: Principles Disciple

## Milestones

- [x] **v1.21.2** — YAML Funnel 完整 SSOT (Phase 5-7) — SHIPPED 2026-04-19
- [x] **v1.22** - Dynamic Gate Migration (Phase 1-2) — SHIPPED 2026-04-19
- [x] **v1.21.1** - Workflow Funnel Scaffold (Phase 3-4) — SHIPPED 2026-04-19
- [x] **v1.21** - PD 工作流可观测化 (Phase 1-2) — SHIPPED 2026-04-19
- [x] **v1.20** - Universal SDK Foundation (Phases 0a-1.5) — SHIPPED 2026-04-17
- [x] **v1.19** - Tech Debt Remediation (Phases 42-46, shipped 2026-04-15)
- [x] **v1.18** - Nocturnal State Safety & Recovery (shipped 2026-04-14)
- [x] **v1.17** - Keyword Learning Engine (shipped 2026-04-14)
- [x] **v1.16** - Trinity Training Quality (shipped 2026-04-13)
- [x] **v1.15** - Runtime & Truth (shipped 2026-04-12)
- [x] **v1.14** - Decomposition (shipped)
- [x] **v1.13** - Boundary Contracts (shipped 2026-04-11)

## Phase Details

<details>
<summary>v1.21.2 — YAML Funnel 完整 SSOT (Phase 5-7) — SHIPPED 2026-04-19</summary>

- [x] **Phase 5: Runtime Wiring** - getSummary() accepts funnels Map, resolves statsField dot-paths, outputs workflowFunnels — COMPLETED 2026-04-19
- [x] **Phase 6: Display Wiring** - evolution-status.ts wires to loader, uses YAML labels/stage order, graceful degraded mode — COMPLETED 2026-04-19
- [x] **Phase 7: Integration Testing** - End-to-end tests for YAML-driven flow and degraded scenarios — COMPLETED 2026-04-19

**Key accomplishment:** `workflows.yaml` now genuinely drives `/pd-evolution-status` funnel display (not just scaffold).

</details>

### v1.22 — Dynamic Gate Migration

- [x] **Phase 1: Gate Removal** - Remove hardcoded gate modules, keep only dynamic rule infrastructure — SHIPPED 2026-04-19
- [x] **Phase 2: Pain Learning Verification** - Verify pain → principle → rule pipeline produces effective gate rules — VERIFIED 2026-04-19

### v1.21.1 — Workflow Funnel Scaffold

- [x] **Phase 3: Core Integration** - WorkflowFunnelLoader scaffolding + FSWatcher lifecycle + loaderWarnings plumbing — SHIPPED 2026-04-19
- [x] **Phase 4: Testing & Validation** - Error handling + integration tests — SHIPPED 2026-04-19

### v1.21 — PD 工作流可观测化

- [x] **Phase 1: Issue #366 Fix** - diagnostician_report category 三态扩展 — SHIPPED 2026-04-19
- [x] **Phase 2: YAML 工作流框架** - workflows.yaml 配置加载 + Nocturnal/RuleHost 漏斗 — SHIPPED 2026-04-19

### v1.20 — Universal SDK Foundation

- [x] **Phase 0a: Interface & Core** - PainSignal schema, StorageAdapter, hallucination detection
- [x] **Phase 0b: Adapter Abstraction** - PainSignalAdapter, EvolutionHook, TelemetryEvent
- [x] **Phase 1: SDK Core Implementation** - @principles/core with reference adapters
- [x] **Phase 1.5: Cross-Domain Validation** - API freeze after cross-domain stress test

---

*Last updated: 2026-04-19 after v1.21.2 milestone shipped*
