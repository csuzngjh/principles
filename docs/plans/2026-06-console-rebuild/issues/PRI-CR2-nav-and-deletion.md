# PRI-CR2：导航骨架 + 删除废弃页与路由

**Type**: AFK
**Priority**: P0
**Blocked by**: PRI-CR1
**必读**: `../01-shared-constraints.md`（**尤其 A 节全部子节**：技术栈、目录结构、api.ts 清理、服务端清理、旧代码处理策略、分支策略；C 节 IA；E 节文案）、`packages/pd-console/design-prototype/governance-focus.html`（侧边栏参考）

## 背景

当前侧边栏是 "MVP Journey" + "Diagnostics" + health badge 的结构，承载 ~20 个页面
入口，标语 `Burn pain, drive evolution`、DNA logo。本工单建立新的两层导航骨架，
并删除编码错误心智的页面与对应后端 route，为各治理页腾出干净地基。

## What to build

1. **新侧边栏**（移至 `src/ui/components/layout/app-sidebar.tsx`，替换现有
   `src/ui/components/app-sidebar.tsx`）：
   - 品牌区：去掉 DNA logo 与 `Burn pain, drive evolution`，换成 `design-prototype`
     里的 "门" 形 mark + `PD / Governance Workspace`。
   - 主导航（治理，视觉重心，恰好 5 项，顺序固定）：治理焦点 / 行为证据 /
     原则审查 / 生效情况 / 原则债务。
   - 次级工具区（弱化）：控制中心 / 产品反馈 / 设置 / 更新。
   - **删除**侧边栏全局 health 告警红点（`fetchSystemHealth` 轮询 + `alertCount` badge）。
   - 快捷键提示：导航项右侧显示 `Cmd/Ctrl+1~5`（J.3）。
2. **路由表更新**（`src/ui/App.tsx`）：建立 5 个治理路由 + 工具路由的占位（页面本体
   由 CR3–CR9 实现，这里先放空壳/Loading 占位，保证可导航、可编译）。
   - 新增启动页路由 `/splash` 和登录页路由 `/login`（C.0）。
   - **重构认证 flow**：当前 App.tsx 在 Router 外 early return LoginPage。重构为
     Router 始终渲染，`/splash` → auth check → `/login` or `/focus`。LoginPage
     成为 Router 内的一个路由页面，不再是 Router 外的条件渲染。
3. **页面目录重组**（A.3）：将页面按 IA 分目录放置，不再扁平：
   - `pages/focus/FocusPage.tsx`、`pages/pain/PainPage.tsx`、
     `pages/principles/PrinciplesPage.tsx`、`pages/activation/ActivationPage.tsx`、
     `pages/debt/DebtPage.tsx`、`pages/control-center/ControlCenterPage.tsx`、
     `pages/settings/SettingsPage.tsx`、`pages/settings/UpdatePage.tsx`、
     `pages/report-problem/ReportProblemPage.tsx`。
   - 创建 `components/auth/splash-screen.tsx` 和 `components/auth/login-form.tsx`（C.0）。
4. **删除以下页面组件**（`src/ui/pages/`）：`OverviewPage`、`DataFlowPage`、
   `EventLogPage`、`EvolutionPage`、`CentralPage`、`AgentsPage`、`TasksPage`、
   `SamplesPage`、`ThinkingModelsPage`、`FeedbackPage`（GFI 监控）、`GatesPage`。
5. **删除对应后端 route 与注册**（`src/server/index.ts` 及 `src/server/routes/`）：
   `overview.ts`、`events.ts`、`evolution.ts`、`central.ts`、`agents.ts`、
   `samples.ts`、`thinking-models.ts`、`gates.ts`、`feedback.ts`（GFI/empathy/
   gate-blocks）、`pipeline.ts`（如仅服务已删页面）。**保留** `feedback-reports.ts`
   （产品反馈草稿，服务 `/report-problem`）、`approvals.ts`、`principles.ts`、
   `config.ts`、`workspaces.ts`、`state.ts`、`update.ts`、`update-history.ts`、
   `health.ts`（仅供控制中心配置就绪用，见 CR9，不再用于全局红点）。
