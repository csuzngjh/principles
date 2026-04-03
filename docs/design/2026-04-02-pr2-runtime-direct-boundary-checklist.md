# PR2 Runtime-Direct Boundary Checklist

**日期**: 2026-04-02  
**用途**: `subagent-helper-empathy` / `subagent-helper-deep-reflect` 的 investigate、architecture-cut、verify 闸门清单

## 1. OpenClaw 事实核验

- [ ] 已核对当前 `D:/Code/openclaw`，确认默认 plugin runtime `subagent` 不可用
- [ ] 已核对 `allowGatewaySubagentBinding` 的 late-binding 机制
- [ ] 已核对当前入口是否依赖 gateway request scope、process-global gateway runtime、或两者之一
- [ ] 已核对当前链路不是 `sessions_spawn` / registry-backed 完成模型
- [ ] 已核对 `subagent_ended` 对这条链路只是 fallback / observation / UNPROVEN，而不是主协议

## 2. Surface 决策

- [ ] 当前 surface 已明确标记为 `sidecar_allowed` 或 `must_degrade`
- [ ] 如果是 `boot-*` session，已明确标记为 `must_degrade`
- [ ] 如果 `api.runtime.subagent` probe 不可用，已明确标记为 `must_degrade`
- [ ] 降级策略已写明，而不是“先尝试 sidecar 再说”

## 3. Workflow 主路径

- [ ] 主路径已明确写成 `run -> waitForRun(runId) -> getSessionMessages(sessionKey) -> finalizeOnce`
- [ ] `runId` 和 `sessionKey` 的角色没有混淆
- [ ] 没有任何一步要求“等 `subagent_ended` 来证明主路径完成”
- [ ] cleanup 失败会进入显式状态，不会伪装成完成

## 4. 可观测性

- [ ] `workflowId` 可查询
- [ ] 最近事件可查询
- [ ] 当前 state / cleanup_state 可查询
- [ ] timeout 之后系统做了什么可解释
- [ ] persist 是否成功可解释
- [ ] cleanup 是否成功可解释

## 5. 禁止事项

- [ ] 没有把 `registry_backed` 一起塞进 helper v1
- [ ] 没有修改 `D:/Code/openclaw`
- [ ] 没有把 `subagent_ended` 升格回主完成协议
- [ ] 没有在 runtime unavailable surface 上硬跑 sidecar

## 6. Go / No-Go

只有以下条件全部满足，才能进入 `implement-pass-1`：

- [ ] OpenClaw 事实核验完成
- [ ] Surface 决策完成
- [ ] 主路径唯一且可解释
- [ ] `subagent_ended` 已明确降级
- [ ] 可观测性交付范围已明确

否则只能：

- revise architecture-cut
- 或直接将该 surface 标记为降级/不支持
