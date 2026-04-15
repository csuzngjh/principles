# Phase 40: LLM Discovery - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-14
**Phase:** 40-llm-discovery
**Areas discussed:** Mutation application, Trigger wiring, LLM input data, Feedback integration

---

## Mutation Application

| Option | Description | Selected |
|--------|-------------|----------|
| A: evolution-worker.ts 直接调用 | Worker 读取结果后直接调用 add/update/remove | |
| B: KeywordOptimizationService | 独立服务，解耦，测试方便 | ✓ |
| C: Workflow manager persistResult | 自包含 | |

**User's choice:** B — KeywordOptimizationService
**Notes:** 解耦优先，evolution-worker.ts 不直接操作 CorrectionCueLearner

---

## Trigger Wiring

| Option | Description | Selected |
|--------|-------------|----------|
| A: 新增 keyword_optimization task type | 职责清晰，独立配置 | ✓ |
| B: 复用 sleep_reflection handler | 改动小但逻辑混杂 | |
| C: 独立 scheduleNextOptimization 循环 | 完全解耦但增加复杂度 | |

**User's choice:** A — 新增 task type，keyword_optimization 独立
**Notes:** 保持 keyword_optimization 与 sleep_reflection 解耦

---

## LLM Input Data

| Option | Description | Selected |
|--------|-------------|----------|
| A: keywordStoreSummary + recentMessages（现状） | 简单，LLM 能推断 | |
| B: + trajectory 历史（correctionDetected 记录） | LLM 知道真实触发频率 | ✓ |
| C: + 每次 correction 后的用户反馈 | 最准确但需要 feedback 记录未实现 | |

**User's choice:** B — trajectory 历史加入 payload
**Notes:** trajectory.listUserTurnsForSession() 已返回 correctionDetected，KeywordOptimizationService 读取并传给 LLM

---

## Feedback Integration

| Option | Description | Selected |
|--------|-------------|----------|
| A: 用户显式否定时立即调用 | 简单直接，可能误判 | |
| B: trajectory 回放时推断 | 更准确但需要回放逻辑 | |
| C: LLM 优化时自动判断 | 全自动 | ✓ |
| D: prompt.ts 中 correction 匹配后立即调用 + 确认满意信号 | 在 prompt.ts 中立即调用 recordFalsePositive()，用户继续正常对话 N 轮后调用 recordTruePositive() | |

**User's choice:** D — prompt.ts 中 correction 匹配后立即调用 + 确认满意信号
**Notes:** 需要定义"确认满意"的窗口（N 轮无 further correction cues）

---

## Deferred Ideas

- recordTruePositive() 确认窗口的精确 N 值（实现时决定）
- CORR-12 trajectory flag 已部分实现，新工作是让 LLM 能访问这些数据

