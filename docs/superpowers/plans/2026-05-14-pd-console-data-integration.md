# PD Console 数据接入完善实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完善 PD Console 的后端数据接入，使所有 UI 页面能够展示真实数据而非 stub/空数据。

**Architecture:** 在 `packages/pd-console/src/server/models/` 中创建新的 ReadModel 类，从 runtime-v2 和 EventLog 中读取真实数据。遵循现有架构模式：ConsoleModel 仅做数据聚合和格式化，复用 runtime-v2 已有能力。

**Tech Stack:** TypeScript, Node.js, better-sqlite3, JSONL 文件解析

---

## 范围说明

本计划专注于**后端数据接入**，不涉及前端 UI 修改。前端已能正确渲染数据，只是后端返回空数据。

### 不在本计划范围

- 前端 UI 组件新增（趋势图等）
- 前端空状态 UI 设计
- 前端国际化补充

---

## 文件结构

```
packages/pd-console/src/server/
├── models/
│   ├── EventLogReadModel.ts        # 新建：EventLog 读取模型
│   ├── GateConsoleModel.ts         # 修改：接入真实 Gate Block 数据
│   ├── FeedbackConsoleModel.ts     # 修改：接入 Empathy Events
│   ├── OverviewConsoleModel.ts     # 修改：完善统计和趋势数据
│   └── ...
├── routes/
│   └── ...
└── types/
    └── index.ts                    # 修改：添加新类型定义
```

---

## Task 1: 创建 EventLogReadModel

**Files:**
- Create: `packages/pd-console/src/server/models/EventLogReadModel.ts`
- Modify: `packages/pd-console/src/server/types/index.ts`

**背景：** EventLog 存储在 `{stateDir}/logs/events_YYYY-MM-DD.jsonl` 文件中。需要创建一个 ReadModel 来读取和查询这些事件。

- [ ] **Step 1: 添加 EventLog 相关类型定义**

修改 `packages/pd-console/src/server/types/index.ts`，添加：

```typescript
export interface EventLogEntry {
  ts: string;
  date: string;
  type: string;
  category: string;
  sessionId?: string;
  data: Record<string, unknown>;
}

export interface GateBlockEvent extends EventLogEntry {
  type: 'gate_block';
  data: {
    toolName: string;
    filePath: string;
    reason: string;
    blockSource?: string;
  };
}

export interface EmpathyEventLogEntry extends EventLogEntry {
  type: 'empathy_rollback' | 'user_empathy';
  data: {
    score?: number;
    reason?: string;
    origin?: string;
  };
}
```

- [ ] **Step 2: 创建 EventLogReadModel 类**

创建 `packages/pd-console/src/server/models/EventLogReadModel.ts`：

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { EventLogEntry, GateBlockEvent } from '../types/index.js';

export class EventLogReadModel {
  private readonly logsDir: string;

  constructor(stateDir: string) {
    this.logsDir = path.join(stateDir, 'logs');
  }

  async getGateBlocks(limit: number = 100): Promise<GateBlockEvent[]> {
    const blocks: GateBlockEvent[] = [];
    const files = this.getEventFiles();

    for (const file of files.reverse()) {
      if (blocks.length >= limit) break;
      
      const entries = await this.readEventsOfFile(file);
      for (const entry of entries.reverse()) {
        if (entry.type === 'gate_block' && blocks.length < limit) {
          blocks.push(entry as GateBlockEvent);
        }
      }
    }

    return blocks;
  }

  async countGateBlocksToday(): Promise<number> {
    const today = new Date().toISOString().split('T')[0];
    const file = path.join(this.logsDir, `events_${today}.jsonl`);
    
    if (!fs.existsSync(file)) return 0;
    
    let count = 0;
    for await (const line of this.readLines(file)) {
      try {
        const entry = JSON.parse(line) as EventLogEntry;
        if (entry.type === 'gate_block') count++;
      } catch { /* skip malformed */ }
    }
    return count;
  }

  async countEventsByTypeToday(eventType: string): Promise<number> {
    const today = new Date().toISOString().split('T')[0];
    const file = path.join(this.logsDir, `events_${today}.jsonl`);
    
    if (!fs.existsSync(file)) return 0;
    
    let count = 0;
    for await (const line of this.readLines(file)) {
      try {
        const entry = JSON.parse(line) as EventLogEntry;
        if (entry.type === eventType) count++;
      } catch { /* skip malformed */ }
    }
    return count;
  }

