# CONTRACT-PD-LAB-DATA-AND-SCORING-001 v0.3

## 0. 范围与约定

本文件是 [SPEC v0.3](SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md) 的数据与计分细化，状态 DRAFT；所有结构是**拟议研究契约**，不是当前已支持的 API/schema。适配现有字段时可通过映射满足，不要求复制一份同义数据。技术归属见 [TECH](TECH-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3.md)，任务与测试见 [HANDOFF](../plans/PD-LAB-V03-IMPLEMENTATION-HANDOFF.md)。

2026-11-17 修订：新增按路径的准入资格和三个问题代码（§2.4）、来源组最低规则（§3）、比较设计（§4）、改动对基线的判定规则（§6.5）及对应手算例（§7）。同日第二轮：§6.5 改为双侧检验（两方向各用 α/2）并更新阈值表与 SC-13 至 SC-16；§5.1 增加 Judge Protocol 版本绑定与 UNKNOWN/截断策略；§3 明确 `caseId = experimentPainId` 的历史数据映射。同日第三轮（PR #2696 评审整改，Owner 指令）：§5.2 归并增加证据绑定校验（评审记录须绑定预注册 judge slot 身份与尝试号、同一单元的比较输入 digest 必须一致、仲裁须绑定输入版本 digests，缺证据或不可验证的单元一律 UNKNOWN 并披露）；§6.2 输出增加 `rankingQualification` 与 `evidenceProblems[]` 并澄清 `ESTIMABLE`≠正式排序资格；§6.5 输出增加派生诊断 `groups[]`。统计公式、α/2、来源组等权与 k 值表未变。同日第四轮（PR #2696 第三次整改：Judge Slot / Attempt 完整性，Owner 指令）：新增 §5.2a（Judge Slot 是投票单位、requiredJudgments 按席位计、T4 注册表引用完整性验证、冻结恢复规则、绑定/冲突检查先于去重）；§6.5 `groups[]` 字段名统一为 `lower_g`/`upper_g`（此前实现输出 `lower`/`upper`，现实现与测试对齐本契约定义）。统计公式、α/2、来源组等权与 k 值表未变。同日第五轮（PR #2696 第四次整改：统计正确性，Owner 指令）：§6.1/§6.2 聚合与全部 0.5 边界比较改为精确有理数运算（浮点聚合曾把精确平局误判为 DEFINITE_WIN）；§6.5 阈值 k(n,α) 改为全 BigInt 尾和交叉乘法（2**n 在 n=1024 溢出曾致假 IMPROVED；阈值表数值本身零改动）；§6.2 计分面限定单候选——计划混合多个 candidateConfigId 时 fail-closed 拒绝（CANDIDATE_IDENTITY_CONFLICT），不得混合计分；FinalComparison 引用与冻结 assignment 矛盾即拒（COMPARISON_REF_MISMATCH）；§5.1 FAILED attempt 无判词合法（保留审计不投票），SUCCEEDED 仍须合法判词；§6.2 bindings 增加来源组 digest 绑定（sourceGroupsDigest，覆盖实际生效分组与 rationales）。统计公式、α/2、来源组等权与 k 值表数值未变。

字段标记：R=必填且验证内容；C=条件必填；O=可选。枚举严格校验，数组逐元素验证。未知不是空字符串、0或false；缺失必填字段是结构错误，合法UNKNOWN必须有原因。示例中的标识为合成演示，不能当真实授权或运行结果。

## 1. 引用、身份与版本

### 1.1 EvidenceRef

| 字段 | 约束 |
| --- | --- |
| `sourceKind` R | `HOST_TRANSCRIPT / TOOL_TRACE / ARTIFACT / DATASET / EXPECTATION / AUTHORIZATION / RUN / JUDGMENT / PROTOCOL`，扩展需版本变更 |
| `sourceId` R | 源系统稳定身份；不能仅靠文件名识别事件 |
| `version` R | 源版本；无版本则绑定冻结快照身份 |
| `locator` R | 受控解析器可定位的文件/记录引用；不包含凭据；不默许任意网络抓取 |
| `digest` R | 算法、value、规范化标识、覆盖范围；原始文件按字节，新派生JSON使用明确的canonicalization |
| `anchor` C | 引用部分轨迹/内容时指定消息ID、工具调用ID或定位范围；同时保留整体digest |

现有 hash 规则原样保留；不能换算法后仍沿用旧 version。新规范化优先复用已审计的实现，验证键顺序、数组顺序、非有限数字和不支持类型；不把 JS 的 undefined 静默序列化成另一种值。引用可能不可用，解析器返回结构化原因而非空对象。

来源中的 painId/sessionId/taskId/principleId 保持原系统身份。`caseId`、`sourceGroupId`、`benchmarkVersion` 是研究身份，不能冒充生产身份。所有跨记录关联必须验证源版本、案例和运行身份一致，拒绝混用不同轮次的证据。

## 2. 完整案例与期望档案

### 2.1 CaseRecord

