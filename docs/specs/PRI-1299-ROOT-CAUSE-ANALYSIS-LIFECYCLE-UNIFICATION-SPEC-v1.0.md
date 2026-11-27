# PRI-1299 Root Cause Analysis & Lifecycle Unification SPEC v1.0

> 状态：调查型 SPEC / 待 Owner 审核  
> 调查基准：`aaccb6b4a9b6b3fdee17514b39f01354a825412a`  
> 工作树：`D:\Code\_worktrees\principles\PRI-1299-pipeline-spine-successor-lookup-taskstor`  
> 调查方式：只读源码审查、调用链追踪、现有测试盘点。未修改生产代码，未运行动态数据库实验。  
> 重要限制：本文中的行号对应上述 HEAD。后续代码变更会使行号漂移，但文件、模块与调用链仍是复核入口。

---

## 1. Executive Summary

PRI-1299 / PR #2805 之所以“修一个问题又暴露下一个问题”，不是因为单个开发者漏写了几个条件判断，而是因为当前任务生命周期同时受到五个系统性根因影响：

1. **身份模型混淆**：`taskId`、logical successor identity、repair round identity、revision epoch、run identity、artifact identity 被局部混用。普通 successor 使用 `(parentTaskId, taskKind, channel)`，但 repair round 的实际区分字段是 `repairPayload.repairIteration`；两套规则并存却没有被明确写成一个身份合同。
2. **生命周期权威分散**：RuleHost 同步链、adversarial loop、InternalizationOrchestrator、consumer、reconciliation、repair seeders、CLI/Owner recovery 都能观察或推动同一批任务。多数路径近年已收敛到正式 authority，但 repair seeding 仍绕过统一 logical successor 创建机制。
3. **崩溃恢复依赖多段 durable evidence，而不是单一大事务**：run output、artifact、terminal task state、completion intent、successor creation、revision reopen、lineage backfill 分别持久化。正确性依赖每层幂等/CAS/cause 的组合；任何一个入口只检查局部状态，就会把“内部一致但已过期”的证据当作有效结果。
4. **SQLite 异步事务抽象与真实连接语义不匹配**：`withWriteTransaction` 跨 event-loop tick 持有 connection-wide transaction。刚修复的 FIFO admission 只覆盖 `SqliteTaskStore` 自身 CRUD；`SqliteRunStore`、lease/fenced writer、artifact/candidate/approval/cursor 等 direct writer 仍可能被外层事务捕获或绕过统一语义。Memory store 也不具备 SQLite 的 rollback/atomicity 语义。
5. **历史数据异质且测试缺口集中在真实生命周期交界处**：timestamp chain、缺 parent、缺 correlation、malformed metadata、legacy repair rows、split diagnostician rows 并存。大量单点测试证明局部函数正确；近期已补真实 SQLite 的 successor race、crash recovery、current-input evidence 等测试，但多轮 repair full lifecycle 仍以 memory/helper 测试为主，多进程并发与 direct-writer capture 仍未充分覆盖。

因此，本 SPEC 不推荐全面重写，也不推荐继续堆局部补丁。推荐 **方案 B：有限职责收敛**：

- 用正式身份合同区分 ordinary successor 与 repair successor；
- 把 repair task creation 收敛到一个专用原子创建 authority，并接入统一 write transaction；
- 保持 `InternalizationOrchestrator.commitNextTaskProposal()`、`reopenTaskForRevision()`、`createLogicalSuccessorTask()`、lease/CAS、run/artifact store 的核心地位；
- 把 SQLite transaction/admission ownership 从 `SqliteTaskStore` 提升到 connection/database 层级，覆盖所有 state.db writer；
- 明确 Memory store 是“非事务 test double”，或将其升级为 copy-on-write/rollback 的 faithful double；
- 用真实 SQLite lifecycle E2E 和 multi-process concurrency 测试补齐检测缺口。

本调查结论为 **PASS_WITH_LIMITATIONS**：入口盘点、主要根因和最小方案均有源码证据；限制是没有执行新的动态并发实验，真实多进程、`SQLITE_BUSY`、rollback failure、direct-writer capture 的动态表现仍需按本文测试计划验证。

---

## 2. Investigation Scope

### 2.1 已执行

- 核对本地/远程 PR 分支：均为 `aaccb6b4a9b6b3fdee17514b39f01354a825412a`，工作区干净。
- 只读审查 production source、schema、store、runner、orchestrator、RuleHost、adversarial loop、repair/source-correction、legacy inference、现有测试。
- 五个独立调查面：identity、lifecycle/recovery、repair/invalidation、storage/transaction、tests/history。
- 交叉核对此前评审指认，不直接采纳任何二手结论。

### 2.2 未执行

- 未修改生产代码、测试、schema、package 配置。
- 未运行新的动态数据库实验或并发故障注入。
- 未推送任何变更到 PR #2805。

### 2.3 证据状态词表

- **CONFIRMED**：源码路径、调用链和/或现有测试共同证明。
- **PARTIALLY_CONFIRMED**：部分成立或仅在受限范围成立。
- **NOT_REPRODUCIBLE**：本轮未动态复现；可能有静态证据但无执行证据。
- **FALSE**：源码证明该判断错误。
- **UNVERIFIED**：证据不足，必须后续验证。

---

## 3. Repository Snapshot

| 项 | 值 |
|---|---|
| Investigation HEAD | `aaccb6b4a9b6b3fdee17514b39f01354a825412a` |
| Branch | `ai/PRI-1299-pipeline-spine-successor-lookup-taskstor` |
| 工作区状态 | 调查开始时 clean |
| 关键新近修复 | `5021a8925` successor creation/lineage backfill 原子化；`aaccb6b4a` SqliteTaskStore write admission |
| 主要相关 PR | #2805（当前未合并工作分支）；#2803 `ai/PRI-1293-pipeline-spine-phase-2b3` 已于 2026-11-26 11:15:05Z merged，HEAD `9a734dfe596e44b0882b3c1029ed337db41b7f26` |
| PR #2803 与本调查关系 | #2803 已把单步执行收编、构造点守卫与 PeerRunnerKind 父链血缘收紧合入 main，是当前源码的基础事实；本文不复述其评审摘要，而是直接核验合并后代码。它解释了为什么 ordinary spine 已相对收敛，也暴露出 repair、recovery、transaction admission、legacy compatibility 尚未被同一合同覆盖。 |

---

## 4. Current Architecture Overview

当前真实生命周期由以下层次组成：

1. **入口层**：pain ingress、candidate/diagnose CLI、RuleHost、host consumer、Owner/operator recovery、reconciliation。
2. **任务图/转移层**：`InternalizationOrchestrator`、`proposeNextTask`、`commitNextTaskProposal`、`revision-reopen`、`successor-lookup/create`。
3. **执行层**：`BasePeerRunner` 及 Dreamer/Philosopher/Scribe/Artificer/Evaluator/Rollout runner；同步 adversarial loop 与 RuleHost 调用同一批 runner，但触发方式不同。
4. **证据层**：`runs`、`pi_artifacts`、task metadata、completion intent、runnerDecision、repairPayload、revisionCauseId、ownerResolutions。
5. **持久化层**：`RuntimeStateManager` 聚合 `SqliteTaskStore`、`SqliteRunStore`、artifact/candidate/lease/approval 等 store；这些 store 共享同一个 SQLite connection，但尚未共享同一个 write-admission authority。

关键事实：当前架构不是“没有状态机”，而是**状态机权威在多个历史阶段逐步补上后，仍有若干创建/存储路径没有完全纳入同一合同**。

---

## 5. Task Creation Entry Points Inventory

### 5.1 统计口径

计数单位是**语义上独立的业务/生命周期创建路径**，不是 `createTask` 文本命中数，也不是同一调用链上的包装函数数。具体规则：

1. `RuntimeStateManager.createTask` 只是代理，不是业务入口。
2. `createLogicalSuccessorTask` 内 preferred/fallback 两次 insert 属于同一个 logical creation authority，不按两个业务入口计。
3. 同一 candidate/dreamer 创建 helper 若被多个命令复用，只有在调用链承载不同业务触发时才分别计数。
4. demo/synthetic writer 位于 production `src`，但不是正常 Owner lifecycle；单独计数，不混入主 lifecycle。
5. schema migration、运行时 lineage backfill、operator remediation 分开统计。

搜索结果口径：

- 全仓库 `.createTask(` 文本命中约 619 处 / 166 文件，绝大多数是测试 fixture，不代表业务入口数。
- production non-test `.createTask` 直接调用约 17 处。按语义折叠 helper/fallback 后，正常 lifecycle/backfill 为 14 类路径；另有 demo/synthetic 3 个直接写入点，以及 1 个 exported 但当前无 in-repo production caller 的 `seedIntakeTask`。这些数字的计量单位不同，不作算术相加。
- `createLogicalSuccessorTask(` 生产定义 1 处，普通 logical successor 生产调用 3 处，其余为测试。
- production `src` 中真正 `INSERT INTO tasks` 的低层实现只有 1 处：`packages/principles-core/src/runtime/store/task/sqlite-task-store.ts:120-138`。

### 5.2 正常 lifecycle / operator-remediation 创建入口（14 类）

