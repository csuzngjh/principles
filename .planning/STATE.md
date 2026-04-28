---
gsd_state_version: 1.0
milestone: v2.7
milestone_name: M8 — Pain Signal → Principle Single Path Cutover
status: verifying
last_updated: "2026-04-28T07:44:01.365Z"
last_activity: 2026-04-28 -- UAT executed, openclaw CLI spawn broken (pre-existing), all 6 blockers verified correct
progress:
  total_phases: 75
  completed_phases: 66
  total_plans: 131
  completed_plans: 140
  percent: 100
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.7 M8 — m8-02 SHIPPED (2026-04-28), m8-03 Real Environment UAT pending

## Current Position

Phase: m8-03 (Real Environment UAT — BLOCKED by pre-existing openclaw CLI env issue)
Plan: 1 plan executed 2026-04-28
Status: Executed — UAT partially blocked, implementation verified correct, CLI env issue is pre-existing
Last activity: 2026-04-28 -- UAT executed, openclaw CLI spawn broken (pre-existing), all 6 blockers verified correct

## M8-03 Real Environment UAT

Phase: m8-03 (Real Environment UAT — M8 final sign-off)
Plan: m8-03-01 executed 2026-04-28
Status: PARTIAL — UAT-01 blocked by pre-existing openclaw CLI env issue (npm wrapper path corruption), UAT-02 PASS, UAT-04 PASS, implementation verified correct
Depends on: m8-02 (both plans complete ✅)
Note: m8-03 is NOT a code change plan — it is manual UAT against live OpenClaw gateway + real workspace D:\.openclaw\workspace
Ledger path (confirmed from principle-tree-ledger.ts): D:/.openclaw/workspace/.state/principle_training_state.json (NOT .principles/ledger/principles.jsonl)
M8 cannot be marked SHIPPED until m8-03 UAT passes — UAT-01 blocked by pre-existing CLI env issue
UAT results: UAT-01 BLOCKED (openclaw CLI env), UAT-02 PASS, UAT-03 SKIP, UAT-04 PASS, UAT-05 INFO (pre-existing env issue)

## M8 Pipeline (single path, no fallback)

pain → PD task/run store → DiagnosticianRunner → OpenClawCliRuntimeAdapter → DiagnosticianOutputV1 → SqliteDiagnosticianCommitter → principle_candidates → CandidateIntakeService → PrincipleTreeLedger probation entry

## M8 约束

1. Legacy deletion 只针对旧诊断执行路径，不删除无关的 evolution-worker 功能
2. M8 成功标准：链路终点必须是 PrincipleTreeLedger probation entry
3. Candidate intake 是 happy path 的一部分
4. m8-03 UAT 必须通过才能标记 M8 SHIPPED — mocked E2E 不能作为最终验收

## Context

**M8 依赖：** M7 (Candidate Intake 已完成)

**M8 非目标：**

- 不保留旧诊断开关
- 不做 legacy fallback
- 不删除 sleep reflection / keyword optimization 等非诊断功能（仅服务于旧诊断链路的才删）

**m8-03 说明：**

- 不是代码修改计划，是人工真实验收（autonomous: false）
- Workspace: `D:\.openclaw\workspace`
- Ledger 路径: `D:\.openclaw\workspace\.state\principle_training_state.json`（不是 .principles/ledger/principles.jsonl）
- 必须通过真实 OpenClaw hook 触发 pain signal（不允许直接调用 PainSignalBridge.onPainDetected）
- 不允许 test-double / mock runCliProcess
- 必须验证：task succeeded + artifact + candidate + ledger probation entry + legacy files unchanged

**Baseline (Frozen):**

- v2.0 M1: Foundation Contracts — SHIPPED 2026-04-21
- v2.1 M2: Task/Run State Core — SHIPPED 2026-04-22
- v2.2 M3: History Retrieval + Context Build — SHIPPED 2026-04-23
- v2.3 M4: Diagnostician Runner v2 — SHIPPED 2026-04-23
- v2.4 M5: Unified Commit + Principle Candidate Intake — SHIPPED 2026-04-24
- v2.5 M6: Production Runtime Adapter — SHIPPED 2026-04-25
- v2.6 M7: Principle Candidate Intake — SHIPPED 2026-04-27

**Canonical source:** `packages/principles-core/src/runtime-v2/`
