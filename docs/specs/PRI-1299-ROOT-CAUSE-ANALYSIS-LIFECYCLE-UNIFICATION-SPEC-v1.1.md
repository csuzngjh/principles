# PRI-1299 Root Cause Analysis & Lifecycle Unification SPEC v1.1

**Status：** Owner-decision frozen — **OWNER_APPROVED；Phase 1 authorized**
**Version：** v1.1
**Created：** 2026-11-27
**Author：** AI Engineering Agent（v1.0 五调查面 + Phase 0 四只读子代理 + 主代理整合；本轮不修改生产/测试代码）
**Related PRs：** PR #2803（MERGED）、PR #2805（MERGED）
**Related ADR：** `docs/adr/0031-pri-1299-lifecycle-unification.md`
**Supersedes：** 不取代 v1.0；v1.0 保留为历史调查快照
**Historical snapshot：** `docs/specs/PRI-1299-ROOT-CAUSE-ANALYSIS-LIFECYCLE-UNIFICATION-SPEC-v1.0.md`

---

## 1. 执行摘要

### 1.1 一句话根因

PD 内部化任务的创建、修复、恢复、失效和持久化依赖一组从未被完整形式化过的生命周期合同。PR #2805 已把 ordinary successor lookup/create 的关键路径收敛，但 repair identity/creation authority、跨模块 evidence validity、connection-level transaction authority 和 historical compatibility 仍未完成统一。

### 1.2 合并后已经解决的scoped问题

| 问题 | 当前状态 | scoped含义 |
|---|---|---|
| Ordinary successor lookup/conflict/malformed adjudication | RESOLVED | 统一在 `lookupSuccessorByParent()`；限 ordinary successor 与参与该 authority 的 writer |
| RuleHost ordinary successor 与 orchestrator 创建职责不一致 | RESOLVED | 两者都调用 `createLogicalSuccessorTask()` |
| Adversarial ordinary successor 绕过统一 authority | RESOLVED | 已调用同一 helper；repair transition 走 formal commit |
| Orchestrator 内 successor create + parent-edge lineage backfill | RESOLVED（scoped） | 已在同一 write transaction；不覆盖所有 standalone multi-edge backfill |
| Preview/confirm implementation fork | RESOLVED | dry-run/confirm 使用同一 lookup/allocation helpers；并发漂移不是 implementation fork |
| Repair lineage validation/backfill 复制实现 | RESOLVED | PRI-1300 已 uplift 到 core；host/pd-cli/orchestrator 共享 |

### 1.3 仍然存在的根因

| PRC | 状态 | 摘要 |
|---|---|---|
| PRC-1 | CONFIRMED | logical identity contract 仍不完整，repair iteration 不进入 ordinary triple |
| PRC-2 | CONFIRMED | ordinary creation 已收敛，但 repair creation 仍有两个 direct seeder |
| PRC-3 | CONFIRMED | lifecycle correctness 仍依赖多段独立 durable evidence，而不是统一恢复合同 |
| PRC-4 | CONFIRMED | write admission 仍只覆盖 TaskStore scoped CRUD/CAS，不是 connection/database-level authority |
| PRC-5 | CONFIRMED（精确定义） | evaluator 局部防线强，但跨 runner/recovery/owner/repair 的 evidence-validity contract 仍缺失 |

### 1.4 最终调查结论

**PASS_WITH_LIMITATIONS。**
静态调查、merge audit、证据复核和架构决策已完成；但本轮按任务边界没有执行新的多进程、fault-injection、direct-writer capture matrix、dirty-read matrix 或完整两轮 repair 动态 E2E。所有此类内容标记为 `UNVERIFIED` 或测试计划，不写成事实。

---

## 2. 调查范围、输入和证据等级

### 2.1 调查输入

- v1.0 调查 SPEC；
- PR #2805 merge commit；
- 当前 `origin/main`；
- 四个只读 Phase 0 子代理报告；
- 主代理对 better-sqlite3 13.0.3 的有限 in-memory transaction probe。

### 2.2 证据等级

| 等级 | 含义 |
|---|---|
| CONFIRMED | 当前源码、schema、生产 wiring 或可复现实验直接证明 |
| PARTIALLY_CONFIRMED | 有部分证据，但范围、动态行为或跨模块组合未完全证明 |
| NOT_REPRODUCIBLE | 按当前代码和测试无法复现历史说法 |
| FALSE | 当前证据证明该说法不成立 |
| UNVERIFIED | 静态上可能成立，但缺少必要动态/多进程/故障证据 |
| RESOLVED | 在当前 main 已修复，但可能仅限于明确 scoped 场景 |

### 2.3 本轮边界

本轮只允许文档变更。没有修改 `packages/`、schema、测试、lockfile、CI 或生产配置。

### 2.4 Change Log（v1.0 → v1.1）

> 本章保留 v1.0 → v1.1 的实质变化；v1.0 原文不覆盖。

1. PR #2805 状态从调查时的 open/work-in-progress 更新为 **MERGED**。
2. 记录 squash merge commit：`e3ddf901d0be93b10713beff8165c7008e64d2d6`。
3. 明确 `aaccb6b4a9b6b3fdee17514b39f01354a825412a` 是历史调查 HEAD，不是当前 main。
4. 重新核对 merge tree：`aaccb6b4^{tree}` 与 `e3ddf901^{tree}` 完全相同，因此 production code 行号未因 merge 漂移。
5. 明确 PRI-1300/PRI-1301 已在调查 baseline 内；不是 v1.0 之后的新变量。
6. 将 ordinary successor lookup/create、RuleHost/adversarial ordinary authority、preview/confirm implementation fork、repair lineage/backfill uplift 标为 scoped `RESOLVED`。
7. 将 repair seeding 问题改写为更精确的架构缺口：缺统一 create/adopt/conflict authority，而不是简单的“两行物理重复”。
8. 细化 PRC-5：正式 evaluator 路径已有强 exact-input 防线；缺口是跨模块统一 evidence-validity contract。
9. 修正 Memory/multi-process 测试证据强度：同进程双 SQLite connection 不是 multi-process 证据。
10. 明确 channel 在 repair identity 中是 mandatory consistency dimension，但不是独立 uniqueness degree of freedom。
11. 新增六项 Phase 0 架构决策，全部标为 `PENDING_OWNER_DECISION`。
12. 冻结 Phase 1-7 实施边界、测试矩阵、验收标准与回滚策略。
13. 修正 v1.0 中两个 `5.3` 小节编号问题；本版采用 `5.3/5.4/5.5` 不重复编号。
14. 更新 `pitask-metadata.ts` repair validation 引用为更精确的 `947-1002` 范围。
15. 新增 Owner stale-resolution submission-time gap 与 activation 端到端测试要求。
16. Owner 已于 2026-11-28 批准 OD-1..OD-8；v1.1 语义保持不变，本版记录批准状态、Phase 1 授权、PD Service Host Only 边界与 Phase 5 正式名称。

---

---

## 3. 系统快照与统计口径

### 3.1 Git baseline

| 项 | 值 |
|---|---|
| 当前 `origin/main` | `e3ddf901d0be93b10713beff8165c7008e64d2d6` |
| PR #2805 merge 时间 | 2026-11-27T05:28:48Z |
| 历史调查 HEAD | `aaccb6b4a9b6b3fdee17514b39f01354a825412a` |
| tree equality | `aaccb6b4^{tree}` = `e3ddf901^{tree}` = `0145ccc594941ffcdb0d1c80be8c52c914d9d51e` |
| v1.0 文档提交 | `c24b5c74b9acf02f6ee52e7baa59b6f95639e161` |
| Phase 0 分支文档基础提交 | `33293368df9beea3ebcdd7c7a3302389a5262c04` |

