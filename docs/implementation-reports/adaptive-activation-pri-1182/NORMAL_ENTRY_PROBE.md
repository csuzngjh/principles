# PRI-1182 正常入口取证 — 可行性结论（2026-11-12）

> 目的：回答「hook 返回了什么」之外的问题——**正常 `codex exec` 实际发给模型提供方的请求里，
> 是否真的带着 Adaptive 补入的那条原则**。本文件只记录取证路径与观测，不构成真实评分批准。

## 1. 结论

**可行，且在隔离路径上已取得肯定证据。** 但这是「宿主发出的请求体」证据，
不是「真实模型收到并据此改变行为」证据；真实评分与真实 provider 仍为 NOT RUN。

| 臂 | Responses 请求数 | Decisions 请求数 | 唯一标记出现次数 | SCOPE 存在 |
| --- | --- | --- | --- | --- |
| Native（Adaptive 关） | 1 | **0** | **0** | 是 |
| Adaptive（Adaptive 开） | 1 | **1** | **1** | 是 |

- 两臂使用同一隔离工作区、同一 prompt、同一紧预算（`budgetChars=959`），只切换
  `host.codex.adaptive_activation`。
- Adaptive 臂多出的唯一差异，就是被补入的 `DELIVERY`（带唯一标记
  `PRI1182_NORMAL_ENTRY_MARKER_DELIVERY_V1`）。Native 臂证明该标记不来自 Native 装配。
- 请求体结构（Adaptive 臂，`input` 共 5 项）：`developer`（Codex 基础指令）→ `developer` →
  `user`（环境/上下文）→ `user`（当轮 prompt）→ **`developer`（PD 指令块，含标记）**。
  即宿主把 `UserPromptSubmit` 的 `additionalContext` 作为**用户消息之后的尾随 developer 消息**注入，
  不是并入系统前缀。这一顺序是宿主行为，本轮如实记录，不作产品结论。

## 2. 环境与隔离

| 项 | 值 |
| --- | --- |
| 宿主 | `codex-cli 0.167.0`（本机安装版） |
| 隔离 | 独立 `CODEX_HOME`、`HOME`、`USERPROFILE`；工作区在临时目录，不在仓库内 |
| 模型侧 | 本地 loopback Responses stub（`wire_api = "responses"`，`model_provider = "local-probe"`） |
| 评分侧 | 本地 loopback HTTPS Decisions stub（固定分数：c3=0.95，其余 0.03） |
| TLS | 一次性自签证书；子进程 `NODE_TLS_REJECT_UNAUTHORIZED=0`（仅此探针） |
| Hook | `CODEX_HOME/hooks.json` 直连构建产物 `packages/codex-adapter/dist/pd-hook.js` |
| Hook 信任 | `--dangerously-bypass-hook-trust`（仅自动化取证用） |
| 外发 | PD 本身零外发；宿主启动时仍会尝试 `chatgpt.com`/`api.github.com`（分别 401/429），未参与判定 |

## 3. 观测到的关键事实

1. `UserPromptSubmit`、`SessionStart`、`Stop` 三个 hook 在 `codex exec` 下均真实触发并 Completed。
2. 宿主交给 hook 的 payload 含 `session_id`、`turn_id`、`transcript_path`、`cwd`、`hook_event_name`、
   `model`、`permission_mode`、`prompt`，与 adapter 解码契约一致。
3. 早先一次失败是工作区配置缺 `version: 1` 导致 `status=degraded reason=missing required field version`，
   补上后正常；不属于产品缺陷。
4. `adaptiveActivation.endpoint` 必须是 `https://`；本地验证需要 TLS，http loopback 会被配置校验拒绝。
5. 当预算过宽（`promptBudget.hosts.codex=24960`）时，Native 自身已包含 DELIVERY，Adaptive 正确判定
   `no_increment`；把预算收紧为 `base + SCOPE + DELIVERY + 10`（并让 BIG 排在 DELIVERY 之前）后，
   Native 只装 SCOPE，Adaptive 才补入 DELIVERY。

## 4. 不能主张的事实（NOT RUN / 限制）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 真实 Respan/OpenRouter 评分 | NOT RUN | 本批未获批准；本次 0 次真实评分请求 |
| 真实模型是否“看见并遵循”补入原则 | NOT RUN | provider 是本地 stub，只能证明宿主发出的请求体 |
| 真实 provider 下的时延/预算 | NOT RUN | 同上 |
| 仓库钉住的 Codex 版本 | NOT RUN | 本机为 0.167.0；仓库 pin 未在本次核对 |
| 无自签证书/TLS 豁免的生产路径 | NOT RUN | 探针用了 `NODE_TLS_REJECT_UNAUTHORIZED=0` |

## 5. 复现

探针脚本（会话临时产物，未入库）位于
`<worktree>/.tmp/pri-1182-normal-entry/probe-two-arms.mjs`，执行：

```powershell
node .tmp/pri-1182-normal-entry/probe-two-arms.mjs
```

证据输出在 `%TEMP%\pri-1182-normal-entry\arms-<timestamp>\`：`arm-request-1.json`（Adaptive 臂实际请求体）、
`report.json`、`hook-logs/*-stdin.json`（宿主交给 hook 的原始 payload）。

## 6. 对验收的影响

- 这一步把 SPEC 的「宿主实际请求已收到」从待证变成了**在隔离宿主上可复现**，
  但它与第 3 步的真实评分是两件事，需分别取证。
- 评分批件只需覆盖真实评分；正常入口确认可在评分过线后，用同一套隔离方法换真实 provider 再做一次。
- 本轮真实请求数：评分 **0**，正常入口真实外发 **0**（仅 loopback）。
