# PD AA10 覆盖率期望值手算表（PRI-1115 纸面准备）v0.1

**状态：纸面预期，未实现、未验证，也不是接口契约。**

- 规范依据：`docs/specs/PD Adaptive Activation SPEC v0.6.md` §6.1（T/V/O/D 与主指标）、§5.1（四维状态与去重）、§4（失败、延迟与重复）、§5.2（配置身份范围）。
- 代码基线：`origin/main` = `46cbdabc3f46d3a5994ea527b66bd9ab03111f02`（2026-11-04 已 fetch）。
- 前置状态：PRI-1107 尚无 Owner 书面设计批准；PRI-1114 输出契约未明确。因此本表只做纸面推演，**不实现确定性汇总**。
- 所有输入样例均为 **fixture**，不代表真实 Host、真实请求或真实行为。所有期望值都是**手算推导**，不是已验证行为。
- 本表不涉及 §6.2 净收益汇总。净收益需要对照条件与结果向量，不能用手算覆盖率代替，也不能生成综合分值或因果措辞。

## 0. 结论先行

| 类别 | 可否给出确定期望值 | 依据 |
|---|---|---|
| 正常（一次介入、结果明确） | 可确定 | T/V/O/D 四层子集关系与分母非零，四则运算直接可算 |
| 未知（仅 returned、识别未知、时钟不可比） | 只能给"已确认下界 + unknown 计数"，不能给单一真值 | §6.1「未知不算失败也不算成功」；§5.1「缺证继续 unknown」 |
| 分母为零（无机会、V=0、O=0） | 可确定，但必须输出"不适用"，不是 0 | §6.1「分母为零写'不适用'」 |
| T 不可枚举 | 不可确定，只能报 unknown，不能报 0 或 N/A | §6.1「无法估计 T 就报告未知」 |
| 重复（稳定机会键可用） | 可确定：按机会去重，回调数只算运行负载 | §4「按同一真实决策机会去重」；§6.1「全量 hook 数只用于运行负载」 |
| 重复（无稳定机会键） | 不可确定；无法拼接的记录必须单列，不能计多次成功 | §4「保留独立未关联记录」 |
| 延迟（确认晚于关键行动） | 可确定：不进 D，单列 delayed | §6.1 D 定义要求「送达先于关键行动」 |
| 延迟（跨评估窗口 / 顺序不可比） | 部分不可确定；窗口归属与未决保留 SPEC 未定义 | §6.1 只定义固定窗口内去重，未定义跨窗结算 |
| 同文（Native 已含完整目标正文） | 按字面定义可算；但"是否计入 T/D、是否只算新增"存在口径冲突 | §2「复用该份内容」；§6.1「分别报告覆盖和真正新增及时提示」 |
| 部分同文（正文部分重叠） | **SPEC 未定义**，不替规范分类 | §2 只定义「实际内容相同」 |
| 误触发 / 范围外 / 不可干预 | 不进 T，单列 | §6.1「误触发与只在事后识别的事件另列」；T 定义「不可干预和范围外另列」 |

一句话：**能确定的是"集合计数 + 四种空值语义"，不能确定的是"unknown 的展示方式、同文归类、无稳定键去重、跨窗口归属"——这些交给 PRI-1107 裁决。**

## 1. 全局口径（手算前先固定）

### 1.1 分析单位与集合嵌套

分析单位是**场景卡规定的决策机会**，在一个**固定窗口**内按稳定机会身份去重，不按 Hook 调用、记录行或请求计数。

四个集合严格嵌套：`D ⊆ O ⊆ V ⊆ T`。

- T：审阅当时存在可改变的实际决定，且已授权原则在行动前有合理干预可能；不要求后来一定犯错。
- V：T 中在选定 profile 上可取得、且早于关键行动的合格信号。
- O：V 中 PD 确实在行动前识别的机会。
- D：O 中独立确认目标完整正文位于**同一决策的实际模型请求**，且送达先于关键行动的。

单条机会的判定顺序固定为 `去重 → T → V → O → D`；前一层不成立则后一层不成立，unknown 沿链条向下传播。D 还要求 `execution=completed` 且存在独立验证标记与证据引用（§5.1）；`degraded/timeout/failed/unknown` 时不能把本次目标 payload 标成 `returned/confirmed`。

### 1.2 输入字段（示意，全部为 fixture）

| 字段 | 语义 | 是否 fixture |
|---|---|---|
| `opportunityId` | 稳定机会键（Session + 本次验收任务/请求）；不可得时标 `unlinkable` | fixture |
| `signalBeforeAction` | 选定 profile 上存在早于行动的合格信号 | fixture |
| `recognizedBeforeAction` | PD 在行动前识别；三态 `true/false/unknown` | fixture |
| `nativeHasTarget` | 原 Native 最终文本已完整包含目标正文 | fixture |
| `execution` | `completed/degraded/timeout/failed/unknown`；D 只接受 `completed` | fixture |
| `requests[]` | `{requestId, order, hasFullTarget, independentEvidenceRef}`；`order` 用同一受信顺序域 | fixture |
| `firstKeyAction` | `{actionId, order}` | fixture |
| `callbacks[]` | `hookInvocationId` 列表，只用于负载与去重诊断 | fixture |
| `dedupeKeyAvailable` | 能否建立稳定机会身份 | fixture |
| `window` | 固定观察窗口标识 | fixture |
| `configSnapshot` | host/hostVersion/runtimeMode/pluginVersion/effectiveHookSetFingerprint/evidenceCoverage | fixture |

时序只用同一受信顺序域内的 `order` 比较；墙钟相近不构成先后证明。链路两端都可比较时也以 `order` 为准。

### 1.3 输出四态语义（本表最关键的部分）

