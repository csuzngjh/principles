# PD 行为偏差事件与相对评价规范

- **版本**：v1.0
- **状态**：Owner 确认的规范性产品语义
- **适用范围**：PD 的 Pain 采集、行为证据归档、数据集建设、历史诊断、宿主行为评测及相关 Agent 文档
- **权威性**：本文件定义概念与数据语义；实现、存储和入口仍服从各自已批准的技术契约。若旧文档把 Pain 等同于任务失败、把摘要等同于完整样本，按本规范修订其语义，不据此推断现有代码已经实现。

> **核心定义**
>
> 用户与宿主执行任务时，宿主行为相对于当时的用户预期、意图及适用的 PD 原则出现偏差，由痛苦信号触发记录和积累。

## 1. 数据集的基本单位：有完整上下文的行为偏差事件

**Pain 是定位入口和触发信号，不是数据集样本本体。** 数据集的基本单位是一个有完整上下文、可追溯、可分析的行为偏差事件（Behavior-Deviation Event）。

行为偏差必须放回具体 Owner、具体任务、具体决策时点和当时适用的约束中判断。不得脱离上下文，把某种行为风格预先定义为普遍更好。

三个不可混淆的判断：

1. **任务完成，也可能存在偏差。** 结果做出来了，但宿主擅自扩大范围、忽略用户指定的执行方式，仍可能偏离预期。
2. **任务失败，不一定存在偏差。** 宿主按用户预期合理执行，外部服务故障导致失败，不自动构成行为偏差。
3. **同一种行为在不同上下文中，偏差方向可能相反。** 用户已授权时反复确认可能偏离预期；用户要求先确认时直接行动也可能偏离预期。

因此，任务结果（成功/失败）与行为符合度是两个独立维度。结果可作为事件上下文或影响证据，但不能代替偏差判断。

## 2. 一个完整事件样本必须保留什么

完整事件样本至少包括以下组成。各项可以通过受授权的原始存储和稳定引用关联，不要求把所有原始内容重复复制进 Pain 或任务记录。

| 组成 | 必须保留的内容 |
| --- | --- |
| 痛苦信号 | 原始触发内容、来源与 provenance、发生时间、对应行为位置，以及可回溯的 Pain / observation 标识 |
| 完整对话轨迹 | 相关任务从开始到信号触发的完整交互；后续澄清、纠正也要按真实时间关联保存。原始轨迹是样本本体，摘要只能辅助索引，不能替代轨迹 |
| 宿主行动证据 | 相关工具调用及其返回、执行顺序、相关产物和状态变化；不能只保留最终回复 |
| 当时的期望依据 | 用户原话、任务意图上下文、当时适用的原则及版本；必须区分当时已表达且宿主有机会获知的内容、事后澄清和评价者推断 |
| 偏差关系 | 实际行为相对于期望行为的具体差异、支持该判断的证据位置、适用范围及不确定性 |
| 运行条件 | 宿主、模型、配置、当时有效的原则及版本，以及必要的环境引用；不得把密钥等秘密写入数据集 |
| PD 派生产物 | 诊断、候选原则、评价、Owner 决策、激活和后续治理记录；这些是派生结果，必须与原始事件样本分开保存 |

### 2.1 完整轨迹的边界

- 轨迹范围从**相关任务开始**到 Pain 触发时点，覆盖理解任务、澄清、计划、工具行动、工具结果、产物与状态变化，以及触发 Pain 的行为。
- 信号触发之后发生的澄清、纠正、Owner 反馈和治理结论也应关联到同一事件，但必须保留各自真实时间和来源，不得回写成宿主在更早决策时已经知道的信息。
- “完整”指相关任务的完整上下文，不意味着无差别收集该宿主所有无关会话。
- 原始轨迹应留在获得授权的权威轨迹存储中，以稳定 source reference、身份和时间关系关联。不得为了满足数据集要求绕过宿主授权、保留期限或撤回机制。
- 如果原始轨迹不可访问、未被允许保留或已按政策清退，该事件仍可作为候选入口保留，但必须标为不完整/不可分析；不得用摘要伪装成完整轨迹。

## 3. 完整性、去重与数据集计数

