# PRI-858 Owner Decision Context Audit

> 只读架构调查。遵循 Consumer-driven Context Contract：只寻找"已有信息 → 消费断链"，
> 不假设 ContextManifest / Global Context Pool / Memory System / Registry。
> 本报告不伴随任何代码/配置/UI 修改。

## Executive Summary

**PRI-858 确认了真实断点。** Owner 决策评审（`buildOwnerDecisionReview`）在血缘 BFS 中
**已经把诊断工件（含 `diag_*`）连同 contentJson 一起取进内存**，但对 Owner 只呈现祖先
工件的 `taskKind` 名单；`rootCause / violatedPrinciples / evidence / sourcePainId` 一律
不进入决策快照、不进入决策卡。该断链与 PRI-843 修复前的 Evaluator 断点同构，且比它更
刺眼：PRI-846 已经让 Evaluator 依据 formation 证据产出 `[principle_pain_mismatch]`
concern 并把任务路由给 Owner——**Owner 收到的正是"原则不忠于 pain"的裁决请求，却被剥
夺了裁决所依据的 pain/diagnosis 证据本身**。

- `PRI_858_RESULT=SPEC_REQUIRED`
- 建议 SPEC 范围 = CIL-002 + CIL-003（PRI-855 已合并登记），复用
  `resolveFormationContext()` / `FormationDiagnosisProjection` 现成契约，
  纯观测投影，不触碰 capability/completeness 权威。
- VERIFIED=9 · INFERRED=3 · UNKNOWN(NOT VERIFIED)=3

## Baseline

```text
BASE_SHA        = 47946c16cf6dbf88234c03b1038c401aea4fde86
current branch  = main (up to date with origin/main)
origin/main SHA = 47946c16cf6dbf88234c03b1038c401aea4fde86
```

| 票 | 是否在 main | 证据 |
|---|---|---|
| PRI-843 | 审计文档存在（本报告写作时 `docs/audit/PRI-843-evaluator-context-contract-audit.md` 为未跟踪文件）；main 提交历史中无 `PRI-843` 字样提交 | `git log main --grep=PRI-843` 空。**UNKNOWN**：其 Linear 状态；其技术结论经 DC-4a 由 PRI-846 落地 |
| PRI-846 | **IN** | `ce788eb4 feat(pri-846): connect evaluator to formation context (DC-4a)`、merge `ac41ef6e` |
| PRI-855 | **IN** | `e7f97a73 docs(pri-855): add context intelligence layer coverage audit`、merge `47946c16` |
| PRI-859 | **NOT IN main** | `dabbf387a fix(pri-859)…` 仅在 `ai/PRI-859-artificer-context-hash-lineage`（`git merge-base --is-ancestor` 失败）；即 CIL-001 修复尚未落地 main |

## Evidence Rules

- **VERIFIED**：file:line + 调用链 +（有则）测试/数据证据；
- **INFERRED**：显式以 `Inference:` 开头，不写成事实；
- **NOT VERIFIED**：无法确认的，明确标出，不猜测。

## Owner Decision Data Flow（Q1）

```text
Console UI (FocusPage → OwnerDecisionCard)
  ↑ GET /api/v1/governance/owner-decisions
routes/owner-decisions.ts:218
  ↑
OwnerDecisionConsoleModel.listOwnerDecisionItems()      ← .pd/state.db (readonly)
  ├─ SELECT tasks WHERE status='needs_human_review' AND task_kind IN ('evaluator','rollout_reviewer')
  ├─ SqlitePIArtifactStore (pi_artifacts)
  └─ deriveTaskDecisionItem
       ├─ collectOwnerDecisionFacts + deriveOwnerDecisionCapability   (owner-review.js — 权威)
       └─ buildOwnerDecisionReview                                    (owner-decision-review.ts — 展示投影)
            ├─ collectCanonicalArtifacts: 血缘 BFS（decision→artificer→scribe→philosopher→dreamer→diag_*）
            ├─ selectLineageArtifact: 只保留 'artificer' | 'scribe'
            └─ qualityChecklist.evidence: 对其余祖先【只读 taskKind】
resolve 动作: POST /:taskId/resolve → owner-resolution-service.ts:332,422 复用同一 buildOwnerDecisionReview 做 digest/stale 校验
```

### Owner Decision Input Map

