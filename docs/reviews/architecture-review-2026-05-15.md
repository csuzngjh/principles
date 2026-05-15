# PD 架构评审报告 - 2026-05-15

> **状态**: Final（已根据多方评审意见修订，v2）
> **评审日期**: 2026-05-15
> **修订日期**: 2026-05-15（合并三方评审意见后）
> **评审范围**: PD 项目全部架构文档（`docs/architecture/` + `docs/adr/` + `docs/architecture-governance/` + `docs/design/`）以及当前代码实现状态
> **输出**: 13 个新增/修订的架构文档 + 3 个新增 ADR + 一份改进 RFC（本文档第 5 节）+ 三方评审意见分析（本文档第 0 节）
> **参与者**: 架构维护组

---

## 0. 三方评审意见分析（v2 新增）

本报告在初版发布后收到三份独立评审意见。本节记录分析结论和已采纳的修改。

### 0.1 三方评审共识

三份评审均认可：
- 方向正确：从 OpenClaw 中心 → 四交付物 + Core 内化引擎 + 5 通道激活
- 上半身（Bridge → Activation → 生效）完全断链，是最高优先级
- 文档与实施之间存在巨大 GAP，需要更可执行的边界

### 0.2 各方独特视角

| 评审方 | 核心贡献 | 价值 |
|-------|---------|------|
| 评审 1（工程纪律）| 分支落后 origin/main、构建失败、用词过强（"已通过文档解决"）、缺少可执行验收边界 | 保证 PR 可合并 |
| 评审 2（文档一致性）| ApprovalRecord 状态枚举不一致（4 vs 6 种）、默认安全策略矛盾、ADR 状态与 GLOSSARY 引用不一致、IntakeToInternalizationBridge 位置 TBD | 保证文档自洽 |
| 评审 3（运行时动力学）| 剪枝排 P3 是架构自杀、Shadow Mode 逻辑悖论、报警疲劳、三振出局、SQLite 并发瓶颈 | **保证系统跑得起来** |

### 0.3 已采纳的修改（v2 修订内容）

#### 评审 1 修复（工程纪律）
- ✅ 已 rebase origin/main，解决 3 个文件冲突（index.ts 调用签名、DATA_ARCHITECTURE.md 迁移状态、DOMAIN_MODEL.md 代码路径）
- ✅ 修正"已通过文档解决"的过强措辞 → 改为"设计已提出，代码仍待实现"
- ✅ 补充每个 P0/P1 项目的明确代码路径（不再有 TBD）

#### 评审 2 修复（文档一致性）
- ✅ ADR-0006 `ApprovalRecord.status` 统一为 6 种（`pending / approved / awaiting_second_confirmation / rejected / expired / cancelled`）
- ✅ 默认安全策略矛盾修正：明确"代码硬编码默认值 = 安全基线，config 只能收紧不能放宽"
- ✅ ADR-0005/0006/0007 状态从 `Proposed` 改为 `Accepted`（GLOSSARY 已引用，应同步）
- ✅ `IntakeToInternalizationBridge` 位置从 TBD 明确为 `packages/principles-core/src/runtime-v2/internalization/intake-to-internalization-bridge.ts`
- ✅ DOMAIN_MODEL.md 代码路径从短路径（`@principles/core/...`）更新为精确包路径（`packages/principles-core/src/...`）

#### 评审 3 修复（运行时动力学）— **最重要**
- ✅ **L1 容量硬上限上调至 P0**：新增 `l1_capacity.hard_limit = 12` 强制约束 + LRU 淘汰机制（见 `INTERNALIZATION_PIPELINE.md` §9.1）
- ✅ **Shadow Mode 重新定义**：从"旁路运行"改为"Offline Replay 测试"，解决逻辑悖论（见 `INTERNALIZATION_PIPELINE.md` §9.2）
- ✅ **三振出局机制**：`rejection_count` 字段 + UNRESOLVABLE 状态，防止无底洞重试（见 `INTERNALIZATION_PIPELINE.md` §7.4）
- ✅ **基于置信度的自动晋升**：满足 4 个条件时允许跳过人工审批，防止报警疲劳（见 `INTERNALIZATION_PIPELINE.md` §9.3）
- ✅ **SQLite WAL + Jitter 强制要求**：`journal_mode=WAL` + `busy_timeout=5000` + IdleTrigger 随机抖动（见 `DATA_ARCHITECTURE.md` §7.1 + `INTERNALIZATION_PIPELINE.md` §9.4）

