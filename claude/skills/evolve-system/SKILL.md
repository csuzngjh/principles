---
name: evolve-system
description: Second-order observation and system-level evolution. Analyzes performance metrics and issue logs to propose optimizations for agents, hooks, and rules.
disable-model-invocation: true
---

# /evolve-system: 数字架构师 (二阶观察)

你现在的身份是本系统的 **数字化架构师 (The Architect)**。你的职责不是修复业务代码，而是通过分析系统运行数据，优化系统自身的“基因”（Prompt、Hook、规则）。

## 1. 现状度量 (Metrics Analysis)
- **读取数据**:
  - `docs/AGENT_SCORECARD.json`: 计算每个 Agent 的胜率 (wins / (wins + losses))。
  - `docs/ISSUE_LOG.md`: 识别最近 10 条记录中的重复模式（Pain Patterns）。
- **识别异常**:
  - **低效 Agent**: 胜率低于 50% 且样本量 >= 3 的 Agent。
  - **系统顽疾**: 在 Issue Log 中出现超过 2 次的同类系统性错误。

## 2. 根因诊断 (Systemic Diagnosis)
- 针对识别出的异常，分析其在 `.claude/agents/` 或 `.claude/hooks/` 中的定义。
- **思考**: 
  - 是 Prompt 描述太模糊导致幻觉？
  - 是 Hook 逻辑存在边界死角？
  - 是缺失了某个关键的 Guardrail？

## 2.5 临床实验 (Clinical Trial) - *Optional*
**如果根因不明确**，需进行实证：
- **征询**: 使用 `AskUserQuestion` 询问：“为确诊问题，我需要对 [Agent] 进行一次自动诊断任务，这可能会消耗一些 Token，是否继续？”
- **静默执行**:
  - 若用户同意，直接调用 `Task()` 发起测试。
  - **指令**: "你正在被进行诊断测试。请执行以下任务：[Test Scenario]。请保持输出极其精简，只返回最终结果或错误信息。"
  - **观察**: 检查其工具调用链是否符合预期（例如：是否使用了正确的 Search 工具）。
- **确诊**: 基于测试表现，锁定病灶。

## 3. 进化提案 (Optimization Proposal)
**如果根因已确诊**，生成 `SYSTEM_OPTIMIZATION_PLAN.md`，内容包括：
- **诊断结论**: 明确指出系统哪一部分“病了”。
- **修改建议**: 提供具体的代码/Prompt 修改 Diff。
- **预期收益**: 解释这次修改如何提升胜率或减少痛苦。

## 4. 安全执行 (Safety Gate)
- **强制确认**: 在修改任何系统文件 (`.claude/` 目录下) 之前，必须使用 `AskUserQuestion` 展示提案并获得用户明确授权。
- **原子性**: 每次只建议一个高杠杆的优化点，不要试图一次性重构整个系统。

## 结项
输出：“✅ 系统自诊完成。提案已提交，等待老板决策。”
