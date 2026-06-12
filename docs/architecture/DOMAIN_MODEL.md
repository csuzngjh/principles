# PD 核心领域模型与通用语言（Ubiquitous Language）

> **状态**: LOCKED-ONTOLOGY（强制执行）
> **最后更新**: 2026-05-23（与 ADR-0005 / ADR-0006 / ADR-0007 / ADR-0012 对齐）

> **ADR-0012 修订**: `IdleTrigger` 不再是目标调度组件；已存在代码视为待退役路径。Runtime V2 的未来唤起由 PD-owned config/SDK/operator/scheduler boundary 承担，OpenClaw 不拥有调度。Nocturnal 执行逻辑按 caller cutover 后删除。
> **关联文档**: `GLOSSARY.md`（术语词典）, `PD_ARCHITECTURE_OVERVIEW.md`（架构总览）, `INTERNALIZATION_PIPELINE.md`（流水线设计）
> **背景**: 本文档是对 PD 核心领域概念的**官方建模**。所有代码、Schema、Linear issue、ADR 必须使用本文术语。变更需通过 PR 同步修订并通知团队。

---

## 0. 设计目标

PD 不是"规则库"或"提示词管理工具"。它的核心是：

> **基于痛苦学习、通过原则演化、向多通道内化的认知治理框架。**

具体地，本文档约束以下事项：

- **语义**：每个概念有唯一定义
- **结构**：概念之间有明确关系
- **生命周期**：状态机有显式规则
- **载体**：每个概念在代码中有清晰映射

任何**新增术语**或**改变现有术语含义**的提议必须先更新本文档。

---

## 1. 三层进化模型

PD 的知识演化遵循固定路径：

```
Pain Signal
    │
    ▼ Diagnostician
Diagnostician Recommendation
    │
    ▼ CandidateIntakeService
Principle (probation)
    │
    ▼ Internalization Pipeline（7 个 Peer Runner）
PIArtifact (validated)

> **ADR-0014 Amendment (2026-06-11)**: The "7 Peer Runner" invariant refers to the
> Internalization Pipeline only. The Diagnostician Pipeline introduces a separate
> `DiagnosticianStageKind` type (diag_rootcause, diag_distiller, diag_router) that
> is NOT a PeerRunnerKind. The union type `RunnerKind = PeerRunnerKind | DiagnosticianStageKind`
> is used by the orchestrator for task dispatch, but the two pipelines remain
> architecturally distinct.

    │
    ▼ Activation Pipeline（5 通道）
实际生效（agent 行为改变）
```

主干结构：**Principle → Rule → Implementation**

```text
Principle  <───────────────────────────────>  Rule  <─────────>  Implementation
高泛化                                          高实操                 具体可执行
低可测试                                        高可测试               有运行时
Why / What                                     When / Where / How    实际承载
适合 Prompt / Skill / SOP                      绑定工具 / 场景        Code / Skill / LoRA
跨场景                                          场景特化              单点实例
```

---

## 2. 核心三层概念

### 2.1 Principle（原则）— 树根

**定义**：高度抽象、跨场景、可泛化的经验或价值判断。说明"为什么这样做"和"大方向应避免什么"。

**关键属性**：

| 属性 | 类型 | 说明 |
|------|-----|------|
| `id` | string | 例 `P_001` / `P_security_001` |
| `version` | number | 版本号（修订递增）|
| `text` | string | 自然语言描述 |
| `triggerPattern` | string | 触发模式 |
| `action` | string | 应该采取的行为 |
| `status` | enum | `candidate \| probation \| active \| archived \| deprecated` |
| `priority` | enum | `P0 \| P1 \| P2` |
| `scope` | enum | `general \| domain` |
| `evaluability` | enum | `manual_only \| weak_heuristic \| deterministic` |
| `valueScore` | number | 价值评分 |
| `adherenceRate` | number | 遵守率 0-1 |
| `painPreventedCount` | number | 防止痛苦的次数 |
| `derivedFromPainIds` | string[] | 来源痛苦信号 |
| `ruleIds` | string[] | 关联的规则 |
| `conflictsWithPrincipleIds` | string[] | 冲突的其他原则 |
| `activatedAt` | string? | 激活时间（ADR-0006）|
| `activatedBy` | ActivationActor? | 激活方（ADR-0006）|
| `archivedReason` | string? | 归档原因（ADR-0006）|
| `archivedAt` | string? | 归档时间 |
| `createdAt` / `updatedAt` | string | 时间戳 |

