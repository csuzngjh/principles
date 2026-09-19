# PD Owner Decision Experience v1

**Status：SPEC（设计，未实施）· 审计基线 2026-09-17 · 经 Owner 指示以 PR 入库 2026-09-19**

本文由三轮 Owner Experience Reality Audit（2026-09-17，会话临时审计目录，未入库）期间的同名设计稿修订而来。交付范围仅为这份设计文档；实施、审批、数据修复、重启等仍需另行授权。下文“必须”“新增”“删除”均为未来实施的验收要求，不是已经完成的产品变更。

## 1. Problem Statement

Owner 需要决定的是“是否希望 Agent 在类似情况下遵守这条行为准则”，而不是解释几套内部状态为什么互相矛盾。

已观察到的困难：candidate 页面声称可批准，却没有对应 pending approval；已批准的原则因为旧任务而提示“不要批准”；可读取证据来源、来源引用数、治理关联缺口被放在一起，缺少区分；实现建议直接成为原则标题；“可回滚”没有绑定真实执行对象。

**问题不是大部分历史信息丢失，而是已有信息没有形成可信、可理解、可操作的 Owner 决策说明。** v1 必须同时回答发生经过、学到的准则、判断理由、适用边界、预期变化、风险与撤销边界、当前决策需求，并使批准后的行为记录可验证。

不做的具体后果：上述同屏矛盾持续存在，Owner 无法区分“无需决定”和“系统判断不了”，也可能将已批准误认为正在执行。可观察验收是 §17 的语义场景和 §22 的新手任务，而非更多图表或日志。

## 2. Audit Evidence

### 2.1 输入与证据优先级

设计前已完整读取 Phase 1、Phase 2 主报告，以及 Phase 0 README、environment、index；委派只读审阅完整读取 Phase 0 全部 15 个案例、审批语义和截图补充文本，以及两阶段子报告和 v2 血缘证据。使用最终主报告纠正子报告的旧结论，不反向覆盖。

审计交付物位于仓库外的会话临时审计目录（未入库，含原始导出与截图；以下为相对该目录的文件名）：
- Phase 0：README、index、environment、`cases/CASE-001.md` 至 `CASE-015.md`。
- `screenshots/owner-experience-supplement/` 中列表、CASE-006、CASE-003、CASE-005 的文字与截图；审批观察和 NOT_AVAILABLE 说明。
- Phase 1：`phase1-owner-decision-contract.md`，尤其 §§2–9、§10 测试证据及末尾局限。
- Phase 2：`phase2-owner-decision-artifact-audit.md`，尤其 §§3–6、§11–14。
- `phase2-raw/availability-census.json`、`reference-census-v2.json`、`lineage-inventory-v2.json`、`selected-lineages-v2.json`。

源码阅读基线为 `45e115363a8ac1aed30a42f0c027ca07032af791`。这不是整个安装 runtime 的版本证明。Phase 0 初始采集因登录受阻而 PARTIAL，后续补充取得指定详情；CASE-005 未出现审批入口，因此没有可采集的确认弹窗。不得把局部无按钮扩大为全 Console 无审批能力。

数据为 2026-09-17 的审计库存，不是永久产品常量；跨 ledger、两个 SQLite 库和 HTTP 不是全局原子快照。15 案例包含重复关联、历史实验和人工复现，不等于 15 次独立自然事件。Phase 2 七个样本原文恢复为四个充分、三个部分；文本匹配不等于因果外键。

### 2.2 接受的 F1–F10

| ID | 不可违反的事实 |
|---|---|
| F1 | candidate 不等于 waiting-for-owner-approval。 |
| F2 | 现状没有覆盖所有治理动作的统一 OwnerDecisionState；已有 OwnerGovernanceView 不等于不存在规范投影。 |
| F3 | Console 存在重复 decision derivation：规范投影、审批分组、详情局部资格和 pending 布尔值不能互相替代。 |
| F4 | 47/50 ledger Principles 缺 canonical PI root；50/50 有 candidate、generic artifact、source run、diagnosis。不是“大部分历史数据丢失”。 |
| F5 | 当前库存 50/50 derivedFromPainIds 指向 candidate UUID；其他历史 writer 可写真实 Pain ID，不能全系统强制按 candidate 解读。 |
| F6 | 50/50 ledger.text 等于 candidate.description；kind 为 principle 19、rule 18、implementation 7、prompt 6。 |
| F7 | Distiller 已生成 abstractedPrinciple（本批 candidate 中 19/50 有值）；Scribe 已能生成 statement、rationale、applicability、antiPatterns、risks、intentContract。 |
| F8 | 七类问题中三类已有直接字段，四类有可推导素材，零类被证明需要普遍从零生成；不代表每个实例字段完整。 |
| F9 | 人工文本分类的 strict implementation leakage 为 34%，broad 为 54%；不是自动检测器准确率。 |
| F10 | Detail 的泛化“可回滚”不是具体 Principle 已验证的 rollback capability。 |

### 2.3 三个验收锚点

- **A / CASE-005**：`55e57250-5d83-404f-8978-e006b60311fd`。candidate 已消费，有诊断，缺规范 PI 根和关联审批；不能说“请批准”或“确定无需决定”。
- **B / CASE-003**：`2d23707d-11a3-4484-a35d-124e19904eac`。ledger active、approval approved，但关联 RuleCode activation 已 deactivated；有一次历史 effect，旧 failed/retry 任务仍存在。不能说当前 live，也不能用旧 frontier 泛化禁止批准。
- **C / CASE-006**：`a4b7dfc6-f0cc-47e9-8d3e-c2cee6ff9e2d`。实现型文本，缺 PI 根，有诊断来源；coverage available 同时可以零保留行为记录。

Phase 1 主报告明确证实 F3。某子报告只观察到 collector 共用纯函数，不能因此否定详情页重复推导。Phase 2 最终报告撤回 E 的 generic artifact 缺行推论；本文不引用该旧推论。

## 3. Design Goals

1. **Connection Before Creation**：连接已有来源、生成产物、审批与执行事实，不建平行解释器、审批系统或事实库。
2. **One Decision Projection**：后端统一输出决策语义、逐对象动作、阻塞和下一步；前端不重算资格。mutation service 始终是写入最终权威。
3. **四类信息可辨**：Observed fact、PD interpretation、Proposed behavior、Current enforcement。诊断 summary 即使有精确来源，也仍是 PD 的解释，不自动升级为客观事实。
4. **三层职责分开**：Owner Principle 是行为准则；Applicability 是适用与例外；Enforcement 是提示、运行拦截、规则与脚本。
5. **渐进披露**：第一层支持决策，技术层保留全部追踪和诊断能力。
6. **未知不补造**：无来源、来源冲突、无法确定唯一归属时明确 UNKNOWN；不请求模型临场补空。
7. **可观察且可逆**：审批后明确实际执行状态、保留窗口内记录和撤销范围，不承诺统计因果或撤回既往外部效果。

情绪价值评审：降低“是不是我不会用”“是否已经偷偷生效”的不确定感；让 Owner 能说明自己在决定什么、什么仍未知、哪里能够停止未来影响。待办与历史库分开以减少无意义打扰；不以“你已决定”“系统会自动修复”等未经证明的文案制造安心假象。已阅读私有情绪价值指南；本文不复制其内容。

