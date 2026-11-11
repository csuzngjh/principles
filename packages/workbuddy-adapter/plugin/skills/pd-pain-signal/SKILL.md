---
name: pd-pain-signal
description: 记录一条"相对锚点的显著行为背离"（Pain）。Owner 用 `PD记录痛苦：` 前缀发消息时由 WorkBuddy Hook 处理；Owner 明确要求你登记且能指出锚点时，通过 PD MCP 工具 pd_submit_pain 提交本次记录。禁止后台提交，禁止编造锚点。
---

# PD Pain Signal（WorkBuddy）

Pain = 相对明确锚点的显著行为背离。三个要素同时成立才算 Pain：

1. **锚点** —— Owner 的明确期望、已建立的原则，或当前有效的 Agent Instructions / Skill 要求；
2. **具体行为** —— 你实际做了什么、或没做什么；
3. **显著背离** —— 实际行为与锚点之间可描述的差距。

没有实际损失、没有反复发生、Owner 尚未纠正，都**不是**拒绝记录的理由；它们只用于帮 Owner 判断注意力优先级。

## 入口 1 —— Owner 原生前缀（由 Hook 处理，不要代劳）

Owner 在自己的消息开头输入：

    PD记录痛苦：<Owner 原文>

- 前缀必须位于消息开头并使用全角冒号；正文 1–500 字符。
- 超长输入会被拒绝并要求精简，不会静默截断。
- 只记录 Owner 原文；引用、工具输出和模型转述不构成新的 Owner 提交。
- 这条路径由 UserPromptSubmit Hook 处理。不要模拟宿主事件，也不要把同一条消息再提交一次。
- 如果当前消息没有此前缀，不要要求 Owner 重发；按入口 2 处理（若 Owner 明确要求登记）。

## 入口 2 —— 锚点式提交：MCP 工具 `pd_submit_pain`

先看当前工具列表。

- 有 `pd_submit_pain` → 按下表参数调用。
- 没有 `pd_submit_pain` → 本部署未启用锚点写入能力。停止：不要调用近似工具，不要用猜测的 lineage 拼一条 CLI 写入，不要声称已提交；如实告诉 Owner 该能力不可用。

| 参数 | 必填 | 约束 |
|---|---|---|
| `reason` | 是 | 1–2000 字符，按下面六项组织 |
| `anchorType` | 是 | `owner_expectation` / `established_principle` / `agent_instruction` |
| `anchorRef` | 是 | 1–300 字符，格式随锚点类型 |
| `painType` | 否 | `principle_deviation` / `tool_failure` / `subagent_error` / `user_frustration` |

schema 是严格的：`score`、`severity`、`priority`、`sessionId`、`approved`、文件路径、metadata 都会在写入前被协议层拒绝。

## 锚点三源

只能选一种，且 `anchorRef` 必须让另一个人能找到出处。

### `owner_expectation`（Owner 明确期望）

Owner 在本次对话、Owner 文档或已批准决定中明确表达过。`anchorRef` 写清出处，例如 `本次对话 14:02 Owner: "……"` 或 `docs/xxx.md §2`。

- 只靠回忆的 Owner 期望不得提交；说不出可核查的出处时，先问 Owner 或放弃提交。

### `established_principle`（已建立原则）

`anchorRef` 必须是 `<principleId>@<version>`（如 `P-42@1`）。id 与 version 都从 `pd principle list` 取，不得猜测或推断版本。

服务端只校验存在性、版本与状态：

- `active` / `probation` 才能作为当前背离的依据；`probation` 会返回 `anchor_probation` 警告（背离有效，但原则仍在试用期）。
- `candidate` / `archived` / `deprecated` 只能作为背景，不能作为依据。

服务端**不校验** `scope` 适用性与优先级冲突。你无法确认这条原则适用于当前场景时，在 `reason` 里写明"适用性待确认"，不要写成已确定。

### `agent_instruction`（Agent 指令 / Skill）

`anchorRef` 必须是 `<path>#<section>`，且不能包含空格，例如 `AGENTS.md#verification`。必须指向当前宿主中有效的要求（AGENTS.md、PRINCIPLES.md、SKILL.md、工具指南）。

### 无法归类

归不到三类中的任何一类 → 不要提交，先向 Owner 澄清。

## `reason` 六项（按顺序）

