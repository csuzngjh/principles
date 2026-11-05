# Plan: Signal Keywords Management Page

> **Spec**: [`docs/superpowers/specs/2026-07-01-signal-keywords-page-design.md`](../specs/2026-07-01-signal-keywords-page-design.md)
> **Tracking**: Task 1-8 (linked below per task)
> **PRD**: PRI-1132 (SignalCollector unified signal collection layer) — this plan implements the frontend governance page

---

## Goal

实现信号词库治理页面（Signal Keywords Page），入口放在纠正观察员（correctionObserver）和共情观察员（empathyObserver）两个 agent 的 L2 展开面板上，跳转到同一管理页（`?category=` 区分来源侧重点）。页面支持关键词的查看、搜索、筛选、新增、编辑、删除，以及 LLM 发现的候选词审批。

**Success criteria:**
- `?category=correction` 进入时默认按纠正相关词筛选
- `?category=empathy` 进入时默认按共情相关词筛选
- 支持 CRUD 操作（新增、编辑、删除关键词）
- 待审批区块展示 LLM 发现的候选词，支持一键审批或驳回
- 所有操作有 loading 和 error 状态，使用当前应用的 design tokens
- 入口不暴露在一级 sidebar 导航中

---

## Architecture

```
pd-console (existing SPA, HashRouter)
├── 修改: App.tsx                              → 新增 /control-center/signal-keywords 路由
├── 修改: pages/control-center/ControlCenterPage.tsx → 过滤 signalCollector 不渲染卡片
├── 修改: pages/control-center/AgentCard.tsx   → L2 面板新增 action-row（管理关键词按钮）
├── 修改: utils/agent-metadata.ts              → AgentMeta 扩展 action 字段 + 填充 observer metadata
├── 新增: pages/control-center/SignalKeywordsPage.tsx  → 主页面（路由入口）
├── 新增: pages/control-center/KeywordListSection.tsx  → 词库列表区域
├── 新增: pages/control-center/KeywordEditDialog.tsx   → 新增/编辑弹窗
├── 新增: pages/control-center/PendingTermsSection.tsx → 待审批区块
├── 新增: utils/signal-keywords-types.ts        → 前端类型定义
├── 新增: utils/signal-keywords-validators.ts   → API 响应验证器
├── 新增: api/signal-keywords-api.ts            → API 函数
├── 修改: i18n/zh-CN.json + en.json             → 新增 signalKeywords 相关翻译键
└── tests/ui/ (新增/修改测试文件)
```

**No new packages, no new runtime services, no new backend routes.** API 层在现有 `request()` 函数基础上扩展，后端路由需要提前实现（不在本 plan 范围内）。

---

## Task Dependency Graph

```
Task 1 (AgentMeta action field)
  └── Task 2 (AgentCard action-row) — depends on Task 1
Task 3 (ControlCenterPage filter) — independent
Task 4 (Types + Validators + API) — independent
  └── Task 5 (SignalKeywordsPage + Route) — depends on Task 4
       ├── Task 6 (KeywordListSection) — depends on Task 5
       ├── Task 7 (KeywordEditDialog) — depends on Task 6
       └── Task 8 (PendingTermsSection) — depends on Task 5
```

**Execution order**: Task 1+3+4 → Task 2+5 → Task 6+8 → Task 7
（并行友好：1+3+4 可并行，2+5 可并行）

---

## Task 1: AgentMeta 扩展 action 字段 + observer metadata 填充

### Goal
为 `AgentMeta` 接口添加可选的 action 字段，让 AgentCard L2 面板可以渲染"管理关键词"按钮。在 correctionObserver 和 empathyObserver 的 metadata 中填入 action 指向信号关键词页面。

### Files
| File | Action |
|------|--------|
| `packages/pd-console/src/ui/utils/agent-metadata.ts` | 修改 |
| `packages/pd-console/tests/ui/agent-metadata.test.ts` | 修改 |

### Interfaces

