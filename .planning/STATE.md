---
gsd_state_version: 1.0
milestone: v2.7
milestone_name: M8 — Pain Signal → Principle Single Path Cutover
status: Defining requirements
last_updated: "2026-04-28T00:10:06.464Z"
last_activity: 2026-04-27 — Milestone v2.7 M8 started
progress:
  total_phases: 73
  completed_phases: 63
  total_plans: 128
  completed_plans: 135
  percent: 100
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.7 M8 — m8-01 SHIPPED, m8-02 planned (executing)

## Current Position

Phase: m8-02 (PainSignalBridge E2E + Auto-Intake Enable)
Plan: 2 plans in 2 waves
Status: Ready to execute
Last activity: 2026-04-28 — m8-02 planned

## M8 Pipeline (single path, no fallback)

pain → PD task/run store → DiagnosticianRunner → OpenClawCliRuntimeAdapter → DiagnosticianOutputV1 → SqliteDiagnosticianCommitter → principle_candidates → CandidateIntakeService → PrincipleTreeLedger probation entry

## M8 约束

1. Legacy deletion 只针对旧诊断执行路径，不删除无关的 evolution-worker 功能
2. M8 成功标准：链路终点必须是 PrincipleTreeLedger probation entry
3. Candidate intake 是 happy path 的一部分

## Context

**M8 依赖：** M7 (Candidate Intake 已完成)

**M8 非目标：**

- 不保留旧诊断开关
- 不做 legacy fallback
- 不删除 sleep reflection / keyword optimization 等非诊断功能（仅服务于旧诊断链路的才删）

**Baseline (Frozen):**

- v2.0 M1: Foundation Contracts — SHIPPED 2026-04-21
- v2.1 M2: Task/Run State Core — SHIPPED 2026-04-22
- v2.2 M3: History Retrieval + Context Build — SHIPPED 2026-04-23
- v2.3 M4: Diagnostician Runner v2 — SHIPPED 2026-04-23
- v2.4 M5: Unified Commit + Principle Candidate Intake — SHIPPED 2026-04-24
- v2.5 M6: Production Runtime Adapter — SHIPPED 2026-04-25
- v2.6 M7: Principle Candidate Intake — SHIPPED 2026-04-27

**Canonical source:** `packages/principles-core/src/runtime-v2/`
