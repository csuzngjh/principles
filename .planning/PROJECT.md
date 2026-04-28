# Principles - AI Agent Principle Evolution System

## What This Is

Principles is a principle-evolution system for AI coding agents. It detects pain signals, proposes candidate principles, gates them through trust and scoring, and promotes validated principles into active use. The repo also contains `ai-sprint-orchestrator`, a long-running multi-stage task runner. Runtime v2 (`@principles/core`) provides a SQLite-backed task/run state machine with diagnostician-driven candidate principle extraction.

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
- v2.5 M6: Production Runtime Adapter: OpenClaw CLI Diagnostician — OpenClawCliRuntimeAdapter, DiagnosticianPromptBuilder, pd diagnose run --runtime openclaw-cli, HG-1~HG-5 all PASS — SHIPPED 2026-04-25
- v2.6 M7: Principle Candidate Intake — CandidateIntakeService, pd candidate intake CLI, PrincipleTreeLedger adapter, idempotent probation entry writing, E2E traceability — SHIPPED 2026-04-27
- v2.7 M8: Pain Signal → Principle Single Path Cutover — IN PROGRESS

## Current Milestone: v2.7 M8 — Pain Signal → Principle Single Path Cutover

**Goal:** 把痛苦信号到原则账本的端到端链路切到 Runtime v2，删除旧 diagnostician 执行链路。

**Pipeline (single path):**
pain → PD task/run store → DiagnosticianRunner → OpenClawCliRuntimeAdapter → DiagnosticianOutputV1 → SqliteDiagnosticianCommitter → principle_candidates → CandidateIntakeService → PrincipleTreeLedger probation entry

**Target features:**
1. 单一诊断链路（无 fallback）— DELETE 所有旧诊断执行路径
2. Legacy code map：先对所有引用分类为 DELETE / REPLACE_WITH_RUNTIME_V2 / KEEP_NON_DIAGNOSTIC，再动手实现
3. 旧链路删除：diagnostician_tasks.json、heartbeat prompt 注入、LLM marker 文件、evolution-worker 轮询
4. CLI 可观测：pd diagnose run / candidate list/show / intake / pain trigger 验证命令
5. E2E 真实 workspace 签收：D:\.openclaw\workspace，runtime=openclaw-cli

**M8 约束：**
- Legacy deletion 只针对旧诊断执行路径，不删除无关的 evolution-worker 功能
- M8 成功标准：链路终点必须是 PrincipleTreeLedger probation entry
- Candidate intake 是 happy path 的一部分（除非明确禁用调试）

**Non-goals：**
- 不保留旧诊断开关（PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED 等）
- 不做 legacy fallback
- 不删除 sleep reflection / keyword optimization 等非诊断功能（除非它们仅服务于旧诊断链路）

**Canonical source:** `packages/principles-core/src/runtime-v2/`

**Out of Scope:**
- 新 UI/dashboard
- 新功能表面区域（SDK scope 外）
- 多 runtime 适配器套件（M8 只需要 OpenClawCliRuntimeAdapter）

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

**Previous:** v2.4 M5 Unified Commit + Principle Candidate Intake — SHIPPED 2026-04-24 (PR #398)

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

*Last updated: 2026-04-27 after v2.6 M7 shipped, v2.7 M8 started*
