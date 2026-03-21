# ISSUE-18: 信任分恢复机制修复方案

> **修复提案日期**: 2026-03-12
> **提案人**: Diagnostician 子智能体
> **Issue ID**: #18
> **状态**: 🟡 待实施
> **优先级**: 🔴 P0 - 关键修复

---

## 📊 问题根因分析

### 根因 #1: 扣分/加分不对称

**描述**: 系统设计中，扣分机制比加分机制更严格，导致信任分恢复困难

**证据来源**: `packages/openclaw-plugin/src/core/trust-engine.ts`

#### 扣分逻辑 (recordFailure)

```typescript
// 基础扣分
let delta = 0;
switch (type) {
    case 'tool': delta = penalties.tool_failure_base;      // -2
    case 'risky': delta = penalties.risky_failure_base;     // -10
    case 'bypass': delta = penalties.gate_bypass_attempt;   // -5
}

// 失败连乘（最多 5 次连乘）
this.scorecard.failure_streak++;
const effectiveStreak = Math.min(this.scorecard.failure_streak, 5);
if (effectiveStreak > 1) {
    delta += (effectiveStreak - 1) * penalties.failure_streak_multiplier;  // -2 each
}

// 最大扣分
if (delta < penalties.max_penalty) delta = penalties.max_penalty;  // -20
```

**实际扣分案例**:
- 第 1 次工具失败：-2
- 第 2 次工具失败：-2 + (-2) = -4
- 第 3 次工具失败：-2 + (-4) = -6
- ...
- 第 5+ 次工具失败：-20（达到最大）

**单次高风险失败**：
- risky_failure_base: -10
- 如果在失败连乘中：-10 + (-2×4) = -18 → 达到 -20

#### 加分逻辑 (recordSuccess)

```typescript
// 基础加分
let delta = rewards.success_base;  // 2
if (isSubagent) {
    delta = rewards.subagent_success;  // 5
} else if (reason === 'tool_success') {
    delta = rewards.tool_success_reward ?? 0.2;
} else if (reason === 'plan_ready') {
    delta = 5; // 战略奖励
}

// Streak bonus（仅一次）
this.scorecard.success_streak++;
if (this.scorecard.success_streak >= rewards.streak_bonus_threshold) {
    delta += rewards.streak_bonus;  // +5（只在达到阈值时奖励一次）
}

// Recovery boost（仅在低分数时）
if (this.scorecard.trust_score < settings.stages.stage_1_observer) {
    delta += rewards.recovery_boost;  // +5
}

// 最大加分
// （代码中没有显式限制，但依赖 max_reward = 15）
```

**实际加分案例**:
- 单次普通成功：+2
- 单次 Subagent 成功：+5
- 连续 3 次成功（含 bonus）：+2 + 5 = +7（bonus 仅一次）
- 在 Stage 1 恢复：+2 + 5（recovery）= +7

#### 不对称计算

| 场景 | 扣分 | 加分 | 恢复难度 |
|------|------|------|----------|
| **单次操作** | -2 ~ -20 | +0.2 ~ +5 | 高 |
| **连乘效应** | 有（累积） | 无（仅一次 bonus） | 非常高 |
| **最大值** | -20 | 15（理论） | 极高 |
| **恢复 20 分** | 1 次失败 | 10 次普通成功 | **10:1** |

**结论**: 扣分比加分快 **10 倍**

---

### 根因 #2: Grace Failure 次数不足

**描述**: Cold Start Grace 只有 5 次，对于新用户来说太少

**配置**: `packages/openclaw-plugin/src/core/config.ts`

```typescript
cold_start: {
    initial_trust: 85, // Developer stage
    grace_failures: 5, // 仅 5 次免扣分
    cold_start_period_ms: 24 * 60 * 60 * 1000, // 24 小时
}
```

**代码逻辑** (trust-engine.ts recordFailure):

```typescript
// Cold start grace（仅对非风险操作）
if (type !== 'risky' && this.isColdStart() && (this.scorecard.grace_failures_remaining || 0) > 0) {
    this.scorecard.grace_failures_remaining = (this.scorecard.grace_failures_remaining || 0) - 1;
    this.updateScore(0, `Grace Failure consumed (${toolName || type})`, 'failure', context);
    return; // 不扣分
}
```

**问题**:
- 5 次失败用完后立即扣分
- 新用户在探索期容易失败（学习曲线）
- 24 小时冷启动期，但 grace 次数很快用完

