# PRI-1115 AA 证据汇总 — Owner 简报

生成时间：2026-11-06T16:14:23.538Z　口径：observed_records_only_no_population_denominator

## 一句话结论

本次输入包含 2 条运行记录（aa-run-20261106T1105Z、aa-run-20261106T1258Z）；原判定失败 2 条（aa-run-20261106T1105Z、aa-run-20261106T1258Z）；受控准入被消费 1 条（aa-run-20261106T1258Z）；目标正文到达端点 1 条（aa-run-20261106T1258Z）；原判定失败只表示该次实验门禁未通过，不表示受控接线事实不存在；离线复核通过 1 条（aa-run-20261106T1258Z），仅为派生结果，不改原判定，也不等于原实验成功；对照未执行；因此收益、损害与因果改善不评价；任何关联或离线通过都不能证明 request 级送达、timely、行为收益或总体覆盖率。

## 证据层级（互不替代）

- 原始运行判定：run-record 的 positiveGate / controlGate，保留原值，不被事后复核改写。
- 受控接线事实：同一 run-record 内的门禁检查；与原始判定分开陈述，原判定失败不等于这些事实不存在。
- 端点观察：本地假端点的 userMessageSha256 与冻结输入比较；差异是限制，不单独决定 D。
- 事后复核：offline-reevaluation，派生结果；不改原判定，也不等于原实验成功。
- 独立观察：只有输入显式提供时才陈述；未提供保持 unknown。

## 已观察事实

- 运行数：2（aa-run-20261106T1105Z、aa-run-20261106T1258Z）；运行证据状态：recorded。
- 原判定：失败 2 条（aa-run-20261106T1105Z、aa-run-20261106T1258Z）；通过 0 条（无）；未知 0 条。
- 受控接线整体证明：0 条；对照执行 0 条。
- 受控准入被消费：aa-run-20261106T1258Z；目标正文到达端点：aa-run-20261106T1258Z。
- 调用数：2（linkage 窗口内，调用不等于决策机会）。
- 决策机会：unknown — 没有任务机会普查，不能把调用或运行当分母（未链接调用 2 条）。
- 实验级强关联：aa-run-20261106T1258Z；弱候选（不作为实验级强关联）：aa-run-20261106T1105Z。

### aa-run-20261106T1105Z

- 原始运行判定：失败（identity、tool-surface）
- 受控接线事实：admissionConsumed=unknown，targetBody=unknown；整体受控接线门禁：未证明（deliveryPath=unknown）
- 端点观察：用户正文摘要与冻结输入=different（endpoint=ccbcc71e9a62，frozen=813856594fed）
- 事后复核：缺失
- 运行内关联：弱候选（basis=action_timestamp_proximity，deltaMs=22；实验级强关联=否；不升级为 matched_by_run；linkage 自身 association=strong_run）
- 本次运行成本：{"hostTurns":1,"httpRequests":2,"toolCalls":1,"paidCalls":0}；证据 sha256=0ad44b19bd7a

### aa-run-20261106T1258Z

- 原始运行判定：失败（tool-invocation、admission-identity）
- 受控接线事实：admissionConsumed=confirmed，targetBody=confirmed；整体受控接线门禁：未证明（deliveryPath=controlled）；原判定失败不表示受控接线事实不存在
- 端点观察：用户正文摘要与冻结输入=different（endpoint=77f64517a091，frozen=458dac4f7d14）
- 事后复核：存在（correctedGate=true，仅作派生结果，不改原判定）；复核器修正了原判定中的 2 个门禁缺陷，不改变实验结论
- 运行内关联：strong（basis=hook_invocation_id；实验级强关联=是；linkage 自身 association=strong_run）
- 本次运行成本：{"hostTurns":1,"httpRequests":2,"toolCalls":1,"paidCalls":0}；证据 sha256=9b339ff239c2

## 覆盖口径（T/V/O/D，SPEC v0.6 §6.1）

- T（理论决策机会）: unknown（未知）（confirmed=0，unknown=0）
- V（事前可见的合格信号）: unknown（未知）（confirmed=0，unknown=0）
- O（PD 在行动前实际识别）: unknown（未知）（confirmed=0，unknown=0）
- D（独立确认目标正文进入实际请求且早于关键行动）: unknown（未知）（confirmed=0，unknown=0）
- 定义：T=theoretical decision opportunity: a real decision that could be changed, an authorized principle, and a plausible pre-action intervention window; requires a declared opportunity census；V=eligible signal visible before the action on the selected profile; visibility is not delivery；O=PD actually recognized the opportunity before the key action; recognition is not Agent adherence；D=independent confirmation that the exact target body entered the same decision's actual request and preceded the key action。
- 口径：V 不等于送达；O 不等于 Agent 遵循；缺证据保持 unknown，不用 strong_run、端点送达或离线通过替代。
- D/T：unknown（value=unknown）
- 链接子集 D/T：not_applicable（链接子集无分母，不等于总体确定为零）
- 收益：not_evaluated；损害：not_evaluated
- 已记录调用/运行不是覆盖率分母；离线复核通过（若存在）只作派生结果，不等于原实验成功。

## 成本

- 累计账本：caps={"hostTurns":4,"httpRequests":5,"toolCalls":2,"paidCalls":0}，used={"hostTurns":3,"httpRequests":4,"toolCalls":2,"paidCalls":0}，remaining={"hostTurns":1,"httpRequests":1,"toolCalls":0,"paidCalls":0}。
- 单次运行成本取 run-record.attempt.used；历史工具调用与历史 HTTP 不重复计入当前运行。

## 来源与哈希

- linkage: linkage-1105.json sha256=122f3b8bb042
- linkage: linkage-1258.json sha256=18159a3c109d
- budget: experiment-budget.json sha256=e2b948dcccdf
- run-record: run-record.json sha256=0ad44b19bd7a run=aa-run-20261106T1105Z
- run-record: run-record.json sha256=9b339ff239c2 run=aa-run-20261106T1258Z
- offline-reevaluation: offline-reevaluation.json sha256=5b7ade6c7ba5 run=aa-run-20261106T1258Z
- run-plan: plan.json sha256=b209307c9329 run=aa-run-20261106T1105Z
- run-plan: plan.json sha256=0f3a0c3b947d run=aa-run-20261106T1258Z
- pollution-audit: pollution-exclusion-2026-11-06-v4.json sha256=604453fea3a5

## 未知

- 没有任务机会普查，因此 T 与总体比例均为 unknown。
- 没有独立固定的 request 与 action 证据，因此即使 association=strong_run，D 仍为 unknown。
- 端点用户正文摘要与冻结输入不同；该限制保留，不据此判定 D。
- 已提供的记录中没有执行对照，因此收益、损害与因果改善均未评价。
- 假 provider 指定工具，不代表 Agent 自主遵循原则。

## 下一步决定（Owner）

1. 决定是否在剩余预算内执行未动的对照臂（剩余 1 次宿主回合 / 1 次 HTTP 请求）。
2. 决定未来运行是否采集独立固定的 request 与 action 证据，或接受本实验 D 永久为 unknown。
3. 在作出任何总体覆盖率结论前，决定是否设计任务机会普查。

## 边界

未新增模型调用、宿主回合、生产数据库写入、安装或发布；未修改冻结证据、历史判定或实验预算；未删除生产记录；未把缺对照当成离线统计开发的阻塞。

