# SPEC-OGQ-001 v1.1 — Decision Trust & Principle Necessity Hardening

> **中文名称：** PD 原则质量与 Owner 治理体验修复  
> **版本：** v1.1（Engineering Review Candidate）  
> **日期：** 2026-10-10  
> **状态：** Proposed / 未获实施授权  
> **代码与运行时核查基线：** Principles Core 1.290.0；源码仓库当前提交以实施前 Reality Audit 为准  
> **审计依据：** PD-APPROVAL-AUDIT-2026-10-10.md（只读独立核查）  
> **目的：** 将「有道理却难以审批」转化为可信、最小、可验证的行为治理决策。  
> **范围控制：** 本 SPEC 授权范围为设计与评审，不自动批准代码、迁移、原则变更或任何 Runtime Mutation。

## 0. 决策摘要

**原则：Pain 是行为改变的理由，Principle 是可修订的长期行为假设，Owner 决定授权的对象是具体且有边界的行为影响，Activation 不是效果证明。**

这轮不是再造一个治理平台。首先修复已核实的误导性输出和既有证据投影；随后让候选必要性与抽象质量审查在 Shadow 模式接受真实检验。是否阻止生产 CREATE、是否加入新审批动作，必须另行获得 Owner 裁决。

**本轮建议交付：** A 决策可信度修复、B 证据连接修复、C Owner Inbox 体验修复；D 候选必要性 Shadow、E 原则抽象和能力一致性 Shadow。  
**本轮不交付：** 正式 Principle Revision / Binding、自动归因引擎、新的授权状态机、自动清退、第二套 Receipt/Evidence 存储、历史原则自动裁决。

### 0.1 核实结论与证据等级

| 事实或判断 | 等级 | 说明 |
| --- | --- | --- |
| activation-dispatcher 根据 LLM 自评输出 multiple validations | 确认 | 模型置信度不构成多次独立验证 |
| OwnerDecisionViewModel 中 evidenceItems 固定为空 | 确认 | 源诊断可含 evidence；既有读投影断开 |
| Scribe 嵌套原则正文未被某条审批摘要路径正确识别 | 确认 | 另一 Console 路径能够识别，不能概括为全系统无正文 |
| 25 条 NULL source_principle_id 等于谱系断裂 | 已推翻 | 间接 lineage 可以关联；每一层来源仍需核实 |
| 注入次数被 Console 全面冒充已改变行为 | 已推翻 | 当前 Console 存在正确区分；聚合与 ID 对齐仍需改进 |
| 原则质量整体很差 | 不支持该绝对判断 | 有优质反例，存在质量波动和缺少统一门禁 |
| 当前复用机制不存在 | 已推翻 | Candidate Intake / reuseEvaluation / reuseEvidence 已存在 |
| 独立行为效果已被证实 | 不支持 | 缺少足够可比结果与完整链路，显示 Unknown |
| 本次所有待办都无必要 | 未评估 | 不得以标题、全称词或一条模型评分代替裁决 |

**口径约束：** 40 条原则、32 条 pending、7 条 active、应用 1726/105/1 等是 2026-10-10 样本快照，不是代码不变量。独立审计个别抽样统计存在计数不一致；本 SPEC 不依靠那些冲突统计设置硬阈值。

## 1. Problem / Goals / Non-Goals

### 1.1 Owner 的真实任务

Owner 不应回答「这段抽象哲理说得对不对」，而应能判断：

1. 发生了什么真实事件？来源能否复核？
2. 诊断哪些是事实，哪些只是合理推断？
3. 为什么需要长期改变，而不是局部修复、复用或等待更多证据？
4. Agent 之后具体应当怎样改变、何时不适用？
5. 本次批准的精确 artifact、channel、scope 与可撤销边界是什么？
6. 什么行为尚未验证，PD 又能提供哪种强度的证明？

### 1.2 结果目标

- **Trust：** 零条无验证记录却宣称「多次验证」的当前 Owner 展示。
- **Traceability：** 能用既有权威事实恢复的 Pain / Diagnosis 证据进入决策投影；不可恢复则明确 Unknown。
- **Clarity：** 一屏理解原因、拟议行为、真实影响、风险、下一步，不强迫 Owner 阅读 UUID/JSON。
- **Quality：** 新建原则之前能提出可审计的「局部修复 / 复用 / 修订 / 新建 / 观察」建议。
- **Governance：** 不改变已有授权，保留 Owner 对正式原则创建、修订、范围扩大和执行升级的决定权。
- **Economy：** 优先连接现有能力，不为每个 Pain 无条件多跑一遍 Trinity。

### 1.3 严格非目标

- 不修改已安装的 ~/.pd/runtime，不触发 installer/update/repair。
- 不直接批准、拒绝、停用或重分类当前 32 条 pending 与 7 条 active。
- 不将 Prompt 指令升级成确定性拦截，也不创建新的激活通道。
- 不实现 ADR-0027/0028 的未来资产、正式 Revision/Binding、自动归因/清退。
- 不把每个抽象原则强制变为 regex/triggerPattern。
- 不要求首次提案必须先证明长期有效；允许「证据不充分的假设」，但不得伪装成已验证结论。
- 不创建独立 EvidenceRef V2、BehaviorDeltaStore、OwnerDecisionStore 或平行治理投影。

