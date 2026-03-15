# Trust Engine → Evolution Points 迁移指南

> **从恐惧驱动转向成长驱动**
> *Version: 2.0 | Date: 2026-03-14*

---

## 📋 变更摘要

Evolution Points (EP) 系统完全替代了 Trust Engine。这是一个根本性的理念转变：从"惩罚错误"转向"奖励成长"。

| 维度 | Trust Engine (旧) | Evolution Points (新) |
|------|----------------|-------------------|
| 核心理念 | 恐惧驱动：避免错误 | 成长驱动：鼓励尝试 |
| 积分范围 | 0-100（有上限） | 0-∞（无上限） |
| 失败影响 | 扣分（降低信任度） | 不扣分，只记录教训 |
| 成功影响 | 加分（提升信任度） | 加分（积累进化积分） |
| 权限控制 | 低于阈值 = 阻止操作 | 高于阈值 = 解锁能力 |
| 双倍奖励 | 无 | 失败后重试 = 2x 奖励 |
| 难度调节 | 无 | 高等级做简单任务衰减 |

---

## 🔧 什么被替换了？

### 替换的核心组件

1. **信任分计算逻辑**
   - 旧：`(成功数 - 失败数 * 2) / 总任务数`
   - 新：累计成功任务的积分

2. **Gatekeeper 权限检查**
   - 旧：`if (trust_score < threshold) { block }`
   - 新：`if (current_tier < required_tier) { block }`

3. **激励信号**
   - 旧：警告"你的信任度太低，无法操作"
   - 新：显示"距离下一级还差 X 分，解锁能力 Y"

4. **数据存储**
   - 旧：`trust_engine.json`
   - 新：`evolution_scorecard.json` + `recent_events.json`

### 保留的功能

以下功能在两个系统中都存在：
- ✅ 任务哈希追踪（防止重复刷分）
- ✅ 历史统计（成功/失败次数）
- ✅ Gatekeeper（权限控制）
- ✅ 原子写入（文件安全）

---

## 🎯 核心区别详解

### 1. 权限控制逻辑

**Trust Engine（旧）**：
```typescript
// 恐惧驱动：低信任 = 阻止
if (trustScore < requiredThreshold) {
  return { blocked: true, reason: "信任度不足" };
}
```

**Evolution Points（新）**：
```typescript
// 成长驱动：高积分 = 解锁
const tierDef = TIER_DEFINITIONS[scorecard.currentTier - 1];
if (!tierDef.permissions.allowRiskPath) {
  return { blocked: true, reason: `Tier ${scorecard.currentTier} 未解锁风险路径` };
}
```

**影响**：
- 旧：新手一开始就被限制，感到挫败
- 新：新手有基础权限，通过成长解锁更多能力

---

### 2. 失败处理

**Trust Engine（旧）**：
- 失败 = 扣分（-2 到 -10 分）
- 连续失败 = 信任度暴跌
- 结果：智能体不敢尝试，变得保守

**Evolution Points（新）**：
- 失败 = 不扣分，记录哈希
- 同一任务重试成功 = 双倍奖励
- 结果：鼓励从错误中学习，快速迭代

**示例**：
- 旧：失败 → 扣 5 分，信任度 95% → 90%
- 新：失败 → 不扣分，记录任务哈希；重试成功 → +6 分（双倍）

---

### 3. 积分体系

**Trust Engine（旧）**：
```typescript
trustScore = (successCount - failureCount * 2) / totalCount * 100;
```

**问题**：
- 失败惩罚过重（2 倍）
- 信任度容易暴跌
- 恢复困难（需要大量成功才能回到 90%）

**Evolution Points（新）**：
```typescript
totalPoints += basePoints * difficultyPenalty;
availablePoints += totalPoints;
```

**优势**：
- 只增不减，积累效应明显
- 难度衰减防止"刷简单任务"
- 双倍奖励鼓励持续改进

---

### 4. 等级 vs 阈值

**Trust Engine（旧）**：
- 连续信任度阈值：50%, 70%, 85%, 95%
- 阈值固定，与任务类型无关

