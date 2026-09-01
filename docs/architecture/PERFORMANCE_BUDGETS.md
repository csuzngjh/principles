# 性能预算（Performance Budgets）

> **状态**: Active
> **最后更新**: 2026-05-15
> **关联**: `PD_ARCHITECTURE_OVERVIEW.md` §6.2, `OBSERVABILITY_ARCHITECTURE.md`

本文档定义 PD 系统**所有关键路径**的性能预算（latency / throughput / 资源使用）。性能预算是契约——超出预算视为缺陷。

---

## 1. 设计原则

### 1.1 核心信条

1. **代理体验优先** —— hook 层延迟必须低到代理无感知
2. **预算可观测** —— 每个预算都有对应 metric
3. **超预算降级** —— 不让一个慢操作拖死整个系统
4. **本地资源有上限** —— SQLite / 文件大小有自动归档
5. **批量优于逐个** —— 高频小操作必须批处理

### 1.2 预算分类

| 类型 | 关注点 | 维度 |
|------|-------|------|
| Latency | 单次操作延迟 | P50 / P95 / P99 |
| Throughput | 单位时间处理量 | RPS / 并发数 |
| Resource | 资源占用 | CPU / 内存 / 磁盘 |
| Storage | 存储增长 | 大小 / 增速 |

---

## 2. Latency 预算（延迟）

### 2.1 Hook 层（同步关键路径）

Hook 在 OpenClaw 同步调用栈中执行，**任何延迟都直接影响代理体验**。

| Hook | P50 | P95 | P99 | 超出后果 |
|------|----|----|----|---------|
| `before_prompt_build` | 10ms | 50ms | 100ms | 用户感知卡顿 |
| `before_tool_call` | 5ms | 20ms | 50ms | 工具响应变慢 |
| `after_tool_call` | 5ms | 30ms | 60ms | 阻塞下一步 |
| `llm_output` | 2ms | 10ms | 20ms | 流式输出卡顿 |
| `subagent_ended` | 5ms | 30ms | 60ms | subagent 切换延迟 |
| `subagent_spawning` | 5ms | 20ms | 40ms | subagent 启动延迟 |
| `before_reset` / `compaction` | 50ms | 200ms | 500ms | 上下文压缩延迟（可接受较慢）|

### 2.2 数据流水线（异步路径）

异步路径对代理透明，预算更宽松，但仍需保证整体吞吐。

#### 2.2.1 Pain Pipeline

| 步骤 | P50 | P95 | P99 | 备注 |
|------|----|----|----|-----|
| Pain 捕获到 SQLite 写入 | 20ms | 50ms | 100ms | hook 同步路径 |
| Pain → Diagnostician task 入队 | 50ms | 100ms | 300ms | 含幂等检查 |
| Diagnostician 完整运行 | 60s | 5min | 10min | LLM 调用主导 |
| Candidate Intake | 100ms | 500ms | 2s | 含 ledger 写入 |
| **完整链路（painId → probation）** | **2min** | **6min** | **15min** | 端到端 |

#### 2.2.2 Internalization Pipeline

| 步骤 | P50 | P95 | P99 | 备注 |
|------|----|----|----|-----|
| IntakeToInternalizationBridge | 100ms | 500ms | 2s | task 入队 |
| 单个 Peer Runner（不含 LLM）| 200ms | 1s | 3s | 不含 polling |
| 单个 Peer Runner（含 LLM）| 60s | 5min | 10min | LLM 主导 |
| PIArtifact 写入 | 50ms | 200ms | 500ms | upsert |
| **完整内化（probation → validated）** | **15min** | **30min** | **60min** | 7 个 Runner 串联 |

#### 2.2.3 Activation Pipeline

| 步骤 | P50 | P95 | P99 |
|------|----|----|----|
| ActivationDispatcher.dispatch | 50ms | 200ms | 500ms |
| ChannelWriter.canActivate | 100ms | 500ms | 2s |
| ChannelWriter.activate（prompt / archive）| 50ms | 200ms | 500ms |
| ChannelWriter.activate（skill）| 100ms | 500ms | 1s |
| ChannelWriter.activate（code_tool_hook）| 200ms | 1s | 3s |
| ChannelWriter.activate（model_training）| 500ms | 2s | 5s |
| ApprovalQueue.enqueue | 50ms | 200ms | 500ms |
| ApprovalQueue.approve / reject | 50ms | 200ms | 500ms |

#### 2.2.4 Read Models（查询）

