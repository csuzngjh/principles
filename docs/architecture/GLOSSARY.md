# PD 标准术语词典（Glossary）

## PD v2 术语增补（2026-10-07，待既有 ontology 评审）

决定见 [ADR-0027](../adr/0027-principle-intervention-evidence-and-delivery-contract.md)、[ADR-0028](../adr/0028-owner-principle-assets-and-evolution.md)。阶段见 [DOMAIN_MODEL](DOMAIN_MODEL.md)，术语登记不证明已实现。

| 层次 | 术语 | 含义 |
| --- | --- | --- |
| Current Implementation | Principle identity / task_outcomes | 既有账本身份 / 任务完成观察，原义保留 |
| Phase 1 Added Concepts | Delivery Evidence | 投递尝试、结果、确认程度；不是应用证明 |
| Phase 1 Added Concepts | Application Evidence | 自述与 Runtime 实际执行分开 |
| Phase 1 Added Concepts | Behavior Episode | 有来源、有边界的行为片段，proposal 不是事实 |
| Phase 1 Added Concepts | Effect Evidence | 关联版本及 Episode 的观察，不是有效性结论 |
| Phase 1 Added Concepts | Outcome Observation | 后续结果或 Owner 反馈，不是自动价值判断 |
| Future Target Model | Revision / Binding | 不可变正式版本 / 显式授权；观察引用不等于新正式版本 |
| Future Target Model | Evaluation / Owner Asset Layer | 可复核解释 / Owner 资产权威；本期不建设 |

实体身份、内容身份与修复过程 RevisionIdentity 分开。Unknown 是证据不足；Failed 是运行失败；Invalidated 是证据作废。没有“无记录即原则无效”的推断。

> **状态**: LOCKED-ONTOLOGY（强制执行）
> **最后更新**: 2026-05-15
> **定位**: PD 项目的**唯一权威术语表**。所有代码、Schema、ADR、设计文档、Linear Issue 必须使用本表中的标准词。
> **变更规则**: 新增/修改术语必须通过 PR 修改本文档，并同步修订所有受影响的文档与代码。

本词典分为以下部分：
1. 核心领域术语（Domain Terms）
2. 技术架构术语（Technical Terms）
3. 流水线与生命周期术语（Pipeline Terms）
4. 命名禁区（Forbidden Names）
5. 弃用映射（Deprecated → Canonical）

---

## 1. 核心领域术语

### Pain Signal（痛苦信号）

用户与宿主执行任务时，宿主行为**相对于当时用户预期、意图和适用的 PD 原则出现偏差**的触发与积累信号。是 PD 演化的原始输入。偏差是相对关系，不是脱离上下文的绝对对错：任务失败不自动构成 Pain，任务完成也可能存在偏差（任务结果、工具调用、伦理标签、安全风险等事实只有结合期望与上下文，才可能成为偏差的证据）。术语权威定义见 [SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001 §2.1](../specs/SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md)（2026-11-17 R0 修正，替代旧表述"结构化失败事件"；旧表述仅存于历史文档，不改写任何历史数据）。

| 字段 | 标准 | 说明 |
|-----|------|------|
| 数据类型 | `PainSignal` | TypeBox schema 定义于 `packages/principles-core/src/pain-signal.ts`（内部模块） |
| 唯一标识 | `painId` | 由捕获方生成的 UUID |
| 严重等级 | `low / medium / high / critical` | 由 `score (0-100)` 派生 |
| 来源 | `tool_failure / subagent_error / user_frustration / ...` | 字段名 `source`；值只表示捕获来源，不表示失败语义；GFI 已于 2026-11-04 退役，不再有 GFI 评分文档 |

**禁止使用**：~~Pain Event~~、~~Pain Flag~~（已废弃，仅历史代码保留）、~~PainDetected~~（仅作为内部事件类型名）

### Principle（原则）

PD 系统的最高层管理对象。**高泛化、跨场景、可复用**的价值判断或经验提炼。

- 数据载体：自然语言为主
- 状态枚举：`candidate → probation → active → archived → deprecated`
- 主键：`principleId`（如 `P_001`）
- 类型分类：`Core Principle` / `Domain Principle` / `Scenario Principle`
- 详见：`DOMAIN_MODEL.md` §1-2

**禁止使用**：~~Law~~、~~Doctrine~~、~~Guideline~~、~~Wisdom~~

### Rule（规则）

Principle 在**特定场景下的可验证表达**。是原则树的"树干"层。

