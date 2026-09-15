# PRI-807 Phase 0 — Worker C：Lineage / Artifact Identity 全链审计报告

- 类型：只读审计（未修改任何既有文件；本文件为唯一新增）
- 审计员：PD Developer（CNB NPC，`ai/cnb-dev/issue-49`）
- 审计对象：`cdec05d4bc4252151c7f9f118bdad90f25067594`
- 历史事实种子：`docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md` §4/§5/§6 与 `VERIFICATION-B/C.md`（作为候选清单，最终判定一律回源 current main）

---

## 1. Scope

回答一个问题：**从 Pain 到 runtime receipt，稳定身份链有没有任何一跳会静默丢失、换名、覆盖、重生？**

覆盖范围（逐跳 producer + consumer 双向核对）：

- 入口与诊断：pain id → diagnostician task id → candidate id
- 内化链：dreamer → philosopher → scribe → artificer → evaluator → `pi-rule-*` → rollout_reviewer
- 治理下游：approval id → activation id → runtime receipt（`principle_applications` / `gate_blocks` / events JSONL）

对每一跳核对任务书 §4.2 的十项：字段名精确拼写（两端）、optional/required 一致性、runner echo reconciliation、persisted column、upsert key 语义、artifact revision 编号方式、content hash 有无与谁校验、approval binding、activation binding、runtime receipt 回链。

不在范围内：修复任何代码、改 config、动 Linear、评估 LLM 提示词遵循度（无实测数据）、`packages/**` 的任何改动。

---

## 2. Baseline

```
git rev-parse HEAD = cdec05d4bc4252151c7f9f118bdad90f25067594
```

**BASELINE: SYNCED** —— 与任务书指定基线完全一致，无 Drift Warning。

补充事实（供复核）：

- 检出分支为 `audit/pri-807-phase0-base`（本地与 `origin` 同 SHA），工作区在开工时干净。
- 任务书提到的历史种子文件存在且已读取：`docs/audit/agent-pipeline-audit-2026-09-15/{REPORT.md,VERIFICATION-A..D.md}`。
- 该历史审计自身基线为 `70d824c4`（REPORT 声明）/ `94e4ef5b`（VERIFICATION-C 检出点），均**早于**本基线；历史条目凡在 51-commits 窗口中改动的，本报告一律以抽查源文件重新判定，不继承历史结论。
- 本报告所有行号均为 `cdec05d4b` 实测行号。

---

## 3. Current Authorities（哪些 ID/键已有唯一权威定义）

这一段只登记**已有单一权威**的事实。凡同一逻辑身份存在两个独立生成点、或键与身份不等价的，登记为 §6 的发现，不在此处美化。

| 身份 | 权威定义 | 权威位置 |
|---|---|---|
| 内容派生 canonical pain id | `sha256(resolve(workspaceDir) \| sessionId \| occurrenceId \| source='user_correction' \| text)`，前缀 `pain_host_` | `packages/host-runtime/src/production-pain-evidence.ts:229-245`（唯一实现；OpenClaw 与 Codex 共用） |
| pain id 持久化唯一性 | `pain_events.canonical_pain_id` partial unique index；重复投递走同 id 冲突路径 | `packages/openclaw-plugin/src/core/trajectory.ts:741`（insert）+ `:759-776`（UNIQUE 冲突 → UPDATE）；`production-pain-evidence.ts:249-251, 259-292` 做 schema 就绪自检 |
| diagnostician task id | `diagnosis_<painId>`（纯函数） | `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts:186-188` |
| pain→task 上的 pain 事实 | `tasks.input_ref` = painId；`diagnosticJson.sourcePainId` = painId | `pain-signal-bridge.ts:322`（builder）、`:419-430`（写入）、`:599`（读取回退） |
| candidate id | `crypto.randomUUID()`，落库主键 `principle_candidates.candidate_id` | `packages/principles-core/src/runtime-v2/store/commit/diagnostician-committer.ts:179`；DDL `store/sqlite-connection.ts:350-371` |
| candidate → dreamer task id | `dreamer-<candidateId>-<channel>`，且 cross-channel 去重有显式枚举 | `internalization/intake-to-internalization-bridge.ts:14-16`（枚举全部 channel 后缀）、`:180`（构造） |
| artifact instance id 约定 | `pi-art-<taskId>-<runId>`（principle 族）/ `pi-rule-<taskId>-<runId>`（rule 族） | `dreamer-runner.ts:299`、`philosopher-runner.ts:311`、`scribe-runner.ts:339`、`artificer-runner.ts:1037`、`evaluator-runner.ts:982`、`evaluator-runner.ts:3261` |
| run id | `run_<taskId>_<attemptNumber>`（attempt 由 `runs` 现有最大号 +1 决定） | `packages/principles-core/src/runtime-v2/store/lifecycle/lease-manager.ts:150-166` |
| approval id | `apr_<channel>_<artifactId>`（纯函数） | `activation/sqlite-approval-store.ts:138-140` |
| activation idempotency key | `` `${artifactId}::${channel}` ``，唯一索引 `idx_activations_idempotency` | `activation/activation-types.ts:268-270`；DDL `store/sqlite-connection.ts:450` |
| activations 与 artifact 的绑定校验 | dispatcher 独立复核 `approvalRecord.artifactId === input.artifactId`（rc-6） | `activation/activation-dispatcher.ts:244-258` |
| activation control state | `activation_control_states.activation_id` PRIMARY KEY | DDL `store/sqlite-connection.ts:545-551` |
| RuleCode 安全决策 | `activation_decisions` append-only（DDL 级 no-update/no-delete trigger） | DDL `store/sqlite-connection.ts:541-544`；写入 `activation/sqlite-activation-safety-store.ts:319-417` |
| 晋升 artifact 摘要 | `sha256(JSON.stringify(artifactSnapshot))` | `activation/promotion-evidence-snapshot.ts:27-29` |
| Owner 决策 stale 防护 | `reviewKey` = hash(taskId, epoch, sourceRunId, sourceArtifactId, sourceArtifactHash, machineDecision, humanReviewReason) | `internalization/owner-review.ts:331-343`；比对 `owner-resolution-service.ts:368-380` |
| Owner 可见的「已批准」时间 | derived join `approvals.artifact_id = pi_artifacts.artifact_id AND status='approved'` | `packages/openclaw-plugin/src/core/principle-receipt-metadata.ts:174-181` |
| lineage 遍历 | `lineageArtifactIds` + 两跳 `sourceTaskId → task.taskKind`（明确不用 `artifactKind`，因其语义过载） | `internalization/candidate-lineage.ts:12-24, 325-341` |
| 陈旧 instance id 重绑 | PRI-717 rebind + `lineage_edge_rebound` 事件 | `candidate-lineage.ts:392-422` |

