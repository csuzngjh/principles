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

## Current Milestone: v2.6 M7 — Principle Candidate Intake

**Goal:** 消费 `principle_candidates.status=pending` 的候选，把它们转换为 PD principle ledger 可管理的 probation principle 条目。M7 不处理 pain signal 自动触发，不删除 legacy evolution-worker，不恢复 heartbeat/cron/subagent。

**Pipeline:** `task → run(openclaw-cli) → DiagnosticianOutputV1 → commit → artifact → principle_candidate(status=pending)` → **[M7 intake]** → `principle_ledger(status=probation)`

**Target features:**
- `CandidateIntakeService` — 消费 pending candidate，幂等写入 ledger
- `pd candidate intake --candidate-id <id> --workspace <path> --json` — CLI 入口
- `PrincipleTreeLedger` adapter — probation principle 写入，不做 promotion
- 链路可追溯：candidate → artifact → task/run → ledger entry

**M7 Non-goals:**
- 不调用 OpenClaw 插件 API
- 不使用 heartbeat / prompt hook / sessions_spawn / marker file
- 不做 pain signal 自动触发（M8 scope）
- 不删除 legacy evolution-worker（M9 scope）
- 不 promote to active principle

**Canonical source:** `packages/principles-core/src/runtime-v2/`

**Out of Scope:**

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

*Last updated: 2026-04-27 after v2.6 M7 shipped*
