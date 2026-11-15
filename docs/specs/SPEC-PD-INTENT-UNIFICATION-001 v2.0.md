# SPEC-PD-INTENT-UNIFICATION-001
# Intent Engineering 一体化与战略意图锚定升级

| 属性 | 内容 |
|---|---|
| SPEC ID | SPEC-PD-INTENT-UNIFICATION-001 |
| 版本 | v2.0 |
| 状态 | Proposed — 待实施 |
| 优先级 | P0 |
| 项目 | Principles Disciple |
| 源码基线 | main / 8ad7b7924a5edb2231486ef0ed99c2462ad78318 |
| 核心模块 | Intent Engineering / Strategic Intent Anchoring |
| 核心原则 | 单一开关、双锚点、上游影响、长期行为改善、最大化复用 |

---

# 1. 项目目标与 Owner 意图

## 1.1 核心目标

让 Owner 只需维护一份长期战略意图，PD 就能够在 Agent 的长期运行过程中持续理解这一意图，并将它作为关键决策、Pain 诊断、原则形成和原则激活的上游依据。

最终让 Owner 的长期目标真正转化为 Agent 可持续改善的行为。

这不是一个独立的 Intent 管理系统建设项目，而是 PD 现有 Intent Engineering 与 Strategic Intent Anchoring 的一体化产品升级。

## 1.2 核心问题

当前 Agent 系统擅长执行局部任务：

- 完成一个 PR。
- 修复一个 Bug。
- 实现一个功能。
- 优化一个架构。
- 完成一次交付。

但局部任务完成，并不意味着 Agent 的长期行为符合 Owner 的方向。

Agent 可能：
- 完成任务，却偏离真正的产品目标。
- 解决眼前问题，却牺牲长期质量。
- 追求局部效率，却损害用户信任。
- 在上下文压缩后丢失长期目标。
- 不断修复相似问题，却没有形成真正有效的行为原则。

PD 需要解决的是：

**如何把 Owner 的长期战略方向转化为 Agent 可以持续学习、执行、检查和修正的行为原则。**

## 1.3 五个产品设计原则

1. **长期性**：Intent 是长期战略方向，不是单次任务目标。
2. **双锚点**：Owner Strategic Intent 与系统内置的十个 Core Principles 共同参与原则形成，不能通过牺牲其中一个来换取表面一致。
3. **情境参与**：普通任务自然执行，关键决策才需要显性参考 Intent。
4. **Owner 主权**：Agent 可以质疑、分析和建议，但不能擅自修改 Intent 或替 Owner 做重大决策。
5. **行为落地**：最终通过已有 Principle、IntentContract、Artificer、Evaluator、RuleCode 和 Activation 机制影响宿主，而不是停留在 Prompt 注入。

## 1.4 本次不解决的问题

本次不开发：

- 独立的战略规划产品。
- 新的任务管理系统。
- 新的 Intent Dashboard。
- 新的 Agent Memory 系统。
- 新的战略决策引擎。
- 新的原则生成阶段。
- 新的 RuleHost 执行框架。
- 新的模型实验平台。
- 自动修改 Owner Intent 的 Agent。

不要求在开发之前进行大模型 A/B 实验或建立新的行为评估数据集。

先完成核心功能和正式用户入口，再利用真实运行记录与 Owner 反馈逐步改进。

---

# 2. 核心概念与权威关系

## 2.1 Intent 的定义

Intent 是 Owner 对项目或组织的长期目标、价值偏好、战略方向和不可妥协边界的表达。

Intent 不是：

- PRD。
- 任务列表。
- 当前迭代计划。
- Agent 的执行指令集合。
- RuleCode。
- 不可质疑的永久教条。

Intent 的职责是帮助 Agent 判断：

- 当前任务为什么值得做？
- 当前方案是否服务于长期目标？
- 有没有局部最优损害整体目标？
- 是否存在值得提醒 Owner 的战略张力？
- 是否已经触及必须停止或升级的边界？

## 2.2 双锚点关系

本次必须保持两个锚点共同参与：

| 锚点 | 职责 |
|---|---|
| Core Principles（T-01 至 T-10） | 系统长期稳定的基础行为原则和价值边界 |
| Owner Strategic Intent | Owner 当前项目或组织的长期战略方向和取舍 |

两者共同参与新原则的形成。

必须遵守：

1. Owner Intent 不能覆盖或废除 Core Principles。
2. Core Principles 不能成为忽略 Owner 战略方向的借口。
3. 新原则需要同时考虑两个锚点。
4. 两个锚点存在真实冲突时，必须显式暴露。
5. 不允许模型通过重新解释其中一个锚点来制造虚假的一致。
6. 不能满足两个锚点的候选原则，必须经过重新推敲，不能直接晋级。

当前 Dreamer、Philosopher、Scribe 已经通过 `coreGrounding: true` 使用 Core Axioms，不需要增加新的核心原则注入开关。

## 2.3 决策权威

以下优先关系必须保持：

1. 平台安全、系统级安全约束和权限边界。
2. Core Principles。
3. Owner 的战略意图与明确授权边界。
4. 基于真实 Pain 的行为纠正要求。
5. 当前具体任务目标和执行策略。

其中 Core Principles 与 Owner Intent 是原则形成中的双锚点，不允许相互替代。

任务目标必须在上述约束内执行。

## 2.4 五个 Intent 章节的职责

沿用现有五章节，不增加字段。

| 章节 | 战略职责 | 在原则形成中的作用 |
|---|---|---|
| Why | 长期价值和存在理由 | 判断纠正方向是否服务于真正目标 |
| Desired Outcome | 希望实现的结果 | 将抽象目标转化为可观察结果 |
| Non-negotiables | 不可妥协的边界 | 识别不能为了局部收益而牺牲的条件 |
| Stop / Escalation | 停止与升级条件 | 判断何时需要停止、询问或交给 Owner |
| Current Strategic Focus | 当前阶段的重点取舍 | 避免原则优化方向与当前战略重点脱节 |

特别说明：

`Non-negotiables` 和 `Stop / Escalation` 的文字本身不是自动执行的 RuleCode。

现有中文模板已经明确说明 Stop / Escalation 属于软升级条件，除非另行编码进 RuleHost，否则不构成硬拦截。

本次必须保留这个真实边界。

战略意图可以成为原则形成和审批的强约束依据；要在宿主执行时形成确定性的硬拦截，仍然需要通过现有 Principle 和 RuleCode 机制实现。

---

# 3. 当前源码现状与改造判断

## 3.1 已有能力：保留，不重复开发