| ID | 分类 | 入口 | 文件/行号 | 调用方 | 创建任务类型 | 统一机制状态 | 风险 |
|---|---|---|---|---|---|---|---|
| C1 | root/intake | 异步 pain ingress | `pain-signal-bridge.ts:561-576` | host/CLI pain ingress | `diagnostician` 根任务 | 不适用；直接 `createTask` | 与 C2 有 read-check-write 竞态，最终靠 taskId UNIQUE |
| C2 | root/intake | 同步 `onPainDetected` 缺失补建 | `pain-signal-bridge.ts:1348-1407` | host pain callback | `diagnostician` 根任务 | 不适用 | 同 C1 |
| C3 | root/intake | diagnosis completion 后 Dreamer seed | `pain-signal-bridge.ts:2181-2204` | pain bridge | `dreamer` 根任务 | 不适用；seed factory + direct write | deterministic id + UNIQUE adopt，非 successor contract |
| C4 | root/intake | `pd diagnose` completion intake | `packages/pd-cli/src/commands/diagnose.ts:972-1001` | CLI diagnose | `dreamer` 根任务 | 不适用 | 与 C3 共享 factory/去重逻辑 |
| C5 | root/intake | `pd candidate internalize` | `packages/pd-cli/src/commands/candidate.ts:747-803` | CLI candidate | `dreamer` 根任务 | 不适用 | dry-run/confirm 语义需保持 |
| C6 | root/intake | candidate review/consumed-candidate Dreamer seed | `candidate.ts:1447-1583` | candidate review/consumption flow | `dreamer` 根任务 | 不适用 | 与 C5 共用工厂但业务触发不同 |
| C7 | fixed subtask | split diagnostician 子任务 | `split-diagnostician-runner.ts:706-729` | `SplitDiagnosticianRunner` | rootcause/distiller/router 子任务 | 不适用；fixed deterministic id | metadata 不写 `pi_metadata.parentTaskId` |
| C8 | ordinary successor | orchestrator logical successor | `internalization-orchestrator.ts:1338-1456` → `successor-create.ts:108-207` | consumer/run-once/enqueue/reconciliation/repair commit | ordinary spine successor | **是** | 已在 HEAD 原子化；依赖所有调用方不绕行 |
| C9 | ordinary successor | RuleHost synchronous spine successor | `rulehost-pipeline-runner.ts:848-934` → `successor-create.ts` | RuleHost | philosopher/scribe | **是** | 已收敛；timestamp id 不再是 identity |
| C10 | ordinary successor | adversarial loop successor | `adversarial-loop.ts:635-663` → `successor-create.ts` | synchronous adversarial loop | artificer/evaluator | **是** | 与 repair-specific identity 存在模型交叠 |
| C11 | repair successor | host-runtime repair seeder | `packages/host-runtime/src/internalization-consumer-governance.ts:194-290` | evaluator repair effect | repair artificer | **否** | 绕过 logical successor authority；deterministic id 防重但无统一仲裁/结构化 outcome |
| C12 | repair successor | pd-cli repair seeder | `packages/pd-cli/src/services/rulehost-pipeline-runner.ts:1017-1110` | evaluator repair effect | repair artificer | **否** | 同 C11，且与 host 是复制实现 |
| C13 | operator remediation/backfill | consumed-candidate missing Dreamer backfill | `candidate.ts:2645-2653` | `pd candidate` internalization backfill | `dreamer` 根任务 | 不适用；operator remediation | 写前须经 admission/suppression gate；不是 schema migration |
| C14 | operator remediation/backfill | pending-candidate intake + Dreamer backfill | `candidate.ts:2818-2826` | `pd candidate` backfill `--include-pending` | `dreamer` 根任务 | 不适用；operator remediation | intake 已成功但 seed 失败会产生 consumed candidate，需要二次恢复路径 |

**统计结果（互斥分类）**：

- root/intake 创建入口：**6 类**（C1-C6）。
- fixed diagnostician subtask 入口：**1 类**（C7）。
- ordinary logical successor 创建入口：**3 类**（C8-C10），均已走统一 helper。
- repair logical task 创建入口：**2 类**（C11-C12），当前未走统一 helper。
- operator remediation/backfill 创建入口：**2 类**（C13-C14）。
- 正常 lifecycle / operator-remediation 创建入口合计：**14 类**。
- schema migration 中的 task backfill insert：**0 个**。
- 测试专用创建 fixture 家族：至少 **8 个主要家族**（successor lookup、round8、RuleHost convergence、adversarial loop、evaluator-runner-deps、verdict-drift、repair-lineage、enqueue-successors SQLite）。

### 5.3 不计入正常 lifecycle 的 production-src 写入

| 类型 | 文件/行号 | 说明 |
|---|---|---|
| synthetic baseline runner | `packages/pd-cli/src/services/synthetic-baseline-runner.ts:313` | synthetic/demo 数据写入；不是 Owner 正常 lifecycle |
| demo story diagnostician | `packages/pd-cli/src/services/demo-story-a-runner.ts:355` | demo 数据写入 |
| demo story dreamer | `packages/pd-cli/src/services/demo-story-a-runner.ts:403` | demo 数据写入 |

这 3 个直接写入点计入 raw production-source inventory，但不计入上述 14 个正常 lifecycle/backfill 语义入口。

### 5.4 exported 但当前无 in-repo production caller 的创建 capability

`seedIntakeTask` 位于 `intake-to-internalization-bridge.ts:370-407`，并经 runtime barrel 导出。当前仓库内 production caller 未命中；它仍是一个 public/exported task creation capability。若外部 host 使用它，它属于 root/intake fixed-seed 创建路径，而不是 logical successor 创建路径。后续统一治理不能只 grep 当前仓库 caller；需要决定是否保留该 public seam、降级为 internal，或在 export contract 中明确其身份类别。

### 5.3 低层写入与运行时回填

| 类型 | 入口 | 文件/行号 | 说明 |
|---|---|---|---|
| 低层 insert | `SqliteTaskStore.createTask` | `sqlite-task-store.ts:115-140` | 唯一生产 raw `INSERT INTO tasks`；只有 `task_id` primary key |
| 普通 update | `SqliteTaskStore.updateTask` | `sqlite-task-store.ts:153-181` | 动态 patch |
| 单行 CAS | `updateTaskWithPreconditions` | `sqlite-task-store.ts:232-323` | diagnostic/status/lease/artifact preconditions |
| generic lineage backfill | `resolveAuthoritativeCorrelationIdWithLegacyBackfill` | `correlation-lineage.ts:473-529` | 先 plan，再逐边 CAS；standalone 多 edge 非整体事务 |
| repair lineage backfill | `validateAndBackfillRepairLineage` | `repair-lineage-backfill.ts:135-205` | repair 身份验证后单 CAS |
| candidate remediation | candidate backfill/intake | `candidate.ts:2645-2653`, `2818-2826` | operator-initiated remediation，不是 schema migration |

---

## 6. Task Recovery Entry Points Inventory

恢复必须分层：恢复 task state、run result、artifact、evaluator verdict、downstream chain 不是同一个操作。

| ID | 恢复入口 | 文件/行号 | 恢复对象 | 读取的数据源 | 是否可能重复执行 | 风险 |
|---|---|---|---|---|---|---|
| R1 | lease-expiry sweep | `internalization-consumer-cycle.ts:204-226`; `recovery-sweep.ts:122-143` | leased task state | lease/status/expires/generation | 否，状态迁移幂等 | heartbeat/recovery 竞态需 fencing |
| R2 | completion-intent resume | `base-peer-runner.ts` 约 `:450`; `evaluator-runner.ts:2190-2202` | run result/verdict | completionIntent + run output + current input artifact | 不应；输入过期则 fresh execution | 旧 intent 冒充新输入已被修复并需保持回归 |
| R3 | succeeded-transition reconciliation | `internalization-orchestrator.ts:1538-1665` | downstream chain transition | succeeded tasks + cursor + successor lookup | 不应；cause/successor 幂等 | reconciliation 本身不制造新触发，只 replay |
| R4 | adversarial durable evidence recovery | `adversarial-loop.ts` 约 `:97` 起 | run/artifact/verdict evidence | durable run output、artifact、intent | 不应；succeeded 走 recovery probe | 证据内部一致但输入过期曾是核心缺陷 |
| R5 | revision cascade recovery | `internalization-orchestrator.ts:1208-1274`; `revision-reopen.ts:68-88` | downstream task epoch | revisionCount/cause/successor state | 同 cause no-op | cascade 是正式失效机制 |
| R6 | repair-completion reopen | `internalization-orchestrator.ts:934-1055` | source evaluator epoch | repairPayload + lineage + cause | 同 cause no-op | repair identity contract 尚未统一 |
| R7 | source-correction targeted reopen | `internalization-orchestrator.ts:1063-1092`, `1713-1835` | original artificer | sourceCorrectionReceipt + scribe epoch | 同 receipt outcome no-op | 专用路径，不能退化为通用 cascade |
| R8 | RuleHost successor reuse | `rulehost-pipeline-runner.ts:848-934` | synchronous spine chain | successor lookup + task status | succeeded reuse，不重跑 | leased/failed/NHR blocked，语义与 async consumer 分层不同 |
| R9 | failed task batch recovery | `runtime-recovery-failed-tasks.ts:105-208`; `recovery-sweep-service.ts:257-295` | failed task | status/attempt budget/metadata | CAS 防双恢复 | operator override 需审计 |
| R10 | strict single-task recovery | `recovery-sweep-service.ts:304-375` | failed task | strict facts | CAS 防双恢复 | 不接受 active lease/pending intent |
| R11 | Owner authority reset | `owner-retry.ts:59-156` | NHR task | owner decision capability + metadata | resolution 存在时拒绝误恢复 | Recover 不能替代 Owner decision |
| R12 | owner evidence recovery | `owner-evidence-recovery.ts` 约 `:279-721` | evidence-review NHR | evidence state + artifacts | resume 后状态核验 | 只适用 evidence review，不是普通 verdict recovery |

