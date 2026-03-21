# Evolution Points System v2.0 - MVP 设计方案

> **版本**: v2.0 (基于 v1.0 全面评审后的简化版)
> **日期**: 2026-03-12
> **评审来源**: Gemini CLI + Claude CLI + 内部交叉评审 + 架构评审
> **设计原则**: 小步快跑，核心先行
> **状态**: ✅ **已实现** (Evolution Engine V2.0)

---

## v1.0 → v2.0 变更摘要

| 维度 | v1.0 | v2.0 | 原因 |
|------|------|------|------|
| 等级数 | 0-20 级 | **5 级** (Seed→Forest) | 三路评审共识：20级过多 |
| 积分模型 | 只增不减 | **总积分 + 可用积分** | 防止满级后失去意义 |
| 双倍奖励 | 无条件触发 | **1小时冷却 + 质量审核** | 防博弈 |
| 学习模式 | 完整实现 | **MVP 砍掉** | 非核心，v2.1 再加 |
| 徽章/技能树 | 有 | **MVP 砍掉** | 过度设计 |
| 存储策略 | 保存所有事件 | **快照 + 最近50条** | 防文件膨胀 |
| 双轨运行 | 完整双轨 | **单轨替代** | 避免权限冲突 |
| 防刷分 | 3层防护 | **冷却期 + 难度衰减** | 更简洁有效 |

---

## 核心接口定义 (v2.0)

```typescript
// ===== 等级定义：5级 =====
export enum EvolutionTier {
  Seed = 1,      // 萌芽：只读 + 基础文档
  Sprout = 2,    // 新芽：单文件编辑 (<50行)
  Sapling = 3,   // 幼苗：多文件 + 测试
  Tree = 4,       // 大树：重构 + 风险路径
  Forest = 5      // 森林：完全自主
}

export interface TierDefinition {
  tier: EvolutionTier;
  name: string;
  requiredPoints: number;  // 达到该级需要的总积分
  permissions: {
    maxLinesPerWrite: number;
    maxFilesPerTask: number;
    allowRiskPath: boolean;
    allowSubagentSpawn: boolean;
  };
}

export const TIER_DEFINITIONS: TierDefinition[] = [
  { tier: 1, name: 'Seed',   requiredPoints: 0,    permissions: { maxLinesPerWrite: 20,  maxFilesPerTask: 1, allowRiskPath: false, allowSubagentSpawn: false }},
  { tier: 2, name: 'Sprout', requiredPoints: 50,   permissions: { maxLinesPerWrite: 50,  maxFilesPerTask: 2, allowRiskPath: false, allowSubagentSpawn: false }},
  { tier: 3, name: 'Sapling',requiredPoints: 200,  permissions: { maxLinesPerWrite: 200, maxFilesPerTask: 5, allowRiskPath: false, allowSubagentSpawn: true  }},
  { tier: 4, name: 'Tree',   requiredPoints: 500,  permissions: { maxLinesPerWrite: 500, maxFilesPerTask: 10,allowRiskPath: true,  allowSubagentSpawn: true  }},
  { tier: 5, name: 'Forest', requiredPoints: 1000, permissions: { maxLinesPerWrite: Infinity, maxFilesPerTask: Infinity, allowRiskPath: true, allowSubagentSpawn: true }},
];

// ===== 积分卡 =====
export interface EvolutionScorecard {
  version: '2.0';
  agentId: string;
  
  // 双积分模型
  totalPoints: number;      // 历史累计（用于等级计算）
  availablePoints: number;  // 可用积分（用于能力消耗）
  
  // 当前等级
  currentTier: EvolutionTier;
  
  // 防刷分状态
  lastDoubleRewardTime?: string;  // 上次双倍奖励时间（冷却用）
  recentTaskHashes: string[];     // 最近任务哈希（防重复）
  
  // 统计
  stats: {
    totalSuccesses: number;
    totalFailures: number;
    consecutiveSuccesses: number;
    consecutiveFailures: number;
  };
  
  lastUpdated: string;
}

// ===== 进化事件 =====
export interface EvolutionEvent {
  id: string;
  timestamp: string;
  type: 'success' | 'failure';
  taskHash: string;         // 任务唯一哈希（工具+文件路径）
  taskDifficulty: 'trivial' | 'normal' | 'hard';
  pointsAwarded: number;
  isDoubleReward: boolean;
}
```

---

## 积分算法 (v2.0)

### 基础积分规则

```typescript
function calculatePoints(
  event: EvolutionEvent,
  scorecard: EvolutionScorecard
): number {
  // 基础分
  const basePoints = {
    trivial: 1,
    normal: 3,
    hard: 8
  }[event.taskDifficulty];
  
  // 难度衰减：高等级做低级任务得分减少
  const tierPenalty = getDifficultyPenalty(scorecard.currentTier, event.taskDifficulty);
  
  // 双倍奖励冷却检查（1小时内最多1次）
  const canDoubleReward = canReceiveDoubleReward(scorecard);
  
  let points = Math.floor(basePoints * tierPenalty);
  
  if (event.type === 'success' && canDoubleReward && hasRecentFailure(event.taskHash, scorecard)) {
    points *= 2;
    event.isDoubleReward = true;
  }
  
  return points;
}

function getDifficultyPenalty(tier: EvolutionTier, difficulty: string): number {
  // 高等级做简单任务，积分衰减
  if (tier >= 4 && difficulty === 'trivial') return 0.1;
  if (tier >= 4 && difficulty === 'normal') return 0.5;
  if (tier >= 3 && difficulty === 'trivial') return 0.3;
  return 1.0;
}

function canReceiveDoubleReward(scorecard: EvolutionScorecard): boolean {
  if (!scorecard.lastDoubleRewardTime) return true;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return scorecard.lastDoubleRewardTime < oneHourAgo;
}
```

