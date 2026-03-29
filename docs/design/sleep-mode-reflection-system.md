# 💤 Nocturnal Evolution — 原则驱动的深度反思与行为进化系统

> **版本**: v4.1 | **日期**: 2026-03-27 | **状态**: Design
> **约束**: 训练管线须在消费级显卡 (RTX 4090 24GB) 上可运行
> **核心原则**: LLM 负责定性分析，代码负责定量裁决——永远不让 LLM 调自己的阈值
> **增强回路**: 选择高 ROI 原则优先固化 → 训练资源集中 → 内化速度加快 → 释放训练带宽给下一个原则

---

## 0. 模块接口规格（给开发者的快速参考）

> ⚠️ **如果你是开发者，先看这一节**。这里定义了模块的输入、输出、触发条件。

### 0.1 模块定位

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Nocturnal Evolution 模块                                                   │
│                                                                             │
│  功能：将"原则违反"转化为"训练数据"，用于 LoRA 微调内化行为                 │
│  位置：packages/openclaw-plugin/src/service/nocturnal-service.ts (新增)    │
│  触发：Pain 信号 OR 空闲检测                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 0.2 输入数据结构

```typescript
/**
 * 反思任务的输入
 * 来源：EVOLUTION_QUEUE（由 Pain 信号或空闲检测入队）
 */
interface NocturnalReflectionInput {
  // ─────────────────────────────────────────────────────────
  // 必填字段
  // ─────────────────────────────────────────────────────────
  
  /** 任务 ID */
  taskId: string;
  
  /** 触发类型 */
  triggerType: 'pain_signal' | 'idle_timeout';
  
  /** 目标原则 ID（要反思哪个原则） */
  targetPrincipleId: string;  // 如 'T-01', 'T-03', 或新原则 ID
  
  /** 关联的 Session ID */
  sessionId: string;
  
  // ─────────────────────────────────────────────────────────
  // Pain 触发时必填
  // ─────────────────────────────────────────────────────────
  
  /** Pain 信号详情（如果触发类型是 pain_signal） */
  painSignal?: {
    score: number;           // 0-100
    source: string;          // 如 'tool_failure', 'user_correction'
    reason: string;          // 具体原因描述
    timestamp: string;       // ISO 时间戳
  };
  
  // ─────────────────────────────────────────────────────────
  // 从 trajectory.db 提取的关联数据
  // ─────────────────────────────────────────────────────────
  
  /** 原始轨迹数据 */
  trajectory: {
    sessionId: string;
    assistantTurns: Array<{
      id: number;
      text: string;           // sanitized_text
      createdAt: string;
    }>;
    userTurns: Array<{
      id: number;
      text: string;
      correctionDetected: boolean;
    }>;
    toolCalls: Array<{
      toolName: string;
      outcome: 'success' | 'failure' | 'blocked';
    }>;
    painEvents: Array<{
      source: string;
      score: number;
      reason: string;
    }>;
  };
  
  // ─────────────────────────────────────────────────────────
  // 原则遵循状态（用于判断是否需要反思）
  // ─────────────────────────────────────────────────────────
  
  /** 该原则当前的遵循状态 */
  principleStatus: {
    complianceRate: number;      // 0-1，最近 N 次行为的遵循率
    violationTrend: number;      // 正数=上升，负数=下降
    trainingSamples: number;     // 已生成的训练样本数
    status: 'needs_training' | 'in_training' | 'monitoring' | 'internalized' | 'dormant';
  };
}
```

### 0.3 输出数据结构

```typescript
/**
 * 反思任务的输出
 * 存储：.state/exports/dpo/reflection-{timestamp}.jsonl
 */
interface NocturnalReflectionOutput {
  // ─────────────────────────────────────────────────────────
  // 元数据
  // ─────────────────────────────────────────────────────────
  
  /** 任务 ID（与输入对应） */
  taskId: string;
  
  /** 关联的原则 ID */
  principleId: string;
  
  /** 时间戳 */
  timestamp: string;
  
  // ─────────────────────────────────────────────────────────
  // ORPO/DPO 训练数据
  // ─────────────────────────────────────────────────────────
  
  /** ORPO JSONL 格式 */
  orpoEntry: {
    prompt: string;           // 任务描述/上下文
    chosen: string;           // 符合原则的轨迹（Scribe 输出）
    rejected: string;         // 违反原则的轨迹（原始轨迹）
    metadata: {
      principleId: string;
      improvementScore: number;   // compositeImprovement
      taskType: string;           // 任务类型标签
      violatedModels: string[];   // 违反的思维模型列表
    };
  };
  
  // ─────────────────────────────────────────────────────────
  // 质量评估结果
  // ─────────────────────────────────────────────────────────
  
  /** Arbiter 评估结果 */
  arbiterResult: {
    passed: boolean;
    compositeImprovement: number;  // 综合改进分 0-1
    thinkingModelDelta: number;    // 思维模型激活率变化
    planningRatioGain: number;     // 规划行为改进
    regressions: Array<{           // 劣化检测
      type: string;
      severity: 'low' | 'medium' | 'high';
    }>;
  };
  
  // ─────────────────────────────────────────────────────────
  // 原则状态更新（反馈到系统）
  // ─────────────────────────────────────────────────────────
  
  /** 原则状态更新 */
  principleStatusUpdate: {
    principleId: string;
    newComplianceRate: number;
    newTrainingSamples: number;
    statusChange?: {
      from: string;
      to: string;
    };
  };
}
```

### 0.4 数据流图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              数据流                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐                                                            │
│  │ Pain 信号   │                                                            │
│  │ (hooks/pain)│                                                            │
│  └──────┬──────┘                                                            │
│         │                                                                   │
│         ▼                                                                   │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                   │
│  │ EVOLUTION   │     │ trajectory  │     │ 原则状态    │                   │
│  │   QUEUE     │────→│    .db      │────→│ (合规统计)  │                   │
│  └──────┬──────┘     └─────────────┘     └──────┬──────┘                   │
│         │                                        │                          │
│         └────────────────┬───────────────────────┘                          │
│                          ▼                                                  │
│              ┌───────────────────────┐                                      │
│              │   反思准入判断        │                                      │
│              │ shouldReflect()?      │                                      │
│              └───────────┬───────────┘                                      │
│                          │                                                  │
│              ┌───────────┴───────────┐                                      │
│              │                       │                                      │
│              ▼                       ▼                                      │
│        ┌──────────┐           ┌──────────┐                                 │
│        │ 跳过反思 │           │ 执行反思 │                                 │
│        │ (已遵循) │           │ (Trinity)│                                 │
│        └──────────┘           └────┬─────┘                                 │
│                                    │                                        │
│                                    ▼                                        │
│                          ┌─────────────────┐                                │
│                          │  Arbiter 门禁   │                                │
│                          └────────┬────────┘                                │
│                                   │                                         │
│                          ┌────────┴────────┐                                │
│                          │                 │                                │
│                          ▼                 ▼                                │
│                   ┌──────────┐       ┌──────────┐                          │
│                   │ 丢弃     │       │ 入库     │                          │
│                   │ (改进不足)│       │ ORPO JSONL│                         │
│                   └──────────┘       └──────────┘                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 0.5 触发条件速查

| 触发源 | 触发条件 | 入队字段 |
|--------|---------|---------|
| **Pain 信号** | `score >= 30` 且关联原则 | `triggerType: 'pain_signal'` |
| **空闲检测** | 空闲 >= 30 分钟 且有 `needs_training` 状态的原则 | `triggerType: 'idle_timeout'` |

### 0.6 反思准入条件

```typescript
// 只有满足以下条件之一，才执行反思
function shouldReflect(input: NocturnalReflectionInput): boolean {
  // 条件 1：有 Pain 关联
  if (input.painSignal) return true;
  
  // 条件 2：遵循率低
  if (input.principleStatus.complianceRate < 0.85) return true;
  
  // 条件 3：违反趋势上升
  if (input.principleStatus.violationTrend > 0) return true;
  
  // 条件 4：新原则（从未训练）
  if (input.principleStatus.trainingSamples === 0) return true;
  
  // 条件 5：已内化但违反（重新激活）
  if (input.principleStatus.status === 'internalized' && input.painSignal) return true;
  
  // 其他：跳过反思
  return false;
}
```

### 0.7 存储位置

| 数据 | 存储位置 | 格式 |
|------|---------|------|
| 输入任务队列 | `.state/evolution_queue.json` | JSON Array |
| 轨迹数据 | `.state/trajectory.db` | SQLite |
| 原则内化状态 | `.state/principle_internalization.json` | JSON |
| 输出训练数据 | `.state/exports/dpo/reflection-{ts}.jsonl` | JSONL |
| 反思日志 | `memory/reflection-log.md` | Markdown |

---

## 1. 问题陈述

### 1.1 当前困境

现有的 AI Agent 存在一个根本性问题：**思维模型和原则对 LLM 行为的影响极其有限**。

| 现象 | 原因 | 后果 |
|------|------|------|
| 无论注入多少原则，Agent 依然"上来就开干" | 原则只是上下文文本，没有被内化为行为模式 | 简单任务侥幸完成，复杂任务必然失败 |
| 长程任务中 Agent 逐渐偏离目标 | LLM 上下文压缩导致任务漂移 | 高价值的长周期任务无法可靠执行 |
| 反思 prompt 产出的质量不稳定 | 缺乏结构化的反思流程和质量度量 | 进化循环难以形成正反馈 |
| 工业界短期内无法解决长程记忆难题 | 注意力机制的根本局限 | 不能等待基础设施成熟 |

### 1.2 核心洞察

> **如果你无法改变模型的底层能力，就改变模型的默认行为模式。**

人类通过"睡眠"来巩固学习：白天的经历在睡眠中被重放、筛选、编码为长期记忆。我们借鉴这个机制：

```
人类学习                          Agent 学习
━━━━━━━━                          ━━━━━━━━━━
白天工作                          日间 Session (对话/工具调用/任务完成)
    ↓                                 ↓
睡眠 → 记忆重放 + 巩固              空闲 → 反思重放 + 原则对照分析
    ↓                                 ↓
行为模式固化                        LoRA 微调 → 行为模式固化
    ↓                                 ↓
第二天表现更好                      下一次推理时自发产生更好的思维模式
```

### 1.3 设计目标

1. **将抽象原则转化为具体行为**：通过反思生成"如果遵循原则X，在这个场景下应该怎么做"的具体示范
2. **生成高质量训练数据**：输出偏好对比对 (ORPO/DPO)，用于 LoRA 微调
3. **建立可量化的质量信号**：不依赖单一金标准，通过多维代理指标 + Arbiter 质量门禁衡量改进
4. **零干扰集成**：在 Agent 空闲时自动触发，不影响正常工作流
5. **消费级硬件可训练**：整个训练管线须可在 RTX 4090 (24GB VRAM) 上运行

---

## 2. 理论基础：为什么这个方案有效

### 2.1 核心假设与论证

**假设**: _通过思维模型驱动的结构化反思，可以生成比原始 trajectory 质量更高的行为示范,
这些示范作为训练数据可以通过 LoRA 微调改变 LLM 的默认行为模式。_

这个假设可以分解为三个子假设：

#### 子假设 A: 反思能产出更好的 trajectory（✅ 高信度）

这几乎是确定成立的。当你给 LLM 一段"上来就开干"的 trajectory，并明确要求它"用 Survey Before Acting 原则重写这些决策节点"，LLM **一定**会输出一个包含更多调查和规划步骤的版本。这是 LLM 的 instruction following 能力，不是反思质量问题。

关键证据：
- Principles Disciple 已有的 `detectThinkingModelMatches()` 函数可以量化验证这一点
- 用 T-01 到 T-09 的正则匹配，可以客观测量原始 vs 反思后的思维模型覆盖率

#### 子假设 B: "更好"可以被可靠度量（⚠️ 需要新框架，见第 3 节）

这是整个方案的最大挑战。我们**不需要**也**不可能**找到一个单一的"金标准"。

**关键洞察：放弃绝对质量评估，转向相对比较。**

你不需要判断"这条 trajectory 值 85 分"，只需要判断"反思后的版本比原始版本更好"。
这个相对判断远比绝对评分容易且可靠。（详见 §3 质量度量框架）

#### 子假设 C: LoRA 微调能内化这些行为（⚠️ 取决于数据量和质量）

这是需要通过实验验证的假设。文献表明：
- LoRA 微调在 1K-10K 高质量样本规模下可以显著改变模型行为
- ORPO/DPO 在偏好学习上的效果优于纯 SFT
- 但效果取决于训练数据和推理场景的分布匹配度

**风险控制**：通过 A/B 测试验证微调效果，而不是盲目希望微调有效。

> 📋 详细的验证实验设计见 **附录 H**，包含对照组设计、评估指标、统计显著性阈值。

### 2.2 与人类认知科学的类比

| 人类睡眠机制 | Agent Nocturnal Evolution | 实现方式 |
|-------------|--------------------------|---------|
| **记忆重放 (Memory Replay)** | 🌙 Dreamer 回放轨迹 | 从 trajectory.db 提取当天 session 的完整行为记录 |
| **选择性巩固 (Selective Consolidation)** | 🏛️ Philosopher 原则审计 | 用 T-01~T-09 思维模型识别需要改进的决策节点 |
| **模式重建 (Pattern Reconstruction)** | ✍️ Scribe 轨迹改写 | LLM 重写关键决策节点，体现正确的思维模式 |
| **质量控制 (Quality Gate)** | ⚖️ Arbiter 仲裁评分 | 双盲对比 + 15% 最低改进阈值 |
| **长期记忆形成 (LTM Formation)** | QLoRA/ORPO 微调 | 将对比对用于参数级别的行为塑造 |

### 2.3 为什么思维模型是有效的质量标准

你可能会问："不同任务类型（编码、写文档、发邮件）差异这么大，如何用一套标准判断？"

答案是：**思维模型是任务无关的 (Task-Agnostic) 元认知标准。**

```
                    任务特定标准（不可用）              元认知标准（可用）
                    ━━━━━━━━━━━━━━━━                   ━━━━━━━━━━━━━━━
编码任务：是否通过测试？                    T-01: 是否先了解现有代码结构？
文档任务：文档是否准确？        ←  这很难    T-03: 是否基于证据而非假设？
邮件任务：是否达到沟通目的？    ←  自动化    T-09: 是否将复杂任务拆解？
                                            T-07: 是否保持最小改动面？
                                              ↑
                                          这些跨任务通用
```

无论什么任务：
- 「先调查再行动」永远优于「上来就开干」(T-01: Survey Before Acting)
- 「基于证据决策」永远优于「基于假设决策」(T-03: Evidence Over Assumption)
- 「拆解复杂到简单」永远优于「试图一步到位」(T-09: Divide And Conquer)
- 「最小改动面」永远优于「大范围修改」(T-07: Minimal Change Surface)

所以**你的 9 个思维模型 (T-01~T-09) 本身就是跨任务的金标准**。

> ⚠️ **注意**：思维模型存在适用边界。例如紧急修复场景下，T-01 的"先调研再行动"可能不适用。详见 **附录 I: 思维模型适用边界与豁免条件**。

---

## 3. 质量度量框架：多维代理指标 + Arbiter 门禁

### 3.1 为什么不能找单一金标准

传统的模型评估有明确的 ground truth（如 MMLU、HumanEval），但 Agent 行为评估没有：

| 评估对象 | 金标准 | 可行性 |
|---------|--------|--------|
| 代码正确性 | 单元测试 | ✅ 可自动化 |
| Agent 编码行为 | "编码的过程是否体现了深思熟虑" | ❌ 无标准答案 |
| Agent 跨任务行为 | "做事的方式是否符合好的工作习惯" | ❌ 更抽象 |

所以我们需要一个全新的评估框架。

### 3.2 七维代理指标体系 (Proxy Metrics)

**核心思想**：每个指标独立不完美，但组合起来可以构成有效的质量信号。

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       Trajectory 质量评估                               │
├─────────────────┬─────────────────┬────────────────┬─────────────────── ┤
│  过程指标        │  效率指标        │  对比指标       │ 原则遵循          │
│  Process         │  Efficiency     │  Contrastive   │ Principle         │
├─────────────────┼─────────────────┼────────────────┼───────────────────┤
│ 思维模型覆盖率   │ 思维深度比       │ 原始 vs 反思   │ T-01 ✓/✗         │
│ 规划→执行比      │ 错误纠正路径长度 │ 规划深度差异    │ T-03 ✓/✗         │
│ 修正次数         │ 冗余操作率       │ 错误恢复差异    │ T-07 ✓/✗         │
│ PLAN.md 确认点   │                 │                │ T-09 ✓/✗         │
│ 工具成功率       │                 │                │                   │
└─────────────────┴─────────────────┴────────────────┴───────────────────┘
```

#### 3.2.1 过程指标 (Process Metrics)

来自 trajectory.db 的已有数据：

| 指标 | 数据来源 | 计算方式 | 好/坏阈值 |
|------|---------|---------|----------|
| **思维模型激活率** | `detectThinkingModelMatches()` on trajectory text | 激活的模型数 / 9 | >0.3 = 好 |
| **规划→执行比 (Pre-computation Density)** | `tool_calls` 表 | 首个 write_file 前的 read_file 次数 | >2 次 = 好 |
| **用户修正次数** | `user_turns.correction_detected` | 单 session 中 correction=true 的总数 | <2 = 好 |
| **工具成功率** | `tool_calls` 表 | success_count / total_count | >0.85 = 好 |
| **PLAN.md 确认点** | `tool_calls` 表 | 首次写入前是否有 PLAN.md 的读/写操作 | >0 = 好 |

#### 3.2.2 效率指标 (Efficiency Metrics)

| 指标 | 数据来源 | 计算方式 | 好/坏阈值 |
|------|---------|---------|----------|
| **思维深度比 (Thinking Ratio)** | `assistant_turns` + `tool_calls` | Σ(assistant 文本长度) / Σ(工具调用数) | >500 = 好 |
| **错误纠正路径长度** | `tool_calls` 表 | 从 failure 到下一个同 tool success 的平均步数 | <3 = 好 |
| **冗余操作率** | `tool_calls` 表 | 连续相同 (tool+params) 调用数 / 总调用数 | <0.1 = 好 |

Thinking Ratio 的直觉：一个"上来就干"的 Agent 每调用一次工具前只产出几十个 token（ratio 低），
一个深思熟虑的 Agent 在行动前会产出大量分析文本（ratio 高）。

> ⚠️ **风险提示**：Thinking Ratio **容易被模型表演**。"话更多 ≠ 决策更好"，模型可能学会输出更多"让我先分析一下"等文本，但实际工具序列没有实质改善。
> 
> **建议**：将 Thinking Ratio 权重从 0.3 **降为 0.1**，增加两个更难作假的指标：
> - **Outcome Preservation**：改写后不能破坏原任务目标
> - **Progress Efficiency**：每增加一步规划，是否减少失败/返工/用户修正

#### 3.2.3 结果指标 (Outcome Metrics)

| 指标 | 数据来源 | 说明 |
|------|---------|------|
| **Pain 密度** | `pain_events` / total_turns | 低 = 好（<0.1） |
| **Gate 拦截率** | `gate_blocks` / total_tool_calls | 低 = 好（趋势应下降） |
| **任务完成** | `task_outcomes.outcome = 'ok'` | binary |

#### 3.2.4 对比指标 (Contrastive Metrics) — 最关键

**这是让整个方案闭环的关键**：不评估绝对质量，只评估相对改进。

```
原始 Trajectory:
  "好的，我直接开始写代码 → write_file → failure → 再试 → failure → 用户修正"
  思维模型激活率: 11% (只有 T-06)
  Thinking Ratio: 80

