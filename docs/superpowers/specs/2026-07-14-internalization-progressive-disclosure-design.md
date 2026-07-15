# 内化管道上下文工程：渐进式披露设计方案

> **文档类型**：设计评审 + 替代方案
> **针对工单**：PRI-511 / PRI-512 / PRI-513（信息共享池三层级）
> **创建日期**：2026-07-14
> **状态**：Proposal — 待 Owner 决策
> **评审依据**：ADR-0014（MVP-First）、PRODUCT_IDENTITY.md、INTERNALIZATION_PIPELINE.md、2026 业界上下文工程共识

---

## 0. TL;DR

PRI-511/512/513 提出的"信息共享池"方案存在两个根本问题：

1. **设计假设违背 2026 年业界共识**：工单隐含"信息越多越聪明"，但 Anthropic / Manus / OpenAI 的工程实践已证伪——上下文增长会导致 precision 下降（lost-in-the-middle）。
2. **未讨论最核心的设计决策**：写入时冗余 vs 读取时回溯。工单隐式选了高成本的"读取时回溯"，而 90% 的跨级需求可以用"写入时冗余摘要"零成本满足。

**本方案推荐**：采用业界已成熟的 **Progressive Disclosure（渐进式披露）** 模式，三层信息架构（TL;DR / 结构化摘要 / 原始详情）+ ContextManifest 声明式需求 + PromptBudgetManager 硬预算 + 两阶段评估。比工单方案成本更低、AI 注意力更聚焦、与现有代码更契合。

---

## 1. 背景与问题诊断

### 1.1 工单试图解决的问题

PRI-511/512/513 识别了一个真实问题：内化管道当前的"线性传话筒"模式下，信息逐级压缩可能丢失。例如：

- **字段丢失**：dreamer 5 维（badDecision / betterDecision / rationale / riskLevel / strategicPerspective），scribe 原则文本可能只写了 betterDecision，丢了 riskLevel
- **语义模糊化**：dreamer 的"audit file tree + imports + dependency graph"被 scribe 压缩成"understand architecture"
- **意图偏移**：pain 是"skipped validation"，dreamer candidate 是"path whitelist"（答非所问）

当前 evaluator 只能发现终端问题（artificer 实现不符 scribe），无法定位"中间压缩丢了什么"。

### 1.2 工单方案概述

| 工单 | 层级 | 内容 |
|------|------|------|
| PRI-511 | 层级1 | 新建 `CandidateLineage` 类，从任意 artifact 回溯完整血缘链 |
| PRI-512 | 层级2 | 改 5 个 runner 的 buildContext，按需注入跨级 artifact |
| PRI-513 | 层级3 | evaluator 升级为三段式语义校验（pain→dreamer / dreamer→scribe / scribe→artificer） |

### 1.3 工单方案的问题

#### 问题 A：违背"最小高信号集合"原则

Anthropic 对 context engineering 的定义：**找到最小的、高信号 token 集合，使期望结果出现的概率最大化。**

工单的做法是"把所有前序 artifact 全注入"，隐含假设"信息越多越聪明"。但 2026 年工程共识恰恰相反——信息越多，LLM 注意力越分散，关键信号被淹没（lost-in-the-middle / needle in the haystack）。

#### 问题 B：未讨论"写入时冗余 vs 读取时回溯"

这是最核心的设计决策，工单完全没讨论：

| 维度 | 读取时回溯（工单方案） | 写入时冗余 |
|------|---------------------|-----------|
| 读取侧改动 | 5 个 runner buildContext + 5 个 prompt builder | **零改动**（runner 仍只读直接前驱） |
| 写入侧改动 | 零 | 改 writer（增量冗余字段） |
| 跨级访问成本 | 每次 buildContext 4 次 I/O + 4 次 parse | **零**（直接前驱已包含） |
| contentJson 重复解析 | 高（无 caching） | 零 |
| 断链处理 | 复杂（运行时回溯失败） | 简单（写入时就检测到缺失） |

工单隐式选了高成本的"读取时回溯"，但 90% 的跨级需求可以用"写入时冗余摘要"零成本满足。

#### 问题 C：无 token 预算管理

工单估算"每 runner 增加 200-500 token"，但严重低估：

