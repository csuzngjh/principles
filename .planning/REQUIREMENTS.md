# Requirements: PD Task Manager (v1.7)

**Defined:** 2026-04-07
**Core Value:** AI agents improve their own behavior through a structured evolution loop. Pain → diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Architecture Doc:** `docs/architecture/pd-task-manager.md`

## v1.7 Requirements

### Type System & Store

- [ ] **TYPE-01**: PDTaskSpec interface with id, name, version, schedule, execution, delivery, meta
 PDTaskDeclaration type
- [ ] **TYPE-02**: Builtin task declarations： empathy-optimizer（6h 周期, 权重调整)
- [ ] **TYPE-03**: PDTaskStore 读写 pd_tasks.json（workspace .state 目录)， file I/O 原子化、 版本化的 reconcile meta
- [ ] **STORE-04**: PDTaskStore 支持健康状态元数据： consecutiveFailCount, lastFailedAt, autoDisabled
 pdTask 的 pd_tasks.json
- [ ] **STORE-05**: PDTaskStore 支持执行历史记录： lastRunAt/lastStatus/lastError 按 taskId 存储

- [ ] **STORE-06**: PDTaskStore 支持手动触发记录: taskId + triggeredAt + triggerStatus

- [ ] **STORE-07**: PDTaskStore 支持数据预取快照: taskId → dataSummary（key/val） 存入 task prompt

- [ ] **STORE-08**: PDTaskStore 数据预取函数可注册， 返回 prompt 数据快照

- [ ] **STORE-09**: Empathy optimizer 的数据预取读取 empathy_keywords.json + trajectory DB， 返回摘要

- [ ] **STORE-10**: Prompt 不包含 shell 命令，改用 read_file + 数据文件访问)

### Reconciler

- [ ] **RECON-01**: Reconciler 读取 pd_tasks.json 和 cron/jobs.json， diff 计算变更（CREATE/update/disable/orphan)
- [ ] **RECON-02**: 使用 file-lock (withLockAsync) 保护 cron/jobs.json 写操作， 原子化写入
 temp + rename
 (withLockAsync 包装整个 read-modify-write)
- [ ] **RECON-03**: Diff 猖略正确处理版本变更（版本号不匹配 → UPDATE）、enabled 不变但 disabled → DISABLE; 名字在 actual 但不在 declared → ORPHAN 警告)
- [ ] **RECON-04**: Reconcile 更新 pd_tasks.json 的 lastSyncedAtMs / lastSyncedJobId | lastSyncStatus
- [ ] **RECON-05**: 支持 dry-run 模式 — reconcile({ dryRun: true }) 只报告差异， 不实际写入
- [ ] **RECON-06**: 向后兼容： 已有 "PD Empathy Optimizer" job 会被自动采用和更新（pdVersion 元数据写入）
- [ ] **RECON-07**: 错误恢复: cron/jobs.json 解析失败 → 警告并跳过; pd_tasks.json 重置为默认
 重试下次启动
- [ ] **RECON-08**: 原子化写入失败 → 保留旧文件、 记录错误, 下次启动重试

### Service Integration

- [ ] **SVC-01**: PDTaskService 注册为 OpenClawPluginService（id: principles-disciple-task-manager）
- [ ] **SVC-02**: Service start() 时调用 reconcilePDTasks()，启动时非阻塞 reconcile
- [ ] **SVC-03**: Service stop() 无需清理（cron job 持久化在 jobs.json 中）
- [ ] **SVC-04**: index.ts 更新: 移除 ensurePDCronJobs 调用, 注册 PDTaskService
- [ ] **SVC-05**: 删除 cron-initializer.ts

- [ ] **SVC-06**: 移除 before_prompt_build 中的 cron init 相关代码和临时变量

### 健康监控
- [ ] **HLTH-01**: 启动时读取 cron/jobs.json 中 PD 任务 state， 检查 consecutiveErrors
- [ ] **HLTH-02**: 如果 consecutiveErrors >= 3， 自动禁用任务（设置 enabled=false）
- [ ] **HLTH-03**: 在 pd_tasks.json 标记 autoDisabled=true + autoDisabledAt + autoDisabledReason
- [ ] **HLTH-04**: 通过 OpenClaw 通知机制（announce delivery）发送送健康告警通知
- [ ] **HLTH-05**: 廉价禁用: 不限制连续失败次数， 可配置 MAXConsecutiveFailures

- [ ] **HLTH-06**: 已禁用任务不自动重新启用（重新 reconcile 可移除 autoDisabled 标记）
- [ ] **HLTH-07**: 如果 autoDisabled 任务在下次 reconcile 中持续禁用（不重新启用）

### Manual Trigger
- [ ] **TRIG-01**: 提供 trigger(taskId) 接口， 手动触发一次 PD 任务执行
- [ ] **TRIG-02**: trigger 通过修改 cron/jobs.json 中的 job 为 deleteAfterRun=true + 添加一次性执行
- [ ] **TRIG-03**: 触发后更新 pd_tasks.json 的 lastTriggeredAt + triggerStatus
- [ ] **TRIG-04**: 支持 trigger --force 模式（忽略 enabled 状态直接执行）

