# Phase 18: Live Replay and Operator Validation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-10
**Phase:** 18-live-replay-and-operator-validation
**Areas discussed:** Live path scope, Verification method, Operator guidance

---

## Live Path Scope

| Option | Description | Selected |
|--------|-------------|----------|
| sleep_reflection 端到端跑通 | 触发 sleep_reflection 任务，在 NocturnalWorkflowManager 中完成，workflow store 显示 completed 状态，resolution 是明确的（非 expired/超时噪声） | ✓ |
| Rule 评估路径可调用 | 验证 bootstrapped rule 在 workflow 中被正确调用，ledger 中 suggestedRules 引用存在 | |
| 手动触发 + 自动验证脚本 | 运行 CLI 脚本，手动注入 test session，触发 sleep_reflection，验证输出包含 principle ID | |

**User's choice:** sleep_reflection 端到端跑通
**Notes:** Stub rules return `action: 'allow (stub)'` — expected. The point is the path runs and is honest, not that it produces novel results.

---

## Verification Method

| Option | Description | Selected |
|--------|-------------|----------|
| Workflow store 查询 | 运行后查询 subagent_workflows.db，workflow state = 'completed'，resolution 明确，metadata 包含 principle ID | ✓ |
| Ledger 状态文件检查 | 检查 principle_training_state.json 中 principle.suggestedRules 是否非空，rules 是否有评估记录 | |
| 单元测试覆盖 + 人工确认 | 写单元测试 mock 外部依赖，验证规则调用路径；人工确认 workflow store 中有对应记录 | |

**User's choice:** Workflow store 查询
**Notes:** LIVE-03 explicitly requires production-state evidence, not just unit tests.

---

## Operator Guidance

| Option | Description | Selected |
|--------|-------------|----------|
| 新增命令：验证 live path | 新增 /nocturnal-validate-live-path 或 npm run validate-live-path，执行 sleep_reflection 验证并输出 workflow store 结果 | ✓ |
| 更新 bootstrap-rules 文档 | 确保 npm run bootstrap-rules 的输出包含验证步骤说明 | |
| 更新 evolution-status 文档 | 确保 /evolution-status 的输出解读说明如何判断 sleep_reflection 是否健康完成 | |

**User's choice:** 新增验证命令
**Notes:** Script should: (1) read bootstrapped principles, (2) trigger sleep_reflection, (3) poll workflow store until completion/timeout, (4) output workflow ID/state/resolution/metadata summary, (5) exit 0 on success.

---

## Claude's Discretion

- Test session injection strategy: if no real sessions exist, inject a minimal synthetic snapshot with non-zero stats (allowed by `hasUsableNocturnalSnapshot()` guard)
- Script location: `scripts/validate-live-path.ts` or added to `package.json` scripts as `validate-live-path`

## Deferred Ideas

- Real rule implementations (functional actions) — future phase
- Full `nocturnal-train` pipeline validation — separate concern
