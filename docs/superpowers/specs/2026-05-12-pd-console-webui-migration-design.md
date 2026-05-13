# PD Console WebUI 迁移设计方案

> 日期：2026-05-12
> 状态：已评审优化

## 1. 背景与目标

### 1.1 项目背景

当前仓库正在进行大量的插件 SDK 重构，目标改善项目的代码架构和设计。PD 项目的 WebUI 界面目前位于 `openclaw-plugin/ui` 目录，需要迁移到专门的 `pd-console` 目录，实现完全独立部署。

### 1.2 迁移目标

1. **完全替代旧 UI**：pd-console 需具备 openclaw-plugin/ui 的全部功能
2. **基于 runtime-v2 重新设计**：不直接迁移旧代码，而是基于 `@principles/core/runtime-v2` 重新实现
3. **支持多工作区**：保留并改进跨工作区的中央视图功能
4. **独立认证机制**：与 OpenClaw 解耦，使用自己的认证机制
5. **SDK 重构方向对齐**：严格遵循 SDK 三层架构

### 1.3 核心约束

- `@principles/core` 不得依赖 `openclaw-plugin` 或 `pd-cli`
- pd-console 只能依赖 `@principles/core/runtime-v2`，不能直接依赖 openclaw-plugin
- 新功能应先在 pd-console 内部实现，成熟后可考虑提升到 core

---

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      pd-console UI                           │
│  ┌──────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Overview │ │ Samples │ │ Feedback │ │  Gates   │       │
│  └──────────┘ └─────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐                                │
│  │ Evolution │ │ Thinking │                                │
│  └──────────┘ └──────────┘                                │
│                      React + React Query                     │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP / JSON
┌───────────────────────────┼─────────────────────────────────┐
│                pd-console Server                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Console Read Models (基于 runtime-v2 聚合)          │   │
│  │  - OverviewConsoleModel (聚合 OperatorHealth)        │   │
│  │  - GateConsoleModel (聚合 GfiReadModel + Pain)       │   │
│  │  - SampleConsoleModel (Phase 2, 新实现)            │   │
│  │  - EvolutionConsoleModel (Phase 3, 新实现)          │   │
│  │  - ThinkingConsoleModel (Phase 4, 新实现)            │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Multi-Workspace Manager                            │   │
│  │  - WorkspaceConfigStore (JSON 文件存储)             │   │
│  │  - WorkspaceService (多工作区聚合)                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                       Node.js HTTP                          │
└───────────────────────────┼─────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────┐
│           @principles/core/runtime-v2 (已验证的能力)           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  已可直接使用:                                       │   │
│  │  - RuntimeStateManager (任务/运行/候选/Artifact)     │   │
│  │  - OperatorHealthReadModel (完整健康快照)             │   │
│  │  - PainChainReadModel (Pain 链追踪)                  │   │
│  │  - PruningReadModel (Principle 修剪信号)            │   │
│  │  - GfiReadModel (GFI 快照 + 工作区健康)              │   │
│  │  - InternalizationQueueReadModel (PI 队列健康)       │   │
│  │  - CandidateIntakeService (候选摄入)                 │   │
│  │  - PrincipleTreeLedgerAdapter (Principle 树)         │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 设计原则

1. **分层清晰**：严格遵循 SDK 三层架构
   - 后端 API 层：仅依赖 `@principles/core/runtime-v2`
   - 前端 UI 层：与后端 API 解耦
   - 状态管理：清晰的数据流

2. **复用 runtime-v2 已有能力**：
   - `OperatorHealthReadModel` 已提供完整的健康快照，直接复用
   - `GfiReadModel` 已提供 GFI 快照和工作区健康评估
   - Console 模型仅做数据聚合和格式化

3. **不直接依赖 openclaw-plugin**：所有数据访问都通过 runtime-v2 API

4. **支持多工作区**：保留 Central Overview 功能

5. **命名规范**：
   - runtime-v2 原生：`*ReadModel`
   - pd-console 特有聚合：`*ConsoleModel`（明确职责边界）

### 2.3 runtime-v2 能力映射

