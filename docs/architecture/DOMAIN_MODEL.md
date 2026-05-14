# PD 核心领域模型与通用语言 (Ubiquitous Language)

> **文档状态**: 强制执行 (LOCKED-ONTOLOGY)
> **最后更新**: 2026-05-03
> **背景**: 本文档是对 `docs/architecture-governance/PRINCIPLE-TREE-ARCHITECTURE.md` 的具象化与工程化约定，旨在消除日常开发中的语义分裂，并为后续 Runtime V2、Principle Lifecycle、RuleHost、Pruning 等重构提供统一领域语言。

---

## 0. 设计目标

PD 的管理核心不是“规则库”，而是 **Principle-led evolution**：系统从 Pain 中提炼高泛化 Principle，再将 Principle 逐步转译成更可验证、更可执行、更低上下文成本的 Rule 与 Implementation。

本文档用于约束：

- 代码命名、接口命名、文件命名
- Linear issue 与 milestone 描述
- PR / review 中的架构判断
- Runtime V2 输出 schema 与 prompt taxonomy
- 后续 core / SDK / CLI / plugin 边界重构

任何新增术语如果会替代或混淆本文术语，必须先更新本文档，再进入代码实现。

---

## 1. Principle 与 Rule 的光谱模型

`Principle` 与 `Rule` 不是互相替代的对象，而是同一条知识内化光谱的两端。

```text
Principle  <------------------------------------------>  Rule
高泛化                                                  高实操
低可测试                                                高可测试
Why / What                                             When / Where / How
适合注入 Prompt / Skill / SOP                          适合绑定工具、场景、Hook、测试
跨场景复用                                              场景特化
价值观 / 架构判断 / 管理核心                            可验证契约 / 执行边界 / 操作规则
```

### 1.1 Principle 是管理核心

**Principle** 是 PD 项目的最高层管理对象。它是高度抽象、跨场景、可泛化的经验或价值判断，用来说明“为什么要这样做”和“在大方向上应该避免什么”。

Principle 的实操性天然较弱，因此它不应该直接承担所有自动化拦截、测试、执行或模型训练职责。它负责提供方向、约束和优先级。

### 1.2 Rule 是 Principle 的具象化投影

**Rule** 是 Principle 在具体上下文中的可验证表达。它把 Principle 绑定到明确场景、问题、工具、Skill、SOP 或 workflow 上，从而提升实操性。

一个 Rule 必须回答：

- 它对应哪个 Principle？
- 它面向什么场景？
- 它解决什么问题？
- 它绑定哪些工具、Skill、SOP 或 workflow？
- 它如何被测试、验证或观测？
- 它触发后是 log、warn、requireApproval 还是 block？

Rule 的泛化性弱于 Principle，但可测试性与可执行性更强。

---

## 2. 核心三层进化模型

在 PD 系统中，知识的内化遵循：

```text
Pain Signal -> Diagnosis -> Recommendation -> Principle -> Rule -> Implementation
```

其中 `Principle -> Rule -> Implementation` 是 Principle Tree 的主干结构。

### 2.1 Principle - 树根

- **英文名**: `Principle` / `LedgerPrinciple`
- **语义定义**: 高维智慧、价值观、架构判断、管理核心。
- **数据载体**: 自然语言为主，可被注入 Prompt、Skill、SOP 或文档。
- **主要职责**:
  - 描述系统应该遵循的抽象方向
  - 聚合多个场景下反复出现的经验
  - 为 Rule 和 Implementation 提供战略父节点
  - 支撑 pruning / lifecycle review 的价值判断
- **示例**: `P_001` - “保持代码库的原子性，不要混合多个任务的修改。”
- **代码映射**:
  - `packages/openclaw-plugin/src/types/principle-tree-schema.ts` 中的 `Principle`
  - `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` 中的 `LedgerPrinciple`

### 2.2 Principle 的类别与层级

Principle 必须具备层级感。后续命名和 issue 描述应优先使用以下分类：

| 类型 | 含义 | 示例 |
| --- | --- | --- |
| `Core Principle` | 跨项目、跨工具、跨场景的核心原则，类似系统宪法 | “不要在未知状态下执行破坏性操作” |
| `Domain Principle` | 面向某个业务域或工程域的原则 | “Runtime V2 的写侧入口必须由 core 拥有” |
| `Scenario Principle` | 面向具体 workflow、工具、SOP 的原则 | “执行 pruning 前必须先生成 explain evidence” |

现有代码中可映射到：

