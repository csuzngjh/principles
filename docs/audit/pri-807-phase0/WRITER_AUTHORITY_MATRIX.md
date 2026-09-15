# PRI-807 Phase 0 · Worker D — State / Writer Authority 矩阵

> 类型：**只读审计产出**。本文件是唯一新增物。
> 基线：`audit/pri-807-phase0-base`
> 方法：枚举每个核心治理事实的全部写点 → 打开调用链区分生产 caller / test-only caller → 回源 current main。
> 判定词：CONFIRMED / FIXED / DRIFTED / PARTIAL / NEW / UNVERIFIABLE
> 证据优先级：生产代码 > schema / DB DDL > 生产测试 > 文档 > 注释 > 推断

---

## 1. Scope

回答一个问题：**每一个核心治理事实到底谁有权写？**

覆盖面：

* 是否存在 second writer / test-only writer 可能被误接入；
* CLI / Console / repair 三条入口是否在写同一状态；
* 哪些事实满足 **one fact → one writer**，哪些不满足；
* R-19 的 D 面（宿主编译/预处理路径把宿主 realm input/helpers 注入 vm）在 current main 的精确位置与调用链，是否还有第三条同类路径。

**不在范围内**：修复方案、架构建议、代码改动。§8 只写 invariant，不写实现。

---

## 2. Baseline

* 实际 checkout SHA：`cdec05d4bc4252151c7f9f118bdad90f25067594`
* 期望基线：`cdec05d4bc4252151c7f9f118bdad90f25067594`
* **BASELINE: SYNCED**
* 未发现 drift（`git rev-parse HEAD` 与任务书给定 SHA 逐字符一致）。
* 历史种子：`docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md`（§6 治理下游）与 `VERIFICATION-D.md` 存在于本 checkout，已作为历史事实种子使用；**全部判定已回源 current main 代码复核**。

---

## 3. Current Authorities（已有唯一权威写者的事实）

判定口径：**某一持久化位置的全部生产写点都汇聚到同一个方法 / 同一个事务边界，且不存在第二条可产出同一语义结果的写路径。**

| # | Fact | 唯一权威写者 | 结论 |
|---|---|---|---|
| A1 | `activation_decisions`（Owner 治理裁决，append-only） | `SqliteActivationSafetyStore.{pauseAllLive, releaseGlobalPause, deactivateWithDecision, recordOwnerDecision, recoverToShadow, safetyIsolate, commitPromotion}` | **CONFIRMED**：全部生产 `INSERT INTO activation_decisions` 都在这 7 个方法内（`sqlite-activation-safety-store.ts:140,163,193,229,253,288,377,401`），且每条各自 `BEGIN IMMEDIATE` + 写前身份断言；DB 层有 `no_update`/`no_delete` 触发器（`sqlite-connection.ts:541-544`）封住改写。 |
| A2 | `activation_evidence_snapshots`（promote 证据快照） | `commitPromotion`（`sqlite-activation-safety-store.ts:352-357`） | **CONFIRMED**：唯一 INSERT 点，同事务内；无 update/delete 触发器放行（`sqlite-connection.ts:564-567`）。 |
| A3 | `global_rulecode_pauses`（全局暂停） | `pauseAllLive` / `releaseGlobalPause` | **CONFIRMED**：两方法各单事务，且 partial unique index 保证同时最多一条 `paused`（`sqlite-connection.ts:579-580`）。 |
| A4 | `pi_artifacts.content_json`（PI 产物正文） | `SqlitePIArtifactStore.upsertArtifact`（`sqlite-pi-artifact-store.ts:75-108`） | **CONFIRMED**：全部 runner 写 artifact 都经 `upsertArtifact`（10 处调用，见 §4）；唯一旁路是 `pd-cli/scripts/migrate-illegal-expected-decision.ts:240` 的一次性历史迁移脚本（非运行期路径），与 `legacy-cleanup --apply` 的同事务 DELETE（见 §7 G3）。 |
| A5 | `commits` 表 | `DiagnosticianCommitter`（`store/commit/diagnostician-committer.ts:153`） | **CONFIRMED**：唯一 INSERT 点，`idempotency_key UNIQUE` + `run_id UNIQUE` 提供 DB 级幂等。 |
| A6 | `intent_doc_versions`（INTENT.md 快照） | `SqliteIntentDocVersionStore` | **CONFIRMED**：唯一实现，append-only（无 UPDATE/DELETE 生产写点）。 |
| A7 | `pending_agent_drafts` | `PendingAgentDraftStore`（`feedback/pending-agent-draft-store.ts`） | **CONFIRMED**：唯一实现，partial unique index 保证每 task 至多一条未消费草案。 |
| A8 | `principle_applications`（Receipt ledger） | `principle-application-ledger.ts`（3 处 `INSERT OR IGNORE`） | **CONFIRMED**：单一模块，双 partial unique index 落实 dedup；flag-off = 无写入（`feature-flag-contract.ts:375`）。 |
| A9 | `principle_tree` ledger 文件（`.state/principle_training_state.json`） | `principle-tree-ledger.ts`（`atomicWriteFileSync` + 跨进程文件锁） | **CONFIRMED**：模块头自述 single writer（`principle-tree-ledger.ts:387`），全部 mutation 经 `withLock` + 原子 rename。 |
| A10 | owner 身份文件 `~/.pd/owner.json` | `routes/owner-identity.ts`（POST register / DELETE unregister） | **CONFIRMED**：单一 HTTP 写点，仅存标识符不存密钥。 |

---

## 4. Contract Map（4.2 完整矩阵）

> 图例：`唯一` = 该位置只有这一处生产写者；`多重` = 存在 ≥2 条独立生产可写路径。
> 行号均相对本 checkout `cdec05d4b`。**test-only caller** 一列只列"能写真实持久化位置"的测试（内存 store / mock 不计）。

### F1 · canonical pain（`pain_events.canonical_pain_id` 为身份键）

| 字段 | 内容 |
|---|---|
| Fact | canonical pain 身份 + pain row |
| Canonical table | `trajectory.db::pain_events`（唯一身份约束 `idx_pain_events_canonical_pain_id`） |
| Canonical writer | **无单一权威写者**（5 条独立 INSERT 路径） |
| Other write-capable API | ①`TrajectoryDatabase.recordPainEvent`（`openclaw-plugin/src/core/trajectory.ts:730-757`）；②`recordPainSignalObservability`（`principles-core/src/runtime-v2/pain-signal-observability.ts:439-455`）；③`createProductionPainEvidenceHandler`（`host-runtime/src/production-pain-evidence.ts:299,415-419`）；④`governance-signal-admission.ts:509,703`（准入路径）；⑤`trajectory-store.ts:211`（correction_rejected） |
| 身份派生 | 两条互不相同：`production-pain-evidence.ts:161-178` 内容哈希 → `pain_host_<sha256>`；`openclaw-plugin/src/hooks/pain.ts:299` / `after-tool-call-helpers.ts:592` 时间戳 → `pain_${Date.now()}_...` |
| Production caller | OpenClaw `after_tool_call` hook（→ shared `production-pain-evidence`）；Codex `pd-hook.ts:186-193`（同一 shared handler）；`pd pain record`（→ `PainToPrincipleService` → `recordPainSignalObservability`）；`gate-block-helper` |
| Test-only caller | `trajectory.test.ts:937`、`pain-list.test.ts`、`governance-signal-admission.test.ts:950`、`pd-hook-owner-loop.test.ts:417`、`evidence-chain*.test.ts` 等直接 `INSERT INTO pain_events` |
| Console path | 只读（`evidence-chain` 读模型） |
| CLI path | `pd pain record` 走 observability writer；`pd pain retry` 读 dead-letter 重放 |
| Repair path | `dead_letter_pains` 表 + `pd pain retry`（不改 pain 身份） |
| Owner authorization | 不需要（检测自动写） |
| Immutable / mutable | `host_kind` / `runtime_task_id` 可被 ① 与 ② 的冲突分支 `UPDATE ... COALESCE` 富化（`trajectory.ts:770-775`、`pain-signal-observability.ts:458-465`）；其余列写入后不可改 |
| 结论 | **多重写者 + 双身份派生**（见 NEW-D1） |

### F2 · task lifecycle（`tasks.status`）

| 字段 | 内容 |
|---|---|
| Fact | 任务状态机 `pending → leased → succeeded/retry_wait/failed/needs_human_review` |
| Canonical table | `state.db::tasks`（DDL `sqlite-connection.ts:224-241`） |
| Canonical writer | `SqliteTaskStore.updateTask`（`sqlite-task-store.ts:143-161`）+ `updateTaskWithPreconditions`（`:222-256`）；DDL 层无状态约束 |
| Other write-capable API | **直接 SQL 绕过 store**：`lease-manager.ts:157-160`（acquireLease：`status='leased'` + `attempt_count=?`）、`lease-manager.ts:205-209`（releaseLease → `pending`）、`lease-manager.ts:252-255`（renewLease）、`recovery-sweep.ts:103,115,123`（→ `needs_human_review`/`retry_wait`/`failed`）、`internalization-integrity-remediation.ts:771,788`（→ `retry_wait`/`pending`，后者含 `attempt_count` 写） |
| Production caller | 6 个 peer runner（`base-peer-runner.ts` → `stateManager.markTask*`）；`RuntimeStateManager.markTaskSucceeded/markTaskFailed/markTaskRetryWait`（`runtime-state-manager.ts:256-341`）；`LeaseManager`（经 `RuntimeStateManager.acquireLease`）；`DefaultRecoverySweep`；`InternalizationIntegrityRemediation`（经 `pd runtime internalization integrity-repair --confirm`） |
| Test-only caller | 大量 `stateManager.updateTask(...)` 测试；`e2e-seed.ts:70` 直插 |
| Console path | Console 无直接 task status 写点；`POST /api/v1/failed-tasks/:id/recover` → core `RecoverySweepService` / `ownerRetryNeedsHumanReviewTask` |
| CLI path | `pd runtime internalization retry --confirm`、`pd runtime recovery sweep --confirm`、`pd runtime recovery failed-tasks --confirm`、`pd runtime internalization integrity-repair --confirm` |
| Repair path | `InternalizationIntegrityRemediation`（独立 `better-sqlite3` 连接，不经 RuntimeStateManager） |
| Owner authorization | 多数转换不需；`needs_human_review → pending` 有 core 层 Owner 语义（但见 F8 / NEW-D4） |
| Immutable / mutable | mutable（`updateTask` 无状态机校验，见 §7 G1） |
| 结论 | **多重写者（8 条可写同一行的路径）**，状态机 guard 不参与生产写 |

