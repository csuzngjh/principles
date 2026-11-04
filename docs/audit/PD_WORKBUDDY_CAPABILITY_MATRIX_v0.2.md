# PD WorkBuddy Capability Matrix v0.2

> **PD_WORKBUDDY_CAPABILITY_MATRIX_v0.2.md** — WorkBuddy 各运行模式真实能力矩阵
> 基线：2026-11-04，WorkBuddy Desktop `5.9.2` / 引擎 `@genie/agent-cli 2.165.0` / Electron `37.10.3-43` / PD 插件 `0.2.2`
> 配套报告：`PD_WORKBUDDY_HOST_AUDIT_v0.1.md`；证据索引：`PD_WORKBUDDY_EVIDENCE_MANIFEST_v0.1.md`

## 0. 模式定义（不可混用）

| 代号 | 模式 | 定义 | 本轮证据来源 | 状态 |
|:---|:---|:---|:---|:---|
| **CLI** | CodeBuddy Code CLI / WorkBuddy 内嵌 CLI 引擎 | 独立 `codebuddy` 命令或 Desktop 内被 spawn 的 CLI 引擎进程。官方文档 D1 (`codebuddy.ai/docs/zh/cli/hooks`) 与 D3 (`plugins-reference`) 描述此模式 | 官方文档 + 当前引擎 bundle 源码 | `OFFICIAL_DOC + SOURCE_CONFIRMED` |
| **IDE** | WorkBuddy IDE / Craft Agent | `workbuddy.ai/docs/ide/Features/hooks` 描述的模式，声明兼容 Claude Code Hooks 规范 | **仅官方文档 D2**（当前机器未运行独立 IDE 进程） | `OFFICIAL_DOC`，**无本轮运行时证据** |
| **Desktop** | WorkBuddy Desktop（Electron） | 当前实际运行：8 个 `WorkBuddy.exe` 进程，Hook 引擎在 pid 95164 的 CLI 子进程内 | 运行时日志 + 安装目录 + 进程列表 | `RUNTIME_VERIFIED` |

> **关键澄清（推翻 SPEC v0.4 用语）**：「`lite-wb` CLI」**不是独立运行模式**，它是引擎入口文件 `codebuddy-lite-wb.mjs` 的名字（引擎内 `"lite-wb"` 计数 27）。当前实际是 **Desktop 承载 CLI 引擎子进程**。因此 v0.4 §0.3 / §5.1 / §12.3 把 `WorkBuddy lite-wb CLI` 与 `WorkBuddy Desktop/IDE` 并列为两个 profile 的方式需要重定义。

## 1. 图例（所有表格通用）

**证据等级**：`DOC`=OFFICIAL_DOC、`SRC`=SOURCE_CONFIRMED、`RUN`=RUNTIME_VERIFIED、`CFG`=STATIC_CONFIG、`HP`=HISTORICAL_PROBE、`INF`=INFERRED、`NR`=NOT_RUN、`UNK`=UNKNOWN。

**支持/派发**：`Y`=确认支持、`N`=确认不存在、`—`=未声明/未验证、`0`=本轮零样本（不等于不支持）。

**注入能力**：`UPS`=当前回合 user 消息上下文、`SS`=会话起始上下文、`TOOL`=工具结果附加、`NONE`=不注入、`BLOCK`=可阻断、`OBS`=仅观察。

**身份能力**：`S`=`session_id`、`G`=`generation_id`、`T`=`taskId`、`A`=`agent_id/agent_type`、`C`=`call_id/tool_use_id`、`P`=transcript_path、`W`=`cwd`。

**异步能力**：`ASYNC`=宿主支持 `async:true` detached、`—`=同步等待。

**PD 现状**：`REG`=已在 hooks.json 注册、`SUB`=在 SUBSCRIBED_EVENTS 内、`—`=未接入。

## 2. 全局执行模型（跨模式对照）

