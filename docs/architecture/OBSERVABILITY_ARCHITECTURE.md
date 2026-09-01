# 可观测性架构（Observability Architecture）

> **状态**: Active
> **最后更新**: 2026-05-15
> **关联**: `PD_ARCHITECTURE_OVERVIEW.md` §6.4, `INTERNALIZATION_PIPELINE.md` §6.4, `ERROR_ARCHITECTURE.md`

> **ADR-0012 修订（2026-05-23）**: `plugin.service.idle-trigger` / `idle_trigger_wake_total` 是待退役 legacy 观测名。新的调度证据必须指明 PD-owned operator/SDK/scheduler source，不能表达为 OpenClaw idle/night trigger。

本文档定义 PD 系统的可观测性规范——**日志（Logs）、指标（Metrics）、追踪（Traces）三位一体**——以及审计日志（Audit Log）。所有 PD 组件必须遵守。

---

## 1. 设计原则

### 1.1 核心信条

1. **静默成功不如显式失败** —— 任何重要状态变更必须可观测
2. **可观测性优先于自动化** —— 宁可慢一点也要看得见
3. **结构化优于自由文本** —— 所有事件遵循固定 schema
4. **本地优先** —— 默认全部存本地（SQLite + JSONL），不依赖外部服务
5. **关联性强制** —— 跨组件的关联通过 `traceId` 串联

### 1.2 三位一体责任划分

| 类型 | 回答的问题 | 主要消费者 | 存储 |
|-----|----------|----------|------|
| **Logs** | 发生了什么？为什么失败？ | 开发者调试 | 标准输出 + 文件（结构化 JSONL） |
| **Metrics** | 系统在什么状态？ | 运维监控 | SQLite 聚合 + 可选 Prometheus export |
| **Traces** | 一次请求经过哪些组件？ | 故障排查 | SQLite events 表（含 traceId）|
| **Audit** | 谁在何时做了什么决策？ | 合规审查 | append-only JSONL（不可篡改）|

---

## 2. Logs（日志）

### 2.1 日志级别

PD 使用 5 级日志，所有组件统一遵循：

| 级别 | 用途 | 默认开启 |
|------|-----|---------|
| `error` | 不可恢复错误、需要人工介入 | ✅ 始终 |
| `warn` | 可恢复异常、降级路径 | ✅ 始终 |
| `info` | 正常生命周期事件（启动、关闭、关键状态变更）| ✅ 默认 |
| `debug` | 详细执行流程 | 开发模式 |
| `trace` | 极细粒度（每个函数入参、决策分支）| 仅排障 |

### 2.2 结构化日志格式

所有 PD 日志必须是**结构化 JSON**（不允许 `console.log("..." + variable)`）。

```typescript
interface PDLogEntry {
  timestamp: string;        // ISO 8601
  level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  component: string;        // 例：'core.runner.diagnostician'
  message: string;          // 一句话主旨
  traceId?: string;         // 跨组件关联
  spanId?: string;          // 单步标识
  taskId?: string;
  runId?: string;
  painId?: string;
  workspaceDir?: string;
  /** 任意附加结构化字段 */
  context?: Record<string, unknown>;
  /** 错误信息（level=error/warn 时） */
  error?: {
    name: string;
    message: string;
    category?: PDErrorCategory;  // 来自 ERROR_ARCHITECTURE
    stack?: string;
    cause?: PDLogEntry['error'];
  };
}
```

### 2.3 component 命名规范

```
{layer}.{module}.{submodule}

例：
core.runner.diagnostician
core.runner.dreamer
core.bridge.pain-signal
core.bridge.intake-to-internalization
core.activation.dispatcher
core.activation.writer.ledger-prompt
core.store.task.sqlite
plugin.hook.pain
plugin.hook.gate
runtime.scheduler.explicit-trigger
plugin.service.evolution-worker
cli.command.diagnose
console.server.routes.approvals
```

### 2.4 不允许的日志反模式

| 反模式 | 应该用什么 |
|-------|---------|
| `console.log("xxx", obj)` | `logger.info('xxx', { ...obj })` |
| `console.error(err)` | `logger.error('action failed', { error: err, taskId })` |
| 把对象 stringify 拼字符串 | 直接传对象，由 logger 序列化 |
| 在循环里 log 每一项 | 累加后批量 log |
| log 完整 LLM prompt（敏感+大）| log prompt hash + length |
| log 用户消息原文 | log 经过 `pain-context-extractor` 脱敏后的内容 |

### 2.5 日志实现

