# PRI-807 / PRI-828 — Safety Net v1.2 Fault Injection 验收记录

- 日期：2026-09-17
- 基线：worktree `ai/PRI-807-safety-net-v12`（base 45e115363）+ 本 PR 全部改动
- 方法：对正式生产代码做一次性行级 mutation → 运行 Safety Net 选择集 → 记录红 → `git checkout --` 还原。**未建立任何长期 mutation framework。**
- 每个 probe 的还原都经 `git status` 核验只剩本 PR 意图改动。
- 证明边界：只证明「对应注入缺陷能被正式 Safety Net 捕获」，不宣称所有同类缺陷均可自动发现（SPEC §13）。

## FI-1 — 破坏当前 schema/契约权威

- 注入：`principles-core/src/runtime-v2/diagnostician-output.ts` 的 `DiagnosticianOutputV1Schema` 增加必填字段 `__fiBrokenContract`（当前合法生产输出不再满足当前契约权威）。
- 结果：**红** — `internalization/__tests__/diag-chain-e2e.test.ts` 4 failed / 11 passed（formation-governance 组）。
- 还原：✅

## FI-2 — 断开正式输入 → formation 接线

- 注入：`openclaw-plugin/src/core/behavior-example-pack-assembler.ts` 的 `assemble()` 将 pain 查找置 null（正式 pain 事件无法进入 formation）。
- 结果：**红** — `tests/integration/rulehost-seed-mvp-e2e.test.ts` beforeAll 即失败（1 failed / 1 skipped）。关键性质：J1 在组装包阶段就断，**不存在的最终 artifact fixture 无法掩护断线**（SPEC FI-2 的判定要求）。
- 还原：✅

## FI-3 — 让 stale authorization 静默通过（完整命令端到端）

- 注入：`principles-core/src/runtime-v2/activation/sqlite-activation-safety-store.ts` `commitPromotion` 的 control version + eligibility 复检移除（保留 control 行存在性检查）。
- 结果：**红 + 端到端传播证明** — `npm run check:pipeline-contract` **EXIT=1**；摘要行 `I3 Authorization boundary FAIL`、`I4 Governance idempotency / recovery FAIL`、`Result: FAIL`；§12 诊断块输出 Entry（可复现命令）/ Expected / Actual / NextAction；精确命中 `rolls back evidence and decision when promotion control version is stale`。
- 还原：✅

## FI-4 — 破坏 deny → host 可见 blockReason 映射

- 注入：`openclaw-plugin/src/hooks/gate-block-helper.ts` 返回值 `blockReason` 置 undefined。
- 结果：**红** — `tests/hooks/gate-rule-host-pipeline.test.ts` 的 `valid block decision from SQLite activation → handleBeforeToolCall returns block result` 失败（EXIT=1；1 failed / 12 passed）。
- 还原：✅

## FI-5 — 撤销后缓存中的规则继续执行

- 注入：`openclaw-plugin/src/core/rule-host.ts` 激活指纹替换为常量字符串（撤销/降级/内容变更不再使缓存失效）。
- 结果：**红** — `tests/core/rule-host-cache-invalidation.test.ts` 6 failed / 3 passed，含两个目标用例：
  - `deactivate invalidates cache: live block → no block (ERR-079 stale cache regression)`
  - `deactivating rule A leaves rule B effective on the same live instance (J4 precision, PRI-828)`（本轮新增的 A/B 精确性用例）
- 还原：✅

## 汇总

```text
FI1 = PASS（红且命中）
FI2 = PASS（红且命中，断在 formation 入口）
FI3 = PASS（红 + 完整命令非零退出 + 摘要/诊断块）
FI4 = PASS（红且命中）
FI5 = PASS（红且同时命中撤销失效与 A/B 精确性）
全部 probe 已还原；最终全量命令回绿见 PR 验证记录。
```
