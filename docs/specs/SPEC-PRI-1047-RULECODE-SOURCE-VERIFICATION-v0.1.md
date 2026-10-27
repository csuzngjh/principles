# SPEC-PRI-1047 RuleCode 草案来源核验统一与定点 source-correction 恢复 v0.1

日期：2026-10-26。状态：限定设计稿（PRI-1047 工单正文 + Owner 配套指令即确认本范围）。本文不批准任何规则、激活、shadow/live 或公共发版。

## 1. 问题（已核实）

原候选 `52d98a96-65b9-4952-82c5-51ba2d853c53`（channel=code_tool_hook，pain `manual_1791868470372_8c47edyh`）在 2026-10-26 出现真实断路：

1. Scribe run4（epoch3，binding revision1 已消耗）返回 `executionConditions.requiredFacts[0].textualBasis = "Owner原文：'非简单行为变更先调查现状，交付SPEC和技术方案……经Owner确认后再编码；…'"` —— 带标签、引号与省略号（U+2026）的改写，非连续原句。
2. `DefaultScribeValidator(requireRuleCodeContracts=true)` 只做结构校验（非空字符串），判 valid=true，Scribe 标记 succeeded 并落工件。
3. Artificer 前置核验 `assessIntentBasis` 判 `textual_basis_unanchored`，任务停 needs_human_review（attempt 0/6）。锚定实现 `isTextualBasisAnchored` 只匹配归一化后 ≤12 字符前缀：标签导致误拒；前缀相同、后段编造却会通过。
4. 该 NHR 停点无正式恢复路径：`revise_once` 只接 evaluator/rollout_reviewer；CLI retry 只重排队不携带 Scribe 修订反馈；binding revision 同 cause 幂等且已被 run4 消耗。
5. `BasePeerRunner` 已持久化 `lastValidatorErrors`（含 sourceAttemptCount 新鲜度），但 Scribe 从不消费——重试与首轮 prompt 零差异（EP-05）。

## 2. 现有权威与复用（Connection Before Creation）

| 能力 | 现有 owner | 本 SPEC 动作 |
|---|---|---|
| 引用锚定判定 | `artificer-intent-preflight.ts` 的 `normaliseForAnchor`/`collectIntentMaterial`/`isTextualBasisAnchored` | 提取为共享模块并升级为全量连续匹配 |
| 上游材料池（含 PRI-1018 Owner 诊断证据血缘） | `collectUpstreamNormalisedText`（同文件，已导出） | 原样复用，Scribe 侧同口径调用 |
| validator 拒绝持久化 + 新鲜度 | `BasePeerRunner.handleValidationError` + `parseLastValidatorErrors`/`isFreshForNextAttempt` | 零改动，Scribe 接上消费 |
| lastValidatorErrors 回喂模式 | `ArtificerRunner.buildContext/invokeRuntime`（priorValidatorErrors） | 同模式移植到 ScribeRunner |
| 有界一次修订恢复 | `reviseRuleBindingOnce`（rule-binding-revision.ts，Console 认证路由 + 同 cause 幂等 + CAS） | 平行新增 source-correction 一次修订，复用同一链解析与入口形态 |
| 修订波下游重开 | `commitNextTaskProposal` 级联（revisionCount>0 时识别 succeeded/NHR 后继） | source-correction receipt 存在时走定点 CAS 分支，泛化级联保留 |
| 多 epoch 工件当前视图 | `sqlite-pi-artifact-store.listBySourceTaskId`（MAX(revision_epoch)） | 零改动，测试断言不回落旧工件 |

## 3. 修复 A：Scribe 成功前统一纯材料锚定校验

### 3.1 共享锚定模块（新 `textual-basis-anchor.ts`）

- `normaliseForAnchor(text)`：lowercase + 去空白与 CJK/ASCII 标点（含引号），与现实现一致；`…`（U+2026）**保留**（省略号是硬失配信号，不是格式差异）。
- `isTextualBasisAnchored(basis, normalisedPool)`：**归一化全量连续子串匹配** —— 整条 basis 必须作为连续片段出现在池内。规则：
  - 归一化后 <4 字符 → 不通过（过短不可信）；
  - 池为空 → 不通过；
  - 标签前缀（如「Owner原文：」）、引号内改写、省略号跨接、后段编造 → 因不连续全部失败；
  - 连续原句（可短至一个完整分句）→ 通过；大小写/空白/标点差异归一化后兼容。
