# ADR 0003: Transition from Synchronous Subagents to Asynchronous Peer Agents via State Machine

**Date**: 2026-05-03
**Status**: Proposed (Cancels & Replaces Migration Phases 3/4/5)
**Context Domain**: `@principles/core/runtime-v2` & `nocturnal-trinity`

## 1. Context & Problem Statement

在推进 PD 系统从 OpenClaw 插件层向 `@principles/core` 独立 SDK 迁移的过程中（PRI-50），我们在前两个阶段（Phase 1 & 2）成功剥离了纯类型和数据读取逻辑。然而，在规划后续的夜间反思链（Trinity）和后台守护进程（Evolution Worker）迁移时，暴露出了严重的架构债务。

当前的 `nocturnal-trinity` 和 `evolution-worker` 采用了**“主子代理（Main/Subagent）”的同步阻塞调用模式**。主控制器作为一个“上帝类（God Class）”，硬编码了从 Dreamer -> Philosopher -> Scribe 的完整执行顺序。

为了将这套系统搬入 Core，早期的 Phase 3/4/5 计划（PRI-58, 59, 60）试图在 Core 中发明 `JobScheduler`（定时器）、`IdleDetector`（空闲检测）和 `SubagentRuntime`（子代理运行时）等接口。这种“带病迁移”会导致：
1. **领域越界**：操作系统级别的调度（Cron/Idle）被强塞进业务内核。
2. **高耦合**：一旦某个子环节崩溃，整个夜间反射链条断裂且难以恢复。
3. **架构倒退**：没有利用已有的 Runtime V2（SQLite 状态机）的强大威力，反而继续使用落后的内存同步调用。

## 2. Decision

我们决定废弃基于“子代理（Subagent）”和“硬编码工作流”的同步编排模式。
全面转向基于 **“独立代理（Peer Agents） + SQLite 异步任务队列”** 的事件驱动微服务架构。

具体实施决策如下：

1. **废除阶级，全员独立 (Peer Agents)**：
   不再有“主代理”派发任务给“子代理”的概念。Dreamer, Philosopher, Scribe, Artificer 全部升格为与 Diagnostician 平级的独立 Runner（独立工人）。
2. **状态机即总线 (SQLite Task Store as Message Bus)**：
   使用 Runtime V2 已经建好的 `SqliteTaskStore` 和 `SqliteRunStore` 作为唯一的通信枢纽。
   * 触发器发现满足条件的原则，仅仅是在数据库插入一个 `Trinity_Dreamer_Task`。
   * `DreamerRunner` 从数据库拉取 Task 执行。完成后，其结果 (Artifact) 存入状态库，并生成一个新的 `Trinity_Philosopher_Task` 压入队列。
3. **净化核心边界 (Pure Core SDK)**：
   `@principles/core` 绝对不允许包含 `cron`, `setInterval`, 或是探针级别的 `IdleDetector` 逻辑。
   Core 只提供 `executeNextPendingTask(agentType)` 接口。
   何时触发这个接口（无论是定时器、文件监听还是空闲钩子），必须由外围宿主应用（如 OpenClaw Plugin）全权负责。

## 3. Consequences

### Positive (收益)
* **极速瘦身**：彻底砍掉 `local-worker-routing` 等复杂的路由黑盒代码。
* **极致鲁棒性**：任何一个环节（如大模型限流）导致失败，Task 状态变为 `retry_wait`。下次宿主唤醒时，系统会自动从断点无缝恢复，绝不丢失进度。
* **无限扩展性**：未来添加新的评估环节（如 Evaluator Agent），只需在状态机中插加一个 Task 节点，无需修改复杂的串行编排代码。

### Negative (代价)
* **短期重构成本**：需要将 `nocturnal-trinity.ts` 中一气呵成的过程式代码，打碎重构成基于 Task 状态流转的异步逻辑。
* **取消旧计划**：原定的 Linear 任务 PRI-58, PRI-59, PRI-60 需作废，代之以基于此 ADR 的新重构任务（如 "Refactor Trinity to SQLite Task Machine"）。

## 4. Actions

- [ ] 提交本 ADR 进行架构师与技术负责人的评审。
- [ ] 若通过，立即在 Linear 中冻结/作废 PRI-58~60。
- [ ] 规划新的 "Phase 3: Event-Driven Trinity Pipeline" 实施计划。