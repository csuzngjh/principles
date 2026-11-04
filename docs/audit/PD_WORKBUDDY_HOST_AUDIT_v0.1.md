# PD × WorkBuddy Host-Native Architecture Audit v0.1

> **PD_WORKBUDDY_HOST_AUDIT_v0.1.md** — 完整宿主能力调查与架构评审报告

| 项 | 值 |
|:---|:---|
| 报告版本 | v0.1 |
| 检查日期 | 2026-11-04（GMT+8） |
| 评审对象 | `docs/specs/PD Adaptive Activation SPEC v0.4.md`（2995 行，122055 B，SHA-256 `c022cd66a73d2d644e6b91e24df280b08772ae3a93e77a97e7b30268e5b520c4`） |
| 输入状态 | **文件存在，已完成全文评审**（非输入缺失） |
| 目标宿主 | WorkBuddy（当前安装版本见 §1） |
| 本轮范围 | 只读调查 + 评审 + 文档交付 |
| 未执行 | 未修改生产代码 / 宿主安装配置 / 插件 / 数据库 / 用户会话 / 原始 SPEC；未合并 PR；未触发付费模型调用 |
| 最终裁定 | **NEEDS_SPEC_REVISION**（见 §8） |

## 证据等级定义

| 标签 | 含义 |
|:---|:---|
| `OFFICIAL_DOC` | 官方文档（本次抓取，URL 与检查日期见证据清单） |
| `SOURCE_CONFIRMED` | 与当前安装版本匹配的宿主源码（文件 + 行号 / 字节偏移） |
| `RUNTIME_VERIFIED` | 当前环境的真实运行证据（进程、日志、配置读取、`--version`） |
| `STATIC_CONFIG` | 静态配置文件内容 |
| `HISTORICAL_PROBE` | 历史隔离探针产物（**不同版本基线，不冒充本轮结果**） |
| `INFERRED` | 明确标注的推断 |
| `NOT_RUN` | 本轮未执行，附具体原因 |
| `UNKNOWN` | 现有证据无法确定 |

**优先级纪律**：当前安装环境真实运行证据 > 匹配版本宿主源码 > 对应版本官方文档 > PD 仓库实现与测试 > 历史探针报告 > 设计推断。三者冲突时**分别登记，不互相覆盖**（§2.6）。

---

# 0. 执行摘要

## 0.1 环境实测结论

| 项 | 当前实际值 | SPEC v0.4 声称 | 判定 |
|:---|:---|:---|:---|
| 宿主产品 / 版本 | WorkBuddy Desktop **5.9.2**（`@genie/workbuddy-desktop`） | 5.9.2 | 一致 |
| Host 引擎 | `@genie/agent-cli` **2.165.0** | 历史探针基线 2.161.0 / 5.8.1 | **基线已失效** |
| Electron | 37.10.3-43 / Chrome 138.0.7204.251 | 未提及 | 新增 |
| 运行模式 | **Desktop（Electron）承载 CLI 引擎子进程** | 「`lite-wb` CLI」作为独立 runtime mode | **概念错误** |
| PD 插件 | **0.2.2**，已 installed / enabled / loaded / 派发 | 「marketplace cache 0.2.0」 | **版本过时** |
| 生效 `UserPromptSubmit` timeout | **15 s**（运行时日志 `timeout=15000ms`） | canonical 15 s vs cache 0.2.0 30 s | **差异已消解，但残留风险仍在** |
| 注入消息角色 | **`user` 消息内 `<system-reminder data-role="hook">` 块** | `UNKNOWN` | **可判定，SPEC 过时** |
| Hook 超时语义 | `exit 2` / 宿主 kill → 阻断；`exit 1` → 非阻断放行 | 「timeout blocks the submission」 | **风险模型不完整** |

## 0.2 五个决定性发现

1. **`[RUNTIME_VERIFIED]` 本次用户提交的原则注入已经丢失。** 本次会话 `UserPromptSubmit` hook（pid 85740，14:52:36.544 spawn，timeout=15000ms）在 **12.113 s** 以 `code=1` 退出，PD 自报 `status=degraded reason=workbuddy_wrapper:entry_deadline_exceeded:12021ms_budget_12000ms`。宿主按非阻断语义放行，会话正常继续；但本次会话 `runtime_v2_prompt_activations_injected` 真实记录数为 **0**。这不是理论风险，是已经发生的生产降级。

2. **`[SOURCE_CONFIRMED]` 宿主原生提供确定性 Task / Session / Compaction / Subagent 生命周期事件与异步 Hook 执行。** 引擎枚举 29 个事件常量，`TaskCreated` / `TaskCompleted` / `SubagentStart` / `SubagentStop` / `PreCompact` / `PostCompact` / `SessionEnd` / `Stop` 均有真实派发点；`async:true` + `asyncTimeout` 支持 detached 后台 hook。v0.4 仍把 WorkBuddy 限制在 `UserPromptSubmit` + `SessionStart` 两个事件上，并把 tool/compaction 事件列为 `NOT_RUN` 且「不得作为设计输入」，这与当前版本事实不符，也放弃了可替代 LLM Decision Model 的确定性信号。

3. **`[RUNTIME_VERIFIED]` 当前生效配置与仓库 canonical 字节级一致，但三版并存。** 0.2.2 `hooks.json` 与 `packages/workbuddy-adapter/plugin/hooks/hooks.json` SHA-256 同为 `556d546a…`；磁盘上仍并存 0.1.0 / 0.2.0（全 30 s）两份旧 `hooks.json`，仅被标记 `.orphaned_at` 而未删除。宿主 `mergeHooks` 语义是**数组拼接而非覆盖**，一旦多版本同时注册将产生重复注入 / 重复刷新。SPEC §8.3 只覆盖数据库层 revision 并发，未覆盖 Hook 配置层去重。

4. **`[OFFICIAL_DOC + SOURCE_CONFIRMED + RUNTIME_VERIFIED]` 三种来源互相矛盾。** IDE 官方文档只写 7 个事件、项目级配置「覆盖」用户级、exit 2 消息取自 stderr、SessionStart 每会话只触发一次；CLI 官方 / 当前源码 / 运行日志则是 27+ 事件、配置合并、exit 2 优先取 stdout、`resume` 会重复触发 SessionStart。SPEC 未建立「分模式证据不可互相替代」的显式规则。

5. **`[SOURCE_CONFIRMED]` `additionalContextLimit` 在当前引擎中不存在。** 仓库 Codex canonical 的 `additionalContextLimit: 10000` 在 WorkBuddy 引擎中零命中；注入内容进入 `user` 消息（而非 Codex 的 `developer`、OpenClaw 的 `system`），宿主侧无长度闸门，PD 必须自行实现截断与优先级隔离。

## 0.3 结论一句话

v0.4 的**共享决策核心 + 宿主适配边界 + 交付证据分级**三项架构判断是正确的，应予保留；但其 WorkBuddy 宿主事实层基于 **2026-10-12 / 引擎 2.161.0 / 5.8.1 / PD 0.2.0** 的历史中间状态，在当前 **2.165.0 / 5.9.2 / 0.2.2** 环境上已多处失真，且**未把宿主已具备的生命周期与异步能力纳入设计**。必须修订后再定稿。

---

# 1. 第一阶段 — WorkBuddy 自身运行环境核验

## 1.1 十项必答

