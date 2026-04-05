# Requirements: Principles Disciple

**Defined:** 2026-04-05
**Core Value:** 自演化 AI 代理通过痛点信号学习并通过显式原则表达实现自我改进。

## v1.5 Requirements

### Foundation

- [ ] **NOC-01**: NocturnalWorkflowManager 实现 WorkflowManager 接口（startWorkflow, notifyWaitResult, finalizeOnce, sweepExpiredWorkflows, dispose, getWorkflowDebugSummary）
- [ ] **NOC-02**: 单阶段路径包装：调用 executeNocturnalReflectionAsync（useTrinity=false 路径）
- [ ] **NOC-03**: WorkflowStore 集成：为 nocturnal 类型的 workflow 创建/更新/记录事件
- [ ] **NOC-04**: NocturnalWorkflowSpec 定义（workflowType='nocturnal', transport='runtime_direct' or new transport）
- [ ] **NOC-05**: sweepExpiredWorkflows 实现：清理超时的 nocturnal workflows

### Trinity Integration

- [ ] **NOC-06**: TrinityRuntimeAdapter 注入到 NocturnalWorkflowManager（作为选项）
- [ ] **NOC-07**: runTrinityAsync 集成：调用 OpenClawTrinityRuntimeAdapter 执行 Dreamer→Philosopher→Scribe 链
- [ ] **NOC-08**: 阶段事件记录：trinity_dreamer_start, trinity_dreamer_complete, trinity_dreamer_failed, trinity_philosopher_*, trinity_scribe_* 等事件写入 WorkflowStore
- [ ] **NOC-09**: 阶段失败处理：任意阶段失败时 workflow 转入 terminal_error 状态并记录 TrinityStageFailure[]
- [ ] **NOC-10**: 全链路状态机：active（chain running）→ finalizing → completed 或 terminal_error

### Persistence & Idempotency

- [ ] **NOC-11**: 中间结果持久化：DreamerOutput 和 PhilosopherOutput 存入 WorkflowStore（payload_json）
- [ ] **NOC-12**: 阶段幂等性 Key：每个 Trinity 阶段生成确定性 idempotencyKey（基于 workflowId + stage + input hash）
- [ ] **NOC-13**: 崩溃恢复：workflow 重启时从 WorkflowStore 恢复已完成的阶段输出，跳过已完成的阶段

### Evolution Worker Integration

- [ ] **NOC-14**: evolution-worker.ts 切换：从直接调用 executeNocturnalReflectionAsync 改为 NocturnalWorkflowManager.startWorkflow()
- [ ] **NOC-15**: 降级行为定义：Trinity 失败时降级到 stub 实现（而非委托 EmpathyObserver/DeepReflect）
- [ ] **NOC-16**: getWorkflowDebugSummary 支持 Trinity 阶段状态展示（当前阶段/已完成阶段/失败阶段）

## v2 Requirements

### Trinity Stage Improvements

- **NOC-17**: 实时阶段进度回调：外部 monitor 可订阅阶段完成事件
- **NOC-18**: 部分结果打捞：Philosopher 失败时保留 Dreamer 输出用于调试

## Out of Scope

| Feature | Reason |
|---------|--------|
| Diagnostician 迁移到 helper | 刚跑通，双路径（subagent_ended + heartbeat）重构风险极高 |
| Realtime stage progress callbacks | v2+ — 需要扩展 WorkflowManager 接口 |
| EmpathyObserver/DeepReflect 改动 | 已完成，保持稳定 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| NOC-01 | Phase 1 | Pending |
| NOC-02 | Phase 1 | Pending |
| NOC-03 | Phase 1 | Pending |
| NOC-04 | Phase 1 | Pending |
| NOC-05 | Phase 1 | Pending |
| NOC-06 | Phase 2 | Pending |
| NOC-07 | Phase 2 | Pending |
| NOC-08 | Phase 2 | Pending |
| NOC-09 | Phase 2 | Pending |
| NOC-10 | Phase 2 | Pending |
| NOC-11 | Phase 3 | Pending |
| NOC-12 | Phase 3 | Pending |
| NOC-13 | Phase 3 | Pending |
| NOC-14 | Phase 4 | Pending |
| NOC-15 | Phase 4 | Pending |
| NOC-16 | Phase 4 | Pending |

**Coverage:**
- v1.5 requirements: 16 total
- Mapped to phases: 16
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-05*
*Last updated: 2026-04-05 after initial definition*
