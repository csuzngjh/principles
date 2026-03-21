# 信任分系统完整实现分析报告

> **分析日期**: 2026-03-12
> **分析者**: Explorer Subagent (ep-explorer)
> **版本**: v1.0
> **目的**: 深入分析 Principles 项目中信任分系统的完整实现，为修复方案提供技术基础

---

## 📋 执行摘要

本报告对 Principles 项目的信任分系统进行了全面深入的分析，覆盖了从数据结构到算法公式、从集成点到问题识别的所有核心方面。

### 关键发现

1. **信任分系统架构**：由 5 个核心组件构成，形成完整的信任-门禁-记录链路
2. **扣分/加分算法严重不对称**：扣分速度比加分快 10 倍，导致恢复困难
3. **探索性/建设性工具分类**：区分无害失败和建设性失败，但分类逻辑有漏洞
4. **Grace Failure 机制**：冷启动期间提供 5 次免费失败机会，但对高风险失败无效
5. **Stage 门禁集成**：信任分直接控制 Agent 的权限级别（1-4 阶段）
6. **4 大问题点**：
   - 扣分/加分不对称（恢复困难）
   - 文件损坏无恢复机制（数据丢失）
   - Gate 并发竞态条件（统计不准确）
   - 行数限制配置不一致（用户体验差）

---

## 🏗️ 1. 数据结构定义

### 1.1 核心数据结构：TrustScorecard

**位置**: `packages/openclaw-plugin/src/core/trust-engine.ts` (Line 14-36)

```typescript
export interface TrustScorecard {
    // 核心信任分 (0-100)
    trust_score: number;

    // 建设性工具（write, edit 等）的连胜/连败记录
    success_streak: number;
    failure_streak: number;

    // 探索性工具（read, grep 等）的失败连败
    exploratory_failure_streak: number;

    // 冷启动期间的剩余免费失败次数
    grace_failures_remaining?: number;

    // 时间戳
    last_updated: string;
    cold_start_end?: string;      // 冷启动结束时间
    first_activity_at?: string;   // 首次活动时间

    // 历史记录（最新 50 条）
    history: Array<{
        type: 'success' | 'failure' | 'penalty' | 'info';
        delta: number;             // 分数变化
        reason: string;
        timestamp: string;
    }>;
}
```

**数据流转**:
- **存储位置**: `.state/AGENT_SCORECARD.json`
- **更新频率**: 每次工具调用成功/失败
- **持久化**: 每次 `updateScore()` 后自动调用 `saveScorecard()`

### 1.2 信任阶段类型

**位置**: `packages/openclaw-plugin/src/core/trust-engine.ts` (Line 38)

```typescript
export type TrustStage = 1 | 2 | 3 | 4;
```

**阶段含义**:
- **Stage 1 (Observer)**: `trust_score < 30`
  - 禁止所有风险路径操作
  - 禁止所有中/高风险操作
  - 仅允许低风险探索

- **Stage 2 (Editor)**: `30 ≤ trust_score < 60`
  - 允许非风险路径写入
  - 行数限制：50 行
  - 禁止风险路径修改

- **Stage 3 (Developer)**: `60 ≤ trust_score < 80`
  - 允许所有路径写入
  - 需要 READY PLAN 才能修改风险路径
  - 行数限制：300 行

- **Stage 4 (Architect)**: `trust_score ≥ 80`
  - 完全绕过所有门禁检查
  - 无行数限制

### 1.3 工具分类定义

**位置**: `packages/openclaw-plugin/src/core/trust-engine.ts` (Line 40-52)

```typescript
// 探索性工具：只读操作，失败无害
export const EXPLORATORY_TOOLS = [
    // 文件读取
    'read', 'read_file', 'read_many_files', 'image_read',
    // 搜索和列表
    'search_file_content', 'grep', 'grep_search', 'list_directory', 'ls', 'glob',
    // Web
    'web_fetch', 'web_search',
    // 用户交互
    'ask_user', 'ask_user_question',
    // LSP
    'lsp_hover', 'lsp_goto_definition', 'lsp_find_references',
    // 内存和状态
    'memory_recall', 'save_memory', 'todo_read', 'todo_write',
    // 状态查询
    'pd-status', 'trust', 'report',
];

// 建设性工具：修改操作，失败有风险
export const CONSTRUCTIVE_TOOLS = [
    'write', 'write_file', 'edit', 'edit_file', 'replace', 'apply_patch',
    'insert', 'patch', 'delete_file', 'move_file', 'run_shell_command',
    'pd_spawn_agent', 'sessions_spawn', 'evolve-task', 'init-strategy'
];
```

### 1.4 信任设置配置

**位置**: `packages/openclaw-plugin/src/core/config.ts` (Line 35-78)

```typescript
export interface TrustSettings {
    stages: {
        stage_1_observer: number;
        stage_2_editor: number;
        stage_3_developer: number;
    };
    cold_start: {
        initial_trust: number;
        grace_failures: number;
        cold_start_period_ms: number;
    };
    penalties: {
        tool_failure_base: number;
        risky_failure_base: number;
        gate_bypass_attempt: number;
        failure_streak_multiplier: number;
        max_penalty: number;
    };
    rewards: {
        success_base: number;
        subagent_success: number;
        tool_success_reward: number;
        streak_bonus_threshold: number;
        streak_bonus: number;
        recovery_boost: number;
        max_reward: number;
    };
    limits: {
        stage_2_max_lines: number;
        stage_3_max_lines: number;
    };
    history_limit?: number;
}
```