**统计结果**：恢复入口 **12 类**。

---

## 7. Task State Mutation Inventory

| ID | 修改入口 | 原状态 | 新状态 | 调用方 | CAS | 事务 | 统一决策 |
|---|---|---|---|---|---|---|---|
| M1 | lease acquisition/renew/release | pending/retry_wait/leased | leased/pending/retry_wait | `lease-manager.ts:154-337` | 是 | acquisition 是 IMMEDIATE | lease manager |
| M2 | expired lease recovery | leased | retry_wait/failed | `recovery-sweep.ts:122-143` | conditional update | 是 | recovery policy |
| M3 | runner terminal writes | leased | succeeded/failed/NHR | BasePeerRunner/concrete runners | fenced CAS | 部分组合事务 | runner result |
| M4 | fenced diagnostic metadata write | 任意 leased active row | metadata update | `runtime-state-manager.ts:501`; `fenced-task-writer.ts:140-168` | 是 | 视调用路径 | runner/governance |
| M5 | logical successor creation | 无行 | pending | `successor-create.ts:108-207` | DB UNIQUE + lookup | 是 | successor authority |
| M6 | commit transition / cascade | terminal successor | pending reopened | `commitNextTaskProposal` + `reopenTaskForRevision` | 是 | reopen 单 CAS；外层非全事务 | orchestrator/planner |
| M7 | repair completion evaluator reopen | evaluator succeeded/NHR | pending new epoch | `REOPEN_SOURCE_EVALUATOR` | 是 | 单 CAS | orchestrator |
| M8 | Owner resolution / supersession | NHR/pending | pending / metadata resolution state | owner-resolution-service / evaluator-runner | 是 | 单 CAS | owner authority/runner |
| M9 | failed/NHR recovery | failed/NHR | pending | recovery services / owner-retry | 是 | 视路径 | operator/Owner recovery authority |
| M10 | source-correction specialized reopen | scribe/artificer terminal/NHR | pending new epoch | source-correction branch | 是 | 单 CAS + receipt | source-correction authority |

**统计结果**：任务/运行状态语义写入口 **10 类**。这里的“统一决策”指是否存在单一语义 authority；不代表所有写都已纳入同一个数据库事务。

### 7.1 direct state.db writer inventory（事务边界审计）

以下 writer 能修改 state.db 中的 lifecycle-adjacent 状态，但当前**没有**进入 `SqliteTaskStore` 私有 FIFO。它们不全部是“任务状态机 authority”；列出的目的，是明确哪些写仍可能在同一 connection 的 async transaction 期间被捕获或绕过统一事务语义。

| Writer | 代表文件/行号 | 写对象 | 当前保护 | 残余风险 |
|---|---|---|---|---|
| run output/run terminal | `packages/principles-core/src/runtime/store/run/sqlite-run-store.ts:107-203`; `packages/principles-core/src/runtime/store/runtime-state-manager.ts:513-531` | runs/outputPayload/executionStatus | 单语句 atomic；无 FIFO | 可被外层 transaction capture，成功后随 rollback 消失 |
| lease/fenced lifecycle | `packages/principles-core/src/runtime/store/lifecycle/lease-manager.ts:154-388`; `packages/principles-core/src/runtime/store/lifecycle/fenced-task-writer.ts:140-274` | lease/status/run/metadata | owner+generation conditional write；自身 transaction | 仍绕过统一 admission；forceExpire 是 recovery-only primitive |
| diagnostician commit/candidate/artifact | `packages/principles-core/src/runtime/store/commit/diagnostician-committer.ts:183-263` | task+artifact+candidate | 自身 IMMEDIATE transaction | nested/interleaving 与 outer manual transaction 未统一 |
| candidate store | `packages/principles-core/src/runtime/store/candidate/sqlite-candidate-store.ts:84-115`, `203-404` | candidate status/admission document | 单语句或自身 transaction | 外层事务期间语义未定 |
| PI artifact store | `packages/principles-core/src/runtime/store/artifact/sqlite-pi-artifact-store.ts:83-97`, `145-168`, `223-226` | artifact rows/validation status | epoch unique/upsert | 不参与统一 write admission |
| family/approved-rule revision | `packages/principles-core/src/runtime/store/task/sqlite-family-reopen.ts:22-45`; `packages/principles-core/src/runtime/store/task/sqlite-approved-rule-revision.ts:17-48` | task family/revision state | 自身 transaction/CAS | direct SQL writer，未被 TaskStore FIFO 覆盖 |
| reconciliation cursor | `packages/principles-core/src/runtime/store/reconciliation-cursor-store.ts:32-48` | cursor rows | UPSERT/DELETE | 可被 capture；cursor correctness 会影响 replay |
| pain/dead-letter/intent stores | `packages/principles-core/src/runtime/store/pain-diagnosis/sqlite-pain-diagnosis-store.ts:112-118`; `packages/principles-core/src/runtime/store/pain/sqlite-dead-letter-store.ts:94-138`; `packages/principles-core/src/runtime/store/intent/sqlite-intent-doc-version-store.ts:68-70`; `packages/principles-core/src/runtime/store/intent/sqlite-intent-decision-store.ts:478-511` | pain/intent evidence | store-local atomicity | 不属于 task authority，但共享 connection 风险相同 |
| approval/activation stores | `packages/principles-core/src/runtime/activation/sqlite-approval-store.ts:355-520`; `packages/principles-core/src/runtime/activation/sqlite-activation-state-store.ts:94-317`; `packages/principles-core/src/runtime/activation/sqlite-activation-safety-store.ts` | approval/activation state | store-local transaction/conditional writes | 不属于 task authority，但必须纳入 connection-level contract |
| raw connection escape hatch | `packages/principles-core/src/runtime/store/runtime-state-manager.ts:180-184` | 任意 state.db write | 无 | 任何 caller 都可绕过全部 store-level admission |

结论：M1-M10 是**语义状态迁移入口**；本表是**物理写入口风险面**。二者不能混为一谈。统一方案必须先覆盖语义 authority，再把物理写 admission 提升到 connection/database 层。

---

## 8. Downstream Reevaluation Triggers

### 8.1 权威失效触发

| 触发事件 | 上游任务 | 下游任务 | 当前处理模块 | 是否使旧结果失效 | 是否幂等 |
|---|---|---|---|---|---|
| 上游 revision 完成后 cascade | 任意 revised source | terminal logical successor | orchestrator + `planExistingSuccessorTransition` | 是，reopen 清空 verdict/intent | causeId 幂等 |
| repair artificer R1/R2 完成 | repair artificer | source evaluator | `REOPEN_SOURCE_EVALUATOR` | 是，revisionCount+1 且换 dependency | repair cause 幂等；旧 round 不得降级 |
| Owner `revise_once` | Owner decision target | target task | owner-resolution-service + reopen | 是 | resolution-scoped cause 幂等 |
| source correction 授权并完成新 scribe epoch | scribe | original artificer | source-correction branch | 是 | receipt/cause 幂等 |
| rollout needs_revision routing | rollout evaluator/reviewer | revision target | rollout routing + reopen | 是 | cause 幂等 |
| approved replay failed / provenance gate | evaluator evidence | evaluator repair loop | evaluator transition decision | 不直接 reopen；触发 repair seed/阻断 advance | durable evidence 幂等 |

**权威失效触发数：6 类**。

### 8.2 重放/执行机制而非新失效事件

| 机制 | 作用 | 是否应产生新失效 |
|---|---|---|
| reconciliation | 补齐 crash 前未完成的 commit transition | 否，只 replay 原 cause |
| consumer pending scheduling | 执行已 reopen/pending 的任务 | 否 |
| adversarial loop restart | 从 durable evidence 恢复或调用正式 cascade | 否 |
| RuleHost rerun | reuse/execute/blocked existing successor | 否 |

因此，下游重评的真实事件源不是“artifact 多了一行”，而是**正式 reopen/cause**。artifact revision 本身不是 invalidation event。

---

## 9. Logical Identity Analysis

### 9.1 必须区分的身份

| 身份 | 当前载体 | 语义 |
|---|---|---|
| TaskRecord identity | `tasks.task_id` primary key | 物理行身份；不等于 logical identity |
| Ordinary logical successor identity | `(parentTaskId, taskKind, channel)` | 普通 spine successor 的逻辑唯一键 |
| Repair successor identity | `(sourceEvaluatorTaskId, repairPayload.repairIteration)` + deterministic id/payload mutual proof + channel/correlation consistency | 自动修复轮次身份 |
| Task revision identity | `(taskId, revisionCount / revisionCauseId)` | 同一 TaskRecord 的新 epoch |
| Execution/run identity | `runs.run_id` | 一次执行尝试或 completion 证据 |
| Artifact identity | `artifactId` + `sourceTaskId` + `artifactKind` + `revisionEpoch` + content hash | 某 epoch 的输出证据 |
| Evaluation result identity | evaluator run output + decision artifact + bound `sourceArtificerArtifactId` | 对某一输入 artifact 的 verdict |