| 字段 | 要求 |
| --- | --- |
| `schemaVersion` R | 新研究协议版本；第一实现需显式注册，不沿用不兼容旧schema名称 |
| `caseId / caseVersion / sourceGroupId` R | 均为非空稳定标识；变体共享来源组，案例内容变化新版本 |
| `recordKind` R | `PAIN_CASE / CONTROL_OPPORTUNITY`；后者不是伪造Pain |
| `provenance` R | 真实/脱敏/合成等来源类型、父案例引用、数据源和采集窗口 |
| `painRefs` C | PAIN_CASE 至少一个有效信号引用及触发锚点；CONTROL_OPPORTUNITY可为空 |
| `trajectoryRef` R | 完整源轨迹引用，不是摘要引用 |
| `boundary` R | 任务开始、冻结/结束、前置上下文引用及边界依据 |
| `expectationRef` R | 期望档案引用；允许档案明确未解决，不能省略后默认无要求 |
| `hostContextRefs` R | 可观察宿主配置、有效原则集合及版本；不暴露部分列未知 |
| `authorizationRef` R | 范围、用途、有效期和撤回状态的可验证授权引用；自填allowed=true无效 |
| `environmentRefs` R | 数组可为空，但声明的执行路径需要哪些环境引用由path检查决定 |
| `integrity` R | 导出工具版本、源计数/分页证据、缺口、工具关联、附件解析和摘要使用情况 |

完整性资格由validator派生，不能信任案例自己声明 `complete=true`。合法未解决期望与来源完整性分开；如果无法确定该研究所需期望，就不能进入相应正式计分，仍可作为歧义研究材料。

### 2.2 TrajectoryView

这是对宿主原始格式的派生视图，不替代原始文件。

| 字段 | 要求 |
| --- | --- |
| `sourceRef` | 完整原始轨迹身份与digest |
| `events[]` | 每项含 `eventId`、角色/类型、内容或受控内容引用、顺序、源锚点 |
| `eventOrder` | 优先源系统可靠序号；跨流用明确偏序/关联，不能只按时间戳猜顺序 |
| `observedAt / availableAt` | 已知时保留；不知道时间则记未知并使用可靠源顺序，不伪造精度 |
| `toolCallId / parentEventId` | 对适用事件必填，调用和返回双向关联 |
| `gaps[]` | 丢消息、截断、无法解码、缺附件、未决调用及其对研究影响 |

不同角色消息总量、首尾边界、分页完成标记和工具配对必须可审计。没有源端完整性证据时不能凭“事件数组非空”认定完整。正常中断时的未返回调用可以是真实状态；注明其发生在冻结边界及研究影响，不为配对完整伪造返回。

### 2.3 ExpectationRecord

每项期望包含：`expectationId`、来源引用、`basis=EXPLICIT_AT_TIME / LATER_CLARIFICATION / RESEARCH_INFERENCE`、当时可知位置、适用条件、允许行为集合、明确偏离关系、相关原则引用、冲突与审阅结论。

模型提议的推断不能升级成用户明示。后续纠正可支持学习研究，但判断历史宿主可知责任时必须标明后见信息。不同Owner相反偏好保留为不同档案；模糊或冲突未解决的案例进入校准/仲裁，不自动以默认原则压平。

### 2.4 ValidationResult

```text
completeness: INCOMPLETE | COMPLETE_FOR_ANALYSIS
pathReadiness[path]: READY | BLOCKED | NOT_EVALUATED
problems[]: {code, fieldOrRef, evidenceRefs, impact, nextAction}
validatedBindings: {caseVersion, sourceDigests, validatorVersion}
```

全部必填输入通过且该path所需快照/入口/授权具备，才可派生 SPEC 的 `EXECUTABLE_FOR_DECLARED_PATH`。`NOT_EVALUATED` 不能当READY。结构损坏直接拒绝；记录合法但证据缺失返回INCOMPLETE，保留补齐队列。

首批问题代码：`SOURCE_GAP`、`SOURCE_RETENTION_EXPIRED`、`TURN_BLOB_MISSING`、`TOOL_RESULT_PREVIEW_ONLY`、`PAIN_ANCHOR_MISSING`、`EXPECTATION_UNRESOLVED`、`AUTHORIZATION_UNVERIFIED`、`REFERENCE_UNAVAILABLE`、`DIGEST_MISMATCH`、`FUTURE_INFORMATION`、`ENVIRONMENT_UNAVAILABLE`。**2026-11-21 r8 追加**：`INGRESS_HOST_UNRESOLVABLE`、`TOOL_RESULT_MISSING`、`EXPECTATION_VISIBILITY_UNPROVEN`（见下方 r8 规则）。每个代码必须有真实拒绝/降级用例，不只添加枚举。

`SOURCE_GAP` 与 `SOURCE_RETENTION_EXPIRED` 的区分规则：不得仅凭“快照内该会话最早一行晚于 Pain 触发时间”断言保留期已删。判定 `SOURCE_RETENTION_EXPIRED` 需要保留证据支持——会话创建时间早于该最早行、`turn_index` 序列从大于 0 的值开始、或保留清扫日志等其他证据表明更早的行曾存在；否则记 `SOURCE_GAP`（真实缺失或正常会话边界），并在 `problems[].impact` 说明两种可能。正常会话中 Pain 之前只有少量轮次不是缺陷。

第一版定义三条路径。`pathReadiness` 按路径分别给出，发布计数也按路径分别列出 READY 数，不合并成一个数。