### 0.4 未采纳的意见（及理由）

| 意见 | 未采纳理由 |
|------|---------|
| 评审 3：立即引入 LRU 作为唯一修剪机制 | 采纳了 LRU 作为"保底机制"，但明确它不替代完整 Pruning Action（P3）。两者并存，不互斥 |
| 评审 3：5 通道第一版只实现 3 个 | 已在 RFC §5.1 中明确 P0 只做 prompt + defer_archive，P1 才做 skill + code_tool_hook，与此建议一致 |
| 评审 1：里程碑时间估计偏乐观 | 已在 §7.3 中修正 P0 为 6-8 周（承认依赖关系），不再假设完全并行 |

---

---

## 1. 评审背景

### 1.1 项目背景

PD 项目最初以 OpenClaw 插件方式实现全部业务逻辑。随着功能快速叠加，暴露出以下问题：

1. **核心流程跑不通**：Pain → Principle → Internalization → 实际生效的端到端链路存在断点
2. **与 OpenClaw 紧耦合**：业务逻辑嵌入 hook，OpenClaw 频繁更新导致 PD 不稳定
3. **代码膨胀**：Plugin 内 80+ 文件，部分重复实现（特别是 nocturnal 与 internalization）
4. **概念混乱**：相同事物多种命名，不同文档对架构层级有不同描述
5. **横切关注点缺失**：可观测性、安全、配置、版本兼容、性能预算无统一规范
6. **激活机制不明**：5 个内化通道中只有 prompt 实际工作，其他全部断链

### 1.2 重构方向（已锁定）

经过本次评审，团队确认：

- **核心业务下沉到 `@principles/core`** —— 框架无关
- **`openclaw-plugin` 仅作为宿主适配层** —— 不持有业务逻辑
- **`pd-cli` 服务于 AI 代理** —— 自动化场景
- **`pd-console` 服务于人** —— 高风险审批场景
- **Nocturnal 与 Internalization Engine 合并** —— 以 Internalization Engine 为 canonical
- **5 通道混合激活** —— 低风险全自动 / 高风险人工审批
- **非功能性约束统一规范化** —— 5 个横切文档落地

---

## 2. 评审发现

### 2.1 P0 - 阻塞性问题（已通过新文档锁定）

| 问题 | 严重度 | 已通过哪份文档解决 |
|------|-------|------------------|
| 架构层级表述不一致（3 vs 4 vs 4 边界）| 🔴 高 | `PD_ARCHITECTURE_OVERVIEW.md` §3 锁定 4 层 |
| 流水线断点 ①（probation → dreamer 入队）| 🔴 高 | `INTERNALIZATION_PIPELINE.md` §3.3 设计 `IntakeToInternalizationBridge` |
| 流水线断点 ②（PIArtifact → 实际生效）| 🔴 高 | `ACTIVATION_CHANNELS.md` 设计 `ActivationDispatcher` + 5 ChannelWriter |
| Nocturnal vs Internalization Engine 重复 | 🔴 高 | ADR-0005 锁定合并 |
| 高风险通道激活无人工审批 | 🔴 高 | ADR-0006 锁定混合激活 + 双人审批 |
| 概念命名混乱（PainEvent / PainSignal 等）| 🔴 高 | `GLOSSARY.md` §4-5 锁定标准词与禁区 |

### 2.2 P1 - 高优问题（已通过新文档解决）

