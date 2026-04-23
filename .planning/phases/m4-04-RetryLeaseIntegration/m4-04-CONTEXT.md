# Phase m4-04: RetryLeaseIntegration - Context

**Gathered:** 2026-04-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Runner 与 M2 存储基础设施（LeaseManager / RetryPolicy / RecoverySweep）的集成测试。

目标：验证 DiagnosticianRunner 在 lease 获取、retry wait 恢复、max attempts 截止、过期 lease 回收等场景下正确调用 M2 store API。

边界：不含 runtime adapter mock（m4-02 已覆盖），不含 CLI surface（m4-05 scope）。

</domain>

<decisions>
## Implementation Decisions

### 测试数据策略（In-memory DB）

- **D-01:** 使用真实 in-memory SQLite 作为测试数据库。
  每个测试创建独立 `RuntimeStateManager({ workspaceDir: ':memory:' })`，所有 CRUD 走和生产一样的存储路径。
  **Why:** 保证测试与真实 DB 行为一致，无 mock 泄漏。
  **How to apply:** `RuntimeStateManager` 支持 `:memory:` 作为 workspaceDir，tests/ 目录下每个测试 suite 创建独立的 manager instance。

### 核心场景覆盖（retry_wait 恢复）

- **D-02:** 重点验证 `retry_wait` -> `leased` 的 lease 恢复。
  task 在 retry_wait 状态，runner 再次调用 `acquireLease`，LeaseManager 能正确：
  1. 接受 retry_wait 状态的 task（LeaseManager 接受 pending/retry_wait）
  2. 创建新 RunRecord（attemptNumber 递增）
  3. 正确更新 attemptCount
  **Why:** retry_wait 是核心 retry 机制的 task 状态，runner 必须能重新获取。
  **How to apply:** 测试用例：create task -> lease -> fail(shouldRetry=true) -> markTaskRetryWait -> 再次 lease -> verify attemptCount

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### M2 存储基础设施
- `packages/principles-core/src/runtime-v2/store/lease-manager.ts` — DefaultLeaseManager, acquireLease(), releaseLease(), renewLease(), isLeaseExpired(), forceExpire()
- `packages/principles-core/src/runtime-v2/store/retry-policy.ts` — DefaultRetryPolicy, shouldRetry(), calculateBackoff(), markRetryWait()
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` — RuntimeStateManager（集成层），markTaskRetryWait(), markTaskFailed()

### M4 已完成
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — DiagnosticianRunner.run()，retryOrFail() 调用 stateManager.markTaskRetryWait()
- `.planning/phases/m4-01-RunnerCore/m4-01-CONTEXT.md` — D-01 到 D-07（Runner 决策）
- `.planning/phases/m4-02-RuntimeInvocation/m4-02-CONTEXT.md` — D-01 到 D-03（RuntimeInvocation 决策）
- `.planning/phases/m4-03-Validator/m4-03-CONTEXT.md` — D-01 到 D-07（Validator 决策）

### Requirements
- `.planning/milestones/pd-runtime-v2-m4/REQUIREMENTS.md` — Section 2.5（Retry / Lease Interaction），Section 4（Exit Criteria #3）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `RuntimeStateManager` — 接受 `:memory:` workspaceDir，创建独立的 in-memory SQLite 连接
- `DefaultLeaseManager` 的 `acquireLease` — 接受 'pending' 或 'retry_wait' 状态的 task（RETRY_WAIT_ACCEPTABLE）
- `DefaultRetryPolicy.shouldRetry()` — 通过 `task.attemptCount < task.maxAttempts` 判断

### Integration Points
- `DiagnosticianRunner.run()` 调用 `stateManager.acquireLease()` 获取 task（第104行）
- `retryOrFail()` 调用 `stateManager.markTaskRetryWait()` 或 `stateManager.markTaskFailed()`
- `RuntimeStateManager.retryPolicy` — runner 通过 `getRetryPolicy()` 获取

### Established Patterns
- In-memory SQLite 测试：每个 test suite 创建独立 `SqliteConnection`（`:memory:`）
- task.attemptCount 在每次 acquireLease 时递增（在 lease-manager.ts 第149行计算）

</code_context>

<specifics>
## Specific Ideas

- 测试覆盖：`retry_wait` -> `leased` -> `fail again` -> `max_attempts_exceeded`
- 验证 `attemptCount` 在每次 lease 时正确递增
- 验证 `lease_expires_at` 在 renewal 后正确更新
- 不 mock RuntimeStateManager — 用真实实例

</specifics>

<deferred>
## Deferred Ideas

- 并发抢 lease 测试 — 后续增强
- RecoverySweep 集成测试 — M4 后期扩展
- Openclaw-history 导入兼容测试 — m4-06 scope

---

*Phase: m4-04-RetryLeaseIntegration*
*Context gathered: 2026-04-23*