- 必须绑定一个 `principleId`
- 必须有 `triggerCondition` 和 `enforcement`（block / warn / log / requireApproval / propose_correction）
- 主键：`ruleId`（如 `R_001_a`）
- 详见：`DOMAIN_MODEL.md` §2.3-2.4

**禁止使用**：~~PolicyRule~~（除非作为 Rule 的子类型明确说明）、~~ConstraintCode~~

### Implementation（实现）

Rule 的**具体行为承载物**。是原则树的"树叶"层。

- 类型枚举：`code` / `prompt` / `skill` / `lora` / `test`
- 必须绑定一个 `ruleId`
- 同一 Rule 同一时间最多一个 `active` Implementation
- 生命周期：`candidate → active → disabled → archived`
- 主键：`implId`

**禁止使用**：~~RuleCode~~（仅指 type=code 的特例）

### Internalization Channel（内化通道）

Principle 通过哪种**载体形式**被内化到代理行为中。

| 通道 ID | 中文 | 内化等级 | 激活策略 |
|--------|------|---------|---------|
| `prompt` | 提示词通道 | L1（软内化） | 全自动 |
| `skill` | 技能通道 | L1.5 | 默认自动，可配置审批 |
| `code_tool_hook` | 代码钩子通道 | L2（硬内化） | 必须人工审批 |
| `model_training` | 模型训练通道 | L3（参数化） | 必须人工审批 + 二次确认 |
| `defer_archive` | 延迟归档通道 | N/A | 全自动 |

**禁止使用**：~~Internalization Route~~（旧名，已统一为 channel）、~~Activation Type~~

### Pain Chain（痛苦链）

一个 `painId` 从捕获到生效的**完整证据链**。

```
painId → taskId → runId → artifactId → candidateId → ledgerEntryId
```

由 `PainChainReadModel` 提供查询接口。

### Internalization Pipeline（内化流水线）

从 probation 候选到 validated PIArtifact 的**多阶段执行链**。包含 7 个 Peer Runner：Dreamer → Philosopher → Scribe → Artificer → Evaluator → RolloutReviewer → Trainer。

详见：ADR-0003、`INTERNALIZATION_PIPELINE.md`

### Activation Pipeline（激活流水线）

从 validated PIArtifact 到代理行为生效的**调度路由链**。详见：ADR-0006、`ACTIVATION_CHANNELS.md`

### Pruning Signal（修剪信号）

`PruningReadModel` 发出的**只读建议**，提示某个 Principle 可能可降级、归档或复审。

**注意**：`PruningSignal` ≠ `PruningAction`。
- `PruningSignal`：只读，定期生成
- `PruningReview`：append-only 审计日志，记录人类审查意图
- `PruningAction`：真正改变 Ledger 的写操作（**当前未实现**）

---

## 2. 技术架构术语

### Peer Runner（对等运行器）

Internalization Pipeline 中的执行单元。**所有 Runner 都是对等的**，无主从关系。

7 个标准 Runner：
- `dreamer`：候选生成
- `philosopher`：原则精炼
- `scribe`：原则文档化
- `artificer`：实现计划
- `evaluator`：评估打分
- `rollout_reviewer`：发布决策
- `trainer`：训练数据生成（仅 model_training 通道）

**禁止使用**：~~Subagent~~、~~Worker Agent~~、~~Slave Runner~~

### Runtime Adapter（运行时适配器）

`PDRuntimeAdapter` 接口的具体实现，**封装一个 LLM 调用后端**。

已实现：
- `PiAiRuntimeAdapter`（直接 API；ADR-0029 后唯一的内部代理后端）
- `TestDoubleRuntimeAdapter`（测试替身）

未来：Codex CLI、Gemini CLI

**禁止使用**：~~LLM Backend~~、~~Provider~~（保留作为 adapter 的内部字段名）

### TaskRecord / RunRecord / PITaskRecord

PD 的核心状态对象，三个层级：

| 类型 | 定义位置 | 说明 |
|------|---------|------|
| `TaskRecord` | `task-status.ts` | 通用任务记录基类 |
| `PITaskRecord` | `peer-runner-contracts.ts` | 内化任务，extends TaskRecord，加 channel/dependencyTaskIds 等 |
| `RunRecord` | `runtime-protocol.ts` | 一次具体的 Runner 执行尝试。`1 Task : N Runs` |

**禁止使用**：~~PDTask~~（旧名，仅 plugin/pd-task-types.ts 保留兼容）、~~EvolutionTask~~（已废弃）

### PIArtifact（内化产物）

