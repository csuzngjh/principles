# 信任门禁核心架构地图

> **创建日期**: 2026-03-12
> **创建者**: Explorer Agent
> **版本**: v1.0

---

## 📊 架构概览

Principles 项目的核心信任系统由 5 个关键组件构成：

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Plugin Hook                   │
│                  (beforeToolCall Hook)                     │
└──────────────────────┬────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    gate.ts (门禁)                          │
│  • 风险路径检测                                          │
│  • 行数限制检查                                          │
│  • Stage 权限验证                                        │
│  • PLAN 白名单检查                                        │
└────┬──────────────┬──────────────┬──────────────┬────────┘
     │              │              │              │
     ▼              ▼              ▼              ▼
┌─────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│Trust    │   │Config    │   │Event     │   │Risk      │
│Engine   │   │Service   │   │Log       │   │Calculator│
└────┬────┘   └────┬─────┘   └────┬─────┘   └──────────┘
     │              │              │
     ▼              ▼              ▼
┌─────────┐   ┌──────────┐   ┌──────────┐
│Scorecard│   │Settings  │   │events    │
│.json    │   │.json     │   │.jsonl    │
└─────────┘   └──────────┘   └──────────┘

后台进程：
┌─────────────────────────────────────────────────────────────┐
│              evolution-worker.ts (进化工作器)               │
│  • 每 15 分钟扫描 PAIN_FLAG                              │
│  • 处理进化队列 (EVOLUTION_QUEUE)                        │
│  • 生成诊断任务 (EVOLUTION_DIRECTIVE)                     │
│  • 处理检测队列 (L2/L3 痛觉检测)                        │
│  • 规则晋升管理                                          │
└────┬──────────────┬──────────────┬──────────────┬────────┘
     │              │              │              │
     ▼              ▼              ▼              ▼
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│Config    │   │Event     │   │Detection │   │Dictionary│
│Service   │   │Log       │   │Service   │   │Service   │
└──────────┘   └──────────┘   └──────────┘   └──────────┘
```

---

## 🗺️ 核心调用链

### 1. 主流程：gate.ts → TrustEngine → ConfigService → EventLog

```typescript
// OpenClaw Plugin Hook 调用
handleBeforeToolCall(event, ctx)
  │
  ├─> WorkspaceContext.fromHookContext(ctx)
  │     └─> wctx.trust (TrustEngine 实例)
  │     └─> wctx.config (ConfigService 实例)
  │     └─> wctx.eventLog (EventLog 实例)
  │
  ├─> trustEngine.getScore() → number
  │     └─> 读取 AGENT_SCORECARD.json
  │
  ├─> trustEngine.getStage() → 1 | 2 | 3 | 4
  │     └─> 基于 score 计算 stage
  │
  ├─> config.get('trust') → TrustSettings
  │     └─> 读取 settings.json
  │     └─> 返回 limits (stage_2_max_lines, stage_3_max_lines)
  │
  ├─> estimateLineChanges(modification) → number
  │     └─> 按工具类型估算行数
  │
  ├─> riskLevel = assessRiskLevel(...) → 'LOW' | 'MEDIUM' | 'HIGH'
  │
  └─> [如果阻止]
        └─> eventLog.recordGateBlock(sessionId, { toolName, filePath, reason })
              └─> 写入 events.jsonl
```

### 2. 信任分数更新链

```typescript
// 工具调用完成后的回调
toolCallComplete(event, ctx, result)
  │
  ├─> 判断成功/失败
  │
  ├─> trustEngine.recordSuccess(toolName, isRisky) → void
  │     ├─> 更新 success_streak / exploratory_success_streak
  │     ├─> 应用奖励 (success_base + streak_bonus)
  │     ├─> eventLog.recordTrustChange(...)
  │     └─> 保存 AGENT_SCORECARD.json
  │
  └─> trustEngine.recordFailure(toolName, isRisky) → void
        ├─> 更新 failure_streak / exploratory_failure_streak
        ├─> 应用惩罚 (tool_failure_base + risky_penalty + streak_multiplier)
        ├─> eventLog.recordTrustChange(...)
        └─> 保存 AGENT_SCORECARD.json
