# PRI-807 Phase 0 — Worker D：State / Writer Authority 矩阵

> 只读审计产物。**除本文件外未修改任何仓库内容**；未提交 `packages/**`、`.cnb/**`、`.cnb.yml` 改动。
> 作者：PD Developer（CNB NPC，Issue #39）。所有判定均回源 current main 静态代码，未做 live 运行时取证（`~/.pd/`）。

---

## 1. Scope

回答一个具体问题：

> **每一个核心治理事实到底谁有权写？有没有 second writer、test-only writer 可能被误接入？CLI / Console / repair 是否在写同一状态？**

覆盖的事实集合（任务书 §4.1）：

canonical pain / task lifecycle / runner decision / owner resolution / approval / activation / shadow→live / deactivation / rollback / runtime control state

本 Worker 的边界（与 A/B/C/E/F 不重叠）：

- **在范围内**：上述 10 类事实的 **writer 归属**（谁 INSERT/UPDATE）、writer 唯一性、test-only 与 production writer 的区分、跨入口（Console / CLI / repair / recovery）写同一位置的情况、写操作是否携带 Owner 授权语义。
- **不在范围内**：reader 语义/投影一致性、故障注入与 live 取证、修复方案设计（任务书 §4.4 明确「只记事实，不提修复方案」）。

方法纪律（任务书 §3）：

- 判定词：CONFIRMED / FIXED / DRIFTED / PARTIAL / NEW / UNVERIFIABLE。
- 证据优先级：生产代码 > schema/DDL > 生产测试 > 文档 > 注释 > 推断。
- **禁止仅凭 grep 下结论**：每个 writer 候选都打开调用链，逐一区分 production caller 与 test-only caller（判据：调用点是否位于 `packages/*/src` 的非 `__tests__` 路径，且是否被生产入口可达）。
- 每条重要事实附 file / symbol / line / 实际 checkout SHA。

---

## 2. Baseline

### 2.1 实际 checkout SHA 与 SYNCED 判定

```
$ git rev-parse HEAD
191ae1af588a68950af1de5a3b9265771a7b3e8d
```

任务书要求的基线 `cdec05d4bc4252151c7f9f118bdad90f25067594` **不在 CNB 镜像对象库中**：

```
$ git cat-file -t cdec05d4bc4252151c7f9f118bdad90f25067594
fatal: git cat-file: could not get object info
```

该 SHA 存在于 **GitHub 上游**（PD 权威仓库，本执行环境无写凭据但有只读可达性）：

```
$ git ls-remote https://github.com/csuzngjh/principles.git HEAD
cdec05d4bc4252151c7f9f118bdad90f25067594	HEAD
```

**BASELINE: DRIFTED**（CNB 镜像 main `191ae1af` ≠ 审计基线 `cdec05d4b`）。

**获取方法（可复核）**：为满足任务书「最终判定必须回源 current main」的要求，本 Worker 以只读方式从 GitHub 上游取得基线对象（`--filter=blob:none` 浅克隆 + `fetch --unshallow`，**无任何写操作、无凭据**），在 `/tmp/pd-baseline` 做 `git checkout cdec05d4b` 的 detached 检出，并验证：

```
$ cd /tmp/pd-baseline && git rev-parse HEAD
cdec05d4bc4252151c7f9f118bdad90f25067594
```

本报告全部 file:line 均在**该校验过的检出树**上读取，而非 CNB 镜像 `191ae1af`。

### 2.2 Drift Warning

两个方向都列出（任务书 §1 要求）：

**a) 基线有、CNB main 没有**（`git log --oneline 191ae1af..cdec05d4b`，29 commits）：

```
cdec05d4 Merge pull request #1710 from csuzngjh/ai/audit2-agent-pipeline-verify-round
d2b4ff7c Merge pull request #1708 from csuzngjh/ai/PRI-801-installer-transitive-deps
deb08d50 docs(audit): incorporate CNB four-round independent verification (VERIFICATION-A..D) …
ed0ec806 test(installer): fail-loud closure verification + committed regression tests (PRI-801)
7b080f4f fix(installer): resolve reparse points before inject rm/copy (PRI-801)
7598626e fix(installer): transitive npm install needs --legacy-peer-deps + fail loud (PRI-801)
131375fa fix(installer): transitive-closure dep verification for injected workspace packages (PRI-801)
d77433fd Merge pull request #1707 from csuzngjh/ai/audit-agent-pipeline-report
da3887af Merge pull request #1703 from csuzngjh/ai/PRI-798-governance-console-repair
991ed299 Merge pull request #1700 from csuzngjh/ai/adhoc-20260915-error-handbook-compress
94e4ef5b chore(cnb): pin npc:go model to deepseek-v4.1-flash for all NPC steps (Owner directive)
7df64651 Merge branch 'main' sync + remote branch advances into ai/PRI-798-governance-console-repair
57e17ad8 fix(openclaw-plugin): bound pd-bootstrap probes and widen its CI budget
…（共 29 条）
```

**b) CNB main 有、基线没有**（`git rev-list --count cdec05d4b ^191ae1af`）：**0 commits**。

即：CNB 镜像 main 是基线的**严格祖先**，漂移是定向的、可枚举的。

**c) 漂移的影响面对本任务**

`git diff --name-status 191ae1af cdec05d4b | grep -v '^.\s+docs/'` 得到全部非 docs 改动（17 个文件）：

```
M  .cnb.yml
A  packages/openclaw-plugin/scripts/lib/transitive-deps.mjs
M  packages/openclaw-plugin/scripts/sync-plugin.mjs
M  packages/openclaw-plugin/src/commands/capabilities.ts
M  packages/openclaw-plugin/tests/commands/capabilities.test.ts
A  packages/openclaw-plugin/tests/scripts/transitive-deps.test.ts
M  packages/pd-console/src/ui/i18n/en.json
M  packages/pd-console/src/ui/i18n/zh-CN.json
M  packages/pd-console/src/ui/pages/focus/OwnerDecisionCard.tsx
M  packages/pd-console/tests/ui/owner-decision-ui-contract.test.ts
A  packages/principles-core/src/runtime-v2/__tests__/governance-timestamp-schema.test.ts
M  packages/principles-core/src/runtime-v2/__tests__/internalization-orchestrator.test.ts
M  packages/principles-core/src/runtime-v2/governance-experience-contract.ts
M  packages/principles-core/src/runtime-v2/governance-projection-contract.ts
A  packages/principles-core/src/runtime-v2/governance-timestamp-schema.ts
M  packages/principles-core/src/runtime-v2/internalization/internalization-orchestrator.ts
```

**结论**：漂移集中在 PRI-798（治理 Console 文案/时间戳契约）与 PRI-801（installer 依赖闭包）两个主题，**未触及本 Worker 审计的任何 writer 权威文件**（`sqlite-approval-store.ts`、`sqlite-activation-state-store.ts`、`sqlite-activation-safety-store.ts`、`activation-dispatcher.ts`、`pain-signal-bridge.ts`、`lease-manager.ts`、`sqlite-task-store.ts`、`production-gate-deps.ts`、`refiner-sandbox-wrapper.ts`、`runtime-activation.ts`、`routes/activations.ts`、`routes/approvals.ts`）。

**d) 本报告的基线口径**

- 行号与断言**均以 `cdec05d4b` 的实际对象读取为准**（本地 `/tmp/pd-baseline` 的 detached checkout，`git rev-parse HEAD` = `cdec05d4b…` 已验证）。
- 本结论**仅对 `cdec05d4b` 负责**。凡涉及人工需在 CNB 镜像上复核的位置，均在 §4 注明「CNB 侧漂移影响」。
- 唯一被 CNB 侧改动覆盖到的相关文件是 `internalization-orchestrator.ts`（PRI-798 时间戳契约），本报告凡引用它（§4.2 task lifecycle、§5.7 recovery）均已按 `cdec05d4b` 读取；其在 `191ae1af` 的差异属治理时间戳字段，不改变 writer 归属结论。

### 2.3 历史事实种子

任务书提到的 `docs/audit/agent-pipeline-audit-2026-09-15/` **在 `cdec05d4b` 上存在**（CNB 镜像 `191ae1af` 上不存在）：

```
docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md           2347 行
docs/audit/agent-pipeline-audit-2026-09-15/VERIFICATION-A.md    309 行
docs/audit/agent-pipeline-audit-2026-09-15/VERIFICATION-B.md    529 行
docs/audit/agent-pipeline-audit-2026-09-15/VERIFICATION-C.md    465 行
docs/audit/agent-pipeline-audit-2026-09-15/VERIFICATION-D.md    426 行
```

已作为历史事实种子阅读（REPORT §6 治理五环节、§8.4 R-19..R-26、VERIFICATION-D §4 NEW-1..13）。**所有判定均已自行回源 `cdec05d4b` 复核**，历史结论仅用于选择核查点，不作为证据。

---

## 3. Current Authorities（哪些事实已有唯一权威写者）

判定口径：**One fact → one writer** 成立 = 该事实存在唯一生产写者，且其他写能力候选要么是 test-only、要么被 schema/类型/授权构造性阻断。

