# Requirements: v1.21.1 Workflow Funnel Runtime Integration

**Defined:** 2026-04-19
**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## v1 Requirements

### Runtime Wiring

- [ ] **YAML-FUNNEL-01**: RuntimeSummaryService 接受可选 funnel definitions；未提供时允许使用内置默认定义作为兼容路径
- [ ] **YAML-FUNNEL-02**: workspace-scoped runtime owner 负责创建并持有 WorkflowFunnelLoader，并将当前 funnel definitions 传给 RuntimeSummaryService
- [ ] **YAML-FUNNEL-03**: WORKFLOWS_YAML 路径加入路径常量体系（PD_FILES / paths.ts）
- [ ] **YAML-FUNNEL-04**: RuntimeSummaryService 用 funnel definitions 驱动 stage 聚合，而不是 hardcoded event type mapping

### FSWatcher Lifecycle

- [ ] **WATCHER-01**: watch() 必须有防重入 guard，防止 double-watch 泄漏 FSWatcher handle
- [ ] **WATCHER-02**: loader 由 workspace-scoped owner 管理，并在 shutdown / workspace 切换时 dispose()
- [ ] **WATCHER-03**: getAllFunnels() 返回深拷贝或只读结构，防止 consumer mutation 污染 loader 内部状态

### Error Handling

- [ ] **ERR-01**: YAML parse/schema 错误进入 RuntimeSummaryService.metadata.warnings（用户可见）
- [ ] **ERR-02**: 当 YAML 模式启用但 YAML 缺失/非法时，summary/status 必须显式 degraded，不静默 fallback
- [ ] **ERR-03**: watcher 读取到不完整/非法 YAML 时，保留 last-known-good config，不清空现有 funnel definitions

### Platform

- [ ] **PLAT-01**: watcher 正确处理 rename、change、瞬时文件缺失和 debounce 抖动，兼容 Windows atomic-save 模式

### Testing

- [ ] **TEST-01**: watch()/dispose() 有测试覆盖，验证无 double-watch / no leaked FSWatcher
- [ ] **TEST-02**: YAML invalid 时 degraded + warnings + last-known-good 保留有测试覆盖
- [ ] **TEST-03**: Windows-style rename/rewrite 事件序列有测试覆盖
- [ ] **TEST-04**: consumer mutation 不会污染 loader 内部状态有测试覆盖

## v2 Requirements

Deferred to future release.

### statsField Dot-Path

- **STATSFIELD-01**: stage.statsField dot-path 解析支持，从 aggregateStats() 输出中直接取对应字段值作为 stage count（当前用 event type 推断，P3 deferral）

### Per-WorkflowId Filtering

- **WFID-01**: aggregateStats() 支持按 workflowId 过滤，实现 nocturnal/heartbeat/rulehost funnel 计数分离（P2 deferral）

## Out of Scope

| Feature | Reason |
|---------|--------|
| 事件生产端全面改成 YAML 驱动 | 事件由各 hook/service 产生，YAML 只驱动漏斗定义层 |
| 改写所有 event type 命名 | 当前 event type 命名清晰，无需重命名 |
| 重做整个 observability 架构 | v1.21 已建立框架，本次只做 wiring |
| chokidar 替代 fs.watch | fs.watch 已够用；chokidar 作为 fallback 而非默认 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| YAML-FUNNEL-01 | Phase 3 | Pending |
| YAML-FUNNEL-02 | Phase 3 | Pending |
| YAML-FUNNEL-03 | Phase 3 | Pending |
| YAML-FUNNEL-04 | Phase 3 | Pending |
| WATCHER-01 | Phase 3 | Pending |
| WATCHER-02 | Phase 3 | Pending |
| WATCHER-03 | Phase 3 | Pending |
| ERR-01 | Phase 4 | Pending |
| ERR-02 | Phase 4 | Pending |
| ERR-03 | Phase 4 | Pending |
| PLAT-01 | Phase 3 | Pending |
| TEST-01 | Phase 4 | Pending |
| TEST-02 | Phase 4 | Pending |
| TEST-03 | Phase 4 | Pending |
| TEST-04 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 15 total
- Mapped to phases: 15
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-19*
*Last updated: 2026-04-19 after roadmap created*
