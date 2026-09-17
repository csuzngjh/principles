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

## 2026-09-17 复评补验：C5 正式 writer 与 C0 执行语义

本节修正原验收局限：旧 C5 测试复制了 upsert SQL，且撤销后检查了错误的 append 输出面；旧 C0 仅检查文件存在，未证明每个文件实际执行。此前相关 PASS 不能替代本次补验。

- C5 的 A/B 写入均调用公开的 `SqlitePIArtifactStore.upsertArtifact`。A 有真实 approval 行，先证明 owner directive 注入；B replacement 后通过 store reader 验证 A 消失、槽中只剩 B、旧 activation 仍绑定 A。真实 prompt hook 的 prepend/append 均不得包含 B，directive 不存在，日志必须同时包含 `artifact_not_found` 和 A 的 ID。
- 一次性注入：仅将生产 writer 的 conflict 分支改为保留旧 artifact ID（仍更新内容），然后重建 core，确保 plugin 消费的 dist 包含 mutation。正式 `check:pipeline-contract` 退出 **1**，C5 报 `expected { …(10) } to be null`；**C0 PASS，I3/J1 FAIL**。这证明测试依赖真实 writer，而非自抄 SQL；普通断言失败不等于未执行。
- C0 全部未收集：临时把 plugin 的 include 改为不存在的目录，文件仍在磁盘；正式命令退出 **1，C0 FAIL**。
- C0 部分未收集：只 exclude formation 组的 `pain-id-chain-e2e.test.ts`，另一个文件正常执行；正式命令仍退出 **1，C0 FAIL**。逐文件 JSON report 校验防止组内部分漏跑假绿；缺失/非法 report 同样 fail closed。报告仅存临时目录，执行结束删除，不建立长期结果库。
- 配置和生产 writer 均在 finally 中逐字恢复；core 恢复构建退出 **0**。之后 `npm run check:pipeline-contract` 与 `npm run verify:merge` 均退出 **0**；prompt 文件 **37/37 PASS**。
- 本轮生产代码净改动 **0**，没有修改 Artifact Store 架构，也没有自动失效 activation 的新机制。

复评问题分类：EP-09（替代性测试/错误观察面）与 EP-03（未执行被误报成功）。本轮防护为真实 writer 负向对照及真实 Vitest 全量/部分漏收集对照，不扩建扫描器。

## 汇总

```text
FI1 = PASS（红且命中）
FI2 = PASS（红且命中，断在 formation 入口）
FI3 = PASS（红 + 完整命令非零退出 + 摘要/诊断块）
FI4 = PASS（红且命中）
FI5 = PASS（红且同时命中撤销失效与 A/B 精确性）
全部 probe 已还原；最终全量命令回绿见 PR 验证记录。
```