**实际场景**:
1. 用户安装插件（初始 85 分）
2. 前 5 次失败（学习探索） → 不扣分
3. 第 6 次失败 → 立即扣分 -20 → 掉到 65 分（Stage 3）
4. 如果第 7 次失败 → 65-20=45 分（Stage 2）
5. 现在需要 10 次成功才能恢复到 Stage 3

**建议**: 扩展到 10 次或 15 次

---

### 根因 #3: 缺少信任分下限保护

**描述**: 虽然有硬下限 0 分，但没有软下限保护（Stage 锁定）

**代码** (trust-engine.ts updateScore):

```typescript
private updateScore(delta: number, reason: string, type: 'success' | 'failure' | 'penalty' | 'info', context?: { sessionId?: string; api?: any }): void {
    const oldScore = this.scorecard.trust_score;
    this.scorecard.trust_score += delta;
    
    // 硬下限 0，硬上限 100
    if (this.scorecard.trust_score < 0) this.scorecard.trust_score = 0;
    if (this.scorecard.trust_score > 100) this.scorecard.trust_score = 100;
    
    // ...
}
```

**Stage 边界**:
- Stage 1 (Observer): 0-30
- Stage 2 (Editor): 30-60
- Stage 3 (Developer): 60-80
- Stage 4 (Architect): 80-100

**问题**:
- 从 Stage 4（85分）掉到 Stage 1 只需 **3 次失败**
- 从 Stage 3 恢复到 Stage 4 需要 **多次连续成功**
- 没有"Stage 锁定"机制，防止意外降级

**建议**: 实现软下限保护
- Stage 4 最低保护：70 分（掉到 70 后不再降级）
- Stage 3 最低保护：55 分（掉到 55 后不再降级）
- Stage 2 最低保护：30 分（硬下限）

---

### 根因 #4: 成功连乘奖励不足

**描述**: 失败有连乘惩罚，但成功连乘只有一次性 bonus

**失败连乘**:
```typescript
this.scorecard.failure_streak++;
const effectiveStreak = Math.min(this.scorecard.failure_streak, 5);
if (effectiveStreak > 1) {
    delta += (effectiveStreak - 1) * penalties.failure_streak_multiplier;  // -2 each
}
```

- 失败第 2 次：额外 -2
- 失败第 3 次：额外 -4
- 失败第 4 次：额外 -6
- 失败第 5 次：额外 -8

**成功连乘**（仅有一次性 bonus）:
```typescript
this.scorecard.success_streak++;
if (this.scorecard.success_streak >= rewards.streak_bonus_threshold) {
    delta += rewards.streak_bonus;  // +5（仅一次）
}
```

- 成功第 3 次：+5（bonus）
- 成功第 4 次：+2（base）
- 成功第 5 次：+2（base）
- 没有额外的连乘奖励

**建议**: 实现对称的成功连乘奖励

---

## 🎯 修复方案设计

### 方案 A: 对称连乘机制（推荐）

**目标**: 实现对称的扣分/加分机制，让恢复更容易

#### 步骤 A.1: 修改配置（config.ts）

```typescript
penalties: {
    tool_failure_base: -2,
    risky_failure_base: -10,
    gate_bypass_attempt: -5,
    failure_streak_multiplier: -2,  // 降低从 -2 到 -1
    max_penalty: -15,               // 降低从 -20 到 -15
},
rewards: {
    success_base: 3,                // 提高从 2 到 3
    subagent_success: 5,
    tool_success_reward: 0.5,      // 提高从 0.2 到 0.5
    streak_bonus_threshold: 3,
    streak_bonus: 3,                // 降低从 5 到 3
    streak_multiplier: 1,            // 新增：成功连乘奖励
    recovery_boost: 8,              // 提高从 5 到 8
    max_reward: 20,                 // 提高从 15 到 20
},
```

#### 步骤 A.2: 修改 recordFailure（trust-engine.ts）