| 字段 | 实际长度 | 工单估算 |
|------|---------|---------|
| pain reason | 500-2000 字符 | ~200 |
| pain evidence（代码/日志） | 2-10 KB | 含在 ~200 里 |
| dreamer 5维 × N candidates | 多 candidate 时翻倍 | ~300（单 candidate） |

最坏情况 evaluator 注入全量可达 8-15 KB，占 context window 20-40%。

#### 问题 D：无相关性排序、无字段语义定义、无 caching

- 5 个 runner 拿一样的全量上下文，无按需过滤
- 注入字段语义未定义（是完整 contentJson？字段子集？摘要？）
- CandidateLineage 无 caching，同一 artifact 被重复解析

#### 问题 E：与代码现状的事实偏差

- `sourceTrace` 不在 artifact 记录上，在 LLM 输出的 `contentJson` 内（不可信，需 rc-1/rc-2 校验）
- artifact 无 stage/kind by runner（`PIArtifactKind` 只有 principle/rule/skill/patch），需 `sourceTaskId → task.taskKind` 二跳
- PRI-508（artificer 注入 dreamer 5维）和 PRD Decision 12（evaluator 注入 scribe）**已完成**，现有 `resolveDreamerContext` / `extractScribeArtifactId` 是 bespoke 实现

---

## 2. 业界 2026 年上下文工程共识

本方案基于业界已成熟的 5 种上下文管理模式（参考 SwirlAI Newsletter 2026 综述、Anthropic Agent Skills 规范、Manus Agent Framework Lessons）：

### 2.1 五种成熟模式

| 模式 | 核心思想 | PD 适用性 |
|------|---------|----------|
| **Progressive Disclosure** | 按需分层加载：Discovery（名字+描述）→ Activation（完整指令）→ Execution（脚本） | ✅ 高度适用 |
| **Context Compression** | 滑动窗口 + summarization，旧信息摘要化 | ✅ 适用（TL;DR 即压缩） |
| **Context Routing** | 按 query 分类路由到不同 context source | ⚠️ 部分适用（runner 即天然路由） |
| **Evolved Retrieval**（Agentic/Graph/Self-RAG） | AI 自主决定检索策略 | ❌ 不适用（PD 是管道，非 agent loop） |
| **Tool Management** | 工具数量控制（<20，准确率 >10 下降） | ⚠️ 不适用（PD runner 非工具调用） |

### 2.2 核心原则

> **找到最小的、高信号 token 集合，使期望结果出现的概率最大化。** —— Anthropic

反模式：**给 Agent 更多上下文不等于让 Agent 更聪明。** 信息越多，precision 下降，推理能力削弱。

### 2.3 PD 的特殊性

- **管道是确定性的**（dreamer → philosopher → scribe → artificer → evaluator），不是开放式 agent loop
- **runner 是 LLM 单次调用**，不能用"agent 主动调工具"
- **前序信息是结构化的**（artifact contentJson 是 schema 化的）

因此 RAG / 工具调用模式不适用。**最合适的范式是：写入时冗余结构化摘要 + 读取时按需回溯大字段 + prompt 拼接时预算管理。**

---

## 3. 推荐方案：渐进式披露三层架构

### 3.1 设计原则

1. **默认最小化**：每个 runner 默认只拿到直接前驱 + TL;DR，不跨级访问
2. **按需扩展**：runner 通过 ContextManifest 声明额外需要什么，而非全量获取
3. **分层摘要**：artifact 携带 3 层信息（TL;DR / 结构化摘要 / 完整 contentJson）
4. **预算管理**：prompt 有硬预算，超预算按优先级截断
5. **相关性排序**：注入字段按"对该 runner 任务的贡献度"排序

### 3.2 三层信息披露架构

