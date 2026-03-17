# Agent Trajectory Database 设计方案

> **版本**: v1.0 | **日期**: 2026-03-17 | **状态**: Draft

---

## 1. 背景与目标

### 1.1 问题陈述

Principles 框架关注的是**决策层**的进化，而非执行层。当前已有的元数据系统：

- `events.jsonl` - 结构化事件日志
- `daily-stats.json` - 日统计聚合
- `sessions/*.json` - 会话状态

但这些数据分散在不同文件中，难以：
1. 进行长期时间序列分析
2. 追踪一个任务从开始到完成的完整轨迹
3. 建立"决策 → 工具调用 → GFI 变化 → 任务结果"的因果链
4. 支持可视化和数据建模

### 1.2 设计目标

| 目标 | 描述 |
|------|------|
| **长期存储** | 支持数月甚至数年的数据保留 |
| **时间序列** | 完整的时间轨迹，便于分析趋势 |
| **任务关联** | 工具调用与任务的关联 |
| **GFI 追踪** | GFI 变化与具体操作的因果关系 |
| **结果标注** | 任务是否被用户接受的标记 |
| **查询友好** | 支持 SQL 查询，便于分析和可视化 |

---

## 2. 数据模型设计

### 2.1 ER 图

```
┌─────────────────────┐
│ workspaces          │
├─────────────────────┤
│ id (PK) TEXT        │
│ path TEXT UNIQUE    │
│ first_seen DATETIME │
│ last_active DATETIME│
└─────────────────────┘
          │
          │ 1:N
          ▼
┌─────────────────────┐     ┌─────────────────────┐
│ sessions            │     │ tasks               │
├─────────────────────┤     ├─────────────────────┤
│ id (PK) TEXT        │────<│ id (PK) TEXT        │
│ workspace_id (FK)   │     │ session_id (FK)     │
│ started_at DATETIME │     │ focus_file TEXT     │
│ ended_at DATETIME   │     │ description TEXT    │
│ final_status TEXT   │     │ priority INTEGER    │
│ gfi_peak REAL       │     │ started_at DATETIME │
│ gfi_final REAL      │     │ completed_at DATETIME│
│ tool_calls_count INT│     │ status TEXT         │
│ user_accepted INT   │     │ user_accepted INT   │
└─────────────────────┘     └─────────────────────┘
          │                           │
          │ 1:N                       │ 1:N
          ▼                           ▼
┌─────────────────────┐     ┌─────────────────────┐
│ tool_calls          │     │ pain_events         │
├─────────────────────┤     ├─────────────────────┤
│ id (PK) INTEGER     │     │ id (PK) INTEGER     │
│ session_id (FK)     │     │ session_id (FK)     │
│ task_id (FK) NULL   │     │ task_id (FK) NULL   │
│ timestamp DATETIME  │     │ timestamp DATETIME  │
│ tool_name TEXT      │     │ score REAL          │
│ file_path TEXT      │     │ source TEXT         │
│ outcome TEXT        │     │ severity TEXT       │
│ gfi_before REAL     │     │ reason TEXT         │
│ gfi_after REAL      │     │ gfi_at_event REAL   │
│ error_type TEXT     │     │ origin TEXT         │
│ error_message TEXT  │     │ confidence REAL     │
│ duration_ms INT     │     └─────────────────────┘
└─────────────────────┘
          │
          │ 1:N
          ▼
┌─────────────────────┐
│ gfi_snapshots       │
├─────────────────────┤
│ id (PK) INTEGER     │
│ session_id (FK)     │
│ tool_call_id (FK)   │
│ timestamp DATETIME  │
│ gfi_value REAL      │
│ delta REAL          │
│ trigger TEXT        │
│ consecutive_errors INT│
└─────────────────────┘
```

### 2.2 表结构定义

#### 2.2.1 workspaces - 工作空间

```sql
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 使用路径的 hash 作为 id
-- id = md5(path)
```

#### 2.2.2 sessions - 会话