### F3 · runner decision（`diagnosticJson.runnerDecision` / `completionIntent` / `ownerResolutions`）

| 字段 | 内容 |
|---|---|
| Fact | 机器 verdict + 完成意图 + Owner 裁决记录 |
| Canonical table | `state.db::tasks.diagnostic_json`（JSON 列，无独立表） |
| Canonical writer | runner 各自 `updateTask({diagnosticJson})`：`evaluator-runner.ts:1684`（runnerDecision）、`:1687`（completionIntent）、`:1721`（intent→applied）、`rollout-reviewer-runner.ts:1213,1216,1297` |
| Other write-capable API | 清空型：`owner-retry.ts:102-110`、`revision-reopen.ts:80-115`（两者都写 `runnerDecision: undefined` + `attemptCount: 0`）；Owner override：`owner-resolution-service.ts:481-512`；标记 applied：`owner-review.ts:597-612`（由 `evaluator-runner.ts:2002,2012` / `rollout-reviewer-runner.ts:1495,1509` 调用） |
| Production caller | 6 runner；`pd runtime internalization retry`；Console owner-decisions route；`recovery-sweep-service.ts:110`（delegates to owner-retry） |
| Test-only caller | `verdict-drift-regressions.test.ts`、`owner-decision.test.ts`、`crash-liveness-regressions.test.ts` 等 |
| Console path | `POST /api/v1/governance/owner-decisions/:taskId/resolve`（`owner-decisions.ts:261`）+ `POST /api/v1/failed-tasks/:id/recover`（→ owner-retry，含 Recover guard） |
| CLI path | `pd runtime internalization retry --confirm` |
| Repair path | 无（无 repair 入口写 runnerDecision） |
| Owner authorization | **裁决写入需 Owner**：Console 侧 `ownerIdentity` 为 null 即 403（`owner-decisions.ts:236`）；CLI 侧 `retry` 无 Owner 身份要求，但受 decision-capable Recover guard（`owner-retry.ts:86-98`） |
| Immutable / mutable | mutable；权威解析单点 `resolveEffectiveRunnerDecision`（`owner-review.ts:400-406`），唯一生产消费点 `internalization-transition-decision.ts:145` |
| 结论 | **值不可改写（CONFIRMED）**；但单一"清空 + 预算重置"语义有三个入口共用同一次 `updateTask`（见 F5） |

### F4 · owner resolution（`ownerResolutions[]`）

| 字段 | 内容 |
|---|---|
| Fact | Owner 裁决事实（accept_current / revise_once / reject_current） |
| Canonical table | `state.db::tasks.diagnostic_json.ownerResolutions`（内嵌数组） |
| Canonical writer | `applyOwnerResolution`（`owner-resolution-service.ts:314-520`）——唯一写入新 resolution 的位置 |
| Other write-capable API | `markOwnerResolutionApplied`（`owner-review.ts:597`）改 `status → applied`；`rollbackPendingResolution`（`owner-resolution-service.ts:217-232`，同名内 `applyOwnerResolution` 调用路径，非独立入口） |
| Production caller | Console `owner-decisions.ts:261`（唯一） |
| Test-only caller | `owner-decision.test.ts`、`owner-override-resume.test.ts` |
| Console path | **是唯一生产入口**（`owner-decisions.ts`） |
| CLI path | **无**：`grep applyOwnerResolution` 在 `packages/pd-cli/src` 零命中；CLI 的 nextAction 明说"治理出口在 Console 治理焦点（或 owner-decisions API）"（`runtime-internalization-retry.ts:142,149`） |
| Repair path | CAS 版本 `updateTaskIfDiagnosticJsonAndArtifactsUnchanged`（`sqlite-task-store.ts:222`）保证裁决与证据同原子 |
| Owner authorization | **需要**：`if (!ownerIdentity) 403`（`owner-decisions.ts:236`） |
| Immutable / mutable | append + 单向 `pending → applied`（`markOwnerResolutionApplied` 对已 applied 是 no-op） |
| 结论 | **one fact → one writer（CONFIRMED，最强的一行）** |

### F5 · approval（`approvals.status`）

| 字段 | 内容 |
|---|---|
| Fact | 人工批准状态 `pending → approved / rejected` |
| Canonical table | `state.db::approvals`（DDL `sqlite-connection.ts:395-410`；身份键 = 确定性 `apr_<channel>_<artifactId>`，`sqlite-approval-store.ts:138-140`） |
| Canonical writer | `SqliteApprovalQueueStore`：`enqueue`（`:157`，`INSERT OR IGNORE`）、`approve`（`:232`）、`reject`（`:248`）、`resetToPending`（`:263`）、`edit`（`:274`） |
| Other write-capable API | 无第二条 store 实现（`MemoryApprovalQueueStore` 仅测试）；`pd legacy cleanup --apply` 对被清理 artifact 的 approval 行做 DELETE（`legacy-cleanup.ts:224`，同事务） |
| Production caller | Console `ApprovalsConsoleModel.{approve,reject,editApproval}`（`:156,478,328`）；CLI `pd activation approve`（`runtime-activation.ts:1307`）、`pd activation edit`（`:1136`） |
| Test-only caller | `demo-story-a-runner.ts:132`（`--demo story-a` 演示路径，非产品入口）、`llm-dogfood.ts:268`（脚本） |
| Console path | `POST /api/v1/approvals/:id/{approve,reject,edit}`（`approvals.ts:146,205,260`） |
| CLI path | `pd activation approve`、`pd activation edit` |
| Repair path | approve 失败 → `resetToPending` 回滚（`ApprovalsConsoleModel.ts:177`；CLI `:1417,1446`） |
| Owner authorization | **不需要**：`decidedBy` 硬编码 `'operator'`（`approvals.ts:146,205,260`）；CLI 默认 `'cli-operator'`（`runtime-activation.ts:1264`）。仅要求 Console token 认证（`AuthConfig`） |
| Immutable / mutable | mutable（仅 `status='pending'` 时可改；`RESET` 仅从 `approved` 回 `pending`） |
| 结论 | **单一 store 实现（CONFIRMED）**；但批准写无 Owner 身份语义（NEW-D5），且 `cancelled` 无写者（NEW-D3） |

### F6 · activation（`activations` 行）

| 字段 | 内容 |
|---|---|
| Fact | 激活记录（prompt / defer_archive / code_tool_hook） |
| Canonical table | `state.db::activations`（DDL `sqlite-connection.ts:439-451`；`activation_id` NOT NULL 但 **无 PK / 无 UNIQUE**，唯一性靠 `idempotency_key` 唯一索引） |
| Canonical writer | `SqliteActivationStateStore`：`recordActivation`（`:73-107`，`INSERT OR REPLACE`）、`deactivateActivation`（`:160-168`）、`promoteActivation`（`:170-218`）；`SqliteActivationSafetyStore`：`commitPromotion`（`:319-419`）、`deactivateWithDecision`（`:175-215`）、`recoverToShadow`（`:242-269`） |
| Other write-capable API | `pd legacy cleanup --apply` DELETE（`legacy-cleanup.ts:219`） |
| Production caller | `ActivationDispatcher.activateArtifact → stateReadModel.recordActivation`（`activation-dispatcher.ts:385`）；owner 决策路径经 `ActivationsConsoleModel` / CLI `pd activation promote` |
| Test-only caller | `promoteActivation` 的**全部**调用者都是测试（`j10-rule-governance-states.test.ts:129`、`rule-host-cache-invalidation.test.ts:156`、`gate-rule-context-v2.vm-e2e.test.ts:178`、`rulehost-seed-mvp-e2e.test.ts:883`、`cross-package-acceptance.test.ts:478`、`sqlite-activation-state-store.test.ts:262+`）——**且它不在 `ActivationStateReadModel` 接口内**（`activation-types.ts:90-97` 无该项） |
| Console path | `POST /api/v1/activations/:id/{disable,emergency-deactivate,reject-after-shadow,promote,recover-to-shadow,continue-observing}`、`POST /api/v1/activations/emergency-pause[/:id/release]`（`activations.ts:88-125,139`） |
| CLI path | `pd activation deactivate --activation-id`（`runtime-activation.ts:434`）、`pd activation promote --confirm`（→ `commitPromotion` `:630`） |
| Repair path | 无 |
| Owner authorization | **分裂**：`emergency-deactivate` / `reject-after-shadow` / `promote` / `recover-to-shadow` / `continue-observing` / `emergency-pause` 需 Owner actor（`activations.ts:101` 403）；`/:id/disable` **不需要**（见 NEW-D2）；CLI `deactivate` **不需要**（无 Owner gate） |
| Immutable / mutable | mutable：`action` 字段被 `commitPromotion`（`:407`）与 `promoteActivation`（`:201`）原地改写为 `code_tool_hook_live_activate` |
| 结论 | **同一行可被 ≥5 条独立路径写；`promoteActivation` 是绕过 Owner gate 的第二 live 写者（NEW-D6a）** |

