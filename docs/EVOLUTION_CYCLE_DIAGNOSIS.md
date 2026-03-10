# 进化循环诊断报告

> **项目**: Principles Disciple (v1.4.0)  
> **分析日期**: 2026-03-10  
> **工作目录**: /home/csuzngjh/clawd  
> **插件源码**: /home/csuzngjh/code/principles/packages/openclaw-plugin

---

## 📋 执行摘要

**结论**: 进化循环存在严重 BUG — 痛苦信号可以被检测并入队，但**从未真正执行**。任务永久卡在 `pending` 状态，导致重复入队和日志 spam。

| 组件 | 状态 | 说明 |
|------|------|------|
| Pain Signal Detection | ✅ 正常 | events.jsonl 记录了大量 pain_signal 事件 |
| Evolution Queue | ⚠️ 异常 | 任务永久 pending，从未完成 |
| Evolution Worker | ⚠️ 异常 | 重复处理同一任务，每 15 分钟 spam 一次 |
| Prompt Injection | ✅ 正常 | directive 正确注入到 prompt |
| Agent Execution | ❌ 失败 | Agent 未执行 /evolve-task |

---

## 🔍 详细发现

### 1. 当前队列状态

**文件**: `/home/csuzngjh/clawd/docs/evolution_queue.json`

```json
[
  {
    "id": "evt-1773072949829",
    "source": "unknown",
    "score": 70,
    "reason": "Tool edit failed on docs/delphi/phase2/tracking.md. Error: Could not find the exact text...",
    "timestamp": "2026-03-09T16:15:49.829Z",
    "status": "pending"
  },
  {
    "id": "evt-1773099949980", 
    "source": "unknown",
    "score": 70,
    "reason": "Tool edit failed on docs/delphi-v2/phase1/tracking.md...",
    "timestamp": "2026-03-09T23:45:49.980Z",
    "status": "pending"
  }
]
```

**观察**: 两个任务均处于 `pending` 状态，从未被处理。

---

### 2. 痛苦信号记录

**文件**: `/home/csuzngjh/clawd/docs/.pain_flag`

```
is_risky: false
reason: Tool edit failed on docs/delphi-v2/phase1/tracking.md. Error: Could not find the exact text in /home/csuzngjh/clawd/docs/delphi-v2/phase1/tracking.md. The old text must match exactly including all whitespace and newlines.
score: 70
time: 2026-03-09T23:37:55.222Z
status: queued
```

---

### 3. 系统日志证据

**文件**: `/home/csuzngjh/clawd/docs/SYSTEM.log`

关键事件时间线:

```
2026-03-09T16:14:12 - Pain Signal detected (score: 70)
2026-03-09T16:15:49 - Evolution task enqueued (evt-1773072949829)
2026-03-09T16:30:49 - 重复入队 (每 15 分钟)
2026-03-09T17:00:49 - 重复入队
2026-03-09T17:30:49 - 重复入队
... (持续到 2026-03-10)
2026-03-09T23:37:55 - 第二次 Pain Signal detected (score: 70)
2026-03-09T23:45:49 - 第二个任务入队 (evt-1773099949980)
```

---

### 4. 事件日志分析

**文件**: `/home/csuzngjh/clawd/memory/.state/logs/events.jsonl`

#### 4.1 Pain Signal 被正确检测

```json
{"ts":"2026-03-09T16:14:12.475Z","type":"pain_signal","category":"detected",
 "data":{"score":70,"source":"tool_failure","reason":"Tool edit failed..."}}

{"ts":"2026-03-09T23:37:55.223Z","type":"pain_signal","category":"detected", 
 "data":{"score":70,"source":"tool_failure","reason":"Tool edit failed..."}}
```

#### 4.2 任务入队成功

```json
{"ts":"2026-03-09T16:15:49.835Z","type":"evolution_task","category":"enqueued",
 "data":{"taskId":"evt-1773072949829","taskType":"unknown",...}}
```

#### 4.3 ⚠️ 无限重复入队 (BUG 核心证据)

```json
// 每 15 分钟重复一次!
2026-03-09T16:30:49.831Z - enqueued
2026-03-09T16:45:49.830Z - enqueued  
2026-03-09T17:00:49.831Z - enqueued
2026-03-09T17:15:49.831Z - enqueued
2026-03-09T17:30:49.832Z - enqueued
... (持续 100+ 次)
```

---

### 5. Evolution Directive 状态

**文件**: `/home/csuzngjh/clawd/memory/.state/evolution_directive.json`

```json
{
  "active": true,
  "task": "Diagnose systemic pain [ID: evt-1773072949829]. Source: unknown. Reason: Tool edit failed...",
  "enqueuedAt": "2026-03-09T16:15:49.829Z"
}
```

**观察**: `active: true` 表示 directive 已被 Worker 生成，但从未被 Agent 处理后重置。

---

## 🐛 BUG 分析

### BUG 1: Agent 未执行进化任务 (核心问题)

**现象**: 
- Worker 正确生成 `evolution_directive.json`
- Prompt hook 正确注入 directive 到 Agent 上下文
- 但 Agent 从未调用 `/evolve-task` 或 `sessions_spawn`

**代码流程** (`src/hooks/prompt.ts`):

```typescript
// 第 71-88 行
if (fs.existsSync(directivePath)) {
  const directive = JSON.parse(fs.readFileSync(directivePath, 'utf8'));
  if (directive.active) {
    // 注入指令
    prependContext += `\n<evolution_directive>${directiveMsg}</evolution_directive>\n`;
    
    // ⚠️ 标记为已处理
    directive.active = false;
    fs.writeFileSync(directivePath, JSON.stringify(directive, null, 2), 'utf8');
  }
}
```

