# PD 架构总览（PD Architecture Overview）

> **状态**: Active / SSoT-ENTRY-POINT
> **最后更新**: 2026-05-15
> **定位**: 整个 PD 项目的**唯一架构入口文档**。任何架构相关的疑问，先来这里。
> **一致性约束**: 本文档是 SSoT（Single Source of Truth）。其他架构文档必须与本文一致；冲突时以本文为准，并通过 PR 同步修订。

本文档回答四个问题：
1. PD 是什么？
2. PD 由哪些子系统构成？
3. 数据如何在子系统之间流转？
4. 想了解某个细节，应该读哪份文档？

---

## 1. PD 是什么

**Principles Disciple（PD）** 是一个面向 AI 编程代理的**原则演化框架**。它捕获代理执行过程中的失败信号（痛苦），把失败提炼为可复用的原则（Principle），再把原则**内化**为更稳定、更低成本的行为约束（Prompt / Skill / Hook 代码 / 模型参数），最终改变代理的实际行为。

PD 的核心循环：

```
痛苦信号  ──→  诊断  ──→  原则候选  ──→  内化流水线  ──→  激活生效
   ▲                                                          │
   └──────────────────  代理行为改变  ←──────────────────────┘
```

PD 的设计哲学：

- **行动品格优先于单次成功率** —— PD 不追求局部任务最优，追求长期稳定行为
- **最便宜的内化方式优先** —— `prompt < code < model_training < fine-tune`
- **代理是日常用户，人是审核员和风险责任人** —— 全自动是目标，人工保留在高风险路径
- **人在回路最低化但不可缺位** —— L2/L3 高风险通道必须有人工审核
- **目标对齐优先于局部优化** —— 代理的每个行动应能追溯到 Objective，偏离目标才是真正的痛苦
- **长程自主优先于短任务轮询** —— 内置代理应持续工作直到完成，而非被超时切碎

---

## 2. 系统边界与四大交付物

PD 是一个 monorepo，由四个独立可交付的包构成。每个包有清晰的职责边界，包之间只允许**单向依赖**。

### 2.1 包依赖关系（强约束）

```
                    ┌──────────────────────┐
                    │   @principles/core   │
                    │  （Domain & Runtime） │
                    └──────────┬───────────┘
                               │ 单向依赖
            ┌──────────────────┼──────────────────┐
            │                  │                  │
   ┌────────▼─────────┐ ┌──────▼──────┐ ┌────────▼──────────┐
   │  openclaw-plugin │ │ @principles │ │  @principles/     │
   │   （Host Adapter）│ │   /pd-cli   │ │    pd-console     │
   │                  │ │  （for AI）  │ │     （for Human）  │
   └──────────────────┘ └─────────────┘ └───────────────────┘
```

**强约束（CI 守护，违反即拒）**：
- `@principles/core` 不得反向依赖任何包
- `openclaw-plugin` / `pd-cli` / `pd-console` 之间不得相互依赖
- 任何 host-specific 代码（OpenClaw API、Codex CLI 等）只能存在于 `openclaw-plugin` 或将来其他 adapter 包

### 2.2 四大交付物职责矩阵

| 包 | 角色 | 主要受众 | 进程模型 | 拥有 | 不拥有 |
|----|------|---------|---------|------|--------|
| `@principles/core` | Domain & Runtime SDK | 其他包 | Library | 业务领域、状态机、Runner、Store、Read Model、Schema、**BALM（代理生命周期管理）**、**LRAS（长程会话）**、**GAP（目标驱动信号）**、**MissionScheduler** | 任何宿主 API、UI、CLI |
| `openclaw-plugin` | Host Adapter | OpenClaw Gateway | Plugin in-proc | Hook 桥接、PainSignal 捕获、Runtime Adapter 注册、IdleTrigger 宿主调度适配、**新 CLI Adapter（Claude Code/Codex/Gemini 等）** | 业务规则、原则生命周期、Runner 实现 |
| `@principles/pd-cli` | Agent Operator | AI 代理 (OpenClaw / Codex / Gemini) | Stdout-driven CLI | 结构化 JSON 接口、读侧查询、低风险写操作、**PD 元工具（pd_validate_output / pd_fetch_recent_logs 等）** | 高风险审批、长连接 UI |
| `@principles/pd-console` | Human Operator | 开发者 / 运维 / 研究员 | Local Web Server | 可视化 UI、人工审批工作流、长任务流式输出、**Mission/Objective 视图**、**Agent 健康面板** | 业务规则 |

