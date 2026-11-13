# Adaptive Activation v3 — 双判断替换签字页

**请求**：批准对**一个已冻结用例**发送 **1 次**真实评分请求，验证「换入是否有价值」与「换出是否安全」两项是否都在 2 秒内过线，并让 Codex 实际请求换入 `DELIVERY`。
**不批准也安全**：`host.codex.adaptive_activation` 默认关闭，未签名即永久零发送。

## 0. 版本关系（此前混写已澄清）

| 对象 | 版本 | 说明 |
| --- | --- | --- |
| 旧验收入口清单 `docs/implementation-reports/adaptive-activation-native-gap/cases.json` | `v1-20261111` | 单一适用性问题，含已移除的 `leadMargin`；原样保留 |
| 上一轮合并的评分协议 | `v2-20261112` | 合并问题、单一 `0.70` 线；旧批件与旧结果原样保留 |
| **本卡对象** | **`v3-20261112`** | 可替换候选两个独立条件；`0.70` 线不变 |

`native-gap` 清单与仓库代码的版本失配是 **pre-existing**：`run-cases.mjs` 断言的自洽版本自 v2 起就与 `v1-20261111` 不一致，早于本 PR 的 v3 改动。证据：`git log --oneline -- docs/implementation-reports/adaptive-activation-native-gap/cases.json` 显示该文件最后一次修改早于 v2 协议提交；`git show origin/main:packages/host-runtime/src/adaptive-decision-protocol.ts` 已是 `v2-20261112`。本 PR 不修改该旧清单，而是在新目录建立 v3 清单。

## 1. 只测这一例

真实评分只跑 `requested-approval.json` 里这一个冻结用例（`replace: SCOPE,DRAFT -> SCOPE,DELIVERY`）；`cases.json` 里的 `replace-select` 等 5 例仅用于仓库内回放/预检，不产生真实请求。

| 项 | 值 |
| --- | --- |
| 真实评分用例 | `requested-approval.json` 的 `case` 字段（夹具清单 SHA-256 `08c01224…`） |
| 输入 | 「这次改动已经全部完成了吗？请给我一个交付验收结论。」 |
| Native | `SCOPE,DRAFT`（`DRAFT` 明确只适用于起草，不适用于交付判定） |
| 候选 | `DELIVERY`（要求以可观察证据自检） |
| 允许让位 | `act-DRAFT`（仅隔离工作区配置） |
| 期望 | 有效响应内 `candidate_c1_value ≥ 0.70` 且 `candidate_c1_safety ≥ 0.70`；Codex 实际请求中完整 `DELIVERY` 恰好一次、`DRAFT` 退出、`SCOPE` 保留、装配 ≤ 1250 字符 |
| 仓库内回放 | `docs/implementation-reports/adaptive-activation-v3/cases.json` 的 `replace-select`（两个可替换候选 `c1`/`c2`），只走 `--preflight` 假端点 |

## 2. 外发范围（逐字段）

请求体：`docs/implementation-reports/adaptive-activation-v3/outbound-body-template.json`
SHA-256 `f5b8864c09c88ddeee0a6b748edcc2fd14986229f3b4bf3b616ab6d2def3ed08`。

- `model` = `respan/span-01-lite:free`
- `provider` = `{only:["Respan"], allow_fallbacks:false}`
- `state.currentInstruction`：上述合成任务文本
- `state.priorMessages`：空数组
- `state.candidates[]`：`ref`、`text`（单条 ≤ 600 字符）、`digest`，以及**可替换候选的 `replaces`**——即 PD 冻结的让位项正文 `DRAFT`
- `questions`：
  - `candidate_c1_value`：候选是否直接帮助完成用户当前要求的下一步（核对/验证/证据整理算直接帮助）
  - `candidate_c1_safety`：本轮能否省掉 `state.candidates[].replaces` 记录的让位项而保留任务所需约束
  - `insufficient_context`：信息不足（≥ 0.60 优先弃选）