- `PrincipleScope = 'general' | 'domain'`
- `domain?: string`
- `priority: 'P0' | 'P1' | 'P2'`
- `conflictsWithPrincipleIds`
- `supersedesPrincipleId`
- `ruleIds`

后续如需表达父子层级，优先新增显式关系字段，而不是发明 `Law`、`Guideline`、`Doctrine` 等新实体。

### 2.3 Rule - 树干

- **英文名**: `Rule` / `LedgerRule`
- **语义定义**: Principle 在特定边界下的契约化表达，是可验证、可测试、可观测的行为约束。
- **数据载体**: 结构化元数据。至少包含 parent principle、trigger、context binding、validation、enforcement。
- **关系约束**: 一个 Principle 可以衍生多个 Rules；一个 Rule 必须归属于一个 Principle。
- **代码映射**:
  - `packages/openclaw-plugin/src/types/principle-tree-schema.ts` 中的 `Rule`
  - `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` 中的 `LedgerRule`

Rule 不等于 Implementation。Rule 是“契约”，Implementation 是“承载这个契约的具体机制”。

### 2.4 Rule Context Binding

Rule 必须绑定上下文，否则无法测试与执行。后续 Rule 模型和 issue 描述应尽量包含：

| 绑定维度 | 含义 | 示例 |
| --- | --- | --- |
| `principleId` | 父 Principle | `P_runtime_v2_boundary` |
| `scenario` | 适用场景 | `runtime-v2-pain-record` |
| `problem` | 解决的问题类型 | `architecture-regression` |
| `tool` | 相关工具 | `apply_patch`, `git`, `pd-cli` |
| `skill` | 相关 Skill | `tdd`, `gsd-execute-phase` |
| `sop` / `workflow` | 相关流程 | `PR review`, `UAT`, `pruning review` |
| `triggerCondition` | 触发条件 | “plugin imports createPainSignalBridge” |
| `validationSpec` | 如何验证 | “architecture-regression.test fails” |
| `enforcement` | 触发后动作 | `log`, `warn`, `requireApproval`, `block` |

现有 `RuleType` 可承载多种路线：

- `hook`
- `gate`
- `skill`
- `lora`
- `test`
- `prompt`

### 2.5 Implementation - 树叶

- **英文名**: `Implementation`
- **语义定义**: Rule 的具体承载物，可以是代码、Prompt、Skill、Hook、Tool、Test、LoRA 等。
- **关系约束**: 一个 Rule 可以有多个 Implementation 候选；同一 Rule 同一时间最多一个 `active` Implementation。
- **代码映射**:
  - `packages/openclaw-plugin/src/types/principle-tree-schema.ts` 中的 `Implementation`
  - `packages/openclaw-plugin/src/core/code-implementation-storage.ts`
  - `packages/openclaw-plugin/src/core/rule-host.ts`
  - `packages/openclaw-plugin/src/core/rule-host-types.ts`

避免把 `Implementation` 简化为 “JS 代码”。代码只是 Implementation 的一种类型。

---

## 3. 三类内化路线

Principle 可以通过不同路线影响系统行为。**本节与 [PD_System_Dynamics_Model.md](./PD_System_Dynamics_Model.md) Section 4 保持术语一致，使用 L1/L2/L3 编号作为 canonical 别名。**

### 3.1 L1: Prompt / Skill / SOP 内化（软内化）

- **L1 别名**：软内化
- **目标**: 影响 LLM 的思考方式、注意事项、流程习惯。
- **载体**:
  - system prompt
  - Skill 文档
  - SOP / runbook
  - prompt injection context
- **适合对象**:
  - 高抽象 Principle
  - 难以确定性测试但值得提醒的经验
  - 需要人类或 LLM 判断的流程约束
- **风险**:
  - 上下文成本高
  - 遵循不稳定
  - 难以证明生效

### 3.2 L2: Code / Hook / Tool 内化（硬内化）

- **L2 别名**：硬内化
- **目标**: 通过确定性逻辑影响或拦截 agent 行为。
- **载体**:
  - RuleHost implementation
  - OpenClaw hook
  - custom tool
  - CLI guard
  - test / architecture regression guard
- **适合对象**:
  - 可检测、可验证、可重复触发的 Rule
  - 高风险路径
  - 已有足够 evidence 的流程约束
- **风险**:
  - 误拦截
  - 与真实 workflow 不匹配
  - 需要回滚和 shadow/probation

### 3.3 L3: Model Parameter / LoRA 内化（模型参数化）