| 旧功能 | runtime-v2 替代方案 | 状态 |
|--------|---------------------|------|
| ControlUiQueryService.overview | `OperatorHealthReadModel` | ✅ 已可用 |
| HealthQueryService.getOverviewHealth | `OperatorHealthReadModel` | ✅ 已可用 |
| HealthQueryService.getFeedbackGfi | `GfiReadModel.buildGfiWorkspaceSnapshot` | ✅ 已可用 |
| HealthQueryService.getFeedbackEmpathyEvents | 需新增 Pain 事件查询 | ⚠️ 需评估 |
| HealthQueryService.getFeedbackGateBlocks | 需新增 Gate Block 查询 | ⚠️ 需评估 |
| ControlUiQueryService.listSamples | 需新增 Sample 查询 | ⚠️ 需评估 |
| EvolutionQueryService | 需新增 Evolution 查询 | ⚠️ 需评估 |
| ControlUiQueryService.getThinkingOverview | 需新增 Thinking Model 查询 | ⚠️ 需评估 |

---

## 3. 认证机制设计

### 3.1 设计目标

独立于 OpenClaw，使用自己的认证机制。

### 3.2 分层认证策略

#### 模式 1：无认证模式（默认）
- pd-console 作为本地服务运行在 localhost
- 默认不需要认证
- 可通过 --port 限制仅本地访问

#### 模式 2：Token 认证（可选）
- 启动时通过 --token 参数传入
- 或通过环境变量 PD_CONSOLE_TOKEN 设置
- Token 存储在 ~/.pd-console/token 文件（可选）

#### 模式 3：配置文件（可选）
- 配置文件位置：~/.pd-console/config.json
- 包含 token、端口、工作区列表等配置

### 3.3 CLI 参数

```bash
pd-console --workspace /path/to/workspace
pd-console --workspace /path/to/workspace --port 3100
pd-console --workspace /path/to/workspace --token my-secret-token
pd-console --no-auth  # 禁用认证（仅推荐本地开发使用）
```

### 3.4 环境变量

```bash
PD_CONSOLE_TOKEN=my-secret-token  # 设置认证 token
PD_CONSOLE_PORT=3100            # 设置端口
```

### 3.5 配置文件 (~/.pd-console/config.json)

```json
{
  "token": "optional-auth-token",
  "port": 3100,
  "workspaces": [
    {
      "name": "main",
      "path": "/path/to/workspace",
      "enabled": true
    }
  ]
}
```

---

## 4. API 设计

### 4.1 响应格式

统一使用 JSON 响应格式：

```typescript
// 成功响应
{
  "success": true,
  "data": { ... }
}

// 错误响应
{
  "success": false,
  "error": "error_code",
  "message": "Human readable message"
}
```

### 4.2 API 端点

#### 4.2.1 Workspace Management API（多工作区支持）

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /api/workspaces | 列出所有配置的工作区 |
| POST | /api/workspaces | 添加新工作区 |
| GET | /api/workspaces/:name | 获取工作区详情 |
| PATCH | /api/workspaces/:name | 更新工作区配置 |
| DELETE | /api/workspaces/:name | 移除工作区 |
| POST | /api/workspaces/:name/sync | 同步工作区数据 |

#### 4.2.2 Overview API

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /api/overview | 单工作区总览数据 |
| GET | /api/overview/health | 健康指标 |

#### 4.2.3 Feedback & GFI API

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /api/feedback/gfi | GFI 当前值和趋势 |
| GET | /api/feedback/empathy-events | 同理心事件（Pain 相关） |
| GET | /api/feedback/gate-blocks | Gate 阻塞事件 |

#### 4.2.4 Gate Monitor API

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /api/gate/stats | Gate 统计 |
| GET | /api/gate/blocks | Gate Block 列表 |

#### 4.2.5 Samples API（Phase 2）

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /api/samples | Sample 列表 |
| GET | /api/samples/:id | Sample 详情 |
| POST | /api/samples/:id/review | 审核 Sample |

#### 4.2.6 Evolution API（Phase 3）

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /api/evolution/tasks | Evolution 任务列表 |
| GET | /api/evolution/events | Evolution 事件 |
| GET | /api/evolution/trace/:id | Evolution 追踪 |
| GET | /api/evolution/stats | Evolution 统计 |

