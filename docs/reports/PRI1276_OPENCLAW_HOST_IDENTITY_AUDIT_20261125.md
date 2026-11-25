# PRI-1276 OpenClaw 正常入口身份与回执兜底 — Stage 0 审计报告

- 日期：2026-11-25
- 类型：安装态/源码只读取证 + 最小改动面
- 工单：PRI-1276（[PD 反馈可靠性·B2] OpenClaw 正常入口身份与自动补证）
- PD 源码基线：`origin/main@021b31d23`（worktree `ai/PRI-1276-pd-b2-openclaw`）
- 本报告只固化取证事实与改动面；取证样本中不含 prompt/reason/anchor 原文与工具输入输出正文。

## 1. 环境与安装态

| 组件 | 版本 | 证据 |
| --- | --- | --- |
| OpenClaw（安装） | `2026.11.5 (e13cf15)`，`%APPDATA%\npm\node_modules\openclaw` | `openclaw --version`（2026-11-25 实测） |
| PD OpenClaw 插件（安装） | `principles-disciple@4.3.0`，`~/.openclaw/extensions/principles-disciple/` | `package.json` |
| PD 源码 | 本 worktree 基于 origin/main `021b31d23`（含 #2739/#2774/#2793/#2790） | git |

与工单记录的基线（OpenClaw 2026.11.5）一致，未发生版本漂移。

## 2. MCP 请求链路取证（安装态 dist）

### 2.1 runtime `callTool` 已支持第四参数 `_meta`（复确认）

`dist/agents/agent-bundle-mcp-runtime.js:746-756`：

```js
async callTool(e, t, n, r) {            // (server, tool, args, options)
  ...
  params: {
    name: t,
    arguments: isRecord(n) ? n : {},
    ...r?._meta ? { _meta: r._meta } : {}
  }
```

`options._meta` 原样进入 MCP `tools/call` 请求。与审计报告 `PD_HOST_IDENTITY_CONTEXT_AUDIT_20261121.md` 结论一致。

### 2.2 materializer 实际调用点未传递第四参数（复确认）

`dist/agent-bundle-mcp-materialize-CJdMpxEi.mjs:284`：

```js
const invoke = () => t.callTool(u, d, s);   // (serverName, toolName, args) — 无 options
```

因此当前安装版上 `pd_submit_pain` 的 `tools/call` 请求不携带任何 `_meta`。

### 2.3 插件侧无可达的 `_meta` 注入扩展点（本次新增取证）

逐一排除（OpenClaw 2026.11.5 安装态）：

1. **`before_tool_call` hook 结果合并契约**：`dist/agent-tools.before-tool-call.wrapper-qxv3_OzC.mjs:729-741` 与 `:1163` — 宿主只读取 `params`（与 approval overrides 合并）、`block`、`blockReason`、`requireApproval`；`params` 进入 `arguments`，永远不会变成 `_meta`。
2. **hook 事件清单**：`dist/hooks-CHsww5hX.mjs` — `before_tool_call` / `after_tool_call` / `before_prompt_build` / `before_message_write` / `tool_result_persist` 等；**不存在 MCP 请求级 hook**。
3. **MCP runtime 配置面**：`dist/agent-bundle-mcp-runtime-config-*.mjs`、`agent-bundle-mcp-manager-api-*.mjs` — 无任何 `_meta`/请求元数据配置项。
4. **materializer 入口**（`dist/agent-bundle-mcp-materialize-CJdMpxEi.mjs:230`）：`e.appRequester` / `t.requesterConnect` 只影响 OAuth/requester 型 server；`pd-recall` 是插件清单声明的 stdio server，走 2.2 的固定 invoke 路径。

**结论：在安装版 2026.11.5 上，PD 仓库（插件侧）不存在能把 `_meta["pd.host-context.v1"]` 注入 `tools/call` 的扩展点。主路径生产者属于 OpenClaw 自身 dist（Owner fork `csuzngjh/openclaw`），即工单预置的"当前安装版本不支持主路径"分支。**

### 2.4 Session/SessionKey/toolCallId 事实

- runtime 同时暴露 `sessionId` 与 `sessionKey`（materializer 内可见 `t.sessionKey`；hook ctx 同时携带两者）。身份只能用 `sessionId`。
- `after_tool_call` 事件（`dist/embedded-agent-subscribe-EcG91LL0.mjs:2279-2299`）真实载荷：