反思后 Trajectory:
  "让我先看看现有的代码结构 → read_file × 3 → 基于依赖关系分析 → 分步实施 → write_file → success"
  思维模型激活率: 56% (T-01, T-03, T-09, T-07, T-06)
  Thinking Ratio: 650

Quality Delta:
  +45% 思维模型激活率，Thinking Ratio +570,
  修正次数从 2 → 0，工具成功率从 60% → 100%
```

### 3.3 Arbiter 质量门禁：最低改进阈值

**设计来源**: 来自 Nocturnal Evolution 方案的 Arbiter 概念。

核心思想：**如果反思后的轨迹只比原始版本好一点点，这条数据对偏好训练的价值很低**（chosen/rejected 差异太小 → 梯度信号弱）。必须设置最低改进阈值。

```typescript
// Arbiter 门禁逻辑
function shouldPersistDpoEntry(original: TrajectoryMetrics, improved: TrajectoryMetrics): boolean {
  const thinkingModelDelta = improved.thinkingModelActivation - original.thinkingModelActivation;
  const planningDelta = improved.planningRatio - original.planningRatio;
  const thinkingRatioDelta = (improved.thinkingRatio - original.thinkingRatio) / Math.max(original.thinkingRatio, 1);

  // 综合改进分 = 三维度加权平均
  const compositeImprovement = (
    thinkingModelDelta * 0.5 +    // 原则覆盖最重要
    planningDelta * 0.3 +         // 规划行为次之
    Math.min(thinkingRatioDelta, 1.0) * 0.1 +  // 思维深度（降权，防表演）
    outcomePreservation * 0.1     // 目标保持（新增，防偏离）
  );

  // 最低门槛: 动态阈值 (由 AdaptiveThresholdManager 维护，初始 15%)
  return compositeImprovement >= adaptiveThreshold;
}
```

**权重敏感性分析**：当前权重 (0.4/0.3/0.3) 基于以下考量：
- 思维模型激活是最直接的原则遵循信号
- 规划行为和思维深度同等重要但间接
- Phase 0 数据收集时应验证权重对入库率的影响

> 💡 建议通过**敏感性分析**调整权重：观察不同权重组合下入库数据的 `thinkingModelActivation` 分布，选择最能区分高质量/低质量数据的配置。

门禁数据质量保障逻辑：

```
原始轨迹 ──→ Trinity 反思 ──→ 改进轨迹
                                │
                                ▼
                    Arbiter 计算 compositeImprovement
                                │
                    ┌───────────┴───────────┐
                    │                       │
              improvement ≥ 15%       improvement < 15%
                    │                       │
                    ▼                       ▼
             ✅ 入库 DPO JSONL        ❌ 丢弃，记录日志
```

> ⚠️ **增强**：除改进阈值外，还需检测"改写后是否引入新问题"（如新失败、冗余增加）。详见 **附录 M.5 Arbiter 劣化检测**。

### 3.4 训练数据格式选择：ORPO 优先，DPO 备选

#### 为什么是 ORPO 而不是 DPO？

**关键硬件约束：RTX 4090 只有 24GB VRAM。**

| 训练方法 | 需要 reference model？ | 内存需求 (7B 4-bit) | 4090 可行？ |
|---------|----------------------|---------------------|------------|
| **SFT** | ❌ | ~8-12 GB | ✅ 轻松 |
| **ORPO** | ❌ 不需要 | ~10-14 GB | ✅ 可行 |
| **SimPO** | ❌ 不需要 | ~10-14 GB | ✅ 可行 |
| **DPO** | ✅ 需要冻结的 ref model | ~16-22 GB | ⚠️ 勉强 |
| **RLHF** | ✅ 需要 reward + policy | ~30+ GB | ❌ 不行 |

**DPO 的内存问题**: DPO 需要同时加载 **policy model** 和 **frozen reference model**，相当于内存翻倍。7B 模型 4-bit 量化下，policy + reference ≈ 16-22 GB，在 4090 上非常紧张，batch size 只能为 1，训练效率低。

**ORPO (Odds Ratio Preference Optimization) 的优势**:
1. **不需要 reference model** — 它将 SFT 和偏好对齐合并为一个训练阶段
2. **内存减半** — 2 个 forward pass (chosen + rejected) vs DPO 的 4 个 forward pass
3. **训练更简洁** — 不需要先做 SFT 再做 DPO 的两阶段流程
4. **数据格式兼容** — 同样使用 `{prompt, chosen, rejected}` 三元组
5. **论文验证** — 在 Llama-3-8B、Mistral-7B 上效果与 DPO 相当甚至更好

#### 数据格式（ORPO/DPO 通用）

**推荐：决策点级别样本 (Decision-Point-Level)**

相比完整的 session 级轨迹，决策点级别样本更短、更聚焦、偏好信号更干净：

```jsonl
{
  "prompt": "场景：用户要新增 API endpoint。当前已知：尚未读取现有 routes 和校验逻辑。你下一步该怎么做？",
  "chosen": "先读取现有路由注册与参数校验实现，再给出分步计划。",
  "rejected": "直接创建新 endpoint 文件并开始写实现。",
  "metadata": {
    "decision_point": "turn_3",
    "violated_principles": ["T-01"],
    "source": "nocturnal_evolution"
  }
}
```

**备选：Session 级样本 (Session-Level)**

```jsonl
{
  "prompt": "用户请求: 实现一个新的 API endpoint, 需要读取配置文件并校验参数",
  "chosen": "让我先调研一下现有的 API 结构和配置系统...\n[Step 1] 读取 routes.ts 了解路由注册模式...\n[Step 2] 读取现有的配置校验逻辑...\n[Step 3] 基于调研结果，将任务分为 3 步...",
  "rejected": "好的，我直接创建 api-endpoint.ts 文件...\n[直接写代码]...\n[报错：找不到 ConfigManager]...\n[再试一次]...",
  "metadata": {
    "principles_applied": ["T-01", "T-03", "T-09"],
    "quality_delta": {
      "thinking_model_activation": 0.45,
      "thinking_ratio_improvement": 570,
      "planning_ratio_improvement": 0.67,
      "correction_reduction": 2,
      "composite_improvement": 0.38
    },
    "source": "nocturnal_evolution"
  }
}
```

> 💡 **为什么推荐决策点级别**：
> - Token 成本更低
> - 关键偏好点不被稀释
> - Scribe 的虚构空间更小
> - 训练后模型学到的是"关键处改法"，不是"套模板式长篇规划文风"

#### 为什么不用 SFT？

| 训练方式 | 需要什么数据 | 适用场景 | 为什么不适合我们 |
|---------|------------|---------|----------------|
| **SFT** | 绝对正确的 gold trajectory | 有标准答案的任务 | ❌ 我们没有标准答案 |
| **ORPO** | 只需要 A 比 B 好的判断 | 偏好/风格/行为塑造 | ✅ 我们能判断反思后更好 |
| **DPO** | 只需要 A 比 B 好的判断 | 偏好/风格/行为塑造 | ⚠️ 可行但内存压力大 |

---

## 4. 系统架构

### 4.1 整体数据流

```
┌──────────────────────────────────────────────────────────────┐
│                     日间工作 (正常运行)                        │
│                                                              │
│  用户请求 → Agent 工作 → 工具调用 → LLM 输出                  │
│       │          │           │          │                     │
│       ▼          ▼           ▼          ▼                     │
│  ┌──────────────────────────────────────────┐                │
│  │  TrajectoryDatabase (已有, 持续记录)       │                │
│  │  sessions, assistant_turns, user_turns,   │                │
│  │  tool_calls, pain_events, corrections     │                │
│  └──────────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────────┘
                           │
                           │ 所有 session 空闲 > 30 分钟
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                 💤 Nocturnal Evolution (新增)                  │
│                                                              │
│  ① 空闲检测 → EVOLUTION_QUEUE.insert('sleep_reflection')     │
│                                                              │
│  ② 轨迹提取                                                  │
│     TrajectoryExtractor.extract(sessionId)                   │
│     从 trajectory.db 拉取结构化 Session 数据                   │
│                                                              │
│  ③ The Trinity — 三位一体思辨 (Phase 2)                       │
│     🌙 Dreamer    → 行为回溯，标注决策点                      │
│     🏛️ Philosopher → 原则审计，T-01~T-09 逐条检查             │
│     ✍️ Scribe     → 轨迹改写，生成理想执行序列                │
│                                                              │
│  ④ ⚖️ Arbiter — 质量仲裁                                     │
│     双盲对比 + compositeImprovement ≥ 15% 门禁                │
│                                                              │
│  ⑤ 数据构建                                                  │
│     ORPO/DPO JSONL → .state/exports/dpo/                     │
│     Token 长度截断 ≤ 2048 (适配消费级 GPU 训练)                │
│                                                              │
│  ⑥ 持久化                                                    │
│     反思日志 → memory/reflection-log.md                       │
│     进化任务 → evolution_tasks 表                             │
└──────────────────────────────────────────────────────────────┘
                           │
                           │ 积累 1K+ 对比对
                           ▼
┌──────────────────────────────────────────────────────────────┐
│               🧬 LoRA 微调 (RTX 4090 24GB)                    │
│                                                              │
│  基础模型: Qwen2.5-7B / Llama-3.1-8B (NF4 量化 ≈ 4GB)       │
│  训练框架: Unsloth + TRL                                     │
│  训练方法: ORPO (无 reference model, 内存 ≈ 10-14GB)         │
│  序列长度: 2048 tokens                                       │
│  Batch size: 2 (gradient accumulation = 8)                   │
│  预估 VRAM: ~14-18 GB (留有余量)                              │
│  训练时间: ~2-4 小时 / 1K 样本                                │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 与现有系统集成

```
src/index.ts
  │
  ├── registerService(EvolutionWorkerService)  ← 已有
  │     │
  │     └── start() → setInterval(15min)
  │           │
  │           ├── checkPainFlag(wctx)           ← 已有
  │           ├── processEvolutionQueue(wctx)    ← 已有
  │           │     │
  │           │     └── if task.type === 'sleep_reflection'  ★ 新增
  │           │           └── executeSleepReflection(wctx, api, task)
  │           │
  │           ├── processDetectionQueue(wctx)    ← 已有
  │           ├── processPromotion(wctx)         ← 已有
  │           │
  │           └── checkSleepMode(wctx)           ★ 新增 (空闲检测 → 插队列)
  │
  └── registerService(TrajectoryService)        ← 已有
```

### 4.3 文件变更总览

| 文件 | 类型 | 行数估算 | 说明 |
|------|------|---------|------|
| `src/core/trajectory-extractor.ts` | **新增** | ~150 行 | 从 trajectory.db 提取结构化轨迹 + 增强指标 |
| `src/service/sleep-reflection.ts` | **新增** | ~400 行 | 反思管线核心编排 (Trinity + Arbiter) |
| `src/service/evolution-worker.ts` | **修改** | +10 行 | 空闲检测 → 插入队列 + 消费队列 |

**不修改**: trajectory.ts, thinking-models.ts, session-tracker.ts, workspace-context.ts, index.ts 等所有现有文件。

---

## 5. 触发机制：空闲检测 + 队列分派

### 5.1 触发流程

与其在 EvolutionWorker 轮询中直接执行反思，不如通过 **EVOLUTION_QUEUE** 分派：

```typescript
// 步骤 1: 空闲检测 (每 15 分钟轮询)
function checkSleepMode(wctx: WorkspaceContext): void {
  if (!shouldEnterSleepMode(wctx)) return;

  // 步骤 2: 插入队列 — 而非直接执行
  insertEvolutionTask(wctx, {
    type: 'sleep_reflection',
    priority: 'low',  // 低于 pain 处理
    targetSessionId: getMostRecentQualifiedSession(wctx).sessionId,
    status: 'pending',
  });
}

// 步骤 3: 在 processEvolutionQueue() 中消费
if (task.type === 'sleep_reflection') {
  await executeSleepReflection(wctx, api, task);
}
```

**为什么走队列而不是直接调用**:
1. 任务有持久化记录，支持断点恢复和审计
2. 低优先级，不会抢占 pain 信号处理
3. 与现有的队列消费模式一致

### 5.2 触发条件（三重门卫）

```typescript
// ⚠️ SDK 审计修正: listSessions() 无外部 API。
// 正确做法: 用 llm_output hook 记录时间戳，在 index.ts 中注册:
//
// api.on('llm_output', (_event, ctx) => {
//   if (!ctx.workspaceDir) return;
//   fs.writeFileSync(
//     path.join(stateDir, '.last_active.json'),
//     JSON.stringify({ ts: Date.now(), sessionKey: ctx.sessionKey }),
//   );
// });

function shouldEnterSleepMode(stateDir: string, config: PainConfig): boolean {
  // 门卫 1: 冷却期 — 防止频繁反思
  const cooldownFile = path.join(stateDir, '.last_reflection.json');
  if (fs.existsSync(cooldownFile)) {
    const { ts } = JSON.parse(fs.readFileSync(cooldownFile, 'utf8')) as { ts: number };
    if ((Date.now() - ts) < (config.get('sleep.cooldown_ms') || 7_200_000)) return false;
  }

  // 门卫 2: 全局空闲 — 主检测：llm_output hook 记录的最后活跃时间
  const lastActiveFile = path.join(stateDir, '.last_active.json');
  if (!fs.existsSync(lastActiveFile)) return false;
  const { ts } = JSON.parse(fs.readFileSync(lastActiveFile, 'utf8')) as { ts: number };
  if ((Date.now() - ts) < (config.get('sleep.idle_threshold_ms') || 1_800_000)) return false;

  // 🆕 保底检测：llm_output hook 可能延迟或被绕过，用 trajectory.db 最新记录校验
  // 如果 hook 有延迟或某些内部调用绕过了它，依赖数据库记录更可靠
  const trajectoryDb = path.join(stateDir, 'trajectory.db');
  if (fs.existsSync(trajectoryDb)) {
    const db = new Database(trajectoryDb);
    const lastRecord = db.prepare('SELECT MAX(created_at) as max_ts FROM events').get() as { max_ts: number } | undefined;
    if (lastRecord?.max_ts && (Date.now() - lastRecord.max_ts) < (config.get('sleep.idle_threshold_ms') || 1_800_000)) {
      return false;  // 数据库显示仍有活动，hook 可能失效
    }
  }

  return true;  // 门卫 3 (数据门槛) 在调用方检查 trajectory stats
}
```

### 5.3 默认配置

```json
{
  "sleep": {
    "idle_threshold_ms": 1800000,
    "max_sessions_per_cycle": 1,
    "min_turns_for_reflection": 8,
    "cooldown_ms": 7200000,
    "arbiter_min_improvement": 0.15,
    "max_trajectory_tokens": 2048
  }
}
```

| 参数 | 默认值 | 含义 |
|------|--------|------|
| `idle_threshold_ms` | 30 分钟 | 所有 session 空闲多久后触发 |
| `max_sessions_per_cycle` | 1 | 每次反思最多处理几个 session |
| `min_turns_for_reflection` | 8 | 最少多少 turns 的 session 才值得反思 |
| `cooldown_ms` | 2 小时 | 两次反思之间的最小间隔 |
| `arbiter_min_improvement` | 0.15 | 最低 15% 综合改进才入库 |
| `max_trajectory_tokens` | 2048 | 截断长度，适配消费级 GPU 训练 |

---

## 6. 反思管线详细设计

### 6.1 阶段一：轨迹提取

从 `trajectory.db` 提取目标 session 的完整结构化数据：

```typescript
interface StructuredTrajectory {
  sessionId: string;
  assistantTurns: Array<{
    id: number;
    text: string;           // sanitized_text, 不用 raw_text
    model: string;
    createdAt: string;
  }>;
  userTurns: Array<{
    id: number;
    text: string;
    correctionDetected: boolean;
    correctionCue: string | null;
  }>;
  toolCalls: Array<{
    toolName: string;
    outcome: 'success' | 'failure' | 'blocked';
    errorType: string | null;
  }>;
  painEvents: Array<{ source: string; score: number; reason: string | null }>;
  metrics: TrajectoryMetrics;  // 七维衍生指标
}

interface TrajectoryMetrics {
  totalTurns: number;
  toolCallCount: number;
  toolSuccessRate: number;
  correctionCount: number;
  painDensity: number;
  planningRatio: number;            // 前置调研密度
  planConfirmation: boolean;        // 是否有 PLAN.md 确认点
  thinkingModelActivation: number;  // T-01~T-09 覆盖率
  activatedModels: string[];
  missingModels: string[];
  thinkingRatio: number;            // 思维深度比
  errorCorrectionPathLength: number; // 报错到修复的平均步数
  redundancyRate: number;           // 冗余操作率
}
```

