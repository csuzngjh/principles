# 信号词库页面 — UI/UX 设计

**Date**: 2026-07-01
**Status**: Draft (pending owner approval) — 已通过代码核查修正（见 §9 核查记录）
**Scope**: pd-console 前端页面，为 UnifiedKeywordStore 提供 Owner 治理界面
**Related**: PR #1132（SignalCollector 统一采集）、`2026-06-30-signal-collector-unified-detection-design.md`（后端设计）、`PD_BRAND_CONSTITUTION.md`（品牌宪章）、`PD_UX_PRINCIPLES.md`（UX 原则）

---

## 0. 摘要

在 pd-console 中新增一个信号词库治理页面——不是"关键词管理后台"，而是 **Owner 治理信号词库的工作台**。入口放在纠正观察员和共情观察员两个 agent 的 L2 展开面板上（"管理关键词"），跳转到同一页面，`?category=` 参数区分来源侧重点。页面保留完整的编辑/删除能力——Owner 不需要碰后端修改词库。

---

## 1. 问题与目标

### 1.1 问题

UnifiedKeywordStore（PR #1132）统一了 correction 和 empathy 两套关键词库，但 Owner 目前没有任何可视化界面来：

- 查看当前词库中有哪些词、各词的精度/权重/来源
- 审批 LLM 发现的新候选词（PendingTermStore）
- 删除过时的 seed 词
- 手动新增关键词

Owner 如果只能通过后端 YAML 来管理词库，体验割裂且风险高。

### 1.2 目标

1. **一个页面**管理所有关键词，`?category=` 参数决定默认筛选
2. **完整 CRUD**：查看、新增、编辑、删除，全部在 UI 完成
3. **审批流**：LLM 发现的候选词在此审批/驳回
4. **品牌一致**：符合 PD Governance Workspace 调性——安静、专注、不对 Owner 施加认知负担

### 1.3 非目标（当前 MVP）

- ❌ 不批量导入/导出
- ❌ 不提供独立 API 服务（只在 pd-console 页面操作，复用 pd-console 现有 API 层）
- ❌ 不重构两套旧词库的迁移（旧库还在，UI 只操作 UnifiedKeywordStore）
- ❌ 不实现"误报率统计"——当前 `UnifiedKeyword` 类型无命中/误报字段（见 §8 开放问题）

---

## 2. 入口设计

### 2.1 signalCollector 在 Control Center 的处理

signalCollector 是 `InternalAgentName` 的一部分（`pd-config-types.ts:75`），`AGENT_METADATA` 类型为 `Record<InternalAgentName, AgentMeta>`，**不能简单删除条目**——删除会导致 TypeScript 编译错误。

signalCollector 默认 `enabled: false`（`pd-config-defaults.ts:52`），`isCore: false`（`agent-metadata.ts:368`）。

**方案**：保留 `AGENT_METADATA` 中的条目（满足类型约束），但在前端渲染时跳过它。具体做法：

- `ControlCenterPage` 的 sidechain 分组渲染中，过滤掉 `agent.name === 'signalCollector'` 的卡片
- `AgentGroup` 组件接收 agents 列表时，由 `ControlCenterPage` 负责过滤
- signalCollector 的 `AgentMeta` 保留，但不在 UI 展示——它是基础设施层，不是 Owner 需要独立管理的 agent

**注意**：这不影响后端配置——`.pd/config.yaml` 中 `signalCollector` binding 仍然存在，只是前端不显示卡片。

### 2.2 入口位置：两个 Observer 的 L2 面板

当前 `AgentCard` 的 L2 展开面板结构（`AgentCard.tsx:281-407`）：

```
L2 展开内容（isOpen 控制）:
  1. 详细说明段落（detailParagraphs）
  2. MVP note（可选，仅 philosopher/rolloutReviewer）
  3. impact-box
  4. L3 技术细节（嵌套折叠，仅当 techDetail 有内容时）
  5. profile-row（select 下拉框）
  6. 内联确认条（仅核心代理 confirming=true 时）
```

**AgentCard 是通用组件**，只接受 `AgentMeta` + `RedactedAgentSummary`，不支持 per-agent 自定义操作。要给 correctionObserver 和 empathyObserver 加"管理关键词"入口，需要扩展 `AgentMeta`。

**方案**：在 `AgentMeta` 接口新增可选字段：

```typescript
// agent-metadata.ts 新增字段
export interface AgentMeta {
  // ... 现有字段 ...
  /** 可选操作入口（如"管理关键词"）。仅特定 agent 有。 */
  actionLabelZh?: string;
  actionLabelEn?: string;
  /** 点击后跳转的路由（不含 hash 前缀） */
  actionHref?: string;
  /** 路由 query 参数的 category 值 */
  actionCategory?: 'correction' | 'empathy';
}
```