| Component | Input | Source | Evidence |
|---|---|---|---|
| `routes/owner-decisions.ts` | `listOwnerDecisionItems()` | `.pd/state.db` tasks 表 NHR 行 | VERIFIED（文件 :218） |
| `OwnerDecisionConsoleModel.deriveTaskDecisionItem` | facts + capability + review snapshot | `collectOwnerDecisionFacts` / `deriveOwnerDecisionCapability` / `buildOwnerDecisionReview` | VERIFIED（:151-179） |
| `buildOwnerDecisionReview` brief(evaluator) | `principleDraft.{title,statement,rationale,applicability}`（scribe）、`implementationSummary/affectedTools/risks`（artificer）、`evaluation.{strengths,concerns,requiredChanges,score}`（decision） | 三工件 contentJson | VERIFIED（owner-decision-review.ts:322-357） |
| qualityChecklist.evidence | 祖先工件 **taskKind 名单** | BFS 已取回的工件（仅 `entry.taskKind`） | VERIFIED（:377-406） |
| `OwnerDecisionCard.tsx` | title/summary/principle.statement/implementation.summary/concerns[0]/checklist/evidence chips/advanced(taskId,reasonCode,requiredChanges,evidence.items) | snapshot | VERIFIED（:132-160, :298-311） |
| 平行未 join 面 A：`EvidenceChainConsoleModel`（Behavior Evidence 页） | `pain_events` 最近 100 条（trajectory.db，按时间排，不按血缘绑定）+ diagnostician tasks + legacy `artifacts` | `.state/trajectory.db`、state.db | VERIFIED（:184-313） |
| 平行未 join 面 B：`OwnerDecisionViewModel`（ledger 键控 inbox/view） | `DiagnosisMaterial{summary,rootCause}` 等 | ledger + pi_artifacts 直读 | VERIFIED（:85-90, :414-420, :488-496） |

## Current Context Availability（Q2）

Owner Decision 对 Formation Context 各要素的可见性：

| 要素 | 结论 | 证据 |
|---|---|---|
| Pain provenance（`sourcePainId`） | **DISCONNECTED** | 存在于 dreamer 工件 content（`formation-context.ts:349` 读取；PRI-841 dataset 实测字段在场，样本值可为 null）；`owner-decision-review.ts` 全文无任何 pain 字段读取 |
| Diagnosis（rootCause / violatedPrinciples / evidence / recommendations） | **DISCONNECTED** | BFS 已取回工件（:226），但仅 :377-380 读 `taskKind`；brief/evidence.items/manifest 无诊断字段（:336-353, :465-493） |
| Root cause 文本 | **DISCONNECTED**（决策卡）| 仅在**另一面**呈现：`OwnerDecisionViewModel.ts:488-496`、`PrincipleDetailPage.tsx` diagnosis stage tab——均按 principleId/ledger 键控，与 pending 决策任务无绑定；决策卡无跳转链接 |
| Principle lineage（工件级） | **CONNECTED（仅存在性）** | BFS 解析出 artificer/scribe 并绑定 digest sources（:476-480）；诊断层仅以 kind 名单出现 |
| Rule lineage | CONNECTED（artificer 工件进 brief） | :330-333 |
| Dreamer 候选集 | **DISCONNECTED** | BFS 可及 dreamer 工件，内容不投影 |

## CIL-002 Verification（Q3）

PRI-855 CIL-002 的判断（"已经读取 diagnosis artifact 但没有投影给 Owner"）在当前 main
**独立复核成立**，按"Source exists + Consumer missing"两段证明：

### Source exists — VERIFIED

- **BFS 遍历**：`owner-decision-review.ts:215-237` `collectCanonicalArtifacts` 从
  `decision.lineageArtifactIds` 起沿 `artifact.lineageArtifactIds` 传递闭包，队列元素经
  `store.getArtifactById`（:226）取回**完整工件（含 contentJson）**；Console 侧适配器
  真实映射 `contentJson`（`OwnerDecisionConsoleModel.ts:126-149`）。
- **血缘写入者**：各 stage 工件统一经 `base-peer-runner.ts:493-517
  resolveLineageArtifactIds` 把**依赖任务的全部工件 id** 写入 lineage
  （dreamer-runner.ts:242-274、scribe-runner.ts:385-414、artificer-runner.ts:958-987、
  evaluator-runner.ts:828-857 同一机制）。任务图 evaluator→artificer→scribe→
  philosopher→dreamer→diag_* 线性可通（PRI-855 Consumer Matrix :68-79 已核，且
  `formation-context.ts:5-9` 模块注释自证"lineage identifiers ALREADY persisted"）。