解释：PR #2805 是 squash merge，拓扑上 `aaccb6b4` 不是 merge commit 的 ancestor，但内容 tree 完全相同。因此 v1.0 对 production code 的行号和调用关系没有因 merge 而失效。

### 3.2 模块统计口径

- 以 TypeScript module/file 为统计单位；
- v1.0 直接核验 34 个 production source modules/files；
- v1.1 复核后该范围仍成立；
- 创建入口按语义独立 lifecycle/business creation path 计数，不按 `.createTask` 文本命中计数。

### 3.3 PR #2803 / PRI-1300 / PRI-1301 关系

- PR #2803 已 merged，HEAD `9a734dfe596e44b0882b3c1029ed337db41b7f26`；
- PRI-1300 repair lineage uplift、PRI-1301 executor separation、PRI-1294 Phase 4 docs 已通过 `1ce190d85` 进入 `aaccb6b4`；
- 它们属于当前 baseline 事实，不是 v1.1 新发现的 post-merge 修复。

---

## 4. 当前架构总览

### 4.1 生命周期主线

```text
Pain/Candidate/CLI intake
→ Root/Intake task
→ fixed diagnostician family
→ Artificer / Evaluator / RuleHost / Scribe 等 ordinary logical successors
→ Owner evidence / resolution / approval / activation
→ revision / repair / reopen / supersede
→ observability / rollback / audit
```

### 4.2 关键运行时对象

```text
TaskRecord
RunRecord
ArtifactRecord
CompletionIntent
EvaluatorVerdict
SuccessorChainEdge
OwnerResolution
RevisionEpoch
ActivationRecord
```

### 4.3 当前权威分布

| 领域 | 当前权威 |
|---|---|
| 语义 transition decision | `decideInternalizationTransition()` |
| commit arbitration | `InternalizationOrchestrator.commitNextTaskProposal()` |
| ordinary successor creation | `createLogicalSuccessorTask()` |
| revision reopen primitive | `reopenTaskForRevision()` |
| repair completion reopen | orchestrator `REOPEN_SOURCE_EVALUATOR` branch |
| repair identity verification | `verifyRepairTaskIdentity()` |
| repair lineage validation/backfill | `validateAndBackfillRepairLineage()` |
| repair creation | **host-runtime / pd-cli 两套 direct seeder（未收敛）** |
| lease/fencing | lease-manager + fenced-task-writer |
| Owner resolution | `owner-resolution-service.ts` + evaluator application-time validation |
| task-store write admission | `SqliteTaskStore` scoped FIFO/ALS |
| connection/database write admission | **不存在统一权威** |

---

## 5. 创建入口全量盘点

统计单位仍为“语义独立业务/生命周期创建路径”。当前 production tree 与 v1.0 调查 tree 相同，因此 14 类入口数量未变；变化在于 v1.1 对分类边界和已收敛程度做了更精确标注。

### 5.1 创建入口分类总表

| 分类 | 数量 | 身份类别 | 当前收敛状态 |
|---|---:|---|---|
| Root / intake | 6 | A | 独立 root/intake identity，未强行套用 ordinary successor key |
| Fixed diagnostician subtask | 1 | B | deterministic family creation，独立身份类别 |
| Ordinary logical successor | 3 | C | 已统一调用 `createLogicalSuccessorTask()` |
| Repair logical successor | 2 | D | host/pd-cli 两套 direct create，未统一仲裁 |
| Operator remediation / backfill | 2 | E | operator remediation provenance，不是新 logical key |
| 合计 | **14** | — | 互斥分类 |

### 5.2 Root / intake entries（6）

| ID | 入口 | 文件/行号 | 当前要点 |
|---|---|---|---|
| CR-01 | 异步 pain ingress | `packages/principles-core/src/runtime/pain-signal-bridge.ts:561-576` | `diagnostician` root task direct create；靠 deterministic id/UNIQUE 兜底 |
| CR-02 | 同步 `onPainDetected` 缺失补建 | `packages/principles-core/src/runtime/pain-signal-bridge.ts:1348-1407` | host pain callback remediation；与 CR-01 存在 read-check-write 竞态面 |
| CR-03 | diagnosis completion 后 Dreamer seed | `packages/principles-core/src/runtime/pain-signal-bridge.ts:2181-2204` | `dreamer` root task；deterministic id + adopt，不是 successor contract |
| CR-04 | `pd diagnose` completion intake | `packages/pd-cli/src/commands/diagnose.ts:972-1001` | CLI diagnose root intake；与 CR-03 共享 factory/去重逻辑 |
| CR-05 | `pd candidate internalize` | `packages/pd-cli/src/commands/candidate.ts:747-803` | candidate → `dreamer` root task；需保持 dry-run/confirm 语义 |
| CR-06 | candidate review/consumed-candidate Dreamer seed | `packages/pd-cli/src/commands/candidate.ts:1447-1583` | 与 CR-05 共用工厂但业务触发不同 |

### 5.3 Fixed diagnostician subtask（1）

| ID | 入口 | 文件/行号 | 当前要点 |
|---|---|---|---|
| CR-07 | split diagnostician rootcause/distiller/router fixed child creation | `packages/principles-core/src/runtime/internalization/split-diagnostician-runner.ts:706-729` | deterministic fixed children；当前不写 `pi_metadata.parentTaskId`，不能套用 ordinary lineage 推断 |

### 5.4 Ordinary logical successor entries（3）

| ID | 入口 | 文件/行号 | 当前状态 |
|---|---|---|---|
| CR-08 | orchestrator logical successor | `packages/principles-core/src/runtime/internalization/internalization-orchestrator.ts:1338-1456` → `packages/principles-core/src/runtime/internalization/successor-create.ts:108-207` | unified authority + transaction-time allocation + parent-edge backfill |
| CR-09 | RuleHost synchronous spine successor | `packages/pd-cli/src/services/rulehost-pipeline-runner.ts:848-934` → `successor-create.ts` | 调同一 `createLogicalSuccessorTask()` |
| CR-10 | adversarial loop ordinary successor | `packages/principles-core/src/runtime/adversarial-loop.ts:635-663` → `successor-create.ts` | ordinary successor 调同一 helper；repair branch 不直接创建 transition |

### 5.5 Repair logical successor entries（2）

| ID | 入口 | 文件/行号 | 当前状态 |
|---|---|---|---|
| CR-11 | host-runtime repair seeder | `packages/host-runtime/src/internalization-consumer-governance.ts:194-290` | direct `stateManager.createTask` at 268-288 |
| CR-12 | pd-cli repair seeder | `packages/pd-cli/src/services/rulehost-pipeline-runner.ts:1017-1110` | direct `stateManager.createTask` at 1078-1109 |

重要事实：deterministic taskId 已防止同 iteration 的物理 duplicate row，但没有 structured `existing/adopt/conflict` outcome；并发 loser 可能把 UNIQUE error 归为 `seed_failed`，即使另一进程已成功创建合法 repair。

### 5.6 Operator remediation/backfill（2）