**一句话结论**：内化链**主路径**各跳都有 runner-owned 的 echo 校正（`reconcileLineageEcho`，`peer-runner-contracts.ts:397-442`），artifact instance id 由 (taskId, runId) 确定性派生，activation 与 artifact 的绑定在 dispatcher 侧被独立复核。真正的问题不在「主路径没有身份证」，而在 **§6 列出的四种身份等价性破坏**。

---

## 4. Contract Map

格式：`ID_A → stored as X → consumed as Y → transformed to Z → SILENT DROP POSSIBLE? YES / NO`

### 4.1 入口与诊断

| # | 跳 | 链 | 判定 |
|---|---|---|---|
| C-01 | STRONG 纠正 → canonical pain | pain text → `deriveProductionCorrectionPainIdentity` → `pain_host_<sha256>` → stored as `pain_events.canonical_pain_id` → consumed as `input.painId` → transformed to `diagnosis_<painId>` | **NO**（身份内容派生且唯一索引兜底；但见 C-05：traceId 已降级为 correlation，`painId` 是该跳唯一权威） |
| C-02 | 手动 pain / gate-block pain → canonical pain | `pain_<Date.now()>_<hash8>`（`hooks/pain.ts:298-300`）或 `gate_<Date.now()>_<rand8>`（`hooks/gate-block-helper.ts:204`）→ stored as `canonical_pain_id` → consumed as painId | **YES（P2，见 §6 F-05）**：时间戳 + 8 字符随机/哈希，**无内容派生**，同一逻辑事件重放会铸造新 pain id；不是「丢失」而是「重生」 |
| C-03 | pain → diagnostician task | painId → `createDiagnosticianTaskId` → `diagnosis_<painId>` → stored as `tasks.task_id` + `tasks.input_ref=painId` → consumed as `inputRef`（`pain-signal-bridge.ts:599`） | **NO**（`inputRef` 缺失时回退为 taskId，`pain-signal-bridge.ts:589`：降级但非静默——回退值就是 task id，可反查） |
| C-04 | diagnostician task → painId（读侧） | `tasks.input_ref` → consumed by `pain-chain-read-model.ts:95`（**只由 painId 反推 taskId，不读 inputRef**）与 `mainline-snapshot-assembler`（`task.diagnosticJson.sourcePainId`） | **PARTIAL（P3）**：两条读路径取 painId 的来源不同（inputRef vs diagnosticJson.sourcePainId），二者由同一 builder 写入（`buildDiagnosticJson`，`pain-signal-bridge.ts:319-337`），当前一致但无交叉校验 |
| C-05 | pain → diagnosis row | painId → `pain_diagnoses.pain_id` + `task_id` + `artifact_id`（`candidate[0].artifactId`） | **PARTIAL（P3）**：`artifactId` 取 `candidates[0]?.artifactId ?? null`（`pain-signal-bridge.ts:729-731`），多候选时只记第一个；`artifact_id` 为 nullable，无回链校验 |
| C-06 | diagnosis → candidate | `artifact_id`(randomUUID) → `diagnostician-committer` 事务内插 `artifacts` + `commits` + N×`principle_candidates`（candidateId 各自 randomUUID） | **NO**（同一事务原子；`principle_candidates.candidate_id` 主键；`commits.run_id` UNIQUE 幂等） |
| C-07 | candidate → dreamer task | candidateId → `dreamer-<candidateId>-<channel>` → stored as `tasks.task_id`；`diagnosticJson.candidateId` 同值 | **NO**（`internalization-committer` 有 `invalid_candidate` 前置门：lineage 三字段全空即拒绝，`intake-to-internalization-bridge.ts:295-310`） |

### 4.2 内化链