**2026-11-21 r7 澄清（准入探测实现侧）**：历史前缀完整性（首写入者身份锚点缺失时为 UNKNOWN，见 PD-Lab T7a 准入报告 §15–§16）是样本级 `completeness` 的输入之一（非 PROVEN_COMPLETE 即 INCOMPLETE），但**不自动构成任何路径的阻断问题**。路径 `pathReadiness` 只由该路径实际所需的输入证据决定：生产诊断 fallback 无界读取会话全部 user/assistant 轮次与 correction-evidence blob（`TrajectoryTurnReader`，PRI-350），因此快照内全部相关行可读且 blob 完整时，即使前缀 UNKNOWN，`PIPELINE_REPLAY` 也可 READY。`SOURCE_GAP` 仅在观察到真实输入缺口（角色缺失、序列断档、顺序破坏、空窗口、起点晚于触发）时产生；未知前缀以 `prefixCompleteness`/`prefixCompletenessReason` 字段单独披露。`PROVEN_INCOMPLETE`（正向删除证明）仍然阻断全部轨迹依赖路径。

| path | READY 的必要条件 | 首个宿主（OpenClaw 轨迹库）的已知情况 |
| --- | --- | --- |
| `PIPELINE_REPLAY` | 快照包含生产诊断入口为该 Pain 构造输入时会读取的全部记录；授权有效；实验入口可表达该样本的会话绑定 | `SOURCE_GAP`、`SOURCE_RETENTION_EXPIRED`、`TURN_BLOB_MISSING` 阻塞。`TOOL_RESULT_PREVIEW_ONLY` 不阻塞，因为生产入口读到的同样是预览，但必须记录。**r8**：会话绑定样本的宿主无法解析为 OpenClaw（未知/空/其他宿主）时 `INGRESS_HOST_UNRESOLVABLE` 阻塞——与生产 ingress fail-closed 语义一致（省略 `--host` 会被 CLI 默认为 openclaw，不得猜测归因）；无会话绑定的非 OpenClaw 宿主样本仍为 NOT_EVALUATED（不涉及入口宿主归因） |
| `EXPECTATION_LABELING` | 与期望相关的轮次和工具输出可完整读取；期望的历史可见性可核验 | 期望依据依赖工具输出时，`TOOL_RESULT_PREVIEW_ONLY` **或** `TOOL_RESULT_MISSING` 阻塞，需用宿主原生会话文件补齐。**r8**：`basis=EXPLICIT_AT_TIME` 缺少 `visibleAt`（且无契约认可的等价证据）时 `EXPECTATION_VISIBILITY_UNPROVEN` 阻塞——依据声明本身不是可与触发时刻比较的证据；`visibleAt` 晚于触发时刻仍为 `FUTURE_INFORMATION`；不可解析的 `visibleAt` 在加载层直接结构化拒绝。`RESEARCH_INFERENCE` 不适用该规则、不自动升级 |
| `BEHAVIOR_BRANCH` | 决策点的仓库与环境可恢复 | 历史案例没有保存环境快照，默认 `ENVIRONMENT_UNAVAILABLE` |

**2026-11-21 r8 规则（准入探测实现侧）**：

1. **宿主归因 fail-closed（`INGRESS_HOST_UNRESOLVABLE`）**：会话绑定样本的 `host_kind` 非 `openclaw`（null、空串、未识别或明确其他宿主；比较前做与生产一致的 trim+小写归一）时，`PIPELINE_REPLAY` 必须 BLOCKED 并给出结构化阻断原因；原始归属保留、不得转换为 openclaw、不得据此无条件阻断 `EXPECTATION_LABELING`（该路径不经 CLI 入口，按自身证据独立判定）。
2. **工具返回证据（`TOOL_RESULT_MISSING`）**：`dependsOnToolOutput=true` 时必须存在真实可读的返回——工具调用不等于工具输出，`params_json` 是调用侧永不是返回侧。**仅统计 Pain 触发时刻及之前的调用**：触发后的完整返回对历史期望是未来信息，不能替代触发前证据（与 `FUTURE_INFORMATION` 同理）。会话无任何 `tool_calls` 行、全部调用晚于触发、或触发前各行的 `result_preview` 均为 NULL/空（且无截断预览形态、无契约认可的 Blob 等恢复路径——当前快照形态的 `tool_calls` 无 blob_ref 列，turn blob 仅覆盖 user/assistant 轮次）时，`EXPECTATION_LABELING` BLOCKED。**可证明有损的预览形态**均按 `TOOL_RESULT_PREVIEW_ONLY` 处理：500 码元截断形态（497+'...'）与对象路径的 `"__truncated__"` 键裁剪标记；无任一有损标记的非空预览是本快照形态可承载的完整可读证据（生产对纯字符串结果 ≤500 码元全量写入；content-array 结果仅序列化 text 块——该静默丢弃在行内不可检测，属生产者侧已披露的残留限制）。`PIPELINE_REPLAY` 不因该期望缺口自动阻断。
3. **历史可见性（`EXPECTATION_VISIBILITY_UNPROVEN`）**：`EXPLICIT_AT_TIME` 声明"当时已可见"，声明需可核验——优先 `visibleAt`；缺失且无等价证据即 BLOCKED；晚于触发为 `FUTURE_INFORMATION`；不可解析为结构化拒绝；早于/等于触发则继续其余条件评估。

