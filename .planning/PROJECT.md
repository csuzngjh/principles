# Principles - AI Agent Principle Evolution System

## What This Is

Principles is a principle-evolution system for AI coding agents. It detects pain signals, proposes candidate principles, gates them through trust and scoring, and promotes validated principles into active use. The repo also contains `ai-sprint-orchestrator`, a long-running multi-stage task runner.

## Core Value

AI agents improve their own behavior through a structured loop:

pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## Validated

- Runtime `Rule Host`, replay evaluation, and manual implementation lifecycle flows exist
- Nocturnal background reflection pipeline exists and can emit production-facing artifacts
- Minimal rule bootstrap and live replay validation shipped in `v1.12`
- CI and lint baseline are green from `v1.9.3`
- v1.19 Tech Debt Remediation: God classes split, type safety improved, queue tests added.
- Phase 0a: Universal PainSignal schema, StorageAdapter interface, FileStorageAdapter, hallucination detection, budget-aware injection, observability baselines.
- Phase 0b: PainSignalAdapter, EvolutionHook, PrincipleInjector, TelemetryEvent interfaces — framework-agnostic adapter abstraction layer.
- v1.21: PD 工作流可观测化 — diagnostician_report 三态扩展 + YAML 工作流漏斗框架（js-yaml, WorkflowFunnelLoader, 6 new EventType, 6 recordXxx methods）
- v1.21.1: Workflow Funnel Runtime Integration — YAML workflows.yaml 驱动运行时 summary/status
- v1.21.2: YAML Funnel SSOT — `workflows.yaml` 真正驱动 `/pd-evolution-status` 展示，getSummary() 消费 funnels Map

## Out of Scope

- New UI/dashboard work
- New feature surface areas (outside SDK scope)
- LoRA or full fine-tune internalization paths

## Context

- Main runtime is being extracted from `packages/openclaw-plugin/src/` into `@principles/core`.
- High priority on interface stability (Semver) and performance benchmarks (p99 targets).
- CEO Plan: 2026-04-16-universal-agent-evolution-sdk.md defines the current strategic direction.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| From zero build for SDK | SDK should be framework-agnostic; refactoring legacy code might bake in coupling | Active |
| evolution-worker is core | It's the functional core, not a god class to be arbitrarily split further | Active |
| Phase 1.5 Validation | N=2 (coding + 1) is not enough for "Universal" claim; need extreme case | Active |
| Freeze Semver after Ph 1.5 | Ensure stability only after cross-domain stress testing | Active |

## Current Milestone: v2.2 PD Runtime v2 — M3 History Retrieval + Context Build

**Goal:** Deliver PD-owned retrieval pipeline — trajectory locate, history query, context build

**Target features:**
- `pd trajectory locate` — by trajectoryId, taskId, runId, date range, PD-managed hints
- `pd history query` — bounded history with cursor pagination + time windows
- `pd context build` — assemble DiagnosticianContextPayload from PD-owned retrieval results
- Degradation policy — bounded fallback, warnings + telemetry, no silent failure
- Workspace isolation — explicit workspace-scoped retrieval, no cross-workspace leakage

**Canonical source:** `packages/principles-core/src/runtime-v2/`

**M3 边界约束（守住边界）:**
- 只做 trajectory locate / history query / context build
- 不做 diagnostician runner（M4）
- 不做 unified commit（M5）
- 不把宿主 API 直接重新带回主设计里
- **Authoritative boundary:** 所有 authoritative retrieval 必须以 PD-owned stores/indexes/references 为主源；OpenClaw raw workspace/session 文件不是 authoritative retrieval source；外部/宿主数据仅在已由 PD 建立索引时方可经由 PD-managed references 访问
- **No LLM in context build:** context assembly 必须 code-generated 或 template-generated，禁止在 context build 过程中调用 LLM

**Previous:** v1.22 — PD CLI Redesign — SHIPPED 2026-04-20

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? Move to Out of Scope with reason
2. Requirements validated? Move to Validated with phase reference
3. New requirements emerged? Add to Active
4. Decisions to log? Add to Key Decisions
5. "What This Is" still accurate? Update if drifted

**After each milestone:**
1. Full review of all sections
2. Core Value check
3. Audit Out of Scope
4. Update Context with current state

*Last updated: 2026-04-22 after M2 shipped, M3 started*
