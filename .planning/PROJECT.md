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
- v2.4 M5: Unified Commit + Principle Candidate Intake — DiagnosticianCommitter, artifact registry, transaction-safe commit, CLI visibility, E2E hard gate — SHIPPED 2026-04-24

## Current Milestone: v2.5 M6 — Production Runtime Adapter: OpenClaw CLI Diagnostician

**Goal:** 实现第一个真实生产级 PDRuntimeAdapter，让 `pd diagnose run --runtime openclaw-cli` 能通过 OpenClaw CLI 调用真实诊断智能体，返回 DiagnosticianOutputV1，并沿用 M3/M4/M5 链路完成全流程。

**Target features:**
- CliProcessRunner — 通用进程执行器（command/args/cwd/env/timeoutMs，捕获 stdout/stderr/exitCode/durationMs，timeout kill，no shell injection）
- OpenClawCliRuntimeAdapter — 实现 PDRuntimeAdapter，RuntimeKind=`openclaw-cli`，one-shot run，错误映射 PDErrorCategory
- DiagnosticianPromptBuilder — DiagnosticianContextPayload → OpenClaw agent message，只输出 JSON，代码负责提交
- pd diagnose run --runtime 扩展 — `--runtime test-double|openclaw-cli [--agent <id>]`
- pd runtime probe --runtime openclaw-cli — 必须交付（HARD GATE）

**Hard Gates (HG-1 ~ HG-6):**
- HG-1: `pd runtime probe --runtime openclaw-cli` 必须交付
- HG-2: OpenClaw CLI 无 `--workspace`；PD workspace 与 OpenClaw agent workspace 是两个不同边界；adapter 必须通过 cwd/env/profile/agent config 明确控制，禁止隐式假设
- HG-3: `--local` 不能静默默认或静默 fallback，必须作为显式 option/config，并测试 gateway/local 失败映射
- HG-4: OpenClaw `--json` 返回 CliOutput { text }，DiagnosticianOutputV1 在 text 里；PD 必须解析 text、校验 schema，失败映射 output_invalid
- HG-5: M6 签收必须包含真实 `D:\.openclaw\workspace` 验证
- HG-6: Non-goals: 不使用 heartbeat/prompt hook/sessions_spawn/marker file/OpenClaw 插件 API，不做 principle promotion，不静默 fallback 到 TestDouble

**Non-goals (M6 scope):**
- 不调用 OpenClaw 插件 API
- 不使用 heartbeat / prompt hook / sessions_spawn / marker file
- 不依赖 OpenClaw skill dispatch
- 不做 principle promotion / PrincipleTreeLedger 修改
- 不静默 fallback 到 TestDouble（TestDouble 仅作为显式测试 runtime）

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

*Last updated: 2026-04-24 after v2.5 M6 started*