```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    started_at DATETIME NOT NULL,
    ended_at DATETIME,
    final_status TEXT CHECK(final_status IN ('active', 'completed', 'abandoned', 'reset')),
    gfi_peak REAL DEFAULT 0,
    gfi_final REAL DEFAULT 0,
    tool_calls_count INTEGER DEFAULT 0,
    pain_events_count INTEGER DEFAULT 0,
    user_accepted INTEGER DEFAULT 0,  -- 0=未知, 1=接受, -1=拒绝
    user_feedback TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_sessions_status ON sessions(final_status);
```

#### 2.2.3 tasks - 任务

```sql
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,  -- 从 CURRENT_FOCUS.md 提取的任务标识
    session_id TEXT NOT NULL,
    focus_file TEXT,      -- CURRENT_FOCUS.md 的路径
    description TEXT NOT NULL,
    priority INTEGER CHECK(priority IN (0, 1, 2)),  -- P0/P1/P2
    started_at DATETIME,
    completed_at DATETIME,
    status TEXT CHECK(status IN ('pending', 'in_progress', 'completed', 'blocked')),
    user_accepted INTEGER DEFAULT 0,  -- 用户是否接受完成
    gfi_at_start REAL,
    gfi_at_end REAL,
    tool_calls_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_tasks_session ON tasks(session_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_priority ON tasks(priority);
```

#### 2.2.4 tool_calls - 工具调用

```sql
CREATE TABLE tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    task_id TEXT,  -- 可选，关联到具体任务
    timestamp DATETIME NOT NULL,
    tool_name TEXT NOT NULL,
    file_path TEXT,
    outcome TEXT CHECK(outcome IN ('success', 'failure', 'blocked')),
    gfi_before REAL,
    gfi_after REAL,
    gfi_delta REAL,  -- gfi_after - gfi_before
    error_type TEXT,
    error_message TEXT,
    duration_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX idx_tool_calls_timestamp ON tool_calls(timestamp);
CREATE INDEX idx_tool_calls_tool ON tool_calls(tool_name);
CREATE INDEX idx_tool_calls_outcome ON tool_calls(outcome);
```

#### 2.2.5 gfi_snapshots - GFI 快照

```sql
CREATE TABLE gfi_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool_call_id INTEGER,  -- 关联到触发变化的工具调用
    timestamp DATETIME NOT NULL,
    gfi_value REAL NOT NULL,
    delta REAL,           -- 变化量
    trigger TEXT,         -- trigger_friction 的 hash
    consecutive_errors INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id)
);

CREATE INDEX idx_gfi_session ON gfi_snapshots(session_id);
CREATE INDEX idx_gfi_timestamp ON gfi_snapshots(timestamp);
```

#### 2.2.6 pain_events - Pain 信号

```sql
CREATE TABLE pain_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    task_id TEXT,
    timestamp DATETIME NOT NULL,
    score REAL NOT NULL,
    source TEXT NOT NULL,
    severity TEXT CHECK(severity IN ('mild', 'moderate', 'severe')),
    reason TEXT,
    gfi_at_event REAL,
    origin TEXT CHECK(origin IN ('assistant_self_report', 'user_manual', 'system_infer')),
    confidence REAL,
    rolled_back INTEGER DEFAULT 0,  -- 是否被回滚
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX idx_pain_session ON pain_events(session_id);
CREATE INDEX idx_pain_timestamp ON pain_events(timestamp);
CREATE INDEX idx_pain_severity ON pain_events(severity);
```

---

## 3. 数据采集流程

### 3.1 采集架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        数据采集层                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐    │
│  │ gate.ts  │   │ pain.ts  │   │prompt.ts │   │lifecycle │    │
│  │          │   │          │   │          │   │   .ts    │    │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘   └────┬─────┘    │
│       │              │              │              │           │
│       ▼              ▼              ▼              ▼           │
│  ┌────────────────────────────────────────────────────────┐   │
│  │              TrajectoryCollector (新增)                │   │
│  │  - buffer: ToolCallEvent[]                             │   │
│  │  - buffer: GfiSnapshot[]                               │   │
│  │  - buffer: PainEvent[]                                 │   │
│  └────────────────────────┬───────────────────────────────┘   │
│                           │                                    │
│                           │ 内存 buffer + 定期 flush           │
│                           ▼                                    │
│  ┌────────────────────────────────────────────────────────┐   │
│  │              TrajectoryDatabase (新增)                 │   │
│  │  - SQLite 存储层                                       │   │
│  │  - 位置: {stateDir}/trajectory.db                      │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Hook 集成点