**隐私保护**: 只使用 `sanitized_text`，不提取 `raw_text`。敏感路径、token、email 已被 `redactText()` 处理。

> ⚠️ **隐私边界补充**：`sanitized_text` 只 redact token、路径、email 等技术敏感信息。**代码逻辑和业务决策本身可能包含敏感信息**（如客户名称、API 设计细节、业务规则），这些不会被 redact。
>
> 如果 JSONL 文件用于外部训练或分享，需要额外脱敏层：
> - 训练前用 NER（命名实体识别）检测潜在敏感实体
> - 或限制 JSONL 仅在本地训练，不外发

**Token 截断**: 为适配 4090 的训练序列长度限制，`chosen` 和 `rejected` 文本截断至 `max_trajectory_tokens` (默认 2048 token)。

### 6.2 阶段二：Trinity 三位一体思辨

Phase 1 用单次 subagent 调用完成所有反思。
Phase 2 拆分为 Trinity 模型 — 三个认知正交的角色：

```
┌──────────────────────────────────────────────────────────────┐
│  Trinity 思辨链                                               │
│                                                              │
│  🌙 Dreamer (回放者)                                         │
│  ├─ 职责: 行为回溯与场景还原                                   │
│  ├─ 输入: trajectory.db 原始轨迹                              │
│  ├─ 输出: 决策点叙事 — 标注"在 Turn X，Agent 做了 Y 决策"      │
│  └─ 认知层: 感知 — "发生了什么？"                              │
│                   │                                          │
│                   ▼                                          │
│  🏛️ Philosopher (原则官)                                     │
│  ├─ 职责: 原则审计与合规检查                                   │
│  ├─ 输入: Dreamer 的决策叙事 + THINKING_OS.md + PRINCIPLES.md  │
│  ├─ 输出: 逐条审计报告 — "Turn X 违反了 T-01，因为..."         │
│  └─ 认知层: 评判 — "做得对不对？"                              │
│                   │                                          │
│                   ▼                                          │
│  ✍️ Scribe (记录员)                                          │
│  ├─ 职责: 行为重塑与样本生成                                   │
│  ├─ 输入: Dreamer 和 Philosopher 的思辨记录                    │
│  ├─ 输出: 改进版轨迹 — "如果遵循原则，Turn X 应该这样做..."     │
│  └─ 认知层: 行动 — "应该怎么做？"                              │
└──────────────────────────────────────────────────────────────┘
```

**为什么 3 个角色而不是 1 个或 5 个？**

- 1 个角色: LLM 容易跳过分析直接改写（感知和评判混在一起）
- 5-6 个角色: 角色间有重叠，token 消耗过高
- 3 个角色: 感知/评判/行动三层正交分离，每角色 prompt 聚焦，输出质量最高

> 💡 **增强建议**：为避免信息传递丢失，Philosopher 应同时接收原始轨迹和 Dreamer 的叙事，可发现 Dreamer 遗漏的决策点。

#### 通过 subagent API 实现

```typescript
// Phase 2: Trinity 链式调用（已根据 SDK 审计修正）
import crypto from 'crypto';

async function trinityReflection(api: OpenClawPluginApi, trajectory: StructuredTrajectory, thinkingModels: ThinkingModelDefinition[]) {
  // ✅ 正确格式: agent:{agentId}:subagent:{uuid}
  const dreamerKey     = `agent:main:subagent:ne-dreamer-${crypto.randomUUID()}`;
  const philosopherKey = `agent:main:subagent:ne-philosopher-${crypto.randomUUID()}`;
  const scribeKey      = `agent:main:subagent:ne-scribe-${crypto.randomUUID()}`;

  try {
    // Step 1: Dreamer — 场景还原
    const { runId: r1 } = await api.runtime.subagent.run({
      sessionKey: dreamerKey,
      message: buildDreamerPrompt(trajectory),        // ✅ 'message' 不是 'task'
      extraSystemPrompt: DREAMER_SYSTEM_PROMPT,
      deliver: false,                                 // 不发送到 chat channel
    });
    const w1 = await api.runtime.subagent.waitForRun({ runId: r1, timeoutMs: 180_000 });
    if (w1.status !== 'ok') throw new Error(`Dreamer failed: ${w1.status} ${w1.error ?? ''}`);
    const d1 = await api.runtime.subagent.getSessionMessages({ sessionKey: dreamerKey, limit: 5 });
    const dreamerOutput = extractLastAssistantText(d1.messages);

    // Step 2: Philosopher — 原则审计
    const { runId: r2 } = await api.runtime.subagent.run({
      sessionKey: philosopherKey,
      message: buildPhilosopherPrompt(trajectory, dreamerOutput, thinkingModels),
      extraSystemPrompt: PHILOSOPHER_SYSTEM_PROMPT,
      deliver: false,
    });
    const w2 = await api.runtime.subagent.waitForRun({ runId: r2, timeoutMs: 180_000 });
    if (w2.status !== 'ok') throw new Error(`Philosopher failed: ${w2.status} ${w2.error ?? ''}`);
    const d2 = await api.runtime.subagent.getSessionMessages({ sessionKey: philosopherKey, limit: 5 });
    const philosopherOutput = extractLastAssistantText(d2.messages);

    // Step 3: Scribe — 轨迹改写
    const { runId: r3 } = await api.runtime.subagent.run({
      sessionKey: scribeKey,
      message: buildScribePrompt(dreamerOutput, philosopherOutput),
      extraSystemPrompt: SCRIBE_SYSTEM_PROMPT,
      deliver: false,
    });
    const w3 = await api.runtime.subagent.waitForRun({ runId: r3, timeoutMs: 180_000 });
    if (w3.status !== 'ok') throw new Error(`Scribe failed: ${w3.status} ${w3.error ?? ''}`);
    const d3 = await api.runtime.subagent.getSessionMessages({ sessionKey: scribeKey, limit: 5 });
    const scribeOutput = extractLastAssistantText(d3.messages);

    return { dreamerOutput, philosopherOutput, scribeOutput };

  } finally {
    // 始终清理 subagent sessions（best-effort）
    await Promise.allSettled([
      api.runtime.subagent.deleteSession({ sessionKey: dreamerKey,     deleteTranscript: true }),
      api.runtime.subagent.deleteSession({ sessionKey: philosopherKey, deleteTranscript: true }),
      api.runtime.subagent.deleteSession({ sessionKey: scribeKey,      deleteTranscript: true }),
    ]);
  }
}
```

#### 6.2.1 Trinity 角色提示词设计

以下是为三个角色设计的专业提示词，存储时应版本化（如 `agents/dreamer-v1.md`）。

**🌙 DREAMER_SYSTEM_PROMPT**

```markdown
# 角色定义

你是一个严谨的行为回放者。你的职责是将原始操作日志转化为连贯的决策叙事，帮助后续审计者理解"发生了什么"。

# 核心原则

1. **客观还原**：只描述发生了什么，不做评判
2. **决策点标注**：识别每个关键决策时刻
3. **因果链构建**：展示决策之间的逻辑关联

# 输入格式

你将收到一个结构化的轨迹数据：
- assistantTurns: Agent 的思考文本
- toolCalls: 工具调用记录（含成功/失败状态）
- userTurns: 用户输入（含修正标记）
- painEvents: Pain 信号事件

# 输出格式

请按以下 JSON 结构输出：

{
  "sessionSummary": "一句话概括这个 session 的目标",
  "decisionPoints": [
    {
      "turnIndex": 3,
      "decisionType": "planning" | "execution" | "diagnosis" | "correction",
      "action": "Agent 做了什么",
      "context": "为什么这么做（可见信息）",
      "outcome": "immediate_success" | "immediate_failure" | "delayed_failure" | "user_correction",
      "triggeredBy": "user_request" | "tool_failure" | "pain_signal" | "self_reflection"
    }
  ],
  "narrative": "连贯的决策叙事，150-300字",
  "criticalMoments": [0, 5, 8]
}

# 工作步骤

1. **通读轨迹**：理解整体任务意图
2. **标注转折点**：识别决策类型变化的时刻
3. **构建因果链**：决策A → 结果 → 决策B
4. **提取叙事**：用第三人称客观描述

# 约束

- 不要评判决策对错
- 不要提出改进建议
- 保持中立的观察者视角
- 如遇模糊情况，使用"Agent 似乎认为..."而非断言
```

**🏛️ PHILOSOPHER_SYSTEM_PROMPT**

```markdown
# 角色定义

你是一个严苛的原则审计官。你的职责是依据 T-01~T-09 思维模型，对每个决策点进行逐条合规检查。

# 思维模型速查

| ID | 名称 | 核心要求 |
|----|------|---------|
| T-01 | Survey Before Acting | 动手前先理解结构 |
| T-02 | Respect Constraints | 显式检查契约/类型/测试 |
| T-03 | Evidence Over Assumption | 用日志/代码验证假设 |
| T-04 | Reversible First | 高风险时优先可逆方案 |
| T-05 | Safety Rails | 显式声明禁止事项 |
| T-06 | Simplicity First | 最简方案优于过度设计 |
| T-07 | Minimal Change Surface | 最小改动范围 |
| T-08 | Pain As Signal | 把失败当作反思信号 |
| T-09 | Divide And Conquer | 分解复杂任务 |

# 输入格式

你将收到：
1. 原始轨迹数据（可选，用于交叉验证）
2. Dreamer 的决策叙事
3. **历史系统性弱点**（来自过去 30 天的数据聚合，见 §10.6）:
   - 常见错误类型聚类
   - 用户高频修正场景
   - 过去 N 个 session 的思维模型激活率趋势

# 输出格式

请按以下 JSON 结构输出：

{
  "auditResults": [
    {
      "turnIndex": 3,
      "violatedModels": ["T-01", "T-03"],
      "evidence": "具体违规证据（引用原文）",
      "severity": "low" | "medium" | "high",
      "improvementHint": "如果遵循原则，应该怎么做"
    }
  ],
  "overallAssessment": {
    "activationRate": 0.22,
    "missingModels": ["T-01", "T-03", "T-09"],
    "mostCriticalViolation": {
      "turnIndex": 3,
      "models": ["T-01"],
      "reason": "上来就改代码，没有先了解结构"
    }
  },
  "recommendationSummary": "3 句话的改进建议摘要"
}

# 审计规则

1. **显式行为优先**：只根据可见的工具调用和文本判断
2. **保守原则**：不确定是否违规时，标记为 "potential"
3. **因果关联**：违规可能在后续 turns 才显现后果
4. **上下文考量**：
   - 紧急修复（urgency=critical）：豁免 T-01
   - 简单修改（complexity≤2）：豁免 T-09
   - 探索性原型：豁免 T-03

# 约束

- 每个 turn 最多标记 3 个违规模型
- severity=high 仅限：直接导致失败 或 用户被迫修正
- 不评价任务结果，只评价决策过程
```

**✍️ SCRIBE_SYSTEM_PROMPT**

```markdown
# 角色定义

你是一个行为重塑者。你的职责是基于 Dreamer 的叙事和 Philosopher 的审计，重写一条"理想执行轨迹"——如果 Agent 遵循了所有原则，它会怎么做。

# 输入格式

你将收到：
1. 原始轨迹数据
2. Dreamer 的决策叙事
3. Philosopher 的审计报告

# 输出格式

请输出改进后的轨迹文本（非 JSON），格式如下：

[原始任务]
{用户的原始请求}

[理想执行序列]

**Phase 1: 环境调研 (T-01 Survey Before Acting)**
- [Step 1] 让我先了解一下项目结构...
  → read_file: src/index.ts ✓
  → read_file: package.json ✓
  → 发现依赖关系：A → B → C

**Phase 2: 制定方案 (T-09 Divide And Conquer)**
- [Step 2] 基于调研结果，我将任务分解为：
  1. 修改模块 A
  2. 更新模块 B 的调用
  3. 添加测试

**Phase 3: 执行实施 (T-07 Minimal Change Surface)**
- [Step 3] 先修改核心模块...
  → write_file: src/a.ts ✓

**Phase 4: 验证结果 (T-03 Evidence Over Assumption)**
- [Step 4] 运行测试验证...
  → run_tests: ✓ 12 passed

[对比分析]
- 原始轨迹：直接修改 → 失败 → 重试 → 失败 → 用户修正
- 改进轨迹：调研 → 规划 → 实施 → 验证 → 成功
- 关键差异：T-01 和 T-09 的缺失导致后续失败

# 重塑规则

**核心策略：最小反事实修正**

不要重写整条轨迹，只修正关键错误决策点。这样能：
1. 降低虚构"空中楼阁"的概率
2. chosen / rejected 差异更聚焦，偏好信号更干净
3. 训练后模型学到的是"关键处改法"，不是"套模板式长篇规划文风"

**具体规则：**

1. **保留任务意图**：不改用户的原始目标
2. **保留成功操作**：原本成功的工具调用尽量保留
3. **只修正关键点**：
   - 找到 Philosopher 标记的 `severity='high'` 违规决策点
   - 只改这些点前后的决策
   - 其余成功段尽量保留原貌
4. **可执行性**：
   - 文件路径必须是真实存在的（或模糊化为"相关文件"）
   - 工具调用必须是合法的
   - 步骤顺序必须逻辑自洽
5. **情境适配**：
   - 如果原始轨迹用户修正 < 2 次：保留原始节奏，只修正关键点
   - 如果原始轨迹用户修正 ≥ 2 次：可以适当扩展修正范围

# 约束

- 总长度 ≤ 1000 tokens（降低，聚焦关键点）
- 不写无法执行的操作（如引用不存在的文件）
- 不添加用户未要求的额外功能
- **不要生成完整理想轨迹，只生成关键决策点的修正**
- 保持专业、简洁的技术文档风格
```

**输出示例（最小反事实修正）：**

```
[原始任务]
实现一个新的 API endpoint，需要读取配置文件并校验参数

[关键决策点修正]

**Turn 3（原始：直接写代码 → 违规 T-01）**
- 原始行为：直接 write_file: api-endpoint.ts
- 改进行为：
  1. 先读取 routes.ts 了解路由注册模式
  2. 读取 config.ts 了解配置结构
  3. 基于调研结果，制定分步计划

**Turn 7（原始：盲目重试 → 违规 T-08）**
- 原始行为：write_file 失败后，再次尝试相同操作
- 改进行为：
  1. 停下诊断失败原因（查看报错信息）
  2. 发现路径不存在，先创建目录
  3. 再执行写入

[保留的成功操作]
- Turn 10: 运行测试 ✓
- Turn 12: 代码格式化 ✓

[对比分析]
- 修正点：2 个关键决策
- 保留点：所有成功操作
- 差异聚焦：T-01 和 T-08 的行为修正
```

### 6.3 阶段三：Arbiter 仲裁

Dreamer/Philosopher/Scribe 的输出经过 Arbiter 评估后，只有达到最低改进阈值的数据才入库：

```typescript
function arbiterGate(original: TrajectoryMetrics, scribeOutput: string, originalTaskGoal: string): {
  pass: boolean;
  compositeImprovement: number;
  regressions: RegressionCheck[];
} {
  // 用 detectThinkingModelMatches() 分析改进后的轨迹
  const improvedMatches = detectThinkingModelMatches(scribeOutput);
  const improvedActivation = improvedMatches.length / totalModelCount;

  // === 第一性原则：从真实数据提取，不做字符串检测 ===
  // planningRatioGain 必须从 trajectory 的工具调用序列中提取，不能用 includes('read_file')
  const improvedToolSequence = extractToolSequence(scribeOutput);  // 解析工具调用
  const hasPlanningPattern = detectPlanningPattern(improvedToolSequence);  // 检测规划模式

  const delta = {
    thinkingModelDelta: improvedActivation - original.thinkingModelActivation,
    planningRatioGain: hasPlanningPattern ? 0.3 : 0,  // 基于真实工具序列，不是字符串
    thinkingRatioGain: (scribeOutput.length / Math.max(original.thinkingRatio, 1)) > 1.5 ? 0.1 : 0.05,
  };

  // 新增：目标保持检查
  const outcomePreservation = checkOutcomePreservation(scribeOutput, originalTaskGoal);

  // 综合改进分 = 四维度加权平均（Thinking Ratio 已降权）
  const composite = delta.thinkingModelDelta * 0.5    // 原则覆盖最重要
                   + delta.planningRatioGain * 0.3    // 规划行为次之
                   + delta.thinkingRatioGain * 0.1    // 思维深度（降权，防表演）
                   + outcomePreservation.score * 0.1; // 目标保持（新增）

  // 新增：劣化检测
  const regressions = detectRegressions(original, scribeOutput);

  // 门禁逻辑：改进足够 + 无严重劣化
  const pass = composite >= 0.15 && !regressions.some(r => r.severity === 'high');

  return { pass, compositeImprovement: composite, regressions };
}
```

> ⚠️ **重要变更**：
> - **Thinking Ratio 权重从 0.3 降为 0.1**：防止模型学会"话多"而非"做得对"
> - **新增 outcome_preservation 检查**：更守原则但没完成任务，也算失败
> - **新增劣化检测**：即使改进 ≥ 15%，如果引入严重劣化（如破坏任务目标），也不入库
> - **伪量化修复**：`planningRatioGain` 改为从真实工具序列检测，不再用 `includes('read_file')` 字符串匹配
```

**辅助函数实现**：

```typescript
// 从 Scribe 输出中提取工具调用序列（解析 JSON 格式的工具调用，不是字符串匹配）
function extractToolSequence(scribeOutput: string): string[] {
  const toolPattern = /"tool":\s*"(\w+)"/g;
  const tools: string[] = [];
  let match;
  while ((match = toolPattern.exec(scribeOutput)) !== null) {
    tools.push(match[1]);
  }
  return tools;
}