Internalization Pipeline 中**每个 Runner 的结构化产物**。

- 字段：`artifactId / artifactKind / sourceTaskId / lineageRefs / validationStatus`
- 可能的 kind：`principle / rule / training_data / skill / patch`
- 存储：通过 `PIArtifactStore`，幂等键为 `sourceTaskId + artifactKind`

**禁止使用**：
- ~~RuleImplementationArtifact~~（旧设计，已被 PIArtifact 涵盖）
- ~~NocturnalArtifact~~（合并后已废弃，旧代码逐步迁移）

### Ledger（账本）

PD 的**原则树持久化文件**，`{workspace}/.state/principle_training_state.json`。

- 顶层结构：`{ trainingStore, _tree: { principles, rules, implementations, metrics } }`
- 由 `@principles/core/principle-tree-ledger.ts` 独占写入
- 写入必须通过 `mutateLedger()` 函数（自动原子写入）

**禁止使用**：~~PrincipleTreeStore~~（旧名）、~~PrinciplesDB~~

### LedgerPrincipleEntry

候选原则被 `CandidateIntakeService` 摄入后写入 Ledger 的**第一条记录**。

- status 默认为 `probation`
- 必须有 `sourceRef`（candidate URI）和 `artifactRef`（artifact URI）
- 11 个标准字段，详见 `candidate-intake.ts`

### State Store / SQLite

PD 的**统一状态数据库**，`{workspace}/.pd/state.db`。

包含的逻辑表：
- `tasks` / `runs` / `commits` / `candidates` / `artifacts`
- `history` / `trajectory` / `pi_artifacts`
- `events`（TelemetryEvent 流）

由 `RuntimeStateManager` 管理，所有 Store 共享一条 `SqliteConnection`。

**禁止使用**：~~PDDatabase~~、~~runtime.db~~（已统一为 state.db）

### Hook（钩子）

`openclaw-plugin` 提供给 OpenClaw Gateway 的**事件回调点**。

PD 当前接入的 hook：
- `before_prompt_build`
- `before_tool_call` / `after_tool_call`
- `llm_output`
- `subagent_ended` / `subagent_spawning`
- `before_reset` / `before_compaction` / `after_compaction`

**禁止使用**：~~Plugin Event~~、~~Listener~~（保留 EventEmitter 内部使用）

### IdleTrigger（空闲触发器，已废止）

历史上的 OpenClaw 空闲/夜间调度策略。根据 ADR-0012，它不是 PD 的目标能力，不能再作为新功能入口；执行应由 PD-owned config/SDK/operator 或 host-agnostic scheduler 显式触发。

- 由 `openclaw-plugin` 拥有，**绝对不在 core 中实现 cron / setInterval**
- 触发依据：工作区空闲、cron、heartbeat、文件变化
- 详见：ADR-0003 §2

**禁止使用**：~~Scheduler~~、~~CronManager~~（旧实现，已废弃）

---

## 3. 流水线与生命周期术语

### 五条核心数据流

| 标准名 | 简称 | 说明 |
|--------|-----|------|
| Pain Pipeline | 痛苦流水线 | PainSignal → Diagnostician → Candidate → Ledger |
| Internalization Pipeline | 内化流水线 | probation → 7 Peer Runners → PIArtifact |
| Activation Pipeline | 激活流水线 | PIArtifact → 5 Channel Dispatcher → 实际生效 |
| Operations Pipeline | 运维流水线 | ReadModels + 写 API + 审批 UI |
| Pruning Pipeline | 修剪流水线 | PruningReadModel → ReviewLog → Action |

**禁止使用**：~~Evolution Loop~~（旧术语过于模糊）、~~Reflection Pipeline~~

### Principle 生命周期状态

| 状态 | 含义 |
|-----|------|
| `candidate` | 新生成，未通过验证 |
| `probation` | 试用/影子模式，注入 prompt 但不强约束 |
| `active` | 正式生效 |
| `archived` | 历史保留，不参与运算 |
| `deprecated` | 已被更优内化吸收，正式退出 |

**禁止使用**：~~pending~~（仅 candidate intake 阶段使用，不是 Principle 生命周期状态）

### TaskStatus（PDTaskStatus）

`pending → leased → succeeded | retry_wait | failed`

终态：`succeeded` / `failed`。`retry_wait` **不是终态**。

### RunExecutionStatus

`queued → running → succeeded | failed | timed_out | cancelled`

注意：`running` 属于 `RunExecutionStatus`，**不属于** `PDTaskStatus`。

