---
gsd_state_version: 1.0
milestone: v2.2
milestone_name: M3 History Retrieval + Context Build
status: in_progress
last_updated: "2026-04-22T10:48:18Z"
last_activity: 2026-04-22 — m3-01-01 TrajectoryLocator complete (3/3 tasks, 17 tests passing)
progress:
  total_phases: 5
  completed_phases: 1
  total_plans: 1
  completed_plans: 1
  percent: 20
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.2 M3 History Retrieval + Context Build — IN PROGRESS

## Current Position

Phase: m3-01 TrajectoryLocator (complete)
Status: m3-01-01 complete — 3 tasks, 3 commits, 17 tests passing
Last activity: 2026-04-22 — TrajectoryLocator interface + SqliteTrajectoryLocator + test suite

## Context

**v2.2 M3 Goal:** Deliver PD-owned retrieval pipeline — trajectory locate, history query, context build

**m3-01 Complete:**
- TrajectoryLocator interface with locate() method
- SqliteTrajectoryLocator with 6 locate modes (painId, taskId, runId, timeRange, sessionId+workspace, executionStatus)
- 17 tests covering all modes, confidence levels, edge cases
- executionStatus field added to TrajectoryLocateQuerySchema (stretch)

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

**Decisions:**
- sessionId locate mode returns all trajectories in workspace DB with confidence=0.5 (sessionId is not a DB column)
- executionStatus added as optional field to TrajectoryLocateQuerySchema for stretch locate mode
- routeQuery pattern used to satisfy init-declarations lint rule

**Canonical source:** `packages/principles-core/src/runtime-v2/`

**Previous:** v2.1 M2 Task/Run State Core — SHIPPED 2026-04-22