| Hook | 采集数据 | 触发时机 |
|------|----------|----------|
| `gate.ts` | 工具调用、GFI Gate 拦截 | 每次工具调用 |
| `pain.ts` | Pain 信号、GFI 变化 | Pain 触发时 |
| `prompt.ts` | 会话开始、GFI 状态 | 每次对话开始 |
| `lifecycle.ts` | 会话结束、压缩前 | 会话结束/压缩时 |

### 3.3 数据流详细设计

#### 3.3.1 会话开始 (prompt.ts)

```typescript
// 在 prependSystemContext 函数中
async function onSessionStart(sessionId: string, workspaceDir: string) {
  await trajectoryCollector.startSession({
    sessionId,
    workspaceId: hashPath(workspaceDir),
    workspacePath: workspaceDir,
    startedAt: new Date().toISOString(),
    gfiInitial: 0
  });
}
```

#### 3.3.2 工具调用 (gate.ts)

```typescript
// 在 gate hook 中
async function onToolCall(event: ToolCallEvent, ctx: HookContext) {
  const gfiBefore = getSession(ctx.sessionId)?.currentGfi || 0;
  
  // 记录工具调用
  trajectoryCollector.recordToolCall({
    sessionId: ctx.sessionId,
    timestamp: new Date().toISOString(),
    toolName: event.toolName,
    filePath: event.filePath,
    outcome: event.error ? 'failure' : 'success',
    gfiBefore,
    gfiAfter: undefined, // 稍后更新
    errorType: event.error?.type,
    errorMessage: event.error?.message
  });
}
```

#### 3.3.3 GFI 变化 (session-tracker.ts)

```typescript
// 在 trackFriction 函数中
export function trackFriction(sessionId: string, deltaF: number, hash: string, workspaceDir?: string): SessionState {
  // ... 现有逻辑 ...
  
  // 新增：记录 GFI 快照
  trajectoryCollector.recordGfiSnapshot({
    sessionId,
    timestamp: new Date().toISOString(),
    gfiValue: state.currentGfi,
    delta: addedFriction,
    trigger: hash,
    consecutiveErrors: state.consecutiveErrors
  });
  
  return state;
}
```

#### 3.3.4 Pain 信号 (pain.ts)

```typescript
// 在 pain hook 中
async function onPainSignal(event: PainEvent, ctx: HookContext) {
  trajectoryCollector.recordPainEvent({
    sessionId: ctx.sessionId,
    timestamp: new Date().toISOString(),
    score: event.score,
    source: event.source,
    severity: event.severity,
    reason: event.reason,
    gfiAtEvent: getSession(ctx.sessionId)?.currentGfi || 0,
    origin: event.origin,
    confidence: event.confidence
  });
}
```

#### 3.3.5 会话结束 (lifecycle.ts)

```typescript
// 在 before_compaction hook 中
async function onSessionEnd(sessionId: string, ctx: HookContext) {
  const session = getSession(sessionId);
  
  // 解析 CURRENT_FOCUS.md 获取任务状态
  const tasks = await parseCurrentFocus(ctx.workspaceDir);
  
  await trajectoryCollector.endSession({
    sessionId,
    endedAt: new Date().toISOString(),
    finalStatus: 'completed',
    gfiPeak: session?.dailyGfiPeak || 0,
    gfiFinal: session?.currentGfi || 0,
    tasks
  });
  
  // flush 所有 buffer 到 SQLite
  await trajectoryCollector.flush();
}
```

### 3.4 CURRENT_FOCUS.md 解析

