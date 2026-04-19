# Phase 1: Issue #366 Fix — Context

**Gathered:** 2026-04-18
**Status:** Ready for planning
**Source:** v1.21 PD 工作流可观测化 milestone

<domain>
## Phase Boundary

修复 Issue #366，让 stats 能感知 JSON 缺失/不完整/成功三种情况。
扩展 `diagnostician_report` event category，从 boolean 改为三值枚举。
这是 PD 可观测化的 Phase 1，Phase 2 才做 YAML 框架。

</domain>

<decisions>
## Implementation Decisions

### Category 三值枚举
- **D-01:** `DiagnosticianReportEventData.category` 类型从 `boolean` 改为 `'success' | 'missing_json' | 'incomplete_fields'`
  - `success`: JSON 存在且有 principle 字段
  - `missing_json`: marker 存在但 JSON 不存在（Issue #366，LLM 输出截断）
  - `incomplete_fields`: JSON 存在但缺 principle 字段

### Stats 聚合扩展
- **D-02:** `aggregateEventsIntoStats` 新增 `reportsMissingJson++` 和 `reportsIncompleteFields++`
- **D-03:** `reportsWrittenToday` 重命名自 `diagnosticianReportsWritten`，更准确

### Marker 检测逻辑
- **D-04:** `evolution-worker.ts` marker 检测逻辑（line 921-1061）写入正确的 category 值
  - JSON 不存在 → `category = 'missing_json'`
  - JSON 存在但 principle 字段缺失 → `category = 'incomplete_fields'`
  - 正常 → `category = 'success'`

### Runtime Summary 展示
- **D-05:** `runtime-summary-service.ts` heartbeatDiagnosis 字段新增 `reportsMissingJsonToday` 和 `reportsIncompleteFieldsToday`

### 向后兼容
- **D-06:** 三值 category 向后兼容，旧数据默认为 `success`

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 设计文档（核心）
- `docs/superpowers/specs/2026-04-18-pd-workflow-funnel-design.md` — 完整架构设计，Issue #366 根因分析，Phase 1/2 实施计划

### 类型定义
- `packages/openclaw-plugin/src/types/event-types.ts` — DiagnosticianReportEventData 定义
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — marker 检测逻辑（line 921-1061）
- `packages/openclaw-plugin/src/core/event-log.ts` — aggregateEventsIntoStats 函数
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` — heartbeatDiagnosis 字段

### 项目参考
- `.planning/REQUIREMENTS.md` — PD-FUNNEL-1.1 到 PD-FUNNEL-1.4
- `.planning/ROADMAP.md` — Phase 1 success criteria

### 现有模式参考
- `diagnostician-task-store.ts` — requeueDiagnosticianTask 重试机制

</canonical_refs>

<code_context>
## Existing Code Insights

### event-types.ts 当前位置
`DiagnosticianReportEventData` 在 `src/types/event-types.ts` line 209-213:
```typescript
export interface DiagnosticianReportEventData {
  taskId: string;
  reportPath: string;
  category: boolean;  // 待修改为三值
}
```

### event-log.ts aggregateEventsIntoStats 位置
在 `src/core/event-log.ts`，统计字段结构：
```typescript
stats.evolution = {
  painSignals: 0,
  diagnosisTasksWritten: 0,
  reportsWritten: 0,  // 待改名和扩展
  ...
}
```

### evolution-worker.ts marker 检测逻辑
在 `src/service/evolution-worker.ts` line 921-1061：
- 检测 `.evolution_complete_<id>` marker 文件
- 尝试读取 `.diagnostician_report_<id>.json`
- JSON 不存在时重试 3 次（requeueDiagnosticianTask）
- 目前 category 未记录

### runtime-summary-service.ts heartbeatDiagnosis
在 `src/service/runtime-summary-service.ts` line 264-270：
```typescript
heartbeatDiagnosis: {
  pendingTasks: number;
  tasksWrittenToday: number;
  reportsWrittenToday: number;
  candidatesCreatedToday: number;
  heartbeatsInjectedToday: number;
}
```

</code_context>

<specifics>
## Specific Ideas

- Phase 1 只做 Issue #366 修复（diagnostician_report 三态）
- Phase 2 才做 YAML 框架加载机制
- 三值枚举使用 string literal type 而非 enum（TypeScript 最佳实践）
- aggregateEventsIntoStats 扩展时保持向后兼容

</specifics>

<deferred>
## Deferred Ideas

- YAML workflows.yaml 加载机制（Phase 2）
- Nocturnal 漏斗补充（Phase 2）
- RuleHost 漏斗补充（Phase 2）

</deferred>

---

*Phase: 01-issue-366-fix*
*Context gathered: 2026-04-18 via /gsd-plan-phase 1*