| 包 | logger 实现 |
|----|-----------|
| core | 通过 `PluginLogger` 接口注入（不直接 console），由调用方提供 |
| plugin | 使用 OpenClaw 提供的 `api.logger`（通过 `SystemLogger` 包装）|
| pd-cli | `console.error` 写 stderr（结构化 JSON）|
| pd-console | 后端用 pino，前端用 console（仅开发） |

### 2.6 日志归档与清理

| 文件 | 路径 | 滚动策略 | 保留 |
|------|------|---------|-----|
| Plugin 日志 | OpenClaw 控制 | 由 OpenClaw 管理 | OpenClaw 默认 |
| pd-cli 日志 | stderr | 进程退出即结束 | 不归档 |
| pd-console 后端日志 | `{workspace}/.pd/logs/console.jsonl` | 单文件 ≤ 50MB，保留 7 天 | 7 天 |
| 审计日志 | `{workspace}/.pd/audit-log.jsonl` | 不滚动（**append only**）| 永久 |

---

## 3. Metrics（指标）

### 3.1 指标分类

| 类型 | 用途 | 存储 |
|------|-----|------|
| `counter` | 单调递增（事件计数）| SQLite |
| `gauge` | 当前值（队列长度）| SQLite + 实时计算 |
| `histogram` | 分布（延迟分位数）| SQLite + buckets |

### 3.2 命名规范

```
pd.{layer}.{domain}.{name}_{unit}

例：
pd.pipeline.pain.captured_total
pd.pipeline.pain.to_probation_latency_ms
pd.pipeline.internalization.queue_depth
pd.pipeline.internalization.runner_succeeded_total
pd.pipeline.activation.dispatched_total
pd.pipeline.activation.queued_for_approval_total
pd.approval.pending_count
pd.approval.avg_decision_latency_ms
pd.runtime.adapter_call_failed_total
pd.store.lease_conflict_total
pd.gfi.workspace_friction_score
```

### 3.3 关键指标清单

#### 3.3.1 Pain Pipeline 指标

| 指标 | 类型 | 标签 | 意义 |
|------|-----|------|------|
| `pd.pipeline.pain.captured_total` | counter | source, severity | 痛苦信号总数 |
| `pd.pipeline.pain.bridge_succeeded_total` | counter | - | 桥接成功 |
| `pd.pipeline.pain.bridge_skipped_total` | counter | reason | 跳过（幂等/lease）|
| `pd.pipeline.pain.bridge_failed_total` | counter | error_category | 桥接失败 |
| `pd.pipeline.pain.diagnostician_latency_ms` | histogram | - | 诊断延迟分布 |
| `pd.pipeline.pain.to_probation_total` | counter | - | 完整链路成功 |
| `pd.pipeline.pain.to_probation_latency_ms` | histogram | - | 完整链路延迟 |

#### 3.3.2 Internalization Pipeline 指标

| 指标 | 类型 | 标签 | 意义 |
|------|-----|------|------|
| `pd.pipeline.internalization.queue_depth` | gauge | task_kind, status | 队列深度 |
| `pd.pipeline.internalization.runner_started_total` | counter | task_kind | 启动 Runner 次数 |
| `pd.pipeline.internalization.runner_succeeded_total` | counter | task_kind | 成功次数 |
| `pd.pipeline.internalization.runner_failed_total` | counter | task_kind, error_category | 失败次数 |
| `pd.pipeline.internalization.runner_retry_wait_total` | counter | task_kind | retry_wait 次数 |
| `pd.pipeline.internalization.runner_latency_ms` | histogram | task_kind | Runner 执行延迟 |
| `pd.pipeline.internalization.dependency_failed_total` | counter | task_kind | 依赖失败 |
| `pd.pipeline.internalization.lease_conflict_total` | counter | task_kind | lease 冲突 |
| `pd.pipeline.internalization.explicit_schedule_total` | counter | source, result | PD-owned operator/SDK/scheduler 唤起次数 |

#### 3.3.3 Activation Pipeline 指标

