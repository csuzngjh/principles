# PD Console WebUI 迁移实现计划

> 日期：2026-05-12
> 状态：待评审
> 参考设计：[2026-05-12-pd-console-webui-migration-design.md](2026-05-12-pd-console-webui-migration-design.md)

---

## 概述

本计划基于优化后的设计方案，将 pd-console 打造成完全独立、基于 runtime-v2 架构的 WebUI 控制台。

**核心原则**：
- 复用 runtime-v2 已有能力（OperatorHealthReadModel、GfiReadModel 等）
- Console 模型（`*ConsoleModel`）仅做数据聚合和格式化
- 独立于 OpenClaw 的认证机制
- 支持多工作区

---

## Phase 1：基础能力（核心里程碑）

**目标**：验证设计可行性，实现 Overview、Feedback、Gates 页面

### Task 1.1: 项目结构重构

**负责人**：（待分配）
**预估时间**：1 天
**依赖**：无

**文件变更**：
```
src/server/
├── index.ts                 # 服务器入口（重构）
├── routes/                  # 新建
│   └── .gitkeep
├── models/                  # 新建
│   └── .gitkeep
├── config/                  # 新建
│   └── .gitkeep
├── types/                  # 新建
│   └── index.ts
└── utils/                  # 新建
    └── response.ts
```

**验收标准**：
- [ ] 目录结构符合设计方案
- [ ] 服务器启动正常
- [ ] 现有 API 端点（/api/status, /api/tasks 等）仍然可用

**实施步骤**：
1. 创建目录结构
2. 创建类型定义文件 `types/index.ts`
3. 创建响应格式化工具 `utils/response.ts`
4. 重构 `server.ts` 拆分为入口 + 路由注册
5. 更新构建配置（如果需要）

---

### Task 1.2: WorkspaceConfigStore 实现

**负责人**：（待分配）
**预估时间**：1 天
**依赖**：Task 1.1

**文件变更**：
- 新建 `src/server/config/WorkspaceConfigStore.ts`

**实施步骤**：
1. 定义配置类型（WorkspaceEntry, WorkspaceConfig）
2. 实现 WorkspaceConfigStore 类
   - 构造函数：初始化配置目录
   - `getWorkspaces()`: 读取配置文件，返回工作区列表
   - `getWorkspace(name)`: 获取单个工作区
   - `addWorkspace(name, path)`: 添加工作区
   - `updateWorkspace(name, updates)`: 更新工作区
   - `removeWorkspace(name)`: 移除工作区
   - `save()`: 持久化配置
3. 配置文件路径：`~/.pd-console/workspaces.json`
4. 添加单元测试

**验收标准**：
- [ ] 配置文件创建/读取/更新/删除正常
- [ ] 自动创建配置目录
- [ ] 单元测试覆盖

---

### Task 1.3: AuthConfig 实现

**负责人**：（待分配）
**预估时间**：0.5 天
**依赖**：Task 1.1

**文件变更**：
- 新建 `src/server/config/AuthConfig.ts`

**实施步骤**：
1. 定义 AuthConfig 接口
2. 实现 AuthConfig 类
   - 构造函数：优先순  CLI token > 环境变量 > 无认证
   - `isEnabled()`: 检查是否启用认证
   - `validate(token)`: 验证 token
3. 更新服务器启动逻辑
4. 添加单元测试

**验收标准**：
- [ ] 支持 --token CLI 参数
- [ ] 支持 PD_CONSOLE_TOKEN 环境变量
- [ ] 支持 --no-auth 参数禁用认证
- [ ] 默认无认证
- [ ] 单元测试覆盖

---

### Task 1.4: OverviewConsoleModel 实现

**负责人**：（待分配）
**预估时间**：2 天
**依赖**：Task 1.1

**文件变更**：
- 新建 `src/server/models/OverviewConsoleModel.ts`

