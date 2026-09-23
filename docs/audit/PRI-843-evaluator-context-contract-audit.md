# PRI-843 Evaluator Context Contract Audit

> **报告类型**：只读架构审计 + 消费者契约定义（Architecture Audit / Research Spike）
> **研究命题**：PD Evaluator 是否应该接入 Formation Context？如果应该，最小正确 Context Contract 是什么？
> **日期**：2026-09-19
> **纪律**：未修改生产代码 / 测试 / 数据库 / 配置 / feature flag / Owner authority / Approval flow / RuleHost；未创建 PR；未创建 Linear 工单。仓库外读取（`D:/pd-labs/pri841/**`）均为只读。
> **上游**：PRI-835 · PR #1756（PRI-838 + PRI-839）· PRI-841 · PRI-842
> **架构方向**：`Consumer-driven Context Contract`（**非** Global ContextManifest，**非** Memory System）

---

## 0. Baseline（Phase 0）

```text
BASE_SHA       = fb3974526095939178ed17aa90217f5fc09c1aca
current branch = main
main SHA       = fb3974526095939178ed17aa90217f5fc09c1aca   (本地 origin/main == HEAD)
HEAD 时间       = 2026-09-19 10:13:46 +0800
HEAD 提交       = Merge pull request #1764 (PRI-844 pain-evidence-first-class-correction)

PR #1756 存在性 = ✅ 已确认包含在 main 中
  merge commit = a07981c97bb707d9abf81f1dece2ef62270de363 (2026-09-18 20:54:38 +0800)
  ancestor 校验 = `git merge-base --is-ancestor a07981c9 HEAD` → YES
  formation-context.ts 最后变更 = 8ac06ec4 (2026-09-18 20:30) fix(pri-838): enforce the total formation-context cap

working tree   = 干净（仅 pre-existing untracked docs/audit/PRI-768-*）
```

**基线披露（限制）**：本机工作区状态库 `D:/Code/principles/.pd/state.db` 为**空库**（`pi_artifacts` / `tasks` / `artifacts` 均 0 行），`D:/Code` 下无其它可用生产库。因此**本审计无法在本机对"当前生产 evaluator prompt 的实际字符数分布"做 live 测量**（见 §11 Q-3）。

替代证据：PRI-841 在 `D:/pd-labs/pri841/dataset.json` 中留存的**真实 dreamer 工件内容**（2 个真实 Owner 标注包族、各 5 候选）可只读复用，用于测量 formation block 的真实体量（见 §3.3、§5.1）。测量使用 PRI-841 `head` 树（`a07981c9` 构建，与本模块当前源码同版）的**真实** `resolveFormationContext` 与 `serializePromptInput`；探针脚本位于仓库外 `D:/pd-probe-pri843/measure-formation.mjs`。

---

## 1. Executive Summary

### 1.1 三个直接答复

**① PD Evaluator 是否应该接入 Formation Context？**
**应该接入。** 这不是"信息越多越好"，而是一次**连接修复（connection fix），不是能力新增（capability addition）**——与 PRI-838（Scribe）、PRI-839（Artificer）已经做过、已被验证两次、并已被 PRI-842 命名为 `MVP-1` 的修复同一类。

核心事实：**Evaluator 是整条 formation 链上唯一同时看到 Rule（Artificer）与 Principle（Scribe）、却看不到原始 Pain / Diagnosis 的决策点。** 因此它的判断上限被结构性地限定为"规则是否忠于**原则文本**"，无法回答"原则是否忠于**痛感**"。这就是 **DC-4a**。

**② 最小正确 Context Contract 是什么？**

| 类别 | 内容 |
|---|---|
| **Required** | `sourceDiagnosis`（`rootCause` + `evidence[]` + `violatedPrinciples[]`）· `provenance`（`sourcePainId` / `sourceDreamerArtifactId` / `sourceDiagnosisArtifactId` / `lineageArtifactIds`）· `dreamerProposals`（仅作为"有哪些备选存活"这一**事实**）· 已持有的 Rule / Principle / intentContract **保持权威，只增不改** |
| **Optional** | `dreamerProposals[]` 的细节维度（`badDecision` / `rationale` / `riskLevel`）· `dreamerContextRefs` · `truncationNotes` · 原始 Pain 原文（**当前不可达**，见 §4.4） |
| **Forbidden** | 全量 artifact dump · Philosopher 全文二次注入 · 历史 evaluation / 跨 formation 记忆 · Owner 原始会话 / 非 formation 记忆 · 被否候选标记（语义未落盘）· 任何回写边 · Owner 身份 / 审批 / 激活状态 |

**③ 最小接入点在哪里？**

`EvaluatorRunner.buildContext()`（`evaluator-runner.ts:416-497`）——镜像 `scribe-runner.ts:219-227` 的接线形态调用**现有** `resolveFormationContext`；`buildEvaluatorPrompt()`（`:622-653`）透传；`EvaluatorPromptBuilder`（`evaluator-prompt-builder.ts:223-247`）增一个条件块 + 一次版本 bump。**不新增子系统、不新增 schema、不新增 flag、不新增跨包依赖。**

### 1.2 必须在 SPEC 阶段裁决的三件事（本审计无法代替 SPEC 决定）

**D-1 归因路由（最高优先，本审计最重要的新增发现）**
Evaluator 判定"原则不忠于痛感"时，**唯一的机器出口是 `needs_revision` → 播种 artificer repair 任务（改规则）**，而**原则本身没有任何机器修订通路**（`revision-reopen.ts:168-171` 的 `RolloutRevisionTarget.kind = 'scribe' | 'artificer'`，且由 rollout 触发，不由 evaluator 触发）。更硬的一条：prompt 的 CONSTRAINTS 明确要求 **`needs_revision` 时 `requiredChanges` 必须至少含一条**（`evaluator-prompt-builder.ts:205`）。
⇒ 若契约允许把"原则级缺陷"写进 `requiredChanges`，会制造**结构性死循环**：唯一下游只能改规则，永远无法满足一个原则级要求。其失败模式与 PRI-703 已裁决的 `evaluator_test_out_of_scope` **完全同构**。
**建议：pain-faithfulness 缺陷只进入 `concerns`（必须带可验证引用）+ 可选的新 decision-capable 人工复核 reason code；`requiredChanges` 明确禁止承载原则级缺陷。**

**D-2 判官自举**
Evaluator 用于判定"原则忠于痛感"的证据（诊断），本身是同一链条的上游产物。若诊断发生**机械式误归因**（本项目的核心攻关问题），该误归因会被 Evaluator **放大为对正确规则的拒绝**——直接推高 `false rejection`。
**建议：prompt addendum 必须含"诊断是证据不是真理"的降级条款**（与 `scribe-prompt-builder.ts:90` 的 `sourceDiagnosis` 缺席降级句同构），且 pain-faithfulness 结论**不得单独导致 `rejected`**。

