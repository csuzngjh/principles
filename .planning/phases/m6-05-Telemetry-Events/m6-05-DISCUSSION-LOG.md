# Phase m6-05: Telemetry Events - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-24
**Phase:** m6-05-Telemetry-Events
**Areas discussed:** TELE emission points, Event naming consistency, Event schema, EventEmitter wiring

---

## Area 1: TELE Emission Points

User selected all 4 gray areas. Discussed in technical detail.

### TELE-01 (runtime_adapter_selected): Where should it fire?

| Option | Description | Selected |
|--------|-------------|----------|
| CLI command handler — handleDiagnoseRun() | Fire when pd diagnose run creates OpenClawCliRuntimeAdapter. The CLI is the "selection point" — user explicitly chose this runtime. | ✓ |
| DiagnosticianRunner constructor | Fire when DiagnosticianRunner is constructed with openclaw-cli runtimeKind. More runner-centric view of "selection". | |

**User's choice:** CLI command handler — handleDiagnoseRun()
**Notes:** 用户选择最直观的发射位置，在用户可见的操作点记录事件。

### TELE-02 (runtime_invocation_started): Same moment as diagnostician_run_started — keep both?

| Option | Description | Selected |
|--------|-------------|----------|
| Keep both — different abstraction levels | diagnostician_run_started = "diagnostician logic wants to run". runtime_invocation_started = "CLI process actually spawned". Both fire at same time but serve different consumers. | ✓ |
| Skip TELE-02 | diagnostician_run_started is sufficient. | |

**User's choice:** Keep both — different abstraction levels
**Notes:** 外部监控工具（如日志聚合系统）需要"CLI 进程"这个事件来区分来源，两个事件虽然触发时间相同但观察角度不同。

---

## Area 2: Event Naming Consistency

### TELE-03: runtime_invocation_succeeded/failed naming

| Option | Description | Selected |
|--------|-------------|----------|
| Two separate event types | Independent events enable monitoring dashboards to count success/failure directly without field filtering. | ✓ |
| Single event + status field | One event with a status field. Requires filtering for stats. | |

**User's choice:** Two separate event types
**Notes:** 独立事件便于监控仪表盘直接显示成功/失败计数。

### TELE-04: output_validation_succeeded/failed vs existing diagnostician_output_invalid

| Option | Description | Selected |
|--------|-------------|----------|
| Add both succeeded and failed | Complete observability — both directions tracked. | ✓ |
| Failed only | Only add output_validation_failed, diagnostician_output_invalid remains. | |

**User's choice:** Add both succeeded and failed
**Notes:** 完整观测需要双向数据，成功率计算需要成功事件。

---

## Area 3: Event Schema — Payload Fields

Discussed inline. Standard payload fields for all TELE events:
- `traceId`: taskId (for correlation)
- `runtimeKind`: 'openclaw-cli' for TELE-01~03
- `errorCategory`: present on failed events (TELE-03 failed, TELE-04 failed)

**Notes:** No further decisions needed — event payload fields follow existing DiagnosticianRunner.emitDiagnosticianEvent() pattern.

---

## Area 4: EventEmitter Wiring

| Option | Description | Selected |
|--------|-------------|----------|
| Dependency injection into OpenClawCliRuntimeAdapter | StoreEventEmitter passed via constructor. Enables isolated testing with mock emitter. Follows existing DiagnosticianRunner pattern. | ✓ |
| Adapter uses global storeEmitter singleton directly | Any place can emit events. Harder to test, global state. | |

**User's choice:** Dependency injection
**Notes:** 遵循 M6 已有模式（DiagnosticianRunner 已经用注入方式接收 eventEmitter），也便于单独测试每个组件。Adapter 构造函数接受 optional eventEmitter，不提供时回退到 storeEmitter 单例（向后兼容）。

---

## Deferred Ideas

None — discussion stayed within m6-05 TELE-01~04 scope.