- **代码自证使用诊断工件**：:377-380 对 `artificerLineage`（以 artificer 工件为根的第二次
  BFS）过滤 `philosopher|dreamer|diagnostician|diag_*` 的 **taskKind**——不取回工件就不可
  能读出这些 kind。**诊断内容在内存中，被丢弃。**
- **数据证据**：PRI-841 真实工件数据集
  `D:/pd-labs/pri841/dataset.json`：dreamer `lineageArtifactIds` 实含
  `pi-art-diag_router-diagnosis_pain_host_…` 工件 id，且同族附
  `resolveFormationContext` 实跑产出的 `formationContext`。本报告写作时只读复核。

### Consumer missing — VERIFIED

- brief 装配（:336-353）字段清单不含任何诊断/pain 内容；
- evidence items（:465-474）仅 `automated_review` + `deterministic_check`；类型联合声明
  了 `provenance`（:19-24）但**全文件从未产出该类别**——一个空着的现成展示槽位；
- `manifest.sources`（:476-480）仅 decision/artificer/scribe 三角色；
- UI 渲染（`OwnerDecisionCard.tsx:132-160,298-311`）无诊断字段；
- 测试锁定的是**负例**：`owner-decision-review.test.ts:256-263` 断言标准链 evidence 项
  fail 且 note 含 `no ancestor artifact resolvable beyond scribe`；全仓无"诊断内容出现在
  snapshot"的正例（因其根本不存在）。

**结论：CIL-002 = VERIFIED（断链机制）。**

Inference: 影响面——Owner 被问"是否接受这条原则"时看不到产生它的 pain；尤其 PRI-846 的
`principle_pain_mismatch` 路由（`evaluator-runner.ts:2063-2083`，且以
`formationContextPresent` 为前置，:2075）使 Owner 收到的 concern 本身就引用了 Owner 无法
查看的证据，形成"机器援引证据、Owner 无法核对证据"的治理不对称。质量提升幅度未测量
（PRI-815/838 的 +85.7pp 是对 Scribe 产出，非对 Owner 裁决）。

## Storage Map（Q6）

| Data | Storage | Producer | Consumer |
|---|---|---|---|
| Pain events | `trajectory.db`.`pain_events`（schema: `trajectory-schema.ts:91`） | `pain-signal-observability.ts:149-188`（宿主观测）、`trajectory-store.ts:208` | `EvidenceChainConsoleModel.ts:184-228`（Behavior Evidence 页）；诊断上下文装配器（PRI-855 :70 引 `sqlite-context-assembler.ts:230-237`）|
| Pain↔diagnosis 关联 | `state.db`.`pain_diagnoses` | `store/pain-diagnosis/pain-diagnosis-store.ts`（canonical_pain_id 逻辑链，无 FK） | 决策面：无（NOT VERIFIED 消费方全集） |
| Diagnosis 工件（diag_rootcause/distiller/router） | `state.db`.`pi_artifacts`（diag-*-runner upsert）+ legacy `artifacts.kind='diagnostician_output'` 双写 | `diag-router-runner.ts:321-330` 等 | owner BFS **取回但只读 kind**；`EvidenceChainConsoleModel.ts:253,312`；`resolveFormationContext` |
| Dreamer 候选 + `sourcePainId` + diag 血缘 | `pi_artifacts` | `dreamer-runner.ts:242-279` | Scribe/Evaluator prompt（resolver）；决策面：无 |
| Scribe 原则文本 + `sourceTrace.dreamerArtifactId` | `pi_artifacts` | `scribe-runner.ts:385-419` | 决策 brief（正文）；dreamer id：决策面**不读** |
| Evaluator verdict/decision 工件 | `pi_artifacts` | `evaluator-runner.ts:828-862` | 决策 brief；rule 工件字段清单（:3192-3212）**无 pain/diagnosis/formationContext**——formation 证据不落盘（PRI-855 结构事实，已复核） |
| 决策读模型 | `.pd/state.db` readonly 连接 | `OwnerDecisionConsoleModel.ts:246-344` | Console API + UI |

## Existing Resolver Reuse Analysis（Q4 / Q7）

### 同构先例（Q7）

- **PRI-843→846（Evaluator）**：`Consumer → resolveFormationContext() → bounded
  projection → prompt`。接线证据：`evaluator-runner.ts:535-542`（从 scribe 权威
  `sourceTrace.dreamerArtifactId` 解析）、`:544-557`（context hash 覆盖实注入证据）、
  `:2075`（formation 证据产生治理效应）。测试：`evaluator-formation-context.test.ts`。