`PIPELINE_REPLAY` 为 READY 不等于该案例是 SPEC §5 意义上的完整偏差案例；后者还要求工具返回等证据无未解释缺口。两个数字分开报告。

## 3. 输入投影与数据发布

ProjectionRecord 必须绑定 `caseRef`、`studyMode`、`cutoff`、`projectionVersion`、允许的历史学习材料引用、`includedEventIds`、排除事件及原因、缺失信息、最终actor输入digest。

允许模式为历史管道分析、决策点行为、纠正后新机会；边界规则遵循SPEC §5.3。截止判断用“宿主当时可见”而非研究者导出时间。若源序列不足以确定先后，相关分支BLOCKED；不能仅按同秒时间排序。

Dataset release 复用所属领域manifest，通过不可变引用连接case、split和validator结果。必须冻结来源组到split的映射，校验父案例/变体/跨组关联泄漏。相同源事件拆成多个Pain仍是一个来源组。完整源样本留存，不因投影较短而删掉历史。

来源组映射随数据集发布，文件名 `source-groups.json`，内容为 `caseId → sourceGroupId` 的**完整**映射及每组的分组依据。历史数据集的 `caseId` 取 `experimentPainId`（数据集样本的主键），映射必须覆盖数据集的每一个样本。最低机械规则：同一 `session_id` 的 Pain 属于同一来源组。跨会话的同一事件、近重复和派生变体由可审查的判断合并进同一组，并记录依据；没有人工依据时不得跨会话合并。映射缺失或有案例未被覆盖时，计分直接 INVALID_PLAN，不默认“一例一组”。已冻结的 16 条样本经会话分组最多 14 个来源组（S01/S08 同会话、S02/S04 同会话），不得当作 16 个独立样本计数。

发布计数至少分开：信号数、任务/来源组数、完整案例数、可执行案例数、对照机会数、真实与派生数量、未授权/缺失/争议数。授权撤回使后续使用资格失效，并产生可追踪的新发布/撤回记录；不直接修改旧数字掩盖影响。

## 4. BenchmarkPlan：从计划确定分母

复用experiment-manifest.v1绑定实验身份；另以研究协议引用承载下列既有manifest不拥有的计划内容。不复制该manifest已有事实。

| 字段 | 要求 |
| --- | --- |
| `benchmarkId/version / experimentRef` | 不可变版本和现有实验身份引用 |
| `comparisonDesign` | `CHANGE_VS_BASELINE / HOST_VS_FIXED_REFERENCE`，见下 |
| `datasetRef / splitRef / expectationSetRef` | 所有案例、分组、期望版本冻结 |
| `population / ownerStrata / groups` | 目标人群、Owner构成、场景组、预设组权重 |
| `candidateConfigs / referenceConfig` | 模型/宿主/工具/预算/有效原则和输入策略，参考集合权重如适用 |
| `judgeProtocolRef` | 裁判身份与版本、交换规则、校准结果、仲裁与最终归并 |
| `assignments[]` | 下述完整分配集合，运行前冻结 |
| `recoveryPolicyRef / analysisPolicyRef` | 重试、主要分析、不确定性、停止与最低精度规则；`analysisPolicyRef` 必须显式冻结正整数 `minimumIndependentSourceGroups`、区间方法/置信水平和精度目标，缺项即不具备正式确认性分析资格，不得套用默认值 |
| `authorizationRefs` | 数据、外部调用、宿主执行的适用批准范围及限额 |

两种比较设计共用同一套裁判记录、归并和层级聚合，区别只在参照是什么：

- `CHANGE_VS_BASELINE`：参照是同一实验里的基线臂，即同一宿主与模型配置、不含被评估改动的那一侧。两臂在同一批次内交错运行，不使用缓存的参照输出。50 分表示改动与基线持平。结果用 §6.5 判定，不进入跨实验榜单。研发晋级决策使用这一设计。
- `HOST_VS_FIXED_REFERENCE`：参照是 benchmark 版本冻结的固定参照宿主。用于多宿主排名，正式排名资格遵循 §6.2。

下文的“候选/参考”在 `CHANGE_VS_BASELINE` 中分别指改动臂和基线臂；实验配置中以 `candidateArm`/`baselineArm` 显式声明（TECH §4.4），不得按臂名字母序或声明顺序推断角色。

每个assignment键：`candidateConfigId + caseId@version + opportunityId + repetitionId + referenceId`。整个计划内唯一；两侧分别绑定源版本、输入投影、环境与运行身份。候选身份不进入裁判可见包。

来源组在单一正式榜单中属于一个Owner层和一个主场景组；跨分类案例用次级标签做诊断，不能重复占主总分权重。Owner/场景/来源组结构在结果产生前冻结。场景组为空、权重非有限/负数/总和不符、重复键或缺参照均为INVALID_PLAN，不可自动补齐默认值。

计划必须包含每个候选同样的案例和条件覆盖。缺支持能力是未能覆盖该榜单，不得静默删除困难组；可以另建明确范围的子榜单。参考记录可缓存，但绑定运行环境与模型版本；参考已经过时或无法证明可比则更换benchmark版本，而非悄悄复用。

