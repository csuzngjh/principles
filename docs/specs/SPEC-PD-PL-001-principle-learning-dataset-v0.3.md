# SPEC-PD-PL-001 v0.3 — 原则学习识别与净价值评测协议

> **English:** Evidence-Dependent Principle Learning, Deployment & Net-Value Evaluation  
> **状态：** Draft / Owner Review Required；**仅授权研究设计和离线核验，不代表正式研发、治理或实验实施授权**  
> **日期：** 2026-10-14  
> **基础版本：** [SPEC-PD-PL-001 v0.2](SPEC-PD-PL-001-principle-learning-dataset-v0.2.md)，保留原文  
> **独立评审：** [REVIEW.md](../../.tmp/2026-10-14-pd-pl-independent-review/REVIEW.md)（项目内本地路径；该报告本身不是新实验证据）  
> **本地核验基线：** D:/Code/principles，Git HEAD 39ebac3f56dc5394844284166c867d2266b159a7；既有未提交/未跟踪文件不改动  
> **产品权威：** AGENTS.md、docs/product/PRODUCT_IDENTITY.md、适用且未被取代的 ADR、既有治理与事实权威  
> **阶段定位：** PR-00 研究协议核验 → 最小可判别 Pilot → 小规模扩展决策；**禁止直接规模化建设**

---

## 0. Owner 决议摘要

### 0.1 我们究竟研究什么？

PD 是 **Owner-governed AI Agent behavior internalization system**，不是通用 Memory、Harness 或工具调用修复器。其研究对象是 **Principle（原则）**，而非 Owner Intent、Preference、Error、提示词形式或某次任务成功率。

**研究定义：** Principle 是可持续复用、受适当权威治理的抽象决策依据：它说明在何种情境下保护什么目标或约束、基于什么理由与证据、如何改变可观察行动、何时需要例外、冲突协调或重新审查。它可以通过提示词、记忆、运行时约束等方式实现；**“原则”不是与 Memory/Prompt 技术上互斥的存储类别**。

原则可包含两种需要分别处理的内容：

1. **规范性承诺（normative commitment）**：Owner 对目标、取舍与权限的授权选择。事实成功/失败不能自行废止其权限约束。
2. **经验性信念（empirical belief）**：特定策略在特定环境会产生何种后果的可检验判断。新证据可挑战其适用范围或因果理由，但没有自动获得修改 Owner 承诺的权力。

**执行形式（delivery/execution representation）** 是第三种不同对象：同样的理由与边界，在实际只投递压缩 statement 或附加 MANDATORY 包装时可能诱导不同的行为。严禁把“完整档案存在”直接当“Agent 收到了全部信息”。

目标不是证明模型内在形成了不可直接观测的心理结构；只评估**历史经验依赖的可观察决策差异**、可迁移性、权限约束、真实后果和 Owner 净收益。

### 0.2 关键问题与可允许的结论

我们要在真实代码与受控实验下判断：

- **经验增量**：相关经历及其关键证据是否改变候选原则的选择/范围与未来行动？
- **抽象增量**：从经验提炼出来的原则，是否比直接复用原始经历或高质量摘要在未见任务中更有效或更省成本？
- **投递与治理增量**：相同内容经 PD 的现有批准、激活、投递和撤销机制是否更可靠、可审计、可控制？
- **整体 Owner 净价值**：质量/风险/时间/误阻/纠错减少带来的好处，是否抵偿计算、审批、改写和长期维护负担？

这四个 **Claim** 相互独立。一层成功不得冒充其他层的证据。**B2 输给强 Memory、没有经验敏感性、甚至 Owner 净价值为负，都属于合法结论**。

### 0.3 立即实施判断

| 阶段 | 决议 |
|---|---|
| PR-00：核对源码、契约、样本来源、审计文档 | **GO（只读）** |
| 更新研究契约及裁定语义 | **GO（本文档设计）** |
| 冻结完整 Schema + 一次性构造 6 PLE / 24 Probes | **NO-GO**，先做最小判别实验 |
| 仅一个 PLE 的独立、隔离、可证伪 Pilot | **Conditional GO**：满足本 SPEC 的预注册、输入隔离、权限及裁定门 |
| 扩建长期数据集、正式 Revision/Binding 或新在线门禁 | **NO-GO**，须后续独立决策 |

---

## 1. 审查证据、权威与已知事实

### 1.1 本次修订的来源口径

- **源码/文档事实**：当前 Git 基线中的真实 TypeScript/JS、现有状态机/Manifest/测试及权威规范。实现事实必须高于旧研究笔记。
- **历史结果**：EP001、EP002-R3、R4 及 PRI-904 的已有记录；未经本轮复跑及独立重裁，不做新的强因果声明。
- **独立评审发现**：REVIEW.md 提供源码定位、测量矛盾和风险。它可以驱动实验修订，**不能替代受控对照的数据**。
- **研究假设**：本文中尚未验证的增益、选择标准、Owner 价值、因果机制；一律待实验验证。

### 1.2 实现事实与不可偷换的契约

| 事实源 | 已核实/评审指出的现实 | 本 SPEC 约束 |
|---|---|---|
| AGENTS.md / PRODUCT_IDENTITY.md | Evidence over assumption；单一事实源；Owner 治理；MVP-first；Pain 并非所有工具 Error | 先审能力后新增；不扩大生产 Pain 入口 |
| PhilosopherOutputV1 / prompt-builder | 当前 Philosopher 要求产生单个 candidate 和 rationale/scope/risks；**不是可自由 abstain 的完整准入决策入口** | 单独研究上游 admission/reuse 与已准入的生成质量 |
| ScribeOutputV1 / scribe-prompt-builder | statement、rationale、applicability、antiPatterns 和 IntentContract 分字段；生产协议以 statement 承载需投递的关键行为条件 | 审核**实际投递字节**是否保留 trigger/action/exception，而非只审完整档案 |
| prompt-activation-reader-contract.ts | reader 主要读取 text 或 principleDraft.statement；渲染器带 MANDATORY / active behavior constraint 包装 | 冻结内容 hash、实际 payload hash、包装/顺序/预算来源；不要假设完整元数据已送达 |
| host-runtime/active-principle-prompt.ts | 存在固定预算（历史源码评审记录 2000 字符预算）与选择路径 | 记录截断、实际暴露、原则集合及竞争曝光；具体数值实施前再核 HEAD |
| experiment-manifest.v1 | 已有真实实验元数据与行为结果字典；NOT_REACHED 由 Evidence Package 派生 | 新研究指标放 sidecar，不用新标签污染原 Manifest |
| evidence-package.mjs | 零 activation 时 behavior_change 为 NOT_REACHED；该事实**不代表无 PD 对照没有可评估行为** | 保留 pipeline 结论；每个实验臂另有统一 Actor 行为观察 |
| IntentContractV1 | 生产 ownerIntent/targetBehavior/forbiddenBehavior/evidenceSource/validationExpectation 已有契约 | 研究侧引用原始字段，不建立第二份可编辑权威 |
| ADR-0027/0028 | 本次检查时为 Proposed，正式 Owner asset、immutable Revision、Binding 未可假定 | 只做修订建议实验；正式资产操作另立授权 |
| SPEC-OGQ-001 v1.2 / PRI-917 | 已有必要性、语义复用、范围/能力 Shadow 设计与部分实际路由能力 | 本 SPEC 输出离线标注/误判分析，**不另建线上 Necessity Gate 或生产 Shadow Hook** |