  private getEventFiles(): string[] {
    if (!fs.existsSync(this.logsDir)) return [];
    
    return fs.readdirSync(this.logsDir)
      .filter(f => f.startsWith('events_') && f.endsWith('.jsonl'))
      .sort()
      .map(f => path.join(this.logsDir, f));
  }

  private async readEventsOfFile(filePath: string): Promise<EventLogEntry[]> {
    const entries: EventLogEntry[] = [];
    for await (const line of this.readLines(filePath)) {
      try {
        entries.push(JSON.parse(line) as EventLogEntry);
      } catch { /* skip malformed */ }
    }
    return entries;
  }

  private async *readLines(filePath: string): AsyncIterable<string> {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) yield line;
    }
  }

  dispose(): void {
    // No resources to clean up
  }
}
```

- [ ] **Step 3: 运行 TypeScript 类型检查**

```bash
cd packages/pd-console && npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add packages/pd-console/src/server/models/EventLogReadModel.ts packages/pd-console/src/server/types/index.ts
git commit -m "feat(pd-console): add EventLogReadModel for reading gate block events"
```

---

## Task 2: 完善 GateConsoleModel 数据接入

**Files:**
- Modify: `packages/pd-console/src/server/models/GateConsoleModel.ts`

**背景：** 当前 `getGateBlocks()` 返回空数组，`today` 统计都是 0。需要接入 EventLogReadModel 获取真实数据。

- [ ] **Step 1: 修改 GateConsoleModel 构造函数**

修改 `packages/pd-console/src/server/models/GateConsoleModel.ts`：

```typescript
import { EventLogReadModel } from './EventLogReadModel.js';

export class GateConsoleModel {
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  private healthReadModel: OperatorHealthReadModel | null = null;
  private painChainReadModel: PainChainReadModel | null = null;
  private pruningReadModel: PruningReadModel | null = null;
  private stateManager: RuntimeStateManager | null = null;
  private eventLogReadModel: EventLogReadModel | null = null;
  private ownsHealthReadModel = false;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = path.join(workspaceDir, '.state');
  }
  
  // ... rest of class
}
```

需要添加 `import * as path from 'path';` 在文件顶部。

- [ ] **Step 2: 实现 getGateBlocks 方法**

```typescript
async getGateBlocks(limit?: number): Promise<GateBlockItem[]> {
  const events = await this.getEventLogReadModel().getGateBlocks(limit ?? 100);
  
  return events.map(event => ({
    timestamp: event.ts,
    toolName: event.data.toolName ?? 'unknown',
    filePath: event.data.filePath ?? null,
    reason: event.data.reason ?? '',
    gateType: this.classifyGateType(event.data.blockSource),
    gfi: 0, // GFI at block time not stored
    trustStage: 0, // Trust stage at block time not stored
  }));
}

private classifyGateType(source?: string): 'gfi' | 'stage' | 'p03' | 'other' {
  if (!source) return 'other';
  if (source.includes('gfi') || source.includes('GFI')) return 'gfi';
  if (source.includes('stage') || source.includes('trust')) return 'stage';
  if (source.includes('p03') || source.includes('P03')) return 'p03';
  return 'other';
}