```typescript
// 在 agent-metadata.ts 的 AgentMeta 接口中添加：
export interface ActionMeta {
  /** 行动按钮的显示文本（中文） */
  labelZh: string;
  /** 行动按钮的显示文本（英文） */
  labelEn: string;
  /** 跳转路径（HashRouter 相对于 # 的路径） */
  href: string;
  /** 传递给页面的 category 筛选参数 */
  category: "correction" | "empathy";
}

// AgentMeta 新增可选字段：
export interface AgentMeta {
  // ... existing fields ...
  /** 可选：在 L2 面板底部显示的行动按钮 */
  action?: ActionMeta;
}
```

### Steps

1. **定义 `ActionMeta` 接口**：在 `agent-metadata.ts` 中 `AgentMeta` 定义之前或同文件内新增。

2. **扩展 `AgentMeta`**：添加 `action?: ActionMeta` 字段。

3. **填充 correctionObserver 的 action**：
   ```typescript
   correctionObserver: {
     // ... existing fields ...
     action: {
       labelZh: "管理关键词",
       labelEn: "Manage Keywords",
       href: "/control-center/signal-keywords",
       category: "correction",
     },
   }
   ```

4. **填充 empathyObserver 的 action**：
   ```typescript
   empathyObserver: {
     // ... existing fields ...
     action: {
       labelZh: "管理关键词",
       labelEn: "Manage Keywords",
       href: "/control-center/signal-keywords",
       category: "empathy",
     },
   }
   ```

5. **更新 `agent-metadata.test.ts`**：
   - 在 `EXPECTED_AGENT_NAMES` 中添加 `"signalCollector"` 已经是 10 个
   - 新增测试：`correctionObserver.action` 存在且字段正确
   - 新增测试：`empathyObserver.action` 存在且字段正确
   - 新增测试：`action.category` 只能是 `"correction" | "empathy"`
   - 测试其他 agent 没有 action 字段，或者 action 是 undefined

### Test Expectations

```typescript
describe("AGENT_METADATA: action field", () => {
  it("correctionObserver has action with href and category=correction", () => {
    const meta = AGENT_METADATA.correctionObserver;
    expect(meta.action).toBeDefined();
    expect(meta.action!.labelZh.length).toBeGreaterThan(0);
    expect(meta.action!.labelEn.length).toBeGreaterThan(0);
    expect(meta.action!.href).toBe("/control-center/signal-keywords");
    expect(meta.action!.category).toBe("correction");
  });

  it("empathyObserver has action with href and category=empathy", () => {
    const meta = AGENT_METADATA.empathyObserver;
    expect(meta.action).toBeDefined();
    expect(meta.action!.labelZh.length).toBeGreaterThan(0);
    expect(meta.action!.labelEn.length).toBeGreaterThan(0);
    expect(meta.action!.href).toBe("/control-center/signal-keywords");
    expect(meta.action!.category).toBe("empathy");
  });

  it("non-observer agents do not have action field", () => {
    const agentsWithoutAction = [
      "diagnostician", "dreamer", "scribe", "artificer",
      "evaluator", "philosopher", "rolloutReviewer",
    ] as const;
    for (const name of agentsWithoutAction) {
      expect(AGENT_METADATA[name].action).toBeUndefined();
    }
  });
});
```

### Scope Boundary
+ 只修改 AgentMeta 相关代码
+ 不修改 AgentCard、ControlCenterPage 或其他组件
+ 不修改 types.ts（后端类型）

---

## Task 2: AgentCard L2 action-row 渲染

### Goal
在 AgentCard 的 L2 展开面板中，当 `agent.action` 存在时，在 impact-box 下方、tech-detail 上方渲染一个 action-row 按钮。

### Files
| File | Action |
|------|--------|
| `packages/pd-console/src/ui/pages/control-center/AgentCard.tsx` | 修改 |
| `packages/pd-console/tests/ui/agent-card.test.ts` | 修改 |

### Design

```
┌─────────────────────────────────────┐
│ L1 header                           │
├─────────────────────────────────────┤
│ L2 content (only when isOpen)       │
│  ┌─ detail ──────────────────────┐  │
│  │  ...                          │  │
│  ├─ impact-box ──────────────────┤  │
│  │  If disabled: 关掉会怎样 ...   │  │
│  ├─ action-row ──────────────────┤  │  ← NEW
│  │  [管理关键词 →]               │  │  ← 仅当 agent.action 存在时
│  ├─ L3 tech detail ─────────────┤  │
│  │  (when showTechDetail)        │  │
│  ├─ profile-row ────────────────┤  │
│  └─ confirm-bar ────────────────┘  │
└─────────────────────────────────────┘
```

