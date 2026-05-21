# PD 架构文档（Architecture Documentation）

> **最后更新**: 2026-05-15
> **维护**: 由架构维护组负责

本目录包含 Principles Disciple（PD）项目的**全部架构文档**。它是项目设计意图、决策、契约的权威来源。

---

## 🚀 快速入口

| 你是谁 / 你想做什么 | 应该读 |
|------------------|-------|
| 第一次了解 PD | [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) |
| 想新建一个组件 | [`COMPONENTS.md`](./COMPONENTS.md) + [`PD_SYSTEM_ARCHITECTURE.md`](./PD_SYSTEM_ARCHITECTURE.md) |
| 不知道某个概念怎么称呼 | [`GLOSSARY.md`](./GLOSSARY.md) |
| 在做痛苦诊断 / 内化相关功能 | [`INTERNALIZATION_PIPELINE.md`](./INTERNALIZATION_PIPELINE.md) |
| 在做激活 / 审批相关功能 | [`ACTIVATION_CHANNELS.md`](./ACTIVATION_CHANNELS.md) |
| 在做 hooks / 错误处理 | [`ERROR_ARCHITECTURE.md`](./ERROR_ARCHITECTURE.md) |
| 在做 storage / 数据相关 | [`DATA_ARCHITECTURE.md`](./DATA_ARCHITECTURE.md) |
| 想观测 / 加日志 / 加指标 | [`OBSERVABILITY_ARCHITECTURE.md`](./OBSERVABILITY_ARCHITECTURE.md) |
| 在处理 LLM/内置代理输出、JSON schema、agent 写入边界 | [`AGENT_SOFTWARE_CONTRACT.md`](./AGENT_SOFTWARE_CONTRACT.md) |
| 安全 / 沙箱 / 审批问题 | [`SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md) |
| 配置 / 环境变量 | [`CONFIGURATION_ARCHITECTURE.md`](./CONFIGURATION_ARCHITECTURE.md) |
| Schema 演化 / API 兼容 | [`VERSIONING_AND_COMPATIBILITY.md`](./VERSIONING_AND_COMPATIBILITY.md) |
| 性能 / SLA | [`PERFORMANCE_BUDGETS.md`](./PERFORMANCE_BUDGETS.md) |
| **新建内置代理 / 切换 CLI 后端** | [`COMPONENTS.md`](./COMPONENTS.md) §3.8（BALM）+ ADR-0008 |
| **代理长程任务 / 自校验工具** | [`COMPONENTS.md`](./COMPONENTS.md) §3.9（LRAS）+ ADR-0009 |
| **痛苦信号来源 / 目标对齐** | [`INTERNALIZATION_PIPELINE.md`](./INTERNALIZATION_PIPELINE.md) §2.1.1 + ADR-0010 |
| **OKR / Mission / 任务调度** | [`COMPONENTS.md`](./COMPONENTS.md) §3.10-3.11 + ADR-0010/0011 |

---

## 📚 推荐阅读顺序

### 第一阶段：理解全局（约 1 小时）
1. [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) — 顶层视图与四大数据流
2. [`GLOSSARY.md`](./GLOSSARY.md) — 标准术语词典
3. [`PD_System_Dynamics_Model.md`](./PD_System_Dynamics_Model.md) — 系统动力学战略视角

### 第二阶段：理解领域（约 1.5 小时）
4. [`DOMAIN_MODEL.md`](./DOMAIN_MODEL.md) — 核心实体与生命周期
5. [`PD_SYSTEM_ARCHITECTURE.md`](./PD_SYSTEM_ARCHITECTURE.md) — 4 层结构与依赖
6. [`COMPONENTS.md`](./COMPONENTS.md) — 组件目录

### 第三阶段：理解流水线（约 2 小时）
7. [`INTERNALIZATION_PIPELINE.md`](./INTERNALIZATION_PIPELINE.md) — Pain → Probation → Validated
8. [`ACTIVATION_CHANNELS.md`](./ACTIVATION_CHANNELS.md) — 5 通道激活机制

### 第四阶段：理解横切关注点（约 2 小时）
9. [`DATA_ARCHITECTURE.md`](./DATA_ARCHITECTURE.md) — 数据存储与读写分离
10. [`ERROR_ARCHITECTURE.md`](./ERROR_ARCHITECTURE.md) — 错误分类与降级路径
11. [`OBSERVABILITY_ARCHITECTURE.md`](./OBSERVABILITY_ARCHITECTURE.md) — 日志/指标/追踪/审计
12. [`SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md) — 工作区/沙箱/审批/PII
13. [`CONFIGURATION_ARCHITECTURE.md`](./CONFIGURATION_ARCHITECTURE.md) — 5 级配置层级
14. [`VERSIONING_AND_COMPATIBILITY.md`](./VERSIONING_AND_COMPATIBILITY.md) — Schema 演化
15. [`PERFORMANCE_BUDGETS.md`](./PERFORMANCE_BUDGETS.md) — 性能预算