**重要区别：** antiPatterns 指应避免的行为，不是 non-applicability；无显式来源不得从“不要做 X”推断“出现 X 则此原则不适用”。

### 1.3 历史数据准确归类

| 历史资产 | 可用证据 | 不得宣称 |
|---|---|---|
| EP001 | principle-quality 曾得 90/100 文本质量，行为为零注入、INCONCLUSIVE | 不可继承为行为已证的 Gold Principle |
| EP002-R3 | 治理阻断、NOT_REACHED，treatment 未运行 | 不是已观测的行为退步，也不是学习成功 |
| R4 09-16 / 09-17 | 早期报告有 Shadow；**09-17 后续文件已有真实 live 拦截和 revoke 后观测** | 能说明运行时对执行的干预，**不能证明自主迁移/长期内化** |
| PRI-904 Phase C | 基础查验 C1/C0 均 20/20；11/20 vs 3/20 的探索性差异；评审指出 T3 表格/脚注、T4 夹具、NO_REPLY 分母问题 | 重新裁定原始轨迹之前，**不把探索数字当已确认效应量** |

参考本地文件：D:/pd-labs/evolution-episode-001/evolution-dataset/episode-001/、D:/pd-labs/evolution-ep002-r3/dataset/、D:/pd-labs/ep002r4-live-review-20260917.json、D:/pd-labs/ep002r4-live-block-evidence-20260917.json、D:/pd-labs/ep002r4-post-revoke-evidence-20260917.json、docs/experiments/pri-836/PRI-904-phaseC-probe-suite.md。

以上是**历史证据目录**而非当前运行状态；不能用文件名/原则标题猜测正式 Ledger identity。老数据隐私与许可证未经核验，不默认可进入公开集。

---

## 2. “主张—证据—竞争解释—允许结论”研究契约

**强制使用以下 Matrix 进行预注册与最终报告，不以成功率直接代替解释。**

| Claim | 最小公平比较 / 必需证据 | 主要竞争解释 | 当前结果允许说什么 | 禁止说什么 |
|---|---|---|---|---|
| C-E：经验依赖 | 同一模型/任务，**有无相关经验**及**关键证据对调**，再看候选/范围/未见行动 | 模型先验、标签暗示、最新一条反馈的表层复述 | 受控历史差异影响了具体判断与行动 | 单凭好原则文本断言模型学会了 |
| C-A：抽象价值 | 固定**同一投递通道**，分别投递真实生成原则、原始经历、强摘要、无内容；同新任务 | 字数、检索、信息量、研究者挑选/润色 | 在此任务分布/成本下某表达更有效 | 归因为 PD 治理或模型内部机制 |
| C-D：投递/治理价值 | 固定内容与权限，比较普通规则/记忆 vs PD 的实际 delivery、可撤销性、效果/成本 | MANDATORY 包装、位置、重复、预算、审批筛选 | 当前 PD 打包机制整体有效或无优势 | 同内容比较直接证明“更会发现原则” |
| C-N：整体净价值 | 同经验、合理资源/Owner 参与记录，前瞻未来任务 B1 vs B2：行为/后果/Owner 成本 | 额外算力、Owner 人工挑选、任务选择、基线模型升级 | 特定 Owner/任务分布中的净收益/负担 | 泛化所有 Owner 或声称因果学习机制 |

**允许结果表述示例：**

- C-E 失败但 A1/A2 任务提升：**原则内容或指令有用，但未证明历史导致学习**。
- C-E 成功、C-A 无改善：**经验改变了候选/条件，但抽象表示未优于可用摘要**。
- A1≈A2：**在受测条件下没有检测到 PD 投递机制独立增量**，不能否定原则内容。
- B1≈B2 且 B2 Owner 时间增加：**当前方案缺乏采用 PD 的净收益证据**。
- PD 无内容质量优势但撤销/追溯更可控：**可能构成治理价值**，必须用可观察结果与成本支持。
- 没有有效机会、样本不足、身份断裂或评审争议：**INCONCLUSIVE/NOT_ESTIMABLE**，不可自动以零替代。

**Research Claim Registry** 必须在 sidecar 记录：claimId、contrastId、主要竞争解释、可接受结果、否定/转向条件、分析单位和预算。实验结束后的描述不得凭空添加新的主结论。

---

## 3. 研究数据本体、裁定权威与必要性

### 3.1 区分对象

- **Experience**：可引用的事实、行动、结果、反馈；来源可真实或清楚标明为 synthetic。
- **Pain**：Owner 相关的行为偏差证据，不等于低级 Error，也不默认需要 Principle。
- **Intent / Preference**：目标与取舍；是治理语境，不是 Principle 的全部。
- **Principle**：有依据、有适用条件、可产生行动差异且可修订的决策依据，可利用旧原则而非必须造新格言。
- **Delivery Representation**：正式 artifact、压缩 statement、包装后的有效 payload 各有独立身份。
- **Learning Episode (PLE)**：从过去可见经验到未来被观察行为的研究单元，可包含 abstain、Owner 拒绝与未到达。
- **Behavior Opportunity**：任务前可定义的行为机会，避免 Actor 通过拒答或不操作自动降低分母。
- **Outcome**：与原则服从分离的任务质量、损失、后果与 Owner 维护负担。

### 3.2 标签不应伪装成客观真理