**实施步骤**：
1. 定义接口类型（OverviewConsoleModelOutput）
2. 实现 OverviewConsoleModel 类
   - 构造函数：初始化 OperatorHealthReadModel
   - `getOverview(days?)`: 聚合健康数据
   - `getHealth()`: 返回健康快照
   - `dispose()`: 清理资源
3. 复用 `OperatorHealthReadModel.getSnapshot()`
4. 格式转换和补充数据
5. 添加单元测试

**数据流**：
```
OperatorHealthReadModel.getSnapshot()
  ↓
PainChainReadModel (补充 Pain 数据)
  ↓
PruningReadModel (补充 Principle 数据)
  ↓
格式转换
  ↓
OverviewConsoleModelOutput
```

**验收标准**：
- [ ] 复用 OperatorHealthReadModel
- [ ] 输出符合设计中的接口定义
- [ ] 单元测试覆盖

---

### Task 1.5: GateConsoleModel 实现

**负责人**：（待分配）
**预估时间**：2 天
**依赖**：Task 1.1

**文件变更**：
- 新建 `src/server/models/GateConsoleModel.ts`

**实施步骤**：
1. 定义接口类型（GateStatsOutput, GateBlockItem）
2. 实现 GateConsoleModel 类
   - 构造函数：初始化 GfiReadModel, PainChainReadModel
   - `getGateStats()`: 获取 Gate 统计
   - `getGateBlocks(limit?)`: 获取 Gate Block 列表
   - `dispose()`: 清理资源
3. 复用 `GfiReadModel.buildGfiWorkspaceSnapshot()`
4. 评估 Gate Block 数据来源
5. 添加单元测试

**验收标准**：
- [ ] 复用 GfiReadModel
- [ ] 输出符合设计中的接口定义
- [ ] 单元测试覆盖

---

### Task 1.6: FeedbackConsoleModel 实现

**负责人**：（待分配）
**预估时间**：1 天
**依赖**：Task 1.1, Task 1.5

**文件变更**：
- 新建 `src/server/models/FeedbackConsoleModel.ts`

**实施步骤**：
1. 定义接口类型（FeedbackOutput, EmpathyEvent）
2. 实现 FeedbackConsoleModel 类
   - 构造函数：初始化依赖
   - `getGfi()`: 复用 GateConsoleModel 的 GFI 数据
   - `getEmpathyEvents(limit?)`: 获取 Empathy 事件
   - `getGateBlocks(limit?)`: 复用 GateConsoleModel 的 Block 数据
   - `dispose()`: 清理资源
3. 评估 Empathy 事件数据来源
4. 添加单元测试

**验收标准**：
- [ ] GFI 数据复用 GfiReadModel
- [ ] Empathy 事件查询（评估数据来源）
- [ ] 单元测试覆盖

---

### Task 1.7: WorkspaceService 实现

**负责人**：（待分配）
**预估时间**：1 天
**依赖**：Task 1.2, Task 1.4

**文件变更**：
- 新建 `src/server/models/WorkspaceService.ts`

**实施步骤**：
1. 定义接口类型（CentralOverviewOutput, CentralHealthOutput）
2. 实现 WorkspaceService 类
   - 构造函数：初始化 WorkspaceConfigStore 和各工作区的 ConsoleModel
   - `getCentralOverview()`: 遍历所有启用的工作区，聚合 Overview 数据
   - `getCentralHealth()`: 遍历所有启用的工作区，聚合健康数据
   - `syncWorkspace(name)`: 同步单个工作区
   - `dispose()`: 清理所有工作区的资源
3. 添加单元测试

**验收标准**：
- [ ] 遍历所有启用的工作区
- [ ] 聚合各工作区的数据
- [ ] 单元测试覆盖

---

### Task 1.8: API 路由实现

**负责人**：（待分配）
**预估时间**：2 天
**依赖**：Task 1.4, Task 1.5, Task 1.6, Task 1.7

**文件变更**：
- 新建 `src/server/routes/overview.ts`
- 新建 `src/server/routes/gates.ts`
- 新建 `src/server/routes/feedback.ts`
- 新建 `src/server/routes/workspaces.ts`
- 新建 `src/server/routes/central.ts`
- 更新 `src/server/index.ts` 注册路由

