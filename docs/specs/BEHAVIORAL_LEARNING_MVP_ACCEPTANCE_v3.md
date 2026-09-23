# Behavioral Learning MVP Acceptance Specification

## Version

Draft v3

## Purpose

本 SPEC 定义 Principles Disciple (PD) Behavioral Learning MVP
的验收标准。

目标不是证明完整因果学习，而是定义：

> 什么证据足以支持一次 Owner 反馈已经转化为 Agent 后续可观察行为变化。

核心验证链：

    Owner Feedback
            ↓
    Principle Formation
            ↓
    Principle Exposure
            ↓
    Behavior Observation
            ↓
    Outcome Observation

------------------------------------------------------------------------

# Core Boundary

必须区分：

    Activation != Learning

    Exposure != Influence

    Outcome != Effect Attribution

Activation 证明原则进入运行流程。

Exposure 证明原则进入执行上下文。

Behavior Evidence 证明 Agent 实际行为变化。

Outcome Evidence 证明变化后出现可观察结果。

Effect Attribution 属于未来阶段。

------------------------------------------------------------------------

# Evidence Layer Model

## Layer 0 --- Process Evidence

证明：

    Pain
     ↓
    Diagnosis
     ↓
    Principle
     ↓
    Approval
     ↓
    Activation

需要：

-   Pain ID
-   Diagnosis artifact
-   Principle lineage
-   Approval record
-   Activation identity

该层不能单独证明学习发生。

------------------------------------------------------------------------

## Layer 1 --- Exposure Evidence

证明任务实际暴露到了 Principle。

需要：

    task/session identity

    principle identity

    activation_id

    timestamp

    runtime exposure reference

注意：

Exposure 不等于 Influence。

Session 级 presence 不应被描述为行为影响证据。

------------------------------------------------------------------------

## Layer 2 --- Behavior Evidence

这是 PRI-836 的核心。

目标：

回答：

> Agent 是否因为 Principle 改变了可观察行为？

------------------------------------------------------------------------

# Behavior Signature

实验必须定义：

    Behavior Signature

    Target Behavior

    Eligible Opportunity

    Previous Behavior

    Expected New Behavior

    Forbidden Pattern

    Evidence Source

其中：

-   Target Behavior
-   Forbidden Behavior
-   Evidence Source

优先复用现有 IntentContract。

新增：

-   Eligible Opportunity
-   Previous Behavior

------------------------------------------------------------------------

# Behavior Evidence Strength

## Level 0

Self Report

Agent 声明遵守原则。

属于声明证据，不属于行为证据。

## Level 1

Trajectory Observation

来自：

-   assistant turns
-   action sequence

## Level 2

Tool / Artifact Verification

来自：

-   tool calls
-   file changes
-   generated artifacts

## Level 3

Runtime Enforcement

来自：

-   hook
-   rulehost

------------------------------------------------------------------------

# Before / After Observation

实验必须包含：

## B0 Baseline

Activation 前：

-   Previous Behavior
-   Failure Pattern
-   Frequency

## A1 / A2

Activation 后：

至少两个独立任务机会。

------------------------------------------------------------------------

# Layer 3 --- Outcome Evidence

目标：

观察行为变化后的结果。

MVP 不要求：

-   因果证明
-   统计显著性
-   自动归因

允许：

-   同类错误减少
-   Owner correction 减少
-   重复 Pain 未出现
-   验证结果改善
-   Review 成本下降

禁止直接使用：

    assistant completed

    agent claimed success

    task record exists

    task_outcomes.completed

因为：

完成记录不等于成功。

------------------------------------------------------------------------

# Experiment Result

## PASS

满足：

-   Process Evidence
-   Exposure Evidence
-   Behavior Evidence
-   Outcome Evidence

## FAIL

原则已暴露，但目标行为未改变。

## INCONCLUSIVE

证据不足或观察机会不足。

------------------------------------------------------------------------

# Owner Governance Decision

实验结果与治理决策分离。

Owner 决策：

-   Keep
-   Revise
-   Revoke
-   Continue Observation

------------------------------------------------------------------------

# Evidence Bundle

    behavioral-learning-evidence/

    ├── pain.json
    ├── diagnosis.json
    ├── principle.json
    ├── approval.json
    ├── activation.json
    ├── exposure.json
    ├── behavior-signature.json
    ├── behavior-before.json
    ├── behavior-after.json
    ├── outcome.json
    └── owner-decision.json

------------------------------------------------------------------------

# PRI-836 Scope

包含：

-   一次真实 Principle 学习实验
-   Behavior Signature 声明
-   Before/After 行为观察
-   Evidence Bundle 组装
-   Owner 裁定

不包含：

-   Counterfactual Reasoning
-   Effect Attribution
-   自动 Principle 排序
-   新 Memory System
-   新 Runtime
-   新 Control Plane

------------------------------------------------------------------------

# Reality Check 最小准备项

## M1

Effect receipt 补充 activation_id。

连接：

    Behavior Evidence → Activation

------------------------------------------------------------------------

## M2

增加实验级 Behavior Signature 声明。

------------------------------------------------------------------------

## M3

增加只读 Evidence Bundle 组装能力。

------------------------------------------------------------------------

## M4

补充 Owner correction 与 Principle exposure 关联查询。

------------------------------------------------------------------------

## M5

明确：

    task_outcomes = Opportunity denominator

不是 Outcome Evidence。

------------------------------------------------------------------------

# Future Evolution

## Level 1

Behavioral Learning MVP:

    Did behavior change?

## Level 2

Effectiveness Evidence:

    Did the change create reliable improvement?

## Level 3

Causal Learning:

    Why did the change work?

包括：

-   Counterfactual reasoning
-   Effect attribution
-   Causal inference