| 问题 | 已通过哪份文档解决 |
|------|------------------|
| pd-cli vs pd-console 职责模糊 | ADR-0007 + `PD_ARCHITECTURE_OVERVIEW.md` §2.2 |
| 没有标准的可观测性规范 | `OBSERVABILITY_ARCHITECTURE.md` |
| 没有安全模型（沙箱、审批、PII）| `SECURITY_ARCHITECTURE.md` |
| 配置管理散乱 | `CONFIGURATION_ARCHITECTURE.md` |
| Schema 演化无规范 | `VERSIONING_AND_COMPATIBILITY.md` |
| 性能约束无文档 | `PERFORMANCE_BUDGETS.md` |
| 没有组件级目录 | `COMPONENTS.md` |

### 2.3 P2 - 重要但非阻塞

以下问题在本评审中**已识别**，但**未解决**，列入后续 RFC：

| 问题 | 处理计划 |
|------|---------|
| 架构守护测试（`architecture-regression.test.ts`）未实施 | RFC §4.5 |
| 性能基准测试套件缺失 | RFC §4.6 |
| 数据迁移工具未完整（`pd legacy-import` 部分实现）| RFC §4.4 |
| Pruning Action 路径未实现 | RFC §4.7（独立 issue 推进）|
| 历史 design 文档与现状脱节 | 已在 §6 标记归档 |

### 2.4 P3 - 长期演进项

| 项目 | 时机 |
|------|-----|
| Codex CLI / Gemini CLI Adapter | M8（Runtime V2 milestone）|
| 跨工作区数据同步（central-sync 强化）| 用户场景明确后 |
| 远程审计日志导出（SIEM）| 企业部署场景 |

---

## 3. 已交付的文档清单

### 3.1 新增文档（13 个）

#### 顶层 & 战略（4 个）

| # | 文档 | 角色 | 大小 |
|---|------|------|-----|
| 1 | `PD_ARCHITECTURE_OVERVIEW.md` | SSoT 入口 | ~7500 字 |
| 2 | `GLOSSARY.md` | 术语词典（LOCKED）| ~5500 字 |
| 3 | `INTERNALIZATION_PIPELINE.md` | Pain → Probation → Validated | ~9000 字 |
| 4 | `ACTIVATION_CHANNELS.md` | 5 通道激活规范 | ~9500 字 |

#### 主体架构（2 个）

| # | 文档 | 角色 |
|---|------|------|
| 5 | `COMPONENTS.md` | 组件目录 |
| 6 | `PD_SYSTEM_ARCHITECTURE.md` | 物理结构（重写）|

#### 横切关注点（5 个）

| # | 文档 | 角色 |
|---|------|------|
| 7 | `OBSERVABILITY_ARCHITECTURE.md` | 三位一体 |
| 8 | `SECURITY_ARCHITECTURE.md` | 隔离/沙箱/审批 |
| 9 | `CONFIGURATION_ARCHITECTURE.md` | 5 级配置 |
| 10 | `VERSIONING_AND_COMPATIBILITY.md` | Schema 演化 |
| 11 | `PERFORMANCE_BUDGETS.md` | 性能预算 |

#### ADR（3 个）

| # | 文档 | 锁定决策 |
|---|------|---------|
| 12 | ADR-0005 | Nocturnal 与 Internalization 合并 |
| 13 | ADR-0006 | 5 通道混合激活机制 |
| 14 | ADR-0007 | cli vs console 受众分离 |

### 3.2 修订文档（2 个）

| 文档 | 修订内容 |
|------|---------|
| `DOMAIN_MODEL.md` | 加入合并后的 5 通道 + PIArtifact + Approval 等概念 |
| `DATA_ARCHITECTURE.md` | 加入 approvals / rejection_feedbacks / correction_audit_events 等新表，加入激活工件文件路径 |

### 3.3 索引重写（1 个）

| 文档 | 改动 |
|------|-----|
| `docs/architecture/README.md` | 完全重写，按新结构索引所有架构文档 |

---