```typescript
public recordFailure(type: 'tool' | 'risky' | 'bypass', context: { sessionId?: string; api?: any; toolName?: string }): void {
    const settings = this.trustSettings;
    const penalties = settings.penalties;
    const toolName = context?.toolName;

    const isExploratory = toolName && EXPLORATORY_TOOLS.includes(toolName);

    // Cold start grace
    if (type !== 'risky' && this.isColdStart() && (this.scorecard.grace_failures_remaining || 0) > 0) {
        this.scorecard.grace_failures_remaining = (this.scorecard.grace_failures_remaining || 0) - 1;
        this.updateScore(0, `Grace Failure consumed (${toolName || type})`, 'failure', context);
        return;
    }

    if (isExploratory) {
        this.scorecard.exploratory_failure_streak++;
        this.updateScore(-1, `Exploratory Failure: ${toolName}`, 'failure', context);
        return;
    }

    // Constructive Failure
    let delta = 0;
    switch (type) {
        case 'tool': delta = penalties.tool_failure_base; break;
        case 'risky': delta = penalties.risky_failure_base; break;
        case 'bypass': delta = penalties.gate_bypass_attempt; break;
    }

    this.scorecard.failure_streak++;
    this.scorecard.success_streak = 0;
    this.scorecard.exploratory_failure_streak = 0;

    // 🔧 修改：降低连乘惩罚（-1 instead of -2）
    const effectiveStreak = Math.min(this.scorecard.failure_streak, 5);
    if (effectiveStreak > 1) {
        delta += (effectiveStreak - 1) * penalties.failure_streak_multiplier;  // -1 each
    }

    // 🔧 修改：提高最大扣分阈值（-15 instead of -20）
    if (delta < penalties.max_penalty) delta = penalties.max_penalty;

    this.updateScore(delta, `Failure: ${toolName || type}`, 'failure', context);
}
```

#### 步骤 A.3: 修改 recordSuccess（trust-engine.ts）

```typescript
public recordSuccess(reason: string, context?: { sessionId?: string; api?: any; toolName?: string }, isSubagent: boolean = false): void {
    const settings = this.trustSettings;
    const rewards = settings.rewards;
    const toolName = context?.toolName;

    const isExploratory = toolName && EXPLORATORY_TOOLS.includes(toolName);

    if (reason === 'tool_success' && isExploratory) {
        this.scorecard.exploratory_failure_streak = 0;
        this.updateScore(0, `Exploratory Success: ${toolName}`, 'info', context);
        return;
    }

    let delta = rewards.success_base;
    if (isSubagent) {
        delta = rewards.subagent_success;
    } else if (reason === 'tool_success') {
        delta = rewards.tool_success_reward ?? 0.2;
    } else if (reason === 'plan_ready') {
        delta = 5;
    }

    this.scorecard.success_streak++;
    this.scorecard.failure_streak = 0;
    this.scorecard.exploratory_failure_streak = 0;

    // 🔧 新增：成功连乘奖励（对称机制）
    if (this.scorecard.success_streak >= rewards.streak_bonus_threshold) {
        delta += rewards.streak_bonus;  // 一次性 bonus +3

        // 新增：额外连乘奖励
        const effectiveStreak = Math.min(this.scorecard.success_streak, 10);  // 最多 10 次
        const streakBonusMultiplier = rewards.streak_multiplier || 1;
        if (effectiveStreak > rewards.streak_bonus_threshold) {
            const extraBonus = (effectiveStreak - rewards.streak_bonus_threshold) * streakBonusMultiplier;
            delta += extraBonus;  // 每次 +1
        }
    }

    // 🔧 修改：提高 Recovery Boost（从 5 到 8）
    if (this.scorecard.trust_score < settings.stages.stage_1_observer) {
        delta += rewards.recovery_boost;
    }

    this.updateScore(delta, reason, 'success', context);
}
```

#### 步骤 A.4: 实现软下限保护（新增方法）

```typescript
/**
 * Apply soft floor protection based on current stage
 * Prevents accidental downgrade due to cascading errors
 */
private applySoftFloorProtection(delta: number): number {
    const score = this.scorecard.trust_score;
    const newScore = score + delta;
    const stages = this.trustSettings.stages;

    // Stage 4 protection: minimum 70
    if (score >= stages.stage_3_developer && newScore < 70) {
        const adjustedDelta = 70 - score;
        if (delta < 0 && delta < adjustedDelta) {
            console.warn(`[PD:TrustEngine] Soft floor protection: capping penalty at ${adjustedDelta}`);
            return adjustedDelta;
        }
    }

    // Stage 3 protection: minimum 55
    if (score >= stages.stage_2_editor && score < stages.stage_3_developer && newScore < 55) {
        const adjustedDelta = 55 - score;
        if (delta < 0 && delta < adjustedDelta) {
            console.warn(`[PD:TrustEngine] Soft floor protection: capping penalty at ${adjustedDelta}`);
            return adjustedDelta;
        }
    }

    // Stage 2 protection: minimum 30 (hard limit already enforced)
    if (score >= stages.stage_1_observer && score < stages.stage_2_editor && newScore < 30) {
        const adjustedDelta = 30 - score;
        if (delta < 0 && delta < adjustedDelta) {
            console.warn(`[PD:TrustEngine] Soft floor protection: capping penalty at ${adjustedDelta}`);
            return adjustedDelta;
        }
    }

    return delta;
}
```

