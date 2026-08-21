---
title: 常见问题 | Principles Disciple
description: Principles Disciple（PD）是什么？是 AI 记忆系统吗？会自动修改你的 Agent 吗？关于这个 AI Agent 行为治理系统的常见问题解答。
---

# 常见问题

## Principles Disciple 是什么？

Principles Disciple（PD）是一个 **AI Agent 行为治理系统**，帮助 Owner 把对 Agent 的反复纠正转化为可复用的行为原则。

每条原则都经 Owner 审批、可审查、可回滚，且其对未来 Agent 行为的影响保持可观察。

## PD 是 AI 记忆（Memory）系统吗？

不是。

Memory 存储信息；PD 把验证过的经验转化为行为原则。

Memory 回答*"发生了什么？"*；PD 回答*"因为发生了什么，行为应该改变什么？"*。参见 [PD vs AI Memory](/zh/comparisons)。

## PD 会自动修改我的 AI Agent 吗？

不会。

PD 只提出原则提案，激活必须经过 Owner 审查。

系统负责呈上证据与提案，判断权始终在 Owner。每次激活都可回滚，效果保持可观察。

## 谁应该使用 PD？

频繁使用 AI Agent、希望 Agent 跨会话保持一致行为的开发者和 AI-native 构建者。

如果你发现自己在反复纠正同一个 Agent 行为，PD 会把这种反复纠正沉淀为受治理的持久原则。

## PD 是 Prompt 管理工具吗？

不是。

Prompt 工程在执行前显式下达指令；PD 基于执行后真实交互中验证过的经验进行改进，并转化为经 Owner 审批的原则。参见 [PD vs Prompt Engineering](/zh/comparisons)。

## PD 支持哪些环境？

PD 目前支持 OpenClaw 与 Codex 宿主，详见[安装指南](/zh/install)。

## 在哪里可以看到完整的产品定义？

见仓库中的[规范定义文档](https://github.com/csuzngjh/principles/blob/main/docs/concepts/pd-canonical-definition.md)，或[对照页面](/zh/comparisons)了解 PD 与相邻类别的边界。
