# PRI-807 Phase 0 — Worker C：Lineage / Artifact Identity 全链审计

> 产出类型：只读审计结果文件（本文件是本次任务唯一写入）
> 任务：Issue #38（CNB）/ 子任务 PRI-807 Phase 0 Worker C
> 审计问题：**从 Pain 一直到 runtime receipt，稳定身份有没有任何一跳会静默丢失、换名、覆盖、重生？**

---

## 1. Scope

**在范围内（逐一回源 current checkout 的生产代码 / DDL / 生产测试）：**

| # | 链路跳 | 主要证据文件 |
|---|---|---|
| 1 | pain ingress → canonical pain id | `pain-ingress.ts`、`pain-ingress-payload.ts` |
| 2 | pain event 落库 → `canonical_pain_id` | `pain-signal-observability.ts`（`pain_events` DDL） |
| 3 | pain → diagnosis task id / diagnosticJson | `pain-signal-bridge.ts` |
| 4 | diagnosis task → run | `lease-manager.ts`（`runs` DDL） |
| 5 | run → diagnostician artifact + candidate | `diagnostician-committer.ts` |
| 6 | candidate → dreamer 任务种子 | `intake-to-internalization-bridge.ts` |
| 7 | dreamer → philosopher → scribe → artificer → evaluator → rollout artifact | 六个 runner + `base-peer-runner.ts` |
| 8 | artifact → approval | `sqlite-approval-store.ts`、`activation-dispatcher.ts` |
| 9 | approval → activation | `approval-completion-service.ts`、`activation-dispatcher.ts`、`low-risk-writers.ts` |
| 10 | activation → runtime receipt | `principle-application-ledger.ts`、`principle-receipt-metadata.ts` |
| 11 | 修订 / revision 编号与 approval 失效 | `revision-reopen.ts`、`activation-types.ts`、`promotions-*` |

**不在范围内（见 §9）：** 不改任何生产代码；不判定 R-19 沙箱信任边界、R-20 Console 停用授权、R-21 correctionObserver 失明、R-22 Codex 侧事件通道（属其他 Worker）；不做 live 运行时核对（无 runtime 数据）；不评估修复方案。

---

## 2. Baseline

```
$ git rev-parse HEAD
191ae1af588a68950af1de5a3b9265771a7b3e8d
```

**BASELINE: DRIFTED**（不是 SYNCED）

### 2.1 Drift Warning

任务书基线 `cdec05d4bc4252151c7f9f118bdad90f25067594` **在本 checkout 不可达**：

```
$ git cat-file -t cdec05d4bc4252151c7f9f118bdad90f25067594
fatal: git cat-file: could not get object info
$ git fetch origin cdec05d4bc4252151c7f9f118bdad90f25067594
fatal: remote error: upload-pack: not our ref cdec05d4bc4252151c7f9f118bdad90f25067594
```

- CNB 远端 `origin`（`cnb.cool/csuzngjh/principles`）的 `main` = `191ae1af588a68950af1de5a3b9265771a7b3e8d`。
- 该 SHA 在 GitHub 上游可达：`git fetch https://github.com/csuzngjh/principles main` → `cdec05d4b Merge pull request #1710 ...`。
- **CNB 镜像落后 GitHub 上游 51 个提交**，任务书锁定的基线尚未镜像到本 checkout。

```text
$ git log --oneline HEAD..cdec05d4b        # 基线领先 checkout（前 10 条）
cdec05d4b Merge pull request #1710 from csuzngjh/ai/audit2-agent-pipeline-verify-round
d9376bbb0 Merge branch 'main' into ai/audit2-agent-pipeline-verify-round
d2b4ff7c2 Merge pull request #1708 from csuzngjh/ai/PRI-801-installer-transitive-deps
deb08d500 docs(audit): incorporate CNB four-round independent verification (VERIFICATION-A..D) ...
ed0ec8067 test(installer): fail-loud closure verification + committed regression tests (PRI-801 ...)
7b080f4f4 fix(installer): resolve reparse points before inject rm/copy (PRI-801)
7598626e8 fix(installer): transitive npm install needs --legacy-peer-deps + fail loud on error
131375fa3 fix(installer): transitive-closure dep verification for injected workspace packages
d77433fd2 Merge pull request #1707 from csuzngjh/ai/audit-agent-pipeline-report
25192f5f6 Merge branch 'main' into ai/audit-agent-pipeline-report
（共 51 条）

$ git log --oneline cdec05d4b..HEAD        # checkout 领先基线
（空 —— checkout 是基线的祖先，非分叉）
```

### 2.2 影响面评估（逐文件亲验）

```
$ git diff --name-only HEAD cdec05d4b
.cnb.yml
docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md
docs/audit/agent-pipeline-audit-2026-09-15/VERIFICATION-A.md
docs/audit/agent-pipeline-audit-2026-09-15/VERIFICATION-B.md
docs/audit/agent-pipeline-audit-2026-09-15/VERIFICATION-C.md
docs/audit/agent-pipeline-audit-2026-09-15/VERIFICATION-D.md
docs/process/error-management/ERROR_ARCHIVE.md
docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md
docs/process/error-management/ERROR_PATTERN_INDEX.md
packages/openclaw-plugin/scripts/lib/transitive-deps.mjs
packages/openclaw-plugin/scripts/sync-plugin.mjs
packages/openclaw-plugin/src/commands/capabilities.ts
packages/openclaw-plugin/tests/commands/capabilities.test.ts
packages/openclaw-plugin/tests/scripts/transitive-deps.test.ts
packages/pd-console/src/ui/i18n/en.json
packages/pd-console/src/ui/i18n/zh-CN.json
packages/pd-console/src/ui/pages/focus/OwnerDecisionCard.tsx
packages/pd-console/tests/ui/owner-decision-ui-contract.test.ts
packages/principles-core/src/runtime-v2/__tests__/governance-timestamp-schema.test.ts
packages/principles-core/src/runtime-v2/__tests__/internalization-orchestrator.test.ts
packages/principles-core/src/runtime-v2/governance-experience-contract.ts
packages/principles-core/src/runtime-v2/governance-projection-contract.ts
packages/principles-core/src/runtime-v2/governance-timestamp-schema.ts
packages/principles-core/src/runtime-v2/internalization/internalization-orchestrator.ts
```

**血缘核心文件全部不在差异内**（逐文件 `git diff --quiet` 亲验）：

```
SAME: pi-artifact-store.ts        SAME: sqlite-pi-artifact-store.ts
SAME: scribe-runner.ts            SAME: scribe-prompt-builder.ts
SAME: artificer-runner.ts         SAME: philosopher-output.ts
SAME: peer-runner-contracts.ts    SAME: sqlite-connection.ts
SAME: candidate-lineage.ts        SAME: revision-reopen.ts
SAME: evaluator-runner.ts         SAME: rollout-reviewer-runner.ts
SAME: dreamer-runner.ts           SAME: pain-chain-read-model.ts
SAME: internalization-chain-integrity-read-model.ts
DIFF: internalization-orchestrator.ts   ← 唯一血缘相邻差异
```

`internalization-orchestrator.ts` 的实际差异仅涉及 **lease 顺序**（PRI-798：`orderBy: 'updated_at_asc'` + 跨桶全局排序），**不触碰任何 ID 字段、artifactId、taskId 或 lineage 语义**：

```diff
-      const pending = await this.stateManager.listTasks({ status: 'pending' });
-      const retryWait = await this.stateManager.listTasks({ status: 'retry_wait' });
+      const pending = await this.stateManager.listTasks({ status: 'pending', orderBy: 'updated_at_asc' });
+      const retryWait = await this.stateManager.listTasks({ status: 'retry_wait', orderBy: 'updated_at_asc' });
+      allCandidates.sort(...)
```

**结论：本报告的全部判定仅对 checkout SHA `191ae1af588a68950af1de5a3b9265771a7b3e8d` 负责。** 因血缘核心文件与基线逐字节相同，报告结论对该 51-commit 窗口内的两棵树**同时成立**；Drift 不改变血缘判定，只影响行号引用与历史报告文件可得性（`docs/audit/agent-pipeline-audit-2026-09-15/` 在本 checkout 不存在，已通过 `git show cdec05d4b:<path>` 读取种子事实，未 checkout 切换）。

---

## 3. Current Authorities（哪些 ID / 键已有唯一权威定义）

| 身份 | 权威定义位置 | 形态 | 权威性评估 |
|---|---|---|---|
| **canonical pain id** | `pain-ingress-payload.ts` → `PainIngressReport.identity.painId`；落 `pain_events.canonical_pain_id`（`pain-signal-observability.ts:188-203`） | 自由字符串 | 单一权威；ingress 是唯一构造点（`pain-ingress.ts` 纯模块，无 I/O、不 mint 身份） |
| **diagnosis task id** | `createDiagnosticianTaskId()` = `` `diagnosis_${painId}` ``（`pain-signal-bridge.ts:186-187`） | **确定性派生** | 单一权威。幂等性由「painId → taskId」函数式映射保证 |
| **run id** | `run_${taskId}_${attemptNumber}`（`lease-manager.ts` acquireLease，同事务 INSERT） | **确定性派生** | 单一权威（`runs` PK）。attemptNumber 由 `MAX(attempt_number)+1` 计算 |
| **diagnostician artifact id** | `randomUUID()`（`diagnostician-committer.ts:132-133`） | **随机** | 单一权威；但**不是确定性派生**，重放会生成新 id |
| **candidate id** | `randomUUID()`（`diagnostician-committer.ts:179-180`） | **随机** | 单一权威；幂等键为 `${commitId}:${i}`（`idempotency_key` UNIQUE） |
| **peer artifact id** | `` `pi-art-${taskId}-${runId}` ``（6 个 runner 一致：`dreamer-runner.ts:299`、`philosopher-runner.ts:314` 区、`scribe-runner.ts:339`、`artificer-runner.ts:1037`、`evaluator-runner.ts:982`、`rollout-reviewer-runner.ts:630`） | **确定性派生（含 runId → 含 attempt）** | 单一权威，但**实例 id 随 re-run 变化** |
| **logic artifact 键** | `UNIQUE(source_task_id, artifact_kind)` = `idx_pi_artifacts_idempotency`（`sqlite-connection.ts:393`） | 复合唯一 | **权威，但语义负载过重**（见 F-01） |
| **approval id** | `` 'apr_' + channel + '_' + artifactId ``（`sqlite-approval-store.ts:138-140`） | **确定性派生** | 单一权威。⇒ 同一 artifact 同一 channel 只会有一条 approval（`INSERT OR IGNORE`） |
| **activation id** | `` `act_prompt_${principleId}` ``（`low-risk-writers.ts` PromptWriter）／`rule` 通道由 `RuleHostWriter` 生成 | 派生/自定义 | 每条通道各自权威 |
| **activation idempotency key** | `` `${artifactId}::${channel}` ``（`activation-types.ts:268-270`） | 确定性 | **单一权威**，`activations.idempotency_key` UNIQUE |
| **runtime receipt** | `principle_applications(principle_id, activation_id, rule_id, channel, level, kind, …)`（`sqlite-connection.ts:463-481`） | 追加行 | 单一权威；**不含 pain/candidate/artifact id**（见 F-04） |
</body>

---

## 4. Contract Map

> 格式：`ID_A → stored as X → consumed as Y → transformed to Z → SILENT DROP POSSIBLE? YES / NO（附证据）`
> 每跳均**同时打开 producer（写入方）与 consumer（读取方）**，不以 grep 单端下结论。

### 跳 1 — 外部 pain → canonical pain id