| 状态 | 含义 | 允许的数值形态 | 禁止的写法 |
|---|---|---|---|
| `exact` 确定值 | 分母 > 0 且成员判定完整 | `0.000` 或 `0.xx` | — |
| `not_applicable` 不适用 | **分母为 0** | 枚举值 `not_applicable` | 禁止写成 `0` 或 `0%` |
| `unknown` 未知 | 分母或成员无法确定 | 枚举值 `unknown` + 已确认计数 | 禁止写成 `0`、`N/A` 或"失败" |
| `lower_bound` 下界 | 分母已知，但存在结果未知的机会 | 数值 + `unknown` 计数 | 禁止把下界说成真值或说成 0% 失败 |

配套的"确定零 / 下界零"区分：

- **确定零**：该层所有成员都已评估，且无一满足 → `0` 是真实计数/比率，例如"确认在关键行动之后才送达"。
- **下界零**：已确认成员为 0，但还有未知成员可能满足 → `0` 只是已确认数，真值可能更高。
- **不适用**：分母本身为 0。
- **未知**：连分母或成员都无法建立。

比率展示的精度（保留几位、用百分比还是小数）**SPEC 未定义**；本表用分数为主、3 位小数为辅，仅为手算核对方便。

## 2. 期望值总表

表中 `N/A` = `not_applicable`；`LB` = `lower_bound`；`UNK` = `unknown`。"SPEC 未定义"列只标出该行不能由规范唯一推出的点。