| ID | 入口 | 文件/行号 | 当前要点 |
|---|---|---|---|
| CR-13 | consumed-candidate missing Dreamer backfill | `packages/pd-cli/src/commands/candidate.ts:2645-2653` | operator remediation；写前须经 admission/suppression gate；不是 schema migration |
| CR-14 | pending-candidate intake + Dreamer backfill | `packages/pd-cli/src/commands/candidate.ts:2818-2826` | operator remediation；intake 成功但 seed 失败会留下需要二次恢复的 consumed candidate |

### 5.7 不计入正常 lifecycle 的 production-src demo/synthetic 写入

| 类型 | 文件/行号 | 说明 |
|---|---|---|
| synthetic baseline runner | `packages/pd-cli/src/services/synthetic-baseline-runner.ts:313` | synthetic/demo 数据写入，不是 Owner 正常 lifecycle |
| demo story diagnostician | `packages/pd-cli/src/services/demo-story-a-runner.ts:355` | demo 数据写入 |
| demo story dreamer | `packages/pd-cli/src/services/demo-story-a-runner.ts:403` | demo 数据写入 |

### 5.8 exported creation capability

`seedIntakeTask` 位于 `packages/principles-core/src/runtime/internalization/intake-to-internalization-bridge.ts:370-407`，当前无 in-repo production caller。若外部 host 使用，它属于 root/intake fixed-seed creation path，而不是 logical successor path。

### 5.9 额外边界统计

- production non-test `.createTask` 直接调用约 17 处；
- demo/synthetic 直接写入点 3 个；
- exported 但当前无 in-repo production caller 的 `seedIntakeTask`：1 个；
- 真正低层 `INSERT INTO tasks`：1 个（`SqliteTaskStore.createTask`）；
- schema migration task backfill insert：0 个。

---

## 6. 恢复入口全量盘点

恢复入口仍按 12 类统计。当前没有 post-merge 代码变化改变数量。

| ID | 恢复入口 | 恢复对象 | 当前风险/状态 |
|---|---|---|---|
| RR-01 | evaluator successful recovery | run/artifact/verdict/intent | exact-input 防线较强，但仍属 runner-local |
| RR-02 | artificer successful recovery | run/artifact/terminal state | 分步持久化，靠消费侧 proof |
| RR-03 | completion-intent resume | durable intent + effects | stale input/intent 防线分布在 evaluator |
| RR-04 | adversarial loop restart/reconciliation | runner state / transition state | replay 机制，不应产生新的 invalidation event |
| RR-05 | RuleHost replay | deterministic rule evaluation/repair request | dual-role legacy binding 仍影响 repair lookup |
| RR-06 | enqueue-existing recovery | existing successor adoption | ordinary scoped 已收敛 |
| RR-07 | batch failed recovery | failed tasks | operator remediation，不等价 lifecycle transition |
| RR-08 | strict single-task recovery | single task evidence | proof-bound |
| RR-09 | owner retry | Owner resolution/evaluator consumption | submission-time exact-input proof仍有缺口 |
| RR-10 | owner evidence recovery | evaluator evidence store | evidence validity distributed |
| RR-11 | revision/reopen replay | revision epoch/cause/effects | same-cause idempotency 已实现核心层 |
| RR-12 | lineage/backfill recovery | parent/correlation metadata | proof-bound，但 standalone multi-edge atomicity 未定义 |

---

## 7. 状态语义写入口全量盘点

### 7.0 十类语义写入口

| ID | 状态写入口 | 权威/风险 |
|---|---|---|
| M-01 | lease acquisition/renew/release | lease fencing authority |
| M-02 | expired lease recovery | lease/state recovery |
| M-03 | runner terminal writes | runner + fenced writer |
| M-04 | fenced diagnostic metadata write | diagnostic metadata consistency |
| M-05 | logical successor creation | ordinary unified；repair 未统一 |
| M-06 | commit transition / cascade | orchestrator/reopen authority |
| M-07 | repair completion evaluator reopen | orchestrator formal branch |
| M-08 | Owner resolution / supersession | owner service + runner fallback |
| M-09 | failed/NHR recovery | evaluator/operator governance |
| M-10 | source-correction specialized reopen | orchestrator specialized branch |

### 7.1 direct state.db writer inventory（物理写风险面）

以下不被计入 10 类语义迁移，避免混淆“业务状态迁移”和“物理写能力”：

- `sqlite-run-store.ts:107-134,154-203`；
- lease-manager / fenced-task-writer；
- `sqlite-pi-artifact-store.ts:83-97,145-168,223-226`；
- candidate store；
- approval/activation stores；
- reconciliation cursor store；
- pain/intent stores；
- raw connection escape hatch：`runtime-state-manager.ts:181-184`。

结论：这些 writer 没有统一 transaction identity / write admission contract。

---

## 8. 权威下游失效触发清单

仍是 6 类：

| ID | 触发 | 说明 |
|---|---|---|
| INV-01 | 上游 revision 完成后 cascade | formal reopen/cascade |
| INV-02 | repair artificer 完成后 `REOPEN_SOURCE_EVALUATOR` | orchestrator commit branch |
| INV-03 | Owner `revise_once` | owner-resolution driven revision |
| INV-04 | source-correction 授权并完成新 scribe epoch | specialized correction path |
| INV-05 | rollout `needs_revision` routing | governance routing |
| INV-06 | approved replay failed / provenance gate repair/NHR path | governance repair/human-review path |

明确排除：reconciliation、consumer scheduling、adversarial restart 是 replay/execution 机制，本身不应成为新的 invalidation event。

---

## 9. Logical Identity 与去重合同

### 9.1 正式术语

以下术语是 ADR-0031/SPEC v1.1 的 approved PRI-1299 contract vocabulary。它们获得本次 PRI-1299 实施授权，但不等于已经修改仓库 LOCKED-ONTOLOGY；是否同步 `docs/architecture/GLOSSARY.md` / `DOMAIN_MODEL.md` 仍按独立 ontology 变更流程处理。

```text
OrdinarySuccessorIdentity = (parentTaskId, taskKind, channel)

RepairSuccessorIdentity = (
  sourceEvaluatorTaskId,
  taskKind = 'artificer',
  channel,
  repairIteration
)

RevisionEpoch = (taskId, revisionCount, revisionCauseId/consumedRevisionCauseIds)
RunIdentity = runs.run_id
ArtifactVersion = (artifactId, sourceTaskId, artifactKind, revisionEpoch, contentHash)
EvaluatorEvidenceKey = (evaluatorTaskId, evaluatorRunId, decisionArtifactId,
                        sourceArtificerArtifactId, evaluatorRevisionEpoch)

RepairCreationAuthority =
  repair identity adjudication + strict lineage/payload verification +
  atomic insert + UNIQUE race re-arbitration + structured outcome owner.

LifecycleTransitionAuthority =
  one semantic owner per mutation family (commit/reopen, lease, owner
  resolution, activation), not a single unrealistic global status writer.

TransactionOwner =
  owner of the open transaction boundary on one SQLite connection,
  including commit/rollback outcome and connection-health handling.

WriteAdmission =
  connection/database-level policy deciding whether a writer may write
  outside, inside, or across an active transaction boundary.

LegacyLineageProof =
  minimum durable evidence required to classify/backfill historical
  parent/correlation lineage without guessing: deterministic identity or
  producer-specific proof, valid target existence/kind, compatible payload,
  and no contradictory lineage evidence.
```

### 9.2 taskId 与 logical identity 的关系

