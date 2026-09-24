# PRI-911A — Identity Writer Boundary 加固审计

> 任务：PR #1856（activation 边界）已经拦住坏身份进入 runtime；本票处理**上游写入方**——
> 任何写 `pi_artifacts.source_principle_id` 的路径必须（1）有明确身份来源、（2）可验证、
> （3）禁止 title/text 兜底、（4）失败可观测。
> 交付：Code PR + 本文档。本文档只描述**写入方契约**，不改历史数据、不改 activation/application、
> 不做 migration（SPEC Non Goals）。

## 0. 结论摘要

修复前只有 **两个写入点** 还能把非 canonical 值写进身份列：

- **W1 DreamerRunner** —— 把 LLM 自述的 `sourcePrincipleId` 原样落到列上；
- **W2 EvaluatorRunner** —— 规则装配时用一条宽容链（列 → contentJson.principleId →
  contentJson.sourcePrincipleId → principleDraft.title）"提取"身份。

Phase 1 审计（`docs/audit/principle-identity-reconciliation-phase1.md`，同一 921 行基线）里的
**22 条文本污染**（T-NN 17 条 + 标题 5 条）只能由这两条路产生；其余写入点早已对账本验证。

修复后：身份列的取值只剩两种——**账本真有的 canonical UUID**，或者 **NULL**（附可观测原因）。
文本兜底被删除，且删除的是**写路径**，不是读能力：标题仍留在 contentJson，展示层的宽容解析器照旧工作。

规则装配**不再因为身份不可验证而中止**（SPEC Verification Case 5）。身份缺口继续由 #1856 的
**publication 边界**处置（规则保留、不建审批、不激活，`identity_binding_unverified`）。
本票不改变这条既有分工。

## 1. 证据基线

| 项 | 值 |
| --- | --- |
| 代码基线 | `origin/main @ f65af4a5`（含 #1851 / #1856 / #1860） |
| 存量身份数据 | Phase 1 副本 `D:/pd-probe-pri910/state.db`，`pi_artifacts` 921 行 = 894 NULL + 5 账本验证 UUID + 22 文本 |
| 身份权威 | `_tree.principles`（`{stateDir}/principle_training_state.json`），id 由 `crypto.randomUUID()` 铸造 |
| 复用的既有能力 | `canonicalLedgerPrincipleId`（由 #1856 的 `resolveActivationPrincipleId` 拆出）、`PrincipleTreeLedgerAdapter.hasPrinciple` |
| 新增 schema / 新身份系统 | 无 |

## 2. Identity Writer Inventory（全量写入点）

`pi_artifacts.source_principle_id` 由 `upsertArtifact/createArtifact` 单点落库
（`sqlite-pi-artifact-store.ts:84`），因此"写入方"= 构造带 `sourcePrincipleId` 的 record 的调用点。
下表是穷举结果（`grep sourcePrincipleId: / source_principle_id`，排除 `dist` 与测试）：

| # | 写入点 | 位置 | 输入来源 | 修复前行为 | 风险 | 修复后 |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | DreamerRunner 落 artifact | `internalization/dreamer-runner.ts:297` | LLM 输出 `sourcePrincipleId`（postFetchTransform 后只剩 `T-NN`） | 原样写入身份列 | 把公理注册表编号当成原则身份（17 条 T-NN 污染来源） | 列不再承载；断言值保留在 contentJson，并 emit `dreamer_identity_assertion_not_carried` |
| W2 | EvaluatorRunner 规则装配 | `internalization/evaluator-runner.ts:3357` | bearer（scribe）artifact，经 4 级宽容链 | 取到 title 也照写 | 标题进身份列（5 条标题污染来源），且 identity 与 lineage 脱钩 | 只认列值且须过 shape + 账本成员校验；不过则写 NULL + emit `evaluator_identity_stamp_failed` |
| W3 | ScribeRunner 链上盖章 | `internalization/scribe-runner.ts:455,496` | 账本 `listForCandidate` 唯一命中 | 已经是 fail-soft（0 或 >1 命中 ⇒ 不盖章 + 事件） | 无（#1856 I2 已成立） | 不变 |
| W4 | RuleHost 身份回填 | `pd-cli/src/services/rulehost-pipeline-runner.ts:1105`（`backfillScribeIdentity`） | 账本 candidate 映射 + 写后读回校验 | 已验证（`identity_conflict` / `binding_unverified` 拒绝） | 无 | 不变（仅删掉一处指向已删函数的注释） |
| W5 | Activation safety store 复原 | `activation/sqlite-activation-safety-store.ts:399` | 从既有行回读后原样写回 | 复制既存值，不产生新身份 | 存量污染行会被原样搬回（属 PRI-910 数据修复范围） | 不变 |
| W6 | Demo / baseline 种子 | `runtime-v2/story-a-demo.ts:92,138`、`runtime-v2/proven-channel-baseline.ts:75,116`、`pd-cli/src/services/demo-story-a-runner.ts:39` | story-a-demo 用 `randomUUID()` 真造账本条目；baseline fixture 用固定 UUID（`b2400000-…0240`） | 写 UUID 形身份 | 不产生文本污染；但 fixture 常量并非账本成员，若被 W2 复用会被判 `invalid_identity`（正确行为） | 不变 |
| — | 其余 runner（artificer / philosopher / rollout / diag-*） | 各自 upsert | — | 根本不传 `sourcePrincipleId` | 无 | 不变 |
| — | 读取面（非写入方） | `pd-console/src/server/models/*`、`openclaw-plugin/src/core/rule-host.ts`、`activation/low-risk-writers.ts` 的 `extractPrincipleId`、`sqlite-activation-safety-store` 的读回 | — | 只把列值取出来做投影/分组/回执键 | — | 不变（见 §7） |

