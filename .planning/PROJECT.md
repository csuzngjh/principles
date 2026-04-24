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
- v1.21: PD 工作流可观测化 — diagnostician_report 三态扩展 + YAML 工作流漏斗框架
- v1.21.2: YAML Funnel SSOT — `workflows.yaml` 驱动 `/pd-evolution-status` 展示
- v2.0 M1: Foundation Contracts — PDRuntimeAdapter, TaskRecord, RunRecord, TypeBox schemas — SHIPPED 2026-04-21
- v2.1 M2: Task/Run State Core — SqliteTaskStore, SqliteRunStore, LeaseManager, RetryPolicy, RecoverySweep — SHIPPED 2026-04-22
- v2.2 M3: History Retrieval + Context Build — trajectory locate, history query, context assembly — SHIPPED 2026-04-23
- v2.3 M4: Diagnostician Runner v2 — explicit runner, runtime adapter, validator, telemetry, CLI — SHIPPED 2026-04-23

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

## Current Milestone: v2.4 PD Runtime v2 — M5 Unified Commit + Principle Candidate Intake

**Goal:** diagnostician output -> diagnosis artifact -> principle candidate -> task resultRef，全链路在 SQLite .pd/state.db 内原子完成

**Target features:**
- DiagnosticianCommitter — 接口隔离，runner 只依赖 Committer，不直接操作 artifact/candidate 表
- Artifact Registry — diagnosis_artifact + principle_candidate 表在 .pd/state.db
- Principle Candidate Intake — 从 recommendations 提取 kind='principle'，写入 candidate 表
- Transaction-safe commit — 同一 SQLite transaction：artifact → candidate → refs → task.resultRef
- Runner integration — 正确顺序：output validated → commit → task succeeded；commit 失败 = artifact_commit_failed
- CLI visibility — pd candidate list/show，JSON 输出可追溯
- E2E 硬门槛 — task→run→output→artifact→candidate→resultRef 全链路可查

**Canonical source:** `packages/principles-core/src/runtime-v2/`

**M5 边界约束（6 corrections）:**
- 原子提交 truth 在 SQLite .pd/state.db，PrincipleTreeLedger 只做 adapter/bridge，不作为原子事务部分
- Runner 不直接知道 artifact/candidate 表或 ledger 文件路径，只依赖 Committer 接口
- task succeeded 必须在 commit 成功之后；commit 失败 = artifact_commit_failed
- 不能产生"任务成功但 candidate 缺失"的状态
- E2E 验证命令是硬门槛：task→run→output→artifact→candidate→resultRef 全链路可追溯
- 不做 principle promotion、active injection、multi-runtime、plugin demotion

**Previous:** v2.3 — M4 Diagnostician Runner v2 — SHIPPED 2026-04-23

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

*Last updated: 2026-04-24 after M4 shipped, M5 started*