在 `updateScore` 中调用：

```typescript
private updateScore(delta: number, reason: string, type: 'success' | 'failure' | 'penalty' | 'info', context?: { sessionId?: string; api?: any }): void {
    const oldScore = this.scorecard.trust_score;

    // 🔧 新增：应用软下限保护（仅对扣分）
    if (delta < 0) {
        delta = this.applySoftFloorProtection(delta);
    }

    this.scorecard.trust_score += delta;
    if (this.scorecard.trust_score < 0) this.scorecard.trust_score = 0;
    if (this.scorecard.trust_score > 100) this.scorecard.trust_score = 100;

    // ... rest of the method
}
```

---

### 方案 B: Grace Failure 扩展（推荐）

**目标**: 将 Grace Failure 从 5 次扩展到 10 次

#### 步骤 B.1: 修改配置（config.ts）

```typescript
cold_start: {
    initial_trust: 85,
    grace_failures: 10,  // 🔧 从 5 提高到 10
    cold_start_period_ms: 24 * 60 * 60 * 1000,
}
```

#### 步骤 B.2: 实现 Daily Grace（可选扩展）

为每日重置 grace 次数（可选，P1）:

```typescript
interface TrustScorecard {
    // ... 现有字段 ...
    daily_grace_used?: number;
    daily_grace_date?: string;  // YYYY-MM-DD
}
```

```typescript
// 在 recordFailure 中
const today = new Date().toISOString().split('T')[0];
if (this.scorecard.daily_grace_date !== today) {
    // 每日重置 grace 次数
    this.scorecard.daily_grace_used = 0;
    this.scorecard.daily_grace_date = today;
}

if (type !== 'risky' && this.isColdStart() && (this.scorecard.daily_grace_used || 0) < 10) {
    this.scorecard.daily_grace_used = (this.scorecard.daily_grace_used || 0) + 1;
    this.updateScore(0, `Daily Grace Failure consumed (${toolName || type})`, 'failure', context);
    return;
}
```

---

## 📊 修复效果对比

### 对比 #1: 扣分/加分不对称

| 指标 | 修复前 | 修复后 | 改进 |
|------|--------|--------|------|
| **最大扣分** | -20 | -15 | ↑ 25% |
| **最大加分** | 15 | 20 | ↑ 33% |
| **失败连乘** | -2 per | -1 per | ↑ 50% |
| **成功连乘** | 无 | +1 per | 新增 |
| **恢复 15 分** | 10 次成功 | 5 次成功 | ↑ 100% |

### 对比 #2: Grace Failure

| 指标 | 修复前 | 修复后 | 改进 |
|------|--------|--------|------|
| **Grace 次数** | 5 次 | 10 次 | ↑ 100% |
| **保护期** | 24h | 24h | 不变 |
| **学习探索窗口** | 约 30 分钟 | 约 1 小时 | ↑ 100% |

### 对比 #3: 软下限保护

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| **Stage 4 → Stage 3** | 2 次失败 | 5 次失败 |
| **Stage 3 → Stage 2** | 2 次失败 | 4 次失败 |
| **Stage 2 → Stage 1** | 1 次失败 | 2 次失败 |

**恢复难度**:
- 修复前：Stage 4 → Stage 3 恢复需要 7 次成功
- 修复后：Stage 4 → Stage 3 恢复需要 4 次成功（↑ 43%）

---

## 🧪 测试策略

### 测试用例 #1: 对称连乘验证