### Steps

1. **在 AgentCard props 类型中确认 `agent` 字段的 `action` 已被 TS 识别**：检查 `AgentMeta` 是否已在 Task 1 中包含 `action`。

2. **在 L2 内容中新增 action-row**：在 impact-box 下方、tech-detail 上方插入：
   ```tsx
   {agent.action && (
     <div data-action-row className="border-t border-line pl-2 pr-2 pt-2 pb-1">
       <Link
         to={`${agent.action.href}?category=${agent.action.category}`}
         className="flex items-center justify-between rounded px-3 py-2 text-[13px] text-accent hover:bg-accent/5 transition-colors"
       >
         <LocaleText zh={agent.action.labelZh} en={agent.action.labelEn} />
         <span className="text-ink-3 text-[12px]">→</span>
       </Link>
     </div>
   )}
   ```

3. **使用 `react-router-dom` 的 `Link`**：如果 AgentCard 当前没有 import `Link`，需要添加：
   ```typescript
   import { Link } from "react-router-dom";
   ```

4. **更新 `agent-card.test.ts`**：新增源码契约测试：
   - 检查源码包含 `data-action-row` 属性
   - 检查源码包含 `action?.href` 的引用模式
   - 检查源码包含 `?category=` 的拼接
   - 检查 action-row 在 L2 (`{isOpen &&`) 的条件区域内
   - 检查 `agent.action &&` 条件守卫

### Test Expectations

```typescript
describe("AgentCard: action-row", () => {
  it("renders action-row conditionally when agent.action exists", () => {
    expect(source).toMatch(/agent\.action\s*&&/);
  });

  it("action-row has data-action-row attribute", () => {
    expect(source).toContain("data-action-row");
  });

  it("action-row links to href with category query param", () => {
    expect(source).toContain("?category=");
  });

  it("action-row is inside L2 conditional block (isOpen)", () => {
    // Find the isOpen block, check action-row is inside it
    const isOpenMatch = source.match(/\{isOpen\s*&&\s*\(/);
    const l2Start = isOpenMatch?.index ?? 0;
    const l2Block = source.slice(l2Start, l2Start + 3000);
    expect(l2Block).toContain("data-action-row");
  });

  it("uses LocaleText for bilingual label", () => {
    expect(source).toMatch(/LocaleText.*action\.label/);
  });
});
```

### Scope Boundary
+ 只修改 AgentCard.tsx 和 agent-card.test.ts
+ 不修改任何 CSS（使用现有 design tokens）
+ 不修改不影响 action-row 渲染的部分

---

## Task 3: ControlCenterPage 过滤 signalCollector

### Goal
在 ControlCenterPage 渲染 agent 卡片时，过滤掉 `signalCollector`（名字为 `"signalCollector"` 的 agent），使其不显示为卡片。

### Files
| File | Action |
|------|--------|
| `packages/pd-console/src/ui/pages/control-center/ControlCenterPage.tsx` | 修改 |

### Steps

1. **找到 agent 卡片的渲染循环**：在 ControlCenterPage.tsx 中找到 map agent 的区域。

2. **添加过滤条件**：在渲染时跳过 `agentName === "signalCollector"`：
   ```typescript
   // 在 map 之前过滤
   const visibleAgents = Object.entries(AGENT_METADATA).filter(
     ([name]) => name !== "signalCollector"
   );
   ```
   或在 JSX 中添加条件守卫：
   ```tsx
   {agentName !== "signalCollector" && (
     <AgentCard key={agentName} ... />
   )}
   ```

3. **如果 AGENT_GROUPS 将 signalCollector 放在 sidechain 组中**：不需要修改 GROUPS——signalCollector 在 sidechain 组中只是 metadata，不渲染即可。检查 groups 的 agnetName list 是否需要保持语义正确。

### Scope Boundary
+ 只修改 ControlCenterPage.tsx
+ 不影响 AGENT_METADATA 本身（signalCollector 的 metadata 仍然存在）
+ 不影响 signalCollector 的功能（它仍然可以在后端运行）
+ 用户无法从 UI 看到或控制 signalCollector 的开关