**D-3 prompt 硬帽**
Evaluator 是**唯一**经由 `serializePromptInput` 组装 payload 的 peer runner（Scribe 用裸 `JSON.stringify`，无上限）。该序列化器在 **50,000 字符处抛 `RangeError`**（`prompt-serializer.ts:1,49-51`），而 `invokeRuntime` 的抛错会落入 `base-peer-runner.ts:381` 的通用 catch → `classifyError` → `retryOrFail`，即**确定性重试循环**（`pitask-metadata.ts:229` 已把这一失败模式记录为历史 incident 并为此专门给 validator 回喂加了上限）。
**建议：不新增预算机制，只要求 SPEC 声明"formation block 复用现有 8,000 硬帽 + 降级顺序"**，并补一条硬帽边界回归。实测（§5.1）真实 formation 只占硬帽 **4.15%–5.06%**，风险极低但必须显式登记。

### 1.3 最终判定

```text
PRI_843_RESULT = READY_FOR_SPEC
```

依据：真实入口已定位到**函数级** · Context Contract 已可定义 · 实施边界清晰（**2 个文件，同一包**）。三项待裁决事项属于 SPEC 内容，不构成调查阻断。

**本审计的首要约束（hardest constraint）**：本连接是**只读证据接地（read-only evidence grounding）**。它让 Evaluator **检测并报告** pain / principle 漂移，**不**改变 Evaluator 的决策权威、**不**改变 Owner 的批准角色、**不**动摇 Scribe 对 Principle 文本的独占写入权。把 DC-4a 变成 Evaluator → Principle 的回写边，就是 DC-4b——PRI-842 已标记 `OPEN by design（治理语义，勿轻动）`，本审计明确不动。

---

## 2. Current Evaluator Architecture（Phase 1）

### 2.1 Evaluator Pipeline Map

```text
Input Artifact
  EvaluatorRunner.buildContext()                       evaluator-runner.ts:416-497
    ├─ 遍历 dependencyTaskIds → 选 'artificer' 且 succeeded  :430-440
    ├─ artificer artifact contentJson  ── sourceArtificerArtifactId  :444-452
    ├─ extractScribeArtifactId(artificer.contentJson)   :190   （sourceTrace.scribeArtifactId）
    ├─ artifactStore.getArtifactById(scribeRef)
    │    → 校验 artifactKind === 'principle' → scribeArtifact contentJson  :458-471
    └─ dependencyRepairPayload → resolvePreviousEvaluation()  (修复轮)  :478-490
        ↓
Context Assembly   EvaluatorContext { contextHash, artificerArtifact,
                   sourceArtificerArtifactId, scribeArtifact, sourceScribeArtifactId,
                   dependencyRepairPayload?, previousEvaluation? }   :86-107
        ↓
Prompt Builder     invokeRuntime() :499 → buildEvaluatorPrompt() :622
    ├─ JSON.parse artificer + scribe
    ├─ extractIntentContract(parsedScribeArtifact)   :650     （PRI-703）
    └─ EvaluatorPromptBuilder.buildPrompt()  evaluator-prompt-builder.ts:223
         message      = serializePromptInput(EvaluatorPromptInput)   ← 50,000 硬帽，超限抛 RangeError
         systemPrompt = EVALUATOR_PROTOCOL_INSTRUCTION (+ language directive)
        ↓
Model              runtimeAdapter.startRun({ outputSchemaRef: 'evaluator-output-v1',
                                            contextItems: [] })      :503-511
        ↓
Validator          validateOutput() :655 → DefaultEvaluatorValidator
                   + 修复轮 convergence 校验（expectedRequirements）
        ↓
Decision Persistence
   ① lineage 一致性核对（ERR-004）                     :697-702
   ② adversarialResult 剥离（LLM 不可伪造 gate 权威）   :710-713
   ③ updateRunOutput + artifactStore.upsertArtifact    :717, :752
   ④ updateValidationStatus(ruleArtifactId,'validated') :1137 / :3068
   ⑤ 决策效果：maybeSeedArtificerRepair() :1950  或
              deriveGovernanceEffect()   :1901-1948
   ⑥ postFetchTransform → reconcileLineageEcho()      :2193-2213
```

### 2.2 关键结构事实

| 事实 | 证据 |
|---|---|
| 单阶段评审：两阶段 `progressive_evaluator` 已随 PRI-819 R-06 退役 | `evaluator-runner.ts:500-501` |
| Evaluator 的直接依赖是单个 `artificer`；job graph 边 `artificer → evaluator` | `:430-440`；`internalization-job-graph.ts:39` |
| 完整链条：`dreamer → philosopher → scribe → artificer → evaluator` | `internalization-job-graph.ts:36-40`；诊断阶段链 `:99-103` |
| Evaluator 已解析 scribe artifact 并**校验 kind** | `:458-471` |
| Evaluator 的 prompt 经 `serializePromptInput`（**有硬帽**） | `evaluator-prompt-builder.ts:1,241` |
| Scribe 的 prompt 用裸 `JSON.stringify`（**无硬帽**） | `scribe-prompt-builder.ts:236` |
| Evaluator **无**原则修订通路 | `revision-reopen.ts:168-171`；evaluator 侧无对应调用 |
| Evaluator 已有"我发现了但我修不了 → 交 Owner"的**成熟先例** | `deriveGovernanceEffect()` :1901-1948 → `selectedEffect:'needs_human_review'` + `effectReasonCode:'evaluator_test_out_of_scope'`；`owner-review.ts:52` 及 `DECISION_CAPABLE_HUMAN_REVIEW_REASONS` |
| Evaluator 输出中的 `sourceTrace.dreamerArtifactId` echo **未被权威校正** | `postFetchTransform` :2200-2209 只校正 `taskId` / `sourceArtificerArtifactId` / `sourceTrace.artificerArtifactId` |

> **结构含义**：§1.2 的 D-1 不是理论担忧。代码里已经存在一条"Evaluator 检测到下游结构性无法满足的缺陷 → 路由给 Owner 而非播种修复轮"的**成熟先例**（PRI-703 Phase 2）。pain-faithfulness 缺陷应当**复用这条先例**，而不是发明新通路，也不是塞进 `requiredChanges`。
>
> **附带发现**：上表最后一行是一个既有的 provenance 小缺口——Evaluator 输出的 `sourceTrace.dreamerArtifactId` 是模型自填、无权威校验（prompt 的 CONSTRAINTS 只说"include only if available from artificer artifact"，`evaluator-prompt-builder.ts:211`）。一旦接入 formation context，该 id 变成**可权威派生**的，因此可以在同一次改动中以极低成本把它一并纳入 `reconcileLineageEcho`（**加强 provenance，不新增权威**）。建议列入 SPEC 的可选范围。

---

## 3. Current Context Inventory（Phase 2）

> 严格区分 **Exists**（已持久化且从 Evaluator 已加载的工件可**到达**）与 **Used**（被投影进 prompt）。**存在 ≠ 使用。**

