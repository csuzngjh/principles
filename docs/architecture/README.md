# PD 架构文档索引 (Architecture Documentation Index)

本目录包含 Principles Disciple (PD) 项目的核心架构文档。这些文档按照不同的抽象层级和用途进行组织：

## 1. 核心本体 (The Ontology)
- **[DOMAIN_MODEL.md](./DOMAIN_MODEL.md)**: **强制执行 (LOCKED-ONTOLOGY)**。定义了项目的统一领域语言（Ubiquitous Language）和核心实体（Principle, Rule, Implementation）的语义及生命周期。它是所有重构和开发的最高准则。

## 2. 目标架构蓝图 (Target Architecture)
- **[PD_SYSTEM_ARCHITECTURE.md](./PD_SYSTEM_ARCHITECTURE.md)**: **目标分层架构蓝图**。详细规划了 3 大物理层级和 5 个功能子系统。它定义了各子系统的功能边界和物理边界，是代码重构的实施蓝图。
  - 注意：其中的 Core 层包含 **Pure Domain Model** 与 **Core Runtime SDK** 两个子边界。不要把“core 不依赖宿主”误读为“core 不能拥有 Runtime V2 store/read-model/service”。

## 3. 战略分析 (Strategic Analysis)
- **[PD_System_Dynamics_Model.md](./PD_System_Dynamics_Model.md)**: **战略/系统动力学分析**。从系统动力学（Stock, Flow, Feedback Loop）视角解释系统进化的动力源泉和瓶颈（上下文压力）。此文档提供宏观视角，**不得覆盖或违反 DOMAIN_MODEL.md 中的实体定义**。

## 4. 历史与细节设计 (Historical & Detailed Design)
- **[pd-task-manager.md](./pd-task-manager.md)**: 任务管理器的详细设计文档。除非明确重新验证，否则视为历史设计参考。

---

> **注意**: 在进行代码修改或 ADR 编写时，请始终首先参考 `DOMAIN_MODEL.md` 以确保术语的一致性。