| # | 事实 | 唯一权威写者（production） | 判定 |
|---|---|---|---|
| 1 | **runner decision**（evaluator / rollout_reviewer 的 durable verdict） | `evaluator-runner.ts:1684`（evaluator 写自身 verdict）+ `rollout-reviewer-runner.ts:1213`（rollout 写自身 verdict）。每类任务只有其自身 runner 写，Owner override 不落 `runnerDecision` 而落 `ownerResolutions[].effectiveDecision` | ✅ **成立**（per-task-kind 唯一） |
| 2 | **owner resolution**（Owner 裁决记录） | `owner-resolution-service.ts:267-271`（`applyOwnerResolution`） | ✅ **成立** |
| 3 | **approval 状态推进** | `SqliteApprovalQueueStore`（`sqlite-approval-store.ts`）为唯一 store 实现：入队 `:157`、approve `:232`、reject `:248`、resetToPending `:263`、edit `:274` | ✅ **成立**（含限定，见 §4.6） |
| 4 | **activation decision**（不可变治理裁决行） | `SqliteActivationSafetyStore`（`sqlite-activation-safety-store.ts`）：7 个 INSERT 点（`:140/:163/:193/:229/:253/:288/:377/:401`） | ✅ **成立**（DB 层 `no_update`/`no_delete` 触发器加固） |
| 5 | **shadow→live 的 live action**（生产路径） | `sqlite-activation-safety-store.ts:407`（`commitPromotion`，单事务） | ✅ **成立**（生产唯一；第二写入者存在但 test-only，见 §6） |
| 6 | **rollback / emergency deactivate**（带审计的停用） | `sqlite-activation-safety-store.ts:175-215`（`deactivateWithDecision`，强制 owner/break-glass 授权） | ✅ **成立** |
| 7 | **runtime control state**（enforcement eligible/safety_isolated） | `sqlite-activation-safety-store.ts:301`（isolate）/ `:411`（version CAS bump）；建行由 `sqlite-activation-state-store.ts:96` 与一次性迁移 `sqlite-connection.ts:762` | ✅ **基本成立**（建行有两个非竞争写者，见 §4.10） |
| 8 | **canonical pain_id** | 无 store writer；由 `production-pain-evidence.ts:176/243` 内容派生（sha256），落库点 `governance-signal-admission.ts:509/703` 与 `production-pain-evidence.ts:418`，受 `trajectory.ts:388` 的唯一索引保护 | ✅ **成立**（DB 层唯一索引为最终权威） |
| 9 | **shadow evidence 事件**（`rulehost_evaluated`） | 仅 OpenClaw 插件 `hooks/gate.ts:117/134` | ⚠️ **单写者但宿主不完整**（Codex 无生产者，见 §5.12） |
| 10 | **task lifecycle status** | `sqlite-task-store.ts:202`（`updateTask`）为通用写点，另有 `lease-manager.ts:158`、`recovery-sweep.ts:104/116/124` 三处直写 | ❌ **不成立**（多写者且无 guard 强制，见 §5.7、§6） |

**小结**：治理裁决面（runner decision / owner resolution / approval / activation decision / rollback）的 writer 唯一性**质量较高**，主要靠「单一 store 实现 + DDL 触发器 + 授权门」三重构造性保证。**薄弱面集中在状态推进（task lifecycle、runtime control state、shadow→live 的测试写者）与宿主覆盖不完整（Codex shadow 证据）**。

---

## 4. Contract Map（完整 writer authority 矩阵）

字段说明：

- **Canonical writer** = 唯一权威写者；若无则明确写「**无权威写者**」。
- **Other write-capable API** = 能写同一位置的全部代码路径（含 test-only，逐一标注）。
- **Production caller / Test-only caller** = 该 writer 的实际调用者。
- **Owner authorization** = 该写是否携带 Owner 授权语义（身份门 / 裁决行 / 证据绑定）。
- **Immutable/mutable** = 该事实写入后是否可改写。

行号均为 `cdec05d4b`。

---

### 4.1 Canonical pain

| 字段 | 内容 |
|---|---|
| **Fact** | canonical pain（`pain_events.canonical_pain_id` + 唯一索引） |
| **Canonical table/file** | `trajectory.db::pain_events`；DDL `openclaw-plugin/src/core/trajectory.ts:388-391`（`CREATE UNIQUE INDEX … ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL`） |
| **Canonical writer** | **无单一 store writer**。身份由内容派生：`production-pain-evidence.ts:176`（tool）、`:243`（correction）。落库点 3 处：`governance-signal-admission.ts:509`、`:703`、`production-pain-evidence.ts:418` |
| **Other write-capable API** | `governance-signal-admission.ts:622/708`：`UPDATE pain_events SET host_kind = ? WHERE canonical_pain_id = ? AND host_kind IS NULL`（**只回填 host_kind，不改身份**，且带 `IS NULL` 守卫）；`internalization-integrity-remediation.ts`（repair）不写 pain_events |
| **Production caller** | `injectCorrectionPain` / `admitGovernanceSignals`（OpenClaw STRONG 路径 `signal-collector-host.ts:510-529` → `pain.ts`；Codex 路径 `governance-signal-admission.ts:776`） |
| **Test-only caller** | 无（落库点均为生产模块） |
| **Console path** | 无写入口（Console 只读 pain 投影） |
| **CLI path** | `pd pain record`（走同一 `PainToPrincipleService` → 同一落库点）；`pd pain retry` 只重放 dead letter，不改 pain_events 身份 |
| **Repair path** | `recordPain` 抛错 → `dead_letter_pains`（`pain-retry.ts:600-627`），不产生第二 pain 身份 |
| **Owner authorization** | **不需要**（pain 是客观观测事实，非治理裁决） |
| **Immutable/mutable** | 身份不可变（唯一索引）；`host_kind` 一次性单调回填 |
| **判定** | ✅ **CONFIRMED**：无第二 pain 身份。唯一「第二写能力」是 `host_kind` 回填，语义上是标注而非身份改写，且被 `IS NULL` 守卫 |
| **CNB 侧漂移影响** | 无（相关文件不在 17 文件漂移集内） |

---

### 4.2 Task lifecycle

| 字段 | 内容 |
|---|---|
| **Fact** | `tasks.status`（PDTaskStatus 状态机）+ `tasks.attempt_count` / `max_attempts` |
| **Canonical table/file** | `state.db::tasks`；DDL `sqlite-connection.ts:224` |
| **Canonical writer** | **无权威写者**。状态推进分散在 4 类写点：①`sqlite-task-store.ts:202`（`updateTask`，通用 patch，**无状态 guard**）；②`lease-manager.ts:158`（`UPDATE tasks SET status='leased', …, attempt_count=?`）；③`recovery-sweep.ts:104/116/124`（裸 UPDATE 三态）；④`internalization-integrity-remediation.ts:771`（repair 裸 UPDATE `status='retry_wait', attempt_count=0`） |
| **Other write-capable API** | `pain-signal-bridge.ts:516`（`onPainDetected` 直写 `status='pending', attemptCount:0`）、`owner-retry.ts:108`、`revision-reopen.ts:111-115`、`internalization-state-machine.ts`（经 updateTask）、`split-diagnostician-runner.ts:305-319` |
| **Production caller** | 上述全部均为生产调用（runner / bridge / CLI retry / orchestrator / recovery） |
| **Test-only caller** | 无（全为生产） |
| **Console path** | **无 task 推进端点**（Console 只读投影，与 REPORT §2 入口清单结论一致） |
| **CLI path** | `pd runtime internalization retry`（`owner-retry.ts:108`，Owner 语义门）、`pd runtime internalization run-once`（不做 recovery sweep）、`pd runtime diagnostics`（repair） |
| **Repair path** | `internalization-integrity-remediation.ts:771`：**裸 SQL 直写 `status`/`attempt_count`，不经 `updateTask`，不查 `canTransitionTo` 白名单** |
| **Owner authorization** | 仅 `owner-retry.ts` 路径有（decision-capable NHR 拒绝 reset，`owner-retry.ts:91-99`）；其余（runner / bridge / recovery / repair）无 Owner 语义 |
| **Immutable/mutable** | 全可变；`succeeded` 后 `resultRef` 有额外不可变 guard（`internalization-task-guards.ts:138+`），但 status 本身可被 reopen |
| **判定** | ❌ **One fact → one writer 不成立**。`canTransitionTo`（`internalization-task-guards.ts:111-134`）只是**校验辅助函数**，唯一消费者是 `internalization-state-machine.ts:230`（决策层），**不构成 `tasks.status` 的写入门**。任何持 db 句柄的代码都能把任意状态改成任意状态 |
| **CNB 侧漂移影响** | `internalization-orchestrator.ts` 被 PRI-798 改动（时间戳契约），但本行判定依赖的 `sqlite-task-store` / `lease-manager` / `recovery-sweep` 均未漂移 |

---

### 4.3 Runner decision

| 字段 | 内容 |
|---|---|
| **Fact** | `diagnosticJson.runnerDecision`（durable machine verdict） |
| **Canonical table/file** | `state.db::tasks.diagnostic_json`（嵌套字段） |
| **Canonical writer** | `evaluator-runner.ts:1684`（evaluator verdict）、`rollout-reviewer-runner.ts:1213`（rollout verdict）——**每类任务只有自身 runner 写自身 verdict** |
| **Other write-capable API** | `revision-reopen.ts:88`（`runnerDecision: undefined`，清空）、`owner-retry.ts:78`（同为清空）；Owner override **不**写 `runnerDecision`，而写 `ownerResolutions[].effectiveDecision`（`owner-resolution-service.ts:462-464`） |
| **Production caller** | evaluator / rollout runner 的 `succeedTask`；reopen 由 orchestrator / owner-resolution 调用 |
| **Test-only caller** | 无 |
| **Console path** | 只读（`GovernanceProjectionCollector.ts:310-320` 投影） |
| **CLI path** | 只读消费 |
| **Repair path** | 无 |
| **Owner authorization** | 「清空」由 Owner 语义动作触发（retry / revise_once）；「写入」纯 runner 权限 |
| **Immutable/mutable** | **写入后不可被 Owner 改写**（Owner 只能清空 + 重跑），这是 INV-02 单一决策依据 |
| **判定** | ✅ **CONFIRMED**。唯一解析点 `resolveEffectiveRunnerDecision`（`owner-review.ts:400-406`），架构测试断言「defined exactly once」 |
| **CNB 侧漂移影响** | 无 |

---

### 4.4 Owner resolution