| 维度 | CLI（官方 + 源码） | IDE（官方 D2） | Desktop / 当前实际 | 证据 |
|:---|:---|:---|:---|:---|
| 执行单元 | command hook = 独立子进程 `spawn`；另有内部 hook / SDK callback | 未声明执行单元 | 每 hook 独立子进程（本次会话 332 次 spawn） | `SRC/RUN` |
| 常驻 sidecar | 无 | — | 无 | `SRC/INF` |
| 每事件新进程 | 是 | — | 是（不同 pid） | `SRC/RUN` |
| 多 Hook 并行 | **是**，`Promise.allSettled` | **是**（FAQ Q4「execution order is not guaranteed」） | **是**：14:52:34.977 同时间戳 spawn pid 27720 + 66216 | `DOC/SRC/RUN` |
| 结果合并 | 任一 `!allowed` → 整体阻断；message/stdout 换行拼接；`hookSpecificOutput` 浅合并；SDK 侧 deny>ask>allow | 未给算法 | 同源码 | `DOC/SRC/NR` |
| 去重 | 相同 command 自动去重 | 相同命令自动去重 | `deduplicateHooks` 存在；宿主侧不去重 `call_id` | `DOC/SRC/HP` |
| 配置来源合并 | **不同作用域合并而非覆盖**；插件 `hooks/hooks.json` 与 extension config **数组拼接** | **项目级覆盖用户级** | `~/.workbuddy/settings.json` 无顶层 `hooks`；插件 0.2.2 单点加载 | `DOC/SRC/CFG` |
| 配置生效 | 启动快照 + 外部修改需 `/hooks` 审查 | 重启 Agent + 新会话 | 启动时 `HookExtensionLoader` 加载，日志 2 次 | `DOC/RUN` |
| async / 后台 | **官方文档未声明**；源码支持 `async:true` + `asyncTimeout` detach | 未声明框架级 async（仅脚本级建议） | 源码能力存在；本轮 `NR` 未运行验证 | `DOC/SRC/NR` |
| 共享状态通道 | 无框架级共享状态 | 未声明 | 无（PD 自行用 SQLite + lease） | `INF` |
| 取消执行中 Hook | 超时 SIGTERM → 1 s → SIGKILL | 未说明 | 同源码 | `SRC/NR` |
| 重试机制 | 无 hook 级重试 | 未说明 | 无 | `SRC/NR` |
| 默认 timeout | **60 s**（`kp=6e4`）；prompt hook 30 s | 60 s | 由 hooks.json 覆盖：UPS 15 s / 其余 30 s | `DOC/SRC/RUN` |
| 注入消息角色 | 未说明 | 未说明 | **`user` 消息内 `<system-reminder data-role="hook">`**，UPS=`last`、SS=`first` | `SRC + HP` |
| 修改当前 Prompt | 不支持（无 modifiedPrompt） | 不支持 | 不支持，只能附加/阻断/清除 | `DOC/SRC` |
| 注入长度闸门 | `additionalContextLimit` 有规范 | 未提 | **当前引擎零命中（NOT_FOUND）** | `SRC` |
| 配置文件路径 | `~/.codebuddy/settings.json` | `~/.codebuddy/settings.json` | **实际 `~/.workbuddy/settings.json`** | `DOC/CFG` |
| `tool_name` 命名 | CLI-style（Bash/Write） | **IDE-style（execute_command/write_to_file）** | CLI-style | `DOC` |

## 3. Table A — CLI 模式（官方 D1/D3 + 当前引擎源码）

> 「实际派发」列为本轮当前环境运行时样本；CLI 官方与引擎源码同源，故并列。