```js
const n = {
  toolName: r,
  params: ...,          // 执行参数（structuredClone）
  runId: a,
  toolCallId: i,        // 来自 t.toolCallId（prepareToolExecutionEnd, :2048）— 真实执行上下文 ID
  result: l,
  error: ...,
  durationMs: t
};
// hook ctx（第二参数）：
{ toolName, agentId, sessionKey, sessionId, runId, toolCallId }
```

- **toolCallId 真实存在**且来自宿主执行上下文 → 回执兜底的身份歧义键可用。
- **submissionTurnId**：当前调用链不存在稳定提交轮字段；`runId` / `sessionKey` 均不得映射为 Turn ID（沿用 SPEC §G2 字段规则）。OpenClaw 兜底路径不传 `submissionTurnId`（与 PRI-1275 WorkBuddy 同规则）。

### 2.5 MCP 工具命名与结果 envelope

- 命名：`dist/agent-bundle-mcp-names-856aMFJA.mjs` `buildSafeToolName` → `{safeServerName}__{sanitizedTool}`；分隔符 `__`，server 片段清洗保 `[A-Za-z0-9_-]`（连字符保留），server 段上限 30、总长 64、冲突加 `-N` 后缀。`pd-recall` + `pd_submit_pain` → **`pd-recall__pd_submit_pain`（无 `mcp__` 前缀，与 WorkBuddy/Codex 不同）**。探针须实测确认。
- 结果 envelope（**已由真实隔离网关实测修正，见 §7**）：真实 `after_tool_call` 事件的 `result` 为
  `{content:[{type:'text',text:<回执 JSON 本体>}],details:{mcpServer:'pd-recall',mcpTool:'pd_submit_pain'}}`
  — **单层编码**；`result.content[0].text` 就是 `pd.pain-submit-receipt.v1` JSON 本体。
  dist 静态读取（`toJsonAgentToolResult` 的双重编码投影）与真实运行路径不符——生产 tools_call 走
  的是另一条结果投影分支（details 带 `mcpTool` 而非 `mcpOperation`）。兜底解析器按"单层优先、
  双层兼容"实现（`extractOpenclawReceipt`），并以真实探针记录
  `.tmp/pri1276/probe/after-tool-call.jsonl` 的 `layer1Keys` 为准。

## 3. 消费端与恢复链现状（PD 仓库）

- Core `resolveHostSubmissionContext('openclaw', meta)`（`packages/principles-core/src/runtime/host-submission-context.ts:271-272`）已支持命名空间键消费 — PRI-1274 交付，无需改动。
- pd-mcp-server `submit-assembly.ts` 已 host 通用：`resolveSessionVerification` 对 openclaw 走同一 trusted `_meta` 路径；`_meta` 缺失时非 Codex 宿主走 PRI-1260 legacy claim 校验；无 claim → `host_session_claim_empty`（unbound，合法落库）。
- Core `recoverTaskIdentityFromReceipt`（`pain-receipt-recovery.ts`）：
  - 恢复白名单 `RECOVERABLE_UNVERIFIED_DETAILS = {codex_host_metadata_missing, host_session_claim_empty}` — **OpenClaw 缺失元数据的真实 reasonCode（`host_session_claim_empty`）已在白名单，无需扩白名单**；
  - `hostKind` 参数类型为 `'codex' | 'workbuddy'`（:265、:371）— **需最小扩展加 `'openclaw'`**；
  - CAS/幂等/歧义/终态/租约保护全部就绪，不改动。
- WorkBuddy 兜底样板（`workbuddy-adapter/src/ingestion/pain-receipt-fallback.ts`）提供模块结构模板；envelope 解析与工具名门是宿主各自实现（跨 adapter 包不可互引，且工单要求"不得复制 WorkBuddy envelope"）。