### F7 · shadow → live 转换

| 字段 | 内容 |
|---|---|
| Fact | `code_tool_hook` 激活从 shadow 进入 live 强制 |
| Canonical table | `state.db::activations.action`（`code_tool_hook_shadow_activate → code_tool_hook_live_activate`）+ `activation_control_states` CAS |
| Canonical writer | `SqliteActivationSafetyStore.commitPromotion`（`:319-419`）——**唯一带 Owner 决策 + 证据快照 + control CAS 的写者** |
| Other write-capable API | **`SqliteActivationStateStore.promoteActivation`（`:170-218`）**：一次 `UPDATE activations SET action='code_tool_hook_live_activate'` 即完成转换，**无 Owner 决策、无 evidence snapshot、无 `activation_decisions` 行、无 control-state CAS**（仅有 `BEGIN IMMEDIATE` + 重复行拒绝） |
| Production caller | `commitPromotion`：Console `ActivationsConsoleModel.ts:636`、CLI `runtime-activation.ts:630`。`promoteActivation`：**零生产 caller** |
| Test-only caller | `promoteActivation` 的 6 个调用点全部在 tests（见 F6） |
| Console path | `POST /api/v1/activations/:id/promote`（`activations.ts:115`，需 Owner + `confirmed=true` + `artifactDigest` + `controlVersion`） |
| CLI path | `pd activation promote --confirm`（`runtime-activation.ts:543-548` 构造 actor，无 Owner 凭证时降为 `break_glass`） |
| Repair path | 无 |
| Owner authorization | `commitPromotion` 内断言 `promote_live` + `configured_owner`（`:324`），DB CHECK 约束强制 `principal_kind/authentication_method` 组合（`sqlite-connection.ts:517-531`）；`promoteActivation` **无任何身份参数** |
| Immutable / mutable | mutable |
| 结论 | **PARTIAL**：生产唯一 live 写者是 `commitPromotion`（构造性受约束）；但存在一条**类型可达、权限为零**的第二 live 写者（NEW-D6a），其隔离依赖「无人接线」而非类型/权限——**F-E9 第 4 项「shadow→live 无旁路」的成立强度被高估** |

### F8 · deactivation / rollback（停用）

| 字段 | 内容 |
|---|---|
| Fact | 停用激活（回滚手段） |
| Canonical table | `state.db::activations.deactivated_at` |
| Canonical writer | 三条独立写者：①`SqliteActivationStateStore.deactivateActivation`（`:160-168`，仅 UPDATE，**不写 decision**）；②`SqliteActivationSafetyStore.deactivateWithDecision`（`:175-215`，写 `activation_decisions` 不可变行）；③`commitPromotion` 内的 supersede 分支（`:403`，旧 live 行 `deactivated_at`） |
| Other write-capable API | `SqliteActivationSafetyStore.{pauseAllLive（不改行，改 pause 表）, recoverToShadow（新 INSERT 新 shadow 行而非停用旧行）}` |
| Production caller | ①Console `POST /activations/:id/disable`（`activations.ts:184`；`ActivationsConsoleModel.ts:693`）、CLI `pd activation deactivate`（`runtime-activation.ts:434`）；②Console `emergency-deactivate` / `reject-after-shadow`；③promote 的 supersede |
| Test-only caller | 大量（`activations-console-model.test.ts`、`story-a-acceptance.test.ts`、`cross-package-acceptance.test.ts`） |
| Console path | ①`/:id/disable`（**需 `confirmed=true`，不需 Owner**）②`/:id/emergency-deactivate`（需 Owner） |
| CLI path | `pd activation deactivate`（无 Owner gate，仅 audit log 前置） |
| Repair path | 无 |
| Owner authorization | **不对称**：②需 Owner，①不需；CLI 不需 |
| Immutable / mutable | mutable（`deactivated_at` 可写；`WHERE deactivated_at IS NULL` 提供单次幂等） |
| 结论 | **同一字段两条授权强度不同的生产路径（NEW-D2，即 R-20 CONFIRMED）** |

### F9 · runtime control state（`activation_control_states`）

| 字段 | 内容 |
|---|---|
| Fact | RuleCode 强制门状态（`eligible` / `safety_isolated`）+ 乐观版本 |
| Canonical table | `state.db::activation_control_states`（DDL `sqlite-connection.ts:545-551`，`activation_id` PRIMARY KEY + `version >= 1` CHECK） |
| Canonical writer | `SqliteActivationSafetyStore.{safetyIsolate（:273-317，CAS）, commitPromotion（:409-411，CAS）, recoverToShadow（:257，新行 `eligible` v1）}` + `SqliteActivationStateStore.recordActivation`（`:96-100`，`INSERT OR IGNORE` 只为 `code_tool_hook` 建初始行）+ 一次性迁移回填（`sqlite-connection.ts:762-766`） |
| Other write-capable API | 无其他 |
| Production caller | ①`recordActivation`（dispatcher，每次 code_tool_hook 激活建行）；②`observeRuleCodeSafety` 熔断（`rulecode-safety-circuit.ts:70` → `safetyIsolate`，**system_safety / 无 Owner**）；③Owner 决策路径 |
| Test-only caller | `sqlite-activation-safety-store.test.ts`、`e2e-seed.ts:210,214,227` |
| Console path | 读（`getOwnerReview` → `controlState`）；写经 promote / recover-to-shadow |
| CLI path | 写经 `pd activation promote` |
| Repair path | 无（`recoverToShadow` 是 Owner 出口，不是 repair） |
| Owner authorization | `safetyIsolate` 走 `system_safety`（自动，无 Owner）；其余需 Owner |
| Immutable / mutable | mutable，全部 UPDATE 带 `version = ?` CAS |
| 结论 | **one fact → one writer（CONFIRMED）**：自动隔离是刻意设计的 system_safety 通道，非越权 |

### F10 · canonical pain → diagnostician 任务血缘（`inputRef` / `sourcePainId`）

| 字段 | 内容 |
|---|---|
| Fact | pain ↔ task 的逻辑关联键 |
| Canonical table | `state.db::tasks.input_ref` + `diagnostic_json.sourcePainId`；`pain_events.canonical_pain_id` 在 trajectory.db（**跨库逻辑键，非 FK**，见 `sqlite-connection.ts:670-676` 注释） |
| Canonical writer | `PainSignalBridge.{onPainDetected（:435）, submitPainSignal, executePendingDiagnosis（:569）, onDiagnosisComplete}` + `governance-signal-admission.{ensureGovernanceDiagnosticianTask（:879）, insertAdmissionMarker（:561）}` + `pain_diagnoses` store（`sqlite-pain-diagnosis-store.ts:113`） |
| Other write-capable API | `internalization-integrity-remediation.ts:895`（`INSERT OR IGNORE` philosopher successor） |
| Production caller | OpenClaw hook chain（`pain.ts:408` → `emitPainDetectedEvent` → `PainToPrincipleService` → bridge）；Codex worker（`workspace-worker.ts:220`）；`governance-signal-admission` 准入路径 |
| Test-only caller | `pain-id-chain-e2e.test.ts`、`diag-chain-e2e.test.ts` 等 |
| Console path | 只读 |
| CLI path | `pd diagnose run --task-id`、`pd pain retry` |
| Repair path | `pd runtime internalization integrity-repair --confirm`（可 `INSERT OR IGNORE` 新 philosopher 任务） |
| Owner authorization | 不需要 |
| Immutable / mutable | `input_ref` 可改（`TaskStoreUpdatePatch` 含该字段） |
| 结论 | **多重写者**，且 `pain_diagnoses` 与 `pain_events` 是同一事实的两个持久化面（逻辑关联键，无跨库一致性守卫） |

### F11 · `tasks.attempt_count` vs `runs.attempt_number`（R-23 深入项）

| 字段 | 内容 |
|---|---|
| Fact | 重试预算（双源） |
| Canonical table | `tasks.attempt_count`（DDL `:232`，NOT NULL DEFAULT 0）与 `runs.attempt_number`（DDL `:271`，NOT NULL DEFAULT 0，无 UNIQUE(task_id, attempt_number)） |
| Canonical writer（`attempt_count`） | 无单一来源。**必须区分两类写点**（仅凭 grep `attemptCount: 0` 会把它们混为一谈）：<br>**（a）建行初值**（`createTask`，不构成"重置"）：`pain-signal-bridge.ts:427,454,516`、`internalization-orchestrator.ts:691`、`intake-to-internalization-bridge.ts:264`、`split-diagnostician-runner.ts:288`（均经 `stateManager.createTask`，行尚不存在）<br>**（b）对既有行的预算归零**（`updateTask` / 裸 SQL，**真正的重置**）：`pain-signal-bridge.ts:502-507`、`revision-reopen.ts:114`、`owner-retry.ts:108`、`recovery-sweep-service.ts:105`、`owner-resolution-service.ts:511`、`internalization-integrity-remediation.ts:771` —— 共 **6 处**(b)<br>**（c）单调写入**：`lease-manager.ts:158`（`= lastAttemptNumber + 1`，由 `runs` 派生）；`lease-manager.ts:207`（release 不回退） |
| Canonical writer（`attempt_number`） | 两处：`lease-manager.ts:164`（`= tasks 派生值 + 1`，与 `attempt_count` 同一事务写）、`sqlite-run-store.ts:98`（`createRun`，**零生产 caller**——`grep createRun` 在 `packages/*/src` 仅命中测试）；外加 repair 路径 `internalization-integrity-remediation.ts:1104`（`safeInsertRunRow`）与 `supplementSucceededRun`（`:1189` 用 `Math.max(1, attempt_count)`） |
| Production caller | `RuntimeStateManager.acquireLease`（runner 唯一租约入口）、`recovery-sweep`、owner/repair 入口 |
| Test-only caller | `createRun` 全部调用者；`attemptCount: 0` 大量 fixture |
| Console path | 读（`OwnerDecisionConsoleModel.ts:79`、`GovernanceProjectionCollector.ts:521`） |
| CLI path | 读（retry/recovery 决策）；写经 runtime 命令 |
| Repair path | `internalization-integrity-remediation.ts:788`（`pending`，**不动 attempt_count**）vs `:771`（`retry_wait` + `attempt_count=0`）——**同一 repair 模块内两种预算语义** |
| Owner authorization | 不需要 |
| Immutable / mutable | mutable |
| 结论 | **R-23 CONFIRMED 且比 Worker C 的标记更严重**：`attempt_count` 是**派生值**（由 `runs.attempt_number` 反算），却被 **6 处**对既有行的写者独立归零，另有 6 处建行初值让"0"成为高频默认；双重身份（预算计数器 / 尝试序号）见 NEW-D7 |