```
外部 pain 信号
  → stored as  PainIngressReport.identity.painId（pain-ingress.ts:59；evaluatePainIngress 唯一构造点）
  → consumed as LegacyPainSubmission.painId（pain-ingress.ts:128）
  → transformed to  PainDetectedData.painId（pain-signal-bridge.ts:50）
  → SILENT DROP POSSIBLE? NO
```
证据：`pain-ingress.ts:128` 显式分支 `report.identity.kind === 'manual_pain_id' ? report.identity.painId : report.identity.observationId`。ingress 声明为纯模块（文件头注：「no identity minting …… mints no canonical identity」），故 identity 由宿主 adapter 提供，ingress 只做解读。**未发现换名或丢弃路径**。

### 跳 2 — canonical pain id → pain_events 落库

```
painId
  → stored as  pain_events.canonical_pain_id（pain-signal-observability.ts:188-203 DDL，列 canonical_pain_id TEXT）
  → consumed as 无血缘消费者（列存在但读侧以 session_id / runtime_task_id 为主）
  → transformed to 无
  → SILENT DROP POSSIBLE? **YES（P3，死字段面）**
```
证据：`pain_events` 同时有 `runtime_task_id`（链接任务）与 `canonical_pain_id`。`pain_diagnoses.pain_id` 是**逻辑关联键而非跨库 FK**（`sqlite-connection.ts:668-676` 注释明言「pain_events lives in trajectory.db (host-runtime) — pain_id here is a LOGICAL association key, not a cross-database FK」）。⇒ 回链靠字符串相等，无约束保证。**本跳不构成 canonical data corruption，但回链正确性不可强制。**

### 跳 3 — canonical pain id → diagnosis task id

```
painId
  → stored as  tasks.task_id = `diagnosis_${painId}`（pain-signal-bridge.ts:186-187 createDiagnosticianTaskId；调用点 :419/:437）
  → consumed as  同名函数在读取侧重建（pain-chain-read-model.ts:95 `createDiagnosticianTaskId(painId)`）
  → transformed to  tasks.input_ref = painId（pain-signal-bridge.ts:425/:452/:514）
  → SILENT DROP POSSIBLE? NO（但见下方换名风险）
```
证据：写侧 `createTask({ taskId, inputRef: painId, … })`；读侧 `pain-chain-read-model.ts:95` 用同一导出函数重建 taskId，**不重复字符串拼接**——单一权威。同时 `diagnosticJson.sourcePainId = data.painId`（`buildDiagnosticJson`，`pain-signal-bridge.ts:322`），并由 `extractPainIdFromDiagnostic` 读回（`base-peer-runner.ts` 内联实现，注释说明镜像 `sqlite-task-store.ts`）。⇒ painId 有 **3 个持久化位置**（taskId 里、input_ref、diagnosticJson.sourcePainId），但三者同源同值。

**换名风险（P3）**：`pain-signal-bridge.ts:589`/`:599` 在 re-entry 时做 `const painId = typeof task.inputRef === 'string' && task.inputRef.length > 0 ? task.inputRef : taskId;` —— **inputRef 缺失时静默回退为 taskId（`diagnosis_xxx`）**。此回退虽有值但改变了 painId 的语义（从「pain 身份」变为「任务身份」）。可观测性：无事件。记为 F-05（P3）。

### 跳 4 — diagnosis task → run

```
taskId
  → stored as  runs.run_id = `run_${taskId}_${attemptNumber}`；runs.task_id = taskId（lease-manager.ts:163-167，与 tasks 状态更新同一事务）
  → consumed as  base-peer-runner.resolveStoreRunId()（base-peer-runner.ts:575-619，取 `runs[runs.length-1]`）
  → transformed to  TaskRecord.attemptCount = attemptNumber（lease-manager.ts:157-160）
  → SILENT DROP POSSIBLE? NO（但存在 R-23 双源，见 §5）
```
证据：读取侧 `getValidRunsByTaskTolerant(taskId)` 返回**容错**列表；畸形历史行被隔离并**emit 遥测**（`degradation_triggered`，含 `nextAction: 'pd runtime internalization integrity-repair --confirm'`），不静默。`attemptNumber` 由 `SELECT MAX(attempt_number) … + 1` 得出，**与 `tasks.attempt_count` 在同一 UPDATE 被写为同一值**（`lease-manager.ts:151-165`）——正常 lease 路径下双源对齐。

### 跳 5 — run → diagnostician artifact + candidate

```
runId / taskId
  → stored as  artifacts.artifact_id = randomUUID()；commits.commit_id = randomUUID()
                principle_candidates.candidate_id = randomUUID()，candidate_idem_key = `${commitId}:${i}`（diagnostician-committer.ts:132-209）
  → consumed as  getCandidatesByTaskId(taskId)（pain-signal-bridge.ts:724，经 `principle_candidates JOIN commits JOIN runs JOIN tasks ON t.task_id = ? OR t.input_ref = ?`，sqlite-candidate-store.ts:41-50）
  → transformed to  candidate.artifactId / candidate.taskId / candidate.sourceRunId
  → SILENT DROP POSSIBLE? NO
```
证据：producer 在一个 SQLite 事务内写 artifacts + commits + N 个 candidates（`diagnostician-committer.ts:138-209`），全部字段从 `input.taskId` / `input.runId` 取——**不从 LLM 输出取**（`pi-ai-runtime-adapter.ts:872-876` 注释：lineage fields 由 `stripLineageFields` 剥离，下游必须从 RunnerContext/TaskRecord 取，防 LLM 投毒，ERR-008 家族）。幂等：`UNIQUE(run_id)` + `UNIQUE(idempotency_key)`，重复提交返回既有 commit（`tryGetExistingCommit`）。

**但**：`candidate_id` 是 `randomUUID()` —— 同一次诊断重放会生成**新** candidate（新 commitId → 新 candidateIdemKey）。⇒ candidate 身份**不跨重放稳定**（见 F-06）。

### 跳 6 — candidate → dreamer 任务种子

```
candidateId
  → stored as  tasks.task_id = `dreamer-${candidateId}-${effectiveChannel}`（intake-to-internalization-bridge.ts:180）
  → consumed as  findExistingDreamerTask(candidateId)（:18-29，遍历全部 4 个 channel 后缀）
  → transformed to  diagnosticJson: candidateId / sourceTaskId / sourceArtifactId / sourceRunId / sourcePainId（:243-250）
  → SILENT DROP POSSIBLE? **YES（受保护，可观测）**
```
证据：`buildDreamerSeedFromCandidate`（:290-330）在**全部 lineage 字段皆空**时 **fail loud** 返回 `invalid_candidate`（:296-306，`lineageFields.every(f => !f)`）——不静默 seed。`computeBridgeDecision` 拒绝形似 taskId 的 candidateId（:135-141）与超长 id（:144-146），防递归拼接。

**Risk（P2，已部分缓解）**：`sourcePainId` 是 `...(input.sourcePainId?.trim() ? { sourcePainId: … } : {})` —— **缺失即静默省略**（:248）。`CANDIDATE_KIND_TO_ROUTE[candidate.recommendationKind ?? '']` 未命中 route 时，整段 seed 被 `if (route)` 跳过且**无事件**（`pain-signal-bridge.ts:771-807`；只有 `not_internalizable` 分支有事件）。记为 F-07（P2）。

### 跳 7 — dreamer → philosopher → scribe → artificer → evaluator → rollout

**统一写入契约（6 个 runner 完全一致，逐文件亲验）：**

```
taskId + runId
  → stored as  artifactId = `pi-art-${taskId}-${runId}`（dreamer:299 / philosopher:314区 / scribe:339 / artificer:1037 / evaluator:982 / rollout:630）
                artifactKind = 'principle'（除 evaluator 的 rule 分支写 'rule'，evaluator-runner.ts:3265-3270）
                sourceTaskId = taskId
                lineageArtifactIds = resolveLineageArtifactIds(taskId)（base-peer-runner.ts:547-571，依赖任务全部 artifact id）
                contentJson = buildArtifactContentJson(...)
  → consumed as  base-peer-runner.buildContext() 各 runner 的 listBySourceTaskId(depId)[0]
                CandidateLineage.resolve(artifactId) 沿 lineageArtifactIds 上溯（candidate-lineage.ts:200+）
  → transformed to  predecessorSummary.artifactId（attach-summary-envelope.ts）
  → SILENT DROP POSSIBLE? **部分 YES（见下 4 项）**
```

**7a — lineageArtifactIds（NO）**：`resolveLineageArtifactIds` 用 `Promise.allSettled`，rejected 的依赖设置 `hasRejected = true` → 调用方 emit `lineage_partial` 事件（`scribe-runner.ts:318-328`、`dreamer-runner.ts:291-296`、`artificer-runner.ts:1028-1035`）。⇒ 不完整是**可观测**的。

**7b — 陈旧实例 id 的静默重生（已 FIXED，PRI-717）**：`pi-art-${taskId}-${runId}` 含 runId ⇒ 同一 task 再 lease（attempt 递增）会产出**新 artifactId**，而 `UNIQUE(source_task_id, artifact_kind)` upsert 会**覆盖 artifact_id 列**（`sqlite-pi-artifact-store.ts:79-101`）。因此**旧 edge 里的 artifactId 会悬空**。`CandidateLineage.tryReboundInstance`（`candidate-lineage.ts:392-422`）在 `listBySourceTaskId` 结果中按同 id family 前缀匹配，**恰好 1 条**才 rebind，并 emit `lineage_edge_rebound`；0 或 >1 条保持 fail-closed `ancestor_pruned`（含 ambiguous 计数）。⇒ **不静默**，但见 F-02。

**7c — runner echo reconciliation（NO，机制完备）**：`reconcileLineageEcho`（`peer-runner-contracts.ts`）区分「字段缺失→注入」与「字段存在但回显错误→用权威值覆盖」，返回被纠正字段名，调用方**必须** emit `<runner>_lineage_echo_corrected`（rc-9）。逐 runner 亲验：
- dreamer：`topFields: [taskId]`（`dreamer-runner.ts:379-381`）
- philosopher：`topFields: [taskId, sourceDreamerArtifactId]`（`philosopher-runner.ts:388-396`）
- scribe：`topFields: [taskId, sourcePhilosopherArtifactId]` + `trace: sourceTrace.philosopherArtifactId`（`scribe-runner.ts:417-425`）
- artificer：`topFields: [taskId, sourceScribeArtifactId]`（同模式）
- rollout：按 reviewMode 选 `sourceScribeArtifactId` 或 `sourceEvaluatorArtifactId`（`rollout-reviewer-runner.ts:390-403`）

**7d — scribe → artificer 的 dreamer 血缘（YES，R-01 核心）**：见 §5 R-01 与 F-08。

**7e — context manifest 焦点模式抹掉 ID（全新发现，见 F-03）**：当 `context_manifest_budget` flag 开启时，`resolveContextInjection` 返回 `{ mode: 'focused', fields }`，调用方**用 fields 整体替换 predecessor 对象**：

```ts
// scribe-runner.ts:215-218
const resolved = this.resolveContextInjection(taskId, SCRIBE_MANIFEST, philosopherPred.contentJson);
if (resolved.mode === 'focused') {
  parsedPhilosopherArtifact = resolved.fields;   // ← 整个 philosopherArtifact 被替换
}
```

`SCRIBE_MANIFEST`（`context-manifests.ts:76-105`）声明的 tier0/tier1 字段**全部是 summary 值**（`philosopher.summary.headline`、`philosopher.predecessorSummary.badDecision` 等），**不含任何 artifactId**。⇒ 焦点模式下 scribe 收到的 prompt 里 `philosopherArtifact` 不再含 `sourceDreamerArtifactId`；而 scribe 被要求「`dreamerArtifactId` `<from philosopher artifact if available, or omit>`」（`scribe-prompt-builder.ts:78,106`）⇒ 该值**必然 omit**。下游 artificer 的 `resolveDreamerContext` 于是在**无事件路径**返回 undefined。**这是 R-01 的一个放大面：不只在「LLM 忘了改名」时失败，而是在 flag 开启时结构性必失败。**

### 跳 8 — artifact → approval