### 内化等级 L1/L2/L3

| 等级 | 通道 | 别名 | 上下文成本 |
|------|------|------|-----------|
| L1 | prompt | 软内化 | 高 |
| L1.5 | skill | 软内化（半结构化） | 中 |
| L2 | code_tool_hook | 硬内化 | 低 |
| L3 | model_training | 模型参数化 | 极低 |

详见：`DOMAIN_MODEL.md` §3、`PD_System_Dynamics_Model.md` §4

### PD-Lab（行为实验基础设施）

回答「设计是否真的**改变了 Agent 行为**、且改变方向符合预期」的实验路径，而不是「代码是否按设计执行」。单元测试只证明代码在跑；只要一个改动声称「让 Agent 做得更好 / 更安全 / 更符合意图」，其行为主张只能由 PD-Lab 的机械化证据支撑：预注册 + A/B 双臂 + 盲评 + 可复算证据。PD-Lab **复用**既有 Runner / Evaluator / Evidence / Report 能力，不自建第二套执行或证据系统。

| 字段 | 标准 | 说明 |
|-----|------|------|
| 当前版本 | v0.3 | 设计权威为 SPEC / TECH / CONTRACT v0.3；使用纪律见使用指南 |
| 判定词汇 | `REQUIRED / NOT_REQUIRED / BLOCKED` | PR 的 PD-Lab Impact 字段；「必须评估」≠「必须执行完整实验」 |
| 结果词汇 | `PASS / PASS_WITH_LIMITATIONS / BLOCKED / NOT_RUN` | 四者不得混用；`BLOCKED` 不得描述为 `PASS` |
| 命令入口 | `npm run lab:*` | 与根 `package.json` 脚本一一对应 |

**禁止使用**：~~Evolution Loop~~、~~Auto Benchmark~~（把行为实验说成自动评分仪式）

详见：[SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.3 §1–§2](../specs/SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md)、[TECH v0.3](../specs/TECH-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md)、[CONTRACT-PD-LAB-DATA-AND-SCORING-001 v0.3](../specs/CONTRACT-PD-LAB-DATA-AND-SCORING-001-v0.3.md)、使用指南 [PD-LAB-USAGE.md](../process/PD-LAB-USAGE.md)

### 实验臂（Experiment Arm）

A/B 双臂实验中的一臂：`baseline`（参照侧）与 `candidate`（被验证侧）。两臂**唯一允许的差异**必须能一句话说清；多于一个差异即实验设计缺陷。臂身份由实验配置显式声明，并贯穿 Metrics、盲评包、汇总与决策输入——**不得**按字母序、目录名或运行顺序推断基线。

| 字段 | 标准 | 说明 |
|-----|------|------|
| 标准名 | arm | 单臂为 `arm`，两臂合称 A/B 双臂 |
| 身份映射 | `blindmap` | `arm → 盲评标识` 的映射；只存在于非盲材料中 |
| 执行入口 | `lab:run`（grid 驱动单臂 `ab-run`） | 不是自建执行器 |

**禁止使用**：~~group~~、~~treatment/control~~（借用医学统计词汇，与臂身份映射语义冲突）

详见：[SPEC v0.3 §12「两臂身份映射」](../specs/SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md)、[PD-LAB-USAGE.md §6](../process/PD-LAB-USAGE.md)

### 盲评包（Blind Pack）

移除臂身份后的可比材料，供 Owner 盲评或裁判模型阅读；生成时复用 `ab-blindpack` 的泄露扫描，**泄露即拒绝**。臂身份只保存在 `blindmap` 中，绝不进入盲评材料本身；解盲只能发生在评分记录落盘之后。

| 字段 | 标准 | 说明 |
|-----|------|------|
| 生成入口 | `npm run lab:blindpack` | 只读，无外部调用 |
| 判官包 | `buildJudgePackage` / `swapJudgePackage` | 后者做 A/B 位置交换，`secretBinding` 携带 `displayOrder` 与 `identityMap` |
| 抽查 | `owner-spotcheck-list.mjs` | 确定性抽取 ≥20% 盲包给 Owner 复核（须 D5） |

**禁止使用**：~~anonymous sample~~、~~sealed set~~（都不表达「同一案例、仅去身份」这一语义）

详见：[SPEC v0.3 §8](../specs/SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md)、[PD-LAB-USAGE.md §6.1](../process/PD-LAB-USAGE.md)

### 裁判协议（Judge Protocol，`jp-pd-lab@1`）

