# Phase 40: Failure Classification & Cooldown Recovery - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-14
**Phase:** 40-llm-discovery
**Areas discussed:** 故障分类范围, 瞬态 vs 持久判定策略, 冷却升级机制

---

## 故障分类范围

| Option | Description | Selected |
|--------|-------------|----------|
| Nocturnal 任务范围 | 仅 sleep_reflection / keyword_optimization / deep_reflect | ✓ |
| Nocturnal + LLM + 文件操作 | 扩展到 LLM 调用和文件操作失败 | |
| 全局故障分类框架 | 统一覆盖所有 evolution-worker 故障 | |

**User's choice:** Nocturnal 任务范围 (Recommended)
**Notes:** 聚焦 nocturnal 三类任务，复用现有 retry.ts 处理瞬时故障

---

## 瞬态 vs 持久判定策略

### 判定标准

| Option | Description | Selected |
|--------|-------------|----------|
| 连续失败次数 | 同一任务连续失败 N 次升级 | ✓ |
| 滑动窗口失败率 | 24h 内失败率超过阈值 | |
| 错误类型映射表 | 按错误类型硬编码分类 | |

**User's choice:** 连续失败次数 (Recommended)

### 升级阈值

| Option | Description | Selected |
|--------|-------------|----------|
| 2 次连续失败 | 快速响应 | |
| 3 次连续失败 | 平衡重试和响应速度 | ✓ |
| 4 次连续失败 | 给足重试空间 | |
| Claude 决定 | 按任务类型决定 | |

**User's choice:** 3 次连续失败 (Recommended)

### 计数器重置策略

| Option | Description | Selected |
|--------|-------------|----------|
| 成功即重置 | 每次成功归零 | ✓ |
| 带时间窗口的重置 | 24h 窗口内累计 | |
| Claude 决定 | 按任务类型选择 | |

**User's choice:** 成功即重置 (Recommended)

---

## 冷却升级机制

### 架构选择

| Option | Description | Selected |
|--------|-------------|----------|
| 扩展现有模块 | 改 retry.ts + checkCooldown() + evolution-worker.ts | |
| 新建独立模块 | failure-classifier.ts + cooldown-strategy.ts | ✓ |
| Claude 决定 | 根据代码分析选择 | |

**User's choice:** 新建独立模块
**Notes:** Phase 31 决策倾向显式适配器模式

### 升级策略

| Option | Description | Selected |
|--------|-------------|----------|
| 线性升级 | 30/60/120min | |
| 指数升级 | 15min/1h/4h | |
| 阶梯升级 | 30min/4h/24h 三档 | ✓ |
| Claude 决定 | 按任务类型选择 | |

**User's choice:** 阶梯升级 30min → 4h → 24h (Recommended)

### 状态持久化

| Option | Description | Selected |
|--------|-------------|----------|
| 持久化到 state 文件 | 写入 nocturnal-runtime.json | ✓ |
| 仅内存状态 | 重启后冷却重置 | |
| Claude 决定 | 根据实际需要选择 | |

**User's choice:** 持久化到 state 文件 (Recommended)
**Notes:** Phase 41 负责启动时清理过期冷却

---

## Claude's Discretion

- 新模块内部文件结构和模块边界
- 失败计数器如何集成 evolution-worker.ts 任务状态机
- cooldown-strategy.ts 是扩展还是包装现有 checkCooldown()
- 日志和诊断输出格式

## Deferred Ideas

- LLM 调用失败分类（超出 retry.ts 范围）— 未来 LLM 弹性阶段
- 文件操作失败分类 — Phase 38-39 原子写入已处理
- 基于失败率趋势的自适应冷却 — Phase 41 验证基础后考虑
- 全局故障监控面板 — 生产可观测性范畴