研究判定沿用 PRINCIPLE_CANDIDATE、REUSE_EXISTING、LOCAL_FIX、OBSERVE_MORE、CONTESTED，但它们属于**条件性建议**，依赖任务机会、风险、现存约束与维护成本；**不是客观必要性真值或生产五路状态机**。

一个时点允许主标签（primaryDecision）及兼容行动建议（concurrentRecommendations）：如立即 LOCAL_FIX 并 OBSERVE_MORE；复用已有原则同时建议 Narrow。每个标签必须注明：

- **producer & stage**：由谁、在何个生产/研究阶段作出（diagnosis/admission/reuse/candidate/Owner/evaluator）；
- **informationCutoff**：该决策时点可见信息，禁止未来后见之明；
- **authority**：research_label / model_proposal / owner_decision / runtime_fact；
- **evidence & assumptions**：机会频率、损失/维护估计、证据充分性、已有规则；
- **compatibleRecommendations**：允许并存的局部修复、观察、复用、研究与提议；
- **NOT_SUPPORTED/UNKNOWN**：生产未实现的建议维度不得凭空记为拒绝或成功。

**具体修正 I0/I1 不公平：** Dreamer→Philosopher→Scribe 当前被要求生成候选，不能拿它和可说“No Principle”的直接反思模型比较全局 abstention Accuracy。**上游必要性/admission/reuse** 与 **已准入后的生成质量**必须分成两张评估表；未实现的必要性能力标 NOT_SUPPORTED，不能靠本项目新增线上 Gate。

### 3.3 研究五维（不假设统计独立）

Grounding（依据）、Generativity（新情境行动）、Boundary（例外/负迁移）、Coherence（协调）、Revisability（响应新证据）继续保留，但作为**可交叉的评价视角**，不宣称五个相互独立的心理因素。

每维分 0/1/2/3 或 NOT_TESTED/INCONCLUSIVE；不得简单加权总分掩盖边界性下降。候选文本的 rationale 只能作为解释素材，不是因果证据；要检查改变关键证据后真实输出和行动的变化。


---

## 4. 识别因果竞争解释的实验设计

### 4.1 C-E：经验敏感性必须进入第一轮 Pilot

同一个待学原则主题准备**相互一致的独立历史世界**，固定模型、任务接口及资源：

| 条件 | 历史中唯一关键区别 | 应允许的学习结果 |
|---|---|---|
| E0：无新增历史 | 只提供当前任务/环境基线 | 可遵循通用原则，但不能归因为新历史学习 |
| EA：支持强化 | 曾因隐藏依赖未查验导致高损失，核验有判别力 | 在风险/不确定性大时更重视查验 |
| EB：支持收窄 | 可信消费者契约已存在，重复全量检查增加成本而无判别力 | 优先可信契约和最小充分查验 |
| EN：无关变化 | 在 EA 或 EB 基础上仅修改与决策无关的事实 | 原则/行动不应随无关事实漂移 |

EA 与 EB 是明确标记 synthetic_environment 的**受控世界**，不是捏造的生产历史；其中每段经历应有内部一致的轨迹、反馈与后果。不能靠“你的主人喜欢 X”直接泄漏未来答案。预注册哪个证据是因果关键、哪些为无关，以及未见 Probe 可接受的**不同决策范围**。

**学习存在的最低支持条件**：不同关键经历对实际候选/适用范围或未来可观察决策产生适当、方向明确的差异；EN 不应产生同程度的不合理变化。不能只比较标题、原则语句相似度。即使成功也仅支持“受控情境下经验依赖”，不自动证明长期习惯。

**竞争解释控制**：相同提示结构、模型与环境，尽量对齐反馈长度/显式程度并记录不可消除差异。如果所谓关键经历直接告知后来 Probe 的答案，只能支持 prompt following。

### 4.2 C-A：冻结真实候选，再连接到未来行动

相同学习历史下保留真实生成物，不允许人工挑选漂亮候选替换：

- **I0**：基础模型直接反思，允许形成候选或拒绝候选。
- **I1**：PD 当前 Dreamer→Philosopher→Scribe 的**真实可达生成阶段**；强制生成候选不代表已证明必要性。
- **Reference**：人工审核的多种可接受判断，仅在裁定侧使用，不是第三个模型臂。

**关键闭环**：冻结 I0/I1 原样字节、hash、成本、来源阶段；以**同一投递方式**将各自真实输出放入独立新会话测试未见任务。不许人工参考原则取代质量不佳的输出。没有候选也是合法结果，须保留其无原则策略的未来行为。此闭环是研究侧同通道评估，不表示生产管线具备自由 abstain。

**抽象对照**：真实生成原则、可用原始经历、高质量摘要、无新增内容，全部保留 tokens、上下文位置、检索方式和预算信息；在同一通道比较。原则输给强摘要是合法结论；无法匹配资源时必须标明限制。

### 4.3 C-D：内容固定，判断 PD 投递与治理增量

固定**同一 Principle 内容及适用条件**：

- A0：无新增 Principle/反馈；
- A1：合理普通 Memory/规则文件持久化，允许有用摘要/检索；
- A2：隔离、获授权的当前 PD 审批、Activation 与 Delivery。

**两种不同的估计对象必须分清**：

1. **产品方式总效应**：各组使用正常包装、位置、重复频率及治理机制；这些差异本身属于产品效果与成本。
2. **内容机制诊断**：在同一通道、相同包装/预算下对比具体内容和表达；实验性投递不能冒充当前生产行为。

### 4.4 完整档案与实际送达的 Fidelity

从已有真实 Artifact、activation 与运行事件记录：

- source Artifact/Principle identity/activation 的**精确权威引用**；未知即 UNKNOWN，不按标题推断 UUID；
- 完整候选 hash、独立 statement hash、真实最终 payload hash；
- 指令包装、语气（例如 MANDATORY）、位置、原则排序、预算/截断、其他同时激活内容；
- 激活、投递、可观察应用的 session/run/turn 和证明方式；
- 原则的条件、行动、必要例外是否**实际出现在 Agent 可见内容**：PRESERVED / OMITTED / AMBIGUOUS / UNKNOWN；
- 只有在完整档案中存在、未投递的 rationale 和历史，必须标为 NOT_DELIVERED；
- payload 无法完整复核/旧 ID 关联不确定，不能宣称完整范围已经送达。

可选**表达对照**：完整表达与压缩 statement 在隔离同通道比较，标为 experimental_representation，不预设长文本效果更好，不要求先改生产 Scribe/渲染器。