| # | 问题 | 结论 | 证据 |
|:--|:---|:---|:---|
| 1 | 实际版本 | App **5.9.2**；Electron **37.10.3-43**；commit `0b5051be70a4899bb5dc6497cd2275e912abe953`；构建日 2026-10-24 | `[D:/Program Files/WorkBuddy/resources/app.asar]` `asar:///package.json` `@132317121`：`@genie/workbuddy-desktop@5.9.2`；`resources/install-manifest.json:2-5` `appVersion 5.9.2`；`version:1` = `37.10.3-43`；`cli/product.json` `genieVersion=5.9.2` — `SOURCE_CONFIRMED / STATIC_CONFIG` |
| 2 | 运行模式 | **Desktop（Electron）**；8 个 `WorkBuddy.exe` 进程（主 86228，Hook 引擎承载进程 pid 95164）；`app.asar` 内 5117 个文本文件对 `UserPromptSubmit` / `additionalContext` / `hooks.json` 命中全部为 **0**，Hook 引擎不在主进程包内 | `Get-Process` + `Get-CimInstance Win32_Process` — `RUNTIME_VERIFIED`；`app.asar` 全包检索 — `SOURCE_CONFIRMED` |
| 3 | Hook 引擎及版本 | `@genie/agent-cli` **2.165.0**，文件 `D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs`（9,880,062 B，SHA-256 `6fbfd77bae7e7688abf7dfd2488b50c79390c966a9132e73ebe7a5a2d7df99cf`） | `cli/package.json` `version=2.165.0`；**本轮独立执行** `node <engine> --version` → `2.165.0`；引擎内嵌 JSON `@4811915` — `RUNTIME_VERIFIED / SOURCE_CONFIRMED` |
| 4 | 实际安装的 PD 插件版本 | **0.2.2**（仓库 Codex 插件 `0.3.0` 未安装） | `plugins/installed_plugins.json` → `installPath=…\principles-disciple\0.2.2`, `version=0.2.2`, `lastUpdated=2026-11-04T05:47:10.465Z` — `STATIC_CONFIG` |
| 5 | 插件真实加载路径 | `C:\Users\Administrator\.workbuddy\plugins\cache\principles-disciple-market\principles-disciple\0.2.2\`；marketplace 源 `C:\Users\Administrator\.pd\workbuddy-marketplace` | `installed_plugins.json`、`known_marketplaces.json` — `STATIC_CONFIG`；运行时 spawn 命令行 — `RUNTIME_VERIFIED` |
| 6 | 当前生效 hooks.json 路径 | 上述 `0.2.2/hooks/hooks.json`（1,346 B，`UserPromptSubmit=15`，其余 4 事件 =30） | 直接读取全文 + `logs/…/principles__97f0…log:L2403` — `STATIC_CONFIG / RUNTIME_VERIFIED` |
| 7 | marketplace cache 与 canonical 一致性 | **当前一致**：0.2.2 与仓库 `packages/workbuddy-adapter/plugin/hooks/hooks.json` SHA-256 均为 `556d546a…`；旧版 0.2.0 为 `d9a2a29c…`（全 30 s）且仍留在磁盘 | `sha256sum` — `STATIC_CONFIG` |
| 8 | Hook 配置是否真正被宿主加载 | **是**：`enabledPlugins["principles-disciple@principles-disciple-market"]=true`（覆盖 manifest 的 `defaultEnabled:false`）；日志 `L349 / L1706` `Loaded hooks configuration from extension: principles-disciple@principles-disciple-market`；`0.2.2/.in_use/95164` 存在；本次会话 332 次 `[HookExecutor] spawn` | `settings.json`、运行时日志 — `RUNTIME_VERIFIED` |
| 9 | 多进程 / 并发 Hook | **支持**。源码 `Promise.allSettled` 并行 + 每个 command hook 独立 `spawn`；运行时同一时间戳 `14:52:34.977` 同时 spawn pid 27720（workbuddy-docx，5000ms）与 pid 66216（PD，30000ms） | `ENGINE:L572 @3589460`（并行）、`@3579239`（spawn）— `SOURCE_CONFIRMED`；日志 `L1574/L1575` — `RUNTIME_VERIFIED` |
| 10 | 是否同时读取多版本 Hook 配置 | **本次只加载 0.2.2**（日志中 `0.2.2` 命中 292 次，`0.1.0`/`0.2.0` 路径命中 0 次）；但三版 `hooks.json` 物理并存，且 `mergeHooks` 为拼接语义 → 存在并存被同时注册的配置风险 | `ENGINE:L2506 @8220394` `mergeHooks(t,i){for(let[n,s]of Object.entries(i))t[n]=[...t[n]||[],...s]}` — `SOURCE_CONFIRMED` + `INFERRED` |

## 1.2 15 s vs 30 s 专项重新裁定

| 问题 | 裁定 | 证据 |
|:---|:---|:---|
| 现在实际生效的是哪个配置？ | **0.2.2 / `UserPromptSubmit` 15 s**；其余 4 事件 30 s | 日志 `L2403` 原始行：`[2026/11/4 14:52:36.544] … [HookExecutor] spawn pid=85740 … timeout=15000ms cmd=node "…/0.2.2/scripts/wrapper.cjs" UserPromptSubmit` — `RUNTIME_VERIFIED` |
| 谁决定最终 Hook timeout？ | **`hooks.json` 的 `timeout` 字段（单位：秒）× 1000** 覆盖宿主默认 60 s。`ENGINE:L572 @3576352` `kp=6e4`；`ENGINE:L576 @3598100` `timeout:t.timeout?1e3*t.timeout:void 0` | `SOURCE_CONFIRMED` |
| 是否存在配置覆盖 / 优先级规则？ | 当前 `~/.workbuddy/settings.json` **无顶层 `hooks` 键**（顶层 6 键：`enabledPlugins` / `sandbox` / `autoLaunchDefaultApplied` / `claw` / `officeMarkdownDefaultClaimAttempted` / `officeFileAssociationsRepairMarker`），不覆盖 hook。官方 CLI 文档明确「不同作用域合并而非覆盖、同事件并行」；官方 IDE 文档却写「项目级覆盖用户级」→ 冲突，见 §2.6 | `STATIC_CONFIG / OFFICIAL_DOC` |
| 更新插件后旧配置是否可能残留？ | **会**。`principles-disciple/` 下 `0.1.0`、`0.2.0`、`0.2.2` 三个版本目录各含完整 `hooks.json`；旧版仅有 `.orphaned_at` 标记 + `.in_use/` 引用计数，引擎中未找到显式删除旧 `hooks.json` 的代码。另有 `~/.pd/workbuddy-marketplace/`、`~/.pd/runtime/`、`~/.pd/backups/runtime.backup.*` 三份同源副本 | `STATIC_CONFIG / NOT_FOUND` |
| PD 是否可能读取与宿主实际行为不一致的配置？ | **是，且已经发生**。PD `wrapper.cjs:55,61` 把 `HOST_TIMEOUT_MS` 写死为 `{UserPromptSubmit:15000, default:30000}`、`SELF_TIMEOUT_MS` 写死 `{12000, 25000}`，**不读取实际生效的 hooks.json**。在 0.2.0（30 s）环境里它会过早降级；若未来宿主收紧到 <12 s，PD 的 12 s 自降级反会被宿主先 kill → 按 `exitCode:-1 / allowed:false` 阻断提交 | `SOURCE_CONFIRMED` + 运行时降级实证 |
| 运行时版本与插件版本不兼容？ | **未发现**。日志对 `incompatible` / `version mismatch` / `Hook timed out` 的命中经核对全部是取证命令回显；用宿主精确前缀 `[cbc-kw=HOOK] Hook timed out` 检索为 0；唯一 hook 加载错误是 `tencent-docs-plugin` 的 `EISDIR`，与 PD 无关。引擎不读取 PD 的 `runtime-version.json` pins | `RUNTIME_VERIFIED / INFERRED` |

> **对 SPEC v0.4 的直接影响**：§0.3、§12.3、§12.4、§14.3、§17.4、§25.1 中「canonical 15 s vs installed 0.2.0 30 s」被当作**当前并存的有效差异**反复引用。事实是：该差异属于 0.2.0 时代，当前 0.2.2 已经统一到 15 s；真正未闭环的是「旧版本 hooks.json 物理残留 + PD wrapper 硬编码 deadline 不感知配置」。

---

# 2. 第二阶段 — WorkBuddy 官方 Hook 能力调查

## 2.1 本次检查的官方页面

| # | URL | 定位 | 检查日期 | 关键产物 |
|:--|:---|:---|:---|:---|
| D1 | `https://www.codebuddy.ai/docs/zh/cli/hooks` | CodeBuddy Code **CLI**「Hook 参考指南」；声明 v1.16.0+、Hooks **Beta** | 2026-11-04 | 27+ 事件、10 事件详述、exit code、timeout 60 s、并行合并、`/hooks` 审查生效 |
| D2 | `https://www.workbuddy.ai/docs/ide/Features/hooks` | **IDE**（Craft Agent）「Hook User Guide」；声明完全兼容 Claude Code Hooks 规范 | 2026-11-04 | **仅 7 事件**、项目级覆盖用户级、exit 2 取 stderr、SessionStart 每会话一次 |
| D3 | `https://www.codebuddy.ai/docs/zh/cli/plugins-reference` | CLI 插件参考 | 2026-11-04 | 「可用事件」表 **27 个事件名 + 触发时机**、`hooks/hooks.json` 结构、`${CODEBUDDY_PLUGIN_ROOT}`、`defaultEnabled`、版本化缓存 |

三个页面**均未提供最后更新日期/文档版本号**（D1 只给产品版本要求 v1.16.0+）。历史工作记忆记录 D1/D3 的 2026-10-12 快照（`docs/plans/2026-10-12-workbuddy-official-*.md`）含 `lastUpdated 2026-09-17`，但本次抓取页面未复现该字段 — `OFFICIAL_DOC / STATIC_CONFIG`。

## 2.2 完整事件清单（当前引擎源码枚举）

`ENGINE:L348 @2096867–@2098323` 枚举对象完整引用清单（`SOURCE_CONFIRMED`）：

```
USER_PROMPT_SUBMIT, NOTIFICATION, STOP, SUBAGENT_STOP, WORKTREE_CREATE, WORKTREE_REMOVE,
POST_COMPACT, ELICITATION_RESULT, TASK_CREATED, TASK_COMPLETED, TEAMMATE_IDLE,
CWD_CHANGED, FILE_CHANGED, FINAL_STOP, PRE_TOOL_USE, POST_TOOL_USE, SESSION_START,
SESSION_END, PRE_COMPACT, POST_TOOL_USE_FAILURE, SUBAGENT_START, STOP_FAILURE,
CONFIG_CHANGE, INSTRUCTIONS_LOADED, PERMISSION_REQUEST, PERMISSION_DENIED,
ELICITATION, SETUP, USER_PROMPT_EXPANSION
```