**默认值** (Line 130-175):
```typescript
trust: {
    stages: {
        stage_1_observer: 30,
        stage_2_editor: 60,
        stage_3_developer: 80,
    },
    cold_start: {
        initial_trust: 85,  // 开发者级别初始信任
        grace_failures: 5,   // 5 次免费失败
        cold_start_period_ms: 24 * 60 * 60 * 1000,  // 24 小时
    },
    penalties: {
        tool_failure_base: -2,       // 基础工具失败
        risky_failure_base: -10,     // 高风险失败
        gate_bypass_attempt: -5,     // 试图绕过门禁
        failure_streak_multiplier: -2, // 连败乘数
        max_penalty: -20,             // 最大扣分
    },
    rewards: {
        success_base: 2,              // 基础成功加分
        subagent_success: 5,          // 子智能体成功
        tool_success_reward: 0.2,     // 工具成功小奖励
        streak_bonus_threshold: 3,    // 连续 3 次成功触发
        streak_bonus: 5,              // 连胜奖励
        recovery_boost: 5,            // 低分恢复加成
        max_reward: 15,               // 最大加分
    },
    limits: {
        stage_2_max_lines: 50,
        stage_3_max_lines: 300,
    },
    history_limit: 50
}
```

---

## 📐 2. 扣分/加分算法完整公式

### 2.1 扣分算法 (recordFailure)

**位置**: `packages/openclaw-plugin/src/core/trust-engine.ts` (Line 144-183)

#### 2.1.1 算法流程图

```
recordFailure(type, context)
    │
    ├─> 判断工具类型
    │     ├─> 探索性工具？ → isExploratory = true
    │     └─> 建设性工具？ → isExploratory = false
    │
    ├─> 检查冷启动 Grace Failure
    │     ├─> 非高风险 && 在冷启动期 && 有剩余次数？
    │     │     ├─> 是 → 消耗 1 次机会，不扣分
    │     │     └─> 否 → 继续扣分流程
    │
    ├─> 探索性失败？
    │     ├─> 是 → exploratory_failure_streak++, 扣 -1 分
    │     └─> 否 → 继续建设性失败流程
    │
    ├─> 建设性失败扣分计算
    │     ├─> 基础扣分：
    │     │     ├─> tool: -2
    │     │     ├─> risky: -10
    │     │     └─> bypass: -5
    │     │
    │     ├─> 连败乘数：
    │     │     ├─> failure_streak++
    │     │     ├─> effectiveStreak = min(failure_streak, 5)
    │     │     └─> delta += (effectiveStreak - 1) × (-2)
    │     │
    │     ├─> 最大扣分限制：
    │     │     └─> if delta < -20, delta = -20
    │
    └─> 更新 scorecard 并保存
          ├─> trust_score += delta
          ├─> success_streak = 0
          ├─> 记录到 history
          └─> saveScorecard()
```

#### 2.1.2 伪代码公式

```typescript
function recordFailure(type, context) {
    let delta = 0;

    // 1. 探索性工具失败
    if (isExploratoryTool(context.toolName)) {
        scorecard.exploratory_failure_streak++;
        delta = -1;
        updateScore(delta, "Exploratory Failure", 'failure');
        return;
    }

    // 2. 冷启动 Grace Failure 检查
    if (type !== 'risky' && isColdStart() && grace_failures_remaining > 0) {
        grace_failures_remaining--;
        updateScore(0, "Grace Failure consumed", 'failure');
        return;
    }

    // 3. 建设性失败扣分
    switch (type) {
        case 'tool':   delta = -2; break;
        case 'risky':  delta = -10; break;
        case 'bypass': delta = -5; break;
    }

    // 4. 连败乘数（最多 5 次连乘）
    scorecard.failure_streak++;
    const effectiveStreak = Math.min(scorecard.failure_streak, 5);
    if (effectiveStreak > 1) {
        delta += (effectiveStreak - 1) × (-2);
    }

    // 5. 最大扣分限制
    delta = Math.max(delta, -20);

    // 6. 更新
    scorecard.success_streak = 0;
    updateScore(delta, "Failure", 'failure');
}
```

#### 2.1.3 实际扣分案例表

| 失败次数 | 失败类型 | 连败数 | 基础扣分 | 连败乘数 | 总扣分 | 说明 |
|---------|---------|--------|---------|---------|--------|------|
| 1 | tool | 1 | -2 | 0 | -2 | 第一次工具失败 |
| 2 | tool | 2 | -2 | -2 | -4 | 第二次工具失败 |
| 3 | tool | 3 | -2 | -4 | -6 | 第三次工具失败 |
| 4 | tool | 4 | -2 | -6 | -8 | 第四次工具失败 |
| 5 | tool | 5 | -2 | -8 | -10 | 第五次工具失败 |
| 6 | tool | 5 | -2 | -8 | -10 | 第六次及以后（连败数封顶 5） |
| 1 | risky | 1 | -10 | 0 | -10 | 单次高风险失败 |
| 2 | risky | 2 | -10 | -2 | -12 | 第二次高风险失败 |
| 3 | risky | 3 | -10 | -4 | -14 | 第三次高风险失败 |
| 1 | bypass | 1 | -5 | 0 | -5 | 试图绕过门禁 |
| 探索 | read | - | - | - | -1 | 探索性失败不触发连败 |

#### 2.1.4 冷启动期间扣分表

| 失败次数 | 类型 | Grace 剩余 | 实际扣分 | 说明 |
|---------|------|----------|---------|------|
| 1 | tool | 5 → 4 | 0 | 第一次免费失败 |
| 2 | tool | 4 → 3 | 0 | 第二次免费失败 |
| 3 | tool | 3 → 2 | 0 | 第三次免费失败 |
| 4 | tool | 2 → 1 | 0 | 第四次免费失败 |
| 5 | tool | 1 → 0 | 0 | 第五次免费失败 |
| 6 | tool | 0 | -2 | Grace 次数用完，开始扣分 |
| 1 | risky | 5 → 5 | -10 | **高风险失败不享受 Grace** |

