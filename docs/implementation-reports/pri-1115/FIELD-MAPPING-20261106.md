# PRI-1115 AA 证据字段映射（2026-11-06）

本文是离线汇总的字段契约。汇总不重算覆盖率：T/V/O/D 一律交给既有
`summarize-adaptive-coverage.mjs` / `adaptive-activation-coverage.mjs`；
本层只做输入适配、去重、溯源与 Owner 简报。

## 0. T/V/O/D 定义（SPEC v0.6 §6.1）

- **T 理论决策机会**：存在可被改变的决策、已授权原则、且在行动前存在合理干预窗口；
  需要显式任务机会普查与 enumeration 声明。
- **V 事前可见的合格信号**：在 T 中，所选 profile 上行动前可见的合格信号。
  **V 不等于送达**。
- **O PD 在行动前实际识别**：在 V 中，PD 在关键行动前实际识别到该机会。
  **O 不等于 Agent 遵循**。
- **D 独立确认目标正文进入实际请求且早于关键行动**：在 O 中，独立确认精确目标正文
  进入同一决策的实际请求，且早于关键行动。

缺证据一律 `unknown`；不得用送达、strong_run、离线复核或 Agent 行为替代任一层。

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
| `V` | `classification.V` + 行动前信号可见性证据 | 已链接机会 + 行动前可见的合格信号；**可见不等于送达** | `unknown`；送达或 strong_run 不足 |
| `O` | `classification.O` + 行动前识别证据 | 已链接机会 + PD 在行动前实际识别；**识别不等于 Agent 遵循** | `unknown`；假 provider 指定工具或行为遵循不算识别 |
| `D` | 既有 `verify-adaptive-delivery.mjs` 的 request/action capture | 独立 pin、精确目标正文进入实际请求、早于关键行动 | `unknown`；原生送达、回执或离线复跑不得确认 D |
| `sameText` | coverage-input `sameText` + 冻结输入摘要 | request 边界比较 | `unknown` |
| `budget.cumulative` | `experiment-budget.json` (`pd-aa-budget-ledger/v1`) | 全部已记录 runId | `state=unknown`，绝不写 0 |
| `budget.perRun` | `run-record.json.attempt.used`（回退：按 runId 过滤数组） | `runId` 等于当前报告运行 | `state=unknown` |
| `originalVerdict` | `run-record.json.positiveGate` / `controlGate` | 门禁当时的判定 | `state=unknown` |
| `offlineReevaluation` | `offline-reevaluation.json` | 独立文件、`sourceRun` 必须匹配已记录运行 | `state=missing`；不得升级为实验成功 |
| `productionExclusions` | 污染审计 v4 的 `incidentWindow` + 快照内容 | 事故时间边界 + 快照内容；**rowid 不是键** | `state=not_audited`；缺审计不等于干净 |
| `benefit / harm` | 评价证据（当前证据集没有） | 独立结果/评价证据 | `not_evaluated`，绝不写 0 |

## 3. 运行时关联的匹配方式

关联分为两层：linkage 自身的 `association`（该记录内部对行动的关联强度）与
“该 linkage 是否属于本条实验记录”的实验级匹配。两者不得互相升级。

1. `hook_invocation_id`：门禁证据中存在可信 `hookInvocationId` 且与 linkage 调用
   相等 → `matched_by_run`，实验级强关联。1258 使用此方式。
2. `run_identity`：`consumedBy.runId` 只与 linkage `intervention.runId` 比较；
   若两边的 session 都有值且不相等 → `contradictory_identity`，不建立关联。
   运行号与 session 号不放入同一集合互相替代。
3. `session_identity_only`：只有 session 相同 → `weak_candidate`，不得输出
   `matched_by_run`；同一 session 可能包含多次运行。
4. `action_timestamp_proximity`：运行记录没有 host 身份时，把运行内
   `toolCalls[].recordedAt` 与 linkage `facts.actions[].ts` 比较；差值 ≤ 5000ms
   只输出 `weak_candidate`，不得输出 `matched_by_run` 或实验级强关联。
   1105 使用此方式（22ms）。
