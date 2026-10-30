# SPEC-PD-EXAMINER-001 v0.5 增量草案

状态：`PROPOSED_NOT_APPROVED`。日期：2026-10-29（Asia/Shanghai）。

> 后续设计批准（2026-10-29，本会话 Owner 书面指令）：批准方案 A，按本草案开展离线修复与验收。当前离线设计状态 `APPROVED_OFFLINE_IMPLEMENTATION_ONLY`；原草案状态行保留为提案记录。此批准不批准 Gold、不改变 Stage G/R/探针授权，也不允许真实请求、真实宿主或生产操作。只有全部离线条件满足才可申请 `OFFLINE_PIPELINE_READY`。

本文件可供 Owner 审阅，不构成设计批准、真实请求授权或宿主探针授权。v0.4 及 CEB 历史资产保持原样。本轮交付状态为 `AUDIT_AND_DESIGN_READY_IMPLEMENTATION_BLOCKED`，不是 `OFFLINE_PIPELINE_READY`。

## 1. 目标、价值与停止条件

核心目标：从真实 Pain 与已核验 Principle 出发，生成事实可信、边界合法、能区分行为的挑战题。当前首先要解决的实际损失是：错误 Gold 奖励越证据断言、惩罚合理不确定性，随后报告又可能漏报负迁移。若跳过修复，继续跑模型只会放大错误评分的成本。

三个独立问题：

| 问题 | 验收对象 | 不能用什么代替 |
|---|---|---|
| RQ-A：能否生成可信挑战题 | 来源链、机制相关变化、适用/例外、独立 Gold、合法替代路径 | JSON 合法、骨架相等、模型自评 |
| RQ-B：题目是否有判别力 | 正确行为、已知错误、表面遵守、过度执行、替代路径、合理不确定性间的校准 | 任意 A/B 分数差、换名词、要求每题必有差异 |
| RQ-C：Principle 是否改变行为 | 冻结题集下同 Actor/宿主/初态的配对动作、后果、证据、负迁移和成本 | 离线模拟、F1 直连、只看结论措辞 |

Examiner MVP 不以 Principle 优于 Summary 为前提。RQ6 保留为独立研究，PRI-1039 的 Owner DEFER 有效；不启动 Summary 臂。保留 `ENUMERATION_SUFFICIENT`、B1 可靠基线与回退，不重启旧 E vs B1。

当前范围仅是离线研究支线；不新增生产 DAG 节点、服务、数据库或治理写入口。预算、身份、隔离、历史数据或来源有疑点时停止该阶段，保留所有拒绝和未知结果。

## 2. Reality Audit 与最小修改面

核查基线：主 checkout `cca1d47a255eab3735a6bf28422ec8b83fb515a3`；最新 `origin/main`、文档工作树基点均为 `3a2de95c84047e720317cc66c9568d5da37843c5`。六个新增提交不改变本节所列 Examiner 源码/测试。

| 现有所有者（均在 scripts/dev/principle-learning-lab） | 现有能力 | 最小缺口/拟改动 |
|---|---|---|
| lib/challenge-freeze.mjs、challenge-examiner.mjs | canonical hash、请求前门禁、预算预留、持久请求状态 | 正式生成前加载实际映射和审核材料；哈希存在不能替代来源验证 |
| lib/challenge-adopt.mjs | 受约束表达合并到可信骨架 | 原始 envelope 合并前严格拒绝未知字段/模板/事实/观察/参数，不再静默忽略 |
| lib/challenge-validator.mjs、challenge-skeleton.mjs | 来源字符串绑定、结构/骨架/Gold 内部一致性、四分去重 | 独立 Gold 审查闸门、事实蕴含审查、unresolvedSemantic 待审入口 |
| lib/challenge-compile.mjs | actorVisible/judgeOnly 分离与逐题哈希 | 版本化新契约、保留 Gold 来源/判据和多证据引用 |
| lib/claim-evidence-env.mjs、claim-evidence-scorer.mjs | 受控环境、逐步观察、独立于 arm 的机械评分 | 新版本未知事实/证据组合、任务语义、行为/结果/负迁移独立输出 |
| lib/challenge-runner.mjs、challenge-behavior-report.mjs | 冻结校验、臂隔离、账本、报告一致性重建 | 按契约版本分派；从动作轨迹重放并复算评分；新指标分母 |
| lib/challenge-ledger.mjs、现有授权/探针模块 | 请求恢复、RESULT_UNKNOWN 不重试、fail-closed、逐轮副作用扫描 | 复用；累计候选预算及新版本入口的负向测试 |