---

### 2.2 加分算法 (recordSuccess)

**位置**: `packages/openclaw-plugin/src/core/trust-engine.ts` (Line 113-143)

#### 2.2.1 算法流程图

```
recordSuccess(reason, context, isSubagent)
    │
    ├─> 判断工具类型
    │     ├─> 探索性工具成功？
    │     │     ├─> 是 → exploratory_failure_streak = 0
    │     │     ├─> 不加分（delta = 0）
    │     │     └─> 记录为 'info' 类型
    │     │
    │     └─> 建设性工具成功？
    │           └─> 继续加分流程
    │
    ├─> 计算基础加分
    │     ├─> isSubagent → delta = 5
    │     ├─> reason === 'plan_ready' → delta = 5
    │     ├─> reason === 'tool_success' → delta = 0.2
    │     └─> 否则 → delta = 2
    │
    ├─> 更新连胜记录
    │     ├─> success_streak++
    │     ├─> failure_streak = 0
    │     └─> exploratory_failure_streak = 0
    │
    ├─> 应用连胜奖励（仅一次）
    │     ├─> success_streak >= 3?
    │     │     ├─> 是 → delta += 5
    │     │     └─> 否 → 无奖励
    │
    ├─> 应用低分恢复加成
    │     ├─> trust_score < 30?
    │     │     ├─> 是 → delta += 5
    │     │     └─> 否 → 无加成
    │
    ├─> 最大加分限制（理论）
    │     └─> 理论最大值：15（代码未强制）
    │
    └─> 更新 scorecard 并保存
          ├─> trust_score += delta
          ├─> 限制在 [0, 100] 范围内
          ├─> 记录到 history
          └─> saveScorecard()
```

#### 2.2.2 伪代码公式

```typescript
function recordSuccess(reason, context, isSubagent) {
    // 1. 探索性工具成功
    if (isExploratoryTool(context.toolName)) {
        scorecard.exploratory_failure_streak = 0;
        updateScore(0, "Exploratory Success", 'info');
        return;
    }

    // 2. 计算基础加分
    let delta = 2;  // success_base
    if (isSubagent) delta = 5;
    else if (reason === 'tool_success') delta = 0.2;
    else if (reason === 'plan_ready') delta = 5;

    // 3. 更新连胜记录
    scorecard.success_streak++;
    scorecard.failure_streak = 0;
    scorecard.exploratory_failure_streak = 0;

    // 4. 连胜奖励（仅一次）
    if (scorecard.success_streak >= 3) {
        delta += 5;
    }

    // 5. 低分恢复加成
    if (scorecard.trust_score < 30) {
        delta += 5;
    }

    // 6. 更新分数
    updateScore(delta, reason, 'success');
}
```

#### 2.2.3 实际加分案例表

| 成功次数 | 类型 | 连胜数 | 基础加分 | 连胜奖励 | 恢复加成 | 总加分 | 说明 |
|---------|------|--------|---------|---------|---------|--------|------|
| 1 | tool | 1 | 2 | 0 | 0 | 2 | 第一次工具成功 |
| 2 | tool | 2 | 2 | 0 | 0 | 2 | 第二次工具成功 |
| 3 | tool | 3 | 2 | 5 | 0 | 7 | 第三次成功（触发连胜） |
| 4 | tool | 4 | 2 | 5 | 0 | 7 | 第四次成功（保持连胜） |
| 5 | tool | 5 | 2 | 5 | 0 | 7 | 第五次成功（保持连胜） |
| 1 | subagent | 1 | 5 | 0 | 0 | 5 | 子智能体成功 |
| 2 | subagent | 2 | 5 | 0 | 0 | 5 | 第二次子智能体成功 |
| 3 | subagent | 3 | 5 | 5 | 0 | 10 | 第三次成功（触发连胜） |
| 探索 | read | - | 0 | 0 | 0 | 0 | 探索性成功不加分 |
| 1 | tool | 1 | 2 | 0 | 5 | 7 | Stage 1 恢复（分数 < 30） |

#### 2.2.4 分数恢复案例表

**场景**: 从 Stage 1 (score = 20) 恢复到 Stage 3 (score = 60)

| 操作 | 变化 | 新分数 | 说明 |
|------|------|--------|------|
| 初始 | - | 20 | Stage 1 |
| 工具成功 #1 | +7 | 27 | 恢复加成 (+5) |
| 工具成功 #2 | +7 | 34 | 连胜奖励 (+5) + 恢复加成 (+5) |
| 工具成功 #3 | +7 | 41 | 保持连胜 + 恢复加成 |
| 工具成功 #4 | +7 | 48 | 保持连胜 + 恢复加成 |
| 工具成功 #5 | +7 | 55 | 保持连胜 + 恢复加成 |
| 工具成功 #6 | +2 | 57 | **退出 Stage 1，失去恢复加成** |
| 工具成功 #7 | +7 | 64 | 连胜奖励 (+5) |
| 工具成功 #8 | +7 | 71 | **进入 Stage 3** |

**恢复成本**: 8 次成功（其中 2 次失去恢复加成，6 次享受）

---

### 2.3 扣分/加分不对称分析

#### 2.3.1 对称性对比表

