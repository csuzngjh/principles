# Phase 2: API Data Endpoints — Context

**Goal:** 实现 7 个 API 端点，每个端点直接调用 @principles/core 函数返回数据。

## Core Function Mapping

| API Endpoint | Core Function(s) | Notes |
|--------------|-----------------|-------|
| GET /api/tasks | RuntimeStateManager.listTasks, getCandidatesByTaskId, PruningReadModel.getPrincipleSignals | 聚合待审批+待清理任务 |
| GET /api/tasks/:id/evidence | PainChainReadModel, RuntimeStateManager.getCandidate | pain→candidate完整追溯 |
| POST /api/tasks/:id/approve | CandidateIntakeService.intake, CandidateStore.updateCandidateStatus | 需先添加updateCandidateStatus方法 |
| POST /api/tasks/:id/reject | CandidateStore.updateCandidateStatus | 标记expired |
| POST /api/tasks/:id/cleanup | updatePrinciple, appendPruningReview | 清理过期经验+审计日志 |
| GET /api/status | OperatorHealthReadModel.getSnapshot, PruningReadModel.getHealthSummary | 已实现，需增强 |
| GET /api/activity | RuntimeStateManager.listTasks, listPruningReviews | 最近动态聚合 |

## Known Gaps

1. **updateCandidateStatus missing**: CandidateStore接口和SqliteCandidateStore实现缺少状态更新方法
2. **Service lifecycle**: server.ts当前per-request创建OperatorHealthReadModel，需改为startup-once初始化
3. **No unified event store**: Activity端点需从tasks+pruning reviews聚合
4. **Cross-store aggregation**: /api/tasks需跨RuntimeStateManager+PruningReadModel聚合

## Key Files

### Core Layer (packages/principles-core/src/runtime-v2/)
- store/candidate/candidate-store.ts — CandidateStore接口 (需加updateCandidateStatus)
- store/candidate/sqlite-candidate-store.ts — SQLite实现 (需加UPDATE SQL)
- store/runtime-state-manager.ts — Task/candidate查询
- pruning-read-model.ts — 清理信号
- pain-chain-read-model.ts — 证据追溯
- candidate-intake-service.ts — 审批逻辑
- operator-health-read-model.ts — 健康快照
- pruning-review-log.ts — 审计日志

### Console Layer (packages/pd-console/src/)
- server.ts — HTTP服务器+路由处理
- types.ts — API响应类型