### 4.5 C-N：完整 PD 与强普通 Memory 的净价值

- **B0**：学习期接收相同反馈，后续新会话无持久规则。
- **B1**：相同经验经有效的普通 Memory/摘要机制保存；具体实现、检索与维护预算预注册。
- **B2**：现有 PD 真实可达学习链，经过 Owner 决策、Activation、Delivery 后观察未来任务。

模型、任务、工具、环境尽量固定，并分别记录：

- tokens、调用次数、执行时长、可核验费用；
- B1 保存、检索、可见文件 hash 和清理维护；
- B2 原始候选、Owner 选择和改写、审批/撤销次数、人工用时；
- 任务质量、漏检、误阻、拖延、返工、风险、可恢复性；
- Owner 主观控制感/信任感（如测，须有预注册观察方法；不由 approvalCount 推断）。

**Owner 是干预组成部分**。匹配人工反馈的实验回答“机制价值”；用真实的不同人工投入回答“整体产品价值”，不能将 B2 更多人力投入引起的改善归功于自动学习管线。

Owner 净价值应多维报告，不默认合成为任意权重总分。重要损失的容忍边界与最小值得采用的改善由 Owner 在查看结果前给出；不知道时不捏造“提升 5%”等门槛。先报告 Pareto 比较，重大副作用不得被平均分掩盖。

---

## 5. 数据入组、预注册、分割与选择偏差

### 5.1 两层分割，消除 v0.2 的潜在矛盾

**外层（方法开发与最终评测）**：有关联的经验来源群、模板群及派生任务一起归入 method-development 或 method-held-out。外层 held-out 不得用于调整 prompt/scorer、选模型、筛候选。

**内层（单个 PLE 的过去与未来）**：Agent 可看到本 PLE 的 learning history，在同一单元的未见 future probes 上评估迁移；二者不违反外层分割。principleFamilyId 是研究主题 ID，leakageGroupId 是泄漏关联来源群，不默认相同。

首批 6 PLE / 约 24 Probe 可**全部作为 development**；若未有全新来源的独立外层测试，标 NOT_AVAILABLE，不能靠 JSON 声称独立泛化。

### 5.2 分配单位、分析单位与时间截止

每次预注册记录：

- enrollmentUnit：入组的经历事件、Owner-任务或连续时间窗口；
- allocationUnit：分配到实验组的单元（Episode、隔离 agent/profile 或连续序列）；
- analysisUnit：主要按 Episode/来源群，**多个 probes/重复轮次不构成多个独立原则学习事件**；
- informationCutoff：该时点 Agent/研究判定原本可见的信息，禁止未来答案回填；
- futureOpportunityRule：**任务前**规定 eligible 条件，Agent 拒答不应自动缩小入组分母；
- 随机执行顺序/配对、预定重复次数、模型/预算、缺失和排除原则。

早期结果以配对案例和描述性统计为主，不假装 N=24 个独立学习事件。

### 5.3 入组以后，系统失败不能统统丢弃

| 事件 | 主分析处置 |
|---|---|
| 夹具预先损坏、预先金标泄漏、选错实验环境 | INVALID_PROTOCOL，按预注册规则使对比无效 |
| 未产出候选、Owner 正当拒绝、Activation 不可达 | 系统/治理实际结果；仍观察后续 Actor 表现 |
| PD 超时、投递失败、无回复、任务被拖延 | 系统失败或结果缺失，单独分类；不自动 INVALID |
| 对照组没有 PD activation | pipeline 可为 NOT_REACHED，但 Actor 结果**仍正常判定** |
| 无可裁定原则使用机会 | N=0 / NOT_ESTIMABLE，保留任务入组及结果缺失 |
| 历史权威 identity 无法精确关联 | UNKNOWN / INCONCLUSIVE，禁止用标题文本修复身份 |

全量入组视角（类 ITT）和实际暴露条件视角分报；不能因 PD 未激活而从 B2 的总体分母删掉。无法观测时披露缺失比例和敏感性限制，不偷偷全部视为成功或失败。

### 5.4 双轨数据路线

**Track D — 诊断挑战集**：人工/合成/精选真实，控制关键证据变化、边界和冲突；解释机制但不推断现实机会发生率。

**Track P — 前瞻真实流**：获得 Owner 的明确授权后，按固定时间窗/抽样规则连续纳入正常完成、失败、未投诉、Owner 放弃纠正、未生成原则、被拒绝、没有未来机会等事件；用于观察真实分布、选择偏差及成本。只收 Pain 或漂亮候选会错误估算发生率。

两轨分别报告。合成样本有实验控制价值；真实样本也可能存在很强选择偏差。未经授权的真实私人数据不可自动公开。

### 5.5 预注册冻结

冻结 claimId、关键对照、分析单位、学习期信息截止、模型/预算、环境和 fixture hash、split 分配、任务前机会条件、评价规则、Owner 损失界限、缺失/剔除规则。看过结果后修改必须升版本并保留旧结果，不可暗改 Gold。

---

## 6. Sidecar 数据契约（研究视图，不改生产 schema）

### 6.1 研究目录建议

只有 PR-01 经确认后才按实际仓库习惯新增最小文件，建议：

    datasets/pd-principles/v0.1/
      dataset-manifest.json
      schemas/episode.schema.json
      schemas/probe.schema.json
      schemas/adjudication.schema.json
      episodes/                  # 每个 PLE 的研究定义、来源 refs
      probes/                    # Agent 可见 task 与环境声明
      judgments/                 # judge-only, gold/允许决策空间
      splits/                    # 外层方法分割 + 单元内 future probes

实验运行产物与冻结数据分开：

    <lab-run>/
      experiment-manifest.json   # 当前 experiment-manifest.v1 的受支持字段
      principle-study.json       # 新研究 sidecar：claims、arms、组别、预算、采样
      delivery-fidelity.json     # 完整 artifact 与有效 payload 的对照
      memory-manifest.json       # 当前可见 Memory/AGENTS/规则/历史的指纹
      evidence-package/          # 沿用既有 collector 与 report
      adjudications.jsonl        # 独立 Actor 行为/任务结果与 Judge 结论
      comparison-report.md
      comparison-report.json

**不得**在研究 JSON 中伪造一份正式 Ledger、Approval、Activation、Principle Revision 或复制可修改的 IntentContractV1；现有数据库仍然是运行时事实权威，sidecar 只持有精确引用、实验声明、独立裁定及派生统计。