| 操作 | P50 | P95 | P99 |
|------|----|----|----|
| `PainChainReadModel.trace(painId)` | 100ms | 500ms | 1s |
| `InternalizationQueueReadModel.getSnapshot()` | 200ms | 1s | 2s |
| `OperatorHealthReadModel.snapshot()` | 300ms | 1.5s | 3s |
| `LifecycleReadModel.build()` | 200ms | 1s | 2s |
| `PruningReadModel.scan()` | 500ms | 3s | 10s |

### 2.3 CLI 命令

| 命令类型 | P50 | P95 | P99 |
|---------|----|----|----|
| 简单查询（`pd status`）| 200ms | 500ms | 1s |
| 复杂查询（`pd trace show`, `pd flow status`）| 500ms | 2s | 5s |
| 写入命令（`pd pain record`）| 200ms | 1s | 3s |
| Runner 触发（`pd runtime internalization-run-once`）| LLM 主导 | LLM 主导 | LLM 主导 |
| 数据导出（`pd legacy-import`）| 数据量主导 | 数据量主导 | 数据量主导 |

### 2.4 pd-console

| 操作 | P50 | P95 |
|------|----|----|
| 启动到首个响应 | 1s | 3s |
| 页面渲染 | 50ms | 200ms |
| API 调用（read） | 100ms | 500ms |
| API 调用（approve / reject）| 200ms | 1s |

---

## 3. Throughput 预算（吞吐量）

### 3.1 关键路径并发上限

| 资源 | 默认上限 | 备注 |
|------|--------|-----|
| 同时运行的 Diagnostician Runner | 1 / workspace | LLM API 限制主导 |
| 同时运行的 Peer Runner | 3 / workspace | 可调，default 3 |
| 同时运行的 PD CLI 进程 | 5 | LeaseManager 协调 |
| 同时打开的 SQLite 连接 | 1 / 进程 | 通过 SqliteConnection 单例 |
| 同时处理的 Hook | 由 OpenClaw 控制 | PD 不限速 |

### 3.2 速率限制（详见 `SECURITY_ARCHITECTURE.md` §9.1）

| 资源 | 上限 |
|------|-----|
| Pain signal 写入 | 1000 / 小时 / session |
| Diagnostician 任务 | 100 / 小时 / workspace |
| InternalizationOrchestrator.wakeOnce | 10 / 分钟 / workspace |
| Approval enqueue | 50 / 小时 / workspace |
| LLM 调用 | RuntimeAdapter 自行限速 |

### 3.3 队列深度

| 队列 | 报警阈值 | 上限（reject 阈值）|
|------|--------|-----------------|
| Tasks (status=pending) | 100 / kind | 1000 / kind |
| Approvals (status=pending) | 30 / channel | 200 / channel |
| Events 表 | 10000 / day | 100000 / day（自动归档）|
| Pain signals 待处理 | 50 / workspace | 500 / workspace |

---

## 4. Resource 预算（资源）

### 4.1 内存

| 进程 | 启动时 | 稳态 | 上限 |
|------|------|------|------|
| Plugin（in OpenClaw） | < 50 MB | < 200 MB | 500 MB |
| pd-cli（单次执行）| < 30 MB | n/a | 100 MB |
| pd-console 后端 | < 50 MB | < 150 MB | 300 MB |
| pd-console 前端（浏览器）| < 30 MB | < 100 MB | 200 MB |

### 4.2 CPU

PD 不应是 CPU 密集型。预算：

- 稳态 < 5% 单核
- LLM 调用期间 < 1% 单核（仅 polling）
- 高负载（流水线满载）< 30% 单核

### 4.3 文件句柄

| 进程 | 限制 |
|------|-----|
| Plugin | < 50 个并发文件句柄 |
| pd-cli | < 20 |
| pd-console | < 100 |

### 4.4 磁盘 I/O

PD 倾向于**小批量同步写**（确保数据安全），不追求极致 throughput。

| 操作 | 频率上限 |
|------|--------|
| atomic JSON write | 10 / 秒 |
| SQLite write | 100 / 秒 |
| Audit log append | 50 / 秒 |
| Telemetry event write | 200 / 秒（批量缓冲）|

---

## 5. Storage 预算（存储）

### 5.1 文件大小上限