## 4. Non-Goals

- 不改产品、不运行迁移、不生成新原则、不批准或撤销任何真实对象。
- 不把可选 PI pipeline 变成每个 ledger 创建的前置流程。
- 不重做任务编排、Runtime 恢复或宿主记忆，不删除已有安全检查。
- 不新增数据库表、永久 OwnerDecision 状态、解释生成服务、后台扫描器或通用暂存机制。
- 不批量重生成 50 条；不要求先修历史身份才交付可读诊断。
- 不合并置信度、可评价性、证据质量和准入状态。
- 不以文案选择修改 ledger.text、已批准工件、RuleCode 或 Owner 决定。
- 不新增普遍“修改措辞”“暂缓”“归档”按钮来兑现旧页面的能力广告。只显示真实支持且目标明确的操作。

## 5. Current Architecture

### 5.1 现有生产路径

```text
Pain / correction
  → rootcause → distiller → router
  → generic artifact / source run / principle_candidates
  → CandidateIntakeService → ledger
      text = candidate.description
      derivedFromPainIds = [candidateId]（此 intake 路径）

可选内化路径
  → Dreamer → Philosopher → Scribe → Artificer / Evaluator
  → approval → activation → behavior applications
```

ledger 创建独立 UUID。Scribe 产物在 PI 工件中，不是当前列表文本 writer。RuleHost 后续 best-effort 身份回填提供条件连接；跳过或失败有 note，但不构成可靠绑定保证。正式 RuleCode 组装从 Scribe 解析 ledger 身份并转发 intentContract。

### 5.2 现有读模型与动作

GovernanceProjectionCollector 读取 ledger、PI artifacts、tasks、approvals、activations，按规范根和关系组装 GovernanceFacts。`deriveOwnerGovernanceView` 产生 attention、automation、timeline 等投影。没有规范根时不应借 generic artifact 冒充 PI 审批血缘。

Console Detail 六路请求还包含原则、审批分组、生命周期、轨迹和回执。页面组合投影 attention、分组 pending、通道白名单、局部 isPending 决定按钮和提示。F3 指这些 Owner 决策推导不一致，不是否定已存在的公共纯函数。

审批写入、RuleCode 准入/推广、恢复、停用各有服务与检查。普通 Console 认证和 configured Owner 身份门不是同一机制。approved、ledger active、当前 activation 与历史 effect 是独立事实。

### 5.3 可复用边界

- 收集 I/O 留在现有 Console server model/collector；不在 core 新增 I/O。
- 规范治理事实与纯派生逻辑沿现有 core 契约方向复用。
- generic artifact/run 的诊断读取复用现有 trajectory 的 candidate 换跳认识。
- approval store、activation/control、Owner decision service 保持持久权威。
- evidence 使用既有 applications、coverage、readiness 与快照，不新建证据库。

源码导航由审计提供：`GovernanceProjectionCollector.ts:112–231`、`governance-projection.ts:29–139`、`PrincipleDetailPage.tsx:151–179,210–329,522,689–695`、`PrincipleTrajectoryModel.ts:191–199`。这些是基线定位，不是永久行号契约。

## 6. Target Contract

**一个 canonical OwnerDecisionView，两个消费面：Inbox 与 Library/Detail；多套既有写入安全门仍独立执行。**

```text
现有 collector + 诊断 read-through + 既有 action review / capability
  → 校验后的来源事实（每源有读取状态、时间和范围）
  → 单一 OwnerDecisionView 派生边界
  → Console 机械呈现
  → Owner 确认具体动作
  → 既有 mutation service 重验并写入
  → 重新 GET canonical projection
```

不创建独立 Assembler 服务或新工件类型。扩展现有治理读模型边界的私有收集/派生逻辑即可；旧 OwnerGovernanceView 保留兼容输出，但新资格不能再由其 attention 二次猜测。新契约消费底层事实及已有 action-specific 只读评估，不把另一投影当作持久事实。

五个工作流的边界：
- **A Identity**：未来 PI 消费可靠绑定既有 ledger；历史只读换跳。见 §9。
- **B View**：完整字段、来源与 UNKNOWN 契约。见 §7。
- **C Decision**：互斥主状态、逐目标动作与 blocker。见 §8。
- **D Semantics**：在已有产物间选择，不生成新的解释系统。见 §10。
- **E UX**：Inbox、Library 和渐进披露。见 §11。

canonical 指 Owner-facing 读结果的唯一算法，不表示全局原子快照、授权凭证、第二审批权威或永久状态机。

## 7. OwnerDecisionView Schema

### 7.1 通用值与来源契约

以下为规范类型记法，不是已经新增的 TypeScript 导出。

```text
Field<T> =
  { status: known, value: T, provenance: SourceRef[1..n], warnings: Reason[] }
  | { status: unknown, reason: Reason, provenance: SourceRef[] }
  | { status: not_applicable, reason: Reason, provenance: SourceRef[1..n] }

SourceRef = {
  kind: ledger | candidate | generic_artifact | run | pi_artifact | task
        | pain | user_turn | assistant_turn | correction_sample
        | approval | activation | decision | application | evidence_snapshot,
  id: nonempty string,
  fieldPath: string,
  relation: exact_id | derived_relation | heuristic | unknown,
  claimClass: observed_fact | pd_interpretation | proposed_behavior | system_state,
  producer: string,
  recordedAt: timestamp or unknown,
  capturedAt: timestamp,
  truncated: boolean
}
Reason = { code: nonempty string, ownerText: nonempty string, sourceRefs: SourceRef[] }
```

known 空数组只表示该来源明确提供了空列表，不表示“没有风险/例外”。unknown 不携带伪造 value；not_applicable 必须有正面证据。文本有界、脱敏、纯文本渲染，不执行 Markdown/HTML 中的指令。不存在的引用不伪造 ID。精确引用等级与事实/解释分类正交。

### 7.2 完整顶层契约