| Context | Exists | Used | Source / 证据 |
|---|---|---|---|
| Rule artifact（`implementationCode` / `goldenTraceCases`） | ✅ | ✅ 恒定 | `evaluator-runner.ts:444` → `evaluator-prompt-builder.ts:231`（全文） |
| Principle（`principleDraft`：statement / rationale / applicability / antiPatterns） | ✅ | ✅ 恒定（可解析时） | `:458-471` → `:232`（全文） |
| intentContract | ✅ | ✅ 条件 | `:650` `extractIntentContract(parsedScribeArtifact)` → `:237` |
| `source_principle_id` / sourceTrace ids | ✅ | ⚠️ 仅 id（写入输出，非判断输入） | 输出 schema `EvaluatorSourceTrace`；提取器 `evaluator-runner.ts:2585` 仅用于持久化归属 |
| examples（期望行为） | ✅ | ✅ 间接 | `artificerArtifact.goldenTraceCases`；prompt 的 `codeReview.traceCoverage` 判定面 |
| antiPatterns | ✅ | ✅ 间接 | `scribeArtifact.principleDraft.antiPatterns`（随全文进入） |
| previousEvaluation / requirementLedger | ✅ | ✅ 条件（修复轮） | `:521-617` → `:233` |
| hostToolCatalog | ✅ | ✅ 条件 | `:642` |
| adversarial 失败案例（真实回放产物） | ✅ | ⚠️ 间接（经 repair 反馈） | `executeDeterministicReplay` :2300+ |
| **Pain（`sourcePainId`）** | ✅（dreamer 工件） | ❌ | 经 `scribeArtifact.sourceTrace.dreamerArtifactId` 可到达；**从不解引用**。内容本身不可达（§4.4） |
| **Diagnosis（rootCause / evidence / violatedPrinciples）** | ✅（`diag_*` 工件） | ❌ | 可经 `resolveFormationContext` 解析；**从未调用** |
| **Dreamer lineage / candidate alternatives** | ✅（dreamer 工件） | ❌ | 同上；**标识符到达了 Evaluator，内容没有** |
| Provenance 块 | ✅ | ❌ | `FormationProvenance`（`formation-context.ts:133-140`）无 Evaluator 消费者 |

### 3.1 一句话结论

**每一行 Missing 都是 *Exists* 且可从 Evaluator 已加载的工件到达。缺口是"解析"，不是"可得"——与 PRI-835 对 Scribe 的诊断（"held the identifier and never dereferenced it"）形态完全相同。**

---

## 4. Existing Formation Context Capability（Phase 3）

### 4.1 已有能力（无需新建）

| 能力 | 位置 | 状态 |
|---|---|---|
| `resolveFormationContext()` | `formation-context.ts:810-822` | ✅ 生产在用，**永不抛错**（内部 try/catch → 可观测事件 + `undefined`） |
| 有界投影（dreamer 候选 / 诊断 / provenance） | `projectDreamerProposals` :289 · `projectDiagnosisOutput` :362 | ✅ untrusted JSON 用 `Object.hasOwn` + `typeof` 守卫，绝不 `as` |
| 预算契约 + 降级顺序 + rc-9 可观测 | `applyBudget` :609 · `enforceTotalBudget` :513 | ✅ 8,000 总帽，ERR-134 回归锁定 |
| 消费侧接线形态（可直接镜像） | `scribe-runner.ts:219-227` + `lookupFormationTask` :261-270 | ✅ |
| 事件词表 | `formation_context_resolved` / `_skipped` / `_failed` / `dreamer_artifact_missing` / `formation_context_invalid` / `formation_dreamer_artifact_missing` | ✅ 成熟，**无需发明新词** |
| 测试契约 | `__tests__/formation-context.test.ts`（Case 1/2/3 + 预算 + PRI-839 差异摘要 + 确定性 + legacy） | ✅ 已覆盖降级 / 有界 / legacy / 字节确定性 |

### 4.2 是否已支持 Evaluator？

**不支持。** 全仓 `resolveFormationContext` 调用点仅 1 处（`scribe-runner.ts:219`）。`formation-context.ts:32-34` 的模块注释**自身即声明** `Consumers (2)`。

**它缺的只是一个 adapter 调用**——resolver 本身**不是 Scribe 专用**：`FormationContextResolverParams`（`:455-473`）只要求 `sourceDreamerArtifactId` + `artifactStore` + `lookupTask` + `emitEvent` + `taskId`，而 Evaluator runner **全部已持有**（`this.artifactStore` / `this.stateManager.getTask` / `this.emitEvent`）。

### 4.3 复用分析：可直接复用 vs 需要新增

| 层 | 结论 |
|---|---|
| **Resolver（取件 + 投影 + 预算 + 降级事件）** | ✅ **100% 直接复用**，零改动 |
| **`lookupFormationTask` 适配器** | ✅ **逐字复用**（`scribe-runner.ts:261-270`：`getTask` → `{taskKind, status, dependencyTaskIds: hydratePITaskRecord(task)?.dependencyTaskIds ?? []}`） |
| **seed id 提取（`dreamerArtifactId`）** | ⚠️ **需新增一个小而纯的 reader**。Scribe 用的是私有 `extractSourceDreamerArtifactId(philosopherContentJson)`（`scribe-runner.ts:78-90`，读**顶层** `sourceDreamerArtifactId`）；Evaluator 手上是 **scribe artifact**，id 嵌在 `sourceTrace.dreamerArtifactId`，**形状不同**，不能直接复用 |
| **`contextHash` 覆盖** | ⚠️ 需把 formation 工件 id 加入 `contextRefs`（Scribe 的作法，`:229-239`），否则 replay/缓存可能命中"早于证据"的 prompt |
| **Prompt 块 + 系统指令** | ⚠️ 新增（形态参照 `FORMATION_EVIDENCE_ADDENDUM`，`scribe-prompt-builder.ts:73-91`） |
| **输出 schema / validator / 决策效果** | ✅ **零改动** |

> ### 种子 id 该取哪一个？（决定接入路径的关键判据）
>
> | 候选来源 | 是否权威 | 判定 |
> |---|---|---|
> | `artificerArtifact.sourceTrace.dreamerArtifactId` | ❌ 模型自填，**未被 `reconcileLineageEcho` 校正**（`artificer-runner.ts:1057-1064` 只校正 `scribeArtifactId`） | 不可作种子 |
> | `scribeArtifact.sourceTrace.dreamerArtifactId` | ✅ **权威**：scribe-runner 经 `reconcileLineageEcho` 用 `_context.sourceDreamerArtifactId` 注入（`scribe-runner.ts:477-500`） | ✅ **推荐种子**。且该 scribe artifact **Evaluator 已经加载并校验过 kind**（`:458-471`），零额外取件 |
>
> ⇒ 选择 scribe artifact 作为种子来源，是**最小改动**同时**最高可信**的方案。本审计据此排除"直接读 artificer sourceTrace"的路线。

> ### P7 检查（No Speculative Abstraction）
> 接入后 `formation-context.ts` 的生产消费者变为 **3 个**，且三者语义不同（写原则 / 写规则 / **判质量**）。这恰好触到 PRI-842 §Option C 记录的"registry 触发条件（≥3 个真实消费者）"边界。
> **本审计明确不因此引入 registry / 全局预算器 / ContextManifest 2.0**：第 3 个消费者的正确回应是**再复用一次现有 resolver**，而不是搭新平面。该触发条件应在 SPEC 中记录为"**仅当实测出现跨 resolver 预算冲突时才重新评估**"。
> 注意第 3 个消费者与另两个的**语义差异是真差异**（消费者是判断者而非生产者），这反而进一步说明"逐边接线"比"统一 registry"更合适。

### 4.4 明确的不可达项：原始 Pain 原文

`resolveFormationContext` **不读取 pain 存储**——它只从 dreamer 工件里读 `sourcePainId`（可选字符串，`formation-context.ts:349`）。全仓 `packages/principles-core/src/runtime-v2/**` 中 **0 命中** `painStore` / `getPainById` / `listPains` / `deadLetterPains`。

