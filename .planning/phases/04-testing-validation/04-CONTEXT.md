# Phase 4: Testing & Validation - Context

**Gathered:** 2026-04-19
**Status:** Ready for planning

<domain>
## Phase Boundary

验证 WorkflowFunnelLoader 集成的错误处理、Windows 兼容性和端到端集成行为。覆盖 watch()/dispose() 生命周期、YAML 无效场景、Windows 事件序列、消费者 mutation 隔离。

</domain>

<decisions>
## Implementation Decisions

### 错误处理（来自 Phase 3 D-08/09/10）
- **D-08:** YAML parse/schema 错误 → `RuntimeSummaryService.metadata.warnings`
- **D-09:** YAML 缺失/非法 → 显式 degraded state，不静默 fallback
- **D-10:** watcher 读取到无效 YAML → 保留 last-known-good funnel definitions

### 平台兼容（来自 Phase 3 D-11）
- **D-11:** watcher 处理 rename + change 事件 + debounce，兼容 Windows atomic-save

### 测试模式
- 使用 `fs.mkdtempSync(path.join(os.tmpdir(), '...'))` 创建 temp 测试目录（参照 event-log.test.ts）
- 每个测试后 `fs.rmSync(dir, { recursive: true, force: true })` 清理
- 使用 `vi.spyOn()` mock FSWatcher 方法进行隔离测试
- 使用真实 temp 文件 + watcher 实例测试端到端行为

### Claude's Discretion
- 测试文件组织方式：遵循项目现有惯例，放在 `tests/core/` 下
- 具体 mock 策略：planner 根据每个 test case 的需要决定
- 集成测试深度：watch() + dispose() + getAllFunnels() 端到端验证

</decisions>

<canonical_refs>
## Canonical References

### Core Files（已实现）
- `packages/openclaw-plugin/src/core/workflow-funnel-loader.ts` — WorkflowFunnelLoader（含 load/watch/dispose/getAllFunnels）
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` — getSummary() 接受可选 funnels 参数
- `packages/openclaw-plugin/src/commands/evolution-status.ts` — 命令入口，持有 loader 生命周期

### Phase 3 Context
- `.planning/phases/03-manual-remediation/03-CONTEXT.md` — 所有 Phase 3 实现决策

### Test Patterns
- `packages/openclaw-plugin/tests/core/event-log.test.ts` — temp dir 测试模式参考

</canonical_refs>

<codebase_context>
## Existing Code Insights

### WorkflowFunnelLoader 已修复缺陷（Phase 3）
- `watch()`: 重入 guard `if (this.watchHandle) return;`
- `getAllFunnels()`: 深拷贝 `v.map(stage => ({ ...stage }))`
- `dispose()`: `this.watchHandle = undefined` after `close()`
- 100ms debounce 已实现
- `'change'` 和 `'rename'` 事件都处理

### RuntimeSummaryService
- `getSummary(workspaceDir, { sessionId?, funnels? })` — funnels 可选

### 测试模式参考
- `event-log.test.ts` 使用 `os.tmpdir()` + `fs.mkdtempSync` + `fs.rmSync` teardown

</codebase_context>

<specifics>
## Success Criteria（全部来自 ROADMAP.md）

1. YAML missing/malformed → degraded state + warning in metadata
2. YAML parse warnings → `RuntimeSummaryService.metadata.warnings`
3. Invalid YAML → loader preserves last-known-good funnel definitions
4. watch()/dispose() lifecycle test: no FSWatcher leaks
5. YAML invalid scenarios: degraded + warnings + last-known-good retained
6. Windows rename/rewrite event sequences
7. Consumer mutation of getAllFunnels() output does not corrupt loader state

</specifics>

<deferred>
## Deferred Ideas

None — Phase 4 scope is complete.

</deferred>

---

*Phase: 04-testing-validation*
*Context gathered: 2026-04-19*