```

### 3. EvolutionWorker 后台处理链

```typescript
// 每 15 分钟执行
start(initialDelay = 5000)
  │
  └─> setInterval(15 * 60 * 1000) →
        │
        ├─> checkPainFlag(wctx, logger)
        │     ├─> 读取 PAIN_FLAG
        │     ├─> 解析 score, source, reason
        │     ├─> 检查 score >= 30 && !isQueued
        │     ├─> push 到 EVOLUTION_QUEUE.json
        │     ├─> 写入 'status: queued' 到 PAIN_FLAG
        │     └─> eventLog.recordEvolutionTask(...)
        │
        ├─> processEvolutionQueue(wctx, logger, eventLog)
        │     ├─> 读取 EVOLUTION_QUEUE.json
        │     ├─> 检查超时 (30 分钟)
        │     ├─> 选择最高分 pending 任务
        │     ├─> 写入 EVOLUTION_DIRECTIVE.json
        │     ├─> 更新任务状态为 'in_progress'
        │     ├─> eventLog.recordEvolutionTask(...)
        │     └─> 保存 EVOLUTION_QUEUE.json
        │
        ├─> processDetectionQueue(wctx, api, eventLog)
        │     ├─> DetectionService.flushQueue()
        │     ├─> 遍历队列中的文本
        │     ├─> dictionary.match(text) → L2 检测
        │     ├─> 如果匹配 → eventLog.recordRuleMatch(...)
        │     ├─> 如果不匹配 → 语义搜索 (L3)
        │     ├─> updateCache(text, { detected: true, severity })
        │     └─> trackPainCandidate(text, wctx)
        │
        ├─> processPromotion(wctx, logger, eventLog)
        │     ├─> 读取 PAIN_CANDIDATES.json
        │     ├─> 过滤 count >= 3 的候选
        │     ├─> dictionary.addRule(ruleId, { phrases, severity })
        │     ├─> 更新候选状态为 'promoted'
        │     ├─> eventLog.recordRulePromotion(ruleId)
        │     └─> 保存 PAIN_CANDIDATES.json
        │
        └─> flushAllSessions(stateDir)
              └─> 刷新所有会话数据
```

---

## 🔑 关键函数及参数类型

### gate.ts (191 行)

| 函数名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `handleBeforeToolCall` | `event: PluginHookBeforeToolCallEvent`<br/>`ctx: PluginHookToolContext` | `PluginHookBeforeToolCallResult \| void` | 主入口，处理所有工具调用前的检查 |
| `block` | `filePath: string`<br/>`reason: string`<br/>`wctx: WorkspaceContext`<br/>`toolName: string` | `PluginHookBeforeToolCallResult` | 返回阻止结果，包含阻止原因 |

**关键检查点** (Line 95-120):
```typescript
// Stage 2 检查
if (stage === 2) {
    const stage2Limit = trustSettings.limits?.stage_2_max_lines ?? 50;
    if (lineChanges > stage2Limit) {
        return block(relPath, `... Max allowed is ${stage2Limit}.`, wctx, event.toolName);
    }
}

// Stage 3 检查
if (stage === 3) {
    const stage3Limit = trustSettings.limits?.stage_3_max_lines ?? 300;
    if (lineChanges > stage3Limit) {
        return block(relPath, `... Max allowed is ${stage3Limit}.`, wctx, event.toolName);
    }
}
```

### trust-engine.ts (300+ 行)

| 函数名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `getScorecard` | 无 | `TrustScorecard` | 获取完整信任分数卡 |
| `getScore` | 无 | `number` | 获取当前信任分数 (0-100) |
| `getStage` | 无 | `1 \| 2 \| 3 \| 4` | 获取当前信任阶段 |
| `recordSuccess` | `toolName: string`<br/>`isRisky: boolean` | `void` | 记录成功，增加分数 |
| `recordFailure` | `toolName: string`<br/>`isRisky: boolean` | `void` | 记录失败，减少分数 |
| `recordSubagentSuccess` | `sessionId: string`<br/>`task: string` | `void` | 记录子智能体成功 |

**关键配置** (Line 35-43):
```typescript
export const EXPLORATORY_TOOLS = [
    'read', 'read_file', 'grep', 'web_search', 'ask_user', ...
];

