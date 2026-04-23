# Phase m4-01: RunnerCore - Context

**Gathered:** 2026-04-23
**Status:** Ready for planning

<domain>
## Phase Boundary

DiagnosticianRunner 的生命周期管理——负责任务租赁、上下文构建、运行记录创建、
runtime adapter 调用、轮询等待、输出获取、验证委托、以及任务 succeed/fail。

Runner 不负责 artifact 持久化、principle candidate 发射、或 marker file 写入。
那些是 M5 DiagnosticianCommitter 的职责。

</domain>

<decisions>
## Implementation Decisions

### Runner 内部状态机

- **D-01:** Phase-based step pipeline。Runner 内部用 RunnerPhase enum 表达执行阶段
  （BuildingContext / CreatingRun / Invoking / Polling / FetchingOutput / Validating），
  每个 phase 是独立方法，入口 run() 按 phase 顺序调用。
  每个 phase 可独立测试，错误恢复粒度细。内部状态不持久化到 TaskStore。

### Runner 与 RuntimeAdapter 的交互模式

- **D-02:** Polling loop。startRun() 返回 RunHandle 后，进入 while + sleep 轮询循环，
  每次调 pollRun() 检查 RunStatus。到达终态（succeeded/failed/timed_out）后调
  fetchOutput()。超时后调 cancelRun()。轮询间隔可配置（默认 5s）。
  与 PDRuntimeAdapter 接口完全匹配，无需新增接口方法。

### Context build 失败时的 runner 行为

- **D-03:** Retry with backoff。context build 异常时标记 task 为 retry_wait，
  附着 errorCategory=context_assembly_failed。区分 transient（DB 连接闪断）
  vs permanent（task 不存在 / workspace 不可用），后者不重试直接 fail。
  SqliteContextAssembler 本身设计为 degradation-safe（缺失数据用 fallback），
  所以大多数情况 assemble() 不会抛异常——但极端错误路径仍需处理。

### Runner 输出与 TaskStore 的写入边界

- **D-04:** Via RuntimeStateManager。Runner 通过 RuntimeStateManager 封装所有
  store 操作（不直接调 SqliteTaskStore / SqliteRunStore）。
  DiagnosticianOutputV1 JSON 序列化后存入 RunRecord.outputPayload。
  M4 不写独立 artifact 文件（.diagnostician_report_*.json 等），那是 M5 scope。

### Claude's Discretion

- 轮询间隔具体值
- RunnerPhase enum 的确切命名
- 内部 phase 方法的参数签名
- 错误分类的细化程度（transient vs permanent 判断逻辑）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Runner Design
- `docs/spec/2026-04-21-diagnostician-v2-detailed-design.md` §14 (Runner Flow), §14.3 (Detailed Flow), §14.4 (Retry Rules), §14.5 (Backoff Policy)
- `docs/design/2026-04-21-pd-runtime-agnostic-architecture-v2.md` §13 (Diagnostician v2), §22.2 (Lease-Based Task Processing)

### Interfaces & Schemas (frozen M1 baseline)
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter, StartRunInput, RunHandle, RunStatus, StructuredRunOutput
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — DiagnosticianOutputV1Schema, DiagnosticianInvocationInput
- `packages/principles-core/src/runtime-v2/agent-spec.ts` — AgentSpec, AGENT_IDS.diagnostician
- `packages/principles-core/src/runtime-v2/context-payload.ts` — DiagnosticianContextPayload
- `packages/principles-core/src/runtime-v2/task-status.ts` — PDTaskStatus, TaskRecord
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory

### Store Layer (frozen M2 baseline)
- `packages/principles-core/src/runtime-v2/runtime-state-manager.ts` — RuntimeStateManager integration layer
- `packages/principles-core/src/runtime-v2/store/sqlite-task-store.ts` — TaskStore CRUD
- `packages/principles-core/src/runtime-v2/store/sqlite-run-store.ts` — RunStore CRUD
- `packages/principles-core/src/runtime-v2/lease-manager.ts` — DefaultLeaseManager
- `packages/principles-core/src/runtime-v2/retry-policy.ts` — DefaultRetryPolicy
- `packages/principles-core/src/runtime-v2/event-emitter.ts` — StoreEventEmitter, TelemetryEvent

### Context Assembly (frozen M3 baseline)
- `packages/principles-core/src/runtime-v2/store/sqlite-context-assembler.ts` — SqliteContextAssembler.assemble()

### Milestone Constraints
- `.planning/milestones/pd-runtime-v2-m4/REQUIREMENTS.md` — M4 constraints, non-goals, exit criteria

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `PDRuntimeAdapter` interface (runtime-protocol.ts:179-209) — Runner 调用 startRun/pollRun/fetchOutput/cancelRun
- `DiagnosticianInvocationInput` schema (diagnostician-output.ts:70-90) — 构造给 adapter 的输入
- `RuntimeStateManager` (runtime-state-manager.ts) — 集成层，封装 TaskStore + RunStore + LeaseManager
- `StoreEventEmitter` (event-emitter.ts) — 遥测事件发射，runner 需扩展 diagnostician events
- `DefaultLeaseManager.acquireLease()` (lease-manager.ts) — runner 通过 RuntimeStateManager 调用

### Established Patterns
- Store 层全部使用 TypeBox schema + Value.Check() 验证
- RunRecord 通过 SqliteRunStore.createRun() 创建，outputPayload 是可选 TEXT 字段
- Lease 操作是原子的（SQLite transaction）
- 所有错误使用 PDRuntimeError(category, message) 抛出

### Integration Points
- Runner 消费 RuntimeStateManager（不直接消费 store 实现）
- Runner 消费 SqliteContextAssembler（M3 frozen）
- Runner 消费 PDRuntimeAdapter（通过依赖注入，测试时用 TestDouble）
- Runner 不消费 evolution-worker.ts 或 prompt.ts（硬约束）

</code_context>

<specifics>
## Specific Ideas

- Runner 的核心方法签名大致为：
  ```ts
  class DiagnosticianRunner {
    constructor(stateManager, contextAssembler, runtimeAdapter, eventEmitter) {}
    async run(taskId: string): Promise<RunnerResult>
  }
  ```
- RunnerResult 区分 succeeded / failed / retried，包含原因和 contextHash
- Runner 不持有可变状态——每次 run() 调用是独立的
- TestDoubleRuntimeAdapter 在 m4-02 中实现，m4-01 用 mock/Stub 替代

</specifics>

<deferred>
## Deferred Ideas

- TestDoubleRuntimeAdapter 的具体实现（m4-02 scope）
- DiagnosticianValidator 的具体实现（m4-03 scope）
- Retry/Lease 交互的集成测试（m4-04 scope）
- Telemetry 事件扩展（m4-05 scope）
- OpenClaw adapter 的生产落地（M6 scope，M4 明确不需要）
- Artifact 文件写入 / principle candidate 发射（M5 scope）
- evolution-worker.ts 或 prompt.ts 的任何修改（M6+ scope）

</deferred>

---

*Phase: m4-01-RunnerCore*
*Context gathered: 2026-04-23*