### 9.2 字段参与情况

1. 普通 successor logical identity 当前参与字段：`parentTaskId`、`taskKind`、`channel`。
2. `dependencyTaskIds` 是输入依赖，不是 causal parent 权威。
3. `repairIteration` 在 `pi_metadata.repairPayload.repairIteration` 中，不在普通 triple 中。
4. `revisionCauseId` 不是 task identity；它是 reopen epoch 的因果消费标记，且单槽可被后续 cause 覆盖，必须结合 `consumedRevisionCauseIds`。
5. `taskId` 对普通 successor 不是 identity；但 deterministic repair id 与 legacy producer-shape inference 中，taskId shape 是 repair/legacy proof 的一部分。

### 9.3 Repair 多轮身份结论

对同一 evaluator `E`：

- R1：`artificer-repair-<E>-r1`
- R2：`artificer-repair-<E>-r2`

二者通常都是：

- `taskKind='artificer'`
- `parentTaskId=E`
- 同 channel

因此，若把 `(parentTaskId, taskKind, channel)` 当作**所有** logical successor 的完整唯一键，R1/R2 会被错误判为重复。当前它们能共存，是因为 repair seeders 绕过统一创建权威；这不是健康设计，而是合同缺口。

**结论**：CONFIRMED — 需要把 repair successor identity 明确建模为 repair-scoped key，而不是强行套用 ordinary triple，也不能允许任意重复。

推荐最小合同：

```text
RepairSuccessorIdentity =
  parentTaskId (= sourceEvaluatorTaskId)
  + taskKind = 'artificer'
  + channel
  + repairPayload.repairIteration
  + deterministic taskId/payload mutual proof
```

普通 successor 仍使用：

```text
OrdinarySuccessorIdentity =
  parentTaskId + taskKind + channel
```

### 9.4 数据库唯一性事实

`tasks` schema 只有 `task_id TEXT PRIMARY KEY`（`sqlite-connection.ts:306-325`），没有 `(parentTaskId, taskKind, channel)` 或 repair key 的唯一约束。所谓 uniqueness 目前是**参与 writer 的 procedural invariant**，不是全库 DB-level invariant。

---

## 10. Repair Multi-Round Lifecycle

以下以 evaluator `E`、原始 artificer `A0` 为例。

| 步骤 | TaskRecord | parent/dependency | revision/cause | run/artifact | 当前权威 verdict |
|---|---|---|---|---|---|
| 1. A0 创建规则 | `A0` 新建并 succeeded | parent/dep 指向 scribe | `revisionCount=0` | runA0/artifactA0 | 无 evaluator verdict |
| 2. E 首次评估 | `E` succeeded | dep=A0；parent 通常为 A0 | epoch0 | runE0/artifactE0；output 绑定 `sourceArtificerArtifactId=artifactA0` | `needs_revision` |
| 3. seed R1 | `R1` pending | parent=E；dep 继承原 scribe；payload iteration=1 | 无 revision cause | 无 | E 仍 succeeded 但 commit blocked |
| 4. R1 成功 | `R1` succeeded | 同上 | 无 | runR1/artifactR1 | repair evidence |
| 5. commit R1 | E reopened | E dep 从 A0 换为 R1 | E `revisionCount+1`; `revisionCauseId=repair-R1`；旧 verdict/intent 清空 | 不新建 E artifact yet | 无有效 verdict |
| 6. E 第二轮执行 | E succeeded | dep=R1 | epoch1 | runE1/artifactE1 绑定 artifactR1 | 再次 `needs_revision` |
| 7. seed R2 | `R2` pending | parent=E；payload iteration=2 | 无 | 无 | E blocked |
| 8. R2 成功并 commit | E reopened | E dep R1→R2 | `revisionCauseId=repair-R2`；旧 cause 折入历史 | runR2/artifactR2 | 无有效 verdict |
| 9. E 第三轮执行 | E succeeded | dep=R2 | epoch2 | runE2/artifactE2 绑定 artifactR2 | approved/needs_revision |
| 10. 若仍 needs_revision | 不创建 R3 | — | — | — | NHR / Owner decision |
| 11. Owner 审批/发布 | Owner/activation path | — | — | — | Owner/runtime authority |

关键源码证据：

- repair id 规则：`pitask-metadata.ts:146-157`
- payload schema与 `[1,2]` 边界：`pitask-metadata.ts:82-144`, `946-1002`
- seed 决策：`evaluator-runner.ts:1838-1886`, `2795-2826`
- repair completion transition：`internalization-transition-decision.ts:90-94`
- reopen 原子改写：`revision-reopen.ts:272-344`
- stale repair downgrade guard：`internalization-orchestrator.ts:987-1015`

### 10.1 中断与重放

- R1 succeeded 后 crash：reconciliation/consumer 再次 commit，`repair-<R1>` cause 已消费则 no-op。
- E reopened 后 crash：E 已是 pending，正常调度执行新 epoch，不重新创建 R1。
- E 第二轮 seed 后 crash：同一 evaluator run 已 seed 时复用，不递增 iteration。
- R1/R2 completion 乱序：旧 round completion 不得把 dependency 从 newer round 降级。

---

## 11. Upstream Revision Invalidation

### 11.1 当前真实规则

Evaluator 不会因为 artifact 行变化自动失效。失效依赖正式 reopen；恢复层再用 input binding 做纵深防御。

一个 evaluator verdict 只对以下输入有效：

```text
output.sourceArtificerArtifactId
  == resolveCurrentArtificerInput(current evaluator dependency).artifactId
```

并且 completion intent 还必须匹配当前 `revisionEpoch`。

已证实机制：

1. reopen 清空 `runnerDecision/completionIntent` 并递增 `revisionCount`：`revision-reopen.ts:272-299`。
2. intent epoch 不等当前 epoch 不得 resume：`evaluator-runner.ts:2169-2195`。
3. intent output 的 `sourceArtificerArtifactId` 必须等于当前输入 artifact：`evaluator-runner.ts:988-1004`, `2196-2202`。
4. Owner resolution 的原证据输入过期时进入 `superseded/input_artifact_stale`：`evaluator-runner.ts:1006-1059`。
5. terminal recovery 用当前输入 artifact 重新验证 durable evidence：`evaluator-runner.ts:1085-1167`。

### 11.2 最小失效判断规则

推荐使用现有字段，不新建版本管理系统：

```text
EvaluatorEvidenceValid(E) =
  E.runnerDecision 来自未被 reopen 清空的当前 revision epoch
  AND durable output/artifact/run evidence 一致
  AND output.sourceArtificerArtifactId == current selected artifact of exactly-one artificer dependency
  AND adversarial replay/provenance gates pass
```

`revisionCount` 与 artifact revision epoch 是辅助证据；最终有效性必须落到 exact input artifact binding。不能用“E succeeded”“dependencyTaskIds 包含某 repair task”“当前 artifact 存在”替代。

---

## 12. SQLite / Memory Store Contract

### 12.1 行为对照表

| 操作/语义 | SQLite 当前 HEAD | Memory 当前 HEAD | 是否一致 | 差异风险 |
|---|---|---|---|---|
| 普通创建 | `INSERT`；duplicate taskId 抛错 | `Map.set` 覆盖同 id | **否** | Memory 掩盖 duplicate 防重问题 |
| 同实例并发创建 | FIFO + BEGIN IMMEDIATE | 实例 queue 仅序列化 transaction callback，普通写不排队 | 否 | 并发语义不可比 |
| 独立实例并发创建 | 进程内 FIFO 串行；跨进程靠 SQLite lock | Map 进程内单实例语义 | 否 | Memory 不能模拟跨连接 |
| 嵌套事务 | 同 store ALS active 时 join；无 savepoint | 也 join但 rollback 无效 | 否 | 使用者易误解 nested transaction |
| 事务回滚 | callback throw → best-effort rollback | 完全无 rollback | **否** | Memory 不能验证崩溃/回滚正确性 |
| 事务外 TaskStore 写入 | 无 active context 则 FIFO admission | 不入队 | 否 | SQLite 刚修复，Memory 未模拟 |
| 事务外 Run/direct writer | 仍可被 connection-wide transaction 捕获 | 不适用 | N/A | 关键未闭合缺口 |
| CAS | 单条 conditional UPDATE，含 lease/artifact preconditions | JS 比较；无 artifact CAS | 部分 | Memory 不是 faithful double |
| Lease fencing | owner+generation+expiry conditional write | 字段模拟 | 部分 | unfenced/raw write 仍可绕过 |
| Legacy backfill | CAS；创建路径已在 orchestrator transaction 内 | 无 SQLite 等价 | 否 | standalone 多 edge atomicity 未定 |
| dirty read | 同 connection 无关读可见未提交状态 | Map 立即可见 | 否 | 读隔离合同缺失 |

### 12.2 SQLite 当前确认事实