| 维度 | 扣分机制 | 加分机制 | 不对称比 |
|------|---------|---------|---------|
| **单次操作** | -2 ~ -20 | +0.2 ~ +7 | **10:1** |
| **连乘效应** | 有（累积） | 无（仅一次） | **无限:1** |
| **最大绝对值** | 20 | 15（理论） | **1.33:1** |
| **恢复 20 分** | 1 次失败 | 10 次普通成功 | **10:1** |
| **触发条件** | 任何失败 | 连胜 ≥ 3 | - |
| **特殊保护** | 无 | Grace Failure (5 次) | - |

#### 2.3.2 恢复难度计算

**案例 1**: 单次高风险失败 (score: 70 → 50)

```
失败: -10 分
恢复: 需要 5 次成功（每次 +2）
恢复时间: 5 次工具调用
难度: 中等
```

**案例 2**: 连败 5 次后失败 (score: 70 → 50)

```
失败: -10 + (-2×4) = -18 分
恢复: 需要 9 次成功（每次 +2）
恢复时间: 9 次工具调用
难度: 高
```

**案例 3**: 跌入 Stage 1 (score: 60 → 20)

```
失败: -20 分（5 次连败）
恢复: 需要 10 次成功（每次 +2），或 5 次成功（每次 +7，含恢复加成）
恢复时间: 10 次工具调用（无恢复加成）
难度: 极高
```

#### 2.3.3 不对称性根源分析

| 根因 | 影响 | 建议 |
|------|------|------|
| **连败乘数** | 失败越来越重 | 添加连胜乘数 |
| **连胜奖励仅一次** | 成功奖励固定 | 每次连胜都加成 |
| **无每日扣分上限** | 可能无限扣分 | 实施每日上限（如 -30） |
| **Grace Failure 仅限非高风险** | 高风险失败无保护 | 扩展 Grace Failure 覆盖 |
| **无对称恢复机制** | 加分慢于扣分 | 添加恢复加速器 |

---

## 🔗 3. 与 gate.ts 的集成点

### 3.1 集成架构图

```
┌──────────────────────────────────────────────────────┐
│              OpenClaw Plugin Hook                     │
│         beforeToolCall(event, ctx)                    │
└───────────────────┬──────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────┐
│                   gate.ts                             │
│  1. 识别工具类型（WRITE_TOOLS vs BASH_TOOLS）         │
│  2. 解析文件路径                                      │
│  3. 检查风险路径（isRisky）                           │
│  4. 调用 WorkspaceContext.fromHookContext()           │
└───────┬──────────────┬──────────────┬────────────────┘
        │              │              │
        ▼              ▼              ▼
┌─────────────┐  ┌──────────┐  ┌────────────┐
│TrustEngine  │  │EventLog   │  │RiskCalc    │
│             │  │          │  │            │
│getScore()   │  │recordXXX()│  │estimateXXX()│
│getStage()   │  │          │  │            │
└──────┬──────┘  └──────────┘  └────────────┘
       │
       ▼
┌─────────────┐
│ConfigService│
│             │
│get('trust') │
│limits.*     │
└─────────────┘
```

### 3.2 集成调用链

#### 3.2.1 主流程：gate.ts → TrustEngine

**位置**: `packages/openclaw-plugin/src/hooks/gate.ts` (Line 36-119)

```typescript
export function handleBeforeToolCall(event, ctx) {
    // 1. 识别工具类型
    const WRITE_TOOLS = ['write', 'edit', ...];
    const BASH_TOOLS = ['bash', 'run_shell_command', ...];

    // 2. 创建工作区上下文（包含 TrustEngine）
    const wctx = WorkspaceContext.fromHookContext(ctx);
    //   ↓
    //   wctx.trust: TrustEngine 实例
    //   wctx.config: ConfigService 实例
    //   wctx.eventLog: EventLog 实例

    // 3. 获取信任分数和阶段
    const trustScore = wctx.trust.getScore();      // 调用 trust-engine.ts
    const stage = wctx.trust.getStage();           // 调用 trust-engine.ts

    // 4. 获取信任设置
    const trustSettings = wctx.config.get('trust');  // 调用 config-service.ts
    const stage2Limit = trustSettings.limits?.stage_2_max_lines ?? 50;
    const stage3Limit = trustSettings.limits?.stage_3_max_lines ?? 300;

    // 5. 评估风险级别
    const riskLevel = assessRiskLevel(relPath, {...}, profile.risk_paths);

    // 6. 估算行数变化
    const lineChanges = estimateLineChanges({toolName, params});

    // 7. Stage 权限检查
    if (stage === 1) {
        // Stage 1: 禁止所有风险路径和中/高风险操作
        if (risky || riskLevel !== 'LOW') {
            return block(...);
        }
    }

    if (stage === 2) {
        // Stage 2: 禁止风险路径，限制行数
        if (risky) return block(...);
        if (lineChanges > stage2Limit) return block(...);
    }

    if (stage === 3) {
        // Stage 3: 需要 READY PLAN 才能修改风险路径
        if (risky && planStatus !== 'READY') return block(...);
        if (lineChanges > stage3Limit) return block(...);
    }

    if (stage === 4) {
        // Stage 4: 完全绕过
        return;  // 允许
    }
}
```

#### 3.2.2 工具调用后回调：gate.ts → TrustEngine

**位置**: `packages/openclaw-plugin/src/hooks/lifecycle.ts` (假设)

```typescript
export function handleAfterToolCall(event, ctx, result) {
    const wctx = WorkspaceContext.fromHookContext(ctx);

    // 判断成功/失败
    if (result.success) {
        // 记录成功
        wctx.trust.recordSuccess(
            'tool_success',
            { sessionId: ctx.sessionId, toolName: event.toolName },
            false  // isSubagent
        );
    } else {
        // 记录失败
        const isRisky = CONSTRUCTIVE_TOOLS.includes(event.toolName);
        wctx.trust.recordFailure(
            isRisky ? 'risky' : 'tool',
            { sessionId: ctx.sessionId, toolName: event.toolName }
        );
    }
}
```