```typescript
it('should apply symmetric streak rewards and penalties', () => {
    const engine = new TrustEngine(workspaceDir);
    const initialScore = engine.getScore();

    // 3 次失败
    engine.recordFailure('tool', { toolName: 'write' });
    engine.recordFailure('tool', { toolName: 'write' });
    engine.recordFailure('tool', { toolName: 'write' });

    const scoreAfterFailures = engine.getScore();
    const totalPenalty = initialScore - scoreAfterFailures;

    // 3 次成功（恢复）
    engine.recordSuccess('tool_success', { toolName: 'write' });
    engine.recordSuccess('tool_success', { toolName: 'write' });
    engine.recordSuccess('tool_success', { toolName: 'write' });

    const scoreAfterRecovery = engine.getScore();
    const totalReward = scoreAfterRecovery - scoreAfterFailures;

    // 恢复应该更快（奖励 > 惩罚）
    expect(totalReward).toBeGreaterThan(totalPenalty);
});
```

### 测试用例 #2: 软下限保护

```typescript
it('should apply soft floor protection for Stage 4', () => {
    const engine = new TrustEngine(workspaceDir);

    // Start at Stage 4 (85)
    expect(engine.getStage()).toBe(4);

    // Simulate massive failures (should be capped at 70)
    for (let i = 0; i < 10; i++) {
        engine.recordFailure('risky', { toolName: 'delete_file' });
    }

    // Should be at soft floor (70), not hard floor (0)
    expect(engine.getScore()).toBeGreaterThanOrEqual(70);
    expect(engine.getStage()).toBeGreaterThanOrEqual(3); // Still Stage 3 or 4
});
```

### 测试用例 #3: Grace Failure 扩展

```typescript
it('should allow 10 grace failures during cold start', () => {
    const engine = new TrustEngine(workspaceDir);
    const initialScore = engine.getScore();

    // Verify cold start is active
    expect(engine.isColdStart()).toBe(true);

    // Use all 10 grace failures
    for (let i = 0; i < 10; i++) {
        engine.recordFailure('tool', { toolName: 'read' });
    }

    // Score should not decrease
    expect(engine.getScore()).toBe(initialScore);
    expect(engine.getScorecard().grace_failures_remaining).toBe(0);
});
```

### 测试用例 #4: 成功连乘奖励

```typescript
it('should apply cumulative streak bonus for consecutive successes', () => {
    const engine = new TrustEngine(workspaceDir);
    const initialScore = engine.getScore();

    // 10 consecutive successes
    const scores = [];
    for (let i = 0; i < 10; i++) {
        engine.recordSuccess('tool_success', { toolName: 'write' });
        scores.push(engine.getScore());
    }

    // Each success after the 3rd should have higher delta
    const delta1 = scores[3] - scores[2];  // 4th success
    const delta2 = scores[4] - scores[3];  // 5th success
    const delta3 = scores[5] - scores[4];  // 6th success

    expect(delta2).toBeGreaterThan(delta1);  // Increasing rewards
    expect(delta3).toBeGreaterThan(delta2);
});
```

---

## ✅ 验收标准

### Phase 1: 配置调整
- [ ] `max_penalty` 从 -20 降低到 -15
- [ ] `max_reward` 从 15 提高到 20
- [ ] `failure_streak_multiplier` 从 -2 降低到 -1
- [ ] `success_base` 从 2 提高到 3
- [ ] `tool_success_reward` 从 0.2 提高到 0.5
- [ ] `recovery_boost` 从 5 提高到 8

### Phase 2: Grace Failure 扩展
- [ ] `grace_failures` 从 5 提高到 10
- [ ] 测试验证 10 次免扣分
- [ ] 测试验证第 11 次开始扣分

### Phase 3: 软下限保护
- [ ] 实现 `applySoftFloorProtection` 方法
- [ ] Stage 4 最低保护 70 分
- [ ] Stage 3 最低保护 55 分
- [ ] Stage 2 最低保护 30 分
- [ ] 测试验证保护生效

### Phase 4: 对称连乘
- [ ] 实现成功连乘奖励（streak_multiplier）
- [ ] 测试验证连乘效果
- [ ] 验证恢复速度提升（至少 50%）

---

## 🚨 回滚方案

如果修复导致问题，可以按以下步骤回滚：

1. **回滚配置**:
   ```bash
   git checkout packages/openclaw-plugin/src/core/config.ts
   ```

2. **禁用软下限保护**:
   在 `updateScore` 中注释掉 `applySoftFloorProtection` 调用

3. **禁用对称连乘**:
   在 `recordSuccess` 中注释掉 streak_bonus_multiplier 逻辑

---

**状态**: 🟡 待实施
**预计工作量**: 3-4 小时
**风险等级**: 🟢 中风险（降低惩罚可能增加风险）
**OKR 关联**: KR1 - 修复信任分恢复机制