| 文件 | 软上限（warn）| 硬上限（自动归档）|
|------|------------|----------------|
| `state.db`（含 WAL）| 100 MB | 500 MB |
| `principle_training_state.json` | 5 MB | 10 MB |
| `audit-log.jsonl` | n/a | n/a（永久保留）|
| 单个 `.principles/skills/{id}/SKILL.md` | 5 KB | 10 KB |
| 单个 `.principles/implementations/code/{id}/entry.ts` | 10 KB | 50 KB |
| `.pd/training-exports/{batch}/dataset.jsonl` | 50 MB | 100 MB |
| Telemetry events 单天聚合 | 5 MB | 50 MB |

### 5.2 数据增长率（典型）

| 数据 | 增速估算（per 工作区 per 天）|
|------|-----------------------|
| Pain signals | 50-200 |
| Tasks（含 PI 任务）| 100-500 |
| PIArtifacts | 50-200 |
| Telemetry events | 1000-10000 |
| Audit log | 10-100 |
| Ledger principles | 1-10（多数情况下不增长）|

### 5.3 归档策略

| 数据 | 归档时机 | 归档目标 |
|------|--------|---------|
| Telemetry events | > 30 天 | 压缩到 `archive/events-{YYYY-MM}.jsonl.gz` |
| 已 archived 的 PIArtifacts | > 90 天 | 移到 `archive/pi_artifacts/` |
| 已 succeeded 的 Tasks | > 30 天 | 仅保留 summary，详情压缩 |
| 失败的 Runs（> max_attempts）| > 30 天 | 同上 |

实施位置：`pd-cli pd legacy-cleanup` + 周期性自动任务。

### 5.4 数据库 vacuum

```bash
# 手动触发 SQLite VACUUM
pd runtime-recovery vacuum
```

或自动：

- 每周一次
- WAL 大于 50MB 时

---

## 6. LLM 调用预算

LLM 调用是 PD 的最大成本中心，必须严格预算。

### 6.1 Token 预算

| 阶段 | 输入 token P95 | 输出 token P95 |
|------|--------------|--------------|
| Diagnostician | 8000 | 2000 |
| Dreamer | 6000 | 3000 |
| Philosopher | 5000 | 2000 |
| Scribe | 4000 | 2000 |
| Artificer | 8000 | 4000 |
| Evaluator | 6000 | 1000 |
| RolloutReviewer | 6000 | 1000 |
| Trainer | 10000 | 5000 |

### 6.2 调用次数预算

每完成一个 painId 的完整内化（→ active）：

| Runner | 调用次数（含重试）|
|--------|---------------|
| Diagnostician | 1-3 |
| Dreamer | 1-2 |
| Philosopher | 1-2 |
| Scribe | 1-2 |
| Artificer | 1-2 |
| Evaluator | 1-2 |
| RolloutReviewer | 1-2 |
| Trainer（仅 model_training）| 1-2 |
| **总计** | **7-17** |

### 6.3 成本预算（按工作区）

| 用量 | 估算 |
|------|------|
| 每天 50 个 PainSignal | 350-850 LLM 调用 / day |
| 每 PainSignal 平均 token | ~50000 input + ~15000 output |
| 单天总 token | ~25M input + ~7.5M output |

成本主导优化方向：
- Prompt 紧凑化（避免重复上下文）
- Cache 共享（相似上下文复用）
- 限制 retry 次数

### 6.4 LLM 调用超时

| 调用 | 默认 timeout |
|------|------------|
| Diagnostician | 5 min |
| 各 Peer Runner | 5 min |
| Trainer | 10 min（数据量大）|

超时 → `PDErrorCategory.timeout` → 重试或失败。

---

## 7. 性能监控

### 7.1 关键 SLI

| SLI | 计算方式 | SLO |
|-----|--------|-----|
| Pain → Probation P95 | histogram p95 | < 6 min |
| Probation → Validated P95 | histogram p95 | < 30 min |
| Hook latency P95 | hook 入口/出口时间差 | < 50 ms |
| Diagnostician 成功率 | succeeded / total | > 90% |
| ApprovalQueue 平均延迟 | (decided - requested) 平均 | < 24 hours |
| Storage 大小增长 | 每日增量 | < 50 MB / 工作区 |

### 7.2 报警规则

| 报警 | 阈值 | 动作 |
|------|-----|-----|
| Hook latency P99 > 200ms | 持续 5 分钟 | 输出 warn 日志 |
| 队列堆积 > 50% 上限 | 持续 10 分钟 | 输出 error 日志 |
| Diagnostician 失败率 > 30% | 滚动 1 小时 | 输出 error 日志 + 暂停新任务入队 |
| state.db > 软上限 | 检测到 | 提示 vacuum |
| Audit log 写入失败 | 任何 | error + 业务中止 |