## 5. 裁判记录与确定性归并

### 5.1 RawJudgment 与版本化 Judge Protocol

裁判行为由**版本化的 Judge Protocol** 定义（`judgeProtocolRef` 引用），新实验必须显式绑定一个版本。历史评审文件和历史格式保留原义、不追溯修改；新协议版本可以修改评价提示词与调用方式，但不得破坏历史记录的可解析性和历史结论的兼容性。

每条裁判记录至少保存：`judgmentId`、assignment键、`judgeProtocolRef`、比较输入digest、rubric/裁判配置、尝试号、显示顺序及受控身份映射、`A_BETTER / TIE / B_BETTER / UNKNOWN`、两侧证据引用（锚点）、判断理由、UNKNOWN原因。原始响应需通过解析验证；非法输出不能默认为TIE。

约束：

- **UNKNOWN 是显式判断**，不允许从低置信度、短理由或超时简单推断为 UNKNOWN；只有证据不足或不可比较时由裁判明确给出，并记录原因。
- **有损输入必须标记**：送评材料被截断或降级时（如旧评审脚本对超过 9000 字符的阶段输出截断），记录 `lossyInput: true` 及截断位置；关键证据缺失时该单元判 UNKNOWN，不得当作完整输入正常评价。
- 记录模型运行失败但无合法判断时，保留失败attempt，由冻结恢复策略决定是否再试。正式裁判调用次数和交换次数由协议给出，不能看到结果后加票。
- 裁判与生成器的模型家族关系在协议中显式披露；同族是已声明的限制，不是隐藏项。

### 5.2 FinalComparison

```text
assignmentKey
candidateTrajectoryRef / referenceTrajectoryRef
expectationRef / judgeProtocolRef
judgmentRefs[] / arbitrationRef?
verdict: CANDIDATE_BETTER | TIE | REFERENCE_BETTER | UNKNOWN
reasonCode / evidenceRefs[]
resolvedBy: CONSISTENT_JUDGMENTS | BLIND_ARBITRATION | UNRESOLVED
```

归并顺序：

1. 验证计划键、双方轨迹/期望/协议绑定及裁判记录数；缺计划内记录保留UNKNOWN。
2. 将显示A/B还原到候选/参考身份。身份映射缺失或冲突属于无效证据，不猜测。
3. 协议要求的判断全部可用且同一结论，直接采用。
4. 任何相反结论、TIE与胜负冲突或实质证据冲突，进入冻结的盲复核/仲裁路径；原始记录不删除。
5. 仲裁引用必须绑定本次全部记录及输入版本。有效且明确时采用；未完成或仍不确定则UNKNOWN。
6. 总分函数只接收FinalComparison；不能平均原始票、挑最好票或把分歧换成0.5。

具体由谁仲裁和调用几次属于预注册必填参数。没有配置则协议不具备正式计分资格。Owner可作为仲裁者，但界面仅显示判断必要证据，不显示被测宿主身份和当前排行。

### 5.2a Judge Slot / Attempt 完整性（2026-11-17 第四轮，PR #2696 第三次整改，Owner 指令）

缺陷背景：整改前同一 Judge Slot 的多个 attempt 会计入有效裁判席位数（attempt 数量放大席位），同一 (slot, attempt) 的冲突记录按 judgmentId 字典序静默保留一条且不阻断判定。本小节冻结正确语义；实现（`mergeJudgments`）与本节逐条对应并有测试。