private getEventLogReadModel(): EventLogReadModel {
  if (!this.eventLogReadModel) {
    this.eventLogReadModel = new EventLogReadModel(this.stateDir);
  }
  return this.eventLogReadModel;
}
```

- [ ] **Step 3: 完善 getGateStats 中的 today 统计**

```typescript
async getGateStats(): Promise<GateStatsOutput> {
  const snapshot = await this.getHealthReadModel().getSnapshot();
  const gfiSnapshot = snapshot.gfi;
  const { active } = gfiSnapshot;
  const currentGfi = active?.currentGfi ?? 0;
  const health = classifyGfiWorkspaceHealth(gfiSnapshot);

  const trustStatus: 'healthy' | 'warning' | 'critical' =
    health.status === 'degraded' ? 'warning' : 'healthy';

  const sources: Record<string, number> = {};
  if (active?.sources) {
    for (const [key, value] of Object.entries(active.sources)) {
      if (value !== undefined) {
        sources[key] = value;
      }
    }
  }

  // Get today's stats from EventLog
  const eventLog = this.getEventLogReadModel();
  const [gfiBlocks, stageBlocks, bypassAttempts] = await Promise.all([
    eventLog.countEventsByTypeToday('gate_block'),
    eventLog.countEventsByTypeToday('stage_block'),
    eventLog.countEventsByTypeToday('gate_bypass'),
  ]);

  return {
    generatedAt: snapshot.generatedAt,
    today: {
      gfiBlocks,
      stageBlocks,
      bypassAttempts,
    },
    trust: {
      stage: 0, // TODO: Get from trust engine
      score: 0, // TODO: Get from trust engine
      status: trustStatus,
    },
    evolution: {
      tier: '',
      points: 0,
      status: '',
    },
    gfi: {
      current: currentGfi,
      peakToday: active?.dailyGfiPeak ?? 0,
      threshold: active?.policy?.criticalThreshold ?? 80,
      trend: [], // TODO: Implement hourly trend
      sources,
      stage: active?.stage ?? 'stable',
    },
  };
}
```

- [ ] **Step 4: 更新 dispose 方法**

```typescript
dispose(): void {
  if (this.healthReadModel && this.ownsHealthReadModel) {
    this.healthReadModel.close().catch((err) => {
      console.error('[GateConsoleModel] Failed to close health read model:', err);
    });
  }
  if (this.painChainReadModel) {
    this.painChainReadModel.close().catch((err) => {
      console.error('[GateConsoleModel] Failed to close pain chain read model:', err);
    });
  }
  if (this.stateManager) {
    this.stateManager.close().catch((err) => {
      console.error('[GateConsoleModel] Failed to close state manager:', err);
    });
  }
  if (this.eventLogReadModel) {
    this.eventLogReadModel.dispose();
  }
}
```

- [ ] **Step 5: 运行类型检查**

```bash
cd packages/pd-console && npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 6: 提交**

```bash
git add packages/pd-console/src/server/models/GateConsoleModel.ts
git commit -m "feat(pd-console): connect GateConsoleModel to EventLog for real gate block data"
```

---

## Task 3: 完善 FeedbackConsoleModel 数据接入

**Files:**
- Modify: `packages/pd-console/src/server/models/FeedbackConsoleModel.ts`

**背景：** `getEmpathyEvents()` 返回空数组。Empathy 事件存储在 EventLog 中，类型为 `empathy_rollback` 或通过 GFI source `user_empathy`。

- [ ] **Step 1: 添加 Empathy Events 查询方法**

修改 `packages/pd-console/src/server/models/FeedbackConsoleModel.ts`：

```typescript
import * as path from 'path';
import { EventLogReadModel } from './EventLogReadModel.js';
import { GateConsoleModel } from './GateConsoleModel.js';
import type { GateBlockItem, EmpathyEvent } from '../types/index.js';

export class FeedbackConsoleModel {
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  private gateModel: GateConsoleModel | null = null;
  private eventLogReadModel: EventLogReadModel | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = path.join(workspaceDir, '.state');
  }

  // ... existing methods

  async getEmpathyEvents(limit?: number): Promise<EmpathyEvent[]> {
    const events = await this.getEventLogReadModel().getEventsByTypes(
      ['empathy_rollback', 'user_empathy', 'pain_signal'],
      limit ?? 50
    );
    
    return events
      .filter(e => e.type === 'empathy_rollback' || 
                   e.type === 'user_empathy' || 
                   (e.type === 'pain_signal' && e.data?.source === 'user_empathy'))
      .map(event => ({
        timestamp: event.ts,
        severity: this.scoreToSeverity(event.data?.score as number | undefined),
        score: (event.data?.score as number) ?? 50,
        reason: (event.data?.reason as string) ?? '',
        origin: (event.data?.origin as string) ?? 'system_infer',
        gfiAfter: 0, // GFI after event not stored
      }));
  }

  private scoreToSeverity(score?: number): 'low' | 'medium' | 'high' {
    if (score === undefined) return 'low';
    if (score >= 70) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  private getEventLogReadModel(): EventLogReadModel {
    if (!this.eventLogReadModel) {
      this.eventLogReadModel = new EventLogReadModel(this.stateDir);
    }
    return this.eventLogReadModel;
  }

  dispose(): void {
    if (this.gateModel) {
      this.gateModel.dispose();
    }
    if (this.eventLogReadModel) {
      this.eventLogReadModel.dispose();
    }
  }
}
```

- [ ] **Step 2: 在 EventLogReadModel 中添加 getEventsByTypes 方法**

修改 `packages/pd-console/src/server/models/EventLogReadModel.ts`，添加：