### 2.3 三个独立 deliverable 共用同一个 core

- **同一份 SQLite 数据库**（`{workspace}/.pd/state.db`）
- **同一份 Ledger 文件**（`{workspace}/.state/principle_training_state.json`）
- **同一份 PIArtifact Store**

但读写规则不同：

```
                  ┌──────────────┐
                  │  state.db    │
                  │  ledger.json │
                  │  artifacts/  │
                  └──┬─────┬──┬──┘
                     │     │  │
        ┌────────────┘     │  └────────────┐
        │ 读+写            │ 读+部分写       │ 读+部分写（含审批）
   ┌────▼────┐       ┌────▼─────┐     ┌────▼──────┐
   │ Plugin  │       │  pd-cli  │     │ pd-console│
   └─────────┘       └──────────┘     └───────────┘
```

写操作的并发安全由 `@principles/core` 内部的 `LeaseManager` + 原子写入保证（详见 `DATA_ARCHITECTURE.md`）。

---

## 3. 四层架构

PD 采用**四层架构**。从上到下：

```
┌────────────────────────────────────────────────────────────────────┐
│  Layer 4: Surface（表面层）                                         │
│  ┌────────────────────┐  ┌────────────────────┐                    │
│  │ pd-cli（for Agent）│  │ pd-console（for 人） │  ← 用户/代理交互   │
│  └────────────────────┘  └────────────────────┘                    │
└────────────────────────────────────────────────────────────────────┘
                              ▲
┌────────────────────────────────────────────────────────────────────┐
│  Layer 3: Host Integration（宿主集成层）                            │
│  ┌────────────────────────────────────────────────┐                │
│  │ openclaw-plugin                                 │                │
│  │  - Hooks (pain/gate/prompt/llm/lifecycle)      │ ← 平台桥接     │
│  │  - IdleTrigger 宿主调度适配（核心策略在 core/idle-trigger/）│
│  │  - RuntimeAdapter (OpenClaw / Claude Code /    │                │
│  │    Codex / Gemini / opencode / Hermes 等)      │                │
│  └────────────────────────────────────────────────┘                │
└────────────────────────────────────────────────────────────────────┘
                              ▲
┌────────────────────────────────────────────────────────────────────┐
│  Layer 2: Domain Services & Runners（领域服务层）                   │
│  ┌──────────────────┬──────────────────┬───────────────────┐       │
│  │ Pain Pipeline    │ Internalization  │ Activation        │       │
│  │ (PainBridge,     │ Pipeline         │ Pipeline          │       │
│  │  Diagnostician,  │ (Dreamer→Trainer │ (5 Channel        │       │
│  │  Intake)         │  + Orchestrator) │  Dispatcher)      │       │
│  ├──────────────────┼──────────────────┼───────────────────┤       │
│  │ BALM             │ LRAS             │ GAP + Goals       │       │
│  │ (代理生命周期)    │ (长程会话)        │ (目标驱动信号)     │       │
│  └──────────────────┴──────────────────┴───────────────────┘       │
└────────────────────────────────────────────────────────────────────┘
                              ▲
┌────────────────────────────────────────────────────────────────────┐
│  Layer 1: Foundation（基础层）                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Schema & Contracts │ Stores │ Read Models │ Error Categories │   │
│  │ (TypeBox)          │ (SQLite│ (immutable  │ (PDErrorCategory)│   │
│  │                    │  + JSON)│  views)    │                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

**层级约束（强约束，CI 守护）**：
- 高层依赖低层，禁止反向
- 同层之间依赖必须显式声明在 `COMPONENTS.md`
- Layer 1 和 2 全部位于 `@principles/core`，Layer 3 位于 `openclaw-plugin`，Layer 4 位于 `pd-cli` / `pd-console`

---

## 4. 五条核心数据流

PD 的所有运行时行为可以归为五条数据流。每条流有：明确的触发器、端到端步骤、产物、Owner、不变量。

### 4.1 Pain Pipeline（痛苦流水线）

**目的**：把代理的失败转化为结构化原则候选。

**信号源三层架构（GAP — Goal-Aligned Pain）**：

```
Layer 1: GAP 主信号（目标驱动）          ← 独立触发 Diagnostician
  mission_failed / mission_stalled
  okr_drift / decision_skipped / rework_loop