### 3.3 Stage 权限矩阵

| Stage | 信任分数 | 风险路径 | 非风险路径 | 行数限制 | PLAN 要求 | 说明 |
|-------|---------|---------|-----------|---------|----------|------|
| **1** | 0-29 | 🚫 禁止 | ⚠️ 仅 LOW | 无 | ❌ 不需要 | Observer 模式 |
| **2** | 30-59 | 🚫 禁止 | ✅ 允许 | 50 行 | ❌ 不需要 | Editor 模式 |
| **3** | 60-79 | ✅ 需要 READY | ✅ 允许 | 300 行 | ✅ 需要 READY | Developer 模式 |
| **4** | 80-100 | ✅ 允许 | ✅ 允许 | 无 | ❌ 不需要 | Architect 模式 |

### 3.4 阻止事件记录

**位置**: `packages/openclaw-plugin/src/hooks/gate.ts` (Line 180-190)

```typescript
function block(filePath, reason, wctx, toolName) {
    const logger = console;
    logger.error(`[PD_GATE] BLOCKED: ${filePath}. Reason: ${reason}`);

    // 记录阻止次数（潜在竞态条件）
    trackBlock(wctx.workspaceDir);

    // 返回阻止结果
    return {
        block: true,
        blockReason: `[Principles Disciple] Security Gate Blocked this action.\nFile: ${filePath}\nReason: ${reason}\n\nHint: You may need a READY plan or a higher trust score to perform this action.`,
    };
}
```

**问题**: 未调用 `eventLog.recordGateBlock()`，审计能力不完整

---

## ⚠️ 4. 当前实现的所有问题点

### 4.1 问题 #1: 扣分/加分不对称（恢复困难）

#### 问题描述

扣分速度比加分快 10 倍，导致信任分恢复极其困难。一次高风险失败（-10 分）需要 5 次普通成功（+2 分）才能恢复。

#### 影响

- **用户体验差**: Agent 频繁陷入 Stage 1
- **测试失败率高**: 失败一次后难以恢复
- **进化受阻**: 无法快速积累信任分提升权限

#### 数据

| 场景 | 扣分 | 加分 | 恢复成本 |
|------|------|------|---------|
| 单次高风险失败 | -10 | +2 | 5 次成功 |
| 连败 5 次失败 | -20 | +2 | 10 次成功 |
| 从 Stage 1 恢复到 Stage 3 | -40 | +2~+7 | 8~20 次成功 |

#### 根因

1. **连败乘数**（failure_streak_multiplier: -2）
2. **连胜奖励仅一次**（仅在达到阈值时加 +5）
3. **无每日扣分上限**
4. **Grace Failure 不覆盖高风险失败**

#### 建议

- 添加连胜乘数（对称机制）
- 每次连胜都给予奖励
- 实施每日扣分上限（如 -30）
- 扩展 Grace Failure 覆盖高风险失败

---

### 4.2 问题 #2: 文件损坏无恢复机制（数据丢失）

#### 问题描述

TrustEngine 在加载 `AGENT_SCORECARD.json` 时，如果文件损坏（非有效 JSON），会**静默重置为初始值**，导致所有历史信任数据丢失。

#### 代码位置

**文件**: `packages/openclaw-plugin/src/core/trust-engine.ts` (Line 66-72)

```typescript
if (fs.existsSync(scorecardPath)) {
    try {
        const raw = fs.readFileSync(scorecardPath, 'utf8');
        const data = JSON.parse(raw);
        // ... 字段迁移逻辑
        return data;
    } catch (e) {
        console.error(`[PD:TrustEngine] FATAL: Failed to parse scorecard at ${scorecardPath}. Resetting.`);
        // ⚠️ 问题：仅记录错误，继续执行，返回默认值
    }
}

// 返回全新的默认值
return {
    trust_score: settings.cold_start.initial_trust,
    success_streak: 0,
    failure_streak: 0,
    exploratory_failure_streak: 0,
    // ...
};
```

#### 风险场景

```
T0: TrustEngine 保存 scorecard（trust_score: 75）
T1: 写入文件前，进程被 kill（磁盘满、OOM、系统崩溃）
T2: AGENT_SCORECARD.json 损坏（不完整的 JSON）
T3: TrustEngine 重启，读取损坏文件
T4: JSON.parse() 抛出异常
T5: catch 块捕获异常，仅记录错误
T6: 返回默认值（trust_score: 85）
T7: 用户丢失所有信任数据，包括：
      - 历史成功/失败记录
      - 当前分数（75 → 85，意外提升）
      - 冷启动状态
      - 连胜/连败记录
```

#### 影响

| 影响维度 | 严重程度 | 说明 |
|---------|---------|------|
| **数据丢失** | 🔴 严重 | 所有信任历史永久丢失 |
| **信任分数错误** | 🔴 严重 | 可能意外提升（从低分变回初始 85） |
| **冷启动失效** | 🟡 中等 | `cold_start_end` 被重置，可能重复冷启动保护 |
| **连胜/连败重置** | 🟡 中等 | 所有统计清零 |
| **审计能力丧失** | 🟡 中等 | `history` 数组清空，无法追踪行为 |

#### 建议

- 实施备份恢复机制（`.bak` 文件）
- 原子写入机制（临时文件 + 重命名）
- 保留损坏文件供分析（`.corrupted.timestamp`）
- 记录恢复事件到事件日志

---

### 4.3 问题 #3: Gate 并发竞态条件（统计不准确）