| 事件 | 官方支持 | 当前版本支持 | 实际派发 | Payload 完整性 | 注入能力 | 事件顺序 | 超时 | 失败语义 | 身份 | 异步 | 证据 | PD 现状 | 建议使用方式 |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| `UserPromptSubmit` | Y (D1/D3) | Y | **1** | 完整：`prompt`,`session_id`,`transcript_path`,`cwd`,`permission_mode`,`generation_id`,`model`,`is_internal_continuation` | `UPS` / `BLOCK` | 与 SessionStart 派发时间并发，无保证；**注入位置确定为 `last`** | 15 s（生效） | exit2/deny/continue:false/宿主kill → **阻断并清除提示词**；exit1/3 → 放行 | `S,G,P,W` | `ASYNC`（源码） | `DOC,SRC,RUN` | `REG,SUB` | **主注入通道**；只读缓存/Native，15 s 内返回；禁止同步模型推理 |
| `SessionStart` | Y | Y | **1** | `source`(startup/resume/clear),`session_id`,`transcript_path`,`permission_mode`,`version`,`client`；**无 cwd** | `SS`（`first`） / `NONE` | 派发并发、无顺序保证；resume/clear 会重复 | 30 s（生效；本次实测 15.552 s / 整链 16.736 s） | exit2 非阻断（仅显示消息）；超时 kill 后会话继续 | `S,P` | `ASYNC`（源码） | `DOC,SRC,RUN` | `REG,SUB` | **只做 health / profile 版本绑定校验**；不做会话计数、不清 Working Set |
| `SessionEnd` | Y | Y | 0 | `reason`(clear/other),`session_id`,`transcript_path` | `NONE` | `/clear` 时先于 SessionStart(clear) | 未配置 | 非阻断；**无 hook 时不派发** | `S,P` | `ASYNC`（源码） | `DOC,SRC` | — | **尽力清理 + TTL 兜底**；登记会话边界，不作为唯一清理点 |
| `PreToolUse` | Y | Y | **164** | `tool_name`,`tool_input`,`call_id`,`tool_use_id`,`tool_response`(无) | `BLOCK`（deny/exit2） | 工具参数构建后、执行前 | 30 s（生效） | **超时 fail-closed（工具阻断）**；`continue:false` 会导致用户 prompt 重新提交 | `S,G,C,P,W` | `ASYNC`（源码） | `DOC,SRC,RUN,HP` | `REG,SUB` | 维持现有治理；**禁用 `continue:false`**；可作阶段信号 |
| `PostToolUse` | Y | Y | **162** | `tool_name`,`tool_input`,`tool_response` | `TOOL`（`<system-reminder data-role="tool-hint">`） | 工具完成后立即 | 30 s | 工具已执行，不阻断；decision:block 已废弃 | `S,G,C,P,W` | `ASYNC`（源码） | `DOC,SRC,RUN` | `REG,SUB` | 维持证据采集；可附加短期提示，**不重复注入原则** |
| `PostToolUseFailure` | Y | Y | **0**（本次无工具抛异常） | `tool_name`,`tool_input`,`error`,`is_interrupt`,`tool_error_code` | `TOOL` | 仅工具 THROW 时 | 30 s | 不阻断 | `S,G,C,P,W` | `ASYNC`（源码） | `DOC,SRC,HP` | `REG,SUB` | 维持；历史探针已证实只覆盖 thrown 类 |
| `Stop` | Y | Y | 0 | `stop_hook_active`,`agent_id`,`agent_transcript_path`,`last_assistant_message`,`background_tasks` | `BLOCK`（阻止停止） | 主 Agent 响应结束；用户中断不触发 | 未配置 | `continue:false`/exit2 = 让 Agent 继续 | `S,G,A,P` | `ASYNC`（源码） | `DOC,SRC` | — | **可作为 Deferred Refresh 的回合结算点**（候选，需验证） |
| `SubagentStop` | Y | Y | 0 | 同 Stop + `agent_id` | `BLOCK` | 子代理结束 | 未配置 | 同 Stop | `S,G,A,P` | `ASYNC`（源码） | `DOC,SRC` | — | 主/子任务区分；不注入 |
| `SubagentStart` | Y (D3) | Y | 0 | `agent_id`,`agent_type` | `NONE` | 子代理启动 | 未配置 | 非阻断 | `S,A` | `ASYNC`（源码） | `DOC,SRC` | — | 识别主任务/子任务边界，避免子代理重复刷新 |
| `TaskCreated` | Y (D3) | Y（真实派发点） | 0 | `taskId`(camelCase),`subject`,`description?`,`teammateName?`,`teamName?` | `NONE` | `TaskCreateTool.execute` | 未配置 | 派发异常仅 `debug` 日志吞掉 | `S,T` | `ASYNC`（源码） | `DOC,SRC` | — | **确定性 `NEW_TASK` 边界，替代 Decision Model 调用** |
| `TaskCompleted` | Y (D3) | Y（真实派发点） | 0 | `taskId`,`subject`,`description?`,`teammateName?`,`teamName?` | `NONE` | `TaskUpdateTool` 状态置 completed | 未配置 | 同上 | `S,T` | `ASYNC`（源码） | `DOC,SRC` | — | **确定性任务结束边界**；Working Set 失效/归档 |
| `TaskUpdated` | — | **N**（枚举零命中） | 0 | — | — | — | — | — | — | — | `SRC` | — | 不要假设存在；用 Tool/Compaction 事件替代 |
| `PreCompact` | Y | Y | 0 | `trigger`(manual/auto),`custom_instructions`,`transcript_path` | 压缩指导（`additionalContext`） / `BLOCK`(exit2 阻止压缩) | 压缩前 | 未配置 | exit2 可阻止压缩 | `S,P` | `ASYNC`（源码） | `DOC,SRC` | — | **Working Set 保存检查点** |
| `PostCompact` | Y (D1/D3) | Y | 0 | `trigger`,`compact_summary` | `OBS`（仅观察） | 压缩成功后 | 未配置 | **不可阻止/修改压缩结果** | `S,P` | `ASYNC`（源码） | `DOC,SRC` | — | **重校验 Working Set + 生成新 fingerprint**（v0.4 未提及） |
| `Notification` | Y | Y | 0 | `message`,`notification_type` | `NONE` | 权限请求/60 s 空闲/认证成功 | 未配置 | exit2 仅显示消息 | `S,P` | `ASYNC`（源码） | `DOC,SRC` | — | 不建议接入 Adaptive Activation |
| `PermissionRequest` | Y | Y | 0 | `tool_name`,`tool_input`,`permission_suggestions` | `BLOCK` | 权限对话框出现 | 未配置 | — | `S,P` | `ASYNC`（源码） | `DOC,SRC` | — | 不建议接入 |
| `PermissionDenied` | Y (D3) | Y | 0 | D3：返回 `{retry:true}` 可告知模型重试 | `NONE` | auto 审查员拒绝时 | 未配置 | — | `S` | — | `DOC,SRC` | — | 不建议接入 |
| `StopFailure` | Y (D3) | Y | 0 | D3：**输出和退出码被忽略** | `NONE` | 轮次因 API 错误结束 | 未配置 | — | `S` | — | `DOC,SRC` | — | 不建议接入 |
| `TeammateIdle` | Y (D3) | Y | 0 | `teammate_name`,`team_name` | `NONE` | 团队成员即将空闲 | 未配置 | — | `S` | — | `DOC,SRC` | — | 可作阶段信号，优先级低 |
| `ConfigChange` | Y (D3) | Y（直接 `executeHooks`） | 0 | `source`,`file_path` | `NONE` | 会话期间配置变更 | 未配置 | — | `S` | — | `DOC,SRC` | — | **可用于检测 hooks.json / profile 漂移**（建议评估） |
| `CwdChanged` | Y (D3) | Y | 0 | — | `NONE` | 工作目录变更 | 未配置 | — | `S,W` | — | `DOC,SRC` | — | 可作 workspace 边界信号 |
| `FileChanged` | Y (D3) | Y | 0 | matcher 指定监视文件名 | `NONE` | 磁盘文件变更 | 未配置 | — | `S` | — | `DOC,SRC` | — | 不建议接入（噪音高） |
| `WorktreeCreate` / `WorktreeRemove` | Y (D3) | 字符串存在；`executeWorktreeCreateHooks` 命名函数 NOT_FOUND | 0 | `name` / `worktree_path` | `NONE` | 工作树创建/移除 | 未配置 | — | `S` | — | `DOC,SRC` | — | 不建议接入 |
| `Elicitation` / `ElicitationResult` | Y (D3) | Y | 0 | `mcp_server_name`,`message`,`mode`,`url`,`elicitation_id`,`requested_schema` | `NONE` | MCP 请求用户输入 | 未配置 | — | `S` | — | `DOC,SRC` | — | 不建议接入 |
| `InstructionsLoaded` | Y (D3) | Y | 0 | — | `NONE` | `CODEBUDDY.md` / rules 加载 | 未配置 | — | `S` | — | `DOC,SRC` | — | 可选：检测规则文件变更影响原则上下文 |
| `Setup` | Y (D1 功能概览) | Y | 0 | `trigger`；`additionalContext` → `setupContext` | `SS` | 启动时 | 未配置 | — | `S` | — | `DOC,SRC` | — | 不建议接入 |
| `UserPromptExpand` | — | **N**（字面零命中；近似项 `USER_PROMPT_EXPANSION` 存在） | 0 | — | — | — | — | — | — | — | `SRC` | — | 不要假设存在 |
| `FinalStop` | — | Y（枚举） | 0 | — | — | — | — | — | — | — | `SRC` | — | 未调查完整语义，`UNKNOWN` |