数据扩充统计的是**去重后的完整、可分析的行为偏差事件数**，不是 Pain 文本条数、Pain 数据库行数或诊断任务数。

建议在数据盘点中至少区分：

- **候选信号**：只有 Pain/observation 入口，尚未关联完整事件。
- **关联但不完整事件**：已找到部分轨迹或行动证据，但至少一项必要组成缺失。
- **完整事件样本**：第 2 节所列必要组成均可追溯、时间关系明确，且使用符合授权与留存政策。
- **不可分析事件**：关键来源不可访问、授权不允许、身份无法确认或证据冲突无法判定；保留原因，不计入完整样本。

计数规则：

1. 一个事件可能有多个 Pain 或观察信号指向它；应归并到同一事件，不能按信号条数重复计数。
2. 文案相似不等于同一事件。不同任务或不同发生时间的相似行为，不能仅凭文本相似去重。
3. 去重依据应优先使用可信的任务/轨迹身份、行为时间窗口和证据位置；身份不足时标记待人工核对，不做猜测性合并。
4. 缺少轨迹的记录可以继续保留、补证和追踪，但不能计为完整管道样本，也不能用它们证明诊断或评测覆盖率。

**现有 106 条信号**是 Owner 提供的候选入口盘点数；在逐条关联轨迹、核对完整性和去重前，不代表 106 个完整事件，也不代表已验证的数据集规模。正式统计必须重新读取实际数据源并给出分母、缺失原因和去重依据。

## 4. 相对偏差可以科学评价，但参照必须明确

评价问题固定为：

> **在这位 Owner 的这段任务上下文中，哪一种行为更贴近其可证实的预期？**

评价对象是实际行为与期望之间的关系，不是模型是否说出一个脱离上下文的标准答案。可接受行为可能不止一种；只要多种做法都符合当时预期，就应允许多种答案。期望不明确、证据不足或要求相互冲突时，必须允许“无法判断”，不得强行选出唯一标准答案。

禁止把以下倾向当作普遍更优：

- 少询问不必然优于多询问；
- 执行更快不必然优于先确认；
- 检查更多不必然优于检查更少；
- 更主动、更保守、更简短或更详细，都不能脱离上下文独立评分。

### 4.1 期望依据必须分层

每条期望依据都应记录来源、原始证据位置、形成时间、适用范围，以及宿主在决策时是否有机会获知。至少区分：

| 依据类别 | 定义 | 评价用途 |
| --- | --- | --- |
| 当时已表达的期望 | 在行为发生前已经表达的用户要求、意图或有效原则；同时记录宿主当时是否可见/可访问 | 若宿主有机会获知，可作为判断当时行为符合度的直接参照 |
| 事后澄清的期望 | 行为发生后，Owner 通过纠正、补充或解释才明确的期望 | 可用于 PD 后续学习和完善原则；不得倒推为宿主在先前决策时已经知道 |
| 评价者推断的期望 | 评价者根据上下文推测、但没有直接表达证据支持的期望 | 必须标记为推断及其不确定性；不能伪装成 Owner 原话或已确认要求 |

“Owner 曾经表达”与“宿主当时有机会获知”不是同一件事。若要求存在于某个宿主不可见的文档或未注入的上下文中，应如实标记不可见/未知，不能直接认定宿主违反了它。

### 4.2 原则适用与冲突

- 记录行为发生时有效的原则 ID、版本、状态、适用范围，以及宿主当时是否能够获知该原则。
- 用户意图与内置原则发生张力时，同时保留双方依据、适用范围、优先级关系和冲突事实。
- 不得机械地按“遵守了几条原则”计分；应判断哪些原则在该时点适用、是否冲突、冲突如何解决。
- 适用关系无法确定时，标记冲突或无法判断，不能把原则存在本身当作其在当前场景必然适用。

### 4.3 偏差结论必须带证据和不确定性

偏差评价至少说明：

1. 宿主实际做了什么（引用轨迹、工具调用、返回或状态变化）；
2. 当时可证实的期望是什么（引用原话、意图或有效原则版本）；
3. 实际行为与期望之间的具体差异；
4. 是否存在其他同样符合预期的行为；
5. 证据缺口、来源冲突和判断不确定性。