#### 4.2.7 Thinking Models API（Phase 4）

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /api/thinking | Thinking Models 总览 |
| GET | /api/thinking/models/:id | Thinking Model 详情 |

#### 4.2.8 Central Overview API（多工作区聚合）

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /api/central/overview | 跨工作区总览 |
| GET | /api/central/health | 跨工作区健康 |

---

## 5. 核心 Console Model 设计

> **命名说明**：以 `*ConsoleModel` 命名，明确这是 pd-console 特有的聚合模型，区别于 runtime-v2 原生的 `*ReadModel`

### 5.1 OverviewConsoleModel

**职责**：聚合多个 runtime-v2 数据源，提供 Overview 页面所需的数据

**数据源**：
- `OperatorHealthReadModel` - 操作员健康（已包含 painChain、candidateLedger、pruning、gfi）
- `RuntimeStateManager` - 任务状态

**优化点**：直接复用 `OperatorHealthReadModel.getSnapshot()` 的输出，仅做格式转换和补充

**接口定义**：

```typescript
interface OverviewConsoleModel {
  workspaceDir: string;
  generatedAt: string;
  dataFreshness: 'fresh' | 'stale' | 'error';

  summary: {
    repeatErrorRate: number;
    userCorrectionRate: number;
    pendingSamples: number;
    approvedSamples: number;
    painEvents: number;
    principleEventCount: number;
    gateBlocks: number;
    taskOutcomes: number;
  };

  health: {
    status: 'healthy' | 'degraded' | 'error';
    gfi: {
      current: number;
      stage: string;
      peakToday: number;
      threshold: number;
    };
    trust: {
      stage: number;
      score: number;
    };
    principles: {
      candidate: number;
      probation: number;
      active: number;
      deprecated: number;
    };
    queue: {
      pending: number;
      inProgress: number;
      completed: number;
    };
  };

  dailyTrend: Array<{
    day: string;
    toolCalls: number;
    failures: number;
    userCorrections: number;
    painEvents: number;
  }>;

  topRegressions: Array<{
    toolName: string;
    errorType: string;
    occurrences: number;
  }>;

  sampleQueue: {
    counters: Record<string, number>;
    preview: SamplePreview[];
  };
}

interface SamplePreview {
  sampleId: string;
  sessionId: string;
  qualityScore: number;
  reviewStatus: string;
  createdAt: string;
}
```

### 5.2 GateConsoleModel

**职责**：提供 Gate 监控数据

**数据源**：
- `GfiReadModel.buildGfiWorkspaceSnapshot()` - GFI 工作区快照
- `PainChainReadModel` - Pain 链追踪
- Session 数据（从文件系统读取）

**接口定义**：

```typescript
interface GateConsoleModel {
  generatedAt: string;

  today: {
    gfiBlocks: number;
    stageBlocks: number;
    bypassAttempts: number;
  };

  trust: {
    stage: number;
    score: number;
    status: 'healthy' | 'warning' | 'critical';
  };

  evolution: {
    tier: string;
    points: number;
    status: string;
  };

  gfi: {
    current: number;
    peakToday: number;
    threshold: number;
    trend: Array<{ hour: string; value: number }>;
    sources: Record<string, number>;
    stage: 'stable' | 'elevated' | 'critical' | 'saturated';
  };

  blocks: GateBlockItem[];
}

interface GateBlockItem {
  timestamp: string;
  toolName: string;
  filePath: string | null;
  reason: string;
  gateType: 'gfi' | 'stage' | 'p03' | 'other';
  gfi: number;
  trustStage: number;
}
```

### 5.3 FeedbackConsoleModel

**职责**：提供 Feedback 和 Empathy 相关数据

**设计说明**：Feedback 和 Gate 有大量重叠，考虑合并。保持独立以支持更灵活的使用场景。

**数据源**：
- `GfiReadModel` - GFI 快照
- Pain 事件记录（需评估数据来源）
- Gate Block 记录（需评估数据来源）

**接口定义**：