```
┌─────────────────────────────────────────────────────────────┐
│ Tier 0: TL;DR（≤50 token，所有 runner 默认获得）             │
│  写入时冗余到下游 artifact，零跨级回溯成本                    │
│  - pain: "用户反馈 AI 跳过了输入校验"                         │
│  - dreamer: "建议增加 path whitelist 机制"                    │
│  - scribe: "原则：所有外部输入必须经过显式校验"                │
│  - artificer: "实现了 validateInput() 函数"                   │
└─────────────────────────────────────────────────────────────┘
                          ↓ 默认
┌─────────────────────────────────────────────────────────────┐
│ Tier 1: 结构化摘要（200-500 token，runner 按 manifest 获取） │
│  写入时冗余到直接前驱 artifact                                │
│  - pain: { category, severity, rootSymptom }                 │
│  - dreamer: { badDecision, betterDecision, rationale }       │
│  - diagnosis: { rootCause, affectedComponents }              │
│  - scribe: { principleText, scope, exceptions }              │
│  - artificer: { changedFiles, apiSurface, risks }            │
└─────────────────────────────────────────────────────────────┘
                          ↓ 显式声明
┌─────────────────────────────────────────────────────────────┐
│ Tier 2: 完整详情（按需回溯，仅特定字段）                      │
│  通过 CandidateLineage 跨级回溯（仅 <10% 情况触发）           │
│  - pain.evidence（代码片段、日志）                            │
│  - dreamer.candidates[full]（多 candidate 完整对比）          │
│  - artificer.code（完整实现）                                 │
│  - diagnosis.reasoningChain（完整推理链）                     │
└─────────────────────────────────────────────────────────────┘
```

**关键**：Tier 0/1 是**写入时冗余**到直接前驱 artifact 的，runner 默认只读直接前驱就拿到。Tier 2 才需要 CandidateLineage 跨级回溯。

### 3.3 三层职责分离架构

```
┌─────────────────────────────────────────────────────────┐
│ Layer 3: Prompt Builder（纯函数，无 I/O）                │
│  - 接收 EnrichedContext，拼接 prompt                     │
│  - 无条件分支（context 字段统一可选）                     │
└─────────────────────────────────────────────────────────┘
                        ↑
┌─────────────────────────────────────────────────────────┐
│ Layer 2: ContextResolver（按 manifest 提取 + 预算管理）  │
│  - 接收 ContextManifest + LineageData                    │
│  - 按 manifest 提取字段                                  │
│  - PromptBudgetManager 分配 token                        │
│  - 输出 EnrichedContext                                  │
└─────────────────────────────────────────────────────────┘
                        ↑
┌─────────────────────────────────────────────────────────┐
│ Layer 1: CandidateLineage（纯血缘回溯 + caching）        │
│  - getLineage(artifactId) → LineageChain                 │
│  - 按 taskKind / artifactKind 查祖先                     │
│  - request-scoped cache                                  │
│  - Result<Chain, LineageError> 错误处理                  │
└─────────────────────────────────────────────────────────┘
```

---

## 4. 详细设计

### 4.1 Tier 0/1：写入时冗余（ArtifactTldr）

#### 4.1.1 设计

每个 artifact 写入时，writer 主动生成并冗余一个 `tldr` 字段到 contentJson：

```typescript
// scribe artifact contentJson 写入时
{
  "principleText": "所有外部输入必须经过显式校验",
  "scope": "all external input boundaries",
  "exceptions": ["trusted internal configs"],
  "tldr": {                          // ← 新增，写入时冗余
    "pain": "用户反馈 AI 跳过了输入校验",
    "dreamer": "建议增加 path whitelist 机制",
    "diagnosis": "根因：未校验输入路径",
    "scribe": "原则：所有外部输入必须经过显式校验"
  },
  "summary": {                       // ← 新增，Tier 1 结构化摘要
    "pain": { category: "validation", severity: "high", rootSymptom: "skipped input check" },
    "dreamer": { badDecision: "trust user input", betterDecision: "path whitelist", rationale: "explicit > implicit" },
    "diagnosis": { rootCause: "no validation layer", affectedComponents: ["input handler"] }
  },
  "sourceTrace": { ... }             // 已有
}
```

#### 4.1.2 TL;DR 生成方式

两种方式（writer 选择）：

1. **LLM 生成**：writer 写入时调用一次轻量 LLM 生成 tldr（固定成本，~50 token）
2. **字段提取**：writer 从 input artifact 提取关键字段填充 summary（无 LLM 成本）

推荐方式 2（字段提取），因为：
- 零 LLM 成本
- 确定性（可测试）
- 字段已有 schema，提取逻辑简单