// 检测规划模式：真正的规划行为是工具调用序列模式，不是某个关键词
function detectPlanningPattern(toolSequence: string[]): boolean {
  // 规划模式示例：read_file → read_file → search → write（先调查再行动）
  // 反模式：直接 write 或 execute（上来就开干）
  const planningPatterns = [
    ['read_file', 'read_file'],           // 连续阅读 = 信息收集
    ['search_file_content', 'read_file'], // 搜索后阅读
    ['glob', 'read_file'],                // 文件发现后阅读
    ['read_file', 'search_file_content'], // 阅读后搜索
  ];

  return planningPatterns.some(pattern => {
    const patternStr = pattern.join('→');
    const seqStr = toolSequence.join('→');
    return seqStr.includes(patternStr);
  });
}
```

### 6.4 阶段四：持久化

| 输出 | 存储位置 | 用途 |
|------|---------|------|
| ORPO/DPO JSONL | `.state/exports/dpo/reflection-{timestamp}.jsonl` | LoRA 微调训练数据 |
| 反思日志 | `memory/reflection-log.md` (追加) | 人类可读的进化记录 |
| 进化任务 | `evolution_tasks` 表 (`source='nocturnal_evolution'`) | 分析和审计 |

### 6.5 即时生效机制：reflection-log.md 注入

> **短程增强回路 (R1.5)** — 反思价值在 LoRA 训练前就能兑现

反思产出的改进示范会在 **下一次会话** 立即生效，无需等待 LoRA 训练：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      即时生效流程                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ① Trinity 反思完成                                                         │
│         │                                                                   │
│         ▼                                                                   │
│  ② 追加写入 memory/reflection-log.md                                        │
│     格式：[原则ID] 场景摘要 → 改进示范                                       │
│         │                                                                   │
│         ▼                                                                   │
│  ③ before_prompt_build hook 读取最近 N 条反思记录                           │
│     (复用现有的 reflectionLog 注入逻辑)                                      │
│         │                                                                   │
│         ▼                                                                   │
│  ④ 注入到 appendSystemContext                                               │
│     （不占用 prependContext 的动态配额）                                     │
│         │                                                                   │
│         ▼                                                                   │
│  ⑤ 下次推理时，Agent 可参考"上次类似场景的改进示范"                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**注入配置**（复用现有 `ContextInjectionConfig`）：

```typescript
// 在 config.ts 中已有：
interface ContextInjectionConfig {
  thinkingOs: boolean;
  trustScore: boolean;
  reflectionLog: boolean;      // ← 复用此开关
  // ...
}

// 默认开启，保留最近 7 天的反思记录
const REFLECTION_LOG_RETENTION_DAYS = 7;
```

**reflection-log.md 格式示例**：

```markdown
## 2026-03-27 反思记录

### T-01 Survey Before Acting
- **场景**：用户请求新增 API endpoint
- **原始行为**：直接创建文件 → 失败（找不到依赖）
- **改进示范**：先读取 routes.ts 和 config.ts 了解结构 → 制定分步计划 → 成功

### T-03 Evidence Over Assumption
- **场景**：调试用户反馈的 bug
- **原始行为**：假设是缓存问题 → 清缓存 → 无效
- **改进示范**：先读取日志定位错误 → 发现是权限问题 → 修复
```

**与 LoRA 训练的关系**：

| 通道 | 生效速度 | 效果持久性 | 适用场景 |
|------|---------|-----------|---------|
| **即时注入** | 下次会话 | 依赖上下文保留 | 快速试错、新原则探索 |
| **LoRA 训练** | 积累 1K+ 后 | 模型参数级固化 | 高频原则内化 |

两个通道互补：即时注入快速验证改进方向，LoRA 训练固化验证有效的行为模式。

---

## 7. 消费级 GPU 训练方案 (RTX 4090 24GB)

### 7.1 硬件约束分析

```
RTX 4090 规格:
├── VRAM: 24 GB GDDR6X
├── CUDA Cores: 16384
├── Tensor Cores: 512 (4th Gen)
├── FP16 算力: 82.6 TFLOPS
└── 内存带宽: 1008 GB/s

训练时的 VRAM 分配:
├── 模型权重 (7B, NF4 量化):    ~3.5 GB
├── LoRA 适配器 (rank 16):      ~0.2 GB
├── 优化器状态 (AdamW 8-bit):   ~0.8 GB
├── 梯度 (gradient checkpointing): ~2 GB
├── 激活值缓存:                  ~4-6 GB
├── KV Cache + 序列:            ~2-4 GB
└── 预留:                        ~4 GB
    ─────────────────────────────────
    总计:                        ~17-21 GB ✅ 可用
```

### 7.2 推荐模型选择

| 模型 | 参数量 | NF4 VRAM | ORPO 可行？ | 中文能力 | 推荐度 |
|------|--------|---------|-----------|---------|--------|
| **Qwen2.5-7B-Instruct** | 7B | ~4 GB | ✅ 最佳 | ★★★★★ | ⭐ 首选 |
| Llama-3.1-8B-Instruct | 8B | ~4.5 GB | ✅ 可行 | ★★★ | 备选 |
| Mistral-7B-Instruct-v0.3 | 7B | ~4 GB | ✅ 可行 | ★★ | 备选 |
| Qwen2.5-14B-Instruct | 14B | ~8 GB | ⚠️ 紧张 | ★★★★★ | 激进选择 |
| Qwen2.5-32B | 32B | ~18 GB | ❌ 不行 | ★★★★★ | 需要多卡 |

**首选: Qwen2.5-7B-Instruct** — 中文能力最强、4-bit 后仅 4GB、留充足空间给训练。

### 7.3 训练框架选择

| 框架 | 内存优化 | 速度 | ORPO 支持 | 易用性 | 推荐 |
|------|---------|------|----------|--------|------|
| **Unsloth** | ★★★★★ (官方宣称 60% 减少) | ★★★★★ (2x 加速) | ✅ 原生 | ★★★★★ | ⭐ 首选 |
| Axolotl | ★★★★ | ★★★ | ✅ | ★★★ | 备选 |
| TRL (HuggingFace) | ★★★ | ★★★ | ✅ | ★★★★ | 参考级 |
| LLaMA-Factory | ★★★★ | ★★★★ | ✅ | ★★★★ | 备选 |

**首选: Unsloth** — 专门为消费级 GPU 优化，自动启用所有内存优化技巧。

### 7.4 训练配置 (Unsloth + ORPO)

```python
# train_nocturnal.py — RTX 4090 优化配置
from unsloth import FastLanguageModel
from trl import ORPOTrainer, ORPOConfig
from datasets import load_dataset

# ── 模型加载 ──
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="Qwen/Qwen2.5-7B-Instruct",
    max_seq_length=2048,          # 与 sleep config 的 max_trajectory_tokens 对齐
    dtype=None,                    # 自动选择
    load_in_4bit=True,            # NF4 量化 ≈ 4GB
)

# ── LoRA 配置 ──
model = FastLanguageModel.get_peft_model(
    model,
    r=16,                          # LoRA rank — 16 是性价比最高的
    target_modules=[               # 只训练关键层
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj",
    ],
    lora_alpha=16,
    lora_dropout=0,                # Unsloth 推荐 0 (已有 QLoRA 正则化)
    bias="none",
    use_gradient_checkpointing="unsloth",  # 启用梯度检查点
)

# ── 数据加载 ──
# 从 .state/exports/dpo/ 目录聚合所有 JSONL
dataset = load_dataset("json", data_files=".state/exports/dpo/*.jsonl")

# ── ORPO 训练配置 ──
training_args = ORPOConfig(
    output_dir="./output/nocturnal-evolution",
    num_train_epochs=3,
    per_device_train_batch_size=2,      # 4090 可以跑 batch=2
    gradient_accumulation_steps=8,       # 有效 batch = 2 × 8 = 16
    learning_rate=5e-5,
    lr_scheduler_type="cosine",
    max_length=2048,                     # 总序列长度
    max_prompt_length=512,               # prompt 部分最大长度
    beta=0.1,                            # ORPO 的 odds ratio 权重
    optim="adamw_8bit",                  # 8-bit AdamW 省内存
    bf16=True,                           # 4090 支持 BF16
    logging_steps=10,
    save_steps=100,
    warmup_ratio=0.1,
    report_to="none",                    # 离线训练，不需要 W&B
)

# ── 启动训练 ──
trainer = ORPOTrainer(
    model=model,
    args=training_args,
    train_dataset=dataset["train"],
    tokenizer=tokenizer,
)

trainer.train()

# ── 保存 ──
model.save_pretrained("./output/nocturnal-evolution/final")
tokenizer.save_pretrained("./output/nocturnal-evolution/final")
```

### 7.5 训练数据的 Token 预算

| 字段 | Token 预算 | 说明 |
|------|-----------|------|
| `prompt` | ≤ 512 tokens | 任务描述 + 上下文 |
| `chosen` | ≤ 1024 tokens | 改进后的轨迹（Scribe 输出截断） |
| `rejected` | ≤ 1024 tokens | 原始轨迹摘要（截断） |
| **总计** | ≤ 2048 tokens | 适配 4090 的内存 |

**为什么是 2048 而不是 4096？**
- 4096 在 ORPO 训练中需要 ~20-24 GB VRAM (接近极限)
- 2048 需要 ~14-18 GB (留有 6-10 GB 余量)
- 对于行为模式训练，2048 token 足够表达"先调查→再规划→再执行"的模式转变
- 余量可用于偶尔的 batch_size=3 或更大的 LoRA rank

### 7.6 训练监控指标

```
训练中监控:
├── loss (应稳步下降)
├── chosen_rewards (应持续上升)
├── rejected_rewards (应持续下降)
├── reward_margin = chosen_rewards - rejected_rewards (应持续扩大)
└── VRAM usage (应 < 20GB)

训练后验证:
├── 在 5 个标准任务上运行微调后模型
├── detectThinkingModelMatches() 计算激活率
├── 对比: 微调前 vs 微调后的 Thinking Ratio
└── 人工审核 10 条输出的行为模式变化
```

### 7.7 推理部署

微调完成后，LoRA adapter 可以通过多种方式部署：

| 方式 | 适用场景 | VRAM 需求 |
|------|---------|----------|
| **Unsloth 推理** | 本地测试 | ~4-6 GB |
| **vLLM + LoRA** | 高吞吐推理 | ~6-8 GB |
| **llama.cpp GGUF** | 极致轻量 | ~4-6 GB |
| **Ollama 自定义模型** | 最简部署 | ~4-8 GB |

推荐流程:
1. 训练完成 → 导出 LoRA adapter
2. 用 `llama.cpp` 或 `Unsloth` 合并 adapter 到基础模型
3. 量化为 GGUF Q4_K_M 格式
4. 通过 `Ollama` 部署为自定义模型
5. 在 OpenClaw 中配置为可选推理模型

---

## 8. 扩展路径

### 8.1 三阶段演进

```
Phase 1 (MVP, 2 周)            Phase 2 (增强, 3 周)          Phase 3 (训练, 持续)
━━━━━━━━━━━━━━━━━━            ━━━━━━━━━━━━━━━━━━           ━━━━━━━━━━━━━━━━━━
· 单 subagent 反思             · Trinity 3 角色              · 积累 1K+ 对比对
· 基础指标计算                  · Arbiter 门禁               · Unsloth + ORPO 训练
· ORPO JSONL 输出              · 七维指标评分                · A/B 验证
· 人工审核 10 条               · EVOLUTION_QUEUE 分派        · 迭代 prompt
```

### 8.2 质量闭环

```
日间工作 → 轨迹记录 → 🌙 睡眠反思 → ORPO 数据
    ↑                                  │
    │                                  │ Arbiter ≥ 15%
    │                                  ▼
微调后的模型表现 ←── QLoRA 微调 ←── Unsloth 训练 (4090)
    │
    └→ 代理指标对比验证 → 迭代优化反思 prompt
```

---

## 9. 决策卫生机制 — 降低规划与决策噪声

> LLM 的工具调用能力会持续改善，但**规划和决策能力的薄弱是结构性缺陷**。
> 本节引入决策科学中的"决策卫生"(Decision Hygiene) 框架来系统性降噪。

### 9.1 LLM 规划能力的四个结构性缺陷

| # | 缺陷 | 本质 | 后果 |
|---|------|------|------|
| 1 | **无跨轮次工作记忆** | 上下文窗口是压缩缓冲区，不是真正的工作记忆 | 早期的规划约束被"挤出"注意力范围 |
| 2 | **无参考类别数据** | 不知道"上次做类似任务的成功率和常见陷阱" | 每次规划都从零开始，无法借鉴历史 |
| 3 | **单路径思维** | 生成第一个方案就直接执行，不考虑备选 | 被锚定在次优方案上 |
| 4 | **时间近视** | RLHF 训练让模型优化即时满意度，而非长期成功 | 跳过规划直接开干，短期看快，长期看慢 |

### 9.2 三类噪声在 Agent 中的表现

```
场景噪声 (Occasion Noise):
  同一个任务，不同时间执行 → 不同的规划决策
  来源: temperature 随机性、上下文排列顺序、残余锚点

模式噪声 (Pattern Noise):
  不同任务类型的规划质量差异 → 编码任务 ★★★★，架构任务 ★
  来源: 训练数据分布偏斜 (代码规划示例远多于架构规划)

水平噪声 (Level Noise):
  决策"谨慎度"校准不一致 → 有时过度谨慎，有时过度激进
  来源: 缺乏一致的风险评估框架
```

### 9.3 七个决策卫生协议

#### 协议 1: 结构化决策记录 (SDR) — 消除单路径思维

在每个**规划节点**，强制 Agent 输出:

```typescript
interface StructuredDecisionRecord {
  decisionPoint: string;              // "选择认证方案"
  alternatives: Array<{               // 强制 ≥2 个备选
    name: string;
    pros: string[]; cons: string[];
    risk: 'low' | 'medium' | 'high';
    reversibility: 'easy' | 'hard' | 'irreversible';
  }>;
  criteria: string[];                  // 评估标准 (在看到方案前确定)
  chosen: string;
  rationale: string;
  fallbackPlan: string;               // 回退计划
}
```

#### 协议 2: 参考类别预测 — 弥补历史记忆缺失

规划前，从 trajectory.db 自动查询类似历史任务:

```sql
-- 找到相似任务的历史成功率
SELECT
  COUNT(*) as similar_tasks,
  AVG(CASE WHEN outcome='ok' THEN 1.0 ELSE 0.0 END) as success_rate,
  GROUP_CONCAT(DISTINCT error_type) as common_errors
FROM task_outcomes t
JOIN tool_calls tc ON t.session_id = tc.session_id
WHERE t.summary LIKE '%重构%' OR t.summary LIKE '%refactor%'
```

注入 Agent 上下文: "类似任务历史成功率 60%，最常见失败原因: 路径错误"

#### 协议 3: 事前验尸 (Pre-mortem) — 消除过度乐观

在 Agent 完成规划后、执行前，注入一行 prompt:

```
在你确定计划后，请先完成这一步:
"假设这个计划在执行中失败了。列出 3 个最可能的失败原因，
并为每个添加一个预防措施。"
```

成本: 约 200-500 tokens。回报: 显著提前暴露风险。
**这是成本最低、回报最高的决策卫生措施。**

#### 协议 4: 中介评估 — 将模糊判断拆分为事实查询

```
❌ 整体判断: "这个重构难度如何？" → "中等" (噪声极高)
✅ 中介评估:
   "需要修改多少个文件？" → 7 个  (可查)
   "有测试覆盖吗？" → 60% (可查)
   "涉及数据库变更？" → 否 (二元)
   → 综合: 中高难度 (每个子判断噪声远低于整体判断)
```

#### 协议 5: 决策日志 — 记录"为什么"而非只记录"做了什么"

trajectory.db 新增 `decision_records` 表:

```sql
CREATE TABLE decision_records (
  id INTEGER PRIMARY KEY,
  session_id TEXT, turn_index INTEGER,
  decision_point TEXT,       -- "选择认证方案"
  alternatives_json TEXT,    -- [{name, pros, cons}]
  chosen TEXT, rationale TEXT,
  confidence TEXT,           -- high/medium/low
  created_at TEXT
);
```

夜间反思时，Philosopher 审计**决策过程**而非只看行为结果。

#### 协议 6: 反锚定 — Trinity 独立判断

```
当前 (有锚定):                   改进 (独立判断):
Dreamer → Philosopher             Philosopher 独立分析原始轨迹
          (被 Dreamer 锚定)        Dreamer 独立标注决策点
                                   → 合并两份独立分析
                                   → 覆盖面更广
