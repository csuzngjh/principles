# 原则树架构设计 (Principle-Tree Architecture)

> **创建日期**: 2026-04-06  
> **状态**: 概念设计 + 类型定义已完成  
> **Schema 文件**: `packages/openclaw-plugin/src/types/principle-tree-schema.ts`

---

## 核心概念

原则 (Principle) 和规则 (Rule) 是光谱的两端：

```
    高度抽象                                    具体可执行
       │                                           │
       ▼                                           ▼
  [原则] ──────── [规则] ──────── [实现]
  (树根)          (树干)          (树叶)
```

- **原则**：一句话，跨场景，价值导向（例："任何写入操作必须确保目标环境的完整性"）
- **规则**：可验证，有触发条件，有具体行为（例："调用 edit 工具前必须先 read 目标文件"）
- **实现**：代码/技能/权重，可执行（例：`before_file_write` hook 中的 `fs.existsSync` 检查）

**关键洞察**：没有规则支撑的原则是空概念。LLM 看到抽象原则会选择无视或忽略。只有当原则拆解为具体规则，规则再固化为代码/技能/LORA 权重时，原则才真正生效。

---

## 架构总览

```
                    ┌─────────────────────┐
                    │     原则层          │
                    │  (Principles)       │
                    │  树根：高度抽象      │
                    └─────────┬───────────┘
                              │ 1:N
              ┌───────────────┼───────────────┐
              │               │               │
        ┌─────▼─────┐  ┌─────▼─────┐  ┌──────▼──────┐
        │  规则层    │  │  规则层    │  │   规则层    │
        │  (Rules)   │  │  (Rules)   │  │   (Rules)   │
        │  树干      │  │  树干      │  │   树干      │
        └─────┬─────┘  └─────┬─────┘  └──────┬──────┘
              │ 1:N          │ 1:N           │ 1:N
    ┌─────────┼──┐    ┌──────┼────┐    ┌──────┼──────┐
    │         │  │    │      │    │    │      │      │
┌───▼──┐ ┌───▼──┐│ ┌──▼──┐┌─▼──┐│ ┌──▼──┐┌─▼──┐┌▼──────┐
│ Hook │ │ Skill│ │ │Gate │ │API │ │ │LORA │ │检查│ │ 测试  │
│(Code)│ │      │ │ │     │ │网关│ │ │权重 │ │脚本│ │(Test) │
└──────┘ └──────┘│ └─────┘└────┘│ └─────┘└────┘└───────┘
                 └──────────────┘
                    树叶：具体实现
```

---

## 三层定义

### 1. 原则层 (Principle) — 树根

| 属性 | 说明 |
|---|---|
| `id` | 原则 ID，如 `P_060` |
| `text` | 一句话原则陈述 |
| `status` | `candidate` → `probation` → `active` → `deprecated` |
| `priority` | `P0` / `P1` / `P2` |
| `scope` | `general`（通用型）/ `domain`（特定领域） |
| `valueScore` | 价值分数 = 防止痛苦次数 × 平均严重程度 |
| `adherenceRate` | 遵守率 0-100% |
| `painPreventedCount` | 已防止的痛苦事件数 |
| `ruleIds` | 关联的规则 ID 列表（树干连接） |
| `conflictsWithPrincipleIds` | 冲突的其他原则 |
| `deprecatedReason` | 弃用原因（如 "已固化到 src/hooks/file-safety.ts"） |

### 2. 规则层 (Rule) — 树干

| 属性 | 说明 |
|---|---|
| `id` | 规则 ID，如 `R_060_01` |
| `name` | 规则名称 |
| `type` | `hook` / `gate` / `skill` / `lora` / `test` / `prompt` |
| `triggerCondition` | 触发条件（正则、工具名、上下文） |
| `enforcement` | `block` / `warn` / `log` |
| `principleId` | 父原则 ID |
| `status` | `proposed` → `implemented` → `enforced` → `retired` |
| `coverageRate` | 覆盖率 0-100% |
| `implementationPath` | 实现路径（文件路径、技能 ID、模型路径） |

### 3. 实现层 (Implementation) — 树叶

| 属性 | 说明 |
|---|---|
| `id` | 实现 ID，如 `IMPL_060_01_hook` |
| `ruleId` | 父规则 ID |
| `type` | `code` / `skill` / `lora` / `test` / `prompt` |
| `path` | 具体文件路径、技能 ID、或模型路径 |
| `coveragePercentage` | 覆盖规则的百分比 |

---

## 生命周期