**不含**：会话历史、额外候选、仓库文件内容、路径、用户身份、遥测、凭证。`OPENROUTER_API_KEY` 仅用于 `Authorization` 头。

## 3. 时限与额度

- 评分窗口：发送时刻起 **2000 ms**，以整张答案表通过校验为终点；宿主更早截止优先。
- 真实 POST 上限 **1 次**；失败或超时同样计入。零重试、零换模型、零调阈值。
- 有效期：**2026-11-15 23:59:59 +08:00**。

## 4. 绑定值（批准即绑定）

### 4.1 真实评分构建（本页签名的对象）

| 项 | 值 |
| --- | --- |
| 评分构建 head | `15a9a0bf91e63b31b49410031bcd0c2d30477257` |
| tree | `361388d4a71bbed479275c9d36f3b4460f851f74` |
| 构建指纹（4 个 dist 文件） | `7e403da2f476dc214c6e79b258d1c34b8d562c104bd777b3ef129d5888e8f9bc` |
| `pd-hook.js` SHA-256 | `6dcc4dc8b0c2d93a9cd175deac7bcbf32f1e6c4f183f0092de01c4392b7c202a` |
| 隔离配置 SHA-256 | `630865ad9d9aa62fbbf07e8a3b5106a88a19e58a69b8e653ca01fe9f433f9416` |
| 真实臂夹具清单 SHA-256 | `08c012240ef56f4108158647a2db88a5a690ecedc58e3fd49ee1254d063a869d` |
| 最终执行器 SHA-256 | `3071cd0907351a26b7c6f1cf4a6f114e00a9fbd746c5a1928e38e2061e1f7830` |
| 冻结批次标识 | `f5c0d8fc02c9c8d38746c29ec69bd32937c50a2ba96b6320b4b0cd51686ca26a`（manifest + 构建指纹 + 协议版本） |
| 出网正文模板 SHA-256（文件） | `f5b8864c09c88ddeee0a6b748edcc2fd14986229f3b4bf3b616ab6d2def3ed08` |
| 出网正文 SHA-256（state+questions 规范化） | `b994729548a78384fed0f7c1e1a33c2911e9329912c6176690e2d7086771f535` |
| 实际执行命令 | `node .tmp/pri-1116-real-split/run-once.mjs --real D:/Code/principles/2026-11-12/pri-1116-split-judgment/evidence/approval/requested-approval.json` |
| 协议版本 | `v3-20261112` |
| 上限 / 窗口 | 1 次 POST / 2000 ms |

以上逐项由 `requested-approval.json`（本目录）承载；执行器在发送前复核签名、head/tree、构建指纹、协议版本、上限、有效期、路由凭据，任一不符即拒绝，0 请求。

### 4.2 本轮仓库预检产物（不发送，可复跑）

`node scripts/dev/adaptive-activation/run-cases.mjs --preflight`

（默认批次即本目录；合并最新 `origin/main` 后重跑。与上一版产物相比，仅时间戳与耗时变化，5 例结论、假请求数与构建指纹不变。）

| 项 | 值（`preflight-result.json` 实测） |
| --- | --- |
| 仓库 head | `4459d270a4632e234644955792d3bc52218e92a2` |
| 仓库 tree | `acec646240ef37414ad5532fbd78282cf023f83c` |
| v3 验收入口清单 SHA-256 | `bad622a1354ba6c4985fc0e6db7da12cd617e0e43f05c08d7f4f8c3683cbe5ac` |
| 隔离配置 SHA-256（`adaptive-activation-pri-1182/isolated-config.yaml`） | `1782e2310313385d6ff9ae65519abfebb9c4de1d367cfff4703c9d5032339413` |
| 构建产物指纹（`hashBuildArtifacts`） | `5dc6f61cf1c5ee6145774c7a04c4bbd6dd0b6474096bb88543662b3c866bb930` |
| 协议版本 / 窗口 | `v3-20261112` / 2000 ms |
| 结果 | 5 例 PASS；4 次假请求、0 次真实请求 |

