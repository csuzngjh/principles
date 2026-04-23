# Phase m4-04: RetryLeaseIntegration - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-23
**Phase:** m4-04-RetryLeaseIntegration
**Areas discussed:** 测试数据策略

---

## 测试数据策略

| Option | Description | Selected |
|--------|-------------|----------|
| Fixture builders | 构造真实 TaskBuilder/RunBuilder，每个测试独立创建 fresh 数据 | |
| Seeded history | 预先 seed 历史数据（多 attempt、导入记录），测试从这些状态出发 | |
| Import mimic | 混合 runtimeKind，模拟 openclaw-history 导入的 run 记录 | |
| In-memory DB | 用真实 in-memory SQLite，走和生产一样的存储路径 | ✓ |

**User's choice:** In-memory DB
**Notes:** 每个测试创建独立 RuntimeStateManager({ workspaceDir: ':memory:' })，所有 CRUD 走和生产一样的存储路径，保证测试与真实 DB 行为一致

---

## 重点场景

| Option | Description | Selected |
|--------|-------------|----------|
| Retry 从 retry_wait 恢复 | task 在 retry_wait，lease acquire 能拿到，attemptCount 递增 | ✓ |
| 过期 lease 回收 | forceExpire 能正确回收，runner 能抢到 | |
| 并发抢 lease | 两个 runner 同时 acquire 同一个 task，只有一个成功 | |
| Max attempts 截止 | max_attempts_exceeded 时不再 retry，直接 markTaskFailed | |

**User's choice:** Retry 从 retry_wait 恢复
**Notes:** 验证 retry_wait -> leased 的恢复链路

---

*Phase: m4-04-RetryLeaseIntegration*
*Discussion completed: 2026-04-23*