# Evolution Points (EP) 系统使用指南

> **Burn Pain. Fuel Evolution.**
> 成长优于惩罚。每一次行动都是学习的机会。

---

## EP 系统是什么？

Evolution Points (EP) 是一个**成长导向的积分系统**，替代了旧的 Trust Engine 惩罚机制。

**核心理念**：
- ✅ 从 0 分开始，只增不减
- ✅ 失败记录教训，不扣分
- ✅ 同一任务失败后重试成功 = 双倍奖励
- ✅ 连续失败触发"学习模式"而非惩罚

---

## 5 个等级定义

| 等级 | 名称 | 所需积分 | 解锁能力 |
|------|------|---------|---------|
| 1 | Seed (萌芽) | 0 | 基础操作，单文件编辑最多 20 行 |
| 2 | Sprout (新芽) | 50 | 最多 50 行，2 个文件 |
| 3 | Sapling (幼苗) | 200 | 可启动子智能体，最多 200 行 |
| 4 | Tree (大树) | 500 | 可编辑风险路径，最多 500 行 |
| 5 | Forest (森林) | 1000 | 完全自主访问，无限制 |

---

## 积分规则

### 基础积分

| 任务难度 | 基础分 | 说明 |
|---------|---------|------|
| Trivial (简单) | 1 | 单行修改、简单查询 |
| Normal (普通) | 3 | 常规代码编辑、文件读取 |
| Hard (困难) | 8 | 复杂任务、多文件修改、重构 |

### 双倍奖励触发条件

1. **同一任务哈希**：与最近失败的任务相同
2. **冷却期**：距离上次双倍奖励超过 1 小时
3. **重试成功**：之前的失败记录存在

**奖励**：基础分 × 2

### 难度衰减

高等级智能体执行简单任务时，积分会减少：

| 当前等级 | 执行 Trivial 任务 | 执行 Normal 任务 |
|---------|----------------|---------------|
| Tree (4) | 10% (0.1x) | 50% (0.5x) |
| Sapling (3) | 30% (0.3x) | 100% (1.0x) |
| Sprout/Seed | 100% (1.0x) | 100% (1.0x) |

---

## 等级晋升

智能体每次成功完成任务后，系统自动检查：

```
if (总积分 >= 下一级所需积分) {
    晋升到下一级
    记录晋升事件
    解锁新权限
}
```

**晋升示例**：
- Seed (0 分) → 完成普通任务 +3 分 → Sprout (3/50，未晋升)
- 累计到 50 分 → 自动晋升到 Sprout
- 累计到 200 分 → 自动晋升到 Sapling
- 依此类推...

---

## 如何查看积分和等级

### 方法 1：命令行查询

```bash
/pd-status
```

显示信息包括：
- 当前等级
- 总积分
- 可用积分
- 距离下一级所需积分
- 成功/失败统计

### 方法 2：查看存储文件

```bash
cat ~/.openclaw/workspace/memory/.state/evolution_scorecard.json
```

文件格式：
```json
{
  "version": "2.0",
  "agentId": "agent:main:main",
  "totalPoints": 150,
  "availablePoints": 150,
  "currentTier": 2,
  "stats": {
    "totalSuccesses": 25,
    "totalFailures": 5,
    "consecutiveSuccesses": 3,
    "consecutiveFailures": 0
  },
  "lastUpdated": "2026-03-14T13:00:00.000Z"
}
```

---

## 常见问题 (FAQ)

### Q: 失败会扣分吗？
**A**: 不会。失败只会记录教训，不影响积分。系统鼓励从错误中学习，而非惩罚错误。

### Q: 为什么我的积分增长很慢？
**A**: 检查以下情况：
1. 是否在做与等级不匹配的任务？（高等级做简单任务，积分衰减）
2. 是否缺乏双倍奖励？（失败后重试同一任务可触发双倍）
3. 统计信息中是否连续失败？

### Q: 达到 Forest (1000分) 后还有意义吗？
**A**: 是的。总积分继续累计，可用于未来的扩展功能（如能力消耗、徽章系统）。

### Q: 如何快速升级？
**A**: 策略：
1. 优先选择合适难度的任务
2. 失败后重试同一任务（触发双倍奖励）
3. 避免高等级做简单任务

### Q: 旧 Trust Engine 数据怎么办？
**A**: 系统提供迁移脚本，自动转换信任分为进化积分。详见 `docs/trust-to-ep-migration.md`。

### Q: 子智能体的积分如何计算？
**A**: 子智能体的成功也会给主智能体加分。具体规则见设计文档。

---

## 配置文件

### PROFILE.json 配置项

在 `docs/PROFILE.json` 中可配置：

```json
{
  "evolution_points": {
    "enabled": true,
    "double_reward_cooldown_minutes": 60,
    "difficulty_decay_enabled": true,
    "max_recent_events": 50
  }
}
```

### pain_settings.json 配置

在 `{stateDir}/pain_settings.json` 中配置进化相关设置：

```json
{
  "evolution_points": {
    "auto_promote": true,
    "track_recent_tasks": true,
    "save_events": true
  }
}
```

---

## 迁移说明

从 Trust Engine 迁移到 EP 系统，请阅读 `docs/trust-to-ep-migration.md`。

---

*最后更新: 2026-03-14*
*版本: EP System v2.0*