### 等级晋升

```typescript
function checkTierPromotion(scorecard: EvolutionScorecard): EvolutionTier | null {
  const currentTierDef = TIER_DEFINITIONS[scorecard.currentTier - 1];
  const nextTierDef = TIER_DEFINITIONS[scorecard.currentTier]; // undefined if max
  
  if (!nextTierDef) return null; // 已满级
  
  if (scorecard.totalPoints >= nextTierDef.requiredPoints) {
    return nextTierDef.tier;
  }
  
  return null;
}
```

---

## 存储策略 (v2.0)

```typescript
// 快照 + 有限事件流，防止文件膨胀
interface EvolutionStorage {
  scorecard: EvolutionScorecard;    // 当前状态快照
  recentEvents: EvolutionEvent[];   // 最近50条事件
  archivedStats: {                  // 历史统计（折叠后）
    totalEventsProcessed: number;
    pointsFromTrivial: number;
    pointsFromNormal: number;
    pointsFromHard: number;
  };
}

const MAX_RECENT_EVENTS = 50;

function saveEvent(event: EvolutionEvent, storage: EvolutionStorage): void {
  storage.recentEvents.push(event);
  
  // 超过上限，折叠最老的事件到统计
  if (storage.recentEvents.length > MAX_RECENT_EVENTS) {
    const oldest = storage.recentEvents.shift()!;
    storage.archivedStats.totalEventsProcessed++;
    // ... 更新对应类型的积分统计
  }
  
  // 原子写入（防止并发损坏）
  atomicWrite(STORAGE_PATH, JSON.stringify(storage, null, 2));
}

function atomicWrite(path: string, content: string): void {
  const tempPath = `${path}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, path); // 原子操作
}
```

---

## Gate 集成 (v2.0)

```typescript
// 替代 Trust Engine 的 gate 逻辑
interface EvolutionGate {
  // 工具调用前检查
  beforeToolCall(toolName: string, args: any, scorecard: EvolutionScorecard): GateDecision {
    const tierDef = TIER_DEFINITIONS[scorecard.currentTier - 1];
    const perms = tierDef.permissions;
    
    // 行数检查
    if (args.content && args.content.split('\n').length > perms.maxLinesPerWrite) {
      return { allowed: false, reason: `Tier ${scorecard.currentTier} 限制: 最多 ${perms.maxLinesPerWrite} 行` };
    }
    
    // 风险路径检查
    if (isRiskPath(args.filePath) && !perms.allowRiskPath) {
      return { allowed: false, reason: `Tier ${scorecard.currentTier} 未解锁风险路径权限` };
    }
    
    return { allowed: true };
  },
  
  // 工具调用后记录
  afterToolCall(result: ToolResult, scorecard: EvolutionScorecard): void {
    const event = createEvent(result);
    const points = calculatePoints(event, scorecard);
    
    scorecard.totalPoints += points;
    scorecard.availablePoints += points;
    
    // 检查晋升
    const newTier = checkTierPromotion(scorecard);
    if (newTier) {
      scorecard.currentTier = newTier;
      logPromotion(newTier);
    }
    
    saveEvent(event, storage);
  }
}
```

---

## 实施计划 (v2.0)

### PR 拆分（从 7 个简化为 4 个）

| PR | 范围 | 预估行数 | 时间 |
|----|------|---------|------|
| PR #1 | 核心数据结构 + 等级定义 + 积分算法 | ~400行 | 第1-2周 |
| PR #2 | Gate 集成 + 存储系统 | ~350行 | 第3周 |
| PR #3 | 测试套件 (单元 + 集成) | ~500行 | 第4周 |
| PR #4 | 配置迁移 + 文档 | ~200行 | 第5周 |

**总周期**: 5 周（vs v1.0 的 9 周）

### 启动前必须完成

- [x] v2.0 设计方案评审
- [ ] P0 问题修复（并发写入、双倍奖励冷却）
- [ ] 等级定义完整（1-5级，无缺失）
- [ ] 原子写入实现
- [ ] 50+ 单元测试

---

## 验收标准

### Phase 1 (PR #1-2) 完成后
- [ ] Agent 可以从 Seed 升级到 Forest
- [ ] 积分正确计算（含难度衰减）
- [ ] 双倍奖励冷却生效
- [ ] 文件原子写入，无损坏

### Phase 2 (PR #3-4) 完成后
- [ ] 测试覆盖率 > 60%
- [ ] 旧 Trust Engine 数据可迁移到 EP
- [ ] 文档完整

---

## 后续版本规划

### v2.1 (Phase 2)
- 学习模式（连续失败后触发指导）
- 能力消耗机制（使用风险路径消耗积分）

### v2.2 (Phase 3)
- 徽章系统
- 任务难度自动评估
- 可观测性面板

---

*基于 Gemini CLI + Claude CLI + 内部评审的共识意见*
*小步快跑，核心先行*