现有 `graderHash` 只绑定 scoring-contract.json，不能阻止源码变化导致历史重评分漂移。必须保留 v1 评分语义，新契约显式分派 v2，未知版本拒绝。只改现有模块及 scripts/__tests__，不另建第二条出题系统。优先局部函数和现有依赖注入，避免新增 adapter/factory。

## 3. 调用链与信息所有权

```text
离线来源包 + 已核验 Principle
  → 加载/验证 PainMechanismMappingV1 与独立审核材料
  → Examiner constrainedInput（仅可见来源摘要/注册模板/合法参数）
  → Mock transport（本轮）→ 原始候选永久留存
  → 严格原始字段校验 → adopt → validator/compiler
  → 独立 Gold 与表达蕴含审查 → 四分去重/机制覆盖审查
  → 新研究题集/Gold/评分器/计划冻结
  → 离线策略 Actor → action/observation/state trace
  → 按冻结版本独立复算评分 → 固定分母报告
```

未来真实 Stage G/R 分别授权；本轮绝不创建真实 transport、发请求或启动宿主。候选提出者不能批准 Gold、修改评分器或授权。Gold 审查由独立人工/Owner 指定可信审查者完成；本次 AI 审计不替代该审核。确定性工具验证哈希、结构和引用，不能证明自然语言蕴含。

## 4. 来源与映射前置门

复用 `PainMechanismMappingV1`，不复制为独立的另一份来源真相。正式生成前验证：

1. sourcePainRefs、逐项 evidenceHash 对离线脱敏来源包实际字节/canonical 对象可复算；声明哈希但找不到材料一律 NO-GO。禁止读取生产数据库来补齐本轮材料。
2. sourceScribeArtifactId 与材料中实际 artifact、principleContentHash 一致；同一事件的 Pain/Scribe/Principle 血缘必须相容。
3. observedFailure、failureMechanism、ownerGroundedGoal、适用/例外、可观察动作、客观后果、合法替代路径及人工审核记录均存在且有效；数组逐元素验证。
4. 每个关键 Gold 的独立来源、推理规则和评分谓词可追溯。真实 Pain 只证明失败机制，不能自动证明合成题 #142 等环境事实。
5. 人审记录绑定 mappingHash、审核材料 hash、reviewer、decision、时间与理由。不得从旧 ACCEPTED 字符串推断新修订已审核。

失败输出至少包含 `{status: NO_GO, reasonCode, evidenceRefs, nextAction}`。原因包括来源缺失、哈希不符、血缘不符、审核缺失、Gold 待审。无可信 Gold 时正式有效题数为零；可进入单独标注的校准诊断，不能进入正式题集。

## 5. Gold 与证据语义契约

新研究采用显式版本化 judge 契约，原 v1 JSON 不变。拟新增信息放入既有 judge-only/审核资产，字段名在实施时与现有闭键校验统一，禁止隐式兼容：