## 4. Table B — IDE 模式（仅官方 D2，无本轮运行时证据）

> **本表全部为 `OFFICIAL_DOC`，不构成本机运行时证据。** D2 页面未出现 `Desktop` 字样、无版本号、无最后更新日期。其声明「完全兼容 Claude Code Hooks 规范」，但与 D1/当前源码多处直接矛盾（见 §6）。

| 事件 | 官方支持 | 触发时机（D2 原文） | matcher | Payload | 注入/阻断 | 超时 | 失败语义 | 身份 | 异步 | 证据 | PD 现状 | 建议使用方式 |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| `SessionStart` | Y | 会话启动；**按 `conversationId` 判断，每新会话只触发一次**；切换/清空会话再触发 | `source`，**仅 `startup`** | `source`,`session_id`,`transcript_path`,`cwd`,`hook_event_name` | `SS`；exit2 非阻断 | 默认 60 s；示例 5–30 s | exit0 注入 stdout；exit2 仅向用户显示 | `S,conversationId` | 未声明 | `DOC` | `REG` | 仅作参考；**不得据此推断 Desktop 行为** |
| `SessionEnd` | Y | 会话终止 | `reason`，**仅 `other`** | `reason` | `NONE` | 60 s | 非阻断 | `S` | 未声明 | `DOC` | — | 仅作参考 |
| `PreToolUse` | Y | 工具执行前，可校验/修改/阻断 | `tool_name`（**IDE-style**） | `tool_name`,`tool_input` | `BLOCK`；`modifiedInput` | 60 s | exit2 阻断 | `S` | 未声明 | `DOC` | `REG` | 注意 `tool_name` 命名差异；不可复用 CLI 映射 |
| `PostToolUse` | Y | 工具完成后 | `tool_name` | `tool_name`,`tool_input`,`tool_response` | `TOOL` | 60 s | 工具已运行 | `S` | 未声明 | `DOC` | `REG` | 仅作参考 |
| `UserPromptSubmit` | Y | 用户提交消息 | 不使用 | `prompt` | `UPS` / `BLOCK`(continue:false) | 60 s | **exit2 时 stdout 忽略、stderr 传给 Agent** | `S` | 未声明 | `DOC` | `REG,SUB` | 仅作参考；exit2 消息来源与 CLI/源码矛盾 |
| `Stop` | Y | Agent 完成响应 | 不使用 | `stop_hook_active` | `BLOCK`（反馈） | 60 s | **exit2 = 反馈，stderr 注入下一条消息** | `S` | 未声明 | `DOC` | — | 仅作参考 |
| `PreCompact` | Y | 上下文压缩前 | `trigger`(manual/auto) | `trigger`,`custom_instructions` | 压缩指导；exit2 阻止压缩 | 60 s | 超时行为**未说明** | `S` | 未声明 | `DOC` | — | 仅作参考 |
| `PostCompact` | **N** | 页面未列出 | — | — | — | — | — | — | — | `DOC` | — | **D2 无此事件，当前引擎有** |
| `TaskCreated` / `TaskCompleted` / `SubagentStart` / `SubagentStop` / `Notification` / `PermissionRequest` / `PostToolUseFailure` / `SessionEnd.reason` 扩展值 | **N**（D2 只列 7 事件） | — | — | — | — | — | — | — | — | `DOC` | — | **不可据 D2 判定引擎不支持** |

