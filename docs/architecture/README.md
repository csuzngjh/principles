# PD 架构文档索引 (Architecture Documentation Index)

> **最后更新**: 2026-05-09
> **语言**: 中文（部分子文档为英文）

本目录包含 Principles Disciple (PD) 项目的核心架构文档。这些文档按照不同的抽象层级和用途进行组织。

---

## 📖 推荐阅读顺序

```
1. DOMAIN_MODEL.md          → 理解核心术语和领域语言
        ↓
2. PD_SYSTEM_ARCHITECTURE.md → 理解三层架构和四条流水线
        ↓
3. DATA_ARCHITECTURE.md     → 理解数据存储架构
        ↓
4. ERROR_ARCHITECTURE.md    → 理解错误处理策略
        ↓
5. PD_System_Dynamics_Model.md → 理解系统动力学（宏观视角）
```

---

## 🗂️ 文档分类

### 核心本体 (LOCKED)

| 文档 | 状态 | 说明 |
|------|------|------|
| [DOMAIN_MODEL.md](./DOMAIN_MODEL.md) | **LOCKED-ONTOLOGY** | 统一领域语言，Principle/Rule/Implementation 光谱模型，生命周期状态机 |

### 目标架构蓝图 (Active)

| 文档 | 状态 | 说明 |
|------|------|------|
| [PD_SYSTEM_ARCHITECTURE.md](./PD_SYSTEM_ARCHITECTURE.md) | **Accepted** | 3 大物理层级，4 条核心流水线，包边界 |
| [DATA_ARCHITECTURE.md](./DATA_ARCHITECTURE.md) | **Active** | 数据存储架构，读写分离，迁移策略 |
| [ERROR_ARCHITECTURE.md](./ERROR_ARCHITECTURE.md) | **Active** | PDErrorCategory 错误分类，PDRuntimeError，降级路径 |

### 战略分析与治理 (Strategy & Governance)

| 文档 | 状态 | 说明 |
|------|------|------|
| [../architecture-governance/AI_DEVELOPMENT_GUARDRAILS.md](../architecture-governance/AI_DEVELOPMENT_GUARDRAILS.md) | **Active** | AI 辅助开发护栏架构，防止大模型破坏系统边界和契约 |
| [PD_System_Dynamics_Model.md](./PD_System_Dynamics_Model.md) | **Final** | 系统动力学视角，存量/流量/反馈回路分析 |

### 历史与废弃文档

| 文档 | 状态 | 说明 |
|------|------|------|
| [pd-task-manager.md](./pd-task-manager.md) | **Partially Implemented** | Task Manager 设计，已部分实施（cron-initializer.ts 已删除） |

---

## 🔍 决策查阅指南

| 遇到的问题 | 应该查阅的文档 |
|------------|---------------|
| **术语/命名歧义** | DOMAIN_MODEL.md → 命名禁区（Section 8） |
| **代码放哪个包** | PD_SYSTEM_ARCHITECTURE.md → Section 0（包边界） |
| **流水线边界争议** | PD_SYSTEM_ARCHITECTURE.md → Section 2（四条流水线） |
| **数据存储选型** | DATA_ARCHITECTURE.md |
| **错误处理策略** | ERROR_ARCHITECTURE.md |
| **系统行为分析** | PD_System_Dynamics_Model.md |
| **迁移计划查询** | ADR（见下方）或 architecture-governance/GRADUAL_ROADMAP.md |

---

## 📎 相关文档

### 架构决策记录 (ADR)

| ADR | 状态 | 主题 |
|-----|------|------|
| [ADR-0001](../adr/0001-runtime-v2-service-boundaries.md) | Accepted | Runtime V2 Service Boundaries |
| [ADR-0002](../adr/0002-hard-internalization-core-boundary.md) | Accepted | Hard Internalization Core Boundary |

### 架构治理

| 文档 | 说明 |
|------|------|
| [architecture-governance/](../architecture-governance/README.md) | 渐进式架构治理，增量迁移策略 |
| [architecture-governance/PRINCIPLE-TREE-ARCHITECTURE.md](../architecture-governance/PRINCIPLE-TREE-ARCHITECTURE.md) | 原则树设计的具象化约定 |

### 废弃文档

| 文档 | 废弃原因 |
|------|---------|
| [../ARCHITECTURE.md](../ARCHITECTURE.md) | 已被 PD_SYSTEM_ARCHITECTURE.md 取代 |

---

## 🏗️ 文档贡献规范

1. **术语使用**：所有代码、schema、Linear issue title 和 ADR 必须使用 DOMAIN_MODEL.md 定义的标准术语
2. **状态标记**：每个文档头部必须标注状态（Draft / Active / Accepted / LOCKED-ONTOLOGY / Deprecated）
3. **交叉引用**：文档间应互相引用，避免重复定义
4. **废弃处理**：废弃文档必须添加废弃标记并指向替代文档
5. **代码锚点**：架构描述必须指向实际代码位置，不得描述不存在的组件

---

## 🔗 核心概念索引

| 概念 | 定义位置 | 状态 |
|------|---------|------|
| Principle | DOMAIN_MODEL.md Section 1-2 | LOCKED |
| Rule | DOMAIN_MODEL.md Section 1-3 | LOCKED |
| Implementation | DOMAIN_MODEL.md Section 1-4 | LOCKED |
| Pain Signal | DOMAIN_MODEL.md Section 4 | LOCKED |
| Internalization (L1/L2/L3) | DOMAIN_MODEL.md Section 3 | LOCKED |
| Pruning Signal | DOMAIN_MODEL.md Section 4 | LOCKED |
| Pruning Review | DOMAIN_MODEL.md Section 5.3 | LOCKED |
| PDErrorCategory | ERROR_ARCHITECTURE.md Section 1 | Active |
| GFI | PD_SYSTEM_ARCHITECTURE.md Section 3 | Active |

---

> **注意**: 在进行代码修改或 ADR 编写时，请始终首先参考 `DOMAIN_MODEL.md` 以确保术语的一致性。
