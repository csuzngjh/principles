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
| 批准记录 | `docs/specs/APPROVAL-PRI-1122-SINGLE-MODEL-v0.2.json` |
| 一次性认领文件 | `docs/implementation-reports/aa-selector-experiments/APPROVAL-PRI-1122-SINGLE-MODEL-v0.2-CLAIM.json` |

批准记录沿用仓库既有的批准文件形态（`schemaVersion` / `approvedBy` / `approvedAt` / `approvalEvidence` / `cardVersion` / `manifestSha256`，见 `scripts/dev/aa-controlled-admission/presence-run.mjs`），另加本实验必需的请求上限：

```json
{
  "schemaVersion": "pd-pri1122-single-model-approval/v1",
  "approvedBy": "<Owner>",
  "approvedAt": "<ISO-8601>",
  "approvalEvidence": "<Owner 批准本卡的出处>",
  "cardVersion": "v0.2",
  "manifestSha256": "c3312f46f033b13f89f17492d9f6adc43a6f092032723d3cc16ea744f6d37526",
  "maxTotalRequests": 12
}
```

`manifestSha256` 必须是**完整 64 位十六进制**原值，不得截断。执行顺序固定为：实际清单与批准记录比对 → 独占认领 → 出网。

- 清单或案例文件变化（哪怕同时更新清单内记录的案例哈希）：批准记录绑定的是原清单，入口在**认领之前**拒绝（`APPROVAL_RECORD_INVALID`，`approval is not bound to this manifest sha256`）。
- 清单内部漂移（案例文件变了但清单记录的哈希没变）：`MANIFEST_DRIFT`。
- 缺少批准记录：`APPROVAL_RECORD_MISSING`；卡版本、上限或批准引用不符：`APPROVAL_RECORD_INVALID`。
- 认领文件一旦存在，重复或并发执行在发送前拒绝（`APPROVAL_ALREADY_CLAIMED`）。

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

- 真实分支只接受 `--mode approved` 与批准标志；`--workspace`、`--current-input`、`--prior`、`--round-key`、`--budget-chars`、`--fixture-response`、`--approval` 任一出现即拒绝（`REAL_BRANCH_ARGUMENT_FORBIDDEN`）。批准标志只是显式执行开关，卡版本、清单哈希、请求上限与批准引用一律从批准记录读取。
- 还需要 `ZAI_CODING_CN_API_KEY`；缺失即拒绝（`MISSING_CREDENTIAL_REFERENCE`），不发起任何请求。
- 每个案例在运行目录下新建一次性 SQLite 工作区，候选、授权、顺序全部来自清单；工作区不写入仓库跟踪路径。
- 输出写 `docs/implementation-reports/aa-selector-experiments/<时间戳>/{results.json,summary.json}`，含逐请求台账与 dev/eval 分开的完成、失败、未运行计数；台账同时记录批准记录哈希与批准引用。

## 5. 停止条件

任一条成立即停止，并把剩余案例记为未运行：

1. 传输失败累计 2 次（`TRANSPORT_FAILURE_LIMIT`）；
2. 凭据失效或端点持续拒绝（表现为连续传输失败）；
3. 授权状态在等待期间变化，导致案例回退两次以上（记录即可，不重试）；
4. Owner 中途撤回批准。

## 6. 回滚与额度口径

- 代码回滚用 `git revert` 即可：本入口只在 lab 下、且只在被批准时执行，没有生产开关，也没有线上行为需要恢复。
- 认领文件与逐请求台账**保留作证据，不要清理**：它们记录批准引用、清单哈希、批准记录哈希与每一笔请求。
- 已认领的批次即使失败或中途停止，也按**实际台账**收口；不得重置、忽略或回收已用额度。
- 删除认领文件**不是**恢复额度的方式。再次运行必须取得**新批准**（新的批准记录，绑定新的卡版本或新的清单 SHA-256）；凭据与环境不得复用旧批准。
- 同一批准只能被执行一次：重复、并发、跨会话都视为已认领。

## 7. 未批准前的状态

- 本轮所有验收只用假传输，真实模型实测记为 `NOT RUN`。
- 代码、测试、冻结对照与入口已经就绪；批准后无需改代码即可执行。

## 8. 需要 Owner 的明确答复

请回复是否批准按本卡执行一次 12 请求的实测。未获明确批准前，不发起任何真实调用。