**IDE 特有的额外规则（D2）**：项目级 `settings.json` **覆盖**用户级；多个 Hook 并行且顺序不保证、建议合并为单脚本；自动去重相同命令；建议 hook 脚本自行用文件锁避免并发写冲突；`matcher` 支持 CLI/IDE 双向别名匹配，但 `tool_name` 的实际值取决于运行时。

## 5. Table C — Desktop / 当前实际运行（`RUNTIME_VERIFIED`）

> 当前会话日志文件：`C:/Users/Administrator/.workbuddy/logs/2026-11-04/principles__97f0a2a3eefec09106aaa9b4220263bb.log`（12,557 行 / 2,895,697 B）。

| 事件 | 官方 Desktop 文档 | 当前版本源码 | 本次实际派发 | Payload 完整性 | 注入结果 | 超时（实测） | 本次失败/降级 | 身份 | 证据 | PD 现状 | 建议使用方式 |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| `UserPromptSubmit` | **无专门 Desktop 文档** | Y | **1**（pid 85740，14:52:36.544） | 完整（见 Table A） | **0 条真实注入记录** — PD 自降级 | `timeout=15000ms` | **`code=1 elapsed=12113ms timedOut=false`，`[PD] status=degraded entry_deadline_exceeded:12021ms_budget_12000ms`；宿主非阻断放行** | `S,G,P,W` | `RUN` | `REG,SUB` | **P0：修复同步路径耗时 + 让 wrapper 读实际 timeout + 记 degraded receipt** |
| `SessionStart` | 无 | Y | **1**（pid 66216，14:52:34.977） | `source=startup` | 无注入（PD 只做 health） | `timeout=30000ms` | `code=0 elapsed=15552ms`；`executeSessionStartHooks=15613ms`，整链 `16736ms` | `S` | `RUN` | `REG,SUB` | 把整链耗时纳入预算；并发实证 |
| `PreToolUse` | 无 | Y | **164** | 完整 | — | `timeout=30000ms` | `code=0`，典型 1–3 s | `S,G,C` | `RUN` | `REG,SUB` | 维持；可作阶段信号 |
| `PostToolUse` | 无 | Y | **162** | 完整 | — | `timeout=30000ms` | `code=0`，典型 1–3 s | `S,G,C` | `RUN` | `REG,SUB` | 维持 |
| `PostToolUseFailure` | 无 | Y | **0**（本次无工具抛异常） | — | — | `timeout=30000ms` | — | — | `RUN(零样本)` | `REG,SUB` | **不可据此判「不支持」** |
| `Stop` / `SessionEnd` / `PreCompact` / `PostCompact` / `Task*` / `Subagent*` | 无 | Y | **0**（本次会话未走到这些生命周期点） | — | — | 未配置 | — | — | `RUN(零样本),SRC` | — | 需隔离探针补样本 |
| 其它插件并发 Hook | 无 | Y | 同时间戳 `14:52:34.977` spawn pid 27720（workbuddy-docx，5000ms）+ pid 66216（PD，30000ms） | — | — | 5000 / 30000 ms | — | — | `RUN` | — | **并行语义实证** |
| 真实超时 / 阻断 | 无 | Y（源码） | **0 条**（`[cbc-kw=HOOK] Hook timed out`、`HookBlockedError` 精确检索均为 0；宽匹配 3 条经逐行核对全是取证命令回显） | — | — | — | — | — | `RUN` | — | 超时阻断仅为 `SRC + HP` 结论 |