| 指标 | 类型 | 标签 | 意义 |
|------|-----|------|------|
| `pd.pipeline.activation.dispatched_total` | counter | channel | 分发总数 |
| `pd.pipeline.activation.activated_total` | counter | channel | 激活总数 |
| `pd.pipeline.activation.queued_for_approval_total` | counter | channel, risk_level | 入队审批数 |
| `pd.pipeline.activation.rejected_total` | counter | channel, reason | 拒绝总数 |
| `pd.pipeline.activation.skipped_total` | counter | channel, reason | 跳过总数 |
| `pd.approval.pending_count` | gauge | channel, risk_level | 当前待审批数 |
| `pd.approval.decision_latency_ms` | histogram | channel | 审批延迟分布 |
| `pd.approval.approval_rate` | gauge | channel | 批准率（24h 滚动）|
| `pd.approval.expired_total` | counter | channel | TTL 过期数 |
| `pd.shadow_mode.cycles_observed` | gauge | impl_id | shadow 已观察周期 |
| `pd.shadow_mode.false_positive_rate` | gauge | impl_id | 误杀率 |
| `pd.shadow_mode.aborted_total` | counter | reason | shadow 中止次数 |

#### 3.3.4 Runtime 与 Store 指标

| 指标 | 类型 | 标签 | 意义 |
|------|-----|------|------|
| `pd.runtime.adapter_call_total` | counter | adapter_kind, agent_id | 适配器调用 |
| `pd.runtime.adapter_call_failed_total` | counter | adapter_kind, error_category | 失败 |
| `pd.runtime.adapter_call_latency_ms` | histogram | adapter_kind | 调用延迟 |
| `pd.store.write_failed_total` | counter | store_name, error_category | 写失败 |
| `pd.store.lease_conflict_total` | counter | - | lease 冲突 |
| `pd.store.lease_expired_recovered_total` | counter | - | lease 恢复 |
| `pd.store.sqlite_wal_size_bytes` | gauge | - | WAL 大小 |
| `pd.store.ledger_size_bytes` | gauge | - | Ledger 文件大小 |

#### 3.3.5 GFI 指标

| 指标 | 类型 | 标签 | 意义 |
|------|-----|------|------|
| `pd.gfi.workspace_friction_score` | gauge | - | 当前摩擦分数 |
| `pd.gfi.session_friction_score` | gauge | session_id | 会话摩擦分数 |
| `pd.gfi.stage` | gauge | - | 当前阶段（GFI Stage 编号）|
| `pd.gfi.relief_applied_total` | counter | trigger | relief 触发次数 |

### 3.4 指标聚合与查询

#### 3.4.1 SQLite 表结构

```sql
CREATE TABLE metrics_counters (
  metric_name TEXT NOT NULL,
  labels_json TEXT NOT NULL,  -- 标签序列化
  value INTEGER NOT NULL,
  bucket_start TEXT NOT NULL, -- 聚合时间段（按分钟）
  PRIMARY KEY (metric_name, labels_json, bucket_start)
);

CREATE TABLE metrics_gauges (
  metric_name TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  value REAL NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (metric_name, labels_json, observed_at)
);

CREATE TABLE metrics_histograms (
  metric_name TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  bucket_le REAL NOT NULL,    -- bucket 上界（"<=" 语义）
  count INTEGER NOT NULL,
  bucket_start TEXT NOT NULL,
  PRIMARY KEY (metric_name, labels_json, bucket_le, bucket_start)
);
```

> **注意**：当前实现可能用 `events` 表派生而非独立 metrics 表。本设计为目标状态。如果不引入独立表，需要 ReadModel 从 events 实时聚合。

#### 3.4.2 查询接口

由 `pd-cli pd metrics query` 提供：

```bash
pd metrics query \
  --name pd.pipeline.pain.to_probation_latency_ms \
  --since "1 hour ago" \
  --output json
```

#### 3.4.3 可选 Prometheus 导出

为生产部署提供：

```typescript
// {workspace}/.pd/config/observability.yaml
observability:
  prometheus:
    enabled: false
    port: 9789
    path: /metrics
```

---

## 4. Traces（追踪）

### 4.1 设计

PD 使用**轻量分布式追踪**，但**不**引入 OpenTelemetry SDK 作为强依赖。核心机制：

- 每个跨组件调用必须传递 `traceId`
- 关键步骤记录为 `TelemetryEvent`，写入 `state.db: events`
- 通过 `traceId` 重建调用链（`PainChainReadModel` 已有此能力）

### 4.2 traceId 传递规则

#### 4.2.1 traceId 来源

```
Pain Pipeline:
  painId → 自动作为 traceId
  Diagnostician taskId.deterministic = traceId

Internalization Pipeline:
  父 task.traceId 传递给子 task
  IntakeToInternalizationBridge 入队时 traceId = parentLedgerEntryId

Activation Pipeline:
  传递 PIArtifact.lineage 中第一条 traceId
```

#### 4.2.2 强制规则