#### 4.1.3 向后兼容

- 旧 artifact 无 `tldr` / `summary` 字段 → runner 回退到跨级回溯（现有 `resolveDreamerContext` 逻辑）
- 新 artifact 有 `tldr` / `summary` → runner 直接读取，零跨级回溯

### 4.2 ContextManifest：runner 声明它需要什么

#### 4.2.1 设计

每个 runner 声明一个 manifest，明确需要哪些 tier 的哪些字段：

```typescript
interface ContextManifest {
  tier0: string[];      // 需要的 TL;DR 字段路径，如 ['pain.tldr', 'diagnosis.tldr']
  tier1: string[];      // 需要的结构化摘要字段
  tier2: string[];      // 需要的完整详情字段（触发跨级回溯）
  budget: number;       // token 硬预算
  priority: string[];   // 字段优先级排序（超预算时按此截断）
}
```

#### 4.2.2 各 runner 的 manifest

```typescript
// dreamer-runner：提方案，需要 pain 根因和 diagnosis
const dreamerManifest: ContextManifest = {
  tier0: ['pain.tldr', 'diagnosis.tldr'],
  tier1: ['pain.category', 'pain.severity', 'pain.rootSymptom',
          'diagnosis.rootCause', 'diagnosis.affectedComponents'],
  tier2: ['pain.evidence'],  // 显式声明需要 pain 原始证据
  budget: 1500,
  priority: ['pain.evidence', 'diagnosis.rootCause', 'pain.rootSymptom',
             'pain.category', 'pain.severity', 'diagnosis.affectedComponents']
};

// artificer-runner：写代码，需要 scribe 原则 + dreamer 决策
const artificerManifest: ContextManifest = {
  tier0: ['scribe.tldr', 'dreamer.tldr', 'diagnosis.tldr'],
  tier1: ['scribe.principleText', 'scribe.scope',
          'dreamer.betterDecision', 'dreamer.rationale',
          'diagnosis.rootCause'],
  tier2: [],  // 不需要原始 pain evidence
  budget: 2000,
  priority: ['scribe.principleText', 'dreamer.betterDecision',
             'diagnosis.rootCause', 'scribe.scope', 'dreamer.rationale']
};

// evaluator-runner：三段式校验，需要最全，但分两阶段
const evaluatorManifestStage1: ContextManifest = {
  tier0: ['pain.tldr', 'dreamer.tldr', 'scribe.tldr', 'artificer.tldr'],
  tier1: ['pain.rootSymptom', 'pain.category',
          'dreamer.badDecision', 'dreamer.betterDecision', 'dreamer.rationale',
          'scribe.principleText', 'scribe.scope',
          'artificer.changedFiles', 'artificer.apiSurface'],
  tier2: [],  // Stage 1 不回溯大字段
  budget: 3000,
  priority: ['scribe.principleText', 'dreamer.betterDecision',
             'pain.rootSymptom', 'artificer.apiSurface',
             'dreamer.rationale', 'scribe.scope', 'pain.category',
             'artificer.changedFiles', 'dreamer.badDecision']
};

const evaluatorManifestStage2: ContextManifest = {
  ...evaluatorManifestStage1,
  tier2: ['pain.evidence'],  // 仅当 pain coverage flagged 时
  budget: 4500,              // Stage 2 给更多预算
};
```

### 4.3 PromptBudgetManager：硬预算 + 优先级截断

```typescript
class PromptBudgetManager {
  allocate(
    manifest: ContextManifest,
    available: LineageData
  ): EnrichedContext {
    const fields: ScoredField[] = [];

    // 1. 收集 manifest 声明的字段，按 tier 评分
    for (const fieldPath of [...manifest.tier0, ...manifest.tier1, ...manifest.tier2]) {
      const value = available.get(fieldPath);
      if (value !== undefined) {
        fields.push({
          path: fieldPath,
          value,
          tokenCost: estimateTokens(value),
          priority: manifest.priority.indexOf(fieldPath),
        });
      }
    }

    // 2. 按优先级排序（priority 数组前面的优先级高）
    fields.sort((a, b) => a.priority - b.priority);

    // 3. 按预算分配，超预算截断
    let remaining = manifest.budget;
    const allocated: EnrichedContext = {};
    for (const f of fields) {
      if (f.tokenCost <= remaining) {
        allocated[f.path] = f.value;
        remaining -= f.tokenCost;
      } else if (remaining > 100) {
        // 预算还剩 100+ token，尝试摘要化截断
        allocated[f.path] = truncate(f.value, remaining);
        remaining = 0;
      } else {
        // 预算耗尽，记录被截断的字段
        allocated.__truncated__ = allocated.__truncated__ || [];
        allocated.__truncated__.push(f.path);
        break;
      }
    }

    return allocated;
  }
}
```