允许的结论包括“符合预期”“存在偏差”“期望/原则冲突”“证据不足/无法判断”。不确定不是失败，也不能被自动改写为无偏差。

## 5. 完整归档与时间受限的实验输入必须分离

同一个事件需要保留完整、按时间排序的归档，但不同任务只能读取其时间点允许看到的信息。

| 使用场景 | 可以暴露的信息 | 禁止泄漏 |
| --- | --- | --- |
| 完整事件归档 | 任务开始至信号触发的完整轨迹，以及之后关联的澄清、纠正和治理记录；每项保留真实时间 | 不得抹平时间顺序或把事后信息写成当时已知 |
| 重跑历史诊断 | 仅使用该次历史诊断时已经出现、已经获准读取的 Pain 和上下文；应按历史诊断时点重建输入快照 | 不得使用历史诊断之后才出现的纠正、评价或治理结论 |
| 测量宿主在决策点的行为 | 只向宿主暴露该决策时点之前（含当时）它有机会获知的信息 | 不得暴露后续纠正、事后澄清、诊断分析、候选原则或最终评价 |
| 反事实/替代行为评测 | 必须单独定义替代动作及其真实观测方式 | 历史轨迹在原动作之后发生的结果，是原动作路径的事实，不能直接当作宿主采取另一动作后的真实结果 |

因此，数据存储应支持按时间点构造输入视图。完整归档可以包含未来信息，但历史诊断回放和决策点评测必须按各自 cutoff 隔离信息。**不得发生 hindsight leakage（事后信息泄漏）。**

## 6. 对 PD 各阶段的约束

- **采集**：Pain 用于定位和触发事件调查；入口记录不等于事件样本完整。
- **归档**：保留原始轨迹及行动证据的权威引用和时间关系；不得以模型摘要替代原始材料。
- **诊断**：区分观察事实、Owner 期望、后续澄清和诊断推断；不得把推断写成原始事实。
- **候选原则**：引用可追溯的事件证据和适用原则版本；不得仅凭任务失败、情绪词或 Pain 数量形成原则。
- **评测**：评价行为与当时预期的相对符合度；任务结果单独报告，不作为偏差标签的替代品。
- **治理**：候选、评价、审批、激活和后续效果均为派生产物，不得覆盖原始事件。
- **隐私与授权**：读取、持久化、复用和清退分别遵守宿主来源授权及留存政策。授权不足时降低完整性等级，不得绕过政策补齐样本。

本规范定义的是语义和数据质量要求，不直接要求新增数据库表、通用 Evidence Engine 或第二套 Pain 管道。实现优先复用现有宿主轨迹存储、稳定 source reference、Pain 身份、诊断和治理链；若现有能力无法满足，必须先以源码和数据证明缺口，再提出最小变更。

## 7. Agent 必须遵守的判断规则

1. 不以任务成功/失败直接判断有无行为偏差。
2. 不把某种行为风格（询问次数、速度、检查数量、主动程度等）定义为跨 Owner 的普遍最优。
3. 不将 Pain 文本条数当作完整事件样本数。
4. 不以摘要替代原始对话轨迹、工具调用与返回、产物或状态变化。
5. 不把事后澄清或评价者推断冒充为宿主当时已知的期望。
6. 不隐藏用户意图与原则之间的冲突；不确定时允许无法判断。
7. 不把历史原动作之后的结果冒充为替代动作的反事实结果。
8. 不因数据集目标而绕过宿主授权、保留期限、撤回或脱敏要求。

## 8. 完整事件样本验收清单

一个样本只有在以下项目均有可追溯证据或明确的合规说明时，才能计入完整事件数：

- [ ] Pain/observation 信号可定位到具体行为位置、来源和时间。
- [ ] 相关任务从开始到信号触发的完整对话轨迹可读取，且没有用摘要代替。
- [ ] 相关工具调用、工具返回、产物和状态变化可追溯。
- [ ] 期望依据及其类别、时间、来源和宿主可见性已记录。
- [ ] 实际行为与期望之间的关系有证据位置和不确定性说明。
- [ ] 宿主、模型、配置及有效原则版本可追溯，敏感秘密未暴露。
- [ ] 后续澄清和 PD 派生产物与原始事件分开，并保留时间顺序。
- [ ] 来源授权、保留和清退条件允许本次使用。
- [ ] 已按事件而非 Pain 文本去重，并保留去重依据。