- **L3 别名**：模型参数化
- **目标**: 通过模型参数或偏好学习改变默认行为倾向。
- **载体**:
  - LoRA
  - fine-tuned checkpoint
  - preference model
  - classifier / reranker
- **适合对象**:
  - 大量样本支持的行为模式
  - Prompt 成本过高但 deterministic rule 又不适合的软行为
- **风险**:
  - 可解释性弱
  - 回滚与评估成本高
  - 需要严格 eval 和 shadow validation

---

## 4. 系统动力学与流量词汇

- **Pain / Pain Signal**: Agent 在执行任务时遭遇的具体挫败，例如报错、超时、人类负面反馈。它是进化的原始输入流量。
- **Diagnosis**: 寻找 Pain 根因的分析过程。
- **Recommendation**: Diagnostician 输出的建议项。合法 `kind` 包括 `principle`、`rule`、`implementation`、`prompt`、`defer`。
- **Taxonomy**: 将 Recommendation 正确分类为 principle/rule/implementation/prompt/defer 的动作。分类精度决定软硬转换效率。
- **Internalization**: 将 Principle 通过 Prompt、Code、Model 等路线转化为更低上下文成本、更稳定的行为约束。
- **Pruning Signal**: 系统发现某个 Principle 可能可降级、隐藏、归档或需要复审的只读信号。
- **Pruning Review**: 人类或 operator 对 Pruning Signal 的审计记录。当前通过 `.state/pruning_reviews.jsonl` 记录。
- **Pruning Action**: 未来真正改变 Principle/Rule/Implementation 生命周期或 Prompt 注入状态的动作。它必须另开 issue，并需要 dry-run、人类确认、rollback plan。

严禁把 `Pruning Review` 当成 `Pruning Action`。当前 `archive-candidate` 只是审计意图，不是实际归档动作。

---

## 5. 状态机规范

状态必须绑定具体 aggregate。不要跨对象复用同一个词导致误解。

### 5.1 Principle / Rule / Implementation 生命周期

| 状态 | 含义 |
| --- | --- |
| `candidate` | 新生成，尚未通过充分验证 |
| `probation` | 试用/影子模式，通过基础校验但不强拦截 |
| `active` | 正式生效，参与 prompt、规则执行或模型行为 |
| `archived` | 因历史原因保留，但不参与运算 |
| `deprecated` | 被更优对象替代，正式退出主路径 |

### 5.2 Runtime V2 Candidate Intake 状态

Runtime V2 的 `principle_candidates` 表可使用 `pending`、`consumed` 等 intake 状态。这些状态只描述 candidate ingestion，不是 Principle/Rule/Implementation 的生命周期状态。

因此“严禁 pending”只适用于 Principle Tree lifecycle 命名，不适用于数据库 intake 阶段。

### 5.3 Pruning Review 状态

Pruning Review 是 append-only audit log，不改变实体生命周期。当前合法 decision：

- `keep`
- `defer`
- `archive-candidate`

这些 decision 不是实体状态，不得直接解释为 ledger mutation。

---

## 6. 当前代码映射

