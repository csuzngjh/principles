# Phase m4-02: RuntimeInvocation - Context

**Gathered:** 2026-04-23
**Status:** Ready for planning

<domain>
## Phase Boundary

TestDoubleRuntimeAdapter 实现（PDRuntimeAdapter 接口的第一个真实实现）+
StartRunInput 构造验证。

不包含 runner+adapter 集成测试（m4-04/m4-06 scope）。
不修改 DiagnosticianRunner（m4-01 已完成）。

</domain>

<decisions>
## Implementation Decisions

### TestDouble 行为模式

- **D-01:** 简单同步模式。pollRun 第一次调用即返回终态（succeeded/failed）。
  不模拟异步轮询延迟。m4-01 集成测试已验证 polling loop 逻辑，
  TestDouble 的核心价值是证明 PDRuntimeAdapter 接口可完整实现。
  **Why:** 异步轮询模拟增加 adapter 复杂度但不增加验证价值。
  **How to apply:** pollRun 默认直接返回 succeeded，通过回调可覆盖为 failed/timed_out。

### 配置 API 设计

- **D-02:** 回调注入模式。通过 onStartRun/onPollRun/onFetchOutput 等回调注入行为。
  提供默认回调（succeed-on-first-poll）简化常见场景。
  测试可精确控制每步返回值，m4-04 可扩展用于 retry 场景。
  **Why:** 场景预设不够灵活（m4-04 需要模拟 timeout 后成功等动态行为），
  回调注入让后续 phase 不需要修改 adapter 本身。
  **How to apply:** TestDoubleRuntimeAdapter 构造函数接受可选的
  TestDoubleBehaviorOverrides 对象，每个方法都有默认实现。

### Phase 范围边界

- **D-03:** 仅 adapter + 接线验证。不包含 runner+adapter 集成测试。
  m4-04 负责 retry/lease 集成，m4-06 负责 end-to-end 测试。
  **Why:** m4-01 集成测试已验证 runner+mock adapter 的 happy/failure path，
  重复测试没有增量价值。
  **How to apply:** 本 phase 的测试聚焦于 adapter 本身的行为正确性
  和 StartRunInput 构造格式验证。

### Claude's Discretion

- TestDoubleBehaviorOverrides 接口的具体字段设计
- 默认 DiagnosticianOutputV1 的内容（用于 fetchOutput 默认回调）
- 是否导出 helper 函数（如 createSucceedingTestDouble()）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### M1 Frozen Interfaces
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter interface (9 methods), StartRunInput, RunHandle, RunStatus, StructuredRunOutput
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — DiagnosticianInvocationInput, DiagnosticianOutputV1

### M4 Completed (m4-01)
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — DiagnosticianRunner (consumer of PDRuntimeAdapter)
- `packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-runner.integration.test.ts` — StubRuntimeAdapter pattern reference

### Requirements
- `.planning/milestones/pd-runtime-v2-m4/REQUIREMENTS.md` — Section 2.2 (Runtime Invocation Path)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- m4-01 integration test StubRuntimeAdapter: 同步实现 PDRuntimeAdapter 的参考模式
- PDRuntimeAdapter 接口: 9 个方法，已由 m4-01 的 mock 和 stub 验证可完整消费

### Established Patterns
- TypeBox schema + Value.Check() for all structured inputs/outputs
- vitest vi.fn() for mock, class implementation for stub/test-double

### Integration Points
- DiagnosticianRunner 构造函数接受 PDRuntimeAdapter（依赖注入）
- runner/diagnostician-runner.ts invokeRuntime() 构造 StartRunInput 并调用 startRun()

</code_context>

<specifics>
## Specific Ideas

- TestDoubleRuntimeAdapter 放在 `packages/principles-core/src/runtime-v2/adapter/` 目录
- 导出 from index.ts: TestDoubleRuntimeAdapter, TestDoubleBehaviorOverrides
- StartRunInput 验证: 测试 DiagnosticianRunner.invokeRuntime() 产生的 StartRunInput 格式正确

</specifics>

<deferred>
## Deferred Ideas

- 异步轮询模拟（m4-04 可通过回调注入实现，不需要改 adapter 基类）
- 生产 OpenClaw adapter（M6 scope）
- runner+adapter 集成测试（m4-04/m4-06 scope）

</deferred>

---

*Phase: m4-02-RuntimeInvocation*
*Context gathered: 2026-04-23*