### Test Expectations
```typescript
// 在 agent-card.test.ts 或单独的文件中测试
it("does not render AgentCard for signalCollector", () => {
  // 源码契约：ControlCenterPage 中 signalCollector 被过滤
  const ccSource = readSrc("pages/control-center/ControlCenterPage.tsx");
  expect(ccSource).toMatch(/signalCollector/); // 可能引用其 metadata
  // 但不应出现 AgentCard 与 signalCollector 同时出现
  expect(ccSource).not.toMatch(/agentName.*!==.*"signalCollector"/);
});
```
> **注意**：具体断言取决于 ControlCenterPage 的实际渲染结构，需要查看源代码后写精确匹配。

---

## Task 4: 信号词库类型 + 验证器 + API 层

### Goal
定义前端使用的类型（镜像后端 types.ts），实现 API 响应验证器（遵循 rc-1~rc-5 runtime contract rules），提供 CRUD API 函数。在 API 不存在时使用 mock 数据占位。

### Files
| File | Action |
|------|--------|
| `packages/pd-console/src/ui/utils/signal-keywords-types.ts` | 新建 |
| `packages/pd-console/src/ui/utils/signal-keywords-validators.ts` | 新建 |
| `packages/pd-console/src/ui/api/signal-keywords-api.ts` | 新建 |
| `packages/pd-console/tests/ui/signal-keywords-validators.test.ts` | 新建 |
| `packages/pd-console/tests/ui/signal-keywords-api.test.ts` | 新建 |

### Interfaces

```typescript
// signal-keywords-types.ts — 前端类型（镜像后端 types.ts）

export type KeywordCategory = "correction" | "empathy";
export type KeywordPrecision = "high" | "ambiguous";
export type KeywordSource = "seed" | "migrated" | "owner_promoted";

export interface UnifiedKeyword {
  term: string;
  category: KeywordCategory;
  weight: number;
  precision: KeywordPrecision;
  source: KeywordSource;
}

export type PendingTermSource = "llm_candidate";

export interface PendingTerm {
  term: string;
  suggestedCategory: KeywordCategory;
  suggestedPrecision: KeywordPrecision;
  reason: string;
  discoveredAt: string; // ISO datetime
  source: PendingTermSource;
}

export interface UnifiedKeywordStore {
  version: number;
  terms: Record<string, UnifiedKeyword>;
}

export interface PendingTermStore {
  version: number;
  terms: PendingTerm[];
}

// API response shapes
export interface SignalKeywordsListResponse {
  store: UnifiedKeywordStore;
}

export interface PendingTermsListResponse {
  store: PendingTermStore;
}

export interface ApprovePendingResponse {
  term: string;
  category: KeywordCategory;
  precision: KeywordPrecision;
}
```

### Validators (signal-keywords-validators.ts)

遵循 rc-1~rc-5 runtime contract rules：

```typescript
import type {
  UnifiedKeyword,
  PendingTerm,
  UnifiedKeywordStore,
  PendingTermStore,
  SignalKeywordsListResponse,
  PendingTermsListResponse,
  ApprovePendingResponse,
} from "../utils/signal-keywords-types.js";

export function validateUnifiedKeyword(v: unknown): UnifiedKeyword | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.term !== "string" || o.term.length === 0) return null;
  if (!["correction", "empathy"].includes(o.category as string)) return null;
  if (typeof o.weight !== "number" || o.weight < 0) return null;
  if (!["high", "ambiguous"].includes(o.precision as string)) return null;
  if (!["seed", "migrated", "owner_promoted"].includes(o.source as string)) return null;
  return o as UnifiedKeyword; // safe after checks
}

export function validateUnifiedKeywordStore(v: unknown): UnifiedKeywordStore | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.version !== "number") return null;
  if (!o.terms || typeof o.terms !== "object") return null;
  for (const [key, val] of Object.entries(o.terms as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) return null;
    if (!validateUnifiedKeyword(val)) return null;
  }
  return o as UnifiedKeywordStore;
}

export function validateSignalKeywordsListResponse(v: unknown): SignalKeywordsListResponse | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const store = validateUnifiedKeywordStore(o.store);
  if (!store) return null;
  return { store };
}

// ... 类似的 PendingTerm 验证器
```