### 第五阶段：决策追溯（按需阅读）
16. [`docs/adr/`](../adr/) — 全部架构决策记录

---

## 🗂️ 文档分类

### 战略层（不易变，>= 6 个月稳定）

| 文档 | 状态 | 描述 |
|------|------|------|
| [`PD_System_Dynamics_Model.md`](./PD_System_Dynamics_Model.md) | Final | 系统动力学战略蓝图 |
| [`GLOSSARY.md`](./GLOSSARY.md) | LOCKED-ONTOLOGY | 标准术语词典 |
| [`DOMAIN_MODEL.md`](./DOMAIN_MODEL.md) | LOCKED-ONTOLOGY | 核心领域模型 |

### 架构层（中等稳定，每个 minor 版本可能调整）

| 文档 | 状态 | 描述 |
|------|------|------|
| [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) | **Active / SSoT** | **架构总览（必读入口）** |
| [`PD_SYSTEM_ARCHITECTURE.md`](./PD_SYSTEM_ARCHITECTURE.md) | Active | 4 层结构 + 物理依赖 |
| [`COMPONENTS.md`](./COMPONENTS.md) | Active | 组件目录 |
| [`INTERNALIZATION_PIPELINE.md`](./INTERNALIZATION_PIPELINE.md) | Active | Pain → Probation → Validated |
| [`ACTIVATION_CHANNELS.md`](./ACTIVATION_CHANNELS.md) | Active | 5 通道激活 |

### 横切层（持续演进）