⇒ **"原始 Pain 原文"在本层不可达。** 把它列入 Required，会把一次"连接修复"扩大为"新增 pain 解析能力"（违反 P3 Minimal Change Surface 与 Connection-before-Creation）。

**契约裁决：Pain 只作为 provenance 标识符出现；痛感内容由诊断投影的 `rootCause` + `evidence[]` 承载。** 这是一个有意的、有证据支持的降级。

---

## 5. Context Gap Analysis

### 5.1 DC-4a 复核（本审计独立验证，非引用）

PRI-842 登记 `DC-4a: Pain/Diagnosis → Evaluator`，证据指向 `evaluator-prompt-builder.ts:226-244`。本审计逐行复核 `EvaluatorPromptInput`（`:123-134`）与 `buildPrompt` payload 构造（`:227-239`）：

```text
{ taskId, contextHash, sourceArtificerArtifactId, artificerArtifact,
  scribeArtifact, previousEvaluation, hostToolCatalog,
  intentContract?, promptContractVersion }
```

**结论：DC-4a 成立，且比原描述更精确**——不是"缺少 Pain 文本"，而是**整条 formation 证据链（痛感标识 → 诊断根因 → 候选备选）在 Evaluator 处结构性断链**。

### 5.2 可判定 vs 不可判定（精确切分）

| 可判定（当前） | 不可判定（当前） |
|---|---|
| 规则是否忠于原则文本（`intentConsistency`，PRI-703 起以 intentContract 为准） | 原则是否忠于原始痛感 |
| 匹配条件是否过宽 / 过窄（`scopePrecision`） | 该原则是否只是"痛感的一个侧面"，遗漏了根因主项 |
| 测试是否覆盖原则描述的场景（`traceCoverage`） | 被 Philosopher 筛选后**仍存活**的备选是否本应被采用 |
| 规则是否通过确定性回放（`adversarialResult`，机械门） | 规则的"正确"是否服务于一个**本身就被误归因的诊断** |

### 5.3 三类失败模式（供 SPEC 与验证方案共用）

| 类别 | 描述 | 当前是否可被 Evaluator 发现 |
|---|---|---|
| **F-a 归因偏差** | 诊断本身归因错误 → 原则 → 规则全部忠于一个错误的根因 | ❌ 不可 |
| **F-b 原则覆盖不足** | 诊断正确，但原则只覆盖了 pain 的次要面 | ❌ 不可 |
| **F-c 规则实现错误** | 原则正确，规则实现不符合原则 | ✅ 可（`codeReview` + 回放门） |

> **关键**：F-a / F-b **不会**被现有机械回放门捕获——PRI-841 实测三臂 **11/11 全 PASS（fp=0 / fn=0）**，回放门在该层**已饱和、区分度为零**。这意味着当前缺口不是"少一层保险"，而是**一个没有任何消费者覆盖的判定维度**。

### 5.4 DC-4b / DC-2 / 自举风险的边界（本审计立场）

| 事项 | 立场 |
|---|---|
| **DC-4b**（Evaluator → Principle 回写） | **明确 OUT of scope**。原则修订只经 rollout → Scribe 窄路（`revision-reopen.ts:168-171`）。PRI-842 标记 `OPEN by design（治理语义，勿轻动）`。本审计的契约把该边界写进 prompt 指令（§6.4），使其成为**契约的一部分**而非口头约定 |
| **DC-2**（被否候选索引） | **依赖登记，不作要求**。该语义全仓无落盘字段，伪造一个 derived 版本会让 Evaluator 以为自己知道"什么已被否决"（正是 `formation-context.ts:216-220` 反复警告的 reading-aid ≠ authority 陷阱）。现有 formation 投影已携带"do NOT revive a proposal the critique explicitly rejected"的指导 |
| **判官自举风险** | formation context（**独立于自生成 goldenTraceCases 的诊断证据**）**降低**但不**消除**该风险。契约必须显式要求降级条款（D-2） |

---

## 6. Evaluator Context Contract（Phase 4 — 需求定义，非实现）

判断问题：**"给定启动本 formation 的真实 Pain 与 Diagnosis，该 Rule（a）是否忠于 Principle，且（b）Principle 是否真的回应了 Pain？"** 只有服务于该问题的信息才被允许进入。

### 6.1 Required Context

| 字段 | 来源 | 为什么必须 | 实测体量（MEASURED，见 §6.1.1） |
|---|---|---|---|
| `sourceDiagnosis.rootCause` | `diag_router` 工件 | **痛感内容的唯一可用载体**（§4.4）；判 F-b 的直接输入；DC-4a 的全部意义 | 每字段 ≤400 字符 |
| `sourceDiagnosis.evidence[]` | 同上 | 让 F-b 判定**有证据锚点**而非印象（Evidence-First 方向） | ≤8 条 × ≤400 字符 |
| `sourceDiagnosis.violatedPrinciples[]` | 同上 | 显式给出"这条痛违反了哪条既有原则"；判"新原则是否与既有原则冲突"的锚 | ≤8 条 × ≤400 字符 |
| `provenance.sourcePainId` | dreamer 工件 | 可追溯性：Evaluator 的结论可被 Owner 反查 | 极短 |
| `provenance.sourceDreamerArtifactId` / `sourceDiagnosisArtifactId` / `lineageArtifactIds` | resolver | 让 `concerns` 可携带**可验证引用**（"对比诊断 X 的 rootCause…"）而非空泛判词 | id 级 |
| `dreamerProposals[]`（仅作"有 N 个备选存活"这一**事实**） | dreamer 工件 | 判"是否过度收窄到单一实现路径"需要知道存在过备选 | 见下 |
| （已持有，保持权威）Rule artifact · Principle 文本 · intentContract | 现状 | formation context 是**追加**，不是替换；既有锚点仍是 `intentConsistency` / `scopePrecision` 的第一顺位判据 | — |

#### 6.1.1 MEASURED —— 真实 formation block 体量

> 方法：真实 dreamer 工件内容（PRI-841 dataset 恢复）+ `a07981c9` 构建的**真实** `resolveFormationContext`，仓库外只读探针 `D:/pd-probe-pri843/measure-formation.mjs`。

| 族 | 解析候选数 | 序列化字符 | 其中 proposals | 估算 token | 占 8,000 帽 | 占 50,000 硬帽 |
|---|---|---|---|---|---|---|
| F1-pain20-ep002r4 | 5 | **2,073** | 1,577 | ~518 | 25.9% | **4.15%** |
| F2-pain18-manual | 5 | **2,530** | 2,018 | ~633 | 31.6% | **5.06%** |

- 诊断缺失（本机无诊断工件内容，探针降级并产出可观测 note `dreamer task … not resolvable — diagnosis not attempted`）。
- 加上诊断块的真实上限 3,500 字符后，**最坏情形约 6,000 字符 ≈ 50,000 硬帽的 12%**。
- 探针同时验证 `serializePromptInput`：48,000 字符 → OK；50,001 字符 → **抛 `RangeError: prompt input exceeds 50000 characters`**。