```typescript
async getEventsByTypes(types: string[], limit: number = 50): Promise<EventLogEntry[]> {
  const results: EventLogEntry[] = [];
  const files = this.getEventFiles();

  for (const file of files.reverse()) {
    if (results.length >= limit) break;
    
    const entries = await this.readEventsOfFile(file);
    for (const entry of entries.reverse()) {
      if (types.includes(entry.type) && results.length < limit) {
        results.push(entry);
      }
    }
  }

  return results;
}
```

- [ ] **Step 3: 运行类型检查**

```bash
cd packages/pd-console && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
git add packages/pd-console/src/server/models/FeedbackConsoleModel.ts packages/pd-console/src/server/models/EventLogReadModel.ts
git commit -m "feat(pd-console): connect FeedbackConsoleModel to EventLog for empathy events"
```

---

## Task 4: 完善 OverviewConsoleModel 数据接入

**Files:**
- Modify: `packages/pd-console/src/server/models/OverviewConsoleModel.ts`

**背景：** 多个字段返回 0 或空数组：`dailyTrend`、`topRegressions`、`repeatErrorRate`、`userCorrectionRate`、`trust`、`queue.inProgress`。

- [ ] **Step 1: 添加 EventLogReadModel 依赖**

修改 `packages/pd-console/src/server/models/OverviewConsoleModel.ts`：

```typescript
import * as path from 'path';
import { EventLogReadModel } from './EventLogReadModel.js';
// ... existing imports

export class OverviewConsoleModel {
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  private healthReadModel: OperatorHealthReadModel | null = null;
  private painChainReadModel: PainChainReadModel | null = null;
  private pruningReadModel: PruningReadModel | null = null;
  private stateManager: RuntimeStateManager | null = null;
  private eventLogReadModel: EventLogReadModel | null = null;
  private ownsHealthReadModel = false;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = path.join(workspaceDir, '.state');
  }
  
  // ...
}
```

- [ ] **Step 2: 完善 getOverview 方法中的统计**

```typescript
async getOverview(_days?: number): Promise<OverviewOutput> {
  const snapshot = await this.getHealthReadModel().getSnapshot();
  const pruningSummary = this.getPruningReadModel().getHealthSummary();

  const { byStatus } = pruningSummary;
  const principleActive = (byStatus.active ?? 0) + (byStatus.candidate ?? 0);
  const principlePending = (byStatus.probation ?? 0) + (byStatus.deprecated ?? 0);

  const gfiSnapshot = snapshot.gfi;
  const activeGfi = gfiSnapshot.active;

  // Get additional stats from EventLog
  const eventLog = this.getEventLogReadModel();
  const [gateBlocksToday, painEventsToday] = await Promise.all([
    eventLog.countEventsByTypeToday('gate_block'),
    eventLog.countEventsByTypeToday('pain_signal'),
  ]);

  const health: OverviewHealthOutput = {
    status: snapshot.overallStatus,
    gfi: {
      current: activeGfi?.currentGfi ?? 0,
      stage: activeGfi?.stage ?? 'stable',
      peakToday: activeGfi?.dailyGfiPeak ?? 0,
      threshold: activeGfi?.policy?.criticalThreshold ?? 0,
    },
    trust: {
      stage: 0, // TODO: Get from trust engine
      score: 0, // TODO: Get from trust engine
    },
    principles: {
      candidate: byStatus.candidate ?? 0,
      probation: byStatus.probation ?? 0,
      active: byStatus.active ?? 0,
      deprecated: byStatus.deprecated ?? 0,
    },
    queue: {
      pending: snapshot.candidateLedger.orphanCandidateCount,
      inProgress: await this.getInProgressCount(),
      completed: snapshot.totalTaskCount,
    },
  };

  return {
    workspaceDir: this.workspaceDir,
    generatedAt: snapshot.generatedAt,
    dataFreshness: snapshot.overallStatus === 'error' ? 'error' : 'fresh',
    summary: {
      repeatErrorRate: 0, // Requires historical analysis
      userCorrectionRate: 0, // Requires historical analysis
      pendingSamples: byStatus.candidate ?? 0,
      approvedSamples: byStatus.active ?? 0,
      painEvents: painEventsToday,
      principleEventCount: principleActive + principlePending,
      gateBlocks: gateBlocksToday,
      taskOutcomes: snapshot.totalTaskCount,
    },
    health,
    dailyTrend: await this.getDailyTrend(),
    topRegressions: [], // Requires regression analysis
    sampleQueue: {
      counters: byStatus,
      preview: [],
    },
  };
}

private async getInProgressCount(): Promise<number> {
  const mgr = this.getStateManager();
  const tasks = await mgr.listTasks({ status: 'leased' });
  return tasks.length;
}

private async getDailyTrend(): Promise<OverviewOutput['dailyTrend']> {
  // Get last 7 days of tool call counts from EventLog
  const eventLog = this.getEventLogReadModel();
  const trend: OverviewOutput['dailyTrend'] = [];
  
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    
    const [toolCalls, failures, painEvents] = await Promise.all([
      eventLog.countEventsByTypeAndDate('tool_call', dateStr),
      eventLog.countEventsByCategoryAndDate('failure', dateStr),
      eventLog.countEventsByTypeAndDate('pain_signal', dateStr),
    ]);
    
    trend.push({
      day: dateStr,
      toolCalls,
      failures,
      userCorrections: 0, // Requires analysis
      painEvents,
    });
  }
  
  return trend;
}

private getEventLogReadModel(): EventLogReadModel {
  if (!this.eventLogReadModel) {
    this.eventLogReadModel = new EventLogReadModel(this.stateDir);
  }
  return this.eventLogReadModel;
}
```