```
artifactId
  → stored as  approvals.approval_id = `apr_${channel}_${artifactId}`（sqlite-approval-store.ts:138-140 makeApprovalId）
                approvals.artifact_id = artifactId；status='pending'
  → consumed as  ActivationDispatcher.dispatch() 的 input.approvalId → getById()（activation-dispatcher.ts:215）
  → transformed to  record.artifactId / record.channel（用于 dispatch 的三个 match 校验）
  → SILENT DROP POSSIBLE? NO
```
证据（producer）：`enqueue` 先做**应用层 FK 检查** `SELECT 1 FROM pi_artifacts WHERE artifact_id = ?`，不存在则 **throw**（`sqlite-approval-store.ts:149-153`）——fail loud，不写孤儿 approval。随后 `INSERT OR IGNORE`（幂等键 = 派生 approvalId）。
证据（consumer）：`approval-completion-service.ts:141-160` 用 `record.artifactId` 与 `record.channel` 构造 `makeIdempotencyKey(record.artifactId, record.channel)` 并 dispatch；**dispatcher 独立复核**（见跳 9）。

### 跳 9 — approval → activation（绑定校验最严的一跳）

```
approvalId + artifactId + channel
  → stored as  activations(activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
                idempotency_key = `${artifactId}::${channel}`（activation-types.ts:268-270）
  → consumed as  dispatcher.activateArtifact() → writer.activate()
  → transformed to  WriterInput.principleId = extractPrincipleId(artifact)
  → SILENT DROP POSSIBLE? NO（三道绑定校验齐全）
```
证据（**dispatcher 的四重校验**，`activation-dispatcher.ts:197-259`）：
1. `rolloutDecision === 'approved'` 但无 `approvalId` → `refused: approved_dispatch_requires_approval_id`
2. `approvalRecord.status !== 'approved'` → `refused: approval_status_is_<s>_expected_approved`
3. `approvalRecord.artifactId !== input.artifactId` → `refused: approval_artifact_mismatch: approval=X dispatch=Y`
4. `approvalRecord.channel !== input.channel` → `refused: approval_channel_mismatch`

⇒ 注释明言这条是 security boundary：「the dispatcher independently verifies the approval record — it does NOT trust the caller's rolloutDecision alone」。**这是全链最强的一跳。**

`principleId` 解析（`low-risk-writers.ts:7-32` `extractPrincipleId`）四级回退：`sourcePrincipleId` 列 → `contentJson.principleId` → `contentJson.sourcePrincipleId` → `contentJson.principleDraft.title`。**注意第 4 级是「标题」而非 ID**（见 F-09，P3）。

### 跳 10 — activation → runtime receipt

```
activationId
  → stored as  principle_applications.principle_id / .activation_id / .rule_id / .channel / .level / .kind（principle-application-ledger.ts:83-100）
  → consumed as  ReceiptsConsoleModel / loadPrincipleReceiptMetadata(workspaceDir, ruleId, principleId)（principle-receipt-metadata.ts:78-90）
  → transformed to  PrincipleReceiptMetadata { title, approvedAt, sourceSummary }
  → SILENT DROP POSSIBLE? **YES（F-04：回链不可达）**
```
证据：
- **receipt 侧**：`principle_applications` 列集**没有** painId / candidateId / artifactId。写入方 `recordPrincipleApplication` 只收 `principleId / activationId / ruleId / channel / level / kind / sessionId / toolName / filePath / digest`（`principle-application-ledger.ts:27-38`）。
- **回链路径**：`principle-receipt-metadata.ts:128-140` 只能从 `pi_artifacts WHERE source_principle_id = ?` 反查 artifact，再经 `artifacts WHERE task_id = ?` 找 candidate title（:152-172）。
- ⇒ **从 receipt 反查 pain / candidate / 具体 artifact revision 没有直接外键路径**；且 `source_principle_id` 的取值语义本身不稳定（见 F-09）。

### 跳 11 — 修订 / revision 编号与 approval 失效

```
revision 触发
  → stored as  tasks.attempt_count = 0（revision-reopen.ts:109-115，单条原子 UPDATE）
                pitaskMetadata.revisionCount += 1；revisionCauseId = causeId
  → consumed as  rollout intent.epoch 比对（rollout-reviewer-runner.ts:1350-1360 `intent.revisionEpoch === (piTask.revisionCount ?? 0)`）
  → transformed to  新 run → 新 runId → 新 artifactId（同 task，覆盖 artifact_id 列）
  → SILENT DROP POSSIBLE? **YES（F-01 + F-10：旧 approval 不被失效）**
```

**artifact revision 编号机制（事实）：** 没有独立的 revision 序号。修订靠 **(a)** `revisionCount`（任务级，存在 `pitaskMetadata`），**(b)** `runId` 含 `attemptNumber`（派生）⇒ artifactId 含新 runId。⇒ **revision 身份 = 「新 runId」，不是「artifactId 的版本号」**。

**content hash（事实）：** `computeContentHash`（`artifact-content-hash.ts`）**只在 Layer 0 summary envelope 内使用**，且**只用在 `predecessorSummary.contentHash` 上**（`attach-summary-envelope.ts:143`），用途是 staleness 检测。**artifact 自身不落任何 content hash 列**（`pi_artifacts` DDL 无 hash 列，`sqlite-connection.ts:379-393`）。⇒ 上下游之间**没有内容级一致性校验**（见 F-11）。

**activation/审批的 digest（唯一的内容绑定）：** `activation_decisions.artifact_digest`（CHECK 要求 subject_kind='activation' 时 NOT NULL，`sqlite-connection.ts:502-540`），由 `PromotionReadinessReader` 计算并**比对** `expectedArtifactDigest`，不匹配 → `blocked: artifact_digest_mismatch`（`promotion-readiness-reader.ts:35-37`）。⇒ **RuleCode promote 路径有内容级绑定**，但**approve → activate 路径没有**。


---

## 5. Confirmed / Fixed / Drifted — §5 Carry-forward 逐项裁决

### R-01（P2）scribe→artificer 血缘命名断链

| 断言成分 | 裁决 | 回源证据（checkout `191ae1af`） |
|---|---|---|
| philosopher 产物字段叫 `sourceDreamerArtifactId` | **CONFIRMED** | `philosopher-output.ts:24` `readonly sourceDreamerArtifactId: string;`；`:42` schema `Type.String({ minLength: 1 })`（**required**）；`:85-87` validator 查非空 |
| scribe 提示词让找 `dreamerArtifactId` | **CONFIRMED** | `scribe-prompt-builder.ts:78` `"dreamerArtifactId": "<from philosopher artifact if available, or omit>"`；`:106` `sourceTrace.dreamerArtifactId is optional` |
| 该字段可选且无权威校验 | **CONFIRMED** | `scribe-output.ts:26` `readonly dreamerArtifactId?: string;`；`:58` `Type.Optional(Type.String())`；`:145-149` 仅当**存在**时校验非空 |
| 缺省时 artificer `resolveDreamerContext` 静默返回 undefined | **CONFIRMED** | `artificer-runner.ts:276`（无 `sourceTrace` → `return undefined`，**无事件**）、`:279-281`（无 `dreamerArtifactId` → `return undefined`，**无事件**）。对比其后的失败分支 `:284` `dreamer_context_skipped`、`:292` `dreamer_artifact_missing`、`:300/:304/:311/:316/:320/:325` `dreamer_context_invalid` —— **均发事件** |
| 「违反 rc-9」 | **CONFIRMED** | 同一函数内三种缺失形态里，前两种（`sourceTrace` 缺失、`dreamerArtifactId` 缺失）**无任何可观测信号**，第三种（变量类型错）才有 `dreamer_context_skipped` |

**裁决：CONFIRMED（P2 维持）。** 补充两条历史报告未点明的事实：

1. **行为已被测试固化为「期望无事件」**：`artificer-runner-vslice.test.ts:1318-1341` 的 `it.each` 用例表里，`'scribe.sourceTrace missing → dreamerContext undefined, no event (backward compat)'` 与 `'sourceTrace.dreamerArtifactId missing → dreamerContext undefined, no event (backward compat)'` 的 `expectedEvent: null`，并在断言里显式 `if (expectedEvent !== null)` 才期望遥测。⇒ **这不是疏漏，是被测试锁定的设计选择**（backward compat）。补事件会与该测试冲突，修复需同时改契约与测试。
2. **R-01 的实际触发面比历史描述更宽**：见 F-03 —— `context_manifest_budget` flag 开启时 scribe 收到的 philosopher 工件被 manifest 收窄为纯 summary 字段（**不含任何 artifactId**），此时 `dreamerArtifactId` 的 omit **是结构必然，不依赖 LLM 是否改名**。

### R-24（P2）`pi_artifacts(source_task_id, artifact_kind)` 唯一索引 = 覆盖语义

**裁决：CONFIRMED（P2 维持，副作用面扩大）。**

| 断言 | 回源证据 |
|---|---|
| 唯一索引存在 | `sqlite-connection.ts:393` `CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_artifacts_idempotency ON pi_artifacts(source_task_id, artifact_kind);` |
| upsert 在冲突时**覆盖 artifact_id** | `sqlite-pi-artifact-store.ts:79-93`：`INSERT … ON CONFLICT(source_task_id, artifact_kind) DO UPDATE SET artifact_id = excluded.artifact_id, source_principle_id = …, source_rule_id = …, lineage_artifact_ids = …, validation_status = …, content_json = …, updated_at = …` |
| 覆盖是生产路径而非理论 | 全部 **12 处** 生产 upsert 调用点逐一定位：`dreamer-runner.ts:302`、`philosopher-runner.ts:314`、`scribe-runner.ts:342`、`artificer-runner.ts:1040`、`evaluator-runner.ts:985 / :1086 / :1177 / :3265`、`rollout-reviewer-runner.ts:630`、`diag-rootcause-runner.ts:288`、`diag-distiller-runner.ts:270`、`diag-router-runner.ts:346` |

**新增事实（历史报告与 VERIFICATION-C 均未记录）：覆盖同时销毁 `lineage_artifact_ids` 与 `content_json` 的旧值，而 `artifact_id` 的旧值正是下游 edge 的引用目标。** 即：一次 re-run 会**同时**（a）改写本行 artifact_id，（b）重写 lineage 数组。二者叠加使「边」与「节点」在无事务跨界的情况下失去同步。PRI-717 的 rebind（`candidate-lineage.ts:392-422`）只覆盖了情形（a）的单一条边，且只在其「恰好 1 条同 family 候选」时生效。

**另注**：`evaluator-runner.ts` 有 **2 种 artifactKind**（`:985` 写 `'principle'`，`:3265` 写 `'rule'`）落在**同一 task** ⇒ 该 task 的 `(source_task_id, artifact_kind)` 有 **2 行**，符合唯一索引语义（不同 kind）。所以 R-24 的「覆盖」只发生在**同 task 同 kind 的 re-run**，不是跨 kind。历史报告未点明此边界，本报告补记。

### `sourcePrincipleId` / `dreamerArtifactId` / `sourceDreamerArtifactId` 三者精确语义与消费方

**逐一定位（producer + consumer 双端）：**

