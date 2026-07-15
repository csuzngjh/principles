# 内化管道上下文工程：渐进式披露设计方案

> **文档类型**：设计评审 + 替代方案
> **针对工单**：PRI-511 / PRI-512 / PRI-513（信息共享池三层级）
> **创建日期**：2026-07-14
> **修订日期**：2026-07-14（v2 — 自检评审修正，见 §11）
> **状态**：Proposal — 待 Owner 决策
> **评审依据**：ADR-0014（MVP-First）、PRODUCT_IDENTITY.md、INTERNALIZATION_PIPELINE.md、2026 业界上下文工程共识

---

## 0. TL;DR

PRI-511/512/513 提出的"信息共享池"方案存在两个根本问题：

1. **设计假设违背 2026 年业界共识**：工单隐含"信息越多越聪明"，但 Anthropic / Manus / OpenAI 的工程实践已证伪——上下文增长会导致 precision 下降（lost-in-the-middle）。
2. **未讨论最核心的设计决策**：写入时冗余 vs 读取时回溯。工单隐式选了高成本的"读取时回溯"。

**本方案推荐**：采用业界已成熟的 **Progressive Disclosure（渐进式披露）** 模式，三层信息架构（TL;DR / 结构化摘要 / 原始详情）+ ContextManifest 声明式需求 + PromptBudgetManager 硬预算 + 两阶段评估。

**重要诚实声明（v2 修正）**：本方案的核心卖点不是"零成本"，而是"用更少的 token 获得更聚焦的注意力"。跨级 TL;DR 的传递有成本（单跳 I/O + LLM 顺带生成的边际成本），tier2 回溯频率需实测验证而非假设。成本优势的成立前提见 §4.8 敏感性分析。

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
| 读取侧改动 | 5 个 runner buildContext + 5 个 prompt builder | 较少（runner 读直接前驱的冗余字段） |
| 写入侧改动 | 零 | 改 writer（增量冗余字段 + 单跳读直接前驱） |
| 跨级访问成本 | 每次 buildContext 多次 I/O + 多次 parse | 单跳 I/O（写入时读直接前驱）+ tier2 按需回溯 |
| contentJson 重复解析 | 高（无 caching） | 较低（冗余字段已提取） |
| 断链处理 | 复杂（运行时回溯失败） | 较简单（写入时检测到缺失，运行时降级） |

工单隐式选了"读取时回溯"，但相当一部分跨级需求可以用"写入时冗余摘要"以更低成本满足。具体比例需实测验证（见 §4.8）。

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

本方案借鉴业界已成熟的 5 种上下文管理模式（参考 SwirlAI Newsletter 2026 综述、Anthropic Agent Skills 规范、Manus Agent Framework Lessons）：

### 2.1 五种成熟模式

| 模式 | 核心思想 | PD 适用性 |
|------|---------|----------|
| **Progressive Disclosure** | 按需分层加载：Discovery（名字+描述）→ Activation（完整指令）→ Execution（脚本） | ⚠️ 部分适用（PD 是管道非 agent loop，需适配） |
| **Context Compression** | 滑动窗口 + summarization，旧信息摘要化 | ✅ 适用（TL;DR 即压缩） |
| **Context Routing** | 按 query 分类路由到不同 context source | ⚠️ 部分适用（runner 即天然路由） |
| **Evolved Retrieval**（Agentic/Graph/Self-RAG） | AI 自主决定检索策略 | ❌ 不适用（PD 是管道，非 agent loop） |
| **Tool Management** | 工具数量控制（<20，准确率 >10 下降） | ⚠️ 不适用（PD runner 非工具调用） |

### 2.2 核心原则

> **找到最小的、高信号 token 集合，使期望结果出现的概率最大化。** —— Anthropic

反模式：**给 Agent 更多上下文不等于让 Agent 更聪明。** 信息越多，precision 下降，推理能力削弱。

### 2.3 PD 的特殊性（v2 修正：诚实声明适用性边界）

- **管道是确定性的**（dreamer → philosopher → scribe → artificer → evaluator），不是开放式 agent loop
- **runner 是 LLM 单次调用**，不能用"agent 主动调工具"——这意味着业界 progressive disclosure 的"agent 按需主动加载"核心机制在 PD 中不直接适用
- **前序信息是结构化的**（artifact contentJson 是 schema 化的）

**适用性声明**：本方案借鉴 progressive disclosure 的"分层信息梯度"思想，但因 PD 是管道而非 agent loop，无法实现真正的"agent 主动按需加载"。PD 的适配方式是：ContextManifest 预声明需求（而非 agent 运行时决定）+ 两阶段评估（evaluator 的 Stage 2 是最接近"按需加载"的机制）。

---

## 3. 推荐方案：渐进式披露三层架构

### 3.1 设计原则

1. **默认最小化**：每个 runner 默认只拿到直接前驱 + 自身 TL;DR，不跨级访问
2. **按需扩展**：runner 通过 ContextManifest 声明额外需要什么，而非全量获取
3. **分层摘要**：artifact 携带 3 层信息（TL;DR / 结构化摘要 / 完整 contentJson）
4. **预算管理**：prompt 有硬预算，超预算按优先级截断
5. **相关性排序**：注入字段按"对该 runner 任务的贡献度"排序

### 3.2 三层信息披露架构（v2 修正：明确 TL;DR 传递机制）