6. **清理 `api.ts`**（A.5）：删除所有废弃接口和函数（详见 A.5 的删除清单），保留
   认证、审批、原则、反馈报告、配置、工作区相关函数。将 `fetchSystemHealth`
   重命名为 `fetchConfigReadiness`，仅保留配置就绪数据源功能，删除全局健康
   红点展示路径。清理后预计 ~300 行。
7. **清理服务端 `index.ts`**（A.6）：删除废弃路由的 import、if 块和 dispose 调用
   （详见 A.6 的删除清单）。
8. **清理对应 Model**（A.4）：删除仅服务废弃页面的 Model
   （如 `EvolutionConsoleModel`、`GateConsoleModel`、`FeedbackConsoleModel`、
   `EventLogReadModel`、`PipelineStatsModel`、`SampleConsoleModel`、
   `ThinkingModelsConsoleModel`、`OverviewConsoleModel`）。
   **逐个确认无其他存活页面引用后再删**（防 ERR-012 误删活引用）。
9. **删除废弃业务组件**（A.3）：`UpdateBanner.tsx`、`UpdateProgressDialog.tsx`、
   `approval-card.tsx`、`approval-detail-dialog.tsx`、`compare-view.tsx`、
   `data-freshness-indicator.tsx`、`health-diagnostic-card.tsx`、`page-header.tsx`、
   `rejection-reason-dialog.tsx`。删除 `charts.tsx`（废弃页专用）。
10. **删除废弃 hooks**：`useBookmarks.ts`、`useKeyboardNavigation.ts`。
11. **清理 i18n**（A.7）：删除废弃页面的文案键前缀（overview/gates/evolution/agents/
    central/dataFlow/eventLog/thinkingModels/samples/feedback(GFI 通道)）。

## Acceptance criteria

- [ ] 侧边栏只有 5 个治理主项 + 工具区，无 health 红点、无旧标语、无 DNA logo。
- [ ] 侧边栏位于 `components/layout/app-sidebar.tsx`（A.3 目录结构）。
- [ ] 启动页 `/splash` 和登录页 `/login` 路由可用（C.0）。
- [ ] 5 个治理路由可导航到占位页（按 IA 分目录），工具路由可达；应用可编译运行。
- [ ] 上列废弃页面组件、后端 route、注册、专属 Model、api.ts 函数全部删除。
- [ ] `api.ts` 从 ~900 行清理到 ~300 行，无废弃接口/函数（A.5）。
- [ ] 服务端 `index.ts` 废弃路由的 import、if 块、dispose 调用全部删除（A.6）。
- [ ] 废弃业务组件和 hooks 全部删除（A.3）。
- [ ] 删除顺序遵循"先确认无存活引用 → 再删"；构建无死引用报错（ERR-012）。
- [ ] 删除同时清理 `i18n/en.json`、`zh-CN.json` 中废弃页面的文案键（A.7）。
- [ ] 删除其专属测试；保留并按需调整仍有效的测试。
- [ ] `cd packages/pd-console && npm run build && npm run test` 通过；`npm run lint` 通过。

## 实施提示（防功能错乱）

- 这是**删除型工单**，按 `AGENTS.md` legacy retirement 顺序：**切 caller → 验证 →
  删除**，不要先删仍被引用的文件。
- `health.ts` / `HealthCheckModel` **不要删**：CR9 控制中心的"配置就绪"会复用它，
  只是不再驱动全局红点。
- 若某个 route/Model 同时被保留页面引用，**停止删除并在 PR 中说明**。
- 工具页（控制中心/设置/反馈/更新）本工单只接路由，不重做内容（归 CR9）。
- **api.ts 清理**（A.5）和服务端 **index.ts 清理**（A.6）的完整删除清单见
  `01-shared-constraints.md`，按清单逐条删除，不要遗漏。
- **CR2 开工前**，确认 pd-cli 是否依赖任何将被删除的路由（A.11）。如有，保留该路由
  或协调 CLI 修改。

## MVP 三问

- **不做会怎样**：旧页面与新治理页并存，IA 混乱，错误心智残留。
- **怎么观察**：侧边栏与路由表；构建/测试通过；废弃 route 返回 404。
- **怎么关闭**：git revert 本 PR 可恢复被删页面（删除前确保 PR 粒度清晰）。

## DoD

见 `../01-shared-constraints.md` I 节。