| 字段 | 语义（精确） | Producer | Consumer | 类型 | 命名空间问题 |
|---|---|---|---|---|---|
| `sourceDreamerArtifactId` | **philosopher 输出顶层字段**：它消费的那个 dreamer artifact 的 `artifactId` | `philosopher-prompt-builder.ts:91`（要求 LLM 逐字复制 `input.sourceDreamerArtifactId`）；`philosopher-runner.ts:194` 从 `firstArtifact.artifactId` 取权威值注入 context | ① `philosopher-runner.ts:269-276` validateOutput 后校验 `=== context.sourceDreamerArtifactId`，不等抛 `output_invalid`；② `philosopher-runner.ts:388-396` reconcileLineageEcho 权威覆盖；③ `succeedTask` 再次比对 | **required**（schema `minLength: 1`） | **无**——philosopher 内部自洽 |
| `dreamerArtifactId` | **scribe 输出 `sourceTrace` 的嵌套可选字段**：由 scribe 从 philosopher 工件里「找」到的 dreamer artifact id | `scribe-prompt-builder.ts:78`（提示词要求）；`scribe-output.ts:58`（Optional） | ① `scribe-runner.ts:417-425` reconcileLineageEcho **不处理该字段**（注释明言 `Optional trace fields (dreamerArtifactId) have no authoritative value and are left alone`）；② `artificer-runner.ts:279-289` `resolveDreamerContext` 唯一的读取方 | **optional** | **有**——见下 |
| `sourcePrincipleId` | **语义过载**：在 dreamer 输出里是「CORE AXIOMS 公理 ID（如 T-01）」；在 `pi_artifacts` 列里是「principle 台账链接」；在 evaluator 写 rule artifact 时是「scribe principle artifact 的 principle ID」 | ① `dreamer-prompt-builder.ts:105`（提示词：仅填 CORE AXIOMS 的 T-XX，禁止编造）；② `dreamer-runner.ts:309` 写 `pi_artifacts.source_principle_id`；③ `evaluator-runner.ts:3269` 写 rule artifact 的 `source_principle_id` | ① `stripFabricatedCorePrincipleIds`（`dreamer-runner.ts:385`）按 CORE_PRINCIPLES 注册表**删除**非法值；② `extractPrincipleId`（`low-risk-writers.ts:7-32`）与 `extractPrincipleIdFromArtifact`（`evaluator-runner.ts:2807-2832`）；③ `sqlite-activation-safety-store.ts:390,393` 的 `COALESCE(source_principle_id, json_extract(...principleId), json_extract(...sourcePrincipleId))` | **optional** | **有（P3，见 F-09）** |

**命名空间错位（回源否证 + 确认为 P3）：** 历史报告 §4 dreamer 卡 7 提出「dreamer 的 sourcePrincipleId 写公理 ID 进原则外键列，疑似悬空外键」。

**回源裁决：PARTIAL / P3，其危害低于历史描述。** 依据：
- `stripFabricatedCorePrincipleIds` 只在 dreamer 的 `postFetchTransform` 调用（`dreamer-runner.ts:385`），且仅对**不在 CORE_PRINCIPLES 注册表内**的值做 `delete`（`core-principles/strip-fabricated-ids.ts:21-29`）。⇒ 落库值只可能是合法公理 ID（`T-XX`）。
- 消费者侧 `extractPrincipleId` 把 `sourcePrincipleId` 当**不透明字符串**使用：传给 `WriterInput.principleId` → PromptWriter 生成 `act_prompt_${principleId}`；唯一语义后果是**activation 命名空间被公理 ID 占据**（`act_prompt_T-01`）。
- 是否有实际冲突需 runtime 数据；静态不可判定 ⇒ 本报告只记 P3 命名空间错位，**不升级**。

### reviewed / approved / activated 三个时点的 exact identity，及「edit 后旧 approval 是否继续生效」

**结论：edit 路径本身是安全的（旧 approval 不会悬空指向新 revision）；但存在两个真实缺口（F-10、F-12）。**

**（A）edit 绑定（CONFIRMED 正确，Story A / PRI-408）：**

```sql
-- sqlite-approval-store.ts:273-283
UPDATE approvals
   SET previous_artifact_id = artifact_id,   -- 旧值先归档
       artifact_id = ?, edited_at = ?, edited_by = ?, edit_reason = ?
 WHERE approval_id = ? AND status = 'pending'  -- 仅 pending 可 edit
RETURNING *
```

⇒ **同一行内原子地移动指针并留档旧值**，`approval_id` 不变，且 `WHERE status = 'pending'` 使**已 approved 的 approval 无法被 edit**（`sqlite-approval-store.ts:277`；`approval-queue.ts:74-81` 亦双重检查）。

**（B）revision 合法性（CONFIRMED，P1 #2 修复，`activation-types.ts:262-267`）：**

```ts
export function isArtifactRevisionOf(candidate, original): boolean {
  const referencesOriginal = candidate.lineageArtifactIds.includes(original.artifactId);
  const samePrinciple = Boolean(candidate.sourcePrincipleId)
    && candidate.sourcePrincipleId === original.sourcePrincipleId;
  return candidate.sourceTaskId === original.sourceTaskId || referencesOriginal || samePrinciple;
}
```

调用方在 swap 前**同时**校验：新 artifact 存在、`validationStatus === 'validated'`、`isArtifactRevisionOf`（Console `ApprovalsConsoleModel.ts:301-325`；CLI `runtime-activation.ts:1108-1118`）。⇒ 不能指向任意的、未验证的、血缘不符的 artifact。

**⇒ 回答任务书问题「edit 之后旧 approval 是否可能继续生效」：NO。** 证据链完整：`edit` 只对 pending 生效；edit 后 approval 仍是 pending（未 approved）⇒ 不存在「旧 revision 的 approved 状态在新 revision 写入后继续生效」的路径。

**（C）但存在真正缺口 —— 反向情形（F-12，P1 候选，本次新发现）：`approval` 一旦 approved，`content_json` 可在原地被改写而 approval 不复核。**

路径：`pi_artifacts` 的 upsert 覆盖 `content_json`（`sqlite-pi-artifact-store.ts:81-93`），artifact_id 也一起被覆盖。若**同一个 task 同 kind 再次 upsert**（re-run / 重放 / repair loop），且该 artifact 已有 approved approval：
- approval 行仍指向**同一个 approvalId**（`apr_<channel>_<artifactId>` 由 artifactId 派生，而新 upsert 的 artifactId 因 runId 变化而**不同**）⇒ 新 artifactId ⇒ **新 approvalId**，旧 approval 变成孤儿但不生效。
- 但 **`lineage_edge` / `lineage_artifact_ids` 指向旧 artifactId 的边**会先 rebind 到新 artifact（`candidate-lineage.ts`），使「逻辑上同一个下游节点」；
- **反之**：若调用方复用同一 `artifactId` 字符串（`owner-review.ts:140` 的 `pi-art-${taskId}-${runId}` 用传入的 runId，可复用），则 upsert 会**原地改写**该行 content_json，而 `UNIQUE(approval_id)` 的 approvals 行**保持不变、状态仍为 approved** ⇒ **approval 指向的 artifact 内容已变，approval 未失效、未复核**。

⇒ 结论：**「同一 artifactId 的 content_json 原地改写后，既有 approved approval 不复核」是真实缺口（F-12）。** 唯一内容级防御只在 RuleCode promote 路径（`activation_decisions.artifact_digest` + `PromotionReadinessReader` 比对），**approve→activate 主路径没有**。

### R-23（P2）`tasks.attempt_count` 与 `runs.attempt_number` 双源不一致

**裁决：CONFIRMED（P2 维持），且确实落在本链上——仅标记，深入调查归 Worker D（按任务书要求）。**

- 写侧 A：`lease-manager.ts:151-165` 单事务内 `attemptNumber = MAX(runs.attempt_number)+1`，同时 `UPDATE tasks SET attempt_count = attemptNumber` ⇒ **两源被写成同值**。
- 写侧 B：`revision-reopen.ts:109-115` 单条原子 UPDATE 写 `attemptCount: 0`，而 `runs.attempt_number` **不回退**。
- ⇒ **reopen 完成 → 下次 lease 之间的窗口内**，`tasks.attempt_count = 0` 而最近 run 的 `attempt_number` 为历史递增值。**同一任务的「第几次尝试」出现两个矛盾的持久化事实。**

**本链上的血缘相关性（本报告新增）：** 该窗口内若发生 upsert，`artifactId = pi-art-${taskId}-${runId}` 中的 runId 取自 `resolveStoreRunId()`（`base-peer-runner.ts:575-619`，取 runs 列表最后一条），与 `task.attemptCount` 无关 ⇒ **artifactId 不含 attempt_count**，故 R-23 **不污染 artifactId 派生**。R-23 对血缘的影响仅限于「observability 读模型可能报告错误的 attempt 序号」。

### 全链裁定汇总

| 条目 | 裁决 | 严重度 |
|---|---|---|
| R-01 scribe→artificer 命名断链 + 静默段 | **CONFIRMED**（补：被测试锁定为 backward compat；触发面因 manifest 收窄而扩大） | P2 |
| R-24 唯一索引 = 覆盖语义 | **CONFIRMED**（补：同一 upsert 同时覆盖 artifact_id 与 lineage 数组；evaluator 双 kind 边界） | P2 |
| `sourcePrincipleId` 语义/命名空间 | **PARTIAL**（三级回退链存在；公理 ID 命名空间错位为 P3，非悬空外键） | P3 |
| edit → 旧 approval 悬空 | **FIXED / 不成立**（`previous_artifact_id` 原子归档 + 仅 pending 可 edit + `isArtifactRevisionOf` 校验） | — |
| 反向：content_json 原地改写后 approved approval 不复核 | **NEW（F-12）** | P1 候选 |
| R-23 attempt_count / attempt_number 双源 | **CONFIRMED**，在本链上仅为 observability（artifactId 不含 attempt_count） | P2（归 Worker D） |


---

## 6. NEW Findings

> 每条含：ID / Severity / Claim / Evidence（file:symbol:line @ `191ae1af`）/ Why it matters / Affected stage / Current protection。
> 严重度标尺：**P1** = 身份静默丢失可导致 canonical data corruption 或未批准内容被激活；**P2** = 血缘语义不一致可能致错误治理结论；**P3** = 死字段 / 命名漂移 / latent debt。

### F-01【P2】`pi_artifacts` 唯一索引下，upsert 一次性销毁旧 `artifact_id` 与旧 `lineage_artifact_ids`，使「边」与「节点」跨事务失同步

- **Severity**：P2
- **Claim**：`UNIQUE(source_task_id, artifact_kind)` 的 `DO UPDATE` 子句同时改写 `artifact_id`（下游 edge 的引用目标）与 `lineage_artifact_ids`（本节点的上行边集合），两者在同一语句内被替换，但**下游已持久化的 edge 字符串不在同一事务内**，因此一次 re-run 会同时使「本行的 id」与「本行的上行边」失效，而下游记录的旧 id 需要靠事后的 rebind 才发现。
- **Evidence**：
  - `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts:393` — `CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_artifacts_idempotency ON pi_artifacts(source_task_id, artifact_kind);`
  - `packages/principles-core/src/runtime-v2/store/artifact/sqlite-pi-artifact-store.ts:79-93` — `ON CONFLICT(source_task_id, artifact_kind) DO UPDATE SET artifact_id = excluded.artifact_id, …, lineage_artifact_ids = excluded.lineage_artifact_ids, content_json = excluded.content_json`
  - `packages/principles-core/src/runtime-v2/runner/base-peer-runner.ts:547-571` — `resolveLineageArtifactIds()`（写入前的边集合解析）
  - `packages/principles-core/src/runtime-v2/internalization/candidate-lineage.ts:392-422` — `tryReboundInstance()`（事后的单边 rebind，`matches.length !== 1` 即 fail-closed）
- **Why it matters**：这是「artifact identity guard」要防的核心形态：**同一逻辑节点的 instance id 被静默改写**，观测者（Console / read model / audit）无法从 id 本身判断「这是新版本还是同一版本」。
- **Affected stage**：全部 6 个 peer runner 的 artifact 写入（跳 7）+ `CandidateLineage` 上溯（tier2 解析）
- **Current protection**：`lineage_edge_rebound` 事件（`candidate-lineage.ts:410-416`，只在恰好 1 条候选时）+ `ancestor_pruned` note + `lineage_partial` 事件。**无版本号、无历史留档、无 content hash 列**。

### F-02【P2】`tryReboundInstance` 在「同 family 多个候选」时 fail-closed，但该情形正是双 kind 写者（evaluator）的正常产物叠加态

