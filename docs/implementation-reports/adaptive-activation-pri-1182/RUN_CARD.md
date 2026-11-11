# PRI-1182 运行卡 — Adaptive 快速决策一次真实验收（v1-20261111）

> 状态：**冻结，等待本批独立批准**。预检已通过，真实请求数 **0**。
> 一句话签字版：**测 5 例（可追加、应弃选、选对但装不下、短确认进入评估、明确致谢零发送对照），
> 最多 4 次真实请求，模型 `respan/span-01-lite:free`（仅 Respan，禁 fallback），
> 时限为发送后 1000 ms（500 + 500，计到完整概率表通过校验），批件 2026-11-14 23:59 到期。**

## 1. 本卡要回答的问题

同步路径上，一次快速决策能否在 1 秒信封内完成「有效追加」与「合法弃选」：

- 能 → 才有理由提交 Codex `exec` 限域试用建议；
- 协议正确但完整评分仍超时 → 结束当前同步候选，按分段耗时决定是否转异步；
- 评分及时但出现误选/误跳过 → 带逐例分数交回，不边跑边调阈值。

## 2. 冻结口径

| 项 | 冻结值 |
| --- | --- |
| 判据版本 | `v1-20261111`：选中门槛 `0.70`、领先差距 `0.25`、信息不足门槛 `0.60` |
| 阈值来源 | **本批预设**，不由旧 GLM 样本推导；旧任务变化概率只用于裁决器回放 |
| 端点 | `https://openrouter.ai/api/alpha/decisions` |
| 请求模型 | `respan/span-01-lite:free` |
| 精确响应模型允许集合 | `respan/span-01-lite:free`、`respan/span-01-lite-20260925`（同前缀但未登记日期一律拒绝） |
| 路由约束 | `provider.only=[Respan]`，`allow_fallbacks=false` |
| 时间信封 | 发送后 **1000 ms** = first-byte 500 + generation 500，计到**完整概率表通过校验** |
| 实际截止 | 「发送后 1000 ms」与「宿主 5000 ms 扣除装配/输出余量 800 ms」两者中**较早者** |
| 准入线 | `300 ms` 是**最低剩余时间准入线**，不是「允许等待多久」 |
| 请求上限 | 每例 ≤1 次，整批 ≤4 次；纯致谢 = 0 次 |
| 到期 | `2026-11-14T23:59:59+08:00` |
| 失败回退 | 任何失败 / 超时 / 身份不符 → 输出 Native；Adaptive 默认仍关闭 |