## 2. 规范与权威边界

| 权威/设计 | 状态 | 本轮约束 |
| --- | --- | --- |
| AGENTS.md P1–P8 | 当前工程宪章 | Reality Audit、Connection Before Creation、单一事实源、最小更改、验证优先 |
| docs/product/PRODUCT_IDENTITY.md | Active | Owner-governed、MVP-first、无通用任务重试/模型输出修复 |
| docs/specs/OWNER_DECISION_EXPERIENCE_V1.md | 既有设计 | 复用来源分类、只读 Decision Projection、真实动作和渐进披露 |
| Principle Governance Projection Contract（2026-08-20） | Phase 0 Design Frozen | Console 只读派生，不新建运行时治理事实源 |
| IntentContractV1（PRI-703） | 已实现 | ownerIntent、targetBehavior、forbiddenBehavior、evidenceSource、validationExpectation 是既有语义锚 |
| PRI-917 Semantic Reuse v0.3.3 | 已批准实施的 SPEC | 复用推荐≠Owner 裁决；自动路径评估失败可观测地继续 CREATE |
| ADR-0024 | Accepted | 不直接写安装运行时；Mutation 服从既有权威 |
| ADR-0027、ADR-0028 | Proposed（截至 2026-10-10 的文档核查） | 可用作未来目标的兼容依据，不等于已获实施授权 |
| Post-MVP Conditional Roadmap | Active | 长期因果归因、自动治理仍受重启条件约束 |

### 2.1 不可违反的不变量

- **INV-01 One Source of Truth：** Ledger、Approval、Activation、Task、Evidence 各自既有权威不改变。
- **INV-02 Read ≠ Write：** Console 的 Projection 只帮助理解，不构成写入或授权令牌。
- **INV-03 AI Suggestion ≠ Owner Decision：** 模型不能代替 Owner 裁定新增长期价值、范围扩张或删除原则。
- **INV-04 Runtime Fail-Open：** PD 故障不阻断宿主正常任务；但新增治理权限不能因为失败而自动放行。
- **INV-05 Observed ≠ Inferred ≠ Proposed ≠ System State：** 四类陈述的来源类型始终可辨。
- **INV-06 Approved ≠ Activated ≠ Delivered ≠ Applied ≠ Effective：** 不把流程阶段偷换为效果事实。
- **INV-07 Exact Identity：** 正式授权目标需要 exact artifact / channel / approval 的权威身份，启发式文本匹配不可赋权。
- **INV-08 No Historical Rewrite：** 历史原始记录不因展示纠错而被覆写。
- **INV-09 Bounded Change：** 首次交付必须维持现有权限和 Runtime 写入边界。
- **INV-10 Observable Failure：** 失败、冲突、来源缺失、超时、评估未执行都须有原因码。

## 3. 架构约定

现有事实链：Pain → Diagnostician → Candidate → Candidate Intake / Reuse → Ledger / Internalization → Scribe / Reviewer → Approval → Activation → Runtime Observation。

本轮的新增能力只允许出现在以下位置：

1. **读投影修复：** OwnerDecisionViewModel 和既有规范 Owner Decision / Governance Projection，恢复当前可恢复的证据与准确语义。
2. **候选建议 Shadow：** 在现有 Candidate Intake / Reuse 写入边界旁计算推荐，不改变生产结果。
3. **抽象/能力 Shadow：** 在 Scribe 输出后、形成 Approval 前评估是否越界；首次阶段只留评估结果、统计误判，不改变产物与现有授权。
4. **正式 Enforcement：** 在 Shadow 经独立审查、Owner Go 后另开实施 PR，并按已接受的 PRI-917 复用语义审查冲突。

禁止在 Console 前端重算核心授权资格；禁止以 JSON 读模型代替原事实存储；禁止额外的长期后台守护进程。

## 4. WP-A — Owner Decision Trust Fix（P0，生产修复）

### A-01 统一语义提取，保留历史真相

**现状：** activation-dispatcher.ts 的 buildApprovalContext 只尝试 artifact.contentJson 中的 text/description；Scribe 正文实际可在 principleDraft.statement。ApprovalsGroupedConsoleModel 已有能读取嵌套正文的提取路径。

**目标：**

1. 调查并优先复用现有可靠的工件正文解析逻辑，形成单一受测的提取规则或共同最小模块；不重复创建第二套解析器。
2. 新审批写入时生成可读摘要；历史审批渲染通过权威 artifact 派生当前摘要，不改写历史 summary。
3. 标题/statement 不可读时展示准确的缺失或解析失败原因；只有 UUID 时不能冒充语义摘要。
4. 任一条审批卡上的摘要必须严格绑定该审批的 artifact revision，不从其他 sibling revision 借正文。
5. 对非 Scribe 工件保留已有兼容路径；输出带 parse status，不能把 JSON 解析失败静默解释为“没有原则”。

**重点入口：** packages/principles-core/src/runtime-v2/activation/activation-dispatcher.ts；packages/pd-console/src/server/models/ApprovalsGroupedConsoleModel.ts；FocusPage.tsx。

### A-02 confidence 来源与历史修复