1. FIFO admission 已覆盖 `SqliteTaskStore` 自身 CRUD/CAS：`sqlite-task-store.ts:63-113`，测试 `sqlite-task-store.test.ts:206-269`。
2. `withWriteTransaction` 手写 `BEGIN IMMEDIATE`，callback 跨 async boundary：`sqlite-task-store.ts:86-107`。
3. rollback failure 被吞：`sqlite-task-store.ts:99-103`。
4. `SqliteRunStore` 无 admission，`updateRunOutput` 可在外层 transaction 期间被捕获：`runtime-state-manager.ts:513-531`; `sqlite-run-store.ts:154-203`。
5. direct writer 还包括 lease/fenced writer、artifact/candidate/approval/cursor/pain/intent/activation 等；raw `connection` getter 是逃生舱：`runtime-state-manager.ts:180-184`。
6. 跨进程无 FIFO；只有 SQLite write lock/busy timeout。better-sqlite3 同步等待还可能阻塞 event loop。

### 12.3 统一 Store Contract 建议

不要求 SQLite 与 Memory 内部实现相同，但对外必须满足：

1. 一个 logical write unit 要么全部可见，要么全部不可见。
2. 独立调用者的 write 不得被其他调用者的 transaction 捕获。
3. nested write 必须显式声明 join-owner 或 new-unit 语义；禁止隐式跨实例死锁。
4. CAS precondition 与 mutation 在同一原子单元。
5. lease fencing 是执行写必要条件，不是可选调用习惯。
6. rollback 只回滚属于该 transaction identity 的写。
7. unrelated reader 不得观察 uncommitted owner state；至少必须明确当前限制并禁止依赖。
8. Memory 若不能提供以上语义，必须标记为非事务 test double，禁止用于验证并发/rollback。

---

## 13. Historical Data Compatibility

| 历史数据类型 | 是否可自动识别 | 证明依据 | 是否可回填 | 不确定时处理 |
|---|---|---|---|---|
| 缺 parentTaskId 的 RuleHost timestamp chain | 可以，限严格 shape | taskId shape + taskKind + exactly-one typed predecessor + channel/correlation compatibility | 可以，plan+CAS+canonical validation | 拒绝自动回填 |
| 缺 parentTaskId 的 adversarial chain | 可以，限 producer-specific shape | round/scribe/evaluator/artifact lineage | 可以 | 拒绝 |
| legacy repair row | 可以，限 deterministic id + payload + source evaluator | repair identity verification | 缺 parent/correlation 时可补 | payload 不全/冲突则拒绝 |
| 缺 channel/correlation | 部分 | 取决于 producer-specific proof | 仅在唯一证明时 | 拒绝 |
| 时间戳 taskId | 可识别但非 identity | producer shape | 不改写 id | 不能凭 timestamp 判重 |
| 缺 revisionCauseId | 可存在 | legacy metadata | 不猜 cause | 新 cause 从下一正式 reopen 开始 |
| 缺 sourceRunId / artifact binding | 部分可由 deterministic artifact id 恢复 | `pi-art-<task>-<run>` 约定 | 证据不足时 fail closed | 不把 succeeded 当充分条件 |
| dependency 与 parent 不一致 | 不一定错误 | parent 是因果，dependency 是输入 | 不用 dependency 泛化推断 | 逐 producer shape 审核 |
| 多合法后继 | 可检测 | exact/broad lookup conflict | 不可自动合并/删除 | `successor_integrity_conflict` |
| malformed metadata/JSON | 部分可归因 | parent/channel/kind 可读性 | 不自动修复 | relevant 则 fail closed；不可归因不能阻塞无关链 |

严格要求保持不变：

- 不允许通过 `dependencyTaskIds` 普遍推断 parent。
- 不允许猜测历史父节点。
- 不允许为唯一性删除历史任务或合并 run。
- 无法证明血缘必须拒绝自动迁移。
- 回填必须幂等、可观察，并在涉及 successor creation 时纳入同一写事务。

---

## 14. Root Cause Analysis

### 14.1 Primary Root Causes

| ID | Root cause | 证据状态 | 关键证据 |
|---|---|---|---|
| PRC-1 | 身份合同不完整且多层身份混用 | **CONFIRMED** | ordinary triple、repair iteration、deterministic repair id、schema 仅有 `task_id` unique 同时存在 |
| PRC-2 | 创建和状态迁移权威未完全收敛 | **CONFIRMED** | ordinary successor 已统一，repair seeders/split diag/root intake 仍有独立创建语义 |
| PRC-3 | 多阶段持久化缺少统一恢复合同 | **CONFIRMED** | output/artifact/terminal/intent/successor/backfill/reopen 分步持久化，恢复依赖多层幂等 |
| PRC-4 | 事务所有权与连接所有权错位 | **CONFIRMED** | TaskStore FIFO 不覆盖 direct writers/run store/raw connection；async transaction connection-wide |
| PRC-5 | 下游失效依赖隐式传播而非显式输入有效性合同 | **CONFIRMED** | artifact revision 不是 invalidation event；有效性依赖 reopen/cascade + exact input binding |

#### PRC-1：身份合同不完整且多层身份混用

证据：ordinary triple 在 `successor-lookup.ts` 中明确；repair round 实际依赖 `repairPayload.repairIteration` 与 deterministic id；schema 只有 `task_id` 唯一。  
结果：repair R1/R2 与普通 successor uniqueness 冲突；每个修复都必须决定“它到底是不是重复任务”。

#### PRC-2：创建和状态迁移权威未完全收敛

证据：C8-C10 已走统一 helper，但 C11/C12 repair seeders 直接 read-check-write/create；split diagnostician、root dreamer/pain 也有独立创建语义。  
结果：同一逻辑对象在不同入口下的 dedupe、冲突、结构化错误不同。

#### PRC-3：多阶段持久化缺少统一恢复合同

证据：output、artifact、terminal state、completion intent、successor、backfill、reopen 分离持久化；repair/revision 依赖多层幂等。  
结果：每个 crash window 都需要专门 proof；旧证据只要“看起来完整”就可能被错误复用。

#### PRC-4：事务所有权与连接所有权错位

证据：`SqliteTaskStore` FIFO 只覆盖自身；direct writers/run store/raw connection 共享同一 connection 但不受 admission；async transaction 持有 connection-wide lock。  
结果：无关写 capture、dirty read、跨实例死锁风险、跨进程行为弱证明。

#### PRC-5：下游失效依赖隐式传播而非显式输入有效性合同

证据：artifact revision 本身不触发 invalidation；正确性依赖 reopen/cascade，而 recovery 又必须独立验证 exact input artifact。  
结果：只检查 status/dependency/current artifact 存在性会把旧 verdict 当作新 verdict。

### 14.2 Contributing Causes

- 历史数据形态多样，legacy inference 只能 producer-specific。
- Memory store 与 SQLite 行为差异掩盖事务/duplicate 问题。
- 测试长期偏单入口、单函数、同步 happy path。
- RuleHost 同步链与 async consumer chain 的复用边界不清晰。
- 文档和注释漂移，例如 repair task id 仍被部分注释描述为 UUID/fresh per call。
- 评审修复按单条 comment 局部响应，缺少统一身份/生命周期合同作为验收基准。

### 14.3 Symptoms

- duplicate successor / successor integrity conflict
- lease conflict / concurrent modification
- stale evaluator verdict / stale completion intent
- repeated evaluation of same input
- repair reopen failure / wrong dependency round
- lineage backfill partial write/conflict
- transaction capture/rollback of unrelated writes
- malformed successor ambiguity

### 14.4 Detection Gaps

| Gap | 影响 |
|---|---|
| 缺少多轮 repair 全链路测试 | R1/R2 identity 冲突长期不可见 |
| 缺少 crash-between-output-and-terminal 测试 | completion intent/result recovery 缺陷 |
| 缺少 upstream revision + evidence reuse 测试 | stale verdict/intent 被复用 |
| 缺少真实 SQLite 双连接/赛后冲突注入 | successor lookup/create/backfill 原子性缺陷 |
| 缺少 direct writer capture 测试 | SQLite transaction isolation 误判 |
| Memory store 被当作 SQLite faithful double | duplicate/rollback 差异被掩盖 |
| 缺少多进程 worker 测试 | 进程内 FIFO 造成虚假信心 |

### 14.5 根因关系图

```text
PRC-1 身份合同不完整
  → repair seeder 绕行/triple 冲突
    → duplicate/conflict/reopen wrong round
      → 缺少多轮 repair E2E 未及时发现

PRC-2 权威分散
  → 多入口各自判断 succeeded/pending/existing
    → repeated execution / incorrect reuse
      → 单入口测试无法暴露

PRC-3 多阶段持久化
  → crash window
    → intent/output/artifact/successor/backfill 部分提交
      → 缺少 crash recovery 测试未暴露

PRC-4 事务所有权错位
  → direct writer capture / dirty read / cross-instance deadlock
    → 成功后 rollback / 隔离失败
      → Memory parity 缺失与进程内 FIFO 掩盖

PRC-5 失效合同不显式
  → artifact/status 局部判断
    → stale verdict treated as current
      → upstream revision tests 缺失
```

---

## 15. Current Lifecycle Invariants

以下 invariant 在当前 HEAD **已有相当程度实现或防线**，但强度不同：

### Identity