**Principle 类型层级**：

| 类型 | 含义 | 示例 |
|------|-----|-----|
| `Core Principle` | 跨项目跨工具，类似系统宪法 | "未知状态下不执行破坏性操作" |
| `Domain Principle` | 面向某业务域 | "Runtime V2 写侧入口必须由 core 拥有" |
| `Scenario Principle` | 面向具体 workflow / 工具 / SOP | "执行 pruning 前必须生成 explain evidence" |

**代码映射**：
- 类型定义：`@principles/core/principle-tree-ledger.ts` 中的 `LedgerPrinciple`
- 持久化：`{workspace}/.state/principle_training_state.json` 的 `_tree.principles`

### 2.2 Rule（规则）— 树干

**定义**：Principle 在特定边界下的可验证、可测试、可观测契约。

**关键属性**：

| 属性 | 类型 | 说明 |
|------|-----|------|
| `id` | string | 例 `R_001_a` |
| `principleId` | string | 父 Principle |
| `name` | string | 规则名 |
| `type` | enum | `hook \| gate \| skill \| lora \| test \| prompt \| code` |
| `triggerCondition` | string | 触发条件 |
| `enforcement` | enum | `block \| warn \| log \| requireApproval \| propose_correction` |
| `status` | enum | `proposed \| implemented \| enforced \| retired` |
| `lifecycleState` | enum | 同 Implementation lifecycle |
| `coverageRate` | number | 0-1 |
| `falsePositiveRate` | number | 0-1 |
| `implementationIds` | string[] | 关联实现 |

**Rule 必须能回答**（如 `INTERNALIZATION_PIPELINE.md` §3.7 所定义）：
- 它对应哪个 Principle？
- 面向什么场景？
- 解决什么问题？
- 绑定哪些工具 / Skill / SOP / Workflow？
- 如何被测试 / 验证 / 观测？
- 触发后是 log / warn / requireApproval / propose_correction 还是 block？

**Rule Context Binding 维度**：

| 维度 | 含义 | 示例 |
|------|-----|-----|
| `principleId` | 父 Principle | `P_runtime_v2_boundary` |
| `scenario` | 适用场景 | `runtime-v2-pain-record` |
| `problem` | 问题类型 | `architecture-regression` |
| `tool` | 相关工具 | `apply_patch`, `git`, `pd-cli` |
| `skill` | 相关 Skill | `tdd`, `gsd-execute-phase` |
| `sop` / `workflow` | 相关流程 | `PR review`, `pruning review` |
| `triggerCondition` | 触发条件 | "plugin imports createPainSignalBridge" |
| `validationSpec` | 验证规范 | "architecture-regression.test fails" |

**关键澄清**：Rule **不等于** Implementation。Rule 是契约；Implementation 是承载契约的具体机制。

### 2.3 Implementation（实现）— 树叶

**定义**：Rule 的具体行为承载物。

**类型枚举**：

| type | 说明 | 通道 |
|------|-----|-----|
| `code` | RuleHost 可执行 JS 代码 | `code_tool_hook` |
| `prompt` | Prompt 注入片段 | `prompt` |
| `skill` | Skill 文档 | `skill` |
| `lora` | LoRA / Fine-tune checkpoint | `model_training` |
| `test` | 验证测试 | n/a（仅做验证）|

**关键属性**：