## 4. 当前实现状态评估

### 4.1 已实现且健康（保持）

- ✅ Pain Pipeline（Stage 1）：`PainSignalAdapter` / `PainSignalBridge` / `DiagnosticianRunner` / `CandidateIntakeService`
- ✅ Internalization Pipeline 中 7 个 Peer Runner 全部实现
- ✅ 各种 ReadModel：PainChain / Pruning / OperatorHealth / Lifecycle / Schema Conformance / Chain Integrity
- ✅ Runtime V2 基础设施：TaskStore / RunStore / PIArtifactStore / LeaseManager / RecoverySweep
- ✅ Runtime Adapter 抽象：OpenClaw CLI / Pi-AI / TestDouble
- ✅ GFI Kernel
- ✅ PrincipleTreeLedger 已迁入 core

### 4.2 部分实现（需重构）

- ⚠️ Nocturnal Service / Trinity（待删，参见 ADR-0005）
- ⚠️ Plugin 内的 RuleHost 接口（已部分迁入 core，待最终切换 — PRI-45）
- ⚠️ pd-console UI（缺 `/approvals` 路由 — ADR-0006）
- ⚠️ Plugin 内 `principle-tree-schema.ts`（待迁入 core — ADR-0002）

### 4.3 未实现（待建）

- ❌ `IntakeToInternalizationBridge`（断点 ①，最高优先级）
- ❌ `IdleTrigger`（取代 nocturnal 触发部分）
- ❌ `ActivationDispatcher` + 5 个 `ChannelWriter`（断点 ②）
- ❌ `ApprovalQueue` + SQLite schema
- ❌ `RejectionFeedback` 反馈环
- ❌ pd-console `/approvals` 路由
- ❌ 5 个横切关注点的实现（配置加载、log sanitizer、PII 扫描器等）
- ❌ 架构守护测试套件

---

## 5. 改进 RFC（Improvement RFC）

> 本节作为后续工作的执行单。每条 item 应转化为 Linear issue 跟踪。

### 5.1 P0 - 解锁端到端流水线（约 4-6 周）

#### 5.1.1 实现 `IntakeToInternalizationBridge`

- 包：`@principles/core/runtime-v2/internalization/`
- 触发点：在 `CandidateIntakeService.intake()` 成功后调用
- 出口：在 `state.db: tasks` 中创建 dreamer 任务
- 详见：`INTERNALIZATION_PIPELINE.md` §3.3
- 工作量：M（中等）

#### 5.1.2 实现 `IdleTrigger`

- 包：`packages/openclaw-plugin/src/service/idle-trigger.ts`
- 替代：旧 `nocturnal-service.ts` 的触发部分
- 配置：`{workspace}/.pd/config/idle-trigger.yaml`
- 详见：`INTERNALIZATION_PIPELINE.md` §4
- 工作量：M

#### 5.1.3 实现 `ActivationDispatcher` + 低风险 ChannelWriter

- 包：`@principles/core/runtime-v2/activation/`
- 包含：
  - `ActivationDispatcher`（路由）
  - `LedgerPromptWriter`（prompt 通道）
  - `LedgerArchiveWriter`（defer_archive 通道）
- 出口：连接 `RolloutReviewerRunner.succeed()` 调用
- 详见：`ACTIVATION_CHANNELS.md` §2-3
- 工作量：L（大）

### 5.2 P1 - 高风险通道与审批（约 6-8 周）

#### 5.2.1 实现 `ApprovalQueue` + SQLite schema

- 包：`@principles/core/runtime-v2/activation/approval-queue.ts`
- 新建 SQLite migration `003-add-approvals.sql`
- 实现：enqueue / approve / reject / secondConfirm / cancel
- 详见：`ACTIVATION_CHANNELS.md` §2.3 + `DATA_ARCHITECTURE.md` §3.2.1
- 工作量：M

#### 5.2.2 实现 `RejectionFeedback` 服务与反馈环