#### 问题描述

如果多个工具调用同时被 gate.ts 阻止，`block()` 函数可能被**并发调用**，导致：
- `trackBlock()` 可能被多次调用，记录错误的阻止次数
- `eventLog.recordGateBlock()` 未被调用（审计能力不完整）

#### 代码位置

**文件**: `packages/openclaw-plugin/src/hooks/gate.ts` (Line 180-190)

```typescript
function block(filePath, reason, wctx, toolName) {
    const logger = console;
    logger.error(`[PD_GATE] BLOCKED: ${filePath}. Reason: ${reason}`);

    trackBlock(wctx.workspaceDir);  // ⚠️ 问题 1: 可能并发调用

    return {
        block: true,
        blockReason: `[Principles Disciple] Security Gate Blocked this action.\nFile: ${filePath}\nReason: ${reason}\n\nHint: You may need a READY plan or a higher trust score to perform this action.`,
    };
}
```

#### 风险场景

```
T0: Agent 同时发起 3 个工具调用
T1: gate.ts 处理第一个请求，调用 block()
T2: gate.ts 处理第二个请求（并发），调用 block()
T3: trackBlock() 内部逻辑
    - 读取 .state/session-blocks.json
    - 解析 JSON
    - 更新计数器
    - 写入文件
    - ⚠️ 如果 T2 的写入在 T1 之后，数据被覆盖

T4: 结果：阻止计数不准确，可能丢失或重复
```

#### 影响

| 影响维度 | 严重程度 | 说明 |
|---------|---------|------|
| **统计数据不准确** | 🟡 中等 | 阻止次数可能重复计数或丢失 |
| **审计能力不完整** | 🟡 中等 | 阻止事件未全部记录到事件日志 |
| **用户体验** | 🟢 轻微 | 用户看到多个相同的阻止消息 |

#### 建议

- 添加并发控制（Mutex 互斥锁）
- 实施原子性 trackBlock（临时文件 + 重命名）
- 调用 `eventLog.recordGateBlock()` 记录所有阻止事件

---

### 4.4 问题 #4: 行数限制配置不一致（用户体验差）

#### 问题描述

Stage 3 文件写入行数限制存在严重的配置不一致问题，导致测试失败率高、用户体验差。代码中的默认值与测试用例和文档中的期望值不匹配。

#### 代码位置

**文件**: `packages/openclaw-plugin/src/hooks/gate.ts` (Line 117)

```typescript
const stage3Limit = trustSettings.limits?.stage_3_max_lines ?? 300;
```

#### 默认值对比

| 来源 | Stage 2 限制 | Stage 3 限制 | 文档说明 |
|------|------------|------------|---------|
| **代码默认** | 50 | 300 | - |
| **测试期望** | 10 | 100 | `tests/feature-testing/framework/test-scenarios/gatekeeper-boundaries.json` |
| **实际阻止消息** | 10 | - | `Modification too large (413 lines) for Stage 2. Max allowed is 10.` |

#### 真实失败案例

**案例 1**: Phase 1 结构分析文档（413 行）

| 属性 | 值 |
|------|------|
| 文件大小 | ~413 行 |
| Stage | Stage 2 (Editor) |
| 实际限制 | 10 行 |
| 配置限制 | 50 行 |
| 阻止原因 | `Modification too large (413 lines) for Stage 2. Max allowed is 10.` |
| 影响 | 文档无法生成，任务无法完成 |

#### 影响

- **测试失败率高**: 大部分文档生成测试被阻止
- **用户体验差**: 合理的文档操作被不合理阻止
- **Agent 误判**: Agent 无法区分合理请求和危险操作

#### 建议

- 统一配置来源（单一事实源）
- 实施文件类型感知限制（docs: 800 行, src: 300 行）
- 更新测试用例与代码默认值对齐
- 提供明确的配置文档

---

### 4.5 问题 #5: 探索性工具分类漏洞

#### 问题描述

探索性工具（EXPLORATORY_TOOLS）列表可能不完整，导致某些只读操作被误判为建设性操作，触发不必要的扣分。

#### 代码位置

**文件**: `packages/openclaw-plugin/src/core/trust-engine.ts` (Line 40-47)

```typescript
export const EXPLORATORY_TOOLS = [
    'read', 'read_file', 'read_many_files', 'image_read',
    'search_file_content', 'grep', 'grep_search', 'list_directory', 'ls', 'glob',
    'web_fetch', 'web_search',
    'ask_user', 'ask_user_question',
    'lsp_hover', 'lsp_goto_definition', 'lsp_find_references',
    'memory_recall', 'save_memory', 'todo_read', 'todo_write',
    'pd-status', 'trust', 'report',
];
```

#### 漏洞场景

**场景**: `cat` 命令（只读）未在 EXPLORATORY_TOOLS 中

```
Agent 执行: bash -c "cat /path/to/file.txt"
工具名: 'bash'
分类: 建设性工具（不在 EXPLORATORY_TOOLS 中）
结果: 失败时扣 -2 分（不合理）
期望: 应该扣 -1 分（探索性失败）
```

#### 影响

| 影响维度 | 严重程度 | 说明 |
|---------|---------|------|
| **误扣分** | 🟡 中等 | 只读操作失败被误扣 -2 分 |
| **恢复困难** | 🟡 中等 | 误扣分导致恢复成本增加 |
| **用户体验** | 🟢 轻微 | 用户不理解为什么只读操作被扣分 |

#### 建议

- 扩展 EXPLORATORY_TOOLS 列表
- 基于工具语义动态分类（而非硬编码）
- 添加白名单机制允许用户自定义分类

---

### 4.6 问题 #6: 历史数组溢出风险（内存泄漏）