- `tasks.task_id` 是物理 row identity / allocation result；
- deterministic taskId 必须与 payload identity 双向验证；
- 即使 taskId 确定，也不能反推 payload 正确；
- taskId mismatch 是 identity conflict，不是可自动修复的 lineage drift。

### 9.3 Repair key 中 channel 的精确定义

当前源码证据：

- ordinary lookup query 只有 `(parentTaskId, successorKind, channel)`：`successor-lookup.ts:21-25`；
- repair deterministic id 不包含 channel：`pitask-metadata.ts:155-157`；
- repair verifier 要求 payload/channel/parent/correlation一致：`repair-task-identity.ts:103-133`。

因此 v1.1/ADR 推荐合同为：

1. channel 保留在 `RepairSuccessorIdentity` 的书面合同中；
2. channel 是 mandatory consistency dimension；
3. channel **不是独立 uniqueness degree of freedom**；
4. `(sourceEvaluatorTaskId, repairIteration)` 是有效 allocation scope；
5. channel mismatch 必须 fail closed；
6. channel mismatch 不允许变成“创建另一个 repair row”的理由。

### 9.4 dependencyTaskIds 非 causal parent

`dependencyTaskIds` 表达执行依赖/输入依赖。它不能作为所有任务的 causal parent proof。Root/fixed subtask/operator remediation 的 lineage 必须按各自 producer contract 判断。

### 9.5 fail-closed 原则

无法证明 identity、lineage、epoch 或 input binding 时，正确行为是拒绝、needs_human_review 或 structured conflict，而不是猜测、重建或自动重命名。

---

## 10. Repair / Revision 生命周期

### 10.1 当前合法生命周期

```text
E evaluates A0
→ needs_revision
→ seed R1
→ R1 succeeds
→ orchestrator REOPEN_SOURCE_EVALUATOR
→ E revisionCount + dependency A0→R1
→ E reevaluates
→ optional needs_revision
→ seed R2
→ R2 succeeds
→ E revisionCount + dependency R1→R2
→ automatic repair stops under current two-round governance
```

### 10.2 R1/R2 合法共存

R1/R2 可以合法共存，因为它们不是同一 logical identity。若把 ordinary triple 当全局唯一规则，会把 R2 误判成 R1 duplicate；这是 latent contract conflict，不是当前物理 schema 直接制造 duplicate row。

### 10.3 当前重复创建风险

同一 evaluator 同一 round 的 deterministic id 使物理 duplicate row 不可能同时存在；但跨进程/跨入口 loser 没有 structured adopt/reuse outcome。`evaluator-runner.ts:2888-2898` 会把 seeder error 泛化为 `seed_failed`，可能导致错误的人审路由。

### 10.4 repair completion authority

Artificer runner 只写 output/artifact/terminal state（`artificer-runner.ts:1241-1306`）。正式 reopen authority 是 orchestrator repair completion branch（`internalization-orchestrator.ts:934-1055`）。历史说法“Artificer runner 直接 reopen evaluator”是 **FALSE**。

### 10.5 repair completion stale downgrade guard

`internalization-orchestrator.ts:987-1015` 已防止 older repair completion 把 evaluator dependency 降回旧 round。这是重要 scoped fix，但仍需完整乱序/crash recovery tests。

### 10.6 当前两轮限制的性质

- 当前 validator 拒绝 `repairIteration > 2`：`pitask-metadata.ts:947-976`；
- evaluator 在 `priorRepairIteration >= 2` 时停止自动 seed：`evaluator-runner.ts:2770-2783`；
- 因此“两轮”既是当前产品治理策略，也是当前 implementation hard limit；
- 架构决策 D2 建议不要把“2”永久写死为 identity model invariant；若未来 Owner 批准 R3+，应同时调整 governance、validator、seed budget 和测试，保留既有 R1/R2 id/rows 不变。

---

## 11. 上游修订与下游失效

### 11.1 artifact mutation 不是 invalidation event

`sqlite-pi-artifact-store.ts` 的写入本身不会触发 evaluator 重评。历史说法“artifact 新增/多行自动触发 evaluator 重评”是 **FALSE**。

### 11.2 真实失效链条

```text
formal reopen/cascade
→ dependency replacement
→ revision epoch increment
→ new evaluator input artifact binding
→ old evidence becomes invalid for the new input
```

### 11.3 evaluator exact-input defenses

正式 evaluator 路径已经具备强防线：

- current input resolution：`evaluator-runner.ts:940-986`；
- intent input match：`995-1004`；
- successful recovery validation：`1085-1167`；
- resume epoch/input gate：`2169-2202`。

因此 PRC-5 不是“没有防线”，而是“防线没有成为跨模块统一合同”。

---

## 12. SQLite / Memory 持久化合同

### 12.1 当前 SQLite transaction facts

1. schema 只有 `task_id` physical uniqueness：`sqlite-connection.ts:306-325`；
2. `SqliteTaskStore` FIFO/admission 在 `sqlite-task-store.ts:63-113`；
3. FIFO 是 module-global，ALS 是 per-instance；
4. `RuntimeStateManager.withWriteTransaction` delegate 到 taskStore：`runtime-state-manager.ts:232-235`；
5. direct writers 不使用统一 admission；
6. raw connection access 仍存在：`runtime-state-manager.ts:181-184`；
7. rollback failure best-effort swallowed：`sqlite-task-store.ts:99-103`。

### 12.2 capture mechanism probe

主代理使用仓库 pin 的 better-sqlite3 13.0.3、in-memory DB 做了有限 probe：

```text
outer raw BEGIN IMMEDIATE
→ inner db.transaction() insert
→ outer ROLLBACK
→ inner row absent
```

结果：`{"version":"13.0.3","rowsAfterRollback":[],"inTransaction":false}`。

结论：capture mechanism 已 CONFIRMED；生产频率、跨 store matrix、真实 concurrency impact 仍 UNVERIFIED。

### 12.3 Memory store contract

`memory-task-store.ts:67-190`：

- `createTask` 对同 id 是 `Map.set` overwrite；
- `withWriteTransaction` 只串行 callback，无 rollback/snapshot；
- artifact epoch 语义与 SQLite 不一致；
- 因此 Memory store 被推荐正式定义为 **Non-Transactional Test Double**。

### 12.4 必须使用真实 SQLite 的测试

- atomicity / rollback；
- multi-connection visibility/locking；
- `SQLITE_BUSY`；
- direct-writer capture matrix；
- nested transaction behavior；
- trigger/foreign-key side effects；
- true multi-process behavior；
- legacy malformed JSON/edge lookup when SQL json functions matter。

---

## 13. 历史数据与兼容性

### 13.1 已确认规则

- dependency 不能泛化为 parent；
- 无证明 parentage 不得猜测；
- malformed/ambiguous lineage fail closed；
- backfill 必须 proof-bound、idempotent、concurrency-aware；
- 不得删除或合并历史行。

### 13.2 legacy repair identity

- deterministic-id legacy repair rows 若缺 parent/correlation，可在 strict proof 下 backfill；
- arbitrary UUID-shaped repair rows 目前不被 `verifyRepairTaskIdentity()` 支持；
- 生产是否存在此类 rows：**UNVERIFIED**；
- 迁移前必须先 audit，不得预支 migration decision。

### 13.3 standalone lineage backfill

`correlation-lineage.ts:473-529` plan 后逐边 CAS。若不在 orchestrator write transaction 内，中间失败可能留下部分边。该问题的 contract/atomicity 仍未定义，标为 **CONFIRMED gap / dynamic extent UNVERIFIED**。