```typescript
interface ParsedTask {
  id: string;           // 从描述生成 hash
  description: string;  // 任务描述文本
  priority: 0 | 1 | 2;  // P0/P1/P2
  status: 'pending' | 'in_progress' | 'completed';
  isCurrent: boolean;   // 是否有 "← 当前" 标记
}

function parseCurrentFocus(content: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const lines = content.split('\n');
  
  let currentSection = '';
  
  for (const line of lines) {
    // 检测 section
    if (line.includes('P0')) currentSection = 'P0';
    else if (line.includes('P1')) currentSection = 'P1';
    else if (line.includes('P2')) currentSection = 'P2';
    
    // 解析任务行
    const match = line.match(/^- \[([ x])\] (.+?)(?: ← 当前)?$/);
    if (match) {
      tasks.push({
        id: hashString(match[2].trim()),
        description: match[2].trim(),
        priority: parseInt(currentSection[1]) as 0 | 1 | 2,
        status: match[1] === 'x' ? 'completed' : 'pending',
        isCurrent: line.includes('← 当前')
      });
    }
  }
  
  return tasks;
}
```

### 3.5 用户接受判断

```typescript
interface UserAcceptanceResult {
  accepted: 0 | 1 | -1;  // 0=未知, 1=接受, -1=拒绝
  feedback?: string;
}

async function detectUserAcceptance(
  sessionId: string,
  sessionFile: string,
  currentFocusPath: string
): Promise<UserAcceptanceResult> {
  // 策略 1: 检查 CURRENT_FOCUS.md 中的任务是否被标记完成
  const focusContent = fs.readFileSync(currentFocusPath, 'utf-8');
  const tasks = parseCurrentFocus(focusContent);
  const hasCompletedTask = tasks.some(t => t.status === 'completed');
  
  // 策略 2: 检查 GFI 是否归零（表示没有遗留问题）
  const session = getSession(sessionId);
  const gfiNormalized = session?.currentGfi === 0;
  
  // 策略 3: 从对话历史中检测用户反馈关键词
  const userMessages = await extractUserMessages(sessionFile);
  const positiveKeywords = ['好的', '谢谢', '完成', '可以', '完美', '搞定'];
  const negativeKeywords = ['不对', '错了', '不是', '重做', '问题'];
  
  let positiveCount = 0;
  let negativeCount = 0;
  
  for (const msg of userMessages.slice(-5)) {
    const text = msg.toLowerCase();
    if (positiveKeywords.some(k => text.includes(k))) positiveCount++;
    if (negativeKeywords.some(k => text.includes(k))) negativeCount++;
  }
  
  // 综合判断
  if (hasCompletedTask && gfiNormalized && positiveCount > negativeCount) {
    return { accepted: 1 };
  } else if (negativeCount > positiveCount || !gfiNormalized) {
    return { accepted: -1 };
  }
  
  return { accepted: 0 };
}
```

---

## 4. 技术实现

### 4.1 文件结构

```
packages/openclaw-plugin/src/
├── core/
│   ├── trajectory-collector.ts   # 新增：数据采集器
│   ├── trajectory-database.ts    # 新增：SQLite 存储层
│   ├── session-tracker.ts        # 修改：集成 GFI 快照
│   └── ...
├── hooks/
│   ├── gate.ts                   # 修改：记录工具调用
│   ├── pain.ts                   # 修改：记录 Pain 事件
│   ├── prompt.ts                 # 修改：会话开始
│   ├── lifecycle.ts              # 修改：会话结束
│   └── ...
└── types/
    └── trajectory-types.ts       # 新增：类型定义
```

### 4.2 核心类设计

#### 4.2.1 TrajectoryCollector