```typescript
interface FeedbackConsoleModel {
  generatedAt: string;

  gfi: {
    current: number;
    peakToday: number;
    threshold: number;
    trend: Array<{ hour: string; value: number }>;
    sources: Record<string, number>;
  };

  empathyEvents: EmpathyEvent[];

  gateBlocks: GateBlockItem[];
}

interface EmpathyEvent {
  timestamp: string;
  severity: 'low' | 'medium' | 'high';
  score: number;
  reason: string;
  origin: string;
  gfiAfter: number;
}
```

### 5.4 WorkspaceConfigStore

**职责**：管理多工作区配置和同步状态

**存储**：JSON 文件 (~/.pd-console/workspaces.json)

**接口定义**：

```typescript
interface WorkspaceConfigStore {
  getWorkspaces(): WorkspaceEntry[];
  getWorkspace(name: string): WorkspaceEntry | null;
  addWorkspace(name: string, path: string): void;
  updateWorkspace(name: string, updates: Partial<WorkspaceConfig>): void;
  removeWorkspace(name: string): void;
  syncWorkspace(name: string): SyncResult;
}

interface WorkspaceEntry {
  name: string;
  path: string;
  lastSync: string | null;
  config: WorkspaceConfig | null;
}

interface WorkspaceConfig {
  workspaceName: string;
  enabled: boolean;
  displayName: string | null;
  syncEnabled: boolean;
}

interface SyncResult {
  success: boolean;
  syncedAt: string;
  items: Record<string, number>;
}
```

---

## 6. UI 组件设计

### 6.1 整体布局

```
┌─────────────────────────────────────────────────────────────┐
│  Header: Logo + Workspace Selector + Auth Status            │
├────────────┬────────────────────────────────────────────────┤
│            │                                                 │
│  Sidebar   │              Main Content                       │
│            │                                                 │
│  - Overview│  (根据选中页面显示不同内容)                       │
│  - Feedback│                                                │
│  - Gates   │                                                 │
│  - Samples │                                                 │
│  - Evolution                                                │
│  - Thinking                                                │
│  - Settings                                                 │
│            │                                                 │
└────────────┴────────────────────────────────────────────────┘
```

### 6.2 页面组件结构

#### OverviewPage
- `OverviewHeader` - 页面标题 + 刷新按钮
- `HealthCard` - 健康状态卡片（GFI、Trust、Evolution、Principles）
- `SummaryStats` - 关键指标统计
- `DailyTrendChart` - 每日趋势图表
- `TopRegressions` - Top 回归问题列表
- `SampleQueuePreview` - Sample 队列预览

#### FeedbackPage
- `GfiGauge` - GFI 仪表盘
- `GfiTrendChart` - GFI 趋势图
- `EmpathyEventsList` - 同理心事件列表
- `GfiSourcesBreakdown` - GFI 来源分布

#### GatesPage
- `GateStatsBar` - 统计概览栏
- `GateStatusCard` - Trust/Evolution 状态卡片
- `GateBlocksList` - Gate Blocks 列表
- `GateBlocksFilter` - 过滤/搜索

#### SamplesPage（Phase 2）
- `SamplesHeader` - 过滤条件 + 统计
- `SampleList` - Sample 列表
- `SampleCard` - 单个 Sample 卡片
- `SampleDetailPanel` - Sample 详情面板
- `SampleReviewActions` - 审核操作按钮

#### EvolutionPage（Phase 3）
- `EvolutionStats` - 统计概览
- `EvolutionTasksList` - 任务列表
- `EvolutionTaskCard` - 任务卡片
- `EvolutionTraceView` - 追踪详情视图
- `EvolutionTimeline` - 时间线视图

#### ThinkingPage（Phase 4）
- `ThinkingModelsSummary` - 模型总览
- `ThinkingModelsGrid` - 模型网格
- `ThinkingModelCard` - 模型卡片
- `ThinkingModelDetail` - 模型详情
- `ScenarioMatrix` - 场景矩阵

#### SettingsPage
- `WorkspaceSelector` - 工作区选择器
- `WorkspaceList` - 工作区列表
- `WorkspaceForm` - 添加/编辑工作区表单
- `AuthSettings` - 认证设置

### 6.3 数据获取模式

使用 React Query 进行数据获取：