| 规则 | 描述 |
|-----|------|
| TR-1 | 每个 TelemetryEvent 必须有 `traceId` |
| TR-2 | Runner 跨阶段传递时必须保留 `traceId` |
| TR-3 | Activation Dispatcher 必须把 traceId 写入 ApprovalRecord |
| TR-4 | 任何错误日志必须包含 `traceId`（如果有上下文）|

### 4.3 TelemetryEvent schema

参见 `packages/principles-core/src/telemetry-event.ts`（内部模块）：

```typescript
interface TelemetryEvent {
  eventType: TelemetryEventType;
  traceId: string;
  timestamp: string;
  sessionId?: string;
  agentId?: string;
  payload: Record<string, unknown>;
}
```

### 4.4 必发的 TelemetryEvent

每个 Runner / Bridge / Service 必须发的最小事件集合：

#### 4.4.1 Diagnostician

```
diagnostician_task_leased
diagnostician_context_built
diagnostician_run_started
diagnostician_artifact_committed
principle_candidate_registered  (per candidate)
diagnostician_artifact_commit_failed (on failure)
diagnostician_task_succeeded
diagnostician_task_retried
diagnostician_task_failed
output_validation_succeeded / output_validation_failed
```

#### 4.4.2 各 Peer Runner（统一格式）

```
{runner}_task_leased
{runner}_context_built
{runner}_run_started
{runner}_run_failed
{runner}_output_invalid
{runner}_output_validated
{runner}_artifact_write_failed
{runner}_task_succeeded
{runner}_task_retried
{runner}_task_failed
{runner}_mark_succeeded_failed
{runner}_mark_failed_error
```

#### 4.4.3 Bridges & Dispatcher

```
pain_bridge_invoked
pain_bridge_skipped
intake_to_internalization_bridged
intake_to_internalization_skipped
activation_dispatched
activation_completed
activation_skipped
approval_queued
approval_decided
approval_second_confirmed
approval_expired
channel_writer_activated
channel_writer_failed
channel_writer_deactivated
shadow_mode_completed
shadow_mode_aborted
rejection_feedback_emitted
```

#### 4.4.4 Idle Trigger

```
idle_trigger_woken
idle_trigger_skipped
idle_trigger_error
```

### 4.5 traceId 的查询接口

#### 4.5.1 通过 pd-cli

```bash
# 查询某个 painId 的完整链
pd trace show <painId>

# 查询某个 taskId 的所有 events
pd events query --trace-id <taskId>

# 查询某个 artifactId 的血缘
pd lineage show <artifactId>
```

#### 4.5.2 通过 pd-console

`/events` 路由提供按 traceId 过滤的事件流视图。

---

## 5. 审计日志（Audit Log）

### 5.1 用途

审计日志专门记录**会改变系统行为**或**承担法律/合规责任**的操作，独立于普通日志。

### 5.2 必须审计的操作

| 操作 | actor | 字段 |
|------|------|-----|
| Approval approve / reject | human | approvalId, artifactId, channel, riskLevel, decidedBy, reason |
| Second confirmation | human | approvalId, secondConfirmedBy |
| Activation 实际写入 | system / human | activationId, channelTarget, approvedBy |
| Deactivation（rollback） | human | activationId, rolledBackBy, reason |
| Configuration 修改 | human | configFile, beforeHash, afterHash, changedBy |
| Pruning Action | human | principleId/ruleId, fromStatus, toStatus, decidedBy |
| Principle Rollback | human | principleId, fromVersion, toVersion |
| Implementation Disable | human | implId, reason |
| Training Export | human | batchId, datasetSize, approvedBy, secondConfirmedBy |
| Workspace Initialization | system / human | workspaceDir, version, initializedBy |
| Schema Migration | system | fromVersion, toVersion, migrationId |

### 5.3 审计日志格式

```typescript
interface AuditLogEntry {
  /** UUID v4 */
  auditId: string;
  /** ISO 8601 */
  timestamp: string;
  /** 操作类型 */
  event: AuditEventType;
  /** 谁做的 */
  actor: {
    kind: 'human' | 'agent' | 'system';
    id: string;       // userId / agentId / 'system'
    sessionId?: string;
  };
  /** 操作目标 */
  target: {
    kind: string;     // 'approval' | 'activation' | 'principle' | ...
    id: string;
  };
  /** 关联 traceId（如有）*/
  traceId?: string;
  /** 工作区 */
  workspaceDir: string;
  /** 操作前后状态摘要（用于审计追溯）*/
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** 业务原因 */
  reason?: string;
  /** 任意附加上下文 */
  metadata?: Record<string, unknown>;
}
```

