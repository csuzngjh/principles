# PRI-1115 AA 证据字段映射（2026-11-06）

本文是离线汇总的字段契约。汇总不重算覆盖率：T/V/O/D 一律交给既有
`summarize-adaptive-coverage.mjs` / `adaptive-activation-coverage.mjs`；
本层只做输入适配、去重、溯源与 Owner 简报。

## 1. 计量单位（不得混用分母）

| 单位 | 来源 | 资格 | 缺失时输出 |
|---|---|---|---|
| 调用 call | `pd activation link` 的 `invocations[].intervention.hookInvocationId` | 同一窗口内唯一 hookInvocationId | `unknown`；绝不由运行数推导 |
| 运行 run | `run-record.json.runId` | schema `pd-aa-controlled-admission-run/v1`；唯一 runId；同字节去重 | `unknown` |
| 决策机会 opportunity | 当前证据集没有 | 需要显式任务机会普查与 enumeration 声明 | `unknown`；调用/运行不得充当分母 |
| 实验尝试 attempt | 一份 `run-record.json` = 一次尝试 | 唯一 runId；保留原判定 | `unknown` |

## 2. 字段映射

| 统计字段 | 原始来源 | 资格条件 | 缺失时输出 |
|---|---|---|---|
| `units.calls` | linkage `totals` + `invocations[].intervention.hookInvocationId` | 唯一调用；窗口完整 | `state=unknown` |
| `units.runs` | `run-record.json.runId` | 唯一 runId；相同字节去重 | `state=unknown` |
| `units.decisionOpportunities` | 无 | 需要任务机会普查；否则不得推断 | `state=unknown`，不报总体覆盖 |
| `units.experimentAttempts` | 每份 `run-record.json` | 原判定保留，不因事后复核改写 | `state=unknown` |
| `T` | coverage-input `classification.T` + enumeration | 仅已链接到声明式机会普查的机会 | `unknown`；总体比率不给值 |
| `V` | `classification.V` + 送达顺序证据 | 已链接机会 + 送达先于关键行动 | `unknown`；strong_run 不足 |
| `O` | `classification.O` + 独立识别证据 | 已链接机会 + 独立原则遵循证据 | `unknown`；假 provider 指定工具不算遵循 |
| `D` | 既有 `verify-adaptive-delivery.mjs` 的 request/action capture | 独立 pin、最终请求边界、精确目标正文、有序行动 | `unknown`；原生送达/离线复跑不得确认 D |
| `sameText` | coverage-input `sameText` + 冻结输入摘要 | request 边界比较 | `unknown` |
| `budget.cumulative` | `experiment-budget.json` (`pd-aa-budget-ledger/v1`) | 全部已记录 runId | `state=unknown`，绝不写 0 |
| `budget.perRun` | `run-record.json.attempt.used`（回退：按 runId 过滤数组） | `runId` 等于当前报告运行 | `state=unknown` |
| `originalVerdict` | `run-record.json.positiveGate` / `controlGate` | 门禁当时的判定 | `state=unknown` |
| `offlineReevaluation` | `offline-reevaluation.json` | 独立文件、`sourceRun` 必须匹配已记录运行 | `state=missing`；不得升级为实验成功 |
| `productionExclusions` | 污染审计 v4 的 `incidentWindow` + 快照内容 | 事故时间边界 + 快照内容；**rowid 不是键** | `state=not_audited`；缺审计不等于干净 |
| `benefit / harm` | 评价证据（当前证据集没有） | 独立结果/评价证据 | `not_evaluated`，绝不写 0 |

## 3. 运行时关联的匹配方式

1. `host_identity`：门禁证据里的 `consumedBy.runId/sessionId` 与 linkage 调用的
   `runId/sessionId` 相等。1258 使用此方式。
2. `action_timestamp_proximity`：当运行记录没有 host run id 时，把运行内
   `toolCalls[].recordedAt` 与 linkage `facts.actions[].ts` 比较；差值 ≤ 5000ms
   才建立关联，并在 `runs[].linkage.matchBasis/matchDeltaMs` 暴露依据。
   1105 使用此方式（22ms）。
3. 两者都不满足时输出 `no_matching_invocation`，不猜。

关联只证明“同一运行内发生过该行动”，不证明 request 级送达、顺序或原则遵循。

## 4. 历史失败与预算

- 两份 `run-record.json` 都保留原判定；1258 的 `offline-reevaluation.json` 单独
  标注为派生复核（corrected gate 通过），`affectsOriginalVerdict=false`。
- 累计预算取账本 `used`；单次成本取 `attempt.used`。运行记录中的
  `httpRequests` / `toolCalls` / `hostTurns` 含历史行，按 `runId` 过滤后
  另计 `historicalRecordsExcluded`，不进入当前运行成本。
- 同一文件重复输入按 SHA-256 去重；同一 `runId` 不同内容视为冲突并失败。

## 5. 结论口径

- 没有任务机会普查 → T 未知，`D/T` 总体比率 `unknown`；链接子集为空时
  `linkedSubsetRatios['D/T'] = not_applicable`（零分母，不是确定零）。
- `strong_run` 只表示关联强度；没有 timely 顺序证据时不升级 D。
- 未执行对照 → 收益/损害 `not_evaluated`；不写 0，不写因果改善。
- 离线 13/13 复核通过不改变原实验失败结论。

## 6. 入口与产物

```bash
node scripts/dev/principle-learning-lab/summarize-aa-evidence.mjs \
  --linkage <pd-activation-link.json> \
  --budget <experiment-budget.json> \
  --run-record <run-record.json> [--run-record ...] \
  [--offline-reevaluation <json>] \
  [--plan <plan.json> ...] \
  [--pollution-audit <audit-v4.json>] \
  --output <coverage-summary.json> --brief <OWNER-BRIEF.md>
```

`--json` stdout 只输出一个 JSON 文档；诊断信息走 stderr。输入 schema/`runId`
缺失时以退出码 1 失败，并给出结构化 `reason` / `nextAction`。

本次产物：

- `docs/implementation-reports/pri-1115/coverage-summary-20261106.json`
- `docs/implementation-reports/pri-1115/OWNER-BRIEF-20261106.md`

## 7. 语义变更声明

本适配层没有改变既有统计语义：覆盖率、比率、链接子集与 `newTimely`
仍由既有模块计算。新增的只有输入适配、去重、溯源、预算拆分、生产事故
排除的时间边界和 Owner 简报。若未来要让“调用”变成“决策机会”，那会改变
既有语义，必须先单独提交差异与最小方案供批准。