```

#### 协议 7: 规划聚焦的 DPO 训练数据

在 DPO 数据中**加权规划节点**（替换价值 ★★★★★）高于执行节点（★★）:

```python
# 节点类型自动标注: 后续有 ≥2 个工具调用的 turn = planning_node
# 训练权重: planning=3x, diagnostic=2x, execution=1x
```

### 9.4 协议实施优先级

| 阶段 | 协议 | 成本 | 实施难度 |
|------|------|------|---------|
| **Phase 1** | 事前验尸 (#3) | 一行 prompt 注入 | ★ 最简单 |
| **Phase 2** | 参考类别 (#2) | SQL 查询 + 上下文注入 | ★★ |
| **Phase 2** | 中介评估 (#4) | prompt 模板改造 | ★★ |
| **Phase 2** | SDR (#1) | JSON schema + DB 表 | ★★★ |
| **Phase 2** | 决策日志 (#5) | 新 DB 表 + 记录逻辑 | ★★★ |
| **Phase 2** | 反锚定 (#6) | Trinity 调用顺序调整 | ★★ |
| **Phase 3** | 规划聚焦 DPO (#7) | 训练数据加权逻辑 | ★★ |

---

## 10. 已知瑕疵与增强措施

> v2.0 的自审结果。以下 7 个瑕疵在 v3.0 中通过对应的增强措施解决。

### 10.1 瑕疵总览

| # | 瑕疵 | 严重度 | 增强措施 | 阶段 |
|---|------|--------|---------|------|
| 1 | LLM 评 LLM = 循环论证 | 🔴 高 | 可执行性验证层 (§10.2) | Phase 2 |
| 2 | 静态阈值脆弱 | 🟡 中 | 自适应阈值系统 (§10.3) | Phase 2 |
| 3 | 训练数据多样性坍缩 | 🔴 高 | 模型多样性 + 锦标赛选择 (§10.4, §10.7) | Phase 2 |
| 4 | Scribe 空中楼阁 | 🔴 高 | 可执行性验证层 (§10.2) | Phase 2 |
| 5 | 线性截断丢失关键信息 | 🟡 中 | 智能轨迹压缩 (§10.5) | Phase 2 |
| 6 | 无跨 Session 模式学习 | 🟡 中 | 跨 Session 模式注入 (§10.6) | Phase 2 |
| 7 | 训练-推理分布偏移 | 🟡 中 | 任务类型标签 + 平衡抽样 (§10.8) | Phase 3 |

### 10.2 可执行性验证层 — 解决循环论证 + 空中楼阁

**问题**: Scribe 可能写出"先读取 config.ts"，但该文件不存在。用"不可执行的理想"训练模型会让模型学会"说漂亮话"而非"做实事"。

**方案**: 用**代码**（而非 LLM）验证 Scribe 输出的可执行性：

```typescript
function verifyExecutability(scribeOutput: string, workspaceDir: string): ExecutabilityCheck {
  // 1. 提取轨迹中引用的文件路径 → 检查是否存在
  const fileRefs = extractFileReferences(scribeOutput);
  const missingFiles = fileRefs.filter(f => !fs.existsSync(path.join(workspaceDir, f)));

  // 2. 提取工具调用 → 检查是否合法
  const toolRefs = extractToolReferences(scribeOutput);
  const invalidTools = toolRefs.filter(t => !VALID_TOOLS.has(t));

  // 3. 步骤顺序: read 应该在 write 之前 (规则引擎，非 LLM)
  const steps = extractSteps(scribeOutput);
  const firstWrite = steps.findIndex(s => s.type === 'write');
  const sequenceValid = firstWrite === -1 || steps.slice(0, firstWrite).some(s => s.type === 'read');

  return { fileReferencesValid: missingFiles.length === 0, missingFiles, sequenceValid };
}
```

**降级策略**: 验证失败时**模糊化**而非丢弃——把"读取 config.ts"替换为"读取相关配置文件"，保留行为模式教学价值。

### 10.3 自适应阈值系统 — 解决静态阈值脆弱

**核心原则**: LLM 决定"反思什么"（定性），代码决定"接受多少"（定量）。

```typescript
class AdaptiveThresholdManager {
  private readonly EMA_ALPHA = 0.2;

  adjustAfterReflection(result: { arbiterPassed: boolean; compositeImprovement: number }): void {
    this.recentResults.push(result);
    if (this.recentResults.length > 50) this.recentResults.shift();

    const passRate = this.recentResults.filter(r => r.arbiterPassed).length / this.recentResults.length;

    // 目标通过率: 40-60% — 太高说明门禁太松，太低说明太严
    if (passRate > 0.6) {
      this.arbiterThreshold = Math.min(0.35, this.arbiterThreshold * 1.05);
    } else if (passRate < 0.4) {
      this.arbiterThreshold = Math.max(0.08, this.arbiterThreshold * 0.95);
    }

    // 冷却期: 数据积累太慢 (<2条/天) → 缩短; 太快 (>5条/天) → 延长
    if (this.dailyEntryCount < 2) {
      this.cooldownMs = Math.max(30 * 60_000, this.cooldownMs * 0.85);
    } else if (this.dailyEntryCount > 5) {
      this.cooldownMs = Math.min(4 * 3600_000, this.cooldownMs * 1.2);
    }

    // minTurns: 跟踪 session 长度的 EMA，取 50% 分位
    this.sessionLengthEma = this.EMA_ALPHA * result.sessionTurns + (1 - this.EMA_ALPHA) * this.sessionLengthEma;
    this.minTurns = Math.max(4, Math.round(this.sessionLengthEma * 0.5));
  }
}
```

| 参数 | 初始值 | 动态范围 | 调整触发 |
|------|--------|---------|---------|
| `arbiterThreshold` | 0.15 | 0.08 ~ 0.35 | Arbiter 通过率偏离 40-60% |
| `cooldownMs` | 2h | 30min ~ 4h | 日积累量偏离 2-5 条 |
| `minTurns` | 8 | 4 ~ ∞ | Session 长度 EMA 变化 |

### 10.4 模型多样性 — 解决训练数据坍缩

```
多模型 Trinity (如果环境有多模型):
  Dreamer:     当前会话模型 (贴近原始行为)
  Philosopher: 推理最强模型 (如 o4-mini / DeepSeek-R1)
  Scribe:      代码最强模型 (如 Claude / GPT-4o)

单模型降级:
  Dreamer:     temp=0.3 (精确回溯)
  Philosopher: temp=0.1 (严谨审计)
  Scribe:      temp=0.7 (创造性改写)
```

**多样性监控**: 每条 DPO 数据计算 `diversity_hash`。如果最近 10 条 hash 相似度 > 80%，自动提升 Scribe temperature 或切换 prompt 变体。

### 10.5 智能轨迹压缩 — 解决线性截断问题

不按位置截断，按**信息密度**选择最有价值的 turns：

```typescript
function computeInfoScore(turn, index, trajectory): number {
  let score = 0;
  if (isAfterUserCorrection(turn, trajectory))    score += 50;  // 修正后的 turn 最有教育价值
  if (isNearToolFailure(turn, index, trajectory))  score += 40;  // 失败后的诊断
  score += detectThinkingModelMatches(turn.text).length * 15;    // 含思维模型信号
  if (index === 0 || index === lastIndex)           score += 30;  // 首尾边界
  return score;
}

// 按价值排序 → 选 top-K 填满 token 预算 → 恢复原始时序
```

### 10.6 跨 Session 模式注入 — 解决单 session 盲区

用 **SQL**（不是 LLM）聚合历史弱点，注入 Philosopher 的上下文：

```sql
-- 错误聚类: Agent 在哪些操作上系统性犯错？
SELECT tool_name, error_type, COUNT(*) as freq
FROM tool_calls WHERE outcome = 'failure'
GROUP BY tool_name, error_type ORDER BY freq DESC LIMIT 5;

-- 修正模式: 用户总在哪些场景修正 Agent？
SELECT correction_cue, COUNT(*) as freq
FROM user_turns WHERE correction_detected = 1
GROUP BY correction_cue ORDER BY freq DESC LIMIT 5;
```

Philosopher prompt 注入：
```
### 历史系统性弱点 (过去 30 天)
- write_file 失败中 42% 与路径错误相关
- 用户修正中 35% 涉及"范围过大"
- T-01 在过去 20 session 中平均激活率仅 15%
请特别关注: 本 session 是否重复上述已知弱点？
```

### 10.7 锦标赛选择 — 提高 Scribe 输出质量

生成多个候选，用**代码**（不是 LLM）选最优：

```
Philosopher 审计 → Scribe 候选 A (temp=0.5)
                 → Scribe 候选 B (temp=0.8)
                       ↓
              代码评分器 (非 LLM):
              ├── thinkingModelActivation 得分
              ├── 可执行性验证得分
              ├── 与最近 10 条的差异度 (防坍缩)
              └── 综合分 → 选最优入库
```

可配置 `tournament_candidates: 1 | 2 | 3`（Phase 1 默认 1，Phase 2 可升至 2-3）。

### 10.8 任务类型标签 + 平衡抽样 — 解决分布偏移

训练数据加类型标签，加载时按类型平衡：

```jsonl
{ "prompt": "[TASK: code_editing] ...", "chosen": "...", "rejected": "...",
  "metadata": { "task_type": "code_editing", "complexity": "medium" } }
```

```python
# 训练时: 确保任何单一 task_type 不超过 40%
balanced = balance_by_task_type(dataset, max_ratio=0.4)
```

### 10.9 结构化 JSON 输出 — 约束 Trinity 角色

强制 Trinity 输出结构化 JSON，而非自由文本：

```typescript
// Philosopher 必须输出:
interface PhilosopherOutput {
  auditResults: Array<{
    turnIndex: number;            // 必须引用具体 turn (可验证)
    violatedPrinciples: string[]; // T-01, T-03 等 (可量化)
    diagnosis: string;
    severity: 'low' | 'medium' | 'high';
  }>;
  overallAdherence: number;       // 0-1 (由代码交叉验证)
}
```

好处: `turnIndex` 可以用代码验证范围合法性，`violatedPrinciples` 可以直接统计，防止 LLM 跳过分析。

---

## 11. 增强后的完整管线

```
┌───────────────────────────────────────────────────────────────────┐
│  Nocturnal Evolution v3.0 Pipeline                                │
│                                                                   │
│  ① EVOLUTION_QUEUE 触发                                          │
│     └── AdaptiveThresholdManager 动态决定冷却期/门槛              │
│                                                                   │
│  ② 轨迹提取                                                      │
│     └── 智能压缩 (按信息密度，非线性截断)         [增强 §9.5]     │
│     └── 跨 Session 模式摘要注入                   [增强 §9.6]     │
│                                                                   │
│  ③ Trinity (多模型/多 temperature)                [增强 §9.4]     │
│     └── 全部使用结构化 JSON 输出                  [增强 §9.9]     │
│     Dreamer(0.3) → Philosopher(0.1) → Scribe(0.7)               │
│                                                                   │
│  ④ 可执行性验证 (代码，非 LLM)                    [增强 §9.2]     │
│     └── 文件引用检查 + 工具合法性 + 步骤顺序                      │
│     └── 失败时: 模糊化处理而非直接丢弃                            │
│                                                                   │
│  ⑤ 锦标赛选择 (可选, 2-3 个 Scribe 候选)         [增强 §9.7]     │
│     └── 代码评分: 指标分 + 可执行分 + 多样性分                    │
│                                                                   │
│  ⑥ Arbiter (动态阈值)                             [增强 §9.3]     │
│     └── compositeImprovement ≥ adaptive_threshold                 │
│     └── 目标通过率: 40-60% → 自动校准                             │
│                                                                   │
│  ⑦ 持久化 + 反馈回路                                             │
│     └── ORPO JSONL (含任务类型标签)               [增强 §9.8]     │
│     └── AdaptiveThresholdManager.adjust()                         │
│     └── diversity_hash 检查 (防坍缩)              [增强 §9.4]     │
└───────────────────────────────────────────────────────────────────┘
```

---

## 12. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| LLM 评 LLM 循环论证 | chosen 只是"说得好"而非"做得对" | 可执行性验证层 (§9.2) |
| 反思输出质量不稳定 | 低质量数据污染训练集 | Arbiter 动态门禁 + 人工抽样审核 |
| 训练数据多样性坍缩 | 模型学到刻板模板 | 模型多样性 (§9.4) + 锦标赛选择 (§9.7) |
| Scribe 写空中楼阁 | 教模型引用不存在的文件 | 可执行性验证 (§9.2) 模糊化降级 |
| 线性截断丢失关键信息 | 最有教育价值的决策转折被截掉 | 智能压缩 (§9.5) |
| 单 Session 反思有盲区 | 看不到系统性弱点 | 跨 Session 模式注入 (§9.6) |
| 训练-推理分布偏移 | 微调后对话场景过度规划 | 任务类型标签 + 平衡抽样 (§9.8) |
| 反思消耗过多 token | 成本不可控 | 自适应冷却期 (§9.3) |
| 4090 VRAM 不够 | 训练 OOM | ORPO + NF4 + gradient checkpointing |

---

## 13. 实现文件参考

| 模块 | 现有文件 | 复用方式 |
|------|---------|---------|
| 轨迹数据 | `src/core/trajectory.ts` | 直接读 SQLite DB |
| 思维模型 | `src/core/thinking-models.ts` | `detectThinkingModelMatches()` |
| 进化队列 | `src/service/evolution-worker.ts` | EVOLUTION_QUEUE 分派 + 消费 |
| 空闲检测 | `llm_output` hook + `.last_active.json` | 见 §5.2 |
| Subagent | `src/openclaw-sdk.d.ts` | `api.runtime.subagent.run()` |
| 配置 | `src/core/config.ts` | `config.get('sleep.*')` |
| 进化日志 | `src/core/evolution-logger.ts` | 记录反思事件 |
| 路径 | `src/core/paths.ts` | `resolvePdPath('EXPORTS_DIR')` |
| 原则状态 | `src/core/evolution-reducer.ts` | 复用 Principle 类型 + 新增内化追踪 |

---

## 14. 验收标准

### Phase 1 完成的定义

- [ ] Agent 空闲 30 分钟后，自动触发第一次反思
- [ ] 反思产出的 ORPO/DPO JSONL 文件格式正确、可被训练框架解析
- [ ] 反思后的思维模型激活率比原始轨迹高（用 `detectThinkingModelMatches()` 客观度量）
- [ ] 人工审核 10 条对比对，>7 条的 chosen 确实比 rejected 更好
- [ ] 不影响正常工作（不修改现有文件逻辑，只新增文件 + 修改 evolution-worker）
- [ ] 所有现有测试 `npm test` 通过

### Phase 2 完成的定义 (增强措施)

- [ ] AdaptiveThresholdManager 正常运行，Arbiter 通过率稳定在 40-60%
- [ ] 可执行性验证层拦截了 >30% 的不可执行改进轨迹
- [ ] 智能压缩保留了 >80% 的用户修正后 turns
- [ ] 跨 Session 模式注入正确运行，Philosopher 能引用历史弱点
- [ ] 结构化输出中 turnIndex 范围合法率 >95%

### Phase 3 完成的定义

- [ ] 积累 1K+ 通过 Arbiter 门禁的高质量对比对
- [ ] 在 RTX 4090 上成功完成 ORPO 训练（VRAM < 20GB）
- [ ] 微调后模型的思维模型激活率 > 原始模型 30%
- [ ] A/B 测试中微调模型的 Thinking Ratio 显著高于原始模型
- [ ] 导出为 GGUF 并可通过 Ollama 部署
- [ ] 任务类型分布偏差 < 40%（无单一类型主导）

---

## 附录 A: 设计原则

| # | 原则 | 应用 |
|---|------|------|
| 1 | **LLM 定性，代码定量** | Arbiter 阈值由代码调，Trinity 分析由 LLM 做 |
| 2 | **验证 > 信任** | Scribe 输出必须过可执行性验证 |
| 3 | **多样性 > 一致性** | 多 temperature + diversity hash 防坍缩 |
| 4 | **信息密度 > 线性截断** | 按教育价值保留 trajectory |
| 5 | **系统 > 个案** | 跨 session 模式挖掘优先于单 session 反思 |
| 6 | **自适应 > 固定** | 所有超参通过反馈回路动态调整 |
| 7 | **渐进 > 完美** | Phase 1 跑通，增强措施 Phase 2-3 逐步加入 |

---

## 附录 B: 与现有 PD 代码集成矩阵

> **评审日期**: 2026-03-27

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      Nocturnal Evolution 集成矩阵                         │
├─────────────────────┬─────────────┬──────────────────────────────────────┤
│ 组件                │ 复用程度    │ 具体方案                              │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ trajectory.ts       │ ████████░░  │ 直接复用 listAssistantTurns()        │
│                     │ 80%         │ 复用 getDataStats().lastIngestAt     │
│                     │             │ 扩展 exportOrpoJsonl()               │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ thinking-models.ts  │ ██████████  │ 直接复用 detectThinkingModelMatches()│
│                     │ 100%        │ 无需修改                              │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ evolution-worker.ts │ █████░░░░░  │ 复用调度框架                          │
│                     │ 50%         │ 新增 taskType: 'sleep_reflection'    │
│                     │             │ 新增 checkIdleAndEnqueueReflection() │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ pain.ts             │ ███████░░░  │ 复用 pain 事件链                      │
│                     │ 70%         │ 扩展触发条件（空闲 → pain 信号）       │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ session-tracker.ts  │ ███░░░░░░░  │ 复用 getDailySummary()                │
│                     │ 30%         │ 新增 exportSessionTimeline()          │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ Arbiter 评分        │ ░░░░░░░░░░  │ 🆕 新建                               │
│                     │ 0%          │ nocturnal-arbiter.ts                  │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ Trinity 角色        │ ░░░░░░░░░░  │ 🆕 新建                               │
│ (Dreamer/Philosopher│ 0%          │ agents/dreamer.md                     │
│ /Scribe)            │             │ agents/philosopher.md                 │
│                     │             │ agents/scribe.md                      │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ 空闲检测            │ ░░░░░░░░░░  │ 🆕 新建                               │
│                     │ 0%          │ nocturnal-idle-detector.ts            │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ ORPO 导出           │ ████░░░░░░  │ 扩展 exportCorrections()              │
│                     │ 40%         │ 新增 exportOrpoJsonl() 方法           │
└─────────────────────┴─────────────┴──────────────────────────────────────┘
```

### SDK 验证结果

| 检查项 | 结果 | 位置 |
|--------|------|------|
| `api.runtime.subagent.run()` 支持 `extraSystemPrompt` | ✅ | `openclaw-sdk.d.ts:68-76` |
| `trajectory.getDataStats().lastIngestAt` | ✅ | `trajectory.ts:37,891` |
| `llm_output` hook 存在 | ✅ | `PluginHookLlmOutputEvent` |
| `detectThinkingModelMatches()` | ✅ | `thinking-models.ts` |

---

## 附录 C: 评审发现的问题

### 高风险问题

| # | 问题 | 影响 | 建议 |
|---|------|------|------|
| **1** | Trinity 角色调用方式需验证 SDK | 设计文档使用 `extraSystemPrompt` 参数 | ✅ 已验证 SDK 支持 |
| **2** | 空闲检测数据源 | 需要确认 `lastIngestAt` 可用 | ✅ 已验证 trajectory.ts 有此字段 |
| **3** | Arbiter 15% 阈值无实证依据 | 设计承认"缺乏实证基础" | Phase 0 先收集 50+ 条数据确定阈值 |
| **4** | Token 截断策略 | 线性截断可能丢失高价值 turns | 需实现智能压缩（Phase 2） |