在 correctionObserver 和 empathyObserver 的 metadata 中填充：

```typescript
correctionObserver: {
  // ... 现有字段 ...
  actionLabelZh: '管理关键词',
  actionLabelEn: 'Manage Keywords',
  actionHref: '/control-center/signal-keywords',
  actionCategory: 'correction',
},
empathyObserver: {
  // ... 现有字段 ...
  actionLabelZh: '管理关键词',
  actionLabelEn: 'Manage Keywords',
  actionHref: '/control-center/signal-keywords',
  actionCategory: 'empathy',
},
```

在 `AgentCard` 的 L2 面板中，profile-row 之后、confirm-bar 之前，新增一个 action-row：

```
  │  ... profile-row ...                     │
  │                                          │
  │  [☰ 管理关键词]                          │  ← 新增 action-row
  │                                          │
  │  ... confirm-bar（仅核心代理）...        │
```

### 2.3 路由设计

当前 App.tsx 路由是**平级结构**（HashRouter），control-center 是独立路由，无嵌套路由。

新增平级路由：

```typescript
// App.tsx 新增
<Route path="/control-center" element={<ControlCenterPage />} />
<Route path="/control-center/signal-keywords" element={<SignalKeywordsPage />} />
```

URL 参数：
```
#/control-center/signal-keywords?category=correction   （默认按纠正筛选）
#/control-center/signal-keywords?category=empathy      （默认按共情筛选）
```

没有 category 参数时显示全部，筛选器默认"全部"。

---

## 3. 页面布局

### 3.1 整体结构

```
← 返回 Control Center

信号词库                              [全部 ▾]  [新增]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  [待审批]                                  ← 仅在有候选词时出现
  ┌──────────────────────────────────────────┐
  │  2 个候选词等待审查                       │
  │                                          │
  │  "你又乱改"  纠正 · high                 │
  │    来源: llm_candidate     [审查] [忽略]   │
  │  ─────────────────────────────────────── │
  │  "搞什么"    共情 · ambiguous            │
  │    来源: llm_candidate     [审查] [忽略]   │
  │                                          │
  └──────────────────────────────────────────┘

  词库列表   共 47 个词
  ┌──────────────────────────────────────────┐
  │  term              精度      权重  来源    │
  │──────────────────────────────────────────│
  │  这是错的           high      0.8  seed  …│
  │  不对               high      0.7  seed  …│
  │  不要自作主张       high      0.9  owner │
  │                                        …│  ← promoted
  │  错了               ambiguous 0.5  seed  …│
  │  …                                       │
  └──────────────────────────────────────────┘
```

### 3.2 数据类型对照（代码核查后的准确字段）

本页面操作的数据类型来自 `packages/principles-core/src/runtime-v2/signal-collector/types.ts`：

```typescript
// 已批准词库
type KeywordCategory = 'correction' | 'empathy';
type TermSource = 'seed' | 'migrated' | 'owner_promoted';

interface UnifiedKeyword {
  term: string;
  category: KeywordCategory;
  weight: number;       // 0-1
  precision: 'high' | 'ambiguous';  // 注意：全拼 ambiguous，不是 ambig
  source: TermSource;   // 注意：没有 'llm' 和 'owner'，只有 owner_promoted
}

interface UnifiedKeywordStore {
  version: number;
  terms: Record<string, UnifiedKeyword>;  // key = term
}

// 待审批候选词
interface PendingTerm {
  term: string;
  suggestedCategory: KeywordCategory;
  suggestedPrecision: 'high' | 'ambiguous';
  reason: string;          // LLM 给出的理由
  discoveredAt: string;    // ISO
  source: 'llm_candidate'; // 固定值
}

interface PendingTermStore {
  version: number;
  terms: PendingTerm[];
}
```

### 3.3 区块说明

**顶部操作栏**：
- 标题：根据 `?category` 显示"纠正信号词库" / "共情信号词库" / "信号词库"
- 分类筛选器：下拉选择「全部 / 纠正 / 共情」
- [新增] 按钮：打开新增关键词弹窗

**待审批区块**（仅在有数据时显示）：
- 展示 PendingTermStore 中的候选词
- 每行：候选词 + suggestedCategory + suggestedPrecision + reason + [审查] [忽略] 按钮
- 审查→打开审批弹窗，可调整精度和权重再批准；忽略→从 PendingTermStore 移除

