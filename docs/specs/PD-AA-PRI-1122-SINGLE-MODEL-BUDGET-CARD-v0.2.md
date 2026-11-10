# PRI-1122 单次通用模型选择 — 真实调用预算卡 v0.2

状态：**未批准 / NOT RUN**
生效范围：`docs/specs/PD-AA-PRI-1122-SINGLE-MODEL-RUN-MANIFEST-v0.1.json` 定义的 12 个冻结案例
取代：`PD-AA-PRI-1122-SINGLE-MODEL-BUDGET-CARD-v0.1.md`（未批准、未执行）

## 1. 这次申请批准什么

只批准**一次**真实执行：用同一个单次通用模型，对 12 个事前冻结的合成案例各做一次选择，选择结果交给 PD 已有的共享装配；执行模型不参与，宿主不启用。

- 数据：仅本仓合成文本，无生产数据、无 Owner 私人内容、无宿主会话。
- 外发：每条当前指令 + 至多 6 条整条事前历史（合计不超过 12000 字符）+ 最多 16 条候选原则文本（合计不超过 12000 字符）+ 固定系统提示。
- 不外发：评价答案、允许集合、禁止错误、Native 基线正文、任何授权记录细节。

## 2. 冻结绑定

| 项 | 值 |
| --- | --- |
| 运行卡版本 | `v0.2` |
| 冻结清单文件 | `docs/specs/PD-AA-PRI-1122-SINGLE-MODEL-RUN-MANIFEST-v0.1.json` |
| 冻结清单 SHA-256 | `c3312f46f033b13f89f17492d9f6adc43a6f092032723d3cc16ea744f6d37526` |
| 冻结案例文件 SHA-256 | `5baec57099720712467bb2caf5a5770f59834d6f64613f8d41a195c6bc757dec` |
| 一次性认领文件 | `docs/implementation-reports/aa-selector-experiments/APPROVAL-PRI-1122-SINGLE-MODEL-v0.2-CLAIM.json` |

清单内容一旦变化，入口在发送前拒绝（`MANIFEST_DRIFT`）；认领文件一旦存在，重复或并发执行在发送前拒绝（`APPROVAL_ALREADY_CLAIMED`）。

## 3. 请求额度

| 项 | 值 |
| --- | --- |
| 模型 | `zai-coding-plan / glm-5.3-flash`（`https://open.bigmodel.cn/api/coding/paas/v4`） |
| 请求总数硬上限 | **12**（dev 8 + eval 4，每案例恰好一个机会） |
| 每个机会发送上限 | 1（第二次尝试在出网前拒绝） |
| 超时 | 每个机会 10 秒；到期后即使返回合法 JSON 也不应用 |
| 输出上限 | `max_tokens = 512`，`reasoning = low` |
| 重试 / 修复 | `maxRetries: 0`，`maxRepairAttempts: 0`，`free_form_only` |
| 失败记账 | 请求在发送前占用额度；失败、超时、畸形输出同样计数 |
| 费用 | 未知（模型计价未确认）；本卡只约束请求数、超时与输出上限 |

## 4. 执行入口

```powershell
node scripts/dev/adaptive-selector-lab/orchestrate.mjs --mode approved --execute-approved-20261110
```

- 真实分支只接受 `--mode approved` 与批准标志；`--workspace`、`--current-input`、`--prior`、`--round-key`、`--budget-chars`、`--fixture-response` 任一出现即拒绝（`REAL_BRANCH_ARGUMENT_FORBIDDEN`）。
- 还需要 `ZAI_CODING_CN_API_KEY`；缺失即拒绝（`MISSING_CREDENTIAL_REFERENCE`），不发起任何请求。
- 每个案例在运行目录下新建一次性 SQLite 工作区，候选、授权、顺序全部来自清单；工作区不写入仓库跟踪路径。
- 输出写 `docs/implementation-reports/aa-selector-experiments/<时间戳>/{results.json,summary.json}`，含逐请求台账与 dev/eval 分开的完成、失败、未运行计数。

## 5. 停止条件

任一条成立即停止，并把剩余案例记为未运行：

1. 传输失败累计 2 次（`TRANSPORT_FAILURE_LIMIT`）；
2. 凭据失效或端点持续拒绝（表现为连续传输失败）；
3. 授权状态在等待期间变化，导致案例回退两次以上（记录即可，不重试）；
4. Owner 中途撤回批准。

## 6. 回滚

- 无生产开关，无需回滚线上行为：本入口只在 lab 下、且只在被批准时执行。
- 删除认领文件即可让下一次批准重新可用；已产生的 `results.json` 保留为证据。
- 若需重跑，必须提交新的预算卡版本并重新获批，不复用本次认领。

## 7. 未批准前的状态

- 本轮所有验收只用假传输，真实模型实测记为 `NOT RUN`。
- 代码、测试、冻结对照与入口已经就绪；批准后无需改代码即可执行。

## 8. 需要 Owner 的明确答复

请回复是否批准按本卡执行一次 12 请求的实测。未获明确批准前，不发起任何真实调用。