```
┌─────────────────────────────────────────────────────────────┐
│ Tier 0: TL;DR（≤50 token/阶段）                              │
│  每个 artifact 携带自身 TL;DR + 直接前驱的 TL;DR              │
│  - 自身 TL;DR：LLM 主输出顺带生成（边际成本极低）              │
│  - 前驱 TL;DR：写入时单跳读取直接前驱（单跳 I/O 成本）         │
│  - 衰减缓解：携带 sourceArtifactId + sourceArtifactUpdatedAt  │
└─────────────────────────────────────────────────────────────┘
                          ↓ 默认
┌─────────────────────────────────────────────────────────────┐
│ Tier 1: 结构化摘要（200-500 token，runner 按 manifest 获取） │
│  每个 artifact 携带自身结构化摘要                              │
│  - pain: { category, severity, rootSymptom }                 │
│  - dreamer: { badDecision, betterDecision, rationale }       │
│  - diagnosis: { rootCause, affectedComponents }              │
│  - scribe: { principleText, scope, exceptions }              │
│  - artificer: { changedFiles, apiSurface, risks }            │
└─────────────────────────────────────────────────────────────┘
                          ↓ 显式声明
┌─────────────────────────────────────────────────────────────┐
│ Tier 2: 完整详情（按需回溯，仅特定字段）                      │
│  通过 CandidateLineage 跨级回溯（频率待实测，见 §4.8）        │
│  - pain.evidence（代码片段、日志）                            │
│  - dreamer.candidates[full]（多 candidate 完整对比）          │
│  - artificer.code（完整实现）                                 │
│  - diagnosis.reasoningChain（完整推理链）                     │
└─────────────────────────────────────────────────────────────┘
```

**v2 关键修正**：不再声称 Tier 0/1 "零成本"。
- **自身 TL;DR**：LLM 主输出顺带生成，边际成本极低（主输出已是 LLM 调用）
- **跨级 TL;DR**：通过级联传播（每个 artifact 携带直接前驱的 TL;DR），写入时单跳 I/O 读取直接前驱
- **衰减风险**：多级摘要会失真（摘要的摘要），通过 `sourceArtifactUpdatedAt` 检测失效（见 §4.7）

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
│  - 截断时 emit context_truncated 事件（可观察性）         │
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

### 4.1 Tier 0/1：写入时冗余（ArtifactTldr）（v2 重写）

#### 4.1.1 设计

每个 artifact 写入时，writer 生成并冗余以下字段到 contentJson：

```typescript
// scribe artifact contentJson 写入时
{
  "principleDraft": { ... },          // 已有（scribe 自身输出）
  "risks": [ ... ],                   // 已有
  "tldr": {                           // ← 新增
    "self": "原则：所有外部输入必须经过显式校验",      // scribe 自身 TL;DR
    "predecessor": {                   // 直接前驱（philosopher）的 TL;DR
      "self": "提炼为'显式校验'原则",
      "predecessor": {                 // philosopher 的前驱（dreamer）的 TL;DR
        "self": "建议增加 path whitelist 机制",
        "predecessor": {               // dreamer 的前驱（diagnostician）的 TL;DR
          "self": "根因：未校验输入路径"
        }
      }
    },
    "sourceArtifactId": "art-xxx",     // 直接前驱 artifact ID
    "sourceArtifactUpdatedAt": "2026-07-14T10:00:00Z"  // 前驱更新时间（失效检测）
  },
  "summary": {                        // ← 新增，Tier 1 自身结构化摘要
    "principleText": "所有外部输入必须经过显式校验",
    "scope": "all external input boundaries",
    "exceptions": ["trusted internal configs"]
  },
  "sourceTrace": { ... }              // 已有
}
```

#### 4.1.2 TL;DR 生成方式（v2 重写：三种方式，诚实对比）

| 方式 | 成本 | 适用场景 | 限制 |
|------|------|---------|------|
| **A. LLM 主输出顺带生成**（推荐） | 边际成本极低（主输出已是 LLM 调用） | 生成自身 TL;DR | LLM 需在 output schema 中新增 tldr.self 字段 |
| **B. 字段提取** | 零 LLM 成本 | 生成自身 summary（结构化字段已有） | 仅适用于自身字段，无法跨级提取 |
| **C. 写入时单跳读取** | 单跳 I/O（读直接前驱） | 传递前驱 TL;DR | 依赖直接前驱已有 tldr 字段 |

