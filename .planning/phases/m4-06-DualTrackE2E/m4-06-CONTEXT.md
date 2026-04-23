# Phase m4-06: DualTrackE2E - Context

**Gathered:** 2026-04-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Dual-track E2E verification — 验证 legacy heartbeat 路径和新的 DiagnosticianRunner 路径都正常工作。

E2E 测试使用 TestDoubleRuntimeAdapter 执行单 task 的完整流程：lease → context build → runner execution → validation → success。
兼容 imported openclaw-history context（M3 m3-08/09 已修复，m4-06 验证无错误）。
</domain>

<decisions>
## Implementation Decisions

### E2E 测试范围
- **D-01:** 使用单元级 E2E（TestDoubleRuntimeAdapter），无需真实 LLM 调用。模拟完整 runtime 行为（success/fail/invalid output），验证 runner 逻辑和存储集成。

### E2E 测试结构
- **D-02:** 单文件多场景：`tests/dual-track-e2e.test.ts`，包含 happy path + failure + validation failure 三个场景，聚焦 runner 逻辑验证。

### Legacy 路径验证
- **D-03:** 不测试 legacy。Heartbeat 路径保持不动（M4 未修改 evolution-worker.ts），M1/M2 的集成测试已覆盖。m4-06 只验证新 runner 路径和兼容性。

### OpenClaw-History 兼容性验证
- **D-04:** 只验证无错误 — 创建一个有 imported openclaw-history entries 的 task，验证 runner 能正确处理（m3-08/09 修复已通过，m4-06 做兼容性验证）。

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### M4 已完成 Phase Context
- `.planning/phases/m4-01-RunnerCore/m4-01-CONTEXT.md` — Runner 类型契约、状态转换、生命周期
- `.planning/phases/m4-02-RuntimeInvocation/m4-02-CONTEXT.md` — PDRuntimeAdapter、StartRunInput
- `.planning/phases/m4-03-Validator/m4-03-CONTEXT.md` — DiagnosticianOutputV1 schema、验证逻辑
- `.planning/phases/m4-04-RetryLeaseIntegration/m4-04-CONTEXT.md` — LeaseManager/RetryPolicy 集成、in-memory DB 测试策略
- `.planning/phases/m4-05-TelemetryCLI/m4-05-CONTEXT.md` — 8 个 diagnostician_ 事件、CLI 导出

### M2 存储基础设施
- `packages/principles-core/src/runtime-v2/store/lease-manager.ts` — DefaultLeaseManager
- `packages/principles-core/src/runtime-v2/store/retry-policy.ts` — DefaultRetryPolicy
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` — RuntimeStateManager

### Test Infrastructure
- `packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-runner.test.ts` — m4-04 的集成测试模式
- `packages/principles-core/src/runtime-v2/adapter/test-double-runtime-adapter.ts` — TestDoubleRuntimeAdapter（M4 测试用）

### Requirements
- `.planning/milestones/pd-runtime-v2-m4/REQUIREMENTS.md` — Section 2.6（Compatibility）、Section 4（Exit Criteria #1-3, #6, #9-10）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- TestDoubleRuntimeAdapter — m4-02 已实现，提供 complete runtime contract mock
- RuntimeStateManager — 支持 `:memory:` workspaceDir，每个测试独立 instance
- SqliteContextAssembler — m3-03，已用于 m4-01 的 context build
- DiagnosticianRunner.run() — m4-01/02/03/04 已验证的核心方法
- 8 个 diagnostician_ 事件 — m4-05 已添加到 TelemetryEventType

### Established Patterns
- In-memory DB 测试：每个 test suite 创建独立的 `RuntimeStateManager({ workspaceDir: ':memory:' })`
- Happy path 测试：task lease → run → succeed → verify task status + run record
- Failure 测试：task lease → run → fail → verify retry_wait 或 failed 状态

### Integration Points
- E2E 测试需要：RuntimeStateManager + DiagnosticianRunner + TestDoubleRuntimeAdapter + SqliteContextAssembler
- legacy heartbeat 路径由 evolution-worker.ts 管理，不在 m4-06 测试范围内
</code_context>

<specifics>
## Specific Ideas

- E2E 测试文件：`packages/principles-core/src/runtime-v2/runner/__tests__/dual-track-e2e.test.ts`
- 三个场景：happy path（task → succeed）、failure（runtime fail → retry_wait）、validation failure（invalid output → task failed）
- 兼容性测试：创建有 imported openclaw-history entries 的 task，验证 runner 能正确处理不报错

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope
</deferred>

---
*Phase: m4-06-DualTrackE2E*
*Context gathered: 2026-04-23*