```text
OwnerDecisionView = {
  schema_version: "1",
  principle_id: string,
  as_of: timestamp,
  read_status: complete | partial,
  source_reads: [{source, status: available | unavailable | not_requested,
                  captured_at, scope, reason?}],

  incident_summary: Field<Narrative>,
  learned_principle: Field<PrincipleText>,
  rationale: Field<Narrative>,
  applicability: Field<NarrativeItem[]>,
  non_applicability_or_unknown: Field<NarrativeItem[]>,
  expected_behavior: Field<Narrative>,
  current_enforcement: Field<EnforcementSummary>,
  evidence_summary: Field<EvidenceSummary>,
  uncertainty: Field<NarrativeItem[]>,
  risk: Field<RiskSummary>,
  rollback: Field<RollbackSummary>,

  decision_state: needs_owner_decision | processing | blocked
                  | recovery_needed | decided | no_action,
  decision_subjects: DecisionSubject[],
  available_actions: Action[],
  blocker: Blocker[],
  next_action: NextAction,
  inbox: {group: decision | blocked | recovery | anomaly | none,
          attention: individual | aggregate | none, reason: Reason},
  technical_details: TechnicalDetails
}

Narrative = {items: NarrativeItem[]}
NarrativeItem = {text: string, claimClass, sourceRefs: SourceRef[1..n]}
PrincipleText = {text: string, sourceTier: scribe | distiller | philosopher
                | candidate_principle, selectionReason: string,
                presentation: verbatim | extracted_sentence,
                sourceVersion: string, decisionArtifactRef?: SourceRef}
RiskSummary = {items: NarrativeItem[], costNotes: Field<NarrativeItem[]>,
               completeness: partial | not_assessed}
EnforcementSummary = {state: none | active | partially_active | deactivated,
  items: [{activationRef, artifactRef, channel: prompt | code_tool_hook | defer_archive,
           effectKind: context_guidance | runtime_rule | non_enforcing_outcome,
           mode: Field<string>, active: boolean, since: Field<timestamp>}]}
EvidenceSummary = {ownerExplanation: string,
  sourceAvailability: Field<string>, retainedBehaviorCount: Field<integer>,
  sourceReferenceCount: Field<integer>, governanceLineage: Field<string>,
  promotionSufficiency: Field<string>,
  observation: {deterministicEffects: Field<integer>,
                selfReportedEffects: Field<integer>,
                contextPresence: Field<integer>, window: Field<string>,
                recentExamples: NarrativeItem[]}}
RollbackSummary = {stopFuture: Field<Capability[]>,
                   restoreConfiguration: Field<Capability[]>,
                   undoPastExternalEffects: Field<Capability[]>, ownerText: string}
Capability = {targetRef: SourceRef, actionKey: string, scope: string,
              limitation: string, successfulPastReceipt: Field<SourceRef>}
DecisionSubject = {key: string, targetRefs: SourceRef[], channel: string,
                   revisionRef: Field<string>, state, reason: Reason}
Action = {key: string, semantic: string, label: string,
          targetRefs: SourceRef[1..n], serviceOperation: string,
          channel: string, assessedAt: timestamp,
          requirements: [{name, ownerText, required: boolean}],
          expectedConsequence: Field<Narrative>,
          confirmation: {required: boolean, text: string}, sourceRefs: SourceRef[1..n]}
Blocker = {subjectKey: string, actionSemantic: string or "judgment",
           kind: data | authorization | safety | runtime | unsupported,
           reason: Reason, requiredAudience: owner | operator | system}
NextAction = {code: review | wait | inspect_data | inspect_recovery | monitor | none,
              ownerText: string, targetRefs: SourceRef[], actionKey?: string}
TechnicalDetails = {sourceRefs: SourceRef[], sourceReadIssues: Reason[],
  governanceView: Field<object>, taskGraph: Field<object>,
  sourceArtifacts: Field<object[]>, ruleCode: Field<string[]>,
  triggerPatterns: Field<string[]>, readinessChecks: Field<object[]>,
  retention: Field<object>, confidenceDimensions: Field<object>}
```

object 容器仅容纳既有已校验契约的嵌套结果，不代表接受任意 JSON；实施须引用对应既有 schema。所有外部输入先当 unknown 校验。顶层 15 个必需字段不得省略。decision_state 不使用 UNKNOWN enum：无法建立判断由 blocked 加原因表达。available_actions 始终是已确认支持的候选操作，不是执行成功保证。

### 7.3 每个必需字段的来源、回退与未知语义

| 字段 | canonical / derived source | 回退顺序 | unavailable 与 UNKNOWN |
|---|---|---|---|
| incident_summary | 已精确关联事件/受控原文摘录为 observed；diagnosis.summary 为 PD interpretation | 同一 candidate 的 artifact → source run；原文缺失可只显示有出处的诊断摘要 | YES。写“这是 PD 的事件概述，原始经过未完整核验”，不能给诊断贴 observed 标签 |
| learned_principle | §10 选中的既有语义字段，属于 interpretation | Scribe → Distiller → Philosopher → 合格 principle description | YES。无合格文本显示“可读的行为准则暂缺”；不能把技术原文顶上 |
| rationale | 当前选定提案的 Scribe rationale；缺时同 candidate 的诊断 rootCause/violatedPrinciples rationale | 有明确版本关系的 Philosopher rationale；相互冲突则并列标注，不拼成新因果 | YES。缺理由不以置信度代替 |
| applicability | 同提案 Scribe applicability；同 candidate 显式 scope/trigger 人类语义 | 仅抽取已有自然语言条件；正则/代码保留技术层 | YES。general 不能解释成“所有场景适用” |
| non_applicability_or_unknown | 已有文本明确写出的例外、排除范围，且与当前提案绑定 | 同版本 risk 中明确例外可摘录；代码反例仅作为技术证据 | YES。antiPatterns 不是例外；不通过取反 trigger/解释任意代码生成新边界 |
| expected_behavior | 同一待决工件 intentContract.targetBehavior、已存 action；动作后果来自真实 channel 服务 | 同 candidate 现有自然语言 action，标为未部署建议 | YES。只有原则 statement 不足以推导已实施行为；不许由摘要生成承诺 |
| current_enforcement | 完整读取且精确绑定的 activation/control/channel facts | 多对象逐项列出；历史事件只补历史说明 | YES。读取失败/绑定不全是 unknown；只有已确认查询范围完整且无记录才是 none |
| evidence_summary | 各独立 evidence/coverage/lineage/readiness 来源确定性汇总 | 可读取维度单独呈现，缺失维度保留 unknown | YES。引用数、行为记录数分开；不能用来源引用长度补行为数 |
| uncertainty | 已有 ambiguityNotes/intentTension，加读取失败、截断、冲突、弱关联等派生问题 | 即使模型无 notes，仍报告真实数据局限 | YES。明确空 notes 不代表确定正确 |
| risk | 当前 Scribe risks、rollout 风险、Evaluator 明确反例/检查结果 | 现有定性成本描述；不从 high/low 或历史耗时生成金额/未来延迟 | YES。空列表仅是未列风险，不是无风险 |
| rollback | 精确 activation + 真实支持的控制操作和当前权限，逐种能力派生 | 无控制对象：有完整证据则 not_applicable；关联/能力未明则 unknown | YES。能力存在不等于这次撤销已测试成功；无普遍“可回滚”文案 |
| decision_state | §8 在 action subjects、来源完整性及当前工作上统一派生 | 数据不足为 blocked；不回退前端 boolean | enum 不用 UNKNOWN；判断不明显式 blocked |
| available_actions | 现有各动作只读 review/capability 与目标状态；§8.2 | 某动作不支持只读评估时，不猜资格；给对应 blocker 或明确的既有管理入口 | 不用 UNKNOWN 数组；未知动作不列入，blocker 解释；空数组不表示无需决定 |
| blocker | 来源问题、身份/权限、安全/Runtime/action check 的结构化原因 | 无可靠细节时报告 action_assessment_unavailable，禁止假称 Runtime 宕机 | 不用 UNKNOWN 容器；每条有 reason 和作用域；空仅代表未发现阻塞 |
| next_action | 后端状态与具体 action/blocker 映射 | 无安全动作则 inspect_data/inspect_recovery 的阅读入口，不自动 repair | 不用 UNKNOWN；明确等待/查看原因，不承诺未排程的自动修复 |