| ID | 情形 | 输入（fixture 摘要） | 手算链（逐步） | 期望输出 | 是否 SPEC 未定义 |
|---|---|---|---|---|---|
| N-1 | 正常：一次介入、结果明确 | 1 机会；信号早于行动；行动前识别；req-1 order=1 独立确认完整正文；行动 order=2；原生不含同文 | ① 1 回调→1 机会 ② T=1 ③ 入 V ④ 入 O ⑤ 入 D（1<2）⑥ 非同文→新增=1 ⑦ 四比率各 1/1 | 计数 T1 V1 O1 D1；D/T=1.000、V/T=1.000、O/V=1.000、D/O=1.000（exact）；newTimely=1 | 否 |
| N-2 | 正常：混合窗口 | 4 机会：①V/O/D ②V 未识别 ③信号晚于行动 ④V/O 但确认晚于行动 | ① T=4 ② V={①②④}=3 ③ O={①④}=2 ④ D={①}=1；另列 missedSignal=1、notRecognized=1、delayed=1 | T4 V3 O2 D1；D/T=1/4=0.250、V/T=3/4=0.750、O/V=2/3≈0.667、D/O=1/2=0.500；均为 exact | 小数精度未定义 |
| U-1 | 未知：仅 returned | 1 机会；信号+识别成立；payload=returned；无独立请求证据 | ① T=1 ② V=1 ③ O=1 ④ 不入 D（confirmed 未成立）⑤ unknownDelivery=1 | T1 V1 O1 D0；D/T=`LB 0.000` + unknownDelivery=1；V/T=1.000；O/V=1.000；D/O=`LB 0.000` | 未知是否允许显示为下界 0（见冲突 C-2） |
| U-2 | 未知：识别时点不可判定 | 1 机会；信号成立；识别=unknown；无独立确认 | ① T=1 ② V=1 ③ O=UNK（不能当 0）④ D 随 O 未知 ⑤ 已知计数只到 V | T1 V1 O=unknown D=unknown；V/T=1.000；O/V=UNK；D/O=UNK；unknownRecognition=1 | 否（§6.1 要求未知单列） |
| U-3 | 冲突：正文出现但 execution=degraded | 1 机会；信号+识别成立；观察者看到正文在请求内；execution=degraded | ① T=1 V=1 O=1 ② §5.1 要求 confirmed 需 execution=completed ③ 不能升级 confirmed ④ 保留阶段证据、标 disputed，交对账 | T1 V1 O1 D=unknown；D/T=UNK；D/O=UNK；disputed=1；不得记 D=1 或失败 | 否（§5.1 明文冲突处理） |
| Z-1 | 分母零：无任何机会 | 窗口内无进入"完成判断前"的任务；无回调 | ① T=0 ② V=O=D=0（子集为空）③ 四个比率的分母依次为 T、T、V、O，均为 0 | T0 V0 O0 D0；四项比率全部 `N/A`；不是 0.0 | 否 |
| Z-2 | 分母零：T=0 但有误触发 | 2 次标记命中引用的旧文本；无真实机会 | ① 2 次命中→falseTrigger=2，不进 T ② T=0 ③ 比率全部 N/A | T0 V0 O0 D0；falseTrigger=2；hooks=2 仅负载；比率 `N/A` | 否 |
| Z-3 | 分母零：V=0 的嵌套 | 2 机会；信号均在行动后才出现 | ① T=2 ② V=0 ③ V/T=0/2=0 ④ O/V 分母 0 ⑤ D/O 分母 0 | T2 V0 O0 D0；V/T=`exact 0.000`；O/V=`N/A`；D/O=`N/A`；missedSignal=2 | 否 |
| Z-4 | 分母零：O=0 的嵌套 | 2 机会；信号均成立；PD 均未在行动前识别 | ① T=2 V=2 O=0 ② V/T=1.000 ③ O/V=0/2=0 ④ D/O 分母 0 | T2 V2 O0 D0；V/T=1.000；O/V=`exact 0.000`；D/O=`N/A` | 否 |
| Z-5 | 分母未知：T 不可枚举 | 无独立任务/产物清单；只有 PD 自身回执 | ① T=UNK（不是 0）② D/T 不可算 ③ 可另报 D/O 作为交付能力 | T=unknown；D/T=`UNK`；如 O 已知可报 D/O 并标"仅交付能力，非总体覆盖"；禁止 N/A | 否（§6.1 明文） |
| R-1 | 重复：稳定机会键可用 | 同一机会 3 条回调；1 次独立确认；`dedupeKeyAvailable=true` | ① 3 回调→1 机会 ② T=1 ③ V=O=D=1（每机会只计 1 次）④ duplicateRecords=2 ⑤ hooks=3 仅负载 | T1 V1 O1 D1；四比率 1.000；duplicateRecords=2；hooks=3（负载） | 否 |
| R-2 | 重复：无稳定机会键 | 2 条记录疑似同一事件；`unlinkable`；无法独立确认 | ① 不能按文本哈希/时间窗拼接 ② 机会集合 T=0（已关联部分） ③ 2 条单列 unlinkedRecords ④ 不得计 2 次成功 | T0（已关联）；比率 `N/A`；unlinkedRecords=2；D 不增；状态 `unlinked` | 是否把 2 条各算一个 T（见冲突 C-4） |
| R-3 | 重复：重试 + 同请求重复出现 | 同一机会 call-1 failed、call-2 confirmed 且早于行动；req-1 中目标正文出现 2 次 | ① 2 调用→1 机会 ② D 每机会只计 1 ③ 第 2 次正文出现记 duplicateOccurrence=1 ④ executionFailure=1 | T1 V1 O1 D1；比率 1.000；executionFailure=1；duplicateOccurrence=1；hooks=2（负载）；不因重复出现加成 | 否（C03 要求只出现一次） |
| L-1 | 延迟：确认但晚于关键行动 | 1 机会；信号+识别成立；req-1 order=3 确认完整正文；行动 order=2 | ① T=1 V=1 O=1 ② D 要求送达<行动，3>2 不成立 ③ 无未知成员 ④ delayed=1 | T1 V1 O1 D0；D/T=`exact 0.000`（确定零，不是下界）；D/O=0.000；delayed=1 | 否 |
| L-2 | 延迟：确认晚到 / 跨窗口 | 事件顺序可证（req order=1 < action order=2），但独立确认在窗口关闭后才取得；或结果晚于窗口结束 | ① T 归发生机会的窗口 ② 事件顺序成立→D=1 ③ 确认取得时间不影响时序判定 ④ 若窗口关闭时仍 open，则关闭时点只能算未决 | 事件顺序可证：D=1，D/T=1.000，`confirmationLag` 单列；窗口关闭时点：`pending=1`，D 不增 | **SPEC 未定义**：跨窗晚到结果在已关闭窗口中算未决 / 移出分母 / 回填原机会，三者未定 |
| L-3 | 延迟：信号晚于行动 | 1 机会；信号 order=3；行动 order=2；PD 未识别 | ① T=1 ② V 要求信号早于行动，不成立 ③ O=0 ④ D=0 | T1 V0 O0 D0；V/T=`exact 0.000`；O/V=`N/A`；D/O=`N/A`；lateSignal=1 | 否 |
| L-4 | 延迟：时钟/顺序不可比 | 1 机会；请求与行动来自不同时钟域，无可靠顺序 | ① T=1 V=1 O=1 ② 无法证明送达<行动 ③ D=UNK ④ 不得记成功或失败 | T1 V1 O1 D=unknown；D/T=`UNK`；D/O=`UNK`；timelinessUnknown=1 | 否（§6.1 允许未知） |
| S-1 | 同文：Native 已含完整正文且已识别 | 1 机会；原生最终文本完整含目标；信号+识别成立；确认在请求内且早于行动 | ① T=1 V=1 O=1 ② 正文确实在请求且早于行动→按字面 D=1 ③ sameText=1 ④ newTimely=0 | T1 V1 O1 D1；D/T=1.000；sameText=1；newTimely=0；新增及时=`0/1` | **是否计入 T/D 存在冲突**（见 C-1） |
| S-2 | 同文：Native 已含正文但 PD 未识别 | 1 机会；原生已含完整正文；信号成立；PD 未在行动前识别 | ① T=1（字面读法） ② V=1 ③ O=0 ④ D 随 O 为 0 ⑤ sameText=1 | T1 V1 O0 D0；V/T=1.000；O/V=`exact 0.000`；D/O=`N/A`；sameText=1 | **T 是否应为 0 存在冲突**（见 C-1b） |
| S-3 | 同文：正文部分重叠 | 目标正文约 70% 已出现在 Native；其余为新增 | ① 不满足"实际内容相同" ② `sameText` 与 `newTimely` 均无法唯一归类 ③ 不替规范决定 | 标 `partialOverlap=1`；sameText/newTimely=`UNK`；汇总完整性 `incomplete` | **SPEC 未定义**（只定义完整相同） |
| X-1 | 误触发 / 范围外 | 1 次标记来自引用旧文本；另 1 个交付物不属呈现验收 | ① 两者都不进 T ② 若发生投递，记 falseTriggerDelivery / outOfScope ③ 不进入任何分母 | 若真实 T=0：比率 `N/A`，falseTriggerDelivery=1、outOfScope=1；若真实 T=1：D/T 只用真实机会算 | 否 |
| P-1 | 采样：T 来自抽样 | 40 个交付任务抽 10 个；样本内 T=6、V=5、O=4、D=3 | ① 只在样本内计数 ② D/T=3/6 ③ V/T=5/6 ④ O/V=4/5 ⑤ D/O=3/4 ⑥ 不外推总体 | D/T=0.500、V/T≈0.833、O/V=0.800、D/O=0.750；标"样本覆盖率"；总体 T=UNK | 采样口径本身已定义（§6.1）；"完整审计能否改称总体覆盖"见 C-6 |

## 3. 逐场景手算明细

