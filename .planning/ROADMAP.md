# Roadmap: v1.7 — PD Task Manager

**Milestone:** v1.7
**Status:** Planning
**Architecture Doc:** `docs/architecture/pd-task-manager.md`

**Date:** 2026-04-07

## Phases

Phase numbering continues from v1.6 (Phase 14).

 Phase 15 not reserved中间。

 不创建新的 phase。

| Phase | Name | Description | Depends on | Status |
|-------|------|-------------|--------|
| 14 | Core Infrastructure | TYPE-01 ~ TYPE-03, STORE + builtin tasks | Pending |
| 15 | Reconciler | TYPE-04 ~ REconcile core + dry-run, atomic write, integration | Pending |
| 16 | Integration | TYPE-05 ~ Service + index updates, delete old cron-init | Pending |

| 16 | Health & Observability | MON-01 ~ Health monitoring + auto-disable | Phase 16 |
| 17 | Manual Trigger & Data Prefetch | Phase 16 |
| 18 | Execution History | Phase 16 |

**Depends on (from v1.6):**
- v1.6 Phase 14: Core Infrastructure ( TYPE-01, TYPE-03, Store, builtin tasks)
- v1.6 Phase 15: Reconciler ( TYPE-04, Reconcile core + dry-run, atomic write + integration)
- v1.6 Phase 16: Health & Observability ( TYPE-05 ~ Service, index updates, delete old cron-init) + health monitoring + auto-disable + manual trigger + data prefetch + execution history)
- v1.6 Phase 16: Health & Observability | TYPE-07 ~ Health monitoring: Reconciler reads CronJobState.consecutiveErrors, auto-disable + log warning + trigger + 通知; (TYPE-08): Data prefetch builder generates snapshot for prompt; (TYPE-09): Build execution history query: read cron/jobs.json, correlate TaskRecord by runId = cron:{jobId}:{startedAt}`; manual trigger: `trigger(taskId)` writes a CronJob to cron store + sets enabled=true; (TYPE-10): `trigger(taskId)` triggers immediate run)

- TYPE-11: Execution history stored in pd_tasks.json per task, (`getExecutionHistory(taskId)`)

- TYPE-12: Migration adopts已有 job, auto adopt + 更新版本 + set pdVersion metadata

 架构文档 §5.2)

- TYPE-13: 新 prompt 不包含 shell 命令，改用 read_file + 数据文件访问)

| HLTH-01 | Delete cron-initializer.ts, replace by pd-task-service |
| HLTH-02 | `before_prompt_build` hook 调用 → Plugin Service `start()` hook |
 lifecycle周期管理
 对 cron 簡单移可靠, 标记机制
| HLTH-03 | 5 个 feature 块衡 v1.7 milestone | | 增加 Phase |
|--------|
---------|
| Nocturnal Review | Weekly on Friday | Daily background tasks | Daily background health check |
 | 数据预取: 在 cron job 触发时注入数据快照 | | 执行历史查询: Task Registry 关联 cron 扌行记录和 TaskRecord 的 runId |

| No new dependencies. All new文件遵循现有 file-lock.ts 的 lock + atomic write 模式 |
| 所有 Phase 忍让 race名在 phase 编号不变 |

| v1.7 Phase | v2+ (Future) Nocturnal Review, weekly governance | Daily 21:00/weekly OKR check) | Yes, shift to future版本 |

**Architecture Doc:** `docs/architecture/pd-task-manager.md`

 (671 lines)

**Milestone:**** v1.7
**Phases:** 3
**Phase numbering:** 14, 15, 16
 from v1.6)

| Phase | Name | Description | Depends on | Status |
|-------|------|-------------|--------|
| 14 | Core Infrastructure | TYPE-01 ~ TYPE-03, Store, builtin Tasks | Pending |
| 15 | Reconciler | TYPE-04, Reconcile core + dry-run, atomic write + integration | Pending |
| 16 | Integration | TYPE-05 ~ Service + index updates, delete old cron-init | Pending |
| 16 | Health & Observability | TYPE-07 ~ Health monitoring | auto-disable | Phase 16 |
| 17 | Manual Trigger & Data Prefetch | Phase 16 |
| 18 | Execution History | Pending |