| 字段 | 内容 |
|---|---|
| **Fact** | `diagnosticJson.ownerResolutions[]`（Owner 裁决 + `effectiveDecision`） |
| **Canonical table/file** | `state.db::tasks.diagnostic_json` |
| **Canonical writer** | `owner-resolution-service.ts:267-271`（`applyOwnerResolution`，CAS 写 + stale 逐字段比对 `:368-380`） |
| **Other write-capable API** | `owner-review.ts:605-608`（`markResolutionApplied`，只改 `appliedAt` 而不改裁决内容）；`owner-resolution-service.ts:244-297`（`driveReviseOnce` 标 applied） |
| **Production caller** | Console `routes/owner-decisions.ts:229-234`（body 强制 reviewKey + 五元组 `:47-61`） |
| **Test-only caller** | 无 |
| **Console path** | `POST /api/v1/owner-decisions/:taskId/resolve`（唯一人工入口） |
| **CLI path** | 无 resolve 命令（owner resolution 仅 Console 面；CLI 只有 retry） |
| **Repair path** | `rollbackPendingResolution`（`routes/owner-decisions.ts:217-233`）——失败回滚，不产生新裁决 |
| **Owner authorization** | **需要**（reviewKey 派生 resolutionId `:171-173`；stale 防护比对 expected* 字段） |
| **Immutable/mutable** | 裁决记录 append-only；`appliedAt` 单次置位 |
| **判定** | ✅ **CONFIRMED**（单一权威写者 + Owner 授权语义 + 幂等） |
| **CNB 侧漂移影响** | 无 |

---

### 4.5 Approval（状态机 pending → approved / rejected / cancelled）

| 字段 | 内容 |
|---|---|
| **Fact** | `approvals.status` 及决策字段（`decided_at/decided_by/decision_note/rejection_reason`） |
| **Canonical table/file** | `state.db::approvals`；DDL `sqlite-connection.ts:395` |
| **Canonical writer** | `SqliteApprovalQueueStore`（`sqlite-approval-store.ts`）：入队 `:157`（`INSERT OR IGNORE`）、approve `:232`、reject `:248`、resetToPending `:263`、edit `:274` |
| **Other write-capable API** | `MemoryApprovalQueueStore`（`memory-approval-store.ts:17`）——**test-only**（全部引用在 `__tests__`，唯一生产引用 `proven-channel-baseline.ts:181` 为 in-memory 诊断夹具，不落库）；`pd-cli legacy-cleanup.ts:224`（`DELETE FROM approvals`，清理写入者）；`pd-console/scripts/e2e-seed.ts:250+`（seed 脚本，非运行时） |
| **Production caller** | `ApprovalQueue`（`approval-queue.ts:45/54/66`）→ Console `ApprovalsConsoleModel.ts:156/478/177`、CLI `runtime-activation.ts:1307/1417/1446`；入队由 `activation-dispatcher.ts:276-338` |
| **Test-only caller** | `MemoryApprovalQueueStore` 全部 11 个 test 文件；`e2e-seed.ts` |
| **Console path** | `routes/approvals.ts`：approve `:146`、reject `:205`、edit `:260`——**decidedBy 硬编码 `'operator'`** |
| **CLI path** | `pd runtime activation approve`（`runtime-activation.ts:1307`）——`decidedBy = opts.decidedBy ?? 'cli-operator'`（`:1264`），**无 owner credential 校验** |
| **Repair path** | `resetToPending` 仅服务 `status='approved'` 的回滚（`:263` WHERE 子句） |
| **Owner authorization** | **不需要**（见 §5.11：这是批准链的授权不一致点） |
| **Immutable/mutable** | mutable，但每次推进都带 `AND status = 'pending'` 前置条件（CAS 语义），approve/reject 幂等安全 |
| **判定** | ✅ **CONFIRMED**（单一生产 store）；`cancelled` 状态 → **无 writer**（见 §5.10） |
| **CNB 侧漂移影响** | 无 |

---

### 4.6 Activation

| 字段 | 内容 |
|---|---|
| **Fact** | `activations` 行（含 `action`、`target_ref`、`promoted_at`、`deactivated_at`） |
| **Canonical table/file** | `state.db::activations`；DDL `sqlite-connection.ts:439` |
| **Canonical writer** | **两条生产写能力，语义分层**：①`activation-dispatcher.ts:385` → `SqliteActivationStateStore.recordActivation`（`:86` `INSERT OR REPLACE`，**建行/重激活**）；②`SqliteActivationSafetyStore.commitPromotion`（`:255` `INSERT` 新行 + `:403/407` UPDATE） |
| **Other write-capable API** | `sqlite-activation-state-store.ts:163`（`deactivateActivation`，UPDATE `deactivated_at`）；`sqlite-activation-state-store.ts:170-218`（`promoteActivation`，**shadow→live 第二写者，test-only**）；`sqlite-activation-safety-store.ts:208-209`（`deactivateWithDecision`）；`pd-cli legacy-cleanup.ts:219`（DELETE） |
| **Production caller** | dispatcher（Console/CLI/auto-consumer 三入口共用）；safety store 由 `RuleCodeOwnerDecisionService` / Console `ActivationsConsoleModel` 调用 |
| **Test-only caller** | `promoteActivation`：`j10-rule-governance-states.test.ts:129`、`rule-host-cache-invalidation.test.ts:156`、`gate-rule-context-v2.vm-e2e.test.ts:178`、`rulehost-seed-mvp-e2e.test.ts:883`、`cross-package-acceptance.test.ts:478`、`sqlite-activation-state-store.test.ts:262+`、`runtime-activation.test.ts:77`（mock） |
| **Console path** | `routes/activations.ts`（dispatch / promote / emergency-deactivate / disable）；`ActivationsConsoleModel.ts` |
| **CLI path** | `pd runtime activation dispatch / promote / deactivate / list` |
| **Repair path** | `legacy-cleanup.ts`（DELETE，清理命令）；`recoverToShadow`（safety store `:253`） |
| **Owner authorization** | **不一致**：promote 需 `configured_owner` + token（`rulecode-owner-decision-service.ts:96-99`）；`/:id/disable` 与 `pd activation deactivate` **不需要**（见 §6 NEW-D1） |
| **Immutable/mutable** | mutable（`action` 可被 promote 翻转、`deactivated_at` 可置位）；无 DDL 触发器 |
| **判定** | ⚠️ **PARTIAL**：生产 writer 唯一性成立，但存在**授权强度不对称**与 **test-only 第二 live 写者** |
| **CNB 侧漂移影响** | 无 |

---

### 4.7 Shadow→live

| 字段 | 内容 |
|---|---|
| **Fact** | `activations.action` 从 `code_tool_hook_shadow_activate` → `code_tool_hook_live_activate` |
| **Canonical table/file** | `state.db::activations.action` |
| **Canonical writer** | `sqlite-activation-safety-store.ts:407`（`commitPromotion`，BEGIN IMMEDIATE 单事务，同事务写 evidence snapshot + decision + supersede + control CAS） |
| **Other write-capable API** | **`sqlite-activation-state-store.ts:201`（`promoteActivation`）**：一次 UPDATE 即完成 shadow→live，**无 Owner 决策、无 evidence snapshot、无 `activation_decisions` 行、无 control-state CAS**；`RuleHostWriter.activate`（`rule-host-writer.ts:361-363`）恒返回 `shadow_activate`——**不是 live 写者，而是 shadow 保障** |
| **Production caller** | `RuleCodeOwnerDecisionService.promote`（`:124-132`）→ Console `ActivationsConsoleModel.ts:636-646` / CLI `runtime-activation.ts:624-661` |
| **Test-only caller** | `promoteActivation` 全部调用点在 tests（§4.6 已列，**生产零调用者**，本 Worker 逐一打开 `git grep` 全部 25 处引用确认） |
| **Console path** | `POST /api/v1/activations/:id/promote`（需 owner + artifactDigest + controlVersion + confirmed） |
| **CLI path** | `pd runtime activation promote --activation-id … --confirm`（需 `cli_owner_credential` + `--note`） |
| **Repair path** | `recoverToShadow`（safety store `:253`，反向） |
| **Owner authorization** | **需要**：`authenticatedOwner` 判定（`rulecode-owner-decision-service.ts:96-99`）+ readiness 10 项 + digest 绑定 + evidence snapshot 绑定 |
| **Immutable/mutable** | live 状态可被 emergency-deactivate / recover-to-shadow 撤销 |
| **判定** | ✅ **CONFIRMED（生产路径）** + ⚠️ **PARTIAL（构造性）**：`promoteActivation` 是一条仅靠「无人接线」成立的第二 live 写者 |
| **重要 DRIFT** | `rule-host-writer.ts:349-354` 注释声称「The only shadow -> live transition is … `SqliteActivationStateStore.promoteActivation`」——**该注释指向的正是 test-only API**。生产唯一 live 写者实为 `commitPromotion`。属注释与实现漂移（见 §6 NEW-D4） |
| **CNB 侧漂移影响** | 无 |

---

### 4.8 Deactivation

| 字段 | 内容 |
|---|---|
| **Fact** | `activations.deactivated_at` + 不可变 `activation_decisions` 行 |
| **Canonical table/file** | `state.db::activations.deactivated_at`；`state.db::activation_decisions`（DDL `sqlite-connection.ts:502`，含 `no_update`/`no_delete` 触发器 `:538-541`） |
| **Canonical writer（带审计）** | `sqlite-activation-safety-store.ts:175-215`（`deactivateWithDecision`）→ UPDATE `:208-209` + INSERT decision `:193` |
| **Canonical writer（无审计）** | `sqlite-activation-state-store.ts:163`（`deactivateActivation`，**仅 UPDATE `deactivated_at`**） |
| **Other write-capable API** | `sqlite-activation-safety-store.ts:403`（supersede 时对旧行置 `deactivated_at`）；`pauseAllLive`（`:133-152`） |
| **Production caller** | 带审计：Console `emergency-deactivate`（`routes/activations.ts:109`）/ `reject-after-shadow`；无审计：Console `/:id/disable`（`:184`）、CLI `pd activation deactivate`（`runtime-activation.ts:434`） |
| **Test-only caller** | 无（两条路径均生产可达） |
| **Console path** | 两条：`/:id/emergency-deactivate`（要求 owner）+ `/:id/disable`（**不要求**，`routes/activations.ts:140-195`） |
| **CLI path** | `pd activation deactivate`（无 owner 门，仅写 `.pd/logs` 审计文本 `runtime-activation.ts:408-419`） |
| **Repair path** | supersede 自动停用旧行（`commitPromotion` 内） |
| **Owner authorization** | **严重不对称**：`deactivateWithDecision` 要求 `configured_owner` 或 `break_glass`（`:177-182`）；`deactivateActivation` 无任何身份要求 |
| **Immutable/mutable** | `deactivated_at` 置位后不可复位（`WHERE deactivated_at IS NULL` 守卫）；`activation_decisions` **DDL 级不可变** |
| **判定** | ⚠️ **PARTIAL**：同一事实（停用）有两条写路径，授权强度不一致（见 §6 NEW-D1） |
| **CNB 侧漂移影响** | 无 |