1. **Judge Slot 是投票单位**。`requiredJudgments` 按**有效且独立的 Judge Slot 数**计，不按原始记录数。一个 Assignment 中一个通过资格验证的 Judge Slot 最多贡献一张有效选票；attempt 数量永远不能增加席位。席位表：单 slot 单有效 attempt → 1 席；同 slot 多个一致 attempt → 至多 1 席；同 slot 冲突记录 → 0 席；两个经资格验证的不同 slot → 2 席。有效席位不足按既有缺失证据/UNKNOWN 聚合处理；不得把局部证据冲突偷换成全局确定结论；§6.5 INCONCLUSIVE 语义不变。
2. **Judge Slot 身份来源（T4 = 引用完整性验证；注册属 T7a）**。非空 `judgeSlotId` 字符串本身不能证明是预注册独立席位。T4 唯一可验证凭证是计划级预注册席位表 `judgeProtocol.judgeSlots: [{ judgeSlotId }]`（最小凭证形态）：存在时逐条做引用完整性比对，来自注册表之外席位的记录使单元 UNKNOWN（`JUDGE_SLOT_NOT_PREREGISTERED`）；缺失时无法证明不同字符串是预注册独立席位，报告在 `rankingQualification.unmetCriteria` 披露 `JUDGE_SLOT_REGISTRATION_UNVERIFIED`。本条不实现 T7a 注册/校准，`rankingEligible` 不因此放宽。
3. **Attempt 生命周期与冻结恢复规则**。`attempt` 只是同一 slot 的调用历史（含失败的技术重试），记录可携带 `attemptStatus: FAILED | SUCCEEDED`（T4 唯一可审计终态；§5.1 的失败 attempt 保留义务由此落到记录级）。冻结恢复规则：声明 FAILED 的尝试不投票并披露（`ATTEMPT_FAILED_EXCLUDED`）；排除后剩余候选恰一条 → 该席有效票；多条候选 **canonical 内容完全一致**（comparisonInputDigest、displayVerdict、unknownReason、lossyInput、reason、evidenceRefs、blindmap 绑定全部一致；judgmentId 与 attempt 号是落盘痕迹，不参与比较）→ 幂等归并为一席（同 attempt 重复落盘 = `DUPLICATE_ATTEMPT_RECORD`，跨 attempt 一致重试 = `MULTI_ATTEMPT_AGREEMENT`，均为非阻断披露，代表记录取最小 judgmentId——内容一致时代表选择无投票语义）；候选内容存在**任一差异** → 无法证明哪条是最终有效记录 → 该席零票、单元 UNKNOWN（`CONFLICTING_ATTEMPT_RECORDS`）。**禁止**以时间戳、最大 attempt、judgmentId 字典序、最后写入或文件顺序作为挑选依据。
4. **绑定/冲突检查先于去重**。对原始候选记录集先做绑定与冲突校验（计划键、协议版本、双方轨迹/期望绑定、judgeSlotId 存在性、注册表比对、comparisonInputDigest 一致性），再进行席位归并。相同 Assignment 的有效记录绑定不同 `comparisonInputDigest` 时不得先去重再检查——冲突进入 `evidenceProblems`（`COMPARISON_INPUT_DIGEST_CONFLICT`）并阻断该单元的正式判定（有其他有效席位也不得"丢一条继续"）；冲突记录保留在 `judgmentRefs` 审计轨迹中，不得静默丢弃。
5. **缺 attempt / 非法 attempt**。缺失不默认为 1（`ATTEMPT_MISSING`，阻断该席、保留原始异常证据）；非法值（非正整数）是结构错误记录（`INVALID_JUDGMENT_RECORD`），不参与正式计票。

## 6. 主标量算法

### 6.1 单元和层级

`value(CANDIDATE_BETTER)=1; value(TIE)=0.5; value(REFERENCE_BETTER)=0`，UNKNOWN没有点值。

第一版按以下层级求均值；每层权重在计划固定，不从结果文件数量计算：

```text
trial      = 单一计划比较单元的value
opportunity = 该机会全部预定repetition（及固定reference组合）的加权均值
case        = 该案例预定opportunity的均值
sourceGroup = 该来源组预定case的均值
scenario    = 该场景组预定sourceGroup的均值
owner       = Σ scenarioWeight × scenario
score       = 100 × Σ ownerWeight × owner
```

单一Owner/单机会/单来源案例等退化情况与SPEC公式一致。未来若需要非等权的机会/案例/来源组，必须作为新协议明确理由及权重，不能由实现者自行引入。展示所有层计数，避免一个长会话或大量合成变体获得不成比例的权重。

### 6.2 完整计划与UNKNOWN

算法先读取计划创建全部单元，再按唯一键left join最终结论。结果中额外键、重复终局、错误版本拒绝；缺少键生成UNKNOWN和原因。每个单元的未知下界0、上界1；按上述相同层级分别聚合lower/upper。

输出：

```text
pointEstimate: number | null
missingBounds: {lower, upper}
status: ESTIMABLE | BOUNDED_ONLY | INVALID
rankingEligible: boolean
rankingQualification: {eligible, unmetCriteria[], rationaleMissingGroups?[]}
counts: {planned, resolved, unknown, invalidRecords, ...各层计数}
samplingInterval: {status, method, level, lower?, upper?, reason?}
bindings: {planDigest, comparisonsDigest, sourceGroupsDigest, analysisVersion, referenceVersion}
evidenceProblems[]: {code, message, assignmentKey, detail?}   // 未验证证据披露（不使运行失效）
```

任何计划单元UNKNOWN时pointEstimate=null、BOUNDED_ONLY、rankingEligible=false。全部可判定且协议/校准/版本可比性通过，才有ESTIMABLE与正式排序资格；结构INVALID不是统计未知，不输出有效分数。全部平局得50，表示持平而非“表现合格”。

2026-11-17 Owner 整改裁定（一句话澄清）：`ESTIMABLE` 只表示全部计划单元的点值可计算，**不构成正式排序资格**；`rankingEligible` 由资格凭证独立判定（裁判校准凭证、冻结 analysisPolicy、预注册最小独立来源组、版本可比性、研究准入状态、来源组独立性证据），缺任一凭证即为 false，并以 `rankingQualification.unmetCriteria` 如实披露未满足项，不伪造通过状态。

缺失范围不是统计区间。未知单元不进入bootstrap生成貌似精确的正式区间；先报告missingBounds及覆盖，不以完整案例子集替换主榜结果。

### 6.3 不确定性与排序

完整点值可计算后，按来源组聚类重采样，候选与参照保持配对，同组的案例/机会/重复记录整体随组进入抽样；各场景层权重不变。对固定Owner集合的推断在Owner/场景内抽样来源组；若要外推Owner人群，需另定义Owner抽样层和足够Owner数。不得给单一Owner数据附“跨人群泛化”的区间。