**现状：** 当 confidence≥0.8，dispatcher 当前输出 High confidence based on multiple validations；Rollout Reviewer protocol 只要求模型给出 assessment certainty。

**目标：**

- 移除新的虚假多次验证声明；显示“Rollout 模型评审自评”及相应来源。
- 历史错误 confidenceExplanation 不是证据：Console 优先显示与已知来源一致的派生说明，无法确认字段来源则标明“历史说明未经验证”。
- 不直接重新解释持久化数值，不将 Diagnosis 的 0.55 与 Reviewer 的 0.92 相加、比较或转换为准确率。
- “已通过 N 次验证”的措辞必须有具体、可解析的验证来源、类型和样本计数；否则一律不得出现。
- 纯模型语义审核只能说明审核完成，不能变成行为重放、独立取证或长期有效性结论。

**回归反例：** pain self-assessment 0.55 → candidate 0.55 → rollout 0.92；页面应标识不同来源，不声称 92% 的成功率，也不声称多次行为验证。

### A-03 修复伪证据计数及警告

- group.records.length 是审批/组内记录数，不是原始证据数。
- 如要显示证据数，必须基于成功解析且具有独立来源的证据引用；多个摘要重复指向同一来源不得重复计数为独立样本。
- 无法恢复原始 evidence 时显示“证据状态不可用”，而不是“0 条证明事实不存在”。
- 工件正文能读但 Principle/Approval 身份不确定、来源不可用、通道能力不匹配时仍然提示准确降级状态。
- 保留 rc-9 的观察性及安全降级，避免强行改动已有正确文案。

### A-04 通道后果说明

- 复用 OwnerDecisionView 中已有 approveConsequenceText(channel) 的业务语义和真实 Channel Writer。
- Prompt：可以向 Agent 上下文提供行为指导；不具备确定性工具调用拦截、强制模板锁定及自动回归验证。
- Code tool hook：是否能阻断取决于真实实现、拦截点和 shadow/live 配置；不可仅凭 channel 名称宣称 live。
- defer_archive：不得暗示产生在线行为改变。
- Skill：不能因为旧注释/展示模板里存在 skill 文案就认定生产支持新 skill 激活通道。当前实际 channel union 为 prompt / code_tool_hook / defer_archive。

### A-05 WP-A 交付/验收

- AC-A01：新审批 Scribe 结构能正确生成自然语言摘要。
- AC-A02：旧审批可读正文不会继续把 UUID 当唯一主标题，且原审批行不被修改。
- AC-A03：没有验证事实支持的历史与新文案均不出现 multiple validations。
- AC-A04：任何“证据数量”均可核算来源，不能以 approval records 代替。
- AC-A05：可读正文无法掩盖身份或原始证据缺失。
- AC-A06：拒绝、批准、停用等真实服务端动作没有被前端错误文案重新定义。
- AC-A07：审计 32 条 pending 的只读 fixture 对照，并确认所有权限与状态不变。

## 5. WP-B — Evidence Propagation Repair（P0，连接既有事实）

### B-01 复用既有契约

权威字段应复用 OwnerSourceRefSchema（kind、id、fieldPath、relation、claimClass、producer、capturedAt、truncated），以及 Field<T> 对 known / unknown / not_applicable 的明确语义。

**禁止：** 创建平行 EvidenceRef V2、另一个“权威 Diagnosis”表，或将历史 JSON 摘要补造为独立事实。

### B-02 修复断点

- OwnerDecisionViewModel.ts parseDiagnosis：读 summary/rootCause 的同时有类型保护地读取上游 evidence 及来源引用。
- buildInputsFor 不再无条件 evidenceItems: []；若下游只能消费字符串列表，应使用既有契约的最小兼容表达，并保留可恢复的源引用。
- 与已有 Owner Decision V1 完整性/回滚字段保持一致；只增强 Producer→Collector→Projection 的连接。
- 确保证据来源受 workspace、Owner 和授权数据访问边界限制；必要时服务端按当前权限取用摘要，不把原始敏感对话无条件传给浏览器。
- 对损坏、截断、关联冲突返回结构化 Unknown reason，不让模型临场补写原始事件。

### B-03 来源类别与语义

| 源 | Claim 类型 | 能够证明 | 不能证明 |
| --- | --- | --- | --- |
| Owner 原始反馈 | observed_fact | Owner 确实提出了该反馈 | 诊断的因果解释真实无误 |
| Diagnostician rootCause | pd_interpretation | 系统提出了某种归因 | 原因已独立验证 |
| Scribe statement / intent | proposed_behavior | 计划采取何种行为改变 | Agent 已实施改变 |
| Approval / Activation | system_state | 记录了授权或部署操作 | Host 接收/应用/改进成功 |
| Agent self_report | 对应来源声明 | Agent 自称遵循 | 运行时独立验证遵循 |
| Runtime verified receipt | 系统观察 | 在特定边界确实发生执行事件 | 广义学习成功或因果改善 |

### B-04 谱系处理

