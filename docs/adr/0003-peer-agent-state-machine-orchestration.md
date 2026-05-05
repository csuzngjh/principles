# ADR 0003: Transition from Synchronous Subagents to Asynchronous Peer Agents via State Machine

**Date**: 2026-05-03
**Status**: Proposed (Cancels & Replaces Migration Phases 3/4/5)
**Context Domain**: `@principles/core/runtime-v2` & `nocturnal-trinity`

## 1. Context & Problem Statement

在推进 PD 系统从 OpenClaw 插件层向 `@principles/core` 独立 SDK 迁移的过程中（PRI-50），我们在前两个阶段（Phase 1 & 2）成功剥离了纯类型和数据读取逻辑。然而，在规划后续的夜间反思链（Trinity）和后台守护进程（Evolution Worker）迁移时，暴露出了严重的架构债务。

当前的 `nocturnal-trinity` 和 `evolution-worker` 采用了**"主子代理（Main/Subagent）"的同步阻塞调用模式**。主控制器作为一个"上帝类（God Class）"，硬编码了从 Dreamer -> Philosopher -> Scribe 的完整执行顺序。

为了将这套系统搬入 Core，早期的 Phase 3/4/5 计划（PRI-58, 59, 60）试图在 Core 中发明 `JobScheduler`（定时器）、`IdleDetector`（空闲检测）和 `SubagentRuntime`（子代理运行时）等接口。这种"带病迁移"会导致：
1. **领域越界**：操作系统级别的调度（Cron/Idle）被强塞进业务内核。
2. **高耦合**：一旦某个子环节崩溃，整个夜间反射链条断裂且难以恢复。
3. **架构倒退**：没有利用已有的 Runtime V2（SQLite 状态机）的强大威力，反而继续使用落后的内存同步调用。

## 2. Decision

我们决定废弃基于"子代理（Subagent）"和"硬编码工作流"的同步编排模式。
全面转向基于 **"独立代理（Peer Agents） + SQLite 异步任务队列"** 的事件驱动微服务架构。

具体实施决策如下：

1. **废除阶级，全员独立 (Peer Agents)**：
   不再有"主代理"派发任务给"子代理"的概念。Dreamer, Philosopher, Scribe, Artificer 全部升格为与 Diagnostician 平级的独立 Runner（独立工人）。
2. **状态机即总线 (SQLite Task Store as Message Bus)**：
   使用 Runtime V2 已经建好的 `SqliteTaskStore` 和 `SqliteRunStore` 作为唯一的通信枢纽。
   * 触发器发现满足条件的原则，仅仅是在数据库插入一个 `Trinity_Dreamer_Task`。
   * `DreamerRunner` 从数据库拉取 Task 执行。完成后，其结果 (Artifact) 存入状态库，并生成一个新的 `Trinity_Philosopher_Task` 压入队列。
3. **净化核心边界 (Pure Core SDK)**：
   `@principles/core` 绝对不允许包含 `cron`, `setInterval`, 或是探针级别的 `IdleDetector` 逻辑。
   Core 只提供 `executeNextPendingTask(agentType)` 接口。
   何时触发这个接口（无论是定时器、文件监听还是空闲钩子），必须由外围宿主应用（如 OpenClaw Plugin）全权负责。

## 3. Principle Internalization Engine — Ownership Boundaries

The **Principle Internalization Engine** is the core module in `@principles/core` that consolidates all nocturnal training and principle internalization logic. It replaces the monolithic `nocturnal-trinity.ts` with a clean architecture.

### 3.1 Ownership Model

```
@principles/core (Pure SDK)
  └── owns: job graph contract, task/artifact contracts, route decisions,
            lifecycle evidence, state-machine transition rules,
            retry/lease/timeout policy semantics
  └── NEVER imports: openclaw-plugin, node:cron, node:fs (for scheduling)

packages/openclaw-plugin (Host Adapter)
  └── owns: OpenClaw hooks, heartbeat/timer trigger, workspace/filesystem adapters,
            provider/runtime adapter wiring
  └── NEVER runs long tasks inline in a hook (must delegate to peer runner)

pi mono / pi-ai (Worker Backend)
  └── concrete LLM execution for one task
  └── NEVER: scheduling, lifecycle decisions, direct ledger mutation
```

### 3.2 Internalization Channels

Principle internalization can occur through any of these channels:

| Channel | Description |
|---------|-------------|
| `prompt` | Inject learned principles into LLM prompt context |
| `skill` | Register principles as operational skills |
| `code_tool_hook` | Use tool-call gate to enforce rules at runtime |
| `model_training` | Fine-tune or distill principles into model weights |
| `defer_archive` | Mark principle/rule as deferred or archived |

### 3.3 Peer Runners

All runners are peers — no main/sub hierarchy:

| Runner | Role |
|--------|------|
| `dreamer` | Extract high-level principle from pain signals |
| `philosopher` | Refine principle into actionable rule |
| `scribe` | Generate implementation artifact (code, prompt, etc.) |
| `artificer` | Validate and finalize artifact |
| `evaluator` | Assess artifact quality and adherence |
| `trainer` | Coordinate model training pipeline |
| `rollout_reviewer` | Gate artifact rollout to production |

