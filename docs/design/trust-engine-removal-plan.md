# Trust Engine 移除计划

> **版本**: v1.7.6 → v1.7.8
> **日期**: 2026-03-28
> **状态**: 规划中

## 背景

Trust Engine 是基于惩罚的信任评分系统（0-100分，Stage 1-4），已在 v1.7.6 被 EP (Evolution Points) 系统替代作为主决策系统。EP 系统采用成长驱动模式，积分只增不减，更适合 AI Agent 的进化特性。

### 两个系统对比

| 特性 | Trust Engine | EP System |
|------|--------------|-----------|
| 分数范围 | 0-100 | 0+ (无限) |
| 等级 | Stage 1-4 | Tier 1-5 (Seed→Forest) |
| 分数变化 | 可增可减 | 只增不减 |
| 决策依据 | 惩罚驱动 | 成长驱动 |
| 状态 | @deprecated | 主决策系统 |

---

## 当前依赖分析

### 核心文件

| 文件 | 用途 | 移除复杂度 |
|------|------|------------|
| `src/core/trust-engine.ts` | Trust Engine 主类 | 中 |
| `core/trust-engine.d.ts` | 类型声明 | 低 |
| `src/commands/trust.ts` | `/trust` 命令 | 低 |

### 引用位置

#### Hooks (高优先级)

| 文件 | 引用 | 处理方式 |
|------|------|----------|
| `src/hooks/progressive-trust-gate.ts` | `wctx.trust`, fallback 逻辑 | **已处理**: EP 为主，Trust 作为 fallback |
| `src/hooks/prompt.ts` | 显示 trust score/stage | 移除显示或改为显示 EP tier |
| `src/hooks/gfi-gate.ts` | `trust_stage_multipliers` | 改为 `tier_multipliers` |
| `src/hooks/bash-risk.ts` | `trust_stage_multipliers` | 改为 `tier_multipliers` |

#### Core (中优先级)

| 文件 | 引用 | 处理方式 |
|------|------|----------|
| `src/core/workspace-context.ts` | `get trust()` getter | 移除 getter |
| `src/core/config.ts` | `trust_stage_multipliers` 配置 | 重命名为 `tier_multipliers` |
| `src/core/event-log.ts` | `recordTrustChange()` | 移除方法 |
| `src/core/trajectory.ts` | `trust_changes` 表 | 保留历史数据，停止写入 |

#### Commands (低优先级)

| 文件 | 引用 | 处理方式 |
|------|------|----------|
| `src/commands/trust.ts` | 整个命令 | 移除或重构为 EP 状态命令 |
| `src/commands/pain.ts` | 显示 trust 信息 | 改为显示 EP 信息 |

#### Services (中优先级)

| 文件 | 引用 | 处理方式 |
|------|------|----------|
| `src/service/phase3-input-filter.ts` | trust 相关检查 | 移除 trust 验证逻辑 |
| `src/service/runtime-summary-service.ts` | `trust_score` 字段 | 改为 `ep_tier` 字段 |

### 测试文件

需要更新或移除的测试文件：

```
tests/core/trust-engine.test.ts           # 移除
tests/hooks/gfi-gate.test.ts              # 更新 mock
tests/hooks/gate.test.ts                  # 更新 mock
tests/hooks/progressive-trust-gate.test.ts # 更新 mock
tests/service/phase3-input-filter.test.ts  # 移除 trust 相关断言
tests/service/runtime-summary-service.test.ts # 更新字段
```

---

## 分阶段移除计划

### Phase 1: v1.7.7 - 移除 Fallback (当前 → v1.7.7)

**目标**: 移除 Trust Engine 作为 fallback，EP 系统成为唯一决策系统

#### 1.1 移除 progressive-trust-gate.ts 中的 fallback 逻辑

```typescript
// 当前代码结构
try {
  const epDecision = checkEvolutionGate(...);
  if (!epDecision.allowed) return block(...);
  return; // EP 允许，放行
} catch (err) {
  // fallback to Trust Engine  ← 移除此分支
}

// 目标代码结构
const epDecision = checkEvolutionGate(...);
if (!epDecision.allowed) return block(...);
return; // EP 允许，放行
```

#### 1.2 更新错误处理

- EP 系统异常时：记录错误日志，**允许操作通过**（fail-open 策略）
- 原因：避免因系统异常阻塞正常工作流

#### 1.3 更新 workspace-context.ts

```typescript
// 移除
get trust(): TrustEngine { ... }

// 可选：添加兼容性 getter (返回 undefined)
/** @deprecated Removed in v1.7.7 */
get trust(): undefined { return undefined; }
```

#### 1.4 更新 prompt.ts

```typescript
// 移除 trust 相关显示
- const trustScore = wctx.trust.getScore();
- const stage = wctx.trust.getStage();

// 改为显示 EP 信息
const epTier = wctx.evolution.getTier();
const epPoints = wctx.evolution.getPoints();
```

#### 1.5 更新 pain.ts 命令

```typescript
// 移除 trust 显示
- const trustScore = trust.getScore();
- const trustStage = trust.getStage();
- text += `💰 **当前信任积分**: ${trustBar} ${trustScore}/100`;

// 改为显示 EP
const epTier = evolution.getTier();
const epPoints = evolution.getPoints();
```

