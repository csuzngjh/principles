---
title: 类别对照 | Principles Disciple
description: PD 与 AI Memory、Prompt Engineering、Agent Skills、Guardrails、规则引擎、自主自我改进的关系。不同工具解决不同问题——PD 是一个 AI Agent 行为治理系统，以行为治理运行时的方式工作。
---

# PD 与相邻类别的关系

不同工具解决不同问题。本页不是排名——下面每个类别都各自解决好自己的问题；这里只是说明各自的位置，以及 PD 的位置。

Principles Disciple 是一个 **AI Agent 行为治理系统**。在技术上，它是一个 **行为治理运行时（Agent Governance Runtime）**：捕捉行为证据，沉淀经 Owner 审批的原则，并通过多个治理通道加以应用。

## PD 与 AI Memory

> Memory：存储信息——*「发生了什么？」*
> PD：治理行为——*「因为发生了什么，行为应该改变什么？」*

Memory 系统存储和检索信息：对话记录、偏好、事实。PD 把验证过的行为经验转化为经 Owner 审批、能改变 Agent 下次行为的原则。两者互补；会话记忆仍由宿主负责。

## PD 与 Prompt Engineering

> Prompt：提供指令——执行之前。
> PD：治理行为改进——执行之后。

Prompt 工程在执行前提供指令；PD 帮助 Agent 从执行后的真实经验中发展出可复用的行为原则——并通过多个治理通道应用，而不只是文字。两者都在塑造行为，只是作用于不同时刻、不同层面。

## PD 与 Agent Skills

> Skills：提供能力。
> PD：治理能力应当如何使用。

Skills 扩展 Agent 能做什么——新工具、新能力。PD 在 Owner 权威下治理 Agent 做事过程中的行为方式。两者天然可组合：Skills 增加能力，PD 对齐行为。

## PD 与 Guardrails

> Guardrails：阻止不想要的行为。
> PD：帮助定义期望的行为模式。

Guardrails 主要防止不想要的行为——围绕「什么不可以发生」筑起围栏。PD 工作在正向一侧：把验证过的经验转化为经 Owner 审批的原则，描述 Agent *应该*如何行为，且内建审查与可回滚。Guardrails 回答「什么被禁止」；PD 回答「什么应该成为习惯」。

## PD 与规则引擎（Rule Engine）

> 规则引擎：预定义的条件触发预定义的动作。
> PD：经验成为原则；原则治理未来行为。

规则引擎执行的是事先写好的映射：条件 X 匹配，动作 Y 触发。这个循环里没有任何学习。PD 工作在任何规则的上游：它把真实行为经验转化为经 Owner 审批的原则——而在某条底线必须被强制执行时，这些原则可以经过审查、影子试运行和显式审批，硬化为可执行的规则。规则是部分原则的执行方式，不是 PD 的起点。

## PD 与自主自我改进

> 自我改进型 Agent：自行决定变更。
> PD：Owner 决定，系统提案。

在 PD 中，每条原则提案都要经过 Owner 审查才能激活，每次激活都可回滚。改进基于经验；治理始终属于 Owner。

## 一句话总结

Memory 存储，Prompt 指令，Skills 扩展，Guardrails 设栏，规则引擎执行固定映射。PD 治理行为改进——把反复纠正转化为经 Owner 审批、可审查、可回滚的行为原则，并通过多个治理通道应用。

另见[常见问题](/zh/faq)。
