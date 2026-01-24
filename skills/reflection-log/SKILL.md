---
name: reflection-log
description: Final task reflection and evolution logging. Use to capture pain signals, update profiles, and propose new principles.
disable-model-invocation: true
---

# Reflection & Evolution (反思与落盘)

**目标**: 将单次任务的经验转化为系统的永久记忆。

请执行以下结项操作：

## 1. Pain Summary (痛苦摘要)
- 简述本次任务中最折磨、最耗时或导致失败的点。

## 2. Issue Logging
- **Action**: 将详细的 Pain Signal 和诊断结果追加到 `docs/ISSUE_LOG.md`。

## 3. Evolution Candidates
- **Principle**: 提议一条新原则（P-XX）。
- **Guardrail**: 建议一个具体的 Hook、Rule 或 Test。**必须**输出可执行的配置建议（例如：将 `xxx` 路径加入 `risk_paths` 或在 `danger_op_guard.sh` 中增加对 `yyy` 命令的匹配）。

## 4. Positive Reinforcement (正向强化)
- **检查卓越信号**: 
  1. 用户明确的赞赏 (Quote user).
  2. 性能/质量指标的客观跃迁 (Cite data).
  3. Reviewer 的高度评价 (Excellent/Elegant).
- **提取模式**: 如果存在上述信号，在 `docs/.user_verdict.json` 中额外记录 `achievement` 字段，描述本次成功的行为模式。

## 5. Attribution (画像更新)
- **Agent Scorecard**: 评估本次使用的子智能体表现，写入 `docs/.verdict.json`。格式遵循 `@docs/schemas/agent_verdict_schema.json`。
- **User Profile**: 评估用户指令质量与偏好，写入 `docs/.user_verdict.json`。格式遵循 `@docs/schemas/user_verdict_schema.json`。

## 6. Cleanup
- 清理所有中间标记文件（如 `.pain_flag`, `.verdict.json` 等）。