| 文档 | 状态 | 描述 |
|------|------|------|
| [`DATA_ARCHITECTURE.md`](./DATA_ARCHITECTURE.md) | Active | 数据存储 |
| [`ERROR_ARCHITECTURE.md`](./ERROR_ARCHITECTURE.md) | Active | 错误处理 |
| [`OBSERVABILITY_ARCHITECTURE.md`](./OBSERVABILITY_ARCHITECTURE.md) | Active | 可观测性 |
| [`AGENT_SOFTWARE_CONTRACT.md`](./AGENT_SOFTWARE_CONTRACT.md) | Active | LLM/代理输出进入软件系统的契约 |
| [`SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md) | Active | 安全 |
| [`CONFIGURATION_ARCHITECTURE.md`](./CONFIGURATION_ARCHITECTURE.md) | Active | 配置管理 |
| [`VERSIONING_AND_COMPATIBILITY.md`](./VERSIONING_AND_COMPATIBILITY.md) | Active | 版本与兼容 |
| [`PERFORMANCE_BUDGETS.md`](./PERFORMANCE_BUDGETS.md) | Active | 性能预算 |

### 历史与废弃文档

| 文档 | 状态 | 处理 |
|------|------|------|
| `pd-task-manager.md` | Partially Implemented | 保留作迁移参考；多数概念已被 TaskRecord + IdleTrigger 替代 |

---

## 🧭 决策查阅指南

| 遇到的问题 | 应该查阅的文档 |
|------------|---------------|
| **术语 / 命名歧义** | `GLOSSARY.md` |
| **代码放哪个包** | `PD_ARCHITECTURE_OVERVIEW.md` §2 + `COMPONENTS.md` |
| **新增组件应放哪一层** | `PD_SYSTEM_ARCHITECTURE.md` §3 |
| **流水线某个步骤的归属** | `INTERNALIZATION_PIPELINE.md` |
| **新通道怎么接入激活** | `ACTIVATION_CHANNELS.md` |
| **错误类别选什么** | `ERROR_ARCHITECTURE.md` §1 |
| **数据存哪里** | `DATA_ARCHITECTURE.md` §2 |
| **怎么加 telemetry / metric** | `OBSERVABILITY_ARCHITECTURE.md` |
| **LLM 输出/JSON 解析/代理写入边界怎么设计** | `AGENT_SOFTWARE_CONTRACT.md` |
| **Sandbox / 工作区隔离** | `SECURITY_ARCHITECTURE.md` |
| **配置文件怎么写** | `CONFIGURATION_ARCHITECTURE.md` |
| **Schema 升级怎么做** | `VERSIONING_AND_COMPATIBILITY.md` |
| **性能预算多少** | `PERFORMANCE_BUDGETS.md` |
| **决策为什么这么定** | `docs/adr/` |

---

## 📎 相关文档目录

### 架构决策记录（ADR）

| ADR | 状态 | 主题 |
|-----|------|------|
| [ADR-0001](../adr/0001-runtime-v2-service-boundaries.md) | Accepted | Runtime V2 服务边界 |
| [ADR-0002](../adr/0002-hard-internalization-core-boundary.md) | Accepted | 硬内化核心边界 |
| [ADR-0003](../adr/0003-peer-agent-state-machine-orchestration.md) | Accepted | Peer Agent 状态机编排 |
| [ADR-0004](../adr/0004-l2-auto-correction-and-replay.md) | Accepted | L2 自动校正与回放 |
| [ADR-0005](../adr/0005-nocturnal-internalization-merger.md) | Accepted | Nocturnal 与 Internalization 合并 |
| [ADR-0006](../adr/0006-hybrid-activation-mechanism.md) | Accepted | 5 通道混合激活机制 |
| [ADR-0007](../adr/0007-cli-vs-console-audience-separation.md) | Accepted | pd-cli 与 pd-console 受众分离 |
| ADR-0008 | Accepted | Built-in Agent Lifecycle Manager（BALM）|
| ADR-0009 | Accepted | Long-Running Agent Session（LRAS）|
| ADR-0010 | Accepted | Goal-Aligned Pain Signal（GAP）|
| ADR-0011 | Accepted | Three-Tier Task Model and MissionScheduler |

### 架构治理（Governance）

| 文档 | 描述 |
|------|------|
| [`../architecture-governance/README.md`](../architecture-governance/README.md) | 渐进式架构治理 |
| [`../architecture-governance/ARCHITECTURE_GUARDRAILS.md`](../architecture-governance/ARCHITECTURE_GUARDRAILS.md) | 架构守则 |
| [`../architecture-governance/PRINCIPLE-TREE-ARCHITECTURE.md`](../architecture-governance/PRINCIPLE-TREE-ARCHITECTURE.md) | 原则树具象化约定（与 DOMAIN_MODEL 互补）|
| [`../architecture-governance/GRADUAL_ROADMAP.md`](../architecture-governance/GRADUAL_ROADMAP.md) | 渐进式重构路线 |
| [`../architecture-governance/PR_ARCHITECTURE_CHECKLIST.md`](../architecture-governance/PR_ARCHITECTURE_CHECKLIST.md) | PR 检查清单 |

### 架构评审记录

| 文档 | 描述 |
|------|------|
| [`../reviews/architecture-review-2026-05-15.md`](../reviews/architecture-review-2026-05-15.md) | 2026-05 架构评审 + 改进 RFC |

### Runtime V2 工作集

| 文档 | 描述 |
|------|------|
| [`../pd-runtime-v2/README.md`](../pd-runtime-v2/README.md) | Runtime V2 文档索引 |
| [`../pd-runtime-v2/runtime-v2-milestone-roadmap.md`](../pd-runtime-v2/runtime-v2-milestone-roadmap.md) | M1-M9 里程碑 |

### 顶层文档

| 文档 | 描述 |
|------|------|
| [`../../README.md`](../../README.md) | 项目首页 |
| [`../GETTING-STARTED.md`](../GETTING-STARTED.md) | 用户入门 |
| [`../USER_GUIDE.md`](../USER_GUIDE.md) | 用户指南 |
| [`../DEVELOPMENT.md`](../DEVELOPMENT.md) | 开发指南 |

---

## 🏗️ 文档贡献规范

### 1. 术语使用

- 所有代码、Schema、Linear issue title、ADR **必须**使用 [`GLOSSARY.md`](./GLOSSARY.md) 定义的标准词
- 新增 / 修改术语 **必须** 同步修订 `GLOSSARY.md` 与 `DOMAIN_MODEL.md`

### 2. 状态标记

每个文档头部必须标注状态：

| 状态 | 含义 |
|------|-----|
| `Draft` | 草稿，尚未通过评审 |
| `Active` | 正在使用，定期演进 |
| `Accepted` | 决策已通过（ADR 用）|
| `Proposed` | 提案中（ADR 用）|
| `LOCKED-ONTOLOGY` | 锁定，修改需走严格流程 |
| `Final` | 战略文档，长期不变 |
| `Deprecated` | 已废弃，保留参考 |

### 3. 交叉引用

- 文档间应**互相引用**，避免重复定义
- 引用时使用相对路径
- 如发现冲突，按 [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) §8.2 流程处理

### 4. 修改流程

| 文档类型 | PR 标签 | 评审要求 |
|---------|---------|---------|
| `LOCKED-ONTOLOGY` 文档 | `[ONTOLOGY]` | 至少 2 名架构维护者批准 |
| `Active` 文档 | `[ARCHITECTURE]` | 至少 1 名架构维护者批准 |
| ADR | `[ADR]` | 至少 1 名架构维护者 + 1 名相关 owner |
| 横切文档 | `[CROSS-CUTTING]` | 至少 1 名架构维护者 |

### 5. 废弃处理

废弃文档**不要直接删除**：

1. 头部加 `Status: Deprecated` 标记
2. 顶部链接指向新文档
3. 保留 2 个 minor 版本后移到 `archive/` 子目录

---

## 🔗 核心概念快速索引

| 概念 | 定义位置 | 状态 |
|------|---------|------|
| Principle | `DOMAIN_MODEL.md` §2.1 | LOCKED |
| Rule | `DOMAIN_MODEL.md` §2.2 | LOCKED |
| Implementation | `DOMAIN_MODEL.md` §2.3 | LOCKED |
| Pain Signal | `DOMAIN_MODEL.md` §4 + `GLOSSARY.md` §1 | LOCKED |
| Internalization Channel（5 通道）| `DOMAIN_MODEL.md` §3 + `ACTIVATION_CHANNELS.md` §3 | LOCKED |
| L1 / L2 / L3 | `DOMAIN_MODEL.md` §3 + `PD_System_Dynamics_Model.md` §4 | LOCKED |
| Pruning Signal | `DOMAIN_MODEL.md` §4 | LOCKED |
| Approval | `DOMAIN_MODEL.md` §5.4 + `ACTIVATION_CHANNELS.md` §2.3 | Active |
| PIArtifact | `DOMAIN_MODEL.md` §5.5 + `INTERNALIZATION_PIPELINE.md` §3.6 | Active |
| Peer Runner | `GLOSSARY.md` §2 + `INTERNALIZATION_PIPELINE.md` §3.4 | Active |
| RuntimeAdapter | `GLOSSARY.md` §2 + `COMPONENTS.md` §3.5 | Active |
| PDErrorCategory | `ERROR_ARCHITECTURE.md` §1 | Active |
| GFI | `PD_ARCHITECTURE_OVERVIEW.md` + `COMPONENTS.md` §3.6 | Active |

---

## 📊 文档完整性自检

> 此清单用于评估架构文档是否完整。新增功能时自检是否有对应文档章节。

| 维度 | 文档 | 完整 |
|-----|------|-----|
| ✅ 系统边界 | `PD_ARCHITECTURE_OVERVIEW.md` §2 | ✅ |
| ✅ 核心模块 | `COMPONENTS.md` | ✅ |
| ✅ 数据流 | `PD_ARCHITECTURE_OVERVIEW.md` §4 + 各 PIPELINE 文档 | ✅ |
| ✅ 服务职责 | `COMPONENTS.md` + `PD_SYSTEM_ARCHITECTURE.md` | ✅ |
| ✅ 外部依赖 | `PD_SYSTEM_ARCHITECTURE.md` §2.2 | ✅ |
| ✅ 安全约束 | `SECURITY_ARCHITECTURE.md` | ✅ |
| ✅ 性能约束 | `PERFORMANCE_BUDGETS.md` | ✅ |
| ✅ 幂等约束 | `INTERNALIZATION_PIPELINE.md` §6.2 + `ACTIVATION_CHANNELS.md` §6.3 | ✅ |
| ✅ 可观测约束 | `OBSERVABILITY_ARCHITECTURE.md` | ✅ |
| ✅ 模块设计 | `PD_SYSTEM_ARCHITECTURE.md` §3 | ✅ |
| ✅ 接口契约 | `COMPONENTS.md` + 各 ADR | ✅ |
| ✅ 服务组件 | `COMPONENTS.md` §3 | ✅ |
| ✅ 仓储分层 | `DATA_ARCHITECTURE.md` §6 | ✅ |
| ✅ Schema 设计 | `DATA_ARCHITECTURE.md` §3-4 + `VERSIONING_AND_COMPATIBILITY.md` | ✅ |
| ✅ 状态管理分层 | `DOMAIN_MODEL.md` §5 + `INTERNALIZATION_PIPELINE.md` | ✅ |
| ✅ 抽象稳定性 | `VERSIONING_AND_COMPATIBILITY.md` §7 | ✅ |
| ✅ 错误处理 | `ERROR_ARCHITECTURE.md` | ✅ |
| ✅ 配置管理 | `CONFIGURATION_ARCHITECTURE.md` | ✅ |

---

## ⚠️ 重要提示

> **修改任何架构文档前**：
>
> 1. 先看 [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) §8（变更流程）
> 2. 改动是否影响 ADR？是 → 先提 ADR 修订
> 3. 是否影响其他文档？列出受影响文档清单
> 4. PR 描述需说明：受影响下游 / 是否破坏性 / 测试验证

> **始终首先参考 [`GLOSSARY.md`](./GLOSSARY.md) 与 [`DOMAIN_MODEL.md`](./DOMAIN_MODEL.md)，确保术语一致**。