Layer 2: 用户反馈信号（强信号）           ← 独立触发 Diagnostician
  explicit_user_complaint / user_correction

Layer 3: 工具/系统失败（辅助信号）        ← 仅作为 Layer 1/2 的证据补充
  tool_failure / empathy_inferred          不独立触发 Diagnostician
```

**数据流**：

```
[GAP Signal / User Feedback / Tool Failure]
      │ Plugin Hook / GAP Generator / 用户显式反馈
      ▼
[PainSignal] ─────► PainSignalAdapter ─────► state.db: pain_signals
      │
      ▼
PainBridge.onPainDetected()
      │
      ▼
DiagnosticianRunner.run()  ◄──── PDRuntimeAdapter（LLM 调用，LRAS 长程会话）
      │
      ▼
DiagnosticianOutputV1
      │
      ▼
CandidateIntakeService.intake()
      │
      ▼
[LedgerPrinciple status=probation] ◄──── ledger.json
```

| 阶段 | 组件 | 包 | 详见 |
|------|------|-----|------|
| 信号捕获 | Hook + `pain-recorder` | plugin + core | `INTERNALIZATION_PIPELINE.md` §2 |
| 诊断 | `DiagnosticianRunner` | core | ADR-0001 |
| 摄入 | `CandidateIntakeService` | core | `DATA_ARCHITECTURE.md` |

**关键不变量**：
- `painId` 是唯一来源标识，可追溯
- 同一个 `painId` 重复进入是幂等的（`createDiagnosticianTaskId(painId)` 确定性映射）
- Diagnostician 失败必须留下 `PDRuntimeError`，不得静默吞没
- Ledger 写入是原子的（`atomicWriteFileSync`）

### 4.2 Internalization Pipeline（内化流水线）

**目的**：把 probation 候选**蒸馏**为可激活的实现工件（PIArtifact）。

```
[Ledger: probation principle]
      │
      ▼
IntakeToInternalizationBridge   ★ 关键桥接器（自动入队）
      │
      ▼
InternalizationOrchestrator.wakeOnce()
      │
      ▼
PIArtifactStore + TaskStore（同一个 state.db）
      │
      ▼  按 Job Graph 顺序执行
┌───────────────────────────────────────────────────────────┐
│ Dreamer ──► Philosopher ──► Scribe ──► Artificer          │
│            ──► Evaluator ──► RolloutReviewer ──► Trainer  │
└───────────────────────────────────────────────────────────┘
      │ 每个 Runner 都产出一个 PIArtifact
      ▼
[PIArtifact: validation_status=validated]
      │ RolloutReviewer 通过 → 可激活
      ▼