- **Severity**：P2
- **Claim**：`tryReboundInstance` 用前缀 `` `pi-art-${taskId}-run_` `` 过滤并**要求恰好 1 条**；`evaluator-runner.ts` 在同一 task 下同时写 `'principle'` 与 `'rule'` 两种 kind 的行（`:985` 与 `:3265`），其中 `rule` 行 id 前缀为 `pi-rule-`（`evaluator-runner.ts:3261` `const ruleArtifactId = \`pi-rule-${taskId}-${runId}\``），因此前缀过滤能正确排除。**但**：若一次修复轮中 evaluator 连续写多行同前缀实例（`:985`、`:1086`、`:1177` 三处 upsert），过滤结果的条数取决于 upsert 是否真的落到同一 `(task, kind)` 组——`matches.length > 1` 时 rebind 放弃并报告 `ambiguousCandidates`。
- **Evidence**：
  - `packages/principles-core/src/runtime-v2/internalization/candidate-lineage.ts:392-422`（`refreshPrefix = \`${ARTIFACT_ID_PREFIX}${taskId}-run_\``，`if (matches.length !== 1) return { ok: true, value: null, …ambiguousCandidates }`）
  - `packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts:982, :1086, :1177, :3261-3265`（同 task 多处 upsert；`'principle'` 与 `'rule'`）
- **Why it matters**：fail-closed 是正确的（不猜测），但代价是**血缘在 evaluator 重放后可能永久留空**（`ancestor_pruned`），使 evaluator→rollout 的上行链在审计读模型中缺失。
- **Affected stage**：evaluator→rollout 的 lineage 上溯；`owner-review.ts` 的 NHR 裁决面（该面只能看到最终态工件）
- **Current protection**：`ancestor_pruned` note + `lineage_partial` 事件 + `ambiguousCandidates` 计数出现在 note detail 里（`candidate-lineage.ts:296-301`）。**无告警升级、无 operator nextAction**。

### F-03【NEW，P2】`context_manifest_budget` 焦点模式下 predecessor 工件被替换为纯 summary 字段，**任何 artifactId 都不再进入 prompt** ⇒ 跨级血缘链在 flag 开启时结构性断裂

- **Severity**：P2（这是 R-01 的真实放大面，且是**结构性**而非概率性）
- **Claim**：`resolveContextInjection` 在 focused 模式返回 `{ mode: 'focused', fields }`，调用方**整体替换** predecessor 对象；`SCRIBE_MANIFEST` 的 tier0/tier1 **全部是 summary 值，不含 artifactId**。故 scribe 提示词中「`dreamerArtifactId` `<from philosopher artifact if available>`」必然 omit，下游 `resolveDreamerContext` 走**无事件**返回 undefined 的路径（`artificer-runner.ts:276/279-281`）。
- **Evidence**：
  - `packages/principles-core/src/runtime-v2/runner/base-peer-runner.ts:1211-1221` — `resolveContextInjection()`；`:1368-1371` — `if (result.kind === 'focused') return { mode: 'focused', fields: result.allocated.fields };`
  - `packages/principles-core/src/runtime-v2/internalization/scribe-runner.ts:215-218` — `if (resolved.mode === 'focused') { parsedPhilosopherArtifact = resolved.fields; }`（**整体替换**）
  - `packages/principles-core/src/runtime-v2/internalization/context-manifests.ts:76-105` — `SCRIBE_MANIFEST` tier0 `['philosopher.summary.headline', …]`、tier1 全为 `philosopher.summary.*` / `philosopher.predecessorSummary.*`；**无任何 artifactId 路径**
  - `packages/principles-core/src/runtime-v2/internalization/scribe-prompt-builder.ts:78,106` — 提示词要求 `dreamerArtifactId`「from philosopher artifact if available」
  - 同模式亦存在于 dreamer（`dreamer-runner.ts:221-226`，`DREAMER_MANIFEST`）与 artificer（`artificer-runner.ts:866-880`）
- **Why it matters**：状态为「flag 开则必断，flag 关则概率断（取决于 LLM 是否改名映射）」——**血缘稳定性依赖一个 feature flag 的开关状态**，而该 flag 的语义（context 预算）与血缘完整性无关。这是「一个开关意外改变 canonical 数据可达性」的典型形态。
- **Affected stage**：scribe（跨级：dreamer→scribe）、artificer（消费端）
- **Current protection**：**无**。focused 模式不发「lineage 字段被收窄掉」的专门事件；`manifest_resolution_insufficient`（`base-peer-runner.ts:1330-1338`）只统计**声明路径**的缺失比例，不统计「未声明但下游需要的 ID」。测试亦未覆盖此组合（`artificer-runner-vslice.test.ts` 的用例全部喂**完整** scribe contentJson）。

### F-04【P2】runtime receipt 无到 pain / candidate / artifact revision 的回链列

- **Severity**：P2
- **Claim**：`principle_applications`（receipt 表）的列集不含 painId、candidateId、artifactId（只有 `principle_id`、`activation_id`、`rule_id`）。回链只能靠 `pi_artifacts.source_principle_id` 二次跳转，且该列的取值语义不稳定（见 F-09）。
- **Evidence**：
  - `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts:463-481` — `CREATE TABLE IF NOT EXISTS principle_applications (id, principle_id, activation_id, rule_id, channel, level, kind, session_id, tool_name, file_path, digest, created_at)` — **无 pain/candidate/artifact 列**
  - `packages/openclaw-plugin/src/core/principle-application-ledger.ts:27-38`（`PrincipleApplicationInput` 字段集）与 `:84-100`（INSERT 列清单）
  - `packages/openclaw-plugin/src/core/principle-receipt-metadata.ts:128-140`（唯一回链 SQL：`FROM pi_artifacts WHERE source_principle_id = ?`）与 `:152-172`（经 `artifacts WHERE task_id = ?` 找 candidate title）
- **Why it matters**：任务书的链尾要求「runtime receipt 回链（事件里带回的 ID 能否反查到 pain/candidate）——**答案是否定的**」。任何「这条被拦下的行为源自哪个 pain / 哪个 candidate」的治理追问，都必须经过一条依赖 `source_principle_id` 语义稳定性的间接路径，且该路径**不区分 revision**。
- **Affected stage**：receipt → pain/candidate 回链（跳 10）
- **Current protection**：`digest` 列存在（`principle-application-ledger.ts:36`），但语义是**行为上下文摘要**（tool/file），不是 artifact 内容 hash；无 FK、无 NOT NULL、无校验。

### F-05【P3】`pain-signal-bridge` re-entry 在 `input_ref` 缺失时静默把 `painId` 回退为 `taskId`

- **Severity**：P3
- **Claim**：`const painId = typeof task.inputRef === 'string' && task.inputRef.length > 0 ? task.inputRef : taskId;` —— 回退产生 `diagnosis_<painId>` 形式的「painId」，语义从 pain 身份漂移为 task 身份，且**无事件、无 warning**。
- **Evidence**：`packages/principles-core/src/runtime-v2/pain-signal-bridge.ts:589` 与 `:599`（`executeSubmittedTask` / `onPainDetected` 的 re-entry 分支）
- **Why it matters**：`painId` 是链头身份；回退值会被写入 `PainSignalBridgeResult.painId`、`pain_diagnoses.pain_id`（经 `persistPainDiagnosis`）与日志 traceId —— **一个前缀形态就足以辨别**，但生态里没有断言。
- **Affected stage**：跳 1-3（pain → diagnosis task 的身份）
- **Current protection**：无（`inputRef` 在正常 seed 路径总被写入，故实际触发需手工/异常建 task）。

### F-06【P3】candidate 身份不跨诊断重放稳定（`randomUUID` + 索引键含 `commitId`）

- **Severity**：P3
- **Claim**：`candidateId = randomUUID()`、`candidateIdemKey = \`${commitId}:${i}\``，而 `commitId = randomUUID()`。⇒ 同一 diagnostician 输出重新提交（新 run / 新 commit）会产生**全新的 candidate 身份**，`principle_candidates` 无「同 task 同 recommendation index」唯一约束。
- **Evidence**：
  - `packages/principles-core/src/runtime-v2/store/commit/diagnostician-committer.ts:132-133`（`commitId = randomUUID(); artifactId = randomUUID();`）
  - 同文件 `:184-185`（`const candidateId = randomUUID(); const candidateIdemKey = \`${commitId}:${i}\`;`）
  - `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts:350-374`（`principle_candidates` DDL：`candidate_id TEXT PRIMARY KEY`、`idempotency_key TEXT NOT NULL UNIQUE`；**无 (task_id, index) 唯一约束**）
  - 幂等仅在**同 runId 或同 idempotencyKey** 时生效：`diagnostician-committer.ts:246-270`（`tryGetExistingCommit`）
- **Why it matters**：`dreamer-${candidateId}-${channel}` 的 taskId 因此也不稳定 ⇒ 「同一 pain 重放几次就会有几套 dreamer 链」。这不是 corruption（每条链自洽），但**血缘基数会膨胀**，且 `findExistingDreamerTask` 的 candidate 级去重（`intake-to-internalization-bridge.ts:23-33`）无法跨重放去重。
- **Affected stage**：跳 5-6（candidate → dreamer seed）
- **Current protection**：仅 run/commit 级幂等；无 candidate 级唯一约束。

### F-07【P2】`CANDIDATE_KIND_TO_ROUTE` 未命中 route 时整段 seed 被静默跳过（无事件）

- **Severity**：P2
- **Claim**：`pain-signal-bridge.onDiagnosisComplete` 的 seed 循环里 `if (route) { …整个 seed + 事件块… }`。`route` 为 undefined 时**既不 seed、也不 push `notInternalizable`、也不 emit 任何事件**，随后 candidate 仍被无条件标记 `consumed`（`:837-839`）。
- **Evidence**：
  - `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts:771-807`（`const route = CANDIDATE_KIND_TO_ROUTE[candidate.recommendationKind ?? '']; if (route) { … }`）
  - `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts:844-846`（`if (candidate.status !== 'consumed') { await this.stateManager.updateCandidateStatus(candidate.candidateId, { status: 'consumed' }); }`）
  - `packages/principles-core/src/runtime-v2/internalization/intake-to-internalization-bridge.ts:114-120`（`CANDIDATE_KIND_TO_ROUTE` 只有 5 个 key）
  - 对比：`not_internalizable` 分支**有**事件（`pain-signal-bridge.ts:800-807` `candidate_not_internalizable`）；`seedErr` 分支**有**事件（`:829-836`）
- **Why it matters**：`recommendation_kind` 落在 5 个合法值之外时（DB 列默认 `'principle'` 但不加 CHECK，`sqlite-connection.ts:363` + `:730-735` 迁移仅 ADD COLUMN），血缘链**在这一点静默终止**：candidate 被 consumed，却既无下游 task 也无任何可观测记录。这是「静默丢弃」的形态之一。
- **Affected stage**：跳 6（candidate → dreamer）、下游全链
- **Current protection**：`candidateOutcomes` 会对该 candidate 给出 `reason: admission.reason`（若 admitted 且无 seededTaskId 则回退到 `'dreamer_seed_failed'` 或 `notInternalizableEntry.reason`）——但**这两者都不适用**，故 outcome 会显示 `decision: 'admitted'` 且**无 reason 说明**（`pain-signal-bridge.ts:853-881`）。

### F-08【P2】scribe `sourceTrace.dreamerArtifactId` 命名与 philosopher `sourceDreamerArtifactId` 不对称，唯一桥接手段是 LLM 自行改名映射