export const CONSTRUCTIVE_TOOLS = [
    'write', 'write_file', 'edit', 'delete_file', 'run_shell_command', ...
];
```

**默认信任设置** (Line 72-78):
```typescript
{
    stages: { stage_1_observer: 30, stage_2_editor: 60, stage_3_developer: 80 },
    cold_start: { initial_trust: 85, grace_failures: 5, cold_start_period_ms: 86400000 },
    penalties: { tool_failure_base: -2, risky_failure_base: -10, ... },
    rewards: { success_base: 2, subagent_success: 5, ... },
    limits: { stage_2_max_lines: 50, stage_3_max_lines: 300 }
}
```

### config-service.ts (271 行)

| 函数名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `ConfigService.get` | `stateDir: string` | `PainConfig` | 单例获取配置实例 |
| `ConfigService.reset` | 无 | `void` | 重置单例（测试用） |
| `PainConfig.get` | `key: string` | `any \| undefined` | 获取配置项 |
| `PainConfig.load` | 无 | `void` | 从 settings.json 加载配置 |

**配置文件路径**: `.state/settings.json`

### event-log.ts (240+ 行)

| 函数名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `recordToolCall` | `sessionId: string \| undefined`<br/>`data: ToolCallEventData` | `void` | 记录工具调用 |
| `recordPainSignal` | `sessionId: string \| undefined`<br/>`data: PainSignalEventData` | `void` | 记录痛觉信号 |
| `recordGateBlock` | `sessionId: string \| undefined`<br/>`data: GateBlockEventData` | `void` | 记录门禁阻止 |
| `recordPlanApproval` | `sessionId: string \| undefined`<br/>`data: PlanApprovalEventData` | `void` | 记录 PLAN 批准 |
| `recordEvolutionTask` | `data: EvolutionTaskEventData` | `void` | 记录进化任务 |
| `recordRuleMatch` | `sessionId: string \| undefined`<br/>`data: RuleMatchEventData` | `void` | 记录规则匹配 |
| `recordRulePromotion` | `data: RulePromotionEventData` | `void` | 记录规则晋升 |
| `recordTrustChange` | `data: TrustChangeEventData` | `void` | 记录信任变化 |
| `getDailyStats` | `date: string` | `DailyStats \| null` | 获取每日统计 |

**事件类型** (event-types.ts):
```typescript
type EventType =
  | 'tool_call'           // 工具调用
  | 'pain_signal'         // 痛觉信号
  | 'rule_match'          // 规则匹配
  | 'rule_promotion'      // 规则晋升
  | 'hook_execution'      // Hook 执行
  | 'gate_block'         // 门禁阻止
  | 'plan_approval'       // PLAN 批准
  | 'evolution_task'      // 进化任务
  | 'deep_reflection'     // 深度反思
  | 'trust_change';       // 信任变化
```

### evolution-worker.ts (280+ 行)

| 函数名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `start` | `initialDelay: number` | `NodeJS.Timeout` | 启动后台服务 |
| `stop` | 无 | `void` | 停止后台服务 |
| `checkPainFlag` | `wctx: WorkspaceContext`<br/>`logger: any` | `void` | 检查痛觉标志 |
| `processEvolutionQueue` | `wctx: WorkspaceContext`<br/>`logger: any`<br/>`eventLog: any` | `void` | 处理进化队列 |
| `processDetectionQueue` | `wctx: WorkspaceContext`<br/>`api: OpenClawPluginApi`<br/>`eventLog: any` | `Promise<void>` | 处理检测队列 |
| `processPromotion` | `wctx: WorkspaceContext`<br/>`logger: any`<br/>`eventLog: any` | `void` | 处理规则晋升 |
| `trackPainCandidate` | `text: string`<br/>`wctx: WorkspaceContext` | `void` | 跟踪痛觉候选 |

**队列项接口**:
```typescript
interface EvolutionQueueItem {
    id: string;                    // 唯一ID (MD5 哈希)
    score: number;                  // 痛觉分数
    source: string;                // 来源 (tool_failure, gate_block_attempt, etc.)
    reason: string;                // 原因描述
    timestamp: string;              // 时间戳
    trigger_text_preview?: string;  // 触发文本预览
    status: 'pending' | 'in_progress' | 'completed';
}
```

---

## 🔌 数据流图

### 工具调用流程

```
User/Agent
    │
    │ 工具调用 (write, edit, bash, etc.)
    ▼