### 中风险问题

| # | 问题 | 影响 | 建议 |
|---|------|------|------|
| **5** | Phase 1 vs v3.0 范围不清晰 | 7 个增强措施未明确分配 | 见附录 D Phase 规划 |
| **6** | 可执行性验证层 Phase 分配不明 | 对防止"空中楼阁"至关重要 | ✅ 已纳入 Phase 1 |

---

## 附录 D: 建议的实施路线

```
Phase 0: 设计验证 (≤1 周)
─────────────────────────────
核心目标：验证 Arbiter 能否区分"真改进"和"表演式改进"

□ **阈值鸡蛋问题解决**：先以 **0% 阈值全量收集**，人工标注 50 条后反推合理阈值
  - 不存在"先有阈值还是先有数据"的困境
  - 人工标注后分析 compositeImprovement 分布，选取合适 cut-off
□ 抽取 50~100 条真实 session
□ Dreamer / Philosopher JSON 化
□ **人工审核 Arbiter 排序结果**：
  - "高分样本"里有多少真的是 better process？
  - "低分样本"里有多少是模型"话多但没实质改善"？
□ **验证 Thinking Ratio 与行为改善的相关性**：
  - 高 Thinking Ratio 的样本，失败率是否真的下降？
  - 低 Thinking Ratio 的样本，是否可能是高效执行？

⚠️ **这一阶段不训练**，只验证信号有效性。

            ↓

Phase 1: MVP (2 周)
───────────────────
🚫 **范围控制规则**：Phase 1 的 PR **不接受任何 Phase 2 功能**。防止"看起来不复杂"导致范围蔓延。

新增文件:
  src/service/nocturnal-service.ts         # 核心反思流程
  src/core/nocturnal-arbiter.ts            # 质量门禁
  src/core/nocturnal-executability.ts      # 可执行性验证层
  agents/reflector.md                      # 单角色反思 Agent

修改文件:
  evolution-worker.ts                      # 新增 sleep_reflection 任务类型
  trajectory.ts                            # 扩展 exportOrpoJsonl()

功能:
  ✓ 空闲检测 → 入队 sleep_reflection
  ✓ 单 subagent 反思（非 Trinity 三角色）
  ✓ 基础指标计算 + Arbiter 门禁
  ✓ 可执行性验证（文件/工具/顺序检查）
  ✓ ORPO JSONL 输出
  ✓ 人工审核 10 条对比对

            ↓

Phase 2: Trinity 增强 (3 周)
──────────────────────────────
新增文件:
  agents/dreamer.md                        # 回放者角色
  agents/philosopher.md                    # 原则官角色
  agents/scribe.md                         # 记录员角色
  src/core/nocturnal-metrics.ts            # 七维指标体系
  src/core/adaptive-threshold.ts           # 自适应阈值

功能:
  ✓ Trinity 三角色链式调用
  ✓ 七维代理指标计算
  ✓ 动态阈值自适应（通过率 40-60%）
  ✓ 智能压缩
  ✓ 跨 Session 模式注入

            ↓

Phase 2.5: 数据质量验证 (≤1 周)
─────────────────────────────────
验收标准:
  □ 入库数据 ≥ 100 条
  □ 类型分布偏差 < 50%
  □ 人工抽样 20 条，合格率 ≥ 80%
  □ 运行 IA³ 快速验证（见附录 F）

            ↓

Phase 3: 训练闭环 (持续)
─────────────────────────
新增文件:
  scripts/train_nocturnal.py               # Unsloth + ORPO 训练脚本
  scripts/export-gguf.py                   # 导出 GGUF 格式

功能:
  ✓ 积累 1K+ 高质量对比对
  ✓ RTX 4090 ORPO 训练 (VRAM < 20GB)
  ✓ A/B 测试验证微调效果
  ✓ 导出 GGUF + Ollama 部署
```

---

## 附录 E: Phase 1 MVP 任务清单

```yaml
Phase 1 MVP 任务拆解:

  1. 空闲检测模块 (2d)
     - [ ] 新增 nocturnal-idle-detector.ts
     - [ ] 复用 trajectory.getDataStats().lastIngestAt 判断空闲
     - [ ] 实现 shouldEnterSleepMode() 三重门卫逻辑
     - [ ] 配置默认值 idle_threshold_ms: 1800000 (30min)

  2. 队列集成 (1d)
     - [ ] EvolutionQueueItem 新增 taskType: 'sleep_reflection' | 'pain'
     - [ ] evolution-worker.ts 新增 checkIdleAndEnqueueReflection()
     - [ ] processEvolutionQueue() 增加 taskType 分发逻辑

  3. 反思服务 (3d)
     - [ ] 新增 nocturnal-service.ts
     - [ ] 实现 extractStructuredTrajectory() (复用 trajectory.ts)
     - [ ] 实现 singleAgentReflection() (单 subagent 版本)

  4. 质量门禁 (2d)
     - [ ] 新增 nocturnal-arbiter.ts
     - [ ] 实现 arbiterGate() 综合评分
     - [ ] 复用 detectThinkingModelMatches() 计算激活率
     - [ ] 初始阈值 15%，后续由 Phase 2 自适应
     - [ ] 实现劣化检测（见附录 M.5）

  5. 可执行性验证 (1d)
     - [ ] 新增 nocturnal-executability.ts
     - [ ] 实现文件引用检查（路径是否存在）
     - [ ] 实现工具合法性检查
     - [ ] 实现步骤顺序验证（read 在 write 前）
     - [ ] 实现失败时模糊化处理

  6. ORPO 导出 (1d)
     - [ ] 扩展 trajectory.ts 新增 exportOrpoJsonl()
     - [ ] 输出 {prompt, chosen, rejected, metadata} 格式
     - [ ] 实现 token 截断 (max_trajectory_tokens: 2048)

  7. 测试与验证 (1d)
     - [ ] 单元测试: nocturnal-idle-detector.test.ts
     - [ ] 单元测试: nocturnal-arbiter.test.ts
     - [ ] 集成测试: 空闲 → 入队 → 反思 → 导出完整流程
     - [ ] 人工审核 10 条对比对
```

---

## 附录 F: CPU/手机友好训练方案 — IA³ + 小模型

设计目标: 让 Nocturnal Evolution 在没有 GPU 的设备上也能训练

### IA³ (Infused Adapter by Injecting Parameters) 原理

核心思想: 不引入新的参数矩阵，只给现有参数乘以一个可学习的缩放向量。

```
传统 LoRA:  W' = W + BA      (新增两个矩阵)
IA³:        W' = W ⊙ l       (只新增一个向量 l，逐元素相乘)
```

### 参数量对比 (7B 模型)

| 方法 | 可训练参数 | 占比 |
|------|-----------|------|
| 全量微调 | ~7B | 100% |
| LoRA (r=16) | ~4M | 0.057% |
| IA³ | ~0.3M | 0.004% |
| Prompt Tuning | ~0.1M | 0.001% |

IA³ 比同等效果的 LoRA 少约 10-50 倍参数。

### 全设备谱系训练方案

| 设备 | 推荐方案 | 模型大小 | 预估时间 (1K样本) | VRAM/RAM |
|------|---------|---------|------------------|----------|
| 📱 手机 | IA³ + 0.15B | ~150MB | 4-8h | ~2GB RAM |
| 💻 低配笔记本 | IA³ + 0.5B | ~600MB | 2-4h | ~4GB RAM |
| 🖥️ CPU PC | IA³ + 0.5B | ~600MB | 1-3h | ~4GB RAM |
| 🖥️ GPU 4090 | LoRA + 7B | ~14GB VRAM | 2-4h | ~17-21GB |

**核心理念**: IA³ 不是 LoRA 的替代品，而是验证工具。先用 IA³ 快速确认"数据质量 OK"，再用 LoRA 正式训练。

---

## 附录 G: PEFT 前沿算法调研 (2026-03-27)

| 算法 | 来源 | 核心亮点 | 参数量(7B) |
|------|------|---------|-----------|
| FAA (Fourier-Activated Adapter) | arXiv 2512.22378 | 傅里叶频域分解，频率感知调制 | adapter 级 |
| LoFT | ICLR 2026 | 低秩适配但效果等价全量微调 | ~4M |
| MetaLoRA | CVPR 2025 Highlight | 元学习自动优化 LoRA 超参数 | 同 LoRA |
| DoRA | NVlabs, ICML 2024 Oral | 权重分解，比 LoRA 更少参数更好效果 | 比 LoRA 少30% |

### 更新后的训练方案推荐

| 阶段 | 旧方案 | 新方案 | 理由 |
|------|--------|--------|------|
| CPU 快速验证 | IA³ + 0.5B | FAA + 0.5B | FAA 频域分解比 IA³ 简单缩放更强 |
| GPU 正式训练 | LoRA + 7B | LoFT + 7B 或 DoRA + 7B | 效果更接近全量微调 |
| 超参数优化 | 手动 + AdaptiveThreshold | MetaLoRA 自动搜索 | 自动找最优配置 |

---

## 附录 H: 验证实验设计

### H.1 A/B 测试方案

| 组别 | 模型 | 训练数据 | 对比维度 |
|------|------|---------|---------|
| **对照组 A** | 原始模型 (无微调) | - | 基线 |
| **对照组 B** | SFT 微调 | 相同轨迹（无对比） | SFT vs ORPO |
| **实验组** | ORPO 微调 | 反思对比对 | 验证 ORPO 效果 |

### H.2 评估指标

| 指标 | 数据来源 | 计算方式 | 显著性阈值 |
|------|---------|---------|-----------|
| **思维模型激活率** | `detectThinkingModelMatches()` | 激活数 / 9 | p < 0.05 |
| **Thinking Ratio** | trajectory.db | Σ(思考token) / 工具调用数 | p < 0.01 |
| **任务成功率** | task_outcomes | outcome='ok' 占比 | p < 0.05 |
| **用户修正率** | user_turns | correction_detected 占比 | p < 0.05 |

### H.3 测试集设计

```yaml
测试集规模: 50 个标准任务
类型分布:
  - code_editing: 40%
  - debugging: 25%
  - planning: 15%
  - code_reading: 10%
  - conversation: 10%

复杂度分布:
  - simple (≤5 steps): 30%
  - medium (5-15 steps): 50%
  - complex (>15 steps): 20%
```

### H.4 收益预期曲线

基于文献和经验估算：

| 数据量 | Thinking Ratio 提升 | 任务成功率提升 | 备注 |
|--------|--------------------|---------------|------|
| 100 条 | +10% | +3% | 初步效果 |
| 500 条 | +25% | +8% | 显著改善 |
| 1000 条 | +40% | +12% | 收益递减拐点 |
| 2000+ 条 | +50% | +15% | 边际效益降低 |

---

## 附录 I: 思维模型适用边界与豁免条件

### I.1 各思维模型的适用边界

| 模型 | 适用场景 | 豁免条件 | 反例说明 |
|------|---------|---------|---------|
| **T-01** Survey Before Acting | 所有非紧急任务 | 紧急修复 + 用户明确要求快速行动 | 线上故障需立即定位 |
| **T-03** Evidence Over Assumption | 有现成证据源的任务 | 探索性原型开发 + 时间紧迫 | 新技术栈无历史参考 |
| **T-07** Minimal Change Surface | 生产环境修改 | 重构任务 + 用户要求大范围改动 | 遗留代码重构 |
| **T-09** Divide And Conquer | 复杂度 > 5 的任务 | 简单修改 + 单文件操作 | 修改一行配置 |

### I.2 边界判断规则

```typescript
interface ThinkingModelContext {
  urgency: 'normal' | 'high' | 'critical';
  complexity: number;  // 1-10
  evidenceAvailable: boolean;
  userIntent: 'speed' | 'quality' | 'balance';
}

function shouldApplyModel(model: string, ctx: ThinkingModelContext): boolean {
  switch (model) {
    case 'T-01':
      return ctx.urgency !== 'critical' && ctx.complexity >= 3;
    case 'T-03':
      return ctx.evidenceAvailable || ctx.complexity >= 5;
    case 'T-07':
      return ctx.userIntent !== 'speed';
    case 'T-09':
      return ctx.complexity >= 5;
    default:
      return true;
  }
}
```

---

## 附录 J: 任务类型自动分类规则

### J.1 分类规则表

| task_type | 判断规则 | 优先级 |
|-----------|---------|--------|
| **code_editing** | tool_calls 包含 write_file 或 replace 且 success > 0 | 1 |
| **debugging** | pain_events > 0 或 tool_calls 中 failure ≥ 2 | 2 |
| **planning** | PLAN.md 写入 或 规划类文本 > 500 tokens | 3 |
| **code_reading** | 只有 read_file/glob/search，无写操作 | 4 |
| **conversation** | tool_calls ≤ 2 或 无工具调用 | 5 |

### J.2 复杂度评估

```typescript
function estimateComplexity(trajectory: StructuredTrajectory): 'simple' | 'medium' | 'complex' {
  const { totalTurns, toolCallCount, correctionCount } = trajectory.metrics;
  
  const score = totalTurns * 0.3 + toolCallCount * 0.5 + correctionCount * 2;
  
  if (score < 10) return 'simple';
  if (score < 25) return 'medium';
  return 'complex';
}
```

---

## 附录 K: 成本控制与收益预期

### K.1 单次反思 Token 成本估算

| 阶段 | 输入 Token | 输出 Token | 小计 |
|------|-----------|-----------|------|
| Dreamer 输入 | ~2000 | - | 2000 |
| Dreamer 输出 | - | ~500 | 500 |
| Philosopher 输入 | ~2500 | - | 2500 |
| Philosopher 输出 | - | ~800 | 800 |
| Scribe 输入 + 输出 | ~2000 | ~1000 | 3000 |
| **总计** | **~6500** | **~2300** | **~8800** |

### K.2 成本控制阈值

```typescript
interface CostControlConfig {
  // 长轨迹压缩阈值
  maxTurnsForFullReflection: 50;  // 超过此值触发智能压缩
  
  // 压缩策略
  compressionStrategy: {
    keepFirstTurns: 5;           // 保留前 N 个 turns
    keepLastTurns: 10;           // 保留后 N 个 turns
    keepCorrectionAdjacent: 3;    // 修正前后各保留 N 个 turns
    keepFailureAdjacent: 2;       // 失败前后各保留 N 个 turns
  };
  
  // 成本上限
  maxTokensPerReflection: 10000;
}
```

### K.3 收益/成本权衡点

| 月反思次数 | Token 成本 (约) | 预期数据积累 | 建议场景 |
|-----------|----------------|-------------|---------|
| 10 次 | ~90K tokens | ~8 条 | 轻度使用 |
| 30 次 | ~270K tokens | ~25 条 | 中度使用 |
| 100 次 | ~900K tokens | ~80 条 | 重度使用（接近训练阈值） |

---

## 附录 L: 数据生命周期管理

### L.1 数据状态流转

```
新入库 → 验证中 → 已验证 → 已过期 → 已淘汰
   │        │         │         │         │
   └─ pending └─ validating └─ verified └─ stale └─ purged
```

### L.2 淘汰规则

| 条件 | 动作 | 说明 |
|------|------|------|
| 入库 > 180 天且无验证 | 标记 `stale` | 可能已过时 |
| `stale` 数据占比 > 20% | 触发数据清洗 | 批量重新评估 |
| `stale` > 365 天 | 自动淘汰 | 从训练集移除 |
| 质量评分 < 0.1 | 直接淘汰 | 低质量数据 |

### L.3 数据验证机制

```typescript
interface DataValidationRule {
  // 每 90 天重新评估一次
  validationIntervalDays: 90;
  
  // 重新评估条件
  revalidationTriggers: [
    'principles_updated',      // 原则文件更新
    'model_upgraded',          // 基础模型升级
    'threshold_adjusted',      // Arbiter 阈值调整
  ];
  
  // 验证方式
  validationMethod: 'arbiter_rerun' | 'human_sample' | 'auto_score';
}
```

---

## 附录 M: 边界条件与异常处理

### M.1 多 Workspace 场景

| 场景 | 问题 | 处理方案 |
|------|------|---------|
| 同时开多个项目 | 空闲检测误判 | 按 workspace 独立检测 |
| workspace 切换 | trajectory 跨项目 | sessionId 包含 workspace 标识 |
| workspace 删除 | 孤儿数据 | 清理关联的反思数据 |

```typescript
interface WorkspaceAwareIdleDetection {
  workspaceId: string;
  lastActivity: Date;
  isIdle(): boolean;  // 独立判断，不受其他 workspace 影响
}
```

### M.2 反思失败重试机制

```typescript
interface RetryConfig {
  maxRetries: 3;
  backoffMs: [1000, 5000, 30000];  // 指数退避
  fallbackOnFinalFailure: 'skip' | 'partial_persist';
  
  // 失败分类处理
  failureHandlers: {
    'timeout': 'retry_with_longer_timeout',
    'rate_limit': 'retry_after_backoff',
    'invalid_output': 'retry_with_stricter_prompt',
    'unknown': 'skip_and_log',
  };
}
```

### M.3 数据一致性保护

```typescript
// 使用快照隔离反思过程
async function reflectionWithSnapshot(sessionId: string) {
  const snapshot = await trajectory.createSnapshot(sessionId);
  
  try {
    // 反思过程中使用快照，不受后续写入影响
    const result = await trinityReflection(snapshot);
    return result;
  } finally {
    await snapshot.release();
  }
}
```

### M.4 并发控制

```typescript
// 全局反思并发限制
const REFLECTION_CONFIG = {
  maxConcurrentReflections: 2,    // 最多同时 2 个反思任务
  maxReflectionsPerHour: 4,       // 每小时最多 4 次
  queueTimeoutMs: 30 * 60_000,    // 队列等待超时 30 分钟
};

const reflectionQueue = new PQueue({ 
  concurrency: REFLECTION_CONFIG.maxConcurrentReflections 
});
```

### M.5 Arbiter 劣化检测