| 属性 | 类型 | 说明 |
|------|-----|------|
| `id` | string | 例 `IMPL_001_a_hook` |
| `ruleId` | string | 父 Rule |
| `type` | enum | 见上 |
| `path` | string | 文件路径 / Skill ID / 模型路径 |
| `lifecycleState` | enum | `candidate \| active \| disabled \| archived` |
| `coversCondition` | string | 覆盖的条件 |
| `version` | string | 实现版本 |
| `shadowMode` | boolean? | 是否处于 shadow 模式（ADR-0004 / ADR-0006）|
| `shadowModeRemaining` | number? | 剩余 shadow 周期 |

**关系约束**：

- 一个 Rule 可有多个 Implementation 候选
- 同一 Rule 同一时间最多一个 `active` Implementation
- `code` type 实现激活前**必须**通过 GoldenTrace（详见 ADR-0004）

**代码映射**：
- 类型定义：`Implementation` in `@principles/core`
- 文件存储：`{workspace}/.principles/implementations/{type}/{implId}/`
- 管理：`@principles/core/runtime-v2/internalization/rule-host-*.ts`

---

## 3. 五条内化通道（合并后版本）

> **重要更新**：原"三类内化路线"已扩展为**五通道**，详见 ADR-0006 与 `ACTIVATION_CHANNELS.md`。

| 通道 ID | 等级 | 中文别名 | 载体 | 默认激活策略 |
|--------|-----|--------|-----|------------|
| `prompt` | L1 | 软内化 | system prompt | 全自动 |
| `defer_archive` | n/a | 归档 | Ledger 状态变更 | 全自动 |
| `skill` | L1.5 | 半软内化 | Skill 文档 | 默认自动，可配置 |
| `code_tool_hook` | L2 | 硬内化 | RuleHost 代码 | 必须人工审批 |
| `model_training` | L3 | 模型参数化 | LoRA / Fine-tune | 必须人工审批 + 二次确认 |

每条通道详细规范参见：[`ACTIVATION_CHANNELS.md`](./ACTIVATION_CHANNELS.md)

### 3.1 设计哲学：最便宜的内化优先

```
prompt < defer_archive < skill < code_tool_hook < model_training

(成本递增，强度递增)
```

PD 鼓励**渐进式内化**：原则先以 prompt 起步，经过验证后逐步升级到 skill / code / training。

---

## 4. 系统动力学与流量词汇

| **概念** | **定义** |
|------|-----|
| **Pain Signal** | 代理执行任务时遇到的具体挫败（错误、超时、用户负面反馈）。是演化的原始输入流量。 |
| **GAP Signal** | Goal-Aligned Pain Signal。目标驱动的痛苦信号，来自 Mission 失败/停滞、OKR 偏离、决策卫生缺失等**长程目标层**事件。是 Pain Pipeline 的**主信号源**（Layer 1）。 |
| **Diagnosis** | 寻找 Pain 根因的分析过程，由 3 阶段拆分管道（`SplitDiagnosticianRunner`）完成。|
| **Recommendation** | Diagnostician 输出的建议项。合法 `kind`：`principle / rule / implementation / prompt / defer`。|
| **Taxonomy** | 将 Recommendation 正确分类的动作。分类精度决定软硬转换效率。|
| **Internalization** | 将 Principle 通过 5 通道转化为更稳定行为约束的过程。|
| **Activation** | 把 validated PIArtifact 通过 ActivationDispatcher 实际生效（ADR-0006）。|
| **Pruning Signal** | 系统发现某个 Principle 可降级、隐藏、归档的**只读**信号。|
| **Pruning Review** | 人类对 Pruning Signal 的审计记录，写入 `.state/pruning_reviews.jsonl`（append-only）。|
| **Pruning Action** | 真正改变 Principle 生命周期的**写**动作。**当前未实现**，需独立 issue 推进。|
| **Approval** | 高风险通道激活的人工审批操作（ADR-0006）。|
| **RejectionFeedback** | 拒绝 Approval 后的结构化反馈，触发 Internalization Pipeline 优化（ADR-0006）。|
| **Shadow Mode** | code_tool_hook 通道激活后的 Offline Replay 观察期（ADR-0004 / ADR-0006）。|
| **Objective** | OKR 中的季度目标。Mission 的上层锚点。可选关联（Mission 可以是 standalone）。|
| **KeyResult** | Objective 的可量化关键结果。有 target / current / measurement_source。|
| **Mission** | 长程任务（数小时到数天）。包含多个 Run，跟踪 status/progress/blockers，可选关联 Objective。|
| **DecisionHygieneGate** | 在代理做高影响决策前强制触发的分析流程。high/critical 影响必须经过，其他为提醒。|
| **AgentManifest** | 内置代理的声明式清单（YAML）。包含 prompt、tools、preferred_runtimes、版本、评估指标。|
| **AgentSession（LRAS）** | Long-Running Agent Session。代理持续工作直到完成的会话模型，有检查点和自修复能力。|