---

## 14. 根因分析与证据链

### PRC-1 — 身份合同不完整且多层身份混用 — CONFIRMED

证据见 ADR §4/PRC-1。数据库仅有 physical `task_id` uniqueness；logical successor uniqueness 不是 DB-level invariant。

### PRC-2 — 创建和状态迁移权威未完全收敛 — CONFIRMED

ordinary successor 已收敛，repair creation 未收敛。正确表述不是“所有创建都混乱”，而是“核心 ordinary spine 已收敛，repair/root/fixed/operator 各有独立语义，其中 repair 是最危险残余缺口”。

### PRC-3 — 多阶段持久化缺少统一恢复合同 — CONFIRMED

run/artifact/terminal/intent/successor/reopen/backfill 分步 durable。现有 fencing/CAS/cause/exact-input 是分布式 recovery protocol，但没有统一合同。

### PRC-4 — 事务所有权与连接所有权错位 — CONFIRMED

TaskStore scoped admission 已修复自身 CRUD/CAS capture；这不是 connection-level write authority。其他 writer、cross-instance、rollback failure、dirty read、multi-process 仍未统一/未验证。

### PRC-5 — 下游失效缺少统一显式输入有效性合同 — CONFIRMED（精确定义）

正式 evaluator path 已有 exact-input 防线；但 Owner submission-time、repair/recovery、downstream evidence consumption 仍依赖局部防线组合，缺统一合同。

---

## 15. 当前实际不变量

### 15.1 已经成立的不变量（scoped）

1. ordinary lookup identity exact；
2. ordinary creation transaction-time adjudication；
3. orchestrator creation path parent-edge backfill atomic；
4. repair completion stale downgrade guard；
5. same-cause reopen idempotency；
6. repair lineage validation helper shared；
7. preview/confirm ordinary helpers shared。

### 15.2 尚未成立/未证明的不变量

1. logical successor uniqueness 是 DB invariant — FALSE；
2. repair creation outcome structured adopt/conflict — FALSE；
3. direct writers all protected from capture — FALSE；
4. true multi-process creation correctness — UNVERIFIED；
5. cross-instance FIFO/ALS no-deadlock — UNVERIFIED；
6. rollback failure connection health — UNVERIFIED/high risk；
7. Memory transaction parity — FALSE。

---

## 16. 当前架构缺口

### 16.1 Repair Creation Authority 缺口

缺少一个统一 owner 完成：

- exact lookup；
- malformed/conflict adjudication；
- legacy identity verification/backfill orchestration；
- atomic insert；
- UNIQUE-conflict re-arbitration；
- structured `created/reused/adopted/conflict/malformed` outcome；
- host/pd-cli parity。

### 16.2 Evidence Validity Contract 缺口

缺少跨 runner/recovery/owner/repair 的统一输入有效性合同，尤其 Owner submission-time exact-input proof。

### 16.3 Transaction Owner 缺口

缺少 connection/database-level write admission 与 transaction identity。

### 16.4 Recovery Matrix 缺口

缺少两轮 repair full lifecycle、crash fault injection、乱序 completion、owner approval/activation full lifecycle、true multi-process coverage。

---

## 17. 目标状态架构方案

推荐 **方案 B：有限职责收敛**。

目标不是建立一个巨型全局 authority，而是：

1. 每类 logical identity 有正式 contract；
2. 每类 creation 有明确 authority；
3. 每类 semantic transition 有明确 authority；
4. evidence validity 有统一判定 contract；
5. persistence write admission 在 Phase 4 单独收敛；
6. legacy compatibility 走 proof-bound recovery，而非猜测。

---

## 18. 最小收敛策略

### 必须保留

- `InternalizationOrchestrator.commitNextTaskProposal()`；
- `reopenTaskForRevision()`；
- `createLogicalSuccessorTask()`；
- lease/CAS/fencing；
- run/artifact stores；
- owner-resolution service baseline。

### 必须收敛

- repair creation authority；
- repair lookup/adjudication semantics；
- evidence validity contract；
- connection/database write authority（Phase 4）。

### 明确不做

- 不建第二套任务状态机；
- 不重写 runtime；
- 不做 blanket data migration；
- 不在 Phase 1 混入 Phase 4 transaction redesign；
- 不为了 parity 构建复杂 Memory transaction engine。

---

## 19. 接口级状态迁移规约

### 19.1 Repair creation target outcome

目标 repair creation authority 应返回类似以下结构化 outcome：

```text
created
reused_existing_valid
adopted_after_unique_conflict
conflict_identity_mismatch
conflict_malformed_existing
refused_unprovable_lineage
refused_terminal_source_state
```

不得把 UNIQUE violation 简单映射成 generic `seed_failed`。

### 19.2 Repair completion commit

repair completion 必须继续通过 `commitNextTaskProposal()`，并保持：

- same-cause idempotency；
- stale downgrade guard；
- dependency replacement；
- revision epoch increment；
- stale completion intent cleanup。

### 19.3 Evidence consume gate

任何消费 evaluator/owner/artifact evidence 的路径必须能回答：

```text
Which exact artifact/input/epoch/run is this evidence valid for?
```

回答不了就 fail closed。

---

## 20. 完整生命周期测试策略

### 20.1 测试原则

1. SQLite transaction/concurrency behavior 必须使用真实 SQLite；
2. Memory tests 只能证明非事务业务分支；
3. true multi-process claim 必须使用独立 OS process；
4. fault injection 必须注入在 durable boundary；
5. 每个场景必须明确是否允许部分写入；
6. legacy/malformed rows 不得通过删除数据“修好”。

### 20.2 A-U 生命周期测试矩阵

> “现有测试”列只列已核实存在的直接/间接覆盖；未核实则写“未找到直接覆盖”，不把近似测试当成证据。