bootstrap随机种子、重复数、区间方法、置信水平及最小独立组要求在analysisPolicy冻结。独立来源不足时interval.status=NOT_ESTIMABLE并注明原因；不得把零宽区间当确定性证明。正式可比点值可以展示排序，但晋级/显著胜出还需足够精度及预注册效果判据。多个模型冠军或多亚组结论需处理多重比较，否则仅作描述性排序。

排序使用未舍入score，展示可保留一位小数。相同数值并列；置信区间重叠与否不能独自代替配对差异检验。变更任何bindings使跨版比较无效，需重测共同案例或发布新榜单。

### 6.4 PD增益与分项

候选对固定参考是排行榜比较；同一宿主PD-on/PD-off、同一代码开关开/关、改动前/后，都是 `CHANGE_VS_BASELINE` 的直接干预比较。两类assignment集合分别冻结，不能从排行榜差分自动推断因果收益。

案例的期望档案给出可判定的“是否满足期望”判据时，二元结果与对齐偏好并列作为主要结果报告，调用既有F统计；UNKNOWN和交付失败遵循该契约。没有可判定判据的案例标为不适用并计数，不强行二值化。多维语义偏差通过对齐比较解释；不为复用F函数强行将TIE映射为PASS或FAIL。任务结果、成本和交付证据作为独立分项，不参与未经定义的总分权重。

### 6.5 改动对基线的判定规则

适用于 `comparisonDesign=CHANGE_VS_BASELINE`。判定以来源组为单位，各组等权；§6.1 的加权总分只作描述，不直接用于判定。

1. 对每个计划内来源组，把组内UNKNOWN单元分别置0和1，按§6.1聚合到来源组，得到 `[lower_g, upper_g]`。
2. 分类：`lower_g > 0.5` 为确定胜；`upper_g < 0.5` 为确定负；其余为未定，包括真实平局和被未知遮蔽的组。
3. 令n为计划内来源组总数，W、L为确定胜、确定负的组数（一个组只能进入其一，不重复计数）。检验为**双侧**：总显著性水平 α 在预注册冻结（默认建议 0.05），改善与回归两个方向各用 α/2；k(n, α) 为满足 `P(X ≥ k) ≤ α/2`（X服从 Binomial(n, 0.5)）的最小整数。检验方向（哪个臂是 candidate）随计划预注册绑定，运行后不得交换。
4. 判定：`W ≥ k` 为 `IMPROVED`；`L ≥ k` 为 `REGRESSION`；否则为 `INCONCLUSIVE`。因 k > n/2，IMPROVED 与 REGRESSION 不可能同时成立。词汇沿用 `experiment-manifest.mjs` 的 `BEHAVIOR_OUTCOMES`。
5. `INCONCLUSIVE` 时输出 `unknownsCouldChangeVerdict`：把所有含UNKNOWN且 `upper_g > 0.5` 的未定组都计为胜后 `W ≥ k`，或把所有含UNKNOWN且 `lower_g < 0.5` 的未定组都计为负后 `L ≥ k`，则为true，下一步是补证据或仲裁；否则为false，补证据不会改变判定，不再投入仲裁成本。
6. 预注册的硬护栏单独判断并输出 `guardrailBreaches[]`。任一触发时判定结果照常给出，但不得据此晋级（SPEC §10）。

未知结果在本规则下既不帮助改动也不帮助基线，因此不需要“零未知”才能下结论。点值仍按§6.2处理：有未知时为null并给出缺失范围。

本规则不输出 `NO_IMPROVEMENT`。证明“没有差异”需要等效界值和更大的样本，R6之前不定义。

**统计标准不可协商下调。** 改单侧为双侧、上调 α、按样本而非来源组计数、或以重复运行增加“独立”样本数，都是协议版本变更，必须重新预注册并重新声明功效；不得为了让既定数据集（包括已冻结的 16 条历史样本）更容易得到改善结论而调整。

实现必须通过的性质验证（每条都要有测试，见 HANDOFF T4）：

- W、L 不重复计数：一个来源组归入确定胜、确定负或未定之一。
- UNKNOWN 不帮助任一方向：把 UNKNOWN 全部置为对己有利不会改变 W/L 的既有计数语义（只影响 unknownsCouldChangeVerdict）。
- TIE 不冒充 UNKNOWN：真实平局组的 `[lower_g, upper_g]` 收敛为单点 0.5，分类为未定而非未知遮蔽。
- 缺失单元保留分母：计划内单元无终局时进 UNKNOWN 与缺失范围，不从 n 中删除。
- 所有来源组等权：组的单元数量不改变该组在判定中的权重。
- 重复运行不增加独立样本数：同一样本的多次 repetition 在组内聚合，不增加组数。
- 未知边界可复算：`missingBounds` 与逐组 `[lower_g, upper_g]` 一致，能从 FinalComparison 独立重算。
- `unknownsCouldChangeVerdict` 的两个方向枚举正确，且只在 INCONCLUSIVE 时输出。

双侧 α=0.05（每方向 α/2=0.025）时的 k 值，用于实现自检：