### F12 · PendingTermStore（R-12）

| 字段 | 内容 |
|---|---|
| Fact | owner-governed LLM 待审词池 |
| Canonical table | 无表；类型 `PendingTermStore`（`signal-collector/types.ts:32-35`），仅有 `version + terms[]`，**无持久化路径** |
| Canonical writer | **无权威写者（零写者）** |
| Other write-capable API | 无 |
| Production caller | 无 |
| Test-only caller | 无（类型与 UI 校验器有测试；`validatePendingTermStore` 仅 `signal-keywords-api.test.ts` 引用） |
| Console path | **全 stub**：`fetchPendingTerms` / `admitPendingTerm` / `rejectPendingTerm` / `updateKeywordStore` / `listActiveSignalKeywords` 全部返回 `endpoint_not_implemented`（`signal-keywords-api.ts:88-166`）；**server 侧无对应 route 文件**（`packages/pd-console/src/server/routes/` 无 signal-keywords） |
| CLI path | 无 |
| Repair path | 无 |
| Owner authorization | N/A（无写点） |
| Immutable / mutable | N/A |
| 结论 | **R-12 CONFIRMED**：`PendingTermStore` 是「有型无人」，Console 端点全 stub |

### F13 · recovery 路径是否能绕过 owner gate

| 字段 | 内容 |
|---|---|
| Fact | recovery（把 terminal 任务拉回 `pending`）是否需 Owner 授权 |
| Canonical writer | `RecoverySweepServiceImpl.{recoverFailedTask（:86-114）, recoverNeedsHumanReviewTask（:118-120）}`（后者委托 `ownerRetryNeedsHumanReviewTask`） |
| Owner authorization | **三条入口全部无身份要求**：①`POST /api/v1/failed-tasks/:id/recover`（`failed-tasks.ts:521-527`，路由 ctx **不含 ownerIdentity**，`index.ts:387` 也没传）；②`pd runtime recovery failed-tasks --confirm [--force]`；③Console token 认证本身（`AuthConfig.isEnabled()` 为 false 时 `isAuthenticated` 恒 true，`AuthConfig.ts:23-25`） |
| 唯一保护 | `ownerRetryNeedsHumanReviewTask` 的 Recover guard：decision-capable 或同 epoch 有 pending resolution → `rejected: owner_decision_required`（`owner-retry.ts:86-98`），且 guard 只在 `needs_human_review` 分支生效 |
| `failed` 分支 | `recoverFailedTask(:86-114)`：仅要求 `status === 'failed'`；`force=true` 时 **放宽 maxAttempts 预算**（`Math.max(maxAttempts, attemptCount) + 3`，`:97-99`）——无任何治理校验 |
| 结论 | **CONFIRMED：recovery 可绕过 owner gate 的语义边界**（NEW-D4）。`failed → pending` 完全无治理语义；`needs_human_review → pending` 有 core 层 guard，但 guard 是**语义判定**（capability eligible）而非身份认证——持有 Console token 的任何人（含 `no_auth` 模式的匿名请求）都能触发。 |

---

## 5. Confirmed / Fixed / Drifted（§5 各项裁决）

| 项 | 历史判定 | current main 裁决 | 证据 |
|---|---|---|---|
| **R-20** Console 停用按钮不要求 Owner / 不写 `activation_decisions` / 不检查 control state | P2 | **CONFIRMED** | `activations.ts:139-195`（disable 分支不读 `authority`）；对比 `:99-101`（mutation 分支的 owner 403）。下游 `ActivationsConsoleModel.deactivateActivation:673-708` → `authorizeGovernanceAction`（`governance-audit.ts:18-25` = 只写 audit log，**不是授权**）→ `SqliteActivationStateStore.deactivateActivation:160-168`（纯 UPDATE）。UI 入口 `DebtPage.tsx:371-400` → `api.ts:853-863`。行号与 #1710 一致，无漂移。 |
| **R-26a** 第二条 live writer | P2 | **CONFIRMED** | `SqliteActivationStateStore.promoteActivation`（`:170-218`）不在 `ActivationStateReadModel`（`activation-types.ts:90-97`）；`SqliteActivationStateStore` 经 `activation/index.ts:58` + `runtime-v2/index.ts:1419` 公开导出（package 内可达）；6 个调用点全在 tests。 |
| **R-26b** skill 通道无 writer | P2 | **CONFIRMED** | `readonly channel = ` 全仓仅 3 处（`low-risk-writers.ts:34,62`、`rule-host-writer.ts:189`）；`channel: 'skill'` 在 `packages/*/src` 仅测试命中；`AUTO_PROMOTABLE_CHANNELS=['skill']`（`activation-types.ts:17`）+ `decideAutoPromotion`（`approval-queue.ts:17-21`）豁免分支存在，但 dispatch 终局为 `no_writer_for_channel_skill` refused（`activation-dispatcher.ts:351-354`）。 |
| **R-07** 同任务两入口 retry 预算语义相反 | P2 | **CONFIRMED**（行号漂移） | `onPainDetected`（`pain-signal-bridge.ts:435`）在 `:502-507` 对非终态非活跃租约任务写 `{status:'pending', attemptCount:0, ...}`；`executePendingDiagnosis`（`:569`）注释明言 "NEVER resets task state"（`:556`），实际不写 attemptCount。历史引 `:472-498/540-558/596-601` → 现 `:435/502-507/556/569`。 |
| **R-12** PendingTermStore 无生产写入者 / Console 全 stub | P2 | **CONFIRMED**（见 F12） | `signal-collector/types.ts:32-35`；`signal-keywords-api.ts:88-166` 5 个 stub；server routes 目录无对应文件。 |
| **R-23** attempt_count 与 attempt_number 双源不一致 | P2 | **CONFIRMED 且加深** | `lease-manager.ts:151-160` 明确「Determine next attempt number from existing runs (most reliable)」——`runs` 是权威、`tasks.attempt_count` 是派生并被 11 处硬写 0。见 NEW-D7。 |
| **approval `cancelled` 无 writer** | 历史 REFUTED | **CONFIRMED**（无写者） | 类型 `activation-types.ts:140`；白名单 `sqlite-approval-store.ts:26`；路由白名单 `approvals.ts:69`；stats 默认 `:219`、`ApprovalsConsoleModel.ts:35,117`。全仓无 `SET status='cancelled'` / `status: 'cancelled'` 生产写点。 |
| **Console approval 是否唯一人工批准入口** | — | **CONFIRMED（Console + CLI 双入口，各写同一 store）** | 能写 `approvals.status` 的生产路径穷举：`SqliteApprovalQueueStore.{enqueue,approve,reject,resetToPending,edit}`，被 Console `ApprovalsConsoleModel.ts:156,478,328,177`、CLI `runtime-activation.ts:1307,1136,1417,1446` 调用。**Console 不是唯一入口**：CLI `pd activation approve` 同样能批；两者 `decidedBy` 都不校验 Owner（`'operator'` / `'cli-operator'`）。 |
| **recovery 是否可绕过 owner gate** | — | **CONFIRMED**（见 F13 / NEW-D4） | `failed-tasks.ts:521-527` + `index.ts:387`（ctx 无 ownerIdentity）；`recovery-sweep-service.ts:86-114`；`owner-retry.ts:86-98` 是语义 guard 非身份门；`AuthConfig.ts:23-25` no-auth 模式恒 true。 |
| **R-19 D 面**（core 侧 vm 预处理把宿主 realm input/helpers 注入） | P1（C NEW-1） | **CONFIRMED 两条，发现第三条** | 见 §5.1 |

### 5.1 R-19 D 面 — current main 精确文件 / 行号 / 调用链

> 以下只记事实，不提修复方案。

**路径 ① — evaluator 确定性对抗重放（gateDeps）**

1. 编译点：`packages/principles-core/src/runtime-v2/activation/production-gate-deps.ts:86-124`
   - `:91` `vm.createContext(Object.create(null))`；`:94` `script.runInContext(context, { timeout: 1000 })`
   - `:111-123` 返回的 `ReplayEvaluateFn` 在**宿主 realm** 内执行：`:112` `Reflect.apply(evaluateFn, undefined, [input, helpers])`
   - 即 `evaluateFn` 对象本身来自 vm realm，但**调用发生在宿主栈**，`input`/`helpers` 是宿主对象
2. 调用点（注入宿主 input/helpers 的位置）：`packages/principles-core/src/runtime-v2/internalization/refiner-sandbox-wrapper.ts:146-178`
   - `:153-159` `createSyntheticRuleHostInput(...)`（宿主构造的 `input`）
   - `:161-167` 宿主构造的 `helpers` 闭包对象
   - `:171` `evaluateFn(input, helpers)` ← **宿主 realm 对象直接传进 vm realm 的 evaluate**