**v2 关键修正**：原方案推荐"字段提取"并声称"零成本"，但代码核查发现 scribe 的直接输入（philosopher artifact）**没有 pain 字段**（[philosopher-output.ts:22-29](file:///c:/Users/csuzn/.trae-cn/worktrees/principles/feat-review-linear-pri-511-513-fzZr81/packages/principles-core/src/runtime-v2/internalization/philosopher-output.ts) 只有 thesis/principleCandidate/risks）。因此跨级 TL;DR 无法通过字段提取获得，必须通过级联传播（方式 C）。

**推荐组合**：
- `tldr.self`：方式 A（LLM 主输出顺带生成）
- `tldr.predecessor`：方式 C（写入时单跳读取直接前驱的 tldr）
- `summary`（自身结构化摘要）：方式 B（字段提取，已有字段）

#### 4.1.3 级联传播的衰减风险与缓解

级联传播意味着 pain 的信息经过 dreamer → philosopher → scribe 三级摘要才到达 scribe。每级摘要都会丢失细节。

**缓解措施**：
1. **TL;DR 长度限制 ≤50 token**：强制 LLM 生成精炼摘要，减少每级衰减
2. **`sourceArtifactUpdatedAt` 失效检测**：下游比对前驱 artifact 的 updatedAt，如果前驱被 upsert 更新，TL;DR 已过时，降级到 tier2 回溯（见 §4.7）
3. **衰减检测事件**：当 TL;DR 链深度超过 3 级时，emit `tldr_decay_warning` 事件，提示 owner

#### 4.1.4 向后兼容

- 旧 artifact 无 `tldr` / `summary` 字段 → runner 回退到跨级回溯（现有 `resolveDreamerContext` 逻辑）
- 新 artifact 有 `tldr` / `summary` → runner 直接读取

### 4.2 ContextManifest：runner 声明它需要什么

#### 4.2.1 设计

每个 runner 声明一个 manifest，明确需要哪些 tier 的哪些字段：

```typescript
interface ContextManifest {
  tier0: string[];      // 需要的 TL;DR 字段路径
  tier1: string[];      // 需要的结构化摘要字段
  tier2: string[];      // 需要的完整详情字段（触发跨级回溯）
  budget: number;       // token 硬预算
  priority: string[];   // 字段优先级排序（超预算时按此截断）
}
```

#### 4.2.2 各 runner 的 manifest（v2 修正：标注待验证假设）

```typescript
// dreamer-runner：提方案，需要 pain 根因和 diagnosis
// 注意：pain.evidence 是否必须放在 tier2（触发回溯）还是 tier1（摘要即可）
// 是本方案成立的关键假设，需 spike 验证（见 §4.8）
const dreamerManifest: ContextManifest = {
  tier0: ['pain.tldr', 'diagnosis.tldr'],
  tier1: ['pain.category', 'pain.severity', 'pain.rootSymptom',
          'diagnosis.rootCause', 'diagnosis.affectedComponents'],
  tier2: ['pain.evidence'],  // ⚠️ 待验证：dreamer 是否必须看原始 evidence？
  budget: 1500,
  priority: ['diagnosis.rootCause', 'pain.rootSymptom',
             'pain.evidence', 'pain.category', 'pain.severity',
             'diagnosis.affectedComponents']
};

// artificer-runner：写代码，需要 scribe 原则 + dreamer 决策
const artificerManifest: ContextManifest = {
  tier0: ['scribe.tldr', 'dreamer.tldr', 'diagnosis.tldr'],
  tier1: ['scribe.principleText', 'scribe.scope',
          'dreamer.betterDecision', 'dreamer.rationale',
          'diagnosis.rootCause'],
  tier2: [],
  budget: 2000,
  priority: ['scribe.principleText', 'dreamer.betterDecision',
             'diagnosis.rootCause', 'scribe.scope', 'dreamer.rationale']
};

// evaluator-runner：三段式校验，分两阶段
const evaluatorManifestStage1: ContextManifest = {
  tier0: ['pain.tldr', 'dreamer.tldr', 'scribe.tldr', 'artificer.tldr'],
  tier1: ['pain.rootSymptom', 'pain.category',
          'dreamer.badDecision', 'dreamer.betterDecision', 'dreamer.rationale',
          'scribe.principleText', 'scribe.scope',
          'artificer.changedFiles', 'artificer.apiSurface'],
  tier2: [],
  budget: 3000,
  priority: ['scribe.principleText', 'dreamer.betterDecision',
             'pain.rootSymptom', 'artificer.apiSurface',
             'dreamer.rationale', 'scribe.scope', 'pain.category',
             'artificer.changedFiles', 'dreamer.badDecision']
};

const evaluatorManifestStage2: ContextManifest = {
  ...evaluatorManifestStage1,
  tier2: ['pain.evidence'],
  budget: 4500,
};
```

**v2 修正**：dreamer 的 `tier2: ['pain.evidence']` 标注为"待验证"。如果 dreamer 必须看原始 evidence 才能生成高质量 candidate，则 tier2 触发频率 ≥ dreamer 调用频率，方案的成本优势显著削弱。需 spike 验证。

#### 4.2.3 manifest 参数确定方法（v2 新增）

原方案未说明 `priority` 和 `budget` 如何确定。v2 补充：

- **priority**：基于 runner 的任务目标确定。例如 artificer 的任务是"按 scribe 原则写代码"，因此 `scribe.principleText` 优先级最高。初始值由设计决定，后续通过 dogfood 调优
- **budget**：基于 LLM context window（如 128K）减去系统指令（~2K）和输出预算（~2K）后，按 runner 复杂度分配。初始值：dreamer 1500 / artificer 2000 / evaluator 3000-4500，需实测调优
- **schema 版本化**：manifest 携带 `schemaVersion`，当 artifact schema 变化时（如 dreamer 新增第 6 维），manifest 同步更新并通过测试验证

### 4.3 PromptBudgetManager：硬预算 + 优先级截断（v2 增加可观察性）

```typescript
class PromptBudgetManager {
  allocate(
    manifest: ContextManifest,
    available: LineageData,
    emitEvent: (event: BudgetEvent) => void  // v2 新增：截断时 emit 事件
  ): EnrichedContext {
    const fields: ScoredField[] = [];

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

    fields.sort((a, b) => a.priority - b.priority);

    let remaining = manifest.budget;
    const allocated: EnrichedContext = {};
    for (const f of fields) {
      if (f.tokenCost <= remaining) {
        allocated[f.path] = f.value;
        remaining -= f.tokenCost;
      } else if (remaining > 100) {
        allocated[f.path] = truncate(f.value, remaining);
        remaining = 0;
      } else {
        allocated.__truncated__ = allocated.__truncated__ || [];
        allocated.__truncated__.push(f.path);
        // v2 新增：emit 结构化事件，让 owner 可观察截断行为
        emitEvent({
          type: 'context_truncated',
          fieldPath: f.path,
          reason: 'budget_exceeded',
          remainingBudget: remaining,
        });
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
- `__truncated__` 字段让 LLM 知道"还有信息但被截断了"
- **v2 新增**：截断时 emit `context_truncated` 事件，让 owner 通过 pd-cli 或 console 观察截断行为（解决原方案"owner 看不到截断"的可观察性盲点）

### 4.4 CandidateLineage：退化为 tier2 应急通道

#### 4.4.1 职责收窄

不再作为普遍机制，只在 evaluator Stage 2 或 TL;DR 失效时使用。

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

**注意**：不要用 stage 枚举（`'pain' | 'diagnosis' | ...`），因为 `PIArtifactKind` 只有 `principle/rule/skill/patch`（[peer-runner-contracts.ts:70-74](file:///c:/Users/csuzn/.trae-cn/worktrees/principles/feat-review-linear-pri-511-513-fzZr81/packages/principles-core/src/runtime-v2/internalization/peer-runner-contracts.ts)）。要判断"这是 dreamer artifact"，必须 `artifact.sourceTaskId → task.taskKind` 二跳查询。

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

### 4.5 两阶段评估（Progressive Evaluator）（v2 修正）

#### 4.5.1 解决"不知道需不需要详情"的困境

evaluator 三段式校验有困境：**不看 pain evidence，怎么知道它相不相关？** 看了又怕爆上下文。

**解法：先看摘要，可疑才看详情**

```
Stage 1: 基于摘要的快速评估（tier0 + tier1）
  → 三段式校验全部通过 → 完成，无需 tier2
  → flagged（见 §4.5.3 形式化判据） → 进入 Stage 2

Stage 2: 按需回溯详情（tier2）
  → 回溯 pain.evidence，做深度对比
  → 输出最终 concerns
```

#### 4.5.2 实现（v2 修正：形式化 flagged 判据 + 假阴性缓解）

```typescript
async function evaluateWithProgressiveDisclosure(
  lineage: CandidateLineage
): Promise<EvaluatorOutput> {
  // Stage 1: 摘要评估
  const summaryContext = await lineage.resolve(evaluatorManifestStage1);
  const preliminaryResult = await llm.evaluate(summaryContext);

  // v2 修正：形式化 flagged 判据
  const needsStage2 = isFlagged(preliminaryResult);

  // v2 新增：5% 随机强制 Stage 2 作为基线对照（缓解假阴性）
  const forceStage2 = Math.random() < 0.05;

  if (!needsStage2 && !forceStage2) {
    return preliminaryResult;
  }

  // Stage 2: 回溯详情
  const deepContext = await lineage.resolve(evaluatorManifestStage2);
  const deepResult = await llm.evaluate(deepContext);

  // v2 新增：如果 forceStage2 且 Stage 2 发现 Stage 1 漏掉的问题，emit 事件
  if (forceStage2 && !needsStage2 && deepResult.hasNewConcerns(preliminaryResult)) {
    emitEvent({
      type: 'stage1_false_negative',
      missedConcerns: deepResult.newConcerns,
    });
  }

  return deepResult;
}

// v2 新增：形式化 flagged 判据
function isFlagged(result: EvaluatorOutput): boolean {
  // 判据 1：compressionFidelity 有未覆盖维度
  if (result.compressionFidelity?.missingDimensions.length > 0) return true;

  // 判据 2：pain coverage 不完整
  if (result.painCoverage && !result.painCoverage.fullyCovered) return true;

  // 判据 3：implementationFidelity 低于阈值
  if (result.implementationFidelity && result.implementationFidelity.score < 0.7) return true;

  return false;
}
```

**v2 修正点**：
1. **形式化 flagged 判据**：`missingDimensions.length > 0 || !painCoverage.fullyCovered || implementationFidelity.score < 0.7`
2. **假阴性缓解**：5% 随机强制 Stage 2 作为基线对照，检测 Stage 1 是否漏判
3. **不再声称 "90% 只跑 Stage 1"**：实际比例需实测验证

#### 4.5.3 优点与诚实声明

**优点**：
- 信息少而聚焦，Stage 1 的摘要评估减少 lost-in-the-middle 风险
- 只有 flagged 时才回溯大字段
- LLM 先形成初步判断，再有针对性地查证

**诚实声明（v2 新增）**：
- Stage 1 的摘要可能不足以判断，导致假阴性（Stage 1 误判"全通过"）。5% 随机强制 Stage 2 是缓解措施，但无法完全消除
- Stage 2 触发率需实测验证，本方案不预设具体比例
- 如果 Stage 1 误判的根因是"摘要语义失真"（级联传播衰减），Stage 2 回溯后仍可能带着 Stage 1 的先入为主判断。Stage 2 设计为**独立评估**（重新生成，非延续 Stage 1），但仍需实测验证效果

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

#### 4.6.2 output schema 兼容性（v2 修正：修正引用位置）

PRI-513 把 `intentConsistency` 重命名为 `painCoverage` + `compressionFidelity` + `implementationFidelity`。

**v2 修正**：原方案错误声称 `intentConsistency` 被 `artificer-prompt-builder.ts:12` 引用。代码核查证实：
- `artificer-prompt-builder.ts` 中 **无** `intentConsistency` 匹配
- 真正引用 `intentConsistency` 的是 [evaluator-runner.ts:68](file:///c:/Users/csuzn/.trae-cn/worktrees/principles/feat-review-linear-pri-511-513-fzZr81/packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts)（"judge intentConsistency"）+ [evaluator-output.ts:40](file:///c:/Users/csuzn/.trae-cn/worktrees/principles/feat-review-linear-pri-511-513-fzZr81/packages/principles-core/src/runtime-v2/internalization/evaluator-output.ts)（`EvaluatorCodeReview.intentConsistency` 字段）

**影响**：重命名会破坏 **evaluator** 侧的 prompt 契约和 output schema，而非 artificer 侧。历史 evaluator artifact 的 contentJson 里有 `intentConsistency` 字段。

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

### 4.7 artifact 可变性与 TL;DR 一致性（v2 新增）

**问题**：代码核查证实 artifact 是**可变的**（[sqlite-pi-artifact-store.ts:75-102](file:///c:/Users/csuzn/.trae-cn/worktrees/principles/feat-review-linear-pri-511-513-fzZr81/packages/principles-core/src/runtime-v2/store/artifact/sqlite-pi-artifact-store.ts)，`ON CONFLICT DO UPDATE`）。dreamer 重跑会 upsert 更新 dreamer artifact，下游 scribe 中冗余的 `tldr.predecessor` 立即过时。

**缓解设计**：

```typescript
// 每个 tldr 携带来源 artifact 的 updatedAt
interface ArtifactTldr {
  self: string;
  predecessor?: {
    self: string;
    predecessor?: ArtifactTldr;  // 递归
    sourceArtifactId: string;
    sourceArtifactUpdatedAt: string;  // ← 关键：前驱的更新时间
  };
  sourceArtifactId: string;
  sourceArtifactUpdatedAt: string;
}

// 下游 runner 读取时检测失效
function isTldrStale(tldr: ArtifactTldr, artifactStore: PIArtifactStore): boolean {
  if (!tldr.predecessor) return false;
  const sourceArtifact = artifactStore.getArtifactById(tldr.predecessor.sourceArtifactId);
  if (!sourceArtifact) return true;  // 前驱已删除
  return sourceArtifact.updatedAt !== tldr.predecessor.sourceArtifactUpdatedAt;
}

// 失效时降级到 tier2 回溯
if (isTldrStale(tldr, artifactStore)) {
  emitEvent({ type: 'tldr_stale', artifactId: tldr.sourceArtifactId });
  return await candidateLineage.getAncestorByTaskKind(...);  // 降级回溯
}
```

### 4.8 tier2 触发率敏感性分析（v2 新增）

原方案声称 "90% 零回溯" 和 "10% tier2"，但无数据支撑。v2 提供敏感性分析：

**成本模型**：
- Stage 1 成本 = manifest.budget（evaluator = 3000 token）
- Stage 2 成本 = manifest.budget + tier2 回溯成本（evaluator = 4500 token）
- 假设工单方案每次 evaluator = 5000 token（全量注入估算）

| tier2 触发率 | 本方案 Stage 1 成本 | 本方案 Stage 2 成本 | 本方案加权总成本 | 工单方案成本 | 本方案优势 |
|-------------|--------------------|--------------------|-----------------|------------|-----------|
| 10% | 3000 × 90% = 2700 | 4500 × 10% = 450 | 3150 | 5000 | ✅ 省 37% |
| 30% | 3000 × 70% = 2100 | 4500 × 30% = 1350 | 3450 | 5000 | ✅ 省 31% |
| 50% | 3000 × 50% = 1500 | 4500 × 50% = 2250 | 3750 | 5000 | ✅ 省 25% |
| 70% | 3000 × 30% = 900 | 4500 × 70% = 3150 | 4050 | 5000 | ⚠️ 仅省 19% |

**结论**：
- 即使 tier2 触发率高达 50%，本方案仍比工单方案节省 25% token
- 但如果 dreamer 每次都需要 tier2（`dreamerManifest.tier2 = ['pain.evidence']`），则 dreamer 环节无成本优势
- **关键 spike**：dreamer 是否必须看原始 pain.evidence？如果摘要（pain.rootSymptom）足够，则把 pain.evidence 移到 tier1，成本优势恢复

**注意**：以上数字是估算（基于 manifest.budget 和假设的工单方案 5000 token），非实测数据。工单方案的实际 token 成本需从 Linear 工单原文核实。

---

## 5. 与现有代码的契合

### 5.1 现有 bespoke 逻辑的演化（v2 修正）

| 现有代码 | 演化方向 |
|---------|---------|
| `resolveDreamerContext`（[artificer-runner.ts:175-283](file:///c:/Users/csuzn/.trae-cn/worktrees/principles/feat-review-linear-pri-511-513-fzZr81/packages/principles-core/src/runtime-v2/internalization/artificer-runner.ts)） | → 演化为 TL;DR 读取 + tier2 降级回溯（保留现有逻辑作为 tldr 失效时的 fallback） |
| `extractScribeArtifactId`（[evaluator-runner.ts:90-109](file:///c:/Users/csuzn/.trae-cn/worktrees/principles/feat-review-linear-pri-511-513-fzZr81/packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts)） | → 演化为 TL;DR 读取（保留现有逻辑作为 fallback） |
| `PIArtifactRecord.contentJson` | → 新增 `tldr` + `summary` 字段（向后兼容） |
| 5 个 prompt builder | → 接收 `EnrichedContext`（manifest 解析后），无需条件分支 |
| `PIArtifactStore.listLineage` | → 单跳，不递归；CandidateLineage 自己实现递归回溯 |

**v2 修正**：
- `extractScribeArtifactId` 实际查**两个**位置（[evaluator-runner.ts:90-109](file:///c:/Users/csuzn/.trae-cn/worktrees/principles/feat-review-linear-pri-511-513-fzZr81/packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts)）：(1) `sourceTrace.scribeArtifactId`，(2) 顶层 `sourceScribeArtifactId`（fallback）。演化时需保留此 fallback 逻辑
- `resolveDreamerContext` 是 110 行的复杂函数（含 rc-1/rc-2/rc-4/rc-5/rc-9 校验 + 7 种降级事件），不应直接删除，应保留为 tier2 降级路径

### 5.2 新增抽象

| 新增 | 替代 | 价值 |
|------|------|------|
| `ArtifactTldr` 字段 | CandidateLineage 普遍回溯 | 部分需求以更低成本满足（具体比例待实测） |
| `ContextManifest` | 5 个 runner 硬编码注入逻辑 | 声明式，可测试 |
| `PromptBudgetManager` | 无 | 硬预算保证不爆炸 + 截断事件可观察 |
| `ProgressiveEvaluator` | PRI-513 单阶段三段式 | 分层信息梯度，flagged 时才扩展 |
| `CandidateLineage`（收窄版） | 工单的 CandidateLineageGraph | 仅 tier2 应急通道，复杂度可控 |

### 5.3 架构合规

- **`antipattern-core-io` 不触发**：CandidateLineage 是纯逻辑，通过构造函数注入 `PIArtifactStore`，不 import fs/path（[io-seam-registry.json](file:///c:/Users/csuzn/.trae-cn/worktrees/principles/feat-review-linear-pri-511-513-fzZr81/packages/principles-core/io-seam-registry.json) 不需登记）
- **`rc-1` / `rc-2` 合规**：解析 contentJson 走 unknown + Object.hasOwn，无 `as` 旁路（现有 `resolveDreamerContext` 已示范）
- **`rc-9` 合规**：错误处理返回 Result 类型，不静默 fallback
- **architecture-regression.test.ts 不触发**：candidate-lineage.ts 是纯逻辑，不登记 io-seam-registry

---

## 6. 实施建议

### 6.1 重新划分三层级（替代 PRI-511/512/513）

| 原工单 | 重构后 | 内容 |
|--------|--------|------|
| PRI-511（CandidateLineage API） | **Layer 0: ArtifactTldr 写入时冗余** | writer 写入时生成 tldr + summary 字段，级联传递前驱 tldr |
| PRI-512（5 runner 注入） | **Layer 1: ContextManifest + BudgetManager** | 每个 runner 声明 manifest，BudgetManager 按优先级分配 |
| PRI-513（evaluator 三段式） | **Layer 2: 两阶段评估 + 按需 tier2 回溯** | Stage 1 摘要评估，Stage 2 仅在 flagged 时回溯 |

### 6.2 实施顺序

1. **Phase 0（Spike，v2 新增）**：验证 dreamer 是否必须看原始 pain.evidence
   - 用合成 baseline 跑 10 次 dreamer：5 次只给摘要，5 次给完整 evidence
   - 对比 candidate 质量（是否有"答非所问"）
   - 如果摘要足够 → pain.evidence 移到 tier2（仅 evaluator Stage 2 用）
   - 如果摘要不足 → dreamer 的 tier2 触发率 = 100%，需重新评估成本优势

2. **Phase 1（Layer 0）**：给 artifact writer 加 tldr + summary 字段
   - 改 5 个 runner 的 output schema（新增 tldr.self 字段）
   - 改 5 个 runner 的 writer 逻辑（写入时单跳读直接前驱 tldr，级联传递）
   - 向后兼容（旧 artifact 无 tldr 时回退到跨级回溯）
   - **必须注册 feature flag**（见 §6.4）
   - 测试：新 artifact 有 tldr，旧 artifact 回退正常，tldr 失效检测正常

3. **Phase 2（Layer 1）**：ContextManifest + BudgetManager
   - 定义 ContextManifest 接口
   - 5 个 runner 各声明 manifest
   - 实现 PromptBudgetManager（含截断事件 emit）
   - 测试：预算截断行为、优先级排序、截断事件 emit

4. **Phase 3（Layer 2）**：两阶段评估 + CandidateLineage 收窄版
   - 实现 CandidateLineage（仅 tier2 回溯，带 caching）
   - evaluator 改为两阶段（含 5% 随机强制 Stage 2）
   - 三段式校验形式化（compressionFidelity 契约）
   - output schema 向后兼容（intentConsistency 别名）
   - 测试：flagged 判据、Stage 2 触发、假阴性检测

### 6.3 必须先修正的工单文档问题

无论走哪条路径，必须先修正：

1. **修正工单编号交叉引用**：PRI-511/512/513 描述里的"PRI-510 作为层级1"全部改为"PRI-511 作为层级1"（代码核查证实 PRI-510 是 repair loop CLI 接线，非 CandidateLineage）
2. **修正 `sourceTrace` 字段位置描述**：从"artifact.sourceTrace"改为"artifact.contentJson 内的 sourceTrace（不可信，需 rc-1/rc-2 校验）+ artifact.lineageArtifactIds（可信但单跳）融合回溯"
3. **修正 artifact kind 假设**：明确"无 stage/kind by runner，需 sourceTaskId → task.taskKind 二跳"
4. **明确 PRI-508/PRD Decision 12 已完成**：PRI-512 应说明"artificer/evaluator 已有 bespoke 跨级注入，本工单是重构 + 扩展"
5. **明确 philosopher 是 MVP-Quiet**：PRI-512 注入规则表应剔除 philosopher 或说明理由

### 6.4 feature flag 注册（v2 修正：Layer 0 必须注册 flag）

**v2 关键修正**：原方案声称 Layer 0"可不需要 flag"，违反 ADR-0014 §5（"只能 revert 的必须带 flag 一起来"）。

理由：artifact 是可变的（upsert），Layer 0 改 writer 行为会污染所有新 artifact 的 contentJson。如果 tldr 写入有 bug，回滚只能靠 PR revert + 数据迁移。因此 Layer 0 **必须**带 flag。

| Layer | flag 名称 | default | 理由 |
|-------|----------|---------|------|
| Layer 0（写入时冗余） | `artifact_tldr_redundancy` | **on** | 改 writer 行为 + 污染 artifact contentJson + 可变 artifact 无回滚路径（ADR-0014 §5） |
| Layer 1（ContextManifest） | `context_manifest_budget` | **on** | 改 runner buildContext 行为，但可通过 flag 回退到旧逻辑 |
| Layer 2（两阶段评估） | `progressive_evaluator` | **off** (quiet) | 改变 evaluator 行为 + 新增 Stage 2 回溯 + 改 output schema |

**注册位置**：`.pd/config.yaml`（统一配置文件，ADR-0016）

### 6.5 BDD 影响评估

- Layer 0/1：不改行为契约（tldr/summary 是附加字段），`.feature` 保持不变
- Layer 2：改变 evaluator output schema（新增 painCoverage / compressionFidelity），需更新对应 `.feature` 并在 PR 说明

### 6.6 测试计划（v2 新增）

| 测试项 | 方法 | 验收标准 |
|--------|------|---------|
| dreamer 是否需要 pain.evidence | Spike：10 次合成 baseline，5 次摘要 / 5 次完整 | 摘要组 candidate 质量 ≥ 完整组的 80% |
| tldr 失效检测 | 单元测试：模拟前驱 artifact upsert | isTldrStale 返回 true，降级到 tier2 |
| 预算截断 | 单元测试：budget=100，字段总 cost=500 | 按优先级截断，emit context_truncated 事件 |
| flagged 判据 | 单元测试：missingDimensions=[] vs [x] | 前者不触发 Stage 2，后者触发 |
| 假阴性检测 | 集成测试：100 次 Stage 1 "全通过"，5 次强制 Stage 2 | Stage 2 发现新 concerns 的比例 < 5% |
| tier2 触发率 | Dogfood：50 次内化管道运行 | 记录实际触发率，与敏感性分析对比 |

---

## 7. 对比：工单方案 vs 本方案（v2 修正）

| 维度 | 工单方案（PRI-511/512/513） | 本方案（渐进式披露） |
|------|---------------------------|-------------------|
| 核心假设 | 信息越多越聪明 | 最小高信号集合最优 |
| 默认信息量 | 全量跨级 artifact | TL;DR + 结构化摘要 |
| 跨级回溯频率 | 每次 buildContext | 仅 flagged 时（频率待实测） |
| token 增量/runner | 估算 2000-8000（全量，待工单原文核实） | 500-1500（摘要）+ 按需 tier2 |
| AI 注意力 | 低（信息过载） | 高（只看相关字段） |
| 相关性排序 | 无 | manifest.priority 显式排序 |
| 预算管理 | 无 | PromptBudgetManager 硬截断 + 截断事件 |
| 多 candidate 处理 | 全注入（混乱） | TL;DR 摘要 + 按需详情 |
| 断链容错 | 复杂（运行时回溯失败） | 较简单（TL;DR 降级 + tier2 fallback） |
| LLM 判断质量 | 信息多但分散，易 lost in middle | 信息少但聚焦，关键时再扩 |
| 成本可控性 | 差（token 随 pain evidence 大小波动） | 较好（摘要固定成本 + 按需扩展，见 §4.8） |
| 借鉴业界趋势 | ❌ 违背 | ⚠️ 借鉴思路，但因 PD 是管道非 agent loop，适用性有限 |
| 与现有代码契合 | ❌ 多处事实偏差 | ✅ 现有 bespoke 逻辑保留为 fallback |

**v2 修正说明**：
- 工单方案的 "2000-8000 token" 是本方案作者估算，非工单原文声明。如需精确数字，需从 Linear 工单原文核实
- "借鉴业界趋势" 从 v1 的 "✅ 完全契合" 降级为 "⚠️ 借鉴思路，适用性有限"——因 PD 是管道非 agent loop，业界的 agent loop 经验不能直接套用
- 成本优势的成立前提见 §4.8 敏感性分析，关键依赖 dreamer 是否需要 pain.evidence 的 spike 结果

---

## 8. 风险与权衡

### 8.1 本方案的风险（v2 修正）

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| 跨级 TL;DR 级联传播衰减 | 🟠 中 | TL;DR ≤50 token + sourceArtifactUpdatedAt 失效检测 + tier2 降级（§4.7） |
| dreamer 可能必须看 pain.evidence，导致 tier2 触发率 = 100% | 🔴 高 | Phase 0 Spike 验证（§6.2）；如果成立，重新评估成本优势 |
| Stage 1 假阴性（摘要不足以判断） | 🟠 中 | 5% 随机强制 Stage 2 作为基线对照（§4.5.2） |
| artifact upsert 导致 tldr 过时 | 🟠 中 | sourceArtifactUpdatedAt 失效检测（§4.7） |
| manifest 参数（priority/budget）需手工调参 | 🟡 低 | 初始值由设计决定，dogfood 调优；schema 版本化 |
| Layer 0 污染 artifact contentJson | 🟠 中 | 必须注册 flag（§6.4），回滚时关闭 flag + PR revert |

### 8.2 工单方案的风险（本方案规避）

| 风险 | 工单方案 | 本方案 |
|------|---------|--------|
| 上下文爆炸 | 高（全量注入 8-15KB） | 较低（摘要 500-1500 token + 按需） |
| LLM 注意力分散 | 高（lost in middle） | 较低（聚焦相关字段） |
| 跨级回溯性能 | 高（无 caching，重复解析） | 较低（TL;DR 级联 + tier2 caching） |
| 断链容错 | 复杂 | 较简单（TL;DR 降级 + tier2 fallback） |

---

## 9. 待 Owner 决策

1. **是否采纳渐进式披露方案**（替代工单的全量注入方案）？
2. **是否走 ADR-0014 amendment 路径**（类似 2026-06-10/16/17 三个 amendment）？需提供 observed defect 证据，而非仅批评工单
3. **Phase 0 Spike 是否优先执行**（验证 dreamer 是否需要 pain.evidence）？这是方案成立的前提
4. **TL;DR 生成方式**：LLM 主输出顺带生成（推荐）vs 字段提取 vs 独立 LLM 调用？
5. **与 "Focus History 详细注入" MVP-Quiet 先例的关系**：本方案的 TL;DR 写入时冗余是否触发该先例？需 Owner 判断

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

---

## 11. 自检评审修正日志（v2 新增）

本章节记录 v1 → v2 的修正，确保方案诚实性和可追溯性。

### 11.1 修正的致命问题

| # | v1 问题 | 严重度 | v2 修正 |
|---|---------|--------|---------|
| 1 | TL;DR "零成本" 假设是假的——scribe 无法从直接输入提取 pain.tldr（philosopher artifact 无 pain 字段） | 🔴 | §4.1 重写：区分自身 tldr（LLM 顺带生成）vs 跨级 tldr（级联传播，单跳 I/O 成本）；诚实声明非零成本 |
| 2 | "90%" 是无依据数字，且与 dreamer manifest 的 tier2=['pain.evidence'] 矛盾 | 🔴 | 全文删除 "90%/10%"，替换为"待实测"；新增 §4.8 敏感性分析；标注 dreamer tier2 为"待验证假设"；新增 Phase 0 Spike |
| 3 | Layer 0 不用 flag 违反 ADR-0014 §5（artifact 可变 + 污染 + 无回滚路径） | 🔴 | §6.4 修正：Layer 0 必须注册 flag `artifact_tldr_redundancy`（default on） |

### 11.2 修正的中等问题

| # | v1 问题 | 严重度 | v2 修正 |
|---|---------|--------|---------|
| 4 | flagged 判据未形式化 | 🟠 | §4.5.2 形式化：`missingDimensions.length > 0 \|\| !painCoverage.fullyCovered \|\| implementationFidelity.score < 0.7` |
| 5 | artifact 可变性盲点（upsert 导致 tldr 过时） | 🟠 | 新增 §4.7：sourceArtifactUpdatedAt 失效检测 + tier2 降级 |
| 6 | intentConsistency 引用位置错误（说在 artificer-prompt-builder.ts:12，实际在 evaluator-runner.ts:68 + evaluator-output.ts:40） | 🟠 | §4.6.2 修正引用位置 |
| 7 | extractScribeArtifactId 描述不完整（遗漏 sourceScribeArtifactId fallback） | 🟡 | §5.1 补充 fallback 逻辑描述 |

### 11.3 v2 新增的内容

- §2.3：PD 特殊性下的适用性边界声明
- §4.1.3：级联传播衰减风险与缓解
- §4.2.3：manifest 参数确定方法
- §4.3：PromptBudgetManager 截断事件 emit（可观察性）
- §4.5.2：5% 随机强制 Stage 2 假阴性缓解
- §4.7：artifact 可变性与 TL;DR 一致性
- §4.8：tier2 触发率敏感性分析
- §6.2：Phase 0 Spike
- §6.4：Layer 0 flag 注册（修正 v1 错误）
- §6.6：测试计划
- §9：新增待 Owner 决策项（Spike 优先级 + Focus History 先例关系）
- §11：本修正日志

### 11.4 仍需 Owner 判断的开放问题

1. **dreamer 是否必须看 pain.evidence**：这是方案成本优势的关键前提，需 Phase 0 Spike 验证
2. **与 Focus History MVP-Quiet 先例的关系**：TL;DR 写入时冗余本质是"让 prompt 更聪明"，是否触发 ADR-0014 §2.5 的先例
3. **级联传播衰减是否可接受**：pain 信息经过 3 级摘要到达 scribe，是否失真到不可用