## 8. Decision State Contract

### 8.1 计算范围与唯一优先级

先建立 **DecisionSubject**：普通审批至少以 approval ID、artifact、channel 定位；promotion/disable/recovery 以各自 activation/任务/版本定位。不将同原则的全部记录作为一次批准请求。现有 artifact+channel 内最新记录规则可以复用；跨 artifact 是否后继必须有明确关系，不能按全局最大时间戳覆盖其他分支。

对每个 subject：收集绑定和当前性证据、已有 Owner 决策、运行工作以及 action-specific 只读评估。数据缺口只阻塞受影响的 subject/action；不能让一条无关历史坏记录抹掉可验证的独立 pending approval。

原则级主状态按以下顺序派生，其他 subject 和 blocker 同时保留：
1. 至少一个**已明确需要 Owner 决定**的 subject，且有可提交的决定动作 → needs_owner_decision。
2. 当前相关事项存在身份/权限/安全/未知资格阻塞 → blocked。
3. 存在当前相关且已证明需恢复的事项或 action-specific Runtime 阻塞 → recovery_needed。
4. 有可证明属于当前 revision 的 queued/running/retry 工作 → processing。
5. 有适用的已完成决策/撤销记录，且无以上当前事项 → decided。
6. 在判断所需范围内读取完整，证实无当前决策或工作 → no_action。

未知可选说明字段不会自动禁用已被服务确认允许的拒绝或审批；但 target 绑定、决策当前性、权限或动作评估未知，绝不能猜测写入资格。审批尚未产生但流程在运行，应为 processing；candidate 且无 pending、无当前工作，只有判断范围完整才能 no_action。

### 8.2 逐动作契约

| 动作语义 | 必要输入与真实边界 | 第一层呈现 |
|---|---|---|
| approve | 具体 pending approval、artifact/channel、认证及该服务当前前置条件 | 显示该对象的批准后果；RuleCode 审批与 live promotion 分开 |
| reject | 同一具体 pending 目标，服务支持拒绝、理由要求满足 | Runtime 不得仅因 approve 受限而连带禁止可安全的 reject |
| edit_approval | 既有替换审批工件能力、newArtifactId/editReason 等真实要求 | 不是“修改原则措辞”；普通 Owner 无合适目标时不虚构编辑能力 |
| promote | 精确 activation、当前 readiness、配置 Owner 身份及既有安全门 | 独立明确的“启用正式执行”决定；缺观察量不能称 ready |
| continue_observing | 仅现有服务对该 shadow 对象确实支持时 | “继续观察”，不重命名为所有原则通用暂缓 |
| disable | 真实且当前支持停用的 activation 和权限 | “停止此执行方式今后的影响”；按对象确认 |
| existing_owner_decision | accept_current/revise_once/reject_current 等既有具体服务语义 | 仅在真实支持的目标上显示，不能改名成普通 approve/reject |
| inspect/recover entry | 查看当前阻塞与既有恢复界面 | 导航不是写动作；恢复提交仍走原服务和确认 |

`defer_archive` 是通道/结果，不是通用 defer action。generic park 未实现时不输出按钮；可以“稍后再看”（离开页面，无持久写入）但不得声称已暂存、已安排提醒或已归档。本 SPEC 不新增暂存写入机制。未确认支持的 archive/reopen/override 不凭名称加入 actions；保留其现有受保护界面，未来接线仍须按上述目标与资格契约。

### 8.3 六态完整定义

所有状态由后端 OwnerDecisionView 产生。以下动作集合均经逐对象评估，主状态不直接授权动作。

| state | 输入语义 | availableActions / Approve、Reject | Owner 文案 | blocker / nextAction |
|---|---|---|---|---|
| needs_owner_decision | 至少一项真实可决定的当前提案/执行决策 | 仅该 subject 支持且允许的决定；Approve/Reject 分别判断 | “有一项决定需要你审阅” | 未受阻动作可用；下一步审阅具体后果 |
| processing | 当前管线有可证明的执行/排队/重试工作，没有更高优先事项 | 不生成审批；独立 disable 等管理动作可保留 | “系统正在处理这项提案” | 等待；没有可靠时长数据不说“几分钟后完成” |
| blocked | 无法建立当前治理判断，或权限/数据/安全前置不满足 | 隐藏不可评估的批准/拒绝；展示阻塞原因，不假称已决定 | “系统暂时无法判断是否需要你决定”或“当前无法执行 X，因为 Y” | 具体 blocker；阅读原因/联系有权操作者，不自动 repair |
| recovery_needed | 当前相关失败/恢复事项有证据，且不是仅旧 frontier 文案 | 受阻动作不列；独立安全动作不连带删除 | “这项处理需要恢复”或“当前无法执行 X，因为 Y” | 明确 operator/system 责任；查看恢复信息 |
| decided | 适用的持久决定已完成，没有尚需处理的当前事项 | 不重显旧 approval 按钮；按能力提供停用/独立后续决定 | “此提案已批准/已拒绝/已停用”，不自动说“你已决定” | 查看执行与观察记录 |
| no_action | 查询范围完整、没有当前待决/工作/阻塞 | 不显示 Approve/Reject；独立管理动作仍按能力输出 | “目前没有需要你决定的事项”，附真实原因 | 查看原则库/行为观察 |

cancelled 不能自动称 Owner 拒绝；ledger 无 rejected 状态；“你”要求有可靠 actor 身份证据，普通 `operator` 不足。存在历史决定但新 revision 正在运行，不能由历史 decided 覆盖 processing。

### 8.4 投影与写入不一致

每次提交都使用 action 的具体目标与既有服务要求，不循环提交全组所有历史记录。后端重新校验 pending、认证/身份、confirmed、readiness、digest/snapshot/CAS 等既有安全条件。

若拒绝：明确显示服务返回的原因；立即失效旧 action 列表，重新读取 canonical projection；不得自动重试写入。刷新失败保持“判断暂不可用”，不得重新启用旧按钮。若审批成功但激活警告/失败，只陈述实际成功部分，重新读取审批与 activation；不得把 approval success 当 live success。

## 9. Identity / Lineage Contract

### 9.1 新数据 fix-forward（Workstream A）

最小方案复用 **candidateId + existing ledger lookup + 现有 PI store 的 sourcePrincipleId**，不新增 `derivedFromCandidateIds` 双写字段。

1. ledger 继续由既有 intake/adapter 产生，不因 UX 强制运行 PI。
2. 当可选 PI 流程准备消费 candidate 时，使用既有 candidateId 元数据解析已存在 ledger ID；只能接受存在且唯一的匹配。模型输出的 title/sourcePrincipleId 不得作为权威。
3. 已建立身份沿现有任务元数据/工件来源字段传递；读取 ledger 核验一致性。PI 的诊断 dual-write 若早于 ledger，可继续不绑定，它不因此成为可审批提案。
4. 在后续提案、RuleCode 组装与审批入队前验证绑定：缺失、多个 ledger、冲突或写入失败，必须停止该 candidate 的后续治理发布，并使用既有任务失败/问题记录表达原因；不能仅留 note 后继续造不可治理对象。
5. 复用现有 backfill 与 PI store writer；新流程完成绑定后，重复调用必须幂等。已绑定同一 ID 是成功；不同 ID 是冲突，禁止覆盖。
6. 跨文件 ledger 与 DB 不假装同事务。不删除已创建 ledger，不因绑定失败重新创建原则；留存来源，按既有恢复机制继续。没有可用恢复路径时明确阻塞，不新建通用 retry 系统。