**问题**: 
1. Prompt 被注入后，`directive.active` 被设为 `false`
2. 但 Agent 收到 prompt 后**并未实际执行**任何操作
3. 下一轮 Worker 轮询时，任务仍是 pending 状态
4. Worker 再次生成新的 directive（虽然 active 已是 false，但逻辑有问题）

---

### BUG 2: 无限重复入队 (日志 Spam)

**现象**: 同一个任务被重复入队 **100+ 次**

**根因**: 
- 任务状态保持 `pending`
- Worker 每次轮询 (15 分钟) 都重新处理
- 没有完成标记或去重机制

**代码流程** (`src/service/evolution-worker.ts`):

```typescript
// 第 81-113 行
function processEvolutionQueue(workspaceDir: string, stateDir: string, logger: any, eventLog: any) {
  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  const pendingTasks = queue.filter(t => t.status === 'pending');
  
  if (pendingTasks.length > 0) {
    // 总是处理第一个 pending 任务
    const highestScoreTask = pendingTasks.sort(...)[0];
    // 生成新的 directive (覆盖旧的)
  }
}
```

**问题**: 
- 只检查 `pending` 状态
- 不检查任务是否已被处理过
- 不更新任务状态为 `completed`

---

### BUG 3: 任务类型为 "unknown"

**现象**: 所有进化工单的 `source` 都是 `"unknown"`

```json
"source": "unknown"
```

**期望**: 应该是 `"tool_failure"`, `"gate_block"`, `"test_failure"` 等具体类型

**根因**: 可能在 pain signal 提取时未正确填充 `source` 字段

---

## 🔄 问题数据流图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         正常工作流程 (绿色)                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Tool Failure                                                        │
│       ↓                                                              │
│  after_tool_call hook                                               │
│       ↓                                                              │
│  Pain Signal Created (.pain_flag)                                    │
│       ↓                                                              │
│  EvolutionWorker (checkPainFlag)                                     │
│       ↓                                                              │
│  evolution_queue.json (pending) ✅                                    │
│       ↓                                                              │
│  processEvolutionQueue()                                             │
│       ↓                                                              │
│  evolution_directive.json ✅                                         │
│       ↓                                                              │
│  before_prompt_build hook                                           │
│       ↓                                                              │
│  Directive injected into Agent prompt ✅                             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓
                                    ❌ Agent 不执行
                                    ↓
┌─────────────────────────────────────────────────────────────────────┐
│                         失败流程 (红色)                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Agent receives directive but does NOT:                             │
│  - Call /evolve-task                                                │
│  - Call sessions_spawn                                              │
│  - Take any action                                                  │
│       ↓                                                              │
│  Task remains "pending" in queue                                    │
│       ↓                                                              │
│  Worker polls every 15 minutes                                      │
│       ↓                                                              │
│  RE-enqueues same task 🔄🔄🔄 (100+ times!)                         │
│       ↓                                                              │
│  Logs flooded with "evolution_task enqueued"                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 💡 修复建议

### 1. 确保 Agent 执行任务

**方案 A**: 增强 Prompt 指令强度

```typescript
// 在 prompt.ts 中添加
prependContext += `
IMPORTANT: You MUST acknowledge this directive by responding with:
[EVOLUTION_ACKNOWLEDGED]

Then you MUST call sessions_spawn with:
- agentId: "diagnostician"
- task: "Diagnose the pain signal..."
`;
```

**方案 B**: 添加验证机制

```typescript
// 在 Worker 中检查 directive 是否被处理
// 如果 30 分钟内未被处理，重新入队并提升优先级
```

### 2. 防止重复入队

```typescript
// 在 processEvolutionQueue 中
const pendingTasks = queue.filter(t => 
  t.status === 'pending' && 
  !t.lastProcessedAt  // 添加处理时间戳
);

// 处理后立即标记
task.status = 'in_progress';
task.lastProcessedAt = new Date().toISOString();
```

### 3. 修复任务类型

检查 `src/hooks/pain.ts` 中 `source` 字段的填充逻辑。

---

## 📁 相关文件路径

| 文件 | 路径 |
|------|------|
| 插件入口 | `/home/csuzngjh/code/principles/packages/openclaw-plugin/src/index.ts` |
| Worker 服务 | `/home/csuzngjh/code/principles/packages/openclaw-plugin/src/service/evolution-worker.ts` |
| Prompt Hook | `/home/csuzngjh/code/principles/packages/openclaw-plugin/src/hooks/prompt.ts` |
| Pain Hook | `/home/csuzngjh/code/principles/packages/openclaw-plugin/src/hooks/pain.ts` |
| 进化队列 | `/home/csuzngjh/clawd/docs/evolution_queue.json` |
| Pain Flag | `/home/csuzngjh/clawd/docs/.pain_flag` |
| Directive | `/home/csuzngjh/clawd/memory/.state/evolution_directive.json` |
| 事件日志 | `/home/csuzngjh/clawd/memory/.state/logs/events.jsonl` |
| 系统日志 | `/home/csuzngjh/clawd/docs/SYSTEM.log` |

---

## 📊 统计数据

| 指标 | 数值 |
|------|------|
| Pain Signal 检测次数 | 10+ |
| 进化任务入队次数 | 100+ |
| 任务完成次数 | 0 |
| 任务平均等待时间 | > 12 小时 |
| 日志 spam 频率 | 每 15 分钟一次 |

---

> **结论**: 进化循环的**检测和入队机制正常**，但**执行机制完全失效**。需要修复 Agent 指令执行逻辑和任务状态管理。

---

*Generated: 2026-03-10*