1. **锚点** —— 引用或写明出处（原则 id@version、Instructions 路径#章节、Owner 原话 + 位置）。
2. **锚点来源与引用等级** —— `verbatim` / `paraphrase` / `recollection` / `inference`。等级不得上调；只有 `recollection` 或 `inference` 时不足以提交，先向 Owner 确认措辞。
3. **观察到的行为** —— 具体动作、顺序、跳过的步骤、越界之处；不要写"质量不好"。
4. **背离** —— 与锚点的差距：没做 / 做反了 / 做了但绕过。
5. **为什么值得记录**（辅助）—— 帮 Owner 判断优先级，**不是**准入条件，更不得用它否掉一条已经成立的 Pain。
6. **上下文** —— 发生的时间、位置与范围。

不得隐藏冲突锚点，不得为"更容易被接受"而夸大背离，不得把第 5 项变成门槛。

## 授权 —— 仅本次提交

调用前必须向 Owner 说明：

1. 锚点及出处；
2. 你实际观察到的具体行为；
3. 两者的背离；
4. 必要时说明为什么值得关注。

然后在**本次对话**中取得 Owner 的明确同意。

- 未回复、回答不明确、或只说"随便"，都不算授权。
- Owner 修改了内容时，提交前必须按最终版本再次确认。
- 授权只对这一次提交有效：不得复用于另一条 Pain、另一个会话，或内容变化后的重试。
- 后台、定时、Hook 触发、无人值守的 Agent 不得自行提交（入口 1 是 Owner 本人输入，不属于 Agent 提交）。

## 严重度与 `painType`

- 不要提交分数或严重度：工具没有该参数；系统对省略严重度的记录按**中等**（moderate）落库。你不得自行提级；认为严重时写在 `reason` 里，由 Owner 判断。
- 只有在你能明确归类时才填 `painType`，省略时默认 `principle_deviation`。
- 不得为了显得紧急而回填 `user_frustration` 等类型。

## 如何阅读回执

工具返回一份 JSON 回执（`pd.pain-submit-receipt.v1`）：

```
status, painId, taskId, workspaceDir, diagnosis, anchor, provenance, warnings, error, nextAction
```

| status | 含义 | 你要做什么 |
|---|---|---|
| `submitted` | 痛苦与诊断任务已写入 | 只报 `painId` / `taskId`；`diagnosis.status` 为 `pending`，诊断尚未运行 |
| `refused` | 没有写入（`task_duplicate` 表示已存在等价任务） | 报 `error.code` + `nextAction`，不要盲目重试 |
| `failed` | 写入失败，唯一会带 `isError: true` 的状态 | 报 `error.code` / `error.message` / `nextAction`；任务可能已存在也可能没有 |
| `submit_unconfirmed` | 写入已开始但结果未知（超时或异常） | 不得重投；先 `pd task show <taskId>` 核对 |

可能遇到的 `refused` 代码：`invalid_input`、`anchor_invalid`、`anchor_unverifiable`（账本不可读）、`anchor_not_found`（id/版本不存在或账本为空）、`anchor_not_currently_valid`、`task_duplicate`、`ingress_*`。

传输降级：

- `minimal` —— 回执被压缩为 `status / painId / taskId / workspaceDir / diagnosis`。
- `untransportable` —— 退回纯文本说明，或带 `isError: true` 的信封。结果未知一律写"未知"，绝不说成"没有写入"。

只复述回执真实返回的标识与状态。登记成功不等于诊断、候选准入、审批或生效。

需要查下游：`pd task show <taskId>`；需要 Owner 审阅：使用 `pd-review`。WorkBuddy 的治理工作区固定为 `~/.workbuddy/pd-workspace`，不得猜测或扫描 session/turn 标识。

## 禁止

- 没有 Owner 在本次消息中的明确请求与同意就提交。
- 后台、定时、Hook 或无人值守时自行提交。
- 编造锚点、原则 id@version、Instructions 路径或 Owner 原话。
- 提交分数、严重度、优先级、session id 或审批令牌。
- 在 `pd_submit_pain` 不可用时，用 CLI 写入、本地开关或宿主 matcher 绕过。
- `submit_unconfirmed` 后未经 `pd task show <taskId>` 核对就重投。
- 写 `.state/.pain_flag` 或调用 legacy `write_pain_flag`。
- 批准、激活或修改原则。