3. 第二条同模式调用链：`packages/principles-core/src/runtime-v2/golden-trace-replay-validator.ts:210-245`
   - `:218-224` 宿主 `input`；`:234-240` 宿主 `helpers`；`:242` `evaluateFn(input, helpers)`
   - 生产 caller：`openclaw-plugin/src/core/principle-compiler/compiler.ts:232-233`（`evaluateFn as ReplayEvaluateFn` + `replayGoldenTrace`），上行 `evolution-reducer.ts:436-438`
4. gate 入口：`refiner-rulehost-gate.ts:104-113`（`invokeSandboxSafe` → `deps.evaluateInSandbox`）→ 由 `RuleHostWriter.canActivate`（`rule-host-writer.ts:297`）与 `evaluator-runner.ts:2716`（`executeDeterministicReplay`，`:2541-2600`）调用
5. 生产 assembly：`EvaluatorRunner` 构造第 2 参数 `gateDeps`——`host-runtime/src/evaluator-runtime-context.ts:85,96`、`internalization-consumer-cycle.ts:484,646`、`internalization-consumer-governance.ts:114`、`pd-cli/src/commands/runtime-internalization-run-rulehost.ts:274`、`pd-cli/src/services/rulehost-pipeline-runner.ts:461`、`pd-cli/src/commands/runtime-activation.ts:327,573`
   - 旁路：`internalization-consumer-governance.ts:125-128` 用 `channel: input.channel as never`（rc-2 面，属 #1710 NEW-9）
6. 可否被同一静态禁门拦下：**不能**。`checkForbiddenPatterns`（`rule-code-validator.ts:79-91`）对 `input["constructor"]["constructor"]`、`String.fromCharCode(...)` 动态拼接、`"con"+"structor"` 三种写法**零命中**（本地实测见 §9 V3），而 `input.constructor.constructor` 直写命中 `constructor`。**注意**：该检查只在 `production-gate-deps.ts:167-179` 与 `refiner-sandbox-wrapper.ts:265-273` 执行，且只针对 `code` 源字符串，对运行时取到的宿主对象无约束。

**路径 ② — refiner sandbox wrapper**

同 ①（`refiner-sandbox-wrapper.ts` 是 ① 的执行体，不是独立第三路径）：`:153-167` 宿主 input/helpers，`:171` 宿主 realm 调用；文件头 `:249-254` 自述 `softTimeoutMs` 仅是"elapsed-time classification threshold, NOT a hard cancellation"，硬取消"out of scope for core"。

**路径 ③（本次新增，此前未登记）— `pd-cli` 的 `compileDemoRule`**

* `packages/pd-cli/src/services/demo-rule-compiler.ts:45-73`
  - `:46` `vm.createContext(Object.create(null))`；`:51` `script.runInContext(..., { timeout: 1000 })`
  - `:60-71` 返回的 evaluate 在**宿主 realm** 执行 `:62` `const result = evaluateFn(input, helpers)` ← 宿主对象同 ①
* 生产接线（非 demo）：
  - `packages/pd-cli/src/services/rulehost-pipeline-runner.ts:235-250` `createSandboxGateDeps()` → `:245` `compileDemoRule(code, 'rulehost-pipeline')` → `evaluateInRefinerSandbox(..., { evaluateCode, ...opts })`
  - 该 gateDeps 被 `pd runtime internalization run-rulehost` 注入 Artificer L2 适配器：`runtime-internalization-run-rulehost.ts:274`
  - `artificer-l2-adapter.ts:429-430` → `tools/artificer-l2-tool-contract.ts:308`（`replay_rulecode` 工具）→ `evaluateRefinerRuleHostGate` → 回 ①
  - 与 ①②不同：`compileDemoRule` **没有** `checkForbiddenPatterns` 前置（不是它不做，而是由 `evaluateInRefinerSandbox:265` 做——但同样只查源码字符串）。**其真实差异点**：该路径是 LLM（Artificer L2 agent）在**生成期间**反复调用的工具，因此被注入的对象域与 ① 相同，触发面比 ① 更宽（每次都跑）。
* `pd-cli` 侧另有 `createDemoSandboxEvaluate`（`principles-core/src/runtime-v2/story-a-demo.ts:161-175`）用 `new Function(...)`——**非 vm**，仅被 `demo-story-a-runner.ts`（`--demo story-a`）使用，同样属宿主 realm 调用。

**明确不受影响的路径（对照组，已核实）**

* `packages/host-runtime/src/rule-implementation-runtime.ts:9-52`：**子进程 + JSON 边界**。`:33` `context.__pdInputJson = JSON.stringify(workerData.input)`、`:34-44` 在 vm realm 内 `JSON.parse` 并用 vm realm 的 `Object.freeze` 造 helpers；`:27-32` 注释明确写出「Passing host-realm objects ... would let rule source walk `.constructor.constructor` back to the host realm's Function constructor ... a full sandbox escape」。这是**生产 live gate** 走的路（`production-rulehost-gate.ts:349-356`）。
* `packages/openclaw-plugin/src/core/rule-implementation-runtime.ts:29-54`：同一 JSON 边界模式（但 `:43-44` 是 `context.__pdCallInput = input; context.__pdCallHelpers = helpers;` —— **在子进程内**，父进程只传 JSON，隔离仍成立；与 host-runtime 版相比少了 `JSON.parse` 一环，因为 `workerData` 本身已由 stdin JSON 反序列化在子进程内完成）。

**判定：R-19 D 面 CONFIRMED，路径数量 = 三条**（#1710 记两条）。三条的共同结构：vm realm 里取出 `evaluate` 函数，然后在**宿主栈**上以宿主对象为参数调用。

---

## 6. NEW Findings

### NEW-D1【P2】canonical pain 身份由两条互不相同的算法派生

* **ID**：NEW-D1
* **Severity**：P2
* **Claim**：`pain_events.canonical_pain_id` 不是单一身份权威。同一逻辑 pain 在两条宿主路径上得到不同 ID 形式。
* **Evidence**：
  - 内容哈希派生：`host-runtime/src/production-pain-evidence.ts:161-178`（`pain_host_<sha256(workspaceDir,sessionId,turnId,toolName,source,params,result,error,exitCode,failure)>`）、`:229-242`（correction 版含 `occurrenceId`）
  - 时间戳派生：`openclaw-plugin/src/hooks/pain.ts:299`（`pain_${Date.now()}_${hash(sessionId)}`）、`after-tool-call-helpers.ts:592`（`pain_${Date.now()}_${errorHash}`）、`llm.ts:302`（`llm_${Date.now()}`）
  - 五位写者：`trajectory.ts:730-757`、`pain-signal-observability.ts:427-465`、`production-pain-evidence.ts:299/415-419`、`governance-signal-admission.ts:509/703`、`trajectory-store.ts:211`
  - OpenClaw 生产链：`hooks/pain.ts:408 emitPainIfAdmitted`（时间戳 ID）与 `hooks/pain.ts:469-518 handleSharedPainEvidenceResult`（读 shared 的 `painId` metadata）**同处一条 hook 链**；`after-tool-call-helpers.ts:592` 显式注释「Generate painId early so it can be passed as canonicalPainId to recordPainEvent, enabling dedup between legacy trajectory write and SDK path」
* **Why it matters**：canonical pain 是 PD 全链身份键（`sqlite-connection.ts:670-676` 称 pain_id 为 LOGICAL association key）。两个算法并存意味着「同一 pain 是否被识别为同一次」取决于哪条路径先落地；唯一索引只保证写入不撞键，不保证语义同一。
* **Affected stage**：pain 采集 → 诊断任务播种
* **Current protection**：`idx_pain_events_canonical_pain_id` 唯一部分索引（`openclaw-plugin/src/core/trajectory.ts:388`、`pain-signal-observability.ts:336`）+ `production-pain-evidence.ts:257-300 hasCanonicalSchema()` 运行时 schema 自检。**两者都只保护单次写入的完整性，不保护身份算法一致性。**

### NEW-D2【P2】停用路径授权强度不对称，且有两条弱路径

* **ID**：NEW-D2（= 历史 R-20，本次确认为"两条弱路径"而非一条）
* **Severity**：P2
* **Claim**：同一 `deactivated_at` 字段有两条生产写者绕过 Owner 身份门与 `activation_decisions` 审计行。
* **Evidence**：
  - Console 弱路径：`activations.ts:139-195`（disable 分支从不读 `authority`）→ `ActivationsConsoleModel.ts:673-708` → `SqliteActivationStateStore.deactivateActivation:160-168`。`authorizeGovernanceAction`（`governance-audit.ts:18-25`）签名为 `(stateDir, data, mutation) => { writer(...); return mutation(); }`——**先写审计再无条件执行 mutation，无身份参数**。
  - CLI 弱路径：`runtime-activation.ts:380-470`（`handleRuntimeActivationDeactivate`）先 `writeGovernanceAction`，再 `deactivateActivation`，**全程无 Owner 身份解析**（对比 promote 路径 `:543-554` 的 `resolveOwnerIdentity`）。
  - 强路径对照：`activations.ts:99-101`（403 `owner_authentication_required`）+ `SqliteActivationSafetyStore.deactivateWithDecision:175-215`（写不可变 decision 行）。
  - `requireOwnerDecisionFeature()` 在 `ActivationsConsoleModel.ts:547,554,573` 三处出现，disable 路径（`:673`）**没有**。
* **Why it matters**：Owner 在 Console 点「停用」与点「紧急停用」得到不同强度的审计链。停用是 PD 唯一的回滚手段，缺少 `activation_decisions` 行意味着事后无法解释"谁在什么证据下停用的"。
* **Affected stage**：activation 治理 / 回滚
* **Current protection**：`confirmed: true` 请求体校验（`activations.ts:25-37`）+ `.pd/logs` governance audit JSONL。**均非身份控制。**