### 5.4 写入规范

| 规则 | 描述 |
|-----|------|
| AUDIT-1 | 写入位置：`{workspace}/.pd/audit-log.jsonl` |
| AUDIT-2 | **append-only**，不允许任何形式的修改或删除 |
| AUDIT-3 | 写入必须**同步**（不允许异步丢失）|
| AUDIT-4 | 写入失败时**必须中止**对应业务操作 |
| AUDIT-5 | 每条记录必须有完整的 actor、target、timestamp |
| AUDIT-6 | 跨进程并发写入通过 OS 文件 append 原子性保证 |
| AUDIT-7 | 文件不滚动（按 PD 实际数据规模，单文件 < 100MB / 年）|

### 5.5 审计日志的可观测性

审计日志本身也要可观测：

- pd-console 提供 `/audit` 路由查看
- pd-cli 提供 `pd audit query --since "30d ago"`
- 可选导出到外部 SIEM（通过 webhook，需配置）

### 5.6 审计日志完整性校验

#### 5.6.1 hash chain（推荐）

每条审计记录包含前一条的 hash，形成链：

```typescript
interface AuditLogEntry {
  // ... 上面字段
  prevHash?: string;   // 前一条记录的 SHA-256
  hash: string;        // 本条记录（除 hash 外）的 SHA-256
}
```

这样可以检测篡改：任何修改都会导致后续 hash 不一致。

> 注：实施时需评估性能开销，仅对关键事件启用。

---

## 6. 三位一体如何配合

### 6.1 典型故障排查流程

**场景**：用户报告"原则没生效"。

1. **从 Logs 定位**：搜索 `error` 级别日志在最近 24h
2. **从 Metrics 验证**：查 `pd.pipeline.activation.activated_total{channel=prompt}` 是否为 0
3. **从 Traces 追溯**：拿到 `painId` 后用 `pd trace show <painId>` 看完整链
4. **从 Audit 确认**：是否有人手动 reject 了对应 approval

### 6.2 输出关联示意

```
[user 报告问题]
     │
     ▼
   Logs?              ─── error: "RuleHostWriter.activate failed"
     │                       └ traceId: trace_abc, taskId: task_123
     ▼
   Metrics?            ─── pd.pipeline.activation.dispatched_total{channel=code_tool_hook} = 1
                       └─ pd.pipeline.activation.activated_total{channel=code_tool_hook} = 0
     │
     ▼
   Traces (events)?    ─── activation_dispatched (trace_abc)
                       └─ approval_queued (trace_abc)
                       └─ approval_decided (trace_abc, decision=rejected)
     │
     ▼
   Audit?              ─── { event: 'approval_decided',
                              actor: { kind: 'human', id: 'alice' },
                              target: { kind: 'approval', id: 'app_xyz' },
                              reason: 'GoldenTrace replay had 30% false positive' }
     │
     ▼
   [找到根因：人工拒绝]
```

---

## 7. 性能与开销

### 7.1 预算

| 维度 | 预算 |
|------|------|
| Telemetry event 写入开销 | 每个 Runner step < 5ms |
| Metric 更新开销 | < 1ms（Counter/Gauge）, < 3ms (Histogram) |
| Audit log 写入开销 | < 10ms（同步 fsync）|
| Logs 写入开销 | < 0.5ms（异步 buffer）|

### 7.2 降级策略

| 异常 | 行为 |
|------|------|
| Logger 失败 | 静默继续（不影响业务）|
| Metric 写入失败 | 记 warn 日志，继续业务 |
| TelemetryEvent 写入失败 | 同上（events 表不可用 → 写 warn）|
| **Audit log 写入失败** | **中止业务**（违反 AUDIT-4）|

### 7.3 数据量估算

| 类型 | 单工作区单天估算 |
|------|---------------|
| Logs (info+) | < 10 MB |
| TelemetryEvents | < 5 MB |
| Metrics | < 1 MB |
| Audit | < 100 KB |

如果某工作区超过 10x 估算量，需 review 业务异常。

---

## 8. 跨包实现指南

### 8.1 core 中的 logger 注入

core 不直接使用 console，而是通过接口注入：

```typescript
// core 中的 service / runner
class DiagnosticianRunner {
  constructor(deps: {
    logger: PluginLogger;
    eventEmitter: StoreEventEmitter;
    // ...
  }) { ... }
}

// 调用方提供 logger
import { SystemLogger } from './core/system-logger.js';
const logger = new SystemLogger(api.logger);
const runner = new DiagnosticianRunner({ logger, eventEmitter, ... });
```