```typescript
interface ArbiterEnhancedResult {
  pass: boolean;
  compositeImprovement: number;
  
  // 新增：劣化检测
  regressions: Array<{
    type: 'introduced_failure'      // 改写后引入新失败
         | 'increased_redundancy'   // 冗余操作增加
         | 'lost_success';          // 原有成功变失败
    severity: 'low' | 'medium' | 'high';
    details: string;
  }>;
}

// 逻辑：即使 compositeImprovement > 15%，如果存在 high severity 回归，也不入库
function shouldPersist(result: ArbiterEnhancedResult): boolean {
  if (result.regressions.some(r => r.severity === 'high')) {
    return false;
  }
  return result.pass;
}
```

---

## 15. 内化追踪子系统 — 闭环的关键拼图

> **v4.0 新增**: 系统动力学审查发现，原有设计缺失"原则状态持久化"和"训练目标选择"两个关键环节。
> 本节补全这两个断裂点，使 进化 → 训练 → 内化 → 选下一个目标 的完整闭环可以形成。

### 15.1 为什么需要这个子系统

**现状**：`EvolutionReducer` 管理原则的**准入生命周期** (`candidate → probation → active`)，
但不追踪原则被 LoRA 训练**固化的程度**。系统不知道：
- T-01 是否已经被模型内化？
- 哪个原则最该优先训练？
- 训练资源应该集中在哪里？

**设计原则**：
- 零侵入——不修改 `EvolutionReducer`，独立维护内化状态
- 代码定量——遵循率由 SQL 聚合计算，不由 LLM 判断
- 与现有类型正交——`PrincipleStatus` (`candidate/probation/active/deprecated`) 是准入状态，`InternalizationStatus` 是训练进度状态

### 15.2 数据模型

```typescript
/**
 * 内化追踪记录
 * 存储: .state/principle_internalization.json (Phase 1 用 JSON，Phase 2 可升级到 SQLite)
 * 零侵入: 不修改 EvolutionReducer 的 Principle 类型
 */
interface PrincipleInternalization {
  principleId: string;              // 'T-01', 'T-03', 'P_001' 等
  principleType: 'thinking_model' | 'evolution_principle';  // 区分评估方式

  // ─── 遵循统计 ───
  complianceRate: number;           // 0-1, 最近 20 个 session 的遵循率
  violationTrend: number;           // 滑动窗口斜率, 正=上升(恶化), 负=下降(改善)
  lastViolationAt: string | null;   // 最近一次违反时间

  // ─── 训练进度 ───
  trainingSamples: number;          // 已生成的 ORPO 样本数
  lastTrainedAt: string | null;     // 最近一次被 LoRA 训练包含的时间

  // ─── 内化状态 ───
  status: InternalizationStatus;
  trainingPriority: number;         // 0-100, 由 computeTrainingPriority() 计算

  // ─── 元信息 ───
  lastEvaluatedAt: string;
  evaluationCount: number;
}

type InternalizationStatus =
  | 'needs_training'    // 遵循率 < 85% 或 从未训练
  | 'in_training'       // 已有样本，遵循率 70-90%
  | 'monitoring'        // 遵循率 > 90%，观察是否稳定
  | 'internalized'      // 遵循率 > 95% 且趋势稳定 7 天
  | 'dormant';          // 遵循率 > 99% 且持续 30 天
```

### 15.3 与现有 Principle 状态的关系

```
┌──────────────────────────────────────────────────────────────────────┐
│  EvolutionReducer (准入生命周期)     Nocturnal (训练内化周期)         │
│  ──────────────────────────────     ─────────────────────────       │
│                                                                    │
│  candidate ──→ probation ──→ active    只有 active 原则进入         │
│       │            │           │       内化追踪系统                  │
│       ▼            ▼           │                                   │
│  deprecated    deprecated      │──→ needs_training                 │
│                                      │                             │
│                                      ├──→ in_training              │
│                                      │                             │
│                                      ├──→ monitoring               │
│                                      │                             │
│                                      ├──→ internalized             │
│                                      │                             │
│                                      └──→ dormant                  │
│                                                                    │
│  两套状态正交，互不干扰                                              │
└──────────────────────────────────────────────────────────────────────┘
```

### 15.4 遵循率计算：SQL 聚合（不是 LLM 判断）

```typescript
/**
 * 从 trajectory.db 聚合计算某原则的遵循率
 * 只用 SQL + detectThinkingModelMatches()，不调 LLM
 */
function computeComplianceRate(
  principleId: string,
  trajectoryDb: TrajectoryDatabase,
  windowSize: number = 20
): { rate: number; trend: number; sessionCount: number } {

  if (principleId.startsWith('T-')) {
    // ─── 思维模型 (T-01~T-09)：用正则检测 ───
    const recentSessions = trajectoryDb.listRecentSessions(windowSize);
    let activations = 0;
    let total = 0;
    const rates: number[] = [];

    for (const session of recentSessions) {
      const turns = trajectoryDb.listAssistantTurns(session.sessionId);
      const allText = turns.map(t => t.sanitizedText).join('\n');
      const matches = detectThinkingModelMatches(allText);
      const activated = matches.some(m => m.modelId === principleId);
      if (activated) activations++;
      total++;
      rates.push(activated ? 1 : 0);
    }

    const rate = total > 0 ? activations / total : 0;
    // 趋势：后 10 个 vs 前 10 个的差值
    const half = Math.floor(rates.length / 2);
    const firstHalf = rates.slice(0, half);
    const secondHalf = rates.slice(half);
    const trend = (avg(secondHalf) - avg(firstHalf));  // 正=改善, 负=恶化

    return { rate, trend: -trend, sessionCount: total }; // violationTrend: 正=恶化
  } else {
    // ─── 进化原则 (P_xxx)：用 Pain 关联检测 ───
    // P_xxx 原则由 diagnostician 创建，与特定 pain 模式关联
    // 遵循率 = 1 - (关联 pain 信号数 / 总 session 数)
    const pain = trajectoryDb.countPainBySource(principleId, windowSize);
    const total = trajectoryDb.countRecentSessions(windowSize);
    const rate = total > 0 ? Math.max(0, 1 - pain / total) : 0;
    return { rate, trend: 0, sessionCount: total };
  }
}
```

### 15.5 训练优先级得分：选出"最该固化的原则"

> **这是整个系统最关键的杠杆点**。训练带宽有限（每天 2-5 次反思），
> 必须集中在 ROI 最高的原则上。

```typescript
/**
 * 训练带宽是稀缺资源，不是 prompt token。
 * 这个函数决定：有限的反思机会，应该用在哪个原则上？
 *
 * ROI = 影响频率 × 违反后果 × 内化难度⁻¹ × 数据可获得性
 */
function computeTrainingPriority(p: PrincipleInternalization): number {
  // 已内化/休眠的原则不需要训练带宽
  if (p.status === 'internalized' || p.status === 'dormant') return 0;

  // 从未训练过的新原则有探索加成
  const explorationBonus = p.trainingSamples === 0 ? 20 : 0;

  // 违反率越高越该训练
  const violationUrgency = (1 - p.complianceRate) * 40;  // 0-40

  // 恶化趋势紧急度
  const trendUrgency = Math.max(0, p.violationTrend) * 20;  // 0-20

  // 高频原则（如 T-01）比低频原则（如 T-05）更值得训练
  // 因为内化后每天都受益
  const frequencyWeight = PRINCIPLE_FREQUENCY[p.principleId] ?? 50; // 0-100
  const frequencyBonus = frequencyWeight / 100 * 15;  // 0-15

  // 数据效率：已有一些样本但还不够的原则，追加训练的边际效益最大
  const dataEfficiency = p.trainingSamples > 0 && p.trainingSamples < 100
    ? 10
    : p.trainingSamples >= 100 ? 0 : 5;

  return Math.min(100,
    violationUrgency + trendUrgency + frequencyBonus + explorationBonus + dataEfficiency
  );
}

// 原则使用频率表（基于附录 Q.3 的优先级分类）
const PRINCIPLE_FREQUENCY: Record<string, number> = {
  'T-01': 90,  // Survey Before Acting — 几乎所有任务
  'T-03': 85,  // Evidence Over Assumption — 高频
  'T-09': 80,  // Divide And Conquer — 高频
  'T-06': 75,  // Simplicity First — 高频
  'T-07': 50,  // Minimal Change Surface — 中频
  'T-08': 40,  // Pain As Signal — 元认知
  'T-02': 60,  // Respect Constraints — 中频
  'T-04': 30,  // Reversible First — 低频高后果
  'T-05': 25,  // Safety Rails — 低频高后果
};
```

### 15.6 状态流转逻辑

```typescript
function updateInternalizationStatus(p: PrincipleInternalization): InternalizationStatus {
  // 任何状态下，违反率突然上升 → 重新激活
  if (p.complianceRate < 0.80 && p.status !== 'needs_training') {
    return 'needs_training';  // 重新激活训练
  }

  switch (p.status) {
    case 'needs_training':
      if (p.trainingSamples >= 50 && p.complianceRate >= 0.70) return 'in_training';
      return 'needs_training';

    case 'in_training':
      if (p.complianceRate >= 0.90 && p.violationTrend <= 0) return 'monitoring';
      return 'in_training';

    case 'monitoring':
      if (p.complianceRate >= 0.95 && p.violationTrend < 0) return 'internalized';
      if (p.complianceRate < 0.85) return 'needs_training';  // 回退
      return 'monitoring';

    case 'internalized':
      if (p.complianceRate >= 0.99) return 'dormant';
      if (p.complianceRate < 0.90) return 'needs_training';  // 重新激活
      return 'internalized';

    case 'dormant':
      if (p.complianceRate < 0.95) return 'needs_training';  // 突然违反
      return 'dormant';
  }
}
```

### 15.7 写入者定义：谁来更新这些数据？

| 字段 | 写入者 | 触发时机 |
|------|-------|--------|
| `complianceRate`, `violationTrend` | `nocturnal-service.ts` | 每次反思前，从 trajectory.db 聚合计算 |
| `trainingSamples` | `nocturnal-service.ts` | 每次 Arbiter 通过后 +1 |
| `status` | `nocturnal-service.ts` | 每次评估后由 `updateInternalizationStatus()` 自动流转 |
| `trainingPriority` | `nocturnal-service.ts` | 每次评估后由 `computeTrainingPriority()` 重算 |
| `lastViolationAt` | `pain.ts` hook | Pain 信号关联到原则时更新 |

### 15.8 与反思管线的集成

```typescript
// 在 nocturnal-service.ts 的反思入口
async function selectReflectionTarget(wctx: WorkspaceContext): NocturnalReflectionInput | null {
  const internalization = loadInternalizationState(wctx.stateDir);

  // 第一步：刷新所有 active 原则的遵循率
  const activePrinciples = wctx.evolutionReducer.getActivePrinciples();
  const thinkingModelIds = ['T-01','T-02','T-03','T-04','T-05','T-06','T-07','T-08','T-09'];
  const allPrincipleIds = [...thinkingModelIds, ...activePrinciples.map(p => p.id)];

  for (const id of allPrincipleIds) {
    const { rate, trend, sessionCount } = computeComplianceRate(id, wctx.trajectory);
    const entry = internalization.getOrCreate(id);
    entry.complianceRate = rate;
    entry.violationTrend = trend;
    entry.status = updateInternalizationStatus(entry);
    entry.trainingPriority = computeTrainingPriority(entry);
    entry.lastEvaluatedAt = new Date().toISOString();
    entry.evaluationCount++;
  }
  internalization.save();

  // 第二步：选出训练优先级最高的原则
  const candidates = internalization.getAll()
    .filter(p => p.trainingPriority > 0)
    .sort((a, b) => b.trainingPriority - a.trainingPriority);

  if (candidates.length === 0) return null;  // 所有原则都已内化，跳过反思

  const target = candidates[0];

  // 第三步：找到最近违反该原则的 session
  const violatingSession = findMostRecentViolatingSession(wctx.trajectory, target.principleId);
  if (!violatingSession) return null;

  return {
    taskId: createReflectionTaskId(target.principleId, violatingSession.sessionId),
    triggerType: 'idle_timeout',
    targetPrincipleId: target.principleId,
    sessionId: violatingSession.sessionId,
    principleStatus: {
      complianceRate: target.complianceRate,
      violationTrend: target.violationTrend,
      trainingSamples: target.trainingSamples,
      status: target.status,
    },
    trajectory: extractStructuredTrajectory(wctx.trajectory, violatingSession.sessionId),
  };
}
```

> **反思目标 vs Philosopher 审计范围**
>
> 每次反思有一个明确的 `targetPrincipleId`（训练优先级最高的原则），但：
> - **Philosopher 仍然审计所有 T-01~T-09** — 这是为了理解完整的上下文，发现潜在的关联问题
> - **Scribe 只改写与 `targetPrincipleId` 相关的决策点** — 训练数据聚焦，偏好信号更干净
>
> 例如：如果 `targetPrincipleId = 'T-01'`：
> - Philosopher 会发现"违反 T-01，同时 T-03 也有问题"
> - 但 Scribe 的改写重点是"如何在动手前先调研"（T-01）
> - T-03 的问题可以在后续反思中单独处理
>
> 这避免了"一次反思改太多东西"导致的训练信号模糊问题。

### 15.9 Arbiter 评估方式区分

```typescript
// Arbiter 需要区分 T-xx (思维模型) 和 P_xxx (进化原则) 的评估方式
function computePrincipleImprovement(
  principleId: string,
  originalText: string,
  scribeOutput: string,
  reducer: EvolutionReducer
): number {
  if (principleId.startsWith('T-')) {
    // 思维模型：用 detectThinkingModelMatches() 正则检测
    const originalMatches = detectThinkingModelMatches(originalText);
    const improvedMatches = detectThinkingModelMatches(scribeOutput);
    const originalHas = originalMatches.some(m => m.modelId === principleId);
    const improvedHas = improvedMatches.some(m => m.modelId === principleId);
    return improvedHas && !originalHas ? 0.4 : 0;  // 从无到有 = 大改善
  } else {
    // 进化原则 (P_xxx)：检测是否避免了原 trigger 场景，或体现了正确 action
    const principle = reducer.getPrincipleById(principleId);
    if (!principle) return 0;
    
    // ⚠️ 不用简单的 includes()，改用更精确的检测
    // 原因："write_file failed" 会误匹配 "write_file 成功了"
    
    // 方法 1：检测是否避免了原 trigger 场景（负面触发不再出现）
    const triggerAvoided = !containsTriggerPattern(scribeOutput, principle.trigger);
    
    // 方法 2：检测是否体现了正确 action（正面行为出现）
    const actionDemonstrated = containsActionPattern(scribeOutput, principle.action);
    
    // 综合评分：避免错误 + 体现正确 = 最佳
    if (triggerAvoided && actionDemonstrated) return 0.4;
    if (actionDemonstrated) return 0.25;  // 体现了正确行为
    if (triggerAvoided) return 0.15;      // 至少避免了错误
    return 0;
  }
}

/**
 * 检测文本是否包含 trigger 模式（精确匹配，避免误判）
 * 例如：trigger = "write_file failed" 只匹配失败场景，不匹配 "write_file 成功"
 */
function containsTriggerPattern(text: string, trigger: string): boolean {
  // 将 trigger 转换为正则，允许空白变化，但保持核心词序
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped.replace(/\s+/g, '\\s+'), 'i');
  return pattern.test(text);
}

/**
 * 检测文本是否体现了 action 行为
 * action 通常是正面指导，如 "先读取现有结构再修改"
 */
function containsActionPattern(text: string, action: string): boolean {
  // 检测 action 的关键词是否出现（分词后至少命中 50%）
  const keywords = action.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const textLower = text.toLowerCase();
  const hits = keywords.filter(kw => textLower.includes(kw)).length;
  return hits >= Math.ceil(keywords.length * 0.5);
}
```

### 15.10 存储方案

**Phase 1 (MVP)**：`.state/principle_internalization.json`
```json
{
  "T-01": {
    "principleId": "T-01",
    "principleType": "thinking_model",
    "complianceRate": 0.35,
    "violationTrend": 0.05,
    "trainingSamples": 0,
    "status": "needs_training",
    "trainingPriority": 82,
    "lastEvaluatedAt": "2026-03-27T10:00:00Z",
    "evaluationCount": 1
  },
  "T-06": {
    "principleId": "T-06",
    "principleType": "thinking_model",
    "complianceRate": 0.92,
    "violationTrend": -0.02,
    "trainingSamples": 67,
    "status": "monitoring",
    "trainingPriority": 8,
    "lastEvaluatedAt": "2026-03-27T10:00:00Z",
    "evaluationCount": 15
  }
}
```

**Phase 2 (可选升级)**：迁移到 trajectory.db 的新表
```sql
CREATE TABLE principle_internalization (
  principle_id TEXT PRIMARY KEY,
  principle_type TEXT NOT NULL,
  compliance_rate REAL DEFAULT 0,
  violation_trend REAL DEFAULT 0,
  training_samples INTEGER DEFAULT 0,
  status TEXT DEFAULT 'needs_training',
  training_priority REAL DEFAULT 0,
  last_violation_at TEXT,
  last_trained_at TEXT,
  last_evaluated_at TEXT,
  evaluation_count INTEGER DEFAULT 0,
  updated_at TEXT
);
```

