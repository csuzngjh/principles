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

## Current Milestone: v1.21.1 Workflow Funnel Runtime Integration

**Goal:** 让 `workflows.yaml` 成为"漏斗定义"的运行时事实源，并驱动 summary/status 展示。

**Target features:**
- WorkflowFunnelLoader 接入 runtime
- RuntimeSummaryService 基于 YAML 定义构建 funnel summary
- /pd-evolution-status 基于 YAML 展示漏斗分层统计
- YAML 缺失/非法时显式报 degraded，不允许静默 hardcoded fallback
- FSWatcher 生命周期正确关闭，避免 watcher 泄漏

**Out of scope:**
- 事件生产端全面改成 YAML 驱动
- 改写所有 event type 命名
- 重做整个 observability 架构

**Success criteria:**
1. RuntimeSummaryService 不再硬编码 heartbeat/nocturnal/rulehost 漏斗结构
2. /pd-evolution-status 展示来自 YAML 定义的漏斗 stages
3. workflows.yaml 修改后可热更新到 summary/status
4. YAML 无效时，status 明确显示配置错误，而不是悄悄 fallback
5. WorkflowFunnelLoader.dispose() 和 watch() 有测试覆盖，确保不泄漏 watcher

**YAML 边界:**
- YAML = 漏斗定义真相源
- event log = 发生事实真相源
- runtime summary = 派生视图（YAML 定义 + event log 数据）

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

*Last updated: 2026-04-19 after v1.21.1 milestone started*
