# 共享实施约束（所有 Console 重做工单必读）

> 本文件是防风格漂移、防功能错乱的**唯一事实源**。每个 PRI-CR* 工单都引用它。
> 如果工单描述与本文件冲突，以本文件为准；如果本文件与 `PD_BRAND_CONSTITUTION.md`
> 冲突，以品牌宪章为准。

---

## A. 技术栈与工程规范

### A.1 技术栈决策

包：`packages/pd-console`。前端在 `src/ui`，后端在 `src/server`。

**沿用（不升级、不替换）**：

| 依赖 | 版本 | 用途 | 重做动作 |
|------|------|------|----------|
| React | ^19.2.6 | UI 框架 | 无 |
| react-dom | ^19.2.6 | DOM 渲染 | 无 |
| react-router-dom | ^7.15.0 | 路由（HashRouter） | CR2 重写路由表 |
| tailwindcss | ^4.3.0 | 样式（CSS-first `@theme`） | CR1 替换 token |
| @radix-ui/* | 各 | shadcn/ui 底层 | CR1 重写组件样式 |
| class-variance-authority | ^0.7.1 | 组件变体 | 无 |
| clsx | ^2.1.1 | 类名合并 | 无 |
| tailwind-merge | ^3.6.0 | Tailwind 类去重 | 无 |
| react-i18next | ^17.0.7 | 国际化 | CR10 重写文案 |
| i18next | ^26.1.0 | i18n 核心 | 无 |
| sonner | ^2.0.7 | Toast 通知 | J.2 扩展撤销链接 |
| lucide-react | ^1.14.0 | 图标 | 无 |
| better-sqlite3 | ^12.9.0 | 服务端 SQLite | 无 |
| vitest | ^4.1.5 | 测试框架 | 无 |

**唯一新增**：

| 依赖 | 用途 | 安装方式 |
|------|------|----------|
| `@fontsource/jetbrains-mono` | Blueprint 等宽字体自托管 | `npm install @fontsource/jetbrains-mono` |

**禁止引入**：
- 新 UI 框架（Chakra/MUI/Ant Design 等）— shadcn/ui 可完全重定制
- 状态管理库（Zustand/Redux/Jotai）— React 19 context + useState 足够
- CSS-in-JS（styled-components/emotion）— Tailwind 4 已满足
- 新路由方案 — HashRouter 保持（自托管应用无需 SSR 路由）
- 图表库 — 治理页不做信息大屏，简单进度条和数字足够

**TypeScript strict，禁止 `any`**，未知数据用 `unknown` + 运行时校验（见 H 节）。

### A.2 主题系统

**从 class 切换到 data-attribute**：当前 `theme-provider.tsx` 使用
`classList.add('dark')` / `classList.remove('dark')`。重做后必须切换为
`[data-theme="dark"]` 属性选择器（与 B.1.1 token 定义一致）：

```typescript
// 旧：document.documentElement.classList.toggle('dark', isDark)
// 新：document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
```

偏好持久化到 `localStorage('pd-theme')`，初始值读取 `localStorage`，无值时跟随
`prefers-color-scheme`。

### A.3 前端目录结构

重做后 `src/ui/` 的目标结构（CR2 建骨架，CR3–CR9 逐页填充）：

```
src/ui/
  App.tsx                        # 路由 + 认证 + Provider（CR2 重写路由表）
  api.ts                         # API 客户端（CR2 大幅清理，见 A.5）
  main.tsx                       # 入口（不变）

  components/
    ui/                          # 基础 UI 组件（CR1 重样式为 Blueprint）
      alert-dialog.tsx           # 保留
      badge.tsx                  # 保留
      button.tsx                 # 保留
      card.tsx                   # 保留
      dialog.tsx                 # 保留
      input.tsx                  # 保留
      select.tsx                 # 保留
      separator.tsx              # 保留
      sheet.tsx                  # 保留
      skeleton.tsx               # 保留
      sonner.tsx                 # 保留
      tooltip.tsx                # 保留
      markdown.tsx               # 保留
      progress-bar.tsx           # 保留
      confirmation-bar.tsx       # ★ 新增：内联确认条（J.1）
      undo-toast.tsx             # ★ 新增：带撤销链接的 Toast（J.2）
      # charts.tsx               # 删除（废弃页专用）

    layout/                      # ★ 新增目录：布局组件
      app-sidebar.tsx            # 从根目录移入，重写为 Blueprint 侧边栏
      page-shell.tsx             # ★ 新增：712px 居中容器 + 蓝图网格背景
      section-title.tsx          # ★ 新增：11px 大写等宽节标题（B.4.6）
      governance-header.tsx      # ★ 新增：三层信息结构的第一层容器

    governance/                  # ★ 新增目录：治理页共享组件
      principle-card.tsx         # ★ 原则卡片（审查/债务页共用）
      evidence-panel.tsx         # ★ 证据面板（三层结构第二/三层）
      lifecycle-indicator.tsx    # ★ lifecycle 指标展示（仅第三层）
      channel-badge.tsx          # ★ 通道标签（prompt/defer_archive/code_tool_hook）
      status-label.tsx           # ★ Blueprint 状态标签（2px 圆角等宽，B.4.5）
      adherence-signal.tsx       # ★ adherence 率展示（诚实约束 F.1）

    auth/                        # ★ 新增目录：认证相关
      login-form.tsx             # 从 LoginPage 拆出，重写为 Blueprint 登录
      splash-screen.tsx          # ★ 新增：启动页组件（C.0）

    # 以下旧组件 CR2 删除：
    # UpdateBanner.tsx, UpdateProgressDialog.tsx,
    # approval-card.tsx, approval-detail-dialog.tsx,
    # compare-view.tsx, data-freshness-indicator.tsx,
    # health-diagnostic-card.tsx, page-header.tsx,
    # rejection-reason-dialog.tsx

  hooks/
    useAutoRefresh.ts            # 保留
    useDebounce.ts               # 保留
    useKeyboardShortcuts.ts      # ★ 新增：Alt+1~0 快捷键（J.3）
    useUndoAction.ts             # ★ 新增：5 秒撤销窗口（J.2）
    # useBookmarks.ts            # CR2 删除
    # useKeyboardNavigation.ts   # CR2 删除（被 useKeyboardShortcuts 替代）

  pages/
    focus/                       # ★ 治理焦点（首页）
      FocusPage.tsx
    pain/                        # ★ 行为证据
      PainPage.tsx
    principles/                  # ★ 原则审查
      PrinciplesPage.tsx
      PrincipleDetailPage.tsx
    activation/                  # ★ 生效情况
      ActivationPage.tsx
    debt/                        # ★ 原则债务
      DebtPage.tsx
    control-center/              # 工具页
      ControlCenterPage.tsx
    settings/
      SettingsPage.tsx
      UpdatePage.tsx
    report-problem/
      ReportProblemPage.tsx
    # 以下旧页面 CR2 删除：
    # AgentsPage.tsx, ApprovalsPage.tsx, CentralPage.tsx,
    # DataFlowPage.tsx, EventLogPage.tsx, EvolutionPage.tsx,
    # FeedbackPage.tsx, GatesPage.tsx, OverviewPage.tsx,
    # SamplesPage.tsx, TasksPage.tsx, ThinkingModelsPage.tsx

  i18n/
    en.json                      # CR10 重写
    zh-CN.json                   # CR10 重写
    index.ts                     # 保留

  styles/
    globals.css                  # CR1 重写 token

  utils/
    format.ts                    # 保留
    navigation.ts                # CR2 重写（新路由）
    validators.ts                # ★ 新增：运行时类型校验工具（H 节）
    control-center-helpers.ts    # 保留
```

### A.4 服务端目录变化

```
src/server/
  routes/
    # 保留（可能按 CR8 调整返回结构）：
    approvals.ts, principles.ts, config.ts, state.ts,
    update.ts, update-history.ts, feedback-reports.ts, workspaces.ts

    # ★ CR8 新增：
    lifecycle.ts                 # MVP6 lifecycle 指标路由
    activations.ts               # ★ CR8 新增：全通道激活记录路由
    governance.ts                # ★ CR8 新增：治理队列聚合路由

    # CR2 删除（对应废弃页面）：
    # agents.ts, central.ts, events.ts, evolution.ts,
    # feedback.ts, gates.ts, overview.ts,
    # pipeline.ts, samples.ts, thinking-models.ts
    # 注意：health.ts 保留（checkAuth 和控制中心配置就绪依赖它）

  models/
    # 保留：
    ApprovalsConsoleModel.ts, PrinciplesConsoleModel.ts,
    FeedbackReportConsoleModel.ts, HealthCheckModel.ts, WorkspaceService.ts

    # ★ CR8 新增：
    LifecycleConsoleModel.ts     # 桥接 LifecycleDatasource

    # CR2 删除：
    # EventLogReadModel.ts, EvolutionConsoleModel.ts,
    # FeedbackConsoleModel.ts, GateConsoleModel.ts,
    # OverviewConsoleModel.ts,
    # PipelineStatsModel.ts, SampleConsoleModel.ts,
    # ThinkingModelsConsoleModel.ts
    # 注意：HealthCheckModel.ts 保留（控制中心配置就绪依赖）
```

**硬规则**：不修改 `src/server` 的数据访问层（SqliteConnection、store）。只允许按工单
调整 **Model 返回结构**和**新增/删除 route**。

### A.5 api.ts 清理计划

当前 `src/ui/api.ts` 约 900 行，包含大量废弃接口和函数。CR2 必须清理：

**删除的接口**（对应废弃页面/路由）：
`OverviewData`, `OverviewHealth`, `GateStats`, `FeedbackGfi`, `EmpathyEvent`,
`GateBlockItem`, `CentralOverview`, `CentralHealth`, `SampleListItem`,
`SampleDetail`, `SamplesData`, `EvolutionStats`, `EvolutionTaskItem`,
`EvolutionTasksData`, `EvolutionPrinciplesData`, `QueueHealthData`,
`ThinkingModelOverview`, `PipelineTimestamps`,
`SystemHealthStatus`, `PipelineStage`, `Bottleneck`, `PipelineStats`,
`EventLogEntry`, `EventsResponse`, `RelatedEventsResponse`, `AgentInfo`,
`AgentDetail`
注意：`HealthCheckItem` 保留（控制中心配置就绪依赖）

**删除的函数**（对应废弃路由）：
`fetchOverview`, `fetchOverviewHealth`, `fetchGateStats`, `fetchGateBlocks`,
`fetchFeedbackGfi`, `fetchEmpathyEvents`, `fetchFeedbackGateBlocks`,
`fetchCentralOverview`, `fetchCentralHealth`, `fetchSamples`,
`fetchSampleDetail`, `reviewSample`, `fetchEvolutionStats`,
`fetchEvolutionTasks`, `fetchEvolutionPrinciples`, `fetchEvolutionQueue`,
`fetchThinkingModels`, `fetchPipelineStats`,
`fetchEvents`, `fetchEventsGrouped`, `fetchRelatedEvents`, `fetchAgents`,
`fetchAgentDetail`, `fetchTasks`, `fetchTaskEvidence`, `approveTask`,
`rejectTask`, `cleanupTask`, `fetchStatus`, `fetchActivity`
注意：`fetchSystemHealth` 重命名为 `fetchConfigReadiness`（CR2），仅保留配置就绪
数据源功能，删除全局健康红点展示路径。`checkAuth` 保留不变。

**保留的接口和函数**：
`getToken`, `setToken`, `clearToken`, `checkAuth`, `request`,
`fetchApprovals`, `fetchApprovalDetail`, `approveApproval`, `rejectApproval`,
`fetchPrinciples`, `fetchPrincipleDetail`,
`createFeedbackReport`, `listFeedbackReports`, `getFeedbackReport`, `deleteFeedbackReport`,
`fetchConfigSummary`, `fetchConfigCatalog`, `updateAgentBinding`,
`checkAgentReadiness`, `updateDefaultRuntime`,
`fetchWorkspaces`, `addWorkspace`, `removeWorkspace`, `syncWorkspace`,
`fetchConfigReadiness`（由 `fetchSystemHealth` 重命名，仅保留配置就绪功能）

**CR8 新增**：
`fetchLifecycleMetrics`, `fetchAllActivations`, `fetchGovernanceQueue`,
`fetchApprovalsGrouped` 等新 API 函数

**CR10 类型安全清理**：当前 `api.ts` 有多处 `as` 类型断言（第 162、169、181、185 行）
违反 H 节。CR10 必须用运行时校验替换所有 `as`，新增 `validators.ts` 提供复用的
类型守卫函数。

清理后 `api.ts` 预计 ~300 行。

### A.6 服务端 index.ts 路由清理

当前 `src/server/index.ts` 约 870 行，路由注册是手动 if-else 链。CR2 需删除：

**删除的 import**：`handleOverviewRoute`, `disposeOverviewModels`,
`handleGatesRoute`, `disposeGateModels`, `handleFeedbackRoute`,
`disposeFeedbackModels`, `handleSamplesRoute`, `disposeSampleModels`,
`handleEvolutionRoute`, `disposeEvolutionModels`,
`handleThinkingModelsRoute`, `disposeThinkingModels`, `handlePipelineRoute`,
`disposePipelineModels`, `handleEventsRoute`, `disposeEventsModels`,
`handleAgentsRoute`, `disposeAgentModels`, `createCentralRoutes`
注意：`handleHealthRoute` / `disposeHealthModels` 保留（checkAuth 和控制中心依赖）

**删除的路由 if 块**：`/api/overview`, `/api/gate`, `/api/feedback`（旧 GFI 通道）,
`/api/samples`, `/api/evolution`, `/api/thinking-models`, `/api/central`,
`/api/agents`, `/api/pipeline`, `/api/events`,
`/api/status`, `/api/tasks`, `/api/activity`
注意：`/api/health` 保留（checkAuth 和控制中心配置就绪依赖）

**删除的 dispose 调用**：`disposeOverviewModels()`, `disposeGateModels()`,
`disposeFeedbackModels()`, `disposeSampleModels()`, `disposeEvolutionModels()`,
`disposeThinkingModels()`, `disposePipelineModels()`,
`disposeEventsModels()`, `disposeAgentModels()`
注意：`disposeHealthModels()` 保留

**保留的路由**：`/api/health`, `/api/v1/approvals`, `/api/principles`, `/api/v1/config`,
`/api/v1/state`, `/api/update`, `/api/update/history`, `/api/feedback/reports`,
`/api/workspaces`

**CR8 新增路由**：
- `GET /api/v1/lifecycle/principles/:principleId` — lifecycle 指标
- `GET /api/v1/activations` — 全通道激活记录
- `GET /api/v1/governance/queue` — 治理队列聚合（首页消费）
- `GET /api/v1/approvals/grouped` — 按原则分组的审批记录

清理后 `index.ts` 预计 ~500 行。

### A.7 i18n key 清理策略

- **CR2**：删除明确废弃的 key 前缀：`overview.*`, `gates.*`, `evolution.*`,
  `agents.*`, `central.*`, `dataFlow.*`, `eventLog.*`, `thinkingModels.*`,
  `samples.*`, `feedback.*`（旧 GFI 通道，非 feedback-reports）。
- **CR3–CR9**：各工单添加新页面对应的 i18n key，同时删除被替换的旧 key
  （如 `pain.*` 重写、`approvals.*` 合并到 `principles.*`）。
- **CR10**：最终对齐，确保 en.json 和 zh-CN.json 零废弃 key、零缺失 key。

### A.8 旧代码处理策略：直接替换，不保留双套

**核心原则：CR2 是删除门，之后只有新代码。**

1. **CR2 开一个 `feature/console-rebuild` 分支**。
2. **CR2 做的事**：
   - 删除 12 个废弃页面文件
   - 删除 11 个废弃服务端路由
   - 删除 9 个废弃 Model
   - 删除 9 个废弃业务组件
   - 清理 `api.ts`（从 ~900 行砍到 ~300 行）
   - 清理 `App.tsx` 路由表（从 21 条路由砍到 9 条新路由 + 占位页）
   - 重构认证 flow：Router 始终渲染，`/splash` → auth check → `/login` or `/focus`
   - 清理 `server/index.ts` 路由注册（删除对应 if 块）
   - 创建 9 个业务占位页面 + splash/login 组件 + dev-only design-system 路由
   - 将 `fetchSystemHealth` 重命名为 `fetchConfigReadiness`，删除全局红点展示路径
   - 删除废弃 i18n key
3. **CR3–CR9**：逐个填充真实页面
4. **CR10**：i18n 清理 + 整体验收
5. **全部通过后**：由 Owner 手动合并到 main

**为什么不用 feature flag 切换新旧 UI**：
- 两套 UI 共存 = 两套组件 + 两套路由 + 两套 i18n = 混乱的源头
- PD Console 是自托管工具，不是 SaaS，不需要灰度发布
- 一个分支搞定，合并时就是完整切换

**文件重写策略**：
- 同名页面（如 `PainPage.tsx`）直接重写内容，保留文件名，git history 可追踪演变
- 需要改名的才删旧建新（如 `ApprovalsPage.tsx` 删除，新建 `PrinciplesPage.tsx`）
- 页面按 IA 分目录（`pages/focus/`、`pages/pain/` 等），不再扁平

### A.9 分支与合并策略

```
main ────────────────────────────────────────── merge ──→
  └── feature/console-rebuild ──────────────────────────→
        CR1 → CR2 → CR3 → ... → CR10 (验收通过)
```

- 单分支 `feature/console-rebuild`，所有 CR 在此分支上依次完成
- 每个 CR 可以是一个或多个 commit（conventional commits）
- CR10 验收通过后，由 Owner 手动合并到 main（禁止 AI 自动合并）
- 合并前跑 `cd packages/pd-console && npm run build && npm run test && npm run lint`
- 合并前跑 `npm run verify:merge`（如可用）

### A.9.1 分支命名规则

| 场景 | 分支名 | 示例 |
|------|--------|------|
| 主重构分支 | `feature/console-rebuild` | — |
| 单个 CR 的子分支 | `feature/console-rebuild-cr<N>` | `feature/console-rebuild-cr1` |
| 紧急修复 | `fix/console-rebuild-<desc>` | `fix/console-rebuild-dark-mode-contrast` |

**规则**：
- 所有 console 重做相关代码**必须**从 `feature/console-rebuild` 分出，不得直接在 `main` 上开发
- 子分支完成后合并回 `feature/console-rebuild`（不是 `main`），用 squash merge 保持历史清晰
- 禁止在 `main` 上直接 commit 任何 `packages/pd-console/` 下的文件

### A.9.2 PR 规则

1. **每个 CR 开一个 PR**，目标分支为 `feature/console-rebuild`（不是 `main`）
2. **PR 标题格式**：`feat(console): CR<N> — <简要描述>`，如 `feat(console): CR1 — design tokens + base components`
3. **PR 描述必须包含**：
   - 对应的 Linear 工单链接
   - 满足了哪些 F 节诚实约束
   - 考虑了哪些 ERR 条目
   - 跑了哪些测试命令及结果
   - 视觉对比截图（如有 UI 变更）
4. **PR 审查**：
   - 每个 PR 至少需要一次 self-review（对照 I 节 DoD 逐条检查）
   - AI 可以创建 PR 和推送代码，但**禁止 AI 合并 PR**
   - 合并由 Owner 手动执行
5. **最终合并**：CR10 验收通过后，Owner 将 `feature/console-rebuild` 合并到 `main`
6. **禁止 force push**：任何情况下不得对 `feature/console-rebuild` 或 `main` 执行 `--force`

### A.10 构建管线

当前构建流程不需要改动：

```bash
npm run build:ui    # esbuild 打包前端到 dist/web/
npm run build       # build:ui + tsc 编译服务端
npm run dev         # tsx 启动开发服务器 (port 3100)
```

**注意**：`@fontsource/jetbrains-mono` 安装后需在 `main.tsx` 或 `globals.css` 中
import，确保 esbuild 打包进 bundle。`design-prototype/` 目录的 HTML 原型不参与构建，
不应被打包进 `dist/`。

### A.11 API 向后兼容

PD Console 的 API 只被前端消费，没有外部消费者。但 `pd-cli` 可能调用部分 API。
CR2 开工前需运行以下命令确认 pd-cli 是否依赖任何将被删除的路由：

```bash
rg "/api/(health|tasks|status|activity|overview|gate|feedback|events|pipeline)" packages/pd-cli packages -g "*.ts"
```

如果发现依赖，需要在 CR2 中保留该路由或协调 CLI 修改，并在 PR 描述中列出结果。

### A.12 测试策略

- CR2 删除废弃页面/路由时，同步删除对应的测试文件
- 每个 CR 工单在实现时写对应测试
- CR8 新增的 lifecycle/activations/governance 路由需要新测试
- 服务端路由删除后，对应的集成测试也要删除
- 每个 CR 的 DoD 包含 `npm run build && npm run test && npm run lint` 通过
- **视觉回归 smoke**：CR1 完成后，至少在 light/dark 两个模式下对 `/design-system`
  和 `/focus` 做 DOM style assertion 或 Playwright screenshot 对比，防止 token
  替换破坏后续页面
- **暗色模式对比度审计**：CR10 验收时，至少检查正文（`--ink` on `--paper`）、
  弱化文本（`--ink-4` on `--paper`）、按钮（`--gov` on `--surface`）、
  标签（`--ink-4` on `--surface`）在 light/dark 两个模式下的对比度

---

## B. Design Tokens（唯一配色与尺度来源）

落地时写入 `src/ui/styles/globals.css` 的 `@theme`，替换现有偏亮的 SaaS 蓝。
原型 `design-prototype/index.html` 顶部 `:root` 是这套 token 的参考实现。

**设计方向：Warm Paper + Blueprint 网格** — 暖纸底色 + 蓝图网格 + 低饱和治理蓝。
气质：安静的技术工作台，温暖但不随意，精密但不冰冷。

### B.1 颜色（HSL/HEX 二选一，全项目统一，禁止页面内自定义色值）

| Token | 值 | 用途 |
|-------|-----|------|
| `--paper` | `#f7f3ea` | 页面背景（暖纸底色） |
| `--paper-2` | `#f2ede3` | 页面边缘 / 次级背景 |
| `--surface` | `#fbf8f0` | 卡片表面 |
| `--panel` | `#fffdf7` | 面板 / 弹出层 |
| `--ink` | `#1f2933` | 主文字 |
| `--ink-2` | `#384150` | 次文字 |
| `--ink-3` | `#525966` | 正文辅助 |
| `--ink-4` | `#5F6774` | 弱化/标签（WCAG AA 对比度 ≥ 4.5:1） |
| `--line` | `#d7d1c4` | 主边框/分割线 |
| `--line-2` | `#c7bfaf` | 次边框 |
| `--gov` | `#1e3a5f` | **唯一主色** 治理蓝 |
| `--gov-2` | `#2f557f` | 主色按压态 |
| `--amber` | `#a66a2a` | 需要注意（非告警） |
| `--green` | `#4d6b52` | 状态稳定 |
| `--danger` | `#8b3a3a` | **仅真实风险**（如拒绝/不可逆），不用于制造紧张 |

**硬规则**：
- 每个画面**主色只用 `--gov` 一种**，强调色最多一种。
- **禁止**：霓虹、蓝紫渐变、高饱和色、红点告警墙、彩色指标块、`--danger` 当装饰。
- **亮色/暗色双模式**：所有页面必须支持亮色（light）和暗色（dark）两种主题，可切换。
  切换按钮位于侧边栏底部工具区上方。偏好持久化到 `localStorage('pd-theme')`。

### B.1.1 暗色模式 Token（`[data-theme="dark"]`）

暗色模式遵循同样的低饱和原则，但主色 `--gov` 提亮以保证在深色背景上的可读性。
所有 token 通过 `[data-theme="dark"]` 选择器覆盖，不需要额外的 CSS 类。

| Token | 暗色值 | 说明 |
|-------|--------|------|
| `--paper` | `#151a20` | 深色页面背景 |
| `--paper-2` | `#1b222a` | 深色次级背景 |
| `--surface` | `#202832` | 深色卡片表面 |
| `--panel` | `#242d38` | 深色面板 |
| `--ink` | `#f1eee6` | 深色主文字 |
| `--ink-2` | `#d3cec3` | 深色次文字 |
| `--ink-3` | `#b0b8c5` | 深色正文辅助 |
| `--ink-4` | `#7C8494` | 深色弱化（WCAG AA 对比度 ≥ 4.5:1） |
| `--line` | `#38414d` | 深色主边框 |
| `--line-2` | `#4b5563` | 深色次边框 |
| `--gov` | `#9db9d8` | 深色主色（提亮以保证对比度） |
| `--gov-2` | `#c2d6ed` | 深色主色按压态 |
| `--amber` | `#d4a15d` | 深色需要注意 |
| `--green` | `#90b892` | 深色状态稳定 |
| `--danger` | `#d28b8b` | 深色真实风险 |
| `--shadow` | `none` | 深色默认无阴影 |

**暗色模式硬规则**：
- `--gov` 从 `#1e3a5f` 提亮为 `#9db9d8`，确保在 `#151a20` 背景上对比度 ≥ 4.5:1。
- 蓝图网格背景在暗色模式下使用 `color-mix(in srgb, var(--gov) 3.5%, transparent)`，
  保持可见但不刺眼。
- 侧边栏在暗色模式下使用 `--surface`（`#202832`），与主内容区形成层次。
- 品牌 mark SVG 在暗色模式下自动适配（`stroke:var(--gov)` 跟随 token 变化）。
- 切换按钮显示太阳图标（亮色模式）或月亮图标（暗色模式）。

### B.2 间距 / 圆角 / 阴影 / 动效

- 间距走 **8px 系统**（4/8/12/16/20/24/32/44/60…）。正文容器最大宽 **712px**，
  居中，左右留白充足（这是"慢思考"的物理实现，不要做满屏宽）。
- 圆角：`--r-sm:3px / --r:4px / --r-lg:8px`（锐角几何）。
- 阴影：`--shadow: 0 18px 48px rgba(31, 41, 51, .08)`。卡片默认有阴影，
  暗色模式 `--shadow: none`。
- 动效：缓动统一 `cubic-bezier(.4,0,.2,1)`；过渡 120–180ms；**必须**包 `@media
  (prefers-reduced-motion: reduce)` 关闭动效。禁止高频动画、粒子、发光、脉冲。
- **焦点样式**：所有可交互元素**必须**有 `:focus-visible` 样式（`outline: 2px solid
  var(--gov); outline-offset: 2px`），不得移除默认 focus ring。

### B.3 字体

- 字体栈：`--sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`。
- 等宽字体栈：`--mono: "SFMono-Regular", "Cascadia Mono", "JetBrains Mono", Consolas, monospace`。
  **标签、元数据、时间戳、状态码**使用 `var(--mono)` 12px。
- 字号阶梯（光学）：页标题 29 / 卡标题 17 / 区标题 13 / 正文 15 / 卡正文 14 /
  辅助 13 / eyebrow·标签 11。
- 大标题用负字距（`-.015em`），正文几乎不收。**所有数字用 `tabular-nums`**。

### B.4 视觉特征（Warm Paper + Blueprint 网格）

以下特征是 Warm Paper 方向的标志性差异，开发时必须遵守：

1. **蓝图网格背景**：`body` 使用 32px 方格网格（`linear-gradient`），
   线色 `color-mix(in srgb, var(--gov) 3.5%, transparent)`，营造技术图纸感。
2. **侧边栏**：`var(--surface)` 背景，1px `var(--line)` 右边框。
   Active 项：`var(--gov)` 左边框 + 背景加深。无圆角背景。
3. **品牌 mark**：门形 SVG，`var(--gov)` 描边，`fill: none`，1.5px stroke，
   外框 `rx="4"` + 描边而非填充。24×24 尺寸。
4. **卡片**：有阴影（`var(--shadow)`），hover 时阴影加深 + 边框色加深。
   无 transform（无 translateY/scale）。
5. **标签**：`border-radius: 2px`，`font-family: var(--mono)`，`font-size: 11px`，
   `letter-spacing: .02em`。方角等宽，像状态码。
6. **节标题**：11px 大写等宽字，`letter-spacing: .1em`，`color: var(--ink-3)`，
   底部 1px `var(--line)` 分割线。
7. **按钮**：`border-radius: var(--r-sm)` (3px)，`font-size: 12.5px`，`padding: 6px 14px`。
   紧凑风格。

---

## C. 信息架构（IA）—— 不可偏离

### C.0 应用入口流程（启动页 → 登录页 → 工作台）

1. **启动页**（`/splash`）：1-2 秒加载过渡页。全屏居中展示门形 mark + "PD" +
   "GOVERNANCE WORKSPACE" + 进度条。动画序列：mark 淡入 → 文字淡入 → 进度条填充 →
   整体淡出 → 跳转登录页。这是"慢思考"的物理仪式，不是装饰。
2. **登录页**（`/login`）：全屏居中卡片，门形 mark + Bearer Token 输入框 +
   "进入工作台"按钮。未认证不可进入工作台。首次使用引导在此建立心智。
3. **工作台**：认证成功后跳转治理焦点页。

### C.1 两层导航（option 甲：5 个治理页平级 + 工具页弱化）

**主导航（治理，视觉重心，恰好 5 项，顺序固定）**：
1. 治理焦点 Governance Focus（首页，路由 `/` 或 `/focus`）
2. 行为证据 Pain Evidence（`/pain`）
3. 原则审查 Principle Review（`/principles`，吸收原 Approvals）
4. 生效情况 Activation（`/activation`，原 Behavior Change 重定义）
5. 原则债务 Principle Debt（`/debt`）

**次级工具区（弱化，footer/角落）**：控制中心 `/control-center`、产品反馈
`/report-problem`、设置 `/settings`、更新 `/update`（独立路由，不在 /settings 下）。

**删除**（页面 + 对应后端 route）：Overview、Data Flow、Event Log、Evolution、
Central、Agents、Tasks、Samples、Thinking Models、Trust/GFI Monitor（`/feedback`
+ `/gates`），以及侧边栏全局 health 告警红点（`fetchSystemHealth` + `alertCount`）。

每个页面**只服务一个治理判断**，不得做成信息大屏。

---

## D. 三层信息结构（每个治理页都遵守，品牌宪章 §3.2）

1. **第一层 结论**：一句话说明当前要做什么判断（大字、克制）。
2. **第二层 为什么**：证据摘要、来源、适用/不适用场景、副作用。默认可见但收敛。
3. **第三层 完整轨迹**：trajectory / pain evidence / 原则历史，**默认折叠**，
   `<details>` 或等价交互按需展开。

**禁止**：一进页面就铺所有日志/字段/指标/历史。

---

## E. 文案规则（治理化语气，中英双语都遵守）

- 语气：冷静、准确、克制、尊重拥有者，不夸张、不神化 AI。
- **必须用**的动词：批准 / 修改 / 拒绝 / 暂存 / 回滚 / 归档 / 查看证据 / 对比行为。
- **禁止词**：自动优化 / 一键进化 / 永不犯错 / 彻底解决 / 智能修复 / AI 替你决定 /
  Burn pain / drive evolution / Optimize / Auto Fix / Evolve。
- 状态标签（低饱和）：草稿 / 待审查 / 已批准 / 已激活 / 已观察 / 需调整 / 已回滚 /
  已归档 / 行为偏差（注意：不使用"反复出现"标签，因为语义匹配为 MVP5，见 F.2）。
- 标签措辞规则：标签只描述当前状态，不暗示系统尚未实现的聚合能力。"反复出现"
  改为"行为偏差"（中性，不暗示聚合）。
- 空状态**不写**"暂无数据"，要引导下一步。示例：
  「还没有可审查原则。当 PD 捕获到行为偏差信号时，会在这里生成原则候选，等待你审查。」
- 错误提示冷静，不制造恐慌。示例：
  「无法加载这条原则的证据来源。原则本身未受影响。你可以稍后重试，或暂时保留在待审查状态。」

### E.1 中英混排规则

中文原型和中文 i18n 文案中，**禁止**将英文术语直接混入中文句子。替换规则：

| 英文术语 | 中文替换 | 保留条件 |
|----------|----------|----------|
| Owner | 拥有者 | — |
| Agent | 智能体 | — |
| Prompt | 提示词 | — |
| Console | 控制台 | — |

**可保留的英文**（产品名/组件名/技术术语）：
- PD、RuleHost、OpenClaw、Defer Archive — 产品/组件名
- Console API — 技术术语（API 后缀保留英文）
- Code Tool Hook — 技术术语
- Bearer Token — 技术术语

**原则**：要么做纯英文版，要么中文版里尽量用中文。PD/RuleHost/OpenClaw 这类产品/组件名可保留。

### E.2 样例原则规则

**禁止**使用"confirm-first / 变更前确认需求"作为默认样例原则。原因：
- 我们刚从源码里移除了内置 confirm-first/PLAN gate
- 用它当默认样例容易误导实现者重新把它做成产品默认行为

**替代样例**：使用更中性的种子用户场景，如：
- "修改配置前展示影响范围"
- "完成任务前说明验证结果"
- "删除操作前确认影响对象"

---

## F. 诚实约束（最高优先级，违反即不可合并）

PD 的信任来自诚实。以下为硬性红线：

1. **不造假行为变化**：生效情况页第一层只展示"激活事实"（激活/未激活、通道、
   动作、时间）。`adherenceRate` 等合成分仅作可展开的第三层证据，且**仅当原则有
   rule 时显示**，并标注"规则质量信号，不等于行为变化"。绝不当主指标。
2. **不造假聚合**："反复出现/相似任务"依赖语义匹配（MVP5，未实现）。一律**按单条
   呈现**；任何"第 N 次/相似任务里"必须省略或显式标注"自动同类识别为 post-MVP"。
   不放占位的假聚合卡。
3. **不造假健康面板**："PD 是否正常工作"只用并入治理焦点的**停滞信号**（如 N 天无
   pain、原则从未激活）表达，不做独立健康/诊断仪表盘，不做全局告警红点。
4. **通道如实**：原则审查页**显示**将走哪个通道（当前 MVP 实际只有 prompt 档）、
   强度、可回滚，但**不放** Owner 选通道/选强度的控件（后端只有一档，假开关违反信任）。
5. **能力边界声明**：凡是后端暂不能提供的数据，用一句诚实声明说明，而不是用 UI 演。

---

## G. 运行时数据契约（已验证的后端事实，照此对接，不要臆测）

- **审批**：`approvals.ts` 仅有 `/approve`、`/reject`，**无 modify**。每条审批记录是
  `artifact + 单一 channel`；批准即 `auto_activate`。UI 把多条审批记录收拢为"对一条
  原则的单次决策"。modify 是 MVP3，本批不做（按钮可作禁用占位，须标注）。
- **激活**：`activations` 表提供 激活/未激活、channel、action、targetRef、
  `activatedAt`。现有 `listPromptActivations()` **仅返回 `channel='prompt'` 的记录**，
  不含 `defer_archive`/`code_tool_hook` 通道。CR8 需新增 `listAllActivations()` 或
  `listByChannel(channels)` 方法以获取全通道激活记录。**无触发/命中计数**（那是 MVP5）。
  激活记录带 `artifactId` 而非 `principleId`，需在 Model 层用
  `PIArtifactSnapshot.sourcePrincipleId` 做 join（属允许的数据契约调整，归 PRI-CR8）。
- **lifecycle 指标**：`lifecycle-metrics.ts` 的 `computePrincipleAdherence` /
  `computeRuleMetrics` 已实现但无 route 暴露（MVP6）。调用链为：
  `buildLifecycleReadModel(datasource)` → `LifecycleReadModel.principles` →
  `computePrincipleAdherence(principle)`。CR8 需在 console server 层实现
  `LifecycleDatasource` 接口（`loadLedger`/`listReplayReports`/`listLineageRecords`），
  将现有 `SqliteConnection` 数据桥接为 core 需要的纯数据结构。指标要求原则有 rule，
  prompt 通道原则通常为空 / `insufficientData`。
- **通道**：当前由 `ROUTE_CHANNEL_MAP` 死映射（`principle-ledger→prompt`、
  `rule-candidate→code_tool_hook`、`implementation-candidate→skill`、
  `prompt-injection-candidate→prompt`）。`defer_archive` 通道**不在** `ROUTE_CHANNEL_MAP`
  中——它通过 `defer` route 处理，不走标准映射。MVP 实际启用的 writer 为
  `prompt` 和 `defer_archive`（低风险通道），`code_tool_hook` 为高风险通道。

### G.1 CR8 新增端点契约

CR8 需新增以下 4 个端点，供 CR3/CR4/CR6/CR7 消费：

**`GET /api/v1/governance/queue`**（治理队列聚合，首页 CR3 消费）
```typescript
interface GovernanceQueueResponse {
  pendingReviewCount: number;      // 待审查原则数
  behaviorDeviationCount: number;  // 行为偏差信号数（不暗示聚合）
  stagnationSignals: Array<{       // 停滞信号
    type: 'no_pain' | 'never_activated';
    principleId: string;
    daysSince: number;
  }>;
}
```

**`GET /api/v1/approvals/grouped`**（按原则分组的审批记录，CR4 消费）
```typescript
interface ApprovalGroup {
  principleId: string;
  principleTitle: string;
  status: 'pending' | 'approved' | 'rejected';
  records: Array<{
    id: string;
    artifactId: string;
    channel: string;
    createdAt: string;
  }>;
}
```

**`GET /api/v1/activations`**（全通道激活记录，CR6/CR7 消费）
```typescript
interface ActivationRecord {
  id: string;
  artifactId: string;
  principleId: string;       // Model 层 join 得到
  channel: string;           // prompt | defer_archive | code_tool_hook
  action: string;
  targetRef: string;
  activatedAt: string | null;
  status: 'active' | 'inactive';
}
```

**`GET /api/v1/lifecycle/principles/:principleId`**（lifecycle 指标，CR4/CR6 第三层消费）
```typescript
interface LifecycleMetricsResponse {
  principleId: string;
  adherence: {
    insufficientData: boolean;  // true = 无 rule 或数据不足
    rate: number | null;        // null when insufficientData
    note: string;               // "规则质量信号，不等于行为变化"（F.1）
  };
  ruleMetrics: Array<{
    ruleId: string;
    triggered: number;
    lastTriggeredAt: string | null;
  }>;
}
```

### G.2 行为证据数据契约（CR5 消费）

行为证据复用 `principles.ts` 现有 pain 相关数据，最小 response shape：

```typescript
interface PainEvidence {
  id: string;
  title: string;                  // 行为偏差简述
  context: string;                // 发生场景
  agentBehavior: string;          // Agent 实际行为
  expectedBehavior?: string;      // 期望行为（如有）
  source: 'tool_call' | 'prompt'; // 信号来源
  recommendationState: 'pending' | 'candidate' | 'principle' | 'dismissed';
  trajectorySummary: {
    taskId: string;
    toolName: string;
    timestamp: string;
  };
  createdAt: string;
}
```

---

## H. 运行时安全规则（前端解析后端数据时强制，对应 Error Handbook）

后端返回经网络来的 JSON 一律视为 `unknown`：
1. 不用 `as` 绕过校验；用 `typeof` / `Array.isArray` / 类型守卫（ERR-001/005）。
2. 必填字段缺失/格式错要**失败响亮**（显式错误或诚实降级），不要 `if(valid){...}` 跳过
   （ERR-009/010）。
3. 数组元素逐个校验类型（ERR-005/007）。
4. 取不可信对象的键用 `Object.hasOwn`，不用 `in`（ERR-013）。
5. 预览/序列化用安全有界方式，不对 unknown 直接 `JSON.stringify`（ERR-014/016/017）。
6. 降级必须带原因（结构化错误 / 提示 / 日志），禁止静默回退（ERR-002）。

参考现有 `src/ui/pages/ReportProblemValidators.ts` 的解析风格作为范例。

---

## I. 每个工单的完成定义（DoD）

- [ ] 视觉严格用 B 节 token，无自定义色值、无风格漂移（对照原型截图）。
- [ ] IA / 文案 / 三层结构 / 诚实约束（C/D/E/F）全部满足。
- [ ] 数据对接符合 G 节事实，解析符合 H 节安全规则。
- [ ] 中英文 i18n 同步（`src/ui/i18n/en.json`、`zh-CN.json`），删除废弃页对应文案键。
- [ ] `cd packages/pd-console && npm run build && npm run test` 通过，`npm run lint` 通过。
- [ ] 不触碰 MVP2–MVP5 后端回路；若发现必须触碰，停止并回报。
- [ ] PR 描述列出：满足了哪些 F 节诚实约束、考虑了哪些 ERR、跑了哪些测试。
- [ ] 交互模式符合 J 节（确认保护、撤销窗口、键盘快捷键）。
- [ ] 可访问性符合 K 节（对比度、focus 样式、aria-label、reduced-motion）。

---

## J. 交互模式（治理动作的交互保护，品牌宪章 §3.4 可回滚心智）

治理动作（批准/拒绝/归档/回滚）是不可逆或高影响操作，需要交互保护。但保护方式
必须符合"冷静、不制造紧张"的品牌人格——不用恐慌弹窗，用内联确认。

### J.1 确认保护

- **批准**：点击后显示内联确认条（不是弹窗），文案如"批准后原则将通过提示通道激活。
  确认批准？" + [确认] [取消]。确认条出现在按钮原位或紧邻下方。
- **拒绝**：已有理由输入框作为天然确认，无需额外确认步骤。
- **归档/回滚**：同批准，内联确认条。
- **暂存**：低影响操作，直接执行 + Toast 反馈，无需确认。

### J.2 撤销窗口

- 所有写操作（批准/拒绝/暂存/归档/回滚/保存设置）的 Toast 中**必须**包含"撤销"链接。
- 撤销窗口 5 秒，超时后链接消失，操作不可逆。
- 撤销操作本身也需要 Toast 反馈（"已撤销"），但不嵌套撤销。
- 品牌依据：宪章 §3.4 "信任来自可回滚"——Toast 撤销是可回滚心智的即时体现。

### J.3 键盘快捷键

- 10 个页面支持 `Alt + 1~0` 快捷键切换（1=启动页, 2=登录页, 3=治理焦点, 4=原则审查,
  5=行为证据, 6=生效情况, 7=原则债务, 8=控制中心, 9=反馈, 0=更新）。
- **禁止使用 `Cmd/Ctrl + 数字`**：这是浏览器切换标签页的保留快捷键，会冲突。
- **禁止使用 `⌘` 符号**：Windows 用户看到 ⌘ 会困惑，统一用 `Alt`。
- 侧边栏导航项右侧显示快捷键提示（`--ink-4` 色，字号 11px），格式为 `Alt+N`。
- 原则审查页决策栏支持：`Enter` 批准 / `D` 暂存 / `R` 拒绝（仅当焦点在决策栏内时生效）。
- 快捷键不得与浏览器/系统快捷键冲突。

### J.4 操作反馈预期

- 任何触发异步流程的按钮（如"沉淀为原则候选"），按钮旁需弱化提示文案说明后续：
  "系统将生成原则候选，出现在首页待审查区"。
- 提示文案用 `--ink-4` 色，字号 13px，按钮下方 4px。

---

## K. 可访问性（WCAG 2.1 AA 合规，品牌宪章 §5.6 无障碍）

### K.1 颜色对比度

- 所有可读文字必须满足 WCAG AA 对比度：正文 ≥ 4.5:1，大字（≥18px 或 ≥14px bold）
  ≥ 3:1。
- `--ink-4` 为 `#5F6774`，在 `--paper` (#F0F1F4) 上对比度 ≥ 4.5:1（WCAG AA）。
- `--ink-5` 仅用于装饰元素（分割线、背景图案），**不用于任何可读文字**。
- 暗色模式同理，上线前需用对比度检测工具验证。

### K.2 焦点管理

- 所有可交互元素（按钮、链接、导航项、卡片）必须有 `:focus-visible` 样式。
- 焦点样式统一：`outline: 2px solid var(--gov); outline-offset: 2px; border-radius: 4px`。
- 不得使用 `outline: none` 移除焦点环，除非提供了等价的可见焦点指示器。
- Modal/Dialog 打开时焦点陷阱（focus trap），关闭后焦点回到触发元素。

### K.3 语义化与 ARIA

- 装饰性 SVG 图标加 `aria-hidden="true"`。
- 功能性 SVG 图标（如导航图标）加 `aria-label`（如 `aria-label="治理焦点"`）。
- 状态标签（待审查/已批准等）使用 `<span role="status">` 或等价语义。
- 折叠区（`<details>`）的 summary 需描述性文案，不用"点击展开"。
- 卡片整体可点击时，用 `<a>` 或 `<button>` 包裹，不用 `onclick` on `<div>`。

### K.4 动效偏好

- **所有页面**必须包含 `@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }`。
- 原型文件也必须包含此声明（当前 `principle-review.html` 缺失，需补齐）。

### K.5 品牌 mark 渲染

- 侧边栏"门"形 mark 使用内联 SVG，`fill: none`，`stroke: var(--gov)`，1.5px stroke，
  外框 `rx="4"` + 描边（Warm Paper 风格：描边而非填充）。SVG 尺寸 24×24，
  `viewBox="0 0 28 28"`。