### 6.2 必需字段的语义契约（PR-01 前先校准）

**PLE：**

- schemaVersion、episodeId、principleFamilyId、leakageGroupId、outerSplit、episodeKind；
- informationCutoff、actor/owner authority、researchQuestions、claimIds；
- learningSignal（pain/correction/success/conflict/environment_change/counterevidence/other）；
- evidenceRefs[]：sourceKind、claim、sourceExactRef、occurredAt、recordedAt、hash 或缺失说明、status、permission、proofMethod；支持逐项 real/synthetic 混合；
- initialDecision：primaryDecision、concurrentRecommendations、producer、stage、assumptions、decisionTime、status；
- principleRef（若真实存在则 exact）、artifactRef、deliveryRef（若确实存在）；未知为 UNKNOWN，不生成 ID；
- learningInputs、futureProbeRefs、revisionTriggerRefs、status。

**Probe：**

- probeId、episodeId、leakageGroupId、innerRole（learning_history/future_probe）、outerSplit；
- probeKind（near/far/boundary/conflict/counterevidence/revision/no_principle/evidence_sensitivity/irrelevant_sensitivity）；
- taskContext、environmentRef、fixtureHash、taskInstructions、objectiveConstraints；
- preTaskEligibleCondition、judgeOnlyRef、expectedDecisionSpace（存 judge-only，不进入 actor 输入）、costBoundaryRef；
- contaminationRules、preRegisteredExclusions、version。

**Research Run：**

- claimId、contrastId、arms、randomization/assignment unit、analysis unit、informationCutoff；
- datasetVersion、rubricVersion、fixtureHash、model/host/runtime SHA、initialMemoryManifest；
- sourceArtifactHash、deliveredPayloadHash、interventionRepresentation、actualCost；
- armStatus、availability/reachability、measuredOpportunities、missingCause 与是否可估计。

**Adjudication（每项机会）：**

- runId、armId、probeId、opportunityId、preTaskEligibility；
- pipelineReachability：NOT_REACHED/REACHED/UNKNOWN；
- actorRunStatus：COMPLETED/FAILED/NO_RESPONSE/INTERRUPTED/UNKNOWN；
- objectiveTaskStatus：PASS/FAIL/UNKNOWN；
- principleAlignment：ALIGNED/ACCEPTABLE/MISALIGNED/INCONCLUSIVE/NOT_APPLICABLE；
- realOutcomes：质量/延误/阻断/返工/可逆性及证据来源；
- ownerCost：reviewMinutes、interventions、maintenanceMinutes、unknownFields；
- judgeId、judgeType、blinded、rubricVersion、decisionRationale、sourceRefs、adjudicationDisagreement；
- dataQualityFlag：VALID/INVALID_PROTOCOL/UNCERTAIN，及具体原因。

同一项评价可以同时出现 pipeline.NOT_REACHED 和 actor.ALIGNED；这是**正确且必须测试的组合**，不得为使 collector 开心而为对照组创造 Activation。

### 6.3 标签权威与 No-Principle

研究标签可来自人工 Judge 或模型建议，必须注明 producer/authority/time。Owner Approve、Reject 等真实治理决策只能由既有权威记录导入，不由研究打分生成。

必要性标签允许**多个兼容后续动作**，但默认只能有一个报告的主要决策；冲突尚不能裁定则 CONTESTED。时点已知信息不足时应允许 OBSERVE_MORE，不得后见之明倒推“原来必然需要创建”。

**Schema 验证范围**：形状、引用、权限、拆分、时间与泄漏规则。JSON 合法不代表现实确实发生，semantic evidence 需要独立复核。真实引用缺失可以在 research-draft 显式标未准备，**不能通过 release-ready 的来源校验门**。

---

## 7. 三层结果与 Judge 校准

### 7.1 所有实验独立评价三类 Outcome

| 层 | 研究问题 | 可用证据 |
|---|---|---|
| **Behavior Alignment** | 符合当前有效行为承诺吗？ | 工具轨迹、文件/输出、真实任务行为和预注册可接受策略 |
| **Task & Consequence** | 任务/质量/风险/误阻/返工/时间是否真正更好？ | 机械 Oracle、结果状态、不可逆变更、实际延误和返工 |
| **Owner Net Value** | 少了多少纠正？增加多少审批/审阅/维护？控制感等是否有证据？ | 时间记录、真实交互次数、授权 Owner 的评价 |

行为对齐、任务后果与 Owner 净收益**不能互相代替**。例如验证强度不断增大或无限询问可以满足某些谨慎性词句，同时导致任务未完成和 Owner 负担增加；必须分别判错/计成本。

**“值得形成原则”不是从两名 Judge 一致性中自动得出的事实**。评估当时的决策质量，与部署后的真实损益要分开；一个预测合理但结果差的候选，不等于当时完全不合理。

### 7.2 Judge 事先校准（PR-02 与 Pilot 门）

冻结至少四类定向判别样本：

1. **动作相同、只改免责声明/文风**：行为对齐不应随措辞无理增分。
2. **声称已查验、实际无工具/来源**：不得认定查验完成。
3. **无需额外工具，但有现成充分证据并做有用决策**：不得因工具数量少而判失败。
4. **无穷澄清或不必要阻断**：应体现任务机会成本与 Owner 负担。

另保留**证据不足**与**真正规范分歧**两种不同的不确定性标签；若两次独立裁定冲突，记录原始意见和仲裁依据，不强迫变成一个“全知金标”。

盲评尽量遮蔽 Arm 和 PD 身份，不强求所有模型输出等长但要披露长答案/指令语气/自述可能引起的偏差。LLM Judge 必须标来源、模型、提示与费用；不能自称真实 Owner。

### 7.3 报告的可复核指标

- Experience Sensitivity：关键经历差异下正确改变判断/未来行动的比数，同时报告 EN 无关变化误漂移。
- Abstraction Utility：同通道真实候选 vs 强摘要/原始经历/无内容的近迁移、远迁移、边界及成本。
- Induction Quality：已准入候选质量；与**上游必要性建议**分表，不能混算 abstention。
- Eligible Alignment：成功/可接受行为机会数 / 可裁定适用机会数；保留 N=0。
- Boundary Misapplication：错误在不适用条件套用原则 / 可裁定不适用机会数。
- Delivery Fidelity：明确完整候选/statement/最终 payload 的保真及实际 exposure。
- Task Consequences：质量、误阻、时间、返工、不可逆损失分别列示。
- Owner Burden & Net Value：减少的纠正和新增审批/维护/人工改写成本；多维呈现与 Owner 预设容忍界限比较。
- Reachability / Missingness：入组数、候选形成数、真实授权数、真实投递数、有效机会数、无回复/未到达数。
- Evolution Plasticity & Stability：该修订时能调整，不该修订时保持；旧能力不被破坏。
- Cost & Compute：模型 tokens/调用/时间，Agent 工具及人为成本。

