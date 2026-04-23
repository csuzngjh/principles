# Phase m3-01: Trajectory Locator — Context

## Phase Goal

Build the trajectory locator layer: `pd trajectory locate` command and underlying store queries.

## Authoritative Boundary (M3 全局约束，写死在此)

- All authoritative retrieval **must** use PD-owned stores/indexes/references as primary source
- OpenClaw raw workspace/session files are **NOT** an authoritative retrieval source
- External/host data may only be accessed through PD-managed references if already indexed by PD
- **No LLM call inside context build** — context assembly must be code-generated or template-generated

## Pre-Implementation Fact-Check (已完成 ✅)

**M2 runs 表实测索引（来自 sqlite-connection.ts initSchema）：**

| 字段/索引 | 状态 | 备注 |
|-----------|------|------|
| run_id | ✅ PK 自带索引 | exact locate 可用 |
| task_id | ✅ idx_runs_task_id | locate by taskId 可用 |
| started_at | ✅ idx_runs_started_at | date range 可用 |
| execution_status | ✅ idx_runs_status | stretch: locate by status 可用 |
| workspace_id | ❌ 列不存在 | **workspace isolation 需要从 tasks 表 join** |
| lease_owner | ❌ 不在 runs 表 | agentId 只能通过 task_id join tasks.lease_owner（成本高） |

**结论（基于实测 schema）：**
- `locateTrajectory(trajectoryId)` ✅ table stakes
- `locateTrajectoryByTaskId(taskId)` ✅ table stakes
- `locateTrajectoryByRunId(runId)` ✅ table stakes
- `locateTrajectoriesByDateRange(start, end)` ✅ table stakes
- `locateTrajectoriesBySessionHint(hints)` ⚠️ workspace 需从 tasks 表 join（m3-05 处理）
- `locateTrajectoriesByAgentId(agentId)` ❌ runs 表无 lease_owner 列，需 join，成本高 → **stretch，延后**
- `locateTrajectoriesByStatus(status)` ✅ stretch 可用（idx_runs_status 已存在）

**关键约束：m3-01 阶段 workspace isolation 通过 task_id→tasks 表 join 实现，不改变 M2 schema。**

## Locate Modes (优先级顺序)

### Table Stakes (M2 已有稳定索引)
1. `locateTrajectory(trajectoryId)` — exact match on run.run_id
2. `locateTrajectoryByTaskId(taskId)` — find runs for taskId, group into trajectory
3. `locateTrajectoryByRunId(runId)` — find run by run_id, return containing trajectory
4. `locateTrajectoriesByDateRange(start, end)` — bounded query on runs.started_at
5. `locateTrajectoriesBySessionHint(hints)` — workspace-scoped hints (workspaceId required)

### Stretch (需要先确认 M2 store 是否有稳定索引)
- `locateTrajectoriesByAgentId(agentId)` — requires `lease_owner` or `runtime_kind` indexed
- `locateTrajectoriesByStatus(executionStatus)` — requires `runs.execution_status` indexed

**确认原则:** 执行前先检查 M2 schema，确认列上有无 index，再决定是否实现 stretch 模式。如果 M2 没有索引，stretch 模式降级为 out-of-scope 并记录在 phase 文档中。

## What NOT to Do
- Do NOT import OpenClaw workspace file parsers (e.g., `*.json` session files, `openclaw/workspace/**`)
- Do NOT use raw file system traversal as a retrieval path
- Do NOT add `agentId` or `status` as primary locate modes without confirming M2 index existence
- Do NOT introduce LLM calls in this phase or any later M3 phase