```typescript
// src/core/trajectory-collector.ts

import { TrajectoryDatabase } from './trajectory-database.js';

interface ToolCallRecord {
  sessionId: string;
  task_id?: string;
  timestamp: string;
  toolName: string;
  filePath?: string;
  outcome: 'success' | 'failure' | 'blocked';
  gfiBefore: number;
  gfiAfter?: number;
  errorType?: string;
  errorMessage?: string;
}

interface GfiSnapshotRecord {
  sessionId: string;
  toolCallId?: number;
  timestamp: string;
  gfiValue: number;
  delta: number;
  trigger: string;
  consecutiveErrors: number;
}

interface PainEventRecord {
  sessionId: string;
  task_id?: string;
  timestamp: string;
  score: number;
  source: string;
  severity?: 'mild' | 'moderate' | 'severe';
  reason?: string;
  gfiAtEvent: number;
  origin?: 'assistant_self_report' | 'user_manual' | 'system_infer';
  confidence?: number;
}

/**
 * TrajectoryCollector - 时间轨迹数据采集器
 * 
 * 设计原则：
 * 1. 内存 buffer 减少 IO 开销
 * 2. 定期 flush 到 SQLite
 * 3. 会话结束时强制 flush
 */
export class TrajectoryCollector {
  private db: TrajectoryDatabase;
  private toolCallBuffer: ToolCallRecord[] = [];
  private gfiBuffer: GfiSnapshotRecord[] = [];
  private painBuffer: PainEventRecord[] = [];
  private flushInterval: ReturnType<typeof setInterval>;
  private readonly maxBufferSize = 50;
  
  constructor(stateDir: string) {
    this.db = new TrajectoryDatabase(stateDir);
    this.flushInterval = setInterval(() => this.flush(), 60000); // 每分钟 flush
  }
  
  // ... 方法实现
}
```

#### 4.2.2 TrajectoryDatabase

```typescript
// src/core/trajectory-database.ts

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

/**
 * TrajectoryDatabase - SQLite 存储层
 * 
 * 使用 better-sqlite3（同步 API，性能好）
 */
export class TrajectoryDatabase {
  private db: Database.Database;
  
  constructor(stateDir: string) {
    const dbPath = path.join(stateDir, 'trajectory.db');
    this.db = new Database(dbPath);
    
    // 启用 WAL 模式提升并发性能
    this.db.pragma('journal_mode = WAL');
    
    this.initTables();
  }
  
  private initTables(): void {
    // 创建所有表（见 2.2 节）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        started_at DATETIME NOT NULL,
        ended_at DATETIME,
        final_status TEXT,
        gfi_peak REAL DEFAULT 0,
        gfi_final REAL DEFAULT 0,
        tool_calls_count INTEGER DEFAULT 0,
        pain_events_count INTEGER DEFAULT 0,
        user_accepted INTEGER DEFAULT 0,
        user_feedback TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );
      
      -- ... 其他表 ...
    `);
  }
  
  // CRUD 方法
  insertSession(session: SessionRecord): void { ... }
  insertToolCalls(calls: ToolCallRecord[]): void { ... }
  insertGfiSnapshots(snapshots: GfiSnapshotRecord[]): void { ... }
  insertPainEvents(events: PainEventRecord[]): void { ... }
  
  // 查询方法
  getSessionTimeline(sessionId: string): SessionTimeline { ... }
  getGfiTrend(sessionId: string, hours: number): GfiDataPoint[] { ... }
  getToolCallStats(days: number): ToolCallStats { ... }
}
```

### 4.3 依赖

```json
{
  "dependencies": {
    "better-sqlite3": "^9.4.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.8"
  }
}
```

---

## 5. 查询与分析接口

### 5.1 常用查询

#### 5.1.1 获取会话时间线

```sql
-- 获取单个会话的完整时间线
SELECT 
  'tool_call' as type,
  timestamp,
  tool_name as detail,
  outcome,
  gfi_after as gfi
FROM tool_calls
WHERE session_id = ?
UNION ALL
SELECT 
  'pain_signal' as type,
  timestamp,
  source as detail,
  severity as outcome,
  gfi_at_event as gfi
FROM pain_events
WHERE session_id = ?
UNION ALL
SELECT 
  'gfi_change' as type,
  timestamp,
  trigger as detail,
  NULL as outcome,
  gfi_value as gfi