任何差异报告同时展示分子/分母、来源群/实验单位、置信局限与排除原因；种子样本小，不报告不可靠的总体显著性或跨 Owner 通用率。

---

## 8. RQ3：原则演化的真实问题

修订触发至少区分：

1. **经验解释被反证**：原有因果假设不成立，建议更新 empirical belief；
2. **环境分布变化**：某工具/依赖关系已改变，旧适用条件需重审；
3. **Owner 规范/授权变化**：需明确 Owner 决策，不能由 LLM 自动覆写；
4. **局部例外**：原原则仍基本成立，只对新条件缩窄；
5. **执行机制故障**：投递失效或超时，并非原则语义被证伪；
6. **不可靠/无关反馈**：不应因每条新反馈而改原则。

RQ3 建议标签 Keep、Narrow、Expand、Revise/Supersede、Retire；同时必须输出修订**对象**（规范/经验/范围/投递/治理权限）、理由、证据等级与 Owner 授权状态。

**稳定性与可塑性同时测**：加入可靠反例、无关噪声、延迟反馈与可信度不同的冲突来源；复测新情境，也复测未被反例挑战的旧情境。永远 Keep 和永远 Revise 都不应得高分。

**原则集合效应**：单原则正确不等于多个原则可同时正确；小规模 Pilot 可以检查 2–3 条竞争原则同时送达时的预算、冲突与旧能力回退，不能因此新造选择器。区分未送达、送达未采用、适用条件误判、原则间张力。

**时间真实性**：记录日历时长、相关行为机会数、无关任务干扰量、模型/host/原则集合变化。30 天零相关机会不证明记住，一天内密集提示也不证明长期稳定。任何真实治理修订/撤销必须单独获授权；ADR-0028 Proposed 不能被误报为正式 Revision 已实现。


---

## 9. 最小可决策 Pilot（先于六主题扩建）

### 9.1 首个问题：验证充分性与效率（拟选 PLE-PILOT-01）

建议用同一抽象判断问题组织一套可判别案例：

> 如何在证据不确定性、查验成本、失败风险和任务时限之间选择**有判别力的最小充分验证**？

**这不是 Gold Principle 文本**；研究需允许不同但有依据的框架，包括原有 Owner 约束和安全底线。优先复用已经存在的验证/消费者契约夹具。若现有夹具只能测“有没有运行命令”，应在不改生产系统前提下补充有真实代价的判断空间。

**学习历史**：

- EA：遗漏一个隐藏消费者导致高代价回归；一个额外、便宜且有判别力的检查本可阻止事故。
- EB：已有可信并受维护的消费者契约；全量重复检查成本高、几乎无新信息，反而延误关键修复。
- EN：仅调整与该权衡无关的历史细节；应保持原来判断边界。
- E0：无该历史，测模型先验。

**预注册四种未来机会**：

1. **应使用该经验判断**：新技术表面中信息不足，廉价核验可显著区分真实风险；
2. **不该机械迁移**：外观相似但可靠验证已充分，额外全面检查无增量价值；
3. **真实冲突**：核验进一步减少风险但导致延期或阻断，需要明确任务、不可逆性与 Owner 授权的取舍；
4. **新证据与旧能力**：出现可靠反例需局部收窄，原本高风险旧情境仍应该正确查验。

**压力题是否有效的反证**：如果 Agent 始终全检、始终不检、永远拒绝、或者只增加免责声明，依然都能拿高分，则这个 Probe **不可判别，必须在冻结前修订**。修订过程不能查看 held-out Actor 结果后迎合 PD。

### 9.2 分层执行与独立门

**Pilot-0：协议校准（无 LLM 因果主张）**

审阅权威证据、同/异源历史一致性、任务约束、金标隔离与评估器对文风和拒答的区分；准备固定负例与 Judge 审查。**失败则不启动正式对照**。

**Pilot-1：经验 → 候选 → 行动**

在 E0/EA/EB/EN 下，记录真实的 I0/I1 产生什么候选/是否拒绝；冻结真实输出，用同一后续通道测试新任务。预注册“哪些候选/行为差异体现了关键经验”，同时检查无关证据变化不诱导虚假修订。不能用手工参考原则替代 PD 的真实输出。

**Pilot-2：抽象表达与交付**

在同通道下比较真实生成原则、原始经历和强摘要；如果真实产物/权限允许，再以 A1/A2 的真实交付机制比较。凡当前生产链路不可达，标 NOT_REACHED/NOT_SUPPORTED，不得塞入合成生产审批。

**Pilot-3：真实成本/后果**

最低限度记录任务完成状态、误阻、核验花费、Owner 干预次数与时间；如果未产生真实 Owner 参与，只能测**实验假定成本或代理指标**，不得宣称净收益已证实。可在获得授权后试点前瞻真实流。

**Pilot-4：有限演化**

加入有判别力的反例和无关噪声，在离线/合法隔离环境检查“该更新时更新、不该更新时保留”。正式治理仍走真实 Owner 决策；本 SPEC 不自动创建 Revision/Binding。

### 9.3 Pilot 可以支持什么？

| 观察 | 允许结论 | 不允许结论 |
|---|---|---|
| EA/EB 造成有理由的候选和未来行动变化，EN 稳定 | 受控世界中有经验敏感性 | 已内化十年经验或必然有真实净收益 |
| 同通道原则 > 强摘要，负迁移未升高 | 当前样本与预算下抽象表达有增量 | PD 治理平台增量已经证明 |
| A2 比 A1 投递可靠/撤销更准确 | 某项治理/投递效果获得支持 | 归纳机制独有优势 |
| A2 强制包装后表现更好，但可逆性/成本不利 | 说明强指令有作用，也有代价 | 必然值得 Owner 长期使用 |
| 仅改变措辞即可获得评分提升 | Judge/任务设计受污染，应修复协议 | 原则学习成功 |
| I1 生成候选但未激活，Actor 仍完成任务 | 生成阶段可评价，完整管线未到达；Actor 可独立评分 | 把 pipeline.NOT_REACHED 当 Actor 失败 |
| B1 相当或更优、且成本更低 | 当前条件下 PD 无已证净增量 | 否定所有场景和既有治理价值 |