### 3.4 Task Model — PITaskRecord Extends TaskRecord

The internalization task model **reuses and extends** `TaskRecord` (from `runtime-v2/task-status.ts`). It does NOT define a separate standalone task store.

**`TaskRecord` base fields** (reused as-is):

| Field | Type | Notes |
|-------|------|-------|
| `taskId` | string | Unique task identifier |
| `taskKind` | string | Task kind (dreamer, philosopher, etc.) |
| `status` | `PDTaskStatus` | `pending \| leased \| succeeded \| retry_wait \| failed` |
| `leaseOwner` | string? | Current lease holder |
| `leaseExpiresAt` | string? | Lease expiry timestamp |
| `attemptCount` | number | Number of attempts made |
| `maxAttempts` | number | Maximum attempts before forced failure |
| `inputRef` | string? | Reference to task input data |
| `resultRef` | string? | Reference to task result data (set on `succeeded`) |
| `lastError` | `PDErrorCategory`? | Last error category |

**`PITaskRecord` adds internalization metadata** (extends TaskRecord):

```typescript
interface PITaskRecord extends TaskRecord {
  taskKind: 'dreamer' | 'philosopher' | 'scribe' | 'artificer'
           | 'evaluator' | 'trainer' | 'rollout_reviewer'

  parentTaskId?: string
  dependencyTaskIds: string[]
  channel: InternalizationChannel
  correlationId?: string
  timeoutMs: number
  inputArtifactRefs: ArtifactRef[]
  outputArtifactRefs: ArtifactRef[]
}

type InternalizationChannel =
  | 'prompt' | 'skill' | 'code_tool_hook'
  | 'model_training' | 'defer_archive'
```

**Critical rules:**
- `status` uses `PDTaskStatus` — `running` is NOT a `PDTaskStatus`. `running` belongs to `RunExecutionStatus`
- Terminal task states: `succeeded` and `failed` only. `retry_wait` is NOT terminal
- `resultRef` is immutable only after status transitions to `succeeded`
- `lastError` can be updated during `retry_wait` and `failed` transitions
- Cancellation is a Run-level concern (`timed_out`/`cancelled` in `RunExecutionStatus`). Task-level `cancelled` is a future schema migration, out of scope for PRI-64

### 3.5 Run Model — 1 Task : N Runs

Every peer-runner execution attempt must create or update a `RunRecord` (from `runtime-v2/runtime-protocol.ts`):

```text
RuntimeArtifactRef fields (reused from runtime-protocol.ts):
  artifactType: string
  ref: string
```

```text
RunRecord (from runtime-protocol.ts):
  runId: string
  runtimeKind: RuntimeKind         // e.g., 'pi-ai', 'openclaw'
  startedAt: string
  taskId: string                   // links back to PITaskRecord
  attemptNumber: number
  executionStatus: RunExecutionStatus
  // RunExecutionStatus: queued | running | succeeded | failed | timed_out | cancelled
  endedAt?: string
  reason?: string
  outputRef?: string
  inputPayload?: string
  outputPayload?: string
  errorCategory?: PDErrorCategory
```

**Rules:**
- 1 `PITaskRecord` : N `RunRecord` — each attempt gets a new RunRecord
- Peer runners MUST use `PDRuntimeAdapter.startRun()` to initiate execution; they MUST NOT call LLM APIs directly
- `resultRef` on PITaskRecord is set only after the RunRecord enters `succeeded` and validation passes
- On permanent failure → `RuntimeStateManager.markTaskFailed()`
- On transient failure → `RuntimeStateManager.markTaskRetryWait()`
- Cancellation is a Run-level concern; Task-level `cancelled` state is a future schema migration

### 3.6 Artifact Contract — PIArtifact

```typescript
interface PIArtifact {
  artifactId: string
  artifactKind: 'principle' | 'rule' | 'training_data' | 'skill' | 'patch'
  sourceTaskId: string
  sourcePrincipleId?: string
  sourceRuleId?: string
  lineageRefs: LineageRef[]
  validationStatus: 'pending' | 'validated' | 'rejected'
}

interface LineageRef {
  targetArtifactId: string
  relation: 'parent' | 'derived_from' | 'validated_by'
}

interface ArtifactRef {
  artifactType: string
  ref: string  // reuses RuntimeArtifactRef
}
```

**Idempotency:** Artifact writes keyed by `sourceTaskId + artifactKind`. Re-running a task with the same key overwrites the prior artifact.

**FailureCategory reuse:** All error categories reuse `PDErrorCategory` from `runtime-v2/error-categories.js`. No custom error categories for internalization.

### 3.7 Job Graph Topology

**Allowed edges (v1):**

```text
dreamer → philosopher
philosopher → scribe
scribe → artificer
artificer → evaluator
evaluator → rollout_reviewer
[any runner] → (model_training channel) → trainer
```