**严禁混淆**：
- ❌ `Pruning Review` 当成 `Pruning Action`
- ❌ `Approval queued` 当成 `Activated`
- ❌ `Shadow mode active` 当成 `Live decision applied`

---

## 5. 状态机规范

状态必须**绑定具体 aggregate**。不允许跨对象复用同一状态名导致歧义。

### 5.1 Principle / Rule / Implementation 生命周期

| 状态 | 含义 | 谁能进入 |
|------|-----|---------|
| `candidate` | 新生成，未通过验证 | Diagnostician 输出 |
| `probation` | 试用 / 影子模式 | CandidateIntakeService |
| `active` | 正式生效 | ActivationDispatcher（含审批通过路径）|
| `archived` | 历史保留，不参与运算 | LedgerArchiveWriter |
| `deprecated` | 已被更优载体吸收 | Pruning Action（未实现）|

**转换规则**：

```
candidate ──intake──→ probation ──ActivationDispatcher──→ active
                                       │
                                       └──archive──→ archived
active ──pruning（未来）──→ deprecated
任意状态 ──Principle Rollback──→ probation（仅 console 操作）
```

### 5.2 Runtime V2 Task / Run / Candidate 状态

参见 ADR-0003 与 `GLOSSARY.md` §3。要点：

- `PDTaskStatus`：`pending → leased → succeeded | retry_wait | failed`
- `RunExecutionStatus`：`queued → running → succeeded | failed | timed_out | cancelled`
- 终态：Task 是 `succeeded` / `failed`；`retry_wait` **不是终态**
- 数据库 `principle_candidates.status` 的 `pending / consumed` 是 intake 阶段，**不是** Principle 生命周期状态

### 5.3 Pruning Review 状态

Pruning Review 是 append-only audit log，**不改变实体生命周期**。合法 decision：

- `keep`
- `defer`
- `archive-candidate`

这些是审计意图，**不是**实体状态。

### 5.4 Approval 状态（新增 — ADR-0006）

> 当前代码已实现的生产状态为 `pending / approved / rejected / cancelled`。
> `awaiting_second_confirmation` 与 `expired` 是 ADR-0006 目标状态，待后续 issue 落地；在实现前不得把它们当作可用生产状态。

| 状态 | 含义 |
|------|-----|
| `pending` | 待审批 |
| `awaiting_second_confirmation` | 目标状态：第一审批通过，等冷却期结束 |
| `approved` | 完全通过 |
| `rejected` | 已拒绝 |
| `expired` | 目标状态：TTL 过期未处理 |
| `cancelled` | 提交方主动取消 |

转换规则：

```
pending ──approve──→ awaiting_second_confirmation（仅 model_training）
                ──→ approved（其他通道）
              ──reject──→ rejected
              ──cancel──→ cancelled
              ──TTL──→ expired
awaiting_second_confirmation ──secondConfirm──→ approved
                              ──reject──→ rejected
```

### 5.5 PIArtifact 状态（新增 — ADR-0003 / ADR-0005）

`validationStatus`：

- `pending`：刚由 Runner 写入，未经验证
- `validated`：已通过下游 Validator
- `rejected`：被 Evaluator / RolloutReviewer 标记不可激活

不可逆：一旦 `validated`，不允许回退。

### 5.6 Shadow Mode 子状态（新增 — ADR-0004 / ADR-0006）