RolloutDecision: { autoActivate | requireApproval }
```

| 阶段 | 组件 | 包 | 详见 |
|------|------|-----|------|
| 入队 | `IntakeToInternalizationBridge`（待建） | core | `INTERNALIZATION_PIPELINE.md` §3 |
| 编排 | `InternalizationOrchestrator` | core | ADR-0003 |
| Runner 执行 | 7 个 PeerRunner | core | ADR-0003 |
| 评估 | `Evaluator` + `RolloutReviewer` | core | `INTERNALIZATION_PIPELINE.md` §4 |

**关键不变量**：
- 每个 Runner 必须遵循 `lease → invoke → poll → validate → succeed/fail`
- 所有 Runner 必须通过 `PDRuntimeAdapter` 调用 LLM，禁止直连 SDK
- Runner 之间禁止直接调用，必须通过 TaskStore 入队
- PIArtifact 的 `validationStatus` 在 `pending → validated` 之前不得激活
- 触发流水线的策略（cron / idle / 立即）由宿主层（plugin）拥有，core 只提供 `wakeOnce` 接口

### 4.3 Activation Pipeline（激活流水线）★ 新增

**目的**：把 validated 的 PIArtifact 通过 5 个通道**实际作用于代理行为**。

```
[PIArtifact: validated, channel=X]
      │
      ▼
ActivationDispatcher（按 channel 路由）
      │
      ├──── channel=prompt          ──► [自动] LedgerWriter.activate()
      ├──── channel=defer_archive   ──► [自动] LedgerWriter.archive()
      ├──── channel=skill           ──► [可配置] SkillWriter.write()
      ├──── channel=code_tool_hook  ──► [必须人工审批] ApprovalQueue
      └──── channel=model_training  ──► [必须人工审批 + 二次确认]
                                        ApprovalQueue
                                              │
                                              ▼
                              [pd-console 人工审批]
                                              │
                                  approve     ▼     reject
                                     ┌────────┼────────┐
                                     ▼                 ▼
                            LedgerWriter.activate  RejectionFeedback
                                                       │
                                                       ▼
                                                  [回到内化流水线优化]
```

| 阶段 | 组件 | 包 | 详见 |
|------|------|-----|------|
| 调度 | `ActivationDispatcher`（基础版已落地） | core | `ACTIVATION_CHANNELS.md` |
| 通道实现 | `PromptWriter` / `DeferArchiveWriter` 已落地；`SkillFileWriter` / `RuleHostWriter` / `TrainingExporter` 待建 | core | `ACTIVATION_CHANNELS.md` |
| 审批队列 | `ApprovalQueue` + `pd-console` Approvals 基础 UI/API | core + console | ADR-0006 |
| 拒绝反馈 | `RejectionFeedbackLoop` | core | ADR-0006 |

**关键不变量**：
- 默认安全策略：未明确为 `auto` 的通道必须经过人工审批
- 拒绝必须产生 `RejectionFeedback` 记录，不得静默丢弃
- 激活操作是原子的（`Ledger.principle.status = active` 与对应资源写入必须一致）
- 撤销激活（rollback）必须可追溯到批准人和批准时间

### 4.4 Operations Pipeline（运维流水线）

**目的**：人和代理对 PD 状态的查询、审批、修剪、回滚。

```
                  ┌────────────────────────────┐
                  │   Read Models（不可变视图） │
                  ├────────────────────────────┤
                  │ PainChainReadModel         │
                  │ InternalizationQueueRM     │
                  │ PruningReadModel           │
                  │ OperatorHealthReadModel    │
                  │ LifecycleReadModel         │
                  └─────────┬──────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼                           ▼
         ┌────────┐                  ┌──────────┐
         │ pd-cli │                  │pd-console│
         │ (json) │                  │ (visual) │
         └────────┘                  └──────────┘
              │                           │
              │ 低风险写                  │ 高风险审批
              ▼                           ▼
         ┌──────────────────────────────────────┐
         │   Write APIs（少量授权写入）          │
         ├──────────────────────────────────────┤
         │ PromoteImpl / DisableImpl            │
         │ PrincipleRollback                    │
         │ PruningReview (append-only audit)    │
         │ ApprovalDecision (pd-console only)   │
         └──────────────────────────────────────┘
