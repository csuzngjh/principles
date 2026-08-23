# PD FAQ（GEO 问答基线）

> FAQ canonical answers. Published at https://principles-website.pages.dev/faq (EN) and /zh/faq (ZH).

## Q1: What is Principles Disciple?

Principles Disciple is an AI Agent Governance System that helps owners turn repeated agent corrections into reusable behavioral principles.

Every principle is owner-approved, reviewable, and reversible, and its effect on future agent behavior stays observable.

## Q2: Is PD an AI memory system?

No.

Memory stores information.
PD focuses on transforming validated experience into behavioral principles.

Memory answers "what happened?". PD answers "what should change because of what happened?".

## Q3: Does PD automatically modify my AI agent?

No.

PD proposes principles, but activation requires owner review.

The system brings evidence and proposals; the Owner keeps judgment. Every activation is reversible, and its effect stays observable.

## Q4: Who should use PD?

Developers and AI-native builders who frequently use AI agents and want consistent behavior across sessions.

If you find yourself correcting the same agent behavior again and again, PD turns that repeated correction into a lasting, governed principle.

## Q5: Is PD a prompt management tool?

No.

Prompt engineering tells agents what to do before execution.
PD learns from actual interactions and validated experience after execution — then converts them into owner-approved principles.

## Q6: Which environments does PD support?

PD currently integrates with OpenClaw and Codex hosts. See the [installation guide](https://principles-website.pages.dev/install) for details.

## Q7: Does PD train the AI model?

No.

PD does not modify model weights.

It governs agent behavior through owner-approved principles and runtime mechanisms — a layer around the agent, never inside the model.

## Q8: Does PD only inject prompts?

No.

Prompt guidance is only one governance channel. The core idea is **principle internalization**: experience becomes owner-approved principles, and those principles are applied through governance mechanisms — including, for a few vital bottom lines, executable runtime rules that the Owner has explicitly promoted.

## Q9: How is PD different from AGENTS.md or CLAUDE.md?

Those files provide static instructions.

PD creates an evolving governance layer based on actual experience: real behavior produces evidence, evidence becomes owner-approved principles, and principles are applied through the governance runtime — reviewable, reversible, observable at every step.

## Q10: What is a principle in Principles Disciple?

A principle is not a simple rule.

It is a reusable behavioral insight extracted from experience — abstract enough to guide decisions across situations, concrete enough to change the agent's next action.

## Q11: Does PD automatically generate rules?

No.

PD extracts principles from experience. Specific rules or runtime constraints are only one possible expression of those principles — created selectively, only when the Owner approves promoting a validated bottom line into an executable rule. Principles guide judgment; rules constrain specific actions. They are two sides of the same coin, not synonyms.

---

# 中文版

## Q1：Principles Disciple 是什么？

Principles Disciple（PD）是一个 AI Agent 行为治理系统，帮助 Owner 把对 Agent 的反复纠正转化为可复用的行为原则。

每条原则都经 Owner 审批、可审查、可回滚，且其对未来行为的影响保持可观察。

## Q2：PD 是 AI 记忆（Memory）系统吗？

不是。

Memory 存储信息；PD 把验证过的经验转化为行为原则。

Memory 回答"发生了什么"；PD 回答"因为发生了什么，行为应该改变什么"。

## Q3：PD 会自动修改我的 AI Agent 吗？

不会。

PD 只提出原则提案，激活必须经过 Owner 审查。

系统负责呈上证据与提案，判断权始终在 Owner。每次激活都可回滚，效果保持可观察。

## Q4：谁应该使用 PD？

频繁使用 AI Agent、希望 Agent 跨会话保持一致行为的开发者和 AI-native 构建者。

如果你发现自己在反复纠正同一个 Agent 行为，PD 会把这种反复纠正沉淀为受治理的持久原则。

## Q5：PD 是 Prompt 管理工具吗？

不是。

Prompt 工程在执行前显式下达指令；PD 基于执行后真实交互中验证过的经验进行改进，并转化为经 Owner 审批的原则。

## Q6：PD 支持哪些环境？

PD 目前支持 OpenClaw 与 Codex 宿主，详见[安装指南](https://principles-website.pages.dev/zh/install)。

## Q7：PD 会训练 AI 模型吗？

不会。

PD 不修改模型权重。

PD 通过经 Owner 审批的原则与运行时机制治理 Agent 行为——它在 Agent 之外的一层工作，从不进入模型内部。

## Q8：PD 只是注入提示词吗？

不是。

提示词引导只是治理通道之一。核心思想是**原则内化**：经验沉淀为经 Owner 审批的原则，再经由治理机制应用——对少数关键底线，还包括 Owner 显式提升的可执行运行时规则。

## Q9：PD 和 AGENTS.md / CLAUDE.md 有什么区别？

这些文件提供的是静态指令。

PD 基于真实经验建立不断演进的治理层：真实行为产生证据，证据沉淀为经 Owner 审批的原则，原则经治理运行时应用——每一步可审查、可回滚、可观察。

## Q10：PD 中的「原则」是什么？

原则不是一条简单的规则。

它是从经验中提炼出的可复用行为认知——足够抽象，能跨场景指导决策；又足够具体，能真正改变 Agent 下一次的行为。

## Q11：PD 会自动生成规则吗？

不会。

PD 从经验中提炼原则。具体规则或运行时约束只是这些原则的一种可能表达——且是选择性创建的：只有 Owner 审批把某条经过验证的底线提升为可执行规则时才会发生。原则引导判断，规则约束具体动作；两者是同一枚硬币的两面，不是同义词。