结论：**污染面 = W1 + W2，全部已收口**；W3/W4 是既有正确写入方，本票把它们的校验方式复制到 W2 上。

## 3. 设计：Connection Before Creation（SPEC §6.3）

没有新抽象、没有第二真值来源：

1. **UUID 校验器不重写**。#1856 的 `resolveActivationPrincipleId(artifact)` 里唯一"真"的东西是
   值级判定，于是把它拆成 `canonicalLedgerPrincipleId(value)`，
   `resolveActivationPrincipleId` 变成它的一行包装（activation 侧行为逐字节不变，
   含小写归一）。W2 现在调这个**同一个**函数。
2. **账本成员检查不重写**。复用 `PrincipleTreeLedgerAdapter.hasPrinciple`，以 #1856 为
   scribe 准备的同款 inject-only 依赖形状接入：
   `EvaluatorRunnerDeps.ledgerIdentity?: { hasPrinciple(id): boolean }`
   —— core 保持零账本 I/O（D5），host 不注入时 shape gate 仍然成立。
3. **lenient 的 `extractPrincipleId` 保留原样**（display / approval 分组仍需要它），
   只是不再被写路径调用。
4. **不新增 feature flag**（mvp-q-3）：回滚 = revert 本 PR；既有 publication 边界本身就是兜底。

生产接线（`grep "new EvaluatorRunner("` 全仓只有 3 处构造，全部已注入）：

- `host-runtime/src/internalization-consumer-cycle.ts:643` —— 常驻 consumer cycle（直接注入）；
- `pd-cli/src/services/rulehost-pipeline-runner.ts:476` —— RuleHost，经
  `createEvaluatorRunnerDeps`（:735，注入在 :743）；
- `pd-cli/src/commands/runtime-internalization-run-once.ts:640` —— `pd runtime internalization
  run-once`，复用同一工厂。

（同文件 :602 是 scribe 的 `listForCandidate` 注入，属 #1856 既有链路，本票未动。）

## 4. Before / After 流程

**Before（污染如何发生）**

```
LLM 自述 sourcePrincipleId='T-06' ──► W1 列写入 'T-06'
scribe 未盖章（列 NULL，title 在 contentJson）
        └─► W2 宽容链落到 principleDraft.title ──► rule.source_principle_id = '意图缺口即风险信号…'
                └─► activation 按 title 分组 / 回执按 title 建键（#1856 之后被拒绝，但脏数据已生成）
```

**After**

```
W1：身份列不承载 LLM 断言；断言值仍进 contentJson + dreamer_identity_assertion_not_carried
W2：bearer.source_principle_id
      ├─ canonical UUID 且账本认得 ──► 写入 + evaluator_identity_stamp_success
      └─ 缺失 / 文本 / 账本不认      ──► 列写 NULL + evaluator_identity_stamp_failed(reason)
                                        规则照常装配 → #1856 publication 边界决定是否入账
```

## 5. 失败契约与遥测（SPEC §6.4）

`IdentityStampFailureReason`（`evaluator-runner.ts` 导出）：

| reason | 触发条件 | 谁产生 |
| --- | --- | --- |
| `missing_identity` | bearer 列空 | W2 |
| `non_canonical_identity` | 有值但不是 canonical UUID（标题、`T-NN`、任意文本） | W2；W1 以同一 reason 报告"断言不被承载" |
| `invalid_identity` | UUID 形状正确但账本没有这条 | W2（须 host 注入 `ledgerIdentity`） |
| `ambiguous_identity` | 同一候选命中多条账本身份 | **bearer/lineage 解析器**（`resolveLedgerActivationId`、`backfillScribeIdentity`），它们才看得见多重性；stamp 路径不重复上报 |

事件（全部登记进 `telemetry-event.ts` 的 Type.Literal union，否则 ERR-060 会把未登记事件
静默改写成 `degradation_triggered`）：

