# Phase 9: 基础监控后端 - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — discuss skipped)

<domain>
## Phase Boundary

用户可以通过 API 获取 Nocturnal 系统的运行状态和健康指标。

**API 端点：**
1. `/api/monitoring/workflows` — workflow 列表（过滤支持）
2. `/api/monitoring/trinity` — Trinity 三阶段状态
3. `/api/monitoring/trinity/health` — Trinity 健康统计
4. 自动检测卡住的 workflow

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
所有实现选择由 Claude 决定 — 纯基础设施阶段。使用 ROADMAP 阶段目标、成功标准和代码库约定指导决策。

### API Design
- 遵循现有 API 模式（参考 `principles-console-route.ts`）
- 复用现有 QueryService 模式（`ControlUiQueryService`、`HealthQueryService`）
- 使用 `/plugins/principles/api/monitoring/*` 路径

### Data Sources
- `subagent_workflows` 表：workflow 运行状态
- `stage_outputs` 表：Trinity 三阶段持久化
- 现有 NocturnalWorkflowManager 和 WorkflowStore

### Stuck Detection
- 检测条件：`created_at > timeoutMs` 且 state 仍为 `active`
- 返回 `stuck` 状态标记和卡住时长

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ControlUiQueryService` — 查询服务模式参考
- `HealthQueryService` — 健康检查服务模式参考
- `WorkflowStore` — workflow 数据访问层
- `NocturnalWorkflowManager` — Nocturnal workflow 管理

### Established Patterns
- API 路由：在 `principles-console-route.ts` 中添加新端点
- QueryService：封装数据查询逻辑，独立服务类
- JSON 响应：使用 `json()` 辅助函数，标准 HTTP 状态码

### Integration Points
- HTTP 路由：`src/http/principles-console-route.ts` — 添加监控端点
- 新服务：`src/service/monitoring-query-service.ts` — 封装监控查询逻辑
- Nocturnal Service：复用现有 NocturnalWorkflowManager

</code_context>

<specifics>
## Specific Ideas

无具体要求 — 基础设施阶段，遵循现有代码库模式和约定。

</specifics>

<deferred>
## Deferred Ideas

无 — 讨论跳过，保持在阶段范围内。

</deferred>

---

*Phase: 09-basic-monitoring-backend*
*Context gathered: 2026-04-10*
