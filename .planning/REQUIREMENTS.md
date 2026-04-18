# v1.21 PD 工作流可观测化 - Requirements

建立 PD 全链路漏斗可观测性，让 Pain→Principle 学习闭环的断点可发现、可量化。

## Phase 1: Issue #366 修复 — diagnostician_report 三态扩展（PD-FUNNEL-1）

### Event Type 扩展（PD-FUNNEL-1.1）

- **PD-FUNNEL-1.1**: `DiagnosticianReportEventData.category` 从 `boolean` 改为三值 `success | missing_json | incomplete_fields`
  - `success`: JSON 存在且有 principle 字段
  - `missing_json`: marker 存在但 JSON 不存在（Issue #366）
  - `incomplete_fields`: JSON 存在但缺 principle 字段

### Stats 聚合扩展（PD-FUNNEL-1.2）

- **PD-FUNNEL-1.2**: `aggregateEventsIntoStats` 新增漏斗统计
  - `reportsMissingJson++`: category === 'missing_json'
  - `reportsIncompleteFields++`: category === 'incomplete_fields'
  - 保留 `reportsJsonWritten` 但重命名为更准确的名称

### Evolution Worker Marker 检测逻辑（PD-FUNNEL-1.3）

- **PD-FUNNEL-1.3**: `evolution-worker.ts` marker 检测逻辑（line 921-1061）写入正确的 category 值
  - JSON 不存在时 → `category = 'missing_json'`
  - JSON 存在但 principle 字段缺失时 → `category = 'incomplete_fields'`
  - 正常时 → `category = 'success'`

### Runtime Summary 漏斗展示（PD-FUNNEL-1.4）

- **PD-FUNNEL-1.4**: `runtime-summary-service.ts` heartbeatDiagnosis 字段扩展

```typescript
heartbeatDiagnosis: {
  pendingTasks: number;
  tasksWrittenToday: number;           // diagnosisTasksWritten
  reportsWrittenToday: number;         // 改名自 diagnosticianReportsWritten，更准确
  reportsMissingJsonToday: number;     // category = missing_json
  reportsIncompleteFieldsToday: number; // category = incomplete_fields
  candidatesCreatedToday: number;      // principleCandidatesCreated
  heartbeatsInjectedToday: number;
}
```

## Phase 2: YAML 工作流漏斗框架（PD-FUNNEL-2）

### 工作流注册机制（PD-FUNNEL-2.1）

- **PD-FUNNEL-2.1**: 建立 `WORKFLOW_FUNNELS` 定义表（纯内存数据）
  - 支持多工作流注册，每工作流多 stage
  - 每 stage 包含：name、eventType、eventCategory、statsField
  - 新增工作流只需在表里注册，不改 event-log 写入逻辑

### workflows.yaml 加载机制（PD-FUNNEL-2.2）

- **PD-FUNNEL-2.2**: 实现 `workflows.yaml` 加载逻辑
  - 放在 `.state/` 目录
  - 启动时加载，支持热更新
  - YAML 定义漏斗结构，event-log 做原始记录，漏斗从 YAML + event 推导

### Nocturnal 漏斗补充（PD-FUNNEL-2.3）

- **PD-FUNNEL-2.3**: 补充缺失的 Nocturnal stage event
  - `nocturnal_dreamer_completed`
  - `nocturnal_artifact_persisted`
  - `nocturnal_code_candidate_created`
  - 关键 gap：ReplayEngine 仍是手动触发，无自动化漏斗

### RuleHost 漏斗补充（PD-FUNNEL-2.4）

- **PD-FUNNEL-2.4**: 补充 RuleHost 实时拦截 event
  - `rulehost_evaluated` — 每次 evaluate() 调用
  - `rulehost_blocked` — 返回 block 的次数
  - `rulehost_allow` / `rulehost_requireApproval` 分布

## 已知限制

- Nocturnal ReplayEngine 目前是手动触发（`/pd-promote-impl eval`），不是自动化漏斗
- PD 工作流仍在持续开发，调研结论可能不准，YAML 定义可以随时修正

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| PD-FUNNEL-1.1 | Phase 1 | Complete |
| PD-FUNNEL-1.2 | Phase 1 | Pending |
| PD-FUNNEL-1.3 | Phase 1 | Pending |
| PD-FUNNEL-1.4 | Phase 1 | Pending |
| PD-FUNNEL-2.1 | Phase 2 | Pending |
| PD-FUNNEL-2.2 | Phase 2 | Pending |
| PD-FUNNEL-2.3 | Phase 2 | Pending |
| PD-FUNNEL-2.4 | Phase 2 | Pending |