- ordinary successor 多匹配 fail closed：已实现，真实 SQLite 测试强。
- repair R1/R2 可物理区分：已实现，但 identity contract 未统一。
- taskId 不等于 logical identity：普通 successor 已实现；repair/legacy 例外需合同化。

### Execution

- succeeded task 不会在 status 不变时直接重跑：CONFIRMED。
- succeeded evidence 必须来自 durable run/artifact：已基本实现，仍需按本 SPEC 保持回归。
- 一个任务同一时间一个有效执行者：lease+fencing 强，但 unfenced writes 是绕过面。

### Revision

- 同一 `revisionCauseId` 只能消费一次：已实现，含 consumed history。
- repair completion 必须经 `REOPEN_SOURCE_EVALUATOR`：已实现。
- 旧 evaluator verdict 不能冒充新 revision：当前 input binding 已实现关键防线。
- 上游 revision 使旧下游结果失效：依赖 formal cascade/reopen，不是 artifact watcher。

### Lineage

- persisted parent 不被二次猜测：已实现。
- dependency 不作为通用 parent proof：已实现。
- 无法证明血缘 fail closed：已实现。
- 多 successor conflict 可观察：已实现。

### Transaction

- TaskStore-owned writes 不被 unrelated active transaction 捕获：HEAD 已实现。
- direct state.db writers 不被捕获：**Gap**。
- rollback 只回滚本事务写：**Gap**。
- SQLite/Memory 对外语义一致：**Gap**。

### Recovery

- crash 后 completion intent 不重复调用模型：已有回归。
- crash 后 successor/repair commit 幂等：已有回归。
- recovery 不产生第二个权威 verdict：在已测核心路径成立；repair identity 合同未闭合前不能声明全局成立。

---

## 16. Lifecycle Gaps

| Gap | 证据状态 | 影响 |
|---|---|---|
| repair logical identity 未纳入统一 contract | CONFIRMED | R1/R2 与 ordinary triple 冲突，repair seeder 绕行 |
| repair seeder host/pd-cli 复制且绕过 successor authority | CONFIRMED | 结构化冲突/并发语义不一致 |
| direct writers 未纳入统一 write admission | CONFIRMED | unrelated write capture、successor metadata 污染 |
| Memory store 非事务/duplicate 覆盖 | CONFIRMED | 测试替身误导 |
| standalone multi-edge lineage backfill 非整体事务 | CONFIRMED | 部分回填语义未定 |
| dirty read isolation 未定义 | CONFIRMED | transaction owner state 可被无关读者看到 |
| cross-instance ALS + global FIFO 可能死锁 | UNVERIFIED / 高风险静态路径 | 组合 store 实例时 promise 环 |
| rollback failure 被吞 | CONFIRMED | 连接可能停留在未知事务状态 |
| true multi-process successor creation 未验证 | UNVERIFIED | 跨进程只依赖 SQLite lock/busy timeout |
| malformed JSON schema 防线表述漂移 | CONFIRMED | legacy corrupt DB 行为不清 |
| Owner submission-time stale validation 不完整 | CONFIRMED | stale resolution 先写入再由 runner supersede，API 语义不精确 |

---

## 17. Target Architecture

### 17.1 职责边界

| 职责 | 目标 owner | 可以做什么 | 不可以做什么 |
|---|---|---|---|
| logical successor identity/adjudication | `successor-lookup.ts` | ordinary/repair-scoped identity 判定、conflict/malformed 分类 | 不写任务 |
| logical successor creation | `successor-create.ts` | 在 transaction 内 lookup/allocate/insert ordinary successor | 不处理 repair-specific payload semantics |
| repair task creation | 新专用 authority（建议仍在 successor-create 模块内） | deterministic id、payload identity、lineage verification、atomic insert | 不允许 host/pd-cli 各自 read-check-write |
| execution | concrete runners / BasePeerRunner | lease、invoke、validate、output/artifact/terminal evidence | 不直接创建 successor 或重开其他任务 |
| post-success transition | `InternalizationOrchestrator.commitNextTaskProposal` | successor create/existing/reopen/repair/source-correction arbitration | 不执行 runner 业务逻辑 |
| revision/reopen | `reopenTaskForRevision` | atomic epoch transition、cause idempotency、CAS | 不决定何时应 reopen（由 planner/orchestrator 决定） |
| result recovery | runner recovery + durable evidence validators | 证明 output/artifact/input/current epoch | 不把 status succeeded 当充分证据 |
| downstream invalidation | orchestrator cascade / repair / source-correction branches | formal reopen | 不由 artifact write 自动触发 |
| lineage validation/backfill | correlation-lineage / repair-lineage modules | strict proof + CAS backfill | 不猜测 unsupported legacy shape |
| persistence transaction/write admission | connection-level write authority | transaction ownership、FIFO、rollback、writer admission | 不允许 raw writer 绕过 |
| historical compatibility | lineage inference + operator remediation | strict proof、fail closed、保留证据 | 不删除/合并/猜测历史 |

### 17.2 身份合同

正式写入 contract：

```text
TaskRecordId = task_id

OrdinarySuccessorKey =
  (parentTaskId, taskKind, channel)

RepairSuccessorKey =
  (parentTaskId=sourceEvaluatorTaskId,
   taskKind='artificer',
   channel,
   repairPayload.repairIteration)

RevisionEpoch =
  (taskId, revisionCount, revisionCauseId/consumedRevisionCauseIds)

RunId = runs.run_id

ArtifactVersion =
  (artifactId, sourceTaskId, artifactKind, revisionEpoch, contentHash)

EvaluatorEvidenceKey =
  (evaluatorTaskId, evaluatorRunId, decisionArtifactId,
   sourceArtificerArtifactId, evaluatorRevisionEpoch)
```

### 17.3 最小架构原则

- 不增加第二套任务状态机。
- 不增加平行任务框架。
- 优先调整现有 `successor-create`、orchestrator、store connection authority。
- repair 使用专用创建 authority，不是把 repairIteration 粗暴塞进所有 successor 查询。
- root dreamer/pain 与 split diagnostician 不强行套用 spine successor triple；应明确它们是 fixed-seed/root/subtask identity class。

---

## 18. Minimum Unification Strategy

### 18.1 方案对比

| 方案 | 内容 | 成本 | 数据迁移风险 | 回归风险 | 长期维护 |
|---|---|---|---|---|---|
| A 局部补丁 | 继续按 review comment 修 repair seeder、SQLite direct writer、单项测试 | 低 | 低 | 高：下一个入口/竞态仍暴露 | 高成本 |
| B 有限职责收敛 | 明确 identity contract；repair creation authority；connection-level write admission；补齐 lifecycle E2E | 中 | 中低 | 中：需阶段性验证 | 最低 |
| C 全面重构 | 新任务框架/新状态机/新存储层 | 高 | 高 | 高 | 可能降低，但迁移代价过大 |

**推荐：方案 B**。它直接针对 primary root causes，同时保留当前已验证的业务闭环、lease/CAS、orchestrator、runner、artifact store。

### 18.2 最小修改清单

| 修改项 | 现有模块 | 必要性 | 预期解决问题 | 风险 |
|---|---|---|---|---|
| 正式记录 ordinary/repair identity contract | successor-lookup/create + SPEC | 必须 | 消除 repair R1/R2 与 triple 冲突 | 需处理 legacy rows |
| 新增 `createRepairSuccessorTask` 或等价专用 authority | successor-create / repair-task-identity | 必须 | host/pd-cli repair seeding 原子化、去重、结构化 | 需迁移两个 seeder |
| host/pd-cli seeders 改用专用 authority | consumer-governance / rulehost-pipeline-runner | 必须 | 移除复制实现和 read-check-write race | 调用行为兼容 |
| write admission 提升到 connection/database 层 | SqliteConnection / RuntimeStateManager / stores | 必须 | direct writer capture、跨实例 ALS 断裂 | 波及面大，需分阶段 |
| 定义/实现 Memory transactional double 或降级标注 | MemoryTaskStore | 必须 | 防止虚假 parity | 部分测试需重写 |
| standalone multi-edge backfill transaction policy | correlation-lineage | 必须明确 | 部分回填语义不清 | 需要真实 SQLite regression |
| Owner submission-time stale validation | owner-resolution-service | 应做 | stale resolution API 语义精确 | 需要复用 current-input proof |
| 修正漂移注释/文档 | orchestrator/RuleHost/SPEC | 应做 | 防止后续代理按旧合同修改 | 低 |

---

## 19. Lifecycle State Transition Specification

### 19.1 合法主流程

```text
pending → leased → succeeded
pending → leased → failed
failed → pending              # 仅显式 recovery authority
leased → retry_wait/failed    # recovery sweep
needs_human_review → pending  # owner-retry/authorized revise, not generic recover
succeeded/NHR → pending       # 仅 reopenTaskForRevision with new cause
```

### 19.2 revision/reopen

合法 reopen 必须：

1. 由正式触发源决定；
2. 使用唯一 cause；
3. 检查 same-cause replay；
4. 校验 lineage/lease/status/metadata snapshot；
5. 单 CAS 写入 status、attemptCount、revisionCount、revisionCauseId、清空 verdict/intent；
6. 失败时返回结构化 outcome，不写部分状态。

### 19.3 repair transition

合法 repair completion 必须：

