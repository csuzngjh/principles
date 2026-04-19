---
gsd_state_version: 1.0
milestone: v1.21.1
milestone_name: Workflow Funnel Scaffold
status: planning
last_updated: "2026-04-19"
progress:
  total_phases: 2
  completed_phases: 0
  total_plans: 2
  completed_plans: 0
  percent: 0
---

# Project State: Principles (Worktree: fix/pd-pain-signal-mandatory-enforcement)

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** Milestone v1.21.1 — Workflow Funnel Scaffold (PR #370)

## Current Position

Phase: Phase 3 (Core Integration) — In progress
Plan: 03-01, 03-02
Status: Planning
Last activity: 2026-04-19 — Plan B execution; scaffold-only scope confirmed

## Context

**PR #370 scope (Plan B — scaffold, not full SSOT):**
- WorkflowFunnelLoader YAML 加载脚手架完成，warnings 已接入 metadata
- RuntimeSummaryService funnels Map 未消费（hardcoded 状态）
- 完整 SSOT 延期到 v1.21.2

**YAML 边界:**
- YAML = 漏斗定义配置来源（SSOT 目标，实际为 scaffold）
- event log = 发生事实真相源
- runtime summary = 派生视图（YAML 定义 + event log 数据）

**YAML 无效策略:** 显式 degraded/error 状态，不允许静默 hardcoded fallback

## Key Files

- `src/core/workflow-funnel-loader.ts` — WorkflowFunnelLoader 类（已写好，待接入 runtime）
- `src/service/runtime-summary-service.ts` — 需改造为 YAML 驱动（v1.21.2）
- `src/commands/evolution-status.ts` — /pd-evolution-status 展示层
- `.planning/phases/02-workflow-watchdog/workflows.yaml` — YAML SSOT（目标）

## Next

**Command:** `/gsd-execute-phase 3` (after Plan B docs complete)

---

*Last updated: 2026-04-19 after Plan B scope correction*