**结论：token 不是本变更的主要约束。** 8,000 帽对真实 formation 有 ≥2.5× 余量；50,000 硬帽有 ≥8× 余量。**但这不解除 D-3**：硬帽是**抛错**边界而非截断边界，必须显式登记。

### 6.2 Optional Context（提升质量；预算紧张时可先丢）

| 字段 | 为什么可选 | 代价 |
|---|---|---|
| `dreamerProposals[].badDecision / rationale / riskLevel / confidence` | 承载"具体的失败模式"，可提升 `scopePrecision` 判定的具体度 | 已含在候选投影内 |
| `dreamerContextRefs` | 是引用不是内容；总帽紧张时**第一个被丢弃**（`enforceTotalBudget` 步骤 2） | 0 |
| `truncationNotes` | 让 Evaluator 知道**自己的输入是否被预算裁过**——"不要对已丢失的证据下结论"的前提 | 极小 |
| 原始 Pain 原文 | **当前不可达**（§4.4）。若未来证明其有独立边际价值，可再评估 | 需新增 pain 解析能力 ⇒ 超出本变更 |
| `previousEvaluation` / `hostToolCatalog` | 已存在，与本契约正交 | 0 |

### 6.3 Forbidden Context（明确禁止进入）

| 禁止项 | 原因 |
|---|---|
| **全量 artifact dump** | 违反有界投影契约与 8,000 帽约束；token 浪费；更糟的是会把 Evaluator 从"评审者"变成"重跑者"——它会开始重做 Philosopher 的语义收敛，产出与上游不一致的**第二判断** |
| **Philosopher 全文二次注入** | 已通过 `scribeArtifact` 间接持有其结论；重复注入制造两个真相源（违反 P4） |
| **历史 evaluation / 跨 formation 记忆** | 属 Learning 契约（DC-5 / ND-3），是独立 initiative；此处引入会让"同一 profile 的重复评审"产生不可复现漂移 |
| **Owner 原始会话 / 非 formation 记忆** | 超出 PD 的证据边界，会造出一条**无主的**证据通道 |
| **被 Philosopher 批判否定的候选标记** | 该语义**尚未落盘**（DC-2 OPEN）。伪造 derived 版本违反 reading-aid ≠ authority |
| **任何回写边（Evaluator → Pain / Principle / Rule）** | 即 DC-4b，治理语义，勿轻动 |
| **Owner 身份 / 审批状态 / 激活状态** | 破坏 Evaluator"只判质量、不判治理"的边界 |
| **任何使 Evaluator 可基于 intentContract 不可派生的理由改写 / 拒绝的通道** | 即"禁止把 formation 证据转化为决策权威变更或 Principle 写入"——这是 DC-4a 保持**只读富化**的守门条款 |

### 6.4 Contract 与输出面的唯一对齐方式（本审计的核心建议）

Evaluator 的输出面（`evaluator-output.ts:95-113`）**没有"pain 忠实度"字段**：

```text
decision: approved | needs_revision | rejected
summary / score / strengths / concerns[] / requiredChanges[]
(+ 修复轮: priorRequirementStatuses / requirementLedger)
```

且 prompt CONSTRAINTS 硬性要求 **`needs_revision` ⇒ `requiredChanges` 至少一条**（`evaluator-prompt-builder.ts:205`）。因此契约只有三种落法，**SPEC 必须显式选一种**：

| 方案 | 落法 | 后果 | 建议 |
|---|---|---|---|
| **A** 只入 `concerns` | 非阻断观察 | 零死循环风险；但无法阻止"方向错误的规则"被 approved | ⚠️ 保守可用 |
| **B** `concerns`（必带引用）+ 新的 decision-capable 人工复核 reason code | 复用 `deriveGovernanceEffect` 先例：检测到 pain-faithfulness 缺口 → `needs_human_review` + 新 reason code | **正确形状**：把"机器修不了"升级为"Owner 裁决"，与 `evaluator_test_out_of_scope` 同构 | ✅ **本审计推荐** |
| **C** 直接写入 `requiredChanges` | 播种 artificer repair | ❌ **结构性死循环**（§1.2 D-1） | ❌ **禁止** |

**建议的 prompt 语义条款（方案 A/B 共用）**：

> *「用 formation 证据判断 Principle 是否忠于源 Pain。若检测到 Principle↔Pain 漂移，将其记录为**有证据接地**的 `concern`（点名诊断 / pain 引用）——**不要**要求重写 Principle，**不要**把 `requiredChanges` 扩展出 Rule 自身的契约之外。修改 Principle 仍是 Owner / Scribe 的决定。当 `sourceDiagnosis` 缺失或可疑时，降低结论强度并说明原因，**不得**据此拒绝。」*

这条同时是**反 scope-creep 守门条款**与 **D-2 降级条款**，形态镜像 `scribe-prompt-builder.ts:85-90` 已被验证的写法。

> 方案 B 需要一个**新增的 reason code 常量**（`owner-review.ts:37-56` 的 `HUMAN_REVIEW_REASON`，并加入 `DECISION_CAPABLE_HUMAN_REVIEW_REASONS` :61-67）。这**不是** new schema / new authority：解析侧本就接受任意非空串（前向兼容），且是纯新增枚举值。**但它是可观察的治理面变化，SPEC 必须显式声明**（§8 的 `NEW_PERMISSION` 判定依赖于此）。

---

## 7. Minimal Integration Point（Phase 5）

> 只列改动点，不预实现。整体镜像 Scribe 接线，逐一对应。

| # | File | Reason | Risk |
|---|---|---|---|
| **1** | `formation-context.ts` | 新增**一个纯读取器** `readDreamerArtifactIdFromScribeArtifact(contentJson)`：从已解析的 scribe artifact 读 `sourceTrace.dreamerArtifactId`（`Object.hasOwn` + `typeof` / `Array.isArray` 守卫，绝不 `as`）。归属此文件而非 evaluator，因为"从哪个上游标识符启动 formation 解析"是本模块的语义职责 | **低**。与 `scribe-runner.ts:78-90` 的既有私有 `extractSourceDreamerArtifactId` **形状不同**（那条读 philosopher 顶层字段）；SPEC 需明确命名/归属，避免出现第二个同名私有实现（P4）。把 scribe 的私有版本一并收敛进来会扩大 PR 表面积 ⇒ **只登记为 follow-up** |
| **2** | `evaluator-runner.ts` `buildContext()`（:416-497） | 镜像 `scribe-runner.ts:219-227` 调用现有 `resolveFormationContext({sourceDreamerArtifactId, artifactStore, lookupTask, emitEvent, taskId})`；`formationContext` 放入 `EvaluatorContext` | **中**。① 每次 buildContext 增加 2–4 次 store/task 读取（可接受，Scribe 同构）；② `sourceDreamerArtifactId` 缺省时**必须**走 `undefined` 分支（resolver 契约保证永不抛错）；③ 降级必须发事件（rc-9） |
| **3** | `evaluator-runner.ts` 新增私有 `lookupFormationTask`（约 6 行）+ `contextRefs`（:473-475） | 提供 `FormationTaskView` 供诊断前驱查找；并把 `formationContext.provenance.sourceDreamerArtifactId` / `sourceDiagnosisArtifactId` 加入 `contextRefs` | **中（本审计与并行审计一致认为这是首要实施风险）**。若遗漏 `contextRefs`，`contextHash` 不覆盖 prompt 实际承载的证据 ⇒ replay / 缓存可能命中**早于证据**的 prompt。必须逐字镜像 Scribe `:229-239`。辅助类型定义无新增风险 |
| **4** | `evaluator-runner.ts` `buildEvaluatorPrompt()`（:622-653） | 透传 `formationContext` 给 prompt builder | **低**（纯参数传递） |
| **5** | `evaluator-prompt-builder.ts`（输入 `:6-47` / `:123-134` / `buildPrompt` `:223-247`） | ① 输入增可选 `formationContext`；② **条件注入**（`...(x !== undefined ? {formationContext: x} : {})`），保证缺证据时 payload 与现 v4 形态**字节等价**；③ system prompt 追加 `EVALUATOR_FORMATION_EVIDENCE_ADDENDUM`；④ `EVALUATOR_PROMPT_CONTRACT_VERSION` **v4 → v5**（`:219`） | **中**。**这是唯一改变模型行为的点**，必须以「addendum 文本冻结 + 版本 bump + 字节等价回归」三件套保护（PR #1756 已验证两次的纪律） |
| **6** | `evaluator-runner.ts` `postFetchTransform`（:2200-2209） | **可选**：用新解析出的权威 dreamer id 校正输出的 `sourceTrace.dreamerArtifactId` echo | **低**。属 provenance **加强**（消除一个既有的模型自填无校验通道），非新增权威。可并入本变更，也可单独 follow-up |
| **7** | `owner-review.ts` `HUMAN_REVIEW_REASON`（:37-56）+ `DECISION_CAPABLE_HUMAN_REVIEW_REASONS`（:61-67） | **仅当契约选方案 B**：新增一个 decision-capable reason code | **低**（纯新增常量，解析侧前向兼容），但**治理语义变化必须显式声明** |