#### 1.6 移除 `/trust` 命令

- 删除 `src/commands/trust.ts`
- 从 `index.ts` 移除命令注册

---

### Phase 2: v1.7.8 - 完全移除 (v1.7.7 → v1.7.8)

**目标**: 移除所有 Trust Engine 相关代码和配置

#### 2.1 删除核心文件

```bash
rm src/core/trust-engine.ts
rm core/trust-engine.d.ts
```

#### 2.2 清理配置

```typescript
// src/core/config.ts
// 移除
trust_stage_multipliers: { ... }

// 可选：添加 tier_multipliers (如果 GFI gate 需要)
tier_multipliers: {
  seed: 0.5,
  sprout: 0.75,
  sapling: 1.0,
  tree: 1.0,
  forest: 1.0,
}
```

#### 2.3 更新 GFI Gate

```typescript
// src/hooks/gfi-gate.ts
// 将 trust_stage_multipliers 改为 tier_multipliers
const tierMultiplier = config.tier_multipliers[tier] || 1.0;
```

#### 2.4 清理 Event Log

```typescript
// src/core/event-log.ts
// 移除方法
- recordTrustChange(sessionId, data) { ... }
```

#### 2.5 更新 Trajectory 数据库

```typescript
// src/core/trajectory.ts
// 停止写入 trust_changes 表
// 保留表结构用于历史数据查询
if (event.type === 'trust_change') {
  // 不再处理，忽略
}
```

#### 2.6 清理 Services

```typescript
// src/service/phase3-input-filter.ts
// 移除 trust 相关验证
- trustRejectedReasons.push('legacy_or_unfrozen_trust_schema');
- trustRejectedReasons.push('missing_trust_score');

// src/service/runtime-summary-service.ts
// 移除 trust_score 字段
- trust_score?: number;
+ ep_tier?: string;
+ ep_points?: number;
```

#### 2.7 清理测试

```bash
# 移除
rm tests/core/trust-engine.test.ts

# 更新其他测试文件中的 mock
# 将 mockTrust.getStage() 改为 mockEvolution.getTier()
```

#### 2.8 清理类型定义

```typescript
// types/event-types.d.ts
// 移除
- | 'trust_change'

// 移除 trustStage 字段
- trustStage: number;
```

---

## 迁移检查清单

### v1.7.7 发布前

- [ ] `progressive-trust-gate.ts`: 移除 Trust Engine fallback
- [ ] `workspace-context.ts`: 移除或标记 `trust` getter 为 deprecated
- [ ] `prompt.ts`: 更新为显示 EP 信息
- [ ] `pain.ts`: 更新为显示 EP 信息
- [ ] `trust.ts`: 移除命令文件
- [ ] 更新所有相关测试
- [ ] 更新 CHANGELOG.md
- [ ] 发布 npm 包

### v1.7.8 发布前

- [ ] 删除 `trust-engine.ts` 和类型声明
- [ ] 清理 `config.ts` 中的 trust 配置
- [ ] 更新 `gfi-gate.ts` 使用 tier multipliers
- [ ] 移除 `event-log.ts` 中的 `recordTrustChange`
- [ ] 清理 services 中的 trust 引用
- [ ] 移除 `trust-engine.test.ts`
- [ ] 更新类型定义
- [ ] 数据迁移脚本（可选：清理 scorecard 文件）
- [ ] 更新 CHANGELOG.md
- [ ] 发布 npm 包

---

## 风险评估

### 低风险

- 移除 `/trust` 命令：用户很少直接使用
- 移除 trust 显示：可被 EP 显示替代

### 中风险

- GFI Gate 配置变更：需要向后兼容现有配置文件
- Service 层变更：需要确保 EP 数据可用

### 缓解措施

1. **版本化迁移**: 分两个版本逐步移除
2. **日志监控**: 在 v1.7.7 中记录所有 fallback 触发情况
3. **配置兼容**: 保留 `trust_stage_multipliers` 配置解析，映射到 tier multipliers
4. **数据保留**: trajectory 数据库中的 `trust_changes` 表保留用于历史查询

---

## 相关文件索引

### 需要修改的文件 (按优先级)

1. `src/hooks/progressive-trust-gate.ts` - Gate 主逻辑
2. `src/core/workspace-context.ts` - Context getter
3. `src/hooks/prompt.ts` - Prompt 注入
4. `src/commands/pain.ts` - 命令输出
5. `src/commands/trust.ts` - 移除命令
6. `src/hooks/gfi-gate.ts` - 配置迁移
7. `src/hooks/bash-risk.ts` - 配置迁移
8. `src/core/config.ts` - 配置清理
9. `src/core/event-log.ts` - 方法移除
10. `src/core/trajectory.ts` - 停止写入
11. `src/service/phase3-input-filter.ts` - 验证逻辑
12. `src/service/runtime-summary-service.ts` - 字段更新

### 需要删除的文件

- `src/core/trust-engine.ts`
- `core/trust-engine.d.ts`
- `tests/core/trust-engine.test.ts`

---

## 参考资料

- [Evolution Points 系统设计](./evolution-points-system.md)
- [EP System v2 MVP](./evolution-points-system-v2-mvp.md)
- [Trust Gate 架构](../maps/trust-gate-architecture.md)