### NEW-D3【P2】`approval` 状态写入无 Owner 身份语义（Console + CLI 双入口）

* **ID**：NEW-D3
* **Severity**：P2
* **Claim**：`approvals.status` 的批准/拒绝写入不携带 Owner 身份；两条生产入口都把 `decidedBy` 硬编码为字面量。
* **Evidence**：
  - `approvals.ts:146` `model.approve(approvalId, 'operator', note)`；`:205` `model.reject(approvalId, 'operator', ...)`；`:260` `editApproval({ ..., editedBy: 'operator', ... })`
  - `runtime-activation.ts:1264` `const decidedBy = opts.decidedBy ?? 'cli-operator'`
  - `sqlite-approval-store.ts:232,248,274`：`decided_by = ?` 直接落库，无格式/身份校验
  - 效果断链：approval 是 `code_tool_hook` 进入 shadow 的前置门（`activation-dispatcher.ts:198-261`：`rolloutDecision='approved'` 时独立复核 approval 记录存在 + status + artifactId/channel 一致），但该复核**只看记录，不看记录里谁批的**
* **Why it matters**：owner-governed 是 PD 产品边界（`docs/product/PRODUCT_IDENTITY.md`）。当前实现里"Owner 批准"与"任何持有 console token 的人批准"在持久层不可区分——`decided_by='operator'` 是常量，不是身份。
* **Affected stage**：approval → activation
* **Current protection**：Console token 认证（`AuthConfig.isAuthenticated`，`index.ts:358`）+ MVP channel 白名单（`ApprovalsConsoleModel.ts:150`）。**`no_auth` 模式下认证恒为 true**（`AuthConfig.ts:23-25`）。

### NEW-D4【P2】recovery 的三条入口均无 Owner 身份门

* **ID**：NEW-D4
* **Severity**：P2
* **Claim**：`failed → pending`（含放宽重试预算）与 `needs_human_review → pending`（authority reset）都不要求 Owner 身份。
* **Evidence**：
  - Console：`failed-tasks.ts:521-527` 调用 `dispatchRecovery`；路由 ctx 类型 `FailedTasksContext`（`:322-328`）**无 `ownerIdentity` 字段**；`index.ts:387` 注入的 ctx 亦无该字段（对比 `owner-decisions` 路由 `index.ts:521-529` 显式传入 `ownerIdentity`）
  - CLI：`runtime-recovery-failed-tasks.ts:117`（`recoverFailedTask`）、`:105-127`（`--force` 放宽预算）；`runtime-recovery.ts:76-79`（expired lease sweep）
  - 唯一语义保护：`owner-retry.ts:86-98` 的 Recover guard（decision-capable → `rejected: owner_decision_required`），**只覆盖 `needs_human_review`**；`failed` 分支（`recovery-sweep-service.ts:86-114`）无任何治理校验，`force` 直接改 `maxAttempts`
  - 认证强度：`AuthConfig.ts:20-25`（token 缺失或 `--no-auth` 时 `isAuthenticated` 恒 true）、`index.ts:591-593`（仅 warn，不阻止启动）
* **Why it matters**：recovery 是「把终态任务重新送回 LLM」的能力，等价于重新消耗预算并可能重新产出候选。它在 `failed` 分支上完全无门，在 `needs_human_review` 分支上只有语义门。
* **Affected stage**：task lifecycle / Owner 治理出口
* **Current protection**：`failed_task_recovery_console` flag（默认 on，`feature-flag-contract.ts:391`）+ `appendRecoveryAction` 审计 JSONL（`failed-tasks.ts:530-544`，**best-effort，写失败仅 warn**）

### NEW-D5【P3】`approvals.status='cancelled'` 有类型、有白名单、无写者

* **ID**：NEW-D5
* **Severity**：P3（无现网故障；潜在误判源）
* **Claim**：`cancelled` 是声明可达状态，但无生产写入者，也无自动过期写者。
* **Evidence**：类型 `activation-types.ts:140`；读白名单 `sqlite-approval-store.ts:26`；查询白名单 `approvals.ts:69`；stats 默认 `sqlite-approval-store.ts:219`、`ApprovalsConsoleModel.ts:35,117`、`memory-approval-store.ts:72`；`ApprovalStats` 类型 `activation-types.ts:196`。全仓 `SET status = 'cancelled'` / `status: 'cancelled'` / `status:'cancelled'` **零命中**。
* **Why it matters**：`enqueue` 用 `INSERT OR IGNORE` + 确定性主键 `apr_<channel>_<artifactId>`（`sqlite-approval-store.ts:138-140,157`）。被拒（`rejected`）的 artifact 无法重新入队——`INSERT OR IGNORE` 静默忽略，既有的 `rejected` 行遮蔽重派。`cancelled` 本可承担"让位重派"语义但无人写。Owner 在 Console 会看到 `cancelled: 0` 恒为 0 的统计字段。
* **Affected stage**：approval
* **Current protection**：无

### NEW-D6【P2】shadow→live 的第二写者无 Owner 门、无证据、无审计

* **ID**：NEW-D6a（= 历史 R-26a）
* **Severity**：P2（不升级为 P1：无生产接线，且类型不在读模型接口内）
* **Claim**：`SqliteActivationStateStore.promoteActivation` 是一次 UPDATE 完成 shadow→live 的完整写者，且被 package 公开导出。
* **Evidence**：`sqlite-activation-state-store.ts:170-218`（`:201` `SET action = 'code_tool_hook_live_activate', promoted_at = ?`）；不在 `ActivationStateReadModel`（`activation-types.ts:90-97`）；导出链 `activation/index.ts:58` → `runtime-v2/index.ts:1419`；6 个调用点全在 tests。对照 `commitPromotion`（`sqlite-activation-safety-store.ts:324` 断言 `promote_live`+`configured_owner`，`:352-357` 写 snapshot，`:371-388` 写 decision，`:409-411` control CAS）。
* **Why it matters**：`git-*`/治理面判定「shadow→live 无旁路」时若只做 grep 会得出"只有 commitPromotion"。真实情况是**类型可达的第二写者存在**，当前隔离靠"没有生产 caller"。任何后续接线都会静默绕过 Owner gate。
* **Affected stage**：shadow → live 治理
* **Current protection**：无（无类型/权限隔离；`ActivationStateReadModel` 接口不含该方法，但 `SqliteActivationStateStore` 类本身被导出，调用方可直接 `new`）

### NEW-D6b【P2】`AUTO_PROMOTABLE_CHANNELS=['skill']` 与零 skill writer 并存

* **ID**：NEW-D6b（= 历史 R-26b）
* **Severity**：P2
* **Claim**：唯一被声明为"高置信度可免人工审批"的通道没有 writer。
* **Evidence**：`activation-types.ts:17`；`approval-queue.ts:17-21`（`decideAutoPromotion`）；dispatch 处 `activation-dispatcher.ts:265-270`（豁免分支）→ `:351-354`（`no_writer_for_channel_ + channel` refused）；writer 注册表来自调用方 `writers: [...]`，全部调用方只注册 prompt / defer_archive / code_tool_hook（`internalization-consumer-governance.ts:109-119`、`runtime-activation.ts:321-335,1377-1391`、`llm-dogfood.ts:301-309`）。
* **Why it matters**：豁免分支在语义上承诺"skill 通道可越过人工审批"，实际终局恒为 refused。任何阅读 `AUTO_PROMOTABLE_CHANNELS` 的审计都会得出相反的可用性结论。
* **Affected stage**：rollout → activation
* **Current protection**：`checkCanActivate` 预检（`activation-dispatcher.ts:288-292`）会在入队前先跑，但对 skill 而言 `writer` 为 undefined 所以预检跳过，错误只在 `activateArtifact` 才出现

### NEW-D7【P2】`tasks.attempt_count` 是派生值却承担两个语义，且有 11 处硬写 0

* **ID**：NEW-D7（R-23 深入）
* **Severity**：P2
* **Claim**：`attempt_count` 的双重身份——"已消耗的重试预算"与"当前运行序号"——在 revision / recovery / owner 三类窗口下由不同写者独立决定，无一致性守卫。
* **Evidence**：
  - 权威推导：`lease-manager.ts:151-158` 从 `runs.attempt_number` 反算 `attempt_count`（注释自述 "most reliable"），说明 runs 才是序号权威
  - **对既有行归零的 6 个生产写点**（经调用链核实，非 grep 罗列）：`pain-signal-bridge.ts:502-507`（`updateTask`；R-07 的归零点）、`revision-reopen.ts:106-115`（`updateTask`）、`owner-retry.ts:106-110`（`updateTask`）、`recovery-sweep-service.ts:93-104`（`updateTask`）、`owner-resolution-service.ts:509-513`（`updateTaskIfDiagnosticJsonAndArtifactsUnchanged`）、`internalization-integrity-remediation.ts:771`（裸 `UPDATE tasks`）
  - **建行初值（非重置，6 处，避免与上者混淆）**：`pain-signal-bridge.ts:427,454,516`、`internalization-orchestrator.ts:687-692`、`intake-to-internalization-bridge.ts:264`、`split-diagnostician-runner.ts:283-289`（全部 `createTask`）
  - 不动预算的写者：`internalization-integrity-remediation.ts:788`（`pending`，同模块不同分支）
  - repair 对 runs 侧：`:1189` `attemptNumber = Math.max(1, taskRow.attempt_count)`（**反向派生**：runs 从 tasks 算，与 lease-manager 方向相反）
  - `runs.attempt_number` 无 `UNIQUE(task_id, attempt_number)`（DDL `sqlite-connection.ts:259-276`）
  - `createRun`（`sqlite-run-store.ts:90-115`）**零生产 caller**