### 9.4 何时扩建、收窄或停止？

**扩建（Owner Go）**：至少完成可重复的关键对照，分项指标可信，出现具实际意义的新的行为/治理价值，未出现严重负迁移或不可接受 Owner 负担；下一步需有新来源而非无限复制当前模板。

**收窄**：若文本/抽象没有优势但治理价值明显，优先研究治理可靠性；若完整档案有效而 statement 压缩无效，优先调查表示/送达保真；若只在一个任务族成立，明确适用域，不宣称普适。

**停止当前扩建（No-Go）**：成熟 Memory 在质量和成本上稳定不劣；所谓收益只来自文风/解释包装、人工手选候选、额外算力或实验污染；更多经验只导致不必要的规则与维护。停止的是**未经证实的扩建与价值主张**，不是删除已有资产。

门槛由 Owner 在校准测量与风险成本后确认，禁止任意事先杜撰“5% 提升即成功”。

---

## 10. 分期实现、职责边界与验收证据

### PR-00A：研究与实现 Reality Audit（只读）

本阶段不写代码、数据库或生产 Artifact。复核当前 HEAD 和现有修改，检查：

- AGENTS.md、PRODUCT_IDENTITY.md、适用 ADR 的实际状态；
- Philosopher、Scribe、IntentContract 的 producer/consumer 及上游 admission/reuse；
- Prompt reader、渲染器、Host 预算、Activation/Delivery 事件；
- Evolution Lab 初始化/collector/evidence-package、Behavior Signature、现有测试；
- SPEC-OGQ-001、PRI-917 的当前状态与重叠边界；
- 本地 EP001/R3/R4/PRI-904 真实证据、精确身份关联、权限/许可和原始记录可达性。

**交付**：Exists/Disconnected/Missing、Producer/Stage/Authority Map、代表性 evidence ref、每一主要 Claim 能否测量、Pilot-01 夹具选择与不可达的明确限制。不可用“SPEC 说存在”替代源码验证。

**Gate**：如果发现不可替代的生产证据缺口，修改研究主张或提交独立修复提案；**本 SPEC 不以研究为名批准新生产服务**。

### PR-00B：可判别性/方法学契约（文档与固定样例）

- 最小 Pilot 的 E0/EA/EB/EN 历史、关键与无关变化；
- 至少四类未来 Probes（应用、不适用、冲突、局部修订）；
- Claims Matrix、学习输入与 judge-only 信息隔离；
- 样例 Producer/Stage 判定，含“应拒绝新原则”；
- 至少四项 Judge 校准与行为/任务/Owner 三层 Outcome；
- 外层与内层分割、任务前机会定义、缺失原因类别、实际 vs 模拟成本。

**Gate**：不同历史与行动之间有真实可判别的预测；否则不得冻结 Schema 或启动昂贵实验。

### PR-01：最小 Sidecar Contract & Validator（PR-00B 通过后）

只加入为当前 Pilot 必需的研究侧文件/校验器，不一次性铺满大 Schema 体系。复用已经实现的 Manifest/Evidence/Intent/Behavior Signature 合法契约。

**硬负测试：**

- 研究数据能把两层 split 的**合法 PLE 内未来 Probe**保留，而能拒绝**外层来源模板泄漏**；
- judge-only 结果/Gold/Fixture answer 不泄漏到 Actor 输入；
- 没有正式 activation 的 A0/B1 仍能得到 Actor 行为评分；pipeline.NOT_REACHED 不被误当任务失败；
- 有候选但被 Owner 拒绝与没有候选、运行超时，状态与缺失处理各异；
- 完整 Artifact scope 与实际 delivered statement 例外缺失时 Fidelity 不能通过；
- antiPatterns-only 无法推出 non-applicability；
- 真实 Owner 与 synthetic 主体、真实 Principle identity 与相似标题不能混淆；
- 事后才知道的结果不能进入信息截止日前的 necessity gold；
- 相同动作只改免责声明/文风不会不合理改变行为评分。

### PR-02：单 PLE 受控 Pilot & Independent Adjudication

固定源码模型、预算、运行夹具、真实/模拟来源；执行 Pilot-0—4 的**可达部分**，未达部分显式记 NOT_SUPPORTED。至少包含经验关键变化的配对、无关变化对照、冻结实际候选的同通道行为测试和边界/冲突机会。

**验收**：必须能够说明某项 Claim 被支持、被削弱或暂不可估，以及**至少排除/暴露一种重要竞争解释**；PD 胜出不是成功要求。未获得真实 Owner 的新授权不得执行生产 Approval/Activation。

### PR-03：Evidence Lab 只读汇总适配（仅 Pilot 真有需要时）

在既有 scripts/dev/pipeline-evolution 下建立最小 Loader/Join/Reporter 或复用当前已有代码；研究 run 结果以 sidecar 组织。现有 Evidence Package 的 NOT_REACHED 语义和 Manifest 写约束保持原样；不能引入第二套数据库、长期服务、候选写路径或数据权限源。

**验收**：固定输入复算分母、配对差异、证据引用与 Judge 裁定；可展示负迁移、未到达、未知、无回复、预算差异，不把 JSON 的 source/detail 存在性当事实独立验证。

### PR-04：扩展数据集 / 前瞻流（当前阶段不授权）

只有 Pilot 支持某种可决策的价值，并由 Owner 通过扩建门，才能推进原先计划的 6 PLE / 约 24 Probe；公开或长期流式采样需要隐私/保留/来源许可的额外决策。大规模原始轨迹收集、模型微调、Owner Asset/Revision/Binding、在线必要性阻断/自动治理仍非本 SPEC 的工作范围。

---

## 11. Acceptance Criteria（先方法后能力）

