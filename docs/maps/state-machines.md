# 状态机规范 (State Machine Specifications)

> **用途**: 定义系统中的状态转换规则，帮助AI编程助手理解有效状态转换
> **目标用户**: AI 编程智能体、架构师
> **最后更新**: 2026-03-21
> **⚠️ 验证状态**: ✅ 已验证 - 与源代码一致

---

## 📋 概述

Principles Disciple 包含以下状态机：
1. 原则生命周期状态机
2. 信任阶段状态机
3. 进化等级状态机
4. GFI状态机

---

## 🔄 1. 原则生命周期状态机

**源码**: `src/core/evolution-reducer.ts`, `src/core/evolution-types.ts` (216-241行)

### 状态定义

| 状态 | 说明 |
|------|------|
| `candidate` | 候选原则，刚创建 |
| `probation` | 试用期，验证有效性 |
| `active` | 激活原则，已验证有效 |
| `deprecated` | 废弃原则，已失效或冲突 |

### 状态转换图

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│          │───▶│          │───▶│          │
│ candidate│    │ probation│    │  active  │
│          │◀───│          │    │          │
└──────────┘    └──────────┘    └──────────┘
                    │                 │
                    ▼                 ▼
                ┌──────────┐    ┌──────────┐
                │          │    │          │
                │deprecated│◀───│deprecated│
                └──────────┘    └──────────┘
```

### 转换规则

#### candidate → probation

**条件**: 自动从 `pain_detected` 事件创建
**触发**: `EvolutionReducer.onPainDetected()` 自动调用 `promote()`

#### probation → active

**条件**: `successCount >= PROBATION_SUCCESS_THRESHOLD` (3次)
**触发**: `EvolutionReducer.recordProbationFeedback()` 达到阈值后自动晋升

#### probation → deprecated

**条件**: 
- 冲突检测 (`conflictCount >= 1`)
- 超过30天试用期

**触发**: `EvolutionReducer.deprecated()` 或 `sweepExpiredProbation()`

#### active → deprecated

**条件**: 原则冲突或失效
**触发**: `EvolutionReducer.deprecated()`

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| `PROBATION_MAX_AGE_DAYS` | 30 | 试用期最大天数 |
| `PROBATION_SUCCESS_THRESHOLD` | 3 | 试用期成功阈值 |
| `CIRCUIT_BREAKER_THRESHOLD` | 3 | 回滚阈值 |

---

## 🔄 2. 信任阶段状态机

**源码**: `src/core/trust-engine.ts` (34行, 127-133行)

### 状态定义

| 阶段 | 名称 | 分数范围 | 最大行数 | 最大文件数 |
|------|------|----------|----------|------------|
| 1 | Observer | < 30 | 20 | 1 |
| 2 | Editor | 30-59 | 50 | 2 |
| 3 | Developer | 60-79 | 300 | 5 |
| 4 | Architect | ≥ 80 | 500 | 10 |

**⚠️ 重要**: Stage 3 最大行数是 **300**，不是200

### 转换规则

#### 分数增加（成功）

**实际行为**: `recordSuccess()` 只重置 `success_streak` 和 `failure_streak` 为 0
**注意**: 信任引擎目前是**冻结状态** (`frozen: true`, `reward_policy: 'frozen_all_positive'`)

#### 分数减少（失败）

**计算公式** (线性增长，不是指数):
```
delta = failure_streak_multiplier × (effectiveStreak - 1)
effectiveStreak = min(failure_streak, 5)  // 上限5
```

**示例**:
```typescript
// 第1次失败
delta = -2 × (1 - 1) = 0

// 第2次连续失败
delta = -2 × (2 - 1) = -2

// 第5次连续失败
delta = -2 × (5 - 1) = -8

// 第6次连续失败 (streak被上限)
delta = -2 × (5 - 1) = -8
```

### 冷启动配置

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `initial_trust` | 85 | 初始信任分数 |
| `grace_failures` | 5 | 冷启动容错次数 |
| `cold_start_period_ms` | 86400000 | 冷启动周期（24小时） |

### 分数下限

**分数最低为 30**，不会降到 30 以下

---

## 🔄 3. 进化等级状态机

**源码**: `src/core/evolution-types.ts` (13-41行, 66-70行)

### 状态定义

| 等级 | 名称 | 所需积分 | 最大行数 | 最大文件数 | 风险路径 | 子智能体 |
|------|------|----------|----------|------------|----------|----------|
| 1 | Seed | 0 | 20 | 1 | ❌ | ❌ |
| 2 | Sprout | 50 | 50 | 2 | ❌ | ❌ |
| 3 | Sapling | 200 | 200 | 5 | ❌ | ✅ |
| 4 | Tree | 500 | 500 | 10 | ✅ | ✅ |
| 5 | Forest | 1000 | ∞ | ∞ | ✅ | ✅ |

### 任务难度和积分

| 难度 | 基础积分 | 说明 |
|------|----------|------|
| trivial | 1 | 简单任务：读取、搜索、状态查询 |
| normal | 3 | 常规任务：单文件编辑、测试编写 |
| hard | 8 | 困难任务：多文件重构、架构变更 |

### 双倍奖励条件

- 同一任务哈希之前失败过
- 距离上次失败 ≥ 1小时 (60 * 60 * 1000 毫秒)
- 当前任务成功

---

## 🔄 4. GFI状态机

**源码**: `src/hooks/gate.ts` (门禁检查逻辑)

### 状态定义

GFI（Gate Friction Index）衡量Agent的"挫败感"，范围0-100。

| GFI范围 | 低风险工具 | 高风险工具 | Agent工具 |
|----------|-----------|-----------|-----------|
| < 40 | ✅ 允许 | ✅ 允许 | ✅ 允许 |
| 40-69 | ✅ 允许 | ❌ 阻塞 | ✅ 允许 |
| 70-89 | ❌ 阻塞 | ❌ 阻塞 | ✅ 允许 |
| ≥ 90 | ❌ 阻塞 | ❌ 阻塞 | ❌ 阻塞 |

### 门禁阈值

| 路径 | 默认值 | 说明 |
|------|--------|------|
| `gfi_gate.thresholds.low_risk_block` | 70 | 低风险工具阻塞阈值 |
| `gfi_gate.thresholds.high_risk_block` | 40 | 高风险工具阻塞阈值 |
| `gfi_gate.thresholds.large_change_block` | 50 | 大规模变更阻塞阈值 |

**⚠️ 重要**: 高风险工具阻塞阈值是 **40**，不是 85

### GFI行为

- **无衰减机制**: GFI不会自动衰减
- **重置机制**: 成功操作后调用 `resetFriction()` 重置为 0
- **乘数效应**: 连续错误使用 `1.5^(n-1)` 乘数

---

## 🔗 相关源码文件

| 文件 | 关键内容 | 行数 |
|------|----------|------|
| `src/core/evolution-reducer.ts` | 原则生命周期 | 全文件 |
| `src/core/evolution-types.ts` | 进化等级, 事件类型 | 全文件 |
| `src/core/trust-engine.ts` | 信任阶段, 奖惩计算 | 全文件 |
| `src/hooks/gate.ts` | 门禁逻辑, GFI检查 | 全文件 |

---

**文档版本**: v2.0
**最后更新**: 2026-03-21
**验证状态**: ✅ 已与源代码验证一致
