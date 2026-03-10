# Trust Engine V2 - 自适应信任系统

## 概述

Trust Engine V2 实现了一个**智能的、自适应的信任系统**，解决传统信任系统的"冷启动"问题，同时提供更公平的惩罚和奖励机制。

## 核心特性

### 1. 冷启动友好（Cold Start）

新智能体获得"新手保护期"：

```typescript
COLD_START: {
    INITIAL_TRUST: 59,           // 初始分数（Stage 2）
    GRACE_FAILURES: 3,           // 3次"免死金牌"
    COLD_START_PERIOD: 24h,      // 24小时保护期
}
```

**效果**：
- 新智能体从 Stage 2（Editor）开始，而不是 Stage 1
- 前3次失败不扣分（使用 grace failures）
- 24小时内的惩罚减半

### 2. 自适应惩罚（Adaptive Penalties）

惩罚根据历史表现动态调整：

```typescript
// 基础惩罚
PENALTIES: {
    TOOL_FAILURE_BASE: -8,       // 工具失败
    RISKY_FAILURE_BASE: -15,     // 风险操作失败
    GATE_BYPASS_ATTEMPT: -5,     // 绕过门禁尝试
    FAILURE_STREAK_MULTIPLIER: -3, // 每次连续失败额外惩罚
    MAX_PENALTY: -25,            // 最大惩罚上限
}
```

**自适应规则**：
- 连续失败加重惩罚（每次额外-3分）
- 70%+ 失败率：惩罚增加 30%
- 30%- 失败率：惩罚减少 30%
- 单次最大惩罚：-25 分（防止一次失误毁灭信任）

**示例**：
```typescript
// 场景1：连续失败
第1次失败：-8 分
第2次失败：-11 分 (-8 + -3)
第3次失败：-14 分 (-8 + -3*2)
第4次失败：-17 分 (-8 + -3*3)

// 场景2：表现良好后的偶尔失败
历史成功率高：-8 * 0.7 = -5.6 ≈ -5 分
```

### 3. 自适应奖励（Adaptive Rewards）

奖励根据连续成功动态调整：

```typescript
REWARDS: {
    SUCCESS_BASE: 1,             // 基础奖励
    SUBAGENT_SUCCESS: 3,         // 子智能体成功
    RECOVERY_BOOST: 3,           // 失败后恢复的额外奖励
    STREAK_BONUS_THRESHOLD: 5,   // 连胜奖励门槛
    STREAK_BONUS: 5,             // 连胜基础奖励
    MAX_REWARD: 10,              // 单次最大奖励
}
```

**奖励规则**：
- 失败后成功：+4 分（基础1 + 恢复3）
- 连续 5+ 次成功：+6 分（基础1 + 连胜5）
- 连续 10+ 次成功：+11 → +10 分（上限）
- 子智能体成功额外：+3 分

**示例**：
```typescript
// 场景1：失败后恢复
连续3次失败 → 第1次成功 → +4 分

// 场景2：连胜积累
第5次成功：+6 分
第10次成功：+11 → +10 分（上限）

// 场景3：高成功率
最近10次8次成功 → 奖励 +2 分
```

## 配置文件

### AGENT_SCORECARD.json 结构

```json
{
  "trust_score": 59,
  "wins": 10,
  "losses": 2,
  "success_streak": 5,
  "failure_streak": 0,
  "first_activity_at": "2026-03-10T08:00:00.000Z",
  "last_activity_at": "2026-03-10T15:30:00.000Z",
  "grace_failures_remaining": 3,
  "recent_history": [
    "success", "success", "failure", "success", "success",
    "success", "success", "success", "success", "success"
  ]
}
```

### 自定义配置

修改 `src/core/trust-engine-v2.ts` 中的 `TRUST_CONFIG`：

```typescript
export const TRUST_CONFIG = {
    COLD_START: {
        INITIAL_TRUST: 59,              // 调整初始分数
        GRACE_FAILURES: 5,              // 增加到5次免死金牌
        COLD_START_PERIOD: 48 * 60 * 60 * 1000, // 延长到48小时
    },
    PENALTIES: {
        TOOL_FAILURE_BASE: -5,          // 减少基础惩罚
        MAX_PENALTY: -20,               // 降低最大惩罚
    },
    REWARDS: {
        MAX_REWARD: 15,                 // 提高最大奖励
        RECOVERY_BOOST: 5,              // 增强恢复奖励
    },
};
```

## API 使用

### 记录成功操作

```typescript
import { recordSuccess } from './trust-engine-v2.js';

// 普通成功
const newScore = recordSuccess(workspaceDir, 'success', ctx);

// 子智能体成功
const newScore = recordSuccess(workspaceDir, 'subagent_success', ctx);
```