---

## 8. 性能测试

### 8.1 基准测试套件

`packages/principles-core/benchmarks/`（待建 — 旧 vitest benchmark 套件与 CI 对比已在 PRI-639 退役，重建后恢复）

测试场景：

1. **Hook latency**：模拟 1000 次 `before_prompt_build` 调用
2. **Pain pipeline 端到端**：100 个并发 PainSignal
3. **Internalization pipeline**：50 个 probation → validated
4. **ReadModel 性能**：在 10000 个 task 数据上测 InternalizationQueueReadModel
5. **SQLite 写入吞吐**：批量 task 创建

### 8.2 性能回归

每个 PR 必须运行核心 benchmark，对比 baseline（当前无活动套件 — PRI-639 已退役旧套件，重建后恢复）：

- 性能下降 < 5% → 允许
- 5-15% → review 必须解释
- > 15% → block PR（除非 ADR 批准）

### 8.3 长时间稳定性测试

每月一次：

- 7 天连续运行 plugin
- 模拟典型 workload
- 监控内存泄漏、文件句柄泄漏、SQLite 增长

---

## 9. 性能优化模式

### 9.1 缓存

| 缓存对象 | 失效策略 | 位置 |
|---------|--------|------|
| 静态文件读取（PRINCIPLES.md 等）| TTL 60s + mtime 检查 | `prompt.ts` 已实现 |
| Empathy keyword store | TTL + module-level | `prompt.ts` 已实现 |
| Pruning mask | 依赖 review log mtime | `pruning-mask.ts` 已实现 |
| Active principles 列表 | Ledger 写入即失效 | `LedgerReadModel`（待建优化）|

### 9.2 批处理

| 操作 | 批量化 |
|------|------|
| TelemetryEvent 写入 | 100ms / 100 events 批量 flush |
| Metrics 聚合 | 1 分钟桶聚合 |
| Pain signals 处理 | 不批量（保持响应性）|
| Audit log | 不批量（保持完整性）|

### 9.3 异步 vs 同步

| 选择 | 标准 |
|------|-----|
| 同步 | 用户等待结果（CLI） / 业务正确性强依赖 |
| 异步 | Telemetry / Metrics / 不影响业务结果 |
| 同步阻塞 | Audit log 写入 / Schema migration |

---

## 10. 不变量与守护

| ID | 不变量 | 强制方式 |
|----|------|---------|
| PERF-1 | Hook 延迟 P95 < 50ms | benchmark + 报警 |
| PERF-2 | 不允许在 hook 同步路径调用 LLM | architecture-regression test |
| PERF-3 | 不允许在 hook 同步路径做 SQLite VACUUM 等重操作 | review |
| PERF-4 | atomic write 必须用，不允许直接 write | review + ESLint rule |
| PERF-5 | 大批量循环必须有 yield（避免阻塞 event loop）| review |
| PERF-6 | 任何 LLM 调用必须有 timeout | review + 类型签名 |
| PERF-7 | 任何 ReadModel 必须有 query bound（不允许全表 scan）| review |

---

## 11. 实施进度

| 项目 | 状态 |
|------|-----|
| Hook latency 测量 | ⚠️ 部分（手动测过，无自动 metric）|
| Pipeline P95 测量 | ⚠️ 缺少端到端 metric |
| 队列深度 metric | ⚠️ 部分（InternalizationQueueReadModel 已有）|
| Storage 大小 metric | ❌ 待建 |
| 速率限制 | ❌ 待建（参见 `SECURITY_ARCHITECTURE.md` §9）|
| 自动归档 | ❌ 待建 |
| 自动 vacuum | ❌ 待建 |
| 性能基准测试套件 | ❌ 待建 |
| CI 中的性能回归门禁 | ❌ 待建 |

---

## 12. 关联文档

- [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) §6.2
- [`OBSERVABILITY_ARCHITECTURE.md`](./OBSERVABILITY_ARCHITECTURE.md) — Metrics 实现
- [`SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md) §9 — 速率限制
- [`DATA_ARCHITECTURE.md`](./DATA_ARCHITECTURE.md) — 存储策略
- [`INTERNALIZATION_PIPELINE.md`](./INTERNALIZATION_PIPELINE.md) §6.5 — 流水线性能预算
