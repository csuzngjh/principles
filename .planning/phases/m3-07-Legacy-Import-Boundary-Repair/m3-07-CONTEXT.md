---
gsd_phase_version: 1.0
phase: m3-07
phase_name: Legacy Import Boundary + Real Workspace Validation
milestone: v2.2 M3 History Retrieval + Context Build
status: in_progress
last_updated: "2026-04-23T09:30:00.000Z"
---

# Phase Context: m3-07 Legacy Import Boundary + Real Workspace Validation

## Phase Goal

让 M3 在真实 OpenClaw workspace 上可用，同时维护严格的 authoritative boundary：
- Authoritative retrieval = `.pd/state.db` (PD-owned)
- Legacy import = `.state/diagnostician_tasks.json` → `.pd/state.db` via bridge
- 禁止命令直接查询 raw `.state` 作为主查询路径

## Real Environment Facts

### OpenClaw Workspace (D:\.openclaw\workspace)
- Legacy data source: `.state/diagnostician_tasks.json` (63 行，包含约 10+ tasks)
- Legacy trajectory DB: `.state/trajectory.db` (7.9MB，包含 evolution_tasks, task_outcomes 等)
- **PD-owned runtime DB: `.pd/state.db` 不存在（首次需要在工作区初始化）**

### Current M3 Implementation
- `trajectory locate` 实现: taskId/runId → runs table 查询，sessionId → JSON extraction
- `history query` 实现: taskId → runs → history entries
- `context build` 实现: taskId → assemble from task/run/history
- **问题：所有实现假设数据已经在 `.pd/state.db` 中，但真实环境为空**

### OpenClaw Workspace Bridge (现状)
- `syncOpenClawWorkspace()` 把 `diagnostician_tasks.json` 的 task 同步到 `tasks` + `runs` 表
- 输出是幂等的（ON CONFLICT UPDATE）
- **问题：bridge 当前位于 `packages/pd-cli/src/openclaw-workspace-bridge.ts`，文件名和注释让人误以为是主 retrieval 路径**

## Authoritative Path Definition

```
Authoritative Retrieval Path (M3 查询的唯一路径):
  pd trajectory locate → SqliteTrajectoryLocator → workspace/.pd/state.db
  pd history query    → SqliteHistoryQuery     → workspace/.pd/state.db
  pd context build    → SqliteContextAssembler → workspace/.pd/state.db

Legacy Import Path (数据迁移路径，非查询路径):
  OpenClaw .state/diagnostician_tasks.json
    → openclaw-workspace-bridge (syncOpenClawWorkspace)
    → PD-owned workspace/.pd/state.db

  Only used for: initial migration or periodic sync from OpenClaw legacy store
  Never used for: primary retrieval (queries go directly to .pd/state.db)
```

## Bridge Disposition

**Decision: 保留但明确隔离**

| 操作 | 理由 |
|------|------|
| 重命名文件 | `openclaw-workspace-bridge.ts` → `legacy-import.ts` |
| 移动目录 | `packages/pd-cli/src/legacy/` (新建) |
| 更新注释 | 明确标注 "compatibility import path, non-authoritative" |
| 保留功能 | diagnostician_tasks.json → tasks + runs 同步（幂等 upsert） |
| **不保留** | 任何 "re-read raw .state for every query" 的行为 |

## CLI Surface: What Stays, What Goes

### trajectory locate — 保留的 modes
| Mode | 状态 | 理由 |
|------|------|------|
| `--task <taskId>` | ✅ 保留 | 直接查 runs 表，高 confidence |
| `--run <runId>` | ✅ 保留 | 直接查 runs 表，高 confidence |
| `--from/--to` (date range) | ✅ 保留 | runs started_at 范围查询 |
| `--session <sessionId>` | ⚠️ 保留但标注 | 需要 workspace 参数；通过 sessionIdHint JSON 字段查询 |
| `--workspace` | ✅ 保留 | 强制显式传入 |
| `--json` | ✅ 保留 | 标准输出选项 |

### trajectory locate — 移除的 modes
| Mode | 状态 | 理由 |
|------|------|------|
| `--pain <painId>` | ❌ 移除 | 当前实现只是 run_id alias；无 PD-owned authoritative pain→task mapping |
| `--status <status>` | ❌ 移除 | executionStatus filter；spec 未固化，experimental；扰乱核心 surface |