**实施步骤**：

#### 1.8.1 实现 overview 路由
```typescript
// GET /api/overview
// GET /api/overview/health
```

#### 1.8.2 实现 gates 路由
```typescript
// GET /api/gate/stats
// GET /api/gate/blocks
```

#### 1.8.3 实现 feedback 路由
```typescript
// GET /api/feedback/gfi
// GET /api/feedback/empathy-events
// GET /api/feedback/gate-blocks
```

#### 1.8.4 实现 workspaces 路由
```typescript
// GET    /api/workspaces
// POST   /api/workspaces
// GET    /api/workspaces/:name
// PATCH  /api/workspaces/:name
// DELETE /api/workspaces/:name
// POST   /api/workspaces/:name/sync
```

#### 1.8.5 实现 central 路由
```typescript
// GET /api/central/overview
// GET /api/central/health
```

#### 1.8.6 注册路由
更新 `src/server/index.ts`，注册所有路由

**验收标准**：
- [ ] 所有端点返回正确的 JSON 格式
- [ ] 统一响应格式 `{ success: true, data: ... }` 或 `{ success: false, error: ..., message: ... }`
- [ ] 认证检查（如果启用）
- [ ] 错误处理

---

### Task 1.9: UI 页面实现（Phase 1）

**负责人**：（待分配）
**预估时间**：3 天
**依赖**：Task 1.8

**文件变更**：
- 创建 OverviewPage 组件
- 创建 FeedbackPage 组件
- 创建 GatesPage 组件
- 更新 App.tsx 路由配置
- 创建通用组件（如果需要）

**实施步骤**：

#### 1.9.1 创建通用组件
- ErrorBoundary.tsx
- LoadingSpinner.tsx

#### 1.9.2 创建 OverviewPage
```
src/ui/pages/OverviewPage.tsx
src/ui/components/overview/HealthCard.tsx
src/ui/components/overview/SummaryStats.tsx
src/ui/components/overview/DailyTrendChart.tsx
src/ui/components/overview/TopRegressions.tsx
```

#### 1.9.3 创建 FeedbackPage
```
src/ui/pages/FeedbackPage.tsx
src/ui/components/feedback/GfiGauge.tsx
src/ui/components/feedback/GfiTrendChart.tsx
src/ui/components/feedback/EmpathyEventsList.tsx
```

#### 1.9.4 创建 GatesPage
```
src/ui/pages/GatesPage.tsx
src/ui/components/gates/GateStatsBar.tsx
src/ui/components/gates/GateStatusCard.tsx
src/ui/components/gates/GateBlocksList.tsx
```

#### 1.9.5 更新 App.tsx
- 添加 React Router
- 配置路由

**验收标准**：
- [ ] Overview 页面展示健康状态、统计、趋势
- [ ] Feedback 页面展示 GFI、Empathy 事件
- [ ] Gates 页面展示 Gate 统计和 Block 列表
- [ ] 页面间导航正常
- [ ] 响应式布局

---

### Task 1.10: Settings 页面实现

**负责人**：（待分配）
**预估时间**：2 天
**依赖**：Task 1.2, Task 1.3

**文件变更**：
- 创建 SettingsPage 组件
- 创建工作区列表/表单组件

**实施步骤**：
1. 创建 SettingsPage.tsx
2. 创建 WorkspaceList 组件
3. 创建 WorkspaceForm 组件
4. 创建 AuthSettings 组件
5. 添加 Settings 路由

**验收标准**：
- [ ] 工作区列表展示正常
- [ ] 添加/编辑/删除工作区功能
- [ ] 认证设置（Token）功能

---

## Phase 1 里程碑检查清单