| # | 跳 | 链 | 判定 |
|---|---|---|---|
| C-08 | dreamer output → dreamer artifact | `taskId` echo → `reconcileLineageEcho` 覆盖为权威 taskId（`dreamer-runner.ts:374-386`）→ stored as `pi-art-<taskId>-<runId>`（artifactKind `principle`）→ `lineageArtifactIds` = 依赖任务全部 artifact ids（`base-peer-runner.ts:547-571`） | **NO** |
| C-09 | dreamer artifact → philosopher | `sourceDreamerArtifactId`（`philosopher-output.ts:24,42`）← buildContext 权威值（`philosopher-runner.ts:194`）；echo 校正（`:382-397`）+ succeedTask 强校验不等即 `output_invalid`（`:269-275`） | **NO**（两端字段名一致、required、有校验） |
| C-10 | philosopher artifact → scribe | `sourcePhilosopherArtifactId` ← 权威值（`scribe-runner.ts:192`）；echo 校正含顶层与 trace 两处（`:409-425`）；validator 比对（`scribe-output.ts:113-116, 139-143`） | **NO** |
| C-11 | **philosopher → scribe 的 dreamer 血缘** | philosopher 产物字段 `sourceDreamerArtifactId` → scribe prompt 指示去 philosopher 产物里找 **`dreamerArtifactId`**（`scribe-prompt-builder.ts:78,106`）→ 由 LLM 自行改名 → stored as `scribe.sourceTrace.dreamerArtifactId`（**optional**，`scribe-output.ts:26,58`）→ consumed by `resolveDreamerContext`（`artificer-runner.ts:279`） | **YES（R-01 CONFIRMED，P2）**。三段证据：<br>① 字段名断链：生产者叫 `sourceDreamerArtifactId`，消费者 prompt 让找 `dreamerArtifactId`，两端不同名且无机器映射；<br>② 无权威回填：scribe 的 `reconcileLineageEcho` 只保护 `taskId` / `sourcePhilosopherArtifactId` / `sourceTrace.philosopherArtifactId`，注释明言 dreamerArtifactId「没有权威值，不处理」（`scribe-runner.ts:411-415`）；<br>③ 缺省静默：`artificer-runner.ts:271, 276, 280` 三处提前 `return undefined` **不发任何事件**（对照其后失败分支均有 `dreamer_context_skipped/missing/invalid`，`:268/284/292`）。<br>**净效果：LLM 一次改名失败 → dreamer 五维上下文对 artificer 静默消失，且该静默与「本来就该没有」不可区分。** |
| C-12 | scribe artifact → artificer | `sourceScribeArtifactId` ← 权威值（`artificer-runner.ts:157`）；echo 校正 + trace（`:1108-1126`）；validator 比对（`artificer-output.ts:241-245`）；另交叉校验 `sourceScribeArtifactId === sourceTrace.scribeArtifactId`（`artificer-output.ts:371-377`） | **NO**（本链最完备的一跳：顶层 + trace 双写且互相一致性校验） |
| C-13 | artificer artifact → evaluator | `sourceArtificerArtifactId` ← 权威值（`evaluator-runner.ts:549`）；echo 校正 + trace（`:2434-2454`）；validator 比对（`evaluator-output.ts:448-452`）；另交叉校验 trace（`:545-549`） | **NO** |
| C-14 | evaluator → `pi-rule-*` | `ruleArtifactId = pi-rule-<taskId>-<runId>`（`evaluator-runner.ts:3261`）；`sourcePrincipleId` 由 `resolvePrincipleBearerArtifact` 解析（`:3332-3400`），未解析则 `rule_assembly_failed/sourcePrincipleId_unresolved` 且不写库（`:3233`） | **PARTIAL（P2，见 §6 F-02）**：id 派生确定、write 前有 fail-loud；但 `sourcePrincipleId` 的**取值空间**不可靠（见 §6 F-02） |
| C-15 | `pi-rule-*` revision 覆盖 | 同一 task+run 重入 → `upsertArtifact` 命中 `UNIQUE(source_task_id, artifact_kind)` → `DO UPDATE SET artifact_id = excluded.artifact_id`（`store/artifact/sqlite-pi-artifact-store.ts:81-88`）→ **旧行被替换为新行**，旧 artifact_id 消失 | **YES（R-24 CONFIRMED，P2）**。同一逻辑工件的历史版本无留档：内容与 artifact_id 一起被覆盖。属于**设计内**的幂等语义（`pi-artifact-store.test.ts:260-288` 明确断言 `art-v1` 变 null、`art-v2` 生效），但任何在覆盖前捕获 id 的下游（activation / approval / receipt）都会指向一个已不存在的 id。见 §5 R-24 与 §6 F-01/F-04。 |
| C-16 | evaluator → rollout_reviewer | 由 `buildContext` 解析依赖（code_chain: evaluator artifact；principle_semantic: scribe artifact），`sourceEvaluatorArtifactId` / `sourceScribeArtifactId` 之一（`rollout-reviewer-runner.ts:353-354`）；echo 校正按 mode 选字段（`:394-395`）；validator 按 mode 校验顶层 + trace（`rollout-reviewer-output.ts:137-190`） | **NO**（mode 分派明确，两 mode 各自校验） |
| C-17 | rollout → activation candidate | rollout 沿 dep 链收集候选，`matches.length === 1` 才接受（`rollout-reviewer-runner.ts:760-800`）；0 或多个 → `needs_human_review` **不猜第一个** | **NO**（本报告实测：这一跳的歧义处理比历史报告描述的更严——已是 fail-closed） |

### 4.3 治理下游与回链

| # | 跳 | 链 | 判定 |
|---|---|---|---|
| C-18 | candidate artifact → approval | `artifactId`(当前值) → `makeApprovalId(artifactId, channel)` → `apr_<channel>_<artifactId>` → `INSERT OR IGNORE INTO approvals` | **PARTIAL（P3）**：id 确定；`INSERT OR IGNORE` 使同 artifact+channel 的二次入队命中旧行——旧行若为 `rejected`，`approve` 只在 `pending` 放行，同工件**无法再入队**（历史 §6 F-E4 已登记；本报告确认 DDL 与代码未变） |
| C-19 | approval → activation（人工路径） | `record.artifactId`（dispatch 时重读，`approval-completion-service.ts:124,156`）→ dispatcher 用 `input.approvalId` 独立复核 `status/artifactId/channel` 三元（`activation-dispatcher.ts:234-258`） | **NO（binding 本身强）**；但见 C-22：**approval 里没有 revision/digest 列**，只能绑 id，而 id 会被 C-15 覆盖 |
| C-20 | activation → artifact | `recordActivation` 先做 FK 存在性校验（`sqlite-activation-state-store.ts:77-82`），落 `activations.artifact_id`；`INSERT OR REPLACE` 按 `idempotency_key` 覆盖（`:83-93`）→ 读侧 JOIN `pi_artifacts`（gate/reader 同形） | **PARTIAL（P2）**：写时 FK 校验存在；读时 `activation_artifact_id_dangling` 检测存在（`internalization-chain-integrity-read-model.ts:523-540`）但**仅只读报告，不自动修复、不在激活时重校验**。artifact 被 C-15 覆盖后，激活行指向失效 id |
| C-21 | activation → runtime receipt | `act_code_<ruleId>` / `act_prompt_<principleId>` → `principle_applications.activation_id`（**nullable，且 6 个写入点中 5 个不传、无读取者**——见 §6 F-03） | **PARTIAL（P2，见 F-03）**：receipt 侧真正落库的是 `principle_id`（+ 可选 `rule_id`）；`activation_id` 在 6 个写入点中 5 个恒 NULL（唯一例外是 presence 路径），且**无任何读取者**；`gate_blocks` 表**连 rule/principle 列都没有**（DDL `packages/openclaw-plugin/src/core/trajectory.ts:253-260`），只存 session/tool/path/reason |
| C-22 | approval / activation 的 revision identity | approval 行 = `(approval_id, artifact_id, channel, ...)`，**无 revision 列、无 content hash 列**（DDL `store/sqlite-connection.ts:395-410` + 两次 `ADD COLUMN` 迁移 `:414-434`）；edit 只改 `artifact_id` 指针并保留 `previous_artifact_id`（`sqlite-approval-store.ts:267-283`） | **YES（P2，见 §6 F-04）**：审批绑的是 **artifact id**，不是「id + 内容版本」。判定「edit 后旧 approval 是否继续生效」需要看代码，证据见下。 |
| C-23 | rollout 自动路径 → activation | `dispatchRolloutActivation` 传 `rolloutDecision: 'auto_activate'`（`internalization-consumer-governance.ts:125-133`）→ dispatcher 走「低风险直激活 / 高风险入队」分支；高风险入队时**不经过 approvals 的 approve** | **NO**（低风险 channel 直激活是有意设计，`activation-types.ts:8`；authority 在 UI 侧标注 `system_policy`，`prompt-activation-reader-contract.ts:10-16`） |
| C-24 | activation → Owner 可见 receipts | receipt 读侧按 `principle_id = ?` 查询（`ReceiptsConsoleModel.ts:176-178`）；Console 侧 `principleId` 由 `extractPrincipleId(artifact)` 4 步回退得出（`ActivationsConsoleModel.ts:301`、`ApprovalsConsoleModel.ts:240`） | **PARTIAL（P2）**：回退第 4 步是 `contentJson.principleDraft.title`（**标题字符串当身份**），与 ledger 的 `derivedFromPainIds`/`candidateId` 命名空间不同，见 §6 F-02 |

