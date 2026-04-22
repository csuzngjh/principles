---
gsd_state_version: 1.0
milestone: v2.2
milestone_name: M3 History Retrieval + Context Build
status: in_progress
last_updated: "2026-04-22T16:00:00.000Z"
last_activity: 2026-04-22 — Milestone v2.2 M3 started
progress:
  total_phases: 5
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.2 M3 History Retrieval + Context Build — IN PROGRESS

## Current Position

Phase: Not started (requirements definition)
Status: Defining requirements
Last activity: 2026-04-22 — Milestone v2.2 M3 started

## Context

**v2.2 M3 Goal:** Deliver PD-owned retrieval pipeline — trajectory locate, history query, context build

**M3 边界约束（守住边界）:**
- 只做 trajectory locate / history query / context build
- 不做 diagnostician runner（M4）
- 不做 unified commit（M5）
- 不把宿主 API 直接重新带回主设计里
- **Authoritative boundary:** 所有 authoritative retrieval 必须以 PD-owned stores/indexes/references 为主源；OpenClaw raw workspace/session 文件不是 authoritative retrieval source
- **No LLM in context build:** context assembly 必须 code-generated 或 template-generated，禁止在 context build 过程中调用 LLM

**M3 Exit Criteria:**
1. `pd trajectory locate` — locate a specific trajectory by ID or criteria
2. `pd history query` — bounded historical retrieval independent of host-specific access
3. `pd context build` — assemble diagnostician-ready context from PD-owned retrieval
4. Workspace isolation: context never leaks across workspaces
5. Degradation policy: graceful fallback when history is incomplete
6. Degraded mode: no crashes, only warnings, task can still proceed

**Canonical source:** `packages/principles-core/src/runtime-v2/`

**Previous:** v2.1 M2 Task/Run State Core — SHIPPED 2026-04-22