```typescript
const { data, isLoading, error, refetch } = useQuery({
  queryKey: ['overview', workspaceName],
  queryFn: () => fetchOverview(workspaceName),
  refetchInterval: 30000,
});
```

### 6.4 错误处理

- 加载状态：显示 Loading spinner
- 错误状态：显示错误消息 + 重试按钮
- 空数据：显示友好提示

---

## 7. 项目结构

```
packages/pd-console/
├── src/
│   ├── ui/                           # React 前端
│   │   ├── components/              # 可复用组件
│   │   │   ├── common/              # 通用组件
│   │   │   │   ├── Header.tsx
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   ├── LoadingSpinner.tsx
│   │   │   │   └── ErrorBoundary.tsx
│   │   │   ├── overview/            # Overview 相关组件
│   │   │   │   ├── HealthCard.tsx
│   │   │   │   ├── SummaryStats.tsx
│   │   │   │   ├── DailyTrendChart.tsx
│   │   │   │   └── TopRegressions.tsx
│   │   │   ├── feedback/            # Feedback 相关组件
│   │   │   │   ├── GfiGauge.tsx
│   │   │   │   ├── GfiTrendChart.tsx
│   │   │   │   └── EmpathyEventsList.tsx
│   │   │   ├── gates/               # Gates 相关组件
│   │   │   │   ├── GateStatsBar.tsx
│   │   │   │   ├── GateBlocksList.tsx
│   │   │   │   └── GateStatusCard.tsx
│   │   │   └── samples/             # Samples 相关组件（Phase 2）
│   │   ├── pages/                   # 页面组件
│   │   │   ├── OverviewPage.tsx
│   │   │   ├── FeedbackPage.tsx
│   │   │   ├── GatesPage.tsx
│   │   │   ├── SamplesPage.tsx      # Phase 2
│   │   │   ├── EvolutionPage.tsx    # Phase 3
│   │   │   ├── ThinkingPage.tsx     # Phase 4
│   │   │   └── SettingsPage.tsx
│   │   ├── hooks/                   # React hooks
│   │   │   ├── useApi.ts            # API 请求 hook
│   │   │   └── useWorkspace.ts      # 工作区管理 hook
│   │   ├── api/                     # API 客户端
│   │   │   └── index.ts
│   │   ├── types/                   # 类型定义
│   │   │   └── index.ts
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── styles/                  # 样式
│   │       └── index.css
│   ├── server/                       # Node.js 后端
│   │   ├── index.ts                 # 服务器入口
│   │   ├── routes/                  # API 路由
│   │   │   ├── overview.ts
│   │   │   ├── feedback.ts
│   │   │   ├── gates.ts
│   │   │   ├── samples.ts           # Phase 2
│   │   │   ├── evolution.ts         # Phase 3
│   │   │   ├── thinking.ts          # Phase 4
│   │   │   ├── central.ts           # 跨工作区 API
│   │   │   └── workspaces.ts        # 工作区管理
│   │   ├── models/                  # Console 模型（聚合层）
│   │   │   ├── OverviewConsoleModel.ts
│   │   │   ├── GateConsoleModel.ts
│   │   │   ├── FeedbackConsoleModel.ts
│   │   │   └── WorkspaceService.ts
│   │   ├── config/                  # 配置管理
│   │   │   ├── WorkspaceConfigStore.ts
│   │   │   └── AuthConfig.ts
│   │   ├── types/                   # 类型定义
│   │   │   └── index.ts
│   │   └── utils/                   # 工具函数
│   │       └── response.ts          # 响应格式化
│   └── cli/                         # CLI 入口
│       └── index.ts
├── package.json
├── tsconfig.json
├── vite.config.ts                   # 前端构建
└── build.config.ts                  # 后端构建
```

### 目录职责

| 目录 | 职责 |
|------|------|
| `src/ui/` | React 前端应用，包含组件、页面、hooks、API 客户端 |
| `src/server/` | Node.js HTTP 服务器，包含路由、业务服务 |
| `src/server/models/` | Console 模型，聚合 runtime-v2 数据源 |
| `src/server/config/` | 配置管理（工作区配置、认证配置） |
| `src/cli/` | CLI 入口，处理命令行参数 |