1. `verifyRepairTaskIdentity` 通过；
2. source evaluator 存在且 lineage 可证明；
3. repair round 不比当前 dependency round 旧；
4. 使用 `repair-<repairTaskId>` 或 `repair-<repairTaskId>-rc<N>` cause；
5. 经 `REOPEN_SOURCE_EVALUATOR`；
6. 不创建第二个 evaluator chain。

### 19.4 evidence validity

任何 recovery/resume/commit 消费 evaluator evidence 前必须验证：

- durable run/output/artifact 一致；
- revision epoch 匹配；
- exact `sourceArtificerArtifactId` 是当前输入；
- deterministic gates/provenance 有效；
- Owner resolution 未 superseded。

---

## 20. Test Strategy

### Layer 1：Unit Tests

- ordinary vs repair identity parsing/adjudication。
- revision cause consumption/history。
- artifact current-input binding。
- legacy inference accept/reject matrix。
- malformed successor relevance matrix。

### Layer 2：Store Contract Tests

同一 contract suite 分别跑 SQLite/Memory：

- duplicate create。
- CAS null/exact semantics。
- write admission。
- nested transaction join。
- rollback visibility。
- updatedAt/null/undefined/schema/error behavior。
- 若 Memory 无法支持，则 contract 标记为 SQLite-only，禁止 Memory 假通过。

### Layer 3：SQLite Integration Tests

- true two-connection/two-process successor creation。
- conflict becomes visible after preflight。
- multi-edge lineage backfill partial failure/rollback。
- direct writer capture matrix：run output、fenced diagnostic、candidate、artifact、approval、cursor。
- dirty read during open transaction。
- rollback failure/connection state handling。
- lease fencing + sweep interleaving。

### Layer 4：Lifecycle E2E

必须覆盖：

A. 正常规则生成和评估。  
B. 单轮 repair。  
C. 两轮连续 repair。  
D. repair 成功后进程崩溃。  
E. evaluator 成功后 RuleHost 重放。  
F. 原始 Artificer 新 revision 导致旧 evaluator evidence 失效。  
G. 两个 consumer 同时处理同一任务。  
H. 同一 repair 被 host/pd-cli/reconciliation 重复观察。  
I. legacy 缺 parentTaskId。  
J. legacy 多合法/冲突后继。  
K. Owner revise/source correction 后重评。  
L. 最终 approved 进入 Owner approval/activation。  

### Layer 5：Regression Preservation

| 问题 | 现有测试 | 是否充分 | 缺失场景 |
|---|---|---|---|
| successor conflict/malformed fail closed | `successor-lookup.test.ts` | 强 | true multi-process |
| conflict 后零 lineage write | `round8-review-regressions.test.ts` | 中强 | multi-edge partial backfill |
| preferred/fallback collision | `successor-lookup.test.ts` | 强 | 跨进程/foreign occupant race |
| completion intent stale input | `adversarial-loop.test.ts` | 强 | RuleHost/consumer 独立入口 matrix |
| NHR current-input no cascade | `adversarial-loop.test.ts` | 强 | owner decision path |
| stale owner resolution supersede | `owner-override-resume.test.ts` | 强 | submission-time validation |
| restart safety/reconciliation | `restart-safety.e2e.test.ts` | 强 | crash inside successor transaction |
| TaskStore write capture | `sqlite-task-store.test.ts` | 中强 | direct writer capture matrix |

---

## 21. Implementation Roadmap

### Phase 0：SPEC 审核与不变量确认

- 修改文件：仅本 SPEC/必要索引。
- 完成标准：Owner 确认 identity contract、repair model、方案 B、边界与不可接受方案。
- 风险：若 contract 决策错误，后续阶段会返工。

### Phase 1：Logical Identity 和 Successor 统一

- 文件：`successor-lookup.ts`, `successor-create.ts`, `repair-task-identity.ts`, host/pd-cli repair seeders, SPEC/tests。
- 内容：正式 repair-scoped key；专用 atomic repair creation authority；迁移 host/pd-cli seeder。
- 前置：Phase 0。
- 测试：R1/R2 coexist、duplicate repair conflict、legacy repair identity、atomic race。
- 数据迁移：无批量迁移；只在严格证明下回填。
- 完成标准：repair seeding 不再有 host/pd-cli 两份 read-check-write 实现。

### Phase 2：Lifecycle State Transition 统一

- 文件：orchestrator/revision-reopen/runner 调用点。
- 内容：审计所有 reopen/transition 是否经正式 authority；修正文档漂移。
- 测试：preview/confirm parity、cascade、repair/source-correction/owner revise matrix。
- 完成标准：无生产路径绕过正式 reopen。

### Phase 3：Repair / Revision / Downstream Invalidation

- 文件：evaluator/artificer recovery、adversarial loop、orchestrator。
- 内容：统一 evidence validity contract；Owner submission-time stale validation。
- 测试：multi-round repair、upstream artifact revision、stale intent/verdict/resolution。
- 完成标准：同一来源修订只有一个权威 evaluator verdict。

### Phase 4：Persistence / Transaction / Concurrency

- 文件：`sqlite-connection.ts`, `sqlite-task-store.ts`, direct stores, `runtime-state-manager.ts`, Memory store。
- 内容：connection-level write authority；transaction identity；direct writer admission；rollback failure policy；Memory double contract。
- 测试：direct writer capture matrix、dirty read、cross-instance、true multi-process。
- 数据风险：高，必须小步迁移。
- 完成标准：独立写不被 capture；SQLite/Memory contract 明确且测试化。

### Phase 5：Recovery / Historical Compatibility

- 文件：correlation-lineage、repair-lineage、legacy migration/remediation tests。
- 内容：standalone multi-edge atomicity policy、malformed JSON legacy contract、operator remediation UX。
- 测试：legacy matrix、partial CAS failure、不可证明拒绝。
- 完成标准：历史不可证明数据不再造成模糊恢复。

### Phase 6：完整 Lifecycle E2E

- 文件：真实 SQLite E2E suite / RuleHost / consumer。
- 内容：A-L 场景全部落地。
- 完成标准：核心 invariant 都有 executable regression。

### Phase 7：独立评审和最终验收

- 内容：独立 code review、错误经验记录复核、CI、真实宿主 smoke。
- 完成标准：无已知 Major；所有 limitations 明确记录。

---

## 22. Regression Prevention

1. 把 logical identity contract 加入 architecture/contract test，而不是只写在文档。
2. 新增任何任务创建路径必须通过创建 authority 审计；CI grep/architecture guard 可禁止 repair/successor 直接 `createTask`。
3. 新增 direct SQL writer 必须注册到 connection-level write authority。
4. 每次修改 reopen/recovery 必须运行真实 SQLite lifecycle suite，而非仅 unit test。
5. 对 reviewer 指认的每个 concurrency 问题，必须提供 red-against-pre-fix 或明确说明无法构造。
6. Memory store 测试名称必须标明是否为 non-transactional behavior；禁止用 Memory 结果证明 SQLite transaction invariant。

---

## 23. Risks and Rollback Strategy

| 风险 | 影响 | 缓解/回滚 |
|---|---|---|
| repair identity contract 决策错误 | 合法 R1/R2 被拒或重复 repair | Phase 0 先冻结合同；保留 legacy proof tests |
| connection-level admission 波及全 state.db | 死锁/性能下降 | 分 store 迁移；先测试 run/task/artifact，再扩展 approval/candidate |
| async transaction 改造过大 | 长周期不稳定 | 短期 universal admission；长期再评估同步 commit unit |
| legacy rows 不符合新 identity | 旧链 blocked | fail-closed + operator remediation；不删除历史 |
| RuleHost 同步链行为变化 | 用户 workflow blocked | 保持 reuse/execute/blocked 外层语义；只统一内部 authority |
| Owner-facing decision behavior 变化 | 治理风险 | submission-time stale validation 单独评审；保持 supersede recovery fallback |

---

## 24. Acceptance Criteria

本 SPEC 实施完成必须满足：

1. ordinary 与 repair successor identity 有正式、可执行、可测试的合同。
2. host/pd-cli repair seeding 不再有复制 read-check-write 实现。
3. 同一 `(sourceEvaluatorTaskId, repairIteration)` 只能有一个有效 repair task；不同 iteration 可合法共存。
4. 同一 ordinary `(parentTaskId, taskKind, channel)` 不会产生第二个有效 successor；冲突 fail closed。
5. succeeded task 不因重放在同一 epoch 重新执行。
6. evaluator evidence 必须绑定当前 exact input artifact；stale evidence 不冒充新 verdict。
7. 所有 reopen 经统一 authority，同 cause 幂等。
8. direct state.db writers 不被 unrelated active transaction 捕获。
9. SQLite/Memory 对外测试语义明确；Memory 不再伪装事务等价。
10. 多轮 repair、crash recovery、RuleHost replay、legacy lineage 都有真实 SQLite regression。
11. 历史不可证明数据 fail closed 且可诊断，不猜测、不删除。
12. CI 与独立评审通过，剩余限制写入 PR/任务风险合同。

---

## 25. Unresolved Questions