- 不把 source_principle_id=NULL 直接标为断链；优先使用已有 lineage_artifact_ids、task graph 和权威 Principal identity resolver。
- 关联必须报告 exact_id / derived_relation / heuristic / unknown 的真实级别。
- heuristic、自然语言相似或时间邻近关联不得自动用于 Approval/Activation 的权威目标。
- 不要求强行把所有历史 derivedFromPainIds 当作真实 painId：有些现有写入实际指向 Candidate UUID。
- 不得把同一次 Owner 反馈在多层模型中重复转述后当作多份独立证据。

### B-05 WP-B 交付/验收

- AC-B01：重点例 3b11b54d 可从 Owner Decision 追溯到真实 Owner 反馈及其来源。
- AC-B02：根因不确定性保持为解释，而不升格为已知事实。
- AC-B03：当原始事件关联无法复核时，字段标 unknown 并携带 reasonCode。
- AC-B04：缺少 UUID 对齐的 application 记录不被解释为“已证明零应用”。
- AC-B05：同一 revision 的 Owner Decision 不消费其他 revision 的 Scribe 正文。
- AC-B06：无新增持久化事实源、无历史行篡改、无未经授权的跨 workspace 读取。

## 6. WP-C — Owner Inbox Usability（P1，真实授权优先）

### C-01 核心界面问题

当前 Owner 面对「合理却难批」的提案，缺的不是另一段原则解释，而是以授权为中心的五个答案：

1. 为什么现在要处理这个问题？
2. 有哪些可以复核的真实事实？
3. PD 拟议改变什么行为，何时不适用？
4. 批准以后哪个具体 artifact 会以什么 channel、什么状态影响 Agent？
5. 不确定性在哪里，拒绝/停用的后果是什么？

### C-02 对现有契约的限制

- 复用 deriveOwnerGovernanceView、deriveOwnerDecisionView、DecisionSubject、MaterialGate、availableActions。
- DecisionSubject 已经绑定 approval artifact+channel，不把原则层面汇总文本偷偷替换成某一具体 revision 的授权内容。
- Console 仅派生、展示、调用真实服务端入口；变更权限时服务端必须重新核验，不能信任 UI 资格判断。
- 现有 approve / reject / edit_approval / disable 按真实语义呈现；未实现的 REQUEST_REVISION / AUTHORIZE_TRIAL / ADOPT 不得放进可执行按钮。
- 不把 edit_approval（替换已验证 Artifact ID）伪装成“编辑原则文字”；不把普通 approve 改名为“限时试行”。

### C-03 第一屏设计契约

默认内容按下列优先级：

**标题：** “遇到什么治理问题 / 建议改变什么”，可从当前 revision 受测的可读摘要派生。  
**证据：** 1–2 条关键事实和来源状态，而非模型长段解释。  
**改变：** 目标行为（若缺 baseline 就标 baseline unknown），不可编造 before/after 测量。  
**必要性：** 复用/局部修复的结果，若尚未评估标明 unassessed。  
**通道：** 真实 channel、shadow/live 能力、批准后果和回滚限制。  
**风险：** 冲突、证据不足、关联不完整、无法证明实施效果。  
**动作：** 只有当前服务端确实可执行且授权对象清晰的操作。

技术 ID、源 JSON、日志及完整 Scribe 文本留在逐级展开详情；所有文本进入现有 i18n。

### C-04 排序与分组

- 以既有权威治理状态区分 needs_decision、blocked、needs_recovery、processing、历史。
- 风险排序仅使用可信且有来源的字段；priority=P1 这类统一默认值不构成真实严重度。
- 首版不做无来源 LLM “重要性评分”。若真实风险信息未知，不以信心数值代替。
- 对一个治理主题关联多个 Artifact，第一步只生成只读相关性提示；不得仅因为语义相似合并不同授权。
- 不得用自动隐藏全部 pending 的方式达成“减少负担”的指标。

### C-05 UX 验收

- AC-C01：Owner 无需进入技术详情即可解释“批准将改变什么、不能保证什么”。
- AC-C02：重要异常不会排在普通待办之后且无标识。
- AC-C03：当前拒绝与停用操作的后果明确区分，历史副作用不承诺撤销。
- AC-C04：action eligibility 与服务端请求一致；UI 不从非权威提示推导批准资格。
- AC-C05：在真实页面的 AI User QA 中，不再靠查看 UUID / 原始 JSON 才能作出普通 Owner 决策。

## 7. WP-D — Principle Necessity Gate：Shadow First（P1，质量实验）

### D-01 责任和非责任

Gate 的责任是提供形成新原则之前的有依据建议；它不独立创造 Owner 的长期价值决策。

五种推荐语义：
- LOCAL_FIX：更适合当前任务局部修复；不能把建议自动转成宿主操作。
- REUSE：已存在实质覆盖的 Principle；实际复用仍遵守 PRI-917 的 Owner 决议边界。
- REVISE：现有原则有价值但需要修订范围或行为；不能自动制造正式 Revision。
- CREATE：发现值得提出新原则的独立行为机制；不等于创建得到 Owner 授权。
- OBSERVE：证据、归因或实际必要性不足；保留候选而非遗忘 Pain。

这些是 Recommendation，不是新的 Ledger status、Approval outcome 或 Runtime state。

### D-02 评价输入与审计输出

