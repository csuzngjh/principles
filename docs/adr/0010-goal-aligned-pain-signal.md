# ADR-0010: Goal-Aligned Pain Signal (GAP)

> **状态**: Partially retained; GAP expansion deferred by ADR-0014
> **日期**: 2026-05-16
> **相关**: INTERNALIZATION_PIPELINE.md, DOMAIN_MODEL.md, DATA_ARCHITECTURE.md

> **2026-05-24 ADR-0014 修订**: 已存在的 pain capture 可继续用于 MVP 验证；`GAPSignalGenerator` 与 Mission/Objective/KeyResult 扩张为 post-MVP conditional work。Phase 1C/1D 与 Attribution 已取消，不能作为实施理由。重启条件见 [post-mvp-conditional-roadmap.md](../plans/post-mvp-conditional-roadmap.md)。


## 1. 背景与痛点 (Context)

PD 系统原本的设计中，任何底层的工具调用失败（例如 `git push` 冲突，或者少传了一个参数）都会无差别地生成 `PainSignal` 并触发 Diagnostician 的反思。
这导致了严重的**“反思噪音 (Reflection Noise)”**：
1. 系统生成了大量极度局部的、低价值的底层补丁规则（Rule），导致 Ledger 迅速膨胀。
2. 这些碎片化的问题往往在下一步的重试中自然解决，根本不配触发昂贵的系统级诊断。
3. Agent 失去了“宏观目标感”。它在不断修补坑洼，但忘记了它原本到底要走到哪里去。

## 2. 决策详情 (Decisions)

我们决定引入 **Goal-Aligned Pain (GAP) 架构**，对痛点信号的生成和触发机制进行彻底的分层降级。

### 2.1 三层信号架构 (Three-Layer Signal Architecture)
痛点被严格划分为三个层级，且**剥夺最底层信号独立触发诊断的权利**：

*   **Layer 1（主信号 / 目标驱动）**：
    *   **类型**：`mission_failed`, `mission_stalled`, `okr_drift`, `decision_skipped`, `rework_loop`。
    *   **触发**：**✅ 独立触发** Diagnostician。
    *   **来源**：由后端的 `GAPSignalGenerator` 每日或基于里程碑扫描生成。只有当长程目标受到实质性阻碍时才拉响最高警报。
*   **Layer 2（强信号 / 用户反馈）**：
    *   **类型**：`explicit_user_complaint`, `user_correction`。
    *   **触发**：**✅ 独立触发** Diagnostician。
    *   **来源**：人类用户的显式介入与干预。
*   **Layer 3（辅助信号 / 基础设施失败）**：
    *   **类型**：`tool_failure`, `empathy_inferred`。
    *   **触发**：**❌ 禁止独立触发** Diagnostician。
    *   **来源**：底层的 Hook 拦截报错。它们只能静静地躺在数据库中，作为后续 Layer 1/2 报警时的“附属作案证据（Evidence）”。

### 2.2 目标管理子系统 (Goals Subsystem)
为了支撑 Layer 1 的报警，我们需要建立真实的结构化目标管理模型。
在 SQLite 数据库中引入 3 张核心表：
1.  **`objectives`**：高维 OKR 季度目标。
2.  **`key_results`**：可量化的关键结果指标（附带自动测量 Query）。
3.  **`missions`**：具体的长程任务（关联到 Objective，拥有明确的预期周期和状态）。

### 2.3 决策卫生门控 (Decision Hygiene Gate)
- 当 Agent 企图执行高影响/破坏性的决策（如放弃目标、彻底重构）时，强制拦截并转入 `DecisionHygieneGate`。
- 如果是 `high/critical` 影响，强制进行额外的深度分析流程；普通行为则仅作警告提醒。

### 2.4 不变量约束 (Invariants)
- `GAP-1`：Layer 3 信号不得独立触发 Diagnostician，由 GAP Generator 聚合。
- `HYGIENE-1`：High/critical 影响必须强制通过 DecisionHygieneGate。

## 3. 架构收益 (Consequences)

### 积极影响 (Pros)
- **终结无意义的反思**：大幅缩减无价值的诊断任务，集中算力解决真正的战略级痛点（Mission 失败）。
- **真正的自治感**：系统终于知道“我在为了什么目标服务”，而不仅仅是一个被动的报错监控器。
- **GFI 内核极简**：Global Friction Index 不再需要做复杂的多源加权，只需要做“上层报警 + 下层证据”的组装。

### 潜在风险 (Cons / Mitigations)
- *风险*：如何准确判断一个 Mission 是 `stalled`（停滞）而非正在努力进行中？
- *缓解*：依托于 ADR-0011 引入的 MissionScheduler，基于时间预算（Time Budget）和最近 N 个 Checkpoint 的进展向量进行数学判定。
