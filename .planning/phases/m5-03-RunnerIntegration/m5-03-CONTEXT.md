# Phase m5-03: Runner Integration - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

将 DiagnosticianCommitter 接入 DiagnosticianRunner 的 succeedTask() 流程。确保 output validated → commit → task succeeded 正确顺序。commit 失败 = artifact_commit_failed，不将 task 标记为 succeeded。

Runner 只通过 DiagnosticianCommitter 接口操作，不直接引用 artifact/candidate 表名或 SQL。

</domain>

<decisions>
## Implementation Decisions

### ResultRef URI scheme
- **D-01:** commit 成功后 resultRef 从 `run://{runId}` 改为 `commit://{commitId}`，指向 commits 表主键。可通过 committer 查询关联的 artifact + candidates。

### Committer 依赖注入
- **D-02:** DiagnosticianCommitter 为必需依赖（非可选）。加入 DiagnosticianRunnerDeps，构造时必须传入。测试用 mock 实现替换。

### RunnerPhase enum
- **D-03:** m5-03 即新增 `RunnerPhase.Committing`，不留给 m5-04。commit 调用前设置 phase = Committing。

### Claude's Discretion
- commit 失败进入 `retryOrFail` 的具体错误信息构造
- SucceedContext 是否需要扩展字段（如 commitResult）
- 测试文件组织和 mock committer 的实现细节

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — RUNR-01 through RUNR-05 (Runner Integration requirements)

### Existing Implementation
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — Current runner, succeedTask() method to modify
- `packages/principles-core/src/runtime-v2/runner/runner-phase.ts` — RunnerPhase enum to extend
- `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts` — Committer interface + implementation (m5-02 output)
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDRuntimeError, error categories

### Prior Phase Context
- `.planning/phases/m5-02-DiagnosticianCommitterCore/m5-02-CONTEXT.md` — Committer interface contracts, CommitInput/CommitResult shapes

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `DiagnosticianRunnerDeps` interface — dependency injection pattern already established (5 deps currently)
- `SucceedContext` — already carries taskId, runId, output, task, contextHash — needs extension for commit result
- `retryOrFail()` — existing retry/fail logic with RetryPolicy, can be reused for commit failures
- `emitDiagnosticianEvent()` — telemetry pattern for all runner events

### Established Patterns
- Phase-based step pipeline: each step is an independent method, `this.phase` tracks current state
- Error classification: commit failures map to `artifact_commit_failed` category
- Idempotency: Committer handles re-commit internally, Runner doesn't need to care

### Integration Points
- `DiagnosticianRunnerDeps` — add `committer: DiagnosticianCommitter`
- `succeedTask()` — insert commit() call between updateRunOutput() and markTaskSucceeded()
- `RunnerPhase` enum — add `Committing = 'committing'`
- `PERMANENT_ERROR_CATEGORIES` — `artifact_commit_failed` is NOT permanent (can retry per RUNR-05)

</code_context>

<specifics>
## Specific Ideas

- succeedTask 新顺序：updateRunOutput → commit → markTaskSucceeded（commit resultRef 替换 run:// URI）
- commit 失败走 retryOrFail，errorCategory = `artifact_commit_failed`
- Boundary constraint #3: "task succeeded MUST happen after commit success" — 此 phase 的核心不变量

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: m5-03-RunnerIntegration*
*Context gathered: 2026-04-24*