### N-1 正常：一次介入、结果明确

**输入（fixture）**

- `opportunityId=opp-n1`，`window=W1`
- `signalBeforeAction=true`
- `recognizedBeforeAction=true`
- `nativeHasTarget=false`
- `requests=[{requestId=req-1, order=1, hasFullTarget=true, independentEvidenceRef=obs-1}]`
- `firstKeyAction={actionId=act-1, order=2}`
- `callbacks=[hook-a]`，`dedupeKeyAvailable=true`

**手算**

1. 去重：1 条回调 + 稳定机会键 → 1 个机会。
2. T：存在真实完成判断机会，且授权原则可在行动前干预 → `opp-n1 ∈ T`，`T=1`。
3. V：`signalBeforeAction=true` → 入 V，`V=1`。
4. O：`recognizedBeforeAction=true` → 入 O，`O=1`。
5. D：`execution=completed`；`obs-1` 独立确认 `req-1` 含完整目标正文；`order(req-1)=1 < order(act-1)=2` → 入 D，`D=1`。
6. `nativeHasTarget=false` → `newTimely=1`，`sameText=0`。
7. 比率：`D/T=1/1=1.000`；`V/T=1.000`；`O/V=1.000`；`D/O=1.000`。

**期望输出**

- 计数：`T=1, V=1, O=1, D=1`。
- 比率：四项均 `exact 1.000`。
- 分项：`sameText=0, newTimely=1, returnedOnly=0, delayed=0, unknownDelivery=0, falseTrigger=0, unlinkedRecords=0`。
- 完整性：`complete`；既不是下界也不是不适用。

**边界**

- 若 `obs-1` 实际只是回调返回而非独立请求证据，则退化为 U-1，不能保留 D=1。
- 若 `order` 来自不同时钟域，则退化为 L-4。

### N-2 正常：混合窗口

**输入（fixture）**

| 机会 | 信号早于行动 | 行动前识别 | 独立确认且早于行动 | 备注 |
|---|---|---|---|---|
| opp-a | 是 | 是 | 是 | 原生不含同文 |
| opp-b | 是 | 否 | — | PD 未触发 |
| opp-c | 否（信号晚于行动） | 否 | — | 漏信号 |
| opp-d | 是 | 是 | 否（确认晚于行动） | 延迟 |

**手算**

1. `T = {a,b,c,d} = 4`。
2. `V = {a,b,d} = 3`（c 的合格信号不早于行动，不入 V）。
3. `O = {a,d} = 2`（b 未识别）。
4. `D = {a} = 1`（d 确认晚于行动）。
5. 比率：`D/T=1/4=0.250`；`V/T=3/4=0.750`；`O/V=2/3≈0.667`；`D/O=1/2=0.500`。
6. 分项：`missedSignal=1`（c）、`notRecognized=1`（b）、`delayed=1`（d）、`newTimely=1`（a）。

**期望输出**：`T4 V3 O2 D1`；四个比率如上手算；全部 `exact`；完整性 `complete`。

**边界**：如果审阅样本不完整，则只能按 P-1 报样本覆盖率。

### U-1 未知：仅 returned

**输入（fixture）**：1 机会；信号与识别均成立；`execution=completed`；`payload=returned`；`independentEvidenceRef=null`；请求与行动顺序在回调层面不可证。

**手算**

1. `T=1`，入 V，入 O。
2. D 需要独立确认完整正文 + 同一请求 + 早于行动。`returned` 只证明返回 callback，不证明进入请求 → 不入 D。
3. 该机会的 D 归属是 unknown，不是 false；因此 `D=0` 是**下界零**。
4. `D/T = LB 0.000`；`D/O = LB 0.000`；`unknownDelivery=1`。
5. `V/T=1.000`、`O/V=1.000` 不受影响。

**期望输出**

- `T1 V1 O1 D0`。
- `D/T = { value: 0.000, state: lower_bound, unknown: 1 }`。
- `D/O = { value: 0.000, state: lower_bound, unknown: 1 }`。
- `returnedOnly=1`、`unknownDelivery=1`。
- **禁止**输出"及时送达 0%"或"失败 1 次"。

**边界**：如果后续对账取得独立请求证据且顺序成立，D 可升级为 1；升级必须绑定同一调用、请求、正文和配置身份（§5.1）。

### U-2 未知：识别时点不可判定

**输入（fixture）**：1 机会；信号成立；`recognizedBeforeAction=unknown`；无独立确认。

**手算**

1. `T=1`，入 V。
2. O 的成员关系未知 → O 不能按 0 处理，也不能按 1 处理。
3. 因 `D ⊆ O`，D 同为未知。
4. 已知计数只能到 V：`T=1, V=1`。

**期望输出**：`T1 V1 O=unknown D=unknown`；`V/T=1.000`；`O/V=unknown`；`D/O=unknown`；`unknownRecognition=1`。

**边界**：未知沿链条向下传播；不能把 `O=unknown` 显示成 `O=0`，否则 `O/V` 会被误报为 0。

### U-3 冲突：正文出现但 `execution=degraded`

**输入（fixture）**：1 机会；信号与识别成立；受控观察者在请求边界看到目标正文；`execution=degraded`；`payload` 未能合法升级为 `confirmed`。

**手算**

1. `T=1`，入 V，入 O。
2. §5.1 规定 `confirmed` 必须同时具备 `execution=completed` 与独立验证标记、证据引用。
3. `execution=degraded` → 本次目标 payload 不能标 `returned/confirmed`，即使观察者看到了正文。
4. 保留阶段证据并标 `disputed`，交对账；D 归属 unknown。
5. `D/T=unknown`、`D/O=unknown`；不能记 D=1，也不能记"失败"。

