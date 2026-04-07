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

## Active

- acceptance checklist is readable and handoff-ready
- baseline tests and package-local validation runs define workflow readiness
- `packages/openclaw-plugin/templates/langs/{zh,en}/skills/ai-sprint-orchestration/` is the packaged delivery target
- another agent can start from the skill package instead of repo-root orchestrator paths
- validation runs stop after classification when they hit sample-side or product-side gaps
- workflow v1.3 focuses on internal usability first, then finer-grained work-unit architecture

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

### v1.6 代码质量清理

**Goal:** 清理代码膨胀、修复危险命名冲突、解决遗留路径断裂问题

**Target features:**

- [ ] **CLEAN-01**: 修复 `normalizePath` 命名冲突 — 重命名 `nocturnal-compliance.ts` 中的函数避免同名不同签名
- [ ] **CLEAN-02**: 解决 PAIN_CANDIDATES 遗留路径 — 集成进 evolution-reducer 或删除
- [ ] **CLEAN-03**: 提取 WorkflowManager 基类 — EmpathyObserver/DeepReflect/Nocturnal 三个 manager 提取公共基类，减少 ~1200 行重复
- [ ] **CLEAN-04**: 统一重复类型定义 — `PrincipleStatus` 和 `PrincipleDetectorSpec` 合并到单一数据源
- [ ] **CLEAN-05**: 调查 empathy-observer-workflow-manager 引用情况 — 确认是死代码还是仍在使用
- [ ] **CLEAN-06**: 添加 build artifacts 到 .gitignore — dist/, coverage/, *.tgz

---
*Last updated: 2026-04-07*