FROM gfi_snapshots
WHERE session_id = ?
ORDER BY timestamp;
```

#### 5.1.2 GFI 趋势分析

```sql
-- 按小时聚合的 GFI 趋势
SELECT 
  strftime('%Y-%m-%d %H:00', timestamp) as hour,
  AVG(gfi_value) as avg_gfi,
  MAX(gfi_value) as max_gfi,
  COUNT(*) as samples
FROM gfi_snapshots
WHERE timestamp > datetime('now', '-7 days')
GROUP BY hour
ORDER BY hour;
```

#### 5.1.3 工具成功率

```sql
-- 按工具统计成功率
SELECT 
  tool_name,
  COUNT(*) as total,
  SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as success,
  ROUND(100.0 * SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) / COUNT(*), 2) as success_rate,
  AVG(gfi_delta) as avg_gfi_impact
FROM tool_calls
WHERE timestamp > datetime('now', '-30 days')
GROUP BY tool_name
ORDER BY total DESC;
```

#### 5.1.4 任务完成分析

```sql
-- 任务完成率与 GFI 关联
SELECT 
  t.priority,
  COUNT(*) as total_tasks,
  SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) as completed,
  AVG(t.gfi_at_end) as avg_final_gfi,
  AVG(t.tool_calls_count) as avg_tools_per_task
FROM tasks t
JOIN sessions s ON t.session_id = s.id
WHERE t.started_at > datetime('now', '-30 days')
GROUP BY t.priority;
```

### 5.2 分析 API

```typescript
// src/core/trajectory-analyzer.ts

export class TrajectoryAnalyzer {
  constructor(private db: TrajectoryDatabase) {}
  
  /**
   * 获取 GFI 趋势数据（用于可视化）
   */
  getGfiTrend(hours: number = 24): GfiTrendData {
    return this.db.query(/* ... */);
  }
  
  /**
   * 分析任务成功率与 GFI 的相关性
   */
  analyzeTaskSuccessCorrelation(): CorrelationResult {
    // 分析高 GFI 会话的任务完成率 vs 低 GFI 会话
  }
  
  /**
   * 识别高频失败工具
   */
  identifyProblematicTools(): ProblematicTool[] {
    // 找出失败率高且 GFI 影响大的工具
  }
  
  /**
   * 导出数据用于建模
   */
  exportForModeling(format: 'csv' | 'json'): string {
    // 导出清洗后的数据
  }
}
```

---

## 6. 可视化方案

### 6.1 可选方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| **内置命令** `/trajectory` | 无需外部依赖 | 文本输出，可视化有限 |
| **导出 + Grafana** | 功能强大 | 需要额外部署 |
| **静态 HTML 报告** | 便于分享 | 需要生成步骤 |
| **Jupyter Notebook** | 灵活分析 | 需要 Python 环境 |

### 6.2 推荐方案：内置命令 + HTML 导出

```typescript
// 新增命令：/trajectory

// /trajectory           - 显示最近 24 小时概览
// /trajectory --week    - 显示最近 7 天趋势
// /trajectory --export  - 导出 HTML 报告
// /trajectory --session <id> - 查看特定会话详情
```

#### 输出示例

```
📊 Agent Trajectory Report (Last 24h)

┌─ Sessions ─────────────────────────────────────────┐
│ Total: 5 | Completed: 3 | Abandoned: 1 | Active: 1 │
└────────────────────────────────────────────────────┘

┌─ GFI Trend ────────────────────────────────────────┐
│                                                    │
│ 100 ┤                                              │
│  80 ┤      ▓▓                                      │
│  60 ┤      ▓▓  ▓▓                                  │
│  40 ┤  ▓▓  ▓▓  ▓▓  ▓▓                              │
│  20 ┤  ▓▓  ▓▓  ▓▓  ▓▓  ▓▓                          │
│   0 ┼───────────────────────────────────────────   │
│     00:00  06:00  12:00  18:00  24:00              │
│                                                    │
│ Peak: 85 | Avg: 23 | Current: 0                    │
└────────────────────────────────────────────────────┘