**词库列表**（始终显示）：
- 全量词库列表，每行展示 term、precision、weight、source
- 每行右侧 `…` 菜单 → [编辑] [删除]
- 支持按 term 搜索
- 支持按 category、precision、source 筛选

---

## 4. 交互细节

### 4.1 新增关键词

点击 [新增] 打开弹窗：

```
┌──────────────────────────────────┐
│  新增关键词                       │
│                                  │
│  关键词  [____________________]  │
│                                  │
│  分类    [纠正 ▾]                 │
│                                  │
│  精度    [高精度 ▾]               │
│              高精度 (high)        │
│              歧义   (ambiguous)   │
│                                  │
│  权重    [0.8 ──────●────] 0.8   │
│                                  │
│  [取消]              [确认新增]    │
└──────────────────────────────────┘
```

- 关键词必填
- 分类默认跟随当前 `?category` 筛选
- 精度默认 `high`
- 权重 slider，范围 0.1-1.0，步长 0.1
- 来源自动设为 `owner_promoted`（前端新增的词固定此来源）

### 4.2 编辑关键词

点击行 `…` → [编辑]，打开编辑弹窗（同新增弹窗，字段预填）：

- term 不可修改（编辑即替换容易出问题）
- 可修改：category、precision、weight
- 如果非要修改 term → 引导用户先删除再新增

### 4.3 删除关键词

点击行 `…` → [删除]，出现确认弹窗：

```
┌──────────────────────────────────┐
│  删除「这是错的」？               │
│                                  │
│  删除后系统不会再以此词检测信号。  │
│  此操作不可撤销。                 │
│                                  │
│  [取消]    [确认删除]              │
└──────────────────────────────────┘
```

### 4.4 审批候选词

点击候选词的 [审查] 打开：

```
┌──────────────────────────────────┐
│  审查候选词                       │
│                                  │
│  关键词: "你又乱改"               │
│  建议分类: 纠正                   │
│  建议精度: high                   │
│  来源: llm_candidate             │
│  理由: <PendingTerm.reason>      │
│                                  │
│  精度    [高精度 ▾]               │
│  权重    [0.7 ──────●────] 0.7   │
│                                  │
│  [忽略]              [批准加入]    │
└──────────────────────────────────┘
```

- Owner 可以在批准前调整 precision 和 weight
- category 沿用 suggestedCategory（不允许在审批时改分类）
- 批准后：从 PendingTermStore 移除，加入 UnifiedKeywordStore（source = `owner_promoted`）
- 忽略→直接从 PendingTermStore 移除

---

## 5. 品牌与 UX 对齐

### 5.1 调性定位

参照 PD_BRAND_CONSTITUTION.md：

| 品牌原则 | 体现 |
|----------|------|
| 安静 | 页面没有跳动的数字、动画图表、实时推送 |
| 精确 | 所有字段名与后端类型完全一致，无虚构概念 |
| 克制 | 不展示后端不存在的统计字段（如"误报率"） |
| 可信 | 编辑/删除有确认，操作有反馈，无静默失败 |

### 5.2 情绪价值

参照 emotional-value.md 框架：

| 情绪 | 来源 | 解决方式 |
|------|------|----------|
| 失控感 | "系统在用哪些词判断我？" | 词库全量可见，无隐藏关键词 |
| 疲惫感 | "这些词我都要一个一个看？" | 默认只展示「待审批」区块，全量列表在下方 |
| 不信任感 | "LLM 加的词会不会乱来" | 所有 LLM 发现词必须经过审批才生效 |
| 安心感 | "词库在我的控制之下" | 编辑/删除随时可用，无需修改后端 |

### 5.3 页面不是 CRUD 表

CRUD 是**手段**不是**目的**。页面回答的问题是：

> **"词库是否健康，有什么需要我处理的？"**

布局优先级：
1. 待审批（最需要你行动的）
2. 全量列表（你可能会用到的）

---

## 6. 后续扩展预留

### 6.1 路由模式

```
/control-center                        ← Control Center 主页
/control-center/signal-keywords        ← 当前页面
/control-center/agents/<agentId>/settings  ← 未来 agent 设置页（预留）
```

### 6.2 category 扩展

`?category=` 参数本身已经具备扩展性。未来如果有新的信号分类加入 SignalCollector，只需要在筛选器增加选项即可。

### 6.3 API 层对接

pd-console 现有 API 层在 `packages/pd-console/src/ui/api.ts`。需要新增以下端点（**当前不存在，需新建**）：