未通过清单的信号继续作为候选/待补资料保存，但不得计入完整样本分母。

---

# English — Normative Summary

## Canonical definition

A **Pain** is a signal and locator, not the dataset unit. The dataset unit is a **complete-context behavior-deviation event**:

> During a task performed by a user and a host agent, the agent's behavior deviates from the Owner's expectations, intent, and applicable PD principles at that time; a pain signal triggers the event's capture and accumulation.

## 1. Judge behavior in context, not by outcome

- A task can succeed while the agent still deviates (for example, it completes the result but exceeds the requested scope).
- A task can fail without a behavior deviation (for example, the agent follows the expected procedure but an external service fails).
- The same action can be aligned in one context and deviant in another. Asking repeatedly, acting quickly, checking more, or being proactive is not universally better.

The evaluation question is:

> In this Owner's specific task context, which behavior best matches the Owner's verifiable expectations?

More than one behavior may be acceptable. If expectations are unclear, conflicting, or unsupported by evidence, allow **undetermined**.

## 2. Required event contents

A complete event must preserve or reliably reference:

1. The Pain signal: original trigger, source/provenance, timestamp, and behavior location.
2. The complete relevant conversation from task start through the signal, with later clarifications and corrections linked chronologically.
3. Host action evidence: tool calls and results, artifacts, execution order, and state changes—not only the final response.
4. Expectation evidence: Owner wording, task intent, applicable principle and version, plus whether the host could access it at decision time.
5. The actual-versus-expected behavior relation, evidence locations, scope, and uncertainty.
6. Runtime conditions: host, model, configuration, effective principles/versions, and necessary environment references (never secrets).
7. PD derivatives—diagnoses, candidates, evaluations, Owner decisions, activation, and governance outcomes—stored separately from the source event.

The original trajectory is the sample body. A summary may aid navigation but must never replace the original trajectory. Use authorized canonical host stores and stable source references; do not bypass consent, retention, or revocation rules.

## 3. Completeness and counting

Count deduplicated **complete behavior-deviation events**, not Pain text rows or task rows. Multiple Pain signals may locate one event; similar wording does not prove two occurrences are the same event.

Keep incomplete signals as candidates with explicit missing-evidence reasons. They do not count as complete pipeline samples. The Owner-provided inventory figure of 106 signals is a candidate-entry count only; it must be rechecked against actual stores and must not be reported as 106 complete events.

## 4. Separate expectation evidence classes

For each expectation, preserve its source, timestamp, scope, and host visibility:

- **Contemporaneous expectation**: expressed before the behavior. Record whether the host could actually see or access it; an Owner statement hidden from the host cannot be treated as known to the host.
- **Post-hoc clarification**: clarified after the behavior. It can inform future PD learning but cannot be backdated as knowledge available to the host.
- **Evaluator inference**: inferred by an evaluator. Mark it as inference with uncertainty; never present it as an Owner quote or confirmed requirement.

When user intent and built-in principles are in tension, record both, including versions, applicability, scope, and priority relationship. Do not mechanically count how many principles were followed.

## 5. Preserve the archive; time-bound every evaluation input

- The full event archive contains the complete chronology, including later clarifications and governance records.
- Historical diagnosis replay may use only Pain and context that existed and was authorized at that historical diagnosis time.
- A host decision-point evaluation may expose only information available to the host up to that decision point.
- Later corrections, analysis, or labels must not leak into earlier decisions (**no hindsight leakage**).
- The observed continuation after the original action is not the true outcome of a counterfactual alternative action.

## 6. Agent rules

Never infer deviation from success/failure alone; never impose universal preferences about speed, questions, checks, or proactivity; never count Pain rows as complete samples; never replace original trajectories with summaries; never backdate post-hoc corrections; preserve conflicts and uncertainty; and never bypass source authorization or retention policy.

This document defines semantic and data-quality requirements. It does not by itself authorize a new database, a second Pain pipeline, or a generic evidence subsystem. Reuse existing authoritative trajectory stores and PD lineage wherever possible.
