---
phase: m4-05
status: ready
created: "2026-04-23"
---

# Phase m4-05: TelemetryCLI - Context

**Gathered:** 2026-04-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Diagnostician-specific telemetry events + minimal CLI surface (`pd diagnose run/status`).
Thin wrappers over DiagnosticianRunner and RuntimeStateManager.
No new CLI framework — library function exports only.
</domain>

<decisions>
## Implementation Decisions

### Event 命名策略
- **D-01:** 新增 8 个 `diagnostician_` 前缀事件类型到 TelemetryEventType union。
  Runner 层直接通过 `eventEmitter.emitTelemetry()` 发出。
  不复用 M2 事件，避免 payload 结构耦合。
  **Why:** 用户明确选择新增类型而非复用。
  **How to apply:** 在 telemetry-event.ts 的 TelemetryEventType union 中追加 8 个 literal type。

### CLI 架构
- **D-02:** 库函数导出，无 bin 脚本、无 CLI 框架依赖。
  在 `runtime-v2/cli/diagnose.ts` 中导出 `run()` 和 `status()` 函数。
  外部代码（如 OpenClaw plugin）import 并调用。
  **Why:** 符合 REQUIREMENTS "thin wrappers" 描述，最小依赖。
  **How to apply:** 创建 `packages/principles-core/src/runtime-v2/cli/diagnose.ts`，导出两个异步函数。

### Status 输出格式
- **D-03:** `status()` 返回 TaskRecord 关键字段（taskId, status, attemptCount, maxAttempts, lastError）。
  不包含 Run 历史。
  **Why:** 最小化 I/O 开销，足够了解任务状态。
  **How to apply:** status() 调用 `stateManager.getTask()` 并提取关键字段返回结构化对象。

</decisions>

<canonical_refs>
## Canonical References

### Requirements
- `.planning/milestones/pd-runtime-v2-m4/REQUIREMENTS.md` — Section 2.7 (Telemetry), Section 2.8 (CLI)

### Existing Infrastructure
- `packages/principles-core/src/telemetry-event.ts` — TelemetryEventType, TelemetryEventSchema
- `packages/principles-core/src/runtime-v2/store/event-emitter.ts` — StoreEventEmitter
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — Runner（emit 事件处）
- `packages/principles-core/src/runtime-v2/index.ts` — 导出入口

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- StoreEventEmitter — 已在 Runner/StateManager 中使用，emitTelemetry + onTelemetry
- TelemetryEventType — 12 个现有类型，需要追加 8 个 diagnostician_ 类型
- RuntimeStateManager — getTask() 已可用于 status() 实现
- DiagnosticianRunner — run() 已可用于 run() CLI 封装

### Established Patterns
- 事件通过 stateManager 内部的 emitter 发出（lease_acquired, task_succeeded 等）
- index.ts 统一导出所有 runtime-v2 公共 API

### Integration Points
- CLI 模块需要 import DiagnosticianRunner + RuntimeStateManager
- 新 event type 需要在 TelemetryEventType union 注册
</code_context>

<specifics>
## Specific Ideas

- 8 个新事件类型：diagnostician_task_leased, diagnostician_context_built, diagnostician_run_started, diagnostician_run_failed, diagnostician_output_invalid, diagnostician_task_succeeded, diagnostician_task_retried, diagnostician_task_failed
- cli/diagnose.ts 导出 run(taskId, options) 和 status(taskId, options)
- run() 封装 DiagnosticianRunner.run()，status() 封装 stateManager.getTask()

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope
</deferred>

---
*Phase: m4-05-TelemetryCLI*
*Context gathered: 2026-04-23*
