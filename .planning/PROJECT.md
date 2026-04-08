# Principles - AI Agent Principle Evolution System

## What This Is

Principles is a principle-evolution system for AI coding agents. It detects pain signals, proposes candidate principles, gates them through trust and scoring, and promotes validated principles into active use. The repo also contains `ai-sprint-orchestrator`, a long-running multi-stage task runner.

## Core Value

AI agents improve their own behavior through a structured loop:

pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## Validated

- WebUI dashboard with overview, loop, feedback, and gate pages
- System health, evolution, feedback, and gate-monitoring APIs
- `ai-sprint-orchestrator` producer/reviewer/decision pipeline
- Contract enforcement and schema validation
- `outputQuality` decision scoring
- Nocturnal background reflection pipeline
- CLEAN-01: normalizePath naming collision eliminated (→ normalizePathPosix)
- CLEAN-02: PAIN_CANDIDATES legacy path removed (165 lines deleted)
- CLEAN-03: WorkflowManager base class extracted (~750 lines duplication removed)
- CLEAN-04: PrincipleStatus and PrincipleDetectorSpec unified to single source
- CLEAN-05: empathy-observer-workflow-manager confirmed LIVE (3 active imports)
- CLEAN-06: build artifacts (coverage/, *.tgz) added to .gitignore

## Active

- acceptance checklist is readable and handoff-ready
- baseline tests and package-local validation runs define workflow readiness
- `packages/openclaw-plugin/templates/langs/{zh,en}/skills/ai-sprint-orchestration/` is the packaged delivery target
- another agent can start from the skill package instead of repo-root orchestrator paths
- validation runs stop after classification when they hit sample-side or product-side gaps
- workflow v1.3 focuses on internal usability first, then finer-grained work-unit architecture
- ARCH-01/ARCH-02: evolution-worker.ts and trajectory.ts splitting (P2, deferred)

## Out of Scope

- `packages/openclaw-plugin` product-side fixes
- `D:/Code/openclaw` changes
- dashboard / stageGraph / self-optimizing sprint / parallel task scheduling
- PR2 / PD product loop closure

## Context

- main workflow source of truth: `packages/openclaw-plugin/templates/langs/zh/skills/ai-sprint-orchestration`
- packaged release target: `packages/openclaw-plugin/templates/langs/{zh,en}/skills/ai-sprint-orchestration`
- baseline tests: `contract-enforcement`, `decision`, `run`
- package-local validation specs: `workflow-validation-minimal`, `workflow-validation-minimal-verify`
- complex task templates: `bugfix-complex-template`, `feature-complex-template`
- known product-side gaps remain documented but excluded from this milestone

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Package-local script closure | released agents will not have the full repo layout | Active |
| Package-local runtime root | packaged runs must not depend on `ops/ai-sprints` | Active |
| Minimal validation specs only | prove workflow behavior without product-side scope creep | Active |
| Classify-and-stop on sample-side issues | keep workflow-first boundary intact | Active |
| v1.3 prioritizes internal usability | use the skill ourselves before redesigning the orchestrator | Active |
| next architecture step is work-unit/tasklet | stage/round/role resets are not enough for very complex long tasks | Planned |

## Current Milestone

### v1.7: PD Task Manager

**Status:** Planning

**Goal:** 用正式的 PD Task Manager 替代 cron-initializer.ts，提供安全的定时任务生命周期管理

**Architecture Doc:** `docs/architecture/pd-task-manager.md`

**Key Features:**
- PDTaskSpec 类型定义 + 内置任务声明（empathy-optimizer）
- PDTaskStore — pd_tasks.json 读写 + meta（健康状态/执行历史）
- PDTaskReconciler — diff + atomic write + file lock + dry-run 模式
- PDTaskService — Plugin Service 集成，启动时自动 reconcile
- 任务健康监控 — 连续失败 3 次自动禁用并通知
- 手动触发 — 支持手动运行/测试某个 PD 任务
- Prompt 数据预取 — 标准化的任务执行前数据快照注入机制
- 执行历史查询 — 通过 Task Registry 关联查询运行记录
- 删除旧的 cron-initializer.ts

**Key Constraints:**
- CronService 是 OpenClaw 内部 API，插件无法直接调用 → 使用 safe file write + own lock
- 版本化 reconcile：当 PD 更新 prompt 时自动更新已有的 cron job
- 向后兼容：已有 "PD Empathy Optimizer" job 会被自动采用和更新
- 复用现有 file-lock.ts（withLockAsync）和 WorkspaceContext 模式

**Phase Start:** Phase 14（上一个是 Phase 13）

---
*Last updated: 2026-04-07 after v1.7 milestone initialized*