---

### 4.9 Rollback

| 字段 | 内容 |
|---|---|
| **Fact** | ①approval 回滚（`resetToPending`）；②owner-resolution 回滚（`rollbackPendingResolution`）；③promote 失败回滚（事务 ROLLBACK）；④recover-to-shadow |
| **Canonical table/file** | `approvals.status`、`tasks.diagnostic_json.ownerResolutions`、`activations.action`、`activations.deactivated_at` |
| **Canonical writer** | ①`sqlite-approval-store.ts:263`；②`routes/owner-decisions.ts:217-233`；③`sqlite-activation-safety-store.ts:418`（`db.exec('ROLLBACK')`，位于 `:417` 的 catch 块内）；④`sqlite-activation-safety-store.ts:253` |
| **Other write-capable API** | `recoverToShadow` 走 safety store 单事务（`:247-259`），无第二实现 |
| **Production caller** | ①`ApprovalsConsoleModel.ts:177` / `runtime-activation.ts:1417,1446`；②Console resolve 失败路径；③promote 失败路径；④Console `recover-to-shadow` |
| **Test-only caller** | 无 |
| **Console path** | 全部四条可达 |
| **CLI path** | ① 可达（approve 失败回滚）；③ 可达 |
| **Repair path** | ③ 是 repair 的核心机制（事务原子性） |
| **Owner authorization** | ①③ 继承其触发动作的授权；② 需 reviewKey；④ 需 owner + controlVersion |
| **Immutable/mutable** | 各回滚路径均有前置条件守卫（如 resetToPending 只服务 `approved`） |
| **判定** | ✅ **CONFIRMED**：无第二回滚实现，均复用各自权威 store 的事务 |
| **CNB 侧漂移影响** | 无 |

---

### 4.10 Runtime control state

| 字段 | 内容 |
|---|---|
| **Fact** | `activation_control_states`（`enforcement` ∈ eligible/safety_isolated + `version` CAS） + `global_rulecode_pauses` |
| **Canonical table/file** | `state.db::activation_control_states`（DDL `sqlite-connection.ts:545`）、`state.db::global_rulecode_pauses`（`:568`） |
| **Canonical writer** | `sqlite-activation-safety-store.ts:301`（isolate）、`:411`（`version = version + 1` CAS bump）、`:140/163`（global pause/release decision） |
| **Other write-capable API** | ①`sqlite-activation-state-store.ts:96`（`INSERT OR IGNORE` 建 eligible 行，channel='code_tool_hook'）；②`sqlite-connection.ts:762`（schema v002 一次性迁移回填，受 `getSchemaVersion() < '002'` 守卫） |
| **Production caller** | ①dispatcher → `recordActivation`（每次激活建行）；②初始化迁移；③safety store 由 Owner 决策服务调用 |
| **Test-only caller** | 无 |
| **Console path** | pause / release / recover-to-shadow（均要求 owner） |
| **CLI path** | `pd runtime activation` 治理子命令 |
| **Repair path** | DDL 迁移回填（一次性） |
| **Owner authorization** | 变更（isolate / CAS bump / pause）需 Owner；**建行不需要**（激活时自动建 eligible） |
| **Immutable/mutable** | mutable，但 `version` 提供乐观并发控制（CAS） |
| **判定** | ✅ **基本成立**：建行有两个写者但语义不冲突（一是激活时自动建 eligible，二是一次性迁移回填）；变更权限集中在 safety store |
| **CNB 侧漂移影响** | 无 |

---

### 4.11 附加：canonical pain 的下游（诊断任务）写入者

| 字段 | 内容 |
|---|---|
| **Fact** | `pain_events.runtime_task_id`（pain → 诊断任务的绑定） |
| **Canonical table/file** | `trajectory.db::pain_events.runtime_task_id` + `tasks`（`state.db`） |
| **Canonical writer** | `governance-signal-admission.ts`（admission marker + `ensureGovernanceDiagnosticianTask` `:853-945`，幂等） / `PainToPrincipleService`（OpenClaw 侧） |
| **Other write-capable API** | 无第二实现（两宿主共用同一 core 服务） |
| **Production caller** | 两宿主入口 |
| **判定** | ✅ **CONFIRMED**（跨库无法共享事务，靠幂等 + admission marker 收敛，与 REPORT 结论一致） |
| **CNB 侧漂移影响** | 无 |

---

## 5. Confirmed / Fixed / Drifted（对 §5 Carry-forward 各项的裁决）

### 5.1 R-20（P2）Console「停用」按钮路径授权不对称

**裁决：CONFIRMED（基线 `cdec05d4b` 仍成立）**

- 弱路径：`POST /api/v1/activations/:id/disable`（`packages/pd-console/src/server/routes/activations.ts:138-195`）。
  - `:139` 正则匹配；`:177` 仅 `validateDisableRequest`（校验 `confirmed:true`，源码 `:25-33`）；`:184` 调 `model.deactivateActivation(activationId)`——**全文无 `authority` / `ownerActor` 参与**。
  - 终局：`SqliteActivationStateStore.deactivateActivation`（`sqlite-activation-state-store.ts:160-168`）——仅 `UPDATE activations SET deactivated_at = ?`。
- 强路径对照（同一页面）：`routes/activations.ts:90` 的 mutation 正则含 `emergency-deactivate`；`:101` 强制 `owner_authentication_required`（403 + nextAction）；`:109` → `deactivateRuleCode` → `deactivateWithDecision`（`sqlite-activation-safety-store.ts:175-182`，要求 `configured_owner` 或 `break_local_glass`）→ 写 `activation_decisions` 不可变行。
- **额外发现（历史未记录）**：CLI **第三条**弱路径 `pd activation deactivate`（`packages/pd-cli/src/commands/runtime-activation.ts:382-460`，命令注册 `:1549`），同样走 `deactivateActivation`，只写 `.pd/logs` 文本审计（`:408-419`），不写 `activation_decisions`、不查 control state、不要求 owner credential。历史 NEW-5 只覆盖 Console 一条。
- 影响面：同一 UI 页面上两条停用路径授权强度不一致；弱路径不落治理审计行、不校验 `activation_control_states`。
- **严重度 P2**（Owner 信任/审计面缺口；无旁路放行、不改变 enforcement，故不宜 P1）。

### 5.2 R-26（P2）第二条 live writer / skill 通道无 writer

**裁决：CONFIRMED（两项均已在 current main 定位到符号）**

**(a) 第二条 shadow→live 写者**

- 符号：`SqliteActivationStateStore.promoteActivation`（`packages/principles-core/src/runtime-v2/activation/sqlite-activation-state-store.ts:170-218`）。
- live 写点：`:201` `SET action = 'code_tool_hook_live_activate', promoted_at = ?`。
- 绕过面（本 Worker 逐条验证）：不写 `activation_decisions`（全文件无 INSERT）、不写 evidence snapshot、不查 `activation_control_states`、无 owner 入参。
- 生产可达性：**零生产调用者**。`grep -rn "promoteActivation" packages/` 共 25 处引用，除定义（`:170/:196/:209`）与本报告之外的注释（`rule-host.ts:521`、`rule-host-writer.ts:352`、`architecture-regression.test.ts:2437`）外，**调用点全部在 tests**（6 个测试文件）。
- 该 API 不在 `ActivationStateReadModel` 接口（`activation-types.ts:90-97`）内。
- 与 §4.7 的 DRIFT 组合：`rule-host-writer.ts:349-354` 的注释把它描述为生产唯一 shadow→live 路径——**注释与实现反向**。

**(b) skill channel 无 writer**

- `ChannelWriter` 实现全仓只有 3 个：`PromptWriter`（`low-risk-writers.ts:33`）、`DeferArchiveWriter`（`:61`）、`RuleHostWriter`（`writers/rule-host-writer.ts`）。
- `writers/index.ts` 只导出 `RuleHostWriter`；全仓无 `SkillWriter` 或 `channel='skill'` 的 writer 实现。
- 而 `AUTO_PROMOTABLE_CHANNELS = ['skill']`（`activation-types.ts:17`）存在。
- 终局：`activation-dispatcher.ts:352-354` `if (!writer) return { decision: 'refused', reason: 'no_writer_for_channel_' + input.channel }` → `no_writer_for_channel_skill`。
- 结论：skill + conf≥0.95 的「自动豁免审批」例外**在 dispatch 层实际无法产出激活**。

### 5.3 R-07（P2）同一诊断任务两条入口 retry 预算语义相反

**裁决：CONFIRMED**