| 模块 | 当前实现 | 处理 |
|---|---|---|
| Feature Flag | `intent_engineering` | 唯一开关 |
| Intent 文档 | INTENT.zh-CN.md / INTENT.en.md | 保留 |
| 五章节解析 | `parseIntentDocSections()` | 保留 |
| 文档校验 | `validateIntentDocSections()` | 扩展 |
| 文件读取 | `safeReadIntentDoc()` | 复用并补充内容过滤 |
| Prompt 注入 | `buildIntentFrictionBlock()` | 保留并完善 |
| Stage A 关联分析 | `DiagRootCauseRunner` | 保留 |
| IntentSnapshot | `intent-snapshot.ts` | 保留 |
| Snapshot CAS | `updateTaskIfDiagnosticJsonUnchanged()` | 保留 |
| Stage C 透传 | `DiagRouterRunner` | 保留 |
| Dreamer 双锚点 | `dreamer-prompt-builder.ts` | 保留 |
| Philosopher 双锚点 | `philosopher-prompt-builder.ts` | 保留 |
| Scribe 双锚点 | `scribe-prompt-builder.ts` | 保留并加强行为契约 |
| IntentContract V1 | `intent-contract.ts` | 五字段保持不变 |
| IntentContract V2 | `assembleIntentContractV2()` | 保留 |
| Owner Decision | `intent_decisions` | 保留 |
| Approval Gate | `strategic-conflict-gate.ts` | 优化冲突判定 |
| Intent UI | `IntentPage.tsx` | 升级 |
| 版本历史 | `IntentDocVersionStore` | 保留 |

## 3.2 已确认的实际缺口

### 缺口 A：模板内容会被误认为真实战略意图

现有：

`buildIntentSnapshot()` 使用 `parseIntentDocSections()`。

只要章节内容非空，就会被记录进 Snapshot。

但中文模板中本身包含：

- 为什么这个项目重要？
- 什么结果能说明更接近目标？
- 哪些东西不能被牺牲？

这些内容虽然非空，却不是 Owner 真正填写的意图。

同时，OpenClaw Prompt Hook 将原始 INTENT.md 直接传入 `buildIntentFrictionBlock()`。

因此，模板内容也可能进入 Agent 上下文。

这是 P0 问题。

### 缺口 B：Scribe 的战略内容可能没有充分传递到行为契约

现有 Scribe 能够生成 V2，并通过服务端计算战略关联。

但是：

Artificer 和 Evaluator 当前的 Prompt Builder 消费的是 `IntentContractV1`。

Artificer 使用：

- ownerIntent
- targetBehavior
- forbiddenBehavior
- validationExpectation

Evaluator 使用 V1 契约进行 intentConsistency 和行为范围判断。

它们没有直接消费 V2 的 `strategicIntent`、`strategicAssessment`。

因此：

**V2 的战略关联记录本身并不等于宿主已经获得了战略行为约束。**

必须保证 Scribe 把相关的 Owner Intent 真正转化为 Principle Statement 和 V1 行为契约。

### 缺口 C：当前冲突门禁过于粗粒度

现有 `StrategicConflictGate`：

- V1 兼容。
- 不完整 V2 硬拒绝。
- potential 放行。
- confirmed 要求 Owner Decision。
- 决策绑定 candidateId、intentDocHash 和 contractDigest。

这套机制已经实现，但目前对所有 confirmed 冲突使用统一的阻断和解决规则。

它没有充分区分：

- 普通战略取舍。
- Non-negotiables 违反。
- Stop/Escalation 边界违反。
- Core Principle 冲突。

这与本次确认的产品语义不完全一致，需要定向调整。

### 缺口 D：Host 接入不完整

已经确认：

- OpenClaw Pain Hook：传入 IntentDocReader。
- OpenClaw Pain Command：传入 IntentDocReader。
- PD CLI Pain Record：构造 `PainToPrincipleService` 时未传入 Reader。
- PD CLI Diagnose：构造 Stage A Runner 时未传入 Reader。
- PD CLI Pain Retry：构造 Stage A Runner 时未传入 Reader。
- Host Runtime Governance Signal Admission：构造 Service 时未传入 Reader。

因此，不能认为所有生产 Pain 入口都已经具备战略快照能力。

### 缺口 E：UI 和实际能力脱节

现有 IntentPage 已经具备：

- 唯一 Flag 状态展示。
- 启用按钮。
- 五章节展示。
- 编辑。
- Warning。
- 决策统计。
- 版本历史。

但存在：

1. 只能从 UI 开启，不能对称关闭。
2. 缺少内容是否真正可用的状态。
3. 模板占位文字没有被识别。
4. 首次 Onboarding 必须填写每个章节才能进入下一步。
5. 用户无法理解 Intent 如何进入 Principle Formation。
6. 当前 UI 没有明确解释 Intent 与 RuleCode 的关系。

---

# 4. 核心目标架构

本次不新增任何原则形成阶段。

沿用现有管道：

```text
Owner Strategic Intent
          |
          v
      INTENT.md
          |
          v
    Intent Engineering
          |
          +-------------------+
          |                   |
          v                   v
   Prompt Context        Pain Diagnosis
    (已有 Host)               |
                              v
                     Stage A IntentSnapshot
                              |
                              v
                       Stage B / C
                              |
                              v
                           Dreamer
                              |
                              v
                         Philosopher
                              |
                              v
                            Scribe
                              |
                 +------------+------------+
                 |                         |
                 v                         v
          Principle Statement       IntentContract V1
                 |                         |
                 +------------+------------+
                              |
                              v
                     IntentContract V2
                     (战略追溯和审批)
                              |
                              v
                       Owner Approval
                              |
                              v
                       Principle
                       Activation
                              |
                 +------------+------------+
                 |                         |
                 v                         v
            Prompt Channel            RuleCode Channel
                 |                         |
                 v                         v
          Principle Context          Artificer
                                           |
                                           v
                                        Evaluator
                                           |
                                           v
                                      RuleCode
                                           |
                                           v
                                      RuleHost
                                           |
                                           v
                                  Long-term Behavior
```

需要特别区分：

- IntentSnapshot：固定本次原则形成所依据的 Owner Intent。
- IntentContract V2：记录战略关联、冲突和可追溯身份。
- IntentContract V1：将 Pain 和 Owner 要求转化为下游可以使用的行为契约。
- Principle Statement：真正进入现有原则激活体系的行为表达。
- RuleCode：在支持代码规则的渠道中实现可执行行为约束。

V2 不替代 V1，也不直接替代 RuleCode。

---

# 5. 各阶段的职责与行为要求

## 5.1 Stage A：战略关联唯一判断点

继续使用：

`DiagRootCauseRunner`

职责：

1. 读取本次有效 Intent 内容。
2. 判断 Pain 与 Intent 是否相关。
3. 判断行为是否偏离 Intent。
4. 识别 Intent 本身是否可能过时、模糊或矛盾。
5. 提供相关章节和证据。
6. 生成不可变 Snapshot。

继续使用现有 `IntentTensionSource`：

| 值 | 含义 |
|---|---|
| none | 没有发现明显张力 |
| action_drift | 行为可能偏离 Owner Intent |
| intent_suspect | Intent 本身可能过时、模糊或矛盾 |
| healthy_tension | 存在真实战略取舍，但不代表行为偏离 |

不得把 `healthy_tension` 当作违规。

继续使用四态 Strategic Relevance：

| 值 | 含义 |
|---|---|
| relevant | 与 Owner Intent 有明确关联 |
| not_applicable | 当前 Pain 与战略意图无关 |
| insufficient_evidence | 证据不足 |
| not_configured | 没有可用的战略意图 |

`intentTension.source` 与 `strategicAssessment.relevance` 是两个不同概念，不得合并。

Stage A 是战略关联判断的唯一权威阶段。

后续阶段不能重新读取最新 INTENT.md 并改变本次判断。