| 场景 | 测试类型 | 数据准备 | 操作步骤 | 预期状态 | 预期数据库结果 | 是否允许部分写入 | 失败错误分类 | 对应现有测试 | 是否需新增 |
|---|---|---|---|---|---|---|---|---|---|
| A. Ordinary Successor 创建和去重 | real SQLite integration + concurrency unit | parent artificer terminal、valid lineage、channel fixed | 两请求同 `(parent,kind,channel)` 创建 | 一创建一复用/结构化 existing | 仅一行 successor；parent edge 完整 | 否 | `existing/reused`，不得 unique crash | `successor-lookup.test.ts`、`successor-create` 相关测试部分覆盖 | 需补真跨连接/进程强化 |
| B. Repair R1 创建 | real SQLite integration | E evaluator 对 A0 needs_revision，epoch/artifact完整 | 调统一 repair creation authority seed R1 | R1 valid、pending/leased按语义 | 一行 R1；parent=correlation=E；payload/id互证 | 否 | `created`；失败 `refused_unprovable_lineage` 等 | host/pd seeder tests 仅分别间接覆盖 | 必须新增统一 authority 测试 |
| C. Repair R2 合法共存 | real SQLite integration | R1 completed，E reopened/reevaluated，再次 needs_revision | seed R2 | R1/R2 coexist 且不冲突 | 两行不同 round；dependency/lineage正确 | 否 | `created`；不得 ordinary-triple conflict | 未找到完整两轮生产 E2E | 必须新增 |
| D. 同一 Repair 重复创建 | real SQLite integration | 已有 valid R1 | 重放同一 creation request | 复用 existing，不新建 | row count 不变 | 否 | `reused_existing_valid` | host reuse path有部分覆盖 | 必须新增统一 outcome 测试 |
| E. host-runtime 与 pd-cli 同时请求同一 Repair | real SQLite multi-connection；理想多进程 | 同一 evaluator/run/input，host和pd-cli两个 seeder caller | 并发请求同 R1 | winner created，loser adopted/reused | 仅一行 R1；无错误人审 | 否 | `adopted_after_unique_conflict` 或 reused；不得 `seed_failed` | 未找到跨入口并发测试 | 必须新增 |
| F. Repair R1 完成后 evaluator reopen | orchestrator integration + real SQLite | valid R1 succeeded output/artifact/terminal | commit next proposal | E reopened，dependency A0→R1，revisionCount+1 | E pending/runnable；cause recorded；旧 intent清理 | 否 | same-cause no-op；conflict fail closed | orchestrator repair branch tests部分覆盖 | 需补完整 durable matrix |
| G. R1/R2 completion 乱序 | integration/fault-ordering | R1/R2 不同完成顺序/延迟 | 先提交旧 R1 completion，再/后提交 R2 | 较新 round不被旧 completion downgrade | dependency保持最高合法 round | 否 | stale no-op `commit repair outdated` | stale guard单元/集成部分覆盖 | 需新增乱序矩阵 |
| H. Repair 完成后进程崩溃 | crash fault-injection + real SQLite | R1 output/artifact/terminal/intent在不同边界写入后 kill | 在 output后、artifact后、terminal后、commit前/后重启 | recovery只提交一次；无duplicate/错reopen | 中间 partial durable 可存在，但最终不得错误提交 | durable阶段允许 partial；业务终态不允许半生效 | recovery conflict/stale no-op/fail closed | 未找到逐边界 crash matrix | 必须新增 |
| I. Evaluator 成功后 RuleHost replay | integration | E succeeded verdict + rulehost successor/artificer binding | restart/replay RuleHost | 不重复创建 successor/repair；正确 adopt | successor row count不变 | 否 | reused/no-op | RuleHost successor tests部分覆盖 | 需补repair dual-role replay |
| J. 上游 Artificer revision 导致旧 verdict 失效 | real SQLite integration | E verdict bound to old artifact，上游A revision产生新input | 新 artifact/reopen后 recovery/resume | 旧 verdict不得复用；E重评或 fail closed | old evidence retained but not consumed；new epoch/input binding | 否 | stale artifact supersede/no-op/retryable conflict | evaluator exact-input tests部分覆盖 | 需补跨revision完整链 |
| K. stale completion intent | integration/fault injection | intent input artifact 与 current input 不同 | restart/resume evaluator | 不应用 stale effects；重新验证或丢弃/重建 intent | terminal state不基于 stale input；effects不重复 | 否 | stale intent no-op/fail closed | evaluator intent tests部分覆盖 | 需补 crash/epoch组合 |
| L. stale Owner resolution | service + runner integration | Owner提交后输入 artifact 已变化 | submit/apply resolution | submit时优先拒绝/标记；application fallback supersede | resolution不得驱动错误reopen/verdict | 否 | `input_artifact_stale`/reviewKey conflict | runner stale fallback tests存在；submission gap未覆盖 | 必须新增 submission-time exact-input tests |
| M. 两个 consumer 同时处理同一任务 | real SQLite multi-connection + multi-process后续 | same ready task，两consumer实例 | 同时 lease/execute | fenced loser拒绝或no-op；只有owner writes | terminal/effects写一次；lease generation正确 | 否 | lease lost/fenced write rejected | lease/fence tests部分覆盖 | 需真实并发矩阵 |
| N. legacy 缺 parentTaskId | real SQLite legacy fixture | deterministic repair row缺parent/correlation，其余proof完整 | lookup/complete trigger backfill | strict proof下补齐；否则 fail closed | 仅补齐证明字段；无guessing | proofed edge允许；未proof不得写 | backfilled/concurrent_modification/unprovable | `repair-lineage-backfill.test.ts`较强 | 需接creation authority集成 |
| O. legacy 多合法后继 | real SQLite integration | 同parent/kind/channel多行但轮次/身份可区分或不可区分 | lookup/adjudicate | ordinary多行conflict；repair按round区分 | 不删除/合并；返回conflict或正确round | 否 | `successor_integrity_conflict` / repair round resolution | successor conflict tests部分覆盖 | 需补repair-aware adjudication |
| P. legacy malformed metadata | real SQLite fixture matrix | malformed diagnostic_json/repairPayload/channel/parent | scan/lookup/creation | malformed fail closed，不污染valid candidate | 无写入；结构化error telemetry | 否 | malformed identity/lineage | malformed tests部分覆盖 | 必须补全矩阵 |
| Q. lineage backfill 中途失败 | fault injection + real SQLite | multi-edge backfill，第二边CAS失败/崩溃 | standalone或creation path执行 | orchestrator内整体rollback；standalone contract明确 | orchestrator path无部分边；standalone按冻结合同 | Phase1/5需明确；当前standalone可partial | concurrent_modification/backfill_partial（目标不得吞掉） | standalone atomicity无直接覆盖 | 必须新增 |
| R. SQLite direct writer transaction capture | real SQLite dynamic matrix | outer write tx + direct run/artifact/candidate writer | outer rollback | direct write不得“成功幻觉”或必须按合同拒绝 | 按合同：要么拒绝，要么显式纳入同一owner；不得silent surprise | 不允许silent partial | write capture violation/transaction owner conflict | probe仅证明机制；无production matrix | 必须新增 Phase4 |
| S. SQLite rollback failure | fault injection + real SQLite | rollback抛错/连接异常 | run write tx | 不得吞掉连接污染；应surface/degrade/close per contract | connection状态可审计 | 不允许unknown poisoned reuse | transaction degraded/rollback failure | 无直接覆盖 | 必须新增 Phase4 |
| T. true multi-process successor creation | OS-level multi-process real SQLite | two independent processes/workspace connections | concurrent create same successor/repair | lock/busy/adjudication per contract；无double终态 | physical/logical row correct；conflict outcome明确 | 否 | busy timeout/conflict/adopt，不得误判 | 当前“two connections”同进程不算 | 必须新增 Phase4/6 |
| U. 最终 Owner approval / activation | activation E2E + full lifecycle regression | pain→principle artifact→owner review→approval→activation | approve/edit/reject/deactivate | activation only for exact approved current artifact/version | approval/activation rows一致；rollback可逆 | 否 | stale approval/version conflict | `story-a-acceptance.test.ts` covers chain partially | 需与PRI生命周期全链串联 |

### 20.3 测试缺口优先级

1. B-E：repair creation authority；
2. F-H：repair completion/reopen/crash；
3. L：Owner stale resolution；
4. Q：lineage atomicity contract；
5. R-T：SQLite transaction/multi-process；
6. U：最终 owner approval/activation 全生命周期串联。

---

## 21. 分阶段实施路线图（冻结边界）

### Phase 0 — SPEC/ADR/Decision Freeze

**修改模块：** `docs/specs/`、`docs/adr/`、必要 docs index。
**禁止修改：** 所有 production/test/schema/config。
**前置条件：** 当前文档审查完成。
**交付物：** ADR-0031、SPEC v1.1、调查汇总、验收报告。
**验收标准：** OD-1..OD-8 已全部记录为 `OWNER_APPROVED`；Phase 1 授权已明确。
**回滚策略：** 文档分支不合并即可。
**真实 SQLite：** 否。
**真实宿主/公网：** 否。