```
□ Task 1.1  项目结构重构
□ Task 1.2  WorkspaceConfigStore 实现
□ Task 1.3  AuthConfig 实现
□ Task 1.4  OverviewConsoleModel 实现
□ Task 1.5  GateConsoleModel 实现
□ Task 1.6  FeedbackConsoleModel 实现
□ Task 1.7  WorkspaceService 实现
□ Task 1.8  API 路由实现
□ Task 1.9  UI 页面实现（Phase 1）
□ Task 1.10 Settings 页面实现

集成测试：
□ pd-console 可独立运行
□ 多工作区功能验证
□ 认证功能验证
□ UI 功能测试覆盖
```

---

## Phase 2：Samples 审核功能

**目标**：实现 Sample 审核队列

| 任务 | 预估时间 | 依赖 |
|------|---------|------|
| 2.1 评估 Sample 数据来源 | 1d | - |
| 2.2 设计 SampleConsoleModel | 1d | 2.1 |
| 2.3 实现 Samples API 路由 | 1d | 2.2 |
| 2.4 实现 Samples UI 页面 | 2d | 2.3 |

**里程碑检查**：
- [ ] Samples 列表展示
- [ ] Sample 详情查看
- [ ] Sample 审核（批准/拒绝）

---

## Phase 3：Evolution 追踪功能

**目标**：实现 Evolution 任务/事件追踪

| 任务 | 预估时间 | 依赖 |
|------|---------|------|
| 3.1 评估 Evolution 数据来源 | 2d | - |
| 3.2 设计 EvolutionConsoleModel | 1d | 3.1 |
| 3.3 实现 Evolution API 路由 | 2d | 3.2 |
| 3.4 实现 Evolution UI 页面 | 3d | 3.3 |

**里程碑检查**：
- [ ] Evolution 任务列表
- [ ] Evolution 事件查看
- [ ] Evolution 追踪视图

---

## Phase 4：Thinking Models 功能

**目标**：实现 Thinking Models 管理

| 任务 | 预估时间 | 依赖 |
|------|---------|------|
| 4.1 评估 Thinking Model 数据来源 | 2d | - |
| 4.2 设计 ThinkingConsoleModel | 1d | 4.1 |
| 4.3 实现 Thinking API 路由 | 2d | 4.2 |
| 4.4 实现 Thinking UI 页面 | 3d | 4.3 |

**里程碑检查**：
- [ ] Thinking Models 列表
- [ ] Thinking Model 详情
- [ ] 场景矩阵展示

---

## Phase 5：清理与优化

| 任务 | 预估时间 | 依赖 |
|------|---------|------|
| 5.1 移除 openclaw-plugin 旧 UI | 1d | Phase 1-4 |
| 5.2 更新文档和 README | 1d | - |
| 5.3 完善测试 | 2d | - |

**移除清单**：
- `packages/openclaw-plugin/ui/` - 整个 UI 目录
- `packages/openclaw-plugin/src/http/principles-console-route.ts` - 路由定义
- 相关构建配置

---

## 时间线总览

```
Week 1: Task 1.1 - 1.3 (基础设施)
Week 2: Task 1.4 - 1.7 (Console Models)
Week 3: Task 1.8 (API Routes)
Week 4: Task 1.9 - 1.10 (UI)
Week 5: Phase 2 (Samples)
Week 6-7: Phase 3 (Evolution)
Week 8-9: Phase 4 (Thinking)
Week 10: Phase 5 (Cleanup)
```

---

## 资源估算

| 角色 | 工作量 |
|------|--------|
| 开发 | ~25 人天 |
| 测试 | ~5 人天 |
| 代码审查 | ~3 人天 |
| **总计** | ~33 人天 |

---

## 风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| Phase 2-4 数据来源评估发现需要新增 runtime-v2 功能 | 中 | 高 | Phase 1 后期开始评估，减少影响范围 |
| 多工作区性能问题 | 中 | 中 | 添加缓存和异步加载 |
| UI 设计与旧版本差异 | 低 | 中 | 参考旧 UI 保持一致性 |

---

## 下一步行动

1. 评审本计划
2. 确认 Task 1.1-1.10 的优先级和分工
3. 开始 Task 1.1：项目结构重构