- `onPainDetected`（`pain-signal-bridge.ts:435`）：对已存在的非终态任务，`:516` 直写 `attemptCount: 0`（`:512-519` 的 `updateTask` patch，条件分支 `:510` 的 `else`——即 status 非 succeeded、非未过期 leased 时）。
- 同文件「预算神圣」语义：`:553-557` 注释「Unlike `onPainDetected` this NEVER resets task state: a worker retry loop must preserve the retry budget (attemptCount/maxAttempts) exactly」；`:580` 注释同旨。
- 另有两处 `attemptCount: 0`：`:427`（`submitPainSignal` 建任务，语义正确）、`:454`（capability-disabled 分支**不**重置——`:443-444` 注释明确「keeps its status, attemptCount, … untouched」；此处 `:454` 是 `existing === null` 时的建任务，语义正确）。
- 结论：`:516` 是唯一「清零已存在任务预算」的点，与同文件 worker 路径语义矛盾。
- **严重度 P2**（可能使 maxAttempts=3 约束失效，导致诊断任务被无限重跑）。

### 5.4 R-12（P2）PendingTermStore 无生产写入者、Console 端点全 stub

**裁决：CONFIRMED（且比历史记录更彻底）**

- 类型定义：`packages/principles-core/src/runtime-v2/signal-collector/types.ts:29`（`source: 'llm_candidate'`）、`:32`（`PendingTermStore`）。
- 写入者：全仓 `llm_candidate` 命中仅 4 处，全在类型/校验器（`signal-keywords-types.ts:37/50`、`signal-keywords-validators.ts:128`、`signal-collector/types.ts:29`）——**零生产者**。
- Console 端点：`packages/pd-console/src/ui/utils/signal-keywords-api.ts:38-48`（`listActiveSignalKeywords`）、`:57-66`（`listPendingSignalTerms`）、`:80-91`（`fetchKeywordStore`）、`:97-107`（`fetchPendingTerms`），全部硬编码 `reason: 'endpoint_not_implemented'`。
- **额外发现**：`find packages/pd-console/src/server -name "*signal*"` 返回空，`grep -rn "signal-keywords" packages/pd-console/src/server/**` 零命中——**服务端根本没有该路由**（不只是 stub，而是完全缺席）。历史 VERIFICATION-D 表述为「Console SignalKeywords 页全部端点为 stub」，本 Worker 收紧为「Console 服务端无该路由」。

### 5.5 R-23（P2）`tasks.attempt_count` 与 `runs.attempt_number` 双源不一致

**裁决：CONFIRMED（本 Worker 深入，含精确双源与触发路径）**

双源事实：

- **源 A — `tasks.attempt_count`**：写入者 `sqlite-task-store.ts:146/202`（经 `updateTask` patch）、`lease-manager.ts:158`、`recovery-sweep`（不写）、`internalization-integrity-remediation.ts:771`（repair 直写 0）。
- **源 B — `runs.attempt_number`**：写入者 `lease-manager.ts:164`（`INSERT INTO runs … attempt_number`），值由 `:151-154` `SELECT attempt_number FROM runs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1` + 1 决定（**自引用递增**）。
- **关键耦合**：`lease-manager.ts:158` 在 acquire 时把**源 B 派生值**写回源 A：`SET … attempt_count = ?`（`:158`，值 = `attemptNumber` = `MAX(runs.attempt_number)+1`）。

不一致窗口（revision 场景，任务书指定）：

1. `revision-reopen.ts:108-115`：单次 `updateTask({status:'pending', attemptCount:0, diagnosticJson})` → **源 A 归零**，但 `runs` 表历史不动。
2. 下一次 `lease-manager.acquireLease`：源 B 读到仍在的 `MAX(runs.attempt_number)`（例如 3）→ `attemptNumber = 4` → **把 4 写回源 A**。
3. 结果：`revision-reopen` 的语义（「修订轮 = 新 execution epoch」）被静默撤销——归零后立刻被源 B 的重算覆盖。

同类重置点均受影响：`owner-retry.ts:108`（`attemptCount: 0`）、`pain-signal-bridge.ts:516`。

下游消费者影响（rc-7 面）：

- `pitask-metadata.ts:258-262` `isFreshForNextAttempt`（`:258-262`）：判据 `record.sourceAttemptCount === currentLeasedAttempt - 1`。`sourceAttemptCount` 由写入侧取 `task.attemptCount`（注释 `:218`），而 `currentLeasedAttempt` 来自 lease 派生（源 B）。**两个不同源的数值做减法**，双源不一致时新鲜度判定会误判（旧错误被回喂，或新错误被抑制）。
- 反向：`lease-manager.ts:151-154` 注释自认「Determine next attempt number from existing runs (most reliable)」——承认 `tasks.attempt_count` 不可靠，却在 `:158` 又用它作为回写目标。

- **严重度 P2**（状态语义不一致，可能导致错误的治理/排障结论；`isFreshForNextAttempt` 是真实消费者）。

### 5.6 approval `cancelled` 状态是否仍无 writer

**裁决：CONFIRMED（无权威写者）**

- 类型/守卫面存在：`sqlite-approval-store.ts:26`（`isApprovalStatsKey` 含 `'cancelled'`）。
- 白名单面存在：`routes/approvals.ts:69`（查询白名单）。
- **写入面为零**：全仓 `INSERT INTO approvals` / `UPDATE approvals` 共 5 个生产写点（均在 `sqlite-approval-store.ts:157/232/248/263/274`），**没有任何一条写 `'cancelled'`**（写的是 `pending`/`approved`/`rejected`）。
- 结论：`cancelled` 是无生产写入者的类型残留。历史 REFUTED（R-c）成立且仍成立。

### 5.7 Console approval 是否仍是唯一人工批准入口

**裁决：不成立 —— 存在 2 条人工批准入口（Console + CLI）**，两者均**无 Owner 身份门**。

全部能写 approval 的生产路径（逐条列）：

| # | 路径 | 入口 | `decidedBy` | Owner 门 |
|---|---|---|---|---|
| 1 | `routes/approvals.ts:146` → `ApprovalsConsoleModel.approve` → `queue.approve` | Console `POST /api/v1/approvals/:id/approve` | 硬编码 `'operator'` | **无** |
| 2 | `routes/approvals.ts:205` → `model.reject` | Console `POST /api/v1/approvals/:id/reject` | 硬编码 `'operator'` | **无** |
| 3 | `routes/approvals.ts:260` → `model.editApproval` | Console `POST /api/v1/approvals/:id/edit` | 硬编码 `'operator'` | **无** |
| 4 | `runtime-activation.ts:1307` → `queue.approve` | CLI `pd runtime activation approve` | `opts.decidedBy ?? 'cli-operator'`（`:1264`） | **无** |
| 5 | `activation-dispatcher.ts:276-338`（入队） | auto-consumer / CLI dispatch | system | 不适用（入队非裁决） |

- 对照：同仓的 **promote**（`rulecode-owner-decision-service.ts:96-99`）与 **emergency-deactivate**（`sqlite-activation-safety-store.ts:177-182`）**都**要求 `configured_owner` + credential。
- 结论：Console 不是唯一人工批准入口（CLI 亦可），且**两条入口都不校验 Owner**。这是与 REPORT F-E9「approvals 表单一 store 实现无第二真相」不冲突的**另一维度**问题：单一 store ≠ 单一授权强度。
- **严重度 P2**（approval 是「低风险通道的人工闸门」；其弱授权与 promote 的强授权形成同类不对称，但 approve 本身不会直接 live 激活 RuleCode——`RuleHostWriter.activate` 恒返 shadow，故不等于绕过 live gate）。

### 5.8 recovery 路径是否能绕过 owner gate

**裁决：PARTIAL —— recovery 本身无 owner gate（设计如此），但它不绕过治理 owner gate。**

证据：

- `recovery-sweep.ts:74-131`（`recoverTask`）：**全文无 owner / authority 判据**，只有机械判据（`status !== 'leased'` 早退 `:90`、lease 未过期早退 `:91`、`retryPolicy.shouldRetry`、`workspace_dirty` 特例）。三条 UPDATE（`:104/:116/:124`）只改 `status` + `lease_*` + `last_error`。
- 为什么这是可接受的：recovery 只把 **leased → retry_wait / failed / needs_human_review**，即只在**既有授权边界内**恢复。它不产生新的治理裁决（不写 `activation_decisions`、不写 `runnerDecision`、不改 `activation_control_states`）。
- 「绕过」的实际检查点：`owner-retry.ts:91-99` 才是 owner gate（`decision-capable` 或 pending resolution 时**拒绝** reset）——recovery-sweep **不走** `owner-retry`，但也不**替代**它：recovery 的输出是 `needs_human_review`（等待 Owner），而 `owner-retry` 的输入是 `needs_human_review`。两者是串联，不是旁路。
- **但存在一处真实绕过**：`internalization-integrity-remediation.ts:771`（repair）裸 SQL `UPDATE tasks SET status='retry_wait', attempt_count=0, …`。它**不经** `updateTask`、**不查** `canTransitionTo`、**不查** owner-retry 的 decision-capable 门。`failed` 是 `canTransitionTo` 定义的**终态（无出边）**，故该 repair 是**唯一能把 failed 拉回 retry_wait 的路径**（对应 REPORT §2 F5「failed→pending 无 guard 授权」）。
- 附加：`recovery-sweep.ts:104` 也把 `leased → needs_human_review`，这是 `canTransitionTo` 允许的边，无问题。
- 结论：**recovery 不绕过 owner gate；repair（integrity-remediation）构成一条绕过状态机 guard 的写路径**。
- **严重度 P2**（repair 是治理恢复工具，非恶意面；但它使 `canTransitionTo` 的 fail-closed 保证在恢复场景下失效）。

### 5.9 R-19 的 D 面（runtime 执行未批准代码/规则的路径）

**裁决：CONFIRMED（两条路径均已精确定位）+ NEW（第三条）**

R-19 的机制（本 Worker 复核，不重复威胁叙述）：`vm.createContext(Object.create(null))` 隔离的是**沙箱内新建对象的原型链**，但**注入进去的宿主 realm 对象**（`input` / `helpers`）仍携带宿主 `Object.prototype.constructor`，故 `input.constructor.constructor('return process')()` 可取宿主 `process`。

**路径 1 — evaluator 确定性对抗重放 gateDeps**

