# PD MCP 可观测性（日志）现状调查与落盘方案设计

> 本轮只读调查：未修改产品代码、未开 PR、未改动本机 PD 安装目录/真实配置。
> 证据标记：`[源码]` = 仓库源码；`[本机实测]` = 本开发机只读观测（不代表 Owner 机器）；`未找到` = 检索/读取后确实不存在。

---

## 0. 一句话结论

**MCP 现在没有"完善日志"。**

PD 侧只有一个**实时 stderr JSON 通道**：不落盘、无轮转、无体积上限、无请求级字段；launcher 在 `initialize` 之前失败时只写一行 stderr，**PD 侧零落盘**。宿主默认也不保留这行 stderr（Codex 需显式 `RUST_LOG`，OpenClaw 网关 stdout 未重定向，WorkBuddy 只记录自有 MCP apps）。因此 Owner 正常使用后，我们**无法事后拿到证据**判断 MCP 走到哪一步。

`SPEC-PD-MCP-GATE4-001 §10` 要求故障时能判断 6 件事（插件是否安装 / MCP 是否启动 / 工具是否发现 / 失败在哪阶段 / 是否需重启 / 是否可安全修复）。现状只能靠 `pd health` **静态推断**前两项，后四项无法事后回答——这是 **Intent Truth 与 Implementation Truth 的明确差距**（AGENTS.md §3.3）。

---

## 1. 现状差距表