### 4.4 §5 点名项的当前状态（裁决）

| 项 | 判定 | 证据 |
|---|---|---|
| R-01（P2）scribe→artificer 血缘命名断链 | **CONFIRMED** | 见 C-11；`philosopher-output.ts:24,42` vs `scribe-prompt-builder.ts:78,106`；`scribe-runner.ts:411-415`（明言不处理）；`artificer-runner.ts:271/276/280`（三处 `return undefined` 零事件） |
| R-24（P2）`pi_artifacts(source_task_id, artifact_kind)` 唯一索引 = 覆盖语义 | **CONFIRMED** | DDL `store/sqlite-connection.ts:393`；`ON CONFLICT ... DO UPDATE SET artifact_id = excluded.artifact_id`（`sqlite-pi-artifact-store.ts:81-88`）；全部 upsert 调用方共 12 处（`dreamer:302`、`philosopher:314`、`scribe:342`、`artificer:1040`、`evaluator:985/1086/1177/3265`、`rollout-reviewer:630`、`diag-rootcause:288`、`diag-distiller:270`、`diag-router:346`），全部走 `upsertArtifact`（无 `createArtifact` 生产调用，除 demo），即**全部继承覆盖语义**；测试明确断言覆盖（`pi-artifact-store.test.ts:122-152, 260-288`） |
| R-23（P2）`tasks.attempt_count` vs `runs.attempt_number` 双源 | **CONFIRMED（在本链上，标记即可）** | lease 让二者同源递增（`lease-manager.ts:150-166`：attemptNumber 由 runs 最大号 +1，随后 `UPDATE tasks SET attempt_count = ?`）；但 `revision-reopen.ts:111-115` 把 `tasks.attempt_count` 重置为 0 而 `runs.attempt_number` **不回退**。影响面：revision 后 artifact id 的 `runId` 段（`run_<taskId>_<n>`）继续从**旧**最大号递增，而 task 的 attemptCount 从 1 重新计；二者在产物命名上不直接冲突（artifact 用 runId），但任何按 task.attemptCount 推断 run 的读路径会错。深入调查归 Worker D |
| `sourcePrincipleId` 当前精确语义与消费方 | **登记（见 §6 F-02）** | 列 `pi_artifacts.source_principle_id`（nullable）。写入者：dreamer 写 LLM 输出的公理 ID（`dreamer-runner.ts:309`，经 `stripFabricatedCorePrincipleIds` 只放行 T-01..T-10，`strip-fabricated-ids.ts:19-28`）；evaluator 写从 scribe 产物解析出的 principle 标识（`evaluator-runner.ts:3269`）。消费者：`extractPrincipleId`（activations/Console）、`sqlite-activation-safety-store.ts:390,393` 的 supersede 查询、`principle-receipt-metadata.ts:174-181` 的 approved 时间 join。**两端命名空间不同（公理 ID vs principle 标识）** |
| `dreamerArtifactId` 当前精确语义与消费方 | **登记** | 仅存在于 `scribe.sourceTrace`（optional，`scribe-output.ts:26,58`）与 evaluator/rollout 的 trace（同为 optional 透传字段，`evaluator-output.ts:119`、`rollout-reviewer-output.ts:25`）。**唯一结构化消费者**是 `resolveDreamerContext`（`artificer-runner.ts:279`）。生产写入者：**无权威写入者**——只有 scribe 的 LLM 可填（`scribe-prompt-builder.ts:78`），无 runner 回填、无 validator 权威比对 |
| `sourceDreamerArtifactId` 当前精确语义与消费方 | **登记** | 仅存在于 philosopher 产物顶层（required，`philosopher-output.ts:24,42`）。消费者：philosopher 自身 succeedTask 校验（`:269-275`）、`reconcileLineageEcho`（`:391`）。**跨级消费者：无结构化消费者**——scribe 只能通过 LLM 读全文并按 `dreamerArtifactId` 改名写入（C-11 断链点） |
| reviewed / approved / activated 三个时点的 exact identity | **见 §6 F-04** | reviewed 时点：evaluator/rollout 的 `humanReviewContext.sourceArtifactId + sourceArtifactHash`（内容级绑定，`pitask-metadata.ts:124-143`）；approved：`approvals.artifact_id`（**id 级，无 hash，无 revision**）；activated：`activations.artifact_id`（id 级）+ 可选 `activation_decisions.artifact_digest`（仅 RuleCode promote 路径）。**三时点绑定粒度不一致** |
| **edit 之后旧 approval 是否可能继续生效** | **FIXED（就「旧 approval 保持生效」这一点而言，代码有明确防护）** | 见下 |

#### 「edit 后旧 approval 是否继续生效」的代码证据

结论：**旧 artifact 的 approval 不会因 edit 而失效——edit 本身就是「把 pending approval 从旧 artifact 改指到新 artifact」的机制，且被显式设计成这样。**

证据链：