### 记录失败操作

```typescript
import { recordFailure } from './trust-engine-v2.js';

// 工具失败
const newScore = recordFailure(workspaceDir, 'tool', ctx);

// 风险操作失败
const newScore = recordFailure(workspaceDir, 'risky', ctx);

// 绕过门禁尝试
const newScore = recordFailure(workspaceDir, 'bypass', ctx);
```

### 获取信任统计

```typescript
import { getAgentScorecard, getTrustStats, getTrustStage } from './trust-engine-v2.js';

const scorecard = getAgentScorecard(workspaceDir);
const stats = getTrustStats(scorecard);
const stage = getTrustStage(scorecard);

console.log(`
  Stage: ${stats.stage}
  Success Rate: ${stats.successRate}%
  In Cold Start: ${stats.isInColdStart}
  Grace Remaining: ${stats.graceRemaining}
  Current Streak: ${stats.currentStreak.type} (${stats.currentStreak.count})
`);
```

## 阶段划分

```typescript
STAGES: {
    STAGE_1_OBSERVER: 30,    // 0-29: 只能观察
    STAGE_2_EDITOR: 60,      // 30-59: 编辑权限
    STAGE_3_DEVELOPER: 80,   // 60-79: 开发权限
    // 80-100: 架构师权限
}
```

## 迁移指南

### 从 V1 迁移到 V2

1. **备份现有数据**
   ```bash
   cp docs/AGENT_SCORECARD.json docs/AGENT_SCORECARD.json.backup
   ```

2. **替换导入**
   ```typescript
   // 旧版本
   import { adjustTrustScore } from './trust-engine.js';

   // 新版本
   import { recordSuccess, recordFailure } from './trust-engine-v2.js';
   ```

3. **更新调用点**
   ```typescript
   // 旧版本
   adjustTrustScore(workspaceDir, 5, 'operation success', ctx);
   adjustTrustScore(workspaceDir, -10, 'operation failed', ctx);

   // 新版本
   recordSuccess(workspaceDir, 'success', ctx);
   recordFailure(workspaceDir, 'tool', ctx);
   ```

4. **自动迁移**
   V2 会自动检测旧格式的 scorecard 并迁移：
   - 添加 `first_activity_at` 和 `last_activity_at`
   - 初始化 `grace_failures_remaining` 为 3
   - 创建空的 `recent_history` 数组

## 最佳实践

### 1. 监控信任变化

```typescript
// 在工具调用后记录成功
try {
    await executeTool(tool, params);
    recordSuccess(workspaceDir, 'success', ctx);
} catch (error) {
    recordFailure(workspaceDir, 'tool', ctx);
}
```

### 2. 根据阶段调整行为

```typescript
const stage = getTrustStage(getAgentScorecard(workspaceDir));

if (stage === 1) {
    // Stage 1: 限制操作，提供详细指导
    return { canProceed: false, message: '请先创建详细计划' };
} else if (stage === 2) {
    // Stage 2: 允许小规模修改
    return { canProceed: true, maxLines: 10 };
} else if (stage >= 3) {
    // Stage 3+: 几乎无限制
    return { canProceed: true };
}
```

### 3. 定期审查信任统计

```typescript
const stats = getTrustStats(getAgentScorecard(workspaceDir));

if (stats.successRate < 50 && stats.currentStreak.count > 5) {
    logger.warn('智能体表现持续不佳，可能需要人工干预');
}
```

## 故障排除

### 问题：信任分数不变化

**原因**：`grace_failures_remaining` 还有余额

**解决**：等待 grace failures 用完，或手动重置：
```json
{
  "grace_failures_remaining": 0
}
```

### 问题：惩罚太重

**原因**：连续失败导致惩罚累积

**解决**：调整配置：
```typescript
FAILURE_STREAK_MULTIPLIER: -2,  // 降低连败惩罚
MAX_PENALTY: -15,                // 降低最大惩罚
```

### 问题：冷启动期太长

**原因**：`COLD_START_PERIOD` 设置太长

**解决**：缩短保护期：
```typescript
COLD_START_PERIOD: 12 * 60 * 60 * 1000, // 12小时
```

## 性能考虑

- **文件I/O**: 每次成功/失败都会读写文件，不适合高频场景
- **历史窗口**: 默认保留20条历史，可通过 `RECENT_HISTORY_SIZE` 调整
- **缓存**: 建议在应用层缓存 scorecard，定期刷新

## 未来改进

- [ ] 添加信任分数衰减机制（长期不活跃自动降低）
- [ ] 实现信任恢复曲线（低谷后快速恢复）
- [ ] 支持多维度信任（不同类型操作的独立分数）
- [ ] 添加信任预测（基于历史趋势预测未来表现）