* **Why it matters**：`attempt_count >= max_attempts` 是 `RetryPolicy.shouldRetry`（`retry-policy.ts:115-119`）与 repair 判定的唯一依据。当 `attempt_count` 被 revision reopen 或 owner retry 归零而 `runs.attempt_number` 继续增长时，"这条任务试过几次"在两张表上给出不同答案——排障与治理统计会得出矛盾结论（`internalization-chain-integrity-read-model.ts:445` 用 `attempt_count`、`schema-conformance-read-model.ts:47` 列 `attempt_number`）。
  - 本文档未下"哪个是错的"结论——那需要设计决策（见 §8 I-D3）。
* **Affected stage**：retry / revision / recovery / repair
* **Current protection**：`SqliteTaskStore` 运行时校验 `attempt_count` 为非负整数（`sqlite-task-store.ts:434-443`）；`SqliteRunStore.rowToRecord` 校验 `attempt_number`（`:261`）。**均只做类型校验，不做双源一致性校验。**

### NEW-D8【P3】`validateTaskTransition` / `canTransitionTo` 不在任何生产写路径上

* **ID**：NEW-D8
* **Severity**：P3（latent debt）
* **Claim**：状态机 guard 是纯函数且被导出，但没有任何生产 writer 调用它。
* **Evidence**：`internalization-task-guards.ts:111-137`（`canTransitionTo`，注释列出合法边）；`internalization-state-machine.ts:226-245`（`validateTaskTransition`）；唯一消费者是 `internalization-queue-read-model.ts:223`（**读模型，租约就绪判定**，非写入 guard）。`grep -rn 'canTransitionTo\|validateTaskTransition' packages/*/src`（排除定义/barrel/测试）仅命中该读模型。全部 `updateTask` writer（§4 F2 的各条路径）都不做状态校验，`SqliteTaskStore.updateTask`（`sqlite-task-store.ts:143-161`）直接拼 SQL。
* **Why it matters**：`failed` 被注释标为"Terminal states (failed) cannot transition to any other state"（`:110`），但 `recovery-sweep-service.ts:86-114` 就写 `failed → pending`。guard 与真实写入面不一致，任何依赖 guard 做审计推理的结论都会偏。
* **Affected stage**：task lifecycle
* **Current protection**：无（guard 存在但不生效）

### NEW-D9【P3】`pi_artifacts` 的唯一性语义被 `(source_task_id, artifact_kind)` 承担，写入是覆盖而非追加

* **ID**：NEW-D9
* **Severity**：P3
* **Claim**：唯一索引 `idx_pi_artifacts_idempotency ON pi_artifacts(source_task_id, artifact_kind)`（`sqlite-connection.ts:387-388`）使 `upsertArtifact` 的 `ON CONFLICT ... DO UPDATE` 可**改写** `artifact_id` 本身。
* **Evidence**：`sqlite-pi-artifact-store.ts:75-108`（`:79-88` `INSERT ... ON CONFLICT(source_task_id, artifact_kind) DO UPDATE SET artifact_id = excluded.artifact_id, content_json = excluded.content_json, ...`）。同一任务二次 upsert 时，旧 `artifact_id` 被替换。**限定**：`activations`（`sqlite-connection.ts:439-451`）与 `approvals`（`:395-410`）的 DDL 都**未声明到 `pi_artifacts` 的 FK**（只在 `commits` `:326-340` 有 FK 且带 CASCADE），所以旧引用不会被级联清理，只会变成读模型眼中的 orphan。生产调用方是否触发二次 upsert 取决于 runner 是否在同一 task 上重跑（evaluator 存在 3 个 upsert 点：`evaluator-runner.ts:985,1086,1177,3265`）。
* **Why it matters**：读模型（`internalization-chain-integrity-read-model.ts`）会报 orphan，但与 `legacy cleanup` 的删除路径归为同一类症状，难以区分"被覆盖"与"被清理"。
* **Affected stage**：artifact 落库 → activation 引用
* **Current protection**：应用层 FK 检查（`sqlite-pi-artifact-store.ts:45-51` 检查 tasks、`sqlite-activation-state-store.ts:76-81` 检查 pi_artifacts）**只检查被引用的 task/artifact 存在，不检查 artifact_id 是否已被替换过**

---

## 7. Protection Gaps（现有 test / guard 是否保护 writer 唯一性）

| # | 保护机制 | 存在？ | 覆盖 writer 唯一性？ | 证据 |
|---|---|---|---|---|
| G1 | DB 层不可变触发器 | 部分 | 仅 `activation_decisions` + `activation_evidence_snapshots` | `sqlite-connection.ts:541-544,564-567`。tasks / runs / activations / approvals / pi_artifacts 全部无 |
| G2 | DB 层状态机 CHECK | 否 | `tasks.status` 无 CHECK（DDL `:224-241`）；`activations.action` 无 CHECK；`approvals.status` 无 CHECK | 仅 `activation_decisions.decision` / `principal_kind` / `authentication_method` 有 CHECK（`:508-531`） |
| G3 | 架构守护（architecture-regression.test.ts） | 是 | **否**：守护的是文件结构与 import 方向（如 `rule-host-writer.ts` 零基础设施 import `:2418-2429`、shadow action 字面量 `:2431-2442`），不守护"谁写哪个表" | 全文 grep `writer` / `sole` 无写者唯一性断言 |
| G4 | `check-security-baseline.js` | 是 | **否**：供应链与文件存在性检查（SECURITY.md、依赖锁定等），`grep vm` 零命中 | `scripts/check-security-baseline.js` |
| G5 | `check-runtime-contract.js` | 是 | **否**：无 writer/authority 断言 | `grep writer\|authority\|promoteActivation` 零命中 |
| G6 | `validateTaskTransition` / `canTransitionTo` | 是 | **否**：不在生产写路径上（NEW-D8） | `internalization-queue-read-model.ts:223` 是唯一消费者 |
| G7 | 应用层 FK 预检 | 是 | 部分：`recordActivation` 检查 artifact 存在（`sqlite-activation-state-store.ts:76-81`）、`enqueue` 检查 artifact 存在（`sqlite-approval-store.ts:149-154`）、`createArtifact` 检查 task 存在（`sqlite-pi-artifact-store.ts:45-51`） | 只挡"引用不存在"，不挡"第二写者覆盖" |
| G8 | 幂等键唯一索引 | 是 | 部分：`activations.idempotency_key` UNIQUE、`init_..._idempotency_key`、`commits.run_id UNIQUE`、`approvals` 确定性主键 | 挡重复，不挡改写 |
| G9 | 生产测试断言"无直接 INSERT" | 是（局部） | 仅 `rulehost-seed-mvp-e2e.test.ts:986-998` 的注释式验收（**注释不是断言**，无 `expect` 检查 SQL 文本） | 该块是注释文本，不是运行时校验 |
| G10 | `error:context` router + ERROR_PATTERN_INDEX | 是 | 无 writer-authority 类 EP 卡片 | 见 §9 V2 输出：plan mode "No automatic routing match" |

**总判定**：**当前仓库没有任何机制保护 writer 唯一性。** 所有"one fact → one writer"结论都来自"没有人接线/没有第二个实现"这类**偶然事实**，而非构造性约束。这类结论会在两类变更后立刻失效：①新增 CLI/Console 入口；②把已存在但未接线的 API 接上生产（`promoteActivation`、`createRun`）。

---

## 8. Suggested Contract Invariants

> 只写 invariant，不写方案。每条注明当前状态（成立 / 不成立 / 未知）。

* **I-D1**：同一 `canonical_pain_id` 只能由一个身份派生算法产出。当前：**不成立**（NEW-D1 两条算法）。
* **I-D2**：任何改变 `activations.deactivated_at` 的写者，若该激活处于 `code_tool_hook` 通道，必须同时产生一条 `activation_decisions` 行。当前：**不成立**（NEW-D2，disable 路径无 decision）。
* **I-D3**：`state.db::tasks.attempt_count` 只能有一个语义。若它是"已消耗预算"，则任何"新一轮"必须显式记录为单独事实（而非归零）；若它是"当前序号"，则必须与 `runs.attempt_number` 同源。当前：**双重语义并存**（NEW-D7）。
* **I-D4**：`approvals.decided_by` 必须能区分"配置的 Owner"与"任意 operator"。当前：**不成立**（常量 `'operator'` / `'cli-operator'`）。
* **I-D5**：任何把任务从 terminal 状态拉回 `pending` 的入口必须携带授权来源，且该来源可从持久层复核。当前：**部分成立**（`needs_human_review` 有语义 guard；`failed` 无；均无身份门）。
* **I-D6**：`shadow → live` 只能有一个写者，且该写者必须可证明携带 Owner 决策 + 证据快照 + control CAS。当前：**生产路径成立，构造性不成立**（NEW-D6a 第二写者类型可达）。
* **I-D7**：声明为"可自动豁免人工审批"的通道必须存在对应 writer；否则该声明不得进入契约常量。当前：**不成立**（NEW-D6b）。
* **I-D8**：`activations.action` 的改写（shadow→live）与 `activation_control_states.version` 的递增必须在同一事务内。当前：**`commitPromotion` 成立**（`:366-413` 单事务）；`promoteActivation` **不成立**（不动 control state）。
* **I-D9**：RuleCode 的编译/求值路径只接受以值（非宿主对象）跨 realm 边界的输入。当前：**不成立**（§5.1 三条路径；子进程路径成立）。
* **I-D10**：任何 `vm` realm 中取出并被宿主栈调用的函数，其输入/helpers 必须来自 vm realm 自身的内建对象。当前：**不成立**（同上）。
* **I-D11**：同一持久化位置的全部生产写者必须能被静态枚举（即：不存在绕过 store 的裸 SQL、不存在未注册的等价 API）。当前：**不成立**（tasks 有 5 条裸 SQL 路径；activations 有 2 个 store 类）。
* **I-D12**：`pain_events` 写入后的 `host_kind` / `runtime_task_id` 富化只能由持有该 pain 权威身份的写者执行。当前：**不成立**（两个 store 的 `UPDATE ... COALESCE` 冲突分支都可能改，`trajectory.ts:770-775` 与 `pain-signal-observability.ts:458-465`）。