- **PRI-838（Scribe）**、**PRI-839（Artificer 候选集）**同型。
- **PRI-859**（Artificer hash，CIL-001）：分支 `ai/PRI-859-...` 未合入 main。

Owner Decision 可采用**完全相同**的模式：`buildOwnerDecisionReview` 已经选出 scribe 工件
（:305-309），其 content 即含 resolver 唯一入参 `sourceTrace.dreamerArtifactId`——
Consumer、id 来源、投影契约（`FormationDiagnosisProjection`）三样全部现成。

### Candidate Solution Matrix

| 方案 | 修改范围 | 优点 | 风险 |
|---|---|---|---|
| **A. Reuse existing resolver**（在 `buildOwnerDecisionReview` evaluator 分支内，从已选 scribe 工件取 dreamer id → `resolveFormationContext` → 把 `sourceDiagnosis`/`provenance` 经既有 `EvidenceClass:'provenance'` 槽位与 bounded brief 字段投影给 Owner） | 1 个 core 文件 + 1 个 UI 文件 + 测试 | Connection Before Creation（P2.1）；零新抽象/零新存储/零新 flag；预算与降级语义（rc-9、truncationNotes）直接继承 | resolver 需要 `lookupTask`+`emitEvent`：`OwnerDecisionReviewStore` 已有 getTask，emitEvent 需窄适配（read 路径无 emitter——可为 no-op+计数，SPEC 定）；digest 随 brief 变化（见治理节） |
| B. New projection module（Owner 专属诊断投影器） | 新文件+新契约 | 可定制 Owner 视角 | 违反 P7（第二个投影惯用法；formation-context.ts:15-18 明确"mirror its contracts rather than inventing a second idiom"）|
| C. New storage（把 formationContext 落盘进决策工件） | schema + committer + 回放 | 顺带解决"当时模型被展示了什么"的回放归因缺口（PRI-855 结构事实） | 新 persisted state；对当前断点非必需（工件即权威源）；应作为独立 follow-up，不与连接修复捆绑（P3） |

推荐 A；CIL-003（`painReasonSummary` 有读者无写者，`rule-host-writer.ts:395-411`）与 A
同主题，PRI-855 已建议并入同一 SPEC，避免再造第二写入者（P4）。

## Governance Boundary Review（Q5）

- **权威链**：可执行动作集合来自 `deriveOwnerDecisionCapability(facts)`
  （owner-review.js），再经三道确定性门修剪：adversarial hard gate、code-bearing
  artificer、`completeness==='insufficient'`（owner-decision-review.ts:449-463）。
  `collectOwnerDecisionFacts` 不读诊断内容。
- **结论**：诊断投影属于 **Observation Evidence**，与 Authority Source 有清晰边界——
  只要 SPEC 保持：(1) 不改 `completeness` 判定输入；(2) 不改 `allowedActions` /
  `acceptRequirement` 推导；(3) 不把"诊断缺失"升格为新的 accept 禁止门。否则就是把展示
  信息偷渡成裁决权威（禁止项）。
- **stale-binding 交互**：`briefSemanticHash`/`evidence.digest`（:481-494）覆盖 brief；
  列表与 resolve 双端各自重算（`owner-resolution-service.ts:332,422`），同版本代码下自
  洽；部署瞬间在途决策卡可能一次性 409 后自动刷新——rollout 注记，非权威变化。
- **审批激活链**：approvals/activations/RuleCode 条目由独立 authority 派生
  （ConsoleModel :279-338），不受影响。
- **只读富化先例**：PRI-843 hardest constraint（Evaluator 只读证据接地、不产生回写边）
  完整适用于 Owner 面：投影不得生成任何回写 Pain/Principle/Rule 的通道。

## False Positive 排除

- **Case 1（Owner 本不该看）**：不成立。checklist 注释（:359-373）明言其职责是"把判断所
  需的事实放在一起"，且 R3 反例 1 自认 taskKind 名单"不足以宣称证据来源"；PRI-846 mismatch
  路由已把 pain 忠实性问题正式提交给 Owner 裁决。
- **Case 2（点击展开即可见）**：不成立（当前）。决策卡 advanced 折叠区（:298-311）无诊断
  内容，卡片亦无到 Behavior Evidence / Principle detail 的**按决策绑定**链接；平行两面按
  principleId/时间键控，非按 pending taskId。Inference: pending NHR 任务在台账中的
  principleId 覆盖情况未核（见 U3），SPEC 前应确认两面是否已对 Owner 构成可达路径。