---

## 8. Phase 1 详细实施计划

> **Phase 1 是最关键的，需要验证设计可行性**

### 8.1 任务分解

#### Task 1.1: 项目结构重构
**目标**：重组 pd-console 项目结构，支持多文件模块化

**文件变更**：
- 创建 `src/server/routes/` 目录结构
- 创建 `src/server/models/` 目录结构
- 创建 `src/server/config/` 目录结构
- 迁移现有 server.ts 逻辑到模块化结构

**验收标准**：
- [ ] 目录结构符合设计方案
- [ ] 服务器启动正常
- [ ] 现有 API 端点仍然可用

---

#### Task 1.2: WorkspaceConfigStore 实现
**目标**：实现多工作区配置管理

**文件变更**：
- 新建 `src/server/config/WorkspaceConfigStore.ts`
- 新建 `src/server/types/index.ts`（配置类型）
- 更新 CLI 参数解析，支持 --workspace 列表

**接口**：
```typescript
class WorkspaceConfigStore {
  constructor(configDir: string);
  getWorkspaces(): WorkspaceEntry[];
  getWorkspace(name: string): WorkspaceEntry | null;
  addWorkspace(name: string, path: string): void;
  updateWorkspace(name: string, updates: Partial<WorkspaceConfig>): void;
  removeWorkspace(name: string): void;
  save(): void;
}
```

**验收标准**：
- [ ] 配置文件创建/读取/更新/删除正常
- [ ] 配置文件路径：~/.pd-console/workspaces.json
- [ ] 单元测试覆盖

---

#### Task 1.3: AuthConfig 实现
**目标**：实现独立于 OpenClaw 的认证机制

**文件变更**：
- 新建 `src/server/config/AuthConfig.ts`
- 更新服务器启动逻辑

**接口**：
```typescript
interface AuthConfig {
  token: string | null;
  enabled: boolean;
}

class AuthConfig {
  constructor(envToken?: string, cliToken?: string, noAuth?: boolean);
  isEnabled(): boolean;
  validate(token: string): boolean;
}
```

**验收标准**：
- [ ] 支持 --token CLI 参数
- [ ] 支持 PD_CONSOLE_TOKEN 环境变量
- [ ] 支持 --no-auth 参数禁用认证
- [ ] 默认无认证（向后兼容本地使用场景）

---

#### Task 1.4: OverviewConsoleModel 实现
**目标**：实现 Overview 聚合模型，复用 OperatorHealthReadModel

**文件变更**：
- 新建 `src/server/models/OverviewConsoleModel.ts`

**接口**：
```typescript
class OverviewConsoleModel {
  constructor(workspaceDir: string);
  async getOverview(days?: number): Promise<OverviewConsoleModelOutput>;
  async getHealth(): Promise<HealthOutput>;
  dispose(): void;
}
```

**数据流**：
```
OperatorHealthReadModel.getSnapshot()
  ↓
格式转换 + 补充数据
  ↓
OverviewConsoleModelOutput
```

**验收标准**：
- [ ] 复用 OperatorHealthReadModel
- [ ] 输出符合 OverviewConsoleModel 接口定义
- [ ] 单元测试覆盖

---

#### Task 1.5: GateConsoleModel 实现
**目标**：实现 Gate 监控聚合模型

**文件变更**：
- 新建 `src/server/models/GateConsoleModel.ts`

**接口**：
```typescript
class GateConsoleModel {
  constructor(workspaceDir: string);
  async getGateStats(): Promise<GateStatsOutput>;
  async getGateBlocks(limit?: number): Promise<GateBlockItem[]>;
  dispose(): void;
}
```

**验收标准**：
- [ ] 复用 GfiReadModel
- [ ] 输出符合 GateConsoleModel 接口定义
- [ ] 单元测试覆盖

---

#### Task 1.6: FeedbackConsoleModel 实现
**目标**：实现 Feedback 聚合模型

**文件变更**：
- 新建 `src/server/models/FeedbackConsoleModel.ts`