**Desktop 全局实测**：`settings.json` `enabledPlugins["principles-disciple@principles-disciple-market"]=true`（覆盖 `defaultEnabled:false`）；`installed_plugins.json` → `0.2.2`；日志 `Loaded hooks configuration from extension: principles-disciple@principles-disciple-market` ×2；`0.2.2` 路径命中 292 次、`0.1.0`/`0.2.0` 路径命中 0 次；引擎 `--version` = `2.165.0`。四层状态：**已安装 ✅ / 已加载 ✅ / 已派发 ✅ / 已注入 ❌**。

## 6. 三方差异登记（不互相覆盖）

| # | 议题 | CLI 官方 (D1/D3) | IDE 官方 (D2) | 当前源码 / Desktop 运行 | 本矩阵采用 |
|:--|:---|:---|:---|:---|:---|
| X1 | 事件总数 | 27+ / D3 表 27 | 7 | 引擎枚举 29 | 分模式分别登记 |
| X2 | 配置优先级 | 合并而非覆盖 | 项目级覆盖用户级 | `mergeHooks` 数组拼接 | 当前环境按合并 |
| X3 | exit 2 消息来源 | stdout 优先、stderr 兜底 | stdout 忽略、stderr 传给 Agent | `parseHookOutput` stdout JSON reason / stderr fallback | 当前环境按 CLI/源码 |
| X4 | SessionStart `source` | startup/resume/clear/compact | 仅 startup | startup/resume/clear（无 compact） | 当前环境按源码 |
| X5 | SessionStart 重复 | resume 会再触发 | 每会话仅一次（conversationId） | `resume` / 分支会派发 | 当前环境按源码 |
| X6 | async 后台 | 未声明 | 未声明 | `async:true + asyncTimeout` detach 存在 | 源码能力，标 `NR` 待验证 |
| X7 | 配置路径 | `~/.codebuddy/settings.json` | `~/.codebuddy/settings.json` | `~/.workbuddy/settings.json`（无顶层 hooks） | 实际路径优先 |
| X8 | 生效机制 | 启动快照 + `/hooks` 审查 | 重启 + 新会话 | 启动时 `HookExtensionLoader` | 会话内改配置不生效 |
| X9 | `additionalContextLimit` | 有规范 | 未提 | 引擎零命中 `NOT_FOUND` | PD 自行截断 |
| X10 | `tool_name` | CLI-style | IDE-style | CLI-style（引擎子进程） | 当前环境按 CLI-style |
| X11 | `PostCompact` | Y | 未列出 | Y | 当前环境按源码 |
| X12 | 注入角色 | 未说明 | 未说明 | **`user` 内 hook system-reminder** | `SRC + HP` |

