# PD Canonical Definition — 官方语义模型

> This is the single source of truth for how Principles Disciple defines itself.
> All website copy, READMEs, marketplace descriptions, and docs MUST align with this definition.
> 中文版见文末。

---

## What is PD?

```
Principles Disciple is an AI Agent Governance System.

It helps AI agent owners transform repeated corrections and behavioral evidence into owner-approved principles that improve future agent behavior.
```

Technical positioning (how PD does it — one layer below the category):

```
Principles Disciple is an Agent Governance Runtime.

It helps owners capture behavioral evidence,
evolve owner-approved principles,
and apply them through multiple governance channels.
```

Secondary definition (equivalent, more precise):

```
Owner-governed Agent Behavior Internalization System
```

The category names the product class; the runtime positioning names how PD operates inside the agent's host. Both layers must appear together on surfaces that explain "how it works".

## What problem does PD solve?

```
AI agents often repeat the same mistakes across sessions.

PD captures these repeated corrections, extracts reusable principles, and allows owners to review and activate them.
```

## PD is not a prompt system

### Is PD just prompt injection?

```
No.

Prompt injection is only one possible governance channel.

PD does not simply tell agents what to do.

PD captures behavioral evidence,
creates owner-approved principles,
and applies governance through runtime mechanisms.
```

Prompt guidance is the soft channel. PD also has a hard channel: owner-promoted rules can participate in tool-call decisions (block, require approval, or correct parameters). See [`governance-runtime.md`](governance-runtime.md) and the code audit [`../audit/governance-runtime-map.md`](../audit/governance-runtime-map.md).

### How does PD change agent behavior?

PD influences agent behavior through multiple layers:

```
1. Cognitive guidance
   Principles help agents consider better approaches.

2. Runtime governance
   Active principles can participate in execution decisions.

3. Continuous improvement
   Future behavior creates new evidence.
```

## What PD is NOT

### Not AI Memory

```
Memory stores information.
PD governs behavior.
```

Memory answers "what happened?". PD answers "what should change because of what happened?".

### Not Prompt Engineering

```
Prompt engineering tells agents what to do.
PD learns from actual interactions and validated experience.
```

Prompt engineering provides instructions before execution. PD transforms experience after execution into reusable governance principles. Prompt injection is one of PD's channels, not PD itself.

### Not Autonomous Learning

```
PD does not allow agents to independently decide values or modify themselves.
Owner approval remains the authority.
```

The system brings evidence and proposals. The Owner keeps judgment.

### Not a Model Trainer

```
PD does not modify model weights or train models.
```

PD governs behavior at the agent-runtime layer; it never touches the model.

## Core Flow

```
Repeated Correction
        ↓
Behavior Evidence
        ↓
Principle Proposal
        ↓
Owner Review
        ↓
Activation (prompt / runtime hook)
        ↓
Runtime Application
        ↓
Future Behavior Improvement
```

Every step is reviewable; every activation is reversible; every effect stays observable.

### Principles and rules

Principles guide judgment; rules constrain specific actions. They are not synonyms but two sides of the same coin: where repeated experience proves a bottom line must never be forgotten, the Owner can approve hardening a principle into an executable rule at the runtime layer (shadow-tested first, always reversible). PD is not a rule generator — hardening is selective and owner-approved.

## Terminology Baseline

- ✅ Always allowed: AI Agent Governance · Agent Governance Runtime · Owner-governed · Behavior principles · Behavior evidence · Governance channels · Reviewable · Reversible · Experience-based improvement
- ⚠️ Only with qualifying context: Learning · Evolution · Memory · Intelligence
- ❌ Never (public copy): Autonomous self-learning · AI improves itself · Agent develops its own values · Replace human decisions · Trains/fine-tunes the model

## Canonical one-liners (copy-paste for any surface)

- **Category statement (EN):** Principles Disciple is an AI Agent Governance System that turns repeated agent corrections into owner-approved, reviewable, reversible behavior principles.
- **Category statement (ZH):** Principles Disciple（PD）是一个 AI Agent 行为治理系统，把 Owner 对 Agent 的反复纠正转化为经 Owner 审批、可审查、可回滚的行为原则。
- **Runtime positioning (EN):** Principles Disciple is an Agent Governance Runtime: it captures behavioral evidence, evolves owner-approved principles, and applies them through multiple governance channels.
- **Runtime positioning (ZH):** Principles Disciple 是 AI Agent 行为治理运行时：捕捉行为证据，沉淀经 Owner 审批的原则，并通过多个治理通道应用于未来行为。
- **Short:** Owner-governed behavior principles for AI Agents.

---

# 中文版

## PD 是什么？

```
Principles Disciple（PD）是一个 AI Agent 行为治理系统。

它帮助 Agent 的 Owner 把反复出现的纠正与行为证据，转化为经 Owner 审批的原则，从而改进 Agent 未来的行为。
```

技术定位（类别之下一层，说明 PD 如何运作）：

```
Principles Disciple 是 AI Agent 行为治理运行时。

它帮助 Owner 从真实 Agent 行为中发现经验，
沉淀经过审批的原则，
并通过多个治理通道影响未来 Agent 行为。
```

次级定义（等价、更精确）：**Owner 治理的 Agent 行为原则内化系统**。

类别回答"PD 属于哪类产品"；运行时定位回答"PD 在 Agent 宿主内以什么方式工作"。在需要解释"如何做到"的场合，两层应同时出现。

## PD 解决什么问题？

```
AI Agent 经常跨会话重复犯同样的错。

PD 捕捉这些反复纠正，提炼可复用的原则，并由 Owner 审查后激活。
```

## PD 不是提示词系统

### PD 只是提示词注入吗？

```
不是。

提示词注入只是 PD 影响 Agent 的一种方式。

PD 的核心不是添加指令，
而是从真实行为中形成可治理原则。
```

提示词引导是软通道。PD 还有硬通道：经 Owner 提升的规则可以参与工具调用决策（阻止、转审批、修正参数）。详见 [`governance-runtime.md`](governance-runtime.md) 与代码审计 [`../audit/governance-runtime-map.md`](../audit/governance-runtime-map.md)。

### PD 如何改变 Agent 行为？

```
1. 认知引导
   原则帮助 Agent 考虑更好的做法。

2. 运行时治理
   激活的原则可以参与执行决策。

3. 持续改进
   未来行为产生新的证据。
```

## PD 不是什么

- **不是 AI Memory**：Memory 存储信息，PD 治理行为。Memory 回答"发生了什么"，PD 回答"因为发生了什么，行为应该改变什么"。
- **不是 Prompt Engineering**：Prompt 工程在执行前提供指令；PD 把执行后的经验转化为可复用的治理原则。提示词注入只是 PD 的通道之一，不是 PD 本身。
- **不是自主学习**：PD 不允许 Agent 独立做价值判断或自我修改。Owner 审批始终是唯一权威。
- **不训练模型**：PD 不修改模型权重。PD 工作在 Agent 运行时层，从不触碰模型。

## 核心流程

```
反复纠正 → 行为证据 → 原则提案 → Owner 审查 → 激活（提示词 / 运行时钩子）→ 运行时应用 → 未来行为改进
```

每一步可审查，每次激活可回滚，每个效果可观察。

### 原则与规则

原则引导判断；规则约束具体动作。两者不是同义词，而是同一枚硬币的两面：当反复的经验证明某条底线绝不能被遗忘时，Owner 可以审批把一条原则硬化为运行时层的可执行规则（先影子试运行，始终可回滚）。PD 不是规则生成器——硬化是选择性的、经 Owner 审批的。