## 4. 最小改动面

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `packages/principles-core/src/runtime/pain-receipt-recovery.ts` | `hostKind` 联合类型加 `'openclaw'`（两处类型位） |
| 2 | `packages/openclaw-plugin/src/openclaw-sdk.ts` | `PluginHookAfterToolCallEvent` 补真实字段 `toolCallId?/runId?/params?`（本地镜像过时；`toolArgs` 保留 deprecated） |
| 3 | `packages/openclaw-plugin/src/hooks/pain-receipt-fallback.ts`（新增） | OpenClaw envelope 解析（双重编码 + 单 text block + `details.mcpServer` 交叉验证）+ 精确工具名门 + 身份归一 + Core CAS 调用 + 结构化诊断行 |
| 4 | `packages/openclaw-plugin/src/index.ts` | `hook:after_tool_call` 注册处接线（仅 `pd-recall__pd_submit_pain` 分支，fail-open，不影响其余工具行为） |
| 5 | `packages/pd-mcp-server`、core、plugin 测试 | 按 Stage 4 矩阵 |
| 6 | `docs/` | 上游补丁卡（OpenClaw fork materializer 第四参数）+ 本报告 |
| 7 | changeset | openclaw-plugin / principles-core / pd-mcp-server 按包规则 |

不新建：身份系统、第二 receipt recovery、任务存储、队列、Worker、Scheduler。

## 5. 主路径（前置绑定）的诚实边界

- PD 消费端已就绪且经真实 MCP Server 进程测试验证（`_meta` → 首次写入即绑定）。
- OpenClaw 安装版 2026.11.5 的生产者缺口 = materializer 三参数调用（§2.2），且无插件可达扩展点（§2.3）→ **宿主级"正常路径 `_meta` 绑定"在本安装版不可达**，按工单要求明确标注；上游补丁（`t.callTool(u, d, s, { _meta: {...} })` + 运行时 sessionId 来源）作为后续任务交付，不在本 PR 内伪报。
- 回执兜底（Stage 2）在本安装版即真实常态路径：无 `_meta` → 合法 unbound（`host_session_claim_empty`）→ `after_tool_call` 结构化回执 → Core CAS 恢复原 Task。

## 7. 真实宿主 E2E 结果（2026-11-25，隔离安装 `PD_EXPERIMENT_ROOT`）

隔离环境：`OPENCLAW_STATE_DIR` + `PD_EXPERIMENT_ROOT` + `PD_WORKSPACE_DIR` 全部指向 worktree `.tmp/pri1276/`；
插件 payload 为本 worktree 生产构建；pd-recall launcher 经实验 binding 启动（launcher_start → startup → initialize）；
模型经宿主正常入口（embedded agent round）真实调用 `pd-recall__pd_submit_pain`。
取证探针插件（pd1276-probe）只记录 ids/shapes/codes（数据最小化）。

### 事件 envelope 实测（修正 §2.5 首读）

- `eventKeys = [durationMs, error, params, result, runId, toolCallId, toolName]`；ctx keys = `[agentId, runId, sessionId, sessionKey, toolCallId, toolName]`。
- `toolCallId = tool_call:chatcmpl-tool-…:pd-recall__pd_submit_pain:1`（真实执行上下文）；`ctxSessionId` 为真实 OpenClaw session UUID。
- `result.details = {mcpServer:'pd-recall', mcpTool:'pd_submit_pain'}`；`result.content[0].text` = 回执 JSON 本体（单层）。
- 工具命名实测 = `pd-recall__pd_submit_pain`（无 `mcp__` 前缀），与 §2.5 命名推导一致。

### 场景 B（缺失 metadata → 回执兜底恢复）— PASS

1. 正常入口提交：`"status":"submitted"`（无 `_meta`，首次写入合法 unbound）。
2. `after_tool_call` 兜底：`pain_receipt_recovered:taskId=diagnosis_mcp_…:state=ready_for_diagnosis`。
3. SQLite 读回（ws/.pd/state.db）：恰好 1 条 task；`sessionIdHint` = 真实 session UUID；
   `painIngress.verifiedHostSession.status = verified`；`recovery.receiptRef.toolCallId` = 真实宿主 toolCallId。

### 场景 C（安全负控）— PASS（真实进程 + 单测矩阵）

- 模型自报 session 与宿主 `_meta` 冲突 → `host_context_conflict`（真实进程测试）。
- 哨兵 session（`cli`）→ `host_context_invalid:host_context_v1_missing_session`（真实进程测试）。
- 错误 server id / `mcp__` 前缀拼写 / 冲突改名 → 工具名门拒绝（单测）。
- 同任务不同 toolCallId → `ambiguous_receipt`；重复同调用 → `already_bound`；异 hostKind → `task_host_kind_mismatch`（Core SQLite 测试）。