建议原因码属于本设计而非既有 enum：candidate_unresolved、ledger_missing、ledger_ambiguous、identity_conflict、binding_write_failed。通过既有日志/任务结果暴露，不建设独立 lineage 事件库。成功后核验 PI store 读回 ID；日志成功不是绑定成功证据。

### 9.2 历史 read-through：两条覆盖轴，不混为一个 lineageQuality

```text
诊断内容轴：
ledger 引用
  → candidate 存在且 producer 语义吻合：exact ID
  → candidate.artifact_id → generic artifact：exact ID/FK
  → candidate.source_run_id → run：exact ID/FK（独立回退来源）
  → diagnostic.diagnosisId 与 Pain runtime_task_id：derived relation
  → 原文/邻近 turn：除非有显式持久关联，否则 heuristic/UNKNOWN

治理动作轴：
ledger ID → PI source_principle_id root → 明确 lineage 后继
  → approval / activation / 具体 action subject
```

artifact 与 run 是两份既有诊断来源，不是 artifact 再转 run 的新外键。若二者内容冲突，优先显示有直接 candidate.artifact_id 的产物并披露冲突；不得静默混合不同 run/revision。

重载引用必须分类：候选 ID、真实 Pain ID、未知、歧义。目标存在不自动证明 producer 语义；同时命中多个域则不猜。旧 Pain writer 继续受支持。禁止标题相似度、字符串截前缀或邻近时间补成 exact。

**读回诊断不能补成审批身份。** A/C 可显示 summary/rationale，但治理判断仍 blocked/unbound_identity。47 条不能一律称等待 PI 处理或生成失败；必须有实际 route/task 证据。50/50 诊断存在也不证明 50/50 原始 Pain/唯一人类 turn 可恢复。

### 9.3 历史 repair

v1 只读 resolver 不写 PI、ledger 或审批。Phase E 才可讨论修复；需独立授权、逐对象 dry-run、唯一身份与版本证明、备份和回滚、冲突拒绝及审计。不得依据文本相似或已废弃字段名批量回填。即便未来修复，也由现有 writer 完成，不建立第二审批系统。

### 9.4 一个确定性验收切片

在隔离测试中建立 candidate C1 与既有 ledger L1，不先生成 PI；启动现有可选 PI 消费。成功路径读取已有 L1、传递并写入同一 sourcePrincipleId，最终 approval 绑定同一工件链；重放不会新增 ledger。失败路径覆盖 missing、ambiguous、conflicting identity 和写失败，均禁止审批入队，保留 L1 和原诊断。这是未来测试设计，**没有对真实案例执行任何重写**。

## 10. Principle Semantic Selection

### 10.1 比较四类已有来源

| 来源 | 职责与覆盖实证 | 适合/不适合的用途 |
|---|---|---|
| candidate.description | Router 建议，当前 50/50 原样进入 ledger；四种 kind 混存 | 最广但不保证人类准则；不得以覆盖率作为第一层权威 |
| abstractedPrinciple | Distiller 专门提炼抽象准则，本批 candidate 19/50 有值 | 直接复用，不用新解释器重新提炼 |
| Philosopher principleCandidate | title/rationale/scope/confidence；职责为抽象、可复用 | 有精确关联时可回退；全库存字段就绪率未单独证明，不能声称覆盖 47 条 |
| Scribe principleDraft.statement | 正式可实施草案，另有边界/风险；本批仅 3/50 有 PI 根可开始精确解析 | 与待决工件直接绑定时优先；concrete 要求不保证人类可读，仍需语义检查 |

### 10.2 选择规则（Workstream D）

**先约束关联与版本，再排来源顺序：**
1. 与当前待决/已决定工件同一 lineage 和 revision 的合格 Scribe.statement。
2. 同 candidate 的合格 Distiller abstractedPrinciple。
3. 有精确可验证关系的 Philosopher principleCandidate.title（不把 rationale 改写为新原则）。
4. kind=principle 且符合下述人类语义条件的 candidate.description。
5. UNKNOWN：“这项提案已有技术建议，但可读的行为准则暂缺。”

没有 pending 工件的 Library 条目可以从其 source candidate 回退；不同 artifact 分支有多个待决对象时，各自显示说明，不选一个“最新”文本替所有分支决定。已经批准的 source statement 与另一更好读的文本不一致时保留批准原文作参考，不能暗示 Owner 批准过后者；绑定不明或语义冲突禁止借用。

### 10.3 明确的人类语义 projection

v1 **只做来源选择和有界逐字摘录，不生成改写**。合格条件：原文明确表达 Agent 的行为义务及相关对象/条件；不依赖内部 ID、API、文件路径、正则或散列算法才能理解；删除技术细节不得扩大/缩小该义务、否定、例外或量词。

可做：从同字段中抽取已经存在且独立完整的人类行为句，保留出处/偏移；不可做：把“调用某 hook”自作解释为一般行为准则，或用删词把具体场景泛化。implementation/rule/prompt 的 description **不走直接回退**；优先找它对应的已有抽象字段。无合格原句时 UNKNOWN，并在技术层保留原始建议。

这是一项保守呈现契约，不宣称已有自动语义分类器。实施只允许可复核的抽取规则；无法确定时拒绝摘录。审计的人工 34%/54% 标签只作测试素材，不建立逐 ID 特判映射。不得把仅无敏感 token 当“语义通过”。若需任意语言语义改写，属于另行批准的既有生成链改进，不是 v1 前置。

antiPatterns 在“应避免的行为”中保留，不能转成 non-applicability。RuleCode 负例只证明该测试场景，不能扩展成通用免责规则。risk 中明示的例外可逐字摘录并注明来源；没有则 UNKNOWN。

## 11. Console Information Architecture

### 11.1 Owner Inbox

复用现有治理焦点/待办入口，显示后端给出的四组：待决定、被阻塞、需要恢复、异常待核对；不是遍历 50 条 ledger 的任务列表。

- 真实当前待决与可操作恢复事项按 subject 展示。
- 47 条历史身份未绑定但无当前待决/工作证据的对象，不制造 47 张待办卡；展示一条派生汇总“部分历史条目的决策状态暂时无法确认”，链接 Library 过滤。汇总不是新持久问题或自动创建任务。
- 当前精确 pending 目标受到身份/安全问题阻塞时单独列出，不被汇总隐藏。
- 异常确认只展示已有具体确认能力；没有则“需核对”，不能捏造 acknowledge 动作。
- 空态区分“没有已确认的待决定事项”和“全部判断完整且无需操作”。有未知条目时必须显示后者尚不能确定。
- 不新建通知、提醒、已读表或紧急程度评分系统。

### 11.2 Principle Library

保留全部历史原则。ledger lifecycle（active/candidate/archived/deprecated/probation）、审批结果和执行状态是分开的筛选维度。