## 5.2 Dreamer：多候选战略推演

继续使用：

`dreamer-prompt-builder.ts`

Dreamer 必须同时考虑：

- Stage A 的 IntentSnapshot。
- Stage A 的 IntentTension。
- Core Axioms。

现有 `strategicPerspective` 字段继续承担战略视角。

要求：

- 当 Intent 与候选相关时，明确指出相关章节。
- 说明候选如何服务于长期目标。
- 不得为了短期修复牺牲核心原则。
- 不得把无关 Intent 强行套用到候选。
- 如果两个锚点存在冲突，必须如实说明。
- 不得重新判定 Stage A 的 relevance。

不新增 StrategicProposalAssessment。

## 5.3 Philosopher：双锚点批判和收敛

继续复用：

`PhilosopherRunner.buildContext()`

当前已经能够从 Dreamer 的依赖链中解析 Stage A Diagnosis Artifact。

继续使用：

`philosopher-prompt-builder.ts`

职责：

1. 审查 Dreamer 候选是否真正解决 Pain。
2. 检查候选是否符合 Owner Strategic Intent。
3. 检查候选是否符合 Core Axioms。
4. 识别候选是否以局部收益牺牲长期目标。
5. 识别 Intent 是否存在需要 Owner 重新审视的情况。
6. 保留真实的战略张力。

特别要求：

如果某个候选只能通过违反 Core Principle 来满足 Owner Intent，必须暴露冲突，而不是替 Owner 或模型选择牺牲其中一个锚点。

不新增 Philosopher 阶段，不重复读取 INTENT.md。

## 5.4 Scribe：最重要的行为落地环节

继续复用：

- `scribe-runner.ts`
- `scribe-prompt-builder.ts`
- `intent-contract.ts`
- `assembleIntentContractV2()`

这是本次升级最重要的业务改造点。

Scribe 必须把战略依据转化为可持续使用的行为契约。

### A. Principle Statement

当 Stage A 判定战略相关时，Scribe 必须：

- 结合真实 Pain。
- 结合 Owner 的相关战略章节。
- 结合 Core Axioms。
- 形成具体、可观察、可执行的行为原则。

不能只把 Intent 原文换一种表达。

也不能为了满足战略意图而扩大原则适用范围。

当 Strategic Relevance 为 `not_applicable`、`not_configured` 或 `insufficient_evidence` 时，不得强迫 Scribe 编造战略关联。

### B. IntentContract V1

保留现有五个字段，字段名称、含义和必填性不变。

| 字段 | 必须表达 |
|---|---|
| ownerIntent | 这条原则真正希望解决的 Owner 需求 |
| targetBehavior | Agent 应当表现出的可观察行为 |
| forbiddenBehavior | 需要禁止的行为模式 |
| evidenceSource | 真实 Pain 和诊断依据 |
| validationExpectation | 如何判断行为原则得到遵循 |

特别要求：

当 Owner Strategic Intent 与当前 Pain 有关联时，V1 的行为契约必须体现这种关联，而不能只描述局部故障。

例如：

Owner 的长期目标是保护用户信任。

当前 Pain 是 Agent 未经确认修改了用户数据。

最终 Principle 不应仅仅表达：

“修改数据前应检查参数。”

而应将真正需要保护的行为边界转化为可执行要求，例如：

“在执行会改变用户数据的操作前，先确认授权范围；无法确认时停止并询问。”

这只是说明原则转化方向，具体内容仍须以真实 Pain 和 Owner 证据为准。

### C. IntentContract V2

继续复用现有 V2，不重新设计一套字段。

- `schemaVersion`
- `strategicIntent`
- `strategicAssessment`
- `corePrincipleRefs`

要求：

- V1 五字段保持原样。
- 战略身份由服务端生成。
- Relevance 由 Stage A 唯一决定。
- Conflict 由模型提出，服务端校验引用和证据。
- `corePrincipleRefs` 只记录实际参与本次判断的 Core Principle。
- 不从 `violatedPrinciples` 自动复制。
- 不允许模型伪造 Hash、Snapshot 或 Owner Decision。

V2 是战略追溯和审批依据，不是直接的运行时规则。

### D. Scribe Prompt 修订

当前 `STRATEGIC_CONTRACT_BLOCK` 有一条要求：

`principleDraft.statement` 必须表达可执行的战略行为要求。

需要修正为条件式要求：

- relevant：将相关战略要求转化为具体行为原则。
- not_applicable：不强制添加战略内容。
- not_configured：按原有 Pain 和 Core Principle 形成原则。
- insufficient_evidence：明确保留不确定性，不虚构战略关系。
- healthy_tension：描述真实取舍，不强行认定违规。
- intent_suspect：记录风险并建议 Owner 重新审视，不自行修改 Intent。

避免因为开关开启，就要求每一条原则都必须成为战略行为原则。

## 5.5 Artificer / Evaluator：保持既有行为机制

继续复用：

- `artificer-prompt-builder.ts`
- `evaluator-prompt-builder.ts`
- `IntentContractV1`
- 现有 RuleCode 生成与验证机制。

Artificer 应当根据：

- Principle Statement。
- IntentContract V1。
- 真实行为证据。

生成忠实于 Owner 目标的 RuleCode。

Evaluator 继续使用 V1 契约检查：

- 是否实现 targetBehavior。
- 是否违反 forbiddenBehavior。
- 是否满足 validationExpectation。
- 是否偏离 Principle 的适用范围。

不为了让它们直接读取 V2 而增加重复的战略分析模块。

**战略内容必须在 Scribe 阶段完成正确转换，V2 负责证明这次形成依据，V1 负责把行为要求传递给后续执行链路。**

## 5.6 Approval / Activation

继续复用：

- Owner Approval。
- Rollout Reviewer。
- RuleHost Activation。
- 现有 Principle Revision 机制。

不新增激活流程。

需要保证 Owner 审批时能够理解：

- 原始 Pain。
- 原则解决了什么问题。
- 本次参考了哪些 Intent 章节。
- 与 Core Principles 的关系。
- 是否存在战略张力或冲突。
- 后续会通过哪一种现有执行渠道生效。

Prompt Channel 和 RuleCode Channel 必须区分。

Prompt Channel 是原则上下文注入，不等于确定性的硬拦截。

RuleCode Channel 只有在生成、验证、审批和激活全部成功后，才具备对应的可执行规则约束。

---

# 6. 战略冲突与 Owner 主权

本节是对现有 Strategic Conflict Gate 的定向语义升级。

不新增冲突状态机，不新增冲突枚举，不新增 Owner Decision 表。

## 6.1 冲突分类

继续复用：

`IntentContractConflict`

现有字段：

- against
- ref
- status
- evidenceRefs

### A. 普通战略相关性

例如：

某项技术改造与当前战略重点相关。

这是关联，不是冲突。

不需要审批阻断。

### B. 潜在冲突

`status = potential`

含义：

存在值得注意的张力，但证据不足以确认。

处理：

- 在 Pain 和 Approval 页面提示 Owner。
- 展示相关章节和证据。
- 不自动阻断审批。
- 不自动修改原则。

### C. 已确认的普通战略取舍

例如：

某个原则有助于当前交付，但可能牺牲一部分长期目标。

`against = owner_intent`