`responseModels` 的精确允许集合与实际路由约束写在**实际生效的隔离配置**里：
[isolated-config.yaml](file:///D:/Code/_worktrees/principles/PRI-1182-adaptive-decision-endpoint/docs/implementation-reports/adaptive-activation-pri-1182/isolated-config.yaml)。

## 3. 冻结样本（判据先写死，再看结果）

Native 基准：`promptBudget` 只装得下 `SCOPE`，因此 Native **不含** `DELIVERY`。

| # | 例 | 输入 | 是否发送 | 允许结果 | 最终正文期望 |
| --- | --- | --- | --- | --- | --- |
| 1 | 可追加 `append` | 「请交付验收：这次改动已经全部完成了吗？」 | 1 | `selected` → `c3`(DELIVERY) | **新增** `DELIVERY` |
| 2 | 应弃选 `abstain` | 「今天杭州天气怎么样？」 | 1 | `none_applicable`（全部条件分低于 0.70） | 与 Native 逐字节一致 |
| 3 | 选对但装不下 `selected-but-does-not-fit` | 同 #1，候选顺序 `BIG,SCOPE,DELIVERY,TESTS`，预算只够 `BIG` | 1 | `selected` → `c3` | 与 Native 逐字节一致（不得改变正文） |
| 4 | 短确认进入评估 `short-confirmation` | 「确认」 | 1 | `none_applicable` 或 `uncertain`（保守弃选） | 与 Native 逐字节一致；若 `selected` 记为**误选** |
| 5 | 明确致谢 `pure-ack` | 「收到，谢谢！」 | **0** | 跳过 `trivial_confirmation` | 与 Native 逐字节一致 |

逐例预设分数见 [cases.json](file:///D:/Code/_worktrees/principles/PRI-1182-adaptive-decision-endpoint/docs/implementation-reports/adaptive-activation-pri-1182/cases.json)。

### 第 4 例的已知限制（属「只验收进入评估」情形）

当前 hook 的外发快照只带**当轮 prompt + 候选集合**，不带上一轮（「要不要提交最终版？」），
所以本卡对第 4 例只硬性验收「进入评估并向端点发了一次请求」；原则适用性**允许保守弃选**。
这是「上下文不可见」情形，不是「上下文可见但弃选」情形，产品判定时不得混用。

## 4. 预检结果（全部使用假端点）

执行入口：**构建后的真实 hook 子进程** `packages/codex-adapter/dist/pd-hook.js`。
预检通过 `--import` 预加载把 `fetch` 换成假 Decisions 端点；预加载对任何非 Decisions URL 直接抛错，
因此「真实请求 0」是 harness 的结构性保证，不是口头承诺。

| 例 | 发送 | 本地裁决 | 发送→校验 | 进程→输出墙钟 | 正文 |
| --- | --- | --- | --- | --- | --- |
| append | 1 | `selected:selected:c3` | 2 ms | 899 ms | 已追加 DELIVERY |
| abstain | 1 | `none_applicable:below_selection_threshold:none` | 2 ms | 896 ms | Native 一致 |
| selected-but-does-not-fit | 1 | `selected:selected:c3` | 2 ms | 900 ms | Native 一致 |
| short-confirmation | 1 | `none_applicable:below_selection_threshold:none` | 2 ms | 879 ms | Native 一致 |
| pure-ack | 0 | `unknown` | — | 880 ms | Native 一致 |

- **假端点请求数 = 4，真实请求数 = 0。**（本表为最终 head 上的一轮；历史多轮预检墙钟在 828–2564 ms 之间波动）
- 墙钟约 0.88–0.90 s，此前轮次曾出现 2.56 s 的 I/O 抖动；其中 **hook 模块冷启动约 0.88 s**
  （纯致谢例同样处于该区间，且 Adaptive OFF 的 Native 路径同样存在），决策本身只用 2 ms；
  整轮仍低于 5000 ms 宿主窗口，**本轮最差余量约 4.10 s**，这一项由真实请求继续观察。
- 两个假端点截止测试（同一声明入口、无测试专用时间参数）：
  - 及时返回完整评分 → 完成装配并补入；
  - 响应头及时、正文跨过 1000 ms → 底层收到取消，最终输出 Native。
  见 `packages/codex-adapter/tests/pd-hook-adaptive.test.ts`（`frozen 1 s envelope` 两条）。
- 证据文件：[preflight-result.json](file:///D:/Code/_worktrees/principles/PRI-1182-adaptive-decision-endpoint/docs/implementation-reports/adaptive-activation-pri-1182/preflight-result.json)。

预检快照绑定的版本：`codeHead=8bb3d57650a319b55ab72b1c0084a82169df1c5e`，
`tree=bd2c915ea6ab799763bf88d173ab06f95172fe33`，清单 `sha256=6f0bf1ee…2931b9`，
隔离配置 `sha256=1782e231…339413`。该快照基于 `main@c65486c8f`（Owner 最终对齐许可）；
清单与隔离配置哈希复算后与上方一致。
快照之后的提交只涉及运行卡与证据文件，**被执行代码未变**；批准时仍以**最终 head/tree** 为准，
由 `--approved` 在发请求前逐项校验，不一致即拒绝。

## 5. 外发数据范围（真实请求只包含这些）

单次 POST 到上面端点，`body` 仅含：

- `model`：`respan/span-01-lite:free`；
- `state`（JSON 字符串）：`currentInstruction`（当轮 prompt，≤6000 字符）、
  `priorMessages`（**当前为空数组**）、`candidates[]`（`ref`、原则正文 `text`、`digest`；正文单条 ≤600 字符）；
- `questions`：每个候选一条适用性条件 + 一条 `insufficient_context`，内容为 PD 生成的固定指令；
- `provider`：`{only:["Respan"], allow_fallbacks:false}`。

不含：对话历史、`transcript_path`、仓库文件、路径、用户身份、遥测。
请求体上限 20 000 字符；响应体上限 65 536 字节。

## 6. 尚不能主张的事实（NOT_RUN）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| Respan 实际服务了哪次响应 | NOT_RUN | 真实请求需本批批准；且响应缺 `provider` 时一律写 `absent`，只主张已有证据支持的路由事实 |
| 真实端点延迟与预算内追加率 | NOT_RUN | 同上 |
| 短确认在「上下文可见」时的原则适用性 | NOT_RUN | 当前 hook 快照不含历史轮次（见 §3 限制） |
| 异步方案可行性 | NOT_RUN | 依 §1 判定后再定，本卡不预设 |

## 7. 批准与执行流程

1. Owner 基于本卡批准，生成批件（示例）：

```json
{
  "approvedBy": "<owner>",
  "approvedAt": "2026-11-11T00:00:00+08:00",
  "expiresAt": "2026-11-14T23:59:59+08:00",
  "codeHead": "<最终 head>",
  "treeHash": "<最终 tree>",
  "manifestSha256": "<cases.json sha256>",
  "isolatedConfigSha256": "1782e2310313385d6ff9ae65519abfebb9c4de1d367cfff4703c9d5032339413",
  "route": {
    "endpoint": "https://openrouter.ai/api/alpha/decisions",
    "model": "respan/span-01-lite:free",
    "provider": "Respan",
    "responseModels": ["respan/span-01-lite:free", "respan/span-01-lite-20260925"]
  },
  "envelopeTotalMs": 1000,
  "criteriaVersion": "v1-20261111",
  "maxRequests": 4
}
```

2. 执行（只允许一次）：

```powershell
$env:OPENROUTER_API_KEY = "<key>"
node scripts/dev/adaptive-activation/run-cases.mjs --approved <approval.json>
```

3. 脚本在**发出任何请求之前**校验：到期时间、head、tree、清单哈希、隔离配置哈希、
   端点/模型/provider/响应模型允许集合、时限、判据版本、请求上限、API key；
   任一不符直接退出且不发请求。
4. 通过后先以独占方式创建 `approval-claim.json`（`wx`）：**同一批件不可重跑**，
   已有认领或已有 `results.json` 都会拒绝再发请求；认领失败即退出。
5. 每例发送前先做预算预留（fail-closed）：整批达到 4 次后不再生成任何可能发送的子进程；
   单例一旦超过 1 次立即中止，不再继续后续用例。
6. 执行后写 `results.json`：批件与认领哈希、逐例最终正文、有效评分、本地裁决与理由、
   `model`/`provider` 观测值（缺失写 `absent`）、该例实际执行的配置哈希、
   发送→校验耗时与整轮墙钟。

## 8. 关闭与回滚

- Adaptive 维持**默认关闭**；关掉 `host.codex.adaptive_activation` 即回到 Native，正文逐字节一致、零发送。
- 真实请求只跑一次；批件过期即作废，需重新出卡。`approval-claim.json` 是单次批件的认领凭证，
  出现即表示该批件已用；重新申请需新批件与新卡。
- 本卡不改 Native 回退逻辑；失败、超时、身份不符一律 Native。
