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

## Current Milestone: v1.21.2 YAML Funnel 完整 SSOT

**Goal:** 让 `workflows.yaml` 真正驱动 `/pd-evolution-status` 展示（完整 wiring，而非 v1.21.1 scaffold）。

**Target features:**
- RuntimeSummaryService.getSummary() 接受 funnels Map，消费 YAML funnel 定义构建 workflowFunnels 输出
- evolution-status.ts 调用 loader.getAllFunnels()，把 funnel 数据传给 getSummary()
- 每个 stage 的 count 从 dailyStats 按 statsField 读取；statsField 缺失时 count=0 + warning 可见
- YAML 缺失/非法时 status 显示 degraded，不静默 fallback

**Out of scope:**
- diagnostician 三态统计逻辑改动
- nocturnal / rulehost 事件生产逻辑
- Rule Host 架构本身
- .planning 清理

**Success criteria:**
1. `workflows.yaml` 的 funnel/stage 定义真实影响 `/pd-evolution-status` 的展示内容和结构
2. 删掉或修改 YAML，展示随之变化
3. statsField 缺失时不崩溃，count=0 + warning 可见
4. 展示层不再有 hardcoded nocturnal/rulehost 漏斗结构

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

*Last updated: 2026-04-19 after v1.21.2 milestone started*