### 场景 D（授权关闭）— PASS

- Workspace 关闭 `host_identity_minimal_metadata` 后重跑真实轮次：提交合法落库，
  `pain_receipt_rejected:blocked_by_consent:stage=after_tool_call:unbound=true:taskId=…`；
  SQLite 读回：`sessionIdHint=null`、`recovery.state=blocked_by_consent`、`reason=minimal_identity_metadata_not_granted`、无 `receiptRef`（零回执元数据持久化）。

## 8. 验收状态

- 主路径（宿主级 `_meta` 前置绑定）：**BLOCKED on installed 2026.11.5**（生产者缺口，§2.2/§2.3）；
  MCP Server 进程级 PASS（5/5：预绑/无meta/冲突/哨兵/撤回）。
- 兜底路径（回执恢复）：**真实宿主 E2E PASS**（场景 B/D）。
- 总体：`PASS_WITH_LIMITATIONS`（限制 = 主路径需 OpenClaw runtime 生产者补丁，上游补丁卡交付）。

## 9. 隐私与授权审计（Stage 3）

- 授权面：唯一授权 = Workspace 级 `host_identity_minimal_metadata`（quiet flag），与
  conversation ingestion 授权**互相独立**；插件侧 per-event 重读（撤回下一事件即生效，场景 D 实证）；
  MCP Server 侧 per-request 重读（进程测试第 5 例实证）。两处关闭均为 fail-closed 且提交本身保持合法。
- 数据最小化（持久化面）：仅 `sessionId`、`toolCallId`（receiptRef 内）、painId/taskId、
  recovery disposition 与时间戳。**不持久化** prompt/reason/anchor 原文、完整工具输入输出、
  transcript、Gateway 私有历史（代码路径无此类读取；探针记录亦只含 ids/shapes/codes）。
- 读取面：兜底恢复唯一 store 读取 = 原 Task 行（`getTask`）+ 可选的目标轮文本探测
  （`listGovernanceConversationTextsForHostTurn` 精确 (session, turn)，consent-first；
  目标轮未知时该读取不发生）。无最近会话扫描、无 Gateway 内存/私有库访问。
- fail-open 契约：兜底任何失败/拒绝都不改变工具本已产生的结果；每条非 not_applicable
  结果输出一条 ids-only 结构化诊断行（reasonCode/stage/unbound/taskId）。

## 10. 上游补丁卡（OpenClaw runtime 生产者，后续任务）

主路径生产者缺口的最小修复（属于 OpenClaw runtime，Owner fork `csuzngjh/openclaw`；本仓库不含该代码）：

- **注入范围（CodeRabbit 评审轮修正）：仅限 PD 服务器 `pd-recall` 的 `pd_submit_pain` 调用**——
  materializer 同时服务其他 MCP 服务器，无条件注入会把 `sessionId`/`toolCallId` 泄露给无关服务器并使其可关联同一会话的调用；
  其他服务器/工具的调用保持原有参数不变。
- 调用点：`src/agents/agent-bundle-mcp-materialize.ts` 的 `invoke = () => t.callTool(serverName, toolName, args)`
  （安装态对应 `dist/agent-bundle-mcp-materialize-*.mjs:284`）→ 仅当 `(serverName, toolName)` 命中
  `(pd-recall, pd_submit_pain)` 时追加第四参数
  `t.callTool(serverName, toolName, args, { _meta: { 'pd.host-context.v1': { sessionId: runtime.sessionId, toolCallId } } })`，
  其余调用保持三参数形态。
- runtime `callTool` 已支持 `options._meta`（`dist/agents/agent-bundle-mcp-runtime.js:756`），无需改 runtime；
  `toolCallId` 仅在执行上下文真实可得时传入，否则省略；不得把 `sessionKey`/`runId` 写入 sessionId；
  不得覆盖请求已有的其他 `_meta` 字段（合并而非替换）。
- 消费端（pd-mcp-server + Core）已就绪并通过真实进程验收，生产者落地后主路径即刻生效，无需 PD 侧再改。
