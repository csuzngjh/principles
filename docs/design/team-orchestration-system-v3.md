# PD 团队协作系统 v3 - 内置版设计

> Status: Draft
> Created: 2026-03-29
> Author: main (麻辣进化者)
> Reference: Paperclip 编排模型（剪裁版）

---

## 一、背景与问题

### 1.1 当前系统问题

| 问题类型 | 现状 | 影响 |
|----------|------|------|
| **数据分散** | 任务信息分散在 TASKBOARD.json、inbox/*.md、tasks/*.md、memory/okr/ 多处 | 难以追踪、状态不同步 |
| **调度不可靠** | 28 个 OpenClaw cron 任务，6 个超时、3 个 Feishu 投递失败 | 任务停滞、遗漏 |
| **重复调度** | 5 个 agent 各自有独立的心跳 cron | 资源浪费、逻辑重复 |
| **沟通机制弱** | sessions_send API 可用但未系统化，messages/ 目录为空 | 协作效率低 |
| **状态不同步** | TEAM_WEEK_STATE.json (W12) vs memory/okr/WEEK_STATE.json (W11) | 信息混乱 |

### 1.2 设计目标

1. **统一数据源** - SQLite 数据库替代分散的 JSON/MD 文件
2. **内置调度器** - 插件 Service 替代 OpenClaw cron
3. **简化 Prompt** - 从复杂的多步骤 prompt 简化为工具调用
4. **可靠通信** - 消息队列 + 唤醒机制替代临时文件

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         OpenClaw Gateway                             │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    PD Plugin (packages/openclaw-plugin)              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                 TeamOrchestrationService                      │   │
│  │  - 内置调度器 (setInterval 30s)                               │   │
│  │  - 任务派发 + 超时检测 + 唤醒管理                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                    │                                 │
│         ┌──────────────────────────┼──────────────────────────┐     │
│         ▼                          ▼                          ▼     │
│  ┌─────────────┐           ┌─────────────┐           ┌─────────────┐│
│  │ CLI 命令    │           │ LLM 工具    │           │  Hooks      ││
│  │ /team-*     │           │ team_*      │           │ (事件触发)  ││
│  └─────────────┘           └─────────────┘           └─────────────┘│
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   SQLite: ~/.openclaw/.central/team.db               │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │
│  │ okr_goals   │ │ team_tasks  │ │ task_runs   │ │ wakeups     │   │
│  │ okr_krs     │ │             │ │             │ │             │   │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘   │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │
│  │ agents      │ │ messages    │ │ schedules   │ │ week_states │   │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 与现有系统集成

| 现有组件 | 处理方式 |
|----------|----------|
| `EvolutionWorkerService` | 保留，只处理 Pain 信号 → 进化队列 |
| `CentralDatabase` | 保留，用于跨工作区聚合 |
| `TrajectoryDatabase` | 保留，用于轨迹记录 |
| OpenClaw cron | **禁用全部**，由 `schedules` 表接管 |
| `TASKBOARD.json` | 迁移后归档 |
| `inbox/*.md` | 删除 |
| `tasks/*.md` | 删除 |

---

## 三、SQLite Schema 设计

### 3.1 核心表

```sql
-- 1. OKR 目标表
CREATE TABLE okr_goals (
  id TEXT PRIMARY KEY,                    -- OKR-2026-Q1
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',           -- active/archived
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 2. OKR 关键结果表
CREATE TABLE okr_krs (
  id TEXT PRIMARY KEY,                    -- KR1.1
  goal_id TEXT NOT NULL REFERENCES okr_goals(id),
  title TEXT NOT NULL,
  assignee TEXT,                          -- 负责人 agent
  progress INTEGER DEFAULT 0,             -- 0-100
  status TEXT DEFAULT 'pending',          -- pending/in_progress/done/blocked
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 3. 团队任务表 (替代 TASKBOARD.json)
CREATE TABLE team_tasks (
  id TEXT PRIMARY KEY,                    -- TASK-20260329-001
  title TEXT NOT NULL,
  okr_ref TEXT REFERENCES okr_krs(id),
  status TEXT NOT NULL DEFAULT 'backlog', -- backlog/locked/done/blocked
  priority TEXT DEFAULT 'P2',             -- P0/P1/P2/P3
  assignee TEXT NOT NULL,                 -- agent id
  assigned_by TEXT,
  locked_by TEXT,
  locked_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  due_at TEXT,
  completed_at TEXT,
  blocked_reason TEXT,
  run_record_json TEXT,                   -- JSON 格式的执行记录
  tags_json TEXT,                         -- JSON 数组
  consumes_json TEXT,                     -- 依赖的任务
  produces_json TEXT                      -- 产出物
);

CREATE INDEX idx_tasks_status ON team_tasks(status);
CREATE INDEX idx_tasks_assignee ON team_tasks(assignee);
CREATE INDEX idx_tasks_okr ON team_tasks(okr_ref);

-- 4. 任务执行记录表 (借鉴 Paperclip heartbeat_runs)
CREATE TABLE task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES team_tasks(id),
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- running/succeeded/failed/timed_out
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  usage_json TEXT,                        -- token 使用量
  result_json TEXT                        -- 结果详情
);

CREATE INDEX idx_runs_task ON task_runs(task_id);
CREATE INDEX idx_runs_status ON task_runs(status);

-- 5. 唤醒队列表 (借鉴 Paperclip wakeup_requests)
CREATE TABLE wakeups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_agent TEXT NOT NULL,
  source TEXT NOT NULL,                   -- dispatch/assignment/manual/cron
  reason TEXT,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued/claimed/completed/failed
  created_at TEXT DEFAULT (datetime('now')),
  claimed_at TEXT,
  completed_at TEXT,
  idempotency_key TEXT UNIQUE             -- 防重复唤醒
);

CREATE INDEX idx_wakeups_status ON wakeups(status);
CREATE INDEX idx_wakeups_agent ON wakeups(target_agent);

-- 6. 主代理注册表 (借鉴 Paperclip agents 表)
CREATE TABLE agents (
  id TEXT PRIMARY KEY,                    -- repair, pm, verification, ...
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker',    -- ceo/cto/engineer/pm/qa/worker
  title TEXT,                             -- 职位名称
  icon TEXT,                              -- 图标/头像
  
  -- 组织架构
  reports_to TEXT REFERENCES agents(id),  -- 汇报对象（上级）
  
  -- 状态管理
  status TEXT NOT NULL DEFAULT 'pending', -- pending/idle/running/paused/terminated
  status_reason TEXT,                     -- 状态原因（manual/budget/system）
  
  -- 运行时配置
  adapter_type TEXT DEFAULT 'process',    -- process/subagent/remote
  adapter_config_json TEXT,               -- 运行时适配器配置
  runtime_config_json TEXT,               -- 模型、thinking、超时等
  
  -- 能力与权限
  capabilities_json TEXT,                 -- 技能包列表
  permissions_json TEXT DEFAULT '{}',     -- 权限配置
  can_create_agents INTEGER DEFAULT 0,    -- 是否可以创建新代理
  
  -- 预算控制
  budget_monthly_cents INTEGER DEFAULT 0,
  spent_monthly_cents INTEGER DEFAULT 0,
  
  -- 心跳
  heartbeat_interval_sec INTEGER DEFAULT 1800,
  max_concurrent_tasks INTEGER DEFAULT 1,
  last_heartbeat_at TEXT,
  
  -- 元数据
  metadata_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 组织架构索引
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_reports_to ON agents(reports_to);
CREATE INDEX idx_agents_role ON agents(role);

-- 7. 消息队列表 (Agent 间通信)
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  type TEXT NOT NULL,                     -- task_assign/block_alert/complete_notice
  content TEXT NOT NULL,
  payload_json TEXT,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_messages_to ON messages(to_agent, read);

-- 8. 调度配置表 (替代 cron jobs.json)
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_agent TEXT,                      -- null = system task
  schedule_expr TEXT NOT NULL,            -- cron 表达式或 'every:Ns'
  action_type TEXT NOT NULL,              -- heartbeat/report/cleanup
  action_config_json TEXT,
  enabled INTEGER DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT,
  consecutive_errors INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_schedules_next ON schedules(next_run_at, enabled);

-- 9. 周状态表 (替代 TEAM_WEEK_STATE.json)
CREATE TABLE week_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week TEXT NOT NULL,                     -- 2026-W12
  agent TEXT,                             -- null = 团队级
  focus_text TEXT,
  progress_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_week_week ON week_states(week, agent);

-- 10. 权限配置表 (替代 AUTONOMY_RULES.md)
CREATE TABLE autonomy_rules (
  agent TEXT PRIMARY KEY,
  auto_allow_json TEXT,                   -- 允许自动执行的操作
  require_approval_json TEXT,             -- 需要审批的操作
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### 3.2 状态机设计

```
任务状态机：

backlog ──► locked ──► done
   │          │
   │          ▼
   └────► blocked ──► (unblock) ──► backlog
```

| 状态 | 含义 | locked_by |
|------|------|-----------|
| `backlog` | 待领取 | null |
| `locked` | 执行中 | agent_id |
| `done` | 已完成 | agent_id |
| `blocked` | 被阻塞 | agent_id |

---

## 四、内置调度器设计

### 4.1 Service 实现

```typescript
// packages/openclaw-plugin/src/service/team-orchestration-service.ts

import type { OpenClawPluginService, OpenClawPluginServiceContext } from '../types';
import Database from 'better-sqlite3';

export class TeamOrchestrationService implements OpenClawPluginService {
  id = 'team-orchestration';
  private intervalId?: NodeJS.Timeout;
  private db!: Database.Database;
  private ctx!: OpenClawPluginServiceContext;

  start(ctx: OpenClawPluginServiceContext): void {
    this.ctx = ctx;
    const dbPath = ctx.resolvePath('.central/team.db');
    this.db = new Database(dbPath);
    this.initSchema();
    
    // 30 秒 tick
    this.intervalId = setInterval(() => this.tick(), 30000);
    
    // 启动时立即执行一次
    this.tick();
  }

  stop(ctx: OpenClawPluginServiceContext): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    this.db?.close();
  }

  private initSchema(): void {
    // 创建所有表...
    this.db.exec(SCHEMA_SQL);
    this.seedInitialData();
  }

  private async tick(): Promise<void> {
    const now = new Date();
    
    try {
      // 1. 处理调度任务
      await this.processSchedules(now);
      
      // 2. 处理唤醒队列
      await this.processWakeups(now);
      
      // 3. 检查超时任务
      await this.checkTimeouts(now);
      
      // 4. 检查孤儿任务（进程恢复）
      await this.recoverOrphans(now);
    } catch (error) {
      this.ctx.logger?.error('TeamOrchestrationService tick error:', error);
    }
  }

  private async processSchedules(now: Date): Promise<void> {
    const due = this.db.prepare(`
      SELECT * FROM schedules 
      WHERE enabled = 1 AND next_run_at <= ?
    `).all(now.toISOString());

    for (const schedule of due) {
      await this.executeSchedule(schedule);
    }
  }

  private async processWakeups(now: Date): Promise<void> {
    const queued = this.db.prepare(`
      SELECT * FROM wakeups WHERE status = 'queued' ORDER BY created_at LIMIT 10
    `).all();

    for (const wakeup of queued) {
      // 标记为 claimed
      this.db.prepare(`UPDATE wakeups SET status = 'claimed', claimed_at = ? WHERE id = ?`)
        .run(now.toISOString(), wakeup.id);
      
      // 调用 OpenClaw sessions_send 唤醒 agent
      try {
        await this.ctx.api?.sessionsSend({
          sessionKey: `session:${wakeup.target_agent}`,
          message: wakeup.reason || 'wake up',
        });
        
        this.db.prepare(`UPDATE wakeups SET status = 'completed', completed_at = ? WHERE id = ?`)
          .run(now.toISOString(), wakeup.id);
      } catch (error) {
        this.db.prepare(`UPDATE wakeups SET status = 'failed' WHERE id = ?`)
          .run(wakeup.id);
      }
    }
  }

  private async checkTimeouts(now: Date): Promise<void> {
    const timeoutMs = 4 * 60 * 60 * 1000; // 4 小时
    const stuck = this.db.prepare(`
      SELECT * FROM team_tasks 
      WHERE status = 'locked' 
      AND datetime(locked_at) < datetime(?)
    `).all(new Date(now.getTime() - timeoutMs).toISOString());

    for (const task of stuck) {
      // 发送提醒消息
      this.db.prepare(`
        INSERT INTO messages (from_agent, to_agent, type, content, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run('system', task.locked_by, 'timeout_alert', 
        `任务 ${task.id} 已锁定超过 4 小时`, 
        JSON.stringify({ task_id: task.id }));
      
      // 更新 agent 的 last_alerted
      // 可选：自动解锁或标记 blocked
    }
  }

  private async recoverOrphans(now: Date): Promise<void> {
    // 查找 running 状态超过 1 小时的 task_runs
    const orphans = this.db.prepare(`
      SELECT * FROM task_runs 
      WHERE status = 'running' 
      AND datetime(started_at) < datetime(?)
    `).all(new Date(now.getTime() - 60 * 60 * 1000).toISOString());

    for (const run of orphans) {
      // 标记为 timed_out
      this.db.prepare(`UPDATE task_runs SET status = 'timed_out', finished_at = ? WHERE id = ?`)
        .run(now.toISOString(), run.id);
      
      // 解锁任务
      this.db.prepare(`
        UPDATE team_tasks SET status = 'backlog', locked_by = NULL, locked_at = NULL 
        WHERE id = ?
      `).run(run.task_id);
    }
  }
}
```

### 4.2 初始调度配置

```typescript
// seeds/schedules.ts
export const INITIAL_SCHEDULES = [
  // Agent 心跳（替代 5 个 agent-taskboard cron）
  { 
    id: 'heartbeat-all', 
    schedule_expr: 'every:1800s', 
    target_agent: null, 
    action_type: 'heartbeat',
    action_config: { agents: ['repair', 'pm', 'verification', 'scout', 'builder', 'hr', 'research'] }
  },
  
  // 任务派发（替代 taskboard-dispatch cron）
  { 
    id: 'dispatch', 
    schedule_expr: 'every:3600s', 
    target_agent: 'main',
    action_type: 'dispatch' 
  },
  
  // 超时检测（替代 taskboard-watchdog cron）
  { 
    id: 'watchdog', 
    schedule_expr: 'every:14400s', 
    target_agent: null,
    action_type: 'watchdog' 
  },
  
  // 日报（替代 daily-report cron）
  { 
    id: 'daily-report', 
    schedule_expr: 'cron:0 1 * * *', 
    target_agent: 'main',
    action_type: 'report',
    action_config: { type: 'daily' }
  },
  
  // 周治理（替代 weekly-governance cron）
  { 
    id: 'weekly-governance', 
    schedule_expr: 'cron:0 0 * * 0', 
    target_agent: 'main',
    action_type: 'governance' 
  },
  
  // 日志告警（替代 scout-log-alert cron）
  { 
    id: 'log-alert', 
    schedule_expr: 'every:10800s', 
    target_agent: 'scout',
    action_type: 'alert' 
  }
];
```

---

## 五、LLM 工具设计

### 5.1 工具列表

```typescript
// packages/openclaw-plugin/src/tools/team-tools.ts

export const TEAM_TOOLS = [
  // 1. 任务查询
  {
    name: 'team_task_list',
    description: '查询任务列表',
    parameters: {
      type: 'object',
      properties: {
        assignee: { type: 'string', description: '过滤指定 agent' },
        status: { type: 'string', enum: ['backlog', 'locked', 'done', 'blocked'] },
        limit: { type: 'number', default: 10 }
      }
    }
  },

  // 2. 任务领取（原子操作）
  {
    name: 'team_task_claim',
    description: '原子领取任务，成功返回任务详情',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID' }
      },
      required: ['task_id']
    }
  },

  // 3. 任务完成
  {
    name: 'team_task_complete',
    description: '标记任务完成并填写执行记录',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        result: { type: 'string', enum: ['success', 'failed', 'partial'] },
        output: { type: 'string', description: '产出物描述' },
        issues: { type: 'array', items: { type: 'string' } }
      },
      required: ['task_id', 'result']
    }
  },

  // 4. 任务阻塞
  {
    name: 'team_task_block',
    description: '标记任务被阻塞',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string', description: '阻塞原因' }
      },
      required: ['task_id', 'reason']
    }
  },

  // 5. 消息发送
  {
    name: 'team_message_send',
    description: '向其他 agent 发送消息',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标 agent' },
        type: { type: 'string', description: '消息类型' },
        content: { type: 'string', description: '消息内容' },
        payload: { type: 'object', description: '附加数据' }
      },
      required: ['to', 'type', 'content']
    }
  },

  // 6. 消息读取
  {
    name: 'team_message_read',
    description: '读取自己的消息',
    parameters: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', default: true },
        limit: { type: 'number', default: 10 }
      }
    }
  },

  // 7. OKR 查询
  {
    name: 'team_okr_list',
    description: '查询 OKR 列表',
    parameters: {
      type: 'object',
      properties: {}
    }
  },

  // 8. Agent 唤醒
  {
    name: 'team_wake_agent',
    description: '唤醒其他 agent',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: '目标 agent' },
        reason: { type: 'string', description: '唤醒原因' }
      },
      required: ['agent', 'reason']
    }
  }
];
```

### 5.2 原子领取实现

```typescript
function handleTaskClaim(taskId: string, agentId: string): ClaimResult {
  // 使用事务保证原子性
  const claim = this.db.transaction(() => {
    // 1. 检查任务状态
    const task = this.db.prepare(`
      SELECT * FROM team_tasks WHERE id = ? AND assignee = ?
    `).get(taskId, agentId);
    
    if (!task) {
      return { success: false, reason: 'task_not_found_or_not_assignee' };
    }
    
    if (task.status !== 'backlog') {
      return { success: false, reason: `task_status_is_${task.status}` };
    }
    
    if (task.locked_by !== null) {
      return { success: false, reason: 'already_locked' };
    }
    
    // 2. 原子更新
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE team_tasks 
      SET status = 'locked', locked_by = ?, locked_at = ?
      WHERE id = ? AND locked_by IS NULL
    `).run(agentId, now, taskId);
    
    if (result.changes === 0) {
      return { success: false, reason: 'concurrent_claim_failed' };
    }
    
    // 3. 创建 run 记录
    this.db.prepare(`
      INSERT INTO task_runs (task_id, agent, status, started_at)
      VALUES (?, ?, 'running', ?)
    `).run(taskId, agentId, now);
    
    return { success: true, task: { ...task, status: 'locked', locked_by: agentId, locked_at: now } };
  });
  
  return claim();
}
```

---

## 六、CLI 命令设计

```bash
# === 任务管理 ===
/team task list [--status backlog|locked|done] [--assignee repair]
/team task show TASK-20260329-001
/team task create --title "xxx" --assignee repair --priority P1 --okr KR1.1
/team task assign TASK-xxx repair
/team task complete TASK-xxx --result success --output "xxx"
/team task block TASK-xxx --reason "等待上游"

# === 唤醒管理 ===
/team wake repair --reason "新任务分配"
/team wake-list [--status queued]

# === OKR 管理 ===
/team okr list
/team okr show KR1.1
/team okr derive                        # 从 OKR 自动生成任务
/team okr progress KR1.1 50             # 更新进度

# === Agent 管理 ===
/team agent list
/team agent status repair
/team agent heartbeat repair            # 手动触发心跳

# === 调度管理 ===
/team schedule list
/team schedule enable/disable <id>
/team schedule run-now <id>             # 手动触发

# === 消息管理 ===
/team message list [--unread]
/team message read <id>

# === 系统状态 ===
/team status                            # 整体状态摘要
/team watchdog                          # 运行异常检测
/team week current                      # 当前周状态
/team week update --focus "xxx"         # 更新焦点
```

---

## 七、心跳 Prompt 简化版

### 7.1 Agent 心跳 Prompt

```markdown
# Agent Heartbeat

你是 {agent_name}。

## 执行步骤

1. 调用 `team_task_list(status=locked, assignee={agent_name})`
   - 有结果 → 继续执行，调用 `team_task_complete` 完成

2. 调用 `team_task_list(status=backlog, assignee={agent_name})`
   - 有结果 → 调用 `team_task_claim` 领取最高优先级任务
   - 领取成功 → 执行任务

3. 无任务 → 调用 `team_okr_list` 查看可认领的 KR
   - 有匹配 → 创建任务并领取

4. 全部无 → 回复 "{agent_name} idle"

## 重要规则

- 每个 heartbeat 周期最多领取 1 个任务
- 领取前确认 locked_by 为 null（原子领取）
- 如果任务执行时间超过 heartbeat 周期，保留 locked 状态下次继续
- 不确定能不能做 → 调用 `team_task_block`，不要直接跳过
- 完成任务必须填写 result 和 output
```

### 7.2 Main 心跳 Prompt

```markdown
# Main Heartbeat

你是 main（麻辣进化者），团队指挥官。

## 执行步骤

1. 调用 `team_task_list(status=backlog)` 检查所有待分配任务
   - 有 backlog → 调用 `team_wake_agent` 唤醒对应 assignee

2. 调用 `team_okr_list` 检查 OKR 覆盖
   - 哪些 KR 没有对应任务？→ 创建任务

3. 调用 `team_message_read` 检查是否有阻塞升级消息
   - blocked > 24h → 必须通知 Wesley

4. 无事可做 → 回复 "main dispatch complete"
```

---

## 八、覆盖现有功能矩阵

| 现有功能 | 当前实现 | 新方案实现 | 覆盖状态 |
|----------|----------|------------|----------|
| 任务看板 | TASKBOARD.json | `team_tasks` 表 | ✅ |
| 任务详情 | .team/tasks/*.md | `team_tasks.run_record_json` | ✅ |
| OKR 管理 | TEAM_OKR.md + JSON | `okr_goals` + `okr_krs` 表 | ✅ |
| 周状态 | TEAM_WEEK_STATE.json | `week_states` 表 | ✅ |
| Agent 心跳 | 5 个独立 cron | 内置调度器 `heartbeat-all` | ✅ |
| 任务派发 | taskboard-dispatch cron | 内置调度器 `dispatch` | ✅ |
| 超时检测 | taskboard-watchdog cron | 内置调度器 `watchdog` | ✅ |
| 消息传递 | sessions_send API | `messages` 表 + `wakeups` 表 | ✅ |
| 收件箱 | inbox/*.md | `messages` 表 | ✅ |
| 通信日志 | comm/log.md | `messages` 表 | ✅ |
| 日报 | daily-report cron | 内置调度器 `daily-report` | ✅ |
| 周治理 | weekly-governance cron | 内置调度器 `weekly-governance` | ✅ |
| 日志告警 | scout-log-alert cron | 内置调度器 `log-alert` | ✅ |
| 权限规则 | AUTONOMY_RULES.md | `autonomy_rules` 表 | ✅ |

---

## 九、实施计划

### Phase 1: 基础设施 (Day 1-2)

| 步骤 | 内容 | 产出 |
|------|------|------|
| 1.1 | 创建 `team-database.ts` | SQLite 初始化 + Schema |
| 1.2 | 创建 `team-orchestration-service.ts` | 内置调度器框架 |
| 1.3 | 创建 `team-tools.ts` | 8 个 LLM 工具实现 |
| 1.4 | 在 `index.ts` 注册 | Service + Tools 生效 |

### Phase 2: CLI 命令 (Day 3)

| 步骤 | 内容 | 产出 |
|------|------|------|
| 2.1 | 创建 `commands/team-*.ts` | 所有 CLI 命令 |
| 2.2 | 数据迁移脚本 | TASKBOARD.json → team.db |
| 2.3 | 测试基本流程 | 创建/领取/完成 |

### Phase 3: 禁用 Cron (Day 4)

| 步骤 | 内容 | 产出 |
|------|------|------|
| 3.1 | 禁用所有 OpenClaw cron | jobs.json 清空 |
| 3.2 | 初始化 `schedules` 表 | 6 个核心调度 |
| 3.3 | 更新 agent 心跳 prompt | 简化版 |

### Phase 4: 验证 (Day 5-7)

| 步骤 | 内容 | 产出 |
|------|------|------|
| 4.1 | 测试任务派发流程 | main → agent |
| 4.2 | 测试超时检测 | 4h/24h 告警 |
| 4.3 | 测试进程恢复 | orphan recovery |
| 4.4 | 验证数据一致性 | 无丢失 |

### Phase 5: 清理 (Day 8)

| 步骤 | 内容 | 产出 |
|------|------|------|
| 5.1 | 删除废弃文件 | inbox/*.md, tasks/*.md |
| 5.2 | 归档 TASKBOARD.json | 保留备份 |
| 5.3 | 更新 AGENTS.md | 新的启动流程 |

---

## 十、风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Agent 不遵守协议 | 中 | 任务不执行 | Watchdog + Trust Score 扣分 |
| 数据库损坏 | 低 | 数据丢失 | 每日备份 + WAL 模式 |
| 调度器崩溃 | 中 | 任务停滞 | 进程监控 + 自动重启 |
| 并发写入冲突 | 低 | 数据不一致 | SQLite 事务 + 重试 |
| 迁移数据丢失 | 低 | 历史丢失 | 完整备份 + 双写过渡 |

---

## 十一、成功标准

| 指标 | 测量方式 | 目标 |
|------|----------|------|
| Wesley 日均交互次数 | 统计聊天消息 | ≤1 次/天 |
| 任务从创建到领取延迟 | 数据库时间戳 | < 1h |
| 任务从领取到完成延迟 | 数据库时间戳 | < 24h (P0) / 72h (P1+) |
| 幽灵任务数 | locked > 4h 的任务 | 0 |
| run_record 完整率 | done 任务有记录 | 100% |
| cron 任务数量 | jobs.json 条目 | 0（全部内置） |

---

## 十二、全生命周期设计

### 12.1 OKR 全生命周期

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         OKR Lifecycle                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  [创建] ──► [激活] ──► [分解KR] ──► [生成任务] ──► [执行] ──► [归档]    │
│     │          │          │            │           │          │         │
│     │          │          │            │           │          │         │
│   Wesley    main       main/agent    main       agents      main       │
│   审批      自动       派生任务      自动派发   执行完成    归档总结    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**OKR 状态机**:

| 状态 | 触发者 | 说明 |
|------|--------|------|
| `draft` | Wesley | 草稿，等待审批 |
| `active` | main | 激活，开始派生任务 |
| `paused` | Wesley | 暂停，停止派生新任务 |
| `completed` | main | 所有 KR 完成 |
| `archived` | main | 归档，写入历史记录 |

**KR 状态机**:

| 状态 | 触发者 | 说明 |
|------|--------|------|
| `pending` | main | 等待分配 |
| `assigned` | main | 已分配给 agent |
| `in_progress` | agent | 有任务正在执行 |
| `done` | agent | 所有任务完成 |
| `blocked` | agent | 被阻塞，需要升级 |

### 12.2 Agent 全生命周期

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Agent Lifecycle                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  [注册] ──► [激活] ──► [工作] ──► [休眠] ──► [唤醒] ──► [退出]         │
│     │        │        │        │        │        │                      │
│     │        │        │        │        │        │                      │
│   main     main    scheduler  main    scheduler  main                   │
│   审批     激活    派发任务   暂停     唤醒      移除                    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Agent 状态机**:

| 状态 | 说明 | 行为 |
|------|------|------|
| `registering` | 注册中，等待审批 | 不接收任务 |
| `active` | 激活，正常工作 | 接收任务、执行心跳 |
| `idle` | 空闲，无任务 | 等待唤醒 |
| `sleeping` | 休眠，暂时离线 | 不接收任务，保留状态 |
| `retired` | 退役，永久退出 | 任务重新分配 |

---

## 十三、订阅机制设计

### 13.1 为什么需要订阅？

**问题**：
- 当前是"轮询模式"：agent 每 30 分钟检查一次任务
- 效率低：无任务时浪费 token
- 延迟高：新任务最多等 30 分钟才被发现

**订阅模式**：
- 事件驱动：有任务时立即通知
- 按需唤醒：无任务时不消耗资源
- 低延迟：新任务立即触发

### 13.2 订阅类型

```typescript
// 订阅类型定义
interface Subscription {
  id: string;
  subscriber: string;           // 订阅者 agent_id
  type: SubscriptionType;       // 订阅类型
  filter: SubscriptionFilter;   // 过滤条件
  action: SubscriptionAction;   // 触发动作
  enabled: boolean;
}

type SubscriptionType = 
  | 'task_assigned'      // 有任务分配给我
  | 'task_completed'     // 我创建的任务完成了
  | 'task_blocked'       // 我关注的任务被阻塞
  | 'kr_progress'        // KR 进度更新
  | 'okr_status'         // OKR 状态变化
  | 'agent_online'       // 某个 agent 上线
  | 'schedule_due';      // 定时任务到期

interface SubscriptionFilter {
  task_id?: string;
  kr_id?: string;
  okr_id?: string;
  agent_id?: string;
  priority?: string;
}

interface SubscriptionAction {
  type: 'wake' | 'message' | 'webhook';
  target?: string;              // wake: agent_id, message: agent_id, webhook: url
  template?: string;            // 消息模板
}
```

### 13.3 订阅表设计

```sql
-- 11. 订阅表
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  subscriber TEXT NOT NULL,              -- 订阅者 agent_id
  type TEXT NOT NULL,                    -- task_assigned / task_completed / ...
  filter_json TEXT,                      -- 过滤条件
  action_type TEXT NOT NULL,             -- wake / message / webhook
  action_target TEXT,                    -- 目标
  action_template TEXT,                  -- 消息模板
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_triggered_at TEXT,
  trigger_count INTEGER DEFAULT 0
);

CREATE INDEX idx_subscriber ON subscriptions(subscriber, enabled);
CREATE INDEX idx_type ON subscriptions(type, enabled);

-- 12. 事件队列表（替代直接唤醒）
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                    -- 事件类型
  source TEXT,                           -- 事件来源
  payload_json TEXT,                     -- 事件数据
  created_at TEXT DEFAULT (datetime('now')),
  processed INTEGER DEFAULT 0,
  processed_at TEXT
);

CREATE INDEX idx_events_pending ON events(processed, created_at);
```

### 13.4 订阅工作流

```
任务分配示例：

1. main 创建任务：team_task_create(assignee='repair')
   │
   ▼
2. 触发事件：INSERT INTO events (type='task_assigned', payload={task_id, assignee})
   │
   ▼
3. 调度器处理事件：
   - 查询订阅：SELECT * FROM subscriptions WHERE type='task_assigned' AND filter matches
   - 发现 repair 订阅了 task_assigned
   - 执行动作：wake repair
   │
   ▼
4. repair 被唤醒，立即处理任务
```

### 13.5 默认订阅配置

```typescript
// 每个新 agent 自动创建的默认订阅
const DEFAULT_SUBSCRIPTIONS: Omit<Subscription, 'id' | 'subscriber'>[] = [
  // 有任务分配给我时，唤醒我
  {
    type: 'task_assigned',
    filter: {},  // 空过滤器 = 所有分配给我的任务
    action: { type: 'wake' },
    enabled: true
  },
  // 我关注的任务被阻塞时，发消息通知我
  {
    type: 'task_blocked',
    filter: {},
    action: { type: 'message', template: '任务 {task_id} 被阻塞：{reason}' },
    enabled: true
  },
  // KR 进度更新时，发消息通知（如果我是 KR 负责人）
  {
    type: 'kr_progress',
    filter: {},
    action: { type: 'message', template: 'KR {kr_id} 进度更新：{progress}%' },
    enabled: true
  }
];
```

---

## 十四、CLI 小程序设计（智能体使用）

### 14.1 设计理念

**CLI 是什么**：
- 一个**独立的命令行小程序**，不是 OpenClaw 的 `/` 命令
- **智能体通过 Skill 指导 LLM 使用这个小程序**
- 智能**可扩展**：智能体可以根据需要添加新命令

**为什么用 CLI 而不是 LLM Tool**：
- CLI 更稳定：输出格式统一，适合 LLM 解析
- CLI 更透明：命令执行过程可审计
- CLI 可扩展：智能体可以 `team cmd add` 添加自定义命令
- CLI 更快：不需要经过插件加载流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       智能体使用 CLI 的流程                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   主代理 (workspace-xxx)                                                 │
│        │                                                                 │
│        │ 1. 读取 Skill: team-collaboration/SKILL.md                     │
│        ▼                                                                 │
│   ┌─────────────────────────────────────┐                               │
│   │ SKILL.md 指导:                       │                               │
│   │ - 什么时候用 team task list          │                               │
│   │ - 什么时候用 team task claim         │                               │
│   │ - 输出格式如何解析                   │                               │
│   │ - 错误如何处理                       │                               │
│   └─────────────────────────────────────┘                               │
│        │                                                                 │
│        │ 2. 调用 CLI                                                     │
│        ▼                                                                 │
│   $ team task list --assignee repair                                    │
│   ┌─────────────────────────────────────┐                               │
│   │ 输出 (JSON 或 表格):                 │                               │
│   │ TASK-001 | backlog  | P1 | 修复登录  │                               │
│   │ TASK-002 | locked   | P2 | 重构API   │                               │
│   └─────────────────────────────────────┘                               │
│        │                                                                 │
│        │ 3. 解析结果，继续工作                                           │
│        ▼                                                                 │
│   主代理决定下一步行动                                                   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 14.2 CLI 命令概览

```bash
# team CLI - 团队协作小程序
# 用法: team <domain> <action> [options]

## 任务管理 (高频使用)
team task list [--assignee <id>] [--status <status>] [--priority <P0-3>]
team task show <task-id>
team task claim <task-id>              # 原子领取
team task complete <task-id> [--result success|failed|partial] [--output <text>]
team task block <task-id> --reason <text>
team task unblock <task-id>

## 消息通信 (中频)
team msg list [--unread]
team msg send <to-agent> <message>
team msg read <msg-id|--all>

## OKR 查询 (低频)
team okr list [--active]
team okr show <okr-id>
team kr progress <kr-id> <percent>

## Agent 状态 (低频)
team agent list
team agent show <agent-id>
team agent stats

## 订阅管理 (低频)
team sub list
team sub add <event-type> [--filter <expr>]
team sub remove <sub-id>

## 系统状态 (管理员)
team status                             # 整体状态
team health                             # 健康检查
team watchdog                           # 异常检测

## 扩展命令 (智能体可自定义)
team cmd add <name> --sql <query> [--output json|table]
team cmd list                           # 列出自定义命令
team cmd remove <name>
```

### 14.3 输出格式

**默认：人类可读的表格**

```
$ team task list --assignee repair

┌──────────────┬──────────┬──────┬─────────────────┬────────────┐
│ ID           │ Status   │ Prio │ Title           │ Due        │
├──────────────┼──────────┼──────┼─────────────────┼────────────┤
│ TASK-001     │ backlog  │ P1   │ 修复登录页样式  │ 2026-03-30 │
│ TASK-002     │ locked   │ P2   │ 重构API响应格式 │ 2026-04-01 │
│ TASK-003     │ blocked  │ P2   │ 集成测试        │ -          │
└──────────────┴──────────┴──────┴─────────────────┴────────────┘
```

**JSON 模式（供 LLM 解析）**：

```
$ team task list --assignee repair --json

{
  "tasks": [
    {
      "id": "TASK-001",
      "status": "backlog",
      "priority": "P1",
      "title": "修复登录页样式",
      "due_at": "2026-03-30"
    },
    {
      "id": "TASK-002",
      "status": "locked",
      "priority": "P2",
      "title": "重构API响应格式",
      "due_at": "2026-04-01",
      "locked_by": "repair",
      "locked_at": "2026-03-29T10:00:00Z"
    }
  ],
  "count": 2
}
```

### 14.4 Skill 指导 LLM 使用 CLI

**文件位置**: `skills/team-collaboration/SKILL.md`

```markdown
# Team Collaboration Skill

## 何时使用 CLI

### 心跳启动时
1. 运行 `team task list --assignee $AGENT_ID --status backlog,locked`
2. 查看是否有待处理任务
3. 如果有 blocked 任务，检查阻塞是否解除

### 开始工作时
1. 运行 `team task claim <task-id>` 领取任务
2. 开始执行任务
3. 完成后运行 `team task complete <task-id> --result success`

### 遇到阻塞时
1. 运行 `team task block <task-id> --reason "具体原因"`
2. 如果需要帮助，运行 `team msg send <agent> "请求帮助..."`

## 输出解析

CLI 支持 `--json` 参数输出结构化数据：

\`\`\`bash
team task list --json | jq '.tasks[] | select(.priority=="P1")'
\`\`\`

## 错误处理

- `ERROR: Task not found` → 任务不存在，检查 ID
- `ERROR: Task already locked` → 任务已被领取，等待或联系管理员
- `ERROR: Permission denied` → 无权限，检查任务是否分配给自己

## 自定义命令

可以扩展 CLI：

\`\`\`bash
# 添加一个自定义命令：查询高优先级任务
team cmd add urgent-tasks --sql "
  SELECT id, title, priority 
  FROM team_tasks 
  WHERE priority IN ('P0', 'P1') 
    AND status IN ('backlog', 'locked')
  ORDER BY priority, created_at
"

# 使用自定义命令
team urgent-tasks
\`\`\`
```

### 14.5 权限控制

**权限检查位置**：CLI 内部（不是在 DB 层）

```typescript
// team-cli/src/permission.ts

export function checkPermission(
  agentId: string,
  command: string,
  params: Record<string, unknown>
): boolean {
  const agent = getAgentConfig(agentId);
  
  // 基本规则：
  // - task list: 只能看自己的任务（非管理员）
  // - task claim: 只能领取分配给自己的任务
  // - task complete: 只能完成自己锁定的任务
  // - okr/agent/schedule: 仅管理员
  
  switch (command) {
    case 'task:list':
      if (!agent.isAdmin && params.assignee && params.assignee !== agentId) {
        return false;
      }
      return true;
      
    case 'task:claim':
      // 检查任务的 assignee 是否是当前 agent
      const task = getTask(params.task_id);
      return task.assignee === agentId;
      
    case 'task:complete':
      // 检查任务的 locked_by 是否是当前 agent
      const task = getTask(params.task_id);
      return task.locked_by === agentId;
      
    case 'okr:*':
    case 'agent:*':
    case 'schedule:*':
      return agent.isAdmin;
      
    default:
      return true;
  }
}
```

### 14.6 CLI 扩展机制

**智能体可以自定义命令**：

```bash
# 查看现有自定义命令
$ team cmd list

┌───────────────┬──────────────────────────────────────────────┐
│ Name          │ Description                                  │
├───────────────┼──────────────────────────────────────────────┤
│ urgent-tasks  │ 高优先级任务列表                              │
│ my-blockers   │ 我被阻塞的任务                                │
└───────────────┴──────────────────────────────────────────────┘

# 添加新命令
$ team cmd add weekly-summary --sql "
  SELECT 
    a.id as agent,
    COUNT(CASE WHEN t.status='done' THEN 1 END) as completed,
    COUNT(CASE WHEN t.status='locked' THEN 1 END) as in_progress,
    COUNT(CASE WHEN t.status='blocked' THEN 1 END) as blocked
  FROM agents a
  LEFT JOIN team_tasks t ON t.assignee = a.id
  WHERE t.completed_at >= date('now', '-7 days')
  GROUP BY a.id
" --output table

# 使用
$ team weekly-summary
```

**自定义命令存储**：`team.db` 中的 `custom_commands` 表

```sql
CREATE TABLE custom_commands (
  name TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,    -- 创建者 agent
  sql_query TEXT NOT NULL,
  output_format TEXT DEFAULT 'table',
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## 十五、LLM 工具设计（CLI 封装层）

### 15.1 核心理念

**LLM 工具 = CLI 的封装**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     LLM Tool Architecture                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   主代理 (独立工作空间)                                                  │
│        │                                                                 │
│        ├──── 方式1: 直接调用 CLI ──────────────────────────────────┐    │
│        │     $ team task list                                     │    │
│        │     (通过 Skill 指导)                                     │    │
│        │                                                          │    │
│        └──── 方式2: 调用 LLM Tool ────────────────────────────────┤    │
│              team_task_list()                                     │    │
│              (Tool 内部调用 CLI)                                   │    │
│                                                                   │    │
│                              ▼                                    │    │
│              ┌─────────────────────────────────┐                  │    │
│              │     team CLI (独立小程序)        │ ◄────────────────┘    │
│              │     team task list --json       │                       │
│              └────────────────┬────────────────┘                       │
│                               │                                         │
│                               ▼                                         │
│              ┌─────────────────────────────────┐                       │
│              │     SQLite: team.db             │                       │
│              └─────────────────────────────────┘                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**为什么需要两层？**
- **CLI**：稳定、可扩展、独立测试
- **LLM Tool**：参数校验、自动注入 agentId、格式化输出

### 15.2 主代理 vs 子代理

| 概念 | 定义 | 协作方式 |
|------|------|----------|
| **主代理** | 独立工作空间、独立记忆、独立心跳 | 通过 CLI/DB 与其他主代理协作 |
| **子代理** | 临时执行单元，由主代理调用 | 主代理的"工具"，不是团队成员 |

**关键区别**：
- 主代理之间**不通过** `sessions_spawn` 协作
- 主代理通过 CLI 读写 team.db 进行协作
- `sessions_spawn` 是主代理内部调用子代理的机制（执行具体任务）

### 15.3 工具定义

```typescript
// packages/openclaw-plugin/src/tools/team-tools.ts

/**
 * LLM 工具是 CLI 的 thin wrapper
 * - 自动注入当前 agentId
 * - 参数校验
 * - 输出格式化
 */