1. `edit` 只在 `status='pending'` 时可用，且是单条原子 UPDATE，把 `artifact_id` 换成 `newArtifactId`、把旧值存进 `previous_artifact_id`（`sqlite-approval-store.ts:271-278`）。`approval_id` **不变**。
2. 应用层入口做三道校验（Console：`ApprovalsConsoleModel.ts:283-345`；CLI：`runtime-activation.ts:1063-1145`）：新 artifact 必须存在、必须 `validationStatus === 'validated'`、必须 `isArtifactRevisionOf(newArtifact, originalArtifact)`。
3. `isArtifactRevisionOf`（`activation-types.ts:262-267`）判定为 `candidate.sourceTaskId === original.sourceTaskId || candidate.lineageArtifactIds.includes(original.artifactId) || (candidate.sourcePrincipleId 非空 && 相等)`——**三条件取或**，其中第一条「同一 source task」等价于「同一 `UNIQUE(source_task_id, artifact_kind)` 行族」，而该行族在 C-15 覆盖语义下**只有一个现存成员**。
4. 于是：approve 时 dispatch 用 `record.artifactId`（**edit 后的新值**，`approval-completion-service.ts:124, 156`）；dispatcher 再用 `approvalRecord.artifactId === input.artifactId` 复核（`activation-dispatcher.ts:244-250`）。二者天然相等，所以**edit 后 approve 一定激活新 artifact，不会激活旧的**。
5. 反向情形——**先 approve 再发生 artifact 覆盖**：approve → `activateArtifact` → `recordActivation` 做 FK 存在性校验（`sqlite-activation-state-store.ts:77-82`）。若此时 artifact 已被覆盖（C-15），激活行写入的是**覆盖前的 id**，而该 id 已不存在 → 产生 `activation_artifact_id_dangling`（只在 integrity 只读报告里出现，`internalization-chain-integrity-read-model.ts:523-540`）。**这一路径没有 inline 失效机制**：旧 approval 行继续 `status='approved'`、`approval_id` 继续存在于表中，指向一个不存在的 artifact。因此：

> **判定：FIXED for「edit 使旧 approval 继续激活旧 artifact」；NEW for「artifact 被 upsert 覆盖后，既有 approved approval / activation 行不被失效」——登记为 §6 F-04（P2）。** 后者的可观测证据是 Console 侧会渲染 `principleId: 'unlinked'`（`ActivationsConsoleModel.ts:386`）与 integrity 报告里的 dangling 项，属可观测降级，但**没有任何写入路径主动使旧 approval 失效**。

---

## 5. Confirmed / Fixed / Drifted（对 §5 各项的裁决）

| 项 | 裁决 | 依据摘要 |
|---|---|---|
| R-01 scribe→artificer 命名断链 + 静默 undefined | **CONFIRMED**（P2） | C-11；三处零事件 `return undefined` 逐行复核。**严重度维持 P2**：影响的是 dreamer 五维上下文注入质量，不改变 canonical data，也不导致未批准内容被激活；但违反 rc-9「no silent fallback」 |
| R-24 `pi_artifacts` 唯一索引 = 覆盖语义 | **CONFIRMED**（P2） | C-15；DDL + upsert 语句 + 12 个调用方 + 覆盖断言测试 |
| R-23 attempt_count / attempt_number 双源 | **CONFIRMED**（P2，标记，深入归 D） | §4.4 |
| `sourceDreamerArtifactId` 语义 | **CONFIRMED**（philosopher 顶层 required，仅 philosopher 自用 + echo 校正；跨级无结构化消费者） | §4.4 |
| `dreamerArtifactId` 语义 | **CONFIRMED**（scribe trace optional，无权威写入者，唯一消费者 artificer） | §4.4 |
| `sourcePrincipleId` 语义 | **DRIFTED**（P2，见 F-02）：写入侧两个命名空间（公理 T-NN / principle 标识）共用一列，读侧再用第四种回退（`principleDraft.title`） | §4.4、F-02 |
| reviewed 时点的 exact identity | **CONFIRMED 且更强**：`humanReviewContext` 绑定 `sourceArtifactId **+ sourceArtifactHash**`，`reviewKey` 含 hash，stale 判定逐字段比对（`owner-resolution-service.ts:368-380`） | §4.4 |
| approved 时点的 exact identity | **PARTIAL**（P2）：只绑 `artifact_id`，无 hash / revision 列 | C-22、F-04 |
| activated 时点的 exact identity | **PARTIAL**（P2）：绑 `artifact_id`；内容级 digest 只在 RuleCode promote 的 `activation_decisions` 存在，**普通 prompt/code_tool_hook approve 路径不写 digest** | C-19/C-20、F-04 |
| 「edit 后旧 approval 是否继续生效」 | **FIXED**（旧 artifact 不会被 edit 后 approve 激活） / **NEW**（覆盖后旧 approval 不被失效，F-04） | §4.4 证据链 |
| 历史 §5 交叉核对「未发现 id 断链」 | **DRIFTED（历史内部矛盾，已由 VERIFICATION-C R-4 登记）**：本报告回源确认该表述范围过宽——C-11 即为反例。**本报告不继承该表述** | VERIFICATION-C.md:219-222；C-11 |

---

## 6. NEW Findings

每条：ID / Severity / Claim / Evidence / Why it matters / Affected stage / Current protection

---

### F-01【P2】`pi_artifacts` 的覆盖语义使 artifact instance id 成为可回收身份，但 approval / activation / lineage 边仍按 instance id 硬引用

- **ID**：F-01
- **Severity**：P2
- **Claim**：`UNIQUE(source_task_id, artifact_kind)` + `DO UPDATE SET artifact_id = excluded.artifact_id` 意味着同一 (task, kind) 的**逻辑**工件永久存在、而它的 **instance id 是可被覆盖的**。凡在覆盖发生前捕获过 instance id 的下游（approval 行、activation 行、其他工件的 `lineageArtifactIds` 边）都会指向一个不再存在的 id。系统对「逻辑 id」与「instance id」的区分只存在于 `CandidateLineage` 的 PRI-717 rebind（`candidate-lineage.ts:392-422`，且只对 `pi-art-<taskId>-run_<taskId>_<seq>` 形态生效），其他消费方（approval/activation/Console）**没有等价重绑**。
- **Evidence**：
  - DDL：`store/sqlite-connection.ts:393`
  - upsert：`store/artifact/sqlite-pi-artifact-store.ts:78-88`
  - 覆盖被断言为期望行为：`pi-artifact-store.test.ts:260-288`（旧 id `getArtifactById` → null）
  - 消费方缺重绑：`activation-dispatcher.ts:244-250`（只比字符串相等）、`sqlite-activation-state-store.ts:77-82`（只校验存在）
  - 只读检测（无修复）：`internalization-chain-integrity-read-model.ts:523-540`（`activation_artifact_id_dangling`）
  - 既有重绑仅一条路：`candidate-lineage.ts:392-422`
