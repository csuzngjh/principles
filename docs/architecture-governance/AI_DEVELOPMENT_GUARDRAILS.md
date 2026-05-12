# AI 辅助开发护栏架构设计 (AI Development Guardrails)

> **文档状态**: Active / 战略级指导文档
> **最后更新**: 2026-05-11
> **目标读者**: 人类架构师、参与开发的 AI Agents (Gemini, Claude, Cursor 等)

## 1. 背景与挑战 (The Crisis of Local Optima)

随着 PD 项目的开发大量采用 AI 驱动，系统面临着**“架构熵增”**的严重威胁。AI 助手是“局部最优”的执行者：为了最快地完成当前的 feature 或 fix，AI 倾向于：
- 破坏现有的领域边界（例如，在底层的纯粹业务逻辑中引入外部的框架 API）。
- 绕过严格的状态机（例如，强行篡改任务状态以跳过验证）。
- 在各处随意定义雷同的临时 Interface，导致数据契约碎裂。

为了确保 PD 项目在持续迭代中**完善而不失控**，我们必须建立一套“护栏架构 (Guardrails Architecture)”。这不是一本长篇大论的教程，而是**绝对不可逾越的红线集合**。

---

## 2. 顶层设计：系统边界与隔离红线 (Top-Level Boundaries)

顶层设计的核心是“物理隔离”，确保大面积的腐化无法跨层蔓延。

### 2.1 依赖倒置红线 (Dependency Inversion)
- **`@principles/core` (核心域)**：这是系统的绝对核心，包含领域模型 (Ontology)、状态机和诊断引擎。
  - **禁令**：**绝对禁止**在 Core 层引入 `openclaw-plugin` 的任何文件。
  - **禁令**：**绝对禁止**在 Core 层包含特定于具体宿主框架的耦合代码。
- **`openclaw-plugin` (宿主接入层)**：负责与外围环境交互（如 Hooks、HTTP 请求）。
  - **禁令**：**绝对禁止**在宿主接入层编写复杂的业务判断逻辑。所有决策必须委托给 Core 层的 `Adapter` 或 `Runner`。

### 2.2 数据流向红线 (Data Flow One-Way Street)
- 数据必须单向流动：`Pain Signal` 只能由宿主环境（外围）捕获，标准化后流入核心域（内部）进行存储和诊断。
- 核心域绝对不能反向去“轮询”宿主框架的特定内部状态，必须通过显式注入的上下文或接口获取。

---

## 3. 中层设计：契约与状态机护栏 (Mid-Level Contracts)

中层设计是防腐的核心。AI 可以自由优化函数的内部算法（局部实现），但**绝对不可擅自修改中层契约**。

### 3.1 数据契约的唯一真相 (Single Source of Truth for Schemas)
- **问题**：过去 Types 和 Interface 散落在各处，AI 经常就地定义临时结构。
- **护栏设计**：
  - 所有的核心领域实体（Principle, Rule, Task, DiagnosticianOutput）必须集中在 `@principles/core/src/contracts` 目录。
  - **运行时防腐**：仅有 TypeScript interface 是不够的，必须使用 `TypeBox` 或 `Zod` 定义 Schema，并在系统边界强制进行运行时校验。
  - **修改权限**：未经人类架构师批准，**严禁修改或扩展已有的核心 Schema**。

### 3.2 绝对刚性的状态机 (Strict State Machines)
- **问题**：幽灵状态。AI 可能会直接将一个任务从 `pending` 强行置为 `succeeded`，引发状态断层。
- **护栏设计**：
  - 必须使用集中式的状态机配置（如 `TaskStateMachine`）。
  - **强制转换验证**：状态的变更不能通过简单的对象赋值 (`task.status = 'succeeded'`) 实现。必须通过状态机提供的方法进行，确保前置条件验证通过。

### 3.3 抽象与实现的分离 (Stable Abstraction vs. Local Implementation)
- **稳定的抽象 (Stable Abstraction)**：
  - 各类 `Adapter` 接口、`Runner` 基类属于稳定抽象。
  - **规则**：增删方法属于架构变更，触发高压审查。
- **局部的实现 (Local Implementation)**：
  - 比如 `PrincipleCompiler` 内部使用什么模板拼接，这属于局部实现。
  - **规则**：允许 AI 自由重构，只要能通过对应的 Unit Test。

---

## 4. 落地与执行 (Execution)

这些护栏不仅仅停留在文档层面，必须：
1. 以 `GEMINI.md` 等形式下发到各个 Package 作为 AI Context。
2. 通过架构测试（Architecture Regression Tests）物理阻断越权的代码提交。
3. 未来的所有重构必须以此文档作为验收标准。