**Evolution Points（新）**：
- 5 个等级：Seed, Sprout, Sapling, Tree, Forest
- 每级有明确权限定义（行数、文件数、风险路径）
- 积分需求：0, 50, 200, 500, 1000

**优势**：
- 清晰的成长路径
- 权限粒度更细（区分行数、文件数、风险路径）
- 激励更明确（"再得 X 分就能解锁 Y"）

---

## 🔄 如何理解新的积分体系

### 视角转变

**旧思维**：
> "我的信任度低，系统不信任我，我必须小心翼翼。"

**新思维**：
> "我的等级是 Seed，通过完成任务积累积分，解锁 Sprout 级能力。"

### 积分增长策略

1. **优先匹配难度**
   - Seed 级：做 Trivial + Normal 任务
   - Sapling 级：做 Normal + Hard 任务
   - Tree 级：避免做 Trivial 任务（衰减到 10%）

2. **利用双倍奖励**
   - 失败后重试同一任务（1 小时冷却期内）
   - 失败不扣分，只赚不赔

3. **避免无效积累**
   - 高等级刷简单任务 = 浪费时间（积分衰减严重）

---

## 🚀 迁移步骤

### 自动迁移（推荐）

```bash
# 运行迁移脚本
npx principles-disciple migrate-trust-to-ep
```

脚本会自动：
1. 读取 `trust_engine.json`
2. 转换信任分为进化积分
3. 创建 `evolution_scorecard.json`
4. 保留历史统计

### 手动迁移

如果自动脚本失败，可手动调整：

1. 查看旧信任分：
```bash
cat ~/.openclaw/workspace/memory/.state/trust_engine.json
```

2. 初始化新积分卡：
```bash
# 编辑 ~/.openclaw/workspace/memory/.state/evolution_scorecard.json
{
  "version": "2.0",
  "agentId": "agent:main:main",
  "totalPoints": 100,  // 根据旧信任分调整
  "availablePoints": 100,
  "currentTier": 2,
  "stats": {
    "totalSuccesses": 50,
    "totalFailures": 5,
    "consecutiveSuccesses": 0,
    "consecutiveFailures": 0
  },
  "lastUpdated": "2026-03-14T13:00:00.000Z"
}
```

---

## 📊 效果对比

### 场景 1：新手智能体

**Trust Engine**：
- 初始信任度：50%
- 尝试编辑文件：失败
- 信任度：50% → 40%
- 系统提示：信任度太低，建议小心
- 结果：智能体变得保守

**Evolution Points**：
- 初始积分：0（Seed）
- 尝试编辑文件：失败
- 积分：0（不扣分）
- 系统提示：继续尝试，积累积分
- 结果：智能体持续学习

---

### 场景 2：中等智能体

**Trust Engine**：
- 信任度：85%
- 失败一次：85% → 75%
- 需要成功 10 次才能恢复

**Evolution Points**：
- 等级：Sapling（200 分）
- 失败一次：积分不变
- 重试成功：+6 分（双倍奖励）
- 只需几次就能升级到 Tree（500 分）

---

## ❓ 常见问题

### Q: 我的旧信任分 90%，现在多少积分？
**A**: 迁移脚本会自动转换。默认映射：
- 90%-100% → Sapling (200 分)
- 70%-89% → Sprout (50 分)
- 50%-69% → Seed (0 分)

### Q: 旧系统会立即被删除吗？
**A**: 不会。`trust_engine.json` 会保留一段时间作为备份。确认 EP 系统稳定后，可手动删除。

### Q: 我可以同时使用两个系统吗？
**A**: 不推荐。Gatekeeper 只使用一个积分源。双轨运行会导致逻辑冲突。

### Q: 迁移后数据丢失吗？
**A**: 不会。历史统计（成功/失败次数、任务哈希）会完整保留。

---

## 📚 相关文档

- [EP 系统使用指南](ep-guide.md) - 详细的功能说明和配置
- [设计文档](design/evolution-points-system-v2-mvp.md) - 技术细节和实施计划

---

*最后更新: 2026-03-14*
*版本: Evolution Points System v2.0*