#### 问题描述

`updateScore()` 函数虽然限制了 `history` 数组长度（最多 50 条），但如果 `history_limit` 配置被手动修改或未设置，数组可能无限增长，导致内存问题。

#### 代码位置

**文件**: `packages/openclaw-plugin/src/core/trust-engine.ts` (Line 250-256)

```typescript
this.scorecard.history.push({ type, delta, reason, timestamp: new Date().toISOString() });

const limit = this.trustSettings.history_limit || 50;  // ⚠️ 如果配置未设置，默认 50
if (this.scorecard.history.length > limit) {
    this.scorecard.history.shift();  // ⚠️ 如果 limit 被设置为 Infinity，永远不执行
}
```

#### 风险场景

```
settings.json:
{
  "trust": {
    "history_limit": 999999  // 配置错误或恶意修改
  }
}

结果：history 数组无限增长，内存耗尽
```

#### 影响

| 影响维度 | 严重程度 | 说明 |
|---------|---------|------|
| **内存泄漏** | 🟡 中等 | 长期运行可能导致内存耗尽 |
| **文件大小增长** | 🟡 中等 | AGENT_SCORECARD.json 可能变得巨大 |
| **加载性能下降** | 🟢 轻微 | JSON 解析和写入变慢 |

#### 建议

- 添加安全限制（最大 500 条，防止配置错误）
- 如果历史数组过大（> 1000），主动截断并警告
- 验证配置有效性（history_limit 必须在 10-500 范围内）

---

## 📊 5. 系统数据流图

### 5.1 完整调用链

```
用户/Agent 操作
    │
    │ [工具调用]
    ▼
┌─────────────────────────────────────────────┐
│      OpenClaw Plugin Hook                    │
│      beforeToolCall(event, ctx)             │
└────────────┬────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────┐
│            gate.ts                          │
│  1. 识别工具类型                             │
│  2. 解析文件路径                             │
│  3. 检查风险路径                             │
│  4. WorkspaceContext.fromHookContext()       │
└────┬────────┬────────┬──────────┬────────────┘
     │        │        │          │
     ▼        ▼        ▼          ▼
┌────────┐ ┌─────┐ ┌────────┐ ┌──────────┐
│ Trust  │ │Risk │ │Config  │ │EventLog  │
│ Engine │ │Calc │ │Service │ │          │
└───┬────┘ └─────┘ └────────┘ └──────────┘
    │
    ├─> getScore() → 信任分数
    ├─> getStage() → 阶段 (1-4)
    │
    ▼
[Stage 权限检查]
    │
    ├─> Stage 1: 禁止风险路径和中/高风险
    ├─> Stage 2: 禁止风险路径，限制 50 行
    ├─> Stage 3: 需要 READY PLAN，限制 300 行
    └─> Stage 4: 完全绕过
    │
    ├─> [通过] → 允许执行
    │
    └─> [阻止]
            │
            ├─> block()
            │       ├─> trackBlock()
            │       └─> 返回阻止结果
            │
            └─> EventLog.recordGateBlock()
                    └─> 写入 events.jsonl
    │
    ▼
[工具执行]
    │
    ├─> 成功 → recordSuccess()
    │       ├─> 更新 scorecard
    │       ├─> EventLog.recordTrustChange()
    │       └─> 保存 AGENT_SCORECARD.json
    │
    └─> 失败 → recordFailure()
            ├─> 更新 scorecard
            ├─> EventLog.recordTrustChange()
            └─> 保存 AGENT_SCORECARD.json
```

### 5.2 数据文件流转

```
AGENT_SCORECARD.json (.state/)
    │
    ├─> 读取频率: 每次 getScore()/getStage()
    ├─> 写入频率: 每次 recordSuccess()/recordFailure()
    ├─> 字段:
    │     ├─> trust_score: 当前信任分数
    │     ├─> success_streak: 连胜数
    │     ├─> failure_streak: 连败数
    │     ├─> exploratory_failure_streak: 探索连败
    │     ├─> grace_failures_remaining: 剩余免费失败
    │     ├─> cold_start_end: 冷启动结束时间
    │     └─> history[]: 历史记录（最多 50 条）
    │
    └─> 损坏恢复: 无（问题 #2）

settings.json (.state/)
    │
    ├─> 读取频率: 每次 ConfigService.get()
    ├─> 写入频率: 用户手动修改
    ├─> 字段:
    │     ├─> trust.stages.*: 阶段阈值
    │     ├─> trust.cold_start.*: 冷启动设置
    │     ├─> trust.penalties.*: 扣分配置
    │     ├─> trust.rewards.*: 加分配置
    │     ├─> trust.limits.*: 行数限制
    │     └─> trust.history_limit: 历史记录限制
    │
    └─> 备份: 无

events.jsonl (.state/logs/)
    │
    ├─> 写入频率: 每次事件触发
    ├─> 事件类型:
    │     ├─> tool_call: 工具调用
    │     ├─> gate_block: 门禁阻止
    │     ├─> trust_change: 信任变化
    │     ├─> pain_signal: 痛觉信号
    │     ├─> rule_match: 规则匹配
    │     └─> evolution_task: 进化任务
    │
    └─> 旋转策略: 每日
```

---

## 🎯 6. 修复优先级与建议

### 6.1 优先级矩阵