- **Severity**：P2（= R-01 的命名成分，独立编号以便后续 guard 设计引用）
- **Claim**：跨级字段名不一致（`dreamerArtifactId` vs `sourceDreamerArtifactId`），且 scribe 侧该字段 optional、无权威回填、无校验。`reconcileLineageEcho` 明确不处理它。
- **Evidence**：
  - producer 侧字段名：`philosopher-output.ts:24,42`（`sourceDreamerArtifactId`）
  - consumer 侧提示词名：`scribe-prompt-builder.ts:78,106`（`dreamerArtifactId`）
  - 无权威回填：`scribe-runner.ts:415-416` — 注释 `Optional trace fields (dreamerArtifactId) have no authoritative value and are left alone.`
  - 唯一读取方：`artificer-runner.ts:279-281`
  - scribe 的 promptInput **不含** dreamer 相关字段（`ScribePromptInput`：`scribe-prompt-builder.ts:15-22` 只有 `taskId / contextHash / sourcePhilosopherArtifactId / philosopherArtifact / promptContractVersion`）⇒ 桥接完全依赖 LLM 在被替换/完整注入的 philosopherArtifact 里找到并改名
- **Why it matters**：跨级血缘的**唯一载体是一段自由文本约定**，无机器校验。任何 prompt 措辞调整、模型更换、或 F-03 的 manifest 收窄，都会静默断开。
- **Affected stage**：philosopher→scribe→artificer
- **Current protection**：`artificer-runner.ts:284-329` 对**存在但无效**的值有事件；对**缺失**无事件。测试 `artificer-runner-vslice.test.ts:1318-1341` 把「缺失→无事件」固定为期望行为。

### F-09【P3】`extractPrincipleId` 第四级回退返回 `principleDraft.title`（标题当 ID）

- **Severity**：P3（命名空间污染；若标题含空格/非 ASCII，激活 idempotency key 会含这些字符）
- **Claim**：`extractPrincipleId` 的回退链最后一级是 `parsed.principleDraft.title`，即把一个**人类可读标题**当作 principle ID 使用，进而参与 `act_prompt_${principleId}` 与 `${artifactId}::${channel}` 之外的命名。
- **Evidence**：
  - `packages/principles-core/src/runtime-v2/activation/low-risk-writers.ts:7-32`（回退顺序：`sourcePrincipleId` 列 → `contentJson.principleId` → `contentJson.sourcePrincipleId` → `contentJson.principleDraft.title`）
  - 镜像实现：`packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts:2807-2832`（`extractPrincipleIdFromArtifact`，同样含 `principleDraft.title` 末级）
  - 消费：`activation-dispatcher.ts:346-349` 的 `principleId` 检查（`if (!principleId) return { decision: 'invalid_artifact', reason: 'no_principle_id' }`）——**只要标题非空就通过**
  - 注释自陈：`evaluator-runner.ts:2801-2806` 明确列出四级（含 `principleDraft.title`）
- **Why it matters**：`sourcePrincipleId` 的语义已过载（公理 ID / 台账 ID / scribe principle ID），末级再落回标题 ⇒ 同一列在不同 artifact 上承载三类不同命名空间。审计/告警若按该列分组会得到互相不可比的键。
- **Affected stage**：跳 8-9（approval/activation 的 principle 绑定）+ 跳 10（receipt 回链）
- **Current protection**：无。`dreamer-runner.ts:385` 的 `stripFabricatedCorePrincipleIds` 只删**编造的公理 ID**，不碰标题回退。

### F-10【P2】`revisionCount` / `revisionCauseId` 只存在于 `pitaskMetadata`，无 artifact 侧 revision 权威

- **Severity**：P2
- **Claim**：修订编号是**任务级**（`pitaskMetadata.revisionCount`），artifact 侧没有 revision 列、没有版本号、没有 `parentArtifactId`（除 approvals 的 `previous_artifact_id` 之外）。⇒ 「这是哪个 revision 的 artifact」在 artifact 行内**无法回答**，只能通过与 runId 的字符串关系反推。
- **Evidence**：
  - `packages/principles-core/src/runtime-v2/internalization/peer-runner-contracts.ts:164-170`（`PITaskRecord.revisionCount?` / `revisionFeedback?` / `revisionCauseId?` 均为 optional 任务元数据）
  - `packages/principles-core/src/runtime-v2/internalization/revision-reopen.ts:109-115`（单条 UPDATE：metadata + status + `attemptCount: 0`）
  - `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts:379-393`（`pi_artifacts` DDL：**无 revision / version / parent / hash 列**）
  - `packages/principles-core/src/runtime-v2/internalization/rollout-reviewer-runner.ts:1350-1360`（唯一使用方：`intent.revisionEpoch === (piTask.revisionCount ?? 0)`）
- **Why it matters**：Exact Artifact Identity guard 需要的「revision 身份」目前**不存在于 artifact 平面上**。任何「同一逻辑 artifact 的第 N 版」断言都必须经由 `pi-art-<taskId>-run_<taskId>_<seq>` 的字符串解析（`candidate-lineage.ts:124-141` `parseArtifactInstanceTaskId`）——即**用命名约定承载版本语义**。
- **Affected stage**：跳 7 / 跳 11
- **Current protection**：`parseArtifactInstanceTaskId` 的格式校验（prefix + run marker + 同 taskId 前缀 + 纯数字 seq），非法形状返回 null 并 fail-closed。

### F-11【P2】artifact 自身无 content hash 列；唯一内容级绑定只在 RuleCode promote 路径

- **Severity**：P2
- **Claim**：`pi_artifacts` 无 hash 列；`computeContentHash` 只用于 Layer-0 envelope 的 `predecessorSummary.contentHash`（staleness 检测）；`activation_decisions.artifact_digest` 是**唯一**的内容级绑定，且只在 promote 时比对。⇒ **approve → activate 主路径无内容一致性校验**。
- **Evidence**：
  - `packages/principles-core/src/runtime-v2/internalization/artifact-content-hash.ts` — `computeContentHash(value, hash)`（纯函数，hash 由调用方注入）
  - `packages/principles-core/src/runtime-v2/internalization/attach-summary-envelope.ts:143` — `contentHash: computeContentHash(loadedPredecessor.contentJson, hash)`（**只写 predecessorSummary**）
  - `packages/principles-core/src/runtime-v2/runner/base-peer-runner.ts:1060-1075`（`contentHashFn` 未注入时 → `artifact_summary_predecessor_skipped` + `reason: 'content_hash_fn_not_injected'`）
  - `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts:379-393`（无 hash 列）
  - `packages/principles-core/src/runtime-v2/activation/promotion-readiness-reader.ts:35-37`（`if (artifactDigest !== request.expectedArtifactDigest) → blocked: artifact_digest_mismatch`）
  - `packages/openclaw-plugin/src/core/rulecode-safety-circuit.ts:69`（digest 计算）与 `packages/pd-console/src/server/models/ActivationsConsoleModel.ts:663`（另一套 digest 计算，`JSON.stringify(artifact)` 全对象）
- **Why it matters**：两处 digest 的**输入不同**（一处 `contentJson`，一处 `JSON.stringify(artifact)` 全记录）⇒ 同一 artifact 的两个 digest 不可比。且主 approve→activate 路径完全无 digest。
- **Affected stage**：跳 8-10
- **Current protection**：promote 路径的 `lineage_binding` check（`promotion-readiness-reader.ts:41-43` 还校验 `sourceTaskId && lineageArtifactIds.length > 0`）。

### F-12【P2】approval 路径的内容绑定为空：同一 `artifactId` 的 `content_json` 被原地改写后，既有 approved approval 不复核

- **Severity**：**P2**（**下调理由见下，附反证**；不作为 P1。涉及「未批准内容被激活」的完整阻塞链仍需 runtime 数据确认）
- **Claim**：PD 存在**两套并行的 Owner 审批入口，内容绑定强度不同**：
  - **增量式 Owner Decision（NHR）入口 —— 绑定严密**：`buildOwnerReviewKey` 把 `taskId / revisionEpoch / sourceRunId / sourceArtifactId / sourceArtifactHash / machineDecision / humanReviewReason` 七元组做 sha256，`owner-resolution-service.ts:364-379` 在服务端**重读 durable facts 重算 reviewKey 并逐字段比对** `expectedSourceArtifactHash` 等断言，任一变化即 `409 stale_owner_decision`。
  - **高风险 deployment approval 入口 —— 内容绑定为空**：`OwnerDecisionConsoleModel.ts:284-294` 为 `activation_approval` 项写死 `expectedSourceArtifactHash: ''`、`expectedSourceRunId: ''`、`expectedRevisionEpoch: 0`；`ActivationDispatcher` 的四重校验（`activation-dispatcher.ts:197-259`）只比对 `approvalId` 存在 / `status === 'approved'` / `artifactId` 相等 / `channel` 相等，**不比对内容**。
- **Evidence**：
  - 写入面无原地改写的直接证据 —— 全部 12 个生产 upsert 调用点（§5 R-24 已枚举）的 artifactId **均含当前 runId**，而 `runId = run_${taskId}_${attemptNumber}` 由 `MAX(attempt_number)+1` 单调递增（`lease-manager.ts:151-168`）⇒ 同一 task 的新 run **必然**产生新 artifactId ⇒ 走 `DO UPDATE SET artifact_id = excluded.artifact_id`（`sqlite-pi-artifact-store.ts:81-93`）路径，**不是**同 id 原地改写。
  - 但 `evaluator-runner.ts:1787 / :1824 / :1923` 的三种 intent-resume 分支用 `pi-art-${taskId}-${intent.sourceRunId}` **复用历史 runId** ⇒ 与既有行 artifactId 相同 ⇒ 走**原地覆盖 content_json** 的分支。
  - approval 绑定弱：`sqlite-approval-store.ts:138-140`（`makeApprovalId = 'apr_' + channel + '_' + artifactId`）、`activation-dispatcher.ts:238-254`（只比 artifactId/channel）、`OwnerDecisionConsoleModel.ts:291-294`（`expectedSourceArtifactHash: ''`）。
  - 唯一的内容级防御位于另一条路径：`activation/promotion-readiness-reader.ts:35-37`（`artifact_digest_mismatch`）。
- **Why it matters**：这是任务书 §4.2 直接要求的判定项。**「edit 方向」是安全的（§5 已 FIXED）；「同 artifactId 内容原地改写」方向不安全**，但触发前提（intent-resume 复用 sourceRunId 且该 artifact 已有 approved approval）在本 checkout 的静态证据下**是窄路径**：`evaluator-runner` 的 intent-resume 分支服务于「裁决漂移恢复」，其恢复前置是任务处于 `needs_human_review`，而 approved approval 语义上表示该 approval 已进入 dispatch。⇒ 静态层**不能证伪也不能证实**「已批准内容被替换后仍被激活」。记为 P2，需 runtime 数据（`activations` ⨝ `approvals` ⨝ `pi_artifacts.updated_at` 时序）方可定级。
- **Affected stage**：跳 8 → 9（approval → activation）
- **Current protection**：
  1. `activation_approval` 项在 OwnerDecisionConsoleModel 里**显式标注** hash 为空（可观测的设计省略，非静默）；
  2. `promotion-readiness-reader.ts:41-43` 的 `lineage_binding` check 要求 `sourceTaskId && lineageArtifactIds.length > 0`（但同样**不是内容级**）；
  3. **approve → activate 主路径无内容级绑定。**

### F-13【P2，本次新发现】两套 Owner 审批入口对「同一事实快照」的绑定强度不对等，且只有一套暴露 reviewKey