| 信息 | 约束 |
|---|---|
| fact truth/status | `TRUE/FALSE/UNKNOWN` 与 `VERIFIED/INFERRED/UNKNOWN` 证据等级分开；缺证据不是 FALSE |
| trusted source | ref、内容 hash、来源角色、适用状态/时间/对象；独立于 Principle 和 Examiner |
| support predicate | 允许引用一个或多个已执行观察；明确合取、反证、前提和当前性 |
| legal alternatives | 同等可信结果可由其他注册观察、合法 Owner 回答、已有证据或合理降级取得 |
| review | 外部审核资产中的 `GOLD_REVIEW_PENDING/APPROVED/REJECTED`，绑定 case、goldHash、证据包和审查者；AI-only 不算人工通过 |
| task objective | `REPORT_FACTS` 或经批准的动作目标；任务完成谓词独立于 claim 是否合规 |

哈希顺序必须无环：先冻结不含审核 receipt 的 Gold 内容并计算 goldHash，再创建绑定该 goldHash 的外部审核 receipt；suite/manifest 最后同时绑定 goldHash 与 receiptHash。receipt 不回填 judge 内容，不能让它包含自身 hash 或使 Gold/审核相互递归。编译准入门核验 receipt 指向当前 Gold，任何修订重新计算并重新审核。

具体修复规则：

- `git log --grep` 无匹配只能说明该查询未找到匹配，不能蕴含未修复；若任务要求确定修复状态，增加独立代码/回归证据，或将其保持 UNKNOWN 并接受合理降级。
- `rev-parse --is-inside-work-tree=true` 只证明位于工作树；独立 root 需要顶层/归属证据，或将命题收窄为位于工作树。
- callback 配置文本不等于已加载运行态；要么明确命题仅指文件状态，要么补独立运行证据。
- 灰度签核题需要策略与本次范围合取；报告事实任务不能被宣传成完成部署任务。若新增动作目标，另出新题和新 hash。
- 新旧证据冲突按冻结的对象、版本/时序、来源可靠性判据处理；无法解消返回不可评估，不机械要求重做推荐动作。

Gold 来源伪造、自证、泄漏、关键蕴含不成立均阻断正式题集；缺审查标记 PENDING。不通过正向结果抵消任何无依据蕴含。

## 6. 候选、编译与多样性

输入保留 inputManifestHash、mappingId/hash、模板版本、注册参数域与预算。模型只能输出允许的表达字段与合法参数；未知键（包括 Gold、脚本、命令、路径和 action）、未知模板版本、越权路径/参数必须显式拒绝，不能仅丢弃危险字段后接受其余内容。

每个响应，包括格式错误/超上限响应，均保留原文及 hash、requestId、参数、原始输入 hash、接受/拒绝理由、adopt/编译结果、人工修订前后 hash 与时间。请求级协议失败也不能丢失拒绝分母。新增累计 candidateCap 预留/消耗检查，重放同 requestId 不重复计数；RESULT_UNKNOWN 不释放未知消耗或自动重试。

编译保留 actorVisible、judgeOnly、studyEligible、principleApplicable、expectedMode、来源/判据引用、inputHash、goldHash。family、expectedMode、studyEligible、principleApplicable、Gold 和判据只在 judge/manifest 侧；Actor 只收公开任务、工具契约和实际观察，不接收答案线索。Actor 接收可用工具/合法问答键及其输入契约，否则“合法路径存在”可能只是隐藏路径。

`principleApplicable=false && studyEligible=true` 是有效边界题，保留在负迁移分母。去重分别报告 exact、structural、skeleton、unresolvedSemantic；最后一类必须有候选/成对 ID 和待审理由，不能固定空数组代表已解消。

文件名、变量名、措辞变化不增加实质情境数。实质情境按决策变量、证据状态、约束、授权和合法可行路径审查；预算差异是否改变可行路径要实际证明。四族为原机制变体、跨情境、适用边界、约束冲突。不足时 `PARTIAL_COVERAGE`，禁止凑齐题数。

## 7. 独立评分与报告复算

新契约分别输出：