### Phase 1 — Logical Identity & Repair Creation Authority

**目标模块（允许）：**

- `packages/principles-core/src/runtime/internalization/successor-lookup.ts`
- `packages/principles-core/src/runtime/internalization/successor-create.ts` 或相邻新增 repair creation module
- `packages/principles-core/src/runtime/internalization/repair-task-identity.ts`
- `packages/principles-core/src/runtime/internalization/repair-lineage-backfill.ts`（仅限 authority 集成）
- `packages/host-runtime/src/internalization-consumer-governance.ts`
- `packages/pd-cli/src/services/rulehost-pipeline-runner.ts`
- 必要的 type definitions / runner seed outcome adapter
- 相应测试文件

**禁止修改：**

- schema/migrations；
- SQLite connection/store transaction architecture；
- `sqlite-run-store.ts` / artifact/candidate/approval stores；
- owner-resolution service；
- broad evaluator/artificer runner refactor；
- repair round policy expansion；
- channel topology/product routing。

**前置条件：** OD-1、OD-3、OD-7、OD-8 已批准；dual-role repair lookup semantics 必须显式化。
**交付物：** unified repair creation authority、host/pd parity、structured outcomes、repair-aware identity tests。
**必需测试：** 场景 B-E、N-P 的 repair部分、channel mismatch、pipelineMode inheritance、terminal valid repair classification、UNIQUE race adopt。
**验收标准：** 同 identity 重复创建不产生 generic seed failure；R1/R2合法共存；malformed fail closed；host/pd行为一致。
**回滚策略：** host/pd seeders可回退到现有 direct path；core authority未接入不影响现有行为。
**真实 SQLite：** 必须。
**真实宿主/公网：** 至少真实 host wiring integration；公网不要求。

### Phase 2 — Lifecycle State Transition Authority

**目标：** 收敛 semantic mutation family 的正式 authority、消除非权威状态写。
**允许：** orchestrator/transition decision/reopen/consumer wiring。
**禁止：** transaction architecture redesign、owner/activation redesign。
**前置：** Phase 1 repair identity stable。
**交付物：** transition authority matrix + implementation/test。
**必需测试：** F-I、M、source-correction、cascade/reopen。
**回滚：** authority wiring flag/revert commit。
**真实 SQLite：** 必须用于状态/CAS/reopen路径。
**真实宿主：** integration必需，公网不要求。

### Phase 3 — Repair / Revision / Evidence Validity / Owner Stale Resolution

**目标：** 统一 evidence validity contract，关闭 Owner submission-time exact-input gap。
**允许：** evaluator/owner-resolution integration validators、evidence key contract、recovery gates。
**禁止：** rewrite owner UI/activation product semantics；copy第二套 validation。
**前置：** Phase 1/2 identity/transition authority。
**交付物：** current-input proof reuse、stale resolution policy、cross-module evidence matrix。
**必需测试：** J-L、owner revise_once、stale artifact supersede、activation前提。
**回滚：** runner fallback remains；可禁用新 submission gate但保留 application-time defense。
**真实 SQLite：** 对持久化状态测试必须。
**真实宿主：** owner-path integration必需；公网视产品验收决定。

### Phase 4 — SQLite Transaction / Connection-level Write Admission

**目标：** 设计并实施 transaction owner/write admission。
**允许：** sqlite connection、stores、runtime-state-manager、writer registration、raw access policy。
**禁止：** 把TaskStore FIFO机械复制到所有store；一次性重写所有writer无合同先行。
**前置：** ADR D5批准；Phase 1-3不依赖未定义事务语义。
**交付物：** transaction architecture + implementation + dynamic proof matrix。
**必需测试：** R-T、nested tx、rollback failure、dirty read、multi-connection/multi-process。
**回滚：** phased writer registration / compatibility mode；不得破坏现有lease/fencing。
**真实 SQLite：** 必须。
**真实宿主/公网：** host integration必须；公网不要求。

### Phase 5 — Historical Repair Data & Lineage Remediation

**目标：** legacy repair data audit、proof-bound lineage backfill、operator remediation。
**允许：** lineage audit tooling、repair metadata classification、operator CLI/docs。
**禁止：** silent delete/merge/rename、blanket migration、保留或恢复旧 PD Companion runtime。
**前置：** Phase 1-4合同稳定。
**交付物：** audit report、migration/backfill plan、strict remediation tools。
**必需测试：** N-Q、malformed matrix、UUID-shaped legacy audit fixture。
**回滚：** audit-only mode；不写入未证明 lineage。
**真实 SQLite：** 必须。
**真实宿主/公网：** 需要真实备份/fixture验收。

### Phase 6 — Full Lifecycle E2E

**目标：** 串联 pain→diagnosis→artifacts→repair/revision→owner→activation/rollback。
**允许：** E2E harness、observability assertions、test orchestration。
**禁止：** 借E2E重写生产架构。
**前置：** Phase 1-5主要合同落地。
**交付物：** full lifecycle E2E + crash/restart matrix。
**必需测试：** A-U全矩阵关键路径、两轮repair、owner approval/activation。
**回滚：** test-only rollback；生产问题按对应phase修复。
**真实 SQLite：** 必须。
**真实宿主/公网：** 真实宿主验收必须；公网按Owner要求。

### Phase 7 — Independent Review / Final Acceptance

**目标：** 独立架构/测试评审与最终验收。
**允许：** review docs、small corrective docs/tests。
**禁止：** 借评审扩大scope。
**前置：** Phase 1-6完成。
**交付物：** acceptance evidence、residual risk register、Owner sign-off。
**验收：** 所有PRC关闭或明确接受残余风险。
**真实 SQLite/宿主：** 按 evidence matrix 要求。

---

## 22. 防复发机制

1. ADR-0031 作为 lifecycle identity/authority 合同入口；
2. SPEC v1.1 固定 phase boundary，禁止把 Phase 4 提前混入 Phase 1；
3. repair creation authority 必须提供 structured outcome；
4. SQLite-only correctness claims 必须附真实 SQLite evidence；
5. multi-process claims 必须使用真实 OS process；
6. malformed/legacy rows fail closed；
7. Owner-approved decisions必须逐项落档，不得把未批准事项写成已批准；
8. PD Service Host Only 是 PD 后台服务唯一目标架构；PD Companion 不保留后台执行/Scheduler/Worker/旧 runtime compatibility，但 PRI-1278 迁移工作不混入本 SPEC 的 Phase 1 PR；
9. PR review 检查是否绕开 authority 或新增第二套 truth。

---

## 23. 风险、限制与回滚

### 23.1 技术风险

| 风险 | 状态 | 处理 |
|---|---|---|
| direct-writer capture production impact | mechanism CONFIRMED / production frequency UNVERIFIED | Phase 4 matrix |
| cross-instance FIFO/ALS deadlock | UNVERIFIED static high risk | Phase 4 dynamic proof |
| true multi-process behavior | UNVERIFIED | Phase 4/6 |
| rollback failure connection poisoning | high risk, dynamic UNVERIFIED | Phase 4 fault injection |
| legacy UUID repair rows | existence UNVERIFIED | Phase 5 audit |
| global repair scan surfaces malformed rows | operational risk | creation authority error classification + remediation |
| pd-cli pipelineMode inheritance missing | CONFIRMED | Phase 1 |
| synchronous dual-role evaluator/artificer binding | design tension CONFIRMED | Phase 1 explicit contract |