export const TEAM_TOOLS = [
  // ═══════════════════════════════════════════════════════════════
  // 任务操作 - 主代理高频使用
  // ═══════════════════════════════════════════════════════════════
  
  {
    name: 'team_task_list',
    description: '查询任务列表。默认查询分配给自己的任务。',
    parameters: {
      type: 'object',
      properties: {
        status: { 
          type: 'string', 
          enum: ['backlog', 'locked', 'done', 'blocked'],
          description: '按状态过滤'
        },
        priority: { type: 'string', description: 'P0/P1/P2/P3' }
      }
    },
    // 实现：调用 CLI
    execute: async (params, ctx) => {
      const args = ['task', 'list', '--json'];
      if (params.status) args.push('--status', params.status);
      if (params.priority) args.push('--priority', params.priority);
      // agentId 自动注入，不需要参数
      return await execTeamCLI(args, { agentId: ctx.agentId });
    }
  },

  {
    name: 'team_task_claim',
    description: '原子领取任务。只能领取分配给自己的任务。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' }
      },
      required: ['task_id']
    },
    execute: async (params, ctx) => {
      return await execTeamCLI(
        ['task', 'claim', params.task_id, '--json'],
        { agentId: ctx.agentId }
      );
    }
  },

  {
    name: 'team_task_complete',
    description: '完成任务。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        result: { type: 'string', enum: ['success', 'failed', 'partial'] },
        output: { type: 'string', description: '产出物' }
      },
      required: ['task_id', 'result']
    },
    execute: async (params, ctx) => {
      const args = ['task', 'complete', params.task_id, '--result', params.result];
      if (params.output) args.push('--output', params.output);
      args.push('--json');
      return await execTeamCLI(args, { agentId: ctx.agentId });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // 消息通信 - 主代理间协作
  // ═══════════════════════════════════════════════════════════════
  
  {
    name: 'team_message_send',
    description: '向其他主代理发送消息（不是子代理）',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标主代理 ID' },
        content: { type: 'string' }
      },
      required: ['to', 'content']
    },
    execute: async (params, ctx) => {
      return await execTeamCLI(
        ['msg', 'send', params.to, params.content, '--json'],
        { agentId: ctx.agentId }
      );
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // 管理工具 - 仅 Team Leader (main)
  // ═══════════════════════════════════════════════════════════════
  
  {
    name: 'team_task_create',
    description: '创建新任务。仅 Team Leader 可用。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        assignee: { type: 'string', description: '分配给哪个主代理' },
        priority: { type: 'string' }
      },
      required: ['title', 'assignee']
    },
    execute: async (params, ctx) => {
      // 权限检查
      if (!isTeamLeader(ctx.agentId)) {
        return { error: 'Permission denied: only Team Leader can create tasks' };
      }
      return await execTeamCLI(
        ['task', 'create', '--title', params.title, '--assignee', params.assignee, '--json'],
        { agentId: ctx.agentId }
      );
    }
  }
];