- 文件：`packages/principles-core/src/runtime-v2/activation/production-gate-deps.ts`
- compile：`:86-106`。`vm.createContext` `:91`；`new vm.Script(normalizeSource(code))` `:92`；`runInContext` `:94`。
- **注入点（漏洞本体）**：`:107-112`
  ```
  return (input: RuleHostInput, helpers: RuleHostHelpers): RuleHostResult => {
    const result = Reflect.apply(evaluateFn, undefined, [input, helpers]) as unknown;
  ```
  宿主 realm 的 `input` / `helpers` 作为参数直接进入 vm 内函数。
- 生产调用链：`compileRuleCode` 由 `:214`（`evaluateCode = compileRuleCode(code, 'production-gate-deps')`）消费；上层是 evaluator 的 deterministic adversarial replay（`executeDeterministicReplay` / `runAdversarialReplay`，见 REPORT §5 evaluator 卡）。
- 受影响面：**评估路径**（adversarial replay 时执行候选 rule 源码）。

**路径 2 — refiner sandbox wrapper**

- 文件：`packages/principles-core/src/runtime-v2/internalization/refiner-sandbox-wrapper.ts`
- 注入点：`:153-159`（`createSyntheticRuleHostInput(...)` 造宿主 realm `input`）；helpers 字面量 `:161-167`；执行点 `:171`（`const result = evaluateFn(input, helpers);`，位于 `:170` 的 `try {` 之后）；错误分类 `:172-186`。
- 无自己的 `vm.createContext`——它**接收**由调用方注入的 `evaluateCode`。
- 生产调用链：`rulehost-pipeline-runner.ts:246`（`return evaluateInRefinerSandbox(code, goldenTrace, { evaluateCode, ...opts })`；其上游 `:245` 调 `compileDemoRule`）。
- 受影响面：**激活预检路径**（adversarial loop 的沙箱评估）。

**路径 3（本 Worker 新增发现）— pd-cli `run-rulehost` 命令**

- 文件：`packages/pd-cli/src/services/rulehost-pipeline-runner.ts:235-248`（`createSandboxGateDeps`）
- compile：调 `compileDemoRule`（`packages/pd-cli/src/services/demo-rule-compiler.ts:46-72`）：`vm.createContext` `:46`、`new vm.Script` `:47`、`runInContext` `:51`。
- 注入点：`demo-rule-compiler.ts:61-62`
  ```
  return (input: RuleHostInput, helpers: RuleHostHelpers): RuleHostResult => {   // :61
    const result = evaluateFn(input, helpers);                                    // :62
  ```
  **与路径 1 是同一模式**（该文件头注释亦自认 `Mirrors createReplayEvaluateFromCode in openclaw-plugin`）。
- 执行点：`rulehost-pipeline-runner.ts:246`（`return evaluateInRefinerSandbox(code, goldenTrace, { evaluateCode, ...opts })`）。
- 生产可达性（本 Worker 验证）：`runtime-internalization-run-rulehost.ts:274`（`gateDeps: createSandboxGateDeps()`）→ `:611`（`runRuleHostPipeline`）；命令注册 `pd-cli/src/index.ts:40` import + `:773` `registerRunRuleHostCommand(internalizationCmd)`；命令名 `:666` `.command('run-rulehost')`。
- 文件头 `:1-20` 自述「**This is the production entry point for the code_tool_hook channel.**」
- 受影响面：**激活预检路径**，但入口是**生产 CLI 命令**（`pd runtime internalization run-rulehost`），不是仅供测试的 demo。与路径 2 共享 `evaluateInRefinerSandbox`，但用的是**另一份独立 compile 实现**（`demo-rule-compiler.ts`，非 core 版）。

**对照 — 正确做法（证明「未批准代码隔离」是可构造的）**

- `packages/host-runtime/src/rule-implementation-runtime.ts:17-33`（生产 live gate 子进程）
  ```
  // Sandbox boundary: hand the context ONLY a primitive JSON string and
  // build the call input + helpers with the context's own intrinsics.
  // Passing host-realm objects … would let rule source walk
  // .constructor.constructor back to the host realm's Function constructor …
  context.__pdInputJson = JSON.stringify(workerData.input);
  new vm.Script('const __pdCallInput = JSON.parse(globalThis.__pdInputJson); …')
  ```
  同模式亦见 `openclaw-plugin/src/core/rule-implementation-runtime.ts:33-46`。
- 即：宿主侧通过 **primitive JSON 字符串**跨界，调用侧用**沙箱自身 intrinsic** 重建对象。前三条路径未采用该模式。

**结论（事实登记，不提修复方案）**：

- 受影响 runtime 是 **core 的 evaluator/refiner 评估与激活预检路径**（路径 1、2）与 **pd-cli 的 run-rulehost 生产命令**（路径 3）。
- 生产 **live gate 走子进程**（`host-runtime/src/rule-implementation-runtime.ts`），不受影响——与本 Worker 复核结果一致。
- 静态禁门（`internalization/rule-code-validator.ts:27-47` 的 `\bconstructor\b` 等 + `:49` bracket-access 规则）仍是**文本匹配**，非 AST/归一化判定，故字符串/模板拼接可绕过；这与「宿主 realm 注入」是**两个独立事实**，本报告只登记两者均存在。

### 5.10 其他历史项复核

| 历史项 | 裁决 | current main 证据 |
|---|---|---|
| F-E9#1 approvals 单一 store 无第二真相 | CONFIRMED（含限定） | 生产 store 唯一（`sqlite-approval-store.ts`）；限定：`legacy-cleanup.ts:224` 是清理 DELETE 写者 |
| F-E9#2 promote supersede/recover/emergency 同事务 | CONFIRMED | `sqlite-activation-safety-store.ts:366-419`（COMMIT `:415`，ROLLBACK `:418`） |
| F-E9#3 Owner 裁决机判值永不改写 | CONFIRMED | `runnerDecision` 只由 runner 写；`activation_decisions` DDL 触发器不可变（`sqlite-connection.ts:538-541`） |
| F-E9#4 shadow→live 无旁路 | PARTIAL（构造性依赖未接线） | `promoteActivation` 存在但 test-only（§4.7 / §5.2a） |
| F5 failed→pending 无 guard 授权 | CONFIRMED | `canTransitionTo:129-130` `case 'failed':` → `return false`；但 `internalization-integrity-remediation.ts:771` 裸 UPDATE 绕过 |
| Codex 无 `rulehost_evaluated` 事件（R-22） | CONFIRMED | `hooks/gate.ts:117/134` 仅 OpenClaw；`production-rulehost-gate.ts` 全文无事件写入 |

---

## 6. NEW Findings

> 每条：ID / Severity / Claim / Evidence / Why it matters / Affected stage / Current protection。
> 只对「历史未记录」或「历史记录不足」的事实编号。R-19 第三路径与 CLI 弱停用路径为本 Worker 新增。

### NEW-D1【P2】停用事实存在三条写路径，其中两条（Console `/disable`、CLI `deactivate`）无 Owner 授权且不写治理审计行

- **Claim**：`activations.deactivated_at` 是同一治理事实，但有 3 条生产写路径，授权强度分两档。强档写不可变 `activation_decisions`；弱档只改一行 + （CLI）写 `.pd/logs` 文本。
- **Evidence**：
  - 强：`routes/activations.ts:101`（owner 403 门）→ `:109` → `sqlite-activation-safety-store.ts:175-215`（`deactivateWithDecision`，owner/break-glass 判据 `:177-182`，INSERT decision `:193`）。
  - 弱 1：`routes/activations.ts:138-195`（`/:id/disable`，无 owner）→ `ActivationsConsoleModel.ts:693` → `sqlite-activation-state-store.ts:160-168`（仅 UPDATE）。
  - 弱 2：`pd-cli/src/commands/runtime-activation.ts:382-460`（`pd activation deactivate`，命令注册 `:1549`）→ `:434` → 同一 UPDATE；仅 `:408-419` 写 `.pd/logs` 审计文本。
- **Why it matters**：停用是 Owner 可见的治理动作。弱路径不产生 `activation_decisions` 行 → 后续「为何这条 live 规则被停」在治理审计面**无记录**；也不校验 `activation_control_states` → 不参与 CAS 冲突检测。
- **Affected stage**：activation deactivation / rollback（治理审计面）。
- **Current protection**：无。历史 NEW-5 只覆盖 Console 一条；CLI 第二条为本次新增。
- **对比**：`recoverToShadow`（`:247-259`）与 `emergency_deactivate` 都要求 owner。

### NEW-D2【P2】`tasks.attempt_count` 与 `runs.attempt_number` 之间存在**双向耦合**的双源循环，revision/owner-retry 的归零被静默撤销

- **Claim**：不只是「双源不一致」，而是 `lease-manager` 把源 B 的派生值**回写**源 A（`:158`），造成归零语义被覆盖的闭环。
- **Evidence**：
  - 源 B 派生：`lease-manager.ts:151-154`（`MAX(attempt_number)+1`）。
  - 回写源 A：`lease-manager.ts:158`（`SET … attempt_count = ?`，值为派生值）。
  - 归零点：`revision-reopen.ts:111-115`、`owner-retry.ts:108`、`pain-signal-bridge.ts:516`（均为 `attemptCount: 0`）。
  - 消费不一致值：`pitask-metadata.ts:258-262`（`isFreshForNextAttempt` 用源 A 写入值 vs 源 B 派生值做减法）。
- **Why it matters**：`revision-reopen` 的注释（`:50-52`）明确「revision reopen = 新 execution epoch」，归零是该语义的承载；被覆盖后 attempt 语义与 revision epoch 语义脱钩。`isFreshForNextAttempt` 是真实消费者（决定是否回喂上次 validator 错误），误判会污染修复 prompt。
- **Affected stage**：task lifecycle / 修复环（retry & validator feedback）。
- **Current protection**：无。`schema-conformance.test.ts` / `sqlite-run-store.test.ts` 只测单表类型与容错，无跨表一致性测试。
- **补充**：历史 R-23 只标记「双源不一致」，未记录回写闭环与下游新鲜度消费者的具体耦合点。

