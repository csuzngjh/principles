---
gsd_state_version: 1.0
milestone: v1.21.1
milestone_name: — Workflow Funnel Runtime Integration
status: planning
last_updated: "2026-04-19T02:11:03.747Z"
last_activity: "2026-04-19 — Roadmap defined (2 phases: 3-4)"
progress:
  total_phases: 39
  completed_phases: 31
  total_plans: 72
  completed_plans: 76
  percent: 100
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** Milestone v1.21.1 — Workflow Funnel Runtime Integration

## Current Position

Phase: Phase 3 (Core Integration) — Not started
Plan: —
Status: Planning complete
Last activity: 2026-04-19 — Roadmap defined (2 phases: 3-4)

## Milestone Progress

| Phase | Name | Requirements | Status |
|-------|------|-------------|--------|
| 3 | Core Integration | 8 | Not started |
| 4 | Testing & Validation | 7 | Not started |

**Coverage:** 15/15 requirements mapped ✓

## Context

**YAML 边界:**

- YAML = 漏斗定义真相源
- event log = 发生事实真相源
- runtime summary = 派生视图（YAML 定义 + event log 数据）

**YAML 无效策略:** 显式 degraded/error 状态，不允许静默 hardcoded fallback

## Key Files

- `src/core/workflow-funnel-loader.ts` — WorkflowFunnelLoader 类（已写好，待接入 runtime）
- `src/core/paths.ts` — WORKFLOWS_YAML 需加入 PD_FILES
- `src/service/runtime-summary-service.ts` — 需改造为 YAML 驱动
- `src/commands/evolution-status.ts` — /pd-evolution-status 展示层

## Next

**Command:** `/gsd-plan-phase 3`

---

*Last updated: 2026-04-19 after roadmap created*