| # | 能力 | 现状 | 证据 | 缺口 | 对 Owner 的影响 |
|---|---|---|---|---|---|
| 1 | stdout 协议纯净 | 已保证；src 内无 `console.log` | [logging.ts:2-9](../../packages/pd-mcp-server/src/logging.ts#L2-L9)、[index.ts:13-14](../../packages/pd-mcp-server/src/index.ts#L13-L14) | 无 | 无 |
| 2 | 结构化日志 | 每行一个 JSON 到 stderr | [logging.ts:28-47](../../packages/pd-mcp-server/src/logging.ts#L28-L47) | 只在 stderr，靠宿主留存 | Owner 不打开终端就看不到 |
| 3 | 持久化日志文件 | **未找到**：`pd-mcp-server/src` 无任何文件写入；`~/.pd/logs` 仅有 `manual-console.log` | 源码 grep `writeFile/appendFile/createWriteStream` 0 命中；[install-layout.ts:57](../../packages/create-principles-disciple/src/update/install-layout.ts#L57) 虽定义 `logsDir` | 没有 MCP 日志文件 | 无法离线打包、无法回溯 |
| 4 | 轮转/体积上限 | **未找到**（PD 侧无文件） | — | 无上限、无保留策略 | 要么没有，要么将来无限增长 |
| 5 | 进程生命周期 | 仅 `startup` / `startup_binding_failed` / `transport_closed` / `shutdown_begun` | [index.ts:39-44,56,65-68](../../packages/pd-mcp-server/src/index.ts#L39-L68)、[server.ts:240-243](../../packages/pd-mcp-server/src/server.ts#L240-L243) | 无 `initialize`、无 `tools/list`、无退出码/uptime | 无法区分"握手失败"与"模型没调用" |
| 6 | `startup` 的证明力 | `startup` 在 `connect()` **之前**打印 | [index.ts:56](../../packages/pd-mcp-server/src/index.ts#L56) 对比 [index.ts:60](../../packages/pd-mcp-server/src/index.ts#L60) | 有 `startup` 不等于握手成功 | 现有日志会给出错误的"已启动"印象 |
| 7 | 单次工具调用字段 | 只有 `durationMs` + `resultKind:'envelope'` | [server.ts:193-198](../../packages/pd-mcp-server/src/server.ts#L193-L198) | 无 request id、工具名、入参摘要、status、错误码、响应字节、截断/超预算、三源状态 | 无法判断"调用成功但数据 partial" |
| 8 | 绑定解析上下文 | 只记 `host` + `workspaceFingerprint` | [index.ts:48-56](../../packages/pd-mcp-server/src/index.ts#L48-L56) | 无 binding 路径/指纹、schema 版本、workspace 是否存在、runtime/entry 指纹 | 无法证明"绑定到了哪个工作区/哪份运行时" |
| 9 | launcher 启动前失败 | 只写一行 stderr `{launcher,status,reason,nextAction}` 后 exit 1 | [launcher.cjs:63-66](../../packages/openclaw-plugin/mcp/launcher.cjs#L63-L66) | 无时间戳、版本、host、pid；**无落盘** | 安装/绑定坏掉时，事后无痕迹 |
| 10 | 错误分类 | `sanitizeErrorKind`（仅 error.name） | [logging.ts:20-26](../../packages/pd-mcp-server/src/logging.ts#L20-L26) | 无稳定错误码体系 | 只能看到类名，无法聚合 |
| 11 | 隐私 | 白名单只允许标量；不记正文/路径/token | [logging.ts:43-45](../../packages/pd-mcp-server/src/logging.ts#L43-L45)、[index.ts:48-55](../../packages/pd-mcp-server/src/index.ts#L48-L55) | 无通用脱敏器；`envVar`/`nextAction` 属"自由文本"但当前安全 | 未来新增字段容易越界 |
| 12 | 日志失败隔离 | 无文件写入；stderr 写入未包 try/catch | [logging.ts:29-31](../../packages/pd-mcp-server/src/logging.ts#L29-L31) | stderr EPIPE 可能变成进程级异常 | 极端情况下日志反过来影响服务 |
| 13 | CLI 查日志/导出 | **无 `pd logs`**；`pd health` 只做静态检查，明确不 spawn server；`pd diagnostics export` 不含 MCP 日志 | [index.ts:253](../../packages/pd-cli/src/index.ts#L253)、[health-mcp.ts:16-20,90-91](../../packages/pd-cli/src/commands/health-mcp.ts#L16-L91)、[runtime-diagnostics-export.ts:87-178](../../packages/pd-cli/src/commands/runtime-diagnostics-export.ts#L87-L178) | 没有"收日志"的入口 | Owner 无法一键把证据发给我们 |
| 14 | 时间戳时区 | `new Date().toISOString()` 只有 UTC `Z` | [logging.ts:36](../../packages/pd-mcp-server/src/logging.ts#L36) | 无本地偏移字段 | 跨时区对齐困难 |
| 15 | 宿主交叉证据 | 存在但**不稳定/默认不保留 PD stderr** | 见 §2.8 [本机实测] | Codex 需 `RUST_LOG`；OpenClaw 无 stdout 留存；WorkBuddy 只记自有 apps | 不能把宿主日志当作默认兜底 |

---

## 2. 现状事实（逐项，含路径与行号）

### 2.1 MCP server 进程日志写到哪里

| 通道 | 写什么 | 证据 |
|---|---|---|
| stdout | **只允许** MCP 协议消息；模块明确"never console.log" | [index.ts:13-14](../../packages/pd-mcp-server/src/index.ts#L13-L14)；src 内 `console.log/info/debug` 仅命中该注释，无实际调用 |
| stderr | 每行一个 JSON：`ts/server/version/level/event` + 白名单标量字段；默认 sink 直接 `process.stderr.write` | [logging.ts:28-31](../../packages/pd-mcp-server/src/logging.ts#L28-L31)、[logging.ts:33-47](../../packages/pd-mcp-server/src/logging.ts#L33-L47) |
| 文件 | **未找到**。`packages/pd-mcp-server/src` 内无 `writeFile/appendFile/createWriteStream/mkdir` | 源码检索 0 命中 |

补充：`SPEC §5.3` 明确"所有日志、调试和诊断写入 stderr 或 PD 既有日志设施"（[SPEC:551-561](../../docs/archive/specs/SPEC-PD-MCP-GATE4-001.md#L551-L561)）。所以 stderr 是**合规**的，但**不可事后采集**；SPEC 并未要求"仅 stderr"。

`SPEC §10` 同时规定了日志**禁止**记录的内容（Pain 原文、证据正文、API Key、环境变量值、完整数据库路径、完整 Tool Result、异常堆栈）和**允许**记录的内容（时间、版本、宿主、请求阶段、耗时、结果类别、错误类别）——[SPEC:1008-1026](../../docs/archive/specs/SPEC-PD-MCP-GATE4-001.md#L1008-L1026)。

### 2.2 是否有持久化日志文件：轮转、上限、默认开关

- 安装布局里确实有 `logsDir`（`<home>/logs`），但不是 MCP 日志设施：[install-layout.ts:57](../../packages/create-principles-disciple/src/update/install-layout.ts#L57)。
- [本机实测] `~/.pd/logs/` 下只有 `manual-console.log`（259 bytes）。内容是一次 `pd-console` 的运行 stdout 采集：`Listening on ...`、`Workspace: <完整路径>`、`Console exited with code 4294967295`。它证明 PD 确实存在"把进程 stdout 写文件"的临时做法，但**不是** MCP 日志设施：无时间戳、无轮转、无上限、只覆盖 Console，且记录了完整工作区路径。`~/.pd/logs/mcp/` **不存在**。
- 更新历史 `history.jsonl` 是追加式、无轮转（[update-history.ts:99-110](../../packages/create-principles-disciple/src/update/update-history.ts#L99-L110)），与 MCP 无关。
- **未找到**任何 MCP 日志轮转、体积上限、保留天数、默认开关。

### 2.3 一次工具调用被记录了哪些字段

现有事件（全部来自 [server.ts](../../packages/pd-mcp-server/src/server.ts)）：

| 事件 | 触发点 | 现有字段（除公共字段外） | 行号 |
|---|---|---|---|
| `tool_call_refused_shutting_down` | 关闭中拒绝 | `durationMs` | [146](../../packages/pd-mcp-server/src/server.ts#L146) |
| `tool_call_refused_saturated` | 并发上限拒绝 | `durationMs, active, max` | [150-154](../../packages/pd-mcp-server/src/server.ts#L150-L154) |
| `tool_call_completed` | 正常返回 | `durationMs, resultKind:'envelope'` | [196](../../packages/pd-mcp-server/src/server.ts#L196) |
| `tool_call_over_budget` | 响应 > 32 KiB | `durationMs, bytes, budget` | [200](../../packages/pd-mcp-server/src/server.ts#L200) |
| `failure_envelope_over_budget` | 失败壳也超预算（理论不可达） | 无 | [208](../../packages/pd-mcp-server/src/server.ts#L208) |
| `tool_call_unexpected_exception` | 非预期异常 | `durationMs, errorKind` | [214](../../packages/pd-mcp-server/src/server.ts#L214) |
| `tool_call_deadline_exceeded` | 超过 10s | `durationMs, deadlineMs, active, orphans` | [224-229](../../packages/pd-mcp-server/src/server.ts#L224-L229) |

公共字段：`ts, server, version, level, event` + 构造时的 `host`（[server.ts:124](../../packages/pd-mcp-server/src/server.ts#L124)、[logging.ts:35-41](../../packages/pd-mcp-server/src/logging.ts#L35-L41)）。

**明确缺失**（Owner 关心的字段）：

- 请求 id / JSON-RPC id：无。
- 工具名：无（只有单一工具 `pd.recall_principle_pains`，但日志里看不出被调用的工具）。
- 入参摘要（`principleId`、`limit`）：无。
- 返回状态（`ok/partial/not_found/unavailable/invalid_input`）：**无**。`resultKind:'envelope'` 只说明"组装成功"，不说明 envelope 内 `status`。
- 错误码（`error.code`）：无。异常只记 `errorKind`。
- 响应字节数：只在**超预算**时记 `bytes`；正常成功不记。
- 是否截断：不适用（设计为超预算整体 withhold，不截断：[server.ts:199-210](../../packages/pd-mcp-server/src/server.ts#L199-L210)）。
- 三源状态（ledger / trajectoryDb / stateDb）：无。

### 2.4 有没有把绑定解析结果、三源状态、binding 是否存在记进日志

- 绑定解析：server 只记 `host` + `workspaceFingerprint`（[index.ts:48-56](../../packages/pd-mcp-server/src/index.ts#L48-L56)）。`resolveWorkspaceBinding` 的失败原因只写 stderr（[workspace.ts:39-87](../../packages/pd-mcp-server/src/workspace.ts#L39-L87)），成功时**不记录** binding 文件路径、schema 版本、runtime/entry 指纹、workspace 是否存在。
- 三源状态：能力返回的 `provenance.sources` 含每个来源的状态（[pain-recall-capability.ts](../../packages/principles-core/src/runtime-v2/pain-recall-capability.ts) 的 `provenance.sources`），但 server 在 `tool_call_completed` 时**只记 `resultKind`**，不记 sources。
- `pd health` 会计算 binding/config/entry 状态（[health-mcp.ts:587](../../packages/pd-cli/src/commands/health-mcp.ts#L587)），但这些结果**不进入任何日志**，也不会在故障后自动留存。

### 2.5 最重点：launcher 在 `initialize` 之前失败，PD 侧有无落盘痕迹

**结论：没有任何落盘痕迹。只有一行 stderr；若宿主不保留 stderr，就等于零证据。**

`launcher.cjs` 的失败出口统一为 `fail(reason, nextAction)`：

```js
// launcher.cjs:63-66
function fail(reason, nextAction) {
  process.stderr.write(JSON.stringify({ launcher: 'pd-mcp', status: 'failed', reason, nextAction }) + '\n');
  process.exit(1);
}
```

该行**没有**时间戳、launcher 版本、host、pid、Node 版本，也**不写文件**。覆盖的启动前失败形态（全部在 `initialize` 之前）：

| reason | 含义 | 行号 |
|---|---|---|
| `host_marker_missing` / `host_marker_ambiguous:*` | 宿主 payload 标记缺失/歧义 | [175-180](../../packages/openclaw-plugin/mcp/launcher.cjs#L175-L180) |
| `binding_missing` | 未运行 setup，无 `mcp-binding.json` | [186-190](../../packages/openclaw-plugin/mcp/launcher.cjs#L186-L190) |
| `binding_unreadable` / `binding_invalid` | JSON 坏/形状非法 | [191-199](../../packages/openclaw-plugin/mcp/launcher.cjs#L191-L199) |
| `binding_schema_unsupported:*` | 插件与安装代际不一致 | [200-207](../../packages/openclaw-plugin/mcp/launcher.cjs#L200-L207) |
| `binding_host_invalid` / `binding_host_mismatch:*` | 绑定属于别的宿主 | [208-215](../../packages/openclaw-plugin/mcp/launcher.cjs#L208-L215) |
| `binding_workspace_invalid` / `binding_runtime_dir_invalid` / `binding_server_entry_invalid` | 绑定字段非绝对路径 | [216-224](../../packages/openclaw-plugin/mcp/launcher.cjs#L216-L224) |
| `binding_versions_invalid` | 版本字段非法 | [225-227](../../packages/openclaw-plugin/mcp/launcher.cjs#L225-L227) |
| `server_entry_not_canonical:*` | entry 不在规范布局 | [229-234](../../packages/openclaw-plugin/mcp/launcher.cjs#L229-L234) |
| runtime/entry/package 校验失败（`runtime_dir_missing`、`server_entry_missing`、`package_identity_mismatch`、`runtime_pin_mismatch` 等） | 运行时未安装/被替换/版本漂移 | [236-325](../../packages/openclaw-plugin/mcp/launcher.cjs#L236-L325) |
| `binding_workspace_missing` / `binding_workspace_not_directory` | 工作区被移动/删除 | [288-296](../../packages/openclaw-plugin/mcp/launcher.cjs#L288-L296) |
| `workspace_declaration_missing` / `binding_workspace_not_declared` | OpenClaw 未声明工作区 | [307-324](../../packages/openclaw-plugin/mcp/launcher.cjs#L307-L324) |
| `server_entry_invalid` / `server_startup_failed:<ErrorName>` | `import()` 失败或 `main()` 抛错的同步阶段 | [333-346](../../packages/openclaw-plugin/mcp/launcher.cjs#L333-L346) |

server 侧的启动失败（绑定环境变量无效）也只有 stderr：`startup_binding_failed`（[index.ts:39-44](../../packages/pd-mcp-server/src/index.ts#L39-L44)），同样不落盘。

[本机实测] 宿主是否保留了这些 stderr：

- Codex：`~/.codex/logs_2.sqlite` 共 **34,440** 行日志，含 `codex_mcp::connection_manager::tool_catalog` 等 MCP 生命周期 target。其中 `feedback_log_body` 含 `pd-recall` 的有 **11** 行（例如 `omitting MCP server without an exact ready client server_name=pd-recall`），但含 `pd-mcp-server` / `MCP server stderr` 的行数为 **0**。老式 `~/.codex/log/codex-tui.log` 最后写入 2026-05-24，非当前通道。Gate-4 验收矩阵也写明只有 `RUST_LOG=rmcp_client=info` 时才捕获 `MCP server stderr`（[矩阵:40](../../docs/reports/PD_MCP_GATE4_HOST_ACCEPTANCE_MATRIX.md#L40)）。
- OpenClaw：`~/.openclaw/gateway.cmd` 启动 node 网关时**没有重定向 stdout/stderr**；`%TEMP%\openclaw\launcher.log` 只记录尝试/退出码；`~/.openclaw/logs/gateway-restart.log` 只记录重启动作；最近 7 天日志中未匹配到 `pd-recall`/`pd-mcp`。
- WorkBuddy：`~/.workbuddy/logs/mcp-apps-diag.log`（当前约 1.0 MB，`.old` 约 10 MB，观测到 ~10 MB 轮转）只记录自有 MCP apps；`logs/mcp-runtime/` 下只有 `builtin_ardot-*`；最近 3 天日志中未匹配到 `pd-recall`/`pd-mcp`/`launcher.cjs`。

> 注意：以上是本**开发机**的只读观测。Owner 机器上的宿主日志格式/保留策略由宿主决定，PD 不能假设它一定存在。

### 2.6 隐私与安全：现在日志会不会泄露敏感内容

**当前实现是"按构造脱敏"，没有通用脱敏器。**

- 白名单：只接受 `string | number | boolean`，对象/数组/异常对象不会进入日志（[logging.ts:13-14,43-45](../../packages/pd-mcp-server/src/logging.ts#L13-L45)）。
- 不记路径：工作区只以 `sha256` 前 16 位指纹出现（[index.ts:48-55](../../packages/pd-mcp-server/src/index.ts#L48-L55)）。
- 异常只记 `name`，且清洗为 `[A-Za-z0-9_-]`、截断 60（[logging.ts:20-26](../../packages/pd-mcp-server/src/logging.ts#L20-L26)）。
- launcher 对 `schemaVersion` 和错误名做同样的有界清洗（[launcher.cjs:203-205](../../packages/openclaw-plugin/mcp/launcher.cjs#L203-L205)、[launcher.cjs:344-346](../../packages/openclaw-plugin/mcp/launcher.cjs#L344-L346)）。
- 不记 Pain 原文、原则正文、Tool Result、token、环境变量值。

**反例（既有设施）**：`~/.pd/logs/manual-console.log` 直接记录了完整工作区路径（`Workspace: D:\.openclaw\workspace`）。这说明 PD 现有日志设施没有统一脱敏约定；MCP 日志必须坚持"指纹而非路径"的白名单。

**但存在两个结构性风险：**

1. `startup_binding_failed` 记录了 `envVar`、`reason`、`nextAction`（[index.ts:39-44](../../packages/pd-mcp-server/src/index.ts#L39-L44)）。这三个是固定/白名单文本，目前安全；但它们绕过了"scalar-only"的语义白名单，未来若有人在 `reason` 中拼入路径就会泄露。
2. stderr 写入没有 `try/catch`（[logging.ts:29-31](../../packages/pd-mcp-server/src/logging.ts#L29-L31)）。宿主提前关闭 stderr/管道时，写入可能触发流错误；当前没有任何保护。**这是"日志反过来影响服务"的真实风险点**（目前因只写 stderr，影响面小于文件写入，但并非零）。

### 2.7 现有 CLI 有没有查日志/导出日志的入口

- `pd health`：存在。注册于 [index.ts:253](../../packages/pd-cli/src/index.ts#L253) → [health.ts:363](../../packages/pd-cli/src/commands/health.ts#L363)；支持 `--host codex|openclaw|workbuddy`（[health.ts:371](../../packages/pd-cli/src/commands/health.ts#L371)、[health.ts:386](../../packages/pd-cli/src/commands/health.ts#L386)）；输出含 `mcp` 段（[health.ts:207](../../packages/pd-cli/src/commands/health.ts#L207)）。
- **但它是静态检查**：明确 "never executes the MCP server or a business Tool (no probe is spawned)"（[health-mcp.ts:16-20](../../packages/pd-cli/src/commands/health-mcp.ts#L16-L20)），`probe.performed` 恒为 `false`（[health-mcp.ts:90-91](../../packages/pd-cli/src/commands/health-mcp.ts#L90-L91)、[health-mcp.ts:581](../../packages/pd-cli/src/commands/health-mcp.ts#L581)）。它读安装态、binding、宿主配置、rollout 文件，**不读任何 MCP 运行日志**。
- `pd logs`：**未找到**（[index.ts](../../packages/pd-cli/src/index.ts) 命令注册中无 `logs`）。
- `pd diagnostics export`：存在（[index.ts:930](../../packages/pd-cli/src/index.ts#L930)），但导出物只含 lock/lease、ledger 摘要、state DB alerts、最近 rollout 文件（[runtime-diagnostics-export.ts:87-178](../../packages/pd-cli/src/commands/runtime-diagnostics-export.ts#L87-L178)），**不含 MCP 日志**。
- `pd runtime health snapshot` 是 Runtime V2 任务链健康，不是 MCP。

### 2.8 宿主侧能看到什么（交叉证据）

| 宿主 | 日志位置/格式 | 能看到 | 看不到 / 限制 | 证据 |
|---|---|---|---|---|
| Codex | `~/.codex/logs_2.sqlite`（表 `logs`：`ts/level/target/feedback_log_body`）；旧 `~/.codex/log/codex-tui.log` | MCP 连接管理/tool catalog 生命周期（如 `codex_mcp::connection_manager::tool_catalog`）；spawn/ready 判定；本机有 11 行提到 `pd-recall`（含 omitting/ready 类记录） | 默认**不保留 server stderr**；需 `RUST_LOG=rmcp_client=info`；本机 34,440 行中 0 行含 `pd-mcp-server`/`MCP server stderr` | [矩阵:40](../../docs/reports/PD_MCP_GATE4_HOST_ACCEPTANCE_MATRIX.md#L40) + [本机实测] |
| Codex 会话 | `~/.codex/sessions/**/rollout-*.jsonl` | 模型实际发起的 tool call（若发生） | 本机最近 5 个 rollout 未匹配 `pd_recall_principle_pains`/`mcp_tool_call`；不能证明"工具被调用" | [本机实测] |
| OpenClaw | `%TEMP%\openclaw\launcher.log`（尝试/退出码）；`~/.openclaw/logs/gateway-restart.log` | 网关是否被拉起/退出 | 网关 stdout 未重定向；插件 `[PD:health]` 只进网关日志；最近 7 天无 `pd-recall` 匹配 | [mcp-binding.ts](../../packages/openclaw-plugin/src/core/mcp-binding.ts) + [本机实测] |
| WorkBuddy | `~/.workbuddy/logs/main.log`、`mcp-apps-diag.log`（~10 MB 轮转）、`mcp-runtime/` | 宿主自有 MCP apps 诊断 | 不覆盖 pd-recall；最近 3 天无 `pd-recall`/`pd-mcp` 匹配 | [本机实测] |

**边界结论**：宿主日志是**补充证据**，不是兜底证据。PD 不能把"判断 MCP 是否工作"建立在宿主是否恰好开了某个环境变量上。

---

## 3. 方案设计（不实现）

### 3.1 设计原则

1. **真实使用即产生证据**：默认开启，不需要 Owner 手工设开关。
2. **单目录、可打包**：所有 MCP 事件只写一个目录；打包脚本只读该目录。
3. **日志绝不改变服务语义**：写入异常全部吞掉；stdout 协议纯净性不变；stderr 行为保留（便于宿主实时看）。
4. **白名单字段**：事件字段固定；不记录业务正文、路径、环境变量值。
5. **失败也要留痕**：launcher 校验失败、server 绑定失败、进程崩溃路径都要先落盘再退出。
6. **不新增事实源**：日志是**派生证据**，不是 ledger/state 的权威；不新增 DB、不新增持久配置。

### 3.2 落盘位置、命名、轮转、上限、开关

| 项 | 设计 |
|---|---|
| 目录 | `~/.pd/logs/mcp/`（Windows：`%USERPROFILE%\.pd\logs\mcp\`）。复用安装布局已有的 `logsDir` 父目录（[install-layout.ts:57](../../packages/create-principles-disciple/src/update/install-layout.ts#L57)），不新建顶层路径 |
| 文件 | 每进程一个文件：`mcp-<host>-<pid>-<YYYYMMDDTHHmmssZ>.jsonl`；`host` ∈ `codex|openclaw|workbuddy|unknown` |
| 格式 | JSONL：一行一个完整 JSON；`runId`（8 hex）标识本次进程，`seq` 单调递增 |
| 时间 | `ts` = 带数字偏移的 RFC3339（如 `2026-11-05T20:15:00.123+08:00`），另加 `tzOffsetMinutes`；不再只用 `Z` |
| 单文件上限 | **2 MiB**；达到上限后关闭当前文件并新建 `...-2.jsonl`（每进程最多 3 个分片，之后丢弃并计数） |
| 目录总量上限 | **64 MiB**；启动时若超限，只删除**匹配 `mcp-*.jsonl` 且最旧**的 PD 自有文件，直到低于上限 |
| 保留 | **14 天**；启动时尽力清理超过 14 天的 `mcp-*.jsonl`（只删本目录、只删匹配前缀） |
| 默认开关 | **默认开启**；`PD_MCP_LOG=0|false|off` 关闭；`PD_MCP_LOG_DIR` 仅用于测试/隔离覆盖 |
| 权限 | 尽力 `mode 0600`（Windows 上退化为当前用户默认 ACL；不做复杂 ACL 操作） |
| 并发 | 一进程一文件，避免多宿主多进程并发追加同一文件；收集脚本按目录聚合 |

**不新增**持久配置项、feature flag 注册表项或数据库表。

### 3.3 事件清单

公共字段（每条都有）：`ts, tzOffsetMinutes, runId, seq, event, level, server, version, host, pid`。

| 事件 | 触发点 | 专有字段 | 敏感内容 |
|---|---|---|---|
| `launcher_start` | launcher 完成宿主标记探测后、读 binding 前 | `launcherVersion, nodeVersion, platform, arch, ppid, hostMarkerCount, argsCount, envPresence{PD_MCP_WORKSPACE_DIR,PD_MCP_HOST,PD_WORKSPACE_DIR,OPENCLAW_WORKSPACE}`（**仅布尔**） | 无。不含 cwd、参数值 |
| `launcher_validated` | 所有校验通过、`import()` 前 | `host, workspaceFingerprint, runtimeDirFingerprint, serverEntryFingerprint, bindingSchemaVersion, bindingHost, mcpServerVersion, coreVersion, workspaceExists:true` | 指纹非路径 |
| `startup_failure` | launcher `fail()` | `stage:'launcher', reason, reasonDetail, nextAction, host|null` | `reasonDetail` 白名单清洗、≤80；`reason` 为闭合枚举 |
| `startup`（复用现有事件名，扩字段） | server 绑定成功后 | `host, workspaceFingerprint, nodeVersion` | 指纹非路径 |
| `binding_rejected` | `resolveWorkspaceBinding` 失败 | `envVar, reasonCategory:'invalid_binding', reasonCode`（把自由文本 `reason` 改为稳定码） | 不含路径/值 |
| `initialize` | 收到 `initialize` 请求 | `requestId, clientName（清洗≤40）, clientVersion（清洗≤40）, protocolVersion, capabilityKeysCount` | 客户端名/版本非敏感，但需清洗 |
| `initialize_response` | 发出 `initialize` 响应 | `requestId, ok, errorCode, responseBytes` | 无 |
| `tools_list` | 收到 `tools/list` | `requestId, protocolVersion` | 无 |
| `tools_list_response` | 发出响应 | `requestId, toolCount, responseBytes` | 无 |
| `tool_call_start` | 收到 `tools/call` | `requestId, toolName（白名单，未知则 unknown）, principleIdHash（sha256 前 12）, principleIdLen, limit` | 不记 `principleId` 原文 |
| `tool_call_completed` | 正常/失败响应前 | `requestId, durationMs, status, errorCode, isError, responseBytes, sourceLedger, sourceTrajectoryDb, sourceStateDb（ok|missing|unreadable|not_checked）, truncated, unresolvedCount` | 无 |
| `tool_call_over_budget` | >32 KiB | `requestId, durationMs, bytes, budget` | 无 |
| `tool_call_deadline_exceeded` | >10s | `requestId, durationMs, deadlineMs, active, orphans` | 无 |
| `tool_call_unexpected_exception` | 非预期异常 | `requestId, durationMs, errorKind` | 无 |
| `tool_call_refused_saturated` | 并发上限 | `requestId, durationMs, active, max` | 无 |
| `tool_call_refused_shutting_down` | 关闭中 | `requestId, durationMs` | 无 |
| `shutdown` | stdin 关闭 / 正常退出 | `reason:'stdin_closed', orphans, active, uptimeMs, exitCode` | 无 |
| `log_write_failed` | 写入失败（尽力） | `droppedEvents, errorKind` | 无；若自身也写不进去则彻底静默 |

**采集 `initialize` / `tools/list` 的机制（设计，需验证）**：SDK 2.4.0 的 `StdioServerTransport` 公开 `onmessage` 与 `send`（`node_modules/@modelcontextprotocol/server/dist/stdio.d.mts`）。在 `new StdioServerTransport()` 之后、`connect()` 之前，用属性描述符包一层：入站只读 `method`/`id`，出站只读 `id`/`isError`/`error.code`/字节数，**不改写消息、不额外发送、不写 stdout**。这样无需改动 SDK，也不影响协议。

**status 的来源**：在 `assembleResult` 之前直接从 capability envelope 读取 `status`/`error.code`/`provenance.sources`（能力已返回这些字段；[pain-recall-capability.ts](../../packages/principles-core/src/runtime-v2/pain-recall-capability.ts)），只提取枚举与计数，不记录正文。

### 3.4 日志失败隔离（硬约束）

- `emit(event)` 只做：序列化到内存缓冲（上限 200 行 / 256 KiB）→ `setImmediate(flush)`；**不 await、不抛异常**。
- `flush()`：`appendFileSync` 包 `try/catch`；失败则丢弃该批、`droppedEvents += n`；下一次成功 flush 时写一条 `log_write_failed`（该条失败则静默）。
- `flushSync()` 仅用于 `startup_failure` / `shutdown` / 进程退出前；同样 `try/catch`，失败也继续退出。
- 所有路径（launcher/server）都**不得**因为日志失败改变退出码、返回值或 stdio 内容。
- stderr 保留现有行为；新增 `stderr` 写入的 `try/catch`（修掉 EPIPE 风险，[logging.ts:29-31](../../packages/pd-mcp-server/src/logging.ts#L29-L31)）。
- 明确测试：日志目录不可写/`fs` 抛错时，工具调用仍返回正常 envelope，stdout 仍只有协议消息。

### 3.5 采集方式（Owner 在自己机器上执行）

**目标形态（随实现提供）**：

```powershell
pd mcp logs export --days 7 --out "$env:USERPROFILE\Desktop\pd-mcp-evidence.zip"
```

行为：只读 `~/.pd/logs/mcp`，按 `LastWriteTime` 取最近 N 天；总量上限 20 MiB；生成 `manifest.json`（导出时间/时区、N、文件清单、OS、Node 版本、PD 版本）+ 原始 JSONL；输出单个 zip。离线可读，不需要联网、不读工作区业务库。

**在命令实现前，Owner 可先用的等价脚本（PowerShell 7+，Windows 自带 `Compress-Archive`）**：

```powershell
$src = Join-Path $env:USERPROFILE '.pd\logs\mcp'
$cut = (Get-Date).AddDays(-7)
$dst = Join-Path $env:TEMP ("pd-mcp-evidence-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $dst | Out-Null
$files = Get-ChildItem $src -Filter 'mcp-*.jsonl' -File -ErrorAction SilentlyContinue |
         Where-Object { $_.LastWriteTime -ge $cut } | Sort-Object LastWriteTime
$total = 0
foreach ($f in $files) {
  if ($total -ge 20MB) { break }
  Copy-Item $f.FullName $dst -ErrorAction SilentlyContinue
  $total += $f.Length
}
[ordered]@{
  generatedAt = (Get-Date).ToString('o')
  days        = 7
  source      = $src
  timezone    = (Get-TimeZone).Id
  os          = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
  node        = (node -v 2>$null)
  files       = @(Get-ChildItem $dst -Filter '*.jsonl' | Select-Object Name, Length)
} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $dst 'manifest.json') -Encoding UTF8
Compress-Archive -Path (Join-Path $dst '*') -DestinationPath "$dst.zip" -Force
Write-Output "已生成：$dst.zip"
```

输出体积上界：≤ 20 MiB 原始 + zip 压缩；时间戳在每行内（本地偏移），`manifest.json` 另带时区 ID。

### 3.6 判定指引表（Owner 一眼看出停在哪一步）

前提：日志目录里有本次运行的 `mcp-*.jsonl`（没有则见最后一行）。

| 观察到的最后事件 / 组合 | 结论 | 下一步 |
|---|---|---|
| **没有任何 `launcher_start`**，且宿主日志也没有该 server 的 spawn/ready 记录 | 宿主**从未尝试拉起** launcher：未注册 MCP / 插件未启用 / 宿主未重启 / Node 不可用 | 先 `pd health --host <host>`；确认宿主 MCP 配置与插件启用；重启宿主 |
| **没有任何 `launcher_start`**，但宿主日志有该 server 的 `omitting ... without an exact ready client`（Codex 示例） | 宿主尝试了但**没有 ready client**：spawn 失败/握手失败，PD 侧又没落盘 | 打开宿主 stderr 捕获（Codex：`RUST_LOG=rmcp_client=info`）；否则无法进一步定位 |
| 有 `launcher_start`，无 `startup_failure`，无 `startup` | launcher 卡住（`import()` 挂起/宿主杀进程）或日志写入失败 | 看宿主日志是否有 spawn/kill；检查 Node 版本 |
| 有 `startup_failure` | 启动前就失败；按 `reason` 直接定位 | `binding_missing`→重跑 setup；`runtime_dir_missing` / `server_entry_missing`→运行时未安装；`binding_workspace_missing`→工作区被移动；`binding_version_mismatch` / `runtime_pin_mismatch` / `binding_versions_invalid`→版本漂移；`host_marker_missing`→重装插件 |
| 有 `startup`，**无 `initialize`** | 进程起来了，但**握手没发生**：宿主没发 initialize / 协议版本不兼容 / transport 未启动 / 宿主超时杀进程 | 查宿主侧 MCP 错误；确认宿主支持该协议版本；重启宿主 |
| 有 `initialize`，无 `initialize_response` | 握手请求到了但响应没发出：SDK/协议失败或进程被杀 | 查宿主超时/协议版本；看是否有 `shutdown` 前异常 |
| 有 `initialize_response`，无 `tools_list` | 宿主没请求工具目录：延迟发现/缓存/工具被过滤/权限提示未确认 | 检查宿主工具目录与信任设置；重启 |
| 有 `tools_list`，无 `tool_call_start` | **MCP 正常，模型没调用**（不是 MCP 故障） | 检查提示词/模型是否选择该工具；属宿主/模型侧 |
| 有 `tool_call_start`，无完成事件，随后 `shutdown`/无后续 | 调用中被杀/宿主退出/进程崩溃 | 看宿主 kill 原因与退出码 |
| `tool_call_completed status=ok` | 正常 | 无 |
| `tool_call_completed status=partial` | 调用成功但**数据关联不完整**（部分来源 missing/unreadable/not_checked） | 看 `sourceLedger/sourceTrajectoryDb/sourceStateDb` 哪个非 `ok`；跑 `pd health` |
| `tool_call_completed status=no_matches` | 调用成功，但当前条件下没有匹配的 Pain | 正常业务结果，不是 MCP 故障 |
| `tool_call_completed status=not_found` | 调用到达，但该 `principleId` 无数据 | 属业务数据问题，不是 MCP 故障 |
| `tool_call_completed status=unavailable` + `errorCode=source_missing` | 工作区数据源缺失/绑定错工作区 | 核对 `workspaceFingerprint` 与 `pd health` 的 workspace |
| `status=unavailable` + `errorCode=disclosure_assertion_failed` | 披露断言失败 | 查 envelope 约束与数据源 |
| `status=invalid_input` | 模型传参不符合 schema | 检查模型输入；MCP 链路正常 |
| `tool_call_over_budget` | 响应 > 32 KiB，被整体扣留（非截断） | 数据异常膨胀，查 ledger/trajectory 数据量 |
| `tool_call_deadline_exceeded` | >10s 或并发拥塞 | 看数据源大小、磁盘、并发 |
| `tool_call_refused_saturated` | 并发上限 | 正常保护；降低并发或重试 |
| `transport_closed` / `shutdown` | 宿主关闭 stdin，正常退出 | 无 |
| 有日志文件但没有本次时间段的记录 | 日志目录被清理/副本不是当前 Owner 机器 | 重新采集最近 N 天 |

**一句话判定链**：`launcher_start` → `startup` → `initialize` → `initialize_response` → `tools_list` → `tool_call_start` → `tool_call_completed`。**链条断在哪一环，问题就在哪一环**。

### 3.7 PD 侧不可控的边界（必须标明）

| 现象 | 为什么 PD 记不到 | 只能靠谁 |
|---|---|---|
| launcher.cjs 根本没被执行 | 插件未安装/未启用/宿主未 spawn/Node 缺失，PD 代码不在进程里 | 宿主配置、安装器、宿主日志 |
| 宿主拒绝/过滤 MCP server | 宿主在启动前就拒绝（信任提示、allowlist、tool catalog 过滤） | 宿主日志/UI |
| 宿主 kill 进程（OOM/配额） | 非优雅退出，PD 来不及 flush | 宿主日志/退出码 |
| 握手失败的**具体错误文本** | SDK 内部处理；PD 只看到入站 initialize | 宿主 `RUST_LOG`/MCP 日志 |
| 模型是否真的看到工具定义 | PD 只能看到 `tools_list` 请求 | 宿主/模型侧 |
| 宿主日志的格式/保留/轮转 | 宿主自有策略（Codex sqlite、OpenClaw 临时日志、WorkBuddy 10 MB 轮转） | 宿主 |
| 日志目录被用户删除/清理 | PD 无法阻止 | Owner/系统清理工具 |

### 3.8 实施点（供后续单独排期，不在本轮）

| 文件 | 改动性质 |
|---|---|
| `packages/pd-mcp-server/src/logging.ts` | 新增文件 sink（缓冲/轮转/上限/吞异常）、`ts` 带偏移、`runId/seq` |
| `packages/pd-mcp-server/src/index.ts` | transport 包层（initialize/tools_list/initialize_response）、`startup` 扩字段、`binding_rejected` 稳定码 |
| `packages/pd-mcp-server/src/server.ts` | `tool_call_start/completed` 增加 requestId/status/errorCode/bytes/sources |
| `packages/openclaw-plugin/mcp/launcher.cjs` **及另外两份字节一致副本** | `launcher_start` / `launcher_validated` / `startup_failure` 落盘；`fail()` 加 ts/host/pid 后 flush |
| `packages/pd-cli/src/commands/mcp-logs.ts`（新命令） | `pd mcp logs export --days N` |
| `docs/` | 更新 MCP 运维/诊断说明与判定表 |

复杂度变化（设计预判）：新增 1 个派生日志目录（非事实源）、1 个环境开关、1 个 CLI 命令；**不新增** DB、后台进程、跨包契约、网络能力。

### 3.9 验证清单（实施时必须覆盖）

1. 日志目录不可写 / `fs` 抛错时：工具调用仍返回正常 envelope，且 stdout 只有协议 JSON。
2. 真实 SDK 客户端驱动：断言事件序列 `startup → initialize → initialize_response → tools_list → tool_call_start → tool_call_completed`。
3. launcher 缺 binding：`startup_failure` 落盘 + exit 1 + stdout 为空。
4. 隐私：日志全文检索不得出现工作区路径、`principleId` 原文、Pain 文本、环境变量值。
5. 轮转/上限：单文件 >2 MiB、目录 >64 MiB、14 天清理。
6. 并发：3 个宿主进程 → 3 个独立文件，无交错。
7. 采集：7 天过滤、20 MiB 上限、zip 内含 `manifest.json` 与 JSONL。
8. 关闭开关 `PD_MCP_LOG=0`：不产生任何文件，服务行为不变。

---

## 4. 关键证据索引（源码）

| 事实 | 位置 |
|---|---|
| stderr-only、单行 JSON、标量白名单、UTC 时间 | [logging.ts:13-47](../../packages/pd-mcp-server/src/logging.ts#L13-L47) |
| `startup` 在 connect 之前 | [index.ts:56](../../packages/pd-mcp-server/src/index.ts#L56)、[index.ts:60](../../packages/pd-mcp-server/src/index.ts#L60) |
| 绑定失败只有 stderr | [index.ts:39-44](../../packages/pd-mcp-server/src/index.ts#L39-L44) |
| workspace 校验链 | [workspace.ts:39-87](../../packages/pd-mcp-server/src/workspace.ts#L39-L87) |
| 工具调用事件字段 | [server.ts:146-229](../../packages/pd-mcp-server/src/server.ts#L146-L229) |
| `tool_call_completed` 只记 resultKind | [server.ts:196](../../packages/pd-mcp-server/src/server.ts#L196) |
| 32 KiB 预算/不截断 | [server.ts:199-210](../../packages/pd-mcp-server/src/server.ts#L199-L210)、[budget.ts](../../packages/pd-mcp-server/src/budget.ts) |
| launcher 失败单行 + exit | [launcher.cjs:63-66](../../packages/openclaw-plugin/mcp/launcher.cjs#L63-L66) |
| launcher 校验分支 | [launcher.cjs:166-346](../../packages/openclaw-plugin/mcp/launcher.cjs#L166-L346) |
| `pd health` 静态、不 spawn | [health-mcp.ts:16-20](../../packages/pd-cli/src/commands/health-mcp.ts#L16-L20)、[health-mcp.ts:90-91](../../packages/pd-cli/src/commands/health-mcp.ts#L90-L91) |
| `pd health` 注册与 host 参数 | [index.ts:253](../../packages/pd-cli/src/index.ts#L253)、[health.ts:363-386](../../packages/pd-cli/src/commands/health.ts#L363-L386) |
| diagnostics export 不含 MCP 日志 | [runtime-diagnostics-export.ts:87-178](../../packages/pd-cli/src/commands/runtime-diagnostics-export.ts#L87-L178) |
| SPEC §10 的 6 项判断要求 | [SPEC:1028-1037](../../docs/archive/specs/SPEC-PD-MCP-GATE4-001.md#L1028-L1037) |
| SPEC §10 日志禁止/允许项 | [SPEC:1008-1026](../../docs/archive/specs/SPEC-PD-MCP-GATE4-001.md#L1008-L1026) |
| Codex 需 `RUST_LOG` 才有 server stderr | [矩阵:40](../../docs/reports/PD_MCP_GATE4_HOST_ACCEPTANCE_MATRIX.md#L40) |

---

## 5. 本轮未做 / 未验证

- 未修改任何产品代码、未新增文件（除本文档）、未开 PR。
- 未在 Owner 真实 profile 中做实验；本机观测均为只读。
- 未验证 Owner 机器上 Codex/OpenClaw/WorkBuddy 的实际日志保留策略（本机观测不等于 Owner 环境）。
- 设计中的 transport 包装（`onmessage`/`send`）尚未实现与测试；需在实施时用真实 SDK 客户端验证不改变协议。