**输入：** 候选身份、原始 Pain/diagnosis 引用、已知影响程度、复用 shortlist、原有原则、适用范围、已有推荐。  
**输出：** candidateId、recommendation、targetPrincipleId（如适用）、minimumSufficientBehaviorChange、reasons、evidenceRefs、counterArguments、uncertainties、assessedAt、model/contract provenance、evaluationStatus。

必须回答：为什么不能使用局部修复？现有原则是否覆盖同一机制？新增原则相较修订旧原则有什么净收益？是否可能对无关任务施加新的负担？

不能使用“首次出现就不立原则”这种机械阈值。单次但高成本、不可逆、越权类行为值得考虑更强治理，但是否新建仍须有边界依据。

### D-03 与 PRI-917 v0.3.3 的强制兼容

**已批准的既有语义：** 自动路径有可信 reuse 推荐时挂起候选等待 Owner；推荐 create/uncertain、评估不可用/失败时，现有方案允许可观测地继续 CREATE，保障学习不中断。

**本轮不得改变这条已批准的生产行为。** v1.0 设想的“必要性评估失败就不准 CREATE”与此有实质冲突，不能通过代码顺手覆盖。

Shadow Gate：
- 不影响 Candidate Intake 的原结果和复用结果；
- 不对真实 ledger、approval、principle status 写入新治理结论；
- 不重新触发已消费候选的非幂等处理；
- 不新增另一个应由 Owner 回复的审批队列；
- 不阻断正常 host 任务与已授权 Activation；
- 记录与现有生产 CREATE 的分歧、误判、漏判和额外费用。

生产 Enforcement 的失败策略必须另行提交 Owner 决议。若未来选择改变既有 v0.3.3 的 CREATE-on-unavailable 行为，必须同步修订该权威 SPEC 并通过针对恢复/批处理/幂等/Owner 复用的完整负例测试。

### D-04 测试样本与质量判断

候选测试包含：
- 3b11b54d：弱归因、scope expansion、hard enforcement wording；
- 24da6d6e：强触发/反触发的正面样本；
- d1a3ab28：正文中存在明确不适用边界的正面样本；
- H3 同源相近三原则：必须区分“可复用”与“不同互补规则”，不能机械合并；
- 151a9c0b：局部资产事故是否被不当全局化；
- 单次严重 Owner 权限事故：不能因次数不足自动降为 LOCAL_FIX；
- 复用候选集合为空：避免无意义 LLM 调用；
- 评估超时、无效 JSON、原始证据缺失、历史 NULL 谱系：必须可观察并保持原生产结果。

评估使用独立人工/Owner 对照标签及案例推理，而非自称准确率。Shadow 输出以建议是否改善真实决策为准，不以“多阻止了多少原则”为单一目标。

### D-05 成本与生存边界

- 尽可能复用 PRI-917 shortlist 和既有诊断，不为每条 Pain 重新运行完整 Trinity。
- Shadow 初始预算：每个进入语义比较的候选最多新增一次必要性模型调用；预算不足直接标 unassessed。
- 记录新增 token、LLM 调用次数、P50/P95 延迟、故障率与实际请求占比。
- 没有经证实的收益、实际误判高或成本不受控，则停留在 Shadow，不上线拦截。

### D-06 验收

- AC-D01：所有 Shadow 建议均不修改现有 CREATE/REUSE 决议和历史数据。
- AC-D02：正向样本不会因绝对措辞、低 sample count 被机械否定。
- AC-D03：相同候选重复观察不造成第二条正式原则或重复 Owner 待办。
- AC-D04：降级时宿主继续运行；现有生产行为保持不变，差异有审计说明。
- AC-D05：Shadow 评审报告明确误判、分歧、成本与 Go/No-Go 建议。

## 8. WP-E — Scribe / Reviewer Scope and Capability Shadow（P1）

### E-01 不创建重复的 Intent Contract

现有 IntentContractV1 已具有 ownerIntent、targetBehavior、forbiddenBehavior、evidenceSource、validationExpectation。

本轮先检查：
- Scribe 是否真的产出这五个字段；
- 对应消费者是否有实际读取及运行时验证；
- 是否因缺失关联而失去 Owner 原意；
- 当前 Scribe Draft 的 applicability/antiPatterns 能否承担部分适用范围语义；
- OwnerDecisionView 的 nonApplicability 何时固定 Unknown，已有正面例外为什么未投影。

如果增加字段，必须说明现有字段不可表达的语义差距，评审与后向兼容通过后再扩展，不为了形式完整另造一个 BehaviorDeltaContract。

### E-02 最小充分行为改变

审查对象是“当前 Pain 的最小充分行为改善”，而不是更响亮的全称规范。

必须避免：
- 一次回复体验反馈升级成所有任务的强制模板锁定；
- 把局部实现细节当成永久全局规则；
- 将一个自然语言建议宣称为确定性工具拦截；
- 在没有反例时把例外列表自动视作“没有例外”。

必须允许并清晰记录 unknown、not_applicable 与可论证的范围界限。

### E-03 Capability Consistency

能力检查只针对现实中可用的 Writer、Host、Channel 和 Mode：