- `collectScribeIntentMaterial(parsed)`：从 preflight 原样迁出（principleDraft.statement + intentContract 四字段 + 审批信号位）。
- 锚定池口径不变：scribe 意图材料（自身 statement + intentContract）∪ 上游材料（philosopher thesis/principleCandidate/risks/analysis + PRI-1018 formation 诊断 evidence notes）。diagnosis recommendations、模型自报批准不在池内，不能冒充 Owner 材料（R02 有区分力反例）。

### 3.2 Scribe 成功边界（scribe-output.ts / scribe-runner.ts）

- `ScribeValidator.validate` 接口加可选第 4 参 `options?: { upstreamAnchorMaterial?: { normalisedText: string } | null }`（加法变更，三处生产接线不动）。
- `DefaultScribeValidator`：`requireRuleCodeContracts` 且 executionConditions 结构有效且 `upstreamAnchorMaterial` 非 null 时，对每个 `required:true` fact 执行共享锚定检查；失败产出**字段级**错误（factKind + 截断引用 + 「必须改为可核验的连续原句」）→ `output_invalid` → `handleValidationError` 记入 lastValidatorErrors → 有界重试。
- `ScribeRunner.validateOutput`：channel=code_tool_hook 时用 `collectUpstreamNormalisedText`（传 `JSON.stringify(output)` 为 scribeContentJson，与 preflight 相同的血缘校验：philosopher sourceDreamerArtifactId ↔ scribe sourceTrace.dreamerArtifactId 一致、pain lineage 一致）计算上游材料并传给 validator。材料不可解析/读失败 → 跳过该校验并发事件（rc-9），由 preflight 的既有停点兜底（材料缺失本身是上游停点，不是输出缺陷）。
- 上游材料可解析而引用不锚定 → Scribe **不得** succeeded、不得落可消费工件（EP-03：失败不得变成功）。

### 3.3 lastValidatorErrors 回喂（scribe-runner.ts，镜像 Artificer）

- `ScribeContext` 增加 `priorValidatorErrors?: LastValidatorErrors` 与 `philosopherTaskId`。
- `buildContext`：`parseLastValidatorErrors(task.diagnosticJson)` + `isFreshForNextAttempt(record, this.currentLeasedAttempt)`；新鲜则携带，陈旧/缺 lease 则发 `prior_validator_errors_suppressed` 事件（rc-9）。
- `invokeRuntime`：新鲜错误以 `<previous_validation_errors>` 块追加进 prompt（错误已由读取侧限界 ≤10 条 × 500 字符），与既有 `<revision_feedback>` 块并存。
- 跨 epoch 新鲜度：reopen 后 attemptCount=0 → 新 attempt 序号 1 ≠ 旧 sourceAttemptCount → 旧错误不进入新轮（rc-7，测试断言）。已知继承边界（pitask-metadata 评审 P1 既档）：纯数字比较下，新 epoch 第 2+ 次 attempt 若前次为**运行时**错误（不覆盖也不清除记录），`sourceAttemptCount === 新序号-1` 的陈旧记录会被视为新鲜回喂——仅影响提示质量（validator 全量重检），成功清理已收窄主路径。
- decisionId 缺失的绑定身份 → `binding_decision_missing` 拒绝（零消费），不写空串破坏元数据可 hydrate 性（评审 P2 #5）。
- 成功清理：`succeedTask` 在 markTaskSucceeded 前对存在 `lastValidatorErrors` 顶层键的任务做一次 CAS 定点删除（expectedStatus=当前持租状态）；CAS 失败发事件、不阻断成功（新鲜度已兜底）。
- maxAttempts 不变：沿用任务行既有值；耗尽走既有结构化终态，不新增 LLM 修复器、不吞错误。

#### 3.3a 附带缺陷修复：重开 epoch 的 attempt 计数（lease-manager.ts）

R04 实跑暴露的既有缺陷：`DefaultLeaseManager.acquireLease` 把「runs 表全局序号」整体写回 `tasks.attempt_count`，重开 epoch（attemptCount 归零、历史 runs 1..N）首次租约即 attempt_count=N+1，`shouldRetry`（attempt_count < maxAttempts）在第一次校验失败就终态化——新 epoch 实际拿不到它被重开时承诺的 maxAttempts 次尝试（binding revision 同样暴露，生产 run4 4/3 即此形状）。修复：runs 的 attempt_number 保持全局递增（run-id 唯一性不变），任务 attempt_count 改为 epoch 内自增（事务内从当前行 +1）。「恢复待执行次数」（epoch 计数）与「原总执行记录」（runs 全局序号）由此区分。