### 8.2 plugin 中的 logger 桥接

```typescript
// plugin/core/system-logger.ts
export class SystemLogger implements PluginLogger {
  constructor(private apiLogger: OpenClawApiLogger) {}

  info(message: string, context?: Record<string, unknown>) {
    this.apiLogger.info(JSON.stringify({
      message,
      component: 'plugin',
      ...context,
    }));
  }
  // ...
}
```

### 8.3 pd-cli 中的 logger

```typescript
// pd-cli/src/commands/diagnose.ts
function jsonLog(level: string, message: string, context: object) {
  process.stderr.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    component: 'cli.command.diagnose',
    message,
    ...context,
  }) + '\n');
}
```

### 8.4 pd-console 中的 logger

后端使用 pino + 输出到文件 + stderr。前端开发模式 `console.log`，生产构建无日志。

---

## 9. 不变量与守护

| ID | 不变量 | 强制方式 |
|----|------|---------|
| OBS-1 | core 不直接使用 `console` | architecture-regression test |
| OBS-2 | 任何 catch 块必须 log（不允许静默）| ESLint rule + review |
| OBS-3 | 任何 Runner 必须发出至少 3 个生命周期 telemetry event | architecture-regression test 检查事件名 |
| OBS-4 | TelemetryEvent 必须有 traceId | TelemetryEventSchema 强制 |
| OBS-5 | Audit 写入失败必须中止业务 | code review + 集成测试 |
| OBS-6 | Audit log 必须 append-only | 文件权限 + 测试 |
| OBS-7 | 错误日志必须包含 PDErrorCategory | review + ESLint custom rule |
| OBS-8 | 不允许 log 完整 LLM prompt（仅 hash + length）| review + 自动检查 |

---

## 10. 配置

### 10.1 observability.yaml

```yaml
# {workspace}/.pd/config/observability.yaml
observability:
  logs:
    level: info                # error | warn | info | debug | trace
    file_logging: true
    file_path: ./logs/pd.jsonl

  metrics:
    enabled: true
    aggregation_interval_ms: 60000
    export:
      prometheus:
        enabled: false
        port: 9789
        path: /metrics

  traces:
    enabled: true
    sampling_rate: 1.0           # 1.0 = 全采样

  audit:
    enabled: true                # 不可关闭
    file_path: ./audit-log.jsonl
    hash_chain: false            # 是否启用 hash chain
    sync_write: true             # 不可关闭
```

---

## 11. 发布与监控集成

### 11.1 默认本地

PD 默认所有可观测性数据存本地，**不**主动发送到任何外部服务。

### 11.2 可选远程导出

以下出口可通过 config 启用：

| 类型 | 出口 |
|------|-----|
| Logs | 第三方 log aggregator（Loki / Splunk）|
| Metrics | Prometheus / OpenTelemetry Collector |
| Traces | Jaeger / Tempo（仅 traceId 关联，不导出 span 详情）|
| Audit | webhook / SIEM |

**安全约束**：
- 远程导出**必须**配置允许列表
- 默认**不导出**包含 workspace 路径或 PII 的字段
- 详见 `SECURITY_ARCHITECTURE.md`

---

## 12. 实施进度

| 项目 | 状态 |
|------|-----|
| TelemetryEvent schema | ✅ |
| StoreEventEmitter | ✅ |
| Runner 必发事件 | ✅（DiagnosticianRunner / Dreamer / Trainer 完整）|
| `events` 表与 PainChainReadModel | ✅ |
| 结构化日志（plugin / cli）| ⚠️ 部分组件 |
| Metrics 聚合 | ❌ 待建（独立 metrics 表 or 派生）|
| Audit log 框架 | ❌ 待建 |
| pd-cli `metrics query` / `audit query` | ❌ 待建 |
| pd-console `/events` / `/audit` 路由 | ⚠️ events 已有，audit 待建 |
| 架构守护测试 | ❌ 待建 |

---

## 13. 关联文档

- [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) §6.4
- [`ERROR_ARCHITECTURE.md`](./ERROR_ARCHITECTURE.md) — PDErrorCategory 与日志关联
- [`SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md) — Audit log 与合规
- [`PERFORMANCE_BUDGETS.md`](./PERFORMANCE_BUDGETS.md) — 可观测性的性能开销预算
- [`COMPONENTS.md`](./COMPONENTS.md) — 各 Service 必发事件清单
