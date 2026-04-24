# Phase m5-03: Runner Integration - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-24
**Phase:** m5-03-RunnerIntegration
**Areas discussed:** ResultRef URI scheme, Committer injection strategy, RunnerPhase timing

---

## ResultRef URI scheme

| Option | Description | Selected |
|--------|-------------|----------|
| commit://{commitId} | 指向 commits 表主键，可追溯 artifact + candidates | ✓ |
| run://{runId} + 新字段 | 保留现有格式，task 表加 commit_id | |
| artifact:// 复合 URI | artifact://{artifactId}?commit={commitId} | |

**User's choice:** commit://{commitId}
**Notes:** 简洁直接，commit 是原子操作的入口点，通过 commitId 可追溯到 artifact 和所有 candidates。

## Committer 依赖注入策略

| Option | Description | Selected |
|--------|-------------|----------|
| 必需依赖 | DiagnosticianRunnerDeps 增加必填 committer，测试用 mock | ✓ |
| 可选依赖 | committer?: DiagnosticianCommitter，undefined 跳过 commit | |

**User's choice:** 必需依赖
**Notes:** Production path mandates committer（boundary constraint #2），可选会增加运行时分支和测试复杂度。

## RunnerPhase.Committing 时机

| Option | Description | Selected |
|--------|-------------|----------|
| 现在加 (m5-03) | 与 commit 逻辑一起实现，m5-04 telemetry 直接复用 | ✓ |
| 留给 m5-04 | m5-03 不改 enum，m5-04 加 phase + telemetry | |

**User's choice:** 现在加
**Notes:** Committing phase 属于 runner 状态追踪核心，和 commit 逻辑天然绑定。延迟加会导致 m5-03 没有正确的 phase 追踪。

## Claude's Discretion

- commit 失败的错误信息构造
- SucceedContext 扩展字段设计
- Mock committer 实现细节

## Deferred Ideas

None.