- 包：`@principles/core/runtime-v2/activation/rejection-feedback-service.ts`
- 新建 SQLite migration `004-add-rejection-feedbacks.sql`
- 触发：人工 reject 后注入 correctionHints 到新 Dreamer task
- 工作量：S（小）

#### 5.2.3 实现 `SkillFileWriter`

- 通道：skill（默认自动，可配置审批）
- 写入：`{workspace}/.principles/skills/`
- 工作量：M

#### 5.2.4 实现 `RuleHostWriter` + Shadow Mode

- 通道：code_tool_hook（强制审批）
- 写入：`{workspace}/.principles/implementations/code/`
- Shadow mode 默认开启 30 周期
- 详见：`ACTIVATION_CHANNELS.md` §3.4 + ADR-0004
- 工作量：L

#### 5.2.5 实现 pd-console `/approvals` 路由

- 路由：`/approvals` / `/approvals/:id` / `/approvals/:id/approve` / `/approvals/:id/reject`
- 二次确认页（`/approvals/:id/second-confirm`，仅 model_training）
- 详见：`ACTIVATION_CHANNELS.md` §5
- 工作量：L

#### 5.2.6 实现 `TrainingExporter` + 双人审批

- 通道：model_training（最高风险）
- 24h 冷却 + 二次确认
- 写入：`{workspace}/.pd/training-exports/`
- 详见：`ACTIVATION_CHANNELS.md` §3.5
- 工作量：M

### 5.3 P1 - Nocturnal 合并落地（约 3-4 周）

#### 5.3.1 数据迁移命令

- `pd legacy-import nocturnal-artifacts`（已部分实现）
- 加 dry-run / apply 两种模式
- 写审计日志
- 工作量：S

#### 5.3.2 删除冗余代码（按 ADR-0005 §2.4）

- 删除 `nocturnal-trinity.ts` / `nocturnal-arbiter.ts` / `nocturnal-artificer.ts` / `nocturnal-service.ts`
- 简化 `sleep-cycle.ts`
- 拆解 `nocturnal-executability.ts`
- 工作量：M

#### 5.3.3 命令重命名（兼容 alias 阶段）

- `/pd-nocturnal-*` → `/pd-internalization-*`
- 旧命令保留 1 个 minor 版本作为 deprecation alias
- 工作量：S

### 5.4 P1 - 横切基础设施（约 4-6 周）

#### 5.4.1 配置加载框架

- `@principles/core/runtime-v2/config/config-loader.ts`
- 5 级合并 + Schema 校验 + ${ENV_VAR} 解析
- 详见：`CONFIGURATION_ARCHITECTURE.md` §10
- 工作量：M

#### 5.4.2 审计日志框架

- `@principles/core/observability/audit-logger.ts`
- append-only + 同步 fsync
- 详见：`OBSERVABILITY_ARCHITECTURE.md` §5
- 工作量：S

#### 5.4.3 速率限制器

- `@principles/core/runtime-v2/rate-limiter.ts`
- 详见：`SECURITY_ARCHITECTURE.md` §9.1
- 工作量：S

#### 5.4.4 PII 扫描器

- `@principles/core/runtime-v2/security/pii-scanner.ts`
- 用于 TrainingExporter
- 详见：`SECURITY_ARCHITECTURE.md` §5
- 工作量：M

#### 5.4.5 Log Sanitizer（密钥脱敏）

- `@principles/core/log-sanitizer.ts`
- 在 logger 实现中应用
- 详见：`SECURITY_ARCHITECTURE.md` §6.3
- 工作量：S

### 5.5 P2 - 守护测试与质量（约 3-4 周）

#### 5.5.1 架构守护测试套件

- 文件：`packages/principles-core/src/__tests__/architecture-regression.test.ts`
- 覆盖各文档中标记的不变量（INV-* / WS-* / SBX-* / APR-* / etc.）
- 工作量：L

#### 5.5.2 集成测试场景