| 通道 | 合理证明 | 不得承诺 |
| --- | --- | --- |
| prompt | Artifact 已激活并可能进入相应上下文；有独立投递事实时可分别声明 | 强制拦截、100% 遵循、自动回归验证 |
| code_tool_hook | 在真实接线与 mode 下观察/执行对应操作 | shadow=live、单次拦截=长期行为改变 |
| defer_archive | 归档或递延的系统事实 | 未来 Agent 一定发生行为改变 |
| 其他假想通道 | 无 | 不能因历史文案或枚举外名称假定生产已支持 |

能力描述只作为现有 Owner Decision 的准确投影；如需硬约束实现，另提符合 ADR 的工程改造建议。

### E-04 与评审产物边界

Reviewer semantic mode 仅对 Scribe 原则进行语义审查，不存在的 Evaluator/Artificer 不得被补造为评审证明。Reviewer 必须把归因不确定性作为风险信息，但不得因为多个同模型角色都同意，就称为多次独立验证。

### E-05 验收

- AC-E01：正例 24da6d6e、d1a3ab28 保留原有效适用界限。
- AC-E02：3b11b54d 型 Prompt-only 不能无说明地宣称硬保障。
- AC-E03：前后意图一致，且负面案例不被非必要的全称词提升为更广作用域。
- AC-E04：模型评审与行为验证保持证据层级分离。
- AC-E05：Shadow 期间不重写现有原则、已批准工件或实际 Owner 授权。

## 9. Implementation Slices / PR Plan

**各 PR 的精确文件清单以 Phase 0 Reality Audit 为准。** 下表为已核实的主入口，不意味着需要大范围重构。

| 阶段 | 工作 | 主要入口 | 权威边界 | Exit Gate |
| --- | --- | --- | --- | --- |
| PR-00 | Reality Audit + 固定 fixtures | AGENTS.md、现有 Owner Decision/Reuse 规范 | 只读 | 有生产入口/消费者/测试/缺口映射 |
| PR-01 | Approval Trust | activation-dispatcher.ts、ApprovalsGroupedConsoleModel.ts、FocusPage.tsx | 不改历史审批记录 | 误导文案为零、标题与数量正确 |
| PR-02 | Evidence Propagation | OwnerDecisionViewModel.ts、owner-decision-view.ts、owner-decision-view-contract.ts | 复用 SourceRef/Field<T> | 真实原始证据与 Unknown 直达 UI |
| PR-03 | Owner Inbox | FocusPage.tsx、OwnerDecisionCard.tsx、已有审批路由 | 只读 Projection + 真实 Action | Owner 可以一屏解释实际授权后果 |
| PR-04 | Necessity Shadow | CandidateIntakeService、pain-signal-runtime-factory、principle-reuse | 不改变 PRI-917 行为 | 人工基准、误判、成本结果足够 |
| PR-05 | Scribe/Capability Shadow | scribe-output.ts、intent-contract.ts、rollout-reviewer-prompt-builder.ts、现有 Writer 能力 | 不改变现有原则/授权 | 正反例通过，风险识别不夸大 |

### 9.1 每个 PR 的标准交付物

1. Reality Audit：既有能力、源事实、生产接线、消费者、实际缺口与反证。
2. 修改范围：确切文件、输入输出契约、保持不变的语义。
3. 失败与降级：损坏、缺失、冲突、超时、回退说明。
4. 验证：单测/契约测试/集成、真实生产路径、必要的 E2E/AI User QA。
5. 变更证据：关键源码行与 diff、测试命令及结果、未覆盖风险。
6. Rollback：回退代码/开关后原事实不丢，且不会恢复已知不可信的“多次验证”显示。

不允许将 PR-04/05 偷渡为生产门禁。未完成 Owner Go/No-Go，保持只读或 Shadow。

## 10. Acceptance Matrix（必须可以复现）

| Case | 测试输入 | 预期 |
| --- | --- | --- |
| T01 | Scribe 有 principleDraft.statement、无顶层 text | 新摘要可读、精确绑定该 Artifact |
| T02 | 历史审批持久化 UUID 摘要 | 当前投影从合法工件恢复语义，但不改历史行 |
| T03 | Rollout confidence=0.92，无验证来源 | 显示模型评审自评，不显示多次验证 |
| T04 | 诊断 confidence=0.55、Reviewer=0.92 | 两阶段语义区分，无伪概率演算 |
| T05 | 诊断有 evidence[]，投影可访问 | 原始证据、来源、推断类别正确显示 |
| T06 | source_principle_id=NULL，但 lineage 可解 | 不错误标记整链断裂；按真实 relation 输出 |
| T07 | 只有启发式相似、无精确绑定 | 不能提供对该弱关联对象的授权动作 |
| T08 | 工件正文可读，主体身份不确定 | 仍显示身份缺口告警 |
| T09 | group.records.length=3、原证据仅1条 | 不将3称为3条原始证据 |
| T10 | Prompt 原则声称“模板强制锁定” | 提示能力冲突，不显示已实现硬保障 |
| T11 | Hook 为 shadow，尚未 live | 不显示“当前已执行强制拦截” |
| T12 | 同一个 Owner 反馈经过多个 LLM 转述 | 不能算作多个独立证据样本 |
| T13 | 旧审批 approved、Activation 失败或跳过 | 保留真实授权/执行差异，不把批准等同于生效 |
| T14 | Ledger active、Activation deactivated | 不将历史 active 错认当前 live |
| T15 | 历史按 Principle UUID 查不到 Application | 显示身份归因未知，不推断从未应用 |
| T16 | 同源 H3 三个相似候选 | Shadow 能提供复用/修订比较，而不是自动合并 |
| T17 | d1a3ab28 有不适用范围 | Shadow 不因缺机械 trigger 错杀 |
| T18 | 24da6d6e 有强边界与“必须”类词 | Shadow 不因强制词机械判不合格 |
| T19 | 单次但严重越权事件 | 不因出现次数少而机械拒绝长期治理建议 |
| T20 | Reuse 语义评估 timeout | Shadow 不改变 PRI-917 当前 CREATE-on-unavailable 行为 |
| T21 | 读取损坏 JSON 或来源截断 | 明确 Unknown、可观察降级，不编造事实 |
| T22 | Owner 点击批准/拒绝/停用 | 只走既有授权服务端操作，重新校验目标与权限 |
| T23 | 只读查看 v1.1 文档/Projection | 不新增 Runtime、Ledger、Approval 写入 |
| T24 | 同一 Candidate 重放/重试 | Shadow 不制造新原则或重复 Owner 待办 |