**接口**：
```typescript
class FeedbackConsoleModel {
  constructor(workspaceDir: string);
  async getGfi(): Promise<GfiOutput>;
  async getEmpathyEvents(limit?: number): Promise<EmpathyEvent[]>;
  async getGateBlocks(limit?: number): Promise<GateBlockItem[]>;
  dispose(): void;
}
```

**验收标准**：
- [ ] GFI 数据复用 GfiReadModel
- [ ] Empathy 事件查询（评估数据来源）
- [ ] 单元测试覆盖

---

#### Task 1.7: WorkspaceService 实现
**目标**：实现多工作区聚合服务

**文件变更**：
- 新建 `src/server/models/WorkspaceService.ts`

**接口**：
```typescript
class WorkspaceService {
  constructor(configStore: WorkspaceConfigStore);
  async getCentralOverview(): Promise<CentralOverviewOutput>;
  async getCentralHealth(): Promise<CentralHealthOutput>;
  async syncWorkspace(name: string): Promise<SyncResult>;
  dispose(): void;
}
```

**验收标准**：
- [ ] 遍历所有启用的工作区
- [ ] 聚合各工作区的 Overview 数据
- [ ] 单元测试覆盖

---

#### Task 1.8: API 路由实现
**目标**：实现 Phase 1 所需的全部 API 路由

**文件变更**：
- 新建 `src/server/routes/overview.ts`
- 新建 `src/server/routes/gates.ts`
- 新建 `src/server/routes/feedback.ts`
- 新建 `src/server/routes/workspaces.ts`
- 新建 `src/server/routes/central.ts`
- 更新 `src/server/index.ts` 注册路由

**验收标准**：
- [ ] /api/overview 返回正确的 Overview 数据
- [ ] /api/overview/health 返回健康数据
- [ ] /api/gate/stats 返回 Gate 统计
- [ ] /api/gate/blocks 返回 Gate Block 列表
- [ ] /api/feedback/gfi 返回 GFI 数据
- [ ] /api/workspaces CRUD 操作正常
- [ ] /api/central/overview 聚合多工作区数据
- [ ] 统一响应格式 { success, data/error }

---

#### Task 1.9: UI 页面实现（Phase 1）
**目标**：实现 Overview、Feedback、Gates 页面

**文件变更**：
- 创建 OverviewPage 组件
- 创建 FeedbackPage 组件
- 创建 GatesPage 组件
- 更新 App.tsx 路由配置
- 创建/复用通用组件

**验收标准**：
- [ ] Overview 页面展示健康状态、统计、趋势
- [ ] Feedback 页面展示 GFI、Empathy 事件
- [ ] Gates 页面展示 Gate 统计和 Block 列表
- [ ] 页面间导航正常
- [ ] 响应式布局

---

#### Task 1.10: Settings 页面实现
**目标**：实现工作区管理和认证设置页面

**文件变更**：
- 创建 SettingsPage 组件
- 创建工作区列表/表单组件
- 创建认证设置组件

**验收标准**：
- [ ] 工作区列表展示正常
- [ ] 添加/编辑/删除工作区功能
- [ ] 认证设置（Token）功能

---

### 8.2 Phase 1 里程碑

```
Phase 1 完成条件：
□ 所有 Task 验收标准通过
□ API 端点测试覆盖
□ UI 功能测试覆盖
□ pd-console 可独立运行
□ 多工作区功能验证
□ 认证功能验证
```

---

## 9. Phase 2-4 概要计划

### Phase 2: Samples 审核功能

| 任务 | 描述 | 依赖 | 预估时间 |
|------|------|------|---------|
| 2.1 | 评估 runtime-v2 中 Sample 数据来源 | - | 1d |
| 2.2 | 设计 SampleConsoleModel | 2.1 | 1d |
| 2.3 | 实现 Samples API 路由 | 2.2 | 1d |
| 2.4 | 实现 Samples UI 页面 | 2.3 | 2d |

---

### Phase 3: Evolution 追踪功能

| 任务 | 描述 | 依赖 | 预估时间 |
|------|------|------|---------|
| 3.1 | 评估 runtime-v2 中 Evolution 数据来源 | - | 2d |
| 3.2 | 设计 EvolutionConsoleModel | 3.1 | 1d |
| 3.3 | 实现 Evolution API 路由 | 3.2 | 2d |
| 3.4 | 实现 Evolution UI 页面 | 3.3 | 3d |