“已拒绝”筛选由实际 approval/Owner decision 记录派生，不新增 ledger.rejected。取消与拒绝分开，多分支混合结果显示“部分提案已拒绝”，不能一条记录覆盖整个原则。卡片标题使用 §10 learned_principle；暂缺时用中性占位而非技术 trigger。

### 11.3 Detail 第一层

1. **发生了什么**：有来源的事件摘录；若只有诊断则清楚标注“PD 的概述”。
2. **学到了什么**：行为准则及其来源版本。
3. **为什么**：PD 的解释与证据局限，不宣称客观根因已经确定。
4. **什么时候适用**：显式条件、例外或未知。
5. **会如何改变行为**：拟议行为与“当前实际执行”分开。
6. **风险与不确定性**：具体已知风险、未评估项；不显示统一 Confidence。
7. **如何撤销**：具体可用控制对象及停止范围，或无法确认能力。
8. **Owner Decision**：逐目标动作、真实后果、确认要求、阻塞与下一步。

批准后，第 5 项展开“后来发生了什么”：经证实的干预、Agent 自述、仅进入上下文分别表述；近期有界例子链接现有证据。不把 Presence 说成行为改变，也不把一次干预称持续学会。技术层保留 Effect/Presence 原分类。

技术详情默认折叠，含 IDs、来源工件、RuleCode、trigger regex、Runtime task graph、readiness checks、retention、完整关系等级。未知/截断/不完整这些会改变决策的局限不能只藏在折叠区。

Confidence：第一层使用“这条准则目前主要依赖行为观察来评估”等真实可评价性说明；技术层保留 weak_heuristic 原值。不得添加“基于行为观察自动提炼”等由 evaluability 单独推不出的来源描述。candidate、approval、lineage、evidence quality、readiness 独立保留，缺值不默认为中等。

## 12. Evidence Semantics

五个维度独立：source availability、retained record count、governance lineage completeness、promotion sufficiency、uncertainty。

典型综合说明（仅为模板，不是新生成的案例摘要）：
- “诊断来源可读取，但还未建立用于判断审批状态的关联。”
- “行为记录来源可读取；当前保留窗口内没有记录。不能据此判断原则已经产生影响。”
- “已有历史行为记录；当前执行方式已停用。这些记录不能证明现在仍生效。”

计数规则：按真实记录 ID 去重；sourceReferenceCount 与 retainedBehaviorCount 不合并；不得用 derivedFromPainIds.length 声称证据行数。确定性干预、自述遵循和上下文出现分别统计。记录只有 principle ID 而无 activation/revision ID 时，不能把效果归因于某一规则版本。

promotion sufficient 只在推广动作上下文读取现有 readiness evaluator；不重新复制阈值或把旧 snapshot 当当前评估。历史审计阈值 observed≥20、matched≥3、neutralControl≥1、24h 仅为测试对照基线，不在 UI 另立权威。风险检查失败与观察不足不能相互覆盖。

人类来源不明时不显示“Owner 说”；Subagent Context、人工实验和脱敏/截断原文保留身份说明。重复原文 turn 不能任取一个作为唯一痛源。

## 13. Runtime Separation

不重写 Runtime frontier 算法，不因新日期自动清除旧任务。新的 Owner 呈现层要求**当前动作相关性证明**：相同 subject、artifact/channel、revision/dependency 关系，或者既有动作服务明确返回该阻塞。

单有历史 failed/retry 记录，或时间更晚的 approval，都不足以自动判定任一分支已被替代。若新旧关系无法确定，展示“存在历史处理问题，其与当前动作的关系尚未确认”；保留技术路径，不能宣称 Runtime 宕机或禁止无关动作。

B 的合格展示应同时保留：批准历史、activation 已停用、一次历史 effect、旧任务问题；不把这些合成“不要批准”。若真实当前 promote 被兼容性检查阻止，应明确“当前无法启用正式执行，因为兼容性检查未通过”，不改写 Principle 状态。

恢复责任和治理决定分开。普通 Owner 不被迫理解 task graph；操作员可通过原有技术入口调查。未知关联不自动触发 retry、repair 或重启。

## 14. Rollback Semantics

| 能力 | 可承诺条件 | 必须披露 |
|---|---|---|
| 停止未来行为 | 精确 activation、当前可用 disable/control 操作、权限可评估 | 停止哪种通道、哪些后续行为；其他 activation 不受影响 |
| 恢复配置/activation | 确有前一版本/恢复目标及既有服务支持 | 恢复哪个目标、需要哪些确认；单有 deactivate 或 promote 不算配置恢复能力 |
| 撤销既往外部副作用 | 必须有独立已验证补偿能力及目标 | 本批审计没有证明普遍能力；v1 不提供通用承诺 |

无 activation 且绑定/查询完整：当前无可撤销执行对象。无绑定或来源不可读：无法确认，不说“从未启用”。已 deactivated：展示已停用及时间，不再显示同一对象的 disable；历史是否成功撤销配置另看回执。

能力可用、曾成功停用、本次停用成功是三件事。点击后依旧走确认、原服务与状态刷新。不得用 channel 静态标签或 approved 状态生成“可回滚”。

## 15. API Changes

以下是**拟议 API**，不是现有端点声明。优先放在现有 principles/experience 路由与 collector 所属边界，不建独立服务。

- `GET /api/v1/principles/:id/owner-decision-view`：返回 §7 契约。保持既有认证、workspace 隔离、ID 校验和响应封装。
- `GET /api/v1/principles/owner-decision-inbox`：同一派生逻辑的批量/分页投影，返回 subjects、派生分组及覆盖未知汇总；静态路由与 `:id` 注册不得冲突。不让浏览器重复过滤/推导治理资格。
- 原 `/governance` 及轨迹/证据/管理端点保留兼容；新第一层只以 OwnerDecisionView 决定资格。
- mutations 不新增统一写入口，不要求增设 view token、viewRefreshHint 或新 CAS 状态；继续消费既有服务响应与并发检查。view.as_of 只是采样时间，不能用作授权或跨源版本凭证。

来源读取失败如可隔离，返回 partial 且对应 blocked/UNKNOWN；不存在 ledger 为 404，认证失败为现有 401/403，契约或服务整体失败为明确错误响应，不能 200 空成功。来源内部坏行与服务器输出 schema 失败区分处理。

只读资格评估不得调用会懒创建状态、生成快照或入队的 mutation 路径。若现有 review 混合读写，必须在既有拥有者内复用/分离无副作用评估部分，不复制安全规则。SQL 外部输入全部参数绑定；GET 的未授权请求不得泄露正文、目标或能力。

## 16. Migration Plan

按以下顺序实施，均需要独立实施授权；本次不启动任一阶段。

### Phase A — fix forward contracts

复用现有身份查询和 PI writer；在可选管线治理发布前保证唯一绑定，失败阻止后续发布、保留诊断与 ledger。§9.4 的成功/冲突/重放测试先定义。无需新字段、全表回填或强制 PI。

现有 approval 三说明栏未来 enqueue 可按实际 channel 接通已有确定性上下文构建；这是后果描述，不是已有逐原则风险分析。无依据的字段继续缺值，risk 仍读真实工件。`INSERT OR IGNORE` 不会补旧行；不以重复入队充当历史修复。不启动额外 LLM 填 NULL。