| 领域概念 | 当前主要位置 | 目标位置 | 迁移状态 | 说明 |
| --- | --- | --- | --- | --- |
| Pain Signal | `packages/principles-core/src/runtime-v2/pain-to-principle-service.ts` | - | ✅ Done (ADR-0001) | Runtime V2 写侧统一入口 |
| Pain Chain Read Model | `packages/principles-core/src/runtime-v2/pain-chain-read-model.ts` | - | ✅ Done (ADR-0001) | pain -> task -> run -> candidate -> ledger 读侧 |
| Principle Schema | `packages/principles-core/src/runtime-v2/types/principle-schema.ts` | `@principles/core` | ✅ Done | 已迁移至 `@principles/core/runtime-v2` |
| LedgerPrinciple | `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` | `@principles/core` | ✅ Done | 已迁移至 `packages/principles-core/src/principle-tree-ledger.ts` |
| Rule / LedgerRule | `packages/principles-core/src/runtime-v2/types/principle-schema.ts` | `@principles/core` | ✅ Done | 已迁移至 `@principles/core/runtime-v2` |
| Implementation Schema | `packages/principles-core/src/runtime-v2/types/principle-schema.ts` | `@principles/core` | ✅ Done | 已迁移至 `@principles/core/runtime-v2` |
| Evolution Types | `packages/principles-core/src/runtime-v2/evolution/evolution-types.ts` | `@principles/core` | ✅ Done | 已迁移至 `@principles/core/runtime-v2/evolution` |
| Nocturnal Trinity Types | `packages/principles-core/src/runtime-v2/nocturnal/nocturnal-trinity-types.ts` | `@principles/core` | ✅ Done | 已迁移至 `@principles/core/runtime-v2/nocturnal` |
| Event Types | `packages/principles-core/src/runtime-v2/types/event-types.ts` | `@principles/core` | ✅ Done | 已迁移至 `@principles/core/runtime-v2/types` |
| Principle Tree Data Structures | `packages/principles-core/src/runtime-v2/types/` | `@principles/core` | ✅ Done | 已迁移（PrincipleDependency、PrincipleValueMetrics、PrincipleLifecycleEvent、PrincipleTreeStore） |
| Code Implementation Asset | `packages/openclaw-plugin/src/core/code-implementation-storage.ts` | - | 🔒 Keep in plugin | 文件系统操作保留在 plugin |
| RuleHost | `packages/openclaw-plugin/src/core/rule-host.ts` | `@principles/core` | ⏳ Pending (ADR-0002) | PRI-45 拆分中 |
| RuleHostInput/Result | `packages/openclaw-plugin/src/core/rule-host-types.ts` | `@principles/core` | ✅ Done (PRI-42) | 已迁移至 `internalization/rule-host-contracts.ts` |
| RuleHost Helpers | `packages/openclaw-plugin/src/core/rule-host-helpers.ts` | `@principles/core` | ✅ Done (PRI-42) | 已迁移 |
| Lifecycle Metrics | `packages/openclaw-plugin/src/core/principle-internalization/lifecycle-metrics.ts` | `@principles/core` | ✅ Done (PRI-42) | 已迁移至 `internalization/` |
| Routing Policy | `packages/openclaw-plugin/src/core/principle-internalization/internalization-routing-policy.ts` | `@principles/core` | ✅ Done (PRI-43) | 已迁移至 `internalization/routing-policy.ts` |
| Template Generator | `packages/openclaw-plugin/src/core/principle-compiler/template-generator.ts` | `@principles/core` | ✅ Done | 已迁移至 `runtime-v2/internalization/template-generator.ts` |
| Pruning Signal | `packages/principles-core/src/runtime-v2/pruning-read-model.ts` | - | ✅ Done | non-destructive read model |
| Pruning Review | `packages/principles-core/src/runtime-v2/pruning-review-log.ts` | - | ✅ Done | append-only audit log |
| Diagnostician Recommendation | `packages/principles-core/src/runtime-v2/diagnostician-output.ts` | - | ✅ Done | recommendation taxonomy schema |

**迁移状态说明**:
- ✅ Done: 已完成迁移
- ⏳ Pending: 迁移计划中（见 ADR-0002）
- 🔒 Keep in plugin: 保留在 plugin（基础设施绑定）

---

**相关 ADR**:
- [ADR-0001: Runtime V2 Service Boundaries](../adr/0001-runtime-v2-service-boundaries.md)
- [ADR-0002: Hard Internalization Core Boundary](../adr/0002-hard-internalization-core-boundary.md)

---

## 7. 后续重构方向

本文档不要求一次性迁移所有代码。推荐顺序：

1. 先让本文档成为 LOCKED ontology，并在 ADR/ARCHITECTURE/Linear 模板中引用。
2. 在 architecture regression test 中保护本文档存在，并防止新增非标准术语绕开 ontology。
3. 将 Principle/Rule/Implementation 的 canonical type 逐步迁入 `@principles/core` 或明确由 core re-export。
4. 将 RuleHost / Lifecycle read model 的领域逻辑与 OpenClaw adapter 边界拆清楚。
5. 对 Prompt、Code、Model 三类 internalization route 分别建立 read model、review workflow 与 activation guard。

---

## 8. 命名禁区

除非先更新本文档，否则不要新增下列替代词作为核心领域实体：

- `Law`
- `Guideline`
- `Doctrine`
- `ConstraintCode`
- `PolicyRule`（除非明确是 Rule 的子类型）
- `WisdomItem`
- `MemoryRule`
- `PendingPrinciple`（请严格区分是业务生命周期的 `candidate` 还是数据摄入阶段的 `pending` 状态，见 5.2 节）

如果只是 UI 文案或外部说明可以使用自然语言同义词，但代码、schema、Linear issue title 和 ADR 必须使用本文标准术语。

---

> **架构师批注**:
> Principle 是 PD 的管理核心；Rule 是 Principle 的实操化投影；Implementation 是 Rule 的行为承载物。后续所有重构都应减少这三者之间的语义混淆，而不是新增一套平行概念。