- `evaluator_identity_stamp_success` `{runId, principleId, bearerArtifactId}`
- `evaluator_identity_stamp_failed` `{runId, reason, nextAction}`
- `dreamer_identity_assertion_not_carried` `{runId, reason, assertedPrincipleId, nextAction}`

`evaluator_rule_assembly_failed` 语义**不收窄也不扩张**：它继续表示结构性装配失败
（无 bearer artifact / 写库失败 / 校验状态更新失败），不代表身份被拒。
新身份事件**未**加入 `WorkspaceTelemetryEmitter.CRITICAL_EVENT_ALLOWLIST`——与 scribe 的同类事件保持一致，
且持久化白名单扩容属独立决策（P3）。

## 6. 验证

Case 1–4（`packages/principles-core/src/runtime-v2/__tests__/evaluator-runner-vslice-v2.test.ts`
› `EvaluatorRunner — identity writer boundary (PRI-911A)`）：账本已知 UUID ⇒ 列写入 + success 事件；
账本未知 UUID ⇒ `invalid_identity` + 列为 NULL；title 值 ⇒ `non_canonical_identity` + 列为 NULL；
未盖章 ⇒ `missing_identity` + 列为 NULL，且**不发** `rule_assembly_failed`。
三个拒绝用例都断言规则 artifact 数量为 1（失败只作用在身份列上）。

Case 1 亦由 pd-cli 真实链路证明：`tests/services/rulehost-pipeline-runner.test.ts`
› "capability ON + evaluator approved … scribe identity backfilled on the rule path too"
——真 RuntimeStateManager + 真 SQLite + 真账本，断言 rule.sourcePrincipleId == 账本 UUID。

Case W1（Dreamer）：`__tests__/dreamer-runner.test.ts` —— Bug-O L1 断言改为列 `undefined`、
contentJson 仍带 `T-01`、事件 reason 为 `non_canonical_identity`；并补一条"无断言时不发身份事件"。

Case 5（既有生产流不受影响）：

| 范围 | 结果 |
| --- | --- |
| `principles-core` 全量 | 391 files passed / 4 skipped（7877 tests） |
| `pd-cli` 全量（`--no-file-parallelism`） | 124 files passed |
| `pd-console` 全量 | 134 files passed |
| `host-runtime` 全量 | 31 files passed |
| `openclaw-plugin` 全量 | 201 passed；3 files failed —— 2 个（`template-anti-regression` GNU tar Windows 路径、`principle-application-ledger.steps` `fs.rmSync` EPERM）在**基线 `176a9a28` 主检出上以同样方式复现**，属本机环境既有失败；1 个（`prompt-golden` 5s 超时）单独运行为绿 |
| `npm run verify:merge` | 绿（含 `check:telemetry-events --strict`：union=336 emitted=342 drift=0） |

注：`pd-cli` 并行全量时 `tests/commands/codex-setup.test.ts` 一例曾以 5000ms 超时复现两次；
与身份链路无关（codex 同意文案），串行全量 124/124 绿 ⇒ 判定为机器负载超时，非本 PR 回归。

## 7. 剩余风险与未纳入范围

| 项 | 说明 | 归属 |
| --- | --- | --- |
| 存量污染行 | 22 条文本 + 894 条 NULL 原样留在库里；本票只关闭**新增**污染面 | PRI-910 Phase 2/3（migration，Owner 决策后） |
| 宽容 READ 面 | `resolveActivationPrincipleId` 之外的读取仍宽容：`production-rulehost-gate.ts:374`（content.principleId → 列 → ruleId）、`rule-host.ts:720`、`sqlite-activation-safety-store.ts:399`、`openclaw-plugin/src/core/principle-receipt-metadata.ts`（按身份列取回执键） | 读面收窄须与回执键推导一起处理（SPEC Non Goals 禁改 receipt/identity reconciliation） |
| `ambiguous_identity` 在 stamp 路径不产生 | 单条 bearer 列值无法自证"多重"；多重性由 bearer/lineage 解析器报告 | 既有设计，已在 §5 记明 |
| 账本不可读时 | `hasPrinciple` 抛错会被身份解析的 try 捕获并降级为 `rule_principle_id_resolve_failed`（既有事件），身份列写 NULL | 行为与修复前一致 |
| 未盖章 bearer 的规则 | 规则可生成但永久无法激活/入审（#1856 gate）；Owner 看到的是"候选存在但不可发布" | 已由 publication 边界的 `degradationReason` 表达 |

## 8. 回滚

`revert` 本 PR 即可：无 schema 变更、无数据迁移、无新 flag、无新持久状态。
回滚后 Dreamer 恢复承载 LLM 断言、Evaluator 恢复 title 兜底；#1856 的 activation 边界仍然生效。