| 用户点名事件 | 官方 D1/D3 | 当前引擎 | 真实派发点 | 备注 |
|:---|:---|:---|:---|:---|
| `SessionStart` | ✅ | ✅ 66 次 | `L2270 @7487424` | source = `startup` / `resume` / `clear`；**`compact` 不是 SessionStart source**（官方文档 D1 列出 `compact`，源码未找到） |
| `SessionEnd` | ✅ | ✅ 45 次 | `L2270 @7489374` | reason = `clear` / `other`；无 hook 时不派发 |
| `UserPromptSubmit` | ✅ | ✅ 22 次 | `L2270 @7485400` | 本次会话实测派发 1 次 |
| `Stop` | ✅ | ✅ | `L2270` `executeStopHooks` | 用户中断时不触发（D1） |
| `PreToolUse` | ✅ | ✅ 46 次 | `L363 @2181628` | 本次会话实测 164 次 |
| `PostToolUse` | ✅ | ✅ 35 次 | `L363 @2184083` | 本次会话实测 162 次 |
| `PostToolUseFailure` | ✅ | ✅ 16 次 | `L576 @3596309` | 本次会话 0 次（本次无工具抛异常，非「不支持」） |
| `PreCompact` | ✅ | ✅ 27 次 | `L99 / L2271 / L2332` | trigger = `manual` / `auto` |
| `PostCompact` | ✅ | ✅ | `L2332 @7915731` | **SPEC v0.4 完全未提及** |
| `SubagentStart` | ✅ | ✅ 10 次 | `L27 @1070395` | 真实派发 |
| `SubagentStop` | ✅ | ✅ 14 次 | `L20 @1043445` | 真实派发 |
| `TaskCreated` | ✅ | ✅ 8 次 | `L1916 @6040660` | `TaskCreateTool.execute` → `executeTaskCreatedHooks({taskId, subject, …})`（**camelCase `taskId`**） |
| `TaskCompleted` | ✅ | ✅ 7 次 | `L1916 @6048230` | `TaskUpdateTool` 状态置 `completed` 时派发 |
| `TaskUpdated` | ❌ | **NOT_FOUND** | — | 引擎枚举中无 `TASK_UPDATED`（历史探针脚本曾把它当待检索词） |
| `Notification` | ✅ | ✅ | `L572 @3456138` | matcher 按 `notification_type` |
| `PermissionRequest` | ✅ | ✅ 33 次 | `L1969 @6132197` | 真实派发 |
| 额外：`StopFailure` / `PermissionDenied` / `Elicitation` / `ElicitationResult` / `InstructionsLoaded` / `ConfigChange` / `CwdChanged` / `FileChanged` / `WorktreeCreate` / `WorktreeRemove` / `TeammateIdle` / `Setup` / `FinalStop` / `UserPromptExpansion` | D3 部分列出 | ✅ | 多处 | `WorktreeCreate` 有字符串但 `executeWorktreeCreateHooks` 命名函数 NOT_FOUND；`ConfigChange` 有直接 `executeHooks` 派发点 |

**Matcher**：工具事件按 `tool_name`（`*` / 空 / 正则）、`SessionStart` 按 `source`、`SessionEnd` 按 `reason`、`PreCompact` 按 `trigger`、`Notification` 按 `notification_type`；`UserPromptSubmit` / `Stop` 不支持 matcher。`ENGINE:L576 @3592980` `getMatchValue` — `SOURCE_CONFIRMED`。

## 2.3 Hook 执行模型（10 问）

| 问题 | 结论 | 证据 |
|:---|:---|:---|
| 独立进程还是宿主内部调用？ | **混合**：command hook = 独立子进程 `spawn`；另有 `executeInternalHook` 宿主内调用与 SDK `invokeCallback`（`control_request/hook_callback`） | `ENGINE:L572 @3579239`、`@3592120`、`@3512240` — `SOURCE_CONFIRMED` |
| 每次事件是否新进程？ | **是**。`registerHookPid/unregisterHookPid` 逐次跟踪；本次会话 5 类事件分别 spawn 不同 pid | 日志 `L1575/L2403/L2600/L2610` — `RUNTIME_VERIFIED` |
| 常驻进程 / Sidecar？ | **无常驻 hook sidecar**（`daemon-supervisor.cjs` 属 CLI daemon，非 hook） | `ENGINE` 全文 — `INFERRED` |
| Hook 间共享状态？ | 宿主不提供共享状态通道；只能通过外部文件/DB 自行实现（PD 已用 SQLite + lease） | `INFERRED` |
| 异步任务？ | **支持**：`async:true` hook 会 detach，`asyncTimeout` 控制子进程存活，宿主立即以 `allowed:true, exitCode:0` 返回，日志 `async hook detached pid=…` | `ENGINE:L572 @3579844–@3580030` — `SOURCE_CONFIRMED` |
| 后台执行？ | **支持**（同上，detached 子进程）；但官方文档 D1/D2 均未声明此能力，属**源码能力而非文档化契约** | `OFFICIAL_DOC` vs `SOURCE_CONFIRMED` 差异 |
| 事件合并 / 去重？ | **相同 command 自动去重**（`deduplicateHooks`）；不同来源配置**合并（数组拼接）而非覆盖**；不做事件级合并 | `ENGINE:L572 @3589460`、`L2506 @8220394`；D1 §8 — `SOURCE_CONFIRMED / OFFICIAL_DOC` |
| 取消正在执行的 Hook？ | 超时时 `SIGTERM` → 1 s 后 `SIGKILL`；无显式用户取消 API | `ENGINE:L572 @3579307` — `SOURCE_CONFIRMED` |
| 多 Hook 是否并行？ | **是**。`Promise.allSettled(h)` 本地 hooks 并行，再与 SDK hooks 并行合并 | `ENGINE:L572 @3589460`、`@3590320` — `SOURCE_CONFIRMED` |
| 并行结果如何合并？ | `aggregateSettledResults`：任一 `!allowed` → 整体 `allowed=false`（阻断可传播）；`message` / `stdout` 换行拼接；`blockingDetails` 累积；`hookSpecificOutput` 对象浅合并；SDK 侧 `permissionDecision` 按 `deny > ask > allow`、`additionalContext` 数组累积 | `ENGINE:L572–576 @3593410–@3594589`、`@3513100` — `SOURCE_CONFIRMED` |

### 关键回答：PD 能否在不阻塞用户提交的情况下完成异步原则选择？

**可以，且应优先复用宿主原生机制。** 最小可行架构：

```
[同步，UserPromptSubmit，15 s 硬上限]
  hook 读当前有效 Working Set / Native → 渲染 → hookSpecificOutput.additionalContext → 立即返回
  同时：向一个 async:true 的独立 command hook（或同一 hook 内 detached 子进程）投递刷新请求
        ↓
[异步，detached，asyncTimeout 控制]
  TaskCreated/TaskCompleted/PreCompact/PostCompact/SessionEnd 等确定性事件也可单独注册
  → 本地 Decision（优先用宿主事件，无歧义时不调用 LLM）
  → 必要时才调用 principle_decision / principle_selector
  → 结果按 sessionId + generationId + contextFingerprint + revision 校验后写入 Working Set
        ↓
[下一次 UserPromptSubmit]
  读取新 Working Set，注入
```

宿主约束（必须写进契约）：`async` hook **立即返回 `allowed:true` 且不提供当前回合的注入内容**，因此它只能承担 Deferred Refresh，不能替代当前 prompt 的同步注入通道；detached 进程仍受 `asyncTimeout` 的 SIGTERM/SIGKILL 管理，PD 必须自行实现幂等 / 租约 / 陈旧结果丢弃（SPEC §8.3 已有该机制，可直接复用）。

## 2.4 Hook 输入输出协议

**stdin**（`ENGINE:L576 @3595449–@3607672` `convertToSdkInput` / `buildHookInputForCommand`）：

```
公共：hook_event_name, session_id, transcript_path, cwd, permission_mode,
      (可选) generation_id, model, tool_use_id / call_id, hook_specific_output
PreToolUse            : tool_name, tool_input
PostToolUse           : tool_name, tool_input, tool_response
PostToolUseFailure    : tool_name, tool_input, error, is_interrupt
PermissionRequest     : tool_name, tool_input, permission_suggestions
UserPromptSubmit      : prompt
SessionStart          : source (默认 startup)
SessionEnd            : reason (默认 other)
Stop / SubagentStop   : stop_hook_active, agent_id, agent_transcript_path,
                        last_assistant_message, background_tasks, session_crons
SubagentStart         : agent_id, agent_type
PreCompact            : trigger (默认 auto), custom_instructions
PostCompact           : trigger, compact_summary
TaskCreated/Completed : taskId, subject, description?, teammateName?, teamName?  ← camelCase
Notification          : message, notification_type
```

`generation_id` 与 `model` 由 `GenerationContextHookInputProcessor` 在派发前注入（`ENGINE:@3711436`）；D1 明确 `generation_id` 在同一轮 `UserPromptSubmit` / `Stop` 间共享，**不可用时省略，禁止用 messageId / traceId 替代** — `OFFICIAL_DOC + SOURCE_CONFIRMED`。

**stdout / exit code**：

| 层 | 结论 |
|:---|:---|
| 输出协议 | 单行 JSON 或纯文本；**成功解析为 JSON 对象时按字段处理，不把 stdout 原文整体传给 Agent**；纯文本 stdout 在 `UserPromptSubmit` / `SessionStart` 作为兜底上下文注入 |
| 返回字段 | `continue` / `stopReason`\|`reason` / `suppressOutput` / `systemMessage` / `hookSpecificOutput.{hookEventName, additionalContext, permissionDecision[allow\|deny\|ask], permissionDecisionReason, modifiedInput, updatedToolOutput}`；`decision:"block"` 已废弃（源码仍兼容但打 deprecation warning） |
| 消息角色 | **不能返回 `system` / `developer` / `user` 等角色内容**；`additionalContext` 是唯一的补上下文通道，角色由宿主决定 |
| 修改当前 Prompt | **不支持**：无 `modifiedPrompt` / `updatedPrompt`；`UserPromptSubmit` 只能附加上下文或阻断 / 清除提示词 |
| 多内容块 / 结构化注入 | `additionalContext` 为单一字符串；宿主包装成一个 `<system-reminder>` 文本块。PostToolUse 的 `updatedToolOutput` 支持数组（MCP content） |
| 长度限制 | **`additionalContextLimit` 在当前引擎零命中（NOT_FOUND）**；宿主侧无注入长度闸门，PD 必须自行截断 |
| 保留宿主原始消息 | 是。注入是追加，不替换 `<user_query>` |
| Exit 0 | 成功；`stdout` 按事件处理 |
| Exit 1 / 其它非 0 | **非阻断放行**；`stderr` 转为 `systemMessage` 警告 |
| Exit 2 | **阻断**（`blockSource:"exit2"`）；`stderr` 作阻断消息 |
| 宿主超时 / 异常 | `exitCode:-1, allowed:false, blocking:true` → **阻断** |
| stderr | 调试日志安全写 stderr，不污染 Agent 反馈（D1）；但 exit 1 时 stderr 会变成界面警告 |

