# Phase 02: YAML 工作流漏斗框架 - Context

**Gathered:** 2026-04-19
**Status:** Ready for planning

<domain>
## Phase Boundary

建立可扩展的 PD 工作流漏斗登记机制，`workflows.yaml` 作为可加载的配置来源（SSOT 目标，实际为 scaffold 阶段）。实现 `WORKFLOW_FUNNELS` 内存定义表从 YAML 动态加载，补充 Nocturnal 和 RuleHost 两条工作流的 stage event 记录。

</domain>

<decisions>
## Implementation Decisions

### WORKFLOW_FUNNELS 数据来源
- **D-01:** `workflows.yaml` 是单一真相来源（SSOT）。启动时解析 YAML，动态构建 `WORKFLOW_FUNNELS` 内存定义表。不是硬编码 TypeScript。
- **D-02:** `workflows.yaml` 放在 `.state/` 目录（per-workspace），支持热更新。

### workflows.yaml 维护方式
- **D-03:** 开发者手动维护 `workflows.yaml`。新增 event 类型或新工作流时，开发者直接在 YAML 中注册 stage。
- **D-04:** 不做自动注册。代码只负责读取 YAML 并执行漏斗聚合，不自动写入 YAML。

### 新 Event 类型定义位置
- **D-05:** Nocturnal 和 RuleHost 共 6 个新 event 的 `EventData` 类型全部内联到 `event-types.ts`。
  - Nocturnal: `NocturnalDreamerCompletedEventData`、`NocturnalArtifactPersistedEventData`、`NocturnalCodeCandidateCreatedEventData`
  - RuleHost: `RuleHostEvaluatedEventData`、`RuleHostBlockedEventData`、`RuleHostRequireApprovalEventData`
- **D-06:** 每个新 event 在 `event-log.ts` 中有对应的 `recordXxx()` 方法。

### Event Type 注册
- **D-07:** `EventType` 枚举和 `EventCategory` 枚举需要同步扩展，加入新的 6 个 event type 和对应的 category。

### 漏斗聚合逻辑
- **D-08:** `WORKFLOW_FUNNELS` 加载后，用于 `aggregateEventsIntoStats` 中补充 Nocturnal 和 RuleHost 的 stats 字段统计。

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Event System
- `packages/openclaw-plugin/src/types/event-types.ts` — Event type/category enums, all EventData interfaces, EvolutionStats, DailyStats
- `packages/openclaw-plugin/src/core/event-log.ts` — EventLog class, recordXxx() methods, updateStats(), aggregateEventsIntoStats()

### Nocturnal Service
- `packages/openclaw-plugin/src/service/nocturnal-service.ts` — NocturnalWorkflowManager, artifact persistence, code candidate creation

### RuleHost
- `packages/openclaw-plugin/src/core/rule-host.ts` — RuleHost.evaluate(), enforcement results
- `packages/openclaw-plugin/src/core/rule-host-types.ts` — RuleHost types

### Existing Phase 1 Artifacts
- `.planning/phases/01-issue-366-fix/01-01-PLAN.md` — PD-FUNNEL-1.1 type definition pattern
- `.planning/phases/01-issue-366-fix/01-03-SUMMARY.md` — evolution-worker.ts 三态 category 实现
- `.planning/REQUIREMENTS.md` — PD-FUNNEL-2.x requirements

</canonical_refs>

<codebase_context>
## Existing Code Insights

### Reusable Assets
- `EventLog.record()` private method — 所有 event 写入的通用入口
- `EventLog.updateStats()` — stats 聚合逻辑，已内联处理所有已知的 event type
- `event-types.ts` — 所有 EventData 类型内联在此，不拆分文件

### Established Patterns
- EventData 类型: `taskId` + 业务字段
- recordXxx 方法命名: `record` + 事件名驼峰（`recordDiagnosisTask`）
- category 使用 EventCategory 枚举

### Integration Points
- Nocturnal event 在 `nocturnal-service.ts` 关键节点调用 `eventLog.recordXxx()`
- RuleHost event 在 `rule-host.ts` 的 `evaluate()` 返回后调用 `eventLog.recordXxx()`
- `workflows.yaml` 加载时机: `EventLog` 构造函数或单独的 `WorkflowFunnelLoader` 类

</codebase_context>

<specifics>
## Specific Ideas

Phase 1 已实现的 event 类型清单：

| Event | 触发位置 |
|-------|---------|
| `pain_signal` | pain.ts after_tool_call |
| `pain_detected` | pain.ts emitPainDetectedEvent |
| `diagnosis_task` | evolution-worker addDiagnosticianTask |
| `heartbeat_diagnosis` | prompt.ts recordHeartbeatDiagnosis |
| `diagnostician_report` | evolution-worker 处理完成后 |
| `principle_candidate` | createPrincipleFromDiagnosis |
| `rule_promotion` | promote() |
| `rule_enforced` | RuleHost.evaluate() |

Phase 2 补充: Nocturnal 3个 + RuleHost 3个 共 6 个新 event。

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 02-yaml*
*Context gathered: 2026-04-19*