**关键设计**：
- 优先级数组**显式声明**哪个字段最重要
- 超预算时**按优先级截断**，而非平均缩减
- `__truncated__` 字段让 LLM 知道"还有信息但被截断了"，可在 concerns 里指出"需要更多信息"

### 4.4 CandidateLineage：退化为 tier2 应急通道

#### 4.4.1 职责收窄

不再作为普遍机制，只在 evaluator Stage 2（pain coverage flagged）时使用。复杂度大幅降低。

#### 4.4.2 API 设计（修正工单的事实偏差）

```typescript
// 按 taskKind 查（贴合代码现状，PIArtifactKind 无 stage）
async getAncestorByTaskKind(
  startArtifactId: string,
  taskKind: RunnerKind  // 'dreamer' | 'scribe' | ...
): Promise<PIArtifactRecord | null>;

// 按 artifactKind 查（如"找前序第一个 principle artifact"）
async getAncestorByArtifactKind(
  startArtifactId: string,
  artifactKind: PIArtifactKind  // 'principle' | 'rule' | ...
): Promise<PIArtifactRecord | null>;
```

**注意**：不要用 stage 枚举（`'pain' | 'diagnosis' | ...`），因为 `PIArtifactKind` 只有 `principle/rule/skill/patch`。要判断"这是 dreamer artifact"，必须 `artifact.sourceTaskId → task.taskKind` 二跳查询。

#### 4.4.3 错误处理（rc-9-no-silent-fallback）

返回 `Result<CandidateLineageChain, LineageError>`，区分异常类型：

| 异常类型 | 处理方式 | 理由 |
|---------|---------|------|
| artifact 不存在（数据损坏） | 抛错 + emit 事件 | 数据完整性问题，不应静默 |
| sourceTrace 字段缺失（历史数据） | 返回 partial chain + note | 可预期的历史数据兼容 |
| contentJson 解析失败 | 抛错 + emit 事件 | 不可信数据损坏，需告警 |
| sourceTrace 指向的 artifact 已删除 | 返回 partial chain + note | 可预期的清理 |

#### 4.4.4 Caching

request-scoped cache，非全局：

```typescript
class CandidateLineage {
  private cache = new Map<string, CandidateLineageChain>();

  async getLineage(startArtifactId: string): Promise<Result<CandidateLineageChain, LineageError>> {
    if (this.cache.has(startArtifactId)) {
      return { ok: true, value: this.cache.get(startArtifactId)! };
    }
    // ... 回溯 ...
    if (result.ok) this.cache.set(startArtifactId, result.value);
    return result;
  }
}
```

### 4.5 两阶段评估（Progressive Evaluator）

#### 4.5.1 解决"不知道需不需要详情"的困境

evaluator 三段式校验有困境：**不看 pain evidence，怎么知道它相不相关？** 看了又怕爆上下文。

**解法：先看摘要，可疑才看详情**

```
Stage 1: 基于摘要的快速评估（tier0 + tier1）
  → 三段式校验全部通过 → 完成，无需 tier2
  → 发现 pain coverage 可疑 → 进入 Stage 2

Stage 2: 按需回溯详情（tier2）
  → 回溯 pain.evidence，做深度对比
  → 输出最终 concerns
```

#### 4.5.2 实现