- **Severity**：P2
- **Claim**：`OwnerDecisionConsoleModel.list()` 把两类异构项扁平进同一个 Owner Inbox：`kind: 'owner_decision'`（NHR，有 `reviewKey = odk_<sha256>`）与 `kind: 'activation_approval'`（高风险部署，`reviewKey = 'apr:<approvalId>'`，且 `expected*` 三个断言字段为空串）。⇒ **同一个 UI 面上，一类裁决被七个事实锚定，另一类仅被 approvalId 锚定**，而调用方无从区分（`reviewKey` 前缀是唯一线索，且 `apr:` 前缀在 `OwnerDecisionConsoleModel.ts:284` 硬编码）。
- **Evidence**：
  - `packages/pd-console/src/server/models/OwnerDecisionConsoleModel.ts:284-294`（`reviewKey: \`apr:${approval.approvalId}\``、`expectedRevisionEpoch: 0`、`expectedSourceRunId: ''`、`expectedSourceArtifactHash: ''`）
  - `packages/pd-console/src/server/models/OwnerDecisionConsoleModel.ts:218`（NHR 项用 `capability.reviewKey`，即真实哈希）
  - `packages/principles-core/src/runtime-v2/internalization/owner-review.ts:314-338`（`buildOwnerReviewKey` 七元组）
  - `packages/principles-core/src/runtime-v2/internalization/owner-resolution-service.ts:364-379`（stale 断言比对）
  - `packages/pd-console/src/server/routes/owner-decisions.ts:105-124`（解析层要求四个 `expected*` 均为 string，空串合法通过）
- **Why it matters**：`ActivationDispatcher` 的注释称其校验是 security boundary（`activation-dispatcher.ts:190-196`），这是正确的——但它防的是**跨 artifact/跨 channel 混淆**，不防**同一 artifactId 的内容变更**。guard 设计者若按「审批必带内容 hash」的假设来写 Exact Artifact Identity guard，会漏掉 `activation_approval` 这一类。
- **Affected stage**：跳 8 → 9；Owner Inbox 的信息架构
- **Current protection**：`apr:` / `odk_` / `rulecode:` 三种前缀是可辨识的命名约定（`OwnerDecisionConsoleModel.ts:284 / :321`），但无 schema 强制、无类型区分。


---

## 7. Protection Gaps

> 问题：现有 test / guard 是否保护 lineage 完整性？

### 7.1 已存在的保护（逐项亲验）

| 保护 | 位置 | 覆盖 | 判定 |
|---|---|---|---|
| `reconcileLineageEcho` + `<runner>_lineage_echo_corrected` 遥测 | `peer-runner-contracts.ts`；5 个 runner 各自注册 | taskId + 各 runner 的 `source*ArtifactId` + `sourceTrace.*` | **有效**，但**不含 scribe 的 `dreamerArtifactId`**（`scribe-runner.ts:415-416` 明言 left alone） |
| 对注入后校验（`succeedTask` 二次比对） | `philosopher-runner.ts:269-276`、`scribe-runner.ts:297-303` | 关键 `source*ArtifactId` | **有效**（fail loud `output_invalid`） |
| 应用层 FK 检查 | `sqlite-pi-artifact-store.ts:39-46`（tasks）、`sqlite-approval-store.ts:149-153`（pi_artifacts） | 防孤儿 artifact / approval | **有效** |
| 链完整性只读读模型（26 类 broken link） | `internalization-chain-integrity-read-model.ts` | `missing_dreamer_task`、`candidate_source_run_id_dangling`、`philosopher_missing_dreamer_artifact`、`lineage_mismatch`、`pi_artifact_duplicate`、`activation_artifact_id_dangling` 等 | **有效但有盲区**（见 7.2） |
| Mainline Contract（统一 CLI/CI/Console 判据） | `mainline-contract.ts:275-296` | `candidate_lineage`（`sourceTaskId/sourceArtifactId/sourceRunId` 非空 + 与诊断任务/工件交叉比对）、`dreamer_task_lineage` | **有效**，是唯一把「同一来源」原则（EP-07）写成可执行判据的地方 |
| `CandidateLineage` 血缘上溯 + PRI-717 rebind | `candidate-lineage.ts:200-456` | 陈旧实例 id 的单边 rebind、环检测、深度上限 | **有效**，fail-closed |
| Owner Decision reviewKey + 服务端 stale 断言 | `owner-review.ts:314-338`、`owner-resolution-service.ts:364-379` | NHR 路径的 artifactId + contentHash + epoch + runId | **最严格的一处**，但**只覆盖 NHR 入口** |
| `activation_decisions.artifact_digest` + `readiness` 比对 | `sqlite-connection.ts:502-540`、`promotion-readiness-reader.ts:35-37` | RuleCode promote 的内容绑定 | **有效**，只覆盖 promote |
| 不可变触发器 | `sqlite-connection.ts:537-540`（`activation_decisions_no_update/no_delete`）、`:558-560`（`activation_evidence_snapshots_no_update/no_delete`） | 决策与证据快照 append-only | **有效** |

### 7.2 缺口清单（按 F-ID 对应）

| Gap | 缺口 | 现有部分保护 | 后果 |
|---|---|---|---|
| G-01 | **无 artifact 侧 revision 权威**（F-10）。`pi_artifacts` 无 revision/version/parent 列；版本语义寄居在 `pi-art-<taskId>-run_<taskId>_<seq>` 的字符串形状里（`candidate-lineage.ts:124-141`） | `parseArtifactInstanceTaskId` 的形状校验（非法即 null → fail-closed） | 「同一逻辑 artifact 的第 N 版」无法在 artifact 平面断言；任何版本断言都依赖命名约定 |
| G-02 | **无 artifact 自身 content hash 列**（F-11）。`computeContentHash` 只用于 Layer-0 envelope 的 `predecessorSummary.contentHash`（staleness），且 `contentHashFn` 未注入时**静默降级**为 `predecessorSummary` 缺失 + `artifact_summary_predecessor_skipped` | `artifact_summary_predecessor_skipped` 事件 + `nextAction: 'Inject contentHashFn into PeerRunnerDeps'` | Peer runner 之间无内容级一致性校验；缺 `contentHashFn` 的运行时（测试/部分 CLI 装配）会静默失去该能力 |
| G-03 | **焦点模式抹掉全部 artifactId**（F-03）。manifest 声明的 tier0/tier1 全是 summary 值 | `manifest_resolution_insufficient` 只统计**声明路径**的缺失比例 | flag 开则跨级血缘**结构性**断裂；无专门事件、无测试覆盖 |
| G-04 | **`dreamerArtifactId` 缺口被测试固化为期望行为**（F-08 / R-01）。`artificer-runner-vslice.test.ts:1318-1341` 的 `expectedEvent: null` | 测试本身 | 补事件会与既有测试冲突；修复必须同时改契约与测试，这不是「加一行 emit」 |
| G-05 | **runtime receipt 无回链列**（F-04）。`principle_applications` 无 pain/candidate/artifact 列 | `digest` 列（语义为行为上下文摘要，非 artifact hash） | 链尾不可反查链头；审计追问必须走间接路径 |
| G-06 | **approval 路径内容绑定为空**（F-12 / F-13）。`activation_approval` 项的 `expectedSourceArtifactHash === ''` | dispatcher 的 artifactId/channel 相等校验；`apr:` 前缀可辨识 | 「同一 artifactId 内容被改写」不被发现；两套审批入口强度不对等 |
| G-07 | **候选级 route 未命中时静默跳过 seed**（F-07）。`if (route)` 无 else 分支 | `not_internalizable` / `seedErr` 分支有事件，route 缺失分支**没有** | candidate 被 consumed 但无下游、无记录 ⇒ 静默丢弃 |
| G-08 | **`revision-reopen` 的 `attemptCount: 0` 与 `runs.attempt_number` 双源**（R-23） | lease 时重新对齐（`lease-manager.ts:157-160`） | reopen→下次 lease 窗口内读模型可能报错 attempt 序号（不影响 artifactId 派生，本报告已证） |
| G-09 | **`sourcePrincipleId` 三类命名空间混用 + 标题回退**（F-09） | `stripFabricatedCorePrincipleIds` 只删编造的公理 ID | 按该列分组会得到互相不可比的键；`act_prompt_<title>` 形态的 activation id |

### 7.3 测试保护面（逐文件清点）

**有覆盖：**
- `peer-runner-lineage-injection.test.ts` — `reconcileLineageEcho` 的注入/覆盖语义
- `philosopher-runner-trust-boundary.test.ts:443-471` — `sourceDreamerArtifactId` 错误回显被纠正（`correctedFields` 断言）
- `candidate-lineage.pri717.test.ts` + `candidate-lineage.property.test.ts` — rebind 与上溯属性
- `chain-integrity-attack.test.ts` / `chain-integrity-real-path.test.ts` — 链完整性攻击面
- `internalization-chain-integrity-read-model.test.ts` — 26 类 broken link
- `artificer-runner-vslice.test.ts:1318-1400+` — `resolveDreamerContext` 的**全部**返回路径（含「无事件」期望）
- `activation/__tests__/approval-store-extended.test.ts`、`sqlite-approval-store.test.ts` — edit 血缘与 FK
- `governance-timestamp-schema.test.ts`（新，基线之后）— 治理时间戳

**未覆盖（本报告实测的缺口）：**
| 未覆盖点 | 依据 |
|---|---|
| `context_manifest_budget` **开启**时的跨级血缘（F-03） | `artificer-runner-vslice.test.ts` 全量用例均喂**完整** scribe contentJson；无 focused-mode 组合用例 |
| `content_json` 原地改写后既有 approved approval 的行为（F-12） | `approval-store-extended.test.ts` 只覆盖 edit（改指针），不覆盖 upsert（改内容） |
| `activation_approval` 项 `expectedSourceArtifactHash === ''` 的语义断言（F-13） | `pd-console/tests/ui/owner-decision-ui-contract.test.ts` 覆盖 UI 契约，未见 hash 空值的语义断言 |
| `CANDIDATE_KIND_TO_ROUTE` 未命中时的可观测性（F-07） | 未见针对 route === undefined 的用例 |
| `saveContentHash` 在 `contentHashFn` 缺失时的降级（G-02） | 无「未注入 hashFn」的生产装配断言（测试均注入） |
| `pain-signal-bridge` re-entry 的 `inputRef` 缺失回退（F-05） | 未见 `inputRef` 为空的建 task 用例 |

---

## 8. Suggested Contract Invariants

> 按任务书要求：**只写 invariant，不写方案。** 每条给出「不变量陈述 / 违反时的可观测证据要求 / 现状」。

**INV-LIN-01 — 稳定身份与运行实例身份必须可区分。**
对任一逻辑 artifact 节点，「逻辑身份」（跨 re-run 稳定）与「实例身份」（每次 run 唯一）必须是两个**各自有权威定义**的标识；任何下游引用必须显式声明它绑定的是哪一个。
*违反时可观测性要求*：存在「旧实例 id 不再可解析」的持久化边，且该情形必须产生带 `artifactId` + `taskId` + `resolution` 的结构化事件。
*现状*：逻辑身份 = `(source_task_id, artifact_kind)`（唯一索引），实例身份 = `pi-art-<taskId>-<runId>`；两者关系**只由命名约定**承载（G-01）。PRI-717 的 rebind 部分满足可观测性要求。

**INV-LIN-02 — 任何跨级血缘字段必须由 runner 拥有并由 runner 权威回填。**
不允许「LLM 从上游产物文本里自行改名映射」作为跨级血缘的唯一承载手段。
*违反时可观测性要求*：当跨级字段缺失或与权威值不符，必须产生结构化事件（缺失与错误分别可辨）。
*现状*：`sourceDreamerArtifactId`（philosopher 层）由 runner 权威回填 + 校验；`dreamerArtifactId`（scribe 层，跨级到 artificer）**不满足**（G-04）。

**INV-LIN-03 — 审批绑定必须包含足够的版本断言，且断言强度在同类入口间一致。**
同一审批类型的所有入口必须绑定同一组事实维度；「绑定内容版本」与「绑定身份」不得混用为同一维度。
*违反时可观测性要求*：断言为空/被跳过时必须显式暴露为「弱绑定」状态，而非与「强绑定」在同一视图内不可区分。
*现状*：NHR 入口满足（七元组），`activation_approval` 入口**不满足**（G-06）。