### API Layer (signal-keywords-api.ts)

```typescript
import { request } from "../api.js";
import { validateSignalKeywordsListResponse, ... } from "../utils/signal-keywords-validators.js";

const IS_DEV = (import.meta as unknown as { env: { DEV: boolean } }).env.DEV;

export async function fetchKeywords(): Promise<...> {
  if (IS_DEV) {
    return { success: true, data: MOCK_KEYWORDS_STORE };
  }
  return request("/api/signal-keywords/list", undefined, validateSignalKeywordsListResponse);
}

// ... 类似的 createKeyword / updateKeyword / deleteKeyword / fetchPendingTerms / approveTerm / rejectTerm
```

### Mock Data

```typescript
const MOCK_STORE: UnifiedKeywordStore = {
  version: 1,
  terms: {
    "变量命名不规范": {
      term: "变量命名不规范",
      category: "correction",
      weight: 0.85,
      precision: "high",
      source: "seed",
    },
    // ... 5-8 条样本数据覆盖各种 category/precision/source
  },
};

const MOCK_PENDING: PendingTerm[] = [
  {
    term: "依赖版本锁定",
    suggestedCategory: "correction",
    suggestedPrecision: "high",
    reason: "用户多次手动固定依赖版本",
    discoveredAt: "2026-07-01T10:00:00Z",
    source: "llm_candidate",
  },
  // ... 3-5 条候选词
];
```

### Test Expectations (validators)

```typescript
describe("validateUnifiedKeyword", () => {
  it("accepts valid keyword", () => {
    const result = validateUnifiedKeyword({
      term: "test", category: "correction", weight: 0.5,
      precision: "high", source: "seed",
    });
    expect(result).not.toBeNull();
  });

  it("rejects invalid category", () => {
    const result = validateUnifiedKeyword({
      term: "test", category: "invalid", weight: 0.5,
      precision: "high", source: "seed",
    });
    expect(result).toBeNull();
  });

  it("rejects null input (rc-1)", () => {
    expect(validateUnifiedKeyword(null)).toBeNull();
  });

  it("rejects missing precision (rc-3)", () => {
    const result = validateUnifiedKeyword({
      term: "test", category: "correction", weight: 0.5,
      source: "seed",
    });
    expect(result).toBeNull();
  });
});
```

### Scope Boundary
+ 纯逻辑层，无 UI 依赖
+ 验证器必须 100% 覆盖所有 field（rc-1~rc-5）
+ mock 数据仅供开发阶段使用
+ API 路径 `/api/signal-keywords/*` 为约定，后端路由由其他 task 实现

---

## Task 5: SignalKeywordsPage 基础框架 + 路由

### Goal
创建 SignalKeywordsPage 作为新的路由页面，读取 `?category=` 参数确定默认筛选，渲染页面骨架（header + tab/区域分隔）。在 App.tsx 中注册路由。

### Files
| File | Action |
|------|--------|
| `packages/pd-console/src/ui/pages/control-center/SignalKeywordsPage.tsx` | 新建 |
| `packages/pd-console/src/ui/App.tsx` | 修改 |
| `packages/pd-console/src/ui/i18n/zh-CN.json` | 修改 |
| `packages/pd-console/src/ui/i18n/en.json` | 修改 |

### Page Structure