`ref = why | desired_outcome | current_strategic_focus`

处理：

- 要求 Owner 明确看到冲突。
- 允许使用现有 `confirm_drift` 决策记录明确接受本次取舍。
- 决策必须绑定当前 Intent Hash、Contract Digest 和 Candidate。
- 只对本次具体候选有效。
- 不形成全局授权。
- 不修改 Intent。

这是一种 Owner 决策，不是模型自动豁免。

### D. 明确违反 Non-negotiables / Stop-Escalation

`against = owner_intent`

`ref = non_negotiables | stop_escalation`

处理：

- 必须进入强约束或升级路径。
- 不得通过普通 `confirm_drift` 记录绕过。
- 必须修改候选原则，使其重新符合边界；或者由 Owner 修改战略意图，再基于新版本重新形成候选。
- 旧 Snapshot 和旧候选保持不变。
- 不能让模型自行判断这些边界已经失效。

特别说明：

Stop/Escalation 的文本可以表达必须询问 Owner 的条件，但真正的宿主硬拦截仍需对应的 RuleCode 或现有 Host 执行机制支持。

### E. Core Principle 冲突

`against = core_principle`

如果服务端能够基于现有证据确认候选违反 Core Principle：

- 必须阻断该候选的晋级。
- Owner Intent 不能覆盖 Core Principle。
- `confirm_drift` 不能成为绕过 Core Principle 的授权。
- 必须重新形成符合两个锚点的候选。

Owner 可以修改自己的战略意图，但不能通过 Owner Decision 废除系统核心原则。

### F. Intent 可能过时

`intentTension.source = intent_suspect`

处理：

- 显示产生怀疑的证据。
- 提示 Owner 检查对应章节。
- 可以使用现有 `revise_intent` 操作。
- Owner 自行修改并保存新版本。
- 不允许 Agent 直接改写 INTENT.md。
- 不允许将 Agent 的推测自动升级成新的战略方向。

## 6.2 Strategic Conflict Gate 修改要求

当前 `evaluateStrategicConflictGate()` 主要根据整体 `conflictStatus` 判断。

需要改为读取经过验证的 `conflicts[]` 逐项判断。

判定原则：

| 条件 | 处理 |
|---|---|
| 只有 potential | 提示，不阻断 |
| confirmed，普通战略章节 | Owner 明确决策后允许 |
| confirmed，Non-negotiables | 阻断，不能普通确认放行 |
| confirmed，Stop/Escalation | 阻断，不能普通确认放行 |
| confirmed，Core Principle | 不可被 Owner Decision 覆盖 |
| V2 不完整或损坏 | 硬拒绝 |
| V1 历史产物 | 保持原有兼容行为 |

增加必要的一致性验证：

- `conflictStatus=none` 时不能存在 confirmed conflict。
- `conflictStatus=potential` 时必须有对应的潜在冲突依据。
- `conflictStatus=confirmed` 时必须存在可定位的 confirmed conflict。
- 不一致的 V2 不能静默降级为 V1。

继续使用现有：

- `STRATEGIC_CONFLICT_UNCONFIRMED`
- `intent_decisions`
- `contract_digest`
- `resultingCandidateId`
- `intentDocHash`

不新增决策类型，优先复用现有 `confirm_drift` 和 `revise_intent` 语义。

服务端仍然是唯一审批权威。

前端不能绕过。

---

# 7. Intent 内容可用性与模板处理

## 7.1 新增一个共享纯函数

在现有 Intent 文档纯逻辑模块中扩展，优先使用：

`packages/principles-core/src/runtime/intent/intent-doc.ts`

不新增 Intent Content Service。

建议提供：

```ts
interface IntentContentAssessment {
  status:
    | 'template_only'
    | 'incomplete'
    | 'configured';

  usableSectionCount: number;
  totalSectionCount: 5;

  sections: {
    key: IntentSectionKey;
    usable: boolean;
    placeholder: boolean;
  }[];
}
```

状态只用于运行和 UI 的确定性投影，不持久化，不创建新状态机。

## 7.2 模板识别

使用现有：

- `INTENT_DOC_TEMPLATE`
- `INTENT_DOC_TEMPLATE_ZH`
- `INTENT_DOC_TEMPLATE_EN`
- `parseIntentDocSections()`

对已知模板占位内容做规范化后的精确比较。

规则：

1. 默认模板提示文字不算 Owner 的有效战略内容。
2. 不使用大模型判断章节是否真实填写。
3. 不使用语义相似度猜测用户意图。
4. 不改变历史 INTENT.md。
5. 不误删用户真实填写的内容。
6. 已有用户内容即使较短，也不能仅因为不足 10 个字符而被硬性判为无效。

`validateIntentDocSections()` 的 `too_vague` 继续作为质量 Warning，不变成强制门禁。

## 7.3 内容使用规则

| 内容状态 | Prompt | Snapshot | Principle Formation |
|---|---|---|---|
| 无文件 | 不注入 | 不捕获 | not_configured |
| 只有模板 | 不注入 | 不捕获 | not_configured |
| 部分填写 | 只使用有效章节 | 只记录有效章节 | 正常参与 |
| 五章节有效 | 正常使用 | 完整捕获 | 正常参与 |
| 文件读取失败 | 安全降级 | 不捕获 | 保留原流程 |

模板内容不能作为真实 Owner Intent。

部分填写不阻断功能。

## 7.4 Hash 语义

`contentHash` 继续标识本次读取的原始 Owner 文档版本。

Prompt 和 Snapshot 使用同一份确定性过滤后的章节投影。

不为了过滤模板再增加第二套 Hash。

原始文件 Hash、Snapshot 捕获时间和章节内容必须可以追溯到同一次读取。

---

# 8. IntentSnapshot 与版本一致性

继续复用现有：

- `IntentSnapshot`
- `DiagRootCauseRunner`
- `pi_metadata.intentSnapshot`
- `updateTaskIfDiagnosticJsonUnchanged()`
- `PIArtifactStore`

## 8.1 不可变规则

| 场景 | 规则 |
|---|---|
| 首次 Stage A | 读取并捕获当前有效 Intent |
| Snapshot 已存在 | 直接复用，不读最新文件 |
| Snapshot 损坏 | Fail closed |
| CAS 并发冲突 | 使用胜者已持久化的 Snapshot |
| 持久化后重试 | 复用原 Snapshot |
| 读取后、持久化前崩溃 | 因尚未调用模型，可重新捕获 |
| Owner 修改 Intent | 只影响新任务 |
| Stage B/C | 只透传 Stage A 产物 |
| Dreamer / Philosopher / Scribe | 只消费固定上游战略依据 |

不能让同一候选链混用不同 Intent 版本。

## 8.2 已有 Snapshot 结构

继续使用现有字段：

- schemaVersion
- contentHash
- capturedAt
- intentVersionId
- lang
- sections

`intentVersionId` 保持可选。

不增加 Snapshot 表。

不新增 Snapshot Service。

不增加新的任务状态机。

## 8.3 Intent 修改后的行为

Owner 修改 INTENT.md：

- 新任务使用新版本。
- 历史任务不重写。
- 历史原则不自动修改。
- 已激活 RuleCode 不自动删除或替换。
- 需要调整旧原则时，使用现有 Principle Revision 和 Approval 机制。