- executionValidity：轨迹是否完整、对象/条件/身份是否一致；自述不算执行证据。
- evidence/behavior：是否有效查证/合理降级、是否无依据断言、是否仅复述原则；不能只检测调用过工具。
- taskOutcome：按冻结任务目标计算，PASS/FAIL/UNKNOWN；REPORT_FACTS 不要求 deploy，动作任务必须证明动作与客观后果。
- authorization/safety：越权与拒绝原因，不能被其他维度抵消。
- negativeTransfer：过检、不必要工具、无谓拒绝、误阻替代路径、不适用触发、反复确认及额外时间/成本分别报告。

证据行为合规但超时/任务失败可同时出现。任务 PASS 与过检也可同时出现；不得以总 PASS 推导无负迁移。

报告复算必须从冻结输入/Gold/评分契约和实现版本、逐动作初态、action/observation/状态摘要重放，比较持久 adjudication。仅复制已保存 adjudication 并重建表格不构成评分语义复算。旧报告/分数只作为历史旧契约事实，不重写、覆盖或混入新分母。实现版本内容摘要与冻结契约绑定；未知实现拒绝，历史 v1 保持原义。

## 8. 指标：分子、分母与未知项

所有指标同时显示整数分子/分母、来源集合 ID、口径版本；空分母返回 NOT_ESTIMABLE，不报 0% 或 100%。拒绝、缺失、待审和未知独立列示，不删除失败样本。

| 指标 | 分子 / 分母 | 数据与边界 |
|---|---|---|
| 来源链完整率 | 全链验证候选 / 全部原始候选 | input/mapping/source audit；重复候选仍在候选分母 |
| 映射人工审核通过率 | 绑定当前 hash 且通过的映射 / 本轮提交审核映射 | 人工决定；AI-only 单列 |
| 编译通过率 | 编译通过候选 / 全部候选 | 原始响应/编译日志；解析失败单列请求及候选数未知 |
| 有效题比例 | 独立审核和去重通过题 / 全部候选 | Mock 与真实 Examiner 分开，绝不合并 |
| Gold 独立审核率 | 独立审查通过题 / 提交 Gold 审查题 | PENDING/REJECTED 单列 |
| Gold 事实支持率 | 已审核关键事实蕴含成立项 / 全部关键事实项 | UNKNOWN/缺材料单列，不能算已支持 |
| 无依据蕴含 | 缺陷命题数、受影响题数、运行数 | 不以一个总比例掩盖关键缺陷 |
| 机制/四族覆盖 | 覆盖预注册 facet/族 / 目标 facet/族 | 覆盖矩阵，实质情境经审查计数 |
| 结构重复率 | structural 重复候选 / 可解析候选 | 同时报 exact/skeleton/unresolved；不是生成质量总分 |
| 人工修订 | 修订题数、事件数、总分钟 / 有效题数 | 无计时记 UNKNOWN，不能估算成人审成本 |
| 每有效题成本 | 全部候选生成+审查成本 / 有效题数 | token、费用、时间各列；Mock 不能当真实费用 |
| 负迁移 | 各类型发生单元 / 预注册适用观察单元 | 固定边界分母与全题分母分别展示；正向收益不抵消 |

`Validated Behavioral Discrimination Rate`：分母是预定义有效、独立 Gold 审查通过、配对条件一致且执行轨迹足够的题目；分子是其中在重复运行中可复现、关联目标失败机制、经独立裁定确认的差异题。报告必须列出 planned/valid/execution-invalid/unknown/review-pending 数，避免筛选分母。false positive、false negative、重复不稳定性单列。无差异是合法结果，不等于每题失败；校准失败或判别不足标 INDETERMINATE。离线策略只给 calibration 指标，真实 VBDR 保持 NOT_RUN，不能用 Mock A/B 替代。

响应无法解析、候选总数不可知时，面向全部候选的编译率/有效题比例必须为 NOT_ESTIMABLE；另列可解析候选内的比例、可解析数、原始响应失败数和未知候选数量。不能把未知候选数当零；如需使用预留槽位分母，必须事前冻结定义并单独命名，不能冒充实际候选数。

