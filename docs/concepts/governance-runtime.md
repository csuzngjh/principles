# Agent Governance Runtime — PD 的技术定位

> Technical positioning page for Principles Disciple.
> Companion to [`pd-canonical-definition.md`](pd-canonical-definition.md); code evidence in [`../audit/governance-runtime-map.md`](../audit/governance-runtime-map.md).
> 中文版见文末。

---

# Agent Governance Runtime

Principles Disciple is an AI Agent Governance System. Its technical positioning is an **Agent Governance Runtime**: a layer inside the agent's host that turns behavioral experience into owner-approved principles and applies them through multiple governance channels.

## Problem

The traditional correction loop loses context every time:

```
Human correction

↓

Temporary improvement

↓

Context lost

↓

Same mistake again
```

Prompt files and session memory do not close this loop. Instructions written before execution cannot learn from what actually happened after execution.

## The PD loop

```
Behavior evidence

↓

Principle extraction

↓

Owner approval

↓

Governance runtime

↓

Future behavior improvement
```

Evidence comes from real agent behavior. The system proposes principles; the Owner approves, rejects, or defers each one. Approved principles are applied by the governance runtime — and every application stays observable and reversible.

## Governance channels

PD does not rely on a single mechanism. Active principles reach the agent through multiple channels:

| Channel | What it does | Governance type |
|---|---|---|
| Prompt directives | Injects owner-approved principles into the agent's context so it considers better approaches | Soft (cognitive guidance) |
| Runtime hooks | Owner-promoted rules participate in tool-call decisions: block, require approval, or correct parameters | Hard (execution governance) |
| Ledger / archive | Records deferred and archived principles with full history | Bookkeeping |

Two safety properties hold across all channels:

- **Shadow-first**: rules with execution power start in observation-only mode. Only the Owner can promote a rule to live enforcement.
- **Fail-open**: if PD itself fails, the host agent keeps working. PD governs behavior; it never becomes a single point of failure.

## Why this is not prompt engineering

Prompt engineering provides instructions before execution. PD focuses on transforming experience after execution into reusable governance principles — then applies them through the runtime, not only through text.

A prompt tells the agent what to do once. A governance runtime closes the loop: evidence in, owner decision, runtime application, observation, revision.

## What the runtime never does

- It does not modify model weights or train models.
- It does not let the agent decide its own values — every principle passes owner approval.
- It does not replace the Owner — the system proposes, the Owner decides.
- It does not take over the host — every channel fails open.

---

# 中文版

## 什么是 Agent Governance Runtime（行为治理运行时）

Principles Disciple 是一个 AI Agent 行为治理系统，其技术定位是 **Agent 行为治理运行时**：位于 Agent 宿主之内的一层，把行为经验转化为经 Owner 审批的原则，并通过多个治理通道加以应用。

## 问题

传统的纠正方式每次都在丢失上下文：

```
人工纠正

↓

暂时改善

↓

上下文丢失

↓

同一个错误再次发生
```

提示词文件和会话记忆都无法闭合这个循环：执行前写下的指令，无法从执行后实际发生的事情中学习。

## PD 的循环

```
行为证据

↓

原则提炼

↓

Owner 审批

↓

治理运行时

↓

未来行为改进
```

证据来自 Agent 的真实行为。系统提出原则提案；Owner 逐条审批、驳回或暂存。通过审批的原则由治理运行时应用——每次应用都可观察、可回滚。

## 治理通道

PD 不依赖单一机制。激活的原则通过多个通道触达 Agent：

| 通道 | 作用 | 治理类型 |
|---|---|---|
| 提示词指令 | 把 Owner 审批过的原则注入 Agent 上下文，使其考虑更好的做法 | 软（认知引导） |
| 运行时钩子 | 经 Owner 提升的规则参与工具调用决策：阻止、转审批、修正参数 | 硬（执行治理） |
| 台账 / 归档 | 记录暂存与归档的原则及完整历史 | 记录 |

所有通道共同遵守两条安全属性：

- **Shadow 起步**：拥有执行权的规则先以仅观察模式运行，只有 Owner 能将其提升为 live 执行。
- **Fail-open**：PD 自身故障时，宿主 Agent 照常工作。PD 治理行为，但绝不成为单点故障。

## 为什么这不是 Prompt 工程

Prompt 工程在执行前提供指令；PD 把执行后的经验转化为可复用的治理原则——并通过运行时应用，而不只是文字。

提示词只告诉 Agent 一次该怎么做。治理运行时闭合整个循环：证据进入、Owner 决策、运行时应用、观察、修正。

## 运行时永远不会做的事

- 不修改模型权重、不训练模型。
- 不让 Agent 自行决定价值观——每条原则都经 Owner 审批。
- 不取代 Owner——系统提案，Owner 决定。
- 不接管宿主——所有通道 fail-open。