### NEW-D3【P2】R-19 存在第三条同模式路径：`pd runtime internalization run-rulehost` 生产 CLI 命令

- **Claim**：除 core 侧两条 vm 预处理路径外，`pd-cli` 有一条**独立 compile 实现**的同类路径，且入口是自称 production entry point 的生产命令。
- **Evidence**：
  - `pd-cli/src/services/demo-rule-compiler.ts:46-72`（`vm.createContext` `:46` / `new vm.Script` `:47` / `runInContext` `:51` / **`:62` 注入宿主 `input`+`helpers`**）。
  - `pd-cli/src/services/rulehost-pipeline-runner.ts:235-248`（`createSandboxGateDeps`；`:245` 调 `compileDemoRule`、`:246` 调 `evaluateInRefinerSandbox`）。
  - `pd-cli/src/commands/runtime-internalization-run-rulehost.ts:1-20`（自述 production entry point）、`:274`、`:611`。
  - 注册：`pd-cli/src/index.ts:40, 773`；命令名 `runtime-internalization-run-rulehost.ts:666`。
  - 对照正确实现：`host-runtime/src/rule-implementation-runtime.ts:17-33`（JSON 字符串跨界）。
- **Why it matters**：历史 R-19 的影响面表述为「评估/激活预检路径」，未记录该路径同时由**生产 CLI 命令**驱动；且它是与 core 版**平行维护的第二份 compile 实现**（同一信任边界缺口出现两次，未来修复可能只改一处）。
- **Affected stage**：激活预检（code_tool_hook 通道的 rule 验证）。
- **Current protection**：同路径 1/2——静态禁门为文本匹配，非 AST。

### NEW-D4【P3】`rule-host-writer.ts` 注释把 test-only 的 `promoteActivation` 描述为生产唯一 shadow→live 路径

- **Claim**：生产代码注释与实现反向。
- **Evidence**：
  - 注释：`activation/writers/rule-host-writer.ts:349-354`——"The only shadow -> live transition is `pd activation promote …`, which atomically rewrites the action to `code_tool_hook_live_activate` inside a BEGIN IMMEDIATE transaction (`SqliteActivationStateStore.promoteActivation`)."
  - 实现：该 API 零生产调用者（§5.2a）；生产 live 写者是 `sqlite-activation-safety-store.ts:407`（`commitPromotion`）。
  - 同类注释：`rule-host.ts:521`。
- **Why it matters**：这是**给未来读者/Agent 的错误权威指向**。`AGENTS.md` P1「Evidence Over Assumption」场景下，注释会误导排障与审计（本 Worker 的第一轮判断即被该注释短暂误导，回源调用链后才纠正）。
- **Affected stage**：shadow→live 治理（可维护性）。
- **Current protection**：无（无注释-实现一致性测试）。

### NEW-D5【P3】`activation_control_states` 建行有两条写路径（激活自动建 + schema v002 迁移回填）

- **Claim**：该表的**行存在性**由两个写者决定，而非单一权威。
- **Evidence**：`sqlite-activation-state-store.ts:96-101`（`INSERT OR IGNORE … 'eligible', 1`，每次 `recordActivation`）与 `sqlite-connection.ts:756-767`（`INSERT OR IGNORE … SELECT … FROM activations WHERE channel='code_tool_hook'`，受 `getSchemaVersion() < '002'` 守卫的一次性迁移）。
- **Why it matters**：语义不冲突（都是 eligible 初始态 + `OR IGNORE`），但若未来有人在迁移里改默认 `version`，会与激活路径的硬编码 `1` 分叉。属 latent debt。
- **Affected stage**：runtime control state。
- **Current protection**：`OR IGNORE` + 迁移版本守卫；无跨写者一致性测试。

### NEW-D6【P3】`MemoryApprovalQueueStore` / `MemoryActivationStateStore` 已导出为公共 API，存在被误接为生产 store 的通道

- **Claim**：两个内存 store 均从 `activation/index.ts:54/82` 与 `runtime-v2/index.ts:1417/1433` 公共导出，且 `proven-channel-baseline.ts:181/275`（生产模块、公开 CLI 命令 `pd proven-channel-baseline`）确实在生产代码中构造了 `MemoryApprovalQueueStore`。
- **Evidence**：`index.ts:54/82`、`runtime-v2/index.ts:1417/1433`、`proven-channel-baseline.ts:181`、`pd-cli/src/index.ts:65/442`。
- **Why it matters**：该基线命令是 in-memory 夹具（不落 state.db，本 Worker 已确认文件内无 SqliteConnection/sqlite 引用），因此当前**无第二持久化真相**。但导出面 + 生产构造点意味着一旦某处误传入该 store，`approvals` 会写入一个不落库的 store 且**失败静默**（内存操作总成功）。属「test-only writer 可能被误接入」的可用通道。
- **Affected stage**：approval / activation store 装配。
- **Current protection**：`architecture-regression.test.ts:3041/3045` 断言源码中存在这两个 class 名（脆弱断言，不阻止生产接线）。

---

## 7. Protection Gaps（现有 test/guard 是否保护 writer 唯一性）

| 保护面 | 现有机制 | 是否覆盖 writer 唯一性 | Gap |
|---|---|---|---|
| `activation_decisions` 不可变 | DDL 触发器 `no_update` / `no_delete`（`sqlite-connection.ts:538-541`） | ✅ **强** | 无——「不可能改写」由 DB 强制，不依赖代码纪律 |
| `canonical_pain_id` 唯一 | 部分唯一索引（`trajectory.ts:388-391`） | ✅ **强** | 无 |
| approvals 单一 store | 运行时无关；`architecture-regression.test.ts:3045` 仅断言字符串存在 | ❌ **弱** | 无机制阻止新增第二个 store 实现或直写 SQL；`legacy-cleanup` DELETE 即为例外 |
| `tasks.status` 状态机 guard | `canTransitionTo`（`internalization-task-guards.ts:111-134`） | ❌ **弱（不是写入门）** | 唯一消费者是 `internalization-state-machine.ts:230`（决策层）；`updateTask` / `lease-manager` / `recovery-sweep` / `integrity-remediation` 均不调用。**无测试断言「所有 status 写点都过 guard」** |
| shadow→live 唯一写者 | 无 guard | ❌ **弱** | `promoteActivation` 仅靠「无调用者」；无类型隔离（它不在 ReadModel 接口，但 `SqliteActivationStateStore` 是具体类且被广泛注入） |
| 停用授权一致性 | 无 guard | ❌ **弱** | 三条路径无共享授权装饰器/中间件；无测试断言「deactivate 必须写 decision 行」 |
| `attempt_count` / `attempt_number` 一致性 | 无 guard | ❌ **无** | 无跨表一致性测试；`lease-manager` 的「回写」行为无断言 |
| Owner 授权语义（promote） | `rulecode-owner-decision-service.ts:96-99` + 生产测试 | ✅ **中** | 授权逻辑内联在服务里，非可复用中间件；无测试断言「所有 owner 级动作都过同一授权门」 |
| vm 沙箱边界 | `rule-code-validator.ts` 静态禁门（文本匹配） | ❌ **弱** | 无 AST 判定；无测试断言「宿主 realm 对象不得跨 vm 边界」 |
| Codex 宿主 shadow 证据 | 无 guard | ❌ **无** | 无跨宿主能力对等测试（R-22 结构性缺口） |
| 注释-实现一致性 | 无 | ❌ **无** | `rule-host-writer.ts:349-354` 即失效注释的活例 |

**总体判断**：writer 唯一性的保护呈**「DDL 层强、代码层弱」**的分布。凡是能用 DDL 表达的不变量（不可变、唯一）都可靠；凡是只能用代码纪律表达的不变量（谁可以写哪些列、经哪条路径）**基本无机械化保护**，依赖 review 纪律。

---

## 8. Suggested Contract Invariants

> 任务书要求：**只写 invariant，不写方案。** 以下为可供后续 Writer Guard 设计引用的不变量陈述，未指定实现手段。

**I-W1（One fact → one writer）**
每个治理事实必须存在唯一权威 writer；任何第二写能力若存在，必须是「类型级不可达」或「DDL 级被拒」，而非仅「当前无调用者」。

**I-W2（授权强度单调）**
同一治理事实的所有写路径必须携带**相同等级**的授权语义。不得出现「强授权路径存在 ⇒ 弱授权路径仍需存在」的并列形态。

**I-W3（状态机是写入门，不是校验辅助）**
状态转移白名单若存在，则每一个 status 写点必须经其校验；任何绕过（含 repair / migration / 裸 SQL）必须被显式标注为例外并附理由。

**I-W4（审计不可省略）**
凡影响 Owner 可见治理结论的写操作（activate / deactivate / promote / recover / isolate / pause），必须与一条不可变裁决行在同一事务内提交；缺少裁决行的写路径即视为不完整。

**I-W5（跨表计数字段单一来源）**
同一语义的计数/序号（如 attempt）不得同时由两张表独立拥有派生权；若必须跨表，必须定义唯一方向的派生关系并禁止反向回写。

**I-W6（信任边界对象不得跨 realm）**
执行未批准代码的 sandbox 必须在**原始类型**边界上接收数据；任何宿主 realm 对象（含 input/helpers 及其可达原型链）不得进入 sandbox 运行时。

**I-W7（宿主能力对等）**
治理闭环的每个环节若声明为「host-neutral」，则所有声明支持的宿主必须具备等价的证据产生与消费通道；缺失必须显式标记为「该宿主不可达」而非「无旁路」。

**I-W8（test-only 能力的类型隔离）**
仅用于测试的写能力不得与生产写能力共享可注入的接口形态；其不可达性必须由类型系统或模块边界保证。

**I-W9（注释指向可执行权威）**
描述写入路径的注释必须指向生产可达的符号；指向 test-only 或已废弃符号视为缺陷。