### Phase B — introduce read-only OwnerDecisionView

扩展现有读模型及两个读入口，前端尚不切换；对保存的 A/B/C 和隔离夹具比较。诊断读取与治理身份保持两个轴，直接暴露 UNKNOWN。无外部模型调用、无业务写入。

### Phase C — switch Console consumption

切换 Inbox/Library/Detail 第一层；移除该路径本地 isActionable/isPending/通道白名单的资格推导。原技术接口保留。此阶段先使用保守的既有文本选择/UNKNOWN，不能等 Phase D 才消除实现原文标题泄漏。

### Phase D — improve semantic Principle selection

完成 §10 四来源优先级与有界原句提取；用人工金样本证明不丢否定、条件、例外且不扩大规则含义。只影响展示，不改存储，不批量重生成。保持已批准对象版本可见。

### Phase E — optional historical repair/backfill

只有只读方案不能满足明确目标并取得独立批准时讨论；不作为 v1 前置。报告逐对象证据、dry-run、备份、幂等和恢复方案。不能将“47 条没 PI 根”自动转成“47 条都应补 PI”。

部署控制：默认不新增 runtime feature flag。使用可回退的兼容发布和原有控制机制；旧接口保留以便版本回退。若实施证明必须独立开关，另作有依据的 flag 生命周期决策，不在本 SPEC 偷增 quiet flag。

## 17. Testing Strategy

**本节是待实施的测试要求；本次没有执行产品测试或生产动作。** 最高测试面是隔离环境的真实 GET → Console → 既有 mutation 服务，配合纯派生单测；不以源码包含字符串替代行为验证。

| ID | 输入与断言 | 验证边界 |
|---|---|---|
| T1 | candidate、无 pending：不得显示“请批准”。绑定完整无当前工作则 no_action；有运行工作则 processing；绑定不明则 blocked，并分别说明真实原因 | GET + 完整页面 |
| T2 | lineage unavailable，即使 summary/rationale 可读取，也不得说“当前不需要 Owner 决策”；blocked、原因可见，诊断仍展示且带解释标签 | resolver + GET + 页面 |
| T3 | active ledger、历史 recovery frontier、已停用 activation：无泛化“不要批准”；保留批准/停用/历史效果，Runtime 不冒充健康探针 | 真实 B 保存证据 + 页面 |
| T4 | coverage available、零 evidence rows、来源引用数 1：说明当前保留记录为零，不称充分，不把引用算为行为记录 | 数据查询 + GET + 文案 |
| T5 | implementation-heavy recommendation：第一层标题不用 hook/MD5/regex；无合格既有语句时 UNKNOWN，技术原文仍可达。另覆盖合法抽取不扩大义务 | 语义金样本 + 页面 |
| T6 | 隔离 active activation、服务支持 disable：返回真实 target 和动作，确认后原服务停用，刷新显示 deactivated；文案仅承诺未来作用停止 | 原控制服务集成 |
| T7 | 完整查询无 activation：无具体 rollback 承诺；另测绑定缺失/读失败应 UNKNOWN，不能冒称从未启用 | collector + GET |
| T8 | GET 允许动作后状态/权限变化，mutation 拒绝：无禁止写入，服务为最终 authority；UI 显示原因、失效旧动作并自动 GET 刷新，不重试 mutation | 并发 HTTP + 页面 |
| T9 | Subagent Context、重复文本 turn、manual 实验及截断：不冒称唯一 Owner 原话或完整自然事件 | 来源 contract |
| T10 | weak_heuristic 与 candidate confidence 0.8 并存；可评价性和数值分开，缺 confidence 不默认 medium | 完整页面 |
| T11 | PI identity 成功/缺失/歧义/冲突/写失败/重放，失败均不入审批；既有 ledger 不删除不重建 | 生产 PI/ledger/store 集成 |
| T12 | 多 channel、多 revision：逐目标批准只改目标 pending；旧 approval/retry 不覆盖新 revision；取消不等于拒绝 | 原审批 HTTP + SQLite |
| T13 | 部分来源失败不阻塞独立可验证 reject；approval success + activation warning 不显示 live success | action-specific 服务集成 |
| T14 | historical effect、自述与 presence；当 activation 停用仍保留过去证据，不声称现在执行或因果改善 | GET + 履历页面 |
| T15 | 未认证、错误 workspace、恶意文本、坏 JSON、NULL、继承属性、非法数组元素：不泄漏、不执行、不写入，明确错误 | API 安全负向测试 |
| T16 | 50 条历史库含 47 未绑定：Inbox 为真实当前 subjects + 历史未知汇总，不铺 50 张待决；rejected 为审批维度非 ledger 新状态 | 批量 API + 页面 |

既有测试基线来自 Phase 1 §10：core governance-projection、Console principle-detail-governance-block、receipt-semantics、HTTP/SQLite governance-approve-activation、promotion-readiness 以及 RuleCode Owner E2E。保护各自真实契约；当前误导文案的契约调整必须显式记录，不以删除场景消除失败。

新 GET 的读-only 集成测试应比较隔离 ledger/DB 写前后内容与副作用调用，避免仅 mock helpers。跨包 schema 增补须测试实际 Console consumer。将新行为写入适用 BDD，不降低旧可观察安全期望。未来实施交付须运行 targeted suites 和 `npm run verify:merge`，明确环境/既有失败；本次文档验证不冒充这些门已通过。

## 18. Observability

复用现有结构化日志/任务结果，不新增遥测系统或永久 OwnerDecision 记录。

建议低基数观测维度：view state、来源读取状态、semantic source tier、unknown reason、identity binding outcome、mutation disagreement reason。记录身份绑定失败是否确实停止发布，而非仅计 note。

禁止日志记录原始对话、完整规则代码、密钥或任意对象；ID 仅在现有受控诊断策略允许时关联。不能从 note 文本解析新状态权威。读结果应稳定排序、输出 as_of 和读取范围；统计不得被当成 Owner 授权或自动 repair 触发器。

成功可观察：A/C 可读诊断并解释判断缺口；B 不再被旧恢复文案误导；首次 Owner 能讲清决定对象及后果；批准后有可区分的真实行为记录。零行不是失败率，历史未知也不是生成失败率。

## 19. Failure / Degradation Behavior

- **新投影不可用**：第一层显示判断暂不可用、禁用过期动作；可继续显示明确标为上次读取的非操作内容。不得自动回退旧前端资格算法。
- **诊断可读、治理不明**：保留诊断说明，decision blocked，current_enforcement/rollback 按可证明范围 unknown。不能修成假空正常状态。
- **单个语义字段缺失**：UNKNOWN；不调用模型补空，不阻止无关安全动作。
- **来源冲突**：显示冲突与相关版本；不混合不同候选/工件的 rationale、risk、expected_behavior。
- **部分 action 评估失败**：只移除该 action，并给精确 blocker；没有足够证据时不可假定 approve/reject 共用门。
- **mutation 拒绝**：按 §8.4 失效、明确原因、刷新；新 GET 也失败则保持不可操作。
- **审批成功、激活失败/警告**：分项陈述持久结果；服务回滚成功与否从真实结果/读回取得，不承诺事务覆盖 ledger 与所有通道。
- **UNKNOWN 原文/身份**：不编造 Owner 话语、过去 incident 或已决定 actor。