┌─ Tool Calls ───────────────────────────────────────┐
│ Tool          Total   Success  Fail   Impact      │
│ read_file        45      43      2    +2.3        │
│ replace          12      10      2   +15.0        │
│ run_shell        23      20      3    +8.5        │
└────────────────────────────────────────────────────┘

┌─ Pain Events ──────────────────────────────────────┐
│ Severity   Count   Avg Score   Top Source         │
│ severe        1       100      user_manual        │
│ moderate      2        45      tool_failure       │
│ mild          0         0      -                  │
└────────────────────────────────────────────────────┘
```

---

## 7. 数据保留策略

### 7.1 默认策略

| 数据类型 | 保留期限 | 压缩策略 |
|----------|----------|----------|
| tool_calls | 90 天 | 超期删除 |
| gfi_snapshots | 30 天 | 超期按小时聚合 |
| pain_events | 永久 | 无压缩 |
| sessions | 永久 | 无压缩 |

### 7.2 清理任务

```typescript
// 定期清理任务（在 Cron 或 heartbeat 中执行）
async function cleanupOldData(db: TrajectoryDatabase): Promise<void> {
  // 删除 90 天前的工具调用
  db.exec(`
    DELETE FROM tool_calls 
    WHERE timestamp < datetime('now', '-90 days')
  `);
  
  // 聚合 30 天前的 GFI 快照
  db.exec(`
    INSERT OR REPLACE INTO gfi_hourly_agg (hour, avg_gfi, max_gfi, samples)
    SELECT 
      strftime('%Y-%m-%d %H:00', timestamp) as hour,
      AVG(gfi_value),
      MAX(gfi_value),
      COUNT(*)
    FROM gfi_snapshots
    WHERE timestamp < datetime('now', '-30 days')
    GROUP BY hour;
    
    DELETE FROM gfi_snapshots 
    WHERE timestamp < datetime('now', '-30 days')
  `);
}
```

---

## 8. 实施计划

### Phase 1: 基础设施 (Day 1-2)

- [ ] 安装 `better-sqlite3` 依赖
- [ ] 实现 `TrajectoryDatabase` 类
- [ ] 实现 `TrajectoryCollector` 类
- [ ] 添加类型定义

### Phase 2: Hook 集成 (Day 3-4)

- [ ] 修改 `gate.ts` 记录工具调用
- [ ] 修改 `session-tracker.ts` 记录 GFI 快照
- [ ] 修改 `pain.ts` 记录 Pain 事件
- [ ] 修改 `lifecycle.ts` 处理会话结束

### Phase 3: 任务关联 (Day 5)

- [ ] 实现 `CURRENT_FOCUS.md` 解析
- [ ] 实现用户接受判断逻辑
- [ ] 集成任务-工具调用关联

### Phase 4: 查询与可视化 (Day 6-7)

- [ ] 实现 `/trajectory` 命令
- [ ] 实现 HTML 报告导出
- [ ] 添加常用查询 API

### Phase 5: 测试与文档 (Day 8)

- [ ] 单元测试
- [ ] 集成测试
- [ ] 更新文档

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| SQLite 文件损坏 | 数据丢失 | 定期备份 + WAL 模式 |
| 性能开销 | 影响用户体验 | 内存 buffer + 批量写入 |
| 磁盘空间 | 存储不足 | 自动清理 + 聚合压缩 |
| 隐私问题 | 敏感数据泄露 | 本地存储 + 不上传 |

---

## 10. 附录

### 10.1 数据字典

完整的数据字典见 `src/types/trajectory-types.ts`

### 10.2 API 参考

完整 API 参考见实现后的 TSDoc 文档

### 10.3 迁移指南

从现有的 `events.jsonl` 迁移：

```typescript
async function migrateFromJsonl(jsonlPath: string, db: TrajectoryDatabase): Promise<void> {
  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = content.trim().split('\n');
  
  for (const line of lines) {
    const event = JSON.parse(line);
    // 根据 event.type 分发到不同的 insert 方法
  }
}
```