- **Case 3（需新增数据采集）**：不成立。全部所需数据已由现有生产者落盘（Storage Map）。
- **Case 4（理论上更多信息更好）**：本发现不依赖该论证——断链有 file:line + 数据 + 既有
  治理路由（mismatch）作为质量证据；但对"投影能提升 Owner 裁决质量"的幅度确属未测量，
  SPEC 应包含观测手段（resolver 事件已现成）。

## Findings

| # | Status | Finding | Evidence |
|---|---|---|---|
| F1 | VERIFIED | 基线：main=47946c16 含 PRI-846/855；PRI-859 不在 main | git merge-base 实测 |
| F2 | VERIFIED | Owner 决策消费链 = route→ConsoleModel→buildOwnerDecisionReview→OwnerDecisionCard；权威在 owner-review.js | 文件行号见 Input Map |
| F3 | VERIFIED | BFS 把 diag_* 工件（含 contentJson）取进内存，随后仅消费 taskKind 名单 | owner-decision-review.ts:221-237, 377-380, 400-406 |
| F4 | VERIFIED | 工件级血缘 dreamer→diag 在生产数据中真实存在（含 formationContext 实跑产物） | PRI-841 dataset.json 只读复核 |
| F5 | VERIFIED | 决策 snapshot/UI 无任何诊断内容出口；`provenance` evidence 类声明后从未产出 | :19-24, 336-353, 465-493; OwnerDecisionCard.tsx |
| F6 | VERIFIED | 测试仅锁负例（标准链 evidence fail），无诊断投影正例 | owner-decision-review.test.ts:256-263 |
| F7 | VERIFIED | PRI-846 使 Owner 收到援引 formation 证据的 mismatch 裁决请求，但证据本身对其不可见 | evaluator-runner.ts:2063-2083 |
| F8 | VERIFIED | 诊断在 Console 的可见面（EvidenceChain / ViewModel）与 pending 决策无绑定 join | EvidenceChainConsoleModel.ts:184-313; OwnerDecisionViewModel.ts:85-90 |
| F9 | VERIFIED | 复用模式先例完整（PRI-843→846 prompt 侧同构；resolver 入参在 review 内已具备） | evaluator-runner.ts:535-542; formation-context.ts:455-473 |
| F10 | INFERRED | Owner 裁决质量影响方向类比 Evaluator（"is the principle faithful to the pain" 无法被核对）；幅度未测量 | 见 CIL-002 复核节 |
| F11 | INFERRED | 方案 A 为最小连贯变更（预计 Complexity Delta 全 NO，emitEvent 窄适配除外） | Connection Before Creation |
| F12 | INFERRED | ViewModel 的 ledger 键控诊断面对 pending 形成中决策大概率不覆盖（ledger 条目在激活/记录后才存在） | 未逐行验证台账写入时机，SPEC 前补核 |
| U1 | NOT VERIFIED | 生产 workspace 中决策 BFS 因 MAX_LINEAGE_ARTIFACTS=16 / 多工件修复轮导致 diag 截断的实际频率（本机 dev state.db 表为空） | — |
| U2 | NOT VERIFIED | 所有 pipeline topology 变体（含修复轮多 artificer/scribe）下 artifact 级 BFS 均能抵达 diag_* | — |
| U3 | NOT VERIFIED | PRI-843 的 Linear 票状态；pending NHR 决策在 ViewModel 台账中的 principleId 覆盖率 | — |

## Recommendation

1. **SPEC_REQUIRED**：立项「Owner 决策证据面 bounded 诊断投影」，范围 = CIL-002 +
   CIL-003（PRI-855 Priority-1 原样），采用方案 A：复用
   `resolveFormationContext()` / `FormationDiagnosisProjection`，经既有
   `EvidenceClass:'provenance'` 槽位投影，不新建抽象/存储/flag。
2. SPEC 硬约束：观测不授权（不改 completeness/allowedActions/acceptRequirement）；
   降级可观测（rc-9）；digest 变更的部署期一次性 stale 刷新注记。
3. SPEC 前补核 U1/U2/U3（截断频率可用 resolver 现成 `formation_context_resolved`
   事件在真实 workspace 测量）。
4. 本报告不进入开发。PRI-859（CIL-001）合入与否不阻塞本 SPEC，但同属一张
   formation-context 连接图，建议排期时知悉。

---

```text
Final Result

PRI_858_RESULT=SPEC_REQUIRED
VERIFIED_COUNT=9
INFERRED_COUNT=3
UNKNOWN_COUNT=3
```