**DAG rules:**
1. **No cycles** — graph must be acyclic
2. **Dependency gating** — a task with non-empty `dependencyTaskIds` must NOT be leased until ALL dependencies are in `succeeded` state
3. **Dependency failure propagation** — if any dependency enters `failed`, the dependent task is NOT auto-failed; PRI-62 defines escalation policy
4. **Fan-out/fan-in** — out of scope for v1

**Rejection feedback loop:**
- When an artifact's `validationStatus` becomes `rejected`, the state machine does NOT simply mark the task as `failed`
- The rejection artifact and feedback are recorded
- A new corrective task may be created (mechanism defined by PRI-62)
- rejection != task failure

### 3.8 Task State Transitions

**Task level** (uses `PDTaskStatus`):

```text
pending → leased              (lease acquired)
leased  → pending             (lease expired, recovered by sweep)
leased  → succeeded           (task completed successfully)
leased  → retry_wait         (transient error; retry scheduled by RetryPolicy)
leased  → failed             (permanent error or max attempts exceeded)
retry_wait → pending          (retry trigger fires; recovery sweep resets to pending)
```

**Terminal task states:** `succeeded` and `failed` only. `retry_wait` is NOT terminal.

**Run level** (uses `RunExecutionStatus`):

```text
queued → running              (executor picked up)
running → succeeded          (run completed successfully)
running → failed             (run failed)
running → timed_out          (timeout exceeded)
running → cancelled          (cancel requested)
```

**Immutability rules:**
- `resultRef` is immutable once task enters `succeeded`
- `lastError` can be updated during `retry_wait` and `failed` transitions
- Terminal task state (`succeeded`/`failed`) is immutable — no reversion to `pending` or `retry_wait`

### 3.9 Architecture Guards

| Guard ID | Rule | Enforced by |
|----------|------|-------------|
| `CORE_NO_SCHEDULING` | `@principles/core` must not import `openclaw-plugin`, `node:cron`, `node:fs` for scheduling | architecture-regression.test.ts |
| `PLUGIN_NO_INLINE_EXECUTION` | Plugin trigger must not await long task inline in hook; must delegate to peer runner | architecture-regression.test.ts |
| `PEER_NO_DIRECT_CHAINING` | Peer runner must not call next peer runner directly; must enqueue via `RuntimeStateManager.createTask()` | architecture-regression.test.ts |
| `TASK_MODEL_REUSE` | Internalization task model must reuse `TaskRecord`/`RunRecord`, not define a second task store | architecture-regression.test.ts |
| `RUNTIME_ADAPTER_ONLY` | Peer runners must invoke LLM via `PDRuntimeAdapter.startRun()`, not call LLM APIs directly | architecture-regression.test.ts |

### 3.10 Relationship to DiagnosticianRunner

The `DiagnosticianRunner` (in `runtime-v2/runner/diagnostician-runner.ts`) is the reference implementation of the peer runner pattern. PRI-61/62/63 must follow the same pattern:

```text
lease → build context → invoke runtime (PDRuntimeAdapter) → poll → fetch output → validate → succeed/fail
```

Key patterns to reuse:
- `acquireLease()` before any work
- `RuntimeStateManager.markTaskSucceeded()` / `markTaskFailed()` / `markTaskRetryWait()` for state transitions
- `resolveStoreRunId()` to map adapter RunHandle to store RunRecord
- `RetryPolicy.shouldRetry()` for retry decisions
- `PermanentErrorCategory` set distinguishes permanent vs transient errors

## 4. Consequences

### Positive (收益)
* **极速瘦身**：彻底砍掉 `local-worker-routing` 等复杂的路由黑盒代码。
* **极致鲁棒性**：任何一个环节（如大模型限流）导致失败，Task 状态变为 `retry_wait`。下次宿主唤醒时，系统会自动从断点无缝恢复，绝不丢失进度。
* **无限扩展性**：未来添加新的评估环节（如 Evaluator Agent），只需在状态机中插加一个 Task 节点，无需修改复杂的串行编排代码。

### Negative (代价)
* **短期重构成本**：需要将 `nocturnal-trinity.ts` 中一气呵成的过程式代码，打碎重构成基于 Task 状态流转的异步逻辑。
* **取消旧计划**：原定的 Linear 任务 PRI-58, PRI-59, PRI-60 需作废，代之以基于此 ADR 的新重构任务（如 "Refactor Trinity to SQLite Task Machine"）。

## 5. Actions

- [x] 提交本 ADR 进行架构师与技术负责人的评审。
- [x] 若通过，立即在 Linear 中冻结/作废 PRI-58~60。
- [x] 规划新的 "Phase 3: Event-Driven Trinity Pipeline" 实施计划。
- [x] 定义 Principle Internalization Engine 模块边界（PRI-64）。
- [x] Align Section 3 task model with Runtime V2 TaskRecord/RunRecord (running is RunExecutionStatus, not PDTaskStatus).
- [x] Add job graph topology (allowed edges, DAG rules, rejection feedback loop).
- [x] Add 5 architecture guards including TASK_MODEL_REUSE and RUNTIME_ADAPTER_ONLY.
- [x] Clarify retry_wait is NOT terminal; resultRef immutability only after succeeded; lastError updateable during retry/failure.
