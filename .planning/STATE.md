---
gsd_state_version: 1.0
milestone: v1.21.2
milestone_name: YAML Funnel 完整 SSOT
status: Defining requirements
last_updated: "2026-04-19T17:00:00.000Z"
last_activity: 2026-04-19 — Milestone v1.21.2 started
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State: Principles (Worktree: fix/pd-pain-signal-mandatory-enforcement)

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** Milestone v1.21.2 — YAML Funnel 完整 SSOT

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-04-19 — Milestone v1.21.2 started

## Context

**v1.21.1 完成情况（PR #370 / PR #375）：**
- WorkflowFunnelLoader scaffold 完成，warnings 已接入 metadata
- diagnosticianReportsWritten legacy compat 修复（PR #375）
- RuntimeSummaryService funnels Map 未消费（hardcoded 状态）→ v1.21.2 目标

**v1.21.2 scope：**
- RuntimeSummaryService.getSummary() 接受 funnels Map，YAML funnel 定义构建 workflowFunnels 输出
- evolution-status.ts 调用 loader.getAllFunnels()，不再 hardcoded nocturnal/rulehost 漏斗
- statsField 缺失时 count=0 + warning 可见
- YAML 缺失/非法时 degraded，不静默 fallback

## Key Files

- `src/core/workflow-funnel-loader.ts` — WorkflowFunnelLoader 类（已完成）
- `src/service/runtime-summary-service.ts` — 需改造为 YAML 驱动
- `src/commands/evolution-status.ts` — /pd-evolution-status 展示层
- `.planning/phases/02-workflow-watchdog/workflows.yaml` — YAML SSOT

## Next

**Command:** `/gsd-plan-phase 1`（skip discuss，直接 planning）

---

*Last updated: 2026-04-19 after v1.21.2 milestone started*
