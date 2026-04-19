---
gsd_state_version: 1.0
milestone: v1.21.1
milestone_name: Workflow Funnel Runtime Integration
status: Defining requirements
last_updated: "2026-04-19"
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** Milestone v1.21.1 — Workflow Funnel Runtime Integration

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-04-19 — Milestone v1.21.1 started

## Context

**YAML 边界:**
- YAML = 漏斗定义真相源
- event log = 发生事实真相源
- runtime summary = 派生视图（YAML 定义 + event log 数据）

**YAML 无效策略:** 显式 degraded/error 状态，不允许静默 hardcoded fallback

## Key Files

- `src/core/workflow-funnel-loader.ts` — WorkflowFunnelLoader 类（已写好，待接入 runtime）
- `src/service/runtime-summary-service.ts` — 需改造为 YAML 驱动
- `src/commands/evolution-status.ts` — /pd-evolution-status 展示层
- `.planning/phases/02-workflow-watchdog/workflows.yaml` — YAML SSOT

## Next

**Command:** `/gsd-plan-phase 2` (since Phase 1 from v1.21 already covered the design doc)