历史原则与当前 Intent 的版本差异可以作为后续治理体验优化，但不在本次建立独立的自动迁移机制。

---

# 9. Host 生产接入范围

本次不是追求所有 Host 都有相同 Prompt Hook，而是确保所有实际支持的战略相关业务路径正确使用共享机制。

## 9.1 现有 Reader 接口

继续使用：

`IntentDocReader`

Core 不直接读取文件。

继续复用现有文件大小限制、Hash、Flag-first、缓存、XML 转义和 Prompt 预算。

## 9.2 生产入口接入矩阵

| 入口 | 当前情况 | 本次要求 |
|---|---|---|
| OpenClaw Pain Hook | 已传 Reader | 保留、回归 |
| OpenClaw Pain Command | 已传 Reader | 保留、回归 |
| OpenClaw Prompt Hook | 已注入 Intent | 增加模板过滤 |
| PD CLI Pain Record | 未传 Reader | 补齐 |
| PD CLI Diagnose | 未传 Reader | 补齐 |
| PD CLI Pain Retry | 未传 Reader | 补齐 |
| Host Runtime Governance Admission | 未传 Reader | 补齐 |
| PD CLI Internalization Run-Once | 消费已有上游产物 | 不重新读取 Intent |

对于 Codex / WorkBuddy：

- 如果进入共享 Governance Admission 和 Pain Formation 链路，应能够获得 Stage A Snapshot。
- 不得因为接入 Snapshot 就宣称已经实现 Prompt Hook 注入。
- 只在实际存在的宿主能力上声明支持。

## 9.3 Reader 适配器边界

当前：

- Core 定义 Reader Port。
- OpenClaw Plugin 提供文件读取实现。

需要检查 package dependency graph。

原则：

1. 不允许 CLI 反向依赖 OpenClaw Plugin。
2. 不允许 Core 直接进行文件系统 I/O。
3. 优先将可复用的 Host 文件读取适配放入现有中立 Host 层（前提是依赖图允许）。
4. 如果无法共享，只允许最薄的 Host 适配器，所有章节解析、模板过滤和业务判断仍使用同一套 Core 纯函数。
5. 不允许复制多套 Intent 业务解析逻辑。

`PainToPrincipleService` 和 `PainSignalRuntimeFactory` 已经具备可选 `intentDocReader` 参数，应优先复用。

## 9.4 Feature Flag Lifecycle

更新：

`feature-flag-lifecycle.ts`

消费者登记必须与实际生产调用点一致。

至少包括：

- OpenClaw Prompt Hook。
- OpenClaw Pain Ingress。
- PD CLI Pain Record。
- PD CLI Diagnose / Retry。
- Host Runtime Governance Admission。
- Diagnostician Stage A。
- Scribe V2 Assembly。
- Intent Decision API。

不得只修改注释，不验证真实调用。

---

# 10. 单一开关与自动协同

## 10.1 唯一开关

继续使用：

`intent_engineering`

默认值保持现有 `false`。

不新增：

- strategic_intent_anchoring
- intent_snapshot_enabled
- intent_contract_v2_enabled
- strategic_conflict_enabled
- intent_prompt_enabled

用户不需要理解这些技术模块。

## 10.2 开关开启

当 Owner 在 Web Console 开启 Intent：

- Prompt Hook 自动读取。
- 支持的 Pain 入口自动提供 Reader。
- Stage A 自动捕获 Snapshot。
- Dreamer 自动获得双锚点。
- Philosopher 自动获得诊断依据。
- Scribe 自动组装 V2。
- Artificer / Evaluator 沿用现有 V1 契约。
- Approval 自动执行战略冲突检查。

不需要任何额外配置。

## 10.3 开关关闭

- 不读取新的 INTENT.md。
- 不注入新的 Intent Prompt。
- 不生成新的 IntentSnapshot。
- 不生成新的 IntentTension。
- 新形成任务回到原有 V1 行为。
- 历史 Snapshot 保留。
- 历史 IntentDecision 保留。
- 已经形成的 V2 Approval Gate 继续生效，不能因为关闭开关而绕过。

## 10.4 Web Console

沿用：

`PATCH /api/config/features/intent_engineering`

支持开启和关闭。

关闭时显示一次确认：

- 不再参与新的 Intent 读取和运行。
- 不删除文档。
- 不删除版本历史。
- 不影响已有候选和历史审批。

不在 Settings 页面再增加第二个 Intent 开关。

---

# 11. Intent Web UI 升级

## 11.1 设计目标

Intent 页面是统一入口，不是新的战略分析 Dashboard。

继续使用：

`IntentPage.tsx`

优化现有组件，不重新建设一套页面。

## 11.2 页面信息架构

```text
Intent
│
├── 1. Intent 状态与开关
│
├── 2. Owner Strategic Intent
│      ├── Why
│      ├── Desired Outcome
│      ├── Non-negotiables
│      ├── Stop / Escalation
│      └── Current Strategic Focus
│
├── 3. 使用说明
│      Intent 如何参与 PD 的核心流程
│
├── 4. Owner Decision Summary
│
└── 5. Version History
```

## 11.3 首屏

必须清楚回答：

- Intent 是否开启？
- 是否有有效内容？
- 有多少章节已经填写？
- 当前是否可以参与下一次符合条件的任务？

状态：

| 状态 | UI 表达 |
|---|---|
| Disabled | 功能关闭 |
| Missing | 尚未创建 |
| Template Only | 仅有模板提示 |
| Incomplete | 已填写部分章节，可以使用 |
| Configured | 已配置有效战略内容 |
| Error | 读取或权限异常 |

不要将 `Configured` 等同于已经验证了宿主行为改善。

## 11.4 五章节 UI

保留五章节结构。

每个章节展示：

- 标题。
- 简短解释。
- 当前内容。
- 是否已填写。
- 编辑入口。

不要把整份 Markdown 直接当作一大段文章展示。

## 11.5 首次 Onboarding

复用现有：

`IntentOnboarding.tsx`

必须修复当前五步向导的强制填写问题。

当前向导在章节为空时禁用 Next。

改为：

- 可以跳过章节。
- 可以部分完成。
- 可以保存后继续编辑。
- 至少有一个有效章节即可进入部分使用状态。
- 最后显示五章节汇总。
- 明确说明未填写章节不会作为战略依据。

不强迫 Owner 一次填写全部五章。

## 11.6 编辑体验

继续复用 `IntentEditor`。

要求：

- 支持五章节独立编辑。
- 支持部分保存。
- 显示章节状态。
- 保存后即时刷新。
- 保留未保存修改确认。
- 保留中英文文件隔离。
- 保留 32KB 限制。
- 不允许 Agent 自动修改原文。

## 11.7 使用说明

页面增加一段简洁说明：

Intent 不会把所有文字变成强制执行规则。

它会：

- 帮助 Agent 理解长期方向。
- 参与关键决策。
- 影响 Pain 诊断。
- 参与原则形成。
- 通过已批准的 Principle 和 RuleCode 进入长期行为机制。

只有已经形成并激活的相应原则或规则，才具备对应的宿主执行能力。

## 11.8 现有功能保留

保留：