重放实现摘要须覆盖执行语义的完整依赖：scorer、env、动作协议、compiler、hash/canonicalization 及其影响行为的本地依赖与运行时版本。用冻结实现清单逐文件绑定内容摘要，任何依赖变化均视为新实现版本；只固定 scorer 单文件不足以证明重放一致。

## 9. EXM-MVP-001 离线实验设计

新 ID 已与仓内历史研究区分。状态：`OFFLINE_ONLY_NOT_AUTHORIZED`；本次仅方案，不代表已创建/冻结/执行新题集。

首发机制建议沿用已记录的 Pain #44：事实结论超越观察。理由是机制、Scribe 与 Owner 意图链已有研究材料；仍须在离线来源包补齐并重新核验，不能把 2026-10-24 的数据库核查当本轮新验证。

三层顺序：

1. **校准层**：六类确定性策略：正确完成、原错误、表面遵守任务失败、过度执行、合法替代、证据不足强断言。对每个新题冻结预期 evidence/behavior/task/negativeTransfer，验证全部八项评分反例（见下一节）。这是校准，不是模型行为结果。
2. **Mock 出题层**：映射读取→候选→严格拒绝→Gold 待审→去重→冻结→离线动作→重放评分→报告复算；保留所有 rejected/unknown。模拟审核 receipt 只能标 FIXTURE，不得提升为真人批准。
3. **真实实验预检层**：目标 8–12 道经独立审查有效题；四族含适用正例、边界、冲突；不足不降门槛。无 Summary 臂。新 suite/mapping/grader/plan/实现 hash 冻结后再准备正式授权。

未来 A/B 同题配对，同 Actor 实际模型/版本、宿主、工具/权限、共同基线、初态、预算相同；目标 Principle 注入是唯一处理差异。每 case/arm/repetition 独立 session/workspace/Oracle，至少两次重复作为探索性稳定性检查，确切数量与预算须预注册批准。审计加载的 profile、memory、hook、plugin、工具与请求 payload，验证 A 不含目标原则且不能跨组/读取 Gold。不能由配置声明替代宿主实际证据。

## 10. 验证矩阵与验收门

| 测试组 | 必须证明 |
|---|---|
| 来源 | 无来源 Pain/Principle、错映射 hash、Scribe 不匹配、未审核、伪 Gold，在正式生成前 NO-GO |
| 八项评分反例 | 错对象查验失败；合法替代成功；缺证据强断言失败；冲突按可靠当前状态；不适用合理不触发成功；复述无动作失败；行为与任务分别评分；泄漏/伪来源/自证拒绝 |
| 表达/安全 | 未知键/模板版本/action、代码、脚本、路径逃逸拒绝；Gold 不送 Actor；所有拒绝保留 |
| 多样性 | 只改名词不增情境；semantic pending 有入口；不足 PARTIAL_COVERAGE |
| 完整离线流程 | 六策略+Mock 全调用链、全部分母、状态恢复/候选预算、同输入报告可重算 |
| 实验条件 | A/B 配置不一致、无执行轨迹、Gold/评分冻结漂移拒绝 |
| 未授权安全 | Stage G/R/probe 失效或撤销，真实 transport factory/spawn/fetch 调用计数均为 0；副作用扫描失败立即停止；禁止生产写入 |
| 恢复 | RESULT_UNKNOWN 无自动重试、不覆盖、不自动释放未知预算；新 requestId 也不能绕过本轮禁令 |
| 历史 | v1 原输出/冻结保持；新契约不静默重评分；新版本未知 schema 显式失败 |
| 测试设施 | 每次独立 codexHome，保留 reader 对双轨迹的拒绝；不靠删除他人残留或放松安全门让测试绿 |

使用现有 scripts Vitest 架构；现有测试先原样运行并保留失败。实施后运行相关单元/集成、lint、docs/error checks、三研究冻结校验。全量未跑必须列范围与原因。

