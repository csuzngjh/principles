# ADR-0009: Long-Running Agent Session (LRAS)

> **状态**: Deferred by ADR-0014 (不得作为当前实施依据)
> **日期**: 2026-05-16
> **相关**: COMPONENTS.md, DATA_ARCHITECTURE.md

> **2026-05-24 ADR-0014 修订**: LRAS 是 post-MVP conditional design。不得以 Phase 1C/1D、Attribution 或“完整代理生命周期”为理由在 MVP 阶段派工。重启必须满足 [post-mvp-conditional-roadmap.md](../plans/post-mvp-conditional-roadmap.md) 的外部反馈条件并经维护者批准。


## 1. 背景与痛点 (Context)

PD 系统此前的代理调用模式（如 OpenClaw 的单次调度）是一种“一锤子买卖”。每次请求都有着严格的超时限制（通常 30 秒到 3 分钟）。
然而，对于架构级的重构、复杂的环境配置或是涉及多个子系统的大规模诊断（Dreamer/Artificer 的工作），Agent 需要进行长时间的探索、反复试错和查阅文档。现有的短生命周期模式导致：
1. Agent 经常在工作进行到一半时被强行掐断（Timeout）。
2. 被切断后再次唤醒时，完全丢失了上一轮的“工作记忆（Scratchpad）”，导致陷入无尽的重试死循环（Rework Loop）。

## 2. 决策详情 (Decisions)

我们决定将内部 AI 代理的执行范式从“单次响应（Request-Response）”升级为 **Long-Running Agent Session (LRAS)** 模式。

### 2.1 长程会话基座 (Session Base)
- **最低时长保障**：默认的内部代理工作周期（Session）从分钟级提升至以“10分钟起步，可达数小时”。不再因为单次 LLM 响应超时而销毁任务。
- **会话持久化**：引入 `AgentSession` 服务，每次会话启动时都会被分配唯一的 `session_id`。

### 2.2 状态恢复与检查点 (Checkpoints & Recovery)
- **数据库扩表**：新增 `agent_session_checkpoints` 状态表。
- **高频存档**：每当 Agent 执行了关键决策（如工具调用完毕、子阶段完成），系统强制将其当前的状态（State）、工作草稿（Scratchpad）和历史动作（Tool Call History）序列化保存为一个 Checkpoint。
- **崩溃恢复 (Recovery Sweep)**：如果宿主进程意外崩溃，`RecoverySweep` 在下次启动时会扫描未完成的 Session，并从最近的一个 Checkpoint 自动“读档”继续执行。

### 2.3 自愈与反馈回灌 (Self-Validation & Log Backflow)
- **赋予 Agent PD 级元工具 (Meta-tools)**：将 PD 系统的部分能力包装为工具开放给 LRAS 代理（如 `pd_validate_output`, `pd_fetch_recent_logs`, `pd_schema_check`）。
- 代理在完成阶段性代码修改后，可以自己调用 `pd_validate_output` 进行在线校验。
- 如果构建失败，`LogBackflow` 服务会自动捕获异常并将日志脱敏后“倒灌”给代理，让其自行修复，无需中断整个长程任务。

### 2.4 不变量约束 (Invariants)
- `LRAS-1`：每一个启动的 LRAS session 在结束前，至少必须产生 1 个物理落盘的 Checkpoint。
- `LRAS-2`：代理所使用的 `SelfValidationTools` 必须绝对保证没有副作用（只读模式），以防代理在校验阶段破坏真实环境。
- `LRAS-3`：`LogBackflow` 倒灌的日志必须经过脱敏层（Log Sanitizer），防止将敏感环境变量泄露入提示词中。

## 3. 架构收益 (Consequences)

### 积极影响 (Pros)
- **真正的系统级干预能力**：Agent 终于可以承接耗时数小时的超大重构任务，不再受限于框架超时。
- **极强的韧性 (Resilience)**：基于 Checkpoint 的状态机让系统无惧意外重启。

### 潜在风险 (Cons / Mitigations)
- *风险*：长程会话如果不加节制，可能会导致 Token 消耗失控，形成天价账单。
- *缓解*：必须结合 Performance Budgets（预算限制），每个 Session 设定硬性的 Token/美元 上限，一旦触顶强制抛出异常并冻结。
