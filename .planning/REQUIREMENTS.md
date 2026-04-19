# Requirements: v1.21.2 YAML Funnel 完整 SSOT

**Defined:** 2026-04-19
**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## v1 Requirements

### Runtime Wiring

- [ ] **YAML-SSOT-01**: RuntimeSummaryService.getSummary() 接受可选 `funnels: Map<string, WorkflowStage[]>` 参数
- [ ] **YAML-SSOT-02**: 当传入 funnels 时，getSummary() 输出 `workflowFunnels: WorkflowFunnelOutput[]`，结构包含 funnelKey/funnelLabel/stages
- [ ] **YAML-SSOT-03**: 每个 stage 的 count 从 dailyStats 按 statsField dot-path 读取
- [ ] **YAML-SSOT-04**: statsField 缺失或 dot-path 解析失败时，count=0 且 metadata.warnings 追加可见 warning

### evolution-status 展示

- [ ] **EVOL-STATUS-01**: evolution-status.ts 调用 loader.getAllFunnels()，将 funnels + loaderWarnings 传给 getSummary()
- [ ] **EVOL-STATUS-02**: 展示层用 YAML stage label 替代 hardcoded 字段名
- [ ] **EVOL-STATUS-03**: stage 顺序由 YAML 决定，不写死在展示逻辑里
- [ ] **EVOL-STATUS-04**: funnels 为空/YAML 无效时，status 仍显示 degraded，不崩溃

### Degraded State

- [ ] **DEGRADED-01**: YAML 缺失/非法时，summary.metadata.status = 'degraded'，warnings 包含具体错误
- [ ] **DEGRADED-02**: funnels 为空 Map 时，展示层不渲染 funnel 块，降级为仅有 stats 数据的旧格式

## v2 Requirements

Deferred to future release.

### Per-WorkflowId Filtering

- **WFID-01**: aggregateStats() 支持按 workflowId 过滤，实现 nocturnal/heartbeat/rulehost funnel 计数分离

## Out of Scope

| Feature | Reason |
|---------|--------|
| diagnostician 三态统计逻辑改动 | 已在 v1.21 PR #375 修复 |
| nocturnal / rulehost 事件生产逻辑改动 | 事件由各 hook/service 产生，YAML 只驱动展示层 |
| Rule Host 架构改动 | Rule Host 架构稳定，无需改动 |
| FSWatcher 生命周期 | 已在 v1.21.1 scaffold 覆盖 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| YAML-SSOT-01 | Phase 5 | Pending |
| YAML-SSOT-02 | Phase 5 | Pending |
| YAML-SSOT-03 | Phase 5 | Pending |
| YAML-SSOT-04 | Phase 5 | Pending |
| EVOL-STATUS-01 | Phase 6 | Pending |
| EVOL-STATUS-02 | Phase 6 | Pending |
| EVOL-STATUS-03 | Phase 6 | Pending |
| EVOL-STATUS-04 | Phase 6 | Pending |
| DEGRADED-01 | Phase 6 | Pending |
| DEGRADED-02 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 10 total
- Mapped to phases: 10
- Unmapped: 0

---
*Requirements defined: 2026-04-19*
*Last updated: 2026-04-19*