### 明确不修改

`EvaluatorOutputV1/V2` schema · `DefaultEvaluatorValidator` · `reconcileLineageEcho` 既有规则 · `maybeSeedArtificerRepair` · `deriveGovernanceEffect` 既有分支 · `evaluateRefinerRuleHostGate` · RuleHost / RuleContextV2 · activation / approval 路径 · `runtimeAdapter.startRun` 契约 · feature flag 表 · **不新增跨包依赖**（全部留在 `principles-core/internalization` 内）。

### 实施边界判定

```text
实际改动文件   = 2（evaluator-runner.ts / evaluator-prompt-builder.ts）
              + 1（formation-context.ts，仅一个纯读取器）
              + 1（owner-review.ts，仅方案 B）
新增公开抽象   = 0（复用 FormationContext）
新增子系统     = 0
新增 schema    = 0
新增 flag      = 0
新增跨包依赖   = 0
```

---

## 8. Validation Plan（Phase 6 — 设计，不执行）

### 8.1 Replay Test（A/B，核心效力证明）—— 镜像 PRI-841 方法

**设计**：固定同一条 Rule / Principle / intentContract / 模型 / 配置（temperature 0、同一 maxTokens 与 reasoning profile）；**唯一变量 = Evaluator 的 formation context 是否存在**。

| 臂 | Evaluator Context | 代码树 |
|---|---|---|
| **A（对照）** | 当前 main 形态（v4 prompt） | `fb397452` |
| **B（处理）** | A + 真实 `resolveFormationContext`（v5 prompt + addendum） | SPEC 提交 |

**样本**：复用 PRI-841 已恢复的 2 个真实族（F1-pain20-ep002r4 / F2-pain18-manual）+ 其 16 个历史 artificer 工件（生产修复环产出，含已知回放结论），使 A 臂历史锚点可直接对照。PRI-841 已为此留下完整 harness（`D:/pd-labs/pri841/{head,pre1756}` 两棵自建 dist、`dataset.json`、`runs/` 断点续跑、`judge.mjs` / `judge-b.mjs` 双判官盲评）——**A 臂即现成基线**，本任务只需新增 B 臂。

**指标**：

| 指标 | 层 | 定义 | 期望方向 |
|---|---|---|---|
| `approval accuracy` | 判官 + 真值 | 应被批准的规则中被批准的比例 | ↑ |
| `rejection accuracy` | 判官 + 真值 | 应被拒绝 / 修订的规则中被识别出的比例 | ↑ |
| **`evidence grounding`** | **机械可测** | `summary` / `concerns` 中引用了诊断 `sourceRef` / `rootCause` 片段（而非复述原则文本）的比例 | A 臂应≈0（无证据可引），B 臂应显著 >0 |
| `false approval` | 机械 + 判官 | F-a / F-b 类缺陷规则被 approved 的比例 | ↓ |
| **`false rejection`** | 机械 + 判官 | 正确规则被 needs_revision / rejected 的比例 | **必须不上升**（本变更的主要伤害面，也是反 scope-creep 守门条款的证明） |
| 决策分布漂移 | 机械 | approved / needs_revision / rejected 比例变化 | 需显式报告（漂移本身是发现，不是故障） |
| token 成本 | 机械 | `usage` 差分 | 预期 +500–1,500 token（§6.1.1 外推） |
| 分歧仲裁 | 人工 | 与 PRI-841 同法（B>A / C>B 三元组人工裁定） | — |

> **测量前提（必须先解决的诚实边界）**：`approval accuracy` 若不锚定真值就不可测。可用真值来源按可信度排序：
> 1. **Owner verdict override 历史**（Owner 曾在 `needs_human_review` 上做过 `accept_current` / `revise_once` / `reject_current`）——真实人工标签；PRI-841 的 dataset 提取脚本已在恢复同类数据，成本低；
> 2. 双独立判官家族（glm 同族 + Qwen3.8-27B 本地独立）——**仅方向证据**，不可当真值；
> 3. **若无 Owner 标签，只报告 `evidence grounding` 与 `false rejection` 两个机械指标，不得宣称 accuracy 提升。** 这是本审计主动声明的边界。

### 8.2 Regression（必须全绿）

| 面 | 断言 |
|---|---|
| **字节等价（无 formation 时）** | pre-formation scribe artifact（无 `sourceTrace.dreamerArtifactId`）⇒ resolver 返回 `undefined` ⇒ message 与今日 v4 形态**逐字节一致**（仅 `promptContractVersion` 串变）。复用既有 `evaluator-prompt-builder.test.ts` / `-v2.test.ts` golden fixtures |
| **决策稳定性** | 原则**确实**服务了痛感的案例，decision / score **不得**相对 A 臂翻转（formation context 不得"制造拒绝"） |
| **contextHash / replay** | formation 证据变化必须使缓存 prompt 失效（§7 第 3 行的 Medium 风险），需定向测试 |
| **预算** | Evaluator payload 中序列化 formation block ≤ 8,000 字符；`truncationNotes` 可观测；**并补一条"最大真实 payload + 最大 formation block 仍 < 50,000"的边界测试**（D-3） |
| **降级路径** | dreamer 缺失 / 诊断缺失 / store 抛错 / `contentJson` 非法 四种情形 ⇒ `undefined` 或部分上下文 + 可观测事件，**绝不抛错、绝不阻断 evaluator run** |
| **确定性** | 同一输入两次 `buildEvaluatorPrompt` 产出逐字节一致 |
| **Owner approval** | `buildOwnerDecisionReview` 输入形状不变；既有 reason 的分类行为不变（方案 B 的新增 reason 需 SPEC 确认） |
| **Activation** | `promotion-readiness-evaluator` 与 `activation/*` 零改动；建议加"activation 决策输入不含 formation 证据"的守卫测试 |
| **RuleHost** | golden trace 生成 / `evaluateRefinerRuleHostGate` / `RuleContextV2` 零改动 |
| **既有关键测试** | `evaluator-gate-authority.test.ts` · `evaluator-out-of-scope-governance.test.ts` · `rule-host-evaluator.test.ts` · `evaluator-gate-wiring-guard.test.ts` · `evaluator-runner-vslice*.test.ts` 全绿；`verify:merge` 门禁通过 |