### 10.1 测试分层

- 纯解析和类型逻辑：Unit/Property Tests。
- 事实聚合、关联与 Unknown：Contract + Fixture Tests。
- SQLite/Artifact/Approval 跨界：集成测试，必须包括旧数据只读兼容。
- Console Owner 决策：真实页面 E2E + AI User QA，不以按钮存在当成通过。
- Host/Channel 能力：真实生产接线测试，不依据注释或模拟接口声称硬拦截。
- Permission/Migration：越权、旧历史、不一致状态、幂等及失败恢复负例。
- Shadow Gate：固定人工案例、生产中收集的脱敏案例、误判分析与成本账本。

## 11. Release / Compatibility / Rollback

### 11.1 Phase 0 — Reality Audit（先决）

任何中大型实现前必须确认：

1. 当前 HEAD / 安装 Runtime 的对齐状态；不得用新源码解释旧安装数据。
2. Owner Decision V1、governance projection、Scribe Intent、reuseEvaluation 的实际 Producer→Consumer 路径。
3. 当前 Feature Flag 的 registry、loader、生产消费者和默认值。
4. 已存在的相关测试、接口版本与历史兼容分支。
5. 改动是否会触及 ADR-0027/0028 尚未授权的未来设计。
6. 需要写入时，权威 Writer 和持久化事务纪律是什么。
7. 是否存在已经由 Owner 作出的冲突决定；冲突即停止扩范围并提出裁决。

### 11.2 Phase 1 — Trust Fix

PR-01 首先上线，不能保留可恢复虚假验证文案作为简单 rollback。若解析器改动异常，可回退新摘要展示，但始终显示 confidence 的来源不确定性。

### 11.3 Phase 2 — Evidence + UI

PR-02、03 使用原有只读模型与既有 feature flag 管理方式。是否需要新 flag 必须经过 Feature Flag Registry Reality Audit；无需多配置的 bug fix 不得机械增旗。

旧数据不作强制 backfill；不可解的历史来源合法地保持 Unknown。Flag-off 不改任何授权与 Runtime 状态。

### 11.4 Phase 3 — Shadow

PR-04、05 先在固定 fixtures 和显式受控工作区执行。Shadow 不能调用真实 Approval/Activation 的写接口，且不会产生正式 Principle。若 Shadow 存储评审结果，须明确该结果的非权威性质和可清理策略。

### 11.5 Phase 4 — Owner Go/No-Go

正式 Gate 变更另开 Owner 决策：
- 该 Gate 是否真的减少不必要原则，而没有误阻有用学习？
- 是否接受其额外模型成本与延迟？
- 冲突于 PRI-917 v0.3.3 的评估失败语义是否需要正式修订？
- 弱证据/高危 Pain 的失败策略是什么？
- 如何不增加另一批 Owner 待办？
- 正式写入边界、幂等和回退是否已验证？

没有新的明确决议，不得默认从 Shadow 自动升级生产门禁。

## 12. 可测量的成功标准

### 12.1 必须达到的正确性目标

- 当前 UI 虚假验证声明 = 0。
- 由审批数量冒充原始证据数量 = 0。
- 无授权的新执行范围提升 = 0。
- 被模糊语义匹配单独支持的授权动作 = 0。
- 已确认的 Prompt-only 硬保障错报 = 0。
- 历史真实决策被静默改写 = 0。

### 12.2 需要建立测量口径的体验指标

- 单条审批的 Owner 中位理解/决策耗时，旧版与新版同样本比较。
- 为做决定需要进入的页面数及是否查原始 JSON。
- 证据不可复核的审批占比及相应恢复原因。
- Owner 无法说清“批准后果”的比例。
- 必须 Owner 裁决的实际事项数，不以隐藏审批制造降幅。
- 每个候选的新增 token、调用、延迟和超时。

**50% 决策时间下降**可作为探索性改善目标，但不是在没有基线的情况下声称可保证的上线结果；不得通过削弱控制权完成该指标。

### 12.3 Shadow 判断标准