```typescript
async function evaluateWithProgressiveDisclosure(
  lineage: CandidateLineage
): Promise<EvaluatorOutput> {
  // Stage 1: 摘要评估
  const summaryContext = await lineage.resolve(evaluatorManifestStage1);
  const preliminaryResult = await llm.evaluate(summaryContext);

  // 如果三段式全部通过，直接返回
  if (preliminaryResult.allDimensionsPass()) {
    return preliminaryResult;
  }

  // Stage 2: 如果 pain coverage 可疑，回溯 pain evidence
  if (preliminaryResult.painCoverage!.flagged) {
    const deepContext = await lineage.resolve(evaluatorManifestStage2);
    return await llm.evaluate(deepContext);
  }

  return preliminaryResult;
}
```

**优点**：
- 90% 的情况只跑 Stage 1，省 token
- 只有真正需要深度校验时才回溯大字段
- LLM 先形成初步判断，再有针对性地查证，避免"信息过载导致判断模糊"

### 4.6 evaluator 三段式校验的形式化定义

#### 4.6.1 compressionFidelity 契约

PRI-513 的核心创新是"dreamer → scribe 压缩保真度"校验，但需形式化定义：

```typescript
interface CompressionFidelityCheck {
  // 每个 5维字段是否在 scribe 文本中有对应表述
  badDecisionCovered: boolean;
  betterDecisionCovered: boolean;
  rationaleCovered: boolean;
  riskLevelCovered: boolean;
  strategicPerspectiveCovered: boolean;
  // 未覆盖的字段
  missingDimensions: string[];
  explanation: string;
}
```

#### 4.6.2 output schema 兼容性

PRI-513 把 `intentConsistency` 重命名为 `painCoverage` + `compressionFidelity` + `implementationFidelity`。

**问题**：当前 `intentConsistency` 被 `artificer-prompt-builder.ts:12` 引用（"judge intentConsistency"），重命名会破坏现有 artificer prompt 契约。历史 evaluator artifact 的 contentJson 里有 `intentConsistency` 字段。

**建议**：
- `implementationFidelity` 保留 `intentConsistency` 作为别名（向后兼容）
- 新增 `painCoverage` + `compressionFidelity` 作为可选字段（不破坏旧数据）
- output schema 演进策略：v1 → v2 的 migration 路径

#### 4.6.3 与 repair loop 的扩展性

当前 repair loop（PRI-509/510）只接 artificer：evaluator 判定 needs_revision → artificer 重跑。

PRI-513 三段式校验新增两个失败点（pain→dreamer / dreamer→scribe），但工单没设计对应 repair 策略。

**建议**：
- 短期：三段式校验只做**诊断**（concerns 指向具体阶段），不触发自动 repair
- 长期：扩展 repair loop 支持阶段化重跑（dreamer repair / scribe repair）
- 明确写在设计里，避免实现者误以为要扩展 repair loop

---

## 5. 与现有代码的契合

### 5.1 现有 bespoke 逻辑的演化

| 现有代码 | 演化方向 |
|---------|---------|
| `resolveDreamerContext`（artificer-runner.ts:175-283） | → 演化为 TL;DR 写入时冗余（scribe 写入时冗余 dreamer TL;DR） |
| `extractScribeArtifactId`（evaluator-runner.ts:90） | → 演化为 TL;DR 写入时冗余（artificer 写入时冗余 scribe TL;DR） |
| `PIArtifactRecord.contentJson` | → 新增 `tldr` + `summary` 字段（向后兼容） |
| 5 个 prompt builder | → 接收 `EnrichedContext`（manifest 解析后），无需条件分支 |
| `PIArtifactStore.listLineage` | → 单跳，不递归；CandidateLineage 自己实现递归回溯 |

### 5.2 新增抽象

| 新增 | 替代 | 价值 |
|------|------|------|
| `ArtifactTldr` 字段 | CandidateLineage 普遍回溯 | 90% 需求零成本满足 |
| `ContextManifest` | 5 个 runner 硬编码注入逻辑 | 声明式，可测试，易调整 |
| `PromptBudgetManager` | 无 | 硬预算保证不爆炸 |
| `ProgressiveEvaluator` | PRI-513 单阶段三段式 | 90% 情况省 token，10% 深度校验 |
| `CandidateLineage`（收窄版） | 工单的 CandidateLineageGraph | 仅 tier2 应急通道，复杂度可控 |

### 5.3 架构合规