---

## 9. Out of Scope

* **不写任何修复方案**（含 invariant 的实现形式）。
* **不改 `packages/**`**：本文件是唯一新增物。
* **不做 live 运行时取证**：未读 `~/.pd/` 实际 state.db；全部判定基于 `cdec05d4b` 静态源码。
* **不打补丁、不建分支以外的东西、不改 config、不碰 Linear**（CLI 零密钥姿态）。
* **R-19 只记事实**：未评估影响面大小、未给缓解建议、未做 exploit 验证（仅在本地复现了静态门对三种规避写法零命中，属证据收集）。
* **未裁决的双源语义**：NEW-D7 未判定 `attempt_count` 与 `attempt_number` 哪个应退位——属设计决策。
* **未覆盖**：`pd-console` UI 层自身的状态副本、`pd-companion` 的本地状态、`website` 包。
* **未核实**：`docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md` 中 §5/§6 与本次范围无关的条目（如 prompt↔validator 对齐、渐进披露三层）；本矩阵只对与 writer authority 相交的条目（R-07/R-12/R-19/R-20/R-23/R-26）作裁决。

---

## 附录 A · 验证记录（本文档自身的验证）

### V1 · 基线核对

```
$ git rev-parse HEAD
cdec05d4bc4252151c7f9f118bdad90f25067594
$ git rev-parse audit/pri-807-phase0-base
cdec05d4bc4252151c7f9f118bdad90f25067594
```
判定：BASELINE SYNCED，无 drift。

### V2 · error:context two-pass

Pass 1（plan mode）：

```
$ npm run error:context -- --paths docs/audit/pri-807-phase0 --signals "writer authority second writer"
Error Context
Basis: plan inputs (paths: 1, signals: 1)
No automatic routing match; manual Pattern Index review is still required.
Read docs/process/error-management/ERROR_PATTERN_INDEX.md before implementing.
```

人工阅读 `ERROR_PATTERN_INDEX.md` 全部 13 张 EP 卡后，选取 4 张命中（本次任务只读、无代码 diff，故它们被用作**判定校验项**而非 Verification Plan）：

* **EP-07 Runtime State Source Alignment**（risk medium，pathSignals 含 `state` / `resolver`）— 命中。其 `requiredEvidence` 第 1 条「Returned state is read from the canonical source after writes; **lineage fields come from one authority (rc-6)**」正是本矩阵 §4 F4/F10/F11 的判定标准。代表 ERR：`ERR-004`、`ERR-008`、`ERR-092`、`ERR-095`。**应用于**：F4 判定（PASS — `resolveEffectiveRunnerDecision` 单点解析）、F11 判定（FAIL — 双源无守卫 → NEW-D7）。
* **EP-02 Production Path Wiring and Architecture Boundaries**（risk high）— 命中。其 failure mode 首句「a component exists and has isolated tests, but the **real user/operator path never calls it**」直接覆盖 NEW-D6a（`promoteActivation` 有测试无生产 caller）与 NEW-D6b（skill 豁免分支无 writer）。代表 ERR：`ERR-083`、`ERR-024`。
* **EP-01 Trust Boundary Validation**（risk high）— 命中。`rule-code-validator.ts` 的静态禁门与 `production-gate-deps.ts` 的 vm realm 边界正是 trust boundary；`requiredEvidence` 第 1 条（untrusted 值在 runtime guard 校验前保持 unknown）适用于 §5.1 判定。代表 ERR：`ERR-001`、`ERR-013`。
* **EP-08 Security Boundary Placement**（risk high）— 命中。用于 §5.1 R-19 D 面与 NEW-D2/NEW-D3/NEW-D4（授权门放置位置）。
* **排除（显式给理由）**：
  - `EP-04 CLI and Operator Contract` — 本次未改 CLI，且 F5/F8 的 CLI 行为差异属"授权强度"而非 CLI 契约（严格 JSON / dry-run / exit code）问题。判定为不命中。
  - `EP-05 Loop State Freshness` — 表面相关（F7 R-07 retry 预算），但该卡聚焦"重试循环复用陈旧 iteration error/result"，R-07 是"两个入口语义相反"，已作为 F7 显式登记，不重复计入。
  - `EP-09 Test Reality Gap` — 与 NEW-D6a 的"test-only caller"判定有交集，但 EP-09 的可执行证据要求（生产路径 smoke）超出本次只读审计范围；已改记在 §7 G9。**这是本卡唯一一处"命中但降级处理"，理由：本任务书禁止改代码，无法产出 smoke 证据。**
  - `EP-03 / EP-06 / EP-10 ~ EP-13` — 与 writer authority 无交集。

Pass 2（diff mode）：本 PR 的 diff 只含本文件（+0 代码行），无代码面新增风险。故 Error Experience / Task Risk Contract = **不适用（零代码 diff）**，已按 policy 附 router 原文输出而非空写。

### V3 · R-19 静态门规避实测（本地、只读、不写仓库）

```
$ cd packages/principles-core && npx tsx -e 'import {checkForbiddenPatterns} ...'
evasive labels: []          # const k = "con" + "structor"; input[k][k](...)()
direct  labels: ["constructor"]   # input.constructor.constructor(...)()
bracket-constructor labels: []    # input["constructor"]["constructor"]
dyn     labels: []                # String.fromCharCode(99,111,...)
```

结论：`checkForbiddenPatterns`（`rule-code-validator.ts:79-91`，`maskNonExecutableText` 先掩码字符串/注释、bracket 模式除外）对上述三种规避写法零命中。

### V4 · 宿主 realm 对象可穿透 vm 边界实测（本地、只读）

```
$ node -e '... vm.createContext ... fn(hostInput, helpers) ...'
host input passed in-realm -> "v24.21.0"
typeof fn === function: true
```

说明：在 vm realm 编译的 `evaluate` 在宿主栈以宿主对象为参数调用时，`input.constructor.constructor` 取到的是**宿主 realm 的 Function**（可读 `process.version`）。与 `host-runtime/src/rule-implementation-runtime.ts:27-32` 注释所描述的逃逸模式一致；该文件因使用 JSON 边界而免疫。

### V5 · 模板一致性自检

| 任务书 §6 要求章节 | 本文档对应 | 状态 |
|---|---|---|
| 1 Scope | §1 | ✅ |
| 2 Baseline（SHA + SYNCED / Drift Warning） | §2 | ✅ SYNCED，无 Drift Warning 小节（因为无 drift） |
| 3 Current Authorities | §3（A1–A10） | ✅ |
| 4 Contract Map（4.2 完整矩阵） | §4（F1–F13，每行含 4.2 全部字段） | ✅ |
| 5 Confirmed / Fixed / Drifted（§5 各项裁决） | §5（9 项 + §5.1 R-19 D 面） | ✅ |
| 6 NEW Findings（ID/Severity/Claim/Evidence/Why/Affected stage/Current protection） | §6（NEW-D1 .. NEW-D9，每条 7 字段齐全） | ✅ |
| 7 Protection Gaps | §7（G1–G10） | ✅ |
| 8 Suggested Contract Invariants（只写 invariant） | §8（I-D1 .. I-D12） | ✅ |
| 9 Out of Scope | §9 | ✅ |
| 4.3 必须回答：One fact → one writer | §3（满足）+ §4 F1/F2/F5..F8/F10/F11（违反）+ §7 总判定 | ✅ |
| 4.4 R-19 D 面（只记事实，不提修复方案） | §5.1（三条路径的 file/line/调用链 + 对照组） | ✅ 全文无修复方案 |
| §3 严重度只对真正 P1 使用 | §6 全部 P2/P3，无 P1 | ✅（理由见 §5.1：R-19 的**影响面**判定不在本次范围，仅记事实） |

### V6 · 零依赖检查

```
$ cd /workspace-cnb-dev-issue-50 && npm run check:docs-structure
> node scripts/check-docs-structure.cjs
[check:docs-structure] OK: docs/.private/ 0 tracked, 9 required files exist, 0 stray root .md files.
```

`verify:merge` 未跑：本 diff 仅新增 1 个 markdown 文件，不触代码/类型/测试面（详见 V5 末）。

### V7 · 未验证项（如实列出）

* 未在真实 `~/.pd/state.db` 中核对 `attempt_count` 与 `attempt_number` 的实际分布（无 live 取证）。
* 未统计 `pain_host_*` 与 `pain_<ts>_*` 两条 ID 形式在真实库中的占比。
* `ApprovalStats.cancelled` 恒 0 的结论来自静态写点枚举，未做运行时确证。
* 未验证 GitHub 权威仓库的 `main` 与本次基线的关系——本入口只能读 CNB 镜像（`origin=cnb.cool/csuzngjh/principles`），权威仓库是 GitHub（章程 §5）；`git ls-remote --heads origin` 已确认远端 base 分支 `audit/pri-807-phase0-base` 存在且指向 `cdec05d4b`（本地同一 SHA）。
* 未跑 `npm run verify:merge`：本次 diff 只含 1 个新增 markdown 文件（零代码行），merge gate 的代码/类型/测试面不适用；已跑的 `npm run check:docs-structure` 是本改动唯一相关的零依赖检查（见 V6）。