---

## 9. Governance Impact（Phase 7）

| 检查项 | 判定 | 证据 |
|---|---|---|
| **SECOND_AUTHORITY** | **NO** | 全部新增信息仅进入 prompt。`formation-context.ts:27-30,216-220` 明确声明投影是 reading aid 不是 authority；`rankCandidates` 不与 Philosopher critique 竞争权威（"do NOT revive a proposal the critique explicitly rejected"）；证据单一权威仍在 `diag_*` / dreamer 工件 |
| **SECOND_STORE** | **NO** | 零新增持久化。resolver 只读 `pi_artifacts` + task 行；产出物不落盘（仅进 prompt 与事件） |
| **NEW_SCHEMA** | **NO** | `EvaluatorOutputV1/V2` / `ArtificerRuleOutput` / `ScribeOutputV1` / `FormationContext(v1)` 全部不变。prompt payload 是 wire 形态而非 schema（无 validator 读取） |
| **NEW_FLAG** | **NO** | 沿用 PR #1756 的**无 flag** 模式："可解析即注入，不可解析即降级 + 事件"。evaluator-runner 不引入 flag 读取 |
| **NEW_PERMISSION** | **NO** | 不触 approval / activation / Owner verdict 的授权面。**唯一需 SPEC 裁定的例外**：方案 B 新增一个 human-review reason code，使 Owner **多一个可裁决入口**——这不是权限扩张（Owner 本就可裁决所有 `needs_human_review`），但属可观察的治理面变化，必须记录 |
| **NEW CROSS-PKG DEP** | **NO** | 全部留在 `principles-core/internalization` 内 |
| **Owner Authority 变化** | 零 | 审批流输入不变 |
| **Runtime Governance 变化** | 零 | RuleHost / RuleContextV2 / deterministic gate 不触 |
| **双 pipeline？** | 无 | 同一 runner、同一 schema、条件扩展；缺证据时回退现形态 |
| **P4（One Source of Truth）** | 维持 | formation 证据单一来源仍是 `pi_artifacts`；Evaluator 只是新增一个**只读派生消费者** |

```text
SECOND_AUTHORITY = NO
SECOND_STORE     = NO
NEW_SCHEMA       = NO
NEW_FLAG         = NO
NEW_PERMISSION   = NO
```

**Complexity Delta**：新增公开抽象 = NO；新增子系统 = NO；新增权威 = NO。净复杂度 = 两个文件里"已被验证两次的接线"的复制。**拒绝本修复才会带来负 delta**——那会让全链最大已登记未满足契约（PRI-842 "最大缺口"）继续悬空。

---

## 10. Recommendation

### 10.1 结论

**接入，但契约形态必须由 SPEC 显式裁定三件事（D-1 归因路由 / D-2 判官自举 / D-3 prompt 硬帽）。**

推荐组合：
> **Required = 诊断投影 + provenance + 候选事实；落点 = `concerns`（必带可验证引用）+ 可选新 decision-capable reason code；`requiredChanges` 明确禁止承载原则级缺陷；全链只读，零回写。**

### 10.2 SPEC 必须携带的三条不可协商约束

1. **只读接地（Read-only grounding）**：formation context 只影响忠实度判断与 `concerns` 措辞，**不得**创建或暗示 Evaluator → Principle 的写入边（DC-4b 保持治理保护）。
2. **`contextHash` 覆盖**：formation 工件 id 必须加入 context refs（镜像 Scribe），否则 replay / 缓存会送出早于证据的 prompt。
3. **契约版本 + 向后兼容纪律**：bump `EVALUATOR_PROMPT_CONTRACT_VERSION`（v4→v5）；无 formation 时 payload 保持**字节等价**；prompt 必须守卫"formation context 不得在原则已服务痛感的案例上制造拒绝"。

（本审计追加第 4 条）：**硬帽边界回归**——`serializePromptInput` 的 `RangeError` 不得成为唯一失败路径。

### 10.3 建议推进次序

| 序 | 动作 | 理由 |
|---|---|---|
| 1 | **Owner 裁决本审计**（§1.2 三项 + §6.4 方案 A/B/C） | 契约语义必须先定，再动任何代码 |
| 2 | 立 SPEC（一条：Evaluator Formation Context） | 参照 PRI-838 SPEC 的粒度 |
| 3 | 实现 §7 的 1–5 项（6 可选；7 若选方案 B） | 一次取件 + 一个条件块 + 一次版本 bump |
| 4 | 复用 PRI-841 lab 跑 A/B（**先只报机械指标**） | 协议层证据先行；accuracy 需 Owner 标签 |
| 5 | 登记 follow-up：三处私有 `clamp` 收敛（PRI-842 MVP-3）· `extractSourceDreamerArtifactId` 双实现收敛 | 不并入本 PR（P3） |

### 10.4 明确不做（记录，非现在建设）

- ❌ **Registry / 全局预算器 / ContextManifest 2.0**：第 3 个消费者出现**不构成**建设理由（PRI-842 §Option C 已量化）。触发条件保持"**实测跨 resolver 预算冲突**"。
- ❌ **原始 Pain 原文注入**：本层不可达（§4.4）。需先证明边际价值。
- ❌ **DC-4b（Evaluator → Principle 回写）**：治理语义，勿轻动。
- ❌ **DC-2（Philosopher 落盘被否候选）**：需跨边界 schema 变更；候选集已部分代偿。**契约中不得伪造该语义。**
- ❌ **DC-5 / ND-3（Learning 契约）**：独立 initiative。
- ❌ **恢复旧 ContextManifest 平面 / `progressive_evaluator` 两阶段**：PRI-819 R-06 已退役，PRI-835/842 明确排除。

### 10.5 开放问题（交付给 SPEC，本审计内不解决）

| # | 问题 | 为什么本审计无法回答 |
|---|---|---|
| **Q-1** | 生产环境下 `artificer.sourceTrace.dreamerArtifactId` 的填写率是多少？ | 本机 `.pd/state.db` 为空。该字段**未被 `reconcileLineageEcho` 校正**（`artificer-runner.ts:1057-1064` 只校正 `scribeArtifactId`），因此可能缺失或不可靠。**这是接入路径选择的决定因素**——本审计据此选择 scribe 侧的权威 id 作为种子（§4.3），但填写率仍需生产数据确认 |
| **Q-2** | Owner 标签（verdict override 历史）能否构成足够规模的 ground truth？ | 需生产数据；PRI-841 的 dataset 恢复脚本可复用，但需在实验室重跑 |
| **Q-3** | Evaluator 单次真实 prompt 的字符数分布？ | 同上，无本机生产数据。§6.1.1 只能给出 formation block 一侧的实测 |