- **Why it matters**：一条 lineage 边或一个 approved approval 可以在**无任何写入者主动失效**的情况下变成悬空引用；Owner 侧看到的是 `unlinked` 或 integrity 报告的一行 warning，而不是「这个审批已经无效」。
- **Affected stage**：artifact 持久化（全链）→ approval → activation → lineage 遍历
- **Current protection**：写时 FK 存在性校验（`sqlite-activation-state-store.ts:77-82`、`sqlite-approval-store.ts:149-154`）+ 只读 integrity 检测。**无 inline 失效、无 revision 校验**。

---

### F-02【P2】`source_principle_id` / principleId 有四个语义不同的取值来源，其中一个是标题字符串

- **ID**：F-02
- **Severity**：P2
- **Claim**：`pi_artifacts.source_principle_id`（nullable）被两类写入者填入不同命名空间；读侧 `extractPrincipleId` 再加两层回退，最后落到 `contentJson.principleDraft.title`（**自由文本标题**）。
- **Evidence**：
  - dreamer 写入 LLM 的**公理 ID**（`dreamer-runner.ts:309`，prompt 明示用 CORE AXIOMS 的 `T-01` 形态：`dreamer-prompt-builder.ts:105`），守卫只放行 T-01..T-10（`core-principles/strip-fabricated-ids.ts:19-28`）
  - evaluator 写入从 scribe 产物解析出的标识（`evaluator-runner.ts:3269`，解析器见 `:2807-2836`）
  - 读侧 4 步回退：列 → `parsed.principleId` → `parsed.sourcePrincipleId` → `parsed.principleDraft.title`（`activation/low-risk-writers.ts:7-31`；`ActivationsConsoleModel.ts:301`；`ApprovalsConsoleModel.ts:240`；`prompt-activation-reader-contract.ts:89-97`）
  - supersede 查询用 `COALESCE(source_principle_id, $.principleId, $.sourcePrincipleId)`（`sqlite-activation-safety-store.ts:390, 393`）——**不含 title 回退**，与前面 4 步回退**不一致**
  - Console 侧同族不一致：`ActivationsConsoleModel` 用 title 回退；`sqlite-activation-safety-store` 不用
- **Why it matters**：同一个原则在「激活列表」与「promotion supersede」两条路径上可能解析出**不同 id**，从而出现「激活看起来绑定到原则 X，supersede 却认为没有绑定」。而「标题当身份」还在同一原则被改写标题后产生身份漂移。
- **Affected stage**：dreamer / evaluator 写入 → activation dispatch（`activateArtifact` 缺 principleId 即 `invalid_artifact/no_principle_id`）→ promotion supersede → Console 展示 → receipt 归属
- **Current protection**：dispatcher 在**无** principleId 时 fail-loud（`activation-dispatcher.ts:346-349`，P1 #3 修复明确移除了 fallback）。因此**不会静默激活**，但会**静默解析到错误身份**。

---

### F-03【P2】runtime receipt 的 activation 回链在绝大多数生产路径上为 NULL 且无人读取；`gate_blocks` 完全没有 rule/principle 列

- **ID**：F-03
- **Severity**：P2
- **Claim**：`principle_applications.activation_id` 列存在，但**生产 6 个写入点中 5 个不传 `activationId`**，且**全仓无任何读取者**；`gate_blocks` 表结构本身不含任何 rule/principle/activation 列。
- **Evidence**：
  - 列定义：`store/sqlite-connection.ts:463-476`（`activation_id TEXT`，nullable）
  - 写入 API 有该参数：`principle-application-ledger.ts:76-100`（`activationId?: string`）、`:147-183`（`recordInjectionPresence` 的 `activationIds` 参数）
  - 生产写入点（全仓实测共 6 处，`grep` 覆盖 `recordPrincipleApplication|recordInjectionPresence|recordSelfReportFromText`）：
    - `hooks/gate.ts:175-184`（rule_blocked，legacy 路径）—— 不传 `activationId`
    - `hooks/gate.ts:345-355`（auto_correct_applied）—— 不传 `activationId`
    - `hooks/gate.ts:638-648`（shared-path rule_blocked）—— 不传 `activationId`
    - `hooks/prompt.ts:725-731`（presence）—— **唯一传 `alignedActivationIds` 的路径**
    - `hooks/llm.ts:200`（self_reported）—— 该函数 SQL 不含 activation_id（`principle-application-ledger.ts:260-263`）
    - `hooks/trajectory-collector.ts:139`（self_reported fallback）—— 同上，不含 activation_id
  - 读侧不消费：`ReceiptsConsoleModel.ts:176-178` 的 SELECT 列**不含 activation_id**；全仓无 `principle_applications.activation_id` 的读取者
  - `gate_blocks` DDL：`packages/openclaw-plugin/src/core/trajectory.ts:253-260`（只有 `session_id/tool_name/file_path/reason/created_at`）；写入契约 `trajectory-types.ts:82-88` 亦无 rule 字段；注释明确「trajectory.db gate_blocks has no source column」（`gate-block-helper.ts:125-128`）
- **Why it matters**：任务书要求的「runtime receipt 回链：事件里带回的 ID 能否反查到 pain/candidate」这一跳，**只到 principle_id 为止**，且该 principle_id 本身受 F-02 回退影响；activation 级的 receipt 反查在 OpenClaw 路径不可达（列未写、读侧未读）。
- **Affected stage**：runtime receipt（`principle_applications` / `gate_blocks` / events JSONL）
- **Current protection**：`rulehost_evaluated` 事件带 `activationId`（`hooks/gate.ts:123, 142`，P1 ISSUE-023 修复），落在 events JSONL；另 `EventLogService.recordRuleEnforced/recordRuleHostBlocked` 带 `ruleId`/`principleId`（`hooks/gate.ts:151-168`）。所以**可观测性存在**，只是不在 receipt 表里。

---

### F-04【P2】三个治理时点的绑定粒度不一致；artifact 被覆盖后旧 approval/activation 不被任何写入路径失效

- **ID**：F-04
- **Severity**：P2
- **Claim**：
  - reviewed 时点绑 **(artifactId, contentHash)**（`humanReviewContext.sourceArtifactId + sourceArtifactHash`，`pitask-metadata.ts:124-143`；reviewKey 含 hash，`owner-review.ts:331-343`；stale 比对 `owner-resolution-service.ts:368-380`）
  - approved 时点绑 **artifactId only**（`approvals` 无 hash/revision 列，DDL `sqlite-connection.ts:395-410` + 迁移 `:414-434`）
  - activated 时点绑 **artifactId only**；内容级 digest 仅存在于 RuleCode promote 的 `activation_decisions.artifact_digest`（`sqlite-activation-safety-store.ts:194-206`）
  - 因此：artifact 内容被覆盖（F-01）后，reviewed 的 hash 绑定会**被发现**（stale），但 approved/activated 的 id 绑定**不会被发现，也不会被失效**。