**期望输出**：`T1 V1 O1 D=unknown`；`D/T=UNK`；`D/O=UNK`；`disputed=1`。

**边界**：如果对账证明 `execution` 实际为 `completed`，且顺序与正文都成立，才能升级；升级不得覆盖原冲突事实（§5.1）。

### Z-1 分母零：无任何机会

**输入（fixture）**：`window=W1`；窗口内没有进入"首次完成判断前"的任务；无回调、无标记。

**手算**

1. `T=0`（不是未知：窗口与任务清单完整，确实没有机会）。
2. 子集 `V=O=D=0`。
3. `D/T` 分母 0 → `N/A`；`V/T` 分母 0 → `N/A`；`O/V` 分母 0 → `N/A`；`D/O` 分母 0 → `N/A`。

**期望输出**：计数全 0；四项比率 `not_applicable`；完整性 `complete`；`noOpportunity=1`。

**边界**：`T=0` 与 `T=unknown` 必须区分。前者是"确定没有机会"，后者是"无法判断有没有机会"。

### Z-2 分母零：T=0 但有误触发

**输入（fixture）**：2 次标记命中来自引用旧文本；无真实决策机会。

**手算**

1. 误触发不进 T；`falseTrigger=2`。
2. `T=0`，比率全部 `N/A`。
3. Hook 次数 2 只作为运行负载，不能改写覆盖率。

**期望输出**：`T0 V0 O0 D0`；`falseTrigger=2`；`hooks=2`（负载）；比率 `N/A`。

**边界**：如果误触发同时发生了一次投递，记 `falseTriggerDelivery`，仍不进 D。

### Z-3 / Z-4 分母零的嵌套

**Z-3（V=0）**

- 输入：2 机会，信号均在行动之后才出现。
- 手算：`T=2`；`V=0`；`V/T=0/2=0.000`（确定零）；`O/V` 分母 0 → `N/A`；`D/O` 分母 0 → `N/A`。
- 输出：`T2 V0 O0 D0`；`V/T=exact 0.000`；`O/V=N/A`；`D/O=N/A`。

**Z-4（O=0）**

- 输入：2 机会，信号成立，PD 均未在行动前识别。
- 手算：`T=2`；`V=2`；`O=0`；`V/T=1.000`；`O/V=0/2=0.000`（确定零）；`D/O` 分母 0 → `N/A`。
- 输出：`T2 V2 O0 D0`；`V/T=1.000`；`O/V=exact 0.000`；`D/O=N/A`。

**关键区分**：`V/T=0` 与 `O/V=N/A` 是两种不同事实；不能因为下游为 0 就把上游比率也写成 0。

### Z-5 分母未知：T 不可枚举

**输入（fixture）**：只有 PD 自身回执；没有独立任务/产物清单；无法复核全部验收交付。

**手算**

1. T 无法枚举 → `T=unknown`，不是 0。
2. `D/T` 不可算 → `unknown`；不能报 `N/A`（那表示"确实没有机会"），也不能报 0%。
3. 如果 O 已知，可报 `D/O`，但必须标注"仅交付能力，不是总体覆盖率"。

**期望输出**：`T=unknown`；`D/T=unknown`；`O` 与 `D/O` 视证据单列；`completeness=unknown`。

**边界**：§6.1 明文禁止把 `D/O` 改名为总体覆盖率。

### R-1 重复：稳定机会键可用

**输入（fixture）**

- 同一机会 `opp-dup` 有 3 条回调：`hook-a, hook-b, hook-c`。
- `dedupeKeyAvailable=true`。
- 1 次独立确认，请求早于行动。

**手算**

1. 稳定键可用 → 3 条记录去重为 1 个机会。
2. `T=1`；入 V；入 O；入 D。
3. D 每个机会最多计 1 次成功，不因 3 条回调变成 3。
4. `duplicateRecords=2`；`hooks=3` 只记运行负载。

**期望输出**：`T1 V1 O1 D1`；四比率 1.000；`duplicateRecords=2`；`hooks=3`（负载）。

**边界**：如果 3 条回调实际跨两个 Session 且无法证明是同一请求，按 R-2 处理，不能强行合并。

### R-2 重复：无稳定机会键

**输入（fixture）**：2 条记录疑似同一事件；`unlinkable`；无独立请求证据；同一 Session 内发生。

**手算**

1. 规范禁止用文本哈希或时间窗补造机会身份（§4 与 G0 设计）。
2. 不能证明是同一机会 → 不做合并；2 条全列 `unlinkedRecords`。
3. 已关联机会集合 `T=0` → 比率 `N/A`，但必须同时标 `unlinkable`，避免被读成"确实没有机会"。
4. 不得把 2 条各计一次成功，也不得计 2 次 T。

**期望输出**：`T0`（已关联集合）；比率 `N/A`；`unlinkedRecords=2`；`D` 不增；状态 `unlinked`；`completeness=unknown`。

**边界**：这是明显的口径冲突点（C-4），不是本表能单方面决定的。

### R-3 重复：重试 + 同请求重复出现

**输入（fixture）**：同一机会；`call-1 execution=failed`；`call-2 execution=completed`，独立确认完整正文且早于行动；`req-1` 中目标正文出现 2 次。

**手算**

1. 2 次调用 → 1 个机会（同一机会键）。
2. D 按机会计 1 次，不按调用计 2 次。
3. `executionFailure=1` 单独保留，不能掩盖后续成功，也不能把失败算成未送达。
4. 同请求正文出现 2 次 → `duplicateOccurrence=1`，按 C03"只出现一次"记为装配/质量异常；不加成 D。

**期望输出**：`T1 V1 O1 D1`；四比率 1.000；`executionFailure=1`；`duplicateOccurrence=1`；`hooks=2`（负载）。