---

### Phase 4: Thinking Models 功能

| 任务 | 描述 | 依赖 | 预估时间 |
|------|------|------|---------|
| 4.1 | 评估 Thinking Model 数据来源 | - | 2d |
| 4.2 | 设计 ThinkingConsoleModel | 4.1 | 1d |
| 4.3 | 实现 Thinking API 路由 | 4.2 | 2d |
| 4.4 | 实现 Thinking UI 页面 | 4.3 | 3d |

---

## 10. 清理策略

### 10.1 待移除文件

1. **openclaw-plugin/ui/** - 整个 UI 目录
2. **openclaw-plugin/src/http/principles-console-route.ts** - 路由定义
3. **相关配置** - 构建脚本中的 UI 构建配置

### 10.2 迁移验证

在移除前，确保：
- pd-console Phase 1-4 功能完整
- 所有 API 端点都已迁移
- UI 功能与旧版本等效或更好
- 测试覆盖完整

---

## 11. 风险与注意事项

### 11.1 技术风险

1. **runtime-v2 功能覆盖**：Phase 1 已验证可复用 OperatorHealthReadModel
2. **Phase 2-4 数据来源**：需要评估 TrajectoryDatabase 中的数据是否可以迁移
3. **性能考虑**：多个工作区同步可能带来性能问题

### 11.2 架构注意事项

1. **Console Model 边界**：保持 Model 职责单一，不要过度聚合
2. **API 版本控制**：考虑预留 API 版本扩展能力
3. **错误处理**：统一错误处理模式，避免不一致

---

## 12. 附录

### 12.1 参考文件

- [openclaw-plugin/ui/](file:///workspace/packages/openclaw-plugin/ui/src) - 旧 UI 代码
- [openclaw-plugin/src/http/principles-console-route.ts](file:///workspace/packages/openclaw-plugin/src/http/principles-console-route.ts) - 旧 API 路由
- [openclaw-plugin/src/service/control-ui-query-service.ts](file:///workspace/packages/openclaw-plugin/src/service/control-ui-query-service.ts) - 旧 Query Service
- [pd-console/src/server.ts](file:///workspace/packages/pd-console/src/server.ts) - 当前 pd-console 服务器
- [@principles/core/runtime-v2](file:///workspace/packages/principles-core/src/runtime-v2/index.ts) - Runtime V2 API

### 12.2 runtime-v2 已验证能力

| 模块 | 文件 | 用途 |
|------|------|------|
| OperatorHealthReadModel | [operator-health-read-model.ts](file:///workspace/packages/principles-core/src/runtime-v2/operator-health-read-model.ts) | 完整健康快照 |
| GfiReadModel | [gfi/gfi-read-model.ts](file:///workspace/packages/principles-core/src/runtime-v2/gfi/gfi-read-model.ts) | GFI 快照和工作区健康 |
| PainChainReadModel | [pain-chain-read-model.ts](file:///workspace/packages/principles-core/src/runtime-v2/pain-chain-read-model.ts) | Pain 链追踪 |
| PruningReadModel | [pruning-read-model.ts](file:///workspace/packages/principles-core/src/runtime-v2/pruning-read-model.ts) | Principle 修剪信号 |
| InternalizationQueueReadModel | [internalization-queue-read-model.ts](file:///workspace/packages/principles-core/src/runtime-v2/internalization-queue-read-model.ts) | PI 队列健康 |
| RuntimeStateManager | [store/runtime-state-manager.ts](file:///workspace/packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts) | 任务/运行/候选/Artifact |

### 12.3 术语表

| 术语 | 说明 |
|------|------|
| ConsoleModel | pd-console 特有的聚合模型，区别于 runtime-v2 原生的 ReadModel |
| ReadModel | runtime-v2 原生的读取模型 |
| GFI | General Friction Index，系统摩擦指数 |
| Pain Event | 痛点事件，系统检测到的用户痛点 |
| Sample | 样本，用于训练的纠正样本 |
| Evolution | 演进，Principle 的演进过程 |
| Thinking Model | 思考模型，系统检测到的思考模式 |