定量统计建议类别分布、与人工判断的一致与分歧、误拒高质量原则、误放宽泛原则、误将互补原则合并为重复、额外模型成本。设定明确评审会议和 Owner Go/No-Go，而不是用单一 LLM 质量分数宣告成功。

## 13. Risks / Negative Scenarios

| 风险 | 禁止的失败方式 | 缓解措施 |
| --- | --- | --- |
| 第二事实源 | Console 新写 OwnerDecisionState | 只读投影、现有写入权威不变 |
| 历史数据污染 | 为让新卡片完整而补造已验证结果 | Unknown、reasonCode、来源约束 |
| 语义欺骗反弹 | 只修新写入，旧 summary 仍含虚假 confidence | 新旧读路径一起修复并测试 |
| 过度防重 | 语义近邻一律 REUSE，丢失互补原则 | 先比较因果机制、适用边界、行为差异 |
| 过度谨慎 | 凡单次 Pain 一律 OBSERVE | 允许高损失、不可逆场景进入人工高优先级判断 |
| 门禁阻断宿主 | Shadow 失败卡死 OpenClaw/Codex 任务 | Host fail-open、异步/受控评估、预算 |
| 审批洪水 | 多一种 Gate 就多一个待办 | 无实际 Owner 责任时不制造授权审批 |
| 权限漂移 | “试行”按钮背后永久 Activate | 暂不引入假的授权语义 |
| Scope 漂移 | 对局部反馈生成全局必需护栏 | Scribe / Reviewer 对适用与不适用边界做反例审查 |
| 写入旁路 | 直接 patch ~/.pd/runtime 或无日志事务 | 只改源码，遵守 ADR-0024、installer/update 权威 |

## 14. Owner Decisions（不能由实施 Agent 代替）

- **OD-01 本轮范围：** 建议批准 PR-00 至 PR-03 的实施评审与窄范围修复；PR-04/05 仅 Shadow。
- **OD-02 正式 Necessary Gate：** Shadow 之前不授权生产阻断；之后根据误判、成本与恢复合同再决定。
- **OD-03 PRI-917 冲突：** 现有 CREATE-on-unavailable 属已批准的 v0.3.3 行为；是否改变必须独立裁决。
- **OD-04 历史原则：** 仅进行只读复审与展示修复；是否更改 32 条 Pending、7 条 Active 需要独立确认。
- **OD-05 新的“限定试行/修订/采纳”动作：** 本轮不授权服务端生命周期新增。
- **OD-06 既有 ADR-0027/0028：** 若正式获接受，先对齐后实施；不能将 Proposed 设计偷渡为当前事实。

## 15. Definition of Done

本轮 SPEC 评审通过的条件：
- 逐项有 Reality Audit：已存在但未接通 / 语义错误 / 真正缺失。
- Owner 的权限和现有 ADR 边界得到书面确认。
- 每个 PR 都有真实生产路径测试和反向失败测试。
- 原始证据及其不确定性在第一屏可见。
- 当前审批没有虚假的验证和执行能力声明。
- 复用和必要性 Shadow 的推荐有可复查成本、误判与分歧数据。
- 没有第二套事实源、授权状态机或被动开启的长期归因能力。
- 安装 Runtime、历史审批与既有原则没有被本设计/文档编辑影响。

**正式原则形成门禁与后续长期效果治理不作为本轮交付完成的硬依赖；它们保留单独的 Owner 决策点。**

## 16. 关联文档与事实核查入口

- docs/specs/OWNER_DECISION_EXPERIENCE_V1.md
- docs/superpowers/specs/2026-08-20-principle-governance-projection-contract.md
- docs/specs/PRI-917-semantic-reuse-adjudication-v0.3.3.md
- docs/specs/PD_CORE_VALUE_PIPELINE_GOVERNANCE_SPEC.md
- docs/adr/0024-pd-runtime-mutation-governance.md
- docs/adr/0027-principle-intervention-evidence-and-delivery-contract.md（Proposed）
- docs/adr/0028-owner-principle-assets-and-evolution.md（Proposed）
- docs/product/PRODUCT_IDENTITY.md
- docs/plans/post-mvp-conditional-roadmap.md
- packages/principles-core/src/runtime-v2/internalization/intent-contract.ts
- packages/principles-core/src/runtime-v2/owner-decision/owner-decision-view-contract.ts
- packages/principles-core/src/runtime-v2/owner-decision/owner-decision-view.ts
- packages/principles-core/src/runtime-v2/candidate-intake-service.ts
- packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts
- packages/principles-core/src/runtime-v2/activation/activation-dispatcher.ts
- packages/pd-console/src/server/models/OwnerDecisionViewModel.ts
- packages/pd-console/src/server/models/ApprovalsGroupedConsoleModel.ts
- packages/pd-console/src/ui/pages/focus/FocusPage.tsx
- packages/pd-console/src/ui/pages/focus/OwnerDecisionCard.tsx
- 外部独立核查报告：PD-APPROVAL-AUDIT-2026-10-10.md（实际文件路径由本地审计工件定位，不能假设已入 Git 仓库）

---

**本 SPEC 是设计与实施评审候选，不宣称已经完成上述功能，不代表 Owner 已批准改写权限边界。**