## 7. 能力结论（供 SPEC 修订引用）

1. **CLI/引擎能力与 IDE 文档不是同一契约**：任何 profile 必须写清「模式 + 文档口径 + 引擎版本 + 证据日期」，禁止用 IDE 文档否定引擎能力，也禁止用引擎源码宣称 IDE 已验证。
2. **Desktop 当前实际能力 ≈ CLI 引擎能力**（因为 Hook 引擎就是 CLI 子进程），但 Desktop 主进程包内**不含** hook 实现，且 Desktop UI 相关能力（`/hooks` review panel、交互式 TUI）本轮 `NOT_RUN`。
3. **宿主已提供 PD 所需的大部分生命周期与异步能力**：`TaskCreated`/`TaskCompleted`/`SessionEnd`/`PreCompact`/`PostCompact` + `async:true`，足以把 `HOST_TASK_BOUNDARY`、`COMPACTION_RESUME`、`PERIODIC_CHECKPOINT` 从「需要模型判断」降级为「确定性事件 + 少量模型判断」。
4. **注入能力是唯一硬约束**：只有 `UserPromptSubmit` 能在当前回合补上下文，且落在 **user 消息**、宿主侧无长度闸门；因此 `Injection Contract` 必须独立定义，不能复用 Codex 的 `developer` 语义。
5. **本次运行暴露的能力与实现落差**：能力充足，但 PD 的 12 s 自降级使本次注入为 0。矩阵中「当前版本支持=Y」不等于「PD 已可靠利用」。

---

**END OF PD_WORKBUDDY_CAPABILITY_MATRIX_v0.2.md**