### L-1 延迟：确认但晚于关键行动

**输入（fixture）**：1 机会；`execution=completed`；信号与识别成立；`req-1 order=3` 独立确认完整正文；`act-1 order=2`。

**手算**

1. `T=1`，入 V，入 O。
2. D 要求 `order(delivery) < order(action)`；`3 > 2` 不成立 → 不入 D。
3. 该机会的时序已确定（顺序域可证），不是未知 → `D=0` 是**确定零**，不是下界。
4. `delayed=1`。

**期望输出**：`T1 V1 O1 D0`；`D/T=exact 0.000`；`D/O=exact 0.000`；`delayed=1`；无 unknown 计数。

**边界**：如果顺序不可比，退化为 L-4（unknown），不能保留确定零。

### L-2 延迟：确认晚到或跨窗口

**输入（fixture）**

- 变体 a：事件顺序可证（`req order=1 < action order=2`），独立确认在窗口关闭后才取得。
- 变体 b：事件发生在 W1，结果在 W2 才到达，W1 关闭时记录仍 `open`。

**手算**

- 变体 a：及时性由**事件顺序**判定，不由确认取得时间判定 → 顺序成立则 `D=1`；`confirmationLag` 单列，只影响数据完整性，不影响 D。
- 变体 b：W1 关闭时没有终态 → `pending=1`，D 不增；不能算成功，也不能算失败。
- 归属：机会的 `t_change` 在 W1，原则上归 W1；但"跨窗结果是否回填 W1、关闭时点是否保留未决、是否移出分母"规范未定义。

**期望输出**

- 变体 a：`D=1`，`D/T=1.000`，`confirmationLag` 单列。
- 变体 b：`T1 V? O? D=unknown`、`pending=1`；窗口关闭时点的比率只能是**临时下界**。

**边界**：**SPEC 未定义**跨窗结算；不要在本表替规范选择一种。

### L-3 延迟：信号晚于行动

**输入（fixture）**：1 机会；`signal order=3`；`action order=2`；PD 未识别。

**手算**

1. `T=1`（机会存在）。
2. V 要求信号早于行动；信号晚于行动 → 不入 V，`V=0`。
3. `O=0`、`D=0`。
4. `V/T=0/1=0.000`（确定零）；`O/V` 分母 0 → `N/A`；`D/O` 分母 0 → `N/A`。
5. `lateSignal=1`，按 §2"信号过晚保留为遗漏"。

**期望输出**：`T1 V0 O0 D0`；`V/T=0.000`；`O/V=N/A`；`D/O=N/A`；`lateSignal=1`。

### L-4 延迟：时钟/顺序不可比

**输入（fixture）**：1 机会；请求与行动来自不同时钟域；无同一受信顺序；无可靠因果顺序。

**手算**

1. `T=1`，入 V，入 O。
2. D 需要证明送达先于行动；无法证明 → D 归属 unknown。
3. 未知不算成功也不算失败 → `D/T=unknown`，不是 0。

**期望输出**：`T1 V1 O1 D=unknown`；`D/T=unknown`；`D/O=unknown`；`timelinessUnknown=1`。

**边界**：不能因"墙钟相近"补出顺序（§4）。

### S-1 同文：Native 已含完整正文且已识别

**输入（fixture）**：1 机会；`nativeHasTarget=true`；信号成立；行动前识别；请求中确认完整正文；请求早于行动。

**手算（按 D 的字面定义）**

1. `T=1`；入 V；入 O。
2. D 的字面条件只要求"独立确认目标文本位于同一请求且送达先于行动"，不要求该文本由 PD 新增 → `D=1`。
3. `sameText=1`；`newTimely = D && !sameText = 0`。
4. `D/T=1.000`；"真正新增及时提示" = `0/1 = 0.000`。

**期望输出**：`T1 V1 O1 D1`；`D/T=1.000`；`sameText=1`；`newTimely=0`；新增及时=`0/1`。

**边界**：这是 §6.1 最后一句要求"分别报告"的直接后果；它不能支撑"增量内容效果"（§2）。是否把同文计入 D 本身有冲突（C-1）。

### S-2 同文：Native 已含正文但 PD 未识别

**输入（fixture）**：1 机会；`nativeHasTarget=true`；信号成立；`recognizedBeforeAction=false`。

**手算（按字面读法）**

1. `T=1`（机会存在，原则在行动前有合理干预可能）。
2. `V=1`（合格信号可取得且早于行动）。
3. `O=0`（PD 未识别）；因 `D ⊆ O`，`D=0`。
4. `V/T=1.000`；`O/V=0/1=0.000`；`D/O=N/A`。
5. `sameText=1`；`newTimely=0`。

**期望输出**：`T1 V1 O0 D0`；`V/T=1.000`；`O/V=0.000`；`D/O=N/A`；`sameText=1`。

**边界**：另一种合理读法是"内容本来就在，PD 没有可新增的东西，因此不构成 T" → `T=0`，比率全部 `N/A`。这是冲突 C-1b。

### S-3 同文：正文部分重叠

**输入（fixture）**：目标正文约 70% 已出现在 Native 最终文本；其余为新增内容。

**手算**

1. §2 只定义"目标原本已在本次 Native 最终文本中"→"实际内容相同"。
2. 70% 重叠既不是完整同文，也不能直接当全新内容。
3. 本表不替规范分类：`sameText=unknown`、`newTimely=unknown`；标 `partialOverlap=1`。
4. 汇总完整性置 `incomplete`，等待裁决。

**期望输出**：`partialOverlap=1`；`sameText=unknown`；`newTimely=unknown`；不允许擅自把新增及时计为 1 或 0。

**边界**：**SPEC 未定义**部分同文。

### X-1 误触发 / 范围外