仅适用于 `code_tool_hook` 通道激活的 Implementation。

```
active + shadowMode=true（前 N 个调用周期）
   │ N 周期后 / 通过率合格
   ▼
active + shadowMode=false（live 模式）

或者：

active + shadowMode=true
   │ 误杀率超阈值 / 异常超过 N 次
   ▼
disabled（自动 deactivate）
```

---

## 6. 当前代码映射

| 领域概念 | 当前位置 | 目标位置 | 状态 |
|---------|--------|---------|------|
| Pain Signal | `packages/principles-core/src/runtime-v2/pain-to-principle-service.ts` | - | ✅ Done（ADR-0001）|
| Pain Chain Read Model | `packages/principles-core/src/runtime-v2/pain-chain-read-model.ts` | - | ✅ Done（ADR-0001）|
| Principle Schema | `packages/principles-core/src/runtime-v2/types/principle-schema.ts` | - | ✅ Done |
| LedgerPrinciple | `packages/principles-core/src/principle-tree-ledger.ts` | - | ✅ Done |
| Rule / LedgerRule | `packages/principles-core/src/runtime-v2/types/principle-schema.ts` | - | ✅ Done |
| Implementation Schema | `packages/principles-core/src/runtime-v2/types/principle-schema.ts` | - | ✅ Done |
| Evolution Types | `packages/principles-core/src/runtime-v2/evolution/evolution-types.ts` | - | ✅ Done |
| Nocturnal Trinity Types | `packages/principles-core/src/runtime-v2/nocturnal/nocturnal-trinity-types.ts` | 删除（ADR-0005）| ⏳ 迁移中 |
| Event Types | `packages/principles-core/src/runtime-v2/types/event-types.ts` | - | ✅ Done |
| Principle Tree Data Structures | `packages/principles-core/src/runtime-v2/types/` | - | ✅ Done |
| Code Implementation 文件 | `packages/openclaw-plugin/src/core/code-implementation-storage.ts` | - | 🔒 Keep in plugin（文件 IO）|
| RuleHost | `packages/openclaw-plugin/src/core/rule-host.ts` | `@principles/core` | ⏳ Pending（ADR-0002 PRI-45）|
| RuleHostInput / Result | `packages/principles-core/src/runtime-v2/internalization/rule-host-contracts.ts` | - | ✅ Done（PRI-42）|
| RuleHost Helpers | `packages/principles-core/src/runtime-v2/internalization/rule-host-helpers.ts` | - | ✅ Done |
| Lifecycle Metrics | `packages/principles-core/src/runtime-v2/internalization/lifecycle-metrics.ts` | - | ✅ Done |
| Routing Policy | `packages/principles-core/src/runtime-v2/internalization/routing-policy.ts` | - | ✅ Done（PRI-43）|
| Template Generator | `packages/principles-core/src/runtime-v2/internalization/template-generator.ts` | - | ✅ Done |
| Pruning Signal | `packages/principles-core/src/runtime-v2/pruning-read-model.ts` | - | ✅ Done |
| Pruning Review | `packages/principles-core/src/runtime-v2/pruning-review-log.ts` | - | ✅ Done |
| Diagnostician Recommendation | `packages/principles-core/src/runtime-v2/diagnostician-output.ts` | - | ✅ Done |
| **PIArtifact** | `packages/principles-core/src/runtime-v2/internalization/pi-artifact.ts` | - | ✅ Done（ADR-0003）|
| **7 Peer Runners** | `packages/principles-core/src/runtime-v2/internalization/*-runner.ts` | - | ✅ Done |

> **ADR-0014 Amendment (2026-06-11)**: The "7 Peer Runner" invariant refers to the
> Internalization Pipeline only. The Diagnostician Pipeline introduces a separate
> `DiagnosticianStageKind` type (diag_rootcause, diag_distiller, diag_router) that
> is NOT a PeerRunnerKind. The union type `RunnerKind = PeerRunnerKind | DiagnosticianStageKind`
> is used by the orchestrator for task dispatch, but the two pipelines remain
> architecturally distinct.