OpenClaw Plugin Hook (beforeToolCall)
    │
    ▼
gate.ts
    │
    ├─> 检测工具类型 (WRITE_TOOLS vs BASH_TOOLS)
    │
    ├─> 解析文件路径
    │
    ├─> 检查风险路径 (isRisky)
    │
    ├─> TrustEngine.getStage()
    │       └─> 读取 AGENT_SCORECARD.json
    │
    ├─> ConfigService.get('trust')
    │       └─> 读取 settings.json
    │
    ├─> RiskCalculator.estimateLineChanges()
    │       └─> 估算行数
    │
    ├─> Stage 权限检查
    │
    ├─> [如果通过] → 允许执行
    │
    └─> [如果阻止]
            │
            ├─> EventLog.recordGateBlock()
            │       └─> 写入 events.jsonl
            │
            └─> 返回阻止结果给用户
```

### 信任分数更新流程

```
工具执行完成
    │
    ├─> 成功
    │       │
    │       ▼
    │   TrustEngine.recordSuccess(toolName, isRisky)
    │       │
    │       ├─> 更新 success_streak
    │       ├─> 应用奖励 (2 基础 + 5 条件 + 3 恢复)
    │       ├─> EventLog.recordTrustChange(+delta, reason)
    │       │       └─> 写入 events.jsonl
    │       └─> 保存 AGENT_SCORECARD.json
    │
    └─> 失败
            │
            ▼
        TrustEngine.recordFailure(toolName, isRisky)
            │
            ├─> 判断是探索性还是建设性失败
            ├─> 更新对应 streak
            ├─> 应用惩罚 (-2 探索 / -10 建设 + 连乘)
            ├─> EventLog.recordTrustChange(-delta, reason)
            │       └─> 写入 events.jsonl
            └─> 保存 AGENT_SCORECARD.json
```

### EvolutionWorker 后台流程

```
每 15 分钟
    │
    ├─> 检查 PAIN_FLAG
    │       │
    │       ├─> 读取文件
    │       ├─> 解析 score, source, reason
    │       ├─> 检查 score >= 30
    │       ├─> 添加到 EVOLUTION_QUEUE.json
    │       └─> EventLog.recordEvolutionTask()
    │
    ├─> 处理 EVOLUTION_QUEUE
    │       │
    │       ├─> 读取队列
    │       ├─> 检查超时任务
    │       ├─> 选择最高分 pending 任务
    │       ├─> 写入 EVOLUTION_DIRECTIVE.json
    │       ├─> 更新任务状态
    │       └─> EventLog.recordEvolutionTask()
    │
    ├─> 处理检测队列 (L2/L3)
    │       │
    │       ├─> DetectionService.flushQueue()
    │       ├─> DictionaryService.match() → L2
    │       ├─> 语义搜索 → L3
    │       ├─> 更新缓存
    │       └─> TrackPainCandidate()
    │
    └─> 处理规则晋升
            │
            ├─> 读取 PAIN_CANDIDATES.json
            ├─> 过滤 count >= 3
            ├─> DictionaryService.addRule()
            ├─> 更新候选状态
            └─> EventLog.recordRulePromotion()
```

---

## 🚀 扩展点识别

### 扩展点 1: Cron/Isolated Session 隔离

**位置**: `gate.ts` - Line 36-47 (工具类型识别)

**当前状态**:
```typescript
const WRITE_TOOLS = ['write', 'edit', ...];
const BASH_TOOLS = ['bash', 'run_shell_command', ...];

const isBash = BASH_TOOLS.includes(event.toolName);
const isWriteTool = WRITE_TOOLS.includes(event.toolName);
```

**扩展建议**:
```typescript
// 检测会话类型
const isCronSession = event.session?.type === 'cron' ||
                     event.session?.metadata?.isolated === true ||
                     event.sessionId?.startsWith('cron:');