**输入（fixture）**：一次标记命中引用旧文本；一次交付物不属于"呈现验收"。

**手算**

1. 两者都不满足 T 的场景/前置事实 → 不进 T。
2. 若发生投递，分别记 `falseTriggerDelivery`、`outOfScope`；不进入任何分母。
3. 如果窗口内真实 T=0 → 比率 `N/A`，不是 0%；如果真实 T=1 → 只用真实机会计算。

**期望输出**：`T` 只含真实机会；`falseTriggerDelivery`、`outOfScope` 分项单列；比率不受污染。

### P-1 采样：T 来自抽样

**输入（fixture）**：40 个交付任务抽 10 个；样本内 `T=6, V=5, O=4, D=3`。

**手算**

1. 只在样本内计数：`D/T=3/6=0.500`。
2. `V/T=5/6≈0.833`；`O/V=4/5=0.800`；`D/O=3/4=0.750`。
3. 样本外的 T 未知 → 总体 `T=unknown`；不能外推。
4. 必须说明抽样方式与漏检限制（§6.1）。

**期望输出**：样本四比率如上手算；`completeness=sample`；`populationT=unknown`；报告标题含"样本覆盖率"。

**边界**：若窗口内是**完整审计**而非抽样，能否改称该窗口的总体覆盖率，见 C-6。

## 4. 口径冲突清单（交 PRI-1107 裁决）

以下每一条都是"两种合理读法给出不同数字"，本表不替规范选择基线以外的结论。基线列只表示本表按字面定义的算法，不代表已被批准。

| ID | 冲突点 | 读法 A | 读法 B | 数值差异示例 |
|---|---|---|---|---|
| C-1 | 同文是否计入 T/D | 字面定义：机会成立，正文在请求内且早于行动 → `T=1, D=1, D/T=1.000`，另报 `newTimely=0` | 只算增量：同文不算 D（甚至不算 T） → `T=1,D=0,D/T=0.000` 或 `T=0,N/A` | 1.000 / 0.000 / N/A 三种结果 |
| C-1b | 同文但 PD 未识别时 T 是否存在 | T=1：机会与干预可能都存在，只是 PD 没识别 | T=0：Native 已含内容，没有可新增的干预 | 分母 1 → V/T=1.000、O/V=0.000；分母 0 → 全 N/A |
| C-2 | unknown 的展示 | §6.1：用已确认数作下界 → `D/T=LB 0.000 + unknown=1` | 只要存在未知就不给比值 → `D/T=unknown` | 0.000（带下界标签） vs unknown；外部读者极易把前者读成失败 |
| C-3 | O 未知时是否按 0 处理 | 三态：`O=unknown`，`O/V`、`D/O` 均为 unknown | 二元化：`O=0`，`O/V=0.000`、`D/O=N/A` | unknown vs 0.000；会把"没证据"误报成"没识别" |
| C-4 | 无稳定机会键的重复记录 | 每条记录各算一个 T：`T=2, D=0, D/T=0.000` | 不拼接，单列 unlinked：`T=0（已关联）, N/A, unlinked=2` | 0.000 vs N/A；两者都不等于真实总体 |
| C-5 | 一次请求服务两个决策机会 | 按机会计：`D=2` | 按送达计：`D=1`（第二次不算独立送达） | D/T 差 1 个计数 |
| C-6 | 抽样 vs 完整审计 | 抽样：只能报"样本覆盖率" | 完整审计：可报该窗口总体覆盖率 | 标签不同；若误标，会把样本值外推为总体值 |
| C-7 | 跨窗/未决结果归属 | 保留在原机会窗口，D=unknown，分母不变 | 移出已关闭分母，只报未决集合 | 分母 n vs n−k；D/T 会变大 |
| C-8 | 部分同文（正文部分重叠） | 视为新增内容：`newTimely=1` | 视为同文：`newTimely=0` | 新增及时 1 vs 0 |
| C-9 | 误触发中发生的投递是否算 D | 不算：不在 T/O，D=0，另列误触发 | 字面"正文在请求内"：可能被算作一次送达 | D 差 1；但后者会把误触发洗成成功 |
| C-10 | 同一 `hookInvocationId` 出现重复行 | 按调用：1 次调用，重复行只诊断 | 按行：2 条记录，可能被算成 2 次 | 覆盖率通常不变，但 Hook 负载与去重诊断不同 |
| C-11 | 比率数字精度/展示 | 精确分数 + 固定小数位 | 百分比 + 四舍五入 | `2/3` 显示为 0.667 或 66.7% 或 67%；SPEC 未定义 |

## 5. 何时不能汇总

这里的"不能汇总"指：不能把该窗口或该批记录压成一个看似确定的覆盖率数字。输出仍可给出计数与分项，但必须带状态。