## Validation Plan (Real Workspace on D:\.openclaw\workspace)

### Step 1: 确认初始状态
```bash
# .pd/state.db 不存在
ls D:\\.openclaw\\workspace\\.pd\\  # 应报错 "No such file or directory"
```

### Step 2: 执行 Bridge Import
```bash
# 方式 A: 通过 CLI sync 命令 (如果实现了 sync 命令)
pd sync --workspace D:\\.openclaw\\workspace

# 方式 B: 直接调用 bridge (临时验证脚本)
node -e "
import { syncOpenClawWorkspace } from './dist/pd-cli/src/legacy/legacy-import.js';
import { SqliteConnection } from '@principles/core';
const conn = new SqliteConnection('D:/.openclaw/workspace');
await syncOpenClawWorkspace('D:/.openclaw/workspace', conn);
conn.close();
"
```

### Step 3: 验证 Bridge 输出
```sql
-- 检查 tasks 表
SELECT COUNT(*) FROM tasks;  -- 应 > 0
SELECT task_id, task_kind, status FROM tasks LIMIT 5;

-- 检查 runs 表
SELECT COUNT(*) FROM runs;  -- 应 > 0
SELECT run_id, task_id, runtime_kind FROM runs LIMIT 5;
```

### Step 4: 验证 Query 命令（核心验证）
```bash
# 获取一个真实的 taskId
TASK_ID=$(sqlite3 D:\\.openclaw\\workspace\\.pd\\state.db "SELECT task_id FROM tasks LIMIT 1;")

# trajectory locate
pd trajectory locate --task "$TASK_ID" --workspace D:\\.openclaw\\workspace
# 期望: 返回 candidates，confidence 1.0

# history query
pd history query "$TASK_ID" --workspace D:\\.openclaw\\workspace
# 期望: 返回 entries 列表（即使为空，也应返回结构而非报错）

# context build
pd context build "$TASK_ID" --workspace D:\\.openclaw\\workspace --json
# 期望: 返回 ContextPayload JSON 结构
```

### Step 5: 验证 Non-Authoritative Boundary
```bash
# 如果命令能正确运行且查的是 .pd/state.db，即为通过
# 如果命令报错 "storage_unavailable" 或 "task not found"，说明 boundary 正确但数据未同步
# 如果命令能查到 raw .state 但没经过 .pd/state.db，即为失败
```

## Implementation Tasks

### T1: 移动并重命名 Bridge
- [ ] 创建 `packages/pd-cli/src/legacy/` 目录
- [ ] 移动 `openclaw-workspace-bridge.ts` → `legacy/legacy-import.ts`
- [ ] 更新所有 import 路径
- [ ] 添加 docstring 明确标注 "compatibility import path"

### T2: 收紧 trajectory locate surface
- [ ] 移除 `--pain` 选项
- [ ] 移除 `--status` 选项
- [ ] 更新 CLI help 注释
- [ ] 更新对应 command handler 文档

### T3: 验证 Workspace 初始化
- [ ] 确认 `SqliteConnection` 在 `D:\.openclaw\workspace\.pd\` 创建目录结构
- [ ] 确认 schema migration 正确执行

### T4: 端到端真实环境验证
- [ ] 执行 bridge import
- [ ] 验证 tasks/runs 表有数据
- [ ] 执行 trajectory/history/context 命令并验证非空结果
- [ ] 截图/记录命令输出

## Non-Goals (明确不做的)
- 不实现 M4 diagnostician runner
- 不实现 M5 unified commit
- 不重写 M2 contracts
- 不把 OpenClaw raw files 当作 authoritative retrieval 源
- 不引入 LLM 参与 context build

## Exit Criteria
1. `trajectory locate --task <id> --workspace <path>` 在 D:\.openclaw\workspace 上返回非空 candidates
2. `history query <id> --workspace <path>` 在 D:\.openclaw\workspace 上返回可解析结果
3. `context build <id> --workspace <path>` 在 D:\.openclaw\workspace 上返回 ContextPayload 结构
4. `--pain` 和 `--status` 选项已从 CLI 移除
5. bridge 代码明确标注为 "import path only"
6. 所有命令均通过 `--workspace` 强制显式传入，无 silent cwd fallback