- **Evidence**：
  - 三处 DDL 见上
  - 无失效写入路径：全仓 `FROM approvals` 的写入只有 `enqueue/approve/reject/resetToPending/edit`（`sqlite-approval-store.ts`），**没有**任何「artifact 变更 → 把 approved 行改回 pending/rejected」的调用；`upsertArtifact` 不触碰 approvals
  - 唯一相关防护是 `ApprovalCompletionService` 的幂等预检 `console.warn` 后继续 dispatch（`approval-completion-service.ts:127-135`）与 dispatcher 的 id 相等复核（`activation-dispatcher.ts:244`）
  - 覆盖后残留的可观测信号：`activation_artifact_id_dangling`（`internalization-chain-integrity-read-model.ts:523-540`）、Console `'unlinked'`（`ActivationsConsoleModel.ts:386`）
- **Why it matters**：这是任务书点名要查的「edit 之后旧 approval 是否可能继续生效」的**真正风险面**——风险不在 edit 路径（该路径有校验，判定 FIXED），而在**绕过 approvals 的 artifact 覆盖**（repair / replay re-persist / revision reopen 都会 upsert 同一 (task, kind) 行）。被覆盖后，一个 `approved` 行在数据库里合法存在、字段自洽，但它的 `artifact_id` 已无对应产物。
- **Affected stage**：approval → activation → 治理可审计性
- **Current protection**：只在「激活落库时 FK 存在性校验」（`sqlite-activation-state-store.ts:77-82`）与「只读 integrity 报告」两道。**无 approval 生命周期失效、无 revision 号校验。**

---

### F-05【P3】非 STRONG 入口的 pain id 是时间戳 + 8 字符随机/哈希，同一逻辑事件不可重投为同一 pain

- **ID**：F-05
- **Severity**：P3
- **Claim**：三个 OpenClaw 路径铸造非内容派生的 pain id：`pain_<Date.now()>_<hash8>`（`hooks/pain.ts:298-300`，手动 pain）、`pain_<Date.now()>_<errorHash8>`（`hooks/after-tool-call-helpers.ts:592`）、`gate_<Date.now()>_<rand8>`（`hooks/gate-block-helper.ts:204`）。ADR-0020 §11.4 已把内容派生的 `pain_host_*` 确立为「同一 pain identity 权威」（`signal-collector-host.ts:481-484`），但**其余入口未迁移**。
- **Evidence**：上述四处；对照内容派生的唯一实现 `production-pain-evidence.ts:229-245`
- **Why it matters**：`pain_events.canonical_pain_id` 唯一索引在非派生路径上退化为「几乎不冲突的随机键」，重试/重投递会产生**新的 pain 与新的诊断任务**（identity 重生而非复用）。属于既有历史行为，非本链新引入。
- **Affected stage**：pain 入口 → 诊断任务创建（含 dead-letter 回放 `packages/openclaw-plugin/src/hooks/pain.ts:261-280`）
- **Current protection**：`pain_events` UNIQUE 索引 + 各入口自己的 cooldown/gate（`trigger-cooldown-tracker`、`PainDiagnosticGate`）；不是身份级防护。

---

### F-06【P3】C-09/C-10 的 dreamer 血缘「三重空洞」在 current main 仍然成立（提示词要求、无输入来源、无消费者）

- **ID**：F-06
- **Severity**：P3
- **Claim**：`dreamer` 产物 schema 含 `sourcePainId?: string`（`dreamer-output.ts:57, 83`），prompt 甚至给出示例值 `"pain-null-crash"`（`dreamer-prompt-builder.ts:91`）与「is an optional string」（`:106`），但：
  - `DreamerPromptInput` 不含该字段（`dreamer-prompt-builder.ts:40-46`）→ **LLM 无从得知真实值**；
  - validator 只做 `Type.Optional(Type.String())`，不与任务 `diagnosticJson.sourcePainId` 比对；
  - 全仓无读取 `dreamerOutput.sourcePainId` 的消费者（`grep` 仅命中类型/示例/prompt）。
- **Evidence**：同左（`dreamer-output.ts:57,83`；`dreamer-prompt-builder.ts:40-46,91,106`；`dreamer-runner.ts:302-320` 的 upsert 不写该字段）
- **Why it matters**：这是一条「看起来存在、实际不可信且无人使用」的血缘字段；任何未来的 guard 若把它当作 pain→dreamer 的权威边，会建立在伪造输入上。历史 §5 已登记（dreamer 卡 2 号），本报告确认 current main 未变。
- **Affected stage**：dreamer 产物 → （无消费者）
- **Current protection**：无（无消费者即无风险面，但字段继续污染 schema 与 prompt）

---

### F-07【P3】Codex 宿主缺 rulehost 事件通道 → receipt/shadow 证据结构性不可得（任务书 R-22 交叉项）

- **ID**：F-07
- **Severity**：P3（就 lineage 面而言）
- **Claim**：`HostEventEmitter` 只有两个方法（`packages/principles-core/src/host/host-adapter.ts:181-184`：`recordRuntimeV2ActivationsInjected` / `recordToolCall`），**没有 rulehost_evaluated / gate_block 通道**。Codex 侧实现仅这两个（`codex-adapter/src/pd-hook.ts:25-55`）。共享 gate 的 deny 直接返回 `HostEventResult`（`production-rulehost-gate.ts:387`），Codex 编码器只输出白名单四字段（`codec/output-encoder.ts:22-32`），**不落任何 rule/principle/activation 标识到持久层**。
- **Evidence**：同左；对照 OpenClaw 侧 `hooks/gate.ts:116-200`（shadow/live 事件 + receipt ledger + `gate_blocks`）
- **Why it matters**：lineage 链的**末端回链**在 Codex 宿主不可达——不是 id 丢失，而是载体不存在。影响 promotion readiness 的 shadow 证据面（历史 R-22 已登记）。
- **Affected stage**：runtime receipt / shadow 证据
- **Current protection**：Codex 侧对 `rule_context_v2_unavailable` 做结构化注释（`pd-hook.ts:80-84`）；v2 规则在 Codex 上保持 suspended（`pd-hook.ts:180-186` 注释）。属明示的宿主能力边界。