| 条件 | 应当返回 | 禁止 |
|---|---|---|
| `T=0`（确定无机会） | 计数全 0；四项比率 `not_applicable`；`noOpportunity` | 输出 `0.000`、`0%`、或"覆盖率为零" |
| `T=unknown`（无法枚举） | `T=unknown`；`D/T=unknown`；如有 O 已知可单列 `D/O` | 输出 `N/A`（会被读成"确实无机会"）；把 D/O 改名为总体覆盖率 |
| `T>0, V=0` | `V/T=exact 0.000`；`O/V=N/A`；`D/O=N/A`；`missedSignal` 计数 | 因下游为空而把 V/T 也写成 N/A |
| `T>0, V>0, O=0` | `O/V=exact 0.000`；`D/O=N/A` | 把 O/V 写成 N/A 或 0% 失败 |
| `O=unknown` | `O/V=unknown`；`D/O=unknown`；只报已知的 T/V | 把 O 当作 0；用自述补齐 |
| 部分 D 未知 | `D/T=lower_bound + value + unknown=n`；`unknownDelivery` 单列 | 把下界说成真值；把未知算作失败或成功 |
| 全部 D 未知但 T/O 已知 | `D/T=lower_bound 0.000 + unknown=n`；明确不是"零送达" | 输出 0% 结论 |
| 存在 unlinked 记录 | 已关联集合单独汇；`unlinkedRecords=n`；`completeness=unknown` | 把 unlinked 记录计成机会或成功 |
| 窗口关闭时仍有 open | 该机会 D=unknown；`pending=n`；比率为临时下界 | 把未决算成功或失败；静默丢弃 |
| 同一批记录跨配置身份 | 按 `configSnapshot` 分组分别汇；旧证据只支持原范围 | 跨 hostVersion/pluginVersion/指纹合并分母（§5.2） |
| 时钟/顺序不可比 | `D/T=unknown`；`timelinessUnknown=n` | 用墙钟相近补出"及时"（§4） |
| 同文 | 覆盖率与"真正新增及时提示"分开报 | 合成一个"有效覆盖率"；把同文算作增量效果 |
| 部分同文 | `partialOverlap=n`；汇总完整性 `incomplete` | 擅自归入同文或新增 |
| T 来自抽样 | 标"样本覆盖率"+ 抽样方式 + 漏检限制；总体 T=unknown | 外推为总体覆盖率 |

补充：**严重伤害不能被平均收益抵销**（§1 设计原则）；覆盖率再高，也不能用单一比率掩盖误触发、重复注入、阻塞或泄露。覆盖率与净收益必须分表报告。

## 6. 需要 PRI-1107 / PRI-1114 裁决的问题

以下问题不是本表能决定的，按最小可裁决粒度列出。

### 6.1 交 PRI-1107（设计权威）

| 编号 | 问题 | 可选项 | 影响 |
|---|---|---|---|
| Q1 | 同文是否计入 T / D | A 计入覆盖、另报新增；B 只算增量；C 不计 T | D/T 可能为 1.000 / 0.000 / N/A |
| Q2 | unknown 展示方式 | A 下界 + unknown 计数；B 直接 unknown | 外部可读性与误报风险 |
| Q3 | T 无法枚举时的输出 | A 只报 unknown，不出比率；B 报 D/O 并明确标注 | 是否会被误读为总体覆盖 |
| Q4 | 无稳定机会键的重复 | A 每条算 T；B 全部 unlinked、已关联集合 N/A；C 暂不汇总 | 分母与成功计数 |
| Q5 | 一次请求服务多个机会 | A 按机会各计 D；B 一次送达只计一次 | D 计数 |
| Q6 | 跨窗/未决结果 | A 保留原窗口、D unknown；B 移出分母；C 另设未决集合 | 分母与比率 |
| Q7 | 部分同文归类 | A 新增；B 同文；C 保持未分类 | newTimely 与同文统计 |
| Q8 | 完整审计能否称总体覆盖 | A 可以（窗口即总体）；B 仍标"窗口内完整样本" | 结论边界 |
| Q9 | 比率展示精度与空值渲染 | A 分数 + 固定小数；B 百分比；空值统一枚举 | 输出一致性（PRI-1114 契约） |

### 6.2 交 PRI-1114（输出契约）

需要读模型至少提供，才能确定性计算本表：

1. 稳定机会身份与窗口归属；不可得时显式 `unlinkable`，不能由文本哈希/时间窗补造。
2. 每个机会的 T/V 前置事实（场景前置、信号可得性）与三态 `recognizedBeforeAction`。
3. 同一受信顺序域内的 `request order` 与 `firstKeyAction order`；无法比较时显式 unknown。
4. 独立确认引用；`returned` 与 `confirmed` 不混用（§5.1）。
5. `nativeHasTarget` 的完整/部分/未知三态，以及同文判定依据。
6. 强关联/弱关联/unlinked 标记；请求一对多时只取行动前与该机会相关的请求。
7. `configSnapshot`，用于阻止跨配置合并。
8. 重复、失败、误触发、范围外、不可干预、信号过晚的计数或原始记录。
9. open/closed/reconciled 状态与未决计数。

在这些字段未定时，本表只能作为**手算核对基准**，不能变成运行时契约。

## 7. 自洽性检查（供后续实现当不变量）

任何实现都应满足：

1. `D ≤ O ≤ V ≤ T`，计数恒为整数或 `unknown`。
2. 比率 ∈ [0,1]，或为 `N/A` / `unknown`；不得出现负数或 >1。
3. `T=0` → 四项比率全部 `N/A`，计数为 0。
4. `V=0` 且 `T>0` → `V/T=0.000`，`O/V=N/A`，`D/O=N/A`。
5. `O=0` 且 `V>0` → `O/V=0.000`，`D/O=N/A`。
6. 任何 unknown 不得被强制转成 0 或 1。
7. `sameText` 与 `newTimely` 分开报；`newTimely` 不得包含同文。
8. `hooks` / `records` / `duplicateRecords` 不进入任何覆盖率分母。
9. 误触发、范围外、不可干预、信号过晚、unlinked 都有独立计数字段。
10. 跨 `configSnapshot` 不合并。

## 8. 本轮明确未做

- 未实现确定性汇总代码；未新增类型、CLI、存储、服务或开关。
- 未修改生产代码、未开 PR、未部署、未安装、未做真实模型/宿主调用。
- 未验证任何真实 Host 请求、真实原则正文或真实行为；全部输入为 fixture。
- 未决定任何口径冲突；冲突留给 PRI-1107（设计）与 PRI-1114（输出契约）裁决。
- 未计算 §6.2 净收益或综合分值；本轮只做 T/V/O/D 覆盖率纸面期望。