## 20. Compatibility

保留 ledger、PI、candidate、approval、activation 各自的权威，旧 API 和技术页面不删除。derivedFromPainIds 在 v1 不重命名、不双写；reader 兼容候选引用和旧 Pain 引用，歧义显式拒绝。

旧 OwnerGovernanceView 的调用方可继续使用原契约；新页面第一层只消费 OwnerDecisionView。不能一边显示新 state、一边用旧 group pending 重新决定按钮。渠道保留真实 prompt/code_tool_hook/defer_archive；非执行结果不能被称运行拦截。

升级为兼容读接口增补；无新表和全量数据迁移。部署回退旧软件版本时旧呈现问题可能回来，必须明说；运行中 endpoint 失败不等于获准回退不安全旧资格。代码回退不得回滚已经发生的 Owner 决策或替 Owner 重新启用规则。

未修改 CLI stdout 契约、不复制私有文档、不影响宿主执行职责。产品身份和 MVP-first 边界不变。

## 21. Complexity Delta

### 21.1 必需判定

| 项目 | 目标 | 解释 |
|---|---|---|
| NEW COMPONENT? | YES，有限 | 新 OwnerDecisionView 契约/纯派生能力、读路由和 Inbox 呈现；放在现有模块，不新建独立服务 |
| NEW TABLE? | NO | 所有说明和状态即时派生 |
| NEW WRITER? | NO | 修改既有 identity/approval producer 的接线，不增加第二 writer |
| NEW STATE MACHINE? | NO（持久生命周期）；YES（新的呈现分类契约） | 六态为新增 Owner 语义，不能谎称现状已有；无持久转移/事件日志，不驱动审批写入 |
| DUPLICATE SOURCE? | NO | 来源不复制为新权威；旧投影兼容保留，新 Console 资格推导收敛 |
| LEGACY SYSTEM RETAINED? | YES，受控 | 原治理投影、Runtime、RuleCode、证据和管理能力保留；只删除重复前端资格推导 |
| SECOND WRITER? | NO | 不建审批/解释第二写入路径 |
| PARALLEL APPROVAL SYSTEM? | NO | mutation service 仍最终权威 |
| MASS REGENERATION? | NO | 不生成 50 条新原则，不改 ledger.text |

### 21.2 仓库复杂度门

| 项目 | 目标 |
|---|---|
| New durable source of truth | NO |
| New persisted schema/state | NO（复用现有身份字段；不新增伴随字段） |
| New subsystem/service/background process | NO |
| New public abstraction/interface | YES：OwnerDecisionView 与两项只读 API |
| New runtime feature flag | NO |
| New cross-package dependency | NO：沿既有 console → core 依赖增加 contract consumer，不是新依赖边 |
| New host/platform-specific behavior | NO |
| New external/network capability | NO：既有 Console HTTP 面新增读资源，无外部服务/LLM 调用 |

YES 的理由与撤回方式：现有 attention 无法表达判断未知、逐动作条件和语义说明；仅改文案不能满足 F3 与 T8。新读边界隐藏来源换跳、版本和动作评估组合，避免 Owner/前端协调内部细节；不引入独立 Assembler 服务是更小方案。T1–T16 通过真实消费验证；兼容增补可回退前端与读端点，不撤销业务记录。

保留旧系统的代价：过渡期存在新旧两个 API 契约，但不能出现两个新页面资格权威。新六态有测试与维护成本，已如实计入，不用“只是 projection”掩盖复杂度。

## 22. Acceptance Criteria

1. 文档/实现显式接受 F1–F10，不再描述大多数历史数据丢失。
2. A/C 可读已有诊断，无法确定审批时明确 blocked；不出现“请批准”或“已确认无需决定”。
3. B 同时显示批准记录、已停用执行、历史 effect 和相关旧任务局限；不宣称当前 live，不泛化“不要批准”。
4. §7 全部必需字段有来源、回退、未知语义；无来源数据不由模型补造。
5. 后端是唯一 Owner-facing state/actions/blocker/next_action 推导点；审批仍由原服务逐目标最终校验。
6. candidate 无 pending、multi-channel、多 revision、取消、既有权限不匹配均正确，不用一组按钮批准所有记录。
7. 四类文本来源有明确优先级、版本约束和保守回退；实现原文不冒充人类 Principle，原技术内容仍可访问。
8. evidence 可读与数量/充分性分开；原文来源、截断、未知因果不被隐藏。
9. 精确 active activation 支持 disable 时给具体动作；无/未知 activation 不泛化承诺；不承诺撤回既往外部效果。
10. Inbox 只列真实当前关注事项，历史未知聚合说明；Library 支持真实生命周期和独立 rejected 审批维度。
11. Phase A 在隔离生产路径测试中证明身份唯一、重放幂等、失败不发布；不强制 ledger 创建时运行 PI，不碰历史数据。
12. T1–T8 全部以可观察行为验收，T9–T16 覆盖来源、身份、并发、安全与历史回归；未来实施记录实际测试结果。
13. 新手验收：至少五位未参与内部实现的受试者（或明确标注的后续招募计划）在无术语讲解下，针对待决/未知/已停用三类材料，回答发生经过、判断理由、适用与风险、当前是否需要决定及撤销边界，并找到真实可用动作和后来行为记录。不得把当前作者自测冒充受试结果。验收门：无人把未知判断为无需决定、把已停用判断为 live、把停止未来影响判断为撤回既往效果；每位至少正确完成七项核心理解/操作任务，失败须记录并修订。
14. 交付实施时给出当前 targeted tests、merge gate、真实消费路径证据及 Owner Review Card；本次只有 SPEC，无实施成功声明。

## 23. Open Questions

以下未知不以臆测补全；保守默认已确定，不阻塞本次设计交付：

1. **各 action review 是否纯读**：审计没有穷尽所有 producer 的副作用。实施必须逐个核验；默认不调用可能写快照/入队的 GET 评估，不能安全评估的动作返回 blocker。
2. **跨分支语义一致性**：已知 ledger 与 Scribe 文本不同，未证明全面等价。默认按版本和明确关系选择；冲突则展示分歧/UNKNOWN，不悄悄以更流畅文本替换批准对象。
3. **任意技术建议的人类改写能力**：v1 默认只选择已有字段和完整原句。是否授权既有 Distiller 按需补生成，需要未来独立决定；不在本次添加生成器。
4. **配置恢复/外部效果补偿覆盖**：审计只证明部分 disable 能力。默认未验证能力不提供；不以 channel 标签填空。
5. **新手测试与运行环境**：当前只有审计截图/数据和静态动作分析，没有新投影或用户试验结果。具体受试安排与验证环境留给实施验收，不伪报已经通过。

**交付边界：本文档为设计交付；实施、数据修复、治理动作等仍需另行授权。设计过程（截至 2026-09-17 审计完成）未修改产品、数据库、配置或测试，未执行修复、治理动作或重启。**
