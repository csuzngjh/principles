# ADR-0011: Three-Tier Task Model and MissionScheduler

> **状态**: Accepted
> **日期**: 2026-05-16
> **相关**: COMPONENTS.md, DATA_ARCHITECTURE.md

> **2026-05-23 修订**: [ADR-0012](./0012-runtime-v2-standalone-scheduling-and-legacy-retirement.md) 规定 `MissionScheduler` 如继续实施，必须是 PD-owned、host-agnostic 的显式调度边界。本文提及 `IdleTrigger` 作为唤醒来源的部分已废止；不得建设 OpenClaw idle/night 触发适配器。

## 1. 背景与痛点 (Context)

PD 系统早期的任务调度机制（如 `IdleTrigger` 和原先的 `TaskStore`）是非常扁平的：任务就是一个简单的列表，后台的 Worker 采用暴力的“心跳轮询（Polling）”来寻找处于 `pending` 状态的任务执行。

随着 ADR-0009 (长程会话 LRAS) 和 ADR-0010 (目标对齐痛点 GAP) 的引入，系统的运行模式发生了巨变：
1. 任务的执行时间被无限拉长（数十分钟到数天），简单的轮询不仅浪费资源，也无法管理长期被占用的租约（Lease）。
2. 单一的 `task` 无法表达复杂的依赖关系。有些诊断任务必须在先置的修复任务完成后才能启动。
3. 任务缺乏与业务大局（Mission）的联动。

## 2. 决策详情 (Decisions)

我们决定彻底废弃扁平的任务轮询模型，引入 **三层任务模型 (Three-Tier Task Model)** 与 **`MissionScheduler` 核心调度器**。

### 2.1 三层任务模型
系统的执行粒度被严密地划分为三个层级，自上而下包含：
1. **Tier 1: Mission (战役)**
   - 对应 `missions` 表。
   - 具有明确的业务背景和预期交付时间（Expected Duration）。通常由架构师或高维规划 Agent 生成。
2. **Tier 2: Task (任务)**
   - 对应扩展后的 `tasks` 表。包含 `mission_id` 关联字段。
   - 新增 `priority` (优先级, 0-100) 和 `depends_on` (前置依赖, JSON 数组) 字段，支持复杂的 DAG (有向无环图) 拓扑。
3. **Tier 3: Run / Session (执行实例)**
   - 对应 `agent_session_checkpoints` 和现有的 `runs` 记录。
   - 具体的物理执行容器，允许因为崩溃而产生多个属于同一个 Task 的重试实例。

### 2.2 引入 `MissionScheduler` 调度引擎
全面接管并替换简单的 `IdleTrigger` 盲目轮询逻辑。
`MissionScheduler` 作为核心的服务单例，负责：
- **依赖解析 (Dependency Resolution)**：在分配 Task 时，检查其 `depends_on` 列表，如果前置任务未处于 `succeeded` 状态，该任务永远保持阻塞，不会被投入就绪队列。
- **优先级抢占 (Priority Preemption)**：高优先级的任务（如针对 Critical 级痛点的反思）优先被调度给空闲的 Agent Runner。
- **战役状态收敛 (Mission State Rollup)**：当一个 Mission 挂载的所有 Task 都流转至终态后，自动将 Mission 的状态置为 `succeeded` 或 `failed`，并触发相应的 GAP 信号判定。

### 2.3 不变量约束 (Invariants)
- `SCHED-1`：**记录回溯**。`MissionScheduler` 调度失败必须记录 reason 供回溯。
- `SCHED-2`：**调度所有权**。PD-owned SDK/operator/scheduler 负责唤醒并委托给 `MissionScheduler`；不得从 OpenClaw idle/night 状态派生执行入口。

## 3. 架构收益 (Consequences)

### 积极影响 (Pros)
- **具备工业级编排能力**：PD 从一个“随时可能被中断的小脚本”，正式变为了能调度跨日级别的多 Agent 协作工作流引擎。
- **资源利用率最优化**：消除了无意义的空转轮询，严格基于依赖图进行唤醒。

### 潜在风险 (Cons / Mitigations)
- *风险*：DAG 的死锁检测和长程任务管理会大幅增加 `@principles/core` 调度层的实现复杂度。
- *缓解*：在第一阶段，仅支持线性或最简单的树状依赖；并强制要求 `priority` 和 `depends_on` 设置默认兜底值。