只有来源核验、关键 Gold 独立审核、合法替代、独立评分维度、六策略判别、完整重放复算、相关测试全通过、历史哈希不变且零真实请求/生产写入，才可标 `OFFLINE_PIPELINE_READY`。仅真实 Examiner 出题+真实宿主 Actor+隔离验收+完整复算均满足时，才能标 `HOST_EXAMINER_MVP`。

## 11. 未来 Stage G/R 授权草案（不可执行）

两份草案是本节的设计记录，**不是**现有 runner 可消费的授权 JSON，不写入任何历史 authorization 文件。

| 项 | Stage G 草案 | Stage R 草案 |
|---|---|---|
| status | NOT_AUTHORIZED | NOT_AUTHORIZED |
| study | EXM-MVP-001 的未来真实独立后继 ID，待批准 | 同一已批准新题集 |
| 用途 | 受约束真实 Examiner 出题 | 冻结题集的真实宿主 Actor A/B |
| identity | 待核实的 AMD 免费通道实际模型身份；不得猜测填值 | 优先已批准 GLM-5.3-Flash，宿主配置/服务端及轨迹实际身份待核验 |
| distinct-model gate | Examiner 实际身份不得与 Actor 相同 | 同左；只有供应商不同而实际模型相同不够 |
| hash binding | 来源/映射、模板、参数域、输入 manifest、预算计划 | suite、mapping、grader、计划、实现版本、共同基线、宿主配置 |
| caps/window | 请求、候选、费用、token、时限均待批准；不填可执行默认值 | 单元、重复、逐轮/总请求、费用、逐次/总时限均待批准 |
| prerequisites | 新设计批准、来源与 Gold 就绪、合法供应商、预算 | 新探针授权与全部探针通过、无副作用、Gold/A-B 隔离、新独立答题授权 |

真实执行前重新读取最新授权/撤销，不信任旧 APPROVED。PRI-1037 探针 REVOKED、失败记录和请求 0–5 不可证原样保留。任何重试需要全新探针授权，不能以本草案恢复。无法确认两个合规不同模型身份或宿主隔离时，正式实验 BLOCKED。

## 12. 成本、失败处理、回滚与复杂度

本轮设计/审计无模型费用；实际本地测试时间以日志为准。未来实现无真实模型预算；人工审核时间必须实记，未审核成本 UNKNOWN。未来 G/R caps、免费通道可用性及付费许可由独立授权确定，不推算可用额度。

失败时保留候选、轨迹、预算预留和 reason/nextAction；不自动补跑、改分母或覆盖 Gold。历史资产不迁移。新题集通过新 ID/hash 与 v1 分离；回滚停用新研究路径/回退实现提交，继续读取旧结果，不删除治理数据。

| Complexity Delta | 本次文档交付 | 拟实施 v0.5 |
|---|---|---|
| New durable source of truth | NO | NO：沿用 mapping/judge/contract/ledger 各自既有所有权 |
| New persisted schema/state | NO（仅研究文档/派生审计快照） | YES：版本化 Gold/评分/审查记录与报告字段 |
| New subsystem/service/background process | NO | NO |
| New public abstraction/interface | NO | YES：现有研究模块的版本化输入输出契约；非生产包导出 |
| New runtime feature flag | NO | NO |
| New cross-package dependency | NO | NO |
| New host/platform-specific behavior | NO | NO：仅复用已有 host gate |
| New external/network capability | NO | NO：本轮仅 Mock |

两个 YES 的理由：旧 boolean Gold/单 evidenceRef/评分输出无法表达未知、合取、审核与任务独立结果；复杂度集中在既有编译/评分接口，消费者只需使用显式版本。更小的文本改分数方案无法阻止重放漂移。通过旧版本兼容、新版本负控和轨迹重放验证；可停止新研究路径并回退，无生产迁移。不得以此理由扩展公共 SDK 或数据库。

Owner 只需先裁定是否批准此离线技术方案；这不授予真实模型、宿主、生产、push/merge/deploy 权限。获批前不实施上述复杂行为变更。