---

## 9. Out of Scope

以下事项**本报告未做、也未提出方案**（属其他 Worker 或后续工单）：

- **修复方案设计**（任务书 §4.4 明确要求「不要提修复方案」）。§8 仅列 invariant，不包含实现建议。
- **Reader / 投影一致性**（属 Worker A/B/C/E/F 面）：Console 读模型、governance projection、evidence snapshot 的读取语义。
- **Live 运行时取证**：未读取 `~/.pd/state.db` 或任何真实 workspace 数据库；全部判定基于静态源码与 DDL。因此「实际默认 flag 组合下的行为」未被观测（如 skill 通道是否真的从未被 dispatch）。
- **LLM 实测**：未验证任何 prompt 对模型的实际约束力。
- **未审计的事实的 writer**：`pi_artifacts`（R-24 覆盖）、`principle_candidates`、`intents`、`trajectory` 表族、`dead_letter_pains` 的完整 writer 矩阵——本次按任务书 §4.1 的 10 项事实集合收窄。
- **安全工单定级**：R-19 D 面只登记事实（受影响路径 + 精确行号 + 对照正确实现），未评估利用难度、未定级 P1/P2（历史已定 P1，本 Worker 不重复定级）。
- **跨宿主差异的完整比对**：仅登记 Codex 无 shadow 事件通道一项（因它直接决定 shadow→live 的可达性）；Codex/OpenClaw 的其他差异未系统枚举。
- **CNB 镜像侧的行为差异**：§2.2 已定位漂移面未触及 writer 权威文件，但未在 CNB 检出树上重跑全部断言。
- **Linear 工单关联**：零密钥姿态，未读写 Linear（本报告仅回应 CNB Issue #39）。
- **`.cnb/`、`packages/**`、`.github/**`、`AGENTS.md`**：未修改（章程 D1/D2）。

---

## 附录 A — 证据索引（按文件）

| 文件（相对仓库根，`cdec05d4b`） | 本报告引用的关键行 |
|---|---|
| `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts` | `224`(tasks) `271`(runs.attempt_number) `395`(approvals) `439`(activations) `502`(activation_decisions) `538-541`(不可变触发器) `545`(control_states) `568`(global pauses) `756-767`(v002 迁移) |
| `packages/principles-core/src/runtime-v2/activation/sqlite-approval-store.ts` | `26`(stats key 含 cancelled) `148-175`(入队) `232/248/263/274`(状态推进) |
| `packages/principles-core/src/runtime-v2/activation/sqlite-activation-state-store.ts` | `86`(INSERT OR REPLACE) `96`(control 建行) `160-168`(deactivate) `170-218`(promoteActivation，test-only) |
| `packages/principles-core/src/runtime-v2/activation/sqlite-activation-safety-store.ts` | `140/163/193/229/253/288/377/401`(decisions) `175-215`(deactivateWithDecision) `208-209` `255`(INSERT activations) `301/411`(control) `366-419`(commitPromotion 事务) |
| `packages/principles-core/src/runtime-v2/activation/activation-dispatcher.ts` | `276-338`(入队) `340-405`(activateArtifact) `352-354`(no_writer) `385`(recordActivation) |
| `packages/principles-core/src/runtime-v2/activation/rulecode-owner-decision-service.ts` | `89-174`(promote) `96-99`(owner 门) |
| `packages/principles-core/src/runtime-v2/activation/writers/rule-host-writer.ts` | `349-354`(失效注释) `361-363`(恒 shadow) |
| `packages/principles-core/src/runtime-v2/activation/writers/index.ts` | 全文（仅导出 RuleHostWriter） |
| `packages/principles-core/src/runtime-v2/activation/activation-types.ts` | `8`(低风险通道) `17`(AUTO_PROMOTABLE_CHANNELS) `90-97`(ReadModel) |
| `packages/principles-core/src/runtime-v2/store/lifecycle/lease-manager.ts` | `130-168`(acquireLease) `151-154`(MAX 派生) `158`(回写 attempt_count) `164`(INSERT runs) |
| `packages/principles-core/src/runtime-v2/store/lifecycle/recovery-sweep.ts` | `74-131`(recoverTask) `104/116/124`(三态 UPDATE) |
| `packages/principles-core/src/runtime-v2/store/task/sqlite-task-store.ts` | `107`(INSERT) `146/202`(attempt_count patch) |
| `packages/principles-core/src/runtime-v2/internalization/internalization-task-guards.ts` | `111-134`(canTransitionTo) |
| `packages/principles-core/src/runtime-v2/internalization/internalization-state-machine.ts` | `230`(canTransitionTo 唯一消费者) |
| `packages/principles-core/src/runtime-v2/internalization/revision-reopen.ts` | `50-52`(语义注释) `108-115`(归零单写) |
| `packages/principles-core/src/runtime-v2/internalization/owner-retry.ts` | `78` `84-100`(owner 门) `108`(归零) |
| `packages/principles-core/src/runtime-v2/internalization/owner-resolution-service.ts` | `171-173`(resolutionId) `244-297`(driveReviseOnce) `267-271` `314-530` `462-464`(effectiveDecision) |
| `packages/principles-core/src/runtime-v2/internalization/owner-review.ts` | `400-406`(唯一解析点) `605-608` |
| `packages/principles-core/src/runtime-v2/internalization/pitask-metadata.ts` | `218`(sourceAttemptCount 注释) `255-260`(isFreshForNextAttempt) |
| `packages/principles-core/src/runtime-v2/internalization-integrity-remediation.ts` | `771`(repair 裸 UPDATE) |
| `packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts` | `1684`(runnerDecision) |
| `packages/principles-core/src/runtime-v2/internalization/rollout-reviewer-runner.ts` | `1213`(runnerDecision) |
| `packages/principles-core/src/runtime-v2/internalization/rule-code-validator.ts` | `27-47`(禁模式) `49`(bracket access) |
| `packages/principles-core/src/runtime-v2/internalization/refiner-sandbox-wrapper.ts` | `153-159`(宿主 input) `161-167`(宿主 helpers) `171`(执行) |
| `packages/principles-core/src/runtime-v2/activation/production-gate-deps.ts` | `86-106`(compile) `107-112`(注入) `214`(调用点) |
| `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts` | `427/454/504/516`(attemptCount:0) `435`(onPainDetected) `553-557/580`(预算神圣注释) |
| `packages/principles-core/src/runtime-v2/signal-collector/types.ts` | `29`(llm_candidate) `32`(PendingTermStore) |
| `packages/principles-core/src/runtime-v2/proven-channel-baseline.ts` | `181`(in-memory 夹具) `275` |
| `packages/host-runtime/src/rule-implementation-runtime.ts` | `17-33`(正确 JSON 边界) |
| `packages/host-runtime/src/production-pain-evidence.ts` | `176/243`(pain 身份派生) `418`(落库) |
| `packages/host-runtime/src/governance-signal-admission.ts` | `509/703`(落库) `616-622/696-708`(host_kind 回填) `776`(Codex 入口) |
| `packages/openclaw-plugin/src/core/trajectory.ts` | `388-391`(canonical 唯一索引) |
| `packages/openclaw-plugin/src/core/rule-host.ts` | `521`(同类失效注释) |
| `packages/pd-console/src/server/routes/activations.ts` | `25-33`(disable 校验) `90` `101`(owner 门) `109` `138-195`(disable 弱路径) |
| `packages/pd-console/src/server/routes/approvals.ts` | `69`(白名单) `146/205/260`(硬编码 operator) |
| `packages/pd-console/src/server/routes/owner-decisions.ts` | `47-61` `211-234` |
| `packages/pd-console/src/server/models/ApprovalsConsoleModel.ts` | `156/177/478`(store 调用) `693`(disable 终局) |
| `packages/pd-console/src/ui/utils/signal-keywords-api.ts` | `38-48/57-66/80-91/97-107`(全 stub) |
| `packages/pd-cli/src/commands/runtime-activation.ts` | `382-460`(deactivate 弱路径) `434` `1231/1264/1307`(approve) `1549`(命令注册) |
| `packages/pd-cli/src/services/demo-rule-compiler.ts` | `46-72`(compile + 注入) |
| `packages/pd-cli/src/services/rulehost-pipeline-runner.ts` | `235-248`(createSandboxGateDeps) `245`(compileDemoRule) `246`(evaluateInRefinerSandbox) |
| `packages/pd-cli/src/commands/runtime-internalization-run-rulehost.ts` | `1-20`(production entry 自述) `274/611` |
| `packages/pd-cli/src/index.ts` | `40/773`(命令注册) |
| `packages/pd-cli/src/commands/legacy-cleanup.ts` | `219/224`(DELETE) |

## 附录 B — 判定计数

| 判定 | 数量 | 分布 |
|---|---|---|
| CONFIRMED | 14 | 4.1 / 4.3 / 4.4 / 4.5 / 4.9 / 4.10（基本）/ 4.11 + §5.1 / §5.2 / §5.3 / §5.4 / §5.5 / §5.6 / §5.9 / §5.10 六项 |
| PARTIAL | 4 | 4.2 / 4.6 / 4.7 / 4.8 + §5.7 / §5.8 |
| FIXED | 0 | 本 Worker 面内无「已在 current main 修复」的历史项 |
| DRIFTED | 2 | §2 基线漂移；§4.7 注释-实现漂移（NEW-D4） |
| NEW | 6 | NEW-D1 .. NEW-D6 |
| UNVERIFIABLE | 0 | — |

**One fact → one writer 违反项合计 8 条**：§4.2（task lifecycle，4 类写点）、§4.6（activation，双写 + 授权不对称）、§4.7（shadow→live，test-only 第二写者）、§4.8（deactivation，三路径不等授权）、§4.10（control state 建行双写者）、§5.5（attempt 双源）、§5.8（repair 绕过状态机 guard）、§5.9（vm 边界三路径 + 两份平行 compile 实现）。