/**
 * CLI 执行器
 */
async function execTeamCLI(
  args: string[], 
  options: { agentId: string }
): Promise<any> {
  const cliPath = path.join(__dirname, '../../../team-cli/bin/team');
  const fullArgs = [...args, '--agent', options.agentId];
  
  const result = spawnSync(cliPath, fullArgs, { 
    encoding: 'utf-8',
    timeout: 5000
  });
  
  if (result.status !== 0) {
    return { error: result.stderr || 'CLI failed' };
  }
  
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { raw: result.stdout };
  }
}
```

### 15.4 工具权限矩阵

| 工具 | 主代理 (worker) | Team Leader (main) |
|------|-----------------|-------------------|
| `team_task_list` | ✅ 只看自己的 | ✅ 看全部 |
| `team_task_claim` | ✅ 自己的任务 | ❌ |
| `team_task_complete` | ✅ 自己的任务 | ❌ |
| `team_message_send` | ✅ | ✅ |
| `team_task_create` | ❌ | ✅ |
| `team_task_assign` | ❌ | ✅ |
| `team_okr_*` | ❌ | ✅ |
| `team_agent_*` | ❌ | ✅ |

### 15.5 与子代理的关系

**主代理可以调用子代理执行具体任务**：

```typescript
// 主代理内部逻辑（不是 team_* 工具）
async function executeComplexTask(taskId: string) {
  // 1. 通过 CLI 领取任务
  await execTeamCLI(['task', 'claim', taskId]);
  
  // 2. 分析任务，决定是否需要子代理
  const task = await execTeamCLI(['task', 'show', taskId]);
  
  if (needsSubagent(task)) {
    // 3. 调用子代理（通过 sessions_spawn）
    const result = await api.subagent.run({
      task: `执行任务 ${taskId}: ${task.title}`,
      model: 'openai/gpt-4o-mini',  // 弱模型省钱
      mode: 'run'
    });
    
    // 4. 汇报结果
    await execTeamCLI(['task', 'complete', taskId, '--result', result.status]);
  } else {
    // 直接执行
    // ...
  }
}
```

**关键点**：
- `team_*` 工具是主代理之间的协作接口
- `sessions_spawn` 是主代理内部的执行机制
- 两者不混淆
        },
        content: { type: 'string', description: '消息内容' },
        payload: { type: 'object', description: '附加数据' }
      },
      required: ['to', 'content']
    }
  },

  {
    name: 'team_message_read',
    description: '读取自己的消息',
    parameters: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', default: true },
        mark_read: { type: 'boolean', default: true, description: '是否标记已读' },
        limit: { type: 'number', default: 10 }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // 查询工具 - 所有 agent
  // ═══════════════════════════════════════════════════════════════

  {
    name: 'team_okr_list',
    description: '查询 OKR 列表和进度',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'completed', 'archived'] }
      }
    }
  },

  {
    name: 'team_status',
    description: '获取团队整体状态：任务统计、agent 状态、阻塞项',
    parameters: { type: 'object', properties: {} }
  },

  {
    name: 'team_agent_list',
    description: '查询 agent 列表和状态',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'idle', 'sleeping'] }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // 协调工具 - 所有 agent
  // ═══════════════════════════════════════════════════════════════

  {
    name: 'team_wake_agent',
    description: '唤醒其他 agent。用于紧急任务或协作请求。',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: '目标 agent id' },
        reason: { type: 'string', description: '唤醒原因' },
        urgent: { type: 'boolean', default: false, description: '是否紧急' }
      },
      required: ['agent', 'reason']
    }
  },

  {
    name: 'team_subscribe',
    description: '订阅事件。当事件发生时会收到通知或被唤醒。',
    parameters: {
      type: 'object',
      properties: {
        event_type: { 
          type: 'string',
          enum: ['task_assigned', 'task_completed', 'task_blocked', 'kr_progress']
        },
        filter: { type: 'object', description: '过滤条件' },
        action: { 
          type: 'string', 
          enum: ['wake', 'message'],
          description: '触发动作'
        }
      },
      required: ['event_type']
    }
  },

  {
    name: 'team_unsubscribe',
    description: '取消订阅',
    parameters: {
      type: 'object',
      properties: {
        subscription_id: { type: 'string' }
      },
      required: ['subscription_id']
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // 管理工具 - main/Wesley 专用
  // ═══════════════════════════════════════════════════════════════

  {
    name: 'team_task_create',
    description: '[Admin] 创建新任务',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        assignee: { type: 'string', description: '分配给哪个 agent' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], default: 'P2' },
        okr_ref: { type: 'string', description: '关联的 KR id' },
        due_at: { type: 'string', description: '截止时间 ISO8601' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        consumes: { type: 'array', items: { type: 'string' }, description: '依赖的任务 id' }
      },
      required: ['title', 'assignee']
    }
  },

  {
    name: 'team_task_assign',
    description: '[Admin] 重新分配任务',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        new_assignee: { type: 'string' },
        reason: { type: 'string' }
      },
      required: ['task_id', 'new_assignee']
    }
  },

  {
    name: 'team_okr_create',
    description: '[Admin] 创建 OKR',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        krs: { 
          type: 'array', 
          items: { 
            type: 'object',
            properties: {
              title: { type: 'string' },
              assignee: { type: 'string' }
            }
          }
        }
      },
      required: ['title']
    }
  },

  {
    name: 'team_agent_register',
    description: '[Admin] 注册新 agent',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'agent 唯一标识' },
        display_name: { type: 'string' },
        role: { type: 'string', enum: ['executor', 'coordinator', 'watcher'] },
        skills: { type: 'array', items: { type: 'string' } },
        heartbeat_interval_sec: { type: 'number', default: 1800 }
      },
      required: ['id', 'display_name', 'role']
    }
  },

  {
    name: 'team_agent_retire',
    description: '[Admin] 退役 agent，任务自动重新分配',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        reassign_to: { type: 'string', description: '任务转交给谁' },
        reason: { type: 'string' }
      },
      required: ['agent_id']
    }
  }
];
```