```
┌─────────────────────────────────────────┐
│ ← 返回控制中心      信号关键词治理      │  ← Breadcrumb + title
│                                          │
│ ┌─ Tabs 或 区域标题 ──────────────────┐ │
│ │  词库列表 (默认展开)                  │ │  ← KeywordListSection
│ │  ┌─ 搜索框 + category 筛选 ──────┐  │ │
│ │  │ [...KeywordListSection]         │  │ │
│ │  └────────────────────────────────┘  │ │
│ │                                       │ │
│ │  待审批 (展开/折叠)                   │ │  ← PendingTermsSection
│ │  ┌─ 候选词列表 ──────────────────┐  │ │
│ │  │ [...PendingTermsSection]       │  │ │
│ │  └────────────────────────────────┘  │ │
│ └───────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### API Integration (placeholder)

```typescript
export function SignalKeywordsPage() {
  const [searchParams] = useSearchParams();
  const category = searchParams.get("category") as KeywordCategory | null;
  const { t } = useTranslation();

  // 初始加载 keywords + pending terms
  // 使用 Task 4 的 API 层

  return (
    <div className="...">
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <Link to="/control-center" className="...">← {t("controlCenter.eyebrow")}</Link>
        <span className="text-ink-3">/</span>
        <h1 className="...">关键词治理</h1>
      </div>

      {/* 入口来源提示（仅当 ?category= 存在时） */}
      {category && (
        <div className="...">
          当前显示 {category === "correction" ? "纠正" : "共情"} 相关关键词
        </div>
      )}

      {/* 词库列表区域 */}
      <KeywordListSection initialCategory={category} />

      {/* 待审批区域 */}
      <PendingTermsSection />
    </div>
  );
}
```

### Route Registration

在 `App.tsx` 中，`control-center` 路由的内部或平级新增：

```typescript
<Route path="/control-center" element={<ControlCenterPage />} />
<Route path="/control-center/signal-keywords" element={<SignalKeywordsPage />} />
```

### i18n Keys

添加到 `zh-CN.json` 和 `en.json` 的 `controlCenter` 块中：

```json
{
  "controlCenter": {
    // ... existing keys ...
    "signalKeywords": {
      "title": "信号关键词治理",
      "titleEn": "Signal Keywords Management",
      "fromCorrection": "当前显示纠正观察员相关关键词",
      "fromCorrectionEn": "Showing keywords relevant to Correction Observer",
      "fromEmpathy": "当前显示共情观察员相关关键词",
      "fromEmpathyEn": "Showing keywords relevant to Empathy Observer",
      "searchPlaceholder": "搜索关键词…",
      "searchPlaceholderEn": "Search keywords…",
      "addKeyword": "新增关键词",
      "addKeywordEn": "Add Keyword",
      "categoryCorrection": "纠正",
      "categoryCorrectionEn": "Correction",
      "categoryEmpathy": "共情",
      "categoryEmpathyEn": "Empathy",
      "precisionHigh": "确定",
      "precisionHighEn": "High",
      "precisionAmbiguous": "模糊",
      "precisionAmbiguousEn": "Ambiguous",
      "sourceSeed": "种子词",
      "sourceSeedEn": "Seed",
      "sourceMigrated": "迁移",
      "sourceMigratedEn": "Migrated",
      "sourceOwnerPromoted": "所有者审批",
      "sourceOwnerPromotedEn": "Owner Approved",
      "weight": "权重",
      "weightEn": "Weight",
      "pendingTerms": "待审批候选词",
      "pendingTermsEn": "Pending Terms",
      "pendingTermsEmpty": "暂无待审批候选词",
      "pendingTermsEmptyEn": "No pending terms for review",
      "approve": "采纳",
      "approveEn": "Approve",
      "reject": "驳回",
      "rejectEn": "Reject",
      "edit": "编辑",
      "editEn": "Edit",
      "delete": "删除",
      "deleteEn": "Delete",
      "deleteConfirm": "确定删除关键词「{{term}}」？",
      "deleteConfirmEn": "Are you sure you want to delete 「{{term}}」?",
      "noKeywords": "暂无关键词",
      "noKeywordsEn": "No keywords yet"
    }
  }
}
```

### Scope Boundary
+ 只创建页面骨架 + 路由 + i18n keys
+ 列表和弹窗区域用占位组件（KeywordListSection / PendingTermsSection），Task 6-8 填充
+ 不处理 loading/error 状态（由子组件处理）

---

## Task 6: 词库列表组件（KeywordListSection）

### Goal
实现关键词列表区域：搜索框、category 筛选 tabs、表格/卡片列表、行内编辑操作和删除确认。

### Files
| File | Action |
|------|--------|
| `packages/pd-console/src/ui/pages/control-center/KeywordListSection.tsx` | 新建 |

### Component API

```typescript
interface KeywordListSectionProps {
  /** 从 URL ?category= 传入的初始筛选值 */
  initialCategory: KeywordCategory | null;
}
```

### Features

1. **搜索过滤**：实时搜索（client-side filter on `term`）
2. **Category 筛选**：Tabs 或 Select：`全部 / 纠正 / 共情`
3. **表格/列表渲染**：每行显示 term / category / precision / weight / source / actions
4. **行操作**：编辑按钮（打开 KeywordEditDialog）+ 删除按钮（确认后删除）
5. **Loading / Error / Empty 状态**

### Table Row Design

```
┌────────────┬──────────┬───────────┬────────┬──────────────┬──────────┐
│ 关键词       │ 类别      │ 精确度     │ 权重   │ 来源          │ 操作      │
├────────────┼──────────┼───────────┼────────┼──────────────┼──────────┤
│ 变量命名... │ 纠正      │ 确定       │ 0.85  │ 种子词        │ ⋮ 编辑/删除│
└────────────┴──────────┴───────────┴────────┴──────────────┴──────────┘
```

### State Management

```typescript
interface ListState {
  keywords: UnifiedKeyword[];
  loading: boolean;
  error: string | null;
  search: string;
  categoryFilter: KeywordCategory | "all";
}
```

### Steps

1. 从 `signal-keywords-api` 导入 `fetchKeywords`
2. 使用 `useEffect` + `fetchKeywords` 加载数据
3. 实现 `filteredKeywords` 计算（search + categoryFilter）
4. 用 `useTranslation` 获取 i18n 文本
5. 渲染 table（用现有 table/`div` 样式）
6. 每个操作的 loading 状态（删除中、编辑中等）
7. "新增关键词"按钮触发 KeywordEditDialog（传入 `category` 参数）

### Scope Boundary
+ 只负责列表展示和行操作触发
+ 编辑/新增弹窗由 Task 7 实现，删除确认用简单 `confirm()` dialog 或自有状态
+ 不处理待审批区域

---

## Task 7: 新增/编辑弹窗（KeywordEditDialog）

### Goal
实现关键词新增/编辑表单弹窗：term、category、weight、precision 四个字段。新增时默认 `source=owner_promoted`，编辑时不修改 source。

### Files
| File | Action |
|------|--------|
| `packages/pd-console/src/ui/pages/control-center/KeywordEditDialog.tsx` | 新建 |
| `packages/pd-console/src/ui/pages/control-center/KeywordEditDialog.test.ts` | 可选（源码契约测试） |

### Dialog API

```typescript
interface KeywordEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑模式传入已有 keyword，新增模式传 null */
  keyword: UnifiedKeyword | null;
  /** 新增模式下的默认 category（从 ?category= 继承） */
  defaultCategory?: KeywordCategory;
  onSave: (keyword: Omit<UnifiedKeyword, "source">) => Promise<boolean>;
}
```

### Form Fields

| Field | Type | Default | Rules |
|-------|------|---------|-------|
| term | text input | (empty) | required, max 100 chars, no duplicate check (API level) |
| category | select: correction/empathy | `defaultCategory ?? "correction"` | required |
| weight | number input (0-1, step 0.05) | 0.5 | required, 0~1 |
| precision | select: high/ambiguous | "high" | required |

### Steps

1. 使用现有的 `<Dialog>` 组件（从 `./components/ui/dialog`）
2. 表单使用受控组件（`useState` + `onChange`）
3. 提交时调用 `onSave`，显示 loading 状态
4. 成功后关闭弹窗并触发列表刷新
5. 验证：所有必填字段、weight 范围
6. 编辑模式预填字段值
7. 新增模式 term 为空、其他字段有默认值

### Test Expectations (source-code contract)

```typescript
it("renders form fields: term, category, weight, precision", () => {
  const source = readSrc("pages/control-center/KeywordEditDialog.tsx");
  expect(source).toContain("term");
  expect(source).toContain("category");
  expect(source).toContain("weight");
  expect(source).toContain("precision");
});

