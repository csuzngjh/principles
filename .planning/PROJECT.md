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

### v1.9.1: WebUI 数据源修复

**Status:** Defining requirements

**Goal:** 排查并修复 WebUI 所有页面（Overview / Loop / Feedback / Gate Monitor）的数据源问题，确保展示数据正确

**Key Features:**
- 排查四个页面的数据源根因（数据库 → API → 前端字段映射）
- 修复缺失或错误的数据链路
- 端到端验证所有页面数据展示正确
- 视觉层保持现状，不改动 UI 风格

**Key Constraints:**
- 前端页面结构和组件已存在，仅修复数据层
- 数据源问题根因未知，需要系统性排查
- 保持 API 向后兼容

**Phase Start:** 延续当前编号（上一个 Phase 15）

---
### v1.7: PD Task Manager（已废弃）

**Status:** Superseded — 从未执行，被 v1.9.0 替代

---
*Last updated: 2026-04-08 after v1.9.1 milestone initialized*