---

## 附录 A — 证据锚点（file:line）

| 主题 | 锚点 |
|---|---|
| Evaluator context 组装 | `evaluator-runner.ts:416-497`（`buildContext`）· `:430-440`（artificer 依赖）· `:444-452`（artificer 工件）· `:458-471`（scribe 工件 + kind 校验）· `:473-475`（contextRefs）· `:478-490`（修复轮） |
| Evaluator prompt | `:499-512`（`invokeRuntime`）· `:622-653`（`buildEvaluatorPrompt`）· `evaluator-prompt-builder.ts:6-47` / `:123-134` / `:223-247`（`buildPrompt`）· `:205`（needs_revision ⇒ requiredChanges 非空）· `:211`（dreamerArtifactId 约束）· `:219`（版本常量） |
| prompt 硬帽 | `prompt-serializer.ts:1`（`MAX_PROMPT_CHARS = 50_000`）· `:49-51`（抛 `RangeError`）· `pitask-metadata.ts:229`（历史 incident 记录与有界回喂理由） |
| 抛错语义 | `base-peer-runner.ts:325`（buildContext）· `:330`（invokeRuntime）· `:381`（通用 catch）· `:575-619`（`classifyError` → `retryOrFail`） |
| Scribe formation 接线（**复用模板**） | `scribe-runner.ts:219-227`（resolver 调用）· `:229-239`（contextRefs）· `:261-270`（`lookupFormationTask`）· `:78-90`（私有 `extractSourceDreamerArtifactId`，读 philosopher）· `:477-500`（`dreamerArtifactId` 权威注入） |
| Scribe addendum（形态模板） | `scribe-prompt-builder.ts:73-91`（`FORMATION_EVIDENCE_ADDENDUM`）· `:85-90`（反 scope-creep + 降级条款）· `:110` · `:189-198`（v3→v4 纪律）· `:236`（裸 `JSON.stringify`，无硬帽） |
| Artificer formation 接线 | `artificer-runner.ts:44`（import）· `:308-315`（`projectDreamerProposals`）· `:1057-1068`（**仅**校正 scribeArtifactId）· `artificer-prompt-builder.ts:26-39` |
| Resolver 契约 | `formation-context.ts:32-34`（consumers = 2）· `:45-75`（预算常量）· `:65`（8,000 总帽）· `:216-220`（reading aid ≠ authority）· `:289-353`（dreamer 投影）· `:362-444`（诊断投影）· `:455-473`（resolver 参数）· `:513-597`（`enforceTotalBudget` 降级顺序）· `:609-681`（`applyBudget`）· `:688-702`（`resolveDiagnosisDependency`）· `:770-777`（provenance）· `:810-822`（**永不抛错**） |
| 治理先例 | `evaluator-runner.ts:1901-1948`（`deriveGovernanceEffect` → `evaluator_test_out_of_scope`）· `:1950-2075`（`maybeSeedArtificerRepair`）· `:2193-2213`（`postFetchTransform`）· `owner-review.ts:37-67`（reason 词表 + decision-capable 集） |
| 无原则修订通路 | `revision-reopen.ts:168-171`（`kind: 'scribe' \| 'artificer'`，rollout 触发） |
| 输出面（无 pain 忠实度字段） | `evaluator-output.ts:95-113`（`EvaluatorEvaluation`）· `:115-120`（`EvaluatorSourceTrace`） |
| Pain 不可达 | `formation-context.ts:349`（只读 `sourcePainId`）；`packages/principles-core/src/runtime-v2/**` 中 `painStore` / `getPainById` / `listPains` / `deadLetterPains` = **0 命中** |
| 流水线拓扑 | `internalization-job-graph.ts:36-40`（`artificer→evaluator`）· `:99-103`（diag 阶段链） |
| 两阶段已退役 | `evaluator-runner.ts:500-501` |

## 附录 B — MEASURED / ESTIMATED / NOT_MEASURED

| 项 | 类别 |
|---|---|
| Baseline SHA · PR #1756 ancestor 校验 · 全部 file:line 锚点 | **MEASURED** |
| formation block 真实体量（2,073 / 2,530 字符；518 / 633 token；**4.15% / 5.06%** 硬帽） | **MEASURED**（真实 dreamer 工件 + `a07981c9` 真实 resolver，仓库外只读探针） |
| `serializePromptInput` 硬帽行为（48,000 OK / 50,001 THROWS `RangeError`） | **MEASURED** |
| 诊断块加入后的最坏体量（≈6,000 字符 / ≈12% 硬帽） | **ESTIMATED**（上限相加；本机无诊断工件内容） |
| 接入后 token 增量（+500–1,500） | **ESTIMATED**（由 block 体量外推） |
| A/B 质量指标（approval / rejection accuracy、false approval / rejection） | **NOT_MEASURED**（设计已给出，未执行；且缺 ground truth 时不可测 — §8.1） |
| 生产 `artificer.sourceTrace.dreamerArtifactId` 填写率 | **NOT_MEASURED**（本机无生产库 — Q-1） |
| 生产 evaluator prompt 字符数分布 | **NOT_MEASURED**（同上 — Q-3） |

## 附录 C — 纪律声明

```text
CODE_CHANGES       = NONE（仓库内唯一新增 = 本报告文件）
TESTS_ADDED        = NONE
PRODUCTION_DB      = 未写入（本机 .pd/state.db 为只读空库探查，零写操作）
ARTIFACTS          = 未修改
CONFIG / FLAG      = 未修改
OWNER / GOVERNANCE = 未修改（approval / activation / RuleHost / Owner authority 全未触）
EXTERNAL_WRITES    = NONE（探针脚本位于仓库外 D:/pd-probe-pri843/，只读 lab 树）
PR                 = NONE
LINEAR             = NONE（按任务指令不建单）
```

---

## Final Verdict

```text
PRI_843_RESULT = READY_FOR_SPEC

条件核对：
  ✅ 已找到真实入口    —— EvaluatorRunner.buildContext (evaluator-runner.ts:416)
                        → buildEvaluatorPrompt (:622)
                        → EvaluatorPromptBuilder.buildPrompt (evaluator-prompt-builder.ts:223)
                        函数级、可引用、可测。
  ✅ Context Contract 明确 —— Required / Optional / Forbidden 三分类已定义（§6），
                        并给出与输出面唯一对齐的落点建议（§6.4）。
  ✅ 实施边界清晰      —— 2（+2）个文件、同一包、1 个新纯函数、0 schema、0 flag、
                        0 新跨包依赖（§7）。

未阻断但必须由 SPEC 裁决：
  D-1 归因路由 —— pain-faithfulness 缺陷不得进入 requiredChanges（唯一下游只能改规则，
      会构成结构性死循环）；走 concerns + 可选新 decision-capable reason code，
      复用 evaluator_test_out_of_scope 先例。
  D-2 判官自举 —— 诊断是证据不是真理；须有降级条款，且不得单独导致 rejected。
  D-3 prompt 硬帽 —— 复用现有 8,000 帽不新增预算机制；补 RangeError 边界回归。

判定：证据充分到可以立 SPEC，但契约的语义选择（§6.4 方案 A/B/C）不能由审计代决。
```