- Decision Summary。
- Version History。
- 文件编辑入口。
- Warning。
- 必要的 Content Hash 和路径信息。

技术详情可以折叠。

不增加新的统计 Dashboard。

不增加未经数据支持的使用率和效果指标。

## 11.9 Pain 与 Approval 页面

复用现有 IntentTension 和 StrategicConflict 展示。

Pain 页面重点表达：

- 行为偏离。
- 健康战略张力。
- Intent 可能过时。
- 相关章节和证据。
- 建议 Owner 行动。

Approval 页面重点表达：

- 本次候选使用的 Intent 版本。
- 战略关联。
- 具体冲突对象。
- 是否需要 Owner 决策。
- 为什么阻断或允许审批。

不得只显示一个模糊的红色冲突标签。

现有 Approval Read Model 已有 per-record `strategicConflict` 投影，本次扩展其语义即可。

---

# 12. API 与数据契约

## 12.1 API 复用

| API | 用途 | 本次处理 |
|---|---|---|
| GET /api/intent | 页面状态 | 扩展内容状态 |
| GET /api/intent/content | 编辑内容 | 保留 |
| POST /api/intent/init | 创建模板 | 保留 |
| PUT /api/intent/content | 保存内容 | 返回内容状态 |
| GET /api/intent/versions | 版本历史 | 保留 |
| PATCH /api/config/features/intent_engineering | 唯一开关 | 支持双向切换 |
| /api/intent-decisions | Owner Decision | 保留 |

## 12.2 Intent Summary

在现有 `IntentSummaryData` 上增加最小必要字段：

```ts
interface IntentSummaryData {
  flagEnabled: boolean;
  found: boolean;
  ok: boolean;

  contentReadiness:
    | 'template_only'
    | 'incomplete'
    | 'configured';

  usableSectionCount: number;
  totalSectionCount: 5;

  warnings: IntentDocWarningData[];

  contentHash?: string;
  lastEditedAt?: string;
  sections?: Record<string, string>;

  reason?: string;
  nextAction?: string;
}
```

使用现有 API Validator 扩展。

不新增重复的状态存储。

## 12.3 数据库

本次不新增数据库表。

不新增：

- Strategic Intent Table。
- Snapshot Table。
- Intent Binding Table。
- Intent State Machine。

继续复用：

- `intent_doc_versions`
- `intent_decisions`
- Task diagnostic_json
- PIArtifactStore
- Approval Store

现有 `contract_digest` 保持使用。

---

# 13. 安全与兼容性

## 13.1 Flag-first

Flag 关闭时，运行时不得读取 Intent 文件或缓存。

## 13.2 Prompt 安全

继续使用：

- XML 转义。
- Prompt 预算。
- 现有 `INTENT_INJECT_MAX_CHARS`。
- Intent 作为 Owner 提供的引用材料，而不是系统指令。

不得让 Intent 覆盖系统安全约束或 Core Principles。

## 13.3 Owner 主权

Agent 可以：

- 识别冲突。
- 提出修改建议。
- 提出战略取舍。
- 提出 Intent 修订方案。

Agent 不可以：

- 自行修改 INTENT.md。
- 自动接受自己的战略偏离。
- 自动修改 Owner Decision。
- 自动批准战略冲突。
- 通过模型输出覆盖服务端 Snapshot。
- 通过 Owner Intent 覆盖 Core Principles。

## 13.4 历史兼容

- V1 IntentContract 保持原有行为。
- V2 必须满足完整性要求。
- 历史 V1 审批不受影响。
- 历史 Snapshot 不重写。
- 历史 IntentDecision 不回填虚假关联。
- 历史原则和规则不自动失效。
- 历史版本继续可读。

补充规则（Owner Amendment 2026-11-15）：

1. 已经完成的历史 Approval 不追溯撤销。
2. 历史 Intent Decision 保留，不伪造数据。
3. 历史 `confirm_drift` 不能自动成为新规则下 Core Principle 或 Owner Boundary 的豁免依据。
4. 只有符合新规则、且 Candidate、Intent Hash、Artifact Digest 和相关章节均匹配的决策，才能解决普通战略取舍。
5. 无法证明旧决策覆盖了对应章节时，要求 Owner 重新审阅，而不是默认放行。
6. 不回填虚假 `related_intent_fields`。
7. 历史 Snapshot 没有 `placeholder` 标记时，用同一套确定性规则重新识别有效章节；不得直接把历史模板内容认定为 Owner 意图。

## 13.5 降级规则

| 故障 | 处理 |
|---|---|
| Intent 关闭 | 不读取，不注入 |
| 文件不存在 | 原有流程继续 |
| 只有模板 | 视为未配置 |
| 部分填写 | 仅使用有效章节 |
| 内容超限 | 明确拒绝读取 |
| 文件读取失败 | 安全降级并记录原因 |
| Reader 未接入 | 暴露真实缺口 |
| Snapshot 持久化失败 | 不使用未固定快照调用模型 |
| V2 不完整 | 拒绝成功 |
| confirmed hard boundary | 阻断候选晋级 |
| Core Principle 冲突 | 不允许 Owner Decision 覆盖 |

---

# 14. 实施阶段

本次不需要先研究模型实验，不需要新建独立研究项目。

按以下顺序开发。

## P0：战略意图真正进入核心管道

1. 固定 `intent_engineering` 唯一开关。
2. 更新 Feature Flag Lifecycle 消费者。
3. 实现统一模板占位识别和内容可用性判断。
4. Prompt 和 Snapshot 使用相同的有效章节。
5. 完成 PD CLI Pain Record Reader 接入。
6. 完成 PD CLI Diagnose / Retry Reader 接入。
7. 完成 Host Runtime Governance Admission Reader 接入。
8. 修订 Scribe 的双锚点到 Principle Statement / V1 Contract 转换要求。
9. 修正 Scribe 在无战略依据时的强制战略表述。
10. 修正 Strategic Conflict Gate 的逐项判定。
11. 确保 Core Principle 冲突不可通过普通 Owner Decision 覆盖。
12. 确保 Non-negotiables / Stop-Escalation 冲突进入强约束路径。
13. 保留 V1 / V2 和历史审批兼容。
14. 补齐集成测试。

P0 目标：

**只开启一次 Intent，填写有效内容，真实生产链路就能自动使用它，并通过现有原则机制向下游传递。**

## P1：Intent 产品体验升级

1. Intent 页面单一开关双向操作。
2. 增加内容状态。
3. 修复五步向导强制填写。
4. 优化五章节编辑体验。
5. 优化首次配置。
6. 保留和优化 Decision Summary。
7. 优化 Version History。
8. 优化 Pain 页面战略张力展示。
9. 优化 Approval 冲突说明。
10. 完成中英文和响应式适配。

## P2：正式开放后的持续完善

1. 观察真实 Pain 是否能正确关联 Intent。
2. 观察 Scribe 生成的 Principle 是否真正反映战略方向。
3. 观察 Artificer 是否忠实实现 V1 行为契约。
4. 观察 Evaluator 是否发现**已写入 V1 行为契约的战略行为要求**被违反（Evaluator 不消费 V2 战略字段；V2 的合法性由服务端审批门禁验证）。
5. 收集 Owner 对冲突分类和提醒质量的反馈。
6. 根据实际问题进行小范围定向修正。