### 15.11 完整闭环图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    完整进化 → 記忆闭环 (v4.0)                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ① Pain 信号产生                                                          │
│      ↓                                                                     │
│   ② trajectory.db 持续记录行为                                              │
│      ↓                                                                     │
│   ③ 内化追踪系统评估所有原则                   ◄── 15.4 SQL 聚合           │
│      ├─ complianceRate 计算                                                │
│      ├─ trainingPriority 排序                  ◄── 15.5 ROI 公式           │
│      └─ 选出 "最该固化的原则"                                              │
│      ↓                                                                     │
│   ④ 针对该原则执行 Trinity 反思                                             │
│      ├─ Dreamer: 还原违反场景                                               │
│      ├─ Philosopher: 审计为什么违反                                         │
│      └─ Scribe: 重写正确行为                                               │
│      ↓                                                                     │
│   ⑤ Arbiter 门禁 (区分 T-xx 和 P_xxx)          ◄── 15.9 评估区分          │
│      ↓                                                                     │
│   ⑥ ORPO JSONL 入库                                                       │
│      ├─ trainingSamples++                                                  │
│      └─ 同时更新 reflection-log.md              ◄── 即时生效的快速通道     │
│      ↓                                                                     │
│   ⑦ LoRA 训练 (积累 1K+ 后)                    ◄── 训练目标已自动聚焦      │
│      ↓                                                                     │
│   ⑧ 行为改善 → complianceRate ↑ → status 流转  ◄── 15.6 自动状态机        │
│      ↓                                                                     │
│   ⑨ 该原则 trainingPriority ↓ → 训练带宽释放                              │
│      ↓                                                                     │
│   ⑩ 下一个高 ROI 原则获得训练优先级                                         │
│      ↓                                                                     │
│   回到 ④ ── 持续进化                                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

*Last updated: 2026-03-27*
*Version: 4.1 — 修复文档瑕疵：(1) 统一 shouldReflect() 函数 (P.3 引用 §0.6)；(2) 澄清反思目标 vs Philosopher 审计范围 (§15.8)；(3) 修复 P_xxx 关键词匹配误判 (§15.9)；(4) 补充即时生效机制说明 (§6.5)；(5) 统一存储位置为 JSON*

---

## 附录 N: 系统思维分析

### N.1 核心要素

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              存量 (Stocks)                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                     │
│  │ 原则库      │    │ 训练数据集  │    │ LoRA 权重   │                     │
│  │ T-01~T-09   │    │ ORPO JSONL  │    │ adapter.bin │                     │
│  │ (存量规范)  │    │ (累积增长)  │    │ (行为编码)  │                     │
│  │ + 新增原则  │    │             │    │             │                     │
│  └─────────────┘    └─────────────┘    └─────────────┘                     │
│         │                  ▲                  │                             │
│         │                  │                  │                             │
│         │            ┌─────┴─────┐            │                             │
│         │            │  Arbiter  │            │                             │
│         │            │  门禁筛选  │            │                             │
│         │            └─────┬─────┘            │                             │
│         │                  │                  │                             │
│         ▼                  ▼                  ▼                             │
│  ┌─────────────────────────────────────────────────────┐                   │
│  │              Trajectory DB                          │                   │
│  │         (原始行为记录，持续增长)                      │                   │
│  └─────────────────────────────────────────────────────┘                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                             流量 (Flows)                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  日间 Session ──→ 反思触发 ──→ Trinity 处理 ──→ 对比对产生                  │
│       │              │              │              │                        │
│       ▼              ▼              ▼              ▼                        │
│   行为记录        条件判断        原则对照       chosen/rejected            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### N.2 正确的输入定义

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         输入：原则 + 关联信号 + 关联轨迹                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐                                                        │
│  │ 原则（核心）    │ ← 存量：T-01~T-09，增量：diagnostician 新增            │
│  └─────────────────┘                                                        │
│         │                                                                   │
│         ├──→ 关联的痛苦信号（如果有）← 核心反馈来源                         │
│         │                                                                   │
│         └──→ 关联的对话轨迹 ← 原则应用/违反的场景                           │
│                                                                             │
│  例如：                                                                     │
│  T-01 (Survey Before Acting)                                                │
│  + Pain: tool_failure (直接修改导致失败)                                    │
│  + Trajectory: "好的我直接改" → write → failure                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

输出：错误轨迹 vs 正确轨迹
──────────────────────────
rejected: 违反原则的轨迹
chosen: 符合原则的轨迹
```

### N.3 核心反馈回路

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    ▼                                     │
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ 原则存量 │───→│ 行为反思 │───→│ 轨迹对比 │───→│ 训练数据 │
│ T-01~T-09│    │ (Trinity)│    │ rejected │    │ ORPO     │
│ 新增原则 │    │          │    │ chosen   │    │          │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
      ▲                                              │
      │                                              ▼
      │                                        ┌──────────┐
      │                                        │ LoRA训练 │
      │                                        └──────────┘
      │                                              │
      │                                              ▼
      │                                        ┌──────────┐
      │                                        │ 行为改变 │
      │                                        │ (内化)   │
      │                                        └──────────┘
      │                                              │
      └──────────────────────────────────────────────┘
                    原则从"显式约束"→"隐式能力"
```

### N.4 原则会消失吗？

**答案：不会消失，但训练优先级会转变**

原则的 prompt 注入成本很低（每个原则 ~50-100 token），所以即使原则已经内化，保留在 prompt 中作为安全网也不会造成显著的上下文压力。真正的杠杆点在于：**训练资源有限（每天反思 2-5 次），应该集中在哪些原则上？**

| 阶段 | 原则角色 | 训练优先级 | prompt 注入 |
|------|---------|-----------|-----------|
| 显式约束期 | 外部提醒，频繁违反 | ★★★★★ 最优先训练 | 始终注入 |
| 内化过渡期 | 违反率下降中 | ★★★ 继续巩固 | 始终注入 |
| 肌肉记忆期 | 融入默认行为 | ★ 仅偶发违反时重训 | 始终注入（安全网） |
| 休眠期 | 长期稳定遵循 | ☆ 不训练 | 可选保留 |

**关键洞察**：原则从未"消失"——它们从"高 ROI 训练目标"变为"低维护安全网"。训练带宽是真正稀缺的资源，而不是 prompt token。

---

## 附录 O: 原则生命周期管理

### O.1 生命周期状态机

```
                        ┌──────────────┐
                        │   新增原则    │
                        │(diagnostician)│
                        └──────┬───────┘
                               │
                               ▼
     ┌─────────────────────────────────────────────┐
     │              needs_training                 │
     │  - 遵循率低 或 有 Pain 关联                  │
     │  - 需要生成训练样本                          │
     │  - 必须注入上下文                            │
     └──────────────────────┬──────────────────────┘
                            │
                 样本数 >= 50 且 遵循率 >= 70%
                            │
                            ▼
     ┌─────────────────────────────────────────────┐
     │              in_training                    │
     │  - 已有训练样本                              │
     │  - 持续监控遵循率                            │
     │  - 必须注入上下文                            │
     └──────────────────────┬──────────────────────┘
                            │
                 遵循率 >= 90% 且 趋势稳定
                            │
                            ▼
     ┌─────────────────────────────────────────────┐
     │              monitoring                     │
     │  - 观察训练效果                              │
     │  - 可减少上下文注入                          │
     │  - 持续监控违反情况                          │
     └──────────────────────┬──────────────────────┘
                            │
                 遵循率 >= 95% 且 趋势下降 且 持续 7 天
                            │
                            ▼
     ┌─────────────────────────────────────────────┐
     │              internalized                   │
     │  - 原则已内化                                │
     │  - 可移除上下文注入                          │
     │  - 仅监控违反情况                            │
     └──────────────────────┬──────────────────────┘
                            │
                 遵循率 >= 99% 且 持续 30 天
                            │
                            ▼
     ┌─────────────────────────────────────────────┐
     │              dormant                        │
     │  - 原则进入休眠                              │
     │  - 不注入上下文                              │
     │  - 不生成训练样本                            │
     │  - 违反时重新激活                            │
     └─────────────────────────────────────────────┘

     ════════════════════════════════════════════════════════════════════

     任何状态下，如果违反率突然上升：
     dormant/internalized/monitoring → needs_training (重新激活)
```

### O.2 内化程度数据结构

```typescript
interface PrincipleInternalization {
  principleId: string;
  
  // 内化程度 0-100%
  internalizationScore: number;
  
  // 计算依据
  trainingSamples: number;           // 该原则的训练样本数
  recentComplianceRate: number;      // 最近 N 次行为的遵循率
  violationTrend: number;            // 违反频率变化趋势（负数=下降）
  
  // 状态
  status: 'needs_training' | 'in_training' | 'monitoring' | 'internalized' | 'dormant';
  
  // 上下文注入策略
  injectionStrategy: 'required' | 'reduced' | 'optional' | 'none';
}

// 内化判定逻辑
function computeInternalizationStatus(p: PrincipleInternalization): string {
  if (p.trainingSamples >= 100 && p.recentComplianceRate >= 0.95 && p.violationTrend < 0) {
    return 'internalized';  // 可移除注入
  }
  if (p.trainingSamples >= 50 && p.recentComplianceRate >= 0.80) {
    return 'in_training';  // 训练中
  }
  return 'needs_training';  // 需要训练
}
```

---

## 附录 P: 反思准入门槛

### P.1 问题：不是所有原则都需要反思

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      效率优化                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ❌ 现有思路：空闲了 → 找个 session → 反思所有原则 → 生成训练数据            │
│                                                                             │
│  问题：                                                                     │
│  - 如果 Agent 已经自然遵循 T-06，为什么要生成训练样本？                      │
│  - 如果某个原则遵循率 99%，反思价值极低                                      │
│  - 浪费 token、浪费训练资源、污染训练数据                                    │
│                                                                             │
│  ✅ 优化思路：只反思"有问题的原则" → 只训练"需要改进的行为"                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### P.2 反思准入决策树

```
Pain 信号发生
     │
     ▼
┌─────────────────┐
│ 是否关联原则？   │──否──→ 记录信号，不触发反思
└─────────────────┘
     │是
     ▼
┌─────────────────┐
│ 该原则是否已内化？│──是──→ 标记"内化原则违反"，可能需要重新激活
└─────────────────┘
     │否
     ▼
入队反思任务

────────────────────────────────────────────────────────────────────────────

空闲触发反思
     │
     ▼
┌─────────────────┐
│ 有需要训练的原则？│──否──→ 跳过本轮反思
└─────────────────┘
     │是
     ▼
筛选原则：
- complianceRate < 85%
- OR violationTrend > 0
- OR trainingSamples === 0
     │
     ▼
只针对"需要训练的原则"生成反思任务
```

### P.3 反思准入判定代码

> **完整实现见 §0.6**。以下为补充说明。

```typescript
// 反思准入的核心逻辑（与 §0.6 shouldReflect() 一致）
// 任何修改应同步更新两处

interface ReflectionAdmissionResult {
  admitted: boolean;
  reason: 'pain_signal' | 'low_compliance' | 'rising_violations' | 'new_principle' | 'reactivated' | 'skipped';
  targetPrincipleId?: string;  // 如果 admitted，指向最该反思的原则
}

function evaluateReflectionAdmission(
  principles: PrincipleInternalization[],
  painSignals: Map<string, PainSignal[]>  // principleId -> associated pains
): ReflectionAdmissionResult {
  // 筛选符合反思条件的原则
  const candidates = principles.filter(p => {
    // 条件 1：有 Pain 关联
    const pains = painSignals.get(p.principleId) ?? [];
    if (pains.length > 0) return true;
    
    // 条件 2：遵循率低
    if (p.complianceRate < 0.85) return true;
    
    // 条件 3：违反趋势上升
    if (p.violationTrend > 0) return true;
    
    // 条件 4：新原则
    if (p.trainingSamples === 0) return true;
    
    // 条件 5：已内化但有新违反（重新激活）
    if ((p.status === 'internalized' || p.status === 'dormant') && pains.length > 0) return true;
    
    return false;
  });
  
  if (candidates.length === 0) {
    return { admitted: false, reason: 'skipped' };
  }
  
  // 按 trainingPriority 排序，选最高的
  const target = candidates.sort((a, b) => b.trainingPriority - a.trainingPriority)[0];
  
  // 确定原因
  const pains = painSignals.get(target.principleId) ?? [];
  let reason: ReflectionAdmissionResult['reason'] = 'low_compliance';
  if (pains.length > 0 && (target.status === 'internalized' || target.status === 'dormant')) {
    reason = 'reactivated';
  } else if (pains.length > 0) {
    reason = 'pain_signal';
  } else if (target.trainingSamples === 0) {
    reason = 'new_principle';
  } else if (target.violationTrend > 0) {
    reason = 'rising_violations';
  }
  
  return { admitted: true, reason, targetPrincipleId: target.principleId };
}
```

### P.4 效率对比

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 反思触发 | 空闲就反思 | 有需要训练的原则才反思 |
| 反思范围 | 所有原则 | 只针对 complianceRate < 85% |
| 训练样本 | 无筛选，全量生成 | 只为"有改进空间"的原则生成 |
| Token 消耗 | 100% | ~60% (节省 40%) |

---

## 附录 Q: 原则优先级矩阵

### Q.1 优先级维度

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      原则优先级评估维度                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  维度 1：影响频率 (impactFrequency)                                         │
│  ─────────────────────────────────────                                     │
│  该原则在多少场景中适用？                                                    │
│  T-01 (Survey Before Acting): 几乎所有任务 → 高频                           │
│  T-05 (Safety Rails): 特定高风险操作 → 低频但高影响                          │
│                                                                             │
│  维度 2：违反后果 (violationSeverity)                                       │
│  ─────────────────────────────────────                                     │
│  违反后会导致什么？                                                          │
│  T-01 违反 → 可能失败，但可修正 → 中等                                       │
│  T-05 违反 → 可能造成不可逆损害 → 高                                        │
│                                                                             │
│  维度 3：内化难度 (internalizationEase)                                     │
│  ─────────────────────────────────────                                     │
│  原则是否清晰、可操作？                                                      │
│  T-06 (Simplicity First): 相对模糊 → 难内化                                 │
│  T-01 (Survey Before Acting): 清晰行为 → 易内化                             │
│                                                                             │
│  维度 4：训练数据可获得性 (dataAvailability)                                │
│  ─────────────────────────────────────                                     │
│  是否容易生成 rejected/chosen 对？                                          │
│  T-01: 违反明显（直接操作），容易生成 → 高可获性                             │
│  T-07 (Minimal Change Surface): 需要理解改动范围 → 低可获性                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Q.2 优先级矩阵

```
                        违反后果
                    低           高
                 ┌─────────┬─────────┐
            高   │ 优先级 2 │ 优先级 1 │
   影响        │ 加速内化 │ 必须内化 │
   频率            ├─────────┼─────────┤
            低   │ 优先级 4 │ 优先级 3 │
                 │ 可延迟   │ 重点监控 │
                 └─────────┴─────────┘
```

### Q.3 T-01~T-09 优先级分类

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 优先级 1（必须内化）：高频 + 高后果                                        │
│   - T-01 Survey Before Acting（高频，违反导致高失败率）                    │
│   - T-03 Evidence Over Assumption（高频，违反导致错误决策）                │
│                                                                          │
│ 优先级 2（加速内化）：高频 + 低后果                                        │
│   - T-06 Simplicity First（高频，违反导致过度设计）                        │
│   - T-09 Divide And Conquer（高频，违反导致复杂任务失败）                  │
│                                                                          │
│ 优先级 3（重点监控）：低频 + 高后果                                        │
│   - T-04 Reversible First（低频，但违反可能造成不可逆损害）                │
│   - T-05 Safety Rails（低频，但违反是灾难性的）                            │
│                                                                          │
│ 优先级 4（可延迟）：低频 + 低后果                                          │
│   - T-07 Minimal Change Surface（依赖场景，违反后果可控）                  │
│   - T-08 Pain As Signal（元认知原则，需结合其他原则）                      │
└──────────────────────────────────────────────────────────────────────────┘
```

### Q.4 核心增强回路：训练带宽优化

> ⚠️ **关键认知修正**：原则的 prompt token 成本很低（约 50-100 token/条）。
> 真正稀缺的资源是**训练带宽**——每天只能反思 2-5 次，LoRA 训练只能做 1K+ 量级。
> 所以增强回路的杠杆不是"释放上下文空间"，而是"集中训练资源在最高 ROI 的原则上"。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      核心增强回路 (R1)                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  选定高 ROI 原则 ──→ 集中训练带宽 ──→ 该原则快速内化                        │
│         ↑                                       │                          │
│         │                                       ▼                          │
│         │                              释放训练带宽                         │
│         │                              给下一个高 ROI 原则                  │
│         │                                       │                          │
│         └───────────────────────────────────────┘                          │
│                                                                             │
│  ROI 计算 = 影响频率 × 违反后果 × 内化难度⁻¹ × 数据可获得性                │
│                                                                             │
│  效果：训练资源永远聚焦在"下一个最该固化的原则"上                            │
│        → 内化速度比随机选择快 3-5x                                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                      短程增强回路 (R1.5)                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  反思产出 ──→ reflection-log.md 更新 ──→ prompt 注入 ──→ 下次推理参考      │
│       │                                                       │            │
│       └──────────── 无需 LoRA，即时生效 ──────────────────────┘            │
│                                                                             │
│  效果：LoRA 训练前的"快速通道"，反思价值即时兑现                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Q.5 优先级计算代码

```typescript
interface PrinciplePriority {
  principleId: string;
  
  // 四维度评分 (0-100)
  impactFrequency: number;    // 在多少比例的场景中适用
  violationSeverity: number;  // 违反后的后果严重程度
  internalizationEase: number; // 原则的清晰度和可操作性
  dataAvailability: number;   // 训练数据的可获得性
  
  // 综合优先级
  priorityScore: number;      // 加权综合分
  
  // 增强潜力：内化后释放的上下文空间 × 对新原则学习的帮助
  enhancementPotential: number;
}

function computePriorityScore(p: PrinciplePriority): number {
  return (
    p.impactFrequency * 0.3 +
    p.violationSeverity * 0.3 +
    p.internalizationEase * 0.2 +
    p.dataAvailability * 0.2
  );
}

function computeEnhancementPotential(p: PrinciplePriority): number {
  // 高频原则内化后释放更多空间
  const spaceReleased = p.impactFrequency / 100 * PRINCIPLE_TOKEN_COST;
  
  // 基础原则内化后，依赖它的原则更容易学习
  const dependencyBoost = countDependentPrinciples(p.principleId) * 0.1;
  
  return spaceReleased * (1 + dependencyBoost);
}
```
*Version: 4.1 — 修复文档瑕疵：统一 shouldReflect()、澄清审计范围、修复 P_xxx 匹配、补充即时生效机制、统一存储位置*