### 3.4 生成要求一致（scribe-prompt-builder.ts，v8 → v9）

EXECUTION CONDITIONS 指令改为与校验同一口径：textualBasis 必须是从 Owner-attributed 材料（诊断 evidence notes / philosopher 材料 / 意图契约锚点）中摘出的**连续原句**；禁止把引用标签、引号、省略号跨接写入该字段；格式差异（大小写/空白/标点）由系统归一化兼容。版本注释记录变更。

## 4. 修复 B：正式、定点、有界的一次 source-correction 恢复

### 4.1 核心操作 `reviseRuleSourceOnce`（新 `rule-source-correction.ts`）

输入（Console 认证路由透传，含 Owner actor/requestId/reason）：`candidateId`、`expectedBindingRevision`、`expectedScribeTaskId`、`expectedArtificerTaskId`、`expectedScribeArtifactDigest`、`reason`、`requestId`、`actor`。

服务端核验（全部通过才落库）：
1. 链解析复用 `resolveRuleBindingRevisionTarget` 语义（dreamer/philosopher 唯一、succeeded，scribe 唯一、code_tool_hook），再定位唯一以该 scribe 为依赖的 artificer，与 `expectedArtificerTaskId` 精确匹配——不接受任意 taskId 组合。
2. ledger 身份 resolved 且 `basis==='owner_rule_binding'` 且 `bindingRevision === expectedBindingRevision`（授权必须锚定当前绑定；撤回/失效/换绑 → 拒绝）。
3. 当前 scribe 工件摘要 === `expectedScribeArtifactDigest`（材料未变不重复调用模型；变了 → `scribe_artifact_changed`）。
4. artificer 处于 needs_human_review 且 `humanReviewContext.reasonCode ∈ {textual_basis_unanchored, approval_dependency_undeclared}`（确因该源材料而停）；其他停点 → 拒绝。
5. scribe/artificer 无活租约；scribe 状态 ∈ {succeeded, needs_human_review}。
6. 预算：cause = `rule-source-correction:<candidateId>:<bindingRevision>`；scribe 已有相同 cause → `revision_already_started`（崩溃/双击幂等重放）；已有**任何** sourceCorrectionCauseId → `source_correction_budget_exhausted`（一次源修订上限，不因新 requestId/重绑/重启获得第二次额度）。

生效（对 scribe 的**单次 CAS 写** = 授权消费 + 重开原子完成，失败零消费）：status→pending、attemptCount→0（maxAttempts 原值不动）、revisionCount+1、revisionCauseId=cause、`sourceCorrectionCauseId=cause`、`revisionFeedback`=锚定修复指令（携带停点 reasonCode 与 detail 摘要）、`sourceCorrectionReceipt`（V1：candidateId、scribeTaskId、artificerTaskId、sourceArtifactId+digest、bindingRevision+decisionId、expectedStopReasonCode、reason、actor、requestId、consumedAt、status:'consumed'、reopenOutcome 未定义）。receipt 归 PITaskMetadata（既有任务元数据 owner），不新增平行存储。

### 4.2 下游定点 CAS 续接（internalization-orchestrator.ts）

`commitNextTaskProposal` 处理 succeeded scribe 且 receipt 存在、`reopenOutcome === undefined` 时，走**定点分支**（先于通用级联与 findExistingSuccessor）：
- artificer 缺失 → 记 outcome `task_missing`，返回 `source_correction_reopen_failed`（可见、可查）。
- artificer pending/retry_wait：revisionCauseId=cause（崩溃重放）或他因在途 → 记 outcome（`reopened_earlier`/`already_in_flight`），返回 no-op 决策（在途任务经 MAX(revision_epoch) 视图自然消费新工件）。
- artificer needs_human_review 且 reasonCode === receipt.expectedStopReasonCode → **CAS 重开**（updateTaskIfDiagnosticJsonUnchanged，expectedStatus=needs_human_review）：保留原 taskId 与依赖、attemptCount→0、revisionCount+1、revisionCauseId=cause、清 runnerDecision/completionIntent。成功记 outcome 并返回 `source_correction_reopened`；CAS 失败重读，同 cause → 幂等，否则 `source_correction_reopen_conflict`。
- 其他状态/停点 → 记 outcome `conflict` 并返回 conflict 决策；**不落入通用级联**（receipt 已把本次完成限定为 source-correction 所有，含 outcome 已记录后的周期性 reconciliation 重放——重放返回 `source_correction_reopen_noop`+`outcome_recorded:*`，刚被拒绝的 Artificer 不会被通用级联绕开停点核验重开），不泛化成自动重开所有 NHR。分支位于 proposeNextTask 之前（不依赖 job graph 可解）。
- Scribe 失败/NHR → 不进入该分支（commitNextTaskProposal 早退），下游零重开（负控断言）。
- Scribe 成功后 Artificer 成功 → 既有通用级联继续重开 evaluator（复用现有后继修订机制），直至正式待审批。