---

## 十六、分层扩展架构

### 16.1 抽象层设计

```typescript
// packages/openclaw-plugin/src/team/types.ts

/**
 * 任务存储接口 - 抽象层
 */
export interface TaskStore {
  // 查询
  getTask(id: string): Promise<Task | null>;
  listTasks(filter: TaskFilter): Promise<Task[]>;
  
  // 变更（原子操作）
  createTask(task: Omit<Task, 'id' | 'created_at'>): Promise<Task>;
  claimTask(taskId: string, agentId: string): Promise<ClaimResult>;
  completeTask(taskId: string, result: CompletionResult): Promise<void>;
  blockTask(taskId: string, reason: string): Promise<void>;
  
  // 批量操作（大规模场景必需）
  batchGetTasks(ids: string[]): Promise<Task[]>;
  batchUpdateStatus(updates: Array<{id: string; status: string}>): Promise<void>;
}

/**
 * 消息队列接口 - 抽象层
 */
export interface MessageQueue {
  send(to: string, message: Message): Promise<void>;
  receive(agentId: string, options?: ReceiveOptions): Promise<Message[]>;
  ack(messageId: string): Promise<void>;
  sendBatch(messages: Array<{to: string; message: Message}>): Promise<void>;
}

/**
 * 事件发布接口 - 抽象层
 */
export interface EventBus {
  publish(event: Event): Promise<void>;
  subscribe(subscription: Subscription): Promise<void>;
  unsubscribe(subscriptionId: string): Promise<void>;
  getSubscribers(eventType: string): Promise<Subscription[]>;
}

/**
 * 调度器接口 - 抽象层
 */
export interface Scheduler {
  schedule(task: ScheduledTask): Promise<void>;
  cancel(scheduleId: string): Promise<void>;
  getNextDue(): Promise<ScheduledTask[]>;
  acquireLock(key: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
}
```

### 16.2 实现层：三种规模

| 规模 | 存储 | 消息队列 | 事件总线 | 调度器 |
|------|------|----------|----------|--------|
| **1-10 agents** | SQLite WAL | SQLite 表 | SQLite 表 + 轮询 | 单进程 setInterval |
| **10-100 agents** | PostgreSQL | Redis Streams | Redis Pub/Sub | 多进程 + Redis 锁 |
| **100-1000 agents** | 分片 PostgreSQL | RabbitMQ | Kafka | 分布式调度器 |

### 16.3 工厂模式

```typescript
// packages/openclaw-plugin/src/team/factory.ts

export interface TeamConfig {
  scale: 'small' | 'medium' | 'large';
  
  // Small scale (SQLite)
  sqlitePath?: string;
  
  // Medium scale (PostgreSQL + Redis)
  postgresUrl?: string;
  redisUrl?: string;
  
  // Large scale (Sharded)
  shards?: Array<{ id: string; postgresUrl: string }>;
  rabbitmqUrl?: string;
  kafkaBrokers?: string[];
}

export function createTeamInfrastructure(config: TeamConfig) {
  return {
    taskStore: createTaskStore(config),
    messageQueue: createMessageQueue(config),
    eventBus: createEventBus(config),
    scheduler: createScheduler(config),
  };
}

function createTaskStore(config: TeamConfig): TaskStore {
  switch (config.scale) {
    case 'small':
      return new SQLiteTaskStore(config.sqlitePath!);
    case 'medium':
      return new PostgreSQLTaskStore(config.postgresUrl!);
    case 'large':
      return new ShardedTaskStore(config.shards!);
  }
}
```

---

## 十七、上下文恢复与任务连续性

### 17.1 问题分析

**单智能体上下文丢失**：
```
┌─────────────────────────────────────────────────────────────────────────┐
│  Session 1                │  Session 2                │  Session 3     │
│  ┌───────────────────┐   │  ┌───────────────────┐   │  ┌───────────┐  │
│  │ 计划: A → B → C   │   │  │ ??? 我在做什么？   │   │  │ ???       │  │
│  │ 执行 A ✓          │   │  │ 上下文丢失         │   │  │ 任务漂移   │  │
│  │ 执行 B (进行中)   │   │  │                    │   │  │           │  │
│  └───────────────────┘   │  └───────────────────┘   │  └───────────┘  │
│         │                      ▲                          ▲           │
│         └──────────────────────┴──────────────────────────┘           │
│                         重启后丢失进度和计划                            │
└─────────────────────────────────────────────────────────────────────────┘
```

**多智能体任务漂移**：
```
┌─────────────────────────────────────────────────────────────────────────┐
│  main 发起任务          │  repair 执行        │  verification 验证     │
│  "修复登录 bug"         │  "修了...什么bug?"  │  "验证什么？"          │
│  ┌─────────────────┐   │  ┌───────────────┐  │  ┌─────────────────┐   │
│  │ 背景: 用户反馈   │   │  │ 只看到:       │  │  │ 只看到:         │  │
│  │ 问题: 登录超时   │───▶│  │ "修复登录"   │──▶│  │ "已修复登录"   │  │
│  │ 影响: VIP用户    │   │  │               │  │  │                 │  │
│  │ 预期: < 2s      │   │  │ 缺失背景！    │  │  │ 缺失验证标准！  │  │
│  └─────────────────┘   │  └───────────────┘  │  └─────────────────┘   │
│                              ▼                       ▼                 │
│                         任务漂移开始            漂移加剧               │
└─────────────────────────────────────────────────────────────────────────┘
```

### 17.2 解决方案：三级上下文存储

借鉴 Paperclip 设计：

```sql
-- 扩展 task_runs 表
ALTER TABLE task_runs ADD COLUMN context_snapshot_json TEXT;  -- 运行时快照
ALTER TABLE task_runs ADD COLUMN session_id_before TEXT;      -- 运行前会话ID
ALTER TABLE task_runs ADD COLUMN session_id_after TEXT;       -- 运行后会话ID

-- 新增：任务会话表（任务级会话持久化）
CREATE TABLE task_sessions (
  id TEXT PRIMARY KEY,                    -- task_id 作为主键
  agent TEXT NOT NULL,
  session_display_id TEXT,                -- 显示用会话ID
  session_params_json TEXT,               -- 会话参数
  plan_json TEXT,                         -- 当前执行计划
  progress_json TEXT,                     -- 阶段进度
  decisions_json TEXT,                    -- 已做出的决策
  last_run_id INTEGER,                    -- 最后一次运行ID
  last_summary TEXT,                      -- 最后一次运行摘要
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 新增：任务上下文表（任务级背景信息）
CREATE TABLE task_contexts (
  task_id TEXT PRIMARY KEY REFERENCES team_tasks(id),
  background_json TEXT,                   -- 任务背景（为什么做、影响范围）
  requirements_json TEXT,                 -- 明确的需求和验收标准
  constraints_json TEXT,                  -- 约束条件
  decisions_json TEXT,                    -- 已做出的关键决策
  artifacts_json TEXT,                    -- 产出物清单和位置
  handoff_count INTEGER DEFAULT 0,        -- 交接次数
  last_handoff_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 新增：执行锁表（防止并发冲突）
CREATE TABLE execution_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,              -- task/issue
  entity_id TEXT NOT NULL,
  locked_by TEXT NOT NULL,
  locked_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,                        -- 锁过期时间
  UNIQUE(entity_type, entity_id)
);
```

### 17.3 context_snapshot 内容定义

```typescript
interface ContextSnapshot {
  // === 任务标识 ===
  taskId: string;
  okrRef: string;
  
  // === 唤醒信息 ===
  wakeReason: string;                     // 'task_assigned' | 'timeout' | 'blocked_resolved'
  wakeSource: string;                     // 'dispatch' | 'agent' | 'schedule'
  
  // === 恢复信息 ===
  resumeFromRunId?: number;               // 从哪个 run 恢复
  resumeSessionDisplayId?: string;        // 会话显示ID
  
  // === 计划状态 ===
  currentPlan?: PlanSnapshot;
  completedSteps?: string[];              // 已完成的步骤
  currentStep?: string;                   // 当前步骤
  pendingSteps?: string[];                // 待完成步骤
  
  // === 关键发现 ===
  findings?: Finding[];                   // 执行过程中的发现
  risks?: string[];                       // 发现的风险
  
  // === 工作区状态 ===
  workspaceInfo?: {
    cwd: string;
    branch?: string;
    lastCommit?: string;
    modifiedFiles?: string[];
  };
}

interface PlanSnapshot {
  goal: string;                           // 最终目标
  steps: PlanStep[];
  createdAt: string;
  updatedAt: string;
}

interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  result?: string;
}

interface Finding {
  type: 'info' | 'warning' | 'error' | 'decision';
  content: string;
  timestamp: string;
}
```

### 17.4 Session Handoff 机制

当会话需要轮换（超过阈值或主动重启）时：

```typescript
interface SessionHandoff {
  previousSessionId: string;
  rotationReason: string;                 // 'token_limit' | 'time_limit' | 'manual'
  
  // 关键摘要
  taskSummary: string;                    // 任务当前状态的一句话总结
  completedWork: string[];                // 已完成的工作
  currentWork: string;                    // 正在进行的工作
  nextSteps: string[];                    // 下一步计划
  
  // 关键上下文
  criticalContext: string;                // 必须保留的关键信息
  decisions: Decision[];                  // 已做出的决策
  
  // 指针
  lastRunId: number;
  artifacts: ArtifactRef[];               // 产出物引用
}

// Handoff Markdown 模板
const HANDOFF_TEMPLATE = `
## Session Handoff

**Previous Session**: {previousSessionId}
**Rotation Reason**: {rotationReason}

### Task Summary
{taskSummary}

### Completed Work
{completedWork}

### Current Work
{currentWork}

### Next Steps
{nextSteps}

### Critical Context (MUST READ)
{criticalContext}

### Decisions Made
{decisions}

---
*Continue from current task state. Rebuild only the minimum context you need.*
`;
```

### 17.5 任务交接协议

**交接时必须传递的信息**：

```typescript
interface TaskHandoff {
  // === 必传字段（Required）===
  taskId: string;
  title: string;
  
  // 背景
  background: {
    why: string;                          // 为什么做这个任务
    impact: string;                       // 影响范围
    deadline?: string;                    // 截止时间
  };
  
  // 需求
  requirements: {
    must: string[];                       // 必须满足的条件
    should: string[];                     // 应该满足的条件
    wont: string[];                       // 不做的范围
  };
  
  // 验收标准
  acceptanceCriteria: string[];
  
  // === 可选字段（Optional）===
  
  // 已完成的工作
  completedWork?: {
    summary: string;
    details: string[];
    artifacts: ArtifactRef[];
  };
  
  // 关键决策
  decisions?: Decision[];
  
  // 已知风险
  risks?: string[];
  
  // 相关资源
  resources?: {
    files: string[];
    links: string[];
    contacts: string[];
  };
}

// 交接消息模板
const HANDOFF_MESSAGE_TEMPLATE = `
## Task Handoff: {taskId}

**From**: {fromAgent}
**To**: {toAgent}
**Reason**: {reason}

### Background
{background}

### Requirements
**Must**:
{requirements.must}

**Should**:
{requirements.should}

**Won't**:
{requirements.wont}

### Acceptance Criteria
{acceptanceCriteria}

### Completed Work
{completedWork}

### Decisions Made
{decisions}

### Known Risks
{risks}

---
*Please read this carefully before starting. Ask if anything is unclear.*
`;
```

### 17.6 任务漂移缓解机制

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Task Drift Prevention                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Layer 1: 任务上下文表 (task_contexts)                            │   │
│  │ - 存储不可丢失的核心信息                                         │   │
│  │ - 每次交接时必须同步更新                                         │   │
│  │ - 接收方必须确认已阅读                                           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Layer 2: 会话快照 (context_snapshot)                             │   │
│  │ - 每次运行结束时保存                                             │   │
│  │ - 包含计划进度和关键发现                                         │   │
│  │ - 下次恢复时自动加载                                             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Layer 3: 交接协议 (handoff protocol)                             │   │
│  │ - 结构化的交接消息                                               │   │
│  │ - 必传字段检查                                                   │   │
│  │ - 接收确认机制                                                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Layer 4: 漂移检测 (drift detection)                              │   │
│  │ - 定期对比任务输出与原始需求                                     │   │
│  │ - 交接超过 N 次时触发检查                                        │   │
│  │ - 发现偏差时告警                                                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 17.7 漂移检测实现

```typescript
// 新增调度任务：漂移检测
{
  id: 'drift-detection',
  schedule_expr: 'every:21600s',          // 每 6 小时
  action_type: 'drift_check',
  action_config: {
    maxHandoffs: 3,                       // 交接超过 3 次触发检查
    checkCompleted: true                  // 检查已完成任务
  }
}

// 漂移检测逻辑
async function detectDrift(taskId: string): Promise<DriftReport | null> {
  const task = await taskStore.getTask(taskId);
  const context = await taskStore.getTaskContext(taskId);
  
  // 1. 检查交接次数
  if (context.handoffCount < 3) return null;
  
  // 2. 获取原始需求
  const originalRequirements = context.requirements_json;
  
  // 3. 获取当前执行结果
  const currentOutput = task.run_record_json?.output;
  
  // 4. 对比分析（可调用 LLM）
  const driftScore = await analyzeDrift({
    requirements: originalRequirements,
    output: currentOutput,
    decisions: context.decisions_json
  });
  
  if (driftScore > 0.3) {
    return {
      taskId,
      driftScore,
      originalRequirements,
      currentOutput,
      recommendations: ['建议 Wesley 介入审核', '重新对齐需求']
    };
  }
  
  return null;
}
```

---

## 十八、智能体工作循环设计