`15a9a0bf9..4459d270a` 之间 `packages/host-runtime/src` 与 `packages/codex-adapter/src` 无差异（仅 CHANGELOG/package.json 与无关包变化），且构建产物指纹与 4.1 完全一致，因此 4.2 的预检与 4.1 的评分构建运行同一判定源码。

## 5. 本地证据（无需 Owner 复跑）

| 证据 | 位置 | 结论 |
| --- | --- | --- |
| v3 链路预检（真实启动器 + 回环 Decisions） | `owner-preflight-real-arm.json` | `codex exec` → 本机接收端 1 次主请求；评分请求 1 次；出网题目为 value/safety/insufficient；最终 `SCOPE,DELIVERY` |
| 缺凭据反例 | 同上 `negative` | 0 宿主请求、0 评分请求、`adaptive_activation_needs_setup` |
| v3 验收入口清单 preflight | `preflight-result.json` | 5 例 PASS；4 次假请求、0 次真实请求；两例拒绝理由分别为 `replacement_unsafe` 与 `below_selection_threshold`，正文与 Native 逐字节一致 |
| 合入门禁回归 | `packages/codex-adapter/tests/pd-hook-adaptive.test.ts` | 37 例通过，含「两个可替换候选：1 次 POST、每个候选两组条件、`validatedAt - requestSentAt ≤ 2000 ms`」 |

> 证据边界：`owner-preflight-real-arm.json` 由未入库的一次性启动器产出（原件在冻结构建工作区 `.tmp/pri-1116-real-split/run-real-decision.mjs`，SHA-256 `ACCDBDBCC77987461C878C5335A6DE8C2B9C696AC165B756FE8AF0A3B9DEE16E`，未删）。仓库内可复跑的验收是 §4.2 的 `run-cases.mjs --preflight`；一次性执行器见 §7。

## 6. 如何撤销

- 默认关闭：不打开 `host.codex.adaptive_activation` 即回 Native，零发送、正文不变。
- 批件一次性、到期作废；失败即收口，不重试。
- 需要彻底移除时整体 revert PR；无迁移、无持久状态。

## 7. 执行器来源（必须明确）

最终执行器已固定，位于冻结构建工作区，不入库：

- 文件：`D:\Code\_worktrees\principles\PRI-1116-adaptive-codex-acceptance\.tmp\pri-1116-real-split\run-once.mjs`
- SHA-256：`3071cd0907351a26b7c6f1cf4a6f114e00a9fbd746c5a1928e38e2061e1f7830`
- 自检：`node .tmp/pri-1116-real-split/run-once.mjs --self-check`
- 本地验收：`node .tmp/pri-1116-real-split/run-once.mjs --preflight`

它复用 `scripts/dev/adaptive-activation/approval-gate.mjs` 的绑定、结果新鲜度与请求预算；独占认领按**冻结批次**（manifest + 构建指纹 + 协议版本）定位，已签文件哈希只写入认领记录供追溯，改签字日期/备注/JSON 格式不会换到新路径。认领文件同时是持久化额度账本：向上游发送前先记 `pending`，响应状态单独更新，无响应头超时记 `no_response`。Decisions 请求经回环中继在**转发前**与冻结模板比对，漂移即 422、不转发。批准后直接执行 §4.1 的命令，至多 1 次请求；证据与认领保留在 `D:\Code\principles\artifacts\pri-1116-one-shot\`。脚本不可用或绑定不符时保持零发送。

## 8. 签字

- 批准人：__________　日期：__________
- 批准范围：`replace-select` 单例 / 最多 1 次真实请求 / 到期 2026-11-15 23:59:59 +08:00
- 批件文件 sha256：__________

> 本轮未发出任何真实评分请求；真实复验记为 `NOT RUN`，直到本页签署。