冻结的**纯函数**协议模块（`judge-protocol.mjs`）：不调用模型、不碰网络/文件系统/时钟。它把盲包、位置交换绑定与裁判原始响应，组装成一条可校验的协议记录：原始响应严格解析为 `A_BETTER / TIE / B_BETTER / UNKNOWN`（非法输出拒绝，绝不降级为 `TIE`；`UNKNOWN` 必须带 reason），`comparisonInputDigest` 从盲包重算，身份绑定下才还原 candidate/reference 判定。

| 字段 | 标准 | 说明 |
|-----|------|------|
| 协议版本 | `jp-pd-lab@1` | 与 `lab:eval`（旧版百分制评分器）不是同一证据 |
| 校验入口 | `npm run lab:judge-validate` | 结构 / 绑定 / 篡改负控；不产生裁判响应 |
| 聚合入口 | `npm run lab:card` | 冻结计划 + 裁判记录 → `decision-input.json` |

**禁止使用**：~~AI 打分~~、~~auto judge~~（协议本身不调用任何模型，谁当裁判是协议外的执行决策）

详见：[CONTRACT v0.3 §5.1](../specs/CONTRACT-PD-LAB-DATA-AND-SCORING-001-v0.3.md)、[TECH v0.3 §6.6](../specs/TECH-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md)、[PD-LAB-USAGE.md §6.1](../process/PD-LAB-USAGE.md)

### T6 资格判定（T6 Qualification）

对 T6（回顾性历史管道实验）的证据输入做**机械判定**：输出三态 `CONFIRMATORY_READY / EXPLORATORY_ONLY / BLOCKED` 与 `t6Permissions`。判定是输入的纯函数，可机械复算，**不得人工改写**；`lab:qualify` 只复算 D2/D5/D6 三类审批绑定，不构成完整的 D2–D6 运行授权。T6 的结论只覆盖「当前 Intent 对历史案例重新诊断的影响」，不得解释为历史行为违反当时意图，也不得外推为真实宿主长期行为改善。

| 字段 | 标准 | 说明 |
|-----|------|------|
| 输入 | `qualification-input.json` | 手工按 `validateQualificationInput` 组装，无自动生成器 |
| 输出 | `qualification.json` | 三态结论 + `t6Permissions` + 审计记录 |
| 前置 | `lab:probe` / `lab:preflight` | 预检通过**不等于**有运行资格 |

**禁止使用**：~~qualification score~~、~~T6 pass rate~~（资格是三态判定，不是分数或通过率）

详见：[SPEC v0.3 §11.2](../specs/SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md)、[PD-LAB-USAGE.md §4–§5](../process/PD-LAB-USAGE.md)

---

## 4. 命名禁区

以下名字**不得**作为代码、Schema、Linear Issue、ADR 中的核心实体名。如果只是 UI 展示文案可以使用。

| 禁用名 | 原因 | 应该用什么 |
|--------|------|-----------|
| `Law` | 与 Principle 重复 | `Principle` |
| `Doctrine` | 与 Principle 重复 | `Principle` |
| `Guideline` | 与 Principle 重复 | `Principle` |
| `WisdomItem` | 与 Principle 重复 | `Principle` |
| `MemoryRule` | 与 Rule 概念冲突 | `Rule` |
| `ConstraintCode` | 与 Implementation(type=code) 重复 | `Implementation` |
| `PolicyRule` | 太宽泛 | `Rule` 或 `Implementation(type=hook)` |
| `PendingPrinciple` | 状态混淆 | 业务用 `candidate`，DB 用 `pending` |
| `PainEvent` | 与 PainSignal 重复 | `PainSignal` |
| `PainFlag` | 已废弃概念 | `PainSignal` |
| `Subagent Runner` | 与 Peer Runner 矛盾 | `Peer Runner` |
| `RuleImplementationArtifact` | 与 PIArtifact 重复 | `PIArtifact` |
| `NocturnalArtifact` | 合并后已废弃 | `PIArtifact` |
| `Trinity` | 旧实现术语 | `Internalization Pipeline`（合并后） |
| `Evolution Engine` | 太宽泛 | 具体到 `EvolutionPointsEngine` 或 `InternalizationOrchestrator` |
| `Cron Job`（PD 内部用） | 与平台 cron 混淆 | `PD Scheduler` / `explicit schedule` |
| `LLM Provider`（作为顶层抽象） | 与 RuntimeAdapter 冲突 | `RuntimeAdapter` |

---

## 5. 弃用映射（Deprecated → Canonical）