### 18.1 单智能体工作循环

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Single Agent Work Loop                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│  │ 1. LOAD  │───▶│ 2. PLAN  │───▶│3. EXECUTE │───▶│4. VERIFY │──┐      │
│  │ Context  │    │          │    │          │    │          │  │      │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘  │      │
│       ▲                                                │         │      │
│       │                                                ▼         │      │
│       │         ┌──────────┐    ┌──────────┐    ┌──────────┐  │      │
│       │         │ 6. SAVE  │◀───│5. ADJUST │◀───│  Result  │  │      │
│       │         │ Context  │    │  Plan    │    │          │  │      │
│       │         └──────────┘    └──────────┘    └──────────┘  │      │
│       │              │                                         │      │
│       └──────────────┴─────────────────────────────────────────┘      │
│                                                                          │
│  1. LOAD:  加载 task_contexts + task_sessions + 最近 context_snapshot  │
│  2. PLAN:  基于当前状态制定/调整计划                                    │
│  3. EXECUTE: 执行当前步骤                                               │
│  4. VERIFY: 验证步骤结果                                                │
│  5. ADJUST: 根据验证结果调整计划                                        │
│  6. SAVE:  保存 context_snapshot + 更新 task_sessions                  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 18.2 心跳 Prompt 增强

```markdown
# Agent Heartbeat v2

你是 {agent_name}。

## 启动检查

1. **加载上下文**
   - 调用 `team_task_list(status=locked, assignee={agent_name})`
   - 如果有 locked 任务，调用 `team_context_load(task_id)` 加载完整上下文

2. **恢复或开始**
   - 如果有 context_snapshot：
     - 读取 completedSteps, currentStep, pendingSteps
     - 读取 findings 和 decisions
     - 继续执行，不要从头开始
   - 如果没有 context_snapshot：
     - 调用 `team_task_claim(task_id)` 领取任务
     - 开始新任务

## 执行循环

3. **执行当前步骤**
   - 执行 context_snapshot 中的 currentStep
   - 如果需要，更新 context_snapshot

4. **验证结果**
   - 检查步骤是否完成
   - 记录 findings

5. **更新计划**
   - 如果步骤完成：标记 done，设置下一个 currentStep
   - 如果步骤阻塞：调用 `team_task_block`
   - 如果发现新问题：更新 pendingSteps

6. **保存进度**
   - 调用 `team_context_save(task_id, snapshot)`
   - 包含：completedSteps, currentStep, pendingSteps, findings

7. **检查是否完成**
   - 如果所有步骤 done：调用 `team_task_complete`
   - 否则：保留 locked 状态，下次继续

## 无任务时

- 调用 `team_task_list(status=backlog)` 领取新任务
- 无 backlog：调用 `team_okr_list` 寻找可认领的 KR
- 全部无：回复 "{agent_name} idle"
```

### 18.3 新增工具

```typescript
// 上下文加载
{
  name: 'team_context_load',
  description: '加载任务的完整上下文：背景、需求、进度、决策',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string' }
    },
    required: ['task_id']
  }
}

// 上下文保存
{
  name: 'team_context_save',
  description: '保存当前执行进度和关键发现',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      completed_steps: { type: 'array', items: { type: 'string' } },
      current_step: { type: 'string' },
      pending_steps: { type: 'array', items: { type: 'string' } },
      findings: { 
        type: 'array', 
        items: { 
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['info', 'warning', 'error', 'decision'] },
            content: { type: 'string' }
          }
        }
      }
    },
    required: ['task_id']
  }
}

// 任务交接
{
  name: 'team_task_handoff',
  description: '[Admin] 将任务交接给其他 agent，必须填写完整上下文',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      to_agent: { type: 'string' },
      reason: { type: 'string' },
      handoff_context: {
        type: 'object',
        properties: {
          completed_work: { type: 'string' },
          current_work: { type: 'string' },
          next_steps: { type: 'array', items: { type: 'string' } },
          critical_context: { type: 'string' },
          decisions: { type: 'array' }
        }
      }
    },
    required: ['task_id', 'to_agent', 'reason', 'handoff_context']
  }
}
```

---

## 十九、实施优先级调整

### 19.1 Phase 1 核心功能（必须）

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | task_contexts 表 | 存储任务背景、需求、验收标准 |
| P0 | context_snapshot | 每次运行结束时保存进度 |
| P0 | team_context_load/save | 上下文加载/保存工具 |
| P0 | 心跳 Prompt v2 | 支持上下文恢复 |

### 19.2 Phase 2 连续性保障

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P1 | task_sessions 表 | 任务级会话持久化 |
| P1 | handoff 协议 | 结构化交接消息 |
| P1 | team_task_handoff | 交接工具 |

### 19.3 Phase 3 漂移检测

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P2 | drift-detection 调度 | 定期检查任务漂移 |
| P2 | 漂移告警 | 发现偏差时通知 main |

---

## 二十、身份管理与组织架构（借鉴 Paperclip）

### 20.1 问题：当前身份管理的痛点

| 现状 | 问题 |
|------|------|
| 身份信息分散在多个 MD 文件 | 难以统一更新和维护 |
| 无结构化组织架构 | 汇报关系不清晰 |
| 无状态管理 | 不知道谁在运行、谁在休息 |
| 无权限控制 | 任何人都可以分配任何任务 |

### 20.2 Paperclip 的设计借鉴

**核心概念**：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Paperclip-inspired Identity Model                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  组织架构（树形结构）:                                                    │
│                                                                          │
│                     CEO (麻辣进化者)                                     │
│                         │                                                │
│          ┌──────────────┼──────────────┐                                │
│          │              │              │                                │
│        PM/产品         CTO/技术       运营                            │
│        (Bridge)       (麻辣)         (Watcher)                        │
│          │              │                                              │
│     ┌────┴────┐    ┌────┴────┐                                        │
│     │         │    │         │                                        │
│   设计师    测试   后端      前端                                      │
│                                                                          │
│  每个节点 = 主代理 (独立工作空间)                                        │
│  边 = reports_to 关系                                                   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 20.3 Agent 状态机

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Agent Status Lifecycle                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│                    ┌──────────────┐                                     │
│                    │    pending   │ ← 新注册，等待审批                   │
│                    └──────┬───────┘                                     │
│                           │ 审批通过                                    │
│                           ▼                                             │
│    ┌─────────────────────────────────────────────┐                     │
│    │                                             │                     │
│    │  ┌───────┐    任务开始    ┌─────────┐      │                     │
│    │  │ idle  │──────────────▶│ running │      │                     │
│    │  └───────┘◀───────────────└─────────┘      │                     │
│    │      │        任务完成/失败                   │                     │
│    │      │                                     │                     │
│    │      │ 暂停 (手动/预算/系统)                 │                     │
│    │      ▼                                     │                     │
│    │  ┌─────────┐                               │                     │
│    │  │ paused  │───────────────────────────────┘                     │
│    │  └─────────┘     恢复                                       │
│    │                                             │                     │
│    └─────────────────────────────────────────────┘                     │
│                           │                                             │
│                           │ 终止（不可逆）                              │
│                           ▼                                             │
│                    ┌──────────────┐                                     │
│                    │  terminated  │                                     │
│                    └──────────────┘                                     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**状态定义**：

| 状态 | 含义 | 可接收任务 | 可执行任务 |
|------|------|-----------|-----------|
| `pending` | 新注册，等待审批 | ❌ | ❌ |
| `idle` | 空闲，可工作 | ✅ | ✅ |
| `running` | 执行任务中 | ⚠️ 队列排队 | ✅ |
| `paused` | 暂停（手动/预算/系统） | ❌ | ❌ |
| `terminated` | 已终止（不可逆） | ❌ | ❌ |

### 20.4 CLI 身份管理命令

```bash
# === 主代理注册 ===
team agent register \
  --id repair \
  --display-name "Repair Agent" \
  --role engineer \
  --reports-to main \
  --skills "debugging,testing"

# === 状态管理 ===
team agent list                      # 列出所有主代理
team agent show repair               # 查看详情
team agent pause repair --reason "budget"  # 暂停
team agent resume repair             # 恢复
team agent terminate repair          # 终止（不可逆）

# === 组织架构 ===
team org tree                        # 显示组织树
team org chain repair                # 显示汇报链
team org chart --style circuit       # 生成 SVG 组织图

# === 权限管理 ===
team agent grant repair --permission "can_create_agents"
team agent revoke repair --permission "can_create_agents"
```

### 20.5 组织架构 CLI 输出

**树形视图**：

```
$ team org tree

麻辣进化者 (ceo) [idle]
├── Bridge (pm) [idle]
│   ├── Designer-A (designer) [running]
│   └── QA-Team (qa) [paused]
├── 麻辣 (cto) [idle]
│   ├── Backend-Lead (engineer) [idle]
│   └── Frontend-Dev (engineer) [running]
└── Watcher (operations) [idle]
```

**汇报链**：

```
$ team org chain repair

Backend-Dev (engineer)
  ↑ reports to
Backend-Lead (engineer)
  ↑ reports to
麻辣 (cto)
  ↑ reports to
麻辣进化者 (ceo)
```

### 20.6 与任务分配的关系

**任务分配时考虑组织架构**：

```typescript
// 分配任务时，自动推荐合适的 agent
async function recommendAssignee(task: Task): Promise<string[]> {
  // 1. 根据任务类型筛选角色
  const role = inferRoleFromTask(task);  // bug fix → engineer
  
  // 2. 找到该角色下空闲的 agent
  const candidates = await db.query(`
    SELECT id, name, status, 
           (SELECT COUNT(*) FROM team_tasks WHERE assignee = agents.id AND status = 'locked') as active_tasks
    FROM agents
    WHERE role = ? AND status = 'idle'
    ORDER BY active_tasks ASC
  `, [role]);
  
  // 3. 考虑汇报关系（优先分配给同一团队）
  // ...
  
  return candidates.map(c => c.id);
}
```

**权限检查**：

```typescript
// 只有上级可以给下属分配任务
async function canAssignTask(
  assignerId: string,
  assigneeId: string
): Promise<boolean> {
  // CEO 可以分配给任何人
  if (await isCEO(assignerId)) return true;
  
  // 检查 assignee 是否在 assigner 的下属链中
  const chain = await getSubordinates(assignerId);
  return chain.includes(assigneeId);
}
```

### 20.7 自注册流程（可选）

**Paperclip Tier 3 自注册协议**：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Agent Self-Registration Flow                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. 管理员生成邀请链接                                                   │
│     $ team invite create --role engineer --expires 7d                   │
│     → https://team.example/invite/abc123                                │
│                                                                          │
│  2. 新 Agent 访问邀请链接，获取入职文档                                  │
│     GET /invite/abc123                                                  │
│     → { company: "...", role: "engineer", permissions: [...] }          │
│                                                                          │
│  3. Agent 提交注册信息                                                   │
│     POST /agents/register                                               │
│     { name: "Backend-Dev", capabilities: [...], webhook_url: "..." }    │
│                                                                          │
│  4. 进入 pending 状态，等待审批                                          │
│                                                                          │
│  5. 审批者设置 reports_to、budget、permissions                           │
│                                                                          │
│  6. 审批通过，Agent 变为 idle 状态                                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 20.8 迁移方案：从 MD 到 DB

**当前状态**：
```
workspace-main/SOUL.md      → 身份信息
workspace-repair/SOUL.md    → 身份信息
workspace-pm/SOUL.md        → 身份信息
```

**迁移步骤**：

```bash
# 1. 解析现有 MD 文件，提取身份信息
team migrate extract-identity --workspace workspace-main
team migrate extract-identity --workspace workspace-repair

# 2. 生成注册 SQL
team migrate generate-sql --output migrate-agents.sql

# 3. 执行迁移
team migrate run --dry-run  # 先预览
team migrate run            # 实际执行

# 4. 建立汇报关系
team agent set-reports-to repair --manager main
team agent set-reports-to pm --manager main
```

**保留 SOUL.md 作为本地记忆**：
- SOUL.md 不再存储身份信息
- 身份信息统一在 team.db 管理
- SOUL.md 保留个人记忆、偏好、经验教训

---

## 二十一、信息共享与渐进加载

### 20.1 现有 PD 框架的渐进加载机制

PD 框架已实现完善的渐进加载机制，核心设计：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    PD Context Injection Pipeline                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ ContextInjectionConfig 配置                                      │   │
│  │ - thinkingOs: boolean        (思维模型)                          │   │
│  │ - projectFocus: 'off'|'summary'|'full'  (项目焦点)               │   │
│  │ - reflectionLog: boolean     (反思日志)                          │   │
│  │ - trustScore: boolean        (信任评分)                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│                              ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 注入顺序（优先级从低到高）                                        │   │
│  │ 1. <project_context>    ← CURRENT_FOCUS.md 内容                  │   │
│  │ 2. <working_memory>     ← 工作记忆快照（文件输出、任务状态）      │   │
│  │ 3. <reflection_log>     ← 反思日志                               │   │
│  │ 4. <thinking_os>        ← 思维模型                               │   │
│  │ 5. principles           ← 进化原则（最高优先级）                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 20.2 CURRENT_FOCUS 渐进加载模式

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `off` | 不注入 | 最小上下文模式，节省 token |
| `summary` | 智能提取关键章节（~30行） | 日常任务，快速对齐 |
| `full` | 当前版本 + 最近 3 个历史版本 | 需要完整上下文的复杂任务 |

**Summary 模式智能提取**：
```typescript
// 按优先级提取章节
const SECTION_PRIORITY = [
  '🎯 当前焦点',      // 最高优先级
  '🏆 里程碑',
  '🧠 Working Memory',
  '📊 进度',
  '⚠️ 风险',
  '💡 下一步'
];

// 截断保护
const MAX_SUMMARY_LINES = 30;
const TRUNCATION_HINT = '...[truncated, see CURRENT_FOCUS.md for full context]';
```

### 20.3 Working Memory 机制

**核心数据结构**：
```typescript
interface WorkingMemorySnapshot {
  lastUpdated: string;
  
  // 文件输出记录（核心）
  artifacts: FileArtifact[];
  
  // 当前任务
  currentTask?: {
    description: string;
    status: 'in_progress' | 'blocked' | 'reviewing' | 'completed';
    progress: number;
  };
  
  // 活动问题
  activeProblems: Array<{
    problem: string;
    approach?: string;
  }>;
  
  // 下一步行动
  nextActions: string[];
}

interface FileArtifact {
  path: string;           // 完整文件路径
  action: 'created' | 'modified' | 'deleted';
  description: string;    // 简短描述
}
```

**独立注入**：
```xml
<working_memory>
## 🧠 Working Memory (Last Session)

**Last Updated**: 2026-03-29 14:30

### 📁 File Artifacts
- `docs/design/team-orchestration-system-v3.md` (created) - 团队编排系统设计
- `src/team/orchestration-service.ts` (modified) - 添加调度器实现

### 📋 Current Task
- **Description**: 设计团队编排系统
- **Status**: in_progress
- **Progress**: 60%

### ⚠️ Active Problems
- cron 任务超时问题待解决
- Feishu 投递失败需排查

### 📌 Next Actions
- [ ] 实现调度器核心逻辑
- [ ] 添加订阅机制
- [ ] 编写单元测试
</working_memory>
```

---

## 二十二、团队编排与 CURRENT_FOCUS 整合

### 21.1 整合策略

**核心理念**：团队编排系统复用 PD 框架的渐进加载机制，无需重复造轮子。

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Team Orchestration + CURRENT_FOCUS                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 单智能体视角（现有 PD 机制）                                      │   │
│  │                                                                  │   │
│  │ CURRENT_FOCUS.md (workspace-local)                               │   │
│  │ ├─ OKR 里程碑                                                    │   │
│  │ ├─ 当前任务列表                                                  │   │
│  │ ├─ Working Memory                                                │   │
│  │ └─ 下一步行动                                                    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│                              │ 整合                                     │
│                              ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 多智能体视角（团队编排扩展）                                      │   │
│  │                                                                  │   │
│  │ team_tasks (SQLite)  ←──同步──→  CURRENT_FOCUS.md               │   │
│  │ ├─ 任务分配                                      │   │
│  │ ├─ 任务状态                                                      │   │
│  │ ├─ 任务上下文 (task_contexts)                                    │   │
│  │ └─ 交接历史                                                      │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 21.2 双向合并设计

