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

## Current Milestone: v2.0 PD Runtime v2 — M1 Foundation Contracts

**Goal:** 冻结 runtime-v2 核心类型与错误枚举，为 M2-M9 提供统一 contracts

**Target features:**
- Canonical `AgentSpec` 定义 + well-known agent IDs
- Unified `PDErrorCategory` 错误枚举 + `PDRuntimeError`
- `PDRuntimeAdapter` / `RuntimeKind` / `RuntimeCapabilities` / `RuntimeHealth` 完整协议
- `RuntimeSelector` 最小接口（只定义，不实现）
- `PDTaskStatus` + `TaskRecord` + `DiagnosticianTaskRecord` 任务状态模型
- `ContextPayload` / `DiagnosticianContextPayload` / `HistoryQueryEntry` 上下文 payload
- `DiagnosticianOutputV1` 诊断输出 schema
- `SchemaVersion` 版本机制

**Canonical source:** `packages/principles-core/src/runtime-v2/`

**架构约束:**
- 8 份 canonical 文档为最高权威（见 docs/pd-runtime-v2/ 和 docs/spec/）
- 所有 contracts 放在 `@principles/core` 中，不散落在 openclaw-plugin
- M1 只定义 interface/type/enum，不含运行时代码
- 不实现 M2+ 的 task store、retrieval、runner

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

*Last updated: 2026-04-20 after v1.22 milestone started*