```

| 阶段 | 组件 | 包 | 详见 |
|------|------|-----|------|
| 读模型 | 各 ReadModel 类 | core | `COMPONENTS.md` |
| pd-cli | 全部命令 | pd-cli | `COMPONENTS.md` |
| pd-console | 审批 UI | pd-console | `COMPONENTS.md` |

**关键不变量**：
- 读模型是**只读**的，禁止从读模型路径触发写
- 写 API 必须记录 `actor`（agent / human / system）
- 审批操作只能从 `pd-console` 入口进入，`pd-cli` 不得绕过

### 4.5 Pruning Pipeline（修剪流水线）

**目的**：清理已被更低层吸收或已无价值的原则，控制 Prompt 上下文压力。

```
[Ledger.active principles]
      │
      ▼
PruningReadModel.scan()  （只读，定期）
      │
      ▼
PruningSignal: 候选修剪集
      │
      ▼  （pd-cli / pd-console 展示）
[人工审查]
      │
      ▼
PruningReviewLog (append-only)  ◄── 仅审计意图，不改 Ledger
      │
      ▼  （独立 issue 触发）
PruningAction（高风险，必须人工 approve + dry-run）
      │
      ▼
LedgerWriter.deprecate() / archive()
```

**关键不变量**（现状已落地）：
- `PruningReadModel` 不得修改 Ledger
- `PruningReviewLog` 是 append-only 审计日志
- `PruningAction` 至今**未实现**，等待独立 issue 推进
- 任何对 active 原则的状态变更必须可回滚

详见 `PRUNING_PIPELINE.md`（待建）和 `DOMAIN_MODEL.md` §4。

---

## 5. 文档导航：想了解 X，应该读哪份

### 5.1 决策路径速查表

| 你的问题 | 入口文档 |
|---------|---------|
| 一个新概念该叫什么名字 | `GLOSSARY.md` → 标准术语词典 |
| 一段代码该放哪个包 | 本文 §2.2 + `COMPONENTS.md` |
| 一个新组件应该归到哪一层 | 本文 §3 + `COMPONENTS.md` |
| 怎么处理一个新错误 | `ERROR_ARCHITECTURE.md` |
| 数据存哪里 | `DATA_ARCHITECTURE.md` |
| 怎么观测某个流水线 | `OBSERVABILITY_ARCHITECTURE.md` |
| 一个新通道怎么接入激活 | `ACTIVATION_CHANNELS.md` |
| 性能怎么做约束 | `PERFORMANCE_BUDGETS.md` |
| 安全和工作区隔离 | `SECURITY_ARCHITECTURE.md` |
| Schema 升级怎么做 | `VERSIONING_AND_COMPATIBILITY.md` |
| 配置文件层级 | `CONFIGURATION_ARCHITECTURE.md` |

### 5.2 五条数据流的详细文档

| 数据流 | 主文档 | 相关 ADR |
|-------|-------|---------|
| Pain Pipeline | `INTERNALIZATION_PIPELINE.md` §2 | ADR-0001 |
| Internalization Pipeline | `INTERNALIZATION_PIPELINE.md` §3-4 | ADR-0003, ADR-0005 |
| Activation Pipeline | `ACTIVATION_CHANNELS.md` | ADR-0006 |
| Operations Pipeline | `COMPONENTS.md` + 各 ReadModel | ADR-0007 |
| Pruning Pipeline | `DOMAIN_MODEL.md` §4 | （待建） |

### 5.3 战略层 vs 执行层

| 文档类型 | 关注点 | 代表文档 |
|---------|-------|---------|
| 战略蓝图（不易变） | "为什么" + "应该是什么" | `PD_System_Dynamics_Model.md`, ADR |
| 架构蓝图（中等稳定） | "由哪些部分构成" + "如何分层" | 本文 + `PD_SYSTEM_ARCHITECTURE.md` + `COMPONENTS.md` |
| 实现指南（频繁更新） | "代码怎么写" | `docs/maps/` + 各模块 README |

---

## 6. 横切约束（Cross-Cutting Constraints）

以下约束适用于所有四层、所有交付物、所有数据流。每一项都有专门文档详述（部分待建）。

### 6.1 安全（Security）

- **工作区隔离**：每个 PD 实例只操作 `workspaceDir` 范围内的文件，不得跨工作区
- **沙箱执行**：所有用户/LLM 提供的可执行代码（RuleHost implementations）必须在 `node:vm` 受限上下文中执行
- **PII 保护**：trajectory 数据中的用户消息必须经过 `pain-context-extractor` 脱敏处理
- **密钥管理**：API Key 通过环境变量传入，禁止落盘
- 详见：`SECURITY_ARCHITECTURE.md`

### 6.2 性能（Performance Budgets）

- **Hook 延迟预算**：`before_prompt_build` < 50ms, `before_tool_call` < 20ms
- **Runner 超时**：默认 5 分钟，可配置
- **SQLite 大小**：单工作区 state.db 上限 500MB（超限触发归档）
- **Ledger 文件**：单 ledger.json 上限 10MB
- 详见：`PERFORMANCE_BUDGETS.md`

### 6.3 幂等性（Idempotency）

- 所有跨进程触发的操作必须可幂等重试
- 幂等键（`idempotencyKey`）由调用方提供（`taskId:runId:painId` 等组合）
- Pain → Diagnostician 任务幂等：同一 `painId` 第二次触发返回缓存结果
- Candidate → Ledger 幂等：`existsForCandidate` 优先查询
- PIArtifact 写入幂等：`sourceTaskId + artifactKind` 为唯一键

### 6.4 可观测性（Observability）

- **三位一体**：Logs（结构化）+ Metrics（计数器）+ Traces（traceId 贯穿）
- **TelemetryEvent**：所有跨流水线事件统一格式（`@principles/core/telemetry-event`）
- **强制事件**：每个 Runner 必须发出 `*_task_leased` / `*_task_succeeded` / `*_task_failed`
- 详见：`OBSERVABILITY_ARCHITECTURE.md`

### 6.5 版本与兼容（Versioning）

- **Schema 版本号**：`RUNTIME_V2_SCHEMA_VERSION`（语义化版本）
- **Schema 演化**：仅允许添加可选字段；删除/重命名字段需经 ADR 决议
- **数据迁移**：所有 schema 变更必须提供 forward migration（旧数据可读）
- **Deprecation 流程**：`@deprecated` JSDoc → 一个 minor 版本警告 → 下个 major 删除
- 详见：`VERSIONING_AND_COMPATIBILITY.md`

### 6.6 可测试性（Testability）

- **架构守护测试**：`architecture-regression.test.ts` 检查层级依赖、命名禁区、duplicate writers
- **测试比例约定**：unit (70%) + integration (20%) + e2e (10%)
- **Property-based**：状态机转换必须有 property-based 测试
- **测试隔离**：每个测试必须使用独立的 tmp workspaceDir

---

## 7. 设计原则汇总

PD 在做架构决策时，按以下优先级判断：

1. **正确性 > 性能** —— 慢但正确，强于快但偶尔出错
2. **可观测性 > 自动化** —— 静默成功不如显式失败
3. **简单 > 通用** —— 不为不存在的需求做抽象
4. **本地 > 远程** —— 默认 SQLite + 文件，不引入网络依赖
5. **声明式 > 命令式** —— 状态用 schema 表达，不用 ad-hoc 字段
6. **代理优先 > 人优先** —— pd-cli 是日常路径，pd-console 是审计路径
7. **可组合 > 绑定** —— core 不绑定任何宿主框架
8. **守恒 > 增量** —— 删除冗余优于添加新代码

---

## 8. 关于变更

### 8.1 修改本文档的流程

- 本文是 SSoT，修改必须通过 PR
- PR 标题必须包含 `[OVERVIEW]` 标签
- PR 描述必须列出所有受影响的下游文档
- 至少需要一个架构维护者批准

### 8.2 与现有文档不一致时怎么办

| 场景 | 处理方式 |
|------|---------|
| 本文 vs ADR | ADR 是单点决策，本文是综合视图。冲突时通常本文滞后；要么修订本文，要么修订 ADR |
| 本文 vs 代码 | 代码是事实，本文是意图。冲突时检查：是代码偏离了意图？还是意图过时了？通过 PR 修订一方 |
| 本文 vs 其他架构文档 | 本文优先。其他文档需在 PR 同步修订 |

### 8.3 索引与归档

- 本目录的所有文档在 `README.md` 索引中维护
- 标记为 `Deprecated` 的文档保留 2 个 minor 版本后归档到 `archive/`
- 归档不删除，永久可追溯

---

## 9. 当前状态快照（实施进度）

> **注**：本节按月更新一次，反映架构落地进度。最后更新：2026-05-18

| 子系统 | 状态 | 主要 gap |
|-------|------|---------|
| Pain Pipeline | ✅ 完整 | 无 |
| Internalization Pipeline | ⚠️ 90% | `IntakeToInternalizationBridge` 已落地；仍需生产链路持续验证与 legacy nocturnal 清理 |
| Activation Pipeline | ⚠️ 75% | `ActivationDispatcher`、低风险 writers、`ApprovalQueue` 已落地；`RuleHostWriter` / `SkillFileWriter` / `TrainingExporter` 待建 |
| Operations Pipeline | ⚠️ 80% | pd-console approvals 基础 UI/API 已落地；仍需 RejectionFeedback、二次确认、审批历史与更强审计 |
| Pruning Pipeline | ⚠️ 50% | PruningAction 未实现 |
| 横切约束 | ⚠️ 70% | 核心横切文档已建立；仍需文档-代码漂移守护与 invariant 编号覆盖 |
| 守护测试 | ⚠️ 70% | architecture-regression.test 已覆盖多条 Runtime V2/Activation 边界；仍需 AC-* / BALM-* / GAP-* / SCHED-* 编号化覆盖 |
| **BALM（代理生命周期）** | ❌ 0% | 全部待建（ADR-0008）|
| **LRAS（长程代理会话）** | ❌ 0% | 全部待建（ADR-0009）|
| **GAP（目标驱动信号）** | ❌ 0% | Mission/Objective/GAP Generator 全部待建（ADR-0010）|
| **MissionScheduler（三层任务）** | ❌ 0% | 全部待建（ADR-0011）|

---

## 10. 关联 ADR 与设计文档

| ADR | 主题 | 状态 |
|-----|------|------|
| [ADR-0001](../adr/0001-runtime-v2-service-boundaries.md) | Runtime V2 服务边界 | Accepted |
| [ADR-0002](../adr/0002-hard-internalization-core-boundary.md) | 硬内化核心边界 | Accepted |
| [ADR-0003](../adr/0003-peer-agent-state-machine-orchestration.md) | Peer Agent 状态机编排 | Accepted |
| [ADR-0004](../adr/0004-l2-auto-correction-and-replay.md) | L2 自动校正与回放 | Accepted |
| [ADR-0005](../adr/0005-nocturnal-internalization-merger.md) | Nocturnal 与 Internalization Engine 合并 | Accepted |
| [ADR-0006](../adr/0006-hybrid-activation-mechanism.md) | 5 通道混合激活机制 | Accepted |
| [ADR-0007](../adr/0007-cli-vs-console-audience-separation.md) | pd-cli 与 pd-console 受众分离 | Accepted |
| ADR-0008 | Built-in Agent Lifecycle Manager（BALM）| Accepted |
| ADR-0009 | Long-Running Agent Session（LRAS）| Accepted |
| ADR-0010 | Goal-Aligned Pain Signal（GAP）| Accepted |
| ADR-0011 | Three-Tier Task Model and MissionScheduler | Accepted |