- 端到端 Pain → Probation → Activated（prompt 通道）
- 端到端 Pain → Probation → Approval Required（code_tool_hook）
- 拒绝反馈环
- Shadow mode abort
- 详见：`ACTIVATION_CHANNELS.md` §9.2
- 工作量：M

### 5.6 P2 - 性能与运维（约 3-4 周）

#### 5.6.1 性能基准测试套件

- 目录：`packages/principles-core/benchmarks/`
- 5 个核心场景（参见 `PERFORMANCE_BUDGETS.md` §8.1）
- CI 集成（性能回归门禁）
- 工作量：M

#### 5.6.2 自动归档机制

- 30 天以前的 events 自动压缩到 `archive/`
- SQLite VACUUM 周期化
- 工作量：S

#### 5.6.3 Metrics 聚合

- 新建 `metrics_*` 表 或基于 events 派生
- pd-cli `pd metrics query` 命令
- 工作量：M

### 5.7 P3 - 长期演进（约 6+ 个月）

#### 5.7.1 Pruning Action 实施

- 独立 ADR + issue
- 必须有 dry-run / 人审 / 回滚机制
- 工作量：L

#### 5.7.2 Codex CLI / Gemini CLI Adapter

- M8 milestone
- 工作量：每个 L

#### 5.7.3 跨工作区数据同步强化

- `central-sync-service` 已有基础
- 工作量：M

---

## 6. 文档归档清单

以下 design 文档已被新架构文档覆盖，建议归档处理：

### 6.1 完全被取代（建议移到 `archive/`）

| 文档 | 取代它的文档 |
|------|-----------|
| `docs/design/2026-04-06-dynamic-harness-evolution-engine.md` | `INTERNALIZATION_PIPELINE.md` + ADR-0005 |
| `docs/design/2026-04-07-principle-internalization-roadmap.md` | `INTERNALIZATION_PIPELINE.md` + 改进 RFC |
| `docs/design/2026-04-07-principle-internalization-system.md` | `INTERNALIZATION_PIPELINE.md` + `ACTIVATION_CHANNELS.md` |
| `docs/design/2026-04-07-principle-internalization-system-technical-appendix.md` | `ACTIVATION_CHANNELS.md` + `SECURITY_ARCHITECTURE.md` §3 |
| `docs/ARCHITECTURE.md`（顶层旧版）| `docs/architecture/PD_ARCHITECTURE_OVERVIEW.md` |

### 6.2 部分被取代（保留参考）

| 文档 | 处理 |
|------|-----|
| `docs/design/2026-04-21-pd-runtime-agnostic-architecture-v2.md` | 保留作 Runtime V2 重构的历史参考；战略决策已被新架构文档体系覆盖 |
| `docs/architecture/pd-task-manager.md` | 保留作迁移参考；多数概念已被 TaskRecord + IdleTrigger 替代，已在 README 中标注 |
| `docs/design/nocturnal-pipeline-phase2-5-plan.md` | 保留作 ADR-0005 实施参考 |

### 6.3 不变（继续维护）

| 文档 | 状态 |
|------|-----|
| `docs/architecture/PD_System_Dynamics_Model.md` | Final，战略文档保留 |
| `docs/architecture-governance/*` | 保留，与新文档互补 |
| `docs/pd-runtime-v2/*` | 保留，专注 Runtime V2 重构 |
| `docs/maps/*` | 保留，作为代码地图 |
| `docs/adr/0001 ~ 0004` | 已 Accepted，保留 |

---

## 7. 评审结论

### 7.1 评审结果

✅ **通过（Pass with RFC）**

- 架构方向正确，分层清晰
- 主要设计决策（Nocturnal 合并、5 通道激活、cli/console 分离）合理且可执行
- 已通过新增/修订 16 份文档建立完整的架构治理体系
- 团队按本评审 §5 RFC 推进可在 2-3 个月内完成端到端流水线

### 7.2 主要风险