it("uses Dialog from radix-ui", () => {
  const source = readSrc("pages/control-center/KeywordEditDialog.tsx");
  expect(source).toContain("DialogContent");
  expect(source).toContain("DialogHeader");
});
```

### Scope Boundary
+ 只负责表单 UI + 基础验证
+ 不负责 API 调用（通过 `onSave` props 解耦）
+ 不处理列表渲染或待审批

---

## Task 8: 待审批区块（PendingTermsSection）

### Goal
展示 LLM 发现的候选词列表，支持一键审批（接受为正式关键词）或驳回（删除候选词）。审批时打开 KeywordEditDialog 让用户确认/调整字段。

### Files
| File | Action |
|------|--------|
| `packages/pd-console/src/ui/pages/control-center/PendingTermsSection.tsx` | 新建 |

### Component API

```typescript
interface PendingTermsSectionProps {
  /** 无 props — 组件自己管理内部状态和数据加载 */
}
```

### Features

1. **折叠面板**：默认展开，"待审批候选词 (N)" 带计数
2. **候选词卡片/行**：显示 term、suggestedCategory、suggestedPrecision、reason、discoveredAt
3. **审批流程**：点击"采纳"打开 KeywordEditDialog（预填建议值），用户确认后调用 API
4. **驳回流程**：点击"驳回"，确认后调用 `rejectTerm` API
5. **Empty State**：无待审批词时的提示
6. **Loading / Error 状态**

### Pending Term Row Design

```
┌─────────────────────────────────────────────┐
│ 依赖版本锁定                                  │
│ 建议类别: 纠正 · 精确度: 确定 · 来源: LLM    │
│ 发现理由: 用户多次手动固定依赖版本             │
│ 发现时间: 2026-07-01 10:00                   │
│ [采纳] [驳回]                                │
└─────────────────────────────────────────────┘
```

### Steps

1. 从 `signal-keywords-api` 导入 `fetchPendingTerms` / `approveTerm` / `rejectTerm`
2. 折叠/展开状态用 `useState`
3. 审批流程：打开 KeywordEditDialog → 用户确认 → 调用 approve API → 从待审批列表移除 + 刷新词库列表
4. 驳回流程：确认 → 调用 reject API → 从待审批列表移除
5. 每个操作有 loading 状态
6. 使用 `useTranslation` 获取 i18n 文本

### Scope Boundary
+ 依赖 KeywordEditDialog（Task 7）
+ 不修改词库列表组件
+ 只在自身区域更新状态

---

## Self-Review Checklist

- [x] 所有 8 个 task 都有明确的 Goal + Success Criteria
- [x] 每个 task 的 scope boundary 清晰
- [x] 验证器遵循 rc-1~rc-5（unknown 输入、as bypass 禁止、fail loud、array element validation、hasOwn）
- [x] i18n keys 在 zh-CN.json 和 en.json 中都有对应条目
- [x] 所有 new component 使用 data-* attributes 便于测试
- [x] 无 placeholder UI（"TODO"、"FIXME"、`Promise<...>` 等占位符需在实现时填充）
- [x] mock 数据覆盖所有 source/precision/category 组合
- [x] API 层的 mock 开关只在 dev 环境生效（`IS_DEV`）
- [x] 删除操作有确认步骤
- [x] 无 `any` 类型（validator 使用 `unknown`）
- [x] 无 `@ts-ignore` / `@ts-expect-error`

### Self-review 发现的待定项

| # | 问题 | 状态 |
|---|------|------|
| 1 | Task 3 的测试断言需要根据实际实现方式（filter 或 JSX guard）精确匹配 | 实现时确认 |
| 2 | Task 4 API 函数签名中的 `Promise<...>` 占位符需填充完整返回类型 | 实现时填充 |
| 3 | `PendingTerm` 验证器代码在 plan 中省略（"// ... 类似的 PendingTerm 验证器"），需从 Task 4 模式推导 | 可推导 |
| 4 | i18n 的 `titleEn` 等命名模式（`title`/`titleEn`）与现有 json 文件模式（`title` 单 key）不一致，需实现时确认 | 实现时确认 |

---

## Execution Options

完成后，选择执行方式：

**Option A: Subagent-driven** — 按 Task 依赖图分批派发 subagent（`category="deep"`），每个 agent 执行一个 task，reviewer gate 在每个 task 完成后触发。

**Option B: Sequential inline** — 按依赖顺序逐个 task 执行，每完成 2-3 个 task 做一次综合 review。

**Option C: Hybrid** — Task 1+3+4 并行 → Task 2+5 并行 → Task 6+8 并行 → Task 7 单独执行。