### Data Prefetch
- [ ] **PREF-01**: 每个 builtin task 可注册 prefetchData(taskId, ctx) 函数
- [ ] **PREF-02**: Empathy optimizer 的预取: 读取 empathy_keywords.json 摘要摘要 + trajectory recent frustration signals
- [ ] **PREF-03**: 预取数据注入到 cron job 的 prompt 中（替代旧的 shell 匽令模式）
- [ ] **PREF-04**: 数据预取通过 reconcile 在任务创建时调用（自动注入 prompt）

- [ ] **PREF-05**: 未来新增任务只需注册自己的 prefetchData 函数即可

### Execution History
- [ ] **HIST-01**: 提供 getExecutionHistory(taskId, limit?) 接口查询 PD 任务执行历史
- [ ] **HIST-02**: 历史数据从 pd_tasks.json 的 executionHistory 数 组读取
- [ ] **HIST-03**: 支持按时间范围查询（最近 N 次）
- [ ] **HIST-04**: 支持按状态查询（succeeded/failed）
- [ ] **HIST-05**: 可通过 /pd-status 壽令展示任务管理器执行历史
- [ ] **HIST-06**: 历史记录通过 cron job state 自动更新（reconcile 时读取 CronJobState.lastRunAtMs 等）

- [ ] **HIST-07**: 历史记录支持分页（默认 50 条/页）

## v2 Requirements (Deferred)

### Future Tasks

- **FUTR-01**: Nocturnal Review（每日 21:00 pain 信号分析）
- **FUTR-02**: Weekly Governance（每周五 OKR 对齐 + 系统健康报告）

### Enhanced Observability

- **OBS-01**: HTTP API 暴露任务状态和历史（集成到 control-ui）
- **OBS-02**: WebUI 任务管理页面（类似 gate-monitor）
- **OBS-03**: 任务执行趋势图和告警通知

## Out of Scope

| Feature | Reason |
|---------|--------|
| 直接调用 CronService API | 内部 API，插件无法导入 |
| 修改 OpenClaw 核心代码 | 只做插件，不修改 OpenClaw 本身 |
| 多 workspace 并发支持 | PD 只管理自己的 workspace |
| 宜告通知（邮件/Webhook） | 复杂度高，非核心功能 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TYPE-01 | Phase 14 | Pending |
| TYPE-02 | Phase 14 | Pending |
| TYPE-03 | Phase 14 | Pending |
| STORE-01 | Phase 14 | Pending |
| STORE-02 | Phase 14 | Pending |
| STORE-03 | Phase 14 | Pending |
| STORE-04 | Phase 14 | Pending |
| STORE-05 | Phase 14 | Pending |
| STORE-06 | Phase 14 | Pending |
| STORE-07 | Phase 14 | Pending |
| STORE-08 | Phase 14 | Pending |
| STORE-09 | Phase 14 | Pending |
| STORE-10 | Phase 14 | Pending |
| RECON-01 | Phase 15 | Pending |
| RECON-02 | Phase 15 | Pending |
| RECON-03 | Phase 15 | Pending |
| RECON-04 | Phase 15 | Pending |
| RECON-05 | Phase 15 | Pending |
| RECON-06 | Phase 15 | Pending |
| RECON-07 | Phase 15 | Pending |
| RECON-08 | Phase 15 | Pending |
| SVC-01 | Phase 16 | Pending |
| SVC-02 | Phase 16 | Pending |
| SVC-03 | Phase 16 | Pending |
| SVC-04 | Phase 16 | Pending |
| SVC-05 | Phase 16 | Pending |
| SVC-06 | Phase 16 | Pending |
| HLTH-01 | Phase 16 | Pending |
| HLTH-02 | Phase 16 | Pending |
| HLTH-03 | Phase 16 | Pending |
| HLTH-04 | Phase 16 | Pending |
| HLTH-05 | Phase 16 | Pending |
| HLTH-06 | Phase 16 | Pending |
| HLTH-07 | Phase 16 | Pending |
| TRIG-01 | Phase 16 | Pending |
| TRIG-02 | Phase 16 | Pending |
| TRIG-03 | Phase 16 | Pending |
| TRIG-04 | Phase 16 | Pending |
| PREF-01 | Phase 16 | Pending |
| PREF-02 | Phase 16 | Pending |
| PREF-03 | Phase 16 | Pending |
| PREF-04 | Phase 16 | Pending |
| PREF-05 | Phase 16 | Pending |
| HIST-01 | Phase 16 | Pending |
| HIST-02 | Phase 16 | Pending |
| HIST-03 | Phase 16 | Pending |
| HIST-04 | Phase 16 | Pending |
| HIST-05 | Phase 16 | Pending |
| HIST-06 | Phase 16 | Pending |
| HIST-07 | Phase 16 | Pending |

**Coverage:**
- v1.7 requirements: 47 total
- Mapped to phases: 47
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-07*
*Last updated: 2026-04-07 after milestone initialization*
