# Phase 3: Core Integration - Context

**Gathered:** 2026-04-19
**Status:** Ready for planning

<domain>
## Phase Boundary

将 `WorkflowFunnelLoader` 接入运行时，使 `workflows.yaml` 成为漏斗定义的运行时真相源，驱动 `/pd-evolution-status` 的 funnel summary 展示。

</domain>

<decisions>
## Implementation Decisions

### WORKFLOWS_YAML 路径注册
- **D-01:** `WORKFLOWS_YAML` 加入 `PD_FILES` 常量体系（`paths.ts`），路径为 `.state/workflows.yaml`

### RuntimeSummaryService 改造
- **D-02:** `RuntimeSummaryService.getSummary()` 接受可选 `funnels?: Map<string, WorkflowStage[]>` 参数
- **D-03:** 未提供 `funnels` 时，使用内置默认定义作为兼容路径（向后兼容）
- **D-04:** 用 `funnels` 驱动 stage 聚合，不再 hardcoded event type mapping

### FSWatcher 生命周期
- **D-05:** `watch()` 必须有防重入 guard（`if (this.watchHandle) return;`）—— WATCHER-01
- **D-06:** loader 由 workspace-scoped owner 管理，`dispose()` 在 shutdown / workspace 切换时调用 —— WATCHER-02
- **D-07:** `getAllFunnels()` 返回深拷贝或只读结构，防止 consumer mutation 污染 loader 内部状态 —— WATCHER-03

### 错误处理
- **D-08:** YAML parse/schema 错误进入 `RuntimeSummaryService.metadata.warnings` —— ERR-01
- **D-09:** YAML 模式启用但 YAML 缺失/非法时，summary/status 必须显式 degraded，不静默 fallback —— ERR-02
- **D-10:** watcher 读取到不完整/非法 YAML 时，保留 last-known-good config，不清空现有 funnel definitions —— ERR-03

### 平台兼容
- **D-11:** watcher 正确处理 rename、change、瞬时文件缺失和 debounce 抖动，兼容 Windows atomic-save 模式 —— PLAT-01

### 集成架构
- **D-12:** `evolution-status.ts` 命令层实例化 `WorkflowFunnelLoader`，调用 `watch()`，将 `getAllFunnels()` 传给 `RuntimeSummaryService`
- **D-13:** `WorkflowFunnelLoader` 本身不做修改（已完整实现）

### YAML 边界
- YAML = 漏斗定义真相源
- event log = 发生事实真相源
- runtime summary = 派生视图（YAML 定义 + event log 数据）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Core Files
- `packages/openclaw-plugin/src/core/workflow-funnel-loader.ts` — 已实现的 loader（170行)，含 FSWatcher、debounce、graceful degradation
- `packages/openclaw-plugin/src/core/paths.ts` — `PD_FILES` 常量，`WORKFLOWS_YAML` 需加入
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` — 改造目标，getSummary() 需接受 funnels 参数
- `packages/openclaw-plugin/src/commands/evolution-status.ts` — 命令入口，接入点

### Research
- `.planning/research/SUMMARY.md` — 研究结论：js-yaml 已在 deps，fs.watch 已实现，WORKFLOWS_YAML 缺失
- `.planning/REQUIREMENTS.md` — 15 条 requirements，Phase 3 占 8 条
- `.planning/ROADMAP.md` — Phase 3 success criteria

### Prior Phase Context
- `.planning/phases/02-workflow-watchdog/02-CONTEXT.md` — Phase 2 决策：workflows.yaml 是配置来源（SSOT 目标，实际为 scaffold），放在 .state/ 目录

</canonical_refs>

<codebase_context>
## Existing Code Insights

### 已实现的 WorkflowFunnelLoader（无需修改）
- `load()`: 缺失文件→清空，解析失败→保留上次有效配置
- `watch()`: **缺陷** — 无重入 guard（调用两次会泄漏第一个 FSWatcher）
- `getAllFunnels()`: **缺陷** — 浅拷贝 `new Map(this.funnels)`，数组引用共享
- 100ms debounce 已实现

### RuntimeSummaryService.getSummary()
- 当前签名：`static getSummary(workspaceDir: string, options?: { sessionId?: string | null }): RuntimeSummary`
- 目标签名：增加可选 `funnels?: Map<string, WorkflowStage[]>` 参数
- 当前 `heartbeatDiagnosis` 是硬编码字段，YAML 驱动后由 funnel 定义决定

### PD_FILES 缺失
- `WORKFLOWS_YAML: posixJoin(PD_DIRS.STATE, 'workflows.yaml')` 需要加入

</codebase_context>

<specifics>
## Specific Ideas

Phase 2 已确认：
- `workflows.yaml` 放在 `.state/` 目录
- 开发者手动维护 `workflows.yaml`
- 代码只读取，不写入

</specifics>

<deferred>
## Deferred Ideas

Phase 4 处理：
- ERR-01/02/03 错误处理测试
- TEST-01/02/03/04 测试覆盖

</deferred>

---

*Phase: 03-workflow-funnel-runtime*
*Context gathered: 2026-04-19*