P2 不得成为 P0/P1 开发前置条件。

不启动无期限的大模型实验。

---

# 15. 自动化测试与验收

## 15.1 Unit Tests

至少覆盖：

- 唯一 Feature Flag。
- 中英文模板识别。
- 模板占位过滤。
- 空章节。
- 部分填写。
- 有效章节。
- 32KB 限制。
- Prompt 内容过滤。
- Snapshot 章节过滤。
- Snapshot Hash。
- Snapshot CAS。
- Snapshot 重试一致性。
- V1 兼容。
- V2 完整性。
- Strategic Relevance 四态。
- ConflictStatus 一致性。
- 冲突目标分类。
- Owner Decision 幂等。
- Digest 变化后旧决策失效。
- Core Principle 冲突不可豁免。

## 15.2 Integration Tests

### 测试 A：模板内容

创建只有默认模板提示的 INTENT.md。

预期：

- UI 显示 Template Only。
- Prompt 不注入模板提示。
- Stage A 不把模板当成 Owner Intent。
- 不生成虚假战略关联。

### 测试 B：部分内容

只填写 Why 和 Non-negotiables。

预期：

- 允许保存。
- 允许正常运行。
- Snapshot 只包含有效章节。
- 其他章节明确标记缺失。
- 不要求补全五章。

### 测试 C：双锚点

构造同时涉及 Owner Intent 和 Core Principle 的 Pain。

预期：

- Dreamer 明确参考两个锚点。
- Philosopher 审查两个锚点。
- Scribe 将有效战略要求转化为行为原则。
- `corePrincipleRefs` 只包含真实参与判断的核心原则。
- 不存在通过牺牲一个锚点制造虚假一致的行为。

### 测试 D：V1 到 RuleCode

验证：

- Scribe 输出 V1 五字段。
- Artificer 收到正确 V1 契约。
- Evaluator 收到相同 V1 行为依据。
- RuleCode 没有偏离 targetBehavior。
- RuleCode 没有实现 forbiddenBehavior。
- 现有验证和激活机制正常工作。

### 测试 E：冲突

分别覆盖：

1. potential owner_intent。
2. confirmed 普通战略取舍。
3. confirmed non_negotiables。
4. confirmed stop_escalation。
5. confirmed core_principle。
6. healthy_tension。
7. intent_suspect。

确认每种情况都按第 6 章执行。

### 测试 F：版本一致性

- Intent A 创建任务。
- Stage A 捕获 A。
- Owner 修改为 B。
- 重试旧任务。
- 检查旧任务仍使用 A。
- 新建任务检查使用 B。

### 测试 G：Flag-off

- 关闭 Intent。
- 触发新任务。
- 验证没有新读取、注入、Snapshot。
- 历史 V2 审批门禁仍然有效。
- 历史数据没有丢失。

## 15.3 真实浏览器 E2E

必须使用实际 Web Console。

至少完成以下完整旅程：

```text
1. 新建测试 Workspace
2. 进入 Intent 页面
3. 开启唯一开关
4. 创建 INTENT.md
5. 只填写部分章节
6. 保存并刷新页面
7. 验证内容状态
8. 通过 OpenClaw / CLI / 支持的 Host 创建真实 Pain
9. 执行 Stage A
10. 检查 IntentSnapshot
11. 执行 Dreamer
12. 执行 Philosopher
13. 执行 Scribe
14. 检查 Principle Statement
15. 检查 IntentContract V1 / V2
16. 进入 Owner Approval
17. 验证战略冲突判断
18. 通过现有流程完成审批
19. 对 code_tool_hook 渠道验证 RuleCode 生成和激活
20. 检查最终宿主运行路径
```

不能用单元测试 Mock 代替真实生产接入验收。

不能把生成 V2 等同于行为已经生效。

不能把审批通过等同于 RuleCode 已经激活。

不能把 RuleCode 激活等同于长期行为已经改善。

这些是不同的事实。

---

# 16. Definition of Done

## 产品

- [ ] 一个 Intent 开关。
- [ ] Web Console 可以开启和关闭。
- [ ] 五个章节继续保留。
- [ ] 允许部分填写。
- [ ] 模板占位内容不再作为真实意图。
- [ ] 页面可以准确表达内容状态。
- [ ] Owner 能理解 Intent 的战略职责。
- [ ] UI 没有形成独立 Dashboard。

## 核心管道

- [ ] OpenClaw Prompt 继续正确工作。
- [ ] 所有本次确认的生产 Pain 入口完成 Reader 接线。
- [ ] Stage A 只使用有效 Intent 内容。
- [ ] Snapshot 不可变。
- [ ] Dreamer 使用双锚点。
- [ ] Philosopher 使用双锚点。
- [ ] Scribe 将战略要求转换为 Principle 和 V1 Contract。
- [ ] V2 由服务端权威组装。
- [ ] Artificer 正确消费 V1。
- [ ] Evaluator 正确验证 V1。
- [ ] Approval 正确识别冲突类型。
- [ ] Core Principle 不可被 Owner 决策覆盖。
- [ ] RuleCode 在支持的渠道正确生成、验证和激活。

## 架构

- [ ] 不新增第二个 Flag。
- [ ] 不新增数据库表。
- [ ] 不新增 Snapshot Service。
- [ ] 不新增 Intent Manager。
- [ ] 不新增原则形成阶段。
- [ ] 不新增冲突状态机。
- [ ] 不重复实现 Owner Decision。
- [ ] 不重复实现 Approval。
- [ ] 不破坏历史 V1/V2 兼容。
- [ ] 最大化复用现有成熟机制。

## 验收

- [ ] Unit Tests 通过。
- [ ] Integration Tests 通过。
- [ ] Host 接入测试通过。
- [ ] Web Console E2E 通过。
- [ ] 双锚点真实链路通过。
- [ ] RuleCode 渠道端到端通过。
- [ ] 真实浏览器验收完成。
- [ ] 无跨 Workspace 数据读取。
- [ ] 无未经授权的 Intent 修改。
- [ ] 已知限制如实记录。

---

# 17. 明确禁止的开发行为

1. 不得新增 Intent 专属 Feature Flag。
2. 不得重新设计 IntentSnapshot。
3. 不得重新开发 IntentContract V1。
4. 不得为了 V2 重新开发一套下游规则机制。
5. 不得让所有任务都强制输出战略分析。
6. 不得把所有战略张力判定成违规。
7. 不得让 Owner Intent 覆盖 Core Principles。
8. 不得让 Agent 自动修改 Intent。
9. 不得把所有 Host 都强行改造成相同的 Prompt Hook。
10. 不得因为 UI 改造而重新设计整个 PD Console。
11. 不得为了所谓的长期验证先建设新的实验平台。
12. 不得在实现过程中不断新增未经 Owner 确认的产品目标。

任何需要新增服务、数据库、状态机或跨包抽象的方案，都必须先证明现有实现无法满足，并选择最小改造。

---

# 18. 风险与未核实事项

以下事项必须如实处理，不能将源码推断包装成已经验证的事实。