```
GET    /api/signal-keywords?category=correction    ← 列表（返回 UnifiedKeywordStore）
POST   /api/signal-keywords                        ← 新增（source=owner_promoted）
PUT    /api/signal-keywords/:term                  ← 编辑（precision/weight/category）
DELETE /api/signal-keywords/:term                  ← 删除
GET    /api/signal-keywords/pending                ← 候选词列表（返回 PendingTermStore）
POST   /api/signal-keywords/pending/:term/approve  ← 批准候选词
POST   /api/signal-keywords/pending/:term/reject   ← 驳回候选词
```

注意：UnifiedKeywordStore 的 key 是 term 字符串，不是数字 ID，所以 API 路径用 `:term` 而非 `:id`。term 可能含特殊字符，需 URL encode。

API 不存在时先 mock 数据占位，后端就绪后替换。

---

## 7. 实现顺序

| 步骤 | 内容 | 依赖 | 涉及文件 |
|------|------|------|----------|
| 1 | `AgentMeta` 新增 action 字段 | 无 | `agent-metadata.ts` |
| 2 | correctionObserver + empathyObserver metadata 填充 action 字段 | 步骤 1 | `agent-metadata.ts` |
| 3 | `AgentCard` L2 面板新增 action-row 渲染 | 步骤 1 | `AgentCard.tsx` |
| 4 | `ControlCenterPage` 过滤 signalCollector 卡片 | 无 | `ControlCenterPage.tsx` |
| 5 | 新增 `SignalKeywordsPage` 组件 | 无 | 新文件 |
| 6 | App.tsx 新增路由 | 步骤 5 | `App.tsx` |
| 7 | 页面基础框架（标题、筛选、返回按钮） | 步骤 5,6 | `SignalKeywordsPage.tsx` |
| 8 | 词库列表组件（含编辑/删除/搜索/筛选） | 步骤 7 | 新组件 |
| 9 | 新增/编辑弹窗 | 步骤 8 | 新组件 |
| 10 | 待审批区块（候选词审批流） | 步骤 8 | 新组件 |
| 11 | 对接真实 API（或 mock 替换为真实接口） | 后端 API 就绪 | `api.ts` + 后端 |

---

## 8. 开放问题

1. **误报率统计不存在**——`UnifiedKeyword` 类型无命中/误报统计字段。如果需要"需关注"区块，后端需要先实现统计记录。当前 MVP 不含此区块，后续作为增强。
2. **删除行为**——删除关键词后，之前基于该词记录的信号如何处理？（建议：信号记录保留，只是停用该词）
3. **待审批列表的排序**——PendingTermStore 是数组，按 discoveredAt 倒序还是其他？
4. **term 作为 API 路径参数**——term 含特殊字符（如中文、空格）时的 URL encode 处理。
5. **SignalCollector 默认关闭的影响**——`pd-config-defaults.ts:52` 中 signalCollector 默认 `false`。如果它关闭了，UnifiedKeywordStore 是否还在运行？需要确认关闭后的行为。

---

## 9. 代码核查记录（2026-07-01）

本 spec 已通过以下代码核查，修正了所有不准确断言：

| 核查项 | 文件 | 结论 |
|--------|------|------|
| UnifiedKeyword 真实字段 | `signal-collector/types.ts:6-12` | term/category/weight/precision/source，precision=`high`\|`ambiguous`，source=`seed`\|`migrated`\|`owner_promoted` |
| PendingTerm 真实字段 | `signal-collector/types.ts:21-28` | term/suggestedCategory/suggestedPrecision/reason/discoveredAt/source(`llm_candidate`) |
| signalCollector 在 InternalAgentName 中 | `pd-config-types.ts:75` | ✅ 包含，不能从 AGENT_METADATA 删除 |
| signalCollector 默认值 | `pd-config-defaults.ts:52` | `false`（默认关闭） |
| signalCollector isCore | `agent-metadata.ts:368` | `false` |
| AGENT_METADATA 类型约束 | `agent-metadata.ts:119` | `Record<InternalAgentName, AgentMeta>`，删除条目会编译错误 |
| AgentCard L2 面板结构 | `AgentCard.tsx:281-407` | detail → impact-box → L3 tech → profile-row → confirm-bar，无 action 区域 |
| AgentCard 是通用组件 | `AgentCard.tsx:32-43` | 只接受 AgentMeta + RedactedAgentSummary，不支持 per-agent 自定义 |
| App.tsx 路由结构 | `App.tsx:98-117` | 平级路由，control-center 无嵌套 |
| ControlCenterPage 渲染流程 | `ControlCenterPage.tsx:910-941` | 通过 AgentGroup 间接渲染 AgentCard，分组由 groupAgentsByDependency 处理 |