> **本次实测印证**：`[2026/11/4 14:52:48.651] Hook exited with non-blocking error code 1: [PD] status=degraded … (non-blocking: the prompt/tool call survived)` — `RUNTIME_VERIFIED`。**PD 的 fail-fast 降级（exit 1）不会阻断提交**，SPEC v0.4 §14.3 / §21 把「WorkBuddy timeout 阻断提交」当作头号风险，需要区分「宿主 kill」与「PD 自降级」两条完全不同的路径。

## 2.5 注入消息角色 — 五层严格区分

用户要求不能把前四步合并成「注入成功」。本轮逐层裁定：

| 步骤 | 本轮判定 | 证据 |
|:---|:---|:---|
| ① Hook 成功返回 | **本次会话未成功**：PD UPS hook 以 exit 1 degraded 返回空 stdout | 日志 `L…` `abnormal exit pid=85740 code=1 elapsed=12113ms` — `RUNTIME_VERIFIED` |
| ② 宿主接受返回值 | 宿主接受了 exit 1 的非阻断结果，会话继续（后续 `addHistory` / MCP 加载 / 模型请求正常） | 日志 14:52:48.652 起 — `RUNTIME_VERIFIED` |
| ③ 内容实际进入模型请求 | **本次会话无注入内容**（`runtime_v2_prompt_activations_injected` 真实记录 0 条），只产生了一条界面警告 | `RUNTIME_VERIFIED` |
| ④ 内容在请求中的消息角色 | **`user` 消息**，形如 `role:"user", content:[{text:"<system-reminder data-role=\"hook\">…</system-reminder>"},{text:"<user_query>…</user_query>"}]`，注入块位于 `<user_query>` **之前**；`SessionStart` 上下文用 `addSystemReminder(...,"first")`，`UserPromptSubmit` 用 `"last"` | `ENGINE:L116 @1387419–@1389139` `injectHookContexts`；`ENGINE:L97 @1309781` `role:"user"` 守卫；历史 P04 `model-request-injection-shapes.json:5-22` — `SOURCE_CONFIRMED + HISTORICAL_PROBE` |
| ⑤ 模型看到完整内容 | **UNKNOWN / NOT_RUN**：本次无注入；宿主侧无长度截断，但压缩 / 上下文窗口裁剪行为本轮未验证 | `NOT_RUN` |

**结论**：`additionalContext` **不是** `system`、也**不是** `developer`，而是被包成 `<system-reminder data-role="hook">` 追加进 **`user` 消息**。这与 Codex（`developer`）、OpenClaw（`system` 主体 + `user` 前缀）在语义优先级上根本不同：WorkBuddy 的原则内容处于用户消息内、与 `<user_query>` 并列，**不应假设其具备 system/developer 的指令优先级**，且必须防止注入文本被模型误读为用户自己的指令。SPEC v0.4 §0.3 / §12.3 / §13.2 / §15.5 / §22 OQ-15 标为 `UNKNOWN`，现在应改为已判定。

> **对照链路**（避免混淆）：`PostToolUse.additionalContext` 不进 user 消息，而是追加到工具结果的 `<system-reminder data-role="tool-hint">`（`ENGINE:L363 @2184377`）；`PreToolUse` deny reason 以 `role:"tool"` 的 `Error: <reason>` 进入模型。

## 2.6 超时与失败语义（分事件，不外推）

| 事件 / 场景 | 默认 timeout | 超时后 | 是否阻断提交 / 工具 | 证据 |
|:---|:---|:---|:---|:---|
| 全局默认 | **60 s**（`kp=6e4`）；prompt hook 30 s（D1） | SIGTERM → 1 s → SIGKILL；`exitCode:-1, allowed:false` | 视事件 | `ENGINE:L572 @3576352` / `@3579307` |
| `hooks.json` 显式 `timeout` | 秒 × 1000 覆盖默认 | 同上 | 同上 | `ENGINE:L576 @3598100` |
| `UserPromptSubmit` | 当前 **15 s** | `if(!s.allowed) throw HookBlockedError("UserPromptSubmit", …)` | **阻断，提示词不到达模型**；`continue:false` / `permissionDecision:deny` / exit 2 同族 | `ENGINE:L2270 @7486690`；D1 §5.2「阻止提示词处理，清除提示词」；历史 P02 契约 — `SOURCE_CONFIRMED / OFFICIAL_DOC / HISTORICAL_PROBE` |
| `SessionStart` | 当前 30 s | hook 被 kill | **不阻断会话**（D2：exit 2 也仅向用户显示消息） | 历史契约 `SessionStart.timeout: hook killed at configured timeout; session proceeds` |
| `PreToolUse` | 当前 30 s | hook 被 kill | **阻断工具（fail-closed）** | 历史契约 `PreToolUse.timeout: tool BLOCKED (fail-closed on timeout)` |
| `PostToolUse` | 当前 30 s | 工具已执行 | 不阻断；`decision:block` 已废弃 | D1 §4.5 / 历史契约 |
| `PreCompact` | 未单独配置 | — | exit 2 可阻止压缩 | D1 §5.2 |
| `PostCompact` | — | — | **仅观察，不可阻止/修改压缩结果** | D1 §2.2 / §4.11 |
| `Stop` / `SubagentStop` | — | — | `continue:false` / exit 2 = 阻止停止、让 Agent 继续 | D1 §4.7 |

**重试 / 部分返回 / 消息丢失**：引擎无 hook 级重试机制；超时前已写入的 stdout 会被保留在结果对象中但 `allowed:false`，对 `UserPromptSubmit` 意味着**该回合注入整体丢失**（不是部分注入）。`aggregateSettledResults` 用 `Promise.allSettled`，单个 hook 超时不影响其他 hook 完成，但只要任一返回 `!allowed`，整体阻断。

## 2.7 官方文档 / 源码 / 运行三方差异登记（不做取舍）