### 4.3 认证入口（pd-console）

`/api/v1/governance/rule-candidate-bindings/:candidateId/source-correct-once`（POST，ownerIdentity 必需，镜像 revise-once）：`RuleCandidateBindingConsoleModel.correctSource` → `reviseRuleSourceOnce`。请求/响应封闭字段校验同既有路由纪律。生产恢复走此入口留审计回执。

### 4.4 与相邻机制的边界

- 区别 binding revision（改身份血缘预算，已消耗）、runner attempt（任务内重试，喂 lastValidatorErrors）、Rule 审批/激活（治理决策，本票不触碰）。
- 新 epoch 沿用原 profile/maxTokens/timeout/maxAttempts 与下游修订上限，不抹历史花费；「恢复待执行次数」与「原总执行记录」分开。
- 生产执行前提：Owner 明确授权句（限定原 52d 候选、一次 source-correction epoch、该 epoch Scribe 最多 3 次 attempt）。无授权 → 工程交付照常，生产恢复记 NOT RUN。

## 5. Complexity Delta

- 新持久化元数据（PITaskMetadata 可选字段 `sourceCorrectionCauseId`/`sourceCorrectionReceipt`）：YES —— 既有任务元数据 owner 的最小扩展；回滚 = 字段被序列化忽略。
- 新公共操作 `reviseRuleSourceOnce` + Console 子路由：YES —— 现有恢复入口的最窄扩接口，复用链解析/CAS/幂等模式。
- 新模块 `textual-basis-anchor.ts`：非新抽象层级，是既有散落判定的单一化搬迁（删除 preflight 本地副本）。
- 新 feature flag / 新子系统 / 新后台进程 / 跨包依赖 / 外部网络能力：NO。

## 6. 验证计划（映射 R01–R10）

- R01：真实 run4 形状锁定「validator valid=true / preflight 拒绝」红；Scribe Runner 测试断言两次 startRun 输入（第二次含上一轮字段级错误）；反例锁定不回喂旧实现失败；跨 epoch 不混旧错、maxAttempts 停、正确引用首轮通过。
- R02：共享锚定纯函数区分表（标签/引号/空白、多语言、错误来源、推荐冒充 Owner、空/畸形、省略转述、前缀同后段伪造、required:false、血缘错配）。
- R03：真实 SQLite 走完整恢复链（binding 已耗 + revisionCount=3 → NHR → 授权 → 新 epoch → 新工件 → 原 Artificer CAS 续接 → evaluator → 待审批）+ 全部负控（findExistingSuccessor 旧遗漏 NHR 的负控、双连接/并发/换 requestId/崩溃重启/额度耗尽/活租约/旧摘要/失效绑定/Scribe 失败不重开/续接失败可恢复/历史与总花费不变）。
- R04：隔离一致副本（state.db + .state ledger + 配置）真 GLM（zai/glm-5.3-flash，maxTokens=32000/timeout=600000ms 实读值）跑 source-correction epoch，失败样本全留。
- R05/R06/R07：独立冻结反例（生成/修订提示之外）覆盖未批准阻止、approved/not_required 放行、unknown 降级可观测、只读/已批 SPEC 不误拦、换命令/写工具/路径、无外部事实原则、先读后写、显式路径禁令、其他原则类型；facts provider 能力声明与执行时 facts 分离。
- R08：分包构建/类型/verify:merge/BDD/架构/ERR 门禁 + PR CI。
- R09：发布安装与生产恢复分列证据；未安装则标「工程完成、生产未验收」。
- R10：真实 Codex 执行属 PRI-1044，未取得真实生效授权/观察条件即标 NOT RUN。

## 7. 回滚

代码回滚 = revert PR；安装回滚 = 官方版本通道降级。所有治理数据、绑定、历史工件保留；无 schema 破坏性回滚（新 metadata 字段为可选加法）。receipt/cause 残留对旧版本不可见（hydrate 忽略未知字段）。