| 项目 | 当前状态 | 处理 |
|---|---|---|
| 最新 main 相关源码 | 已核查 | 本地实施前重新对齐 |
| 生产数据库 Intent 版本分布 | 未核查 | 不进行历史数据假设 |
| Codex / WorkBuddy 实际部署入口 | 源码路径已核查，实际运行未全面验证 | 本地环境 E2E |
| 真实 LLM 对双锚点的语义遵循程度 | 未验证 | 核心功能开放后观察 |
| Intent 对长期行为改善的实际幅度 | 未验证 | 不作为本次开发前置门槛 |
| 手工编辑 INTENT.md 的版本记录 | 现有版本存储主要记录 Console/CLI 保存；直接磁盘修改可能不生成版本记录 | 保留 Snapshot Hash 和正文追溯，不承诺完整版本历史 |
| 不同 Host 的 Prompt 能力 | 不完全一致 | 如实标记支持范围 |

---

# 19. 最终验收问题

本次项目不是为了交付一张更漂亮的 Intent 页面，也不是为了增加几个战略字段。

最终要回答：

**Owner 只需要维护一份长期战略意图，PD 是否就能把它真正带入自己的原则形成和行为治理过程，并通过已经成熟的 Principle、IntentContract、Artificer、Evaluator、RuleCode 和 Activation 机制，逐渐改变 Agent 的长期行为？**

完整体验应该是：

1. Owner 开启一次 Intent。
2. Owner 填写自己的长期目标和边界。
3. PD 在相关任务中自然参考它。
4. PD 从真实 Pain 中识别行为与战略方向之间的关系。
5. PD 在原则形成时同时考虑 Owner Intent 和 Core Principles。
6. PD 将战略要求转化为具体行为原则。
7. 下游规则生成和评估继续沿用成熟的 V1 行为契约。
8. 冲突和重大取舍交给 Owner。
9. 经批准的原则和规则通过现有机制进入宿主。
10. 后续真实运行不断积累行为纠正经验。

**最终目标不是让 Agent 记住 Owner 想要什么，而是让 Agent 在长期行为中逐渐体现 Owner 真正重视什么。**

---

# 20. Owner Amendment 2026-11-15 — 规范澄清

本节是 v2.0 的规范性澄清，与前面章节冲突时以本节为准。它不改变版本号，也不改变产品目标；只消除实现者会踩空的歧义。

## 20.1 有效 Intent 章节是战略证据的唯一入口

Owner 的战略意图只有两类内容：Owner 亲手写的章节正文，以及服务端据此产生的快照与契约。

因此：

- `missing`（缺失/空白）与 `placeholder`（模板或 TODO 占位）章节**不构成战略证据**；
- 该判定必须在**服务端**、用**确定性规则**完成，不得交给 LLM；
- 判定结果必须统一作用于：Stage A 快照、`intentTension.relatedIntentFields`、`deriveStrategicRelevance()`、`assembleIntentContractV2()`、FormationContext、Dreamer/Philosopher/Scribe 战略上下文、Approval 冲突验证；
- 任何一处仍然直接使用未净化的模型章节引用，都视为实现缺陷。

模型引用无效章节时：

1. 拒绝该引用并可观察地记录；
2. 部分有效时只保留有效部分；
3. 全部无效时不得产生 `confirmed` 冲突，必须降级为 `insufficient_evidence`；
4. 模型**没有声明**关联章节与"声明了但全部被拒绝"必须区分，前者按正常无关联处理，后者不得回退成"完整快照"。

## 20.2 三类冲突的治理边界

| 类型 | 允许的处理 |
|---|---|
| 普通战略取舍（`why` / `desired_outcome` / `current_strategic_focus`） | Owner 可以使用 `confirm_drift` 明确接受本次取舍 |
| Owner 边界违反（`non_negotiables` / `stop_escalation`） | 不能通过普通 `confirm_drift` 绕过；必须修改候选，或由 Owner 修改意图后重新形成候选 |
| Core Principle 冲突 | 不能通过任何 Owner Intent Decision 豁免；必须阻断当前候选晋级 |

`confirm_drift` 的放行必须同时验证：Candidate、Intent Hash、Artifact Digest、章节属于普通战略取舍、决策的 `relatedIntentFields` 覆盖该章节、同一契约内全部需要解决的普通取舍均被覆盖。

`conflictStatus: 'confirmed'` 但 `conflicts` 缺失或为空数组时，属于**不可分类冲突**：必须无条件阻断，不允许任何 `confirm_drift` 豁免，也不允许用决策的 `relatedIntentFields` 反向推断冲突类型。已完成的历史 Approval 不追溯撤销；历史待审批记录必须重新形成可识别的冲突契约，或由 Owner 重新审阅。

IA 如果提到"既有核心原则治理机制"，必须给出真实存在的实现位置与调用路径；当前仓库不存在第二套 Core Principle 冲突治理流程，因此不得把它当作放行通道。

## 20.3 无有效战略依据时不得产生战略判断

- 没有 Snapshot（含 flag 关闭、模板-only）时，服务端必须删除模型提供的 `intentSnapshot` 与 `intentTension`；
- FormationContext 投影同样执行该规则：无快照或快照无有效章节时删除 `intentTension`；快照存在时，`intentTension.relatedIntentFields` 只能引用 authored 章节；缺少 `authoredSectionKeys` 的历史 artifact 不得重新获得模型章节引用的权威性；
- 不允许模型自建战略锚点，也不允许形成基于不存在 Owner Intent 的 `confirmed` 冲突；
- 模板-only 必须归类为 `not_configured`，不得因为模型自报 `intentTension` 改变结论。

## 20.4 Feature Flag 必须真正关闭整条链路

`intent_engineering` 关闭时：

- 不注入、不捕获、不产生新锚定；
- 不保留模型生成的 `intentTension`；
- Dreamer 的 predecessorOutput、Philosopher 的 diagnosisArtifact、Scribe 的 FormationContext 都必须移除战略部分（Snapshot / Tension / `provenance.strategicIntent`），普通诊断信息（Root Cause、Pain、Evidence、Dreamer Proposals）保留；
- Scribe 不生成新的 V2 战略锚定，只产出 V1；
- 但**不删除**已持久化的快照。

重新开启后，同一任务恢复使用之前固定的快照，不重新读取最新 INTENT.md。

## 20.5 下游边界与契约语义

- Artificer / Evaluator 继续消费 **V1**；V2 战略字段由服务端组装，用于战略追溯与审批门禁。
- 不得为本次整改扩展 Evaluator 直接消费 V2。
- V2 是战略追溯与审批依据，不是 RuleCode 的直接执行载体。
- `intentVersionId` 保持可选；不得通过 `contentHash` 反查版本（版本存储没有该索引）。
- `contract_digest` 绑定的是完整 Artifact Digest，不存在 contract-only digest。

## 20.6 明确不新增的架构

本次整改禁止新增：StrategicIntentService、IntentSnapshotService、FormationIntentBinding、Formation ID、StrategicContextService、StrategicConflictManager、IntentContractStore、StrategicApprovalService、第二套 Intent 文档、第二个 Feature Flag、第二套 Principle Formation Pipeline，以及无必要的数据库表与状态机。

优先扩展现有模块。

---

**SPEC-PD-INTENT-UNIFICATION-001 v2.0 结束**

本版本替代 v1.0，作为本次后续技术实施的唯一产品需求依据。