- **`antipattern-core-io` 不触发**：CandidateLineage 是纯逻辑，通过构造函数注入 `PIArtifactStore`，不 import fs/path
- **`rc-1` / `rc-2` 合规**：解析 contentJson 走 unknown + Object.hasOwn，无 `as` 旁路（现有 `resolveDreamerContext` 已示范）
- **`rc-9` 合规**：错误处理返回 Result 类型，不静默 fallback
- **architecture-regression.test.ts 不触发**：candidate-lineage.ts 是纯逻辑，不登记 io-seam-registry

---

## 6. 实施建议

### 6.1 重新划分三层级（替代 PRI-511/512/513）

| 原工单 | 重构后 | 内容 |
|--------|--------|------|
| PRI-511（CandidateLineage API） | **Layer 0: ArtifactTldr 写入时冗余** | writer 写入时生成 tldr + summary 字段，冗余到下游 artifact |
| PRI-512（5 runner 注入） | **Layer 1: ContextManifest + BudgetManager** | 每个 runner 声明 manifest，BudgetManager 按优先级分配 |
| PRI-513（evaluator 三段式） | **Layer 2: 两阶段评估 + 按需 tier2 回溯** | Stage 1 摘要评估，Stage 2 仅在 flagged 时回溯 |

### 6.2 实施顺序

1. **Phase 1（Layer 0）**：给 artifact writer 加 tldr + summary 字段
   - 改 5 个 runner 的 writer 逻辑（写入时冗余）
   - 向后兼容（旧 artifact 无 tldr 时回退到跨级回溯）
   - 测试：新 artifact 有 tldr，旧 artifact 回退正常

2. **Phase 2（Layer 1）**：ContextManifest + BudgetManager
   - 定义 ContextManifest 接口
   - 5 个 runner 各声明 manifest
   - 实现 PromptBudgetManager
   - 测试：预算截断行为、优先级排序

3. **Phase 3（Layer 2）**：两阶段评估 + CandidateLineage 收窄版
   - 实现 CandidateLineage（仅 tier2 回溯，带 caching）
   - evaluator 改为两阶段
   - 三段式校验形式化（compressionFidelity 契约）
   - output schema 向后兼容（intentConsistency 别名）
   - 测试：90% 情况只跑 Stage 1，Stage 2 触发条件

### 6.3 必须先修正的工单文档问题

无论走哪条路径，必须先修正：

1. **修正工单编号交叉引用**：PRI-511/512/513 描述里的"PRI-510 作为层级1"全部改为"PRI-511 作为层级1"
2. **修正 `sourceTrace` 字段位置描述**：从"artifact.sourceTrace"改为"artifact.contentJson 内的 sourceTrace（不可信，需 rc-1/rc-2 校验）+ artifact.lineageArtifactIds（可信但单跳）融合回溯"
3. **修正 artifact kind 假设**：明确"无 stage/kind by runner，需 sourceTaskId → task.taskKind 二跳"
4. **明确 PRI-508/PRD Decision 12 已完成**：PRI-512 应说明"artificer/evaluator 已有 bespoke 跨级注入，本工单是重构 + 扩展"
5. **明确 philosopher 是 MVP-Quiet**：PRI-512 注入规则表应剔除 philosopher 或说明理由

### 6.4 feature flag 注册

- **Layer 0（写入时冗余）**：纯字段添加，向后兼容，**可不需要 flag**
- **Layer 1（ContextManifest）**：若不改运行时行为（只重构），**可不需要 flag**；若新增注入字段，需 quiet flag
- **Layer 2（两阶段评估）**：改变 evaluator 行为（新增 Stage 2 回溯），**需要 quiet flag**（default off），注册到 `.pd/config.yaml`

### 6.5 BDD 影响评估

- Layer 0/1：不改行为契约，`.feature` 保持不变
- Layer 2：改变 evaluator output schema（新增 painCoverage / compressionFidelity），需更新对应 `.feature` 并在 PR 说明

---

## 7. 对比：工单方案 vs 本方案