| ID | 验收要求 |
|---|---|
| AC-01 | Principle-first；Experience/Intent/Preference/Policy/Delivery/Outcome 各有独立语义 |
| AC-02 | 规范性承诺、经验性信念和投递表示可以被独立追溯，不允许模型擅改 Owner 权威 |
| AC-03 | C-E/C-A/C-D/C-N 每项有独立对照、竞争解释与禁止宣称的结论 |
| AC-04 | E0/EA/EB/EN 经验敏感性、无关变化对照与实际候选冻结用于首个 Pilot |
| AC-05 | 真实 I0/I1 输出被公平用于未见任务，不以人工参考替代 |
| AC-06 | 全部生产必要性/admission 与已准入 Philosopher 生成质量分表，NOT_SUPPORTED 合法 |
| AC-07 | 准确记录 Artifact→statement→effective payload 的含边界、包装与截断保真 |
| AC-08 | 无 PD activation 的对照仍能评 Actor；pipeline reachability 与 Actor outcome 分开 |
| AC-09 | 外层来源群与内层 history→future 分割独立，能识别泄漏 |
| AC-10 | 预注册入组、主要分析单位、任务前 eligible、随机顺序、缺失与不可达原因 |
| AC-11 | Owner 没有纠正、候选没建立、没有未来机会都能进入真实流，非只取优质 Pain |
| AC-12 | 行为相符、任务后果、Owner 净收益三层独立，误阻/延迟和人工成本不能被隐藏 |
| AC-13 | Judge 经文风/证据/工具数量/过度澄清样例校准，允许分歧 |
| AC-14 | RQ3 包含应该修订和应该保持；旧能力复测；不冒充正式 Revision 已实现 |
| AC-15 | 历史 EP001/R3/R4/PRI-904 各按证据等级使用，不宣称未复算的效应 |
| AC-16 | 不碰 installed runtime、live Owner DB、既有未提交文件或实际 Governance，不复制事实源 |
| AC-17 | Pilot 可得出 PD 无增量、只支持治理价值、或 INCONCLUSIVE，并仍算工程实验合格 |
| AC-18 | 长期扩建必须经独立 Owner Go/No-Go，不因文档完成而自动开始 |

---

## 12. v0.2 独立评审 → v0.3 处置追踪

| Review 发现 | v0.3 修复位置 | 状态 |
|---|---|---|
| 经验未必引起原则形成，强提示可伪装学习 | §2 C-E、§4.1、§9 | **已设计**，待实验 |
| 实际 I0/I1 需冻结并同通道测试 | §4.2、§9、AC-05 | **已设计**，待实验 |
| 原则与记忆/提示不是互斥技术类别 | §0.1、§4.2–4.5 | **已修订概念** |
| 规范承诺与经验信念混淆 | §0.1、§3.2、§8 | **已修订概念** |
| 必要性是条件建议且标签可兼容 | §3.2、§6.2 | **已修订契约** |
| 真实送达文本可能丢失适用例外 | §1.2、§4.4、§6.2、AC-07 | **已规定取证** |
| Philosopher 强制候选，不能与可 abstain I0 直接比较 | §3.2、§4.2、§10 PR-01 | **已拆分 producer** |
| collector.NOT_REACHED 不能评分无 PD Actor | §1.2、§5.3、§6.2、PR-01 | **已拆分状态** |
| 只守原则可能降低任务/Owner 净价值 | §4.5、§7、§9.3 | **已加入 Outcome 层** |
| Judge 文风偏差与资源差异 | §4.2、§7.2、PR-00B | **已加入校准/成本** |
| 外层与单元内分割冲突 | §5.1、§6.2、PR-01 | **已澄清层次** |
| ITT、入组后缺失、依赖任务前机会 | §5.2–5.3、§7.3 | **已规定分母** |
| 选择性只收 Pain/精彩案例 | §5.4、§10 PR-04 | **已采用双轨研究** |
| RQ3 修改原因、稳定性、多原则与机会漂移 | §8、§9 | **已设计 Pilot 条件** |
| R4 存在 09-17 live 证据，PRI-904 数字需复算 | §1.3、AC-15 | **已修订历史定性** |

“已设计”不等于已经实证通过；所有条目均需在适当的 PR/Pilot 通过实际验收。旧 v0.2 保留以维护历史可追溯性。

---

## 13. 剩余不确定性、停止条件与交付声明

**依旧尚未解决：**

1. 首个 PLE 的历史世界、fixture、Gold 与实际成本尚未正式建成或经独立复核；§9 是实验设计，不是数据交付。
2. 未对 PRI-904 的 11/20 vs 3/20 及 R4 全部历史证据重新逐机会裁定，不能以本版修订代替复算。
3. 真实 Owner 长期流的伦理/隐私授权、抽样窗口、时间成本预算尚无新的授权。
4. 真实模型运行、variance、检索预算与 Judge 一致性尚未测量；不能预先宣称显著增益或选任意阈值。
5. 不存在已被本 SPEC 授权实现的生产 Principle Revision、Binding 或新候选 Necessity Gate。
6. 模型升级、Owner 间外推、月级效果及真正的增量 Owner 价值，仍属未来开放研究。

**最终工程门槛：**

- **Document Ready**：本 SPEC 与本地事实核对、审查自评、明确 Claim/对照/约束和 PR-00 可执行输入完成；
- **Protocol Ready**：PR-00A/B 的历史、对象、条件、Judge 校准与泄漏测试通过，方可冻结 PR-01 最小数据契约；
- **Pilot Completed**：记录真实受控 Actor 行为，可复核且诚实区分 C-E/C-A/C-D/C-N 的正负/未知结果；
- **Scale Ready**：有适用领域内可重复的、有意义且可负担的增量，Owner 另行决定扩建。

### 给 Implementer 的第一条指令（仅 PR-00A/B）

> 请先只读执行 SPEC-PD-PL-001 v0.3 的 PR-00A（源码/权威/数据 Reality Audit）与 PR-00B（最小 Pilot 的实验可判别性评审）。从当前源码复核 Producer、Consumer、Evidence Package、真实 payload、SPEC-OGQ/PRI-917 边界、历史证据、采样/双层分割与 Owner 许可；输出每项 Claim 是否可测、一个合法例与一个负例、准入与任务后果分母、最小样本成本。**不要进入 PR-01 编码，更不要替 Owner 审批、改写或停用真实原则。** 不修改 AGENTS、runtime、生产 DB、已安装 ~/.pd/runtime、用户已有未提交工作；未取得当前明确批准前不启动真实治理实验。

**本 SPEC 的主要目标不是积累漂亮的 Benchmark，而是让每项研究投入买到明确的判别力：经验是否改变了未来选择、抽象是否有价值、治理是否有增量、Owner 是否净受益。**

**END — SPEC-PD-PL-001 v0.3 (Draft)**