---

## 7. Protection Gaps（现有 test/guard 是否保护 lineage 完整性）

| 面 | 现有保护 | 缺口 |
|---|---|---|
| runner echo（taskId / source*ArtifactId / trace） | `reconcileLineageEcho` 共享实现（`peer-runner-contracts.ts:397-442`）+ 每 runner 的 succeedTask 强校验 + validators 双写比对 | **`scribe.sourceTrace.dreamerArtifactId` 不在保护清单内**（`scribe-runner.ts:411-415` 显式说明）。这是唯一一条「provider 无权威值」的 lineage 边 |
| artifact instance id | 写时 FK 校验；`activation_artifact_id_dangling` 只读检测；PRI-717 rebind（仅 `pi-art-*` 形态） | approval 行**无**任何悬空检测；`pi-rule-*` 形态不在 rebind 覆盖内；检测仅存在于 integrity 报告，不进 CI gate |
| artifact 覆盖语义 | 覆盖行为被测试**断言为期望**（`pi-artifact-store.test.ts:260-288`）；`pi_artifact_duplicate` 检查在 integrity 报告中（`internalization-chain-integrity-read-model.ts:505-518`） | 无「覆盖前是否需要失效下游」的守卫；无 content hash 列用于跨版本审计 |
| approval identity | `approval_id` 确定性；dispatch 侧 id 三元复核；edit 侧新 artifact 三项校验 | approval 行无 revision / digest 列；无「artifact 变更 → approval 失效」机制（F-04） |
| activation identity | `idempotency_key = artifactId::channel` UNIQUE；`activation_control_states` PK；append-only `activation_decisions`（DDL trigger） | activations **主表** `activation_id` 无 PK/UNIQUE（DDL `sqlite-connection.ts:439-449`）——同一 activation_id 可有多行（`promoteActivation` 的乐观检查 `sqlite-activation-state-store.ts:182-198` 是对此的补偿，但只在 promote 路径） |
| receipt 回链 | presence 路径会写 activation_id；events JSONL 带 activationId/ruleId/principleId | **无读取者**；`gate_blocks` 无 rule 列；6 个写入点里 5 个不写 activation_id（F-03） |
| pain identity | 内容派生实现唯一（`production-pain-evidence.ts`）；pain_events UNIQUE 索引 | 非 STRONG 入口仍用随机/时间戳 id（F-05）；无「所有入口必须用同一派生函数」的 guard |
| lineage 遍历 | `CandidateLineage` 是唯一实现，fail-loud 语义完善（`candidate-lineage.ts:6-24`），有 property test 与 PRI-717 回归测试 | `maxDepth = 6`（`:110`）对 9 跳链（含 4 个 diag 阶段）是**紧的**；超出即 `depth_limit_reached` 且 `complete=false`（消费者按 `ok` 判定，不会静默——但语义上会把长链判为部分） |
| 结构性守卫 | `runtime-contract-rules.js` 只有 ERR-001/005/013 三条规则（`id:` 列表位于 `:498,503,508`）；`verify:merge` 不含任何 lineage 专用检查 | **没有** lineage 完整性 / artifact 身份不变量的自动化 guard |

---

## 8. Suggested Contract Invariants

只写不变量，不写方案（实现方式与取舍交 Owner）。

- **INV-L1（instance vs logical identity）**：任一 artifact 的**逻辑身份**（`source_task_id + artifact_kind`）与**实例身份**（`artifact_id`）必须可区分；凡跨工件引用的持久化边只允许引用其中之一，且该选择在整条链上一致。
- **INV-L2（覆盖可见性）**：任何会改变既有 `(source_task_id, artifact_kind)` 行内容的写入，其导致的实例 id 变更必须被所有持有该旧 id 的下游观察到（即：不允许存在「持有旧 id 且无任何失效信号」的持久化行）。
- **INV-L3（绑定充分性）**：一个治理决定（approval / activation / promotion）若声称绑定了某个 artifact，其绑定的充分性必须与该决定可撤销的代价相称；对「内容变了就等于绑错了」的决定，绑定必须包含内容摘要而非仅 id。
- **INV-L4（provider 权威值存在性）**：一条 lineage 边若被 prompt 要求生产者输出，则该边在**每个**生产者必须有 runner-owned 权威值可供 echo 校正；不允许「只能由 LLM 从非结构化上下文推测、且无权威校正」的 lineage 边。
- **INV-L5（静默不可区分性）**：lineage 边的缺省必须与「该边本不该存在」在可观测层可区分（事件、reasonCode 或结构化 note）；同一处代码路径不得同时承担「向后兼容缺省」与「解析失败」两种语义而不加披露。
- **INV-L6（命名空间唯一性）**：同一持久化列的取值必须来自单一命名空间；若某列历史上承载多个命名空间，必须存在一个权威解析点，且所有读路径共享该解析点。
- **INV-L7（receipt 回链闭合）**：runtime receipt 行必须能反查到触发它的治理决定（activation/rule）或显式披露「该维度不适用」；不允许「列存在但恒空且无披露」的形态。
- **INV-L8（宿主能力对等性披露）**：凡某一宿主结构性缺失某类证据载体，必须以结构化方式（而非仅在注释中）在 Owner 可见面披露，且不得使另一宿主的 gate 静默通过。

---

## 9. Out of Scope

- 未修复任何代码、未改任何 config、未触碰 `packages/**`、未动 Linear。
- 未评估 LLM 实际提示词遵循度（无实测数据，无法判定 C-11 在真实模型上的失败率）。
- 未做 live 运行时核对（无可用 workspace state.db）。
- R-23 的深入调查（`attempt_count` / `attempt_number` 全影响面）归 Worker D；本报告仅标注其在本链上的位置。
- 历史审计 REPORT.md §2/§3 的 F/R 编号条目中与 lineage 无关者（路由、预算、提示词长度、empathy 死角色、词库等）不在本报告判定范围。
- 未为 §8 的每条 invariant 设计实施方案（按 D9：设计决策留 Owner）。
- 未评估 `docs/adr/`、`docs/product/` 中的设计意图是否与本报告判定冲突（章程 D6：只读且不在委托范围）。