// 为 Cron 会话提供独立限制池
if (isCronSession) {
    const cronLimit = trustSettings.limits?.cron_max_lines ?? 800;
    // ... 使用 cronLimit 检查
}
```

**影响**: EvolutionWorker 和 cron 任务可以使用更高的行数限制

---

### 扩展点 2: 文件类型感知限制

**位置**: `gate.ts` - Line 117-120 (Stage 3 限制)

**当前状态**:
```typescript
const stage3Limit = trustSettings.limits?.stage_3_max_lines ?? 300;
if (lineChanges > stage3Limit) {
    return block(...);
}
```

**扩展建议**:
```typescript
// 根据文件类型调整限制
const getFileTypeLimit = (filePath: string, baseLimit: number): number => {
    const ext = path.extname(filePath).toLowerCase();
    if (['.md', '.txt', '.rst'].includes(ext)) {
        return Math.max(baseLimit, 800); // 文档文件
    }
    if (['.json', '.yaml', '.yml'].includes(ext)) {
        return Math.min(baseLimit, 100); // 配置文件
    }
    return baseLimit; // 代码文件使用默认
};

const adjustedLimit = getFileTypeLimit(relPath, stage3Limit);
```

**影响**: 文档文件不会被不合理阻止，配置文件保持严格

---

### 扩展点 3: 动态限制调整

**位置**: `trust-engine.ts` - Line 72-78 (信任设置)

**当前状态**:
```typescript
limits: { stage_2_max_lines: 50, stage_3_max_lines: 300 }
```

**扩展建议**:
```typescript
// 根据历史成功率动态调整
const recentHistory = scorecard.history.slice(-10);
const successRate = recentHistory.filter(h => h.type === 'success').length / recentHistory.length;

let dynamicMultiplier = 1.0;
if (successRate > 0.95) {
    dynamicMultiplier = 1.2; // 高成功率，增加 20%
} else if (successRate < 0.7) {
    dynamicMultiplier = 0.8; // 低成功率，减少 20%
}

const dynamicLimit = baseLimit * dynamicMultiplier;
```

**影响**: 高信任度 Agent 可以获得更高的行数限制

---

## 📁 关键文件清单

### 核心代码文件
- `packages/openclaw-plugin/src/hooks/gate.ts` (191 行) - 核心门禁逻辑
- `packages/openclaw-plugin/src/core/trust-engine.ts` (300+ 行) - 信任引擎
- `packages/openclaw-plugin/src/core/config-service.ts` (271 行) - 配置服务
- `packages/openclaw-plugin/src/core/event-log.ts` (240+ 行) - 事件日志
- `packages/openclaw-plugin/src/service/evolution-worker.ts` (280+ 行) - 进化工作器
- `packages/openclaw-plugin/src/core/risk-calculator.ts` (54 行) - 风险计算器

### 数据文件
- `.state/AGENT_SCORECARD.json` - 信任分数卡
- `.state/settings.json` - 配置文件
- `.state/logs/events.jsonl` - 事件日志
- `.state/logs/daily-stats.json` - 每日统计
- `.state/EVOLUTION_QUEUE.json` - 进化队列
- `.state/EVOLUTION_DIRECTIVE.json` - 进化指令
- `.state/PAIN_CANDIDATES.json` - 痛觉候选
- `.pain_flag` - 痛觉标志

### 类型定义
- `packages/openclaw-plugin/src/types/event-types.ts` - 事件类型定义
- `packages/openclaw-plugin/src/core/workspace-context.ts` - 工作区上下文
- `packages/openclaw-plugin/src/openclaw-sdk.ts` - OpenClaw SDK 接口

---

## 🔗 相关文档

- **Issue #20 证据**: `docs/evidence/ISSUE-20-evidence.md`
- **Issue #19 证据**: `docs/evidence/ISSUE-19-evidence.md` (待创建)
- **Issue #18 证据**: `docs/evidence/ISSUE-18-evidence.md` (待创建)
- **EvolutionWorker 分析**: `docs/evidence/evolution-worker-analysis.md`

---

**文档版本**: v1.0
**创建时间**: 2026-03-12 17:30 UTC
**下一步**: KR3 - 系统风险发现