| **InternalizationOrchestrator** | `packages/principles-core/src/runtime-v2/internalization/internalization-orchestrator.ts` | - | ✅ Done |
| **CorrectionProposal** | `packages/principles-core/src/runtime-v2/internalization/correction-proposal.ts` | - | ✅ Done（ADR-0004）|
| **GoldenTrace** | `packages/principles-core/src/runtime-v2/golden-trace.ts` | - | ✅ Done |
| **IntakeToInternalizationBridge** | `packages/principles-core/src/runtime-v2/internalization/intake-to-internalization-bridge.ts` | - | ✅ Done（断点① 已解决）|
| **IdleTrigger** | `packages/principles-core/src/runtime-v2/idle-trigger/` | - | ⚠️ 退役目标（ADR-0012：不建立 host 调度适配）|
| **ActivationDispatcher** | `packages/principles-core/src/runtime-v2/activation/activation-dispatcher.ts` | - | ✅ Done（ADR-0006 基础版）|
| **ApprovalQueue** | `packages/principles-core/src/runtime-v2/activation/approval-queue.ts` | - | ✅ Done（基础 4 状态；二次确认/过期待扩展）|
| **ChannelWriter（5 个设计通道）** | `PromptWriter` / `DeferArchiveWriter` 已在 `activation/low-risk-writers.ts`；`RuleHostWriter` 已落地 | `SkillFileWriter` 为 MVP stretch；`TrainingExporter` deferred | ⏳ MVP proven-channel 已具备 |
| **Nocturnal-Trinity** | `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` | 删除 | ⏳ 删除中（ADR-0005）|
| **NocturnalArtifact** | plugin | 替换为 PIArtifact | ⏳ 迁移中（ADR-0005）|
| **BuiltInAgentRegistry（BALM）** | TBD | `packages/principles-core/src/runtime-v2/agents/` | ❌ 待建（ADR-0008）|
| **AgentManifest** | TBD | `packages/principles-core/src/runtime-v2/agents/agent-manifest.ts` | ❌ 待建（ADR-0008）|
| **AgentSession / LRAS** | TBD | `packages/principles-core/src/runtime-v2/session/` | ❌ 待建（ADR-0009）|
| **SessionCheckpoint** | TBD | `packages/principles-core/src/runtime-v2/session/session-checkpoint.ts` | ❌ 待建（ADR-0009）|
| **GAPSignalGenerator** | TBD | `packages/principles-core/src/runtime-v2/goals/gap-signal-generator.ts` | ❌ 待建（ADR-0010）|
| **ObjectiveStore** | TBD | `packages/principles-core/src/runtime-v2/goals/objective-store.ts` | ❌ 待建（ADR-0010）|
| **MissionStore** | TBD | `packages/principles-core/src/runtime-v2/goals/mission-store.ts` | ❌ 待建（ADR-0010）|
| **DecisionHygieneGate** | TBD | `packages/principles-core/src/runtime-v2/decision-hygiene/` | ❌ 待建（ADR-0010）|
| **MissionScheduler** | TBD | `packages/principles-core/src/runtime-v2/scheduler/mission-scheduler.ts` | ❌ 待建（ADR-0011）|

**迁移状态图例**：
- ✅ Done
- ⏳ Pending（迁移计划中）
- 🔒 Keep in plugin（基础设施绑定，永久保留）
- ❌ 待建（设计已定，未实现）

---

## 7. 命名禁区（强制）

详见 `GLOSSARY.md` §4。摘要：

**严禁**作为代码 / Schema / Linear issue / ADR 的核心实体名：

- `Law`, `Doctrine`, `Guideline`, `WisdomItem` —— 应为 `Principle`
- `MemoryRule`, `PolicyRule` —— 应为 `Rule`
- `ConstraintCode` —— 应为 `Implementation(type=code)`
- `PendingPrinciple` —— 区分 `candidate`（业务）vs `pending`（DB intake）
- `PainEvent`, `PainFlag` —— 应为 `PainSignal`
- `Subagent Runner` —— 应为 `Peer Runner`（ADR-0003）
- `RuleImplementationArtifact` —— 应为 `PIArtifact`（ADR-0005）
- `NocturnalArtifact` —— 已弃用（ADR-0005）
- `Trinity` —— 已弃用（ADR-0005），用 `Internalization Pipeline`
- `Internalization Route` —— 应为 `Internalization Channel`（ADR-0006）