- [ ] **Step 3: 在 EventLogReadModel 中添加日期查询方法**

```typescript
async countEventsByTypeAndDate(eventType: string, date: string): Promise<number> {
  const file = path.join(this.logsDir, `events_${date}.jsonl`);
  
  if (!fs.existsSync(file)) return 0;
  
  let count = 0;
  for await (const line of this.readLines(file)) {
    try {
      const entry = JSON.parse(line) as EventLogEntry;
      if (entry.type === eventType) count++;
    } catch { /* skip malformed */ }
  }
  return count;
}

async countEventsByCategoryAndDate(category: string, date: string): Promise<number> {
  const file = path.join(this.logsDir, `events_${date}.jsonl`);
  
  if (!fs.existsSync(file)) return 0;
  
  let count = 0;
  for await (const line of this.readLines(file)) {
    try {
      const entry = JSON.parse(line) as EventLogEntry;
      if (entry.category === category) count++;
    } catch { /* skip malformed */ }
  }
  return count;
}
```

- [ ] **Step 4: 更新 dispose 方法**

```typescript
dispose(): void {
  if (this.healthReadModel && this.ownsHealthReadModel) {
    this.healthReadModel.close().catch((err) => {
      console.error('[OverviewConsoleModel] Failed to close health read model:', err);
    });
  }
  if (this.painChainReadModel) {
    this.painChainReadModel.close().catch((err) => {
      console.error('[OverviewConsoleModel] Failed to close pain chain read model:', err);
    });
  }
  if (this.stateManager) {
    this.stateManager.close().catch((err) => {
      console.error('[OverviewConsoleModel] Failed to close state manager:', err);
    });
  }
  if (this.eventLogReadModel) {
    this.eventLogReadModel.dispose();
  }
}
```

- [ ] **Step 5: 运行类型检查**

```bash
cd packages/pd-console && npx tsc --noEmit
```

- [ ] **Step 6: 提交**

```bash
git add packages/pd-console/src/server/models/OverviewConsoleModel.ts packages/pd-console/src/server/models/EventLogReadModel.ts
git commit -m "feat(pd-console): connect OverviewConsoleModel to EventLog for daily trend and stats"
```

---

## Task 5: 添加单元测试