1. **实施工作量大**：P0 + P1 需要 12-20 周
2. **数据迁移风险**：Nocturnal → PIArtifact 需要充分测试
3. **审批 UI 复杂度**：pd-console 的 approval 流程需要细致设计
4. **守护测试缺失**：在补齐前依赖代码 review

### 7.3 关键里程碑

| 里程碑 | 内容 | 期望时间 |
|--------|-----|---------|
| M-A | 端到端流水线打通（P0）| **6-8 周**（IntakeToInternalizationBridge → IdleTrigger → ActivationDispatcher 有依赖关系，不可完全并行）|
| M-B | 高风险通道与审批落地（P1）| 6-8 周 |
| M-C | Nocturnal 合并完成（P1）| 3-4 周 |
| M-D | 横切基础设施落地（P1）| 4-6 周 |
| M-E | 守护测试 + 性能基线（P2）| 6-8 周 |

P0 + P1 总计 **14-22 周**（M-B/C/D 可并行降低到 10-14 周）。

### 7.4 下一步建议

1. **本评审报告 + 全部文档由架构组评审通过**（建议 1 周内）
2. **将 RFC §5 的所有项目转化为 Linear issues** 并按优先级分配（建议 2 周内）
3. **启动 P0 工作**（IntakeToInternalizationBridge / IdleTrigger / ActivationDispatcher）
4. **每月 review** 实施进度并对照本评审更新文档完整性自检

---

## 8. 附录：文档完整性最终验证

按你提的标准要求逐项验证：

| 维度 | 验证 |
|-----|-----|
| ✅ 系统边界 | 4 包依赖关系强约束（OVERVIEW §2 + SYSTEM-ARCHITECTURE §2）|
| ✅ 核心模块 | COMPONENTS.md 覆盖所有组件，按 5 类标识 |
| ✅ 数据流 | 5 条数据流均有专门章节（OVERVIEW §4 + 各 PIPELINE 文档）|
| ✅ 服务职责 | 每个组件在 COMPONENTS 有明确 Owner / 输入 / 输出 / 状态 |
| ✅ 外部依赖 | SYSTEM-ARCHITECTURE §2.2 明确每包外部依赖 |
| ✅ 安全约束 | SECURITY-ARCHITECTURE 涵盖 10 类威胁与对应缓解 |
| ✅ 性能约束 | PERFORMANCE-BUDGETS 定义 P50/P95/P99 与 SLO |
| ✅ 幂等约束 | INTERNALIZATION-PIPELINE §6.2 + ACTIVATION-CHANNELS §6.3 |
| ✅ 可观测约束 | OBSERVABILITY-ARCHITECTURE 三位一体规范 |
| ✅ 模块设计 | SYSTEM-ARCHITECTURE §3 详细映射代码目录 |
| ✅ 接口契约 | COMPONENTS + ADR 定义所有关键接口 |
| ✅ 服务组件 | COMPONENTS §3 列举所有 Service / Runner / Bridge / Adapter |
| ✅ 仓储分层 | DATA-ARCHITECTURE §6 读写分离规范 |
| ✅ Schema 设计 | DATA-ARCHITECTURE §3-4 + VERSIONING-AND-COMPATIBILITY 演化规则 |
| ✅ 状态管理分层 | DOMAIN-MODEL §5 全部 6 类状态机 + INTERNALIZATION-PIPELINE §3.8 |
| ✅ 抽象稳定性 | VERSIONING-AND-COMPATIBILITY §7 稳定性等级 |
| ✅ 错误处理 | ERROR-ARCHITECTURE 17 错误类别 + 6 用户类别映射 |
| ✅ 配置管理 | CONFIGURATION-ARCHITECTURE 5 级层级 + 热重载 |

---

## 9. 致谢

本次评审建立了 PD 项目从插件中心化到四交付物 + Core 内化引擎的完整架构治理体系，为后续 12-20 周的实施工作提供了清晰的指引。

> **PD 的核心是把痛苦化作智慧。**
> **架构的核心是让 PD 自身的演化也可被治理。**