### 23.2 回滚原则

- Phase 1 authority 未接入前可回退到现有 direct seeders；
- 不做 destructive migration；
- Owner stale gate 可先以 report-only/compat mode验证，再硬 fail；
- transaction rollout 必须保留 lease/fencing 行为；
- 每 phase 独立 PR/验收，避免不可回滚大爆炸。

---

## 24. Acceptance Criteria

### 24.1 Phase 0 acceptance

- [x] PR #2805 merge state corrected；
- [x] latest main SHA recorded；
- [x] v1.0 preserved unchanged；
- [x] five PRC revalidated；
- [x] six architecture decisions written with evidence；
- [x] Owner decisions explicit；
- [x] no production/test code modified；
- [x] OD-1..OD-8 approved and recorded。

### 24.2 Future implementation acceptance

1. R1/R2 identity/coexistence contract enforced；
2. duplicate repair creation has structured reuse/adopt/conflict outcome；
3. host-runtime and pd-cli no longer maintain competing creation logic；
4. repair completion/reopen/recovery is crash-safe under test matrix；
5. stale owner resolution cannot drive wrong reopen/verdict；
6. connection-level write authority defined before rollout；
7. true SQLite/multi-process/fault evidence exists for transaction claims；
8. full lifecycle reaches Owner approval/activation without hidden duplicate state；
9. legacy malformed/unprovable data fails closed with operator-actionable evidence。

---

## 25. Owner 决策记录（已冻结）

| ID | Decision | Status | Rationale | Consequences |
|---|---|---|---|---|
| OD-1 | 批准 §9 logical identity contract（含 channel clarification） | OWNER_APPROVED | channel 是 mandatory consistency dimension，不是独立 uniqueness degree of freedom | Phase 1 必须 fail closed on channel mismatch，不得用 channel 变异制造第二条 repair |
| OD-2 | 保留当前两轮自动 repair 策略 | OWNER_APPROVED | R1/R2 是当前产品治理边界；“2”不是永久身份不变量 | R1/R2 必须拥有不同 identity；不允许同轮 duplicate；不新增 R3+ |
| OD-3 | 批准五类 task identity classes | OWNER_APPROVED | 每类需要明确身份合同而非模糊通用身份系统 | “Manual Repair Task”按本 SPEC 的 operator-remediation/backfill provenance 解释，不创造绕过 authority 的新 logical identity |
| OD-4 | Memory store = Non-Transactional Test Double | OWNER_APPROVED | 不为测试替身建设第二套事务架构 | 关键持久化/原子性测试必须跑真实 SQLite |
| OD-5 | Phase 4 独立处理 transaction architecture | OWNER_APPROVED | 先冻结 transaction ownership/write-admission合同，再统一实现 | Phase 1 禁止 schema/migrations/connection/store transaction architecture 变更 |
| OD-6 | Owner submission-time exact-input validation | OWNER_APPROVED | stale evidence 不得静默提交为有效决策 | Phase 3 范围内实现；Phase 1 不修改 owner-resolution service |
| OD-7 | 启动 Phase 1 | OWNER_APPROVED | Phase 0 证据已足够收敛 identity/create authority | Phase 1 = Logical Identity & Repair Creation Authority，范围以 §21 为准 |
| OD-8 | synchronous RuleHost dual-role repair semantics | OWNER_APPROVED | 保留现有必要业务兼容，但不能依赖隐式类型判断 | evaluator-seeded R1 的 round-2 artificer role transition 必须显式并有测试覆盖 |

---

## 26. 附录：Evidence Matrix

### 26.1 关键源码引用（当前 main tree；merge后无漂移）

- `successor-lookup.ts:1-25,162-261` — ordinary identity/query/adjudication；
- `successor-create.ts:45-207` — allocation/creation/UNIQUE re-arbitration；
- `internalization-orchestrator.ts:934-1055` — repair completion reopen；
- `internalization-orchestrator.ts:1338-1456` — ordinary creation transaction；
- `revision-reopen.ts:34-345` — cause/planner/reopen primitive；
- `repair-task-identity.ts:50-140` — repair payload/id/parent/correlation/channel verification；
- `repair-lineage-backfill.ts:135-205` — proof-bound repair lineage backfill；
- `pitask-metadata.ts:155-157,947-1002` — deterministic repair id and validation；
- `evaluator-runner.ts:940-1059,1085-1167,2155-2202,2654-2899` — input binding/stale resolution/seeding；
- `owner-resolution-service.ts:323-527` — reviewKey/evidence validation/resolution lifecycle；
- `internalization-consumer-governance.ts:194-290` — host repair direct seeder；
- `rulehost-pipeline-runner.ts:848-934,1017-1110` — ordinary unified path + pd-cli repair direct seeder；
- `sqlite-task-store.ts:63-113` — TaskStore FIFO/admission/rollback best effort；
- `memory-task-store.ts:67-190` — non-transactional memory semantics；
- `runtime-state-manager.ts:181-184,232-235` — raw connection + task-store transaction delegation；
- `sqlite-connection.ts:306-325` — task schema physical uniqueness；
- `correlation-lineage.ts:473-529` — standalone multi-edge lineage backfill。

### 26.2 已复核历史说法状态

| 说法 | 状态 |
|---|---|
| Artificer runner 直接 reopen evaluator | FALSE |
| artifact 新增自动触发 evaluator 重评 | FALSE |
| ordinary triple 是所有 successor 的完整身份 | FALSE |
| logical successor uniqueness 是 DB-level invariant | FALSE |
| 所有 state.db writer 已防止 transaction capture | FALSE |
| repair lineage/backfill 复制实现仍存在 | FALSE（已 uplift/shared） |
| repair creation authority 已统一 | FALSE |
| R1/R2 当前物理上不能共存 | FALSE（可共存；冲突是 contract 层 latent conflict） |
| true multi-process successor creation 已证明 | FALSE/UNVERIFIED |
| evaluator exact-input 防线完全不存在 | FALSE |
| 统一 cross-module evidence validity contract 存在 | FALSE |

### 26.3 子代理调查整合结论

四份报告在核心事实上无冲突：

- Agent A：merge audit / main code revalidation；
- Agent B：identity/repair lifecycle；
- Agent C：SQLite transaction/store architecture；
- Agent D：lifecycle recovery/test coverage。

唯一需要架构层调和的点：Agent B 建议 channel 不应是 repair uniqueness 的独立维度。ADR/SPEC 采用折中且更准确的表达：channel 保留在书面 identity 中，但它是 consistency dimension，不是 independent uniqueness degree of freedom。这样既尊重用户建议的完整 key，也符合当前 deterministic id/channel topology 的源码事实。

完整证据摘要见：`docs/specs/PRI-1299-PHASE0-SUBAGENT-INVESTIGATION-SUMMARY-v1.0.md`。

---

## 最终结论

**Phase 0 documentation/architecture work：PASS_WITH_LIMITATIONS — OWNER_DECISION_FROZEN。**
**Phase 1 implementation：READY — OD-1/OD-3/OD-7/OD-8 已批准，授权范围仅限 Logical Identity & Repair Creation Authority。**

剩余实现风险不再是身份合同未决，而是 Phase 1 必须证明 host-runtime 与 pd-cli 都收敛到同一 `RepairCreationAuthority`，并用真实 SQLite、并发、channel/payload mismatch、dual-role transition 与 crash-adjacent 失败场景验证不会生成第二条不确定 repair。