1. **split diagnostician 子任务是否属于 successor contract？** 当前不写 `pi_metadata.parentTaskId`，且 deterministic fixed-id 语义不同于 spine successor。需要 Owner/architecture 决策。
2. **是否需要 DB-level generated-column unique index？** 若加入 ordinary triple unique constraint，legacy/malformed/repair 会造成迁移与表达困难；建议先完成 procedural authority，再评估是否可行。
3. **standalone multi-edge lineage backfill 是否必须全原子？** 推荐全原子，但需验证实现成本与现有调用方恢复语义。
4. **dirty read 是否必须完全消除？** 真正隔离可能需要独立 read connection 或 transaction-aware reads；这涉及架构成本，不能在本 SPEC 中假装免费。
5. **rollback failure 如何上报？** 当前完全吞掉；可能需要在 connection health/degraded state 中显式记录。
6. **Owner submission-time stale validation 应复用哪一层 current-input proof？** 需要避免把 runner 私有逻辑复制到 service。
7. **true multi-process test 如何在 CI 中稳定实现？** 需要独立 worker/process harness，而不是同进程双 connection。

---

## 26. Evidence Appendix

### 26.1 关键源码证据索引

| 主题 | 文件/行号 |
|---|---|
| ordinary successor identity/lookup | `packages/principles-core/src/runtime/internalization/successor-lookup.ts:1-13`, `162-261` |
| successor atomic create | `packages/principles-core/src/runtime/internalization/successor-create.ts:108-207` |
| orchestrator transaction ordering | `packages/principles-core/src/runtime/internalization/internalization-orchestrator.ts:1331-1460` |
| repair completion branch | `internalization-orchestrator.ts:934-1055` |
| cascade reopen | `internalization-orchestrator.ts:1208-1274` |
| source correction | `internalization-orchestrator.ts:1063-1092`, `1713-1835` |
| revision reopen CAS | `packages/principles-core/src/runtime/internalization/revision-reopen.ts:154-345` |
| repair identity verification | `packages/principles-core/src/runtime/internalization/repair-task-identity.ts:50-140` |
| repair id convention | `packages/principles-core/src/runtime/internalization/pitask-metadata.ts:146-157` |
| repairPayload schema | `pitask-metadata.ts:82-144`, validation `946-1002` |
| evaluator repair seed decision | `packages/principles-core/src/runtime/internalization/evaluator-runner.ts:1838-1886`, `2795-2826` |
| evaluator input binding | `evaluator-runner.ts:940-1004`, `1085-1167`, `2169-2202` |
| owner stale supersede | `evaluator-runner.ts:1006-1059` |
| artifact epoch store | `packages/principles-core/src/runtime/store/artifact/sqlite-pi-artifact-store.ts:121-202` |
| task schema | `packages/principles-core/src/runtime/store/sqlite-connection.ts:306-325` |
| SqliteTaskStore FIFO/transaction | `packages/principles-core/src/runtime/store/task/sqlite-task-store.ts:63-113` |
| task CAS | `sqlite-task-store.ts:232-323` |
| RunStore direct write | `packages/principles-core/src/runtime/store/run/sqlite-run-store.ts:107-203` |
| RuntimeStateManager connection exposure | `packages/principles-core/src/runtime/store/runtime-state-manager.ts:135-146`, `180-184`, `232-235` |
| Memory store transaction limitation | `packages/principles-core/src/runtime/store/task/memory-task-store.ts:67-107` |
| host repair seeder | `packages/host-runtime/src/internalization-consumer-governance.ts:194-290` |
| pd-cli repair seeder | `packages/pd-cli/src/services/rulehost-pipeline-runner.ts:1017-1110` |
| RuleHost successor authority | `packages/pd-cli/src/services/rulehost-pipeline-runner.ts:848-934` |
| adversarial successor helper | `packages/principles-core/src/runtime/adversarial-loop.ts:635-663` |

### 26.2 关键测试证据索引

| 主题 | 测试 |
|---|---|
| successor lookup/atomic create | `packages/principles-core/src/runtime/internalization/__tests__/successor-lookup.test.ts` |
| round5 successor/revision | `round5-successor-revision-regressions.test.ts` |
| round8 conflict/backfill race | `round8-review-regressions.test.ts` |
| lineage integration | `correlation-lineage-integration.test.ts` |
| repair lineage backfill | `repair-lineage-backfill.test.ts` |
| owner override/stale supersede | `owner-override-resume.test.ts` |
| adversarial crash/input-current recovery | `packages/principles-core/src/runtime/__tests__/adversarial-loop.test.ts` |
| RuleHost convergence | `packages/pd-cli/tests/services/rulehost-pipeline-successor-convergence.test.ts` |
| enqueue successors SQLite | `packages/pd-cli/tests/commands/runtime-internalization-enqueue-successors.sqlite.test.ts` |
| restart safety | `packages/principles-core/src/runtime/internalization/__tests__/restart-safety.e2e.test.ts` |
| SQLite write admission | `packages/principles-core/src/runtime/store/sqlite-task-store.test.ts:206-269` |
| metadata filter parity | `packages/principles-core/src/runtime/store/task/__tests__/pi-metadata-filter.test.ts` |

### 26.3 此前评审线索逐项复核

| 此前线索 | 复核状态 | 当前结论 |
|---|---|---|
| RuleHost 与 InternalizationOrchestrator 创建任务职责不一致 | **PARTIALLY_CONFIRMED** | ordinary spine successor 已收敛到 `createLogicalSuccessorTask`；repair seeders 与 root/intake/split 创建仍保留独立语义 |
| Logical Successor 身份定义可能不完整 | **CONFIRMED** | ordinary triple 不能表达 repair round identity；repair 需要 iteration/source evaluator 维度 |
| Repair 多轮可能发生逻辑身份冲突 | **CONFIRMED** | R1/R2 物理上可区分，但与普通 triple 的全局唯一性假设冲突；尚无 repair-scope DB invariant |
| Artificer / Evaluator 成功结果恢复不完整 | **PARTIALLY_CONFIRMED** | 历史 crash-window 机制有源码证据；当前 HEAD 已有 intent/exact-input/fencing 防线和测试，但不能声称所有恢复面已完备 |
| Repair 完成后的 Evaluator 重开与同步执行链冲突 | **PARTIALLY_CONFIRMED / 当前精确复现 NOT_REPRODUCIBLE** | 权威转移在 orchestrator commit；静态审查未见当前精确绕过路径，但同步/异步链共用 durable evidence 的边界仍需 E2E 验证 |
| 上游 Artificer 修订后旧 Evaluator 结果可能被错误复用 | **PARTIALLY_CONFIRMED** | 正式 lifecycle 内 exact artifact binding 防线强；artifact/status 局部判断或 system-owned repair rewrite 仍是残余风险 |
| SQLite 与 Memory Store 事务语义不一致 | **CONFIRMED** | Memory 无 snapshot/rollback/atomic commit，且写入 admission/duplicate/error semantics 不同 |
| Legacy Lineage 回填存在并发一致性问题 | **CONFIRMED** | successor creation 内已在 HEAD 原子化；standalone generic multi-edge backfill 仍非整体事务 |
| Preview / Confirm 存在决策分叉 | **PARTIALLY_CONFIRMED** | 二者共享同一 successor authority，未见独立决策 fork；但 preview 静态快照与 confirm transaction-time 状态在真实并发下本来就可漂移 |

### 26.4 已核验命题状态摘要

| 命题 | 状态 |
|---|---|
| 普通 successor identity 是 `(parentTaskId, taskKind, channel)` | CONFIRMED（限 ordinary） |
| 该 triple 是所有任务/所有 successor 的完整身份 | FALSE |
| repair R1/R2 可由当前物理模型表示 | CONFIRMED |
| repair R1/R2 与普通 triple 无冲突 | FALSE |
| repair completion 直接由 Artificer runner reopen evaluator | FALSE；权威是 orchestrator commit |
| artifact 新增/多行会自动触发 evaluator 重评 | FALSE |
| artifact revision 自身不是 invalidation event | CONFIRMED |
| stale evaluator evidence 在所有路径都永不复用 | PARTIALLY_CONFIRMED；正式 lifecycle 内防线强，但不是全局 artifact watcher |
| TaskStore CRUD 已防止 unrelated transaction capture | CONFIRMED |
| 所有 state.db writer 已防止 capture | FALSE |
| Memory 与 SQLite transaction semantics 等价 | FALSE |
| dry-run/confirm 使用同一 successor authority | CONFIRMED（静态快照；不消除真实并发漂移） |
| logical successor uniqueness 是 DB-level invariant | FALSE；目前是参与 writer 的 procedural invariant |

---

## 结论：为什么这个 PR 这么难修

这个 PR 难修的本质原因是：它表面上是在修 successor lookup，但实际碰到了整个系统的**身份、创建权威、revision/repair、恢复证据、事务边界、历史兼容**六个交叉不变量。每修一个局部 invariant，都会暴露另一个入口没有遵守同一 invariant。继续逐条 comment 打补丁只会延长这个过程。

正确的下一步不是重写系统，而是先批准并实施本 SPEC 的 **方案 B：有限职责收敛**：

1. 先冻结 identity contract；
2. 再统一 repair creation authority；
3. 再统一 state transition/evidence validity；
4. 最后提升 transaction/write admission 并补齐 lifecycle E2E。

建议进入下一阶段实施，但必须以 Phase 0 的 Owner/架构确认为前提。
