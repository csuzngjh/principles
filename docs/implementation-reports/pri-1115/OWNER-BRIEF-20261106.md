# PRI-1115 AA 证据汇总 — Owner 简报

生成时间：2026-11-06T15:30:12.832Z　口径：observed_records_only_no_population_denominator

## 一句话结论

本次证据只能证明：受控准入在 1258 运行中被消费、目标正文到达本地假端点，且两次运行各存在一次 run 级只读行动关联（1105 以时间邻近匹配，1258 以 host identity 匹配）。它不能证明 request 级送达、timely、行为收益、因果改善或总体覆盖率。原运行判定仍为失败，对照未执行。

## 已观察事实

- 运行数：2；实验尝试：2；其中原判定失败 2 次，受控接线被证明 0 次。
- 调用数：2（linkage 窗口内，调用不等于决策机会）。
- 决策机会：unknown — 没有任务机会普查，不能把调用或运行当分母（未链接调用 2 条）。
- 受控准入被消费：aa-run-20261106T1258Z；目标正文到达端点：aa-run-20261106T1258Z。
- 关联为 strong_run：aa-run-20261106T1105Z（requestAssociation=unknown，ordering=unknown）；aa-run-20261106T1258Z（requestAssociation=unknown，ordering=unknown）。

### aa-run-20261106T1105Z

- 原判定：失败（identity、tool-surface）
- 受控接线：未证明（deliveryPath=unknown，admissionConsumed=unknown，targetBody=unknown）
- 事后复核：缺失
- 端点用户正文摘要与冻结输入：different（endpoint=ccbcc71e9a62，frozen=813856594fed）
- 本次运行成本：{"hostTurns":1,"httpRequests":2,"toolCalls":1,"paidCalls":0}；证据 sha256=0ad44b19bd7a

### aa-run-20261106T1258Z

- 原判定：失败（tool-invocation、admission-identity）
- 受控接线：未证明（deliveryPath=controlled，admissionConsumed=confirmed，targetBody=confirmed）
- 事后复核：存在（correctedGate=true，仅作派生结果，不改原判定）；复核器修正了原判定中的 2 个门禁缺陷，不改变实验结论
- 端点用户正文摘要与冻结输入：different（endpoint=77f64517a091，frozen=458dac4f7d14）
- 本次运行成本：{"hostTurns":1,"httpRequests":2,"toolCalls":1,"paidCalls":0}；证据 sha256=9b339ff239c2

## 覆盖口径（T/V/O/D）

- T（决策机会）: unknown（未知）（confirmed=0，unknown=0）
- V（原则可得）: unknown（未知）（confirmed=0，unknown=0）
- O（行动前被识别）: unknown（未知）（confirmed=0，unknown=0）
- D（request 级送达）: unknown（未知）（confirmed=0，unknown=0）
- D/T：unknown（value=unknown）
- 链接子集 D/T：not_applicable（链接子集无分母，不等于总体确定为零）
- 收益：not_evaluated；损害：not_evaluated
- 已记录调用/运行不是覆盖率分母；离线 13/13 复核通过不等于原实验成功。

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

- No decision-opportunity census exists, so T and all population ratios are unknown.
- No independently pinned request+action evidence exists, so D is unknown even where association is strong_run.
- The endpoint user body digest and frozen input digest differ; this limitation is preserved and does not decide D.
- The control arm never ran, so benefit, harm and causal improvement are not evaluated.
- A fake provider specified the tool; this does not show the Agent independently followed the principle.

## 下一步决定（Owner）

1. Decide whether to run the untouched control arm under the remaining budget (1 host turn / 1 HTTP request).
2. Decide whether a future run should capture independently pinned request and action evidence, or accept D as permanently unknown for this experiment.
3. Decide whether to design a task-opportunity census before any overall coverage claim.

## 边界

未新增模型调用、宿主回合、生产数据库写入、安装或发布；未修改冻结证据、历史判定或实验预算；未删除生产记录；未把缺对照当成离线统计开发的阻塞。