```
新 Pain 信号 → 诊断者分析 → 提炼原则 (candidate)
                                    ↓
                              拆解为规则 (proposed)
                                    ↓
                        转化为代码/技能/LORA (implemented)
                                    ↓
                        规则变为 enforced
                                    ↓
                    规则覆盖率 100% → 原则标记 deprecated
                                    ↓
                    原则从活跃列表移除，用户不再关注
```

### 原则状态流转

```
candidate ──验证通过──→ probation ──充分验证──→ active ──规则100%覆盖──→ deprecated
    │                       │                       │                          │
    └────验证失败───────────┴───────────────────────┴──────────────────────────┘
                                     ↓
                               原则废弃
```

---

## 用户管理焦点

作为 PD 系统的使用者，你需要关注的是：

| 你关注什么 | 系统如何支持 |
|---|---|
| **新增原则** | 诊断者产出的新原则自动出现在待审列表 (`candidate` 状态) |
| **原则价值排名** | 自动计算 `valueScore`，支持按价值排序 |
| **原则删除** | 规则覆盖率达 100% 时自动标记 `deprecated`，从活跃列表移除 |
| **原则冲突** | 声明 `conflictsWithPrincipleIds`，LLM 知道冲突时优先哪个 |

---

## 数据关系

```typescript
Principle (树根)
  ├── has many → Rule (树干)
  │     └── has many → Implementation (树叶)
  ├── conflicts with → Principle[]
  ├── supersedes → Principle
  └── derived from → PainSignal[]

Rule (树干)
  ├── belongs to → Principle
  ├── has many → Implementation
  └── may conflict with → Rule[]
```

---

## 当前状态 vs 目标

| 维度 | 当前状态 | 目标状态 |
|---|---|---|
| **原则结构** | 只有 `trigger_pattern` + `action` | 完整属性（价值、优先级、场景、关联规则） |
| **规则层** | 不存在 | 可验证、可追踪、关联到原则 |
| **实现层** | 不关联原则 | 代码/LORA/skill 关联到具体规则 |
| **原则生命周期** | 永远活跃 | 固化后自动 deprecated 并移除 |
| **LLM 上下文注入** | 全量读 PRINCIPLES.md 文件 | 从结构化 API 获取 active 原则摘要 |
| **价值量化** | 无 | `valueScore` = pain_prevented × severity × adherence |

---

## Schema 文件

类型定义位于：`packages/openclaw-plugin/src/types/principle-tree-schema.ts`

包含的类型：
- `Principle` — 原则定义
- `Rule` — 规则定义
- `Implementation` — 实现定义
- `PrincipleDependency` — 原则依赖关系
- `PrincipleValueMetrics` — 价值指标
- `PrincipleDetectorSpec` — 检测器元数据
- `PrincipleLifecycleEvent` — 生命周期事件
- `PrincipleTreeStore` — 完整存储结构

---

## 实现路线图

### Phase 1: 数据迁移 (当前)
- [x] 类型定义完成
- [ ] 现有 Principle 迁移到新结构
- [ ] 增加 priority、scope、valueScore 字段

### Phase 2: 规则层实现
- [ ] Rule CRUD API
- [ ] 原则 → 规则拆解辅助（诊断者输出规则建议）
- [ ] 规则覆盖率自动计算

### Phase 3: 关联实现层
- [ ] 代码 hook 关联到规则
- [ ] Skill 关联到规则
- [ ] LORA 权重关联到规则
- [ ] 覆盖率自动更新

### Phase 4: 价值量化
- [ ] pain 信号与原则关联统计
- [ ] 遵守率自动计算
- [ ] 价值分数自动更新

### Phase 5: 生命周期自动化
- [ ] 规则 100% 覆盖 → 原则自动 deprecated
- [ ] deprecated 原则自动从活跃列表移除
- [ ] 用户收到原则废弃通知

---

## 设计决策记录

| 决策 | 方案 | 原因 |
|---|---|---|
| 原则如何标记 deprecated | 规则覆盖率 100% 时自动标记 | 固化到代码/权重后，原则作为独立条目已无存在必要 |
| 价值如何量化 | `pain_prevented_count × avg_severity × adherence_rate` | 可计算，可排序，反映真实价值 |
| 冲突如何解决 | 原则之间声明 `conflictsWith` 关系 | 让 LLM 知道冲突时该优先哪个 |
| 规则如何关联实现 | `implementationPath` 指向具体文件/技能 | 可追溯，可审计 |
| LLM 如何消费原则 | 从 `evolutionReducer.getActivePrinciples()` 获取结构化数据 | 不再依赖 PRINCIPLES.md 文件解析 |