**核心原则**：
- CURRENT_FOCUS 是智能体的主工作视图（保留原有灵活性）
- SQLite 是团队协作数据源（可选）
- **双向合并**：两边的内容共存，通过标记区分来源

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Dual-Source Task View                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   用户直接安排的任务          团队编排分配的任务                          │
│         │                          │                                     │
│         ▼                          ▼                                     │
│  ┌──────────────┐           ┌──────────────┐                            │
│  │ CURRENT_FOCUS│           │   SQLite     │                            │
│  │ (手动编辑)   │           │ (团队协作)   │                            │
│  │              │           │              │                            │
│  │ [local] 任务 │           │ [team] 任务  │                            │
│  └──────┬───────┘           └──────┬───────┘                            │
│         │                          │                                     │
│         └──────────┬───────────────┘                                     │
│                    ▼                                                     │
│         ┌─────────────────────┐                                          │
│         │   合并视图（注入）   │                                          │
│         │                     │                                          │
│         │ 📋 任务列表          │                                          │
│         │ ├─ [team] TASK-001  │ ← 来自团队                               │
│         │ ├─ [team] TASK-002  │                                          │
│         │ └─ [local] 修复bug  │ ← 用户手动添加                            │
│         └─────────────────────┘                                          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**合并策略**：

```typescript
interface TaskWithSource {
  id: string;
  title: string;
  source: 'team' | 'local';  // 来源标记
  priority?: string;
  status?: string;
}

/**
 * 合并 CURRENT_FOCUS 和 SQLite 的任务
 * - [team] 标记：来自团队编排系统
 * - [local] 标记：用户手动添加
 */
async function mergeTaskSources(
  workspaceDir: string,
  agentId: string
): Promise<TaskWithSource[]> {
  const tasks: TaskWithSource[] = [];
  
  // 1. 从 SQLite 加载团队分配的任务
  const teamTasks = await taskStore.listTasks({
    assignee: agentId,
    status: ['backlog', 'locked', 'blocked']
  });
  for (const t of teamTasks) {
    tasks.push({ ...t, source: 'team' });
  }
  
  // 2. 从 CURRENT_FOCUS 解析本地任务（用户手动添加）
  const focusPath = path.join(workspaceDir, 'memory/okr/CURRENT_FOCUS.md');
  const focusContent = fs.readFileSync(focusPath, 'utf8');
  const localTasks = parseLocalTasks(focusContent);  // 解析无 [team] 标记的任务
  for (const t of localTasks) {
    tasks.push({ ...t, source: 'local' });
  }
  
  // 3. 按优先级排序（P0 > P1 > P2 > P3）
  return sortByPriority(tasks);
}

/**
 * 解析 CURRENT_FOCUS 中的本地任务
 * 本地任务：没有 [team] 标记的任务项
 */
function parseLocalTasks(content: string): TaskWithSource[] {
  const lines = content.split('\n');
  const tasks: TaskWithSource[] = [];
  
  for (const line of lines) {
    // 匹配任务项：- [ ] 或 - [x] 开头
    const match = line.match(/^- \[([ x])\] (.+)$/);
    if (match) {
      const done = match[1] === 'x';
      const text = match[2];
      
      // 跳过已标记为 [team] 的任务
      if (text.includes('[team]')) continue;
      
      tasks.push({
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: text,
        source: 'local',
        status: done ? 'done' : 'backlog'
      });
    }
  }
  
  return tasks;
}
```

### 21.3 CURRENT_FOCUS.md 混合模板

```markdown
# 🎯 CURRENT_FOCUS

> **版本**: v1 | **更新**: 2026-03-29

## 📋 当前任务

### 🔒 进行中

- [team] TASK-001: 实现调度器核心 (P1)
  - 背景：替代现有 cron 任务
  - `team_context_load('TASK-001')` 查看完整上下文
  
- [ ] 修复登录页样式问题 ← 用户手动添加，无 [team] 标记

### 📥 待办

- [team] TASK-002: 添加订阅机制 (P2)
- [ ] 整理项目文档 ← 本地任务

### ⚠️ 阻塞

- [team] TASK-003: 集成测试 - 等待 TASK-001

---
**说明**：
- `[team]` 标记的任务来自团队编排系统，通过 `team_*` 工具管理
- 无标记的任务是本地任务，可直接编辑此文件
```

### 21.4 状态同步规则

| 操作 | CURRENT_FOCUS | SQLite | 说明 |
|------|---------------|--------|------|
| 用户手动添加任务 | ✅ 直接编辑 | ❌ 不同步 | 本地任务，不影响团队 |
| team_task_create | ✅ 同步写入 | ✅ 写入 | 团队任务，两边都有 |
| team_task_complete | ✅ 同步更新 | ✅ 更新 | 状态同步到 CURRENT_FOCUS |
| 用户标记本地任务完成 | ✅ 更新 | ❌ 不影响 | 本地任务不影响团队 |

**关键代码**：

```typescript
/**
 * 团队任务完成时，同步更新 CURRENT_FOCUS
 */
async function onTeamTaskComplete(
  taskId: string,
  result: CompletionResult
): Promise<void> {
  // 1. 更新 SQLite
  await taskStore.completeTask(taskId, result);
  
  // 2. 同步到 CURRENT_FOCUS（找到对应行，标记完成）
  const focusPath = getFocusPath();
  let content = fs.readFileSync(focusPath, 'utf8');
  
  // 找到 [team] TASK-xxx 的行，标记为 [x]
  const regex = new RegExp(`^(\\s*)- \\[ \\] \\[team\\] ${taskId}:`, 'm');
  content = content.replace(regex, '$1- [x] [team] ${taskId}:');
  
  fs.writeFileSync(focusPath, content);
}
```

### 21.5 单智能体场景兼容

**场景**：只有一个智能体运行在 PD 框架，没有团队协作需求。

**行为**：
- SQLite 团队编排系统**不启动**（无团队任务）
- CURRENT_FOCUS 保持原有行为，用户直接编辑
- 智能体只看到 `[local]` 本地任务
- `/pd-focus` 等命令正常工作

**检测逻辑**：

```typescript
/**
 * 判断是否启用团队编排模式
 */
function isTeamOrchestrationEnabled(workspaceDir: string): boolean {
  // 1. 检查 team.db 是否存在
  const dbPath = path.join(workspaceDir, '.team', 'team.db');
  if (!fs.existsSync(dbPath)) return false;
  
  // 2. 检查是否有注册的 agent（除了自己）
  const agents = teamStore.listAgents();
  if (agents.length <= 1) return false;  // 只有自己，不需要团队模式
  
  return true;
}
```

### 21.3 CURRENT_FOCUS.md 扩展模板

```markdown
# 🎯 CURRENT_FOCUS

> **版本**: v1 | **更新**: 2026-03-29

## 🏆 里程碑

- [ ] M1: 团队编排系统 v1（目标：2026-04-15）
  - [x] 设计文档完成
  - [ ] SQLite 数据库实现
  - [ ] 调度器实现
  - [ ] LLM 工具实现

## 📋 当前任务（来自团队编排系统）

### 🔒 进行中 (locked)

| ID | 标题 | 优先级 | 上下文 |
|----|------|--------|--------|
| TASK-001 | 实现调度器核心 | P1 | [加载上下文](#task-001-context) |

### 📥 待领取 (backlog)

| ID | 标题 | 优先级 | 来源 |
|----|------|--------|------|
| TASK-002 | 添加订阅机制 | P2 | OKR-KR1 |

### ⚠️ 阻塞 (blocked)

| ID | 标题 | 阻塞原因 |
|----|------|----------|
| TASK-003 | 集成测试 | 等待 TASK-001 完成 |

## 🧠 Working Memory

**Last Updated**: 2026-03-29 14:30

### 📁 File Artifacts
- `docs/design/team-orchestration-system-v3.md` (created)

### 📌 Next Actions
- [ ] 实现 `team-database.ts`
- [ ] 实现 `team-orchestration-service.ts`

## 📊 任务上下文摘要

### TASK-001 上下文 {#task-001-context}

**背景**: 替代现有 28 个 cron 任务，统一调度
**需求**: 支持 heartbeat/interval/schedule 三种触发方式
**验收标准**: 所有现有 cron 任务迁移完成
**关键决策**: 使用 SQLite WAL 模式支持并发

---
*提示: 完整上下文可通过 `team_context_load(task_id)` 加载*
```

### 21.4 双向数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Data Flow Architecture                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────────┐                              ┌─────────────────┐ │
│  │ Team Orchestration│                              │ PD Framework    │ │
│  │ (SQLite)          │                              │ (CURRENT_FOCUS) │ │
│  ├───────────────────┤                              ├─────────────────┤ │
│  │ team_tasks        │───── 同步 ────────────────▶│ 任务列表章节    │ │
│  │ task_contexts     │───── 同步 ────────────────▶│ 上下文摘要      │ │
│  │ task_sessions     │                              │                 │ │
│  └───────────────────┘                              └─────────────────┘ │
│          │                                                    ▲          │
│          │                                                    │          │
│          ▼                                                    │          │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                         同步策略                                   │ │
│  │                                                                   │ │
│  │ 触发时机：                                                         │ │
│  │ 1. 任务状态变化时 (claim/complete/block)                           │ │
│  │ 2. 心跳开始时 (heartbeat)                                          │ │
│  │ 3. 任务交接时 (handoff)                                            │ │
│  │                                                                   │ │
│  │ 同步方向：SQLite → CURRENT_FOCUS.md（单向）                        │ │
│  │   - SQLite 是唯一数据源                                           │ │
│  │   - CURRENT_FOCUS.md 是只读视图                                   │ │
│  │   - 修改任务只能通过 team_* 工具                                   │ │
│  │                                                                   │ │
│  │ 内容策略：                                                         │ │
│  │   - 默认注入 summary 模式（~30行）                                 │ │
│  │   - 需要完整上下文时调用 team_context_load()                       │ │
│  │   - 历史版本自动归档到 .history/                                   │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 21.5 工具整合

**现有 PD 工具（保持不变）**：
- `/pd-focus status` - 查看 CURRENT_FOCUS 状态
- `/pd-focus compress` - 压缩 CURRENT_FOCUS
- `/pd-focus history` - 查看历史版本
- `/pd-context` - 控制上下文注入配置

**新增团队编排工具**：
- `team_context_load(task_id)` - 加载完整任务上下文
- `team_context_save(task_id, snapshot)` - 保存执行进度
- `team_task_handoff(task_id, to_agent, context)` - 任务交接

**工作流整合示例**：

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Agent 心跳工作流（整合后）                                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. 心跳开始                                                             │
│     ├─ PD 自动注入 CURRENT_FOCUS (summary 模式)                          │
│     │   └─ 包含：任务列表摘要 + 上下文摘要                               │
│     │                                                                    │
│  2. 任务识别                                                             │
│     ├─ 从 CURRENT_FOCUS 读取 locked 任务                                 │
│     ├─ 如需详细上下文：team_context_load(task_id)                        │
│     │                                                                    │
│  3. 任务执行                                                             │
│     ├─ 执行步骤                                                          │
│     ├─ 定期保存：team_context_save(task_id, progress)                    │
│     │                                                                    │
│  4. 任务完成/阻塞                                                        │
│     ├─ team_task_complete() 或 team_task_block()                        │
│     ├─ SQLite 更新 → 自动同步到 CURRENT_FOCUS                            │
│     │                                                                    │
│  5. 心跳结束                                                             │
│     └─ Working Memory 自动保存到 CURRENT_FOCUS                           │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 二十三、主代理调度机制

### 22.1 核心概念澄清

**主代理 vs 子代理（关键区分）**：

| 概念 | 定义 | 特征 |
|------|------|------|
| **主代理** | 团队成员 | 独立工作空间、独立记忆、独立心跳、独立 AGENTS.md |
| **子代理** | 执行单元 | 临时创建、无独立空间、由主代理调用 |

**协作方式**：
- 主代理之间：通过 CLI 读写 team.db
- 主代理内部：可调用子代理执行复杂任务

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    主代理团队协作架构                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │
│  │ workspace-main  │  │ workspace-repair│  │ workspace-pm    │          │
│  │ 主代理: 麻辣    │  │ 主代理: Repair  │  │ 主代理: Bridge  │          │
│  │                 │  │                 │  │                 │          │
│  │ 心跳 (30min)    │  │ 心跳 (30min)    │  │ 心跳 (30min)    │          │
│  │ AGENTS.md       │  │ AGENTS.md       │  │ AGENTS.md       │          │
│  │ HEARTBEAT.md    │  │ HEARTBEAT.md    │  │ HEARTBEAT.md    │          │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘          │
│           │                    │                    │                   │
│           │    心跳时调用 CLI  │                    │                   │
│           └────────────────────┼────────────────────┘                   │
│                                ▼                                        │
│              ┌─────────────────────────────────┐                        │
│              │    team CLI (独立小程序)         │                        │
│              │    team task list               │                        │
│              │    team task claim TASK-xxx     │                        │
│              └────────────────┬────────────────┘                        │
│                               │                                         │
│                               ▼                                         │
│              ┌─────────────────────────────────┐                        │
│              │     SQLite: team.db             │                        │
│              │     (团队协作数据源)             │                        │
│              └─────────────────────────────────┘                        │
│                                                                          │
│  ══════════════════════════════════════════════════════════════════════ │
│                                                                          │
│  主代理内部（可选）:                                                      │
│                                                                          │
│  ┌─────────────────┐                                                     │
│  │ 主代理: Repair   │                                                     │
│  │                 │                                                     │
│  │ 复杂任务时:     │──sessions_spawn──▶ 子代理 (临时)                    │
│  │                 │                    - 无独立空间                     │
│  │                 │                    - 执行完毕后销毁                 │
│  └─────────────────┘                                                     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 22.2 主代理心跳工作流

**每个主代理有独立的心跳**：

```typescript
// 每个主代理的 HEARTBEAT.md（位于各自工作空间）

# 心跳任务

## 每次心跳执行

1. **检查团队任务**
   ```bash
   team task list --assignee $AGENT_ID --status backlog,locked
   ```
   
2. **检查未读消息**
   ```bash
   team msg list --unread
   ```

3. **如果有任务**:
   - 读取任务详情
   - 决定是否执行
   - 执行后完成

4. **如果无任务**: 回复 `HEARTBEAT_OK`
```

### 22.3 心跳触发机制

**方式：复用 OpenClaw 现有心跳**

```json
// openclaw.json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "intervalSeconds": 1800,
        "isolatedSession": true,
        "model": "openai/gpt-4o-mini"
      }
    }
  }
}
```

**心跳流程**：

```
OpenClaw Gateway
    │
    │ 每 30 分钟
    ▼
┌─────────────────────────────────────┐
│ 主代理心跳 (isolated session)        │
│                                     │
│ 1. 读取 HEARTBEAT.md                │
│ 2. 执行 team task list              │
│ 3. 如果有任务:                       │
│    - team task claim                │
│    - 执行任务                        │
│    - team task complete             │
│ 4. 如果无任务: HEARTBEAT_OK          │
└─────────────────────────────────────┘
```

### 22.4 主代理之间的消息传递

**不使用 sessions_spawn！**

```
错误做法 ❌:
  main agent ──sessions_spawn──▶ repair agent
  (sessions_spawn 是主代理调用子代理)

正确做法 ✅:
  main agent ──team msg send──▶ team.db ──▶ repair agent 心跳读取
```

**消息通知机制**：

```typescript
// 主代理 A 发送消息
await execCLI(['msg', 'send', 'repair', 'TASK-001 需要你帮忙']);

// 主代理 B (repair) 心跳时读取
const msgs = await execCLI(['msg', 'list', '--unread']);
// 看到 "TASK-001 需要你帮忙"
// 决定是否响应
```

### 22.5 子代理的正确用途

**子代理是主代理的"手"，不是团队成员**

```typescript
// 主代理内部逻辑
async function executeComplexTask(task: Task) {
  // 情况1: 简单任务，主代理直接执行
  if (isSimple(task)) {
    return await doDirectly(task);
  }
  
  // 情况2: 复杂任务，调用子代理
  const result = await api.subagent.run({
    task: `执行子任务: ${task.subTask}`,
    model: 'openai/gpt-4o-mini',  // 弱模型省钱
    mode: 'run'
  });
  
  // 子代理执行完毕，结果返回给主代理
  return result;
}
```

**关键点**：
- 子代理不参与团队协作
- 子代理不知道 team.db 的存在
- 子代理是主代理的内部实现细节

### 22.6 Session 隔离

| Session 类型 | 格式 | 用途 |
|-------------|------|------|
| 主代理 session | `agent:<id>:main` | 用户对话 |
| 主代理心跳 session | `agent:<id>:heartbeat` | 心跳隔离 |
| 子代理 session | `agent:<id>:subagent:<uuid>` | 主代理内部调用 |