5. 多条候选：输出 `ambiguous` 并列出全部候选，不用 `find` 任取第一条。
6. 记录有可信 `hookInvocationId` 但 linkage 中不存在：输出
   `no_matching_invocation`，不降级改用时间或 session 猜测。
7. 无可信匹配：保持 `no_matching_invocation`，不补造身份。

只有 `runs[].linkage.experimentLevelStrongLink=true` 才是实验级强关联；
`association=strong_run` 本身不是。关联只证明“同一运行内发生过该行动”，
不证明 request 级送达、顺序或原则遵循。

## 4. 历史失败与预算

- 两份 `run-record.json` 都保留原判定；1258 的 `offline-reevaluation.json` 单独
  标注为派生复核（corrected gate 通过），`affectsOriginalVerdict=false`。
- 累计预算取账本 `used`；单次成本取 `attempt.used`。运行记录中的
  `httpRequests` / `toolCalls` / `hostTurns` 含历史行，按 `runId` 过滤后
  另计 `historicalRecordsExcluded`，不进入当前运行成本。
- 同一文件重复输入按 SHA-256 去重；同一 `runId` 不同内容视为冲突并失败。
- 调用去重：仅当 `hookInvocationId` 相同、workspace/host/config 作用域相同、
  且语义内容（canonical hash，键顺序无关）一致时才算重复；内容不同 →
  `conflicting_linkage_invocations`，作用域不同 → `conflicting_linkage_scopes`，
  均以退出码 1 显式失败。报告级 `generatedAt` 等非事实字段不参与比较。
- 多窗口/多 workspace/多 config 以 canonical 排序聚合；输入顺序不改变
  `units`、`windowId`、`workspaceId` 或冲突结论。

## 5. 结论口径

- 没有任务机会普查 → T 未知，`D/T` 总体比率 `unknown`；链接子集为空时
  `linkedSubsetRatios['D/T'] = not_applicable`（零分母，不是确定零）。
- V = 行动前可见的合格信号，不等于送达；O = PD 行动前实际识别，不等于
  Agent 遵循；D = 独立确认目标正文进入实际请求且早于关键行动。
- `strong_run` 只表示 linkage 自身关联；只有 `experimentLevelStrongLink=true`
  才是实验级强关联；没有 timely 顺序证据时不升级 D。
- 未执行对照 → 收益/损害 `not_evaluated`；不写 0，不写因果改善。
- 离线复核通过不改变原实验失败结论；零运行输入不出现任何历史实验结论。

## 6. 入口与产物

```bash
node scripts/dev/principle-learning-lab/summarize-aa-evidence.mjs \
  --linkage <pd-activation-link.json> \
  --budget <experiment-budget.json> \
  [--run-record <run-record.json> ...] \
  [--offline-reevaluation <json>] \
  [--plan <plan.json> ...] \
  [--pollution-audit <audit-v4.json>] \
  --output <coverage-summary.json> --brief <OWNER-BRIEF.md>
```

`--run-record` 可省略：此时运行/实验为 `unknown`，简报只陈述调用、预算与来源哈希，
不得出现任何历史运行编号或实验结论。提供 run-record 时，输入 schema/`runId`
缺失仍以退出码 1 失败，并给出结构化 `reason` / `nextAction`。

本次产物：

- `docs/implementation-reports/pri-1115/coverage-summary-20261106.json`
- `docs/implementation-reports/pri-1115/OWNER-BRIEF-20261106.md`

## 7. 语义变更声明

本适配层没有改变既有统计语义：覆盖率、比率、链接子集与 `newTimely`
仍由既有模块计算。新增的只有输入适配、去重、溯源、预算拆分、生产事故
排除的时间边界和 Owner 简报。若未来要让“调用”变成“决策机会”，那会改变
既有语义，必须先单独提交差异与最小方案供批准。
