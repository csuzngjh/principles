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

## 4. Attribution (画像更新)
- **Agent Scorecard**: 评估本次使用的子智能体表现，写入 `docs/.verdict.json`。
- **User Profile**: 评估用户指令质量与偏好，写入 `docs/.user_verdict.json`。

## 5. Cleanup
- 清理所有中间标记文件（如 `.pain_flag`, `.verdict.json` 等）。
