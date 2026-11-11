# PRI-1182 Adaptive Activation — 真实请求签字页

**请求**：批准在冻结的 5 个用例上，最多发送 **4 次**真实评分请求，用于验收一次。
**不批准也安全**：该功能默认关闭，不签则永久零发送。

## 1. 只测这 5 例

| 用例 | 输入 | 期望（可观察） |
| --- | --- | --- |
| append | 交付验收提问 | 选中 DELIVERY 并补入正文 |
| abstain | 与任务无关的提问（天气） | 全部低于门槛，弃选，正文不变 |
| selected-but-does-not-fit | 选中项装不进预算 | 选中正确但正文不变 |
| short-confirmation | 只有「确认」两字 | 允许弃选或不确定；**禁止误选** |
| pure-ack | 「收到，谢谢！」 | **0 次发送**，正文逐字节一致（零请求对照） |

## 2. 请求预算与防重

- 真实 POST 上限 **4 次**；每例最多 1 次；`pure-ack` 为 0 请求对照。
- 批件**只能认领一次**（`approval-claim.json` 以独占方式创建）；已有认领或已有结果即拒绝再发。
- 每次发送前先做预算预留，fail-closed：达到上限不再生成任何可能发送的子进程。
- **发请求之前**逐项校验：到期时间、head、tree、用例清单哈希、隔离配置哈希、实际构建文件哈希、工作树已跟踪文件状态、端点/模型/provider/响应模型白名单、时限、判据版本、上限、凭证；任一不符即退出，**0 请求**。

## 3. 模型与端点

- 端点：`https://openrouter.ai/api/alpha/decisions`
- 模型：`respan/span-01-lite:free`；provider **只允许 `Respan`**，`allow_fallbacks=false`
- 响应模型白名单：`respan/span-01-lite:free`、`respan/span-01-lite-20260925`；其它一律判失败并回退原生
- 响应未返回 provider 字段时记 `absent`。有该字段且与 Respan 不符时拒绝。
- 凭证：只从 `OPENROUTER_API_KEY` 读取，不写入任何日志或产物

## 4. 时限

- 评分窗口：**发送时刻起 1000 ms**（首字节 500 ms + 生成 500 ms），以整张答案表通过校验为终点。
- 宿主窗口 5000 ms；Adaptive 预算 4200 ms；输出保留 200 ms；剩余不足 300 ms 直接不评估。
- 超时、身份不符、结构不合法 → 一律回退原生，正文逐字节一致。

## 5. 到期时间

**2026-11-14 23:59:59 +08:00**。过期批件作废，需重新出卡。

## 6. 外发数据范围（逐字段）

- `model`；
- `state`：当轮 prompt（≤6000 字符）+ `priorMessages`（**当前为空数组**）+ 候选原则 `ref`/正文 `text`（单条 ≤600 字符）/`digest`；
- `questions`：每个候选一条适用性条件 + 一条 `insufficient_context`，均为 PD 生成的固定指令；
- `provider`：`{only:["Respan"], allow_fallbacks:false}`。

**不含**：对话历史、`transcript_path`、仓库文件内容、路径、用户身份、遥测、凭证。
请求体上限 20 000 字符；响应体上限 65 536 字节。

## 7. 如何撤销

- **默认关闭**：不打开 `host.codex.adaptive_activation` 就是原生路径，零发送、正文不变（当前即为关闭状态）。
- 批件一次性且到期作废；`results.json` 不可覆盖，重复执行会被拒绝。
- 认领后如中途终止，脚本不会重发；再跑需要新批件与新卡。
- 需要彻底移除时，整体 revert 该 PR 即可，无迁移、无持久状态。

## 8. 现在的状态

- 真实请求：**0 次**。预检 5/5 PASS，4 次请求全部发给假端点；harness 对任何非 Decisions URL 直接抛错，这是结构性保证。
- 已合入前需满足的工程证据：CI 全绿、`Verify Merge Gate` 通过。
- 代码绑定（批件需照抄）：`codeHead`、`treeHash`、`manifestSha256=6f0bf1ee…2931b9`、`isolatedConfigSha256=1782e231…339413` 和 `buildArtifactsSha256`。完整值见同目录 `preflight-result.json`。
  以执行时校验的**最终 head/tree** 为准；本页之后若仅有运行卡/证据类提交，被执行代码不变。

## 9. 签字

- 批准人：__________　日期：__________
- 批准范围：上述 5 例 / 最多 4 次真实请求 / 到期 2026-11-14 23:59:59 +08:00
- 批件文件 sha256：__________
