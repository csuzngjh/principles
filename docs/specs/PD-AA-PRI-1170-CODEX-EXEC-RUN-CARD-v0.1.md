# PRI-1170 — Codex `exec` 小批真实验收运行卡 v0.1

状态：`FROZEN_NOT_EXECUTED`（本卡与冻结用例先冻结，再由批准记录绑定；执行只允许一次）
日期：2026-11-11
工单：PRI-1170

## 1. 驱动路径（必须是已合并路径）

本批**不**复用冻结批次执行器，直接驱动合并提交 `9ae19367` 的 Codex 路径：

```
Codex UserPromptSubmit JSON
→ processHookInvocation（真实解码）
→ dispatch（真实装配、真实预算、additiveOnly）
→ adaptivePriorityProvider
→ 共享 runAdaptiveSelection（引用 + 正文 + 本地摘要；冻结表 + 独立重算双检）
→ 共享原则装配
→ hookSpecificOutput.additionalContext
```

- 生产包内容绑定：`packages/` 必须与合并提交 `9ae19367f2c7feb03517a15cefb449b4f4398bb8` 完全一致（tree `a51e3e5b0df63ff7e9a6f79e12aef69a2b20d1c1`）。执行前由 runner 用 `git diff --quiet <merge> HEAD -- packages/` 校验，漂移即拒绝。
- 隔离范围：每个用例单独 seed 一个抛掷型 SQLite 工作区；不使用真实用户工作区，不读真实会话。
- 真实网络：唯一出网点是批准绑定的端点；runner 只做计量（请求数、首字节、生成结束、usage、finish_reason），不做任何替换、重试或降级。
- `CODEX_HOME` 指向夹具内的空目录，避免落到本机真实用户工作区。

## 2. 执行版本绑定

| 项 | 值 |
|---|---|
| 合并提交 | `9ae19367f2c7feb03517a15cefb449b4f4398bb8` |
| 合并 tree | `a51e3e5b0df63ff7e9a6f79e12aef69a2b20d1c1` |
| 工作树基线 HEAD | `09e7ac968`（内容与合并提交一致，`packages/` 无差异） |
| runner | `scripts/dev/adaptive-selector-lab/pd-hook-approved-run.mjs`，SHA-256 `824b4c9323d65b16dba5d99ef6f81fddd2ca4702c1e37c95547a381255b28df0` |
| 冻结用例 | `docs/specs/PD-AA-PRI-1170-CODEX-EXEC-FROZEN-CASES-v0.1.json`，SHA-256 `b7060f726db5e4b3e8202aef1845991227900a4fe18eabd3db542ad81d102bc6` |
| 运行清单 | `docs/specs/PD-AA-PRI-1170-CODEX-EXEC-RUN-MANIFEST-v0.1.json`（其完整 SHA-256 由批准记录绑定） |

## 3. 可外发数据（仅隔离夹具）

每次真实请求最多包含：

1. 固定选择系统提示（仓库内合并版本，含“只返回引用与摘要”的协议）；
2. 当前轮正文：本卡冻结的 `prompt` 字段（≤ 6000 字符）；
3. 候选原则：最多 12 条，每条 `{ref, text, digest}`，其中 `text` 截断到 ≤ 600 字符，`digest = sha256(实际下发正文)`。

明确不发送：会话历史、prior messages、真实用户文件、persona/记忆、凭据、完整响应、原始会话、真实工单内容。所有候选文本均为合成夹具文本，不含生产数据。

## 4. 端点、模型与用量上限

| 项 | 值 |
|---|---|
| provider | `zai-coding-plan` |
| baseUrl | `https://open.bigmodel.cn/api/coding/paas/v4` |
| model | `glm-5.3-flash`（批准记录绑定的唯一模型，不允许换模型） |
| 请求 | 流式；`temperature: 0`；`reasoning: low` |
| 单请求 `max_tokens` | 512 |
| 单请求输入上限 | ≤ 6000 字符当前正文 + ≤ 12×600 字符候选 + 固定系统提示 |
| 本批实际请求上限 | **3 次**（每例 1 次；Native 臂 0 次模型请求） |
| 累计输出上限 | ≤ 3 × 512 = 1536 tokens |
| 重试 / repair / provider fallback / 换模型 | **0 / 0 / 0 / 0** |
| 旧额度 | PRI-1122 的 12 次额度**已消费，不得复用** |

## 5. 时限

| 项 | 值 | 依据 |
|---|---|---|
| 宿主外层 `UserPromptSubmit` 超时 | **5 s** | `plugins/principles-disciple/hooks/hooks.json` 的 `timeout: 5` |
| 单例墙钟硬上限 | **5 s** | 与宿主外层一致；超时即中止传输、保留 Native、记 `HOST_HOOK_TIMEOUT` |
| 整批墙钟上限 | **20 s** | 3 例 × 5 s + 5 s 开销；超出后剩余用例记 `NOT_RUN` |
| 合并实现内部准入 / 生成预算 | 10 s / 10 s | 合并版 `ADAPTIVE_SELECTION_LIMITS`；外层 5 s 先到，本次同时记录该差异 |

说明：合并实现的内部预算（10 s + 10 s）长于宿主外层 5 s。本卡以宿主 5 s 为硬上限执行；两者差异会原样写入结果，供限域试用判断使用，不在本批修改默认值。

## 6. 费用口径

- 只使用批准绑定的低成本模型 `glm-5.3-flash`。
- 费用按服务端返回的 `usage`（`prompt_tokens` / `completion_tokens` / `total_tokens`）逐次记录；响应内不提供价格时，**不臆造金额**，记为 `unknown`。
- 不以“免费额度”或历史账单推断本次费用。
- 用量与请求数写入一次性台账（write-ahead），失败尝试同样计数。

## 7. 三个冻结代表例（各一例）

| 用例 | 决策 regime | 选择 | Native 预期 | Adaptive 预期 |
|---|---|---|---|---|
| `exec-append` | Native 漏掉适用原则且可追加 | 应选中 `fixture_verify` | 含 `fixture_log_redaction`，不含目标 | 追加目标；原 Native 内容逐字保留；只新增 1 条 |
| `exec-abstain` | 应弃选 | `none_applicable`（`no_increment`；`uncertain` 也计弃选） | 覆盖全部候选 | 与 Native **逐字节一致**；不增不减 |
| `exec-nofit` | 选对但预算放不下 | 应选中 `fixture_verify` | 不含目标 | 与 Native **逐字节一致**；目标仍不装入；归类为“选对但未装入”，不是模型漏选 |

预算规则：`base + kept blocks + target block + slack − deficit`，由共享指令成本实测得出；三个用例预算均 ≥ 1250 字符（合并路径 operator-declared 窗口的下限），可被精确表达。

## 8. 执行与收口规则

- 执行前：校验批准记录（清单/用例/runner 全哈希、模型、端点、请求上限、时限、过期时间），并以独占方式认领一次。
- 每例先跑 Native 臂（Adaptive 关，0 次模型请求），再跑 Adaptive 臂（1 次真实请求）。
- 逐例记录：模型是否给出有效结果、Native 与 Adaptive 最终正文差异、是否新增适用原则、是否误选、首字节/生成结束/取消时点、失败阶段、引用与摘要校验结果、HTTP 状态、`finish_reason`、`usage`、墙钟。
- 任一时限/协议失败：保留 Native，记录失败阶段，**直接收口，不追加请求**。
- 超出 3 次请求、超过整批墙钟、批准失效、执行版本漂移：立即停止，未执行项记 `NOT_RUN`，不记 PASS。
- 本批旧批准不重跑；本批结束不滚动额度。