历史代码中的旧名称，应在重构时改名。本表用于辅助代码搜索和审计。

| 旧名 | 当前代码位置 | 应改为 | 迁移状态 |
|------|------------|-------|---------|
| `PainEvent` | 部分 plugin/event-types | `PainSignal` | 进行中 |
| `PainFlag` / `PainFlagData` | plugin/core/pain-signal.ts | `PainSignal` | 进行中 |
| `PrincipleTreeStore` | 旧文档 | `Ledger` / `LedgerTreeStore` | 已完成 |
| `EvolutionTask` | 旧文档 / pd-task-* | `TaskRecord` + `taskKind` | 进行中 |
| `NocturnalArtifact` | plugin/core/nocturnal-arbiter.ts | `PIArtifact` | 待 ADR-0005 落地 |
| `TrinityDraftArtifact` | plugin/core/nocturnal-trinity.ts | `DreamerOutput` | 待 ADR-0005 落地 |
| `RuleImplementationArtifact` | 旧设计文档 | `PIArtifact(kind=rule)` | 已完成（仅文档保留旧名） |
| `Internalization Route` | 旧文档 | `Internalization Channel` | 进行中 |
| `Soft Internalization` / `Hard Internalization` | 用作描述可以 | 代码中使用 `L1` / `L2` | 已完成 |
| `Trust Engine` | plugin/core | 已删除（使用 `EvolutionPointsEngine`） | 已完成 |
| `Subagent` | OpenClaw 概念，在 PD 内部禁用 | `Peer Runner` 或具体 Runner 名 | 进行中 |

---

## 6. 标识符约定

### 6.1 业务 ID 前缀

| 前缀 | 含义 | 示例 |
|-----|------|------|
| `P_` | Principle | `P_001`, `P_runtime_v2_boundary` |
| `R_` | Rule | `R_001_a` |
| `IMPL_` | Implementation | `IMPL_001_a_hook` |
| `pain_` | PainSignal | `pain_<uuid>` |
| `task_` | TaskRecord | `task_<uuid>` |
| `run_` | RunRecord | `run_<taskId>_<attempt>` |
| `art_` / `pi-art-` | Artifact | `pi-art-<taskId>-<runId>` |
| `cand_` | Candidate | `cand_<uuid>` |

### 6.2 URI Schemes

PD 内部用的 URI scheme（用作 `sourceRef` / `artifactRef` 等字段）：

| Scheme | 解析为 | 示例 |
|--------|-------|------|
| `pain://` | PainSignal | `pain://abc-123` |
| `task://` | TaskRecord | `task://diagnosis_abc` |
| `candidate://` | Candidate | `candidate://uuid-...` |
| `artifact://` | Artifact | `artifact://uuid-...` |
| `commit://` | DiagnosticianCommit | `commit://uuid-...` |
| `ledger://` | LedgerPrincipleEntry | `ledger://P_001` |
| `dreamer://` / `philosopher://` / ... | Runner 输出 | `dreamer://run-id` |

---

## 7. 错误类别（PDErrorCategory）速查

详见 `ERROR_ARCHITECTURE.md`。这里只列出标准名称，禁止发明同义词：

`runtime_unavailable / capability_missing / input_invalid / lease_conflict / lease_expired / execution_failed / timeout / cancelled / output_invalid / artifact_commit_failed / max_attempts_exceeded / context_assembly_failed / history_not_found / trajectory_ambiguous / storage_unavailable / workspace_invalid / query_invalid`

---

## 8. 索引

| 看到这个词 | 跳到 |
|----------|------|
| Pain Signal / PainSignal | §1 |
| Principle / Rule / Implementation | §1, `DOMAIN_MODEL.md` |
| Channel | §1 |
| Peer Runner | §2 |
| Runtime Adapter | §2 |
| TaskRecord / RunRecord / PITaskRecord | §2 |
| PIArtifact | §2 |
| Ledger | §2 |
| Pipeline | §3 |
| L1/L2/L3 | §3 |
| PD-Lab / 行为实验 | §3, `docs/process/PD-LAB-USAGE.md` |
| 实验臂 / arm / baseline / candidate | §3 |
| 盲评包 / blindmap | §3 |
| 裁判协议 / jp-pd-lab@1 | §3 |
| T6 资格判定 / CONFIRMATORY_READY | §3 |
| 禁用名 | §4 |
| 弃用映射 | §5 |
| ID 前缀 / URI scheme | §6 |
| Error 名 | §7 |