**主代理心跳使用隔离 session**：

```json
// 好处：
// 1. 心跳不污染主 session 的上下文
// 2. 心跳可以用弱模型 (gpt-4o-mini) 省钱
// 3. 心跳失败不影响用户对话
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "isolatedSession": true,
        "model": "openai/gpt-4o-mini"
      }
    }
  }
}
```

### 22.7 配置示例

```json
// ~/.openclaw/openclaw.json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4",
      "heartbeat": {
        "intervalSeconds": 1800,
        "isolatedSession": true,
        "model": "openai/gpt-4o-mini"
      },
      "subagents": {
        "model": "openai/gpt-4o-mini",
        "maxSpawnDepth": 2,
        "maxChildrenPerAgent": 5
      }
    }
  }
}
```

```markdown
<!-- workspace-repair/AGENTS.md -->
# AGENTS.md - Repair 工作空间

## 心跳任务

1. 运行 `team task list --assignee repair`
2. 如果有任务，执行并完成
3. 检查 `team msg list --unread`
4. 如果无任务无消息，回复 HEARTBEAT_OK

## Skill

使用 `team-collaboration` skill 与其他主代理协作。
```
// 5. 超时自动终止
```

**与用户对话 Session 的关系**：

| Session | 用户可见 | 上下文隔离 | Token 计数 |
|---------|----------|-----------|-----------|
| 主 session (`:main`) | ✅ 可见 | ❌ 共享 | 计入总消耗 |
| 子智能体 session (`:subagent:`) | ⚠️ 可查询 | ✅ 隔离 | 独立计算 |
| Cron session (`cron:`) | ❌ 不可见 | ✅ 隔离 | 独立计算 |

### 22.6 配置示例

```json
// openclaw.json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4",
      "subagents": {
        "model": "openai/gpt-4o-mini",  // 子智能体用弱模型
        "maxSpawnDepth": 2,
        "maxChildrenPerAgent": 5
      },
      "heartbeat": {
        "model": "openai/gpt-4o-mini",  // 心跳用弱模型
        "isolatedSession": true
      }
    }
  },
  "cron": {
    "jobs": [
      {
        "id": "team-dispatch",
        "schedule": "every:1800s",
        "sessionTarget": "isolated",
        "agentTurn": {
          "agentId": "main",
          "message": "[team:dispatch] 检查任务队列并分发"
        }
      }
    ]
  }
}
```

---

## 二十四、团队身份同步机制（DB → MD）

### 24.1 核心问题

**问题**：LLM 只能读取 MD 文件，不能直接查询 DB

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    数据流向问题                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   team.db (主数据源)                                                     │
│   ├─ agents 表：身份、角色、状态                                         │
│   ├─ team_tasks 表：任务分配                                             │
│   └─ messages 表：消息                                                   │
│                                                                          │
│   ❌ LLM 无法直接读取                                                     │
│                                                                          │
│   workspace-xxx/ (LLM 可读)                                              │
│   ├─ SOUL.md：个人身份                                                   │
│   ├─ HEARTBEAT.md：系统状态                                              │
│   └─ ??? 团队信息在哪里？                                                │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 24.2 解决方案：DB → MD 同步

**设计原则**：
1. **DB 是主数据源**：所有修改通过 CLI 写入 DB
2. **MD 是 LLM 视图**：从 DB 同步生成，只读
3. **增量同步**：只同步变化的部分

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    DB → MD Sync Architecture                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌─────────────────┐                                                   │
│   │ team CLI        │                                                   │
│   │ team agent *    │                                                   │
│   │ team task *     │                                                   │
│   └────────┬────────┘                                                   │
│            │ 写入                                                        │
│            ▼                                                             │
│   ┌─────────────────┐      同步触发      ┌─────────────────────────┐   │
│   │ team.db         │ ─────────────────▶ │ TeamSyncService         │   │
│   │                 │                    │ (插件内 Service)         │   │
│   │ agents          │                    │                         │   │
│   │ team_tasks      │                    │ onChange → syncToMD()   │   │
│   │ messages        │                    └───────────┬─────────────┘   │
│   └─────────────────┘                                │                 │
│                                                      │ 写入            │
│                                                      ▼                 │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ workspace-main/                  workspace-repair/              │  │
│   │ ├─ SOUL.md        (个人身份)      ├─ SOUL.md                    │  │
│   │ ├─ IDENTITY.md    (元数据)        ├─ IDENTITY.md                │  │
│   │ ├─ HEARTBEAT.md   (系统状态)      ├─ HEARTBEAT.md               │  │
│   │ └─ TEAM.md        (团队视图) ◀─── └─ TEAM.md                    │  │
│   │     ├─ 组织架构                    (每个主代理都能看到团队)     │  │
│   │     ├─ 队友状态                                                   │  │
│   │     └─ 分配给我的任务                                             │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 24.3 TEAM.md 模板

**每个主代理工作空间都需要有 TEAM.md**：

```markdown
# TEAM.md - 团队视图

> 最后同步: 2026-03-29 14:30 UTC
> 数据源: team.db

## 组织架构

```
麻辣进化者 (ceo) 🟢 idle
├── Bridge (pm) 🟢 idle
│   └── Designer-A (designer) 🔴 running
├── 麻辣 (cto) 🟢 idle
│   ├── Backend-Lead (engineer) 🟡 paused
│   └── Repair (engineer) 🟢 idle  ← 你
└── Watcher (operations) 🟢 idle
```

## 我的队友

| 名称 | 角色 | 状态 | 当前任务 |
|------|------|------|----------|
| 麻辣进化者 | ceo | 🟢 idle | - |
| Bridge | pm | 🟢 idle | TASK-001 (P1) |
| Backend-Lead | engineer | 🟡 paused | TASK-003 (blocked) |
| Designer-A | designer | 🔴 running | TASK-005 |

## 我的状态

- **ID**: repair
- **角色**: engineer
- **上级**: 麻辣 (cto)
- **状态**: 🟢 idle
- **当前任务**: 无

## 待处理任务

| ID | 标题 | 优先级 | 状态 | 分配时间 |
|----|------|--------|------|----------|
| TASK-002 | 修复登录页样式 | P1 | backlog | 2026-03-29 |
| TASK-006 | 重构 API 响应 | P2 | backlog | 2026-03-29 |

## 未读消息

- [1] Bridge: "TASK-001 需要你帮忙 review"
```

### 24.4 同步触发时机

| 触发事件 | 同步内容 | 目标文件 |
|----------|----------|----------|
| Agent 状态变化 | TEAM.md 中该 agent 的状态 | 所有 agent 的 TEAM.md |
| 新 Agent 注册 | TEAM.md 组织架构 | 所有 agent 的 TEAM.md |
| 任务分配/完成 | TEAM.md 任务列表 | 相关 agent 的 TEAM.md |
| 消息发送 | TEAM.md 未读消息 | 目标 agent 的 TEAM.md |
| 组织架构调整 | TEAM.md 组织架构 | 所有 agent 的 TEAM.md |

### 24.5 同步服务实现

```typescript
// packages/openclaw-plugin/src/team/team-sync-service.ts

export class TeamSyncService {
  private dbPath: string;
  
  /**
   * 同步所有 agent 的 TEAM.md
   */
  async syncAll(): Promise<void> {
    const agents = await this.listActiveAgents();
    
    for (const agent of agents) {
      await this.syncAgentTeamMD(agent.id);
    }
  }
  
  /**
   * 同步指定 agent 的 TEAM.md
   */
  async syncAgentTeamMD(agentId: string): Promise<void> {
    const workspaceDir = this.getWorkspaceDir(agentId);
    const teamMDPath = path.join(workspaceDir, 'TEAM.md');
    
    // 1. 从 DB 读取数据
    const orgTree = await this.getOrgTree();
    const teammates = await this.getTeammates(agentId);
    const myTasks = await this.getAgentTasks(agentId);
    const unreadMsgs = await this.getUnreadMessages(agentId);
    const myInfo = await this.getAgentInfo(agentId);
    
    // 2. 生成 TEAM.md 内容
    const content = this.renderTeamMD({
      agentId,
      orgTree,
      teammates,
      myTasks,
      unreadMsgs,
      myInfo,
      syncedAt: new Date().toISOString()
    });
    
    // 3. 写入文件
    fs.writeFileSync(teamMDPath, content);
  }
  
  /**
   * 渲染 TEAM.md
   */
  private renderTeamMD(data: TeamMDData): string {
    return `# TEAM.md - 团队视图

> 最后同步: ${data.syncedAt}
> 数据源: team.db

## 组织架构

\`\`\`
${this.renderOrgTree(data.orgTree, data.agentId)}
\`\`\`

## 我的队友

${this.renderTeammatesTable(data.teammates)}

## 我的状态

- **ID**: ${data.myInfo.id}
- **角色**: ${data.myInfo.role}
- **上级**: ${data.myInfo.reportsToName} (${data.myInfo.reportsToRole})
- **状态**: ${this.statusEmoji(data.myInfo.status)} ${data.myInfo.status}
- **当前任务**: ${data.myInfo.currentTask || '无'}

## 待处理任务

${this.renderTasksTable(data.myTasks)}

## 未读消息

${this.renderMessagesList(data.unreadMsgs)}
`;
  }
  
  /**
   * 渲染组织架构树，高亮当前 agent
   */
  private renderOrgTree(tree: OrgNode[], currentAgentId: string): string {
    const render = (nodes: OrgNode[], indent: string = ''): string => {
      return nodes.map((node, i) => {
        const isLast = i === nodes.length - 1;
        const prefix = indent + (isLast ? '└── ' : '├── ');
        const status = this.statusEmoji(node.status);
        const highlight = node.id === currentAgentId ? ' ← 你' : '';
        const line = `${prefix}${node.name} (${node.role}) ${status}${highlight}\n`;
        
        if (node.children?.length) {
          const childIndent = indent + (isLast ? '    ' : '│   ');
          return line + render(node.children, childIndent);
        }
        return line;
      }).join('');
    };
    return render(tree);
  }
  
  /**
   * 状态转换为 emoji
   */
  private statusEmoji(status: string): string {
    const map: Record<string, string> = {
      'idle': '🟢',
      'running': '🔴',
      'paused': '🟡',
      'pending': '⚪',
      'terminated': '⚫'
    };
    return map[status] || '⚪';
  }
  
  /**
   * 获取 agent 的工作空间目录
   */
  private getWorkspaceDir(agentId: string): string {
    // 从配置或环境变量获取
    const baseDir = process.env.OPENCLAW_WORKSPACE_BASE || '/home/csuzngjh/.openclaw';
    return path.join(baseDir, `workspace-${agentId}`);
  }
}
```

### 24.6 同步触发器

**方式一：CLI 命令后自动触发**

```typescript
// team-cli/src/commands/agent.ts

async function updateAgentStatus(agentId: string, status: string) {
  // 1. 更新 DB
  await db.update(agents).set({ status }).where(eq(agents.id, agentId));
  
  // 2. 触发同步
  await syncService.syncAll();  // 或 syncService.syncAffected(agentId)
}
```

**方式二：心跳时检查并同步**

```typescript
// 心跳时的同步检查
async function heartbeatSync(agentId: string) {
  const lastSync = await getLastSyncTime(agentId);
  const changes = await db.query(`
    SELECT * FROM sync_log 
    WHERE updated_at > ? AND affected_agents LIKE ?
  `, [lastSync, `%${agentId}%`]);
  
  if (changes.length > 0) {
    await syncService.syncAgentTeamMD(agentId);
  }
}
```

**方式三：手动触发**

```bash
# 手动同步所有 TEAM.md
team sync --all

# 同步指定 agent
team sync --agent repair
```

### 24.7 增量同步优化

```sql
-- 同步日志表
CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,        -- agent_status/task_assign/msg_send
  affected_agents_json TEXT,       -- ["repair", "main"]
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 触发器：agents 表变化时记录
CREATE TRIGGER sync_log_agent
AFTER UPDATE ON agents
BEGIN
  INSERT INTO sync_log (event_type, affected_agents_json)
  VALUES ('agent_update', json_array(NEW.id));
END;
```

### 24.8 其他需要同步的文件

| 文件 | 同步内容 | 频率 |
|------|----------|------|
| `TEAM.md` | 团队视图 | 每次变化 |
| `HEARTBEAT.md` | 系统状态、待处理任务 | 每次心跳 |
| `SOUL.md` | 个人身份（只读部分） | 身份变化时 |
| `CURRENT_FOCUS.md` | 任务列表 | 任务变化时 |

**SOUL.md 同步示例**：

```typescript
// SOUL.md 顶部添加自动生成区块
async function syncSoulMD(agentId: string) {
  const info = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  
  const autoSection = `
<!-- AUTO-GENERATED: Do not edit manually -->
> **身份信息** (自动同步自 team.db)
> - 角色: ${info.role}
> - 上级: ${info.reportsToName}
> - 状态: ${info.status}
> - 最后更新: ${info.updatedAt}
<!-- END AUTO-GENERATED -->

# SOUL.md - Who You Are
...原有内容...
`;
}
```

---

## 二十五、关键问题修复

### 25.1 调度器高可用设计

**问题**：TeamOrchestrationService 单进程，崩溃后调度停止

**解决方案**：调度器自监控 + 进程守护

```typescript
// packages/openclaw-plugin/src/service/team-orchestration-service.ts

export class TeamOrchestrationService implements OpenClawPluginService {
  private lastTickTime: number = 0;
  private healthCheckPath: string;
  
  start(ctx: OpenClawPluginServiceContext): void {
    this.ctx = ctx;
    this.healthCheckPath = ctx.resolvePath('.state/team-scheduler-health.json');
    
    // 主调度循环
    this.intervalId = setInterval(() => this.tick(), 30000);
    
    // 健康检查写入（每次 tick 更新）
    this.writeHealthCheck('running');
  }
  
  private writeHealthCheck(status: 'running' | 'error'): void {
    const health = {
      status,
      lastTick: new Date().toISOString(),
      lastTickTimestamp: Date.now(),
      pid: process.pid,
      consecutiveErrors: this.consecutiveErrors
    };
    fs.writeFileSync(this.healthCheckPath, JSON.stringify(health, null, 2));
  }
  
  private async tick(): Promise<void> {
    this.lastTickTime = Date.now();
    
    try {
      // ... 原有逻辑
      this.consecutiveErrors = 0;
      this.writeHealthCheck('running');
    } catch (error) {
      this.consecutiveErrors++;
      this.writeHealthCheck('error');
      
      // 连续错误超过阈值，尝试恢复
      if (this.consecutiveErrors >= 3) {
        this.ctx.logger?.error('Scheduler critical failure, attempting recovery');
        await this.attemptRecovery();
      }
    }
  }
  
  private async attemptRecovery(): Promise<void> {
    // 1. 重新初始化 DB 连接
    this.db?.close();
    this.db = new Database(this.dbPath);
    
    // 2. 重置超时任务
    await this.recoverOrphans(new Date());
    
    // 3. 重置错误计数
    this.consecutiveErrors = 0;
  }
}
```

**外部监控脚本**：

```bash
#!/bin/bash
# scripts/watchdog-scheduler.sh

HEALTH_FILE="$HOME/.openclaw/.state/team-scheduler-health.json"
MAX_AGE=120  # 秒

if [ ! -f "$HEALTH_FILE" ]; then
  echo "ERROR: Health file not found"
  exit 1
fi

LAST_TICK=$(jq -r '.lastTickTimestamp' "$HEALTH_FILE")
NOW=$(date +%s)000
AGE=$(( ($NOW - $LAST_TICK) / 1000 ))

if [ $AGE -gt $MAX_AGE ]; then
  echo "ERROR: Scheduler stalled for ${AGE}s"
  # 可选：发送告警或重启 Gateway
  # systemctl restart openclaw-gateway
  exit 1
fi

STATUS=$(jq -r '.status' "$HEALTH_FILE")
if [ "$STATUS" = "error" ]; then
  echo "WARN: Scheduler in error state"
  exit 1
fi