UI 文案可使用同义词；**代码、Schema、ADR、issue title 必须使用本文标准词。**

---

## 8. 后续重构方向

后续推荐的重构顺序：

1. ✅ **本文档锁定**：作为 LOCKED ontology，在 ADR / ARCHITECTURE / Linear 模板中引用
2. ⏳ **架构守护测试**：保护本文档存在，禁止新增非标准术语
3. ⏳ **类型迁移到 core**：Principle / Rule / Implementation 的 canonical type 完整迁入 `@principles/core`（ADR-0002 PRI-45）
4. ⏳ **完成 Nocturnal 合并**：删除冗余实现，对齐 PIArtifact 模型（ADR-0005）
5. ⏳ **激活流水线收敛**：ActivationDispatcher + prompt/defer_archive + RuleHostWriter 已完成；SkillFileWriter 仅在需求验证后评估，TrainingExporter 不在 MVP（ADR-0014）
6. ⏳ **审批 UI**：pd-console `/approvals` 基础版已完成；RejectionFeedback、二次确认、审批历史待建（ADR-0006 + ADR-0007）
7. ❌ **Pruning Action**：从 ReadModel 推进到真正的 mutation（独立 issue）
8. ❌ **BALM**：内置代理生命周期管理，声明式 AgentManifest（ADR-0008）
9. ❌ **LRAS**：长程代理会话，检查点 + 自校验工具（ADR-0009）
10. ❌ **GAP + Goals**：Mission/Objective 数据模型 + GAP 信号生成器（ADR-0010）
11. ❌ **MissionScheduler**：三层任务调度，替代 polling 模型（ADR-0011）

---

## 9. 与 ADR / 其他文档的关系

| 文档 | 关系 |
|------|-----|
| [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) | 架构总览，引用本文术语 |
| [`GLOSSARY.md`](./GLOSSARY.md) | 词典，本文是建模 |
| [`INTERNALIZATION_PIPELINE.md`](./INTERNALIZATION_PIPELINE.md) | Pipeline 设计，使用本文术语 |
| [`ACTIVATION_CHANNELS.md`](./ACTIVATION_CHANNELS.md) | 通道详细，扩展本文 §3 |
| [`COMPONENTS.md`](./COMPONENTS.md) | 组件目录，引用本文实体 |
| [ADR-0001](../adr/0001-runtime-v2-service-boundaries.md) | 服务边界 |
| [ADR-0002](../adr/0002-hard-internalization-core-boundary.md) | Hard internalization 边界 |
| [ADR-0003](../adr/0003-peer-agent-state-machine-orchestration.md) | Peer Agent 状态机（PIArtifact 起源）|
| [ADR-0004](../adr/0004-l2-auto-correction-and-replay.md) | L2 自动校正与 GoldenTrace |
| [ADR-0005](../adr/0005-nocturnal-internalization-merger.md) | Nocturnal 合并（NocturnalArtifact 弃用）|
| [ADR-0006](../adr/0006-hybrid-activation-mechanism.md) | 5 通道混合激活（Approval 等概念引入）|
| [ADR-0007](../adr/0007-cli-vs-console-audience-separation.md) | cli / console 受众分离 |

---

> **架构师批注**：
>
> Principle 是 PD 的管理核心。
> Rule 是 Principle 的实操化投影。
> Implementation 是 Rule 的行为承载物。
> PIArtifact 是 Internalization Pipeline 中流转的不可变工件。
>
> 五通道是从抽象到具象的渐进路径。
> 痛苦是输入流，激活是输出流，原则是中间形态，知识是最终沉淀。
>
> **后续所有重构应减少这几个概念之间的歧义，而不是发明平行概念。**
