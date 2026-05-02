# PD 核心领域模型与通用语言 (Ubiquitous Language)

> **文档状态**: 强制执行 (LOCKED-ONTOLOGY)
> **最后更新**: 2026-05-02
> **背景**: 本文档是对 `docs/architecture-governance/PRINCIPLE-TREE-ARCHITECTURE.md` 的具象化与工程化约定，旨在消除日常开发中的语义分裂。

---

## 1. 核心三层进化模型 (The 3-Tier Evolution Hierarchy)

在 PD 系统中，知识的内化必须严格遵循“原则 -> 规则 -> 实现”的三层降维结构。任何代码变量命名、UI 展示和 Linear Issue 描述必须使用以下标准术语。

### 1.1 原则 (Principle) - 树根
*   **英文名**: `Principle` / `LedgerPrinciple`
*   **语义定义**: 高维智慧、价值观、哲学指导。它描述了“为什么（Why）”和“大方向（What）”。
*   **数据载体**: 自然语言（通常存在 Prompt 中）。
*   **示例**: `P_001` - "保持代码库的原子性，不要混合多个任务的修改。"
*   **生命周期**: 由 `Diagnostician` (诊断者) 从痛点中提炼。属于 **L1 软内化资产**。

### 1.2 规则 (Rule) - 树干
*   **英文名**: `Rule` / `LedgerRule`
*   **语义定义**: 原则在特定边界下的**契约化表达**。它是一组可验证的触发条件和预期行为。
*   **数据载体**: 结构化元数据 (JSON Schema)。包含 `triggerCondition` 和 `enforcement`。
*   **示例**: `R_001_A` - "在 `packages/core` 目录下执行 write 工具时，必须确保当前只有一个 task 在进行。"
*   **关系约束**: 一个 Principle 可以衍生出多个 Rules (1:N)。

### 1.3 实现 (Implementation) - 树叶
*   **英文名**: `Implementation` / `CodeCandidate`
*   **语义定义**: 规则的具体**物理执行肌肉**。它是大模型或人类编写的真实代码。
*   **数据载体**: JavaScript 沙盒代码 (`.js`)，包含 `meta` 和 `evaluate()` 函数。
*   **示例**: `IMPL_001_A_v1` - 一段通过正则表达式检查传入参数并返回 `{ decision: 'block' }` 的代码。
*   **关系约束**: 一个 Rule 可以有多个 Implementations 候选，但同一时间只能有一个是 `active` 的。属于 **L2 硬内化资产**。

---

## 2. 系统动力学与流量词汇 (System Dynamics Flow)

为了配合 PD 的系统动力学（SD）监控，以下术语用于描述系统运行时的动态行为：

*   **痛点 (Pain / Pain Signal)**：Agent 在执行任务时遭遇的具体挫败（报错、超时、人类负面反馈）。它是驱动进化的**原始输入流量**。
*   **诊断 (Diagnosis)**：寻找痛点根因的分析过程。
*   **分类 (Taxonomy)**：`Diagnostician` 将学到的经验划分为 `principle`、`rule` 或 `defer` 的决策动作。**分类精度**决定了软硬转换的效率。
*   **内化 (Internalization)**：将“文字原则”转化为“硬逻辑代码”的整个流水线作业（从 L1 向 L2 的转移）。
*   **剪枝 (Pruning)**：当 L2 的硬实现（Implementation）生效后，将 L1 的软原则从系统 Prompt 中物理剔除的行为。这是实现**系统减压**的最终动作。

---

## 3. 状态机规范 (State Machine Ontology)

在描述规则或实现的生命周期时，**严禁使用** `needs_training`、`pending` 等模糊词汇，必须使用以下标准生命周期状态：

1.  **Candidate (候选)**：新生成的代码实现，尚未经过安全校验，静置在库中。
2.  **Probation (试用/影子模式)**：通过了静态安全校验，正在系统中运行，但不阻断真实操作（仅记录命中率）。
3.  **Active (激活/实装)**：正式生效的规则或实现，具备物理拦截能力（如触发 `block` 或 `requireApproval`）。
4.  **Archived (归档)**：因历史原因保留，但不再参与任何运算。
5.  **Deprecated (废弃)**：规则或原则已被更优的逻辑替代，正式退出舞台。

---

> **架构师批注**: 
> 任何开发者在提交 PR 时，若发现新增的接口或变量名未包含上述领域词汇（例如发明了 `Law`、`Guideline`、`ConstraintCode` 等非标准词汇），请在 Code Review 阶段主动拦截并要求重构。