echo "OK: Scheduler healthy, last tick ${AGE}s ago"
```

### 25.2 DB → MD 同步可靠性

**问题**：DB 写入成功但 MD 同步失败，LLM 看到过期数据

**解决方案**：事务级同步 + 失败重试 + 版本标记

```typescript
// packages/openclaw-plugin/src/team/team-sync-service.ts

export class TeamSyncService {
  private syncQueue: Map<string, SyncTask> = new Map();
  private syncRetryLimit = 3;
  
  /**
   * 原子操作：DB 更新 + MD 同步
   */
  async atomicUpdate<T>(
    dbOperation: () => Promise<T>,
    affectedAgents: string[]
  ): Promise<T> {
    // 1. 执行 DB 操作
    const result = await dbOperation();
    
    // 2. 记录同步需求（即使后续失败也能恢复）
    const syncId = `sync-${Date.now()}`;
    await this.logSyncRequest(syncId, affectedAgents);
    
    // 3. 同步 MD 文件
    for (const agentId of affectedAgents) {
      await this.syncWithRetry(agentId, syncId);
    }
    
    // 4. 标记同步完成
    await this.markSyncComplete(syncId);
    
    return result;
  }
  
  private async syncWithRetry(agentId: string, syncId: string): Promise<void> {
    let lastError: Error | null = null;
    
    for (let i = 0; i < this.syncRetryLimit; i++) {
      try {
        await this.syncAgentTeamMD(agentId);
        return;
      } catch (error) {
        lastError = error;
        await this.sleep(1000 * (i + 1));  // 指数退避
      }
    }
    
    // 同步失败，记录但不阻塞主流程
    this.ctx.logger?.error(`Failed to sync TEAM.md for ${agentId}`, lastError);
    await this.logSyncFailure(syncId, agentId, lastError);
  }
  
  /**
   * 心跳时的增量同步检查
   */
  async checkAndSync(agentId: string): Promise<boolean> {
    // 1. 检查是否有待同步的变更
    const pending = await this.db.prepare(`
      SELECT * FROM sync_log 
      WHERE status = 'pending' 
      AND affected_agents_json LIKE ?
      ORDER BY created_at
    `).get(`%${agentId}%`);
    
    if (!pending) return false;
    
    // 2. 执行同步
    await this.syncAgentTeamMD(agentId);
    
    return true;
  }
}
```

**MD 文件版本标记**：

```markdown
# TEAM.md - 团队视图

> 最后同步: 2026-03-29 14:30 UTC
> 数据源: team.db
> **版本**: v20260329-143000
> **DB 校验和**: abc123def

<!-- AUTO-GENERATED: Do not edit manually. Changes will be overwritten. -->
```

**启动时校验**：

```typescript
async function validateSync(agentId: string): Promise<boolean> {
  const teamMD = readTeamMD(agentId);
  const dbChecksum = await getDBChecksum();
  
  if (teamMD.checksum !== dbChecksum) {
    // MD 过期，重新同步
    await syncService.syncAgentTeamMD(agentId);
    return false;
  }
  
  return true;
}
```

### 25.3 心跳执行机制修正

**问题**：文档假设 LLM 能执行 shell 命令，但 OpenClaw 心跳需要工具/Skill

**解决方案**：明确心跳执行路径

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    心跳执行机制（修正版）                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  OpenClaw Gateway                                                        │
│       │                                                                  │
│       │ 每 30 分钟触发                                                   │
│       ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Heartbeat Session (isolated)                                     │   │
│  │                                                                  │   │
│  │ 1. 加载 AGENTS.md（心跳指令）                                     │   │
│  │                                                                  │   │
│  │ 2. 加载 TEAM.md（团队视图）                                       │   │
│  │    - 检查 DB 校验和，如过期则重新同步                              │   │
│  │                                                                  │   │
│  │ 3. 加载 HEARTBEAT.md（详细任务）                                  │   │
│  │                                                                  │   │
│  │ 4. LLM 决定行动：                                                 │   │
│  │    - 调用 team_task_list 工具 ←─ LLM Tool (插件注册)             │   │
│  │    - 或回复 HEARTBEAT_OK                                          │   │
│  │                                                                  │   │
│  │ 5. 执行任务（通过 team_* 工具）                                   │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**关键修正**：
- CLI 是**可选的辅助工具**，不是必需
- LLM 通过 **team_* 工具**与 DB 交互（工具内部可调用 CLI）
- 心跳 prompt 放在 **HEARTBEAT.md**，不在 AGENTS.md

**修正后的 HEARTBEAT.md**：

```markdown
# HEARTBEAT.md

## 心跳任务

### 优先级 1：检查团队任务

调用 `team_task_list` 工具，查询分配给你的任务：
- 参数：`{"status": ["backlog", "locked"]}`

如果有任务：
1. 调用 `team_task_claim` 领取
2. 执行任务
3. 调用 `team_task_complete` 完成

### 优先级 2：检查消息

调用 `team_message_read` 工具：
- 参数：`{"unread_only": true}`

如果有未读消息，根据内容决定是否响应。

### 无任务时

回复 `HEARTBEAT_OK`

---
*最后更新: 2026-03-29*
```

### 25.4 CURRENT_FOCUS 与 TEAM.md 职责划分

**问题**：两者职责重叠，关系不清

**解决方案**：明确分工

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    CURRENT_FOCUS vs TEAM.md                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  CURRENT_FOCUS.md                    TEAM.md                             │
│  ├─ 职责：个人工作视图                ├─ 职责：团队协作视图              │
│  ├─ 来源：本地 + 团队任务             ├─ 来源：team.db（只读）          │
│  ├─ 可编辑：是（本地任务）            ├─ 可编辑：否（自动生成）          │
│  └─ 注入时机：每次 prompt             └─ 注入时机：心跳启动时            │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 数据流向                                                         │   │
│  │                                                                  │   │
│  │ team.db ──同步──▶ TEAM.md (团队视图)                             │   │
│  │     │                                                            │   │
│  │     └──合并──▶ CURRENT_FOCUS.md (包含 [team] 和 [local] 任务)    │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  使用场景：                                                              │
│  - 用户对话时：注入 CURRENT_FOCUS（完整上下文）                          │
│  - 心跳时：注入 TEAM.md + HEARTBEAT.md（团队协作）                       │
│  - 单智能体模式：只用 CURRENT_FOCUS，TEAM.md 不生成                      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**CURRENT_FOCUS.md 模板（修订版）**：

```markdown
# 🎯 CURRENT_FOCUS

> **版本**: v2026-03-29-1 | **更新**: 2026-03-29

## 📋 当前任务

### 🔒 进行中

- [team] TASK-001: 实现调度器核心 (P1)
  _来自团队编排，通过 team_* 工具管理_
  
- [ ] 修复登录页样式问题
  _本地任务，可直接编辑此文件_

### 📥 待办

- [team] TASK-002: 添加订阅机制 (P2)
- [ ] 整理项目文档

---
**说明**：
- `[team]` 任务来自团队系统，修改请用 team_* 工具
- 无标记任务为本地任务，可直接编辑
- 团队视图见 TEAM.md
```

### 25.5 消息管理机制

**问题**：消息无上限堆积，无过期机制

**解决方案**：消息生命周期管理

```sql
-- 扩展 messages 表
ALTER TABLE messages ADD COLUMN priority TEXT DEFAULT 'normal';  -- urgent/high/normal/low
ALTER TABLE messages ADD COLUMN expires_at TEXT;                  -- 过期时间

-- 消息清理调度
INSERT INTO schedules (id, schedule_expr, action_type, action_config_json)
VALUES ('message-cleanup', 'cron:0 0 * * *', 'cleanup', '{"type": "messages", "maxAge": "7d"}');
```

**消息优先级处理**：

```typescript
// 紧急消息：立即触发唤醒
async function sendMessage(msg: Message): Promise<void> {
  await this.db.insert(messages).values(msg);
  
  if (msg.priority === 'urgent') {
    // 紧急消息：直接通过 sessions_send 唤醒
    await this.ctx.api?.sessionsSend({
      sessionKey: `agent:${msg.to_agent}:heartbeat`,
      message: `[URGENT] ${msg.content}`
    });
  }
  
  // 同步 TEAM.md
  await this.syncService.syncAgentTeamMD(msg.to_agent);
}
```

**消息过期清理**：

```typescript
async function cleanupExpiredMessages(): Promise<number> {
  const result = await this.db.delete(messages)
    .where(lt(messages.expires_at, new Date().toISOString()));
  
  return result.changes;
}
```

### 25.6 安全考虑（未来可选）

**当前场景**：单机单用户，所有 agent 在可信环境运行

**暂不实现**：
- Agent Token 验证（信任环境）
- 自定义 SQL 白名单（禁用 `team cmd add` 即可）
- 敏感信息脱敏（团队内部可见）

**未来如需加固**：
- 多用户/多机部署时，添加 Token 验证
- 开放自定义 SQL 时，添加白名单过滤
- 跨团队协作时，添加字段脱敏

### 25.7 TEAM.md 性能优化

**问题**：大团队时文件膨胀

**解决方案**：分层视图 + 按需加载

```typescript
// TEAM.md 分层生成
async function renderTeamMD(agentId: string, options: TeamMDOptions): Promise<string> {
  const { detailLevel = 'summary' } = options;
  
  switch (detailLevel) {
    case 'minimal':
      // 只包含：我的状态 + 我的任务 + 未读消息数
      return this.renderMinimal(agentId);
      
    case 'summary':
      // 包含：组织架构（直系）+ 队友列表 + 我的任务
      return this.renderSummary(agentId);
      
    case 'full':
      // 包含：完整组织架构 + 所有队友详情 + 所有任务
      return this.renderFull(agentId);
  }
}

// 默认使用 summary 模式
// 心跳时按需调用 team_status 获取更多详情
```

**TEAM.md 精简模板**：

```markdown
# TEAM.md - 团队视图 (精简版)

> 最后同步: 2026-03-29 14:30 UTC
> 详细信息：调用 `team_status` 工具

## 我的上级

麻辣 (cto) 🟢 idle

## 我的队友（同级）

| 名称 | 状态 | 当前任务 |
|------|------|----------|
| Backend-Lead | 🟡 paused | TASK-003 |

## 我的任务

| ID | 标题 | 优先级 | 状态 |
|----|------|--------|------|
| TASK-002 | 修复登录页 | P1 | backlog |

## 未读消息

- [2] 条未读，调用 `team_message_read` 查看
```

---

## 二十六、简化实施路径

### 26.1 MVP 范围（最小可行版本）

**只做核心功能**：

| 功能 | 必要性 | 说明 |
|------|--------|------|
| SQLite Schema | ✅ 必须 | 数据存储基础 |
| team_* LLM 工具（4个核心） | ✅ 必须 | task_list, task_claim, task_complete, message_send |
| 调度器（简化版） | ✅ 必须 | 只做超时检测，不做复杂派发 |
| TEAM.md 同步 | ✅ 必须 | 让 LLM 能看到团队信息 |
| 心跳 Prompt 更新 | ✅ 必须 | 指导 LLM 使用新工具 |

**暂不做**：

| 功能 | 原因 |
|------|------|
| CLI 独立小程序 | 复杂，LLM 工具已足够 |
| 自定义命令 | 非核心，后期可加 |
| 订阅机制 | 复杂，心跳轮询够用 |
| 漂移检测 | 非核心，后期可加 |
| Token 验证 | 单机环境不需要 |

### 26.2 实施步骤（3 天）

**Day 1: 数据层**

```
1. 创建 team.db + Schema
2. 迁移 TASKBOARD.json 数据
3. 验证数据完整性
```

**Day 2: 工具层**

```
1. 实现 4 个核心 team_* 工具
2. 实现 TEAM.md 同步服务
3. 更新 HEARTBEAT.md 模板
```

**Day 3: 集成验证**

```
1. 禁用现有 cron 任务
2. 测试心跳流程
3. 测试任务流转（创建→领取→完成）
```

### 26.3 验证清单（精简版）

| 检查项 | 命令/方法 | 通过标准 |
|--------|----------|----------|
| DB 可用 | `sqlite3 team.db ".tables"` | 返回表名列表 |
| 工具可用 | 心跳时调用 `team_task_list` | 返回任务列表 |
| 同步正常 | 检查 TEAM.md 内容 | 与 DB 一致 |
| 任务流转 | 创建任务 → 领取 → 完成 | 全流程通 |

### 26.4 回滚方案

```bash
# 如果新系统有问题，简单回滚：
# 1. 恢复 cron 任务
cp ~/.openclaw/cron/jobs.json.backup ~/.openclaw/cron/jobs.json

# 2. 禁用新工具（从插件 index.ts 注释掉）

# 3. TEAM.md 改为手动维护
```

---

## 版本历史

| 版本 | 日期 | 内容 |
|------|------|------|
| v1 | 2026-03-28 | 初始版本：5 个补丁方案 |
| v2 | 2026-03-29 | 统一方案：TASKBOARD + 三层自驱动 |
| v3 | 2026-03-29 | 内置版：SQLite + 调度器 + 完全替代 cron |
| v3.1 | 2026-03-29 | 全生命周期 + 订阅机制 + CLI 完整设计 + 分层扩展 |
| v3.2 | 2026-03-29 | 关键问题修复：调度器高可用、同步可靠性、心跳机制修正 |
| **v3.3** | 2026-03-29 | **简化版**：聚焦 MVP，3 天可落地 |

---

## 二十七、深度评审意见与优化建议 (2026-03-29)

### 27.1 核心风险提示

| 风险点 | 严重程度 | 描述 | 优化建议 |
|:---|:---|:---|:---|
| **API 盲区** | 🔴 致命 | \`sessionsSend\` 在当前 OpenClaw SDK 中并不存在。 | 降级为 **Pull 模式**。Agent 依赖 Heartbeat 主动拉取任务，而非由 Service 推送。 |
| **物理同步冗余** | 🟡 严重 | 频繁写 \`TEAM.md\` 违反“数字洁癖”，且存在 I/O 阻塞。 | 废除物理文件，在 \`before_prompt_build\` 钩子中进行 **内存级 XML 注入**。 |
| **反模式调用** | 🟡 严重 | LLM 工具通过 \`spawnSync\` 封装 CLI 会导致高延迟。 | 建立 **DAL (数据访问层)**，LLM 工具直接查询 DB，CLI 仅作为人类终端工具。 |
| **逻辑悖论** | ⚪ 中等 | 插件调度器与 OpenClaw 原生 Heartbeat 职责冲突。 | 剥离职责：Heartbeat 负责“闹钟”，Service 仅作为 **Watchdog** 处理超时和清理。 |
| **性能隐患** | ⚪ 中等 | \`better-sqlite3\` 同步操作可能阻塞事件循环。 | 使用链式 \`setTimeout\` 替代 \`setInterval\`，并确保单次 Tick 任务原子化、极简化。 |

### 27.2 架构架构优化建议

1. **即时注入机制 (JIT Injection)**：
   不要在磁盘上维护数个 \`TEAM.md\` 副本。在 Agent 发起对话的瞬间，插件通过 \`before_prompt_build\` 钩子拦截，从 SQLite 中实时提取该 Agent 相关的团队快照，直接注入 System Prompt。这保证了数据的 **100% 实时性** 且不污染工作空间。

2. **DAL (Data Access Layer) 共享模式**：
   重构 \`team-database.ts\`，将其作为插件内部的单例服务。
   - **LLM Tool**: 调用 \`TaskRepository.list()\` -> 返回 JSON（毫秒级）。
   - **Team CLI**: 调用同一个 \`TaskRepository\` -> 渲染 Table -> 打印。
   - 严禁 LLM 工具衍生 (spawn) 外部子进程来执行简单的数据库操作。

3. **调度器降级为“清道夫”**：
   取消 \`TeamOrchestrationService\` 中主动“唤醒” Agent 的逻辑（因为 API 不支持）。将其职能转变为后台维护任务：
   - 扫描 \`locked\` 超过 4 小时的任务并标记为 \`timed_out\`。
   - 清理 7 天前的已读消息。
   - 重新计算 KR 进度百分比。

4. **Session 隔离策略强化**：
   确保心跳 (Heartbeat) 在 OpenClaw 的 \`isolatedSession\` 中运行，并使用 \`gpt-4o-mini\` 等轻量模型以降低成本。心跳 Prompt 应极度精简，仅包含读取任务和领取任务两个动作。

