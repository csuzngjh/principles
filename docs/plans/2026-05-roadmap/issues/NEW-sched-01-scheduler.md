# OP: NEW

**Title**: `[Core] MissionScheduler (Three-Tier Tasks)`
**Priority**: High
**Project**: Project P: PD Product & Runtime
**Phase**: 2C
**Branch suggestion**: `csuzngjh/sched-01-mission-scheduler`

---

## Goal

Provide a PD-owned, host-agnostic three-tier scheduler (Mission -> Task -> Run) that respects dependencies (`depends_on` DAG) and priority. It replaces, rather than delegates from, the retired OpenClaw `IdleTrigger` pattern. Per ADR-0011 as amended by ADR-0012.

## Pre-Implementation Check

1. PRI-NEW-gap-01 must be merged (Mission table needed)
2. PRI-NEW-lras-01 should be merged (long-running execution model)
3. Read ADR-0012 and inventory any existing `runtime-v2/idle-trigger/` dependency only for retirement; do not build on it
4. Read `packages/principles-core/src/runtime-v2/internalization/internalization-orchestrator.ts` — wakeOnce contract

## Must Read First

- `docs/adr/0011-three-tier-task-model-and-mission-scheduler.md`
- `docs/architecture/COMPONENTS.md` §3.11
- `docs/adr/0012-runtime-v2-standalone-scheduling-and-legacy-retirement.md`
- `packages/principles-core/src/runtime-v2/internalization/internalization-orchestrator.ts`

## Architecture Guardrails

- Layer 2 / Domain Services
- Scheduler **必须可解释**（每个调度决策有 reason 字段，SCHED-1 不变量）
- OpenClaw `IdleTrigger` **不得作为入口**；PD-owned config/SDK/operator/scheduler 负责显式 dispatch（SCHED-2）
- 第一版仅支持线性 / 树状依赖；环依赖检测 fail-fast
- 优先级抢占只在 task 边界（lease 后不抢）
- Mission state rollup 必须 idempotent

### 不变量

- SCHED-1 / SCHED-2

## Allowed Files

新建：
- `packages/principles-core/src/runtime-v2/scheduler/mission-scheduler.ts`
- `packages/principles-core/src/runtime-v2/scheduler/priority-calculator.ts`
- `packages/principles-core/src/runtime-v2/scheduler/dependency-resolver.ts`
- `packages/principles-core/src/runtime-v2/scheduler/__tests__/`

修改：
- 必要的 Runtime V2 scheduler/config boundary 文件；不得新增 `idle-trigger` 调用方
- `packages/principles-core/src/runtime-v2/store/task/`（task 表加 priority + depends_on + mission_id 字段；migration）

## Forbidden

- ❌ 不引入死锁（环依赖必须 fail-fast）
- ❌ Scheduler 不持有 LLM 调用
- ❌ 不允许从 OpenClaw idle/night 或 legacy IdleTrigger 触发 Runtime V2（守护测试强制）
- ❌ 不引入跨 mission 的资源争抢（每 mission 独立 budget）

## Scope

1. `MissionScheduler.scheduleNext(): ScheduleDecision[]`（按优先级 + 依赖返回就绪 task）
2. `PriorityCalculator`：综合 mission objective alignment + age + retry count
3. `DependencyResolver`：DAG 拓扑校验 + 环检测
4. `Mission state rollup`：当 mission 内全部 task 终态后更新 mission.status
5. Migration：扩展 tasks 表加 `priority`, `depends_on`, `mission_id` 字段
6. 测试 ≥ 12 用例（含 DAG / 环 / 抢占 / rollup / 守护）

## Verification

- `pnpm test --run "mission-scheduler|priority-calculator|dependency-resolver"` 通过
- `architecture-regression.test.ts` 含 SCHED-1 / SCHED-2

## Out of Scope

- pd-console Mission Dashboard（PRI-NEW-sched-02）
- 复杂 DAG（fork/join、condition）
- 跨 workspace 调度

## Related

- ADR-0011
- PRI-NEW-gap-01 — 依赖
- PRI-NEW-lras-01 — 协同