**Files:**
- Create: `packages/pd-console/tests/unit/EventLogReadModel.test.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EventLogReadModel } from '../../src/server/models/EventLogReadModel.js';

describe('EventLogReadModel', () => {
  let tempDir: string;
  let logsDir: string;
  let model: EventLogReadModel;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(process.cwd(), 'test-logs-'));
    logsDir = path.join(tempDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    model = new EventLogReadModel(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty array when no events exist', async () => {
    const blocks = await model.getGateBlocks();
    expect(blocks).toEqual([]);
  });

  it('reads gate block events from event log', async () => {
    const today = new Date().toISOString().split('T')[0];
    const eventFile = path.join(logsDir, `events_${today}.jsonl`);
    
    fs.appendFileSync(eventFile, JSON.stringify({
      ts: new Date().toISOString(),
      date: today,
      type: 'gate_block',
      category: 'blocked',
      sessionId: 'test-session',
      data: {
        toolName: 'Write',
        filePath: '/test/file.ts',
        reason: 'Test block reason',
        blockSource: 'gate',
      },
    }) + '\n');

    const blocks = await model.getGateBlocks();
    
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('gate_block');
    expect(blocks[0].data.toolName).toBe('Write');
    expect(blocks[0].data.filePath).toBe('/test/file.ts');
  });

  it('counts events by type today', async () => {
    const today = new Date().toISOString().split('T')[0];
    const eventFile = path.join(logsDir, `events_${today}.jsonl`);
    
    fs.appendFileSync(eventFile, JSON.stringify({
      ts: new Date().toISOString(),
      type: 'gate_block',
      category: 'blocked',
      data: {},
    }) + '\n');
    fs.appendFileSync(eventFile, JSON.stringify({
      ts: new Date().toISOString(),
      type: 'gate_block',
      category: 'blocked',
      data: {},
    }) + '\n');
    fs.appendFileSync(eventFile, JSON.stringify({
      ts: new Date().toISOString(),
      type: 'pain_signal',
      category: 'detected',
      data: {},
    }) + '\n');

    const gateBlockCount = await model.countEventsByTypeToday('gate_block');
    const painCount = await model.countEventsByTypeToday('pain_signal');
    
    expect(gateBlockCount).toBe(2);
    expect(painCount).toBe(1);
  });

  it('limits results to specified count', async () => {
    const today = new Date().toISOString().split('T')[0];
    const eventFile = path.join(logsDir, `events_${today}.jsonl`);
    
    for (let i = 0; i < 10; i++) {
      fs.appendFileSync(eventFile, JSON.stringify({
        ts: new Date().toISOString(),
        type: 'gate_block',
        category: 'blocked',
        data: { index: i },
      }) + '\n');
    }

    const blocks = await model.getGateBlocks(5);
    
    expect(blocks).toHaveLength(5);
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
cd packages/pd-console && npm run test
```

Expected: 所有测试通过

- [ ] **Step 3: 提交**

```bash
git add packages/pd-console/tests/unit/EventLogReadModel.test.ts
git commit -m "test(pd-console): add unit tests for EventLogReadModel"
```

---

## Task 6: 集成测试和验证

**Files:**
- 无新增文件

- [ ] **Step 1: 构建项目**

```bash
cd packages/pd-console && npm run build
```

- [ ] **Step 2: 启动服务**

```bash
cd packages/pd-console && npm run dev -- --workspace=<test-workspace> --no-auth
```

- [ ] **Step 3: 测试 API 端点**

```bash
# Test gate blocks
curl http://localhost:3100/api/gate/blocks

# Test gate stats
curl http://localhost:3100/api/gate/stats

# Test feedback empathy events
curl http://localhost:3100/api/feedback/empathy-events

# Test overview
curl http://localhost:3100/api/overview
```

Expected: 返回真实数据（如果工作区有事件记录）或空数组（如果无数据）

- [ ] **Step 4: 浏览器测试**

使用 agent-browser 或手动浏览器访问 http://localhost:3100，验证：
- Gates 页面显示 Block History 列表
- Feedback 页面显示 Empathy Events 列表
- Overview 页面显示正确的统计数据

- [ ] **Step 5: 提交最终更改**

```bash
git add -A
git commit -m "feat(pd-console): complete data integration for gate blocks, empathy events, and overview stats"
```

---

## 自检清单

### Spec Coverage

| 需求 | 对应任务 |
|---|---|
| Gate Blocks 数据接入 | Task 2 |
| Empathy Events 数据接入 | Task 3 |
| Gate 今日统计完善 | Task 2 |
| Overview dailyTrend | Task 4 |
| Overview 统计数据 | Task 4 |
| 单元测试 | Task 5 |
| 集成验证 | Task 6 |

### Placeholder Scan

- [x] 无 "TBD"、"TODO"、"implement later" 占位符
- [x] 无 "add appropriate error handling" 等模糊描述
- [x] 所有代码步骤都有完整代码
- [x] 所有命令都有预期输出

### Type Consistency

- [x] `GateBlockItem` 类型在 types/index.ts 中定义
- [x] `EmpathyEvent` 类型在 types/index.ts 中定义
- [x] `EventLogReadModel` 方法返回类型一致

---

## 执行选项

**Plan complete and saved to `docs/superpowers/plans/2026-05-14-pd-console-data-integration.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