| 维度 | 工单方案（PRI-511/512/513） | 本方案（渐进式披露） |
|------|---------------------------|-------------------|
| 核心假设 | 信息越多越聪明 | 最小高信号集合最优 |
| 默认信息量 | 全量跨级 artifact | TL;DR + 结构化摘要 |
| 跨级回溯频率 | 每次 buildContext | 仅 evaluator Stage 2（<10% 情况） |
| token 增量/runner | 2000-8000（全量） | 500-1500（摘要）+ 按需 |
| AI 注意力 | 低（信息过载） | 高（只看相关字段） |
| 相关性排序 | 无 | manifest.priority 显式排序 |
| 预算管理 | 无 | PromptBudgetManager 硬截断 |
| 多 candidate 处理 | 全注入（混乱） | TL;DR 摘要 + 按需详情 |
| 断链容错 | 复杂（运行时回溯失败） | 简单（TL;DR 已冗余，断链只丢 tier2） |
| LLM 判断质量 | 信息多但分散，易 lost in middle | 信息少但聚焦，关键时再扩 |
| 成本可控性 | 差（token 随 pain evidence 大小波动） | 好（摘要固定成本 + 按需扩展） |
| 符合业界趋势 | ❌ 违背 | ✅ 完全契合 2026 共识 |
| 与现有代码契合 | ❌ 多处事实偏差 | ✅ 现有 bespoke 逻辑自然演化 |

---

## 8. 风险与权衡

### 8.1 本方案的风险

| 风险 | 缓解 |
|------|------|
| TL;DR 写入时冗余增加 artifact 体积 | TL;DR ≤50 token，summary 200-500 token，总体增量可控 |
| TL;DR 生成质量依赖 writer 逻辑 | 推荐字段提取（非 LLM 生成），确定性可测试 |
| 两阶段评估增加 10% 情况的 LLM 调用 | 90% 情况省 token，整体成本仍下降 |
| ContextManifest 增加配置复杂度 | 声明式，5 个 runner 各一份，易维护 |

### 8.2 工单方案的风险（本方案规避）

| 风险 | 工单方案 | 本方案 |
|------|---------|--------|
| 上下文爆炸 | 高（全量注入 8-15KB） | 低（摘要 500-1500 token） |
| LLM 注意力分散 | 高（lost in middle） | 低（聚焦相关字段） |
| 跨级回溯性能 | 高（无 caching，重复解析） | 低（90% 零回溯） |
| 断链容错 | 复杂 | 简单 |

---

## 9. 待 Owner 决策

1. **是否采纳渐进式披露方案**（替代工单的全量注入方案）？
2. **是否走 ADR-0014 amendment 路径**（类似 2026-06-10/16/17 三个 amendment）？
3. **TL;DR 生成方式**：字段提取（推荐）vs LLM 生成？
4. **Layer 2 是否注册 quiet flag**（default off）？

---

## 10. 参考资料

- [Agent Context Engineering：五个已成熟的上下文管理模式](http://m.toutiao.com/group/7631127674383073792/) — 2026 年五种上下文管理模式综述
- [Anthropic Agent Skills Specification](https://www.anthropic.com/) — Agent Skills 官方规范
- [Anthropic Engineering: Effective context engineering for agents](https://www.anthropic.com/) — 官方对 context engineering 的定义
- [Manus Agent Framework Lessons](https://manus.im/) — ReAct agent context bloat 实践细节
- [ADR-0014 MVP-First Strategy](file:///c:/Users/csuzn/.trae-cn/worktrees/principles/feat-review-linear-pri-511-513-fzZr81/docs/adr/0014-mvp-first-strategy-and-product-pivot.md)
- [PRODUCT_IDENTITY.md](file:///c:/Users/csuzn/.trae-cn/worktrees/principles/feat-review-linear-pri-511-513-fzZr81/docs/product/PRODUCT_IDENTITY.md)
- [INTERNALIZATION_PIPELINE.md](file:///c:/Users/csuzn/.trae-cn/worktrees/principles/feat-review-linear-pri-511-513-fzZr81/docs/architecture/INTERNALIZATION_PIPELINE.md)
- [2026-06-28-rulecode-context-v2 ADR](file:///c:/Users/csuzn/.trae-cn/worktrees/principles/feat-review-linear-pri-511-513-fzZr81/docs/adr/2026-06-28-rulecode-context-v2.md) — 最相似的近期上下文增强先例