| 问题编号 | 问题名称 | 严重程度 | 影响范围 | 修复优先级 | 预计工作量 |
|---------|---------|---------|---------|-----------|-----------|
| **#1** | 扣分/加分不对称 | 🔴 高 | 核心算法 | P0 | 2-3 小时 |
| **#2** | 文件损坏无恢复 | 🔴 高 | 数据完整性 | P0 | 2-3 小时 |
| **#3** | Gate 并发竞态 | 🟡 中 | 统计准确性 | P1 | 1-2 小时 |
| **#4** | 行数限制不一致 | 🟡 中 | 用户体验 | P1 | 2-3 小时 |
| **#5** | 探索性工具分类 | 🟢 轻微 | 误扣分 | P2 | 1 小时 |
| **#6** | 历史数组溢出 | 🟡 中 | 内存安全 | P1 | 30 分钟 |

### 6.2 修复里程碑

#### M1: P0 关键修复（1 天内）
- [ ] **问题 #1**: 实施对称恢复机制
  - 添加连胜乘数
  - 每次连胜都给予奖励
  - 实施每日扣分上限
  - 扩展 Grace Failure 覆盖高风险失败

- [ ] **问题 #2**: 实施文件损坏恢复机制
  - 备份恢复（`.bak` 文件）
  - 原子写入（临时文件 + 重命名）
  - 保留损坏文件供分析
  - 记录恢复事件到事件日志

#### M2: P1 重要修复（2 天内）
- [ ] **问题 #3**: 添加 Gate 并发控制
  - Mutex 互斥锁
  - 原子性 trackBlock
  - 调用 eventLog.recordGateBlock()

- [ ] **问题 #4**: 统一行数限制配置
  - 统一配置来源
  - 文件类型感知限制
  - 更新测试用例

- [ ] **问题 #6**: 添加历史数组安全限制
  - 最大 500 条限制
  - 自动截断警告

#### M3: P2 优化修复（3 天内）
- [ ] **问题 #5**: 扩展探索性工具分类
  - 完善工具列表
  - 动态分类机制
  - 白名单支持

---

## 📝 7. 总结

### 7.1 关键发现

1. **信任分系统架构成熟**：由 5 个核心组件构成，形成完整的信任-门禁-记录链路
2. **扣分/加分算法严重不对称**：扣分速度比加分快 10 倍，导致恢复困难
3. **探索性/建设性工具分类机制**：区分无害失败和建设性失败，但分类列表有漏洞
4. **Grace Failure 机制设计合理**：冷启动期间提供 5 次免费失败机会，但对高风险失败无效
5. **Stage 门禁集成紧密**：信任分直接控制 Agent 的权限级别（1-4 阶段）
6. **6 大问题点**：
   - 扣分/加分不对称（恢复困难）
   - 文件损坏无恢复机制（数据丢失）
   - Gate 并发竞态条件（统计不准确）
   - 行数限制配置不一致（用户体验差）
   - 探索性工具分类漏洞（误扣分）
   - 历史数组溢出风险（内存泄漏）

### 7.2 建议修复顺序

1. **立即修复（P0）**：
   - 扣分/加分对称机制
   - 文件损坏恢复机制

2. **短期修复（P1）**：
   - Gate 并发控制
   - 行数限制统一
   - 历史数组安全限制

3. **中期优化（P2）**：
   - 探索性工具分类完善

### 7.3 长期改进建议

1. **动态信任调整**：根据历史成功率动态调整奖励/惩罚系数
2. **多维度信任评估**：不仅基于工具调用，还考虑任务完成度、用户反馈等
3. **可配置信任策略**：允许用户自定义信任分算法和阈值
4. **信任分可视化**：提供 UI 界面展示信任分变化趋势和影响因素
5. **信任分导出/导入**：支持信任分备份和迁移

---

**文档版本**: v1.0
**创建时间**: 2026-03-12 22:30 UTC
**分析者**: Explorer Subagent (ep-explorer)
**交付路径**: `/home/csuzngjh/clawd/workspace/code/principles/docs/evidence/trust-system-full-analysis.md`

---

## 📎 附录

### A. 关键文件清单

| 文件路径 | 行数 | 说明 |
|---------|------|------|
| `packages/openclaw-plugin/src/core/trust-engine.ts` | 300+ | 信任引擎核心 |
| `packages/openclaw-plugin/src/hooks/gate.ts` | 191 | 门禁逻辑 |
| `packages/openclaw-plugin/src/core/config.ts` | 271 | 配置定义 |
| `packages/openclaw-plugin/src/core/config-service.ts` | 27 | 配置服务 |
| `packages/openclaw-plugin/src/core/event-log.ts` | 240+ | 事件日志 |
| `packages/openclaw-plugin/src/service/evolution-worker.ts` | 280+ | 进化工作器 |
| `packages/openclaw-plugin/src/core/risk-calculator.ts` | 54 | 风险计算器 |

### B. 相关文档引用

- **Issue #18 证据**: `docs/evidence/ISSUE-18-evidence.md`（待创建）
- **Issue #19 证据**: `docs/evidence/ISSUE-19-evidence.md`（待创建）
- **Issue #20 证据**: `docs/evidence/ISSUE-20-evidence.md`
- **Issue #18 修复提案**: `docs/fixes/ISSUE-18-fix-proposal.md`
- **Issue #19 修复提案**: `docs/fixes/ISSUE-19-fix-proposal.md`
- **Issue #20 修复提案**: `docs/fixes/ISSUE-20-fix-proposal.md`
- **架构地图**: `docs/maps/trust-gate-architecture.md`
- **风险分析**: `docs/risks/potential-risks.md`

### C. 数据结构完整定义

参见第 1 节（数据结构定义）

### D. 扣分/加分公式完整定义

参见第 2 节（扣分/加分算法完整公式）

### E. 与 gate.ts 的集成点完整分析

参见第 3 节（与 gate.ts 的集成点）

### F. 所有问题点详细分析

参见第 4 节（当前实现的所有问题点）