当 `n ≤ 5` 时，不存在满足 `k ≤ n` 的阈值，因此在该显著性水平下不可能得到 `IMPROVED` 或 `REGRESSION`；这类样本量只能产生描述性/探索性结果。`n = 6` 是数学上首次可能拒绝原假设的规模，但必须 6 组全部确定胜（或全部确定负）。`n ≥ 6` 只表示检验在数学上可达，不代表统计功效或区间精度已经足够。

| n | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| k | 6 | 7 | 8 | 8 | 9 | 10 | 10 | 11 | 12 | 12 | 13 |

| n | 20 | 30 | 50 | 100 |
| --- | --- | --- | --- | --- |
| k | 15 | 21 | 33 | 61 |

正式确认性分析还必须满足预注册 `analysisPolicyRef.minimumIndependentSourceGroups`、区间方法、置信水平和精度目标；不得把 `n ≥ 6` 单独当作样本充足或晋级资格。`n` 是预注册计划中的独立来源组数，不是 Pain 条数、重复次数或评审记录数。
输出在§6.2结构上增加：

```text
decision: {
  design, alpha, alphaPerDirection, plannedGroups, definiteWins, definiteLosses, undetermined,
  threshold, outcome: IMPROVED | REGRESSION | INCONCLUSIVE,
  unknownsCouldChangeVerdict, guardrailBreaches[],
  groups[]: {sourceGroupId, scenarioId, plannedUnits, lower_g, upper_g, containsUnknown, classification}
}
```

`decision.groups[]` 是**派生诊断字段**而非独立统计结果（2026-11-17 Owner 整改指令）：每组的 `[lower_g, upper_g]`、`containsUnknown` 与 `classification` 都能从计划 + FinalComparison 按 §6.1 独立复算，仅用于 Owner 审计展示；判定权威是它上游汇总出的 `definiteWins/definiteLosses/undetermined/outcome`。该字段与 §6.2 的 `ESTIMABLE`/`rankingEligible` 语义分离：它不授予任何排序或晋级资格。

## 7. 可机械验算的合成例

这些是算法夹具预期，不是真实模型结果。

| ID | 输入 | 预期 |
| --- | --- | --- |
| SC-01 | 一组、两个独立来源：胜、负 | 50，完整可计分 |
| SC-02 | 一组、两来源：第一来源单案例重复胜/负；第二来源单次胜 | 75；不是按三个输出直接算66.7 |
| SC-03 | 两场景等权：A来源得1、0.5；B来源得0 | 37.5 |
| SC-04 | SC-03的B改为UNKNOWN | point=null，范围[37.5,87.5]，不得列正式排名 |
| SC-05 | 一来源有十个得1的派生案例，另一来源一个得0案例 | 50；不得按11个案例算90.9 |
| SC-06 | 所有计划单元TIE | 50；不自动晋级 |
| SC-07 | 计划2单元，只落盘一个胜 | point=null，范围[50,100]，缺记录保留 |
| SC-08 | 两份相同assignment终局 | INVALID；不能任取最后一条 |
| SC-09 | 一次A胜候选，交换位置后B胜且B是候选 | 一致的候选胜，1 |
| SC-10 | 两次交换分别支持不同宿主，无仲裁 | UNKNOWN；不能平均成0.5 |
| SC-11 | 某组为空或权重和不为1 | INVALID_PLAN，不自动删除组并重算权重 |
| SC-12 | 相同源组被拆入两个主场景 | INVALID_PLAN；可用次级标签，不能双计 |
| SC-13 | 14个来源组、单场景、每组一个单元：12胜2负，双侧α=0.05 | IMPROVED；点值85.7 |
| SC-14 | 14组：11胜3负 | INCONCLUSIVE（双侧k=12；11是单侧旧阈值，不得采用）；`unknownsCouldChangeVerdict=false`；点值78.6 |
| SC-15 | 14组：10胜、1负、3组全部UNKNOWN | INCONCLUSIVE；`unknownsCouldChangeVerdict=true`；point=null，范围[71.4, 92.9] |
| SC-16 | 14组：8胜、2负、4平，无未知 | INCONCLUSIVE；`unknownsCouldChangeVerdict=false`；点值71.4 |
| SC-17 | 14组：1胜、12负、1平 | REGRESSION；点值10.7 |
| SC-18 | 一个来源组含两个单元：一胜一UNKNOWN | 该组 `[0.5, 1]`，记未定，不记确定胜 |
| SC-19 | 数据集有案例未出现在 `source-groups.json` | INVALID_PLAN；不默认一例一组 |

SC-13至SC-19适用 `CHANGE_VS_BASELINE`，判定阈值一律取 §6.5 的双侧表。

数值性质：所有有效分数在[0,100]；交换候选和参考且所有判断对应反转时，两分之和为100；重排记录不改变结果；相同记录重算一致；增加未知不得缩窄缺失范围；重复一条输出不能改变计划权重。

## 8. 资格与结论分离

研究有效性、交付结果、行为效果、正式排名资格与Owner晋级分别报告。确证未交付但对照/行为可观察是有效负结果；无法判断交付则限制归因。交付成功不保证行为改善；高对齐总分也不构成自动授权。

所有问题带code、证据和下一动作；日志/预览安全序列化并限制长度，避免完整私人轨迹进入公共报告。正式报告只引用合法可披露材料，公开结构样例与受控全保真样本分离。
