# SPEC — painEvidenceAdmission / painEvidenceAdmissionDefault 契约修复（PRI-751）

> 状态：待 Owner 决策（PROPOSED）
> 日期：2026-09-12 · 基线：`origin/main` `4dce7d942`
> 性质：**Protected Zone SPEC**。两个 flag 的行为域是 pain pipeline（准入门控），按任务纪律不直接改码，先立本 SPEC。
> 系列背景：Feature Flag Reality Matrix 审计（同分支 `PRI-751-feature-flag-reality-matrix.md`）；同系列已完成 PR #1622 / #1624 / #1625（三个零消费者 flag 退役）。

---

## 1. Reality（已核实的事实链）

按事实优先级（Runtime 实际读取 > 生产消费者 > 配置 > 文档）逐层验证：

1. **Runtime 实际路径**：pain 信号准入由 Gate B（TriggerController，`evaluateTriggerController`）**无条件**执行——`host-runtime/src/production-pain-evidence.ts:359` 不检查任何 flag。
2. **零可执行消费者**：`painEvidenceAdmission` / `painEvidenceAdmissionDefault` 两个 ID 在生产代码中**没有任何可执行读取**。全部引用为：注册表/lifecycle/别名表自指、注释、CLI 提示文案。
3. **消费者是被有意摘除的**：`pain-emission-characterization.test.ts`（PRI-651-B1，三处）以源码扫描断言 pain 钩子 **"no longer loads/reads painEvidenceAdmission flags"**——即 PRI-651（Gate A Retirement Design，Linear Done）已把 flag 读取从 pain 路径移除，但**未同步**注册表、census、别名测试与文档。
4. **Gate A 状态**：`pain-gate/pain-diagnostic-gate-policy.ts` 头注 `@deprecated PRI-454`，自述"remains as the rollback path when flags are OFF"；`triage-adapter.ts:12` 明示 "Gate A retired from runtime; remains archived"。plugin 侧 `pain-diagnostic-gate.ts` 是保导出兼容 shim（为 5 个调用方保名）。**没有任何生产代码按 flag 路由回 Gate A。**
5. **过期测试**：`host-runtime/tests/pd-config-flag-alias.integration.test.ts`（PRI-609）头注仍声称 "Production consumers (pain.ts / llm.ts / gate-block-helper.ts) read the canonical IDs"，并在注释中自认 "a silently dead kill switch"。该测试保护的 rollback 场景已无真实消费者。
6. **过期文档**：census 文档 `docs/process/feature-flag-lifecycle-census.md:49` 仍写 "painEvidenceAdmission(+Default): pain.ts / llm.ts / gate-block-helper.ts (production readers since PRI-454)"；注册表两条目描述承诺 "When OFF, Gate A is re-activated"。
7. **配置现实**：live workspace 同时含 canonical 与 snake 别名键且同为 true（PRI-609 归一化无冲突告警，良性）。
8. **PRI-454 既定退出条件已满足**：Gate A 归档处置的解除条件为"双 flag 生产 ON 满 30 天 + 5 条 MVP 路径验证 Gate B"（2026-06 起）；PRI-651 已完成 Gate A 退役设计。

**结论**：这两个默认开启的 flag 是 no-op；其文档化的 rollback 契约（flag-off → Gate A）**不存在接线**。任何按 flag 文档执行"关闭回滚"的操作者/AI 会误判已回滚。

## 2. 决策请求（三选一）

| 选项 | 内容 | 影响 |
| --- | --- | --- |
| **A（推荐）** | 完成 PRI-651 尾巴：删两 flag 注册项 + census 条目 + 归档 Gate A shim 与 policy 模块 + 修正 alias 测试头注与 census 文档 + 别名表清理（`FEATURE_FLAG_ALIASES` 两条指向已删 ID 需同步移除） | 配置面=代码现实；rollback 语义改为「per-rule `deactivate`」（既有机制）；存量配置键走 unknown-flag 告警 |
| B | 真正接线 rollback：恢复 flag 读取并在 OFF 时路由 Gate A | 需要在 pain pipeline 写新路由逻辑 + 重验 5 条 MVP 路径；成本高，且与 PRI-651 的退役方向相反 |
| C | 仅修文档：flag 保留但描述改为"已退役为 no-op，回滚走 per-rule deactivate" | 改动最小，但注册表继续收留 no-op 键（与 #1622/24/25 的收敛标准不一致） |

## 3. 影响域与保护措施（Protected Zone）

涉及模块：pain pipeline（准入）、Gate A 归档模块、census 契约。实施时（选项 A）必须：

- 不触碰 `evaluateTriggerController` / `evidence-triage` / pain 钩子发射路径（PRI-651-B1 特征测试锁定其形状，改动会红）。
- `pain-diagnostic-gate.ts` shim 删除前确认其 5 个保名调用方全部是测试（已初核为测试；实施 PR 中逐一举证）。
- 别名表 `FEATURE_FLAG_ALIASES.pain_evidence_admission*` 与 flag 同批删除（alias 指向已删 ID 会成为新的死键）。
- census contract test（feature purgatory=0）双向同步。

## 4. 验证计划（选项 A 的 Definition of Done）

1. 全量 flag/config 契约测试（census 双向覆盖）绿。
2. pain 路径特征测试（pain-emission-characterization 等）**零改动**且绿——证明 pain pipeline 未被触碰。
3. `rg "painEvidenceAdmission|pain_evidence_admission"` 全仓仅剩历史审计文档命中。
4. verify:merge 绿。
5. live 残留键（4 个：canonical×2 + 别名×2）在下次配置加载产生 unknown-flag 告警（可观察、无行为影响）。

## 5. 回滚

单 PR revert 即可（无数据/状态变更）。