**INV-LIN-04 — 修订不得静默使既有审批失去对象。**
当 artifact 或候选的实例身份发生变化时，绑定到旧实例的审批必须处于「可判定的」状态：要么仍有效（因为它绑定的是逻辑身份），要么被显式失效。
*违反时可观测性要求*：任一「绑定对象的实例 id 已不存在」的审批，必须可由一个确定性查询列出。
*现状*：edit 方向满足（`previous_artifact_id` 归档 + 仅 pending 可 edit）；upsert 方向**不满足**（G-06）。

**INV-LIN-05 — 契约载荷（prompt/manifest 注入）不得成为血缘字段的传输通道。**
任何会改变 prompt 载荷组成的开关，不得改变下游可解析到的血缘字段集合；若确实改变，必须使该变化可观测并与该开关关联。
*违反时可观测性要求*：焦点/收窄模式下被丢弃的血缘字段必须是可列举的（而非仅统计已声明路径的缺失比例）。
*现状*：**不满足**（G-03）。

**INV-LIN-06 — 链尾身份必须能反查到链头（或显式声明不可反查）。**
runtime receipt 若能反查到 pain/candidate，必须是直接可判定的路径；若设计上不支持，必须作为显式能力边界声明，而非依赖间接路径。
*违反时可观测性要求*：读模型必须能报告「该 receipt 的记录粒度决定了它不可反查」。
*现状*：**不满足**（G-05）。

**INV-LIN-07 — 同一语义字段只能承载一个命名空间。**
一个持久化列或字段不得在不同写入者处以不同命名空间语义被复用；若必须复用，必须有字段级命名空间判别符。
*违反时可观测性要求*：按该字段分组的读模型必须能报告「本组内混入了哪些命名空间」。
*现状*：`sourcePrincipleId` **不满足**（G-09）。

**INV-LIN-08 — 静默丢弃（无事件、无 reason、无计数）在血缘链上必须是零。**
血缘链上任一「本应产生下游对象/边却未产生」的分支，必须至少有结构化 reason 与 nextAction。
*违反时可观测性要求*：所有此类分支必须出现在同一个可枚举的事件命名空间内。
*现状*：**部分不满足** —— `artificer-runner.ts:276/279-281`（G-04）、`pain-signal-bridge.ts:771` 的 `if (route)`（G-07）、`pain-signal-bridge.ts:589/599` 的 inputRef 回退（F-05）三处均无事件。

---

## 9. Out of Scope

明确**不在**本次审计范围内的事项（含任务书指定与自查确认）：

1. **一切代码修改**：本任务只读。未改 `packages/**`、未改 config、未建 subsystem、未修任何 bug、未碰 Linear、未改 `.cnb/**`、未动 `docs/adr/**` 与 `docs/product/**`。
2. **修复方案设计**：§8 只写 invariant，不含实现方案（章程 D9：设计决策交 Owner）。
3. **不判定以下发现**（属其他 Worker 的管辖面，本报告仅标注它们与血缘链的交叉点）：
   - R-19 RuleCode 沙箱信任边界（安全面，静态禁门绕过）——与本链交叉于「rule artifact 内容进入 vm 前的可信度」；本报告在 F-11 中记录了「rule artifact 无内容 hash 列」这一**血缘侧**事实，但**不评估沙箱本身**。
   - R-20 Console 停用按钮授权不对称——与跳 9 的 activation 面相关，归 Worker D。
   - R-21 correctionObserver 结构性失明——本链的 observer 侧，不涉及 artifact identity。
   - R-22 Codex 侧 `rulehost_evaluated` 事件通道缺失——归 Worker D/E。
   - R-23 深入调查（`attempt_count` / `attempt_number` 双源的完整影响面）——按任务书要求**仅标记**，归 Worker D。
   - R-25 入口清单与 flag 表遗漏——归 Worker A。
4. **live 运行时核对**：本 checkout 无 `.pd/state.db` 运行时数据，所有判定均基于静态证据（生产代码 / DDL / 生产测试）。F-12 的最终定级**明确依赖 runtime 时序数据**。
5. **LLM 实测提示词遵循度**：未对任何 agent 做真实模型调用；所有「LLM 是否真的会改名映射」的推断均标注为推断（F-08 的核心不确定点）。
6. **`docs/audit/agent-pipeline-audit-2026-09-15/**`** 全部文件：作为历史事实种子读取（`git show cdec05d4b:<path>`），**未修改、未搬运**；其报告行号锚定的 `70d824c4` 基线不属本报告责任范围。
7. **私有文档**：本任务未涉及治理/产品情感价值面，未访问 `$PD_PRIVATE_DOCS_DIR`。
8. **漂移窗口内的 51 个提交**：仅评估其对本链的影响（§2.2），不评估其内容正确性。

---

## 附录 A — 全链一行汇总（任务书 §4.3 格式）

```text
Pain ID
  → stored as  PainIngressReport.identity.painId
  → consumed as PainDetectedData.painId
  → transformed to tasks.input_ref + diagnosticJson.sourcePainId + taskId 前缀
  → SILENT DROP POSSIBLE? NO（F-05 的 inputRef 回退为 P3 命名漂移，非丢失）

session ID
  → stored as  PainIngressReport.correlation.sessionId → pain_events.session_id
  → consumed as  principle_applications.session_id（presence 去重键）
  → transformed to 判据「principle_id + session_id」局部唯一索引
  → SILENT DROP POSSIBLE? NO

diagnosis task / artifact
  → stored as  tasks.task_id = diagnosis_<painId>；artifacts.artifact_id = randomUUID()
  → consumed as  pain-chain-read-model 重建 taskId；candidate.artifactId
  → transformed to  commits(run_id UNIQUE, idempotency_key UNIQUE)
  → SILENT DROP POSSIBLE? NO

candidate ID
  → stored as  principle_candidates.candidate_id = randomUUID()（idempotency_key = <commitId>:<i>）
  → consumed as  buildDreamerSeedFromCandidate → dreamer taskId = dreamer-<candidateId>-<channel>
  → transformed to  diagnosticJson.candidateId / correlationId
  → SILENT DROP POSSIBLE? NO（但 F-06：不跨重放稳定；F-07：route 未命中静默跳过，P2）

dreamer artifact
  → stored as  pi_art-<taskId>-<runId>（artifactKind='principle'；upsert 键 = (source_task_id, artifact_kind)）
  → consumed as  philosopher.buildContext → listBySourceTaskId(depId)[0].artifactId
  → transformed to  philosopher.sourceDreamerArtifactId（runner 权威回填 + 校验）
  → SILENT DROP POSSIBLE? NO（reconcileLineageEcho 覆盖错误回显）

philosopher artifact
  → stored as  pi-art-<taskId>-<runId>
  → consumed as  scribe.sourcePhilosopherArtifactId（权威校验 + echo reconciliation）
  → transformed to  scribe 需自行从工件文本提取 dreamer id 并改名为 sourceTrace.dreamerArtifactId
  → SILENT DROP POSSIBLE? **YES**（F-08：optional，无权威值，reconcileLineageEcho 明确不处理）

scribe artifact
  → stored as  pi-art-<taskId>-<runId>
  → consumed as  artificer.sourceScribeArtifactId（权威）+ artificer 从 contentJson.sourceTrace.dreamerArtifactId 解析 dreamerContext
  → transformed to  ArtificerDreamerContext（5-dim）
  → SILENT DROP POSSIBLE? **YES**（R-01/F-08：缺失时 resolveDreamerContext 无事件返回 undefined；测试固化为期望行为）
  → SILENT DROP POSSIBLE? **YES**（F-03：manifest 焦点模式下 scribe 收到的 philosopher 工件不含任何 artifactId ⇒ 结构性必断）

artificer artifact
  → stored as  pi-art-<taskId>-<runId>
  → consumed as  evaluator.sourceArtificerArtifactId；resolvePrincipleBearerArtifact
  → transformed to  ruleContent.sourceArtificerArtifactId + rule artifact 的 sourcePrincipleId
  → SILENT DROP POSSIBLE? NO（rule 分支解析失败时 fail loud：rule_assembly_failed + sourcePrincipleId_unresolved）

evaluator artifact
  → stored as  pi-art-<taskId>-<runId>（principle）与 pi-rule-<taskId>-<runId>（rule）
  → consumed as  rollout.buildContext（按 reviewMode 选 sourceEvaluatorArtifactId 或 sourceScribeArtifactId）
  → transformed to  rollout 的权威 source id + echo reconciliation
  → SILENT DROP POSSIBLE? NO（但 F-02：replay 后 rebind 可能 fail-closed 为 ancestor_pruned）

rollout artifact
  → stored as  pi-art-<taskId>-<runId>
  → consumed as  activation dispatch 的 artifactId（由 pipeline/CLI 传入）
  → transformed to  approvals.artifact_id
  → SILENT DROP POSSIBLE? NO

approval ID
  → stored as  apr_<channel>_<artifactId>（INSERT OR IGNORE；应用层 FK 检查先抛）
  → consumed as  dispatcher 的四重校验（id 存在 / status=approved / artifactId 相等 / channel 相等）
  → transformed to  activation 的 idempotency_key = <artifactId>::<channel>
  → SILENT DROP POSSIBLE? NO（但 F-12/F-13：**内容绑定为空**，artifactId 不变即通过）

activation ID
  → stored as  activations.activation_id（writer 自定义）+ idempotency_key UNIQUE
  → consumed as  RuleHost / PromptActivationReader / principle_applications.activation_id
  → transformed to  WriterInput.principleId = extractPrincipleId(artifact)（四级回退，末级为标题）
  → SILENT DROP POSSIBLE? NO（但 F-09：principleId 命名空间可能退化为标题）

runtime receipt / event
  → stored as  principle_applications(principle_id, activation_id, rule_id, channel, level, kind, session_id, tool_name, file_path, digest, created_at)
  → consumed as  loadPrincipleReceiptMetadata(workspaceDir, ruleId, principleId) / ReceiptsConsoleModel
  → transformed to  PrincipleReceiptMetadata { title, approvedAt, sourceSummary }
  → SILENT DROP POSSIBLE? **YES**（F-04：表内无 pain/candidate/artifact 列，回链只能经 pi_artifacts.source_principle_id 间接跳转）
```

---

## 附录 B — 判定与证据索引

| 判定 | 条目 | checkout SHA |
|---|---|---|
| CONFIRMED | R-01、R-24、R-23、`releasePrincipleId` 三级回退链存在 | `191ae1af588a68950af1de5a3b9265771a7b3e8d` |
| FIXED | edit → 旧 approval 悬空（`previous_artifact_id` + 仅 pending + `isArtifactRevisionOf`） | 同上 |
| PARTIAL | `sourcePrincipleId` 公理 ID 命名空间错位（P3，非悬空外键） | 同上 |
| DRIFTED | 任务书基线 `cdec05d4b` 不在 checkout（CNB 镜像落后 GitHub 51 提交） | 见 §2 |
| UNVERIFIABLE | F-12 的最终定级（需 runtime `activations` ⨝ `approvals` ⨝ `pi_artifacts` 时序） | 同上 |
| NEW | F-01 … F-13（共 13 条：P2 10 条 —— F-01/02/03/04/07/08/10/11/12/13；P3 3 条 —— F-05/06/09；F-12 已附反证下调为 P2，未产生 P1） | 同上 |

**审计结论（一句话）：** 从 Pain 到 runtime receipt，**runner 之间**的血缘（taskId / source*ArtifactId / echo reconciliation）机制完备且 fail-loud；**真正的静默丢失集中在三处** —— ① scribe↔artificer 的跨级 `dreamerArtifactId`（命名不对称 + 缺失无事件 + 被测试固化），② 其结构性放大面 `context_manifest_budget` 焦点模式抹掉全部 artifactId，③ 链尾 runtime receipt 无回链列。**未经批准内容被激活**的路径在 approve→activate 主链上由 dispatcher 的四重身份校验阻断，但**内容级绑定缺失**（approval hash 为空、artifact 无 hash 列）使「同一 artifactId 内容变更」不被发现。