| # | 议题 | 官方 CLI (D1/D3) | 官方 IDE (D2) | 当前源码 / 运行 | 处理 |
|:--|:---|:---|:---|:---|:---|
| X1 | 事件总数 | 27+ / D3 列 27 | **7** | 引擎枚举 **29** | 分别登记；以当前源码为准，IDE 文档视为不同/旧口径 |
| X2 | 配置优先级 | 合并而非覆盖、并行 | **项目级覆盖用户级** | `mergeHooks` 数组拼接 | 当前环境按合并语义 |
| X3 | exit 2 消息来源 | stdout 优先、stderr 兜底 | **stdout 忽略、stderr 传给 Agent** | `parseHookOutput` 按 stdout JSON reason / stderr fallback | 当前环境按 CLI/源码口径 |
| X4 | `SessionStart` source | startup/resume/clear/**compact** | **仅 startup** | startup/resume/clear（无 compact） | 三者不一致，分别登记 |
| X5 | `SessionStart` 去重 | resume 会再次触发 | 按 `conversationId` 每会话只一次 | `emitSessionStart` 对 startup/resume 有 join in-flight；resume 会派发 | 当前环境按源码 |
| X6 | 异步 / 后台 Hook | 未声明 | 未声明（仅脚本级建议） | **`async:true` + `asyncTimeout` detach 存在** | 源码能力，文档未覆盖，须自行验证后使用 |
| X7 | 配置文件路径 | `~/.codebuddy/settings.json` | `~/.codebuddy/settings.json` | **实际 `~/.workbuddy/settings.json`**，且无顶层 `hooks` 键 | 实际路径优先 |
| X8 | 生效机制 | 启动快照 + `/hooks` 审查后应用 | 重启 Agent + 新会话 | 运行时日志显示启动时 `HookExtensionLoader` 加载 | 修改 hooks.json 不会在会话内立即生效 |
| X9 | `additionalContextLimit` / `updatedToolOutput` | 有规范 | 未提 | `additionalContextLimit` **零命中**；`updatedInput` 命名与 D1 的 `modifiedInput` 不同 | 按源码 |
| X10 | `tool_name` | CLI-style（Bash/Write） | **IDE-style（execute_command/write_to_file）** | 当前 CLI 引擎子进程 | 当前环境按 CLI-style |

---

# 3. 第三阶段 — 生命周期与 Agent 能力调查

## 3.1 Task 生命周期 — 宿主是否已提供 Task Change Detection？

**是，部分提供，且应优先于 LLM Decision Model。**

| 问题 | 回答 | 证据 |
|:---|:---|:---|
| `TaskCreated` 能否准确识别新任务？ | 能识别**宿主工具层显式创建任务**（`TaskCreateTool.execute`），但不能识别用户自然语言里的隐含任务切换 | `ENGINE:L1916 @6040660` — `SOURCE_CONFIRMED` |
| `TaskCompleted` 能否作为任务边界？ | 能（`TaskUpdateTool` 状态置 `completed` 时派发），适合作为 Working Set 失效 / 归档边界 | `ENGINE:L1916 @6048230` |
| Subagent 生命周期能否区分主/子任务？ | 能。`SubagentStart` / `SubagentStop` 带 `agent_id` / `agent_type` / `agent_transcript_path`；配合 `ScopedHookRegistry`（D1 §11.13）可把 hook 作用域限定到 subagent | `ENGINE:L27/L20`、D1 — `SOURCE_CONFIRMED / OFFICIAL_DOC` |
| 能否用 Task ID 关联多个 Agent 操作？ | 可，payload 为 `taskId` / `subject` / `description` / `teammateName` / `teamName`；`session_id` + `generation_id` 可在同一轮内关联 | `ENGINE:L1916`、D1 §3.1 — `SOURCE_CONFIRMED` |
| 能否区分同一任务内多个阶段？ | **不能由 Task 事件直接给出**；`TeammateIdle` / `FileChanged` / `PreToolUse` 的工具类型可作辅助信号，但阶段语义仍需 PD 侧判断 | `INFERRED` |
| 是否可替代部分 Decision Model？ | **可**：`TaskCreated` = 确定性 `NEW_TASK`，`TaskCompleted` = 确定性任务边界，`SessionEnd` = 确定性会话边界；这些路径无需调用 `principle_decision`。只有「同一任务内的 GOAL_SHIFT / PHASE_SHIFT」仍需语义判断 | `INFERRED`（基于源码事件语义） |

**SPEC 影响**：v0.4 §5.4 有 `HOST_TASK_BOUNDARY` 触发条件但停留在抽象层，§5.5 仍以 `maxUserTurnsWithoutReview=4` + 本地 fingerprint 为主要节奏，§12.4 明确「不要使用 unverified tool/compaction 事件作为设计输入」。在当前版本上这是**用模型调用去重复宿主已经确定性给出的边界**，直接违背 §17.5「Optimization order: 1. Avoid unnecessary Decision calls」。

## 3.2 Session 生命周期

| 问题 | 结论 |
|:---|:---|
| 如何可靠识别新 Session？ | `session_id`（所有事件均带，uuid）。`SessionStart.source`: `startup`=新会话、`resume`=恢复、`clear`=清空。IDE 文档声称的 `compact` 值在当前源码 NOT_FOUND |
| 新建 / 恢复 / 重置如何区分？ | `source` 三值可确定性区分；`SessionEnd.reason` 提供 `clear`/`other`。`/clear` 路径先 `SessionEnd(clear)` 再 `SessionStart(clear)`（`ENGINE:L218 @1792779/@1793498`） |
| `SessionStart` 是否可能重复？ | **会**：`resume`、会话分支/重命名（`ENGINE:L251 @1822457`）都会再次派发；v0.4 §5.3 的禁令正确，应保留 |
| `SessionEnd` 是否一定派发？ | **不保证**：`executeSessionEndHooks` 在无 hook 时直接 return；进程异常退出依赖 best-effort（`emitSessionEndBestEffort`）。因此**不能用 SessionEnd 作为唯一 Working Set 清理点**，需配合 TTL + revision |
| 稳定 Session ID / 跨进程稳定？ | `session_id` 在 payload 中稳定；工作记忆历史实证 `~/.workbuddy/projects/<encoded-cwd>/<sessionId>.jsonl`。跨进程共享同一会话 ID 的能力本轮 `NOT_RUN` |
| Session 迁移 / 切换 / 多 Agent 共用 Session？ | `TeammateIdle` / `SubagentStart` 表明存在 team/subagent 共享会话上下文；精确身份语义 `UNKNOWN` |

**本次会话实测**：`SessionStart` 1 次（source=startup），`executeSessionStartHooks=15613ms`、`emitSessionStartWithPreflight total=16736ms`（日志 `L2506/L2507`）。**30 s budget 已消耗过半**，且这是包含其它插件 hook 的整链耗时，SPEC §12/§14/§17 未把 SessionStart 整链耗时纳入预算模型 — `RUNTIME_VERIFIED`。

## 3.3 Compaction 生命周期

| 问题 | 结论 |
|:---|:---|
| 压缩前能否拿到完整上下文？ | `PreCompact` payload 含 `transcript_path` + `trigger` + `custom_instructions`，可读取压缩前 transcript；D2 的「备份完整上下文」用例即基于此 |
| 压缩后能否读取新上下文？ | `PostCompact` payload 含 `compact_summary`（引擎 `notifyPostCompact` → `executePostCompactHooks`）；**SPEC v0.4 未提及 PostCompact** |
| 能否安全保存 Working Set？ | 可以：`PreCompact` 作保存检查点、`PostCompact` 作重校验点；`PostCompact` 仅观察、不可阻断，适合做幂等重读 |
| 能否减少重复上下文读取？ | 可以，用 `compact_summary` 作为新的 contextFingerprint 输入，避免重扫 transcript |
| 压缩期间并发 / 状态竞争？ | 引擎 `Promise.allSettled` 并行 + PD 侧无锁保护则可能竞争；SPEC §8.3 的 revision check 可复用。本轮 `NOT_RUN`（本次会话无压缩事件） |

## 3.4 Tool 生命周期

| 问题 | 结论 |
|:---|:---|
| 能否识别 Agent 正在做什么类型的工作？ | 能：`PreToolUse`/`PostToolUse` 带 `tool_name` + `tool_input` + `tool_response`。本次会话实测 **164 / 162 次派发** — `RUNTIME_VERIFIED`，直接推翻 v0.4 §12.3「WorkBuddy tool events were NOT_RUN」作为当前环境的现状描述 |
| 能否识别关键决策阶段？ | 部分：工具类型序列（规划 → 编辑 → 测试 → 交付）可作确定性阶段信号；语义阶段仍需 PD 判断 |
| 能否识别规划→执行→验证→交付的阶段变化？ | 可用 `tool_name` 序列 + `TaskCompleted` 组合作为**低模型成本**的启发式输入，但不应把正则/关键词当作主语义选择器（v0.4 §5.9 的禁令应保留） |
| 是否应把部分刷新机制放到 Tool 生命周期？ | **应放「失效检测」而非「注入」**：工具事件适合触发 Working Set 重校验 / 采样 evidence，但注入仍应只在 `UserPromptSubmit` 发生，避免重复注入（v0.4 §7.1「只有一个 Working Set Resolver 产出最终集合」应保留） |

---

# 4. 第四阶段 — 真实运行验证

## 4.1 隔离探针执行裁定

**本轮未重建并运行真实引擎 Mock 探针，标记 `NOT_RUN`。** 具体原因（三条，均可复核）：

1. **隔离实验室已被清理**：`scripts/dev/workbuddy-probe/README.md:11` 指定的 `D:/Code/_worktrees/wb-probe-lab/` 目录**不存在**（本轮 `ls` 实测）。该 lab 需一次性重建 `iso-home/models.json`、本地 OpenAI 兼容 mock server、`marketplace/pd-probe` 探针插件、stream-json prompt feeder。
2. **无法在当前会话内独立证明隔离**：当前会话是真实生产 WorkBuddy 会话（pid 95164）。即使设置 `WORKBUDDY_CONFIG_DIR` + `CODEBUDDY_CONFIG_DIR`，第二个引擎实例仍与宿主共享安装目录、日志目录（`~/.workbuddy/logs/`）与全局 `installed_plugins.json`；本轮无权修改这些路径或验证其写入边界。用户明确要求「如果无法证明探针隔离，不要触碰真实会话」。
3. **禁止项约束**：不得用真实用户请求测试可能阻断提交的 Hook，不得触发不必要的付费模型调用。重建探针需启动第二个 agent loop 并驱动模型请求，与上述约束冲突。

**替代证据（本轮已取得）**：当前会话真实运行时日志（332 次 hook spawn，含 PD 全部 5 类注册事件中的 4 类）、当前版本引擎源码（2.165.0）、官方三份文档、历史隔离探针冻结契约（明确标注为不同基线）。**历史探针结论一律标 `HISTORICAL_PROBE`，不冒充本轮结果**。

## 4.2 P1–P6 探针状态

| 探针 | 本轮状态 | 已取得的证据 | 证据等级 | 仍缺什么 |
|:---|:---|:---|:---|:---|
| **P1 UserPromptSubmit** | **部分完成** | 真实派发 1 次（pid 85740，`timeout=15000ms`，命令指向 0.2.2）；PD 以 exit 1 degraded 返回；宿主非阻断放行；`additionalContext` 通道由源码确认进入 user 消息 | `RUNTIME_VERIFIED`（派发/返回）+ `SOURCE_CONFIRMED`（通道） | 本轮**未验证**一次成功 `additionalContext` 进入当前版本模型请求；多 Hook 返回合并未做运行时验证；超时阻断未做运行时注入测试 |
| **P2 SessionStart** | **部分完成** | 真实派发 1 次（pid 66216，30000ms，14:52:34.977）；与 workbuddy-docx hook 同一时间戳并发 spawn → **并发实证**；`source=startup`；耗时 15.552 s / 整链 16.736 s；`SessionStart` 注入位置 `"first"`、UPS `"last"`（源码确定性） | `RUNTIME_VERIFIED` + `SOURCE_CONFIRMED` | 派发相对顺序无运行时保证（源码显示 startup 走 preflight 异步、resume 有 join）；重复派发（resume/clear）本轮 `NOT_RUN` |
| **P3 Task / Subagent** | **NOT_RUN（本次会话未触发）** | 源码确认 `TaskCreated`/`TaskCompleted`/`SubagentStart`/`SubagentStop`/`TeammateIdle` 真实派发点 + `taskId`/`agent_id` 字段；官方 D3 列明触发时机 | `SOURCE_CONFIRMED / OFFICIAL_DOC` | 本次会话无 Task 工具调用、无 Subagent 事件，零运行时样本；Task ID 与 Session ID 关联未实测 |
| **P4 Compaction** | **NOT_RUN** | 源码确认 `PreCompact`/`PostCompact` 派发点与 payload（`compact_summary`）；历史探针 README 明确 `resume/compact injection persistence is UNKNOWN` | `SOURCE_CONFIRMED / HISTORICAL_PROBE` | 压缩前后上下文获取、Working Set 检查点安全性未验证 |
| **P5 Tool** | **完成（派发层）** | `PreToolUse` **164** 次、`PostToolUse` **162** 次真实派发，timeout=30000ms；典型耗时 1–3 s；`PostToolUseFailure` 0 次（本次无工具抛异常） | `RUNTIME_VERIFIED` | 工具结果内容、失败/重试、`PostToolUseFailure` 派发形状未做本轮运行时取样 |
| **P6 Timeout（8 场景）** | **NOT_RUN（真实宿主）+ 源码推演已完成** | 源码给出 8 场景的确定性语义表（见下）；本次会话**真实超时/阻断记录 0 条**（用宿主精确前缀 `[cbc-kw=HOOK] Hook timed out`、`HookBlockedError` 检索；另 3 条宽匹配命中经逐行核对全是取证命令回显） | `SOURCE_CONFIRMED / RUNTIME_VERIFIED(零样本)` | 未在隔离环境注入超时 / 异常退出 / 无效 JSON / 多 Hook 并发 |

### P6 八场景语义推演（`SOURCE_CONFIRMED`，非运行时验证）

| 场景 | 宿主行为 | 是否阻断 UPS |
|:---|:---|:---|
| 正常返回（exit 0 + JSON） | 解析 `hookSpecificOutput`，注入 `additionalContext` | 否 |
| 返回空内容（exit 0） | 中性，无注入 | 否 |
| 返回无效 JSON（exit 0） | 纯文本 stdout 兜底注入（**风险：脏文本进上下文**）；历史契约记 `bad-json-exit0` 未观察到注入，两者按基线差异分别登记 | 否 |
| 非零 exit 1 / 3 | 非阻断，`stderr` → `systemMessage`；**本次会话实测 exit 1** | 否 |
| exit 2 | 阻断（UPS 提示词被清除） | **是** |
| Hook 超时 | SIGTERM→SIGKILL，`exitCode:-1, allowed:false` | **是** |
| 进程异常退出 | 按 exit code 归类；无退出码按 error 处理 | 视码值 |
| 多 Hook 并发 / 长时间运行 | `Promise.allSettled` 并行，任一 `!allowed` 整体阻断；其它 hook 不被取消 | 视最严结果 |

## 4.3 「探针 / 派发 / 返回 / 模型请求」四层区分（本轮诚实判定）

| 层 | 本轮结果 |
|:---|:---|
| 探针成功 | 隔离探针 lab 不存在 → `NOT_RUN`；只读运行时取证成功 |
| Hook 派发成功 | ✅ `RUNTIME_VERIFIED`（本次会话 332 次 spawn，PD UPS/SessionStart/PreToolUse/PostToolUse 全有） |
| Hook 返回成功 | ❌ 本次 PD UPS 返回为 degraded exit 1；其它 hook 返回 exit 0。`RUNTIME_VERIFIED` |
| 模型请求包含注入内容 | ❌ 本次会话 0 条真实注入记录 → **未发生**；当前版本的成功注入形状仅有 `SOURCE_CONFIRMED`（源码）+ `HISTORICAL_PROBE`（2.161.0 P04 fixture） |
| 模型看到完整内容 | `UNKNOWN / NOT_RUN` |

## 4.4 可复现探针重建方案（供后续在隔离机器执行）

1. 建独立 lab：`D:/pd-wb-probe-<ts>/`，含 `iso-home/`、`marketplace/pd-probe/`、合成项目 `proj-a/`。
2. 写 `iso-home/models.json` 指向本地 `http://127.0.0.1:39471/v1/chat/completions` 的 mock model（`scripts/dev/workbuddy-probe/e2e-mock-server.mjs` 可作参考）；**禁止任何外部/付费模型端点**。
3. 探针插件：`.codebuddy-plugin/plugin.json` + `hooks/hooks.json`（注册 UPS/SessionStart/TaskCreated/TaskCompleted/PreCompact/PostCompact/Stop/SessionEnd）+ `scripts/hook.cjs`，按 `scenario.txt` 输出 8 种返回形状；另建一个 `async:true` hook 验证 detach。
4. 启动：`WORKBUDDY_CONFIG_DIR=<iso> CODEBUDDY_CONFIG_DIR=<iso>` **双变量必须同时设置**（`hook-runtime-contract.json:96` 明确单设时 transcript 会落到 `~/.codebuddy`）。
5. 用 `node <engine> -p --input-format stream-json --output-format stream-json --plugin-dir <probe> --no-session-persistence` 驱动；首条 startup prompt **不会**触发 UPS，需第二条 prompt（`hook-runtime-contract.json:29`）。
6. 断言：mock server 记录 request body 中 `role:"user"` 的 `<system-reminder data-role="hook">` 块位置、Task 事件 payload、8 场景 exit/阻断结果、async detach 是否阻塞提交。
7. 记录引擎 `--version` 与 `sha256sum <engine>`，绑定 profile。

---

# 5. 第五阶段 — PD 当前 WorkBuddy 集成审计

## 5.1 十五项逐项判定

| # | 检查项 | 判定 | 关键证据 |
|:--|:---|:---|:---|
| 1 | 事件注册是否完整 | **不完整**。`hooks.json` 只注册 5 个（PreToolUse / PostToolUse / PostToolUseFailure / UserPromptSubmit / SessionStart）；`host-adapter.ts:34-39` `SUBSCRIBED_EVENTS` 仅 4 个内部事件。宿主 29 个事件常量中 20+ 未接入 | `packages/workbuddy-adapter/plugin/hooks/hooks.json`；`src/host-adapter.ts:34-39` |
| 2 | 是否使用官方推荐 API | 基本符合：`${CODEBUDDY_PLUGIN_ROOT}`、`hookSpecificOutput.additionalContext`、command 类型、matcher `"*"` 均为官方推荐。**但 `PostToolUseFailure` 的 `matcher:"*"` 与官方语义一致，代码注释却否认其注册** | `output-encoder.ts:26-63`；`host-adapter.ts:17-20` |
| 3 | 是否存在过时 API | `output-encoder.ts` 未使用 `continue` / `decision` / `systemMessage` / `updatedToolOutput` / `ask`，白名单设计是**正确且克制**的；`additionalContextLimit` 只出现在 Codex canonical，WorkBuddy 引擎不识别（非 PD 过错，但配置漂移） | `output-encoder.ts:21-23,65-85` |
| 4 | hooks.json 与当前宿主版本匹配 | **功能匹配**（0.2.2 与 canonical SHA 一致，引擎识别 `timeout`）；但**配置未绑定引擎版本**，宿主升级不触发 PD 重验 | 本报告 §1 |
| 5 | Payload 解析是否正确 | 基本正确：`session_id`→sessionId、`generation_id`→turnId、`call_id`/`tool_use_id`→toolCallId、`cwd`→workspaceDir、`prompt`；SessionStart 无 cwd 由 `pd-hook.ts:282-283` 补治理目录。**未解析** `agent_id` / `agent_type` / `taskId` / `compact_summary` / `source` 的 resume/clear 语义 | `codec/input-decoder.ts:189-262` |
| 6 | 是否存在事件字段缺失导致降级 | **有**：SessionStart 无 cwd → 必须用治理目录兜底；无 `conversationId` / `workspaceId` 字段（PD 也未伪造，符合 SPEC §12.5） | `input-decoder.ts:219-227` |
| 7 | 是否存在错误事件顺序假设 | PD 本身未依赖顺序（UPS/SessionStart 各自独立处理），符合 v0.4 §5.3；但**未利用**宿主已确定的注入位置（SessionStart=first / UPS=last） | `pd-hook.ts:389-395` |
| 8 | Session ID 误用 | 未发现误用；`nativeIdentity = ['workbuddy', sessionId, turnId]`，用 `observationKey` 幂等去重，测试覆盖 replay | `explicit-owner-statement.ts:31-47`；`evidence-concurrency.test.ts` |
| 9 | 重复事件导致重复刷新 | **PD 侧有幂等，宿主侧有风险**：`mergeHooks` 拼接 + 三版 hooks.json 并存；且历史契约记录 `PreToolUse` 用 `continue:false` 会导致用户 prompt 被重新提交、UPS 再次派发 | `hook-runtime-contract.json:60` — `HISTORICAL_PROBE`；`ENGINE:L2506 @8220394` |
| 10 | 并发写入问题 | PD 有 `durable Runtime V2 task lease` + `evidence-concurrency.test.ts` 真实多进程覆盖；**但 wrapper 层 12 s 硬 deadline 与并发下的 SQLite 争用叠加，已在本次会话实际触发降级** | `src/worker/workspace-worker.ts:207-239`；运行时日志 |
| 11 | Hook 超时阻断用户提交风险 | **两条路径必须分开**：PD 自降级 exit 1 → 非阻断（本次实测）；宿主 kill / exit 2 → 阻断。当前 wrapper 12 s < 宿主 15 s，理论上安全，但**硬编码不感知实际 timeout**，配置变更即失效 | `plugin/scripts/wrapper.cjs:55,61,113-143` |
| 12 | 是否正确处理宿主注入通道 | 通道使用正确（`hookSpecificOutput.additionalContext`，仅 UPS）；**但对通道语义的理解不完整**：代码注释称「host wraps raw stdout as model-visible hook system-reminder」，`workbuddy-evidence-recorder.ts:43` 称 P04 已验证，而 SPEC v0.4 标 `UNKNOWN` — 三方表述冲突 | `output-encoder.ts:4-7`；`workbuddy-evidence-recorder.ts:37-44` |
| 13 | 是否有能力确认真实模型请求中的注入内容 | **没有**。`agent_context_delivery` 声明 `maxConfirmation:'submitted'`，`stdout submission is the proof boundary`；payload 固定 `confirmation:'submitted', outcome:'attempted'`，注释明确 `submitted ≠ delivered`。**无运行时回读 / 请求 diff** | `workbuddy-evidence-recorder.ts:37-44,147` |
| 14 | 可靠失败日志与诊断 | **部分可靠**：stderr 单行 `[PD] status=… reason=… nextAction=…`（`MAX_DIAGNOSTIC=500`）、`events_<date>.jsonl` 事件日志。本次会话确实留下了 degraded 记录 | `pd-hook.ts:53-61,84-99`；运行时日志 |
| 15 | 能否区分「已安装 / 已加载 / 已派发 / 已注入」 | **只能区分后两层**：adapter 不写安装日志（installer 才写）；插件未启用时 hook 根本不触发、无任何 PD 日志；`runtime_v2_prompt_activations_injected` 可表示注入意图但**本次 degraded 时无记录**，无法区分「degraded 空返回」与「成功注入」的 `delivery` 状态 | `manifest-facts.json:50-52`；本次会话日志 |

## 5.2 测试覆盖实况

| 测试 | 真实断言 | 性质 |
|:---|:---|:---|
| `plugin-skeleton.test.ts:123-202` | hooks.json 五事件注册、UPS 15 s、wrapper self-deadline < hooks.json timeout、`HOST_TIMEOUT_MS` mirror、800 ms override kill | **静态数值守卫 + wrapper 进程**；未验证真实宿主 timeout 阻断；守卫只针对 canonical 15 s，未覆盖 0.2.0 30 s 副本 |
| `pd-hook-production.test.ts:54-71` | UPS stdout 恰好 1 行 JSON、`additionalContext` 含唯一标记 | **只断言 stdout**，未验证进入模型请求 |
| `evidence-concurrency.test.ts` | 真实 N 进程并发 + SQLite 幂等 replay | 真实并发（**但未覆盖 wrapper deadline 与并发争用叠加**） |
| `workbuddy-real-engine-isolation.test.ts` | 驱动真实引擎 `plugin marketplace add/install/uninstall`，断言注册隔离；引擎不存在则 SKIP `NOT RUN, never faked green` | 真实引擎但仅注册隔离，**非事件派发/注入** |
| `host-contract.test.ts` | frozen fixture 字段映射、fail-loud 矩阵 | 纯单测 + fixture |
| `model-request-injection-shapes.json` | P04 历史探针的模型请求形状 | **fixture 数据，不是自动化断言**；`host-contract.test.ts:130` 反而断言它「不是 event payload」 |

**明确未覆盖**：真实宿主派发的自动化断言、当前版本注入进入模型请求的运行时确认、hostVersion/engineVersion 绑定、marketplace cache 与 canonical 一致性守卫、SessionStart resume/clear 语义、多版本 hooks.json 去重、async hook、Task/Compaction 事件、Desktop/IDE 运行时、wrapper deadline 在生产负载下的表现。

## 5.3 三个专项核查

1. **「注册即支持」？** 未发现该逻辑：`input-decoder.ts:52-58` 用白名单，未知 `hook_event_name` 直接抛错；`manifest-facts.json:50-52` 反而明确「plugin installed AND enabledPlugins true」才生效。但 `host-adapter.ts:17-20` 注释「PostToolUseFailure 未注册」与 `hooks.json:27` 已注册相矛盾（过时注释，P3）。
2. **CLI → IDE/Desktop 外推？** 无功能性外推代码；`SUBSCRIBED_EVENTS` 是显式白名单。但 `input-decoder.ts:5,44` 常量 `HOST_CONTRACT_BASELINE = 'WorkBuddy Desktop 5.8.1 / engine 2.161.0 (Phase 0 probe contract, 2026-10-12)'` 把 headless CLI + mock model 的取证命名为 Desktop；`docs/specs/workbuddy-host-adapter-spec.md:246` 亦有同类措辞。**属措辞层外推**，与 v0.4 §1.2(10) 的禁令并存。
3. **canonical 与安装缓存不一致？** **当前一致**（SHA-256 相同）；历史 0.2.0 不一致且物理残留。SPEC 把「不一致」写成现状，需要改为「版本漂移风险 + 残留治理」。

---

# 6. 第六阶段 — SPEC v0.4 逐章节重审

## 6.1 十二个关键问题

| # | 问题 | 回答 |
|:--|:---|:---|
| 1 | 是否充分利用 WorkBuddy 原生能力？ | **否**。29 个事件中只注册 5 个；Task/Session/Compaction/Subagent 确定性边界、async detach、PostCompact 均未用 |
| 2 | 是否存在不必要的模型调用？ | **是**。`HOST_TASK_BOUNDARY` 可用 `TaskCreated`/`TaskCompleted`/`SessionEnd` 确定性事件替代部分 `principle_decision`；§5.5 仍以 turn 计数 + fingerprint 为主节奏 |
| 3 | 是否存在错误的 Hook 生命周期假设？ | **有**：「`lite-wb` CLI 是独立 runtime mode」（实为 Desktop 承载 CLI 引擎）、「WorkBuddy tool events NOT_RUN / 不得作为设计输入」（当前 164/162 次真实派发）、「injection channel UNKNOWN」（已可判定）、「SessionStart 与 UPS 并发且顺序不保证」在派发层成立但**注入位置由源码确定为 first/last** |
| 4 | 是否有比 UserPromptSubmit 更适合的触发点？ | **注入仍以 UPS 最合适**（唯一能在当前回合补上下文的通道）。但「刷新触发」有更好组合：`TaskCreated`/`TaskCompleted`/`SessionEnd`/`PreCompact`/`PostCompact` + async hook；`SessionStart` 适合做会话级初始化而非刷新 |
| 5 | 是否需要 WorkBuddy 专用 Working Set 生命周期？ | **需要**。当前用 `sessionId`+`turnId` 绑定，缺 `generation_id` 轮内关联、`TaskId` 任务边界、`SessionEnd` 终点、`PostCompact` 重校验点 |
| 6 | 是否需要调整 Deferred Refresh 架构？ | **需要**。保留「同步只读缓存 / Native，模型推理延迟」的核心（正确），但执行载体应改为**宿主 `async:true` detached hook**，并显式声明「async hook 不提供当前回合注入」 |
| 7 | 是否存在可直接利用的后台执行机制？ | **有**（`async:true` + `asyncTimeout`）。§10.4/§14.2「不要假设宿主支持后台执行」「若无法证明 worker 则保持 OFF」应改为「WorkBuddy profile 使用已验证的 async hook，其它宿主仍各自验证」 |
| 8 | 是否需要调整 Injection Contract？ | **需要**。channel 从 `unknown` 改为 `user_message_system_reminder`；明确不得假设 system/developer 优先级；宿主无 `additionalContextLimit`，PD 自行截断；禁止把注入文本写成用户指令口吻 |
| 9 | 是否需要单独定义 WorkBuddy Runtime Profile？ | **需要，且 v0.4 已要求但代码未实现**。profile 必须绑定 `appVersion 5.9.2` + `engineVersion 2.165.0` + `pdPluginVersion 0.2.2` + `engineSha256` + `runtimeMode=desktop_cli_engine`，而非只有 `hostVersion` |
| 10 | 当前设计是否会导致阻断 / 重复注入 / 原则丢失？ | **原则丢失已经发生**（本次会话 degraded，0 注入）；重复注入风险来自多版本 hooks.json 拼接；阻断风险来自 wrapper 硬编码 deadline 与配置漂移 |
| 11 | 是否有必要为 WorkBuddy 制定不同于 Codex/OpenClaw 的策略？ | **有必要**：注入角色（user 内 system-reminder vs developer vs system）、异步能力（async hook）、生命周期事件丰富度（29 vs 少）、失败语义（exit 1 放行 / exit 2 阻断）都不同。v0.4 §ADR-011「共享核心 + 宿主适配契约」已提供正确框架，需要把 WorkBuddy 的具体契约填实 |
| 12 | 哪些需修订 / 哪些保留？ | **保留**：Runtime V2 唯一治理权威、Native/Model 双模、两阶段模型、多标签选择、三层上下文、共享核心+宿主适配器、`returned ≠ confirmed`、Shadow 不自动升 Live、所有 flag 默认 OFF、禁止外推未验证模式、禁止同步模型推理、Working Set Selector v0.2 Hold。**修订**：所有 WorkBuddy 宿主事实层、§5 触发与节流、§8 生命周期与并发、§10/§14 异步执行、§12/§13 profile 与注入契约、§15 证据、§17 性能、§19/§20 门禁与验收、§22 OQ、§23 ADR |

## 6.2 章节判定速览

| 章节 | 判定 | 主因 |
|:---|:---|:---|
| §3 Core Architecture | 修订（增补异步分支，保留核心） | 未体现宿主 async hook |
| §4 Context Model | 修订（补身份字段） | 缺 generationId/taskId/engineSha |
| §5 Host Event Semantics / Task Change Detection | **大幅修订** | 事件映射过时、NOT_RUN 结论错误、缺确定性边界 |
| §8 Working Set Persistence | 修订 | 缺 Hook 配置层去重、SessionEnd/Compaction 生命周期 |
| §9 Workspace Focus | 保留 + 小修 | F3 的 lifecycle 列表需补 PostCompact/Task 事件 |
| §10 Model Runtime Configuration | 修订 | `requireExactVersionMatch` 无实现；deferred worker 前提过时 |
| §11 Feature Flags | 修订（新增 flag） | 需 async refresh / profile 绑定开关 |
| §12 Host Runtime Capability Profiles | **大幅修订** | 版本基线、runtimeMode、channel、事件集全部过时 |
| §13 Host-specific Prompt Injection | **大幅修订** | channel UNKNOWN → 已判定；缺长度约束 |
| §14 Execution and Failure Handling | 修订 | 超时风险模型不完整（exit 1 vs 宿主 kill） |
| §15 Receipt and Evidence | 修订 | 需新增 `degraded` 状态与安装/加载/派发/注入四层 |
| §17 Performance and Cost | 修订 | 已有生产降级事实；SessionStart 15.6 s 未纳入 |
| §19 Rollout Plan | 修订 | Phase 0/2/3 门禁需加入 profile 重验与配置一致性 |
| §20 Acceptance Criteria | 修订 | 新增可观测/去重/异步/版本绑定验收项 |
| §21 Stop Conditions | 修订 | 新增「静默降级导致注入丢失」停止条件 |
| §22 Open Questions | 修订 | OQ-02/06/15 已可关闭或部分关闭；新增 OQ |
| §23 ADRs | 修订（新增 2 条） | 加 ADR-015 宿主原生异步、ADR-016 分模式证据 |

逐章节**完整建议替换文本**见 `PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.1.md`。

---

# 7. 第七阶段 — 改进方案摘要

完整交付见三份配套文档：

- `PD_WORKBUDDY_CAPABILITY_MATRIX_v0.2.md` — CLI / IDE / Desktop 分模式能力矩阵 + 全局执行模型。
- `PD_WORKBUDDY_INTEGRATION_GAP_AUDIT_v0.1.md` — 22 项 Gap（3×P0 / 9×P1 / 7×P2 / 3×P3），含证据、影响、修复与「是否改代码 / 是否改 SPEC」。
- `PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.1.md` — 逐章节替换文本、新增接口、验收标准与测试要求。
- `PD_WORKBUDDY_EVIDENCE_MANIFEST_v0.1.md` — 全部证据索引与 SHA-256。

## 7.1 推荐的 WorkBuddy 事件组合（最小且充分）

| 目的 | 事件 | 理由 |
|:---|:---|:---|
| 当前回合注入 | `UserPromptSubmit`（15 s） | 唯一能在当前回合补上下文的通道 |
| 会话初始化 | `SessionStart`（30 s，只做 health / 版本绑定校验） | 注入位置 `first`，与 UPS `last` 不冲突；不做 Working Set 计数 |
| 确定性任务边界 | `TaskCreated` / `TaskCompleted` / `SessionEnd` | 替代部分 Decision Model 调用，零模型成本 |
| 压缩检查点 | `PreCompact`（保存）+ `PostCompact`（重校验） | `compact_summary` 可作新 fingerprint |
| 异步刷新 | `async:true` detached command hook | 宿主原生后台能力，不阻塞提交 |
| 证据采集（已有） | `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | 维持现状，不新增注入 |

**不建议新增**：`Notification` / `PermissionRequest` / `Worktree*` / `Elicitation*` — 与原则激活准确性无直接关系，徒增集成复杂度（遵循 v0.4 §6.4 「不要为了增加 Hook 数量而增加集成复杂度」）。

## 7.2 八项架构建议一句话

1. **事件组合**：UPS 注入 + SessionStart 初始化 + Task/Session/Compaction 确定性刷新 + async hook 后台计算。
2. **Session 生命周期**：以 `session_id` 为主键、`source` 区分 startup/resume/clear，`SessionEnd` 作尽力清理、TTL 作兜底，不用 SessionStart 计数。
3. **Task Change Detection**：宿主 Task 事件直接产出 `NEW_TASK` / 任务边界，只有同任务内 GOAL/PHASE_SHIFT 才调用 Decision Model。
4. **Working Set 更新**：`generation_id` + `contextFingerprint` + revision 乐观锁；新增 Hook 配置层去重（安装版本 + engineSha 绑定）。
5. **异步刷新**：`async:true` detached hook，声明「不提供当前回合注入」，结果只在后续 UPS 生效。
6. **Prompt Injection**：`hookSpecificOutput.additionalContext`，按 `user_message_system_reminder` 契约编码，PD 自行截断，内容自包含且不伪装成用户指令。
7. **超时降级**：wrapper 从**实际生效 hooks.json 读取 hard timeout** 并计算 soft deadline；degraded 必须写 `delivery=degraded` receipt，禁止静默。
8. **Evidence**：新增 `installed / loaded / dispatched / returned / degraded / confirmed` 六层，当前版本 `confirmed` 仍需请求级证据；`returned` 不得标 `confirmed`。

---

# 8. 最终裁定

## 8.1 七个必答问题

1. **WorkBuddy 当前是否具备支持 PD Adaptive Activation 的条件？** — **具备，且条件优于 v0.4 假设**。宿主提供 29 事件、并行多进程、async detach、稳定 `session_id`/`generation_id`/`taskId`、Pre/PostCompact、明确的 exit/timeout 语义。限制也很明确：注入只在 UPS 生效且进入 user 消息、宿主无注入长度闸门、无框架级共享状态、`SessionEnd` 非保证派发。
2. **当前 PD 对 WorkBuddy 的支持处于什么成熟度？** — **「已安装并运行，但可观测性与自适应能力不足」**：插件 0.2.2 已 installed/enabled/loaded/dispatched，5 事件注册、payload 解析与注入编码基本正确，有幂等与并发测试；但**本次会话的实际注入已因 12 s 自降级而丢失**，无 Host Profile 运行时实现、无版本绑定、无 `confirmed` 证据、无生命周期/异步能力利用、无真实宿主派发的自动化回归。
3. **v0.4 对 WorkBuddy 的设计是否充分？** — **不充分**。架构骨架正确，宿主事实层过时（引擎 2.161.0→2.165.0、PD 0.2.0→0.2.2、lite-wb 概念、channel UNKNOWN、tool events NOT_RUN），且未纳入宿主原生生命周期与异步能力。
4. **哪些必须在 SPEC 定稿前解决？** — ① 注入静默丢失与 `degraded` 证据（P0）；② wrapper 硬编码 deadline 与配置漂移（P0）；③ delivery status 落地（P0）；④ profile 版本/引擎绑定与基线重验（P1）；⑤ injection channel 改判与契约修订（P1）；⑥ `HOST_TASK_BOUNDARY`/Throttling 改为宿主确定性事件优先（P1）；⑦ Deferred Refresh 改用 async hook（P1）；⑧ 多版本 hooks.json 去重（P1）。
5. **哪些可留给实现阶段？** — adapter 具体事件编码、PostCompact 检查点实现细节、`additionalContext` 截断阈值、SessionEnd 兜底清理策略、测试夹具重建、Desktop/IDE 分模式 profile 的第二轮运行时验证、Examiner 归因实验。
6. **哪些不值得投入工程资源？** — 为 WorkBuddy 重建独立注入/治理/模型运行时子系统；把 `Notification`/`PermissionRequest`/`Worktree*`/`Elicitation*` 接入 Adaptive Activation；为形式统一而强行让三宿主共用同一 timeout / channel / 事件映射；在当前生产会话内重跑阻断类探针。
7. **是否应单独制定更深入的 WorkBuddy Host Adapter 设计？** — **应该**。不是因为 WorkBuddy 能力弱，恰恰因为它能力面显著宽于另外两个宿主（29 事件 + 异步 + Task/Compaction 生命周期 + 会话级证据链），值得一份独立的 Host Adapter Contract，而不是塞进三宿主通用表格里被拉平。

## 8.2 结论

> ## **NEEDS_SPEC_REVISION**
>
> 不是 `BLOCKED_BY_HOST_CAPABILITY`：宿主能力充足，且比 v0.4 假设的更强。
> 不是 `READY_WITH_LIMITATIONS`：已发生的生产注入丢失属于 P0，不是可接受的「限制」。
> 不是 `READY_FOR_SPEC_FINALIZATION`：宿主事实基线失效会直接传导到 §12 profile 门禁、§19 发布门禁与 §20 验收标准。
>
> **定稿前置条件**：完成 §8.1(4) 的 8 项修订，并以**当前 5.9.2 / 2.165.0 / 0.2.2** 为基线重新冻结 Host Runtime Capability Profile；在隔离 lab 重建后补跑 P1/P3/P4/P6 探针，闭合「模型请求包含注入内容」的 `RUNTIME_VERIFIED` 证据。

---

# 附录 A — 本轮执行纪律核对

| 允许项 | 执行情况 |
|:---|:---|
| 读取本地仓库 | ✅ |
| 检查 WorkBuddy 实际安装目录 | ✅ |
| 检查当前生效 Hook 配置 | ✅ |
| 阅读官方文档 | ✅ 3 个页面 |
| 阅读匹配版本源码 | ✅ 引擎 bundle 2.165.0 |
| 执行只读诊断 | ✅ 进程、配置、日志、`--version`、SHA-256 |
| 隔离环境 Mock 探针 | ❌ `NOT_RUN`（原因见 §4.1），已交付可复现方案 |
| 运行不改变系统状态的测试 | ✅ `node <engine> --version`、只读统计 |
| 生成独立审计报告与 SPEC 修改建议 | ✅ 5 份文档 |

| 禁止项 | 是否触碰 |
|:---|:---|
| 修改 WorkBuddy 实际安装配置 | ❌ 未 |
| 更新/重装 WorkBuddy | ❌ 未 |
| 修改 PD 生产插件 | ❌ 未 |
| 修改生产数据库 | ❌ 未 |
| 修改用户真实会话 | ❌ 未 |
| 合并 PR / 部署 / 发布 | ❌ 未 |
| 用真实用户请求测试阻断 Hook | ❌ 未 |
| 触发付费模型调用 | ❌ 未 |
| 自行修改 SPEC v0.4 原文 | ❌ 未 |
| 打印 API Key / Token / Cookie | ❌ 未（`settings.json` 仅输出键名与 PD 布尔值） |

---

**END OF PD_WORKBUDDY_HOST_AUDIT_v0.1.md**
