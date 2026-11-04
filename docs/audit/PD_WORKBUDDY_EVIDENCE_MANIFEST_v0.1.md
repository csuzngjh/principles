# PD × WorkBuddy Evidence Manifest v0.1

> **PD_WORKBUDDY_EVIDENCE_MANIFEST_v0.1.md** — 全部关键结论的证据索引
> 检查日期：2026-11-04（GMT+8）｜ 对应报告：`PD_WORKBUDDY_HOST_AUDIT_v0.1.md`
> 配套：`PD_WORKBUDDY_CAPABILITY_MATRIX_v0.2.md` / `PD_WORKBUDDY_INTEGRATION_GAP_AUDIT_v0.1.md` / `PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.1.md`

## 0. 证据纪律

**等级**：`OFFICIAL_DOC` / `SOURCE_CONFIRMED` / `RUNTIME_VERIFIED` / `STATIC_CONFIG` / `HISTORICAL_PROBE` / `INFERRED` / `NOT_RUN` / `UNKNOWN` / `NOT_FOUND`。

**冲突处理优先级**（本轮严格执行）：① 当前安装环境真实运行证据 → ② 与当前版本匹配的宿主源码 → ③ 当前版本对应的官方文档 → ④ PD 仓库实现与测试 → ⑤ 历史探针报告 → ⑥ 设计推断。**不同来源描述不同运行模式时分别登记，不互相覆盖**（§9）。

**脱敏**：全程未打印 API Key / Token / Cookie / 密钥内容；`settings.json` 仅输出顶层键名与 `enabledPlugins` 中 PD 项的布尔值；`product.json` 仅输出版本相关字段；日志引用仅含 hook 命令行与诊断文本。

**执行纪律**：只读。未修改宿主安装配置、插件、生产数据库、用户会话或 SPEC v0.4 原文；未触发付费模型调用。

---

# 1. 官方文档证据（OFFICIAL_DOC）

| ID | URL | 定位 | 文档版本 / 状态 | 检查日期 | 本轮提取要点 |
|:---|:---|:---|:---|:---|:---|
| D1 | `https://www.codebuddy.ai/docs/zh/cli/hooks` | CodeBuddy Code **CLI**「Hook 参考指南」 | 声明适用 **CodeBuddy Code v1.16.0+**；Hooks **Beta**；**页面未提供最后更新日期 / 文档版本号** | 2026-11-04 | 27+ 事件（正文列 27 名）、10 事件详述；公共 payload `session_id/transcript_path/cwd/permission_mode/generation_id`；`generation_id` 同轮 UPS/Stop 共享、不可用时应省略；stdout JSON `continue/stopReason/suppressOutput/systemMessage/hookSpecificOutput`；`decision:"block"` 废弃；exit 0/1/2/其他语义；默认 timeout **60 s**（60000ms）、prompt hook 30 s；不同作用域**合并而非覆盖**、同事件**并行**、相同命令去重；Windows 强制 Git Bash；启动时快照 + `/hooks` 审查生效；`SessionStart` matcher 含 `startup/resume/clear/compact`；`allowUntrustedFrontmatterHooks` 闸门 |
| D2 | `https://www.workbuddy.ai/docs/ide/Features/hooks` | **IDE**（Craft Agent）「Hook User Guide」 | 声明「完全兼容 Claude Code Hooks 规范」；**无版本号、无更新日期、未出现 `Desktop` 字样** | 2026-11-04 | **仅 7 事件**（SessionStart/SessionEnd/PreToolUse/PostToolUse/UserPromptSubmit/Stop/PreCompact）；`SessionStart` 按 `conversationId` 每会话只触发一次、matcher 仅 `startup`；`SessionEnd.reason` 仅 `other`；**项目级配置覆盖用户级**；**exit 2 时 stdout 忽略、stderr 传给 Agent**；并行、顺序不保证；timeout 默认 60 s；`tool_name` 为 IDE-style（`execute_command`/`write_to_file`）；未说明注入角色、未说明 async |
| D3 | `https://www.codebuddy.ai/docs/zh/cli/plugins-reference` | CLI 插件参考 | 未提供版本号 / 更新日期 | 2026-11-04 | 「可用事件」表 **27 个事件名 + 触发时机**（含 `PostToolUseFailure`/`StopFailure`/`PermissionDenied`/`TaskCreated`/`TaskCompleted`/`PostCompact` 等）；`hooks/hooks.json` 结构；hook 类型 `command/http/prompt/agent`；`${CODEBUDDY_PLUGIN_ROOT}` 在**插件更新时会变化**、写入其中的文件不保留；`defaultEnabled` 默认 true、已有 `enabledPlugins` 优先；版本化缓存；frontmatter hooks 受安全闸门约束而插件 `hooks/hooks.json` 不受限；**页面未提供 Hook timeout 单位/默认值或完整合并算法** |
| D4 | `docs/plans/2026-10-12-workbuddy-official-hooks-reference.md` | 仓库内 D1/D3 的 2026-10-12 SSG→Markdown 快照 | 工作记忆记载 `lastUpdated 2026-09-17`、构建 commit `4a4c8c2c72d`；本轮在线页面未复现该字段 | 历史快照 | 用于对照版本漂移，未作为本轮结论主证据 |
| D5 | `docs/plans/2026-10-12-workbuddy-official-plugins-reference.md` | 仓库内插件参考快照（46 KB） | 同上 | 历史快照 | 同上 |

> **D1 与 D2 的关系**：两者描述不同模式且互相矛盾（见 §9）。工作记忆 `.workbuddy/memory/topics/workbuddy-host-adaptation.md:44` 已把中文站 IDE Hooks 页标注为「旧版，勿作信源」；本轮按用户要求仍抓取 D2 并完整登记，但**不将其作为当前 Desktop/CLI 引擎能力的判据**。

---

# 2. 运行环境与版本证据（RUNTIME_VERIFIED / STATIC_CONFIG）

| ID | 结论 | 证据路径与内容 | 等级 |
|:---|:---|:---|:---|
| E-01 | App **5.9.2** | `D:/Program Files/WorkBuddy/resources/app.asar` → `asar:///package.json`（绝对偏移 `@132317121`，size 10155）：`name="@genie/workbuddy-desktop"`, `version="5.9.2"`, `main="main/index.js"` | `SOURCE_CONFIRMED` |
| E-02 | App **5.9.2** / 构建 2026-10-24 | `D:/Program Files/WorkBuddy/resources/install-manifest.json:2-5`：`version:"1"`, `appVersion:"5.9.2"`, `generatedAt:"2026-10-24T08:48:55.660Z"`, `fileCount:118` | `STATIC_CONFIG` |
| E-03 | App **5.9.2** / commit | `…/app.asar.unpacked/cli/product.json`：`productName="WorkBuddy"`, `dataFolderName=".workbuddy"`, `genieVersion="5.9.2"`, `commit="0b5051be70a4899bb5dc6497cd2275e912abe953"`, `date="2026-10-24T08:44:37.992Z"` | `STATIC_CONFIG` |
| E-04 | Electron **37.10.3-43** / Chrome 138 | `D:/Program Files/WorkBuddy/version:1` = `37.10.3-43`；`WorkBuddy.exe` 二进制串 `Electron/37.10.3`、`Chrome/138.0.7204.251`；VersionInfo `ProductVersion=5.9.2.0` | `STATIC_CONFIG / RUNTIME_VERIFIED` |
| E-05 | 引擎 **2.165.0** | `D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/package.json` `name="@genie/agent-cli"`, `version="2.165.0"`；引擎内嵌 JSON `@4811915`（L744）同一版本；**本轮独立执行** `node "D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs" --version` → `2.165.0`；`~/.workbuddy/logs/main.log` 命中 44 次 | `RUNTIME_VERIFIED / SOURCE_CONFIRMED` |
| E-06 | 引擎文件与指纹 | `…/cli/dist/codebuddy-lite-wb.mjs`，9,880,062 B，**SHA-256 `6fbfd77bae7e7688abf7dfd2488b50c79390c966a9132e73ebe7a5a2d7df99cf`** | `STATIC_CONFIG` |
| E-07 | 运行模式 = **Desktop** | 8 个 `WorkBuddy.exe` 进程（主 PID 86228；hook 引擎承载 pid 95164）；`ExecutablePath` 全部 `D:\Program Files\WorkBuddy\WorkBuddy.exe`；无独立 `codebuddy.exe`；`app.asar` 内 5117 个文本文件对 `UserPromptSubmit`/`SessionStart`/`additionalContext`/`hooks.json` 命中 **0** → 主进程包内不含 hook 实现 | `RUNTIME_VERIFIED / SOURCE_CONFIRMED` |
| E-08 | 启动版本记录 | `C:/Users/Administrator/.workbuddy/last-launch.json:1`：`{"version":"5.9.2","build":"0b5051be…","timestamp":"2026-11-04T05:47:02.966Z"}`；`startup-seed-version.json` `{"appVersion":"5.9.2"}` | `STATIC_CONFIG` |
| E-09 | PD 插件 **0.2.2**，已安装 | `…/plugins/installed_plugins.json` → `principles-disciple@principles-disciple-market`: `scope=user`, `installPath=…\0.2.2`, `version="0.2.2"`, `installedAt="2026-10-15T12:46:49.876Z"`, `lastUpdated="2026-11-04T05:47:10.465Z"` | `STATIC_CONFIG` |
| E-10 | PD 插件**已启用** | `~/.workbuddy/settings.json`：`enabledPlugins["principles-disciple@principles-disciple-market"] = true`（覆盖 `plugin.json` 的 `defaultEnabled:false`）；顶层 **无 `hooks` 键**（6 个顶层键：`enabledPlugins/sandbox/autoLaunchDefaultApplied/claw/officeMarkdownDefaultClaimAttempted/officeFileAssociationsRepairMarker`） | `STATIC_CONFIG` |
| E-11 | 已加载 | `plugins/cache/…/0.2.2/.in_use/95164` 存在；运行时日志 `L349`（14:52:33.189）与 `L1706`（14:52:35.596）`Loaded hooks configuration from extension: principles-disciple@principles-disciple-market` | `RUNTIME_VERIFIED` |
| E-12 | 历史基线失效 | `hook-runtime-contract.json:2,4-6` 记录历史探针 engine `2.161.0` / Desktop `5.8.1` / engine SHA-256 `fd9d20c75264d20caf8878edc9cf374b333081113595486628d0bd8b8ca374ad`；与 E-05/E-06 均不同 → 历史探针基线 `EXPIRED` | `HISTORICAL_PROBE + RUNTIME_VERIFIED` |
| E-13 | 无版本不兼容迹象 | 宿主日志对 `incompatible`/`version mismatch`/`[cbc-kw=HOOK] Hook timed out` 精确检索为 **0**；唯一 hook 加载错误 `L346/L1704` 为 `tencent-docs-plugin/5.9.2-…` 的 `EISDIR`，与 PD 无关；引擎全文不读取 PD `runtime-version.json` pins | `RUNTIME_VERIFIED / INFERRED` |

---

# 3. 当前安装配置与 SHA-256（STATIC_CONFIG）

| ID | 绝对路径 | 内容 / 数值 | SHA-256 |
|:---|:---|:---|:---|
| C-01 | `C:/Users/Administrator/.workbuddy/plugins/cache/principles-disciple-market/principles-disciple/0.2.2/hooks/hooks.json` | **当前生效**：`PreToolUse` 30 / `PostToolUse` 30 / `PostToolUseFailure` 30 / **`UserPromptSubmit` 15** / `SessionStart` 30；matcher `"*"` 仅工具事件；command `node "${CODEBUDDY_PLUGIN_ROOT}/scripts/wrapper.cjs" <Event>` | `556d546aacf0bd66c10360e5823ce39e7f979cd36970766908af78ba66a21a85` |
| C-02 | `D:/Code/principles/packages/workbuddy-adapter/plugin/hooks/hooks.json` | 仓库 WorkBuddy canonical，与 C-01 **逐字一致** | `556d546aacf0bd66c10360e5823ce39e7f979cd36970766908af78ba66a21a85` |
| C-03 | `…/principles-disciple/0.2.0/hooks/hooks.json` | 旧版：**全部 5 事件均 30 s**（即 SPEC v0.4 所称「marketplace cache 0.2.0 30 s」）；已标 `.orphaned_at`（2026-11-04 13:47），文件仍在磁盘 | `d9a2a29c1862643450bb07b761964b62732d3d41e7f3638ee7ba62b5dcc78718` |
| C-04 | `…/principles-disciple/0.1.0/hooks/hooks.json` | 更旧版本，全 30 s，已标 `.orphaned_at`（2026-10-23 08:46），仍在磁盘 | 本轮未计算 |
| C-05 | `C:/Users/Administrator/.pd/workbuddy-marketplace/principles-disciple/hooks/hooks.json` | marketplace 源，15/30，mtime `2026-11-04 12:52:49` | 本轮未计算 |
| C-06 | `C:/Users/Administrator/.pd/runtime/workbuddy-adapter/plugin/hooks/hooks.json:39-45` | 安装运行时副本，`UserPromptSubmit timeout:15` | 本轮未计算 |
| C-07 | `C:/Users/Administrator/.pd/backups/runtime.backup.1793772420152/…/hooks.json` | 备份副本 | 本轮未计算 |
| C-08 | `D:/Code/principles/plugins/principles-disciple/hooks/hooks.json` | **Codex canonical**（非 WorkBuddy）：5/5/**5**/30/5，`additionalContextLimit:10000`，`statusMessage`，`${PLUGIN_ROOT}`，多一个 `Stop` | 本轮未计算 |
| C-09 | `…/0.2.2/.codebuddy-plugin/plugin.json` | `name:"principles-disciple"`, `version:"0.2.2"`, `defaultEnabled:false`，描述含 `read-only pd-recall MCP server (Gate 4)` | 本轮未计算 |
| C-10 | `D:/Code/principles/packages/workbuddy-adapter/package.json:2-4` | `@principles/workbuddy-adapter@0.3.0`（包版本，非插件 manifest 版本） | 本轮未计算 |
| C-11 | `D:/Code/principles/docs/specs/PD Adaptive Activation SPEC v0.4.md` | 评审输入，2995 行 / 122055 B | `c022cd66a73d2d644e6b91e24df280b08772ae3a93e77a97e7b30268e5b520c4` |
| C-12 | `C:/Users/Administrator/.workbuddy/plugins/known_marketplaces.json` | `principles-disciple-market`: `type="directory"`, `source.path="C:\Users\Administrator\.pd\workbuddy-marketplace"`, `autoUpdate=false` | 本轮未计算 |
| C-13 | 多版本并存统计 | `~/.workbuddy/` 30 份 `hooks.json`、`D:/Program Files/WorkBuddy/` 4 份、`~/.pd/` 3 份、`D:/Code/principles/` 18 份 → **合计 55 份**；`plugins/cache/workbuddy-builtin/` 另有 5.8.3 / 5.9.0 / 5.9.2 三套宿主版本缓存 | `STATIC_CONFIG` |

> **C-01 与 C-02 SHA-256 相同**是「canonical 与当前安装副本一致」的字节级证据；SPEC v0.4 描述的 15 s/30 s 差异对应 C-03，而 C-03 已非生效版本。

---

# 4. 宿主源码证据索引（SOURCE_CONFIRMED）

> `ENGINE` = `D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs`（SHA-256 见 E-06）。`L` 为行号，`@` 为文件内字节偏移（bundle 为长行，优先用偏移定位）。

| ID | 结论 | 位置 | 关键片段 / 说明 |
|:---|:---|:---|:---|
| S-01 | 宿主默认 timeout 60 s | `ENGINE:L572 @3576352` | `kp=6e4` |
| S-02 | `hooks.json` timeout（秒）覆盖默认 | `ENGINE:L576 @3598100` | `executeCommandHook`: `let h={timeout:t.timeout?1e3*t.timeout:void 0,…}` |
| S-03 | Hook = 独立子进程 | `ENGINE:L572 @3579239` | `L=(0,pg.spawn)(c,p,N); registerHookPid(L.pid); … [HookExecutor] spawn pid=… timeout=${A}ms` |
| S-04 | 超时 kill | `ENGINE:L572 @3579307` | `setTimeout(()=>{…L.kill("SIGTERM"),setTimeout(()=>{L.killed||L.kill("SIGKILL")},1e3)},A)` |
| S-05 | 超时返回阻断 | `ENGINE:L572 @3580460` | `if(E)return void s({allowed:!1,exitCode:-1,…,message:\`Hook timed out after ${A}ms\`})` |
| S-06 | stdin 写入 | `ENGINE:L572 @3581750` / `@3607672` | `JSON.stringify(I)` 写入 `L.stdin`；`buildHookInputForCommand` 用 `JSON.stringify(i,null,2)` |
| S-07 | **`async:true` detached** | `ENGINE:L572 @3579844–@3580030` | `B=!0; let i=…n.asyncTimeout…; clearTimeout($); … s({allowed:!0,exitCode:0,stderr:S})`；日志 `async hook detached pid=… asyncTimeout=…ms` |
| S-08 | 多 Hook 并行 | `ENGINE:L572 @3589460–@3589890` | `for(let s of I)h.push(this.executeLocalHook(...)); … await Promise.allSettled(h); P=this.aggregateSettledResults(t)` |
| S-09 | 本地 + SDK 并行合并 | `ENGINE:L572 @3590320` | `let F=[{status:"fulfilled",value:P},...await Promise.allSettled(O)]` |
| S-10 | 结果合并规则 | `ENGINE:L572–576 @3593410–@3594589` | 任一 `!allowed` → 整体 `allowed=false`；`message`/`stdout` 换行拼接；`blockingDetails` 累积；`hookSpecificOutput` 浅合并 |
| S-11 | SDK 侧合并优先级 | `ENGINE:L572 @3513100` | `permissionDecision` `deny > ask > allow`；`additionalContext` 数组累积；`continue:false` → `shouldContinue=false` |
| S-12 | **exit code 语义** | `ENGINE:L572 @3583830–@3584260` | `exit 2` → `allowed=false, blockSource="exit2", blocking=true`（stderr 作消息）；`0!==t` 其它非零 → `allowed=true` + `systemMessage` 非阻断警告；`exit 0` → 放行 |
| S-13 | stdout JSON 解析 | `ENGINE:L576 @3582610` | `parseHookOutput`：`{allowed:0===t,exitCode:t??-1,…}`；`permissionDecision:deny` 阻断；`decision:"block"` 兼容但 deprecated；`continue`/`suppressOutput`/`systemMessage` |
| S-14 | UPS 阻断提交 | `ENGINE:L2270 @7486690` | `if(n(s.allowed),!s.allowed){…throw new e2._2("UserPromptSubmit", s.message||"User input blocked by hook", s.blockingDetails)}`；`_2` = `HookBlockedError`（`L2789 @8618251`） |
| S-15 | UPS 接受 additionalContext | `ENGINE:L2270 @7485400–@7487120` | `executeUserPromptSubmitHooks`：`if(s.hookSpecificOutput?.additionalContext) t.hookContexts.userPromptSubmitContext=…; else if(s.stdout&&!s.suppressOutput) …纯文本兜底` |
| S-16 | **注入消息角色（最关键）** | `ENGINE:L116 @1387419–@1389139` | `injectHookContexts(t)`：`let n=\`<system-reminder data-role="hook">${i}</system-reminder>\`; t$.r7s.addSystemReminder(t.input,n,"last")` for UPS（SessionStart 用 `"first"`）；条件 `this.isUserMessage(t)` 限制 UPS 只注入用户消息 |
| S-17 | `role:"user"` 构造与守卫 | `ENGINE:L97 @1309781` / `L25 @1050719` / `L576 @3595019` | `if($?.type==="message"&&"user"===$.role&&$.providerData?.isMeta!==!0){…addSystemReminder(...,"last")}`；`buildPreloadItem` `{type:"message",role:"user",…}`；`mergeMessages` `{type:"message",role:"user",content:…,providerData:{isMeta:!0}}` |
| S-18 | PostToolUse 注入不同通道 | `ENGINE:L363 @2184377–@2184466` | `p.additionalContext&&O.push({type:"text",text:\`\n<system-reminder data-role="tool-hint">…\`})` |
| S-19 | 事件枚举 29 项 | `ENGINE:L348 @2096867–@2098323` | `USER_PROMPT_SUBMIT, NOTIFICATION, STOP, SUBAGENT_STOP, WORKTREE_CREATE, WORKTREE_REMOVE, POST_COMPACT, ELICITATION_RESULT, TASK_CREATED, TASK_COMPLETED, TEAMMATE_IDLE, CWD_CHANGED, FILE_CHANGED, FINAL_STOP, PRE_TOOL_USE, POST_TOOL_USE, SESSION_START, SESSION_END, PRE_COMPACT, POST_TOOL_USE_FAILURE, SUBAGENT_START, STOP_FAILURE, CONFIG_CHANGE, INSTRUCTIONS_LOADED, PERMISSION_REQUEST, PERMISSION_DENIED, ELICITATION, SETUP, USER_PROMPT_EXPANSION` |
| S-20 | `TaskCreated` 派发 | `ENGINE:L1916 @6040660` | `TaskCreateTool.execute` → `executeTaskCreatedHooks(s,{taskId:String(t.id),subject:t.subject,…})`（**camelCase `taskId`**） |
| S-21 | `TaskCompleted` 派发 | `ENGINE:L1916 @6048230` | `TaskUpdateTool` 状态 `"completed"` → `executeTaskCompletedHooks(n,{taskId,…})` |
| S-22 | Subagent 派发 | `ENGINE:L27 @1070395` / `L20 @1043445` | `executeSubagentStartHooks(this.subAgentSession)` / `await this.executeSubagentStopHookOnce()` |
| S-23 | Compaction 派发 | `ENGINE:L2332 @7915731` / `L99 @1328031` / `L2271 @7492848` | `notifyPreCompact → executePreCompactHooks`；`notifyPostCompact → executePostCompactHooks`；手动 `/compact` `trigger="manual"` |
| S-24 | SessionStart source | `ENGINE:L576 @3596739` / `L2270 @7487424` / `L2272 @7526016` / `L218 @1793498` / `L251 @1822457` | `source` 默认 `startup`；`/clear` → `emitSessionStart(s,"clear")`；分支/重命名 → `emitSessionStart(E,"resume")`；**未找到 `compact` 作为 SessionStart source** |
| S-25 | SessionEnd 派发 | `ENGINE:L2270 @7489374` / `@7490023` / `L218 @1792779` / `L572 @3336329` | `if(!await this.hookManager.hasHooks(SESSION_END))return`（无 hook 不派发）；`reason` 默认 `other`；`emitSessionEndBestEffort` |
| S-26 | Payload 字段构造 | `ENGINE:L576 @3595449–@3597599` / `@3607672` | `convertToSdkInput` / `buildHookInputForCommand` 全字段清单（见 Host Audit §2.4） |
| S-27 | generation_id / model 注入 | `ENGINE:@3711436–@3711488` | `GenerationContextHookInputProcessor.process`：`t.generation_id=t.session.conversationRequestId`；`t.model` 从 requestOptions / 当前模型补全；`L572 @3589030` `runInputProcessors` 在派发前调用 |
| S-28 | **配置拼接而非覆盖** | `ENGINE:L2506 @8220394` | `HookExtensionLoader`：`rn="hooks/hooks.json"`；`mergeHooks(t,i){for(let[n,s]of Object.entries(i))t[n]=[...t[n]||[],...s]}` |
| S-29 | 插件根变量替换 | `ENGINE:L2506 @8100836` / `L576 @3598100` | `enrichPluginHookConfigs` 替换 `${CODEBUDDY_PLUGIN_ROOT}`；同时支持 `CLAUDE_PLUGIN_ROOT` / `CODEBUDDY_PLUGIN_DATA` |
| S-30 | 匹配与去重 | `ENGINE:L576 @3592980` / `L572 @3589460` | `getMatchValue`：PRE/POST_TOOL_USE→`tool_name`、SESSION_START→`source`、SESSION_END→`reason`、PRE_COMPACT→`trigger`、NOTIFICATION→`notification_type`；`deduplicateHooks(R)` |
| S-31 | `additionalContextLimit` 不存在 | `ENGINE` 全文 | 字面计数 **0**（`NOT_FOUND`）；`additionalContext` 62、`system-reminder` 213、`hookSpecificOutput` 78 |
| S-32 | 未找到的事件 / 函数 | `ENGINE` 全文 | `TaskUpdated` / `TASK_UPDATED` / `UserPromptExpand` 字面 0；`executeWorktreeCreateHooks` / `executeConfigChangeHooks` 命名函数 0（但 `CONFIG_CHANGE` 有直接 `executeHooks` 派发点） |
| S-33 | Desktop 主进程包不含 hook 实现 | `D:/Program Files/WorkBuddy/resources/app.asar` 内 5117 文本文件 | `UserPromptSubmit`/`SessionStart`/`additionalContext`/`system-reminder`/`hook_event_name`/`hooks.json`/`codebuddy-lite-wb` 命中全部 **0** |
| S-34 | 引擎不校验 PD 版本 | `ENGINE` 全文 | `runtime-version.json` / `verify-pinned-runtime-capability` / `genieVersion` / `0.2.2` / `0.3.0` 字面均 0 |

---

# 5. PD 仓库实现与测试证据（CODE / TEST / DOC）

| ID | 路径 | 关键行 | 事实 |
|:---|:---|:---|:---|
| P-01 | `packages/workbuddy-adapter/plugin/hooks/hooks.json` | 全文 | canonical 5 事件；UPS 15 s、其余 30 s；无 `additionalContextLimit` / `statusMessage` |
| P-02 | `packages/workbuddy-adapter/plugin/scripts/wrapper.cjs` | `:27-44, :50, :55, :61, :113-143` | `HOST_TIMEOUT_MS={UserPromptSubmit:15000,default:30000}`、`SELF_TIMEOUT_MS={UserPromptSubmit:12000,default:25000}` **硬编码**；`spawnSync(timeout:deadlineMs,killSignal:'SIGTERM')`；超时降级 exit 1；`PD_WORKBUDDY_HOOK_SELF_TIMEOUT_MS` 可覆盖但被 clamp |
| P-03 | `packages/workbuddy-adapter/src/host-adapter.ts` | `:17-20, :34-39, :41-43` | `SUBSCRIBED_EVENTS=['before_tool_call','after_tool_call','before_prompt_build','session_start']`（4 个）；`hostId='workbuddy'`, `hostKind='subprocess'`；`:17-20` 注释称 `PostToolUseFailure` 未注册，与 P-01 已注册矛盾 |
| P-04 | `packages/workbuddy-adapter/src/codec/input-decoder.ts` | `:5,:44,:46-58,:189-262` | `HOST_CONTRACT_BASELINE='WorkBuddy Desktop 5.8.1 / engine 2.161.0 …'`；`EVENT_KINDS` 映射 5 事件；字段 `session_id`/`generation_id`→turnId/`cwd`/`prompt`/`tool_name`/`tool_input`/`call_id`→toolCallId/`tool_response`/`error`/`source`；**SessionStart 无 cwd**；未解析 `taskId`/`agent_id`/`compact_summary` |
| P-05 | `packages/workbuddy-adapter/src/codec/output-encoder.ts` | `:4-7,:21-23,:26-28,:44-63,:65-85` | 仅 `hookSpecificOutput.{hookEventName,permissionDecision(仅 deny),permissionDecisionReason,additionalContext}`；neutral=`null`（空 stdout）；`modifiedInput` 被拒；`additionalContext` 仅 `before_prompt_build`；不使用 `continue/decision/systemMessage/updatedToolOutput/ask`；`:4-7` 注释称宿主把 raw stdout 包装为 hook system-reminder |
| P-06 | `packages/workbuddy-adapter/src/pd-hook.ts` | `:6-24,:29-32,:53-61,:84-99,:199-213,:217,:278-283,:298,:384-386,:389-395,:505-516,:519-671,:631-641` | exit code 语义（flag-off/降级 → 空 stdout + exit 0；PreToolUse 治理失败 → exit 2；UPS 失败 → exit 0；wrapper 启动失败 → exit 1）；stderr `[PD] status=… reason=… nextAction=…`（`MAX_DIAGNOSTIC=500`）；`events_<date>.jsonl` 写 `<workspaceDir>/.state`；SessionStart 只做 `health()` 且不注入；stdout 单行 JSON |
| P-07 | `packages/workbuddy-adapter/src/workbuddy-evidence-recorder.ts` | `:37-44,:43,:69-88,:107-151,:147,:177-274` | `agent_context_delivery` `maxConfirmation:'submitted'`、`stdout submission is the proof boundary`；payload `confirmation:'submitted', outcome:'attempted'`，注释 `submitted ≠ delivered`；无 `degraded` 态；`observationKey`/`existingObservationRefs` 幂等 |
| P-08 | `packages/workbuddy-adapter/src/workspace-resolution.ts` | `:27-58` | 治理目录 `<home>/.workbuddy/pd-workspace` |
| P-09 | `packages/workbuddy-adapter/src/explicit-owner-statement.ts` | `:31-47` | `nativeIdentity = JSON(['workbuddy', sessionId, turnId])`，`already_admitted` / `rate_limited` |
| P-10 | `packages/workbuddy-adapter/src/worker/workspace-worker.ts` | `:26-31,:207-239` | `durable Runtime V2 task lease` 保证并发正确性 |
| P-11 | `packages/host-runtime/src/active-principle-prompt.ts` | `:98-124,:134-244` | 从 `.pd/state.db` 读 activations → `renderPrinciplesToDirectives` → `additionalContext` 字符串 |
| P-12 | `packages/host-runtime/src/index.ts` | `:346,:381-386` | `HostEventResult` `decision:'modify'` + `additionalContext`；hostKind 含 workbuddy |
| P-13 | `packages/workbuddy-adapter/CHANGELOG.md` | `:168,:246` | 0.2.14：`UserPromptSubmit 12s under a narrowed 15s host timeout … every other event 25s under the unchanged 30s`（2026-10-28 incident）；插件 manifest 版本演进 0.1.0→0.2.0→0.2.1→0.2.2 |
| P-14 | `packages/create-principles-disciple/src/installers/workbuddy-host-installer.ts` | `:97-98,:484,:923,:1004-1107,:1486,:1766,:1808-1845,:2095` | installer 只校验 **PD 插件自身** manifest version / `installed_plugins.json v2` / 版本化缓存；`applyWorkbuddyGovernanceRuntimeProfile` 写的是 **LLM runtime profile**（`pd.default`），不是宿主能力 profile；无宿主/引擎版本绑定 |
| P-15 | `packages/principles-core/src/runtime-v2/__tests__/workbuddy-host-contract.test.ts` 等 | — | 全仓未找到 `HostRuntimeCapabilityProfile` / `hostVersion` 绑定的运行时实现 — `NOT_FOUND` |
| P-16 | `packages/workbuddy-adapter/tests/plugin-skeleton.test.ts` | `:47-88,:123-202` | 断言 5 事件注册、UPS 15 s、self-deadline < hooks.json timeout、`HOST_TIMEOUT_MS` mirror、800 ms override kill。**静态数值守卫，只针对 canonical 15 s** |
| P-17 | `packages/workbuddy-adapter/tests/pd-hook-production.test.ts` | `:54-71,:73-95,:401,:426` | 断言 UPS stdout 恰好 1 行 JSON 且 `additionalContext` 含唯一标记；**只断言 stdout，未验证进入模型请求** |
| P-18 | `packages/workbuddy-adapter/tests/evidence-concurrency.test.ts` | `:1-13,:52-53,:110,:131,:176` | 真实 N 进程并发 + `busyTimeout=0` 降级观测 + 幂等 replay |
| P-19 | `packages/create-principles-disciple/tests/workbuddy-real-engine-isolation.test.ts` | `:1-23,:99,:145-146` | 驱动真实引擎做 marketplace add/install/uninstall 注册隔离；引擎不存在则 `SKIP … NOT RUN, never faked green`；**非事件派发/注入** |
| P-20 | `packages/workbuddy-adapter/tests/fixtures/host-contract/hook-runtime-contract.json` | `:1-115` | **HISTORICAL_PROBE** 冻结契约（engine 2.161.0 / Desktop 5.8.1 / SHA `fd9d20c7…`）：UPS exit2/deny/continue:false 阻断、exit1 非阻断、bad-json 无注入；PreToolUse timeout fail-closed、`continue:false` 导致 prompt 重新提交；`generation_id` 同轮稳定；`call_id` 无宿主去重；`resumeCompactPersistence UNKNOWN` |
| P-21 | `packages/workbuddy-adapter/tests/fixtures/host-contract/events/model-request-injection-shapes.json` | `:1-22,:56-77` | **HISTORICAL_PROBE** P04：UPS `additionalContext` → `role:"user"`, content[0]=`<system-reminder data-role="hook">…`, content[1]=`<user_query>…`, `startsNewUserRequest:true`；SessionStart stdout 同样进入 user 消息 |
| P-22 | `packages/workbuddy-adapter/tests/fixtures/host-contract/README.md` | `:3,:12,:30-36,:53-58` | 探针为 headless `codebuddy-lite-wb.mjs` + 本地 mock model；`Desktop-UI-only facts UNKNOWN headlessly`；`resume/compact injection persistence UNKNOWN`；原始证据归档于私有 `docs/reports/workbuddy-host-adapter-20261012/`（仓库内 **NOT_FOUND**） |
| P-23 | `scripts/dev/workbuddy-probe/README.md` | `:1-58` | P01–P06 可复现探针说明；隔离靠 `WORKBUDDY_CONFIG_DIR` + `CODEBUDDY_CONFIG_DIR` **双变量**；历史引擎 `--version 2.161.0` / Desktop 5.8.1；lab `D:/Code/_worktrees/wb-probe-lab/`（**本轮实测不存在**） |
| P-24 | `docs/plans/2026-08-28-workbuddy-adapter-verification.md` | `:56-83,:137-163` | 历史 http hook **fail-OPEN P0** 结论与未闭环项；本轮 command 方案不沿用其结论 |
| P-25 | `docs/plans/2026-08-workbuddy-plugin-feasibility.md` / `2026-08-28-workbuddy-capability-map-for-pd.md` / `2026-08-28-workbuddy-session-transcript-access.md` / `2026-10-12-workbuddy-spec-review-report.md` | 多处 | 四份历史 WorkBuddy 宿主适配调查；27 事件能力面（5.3.14 历史静态计数）；transcript 可读性；SPEC 独立评审 10 Major / Blocker 无 |
| P-26 | `.workbuddy/memory/topics/workbuddy-host-adaptation.md` | `:41-52,:63-67` | 历史官方文档快照与取证坑：中文站 IDE Hooks 页为旧版勿作信源；宿主曾静默升级 5.3.14→5.8.1；引擎路径随版本变 |

---

# 6. 运行时日志证据（RUNTIME_VERIFIED）

> 日志：`C:/Users/Administrator/.workbuddy/logs/2026-11-04/principles__97f0a2a3eefec09106aaa9b4220263bb.log`
> 读取时快照 **12,557 行 / 2,895,697 B**（该文件随会话持续增长，子代理较早读取时为 2,257,333 B，属同一文件不同时间点）。所有行号以本次读取为准。

| ID | 行 / 时间 | 原始行文本（脱敏后） | 证明什么 |
|:---|:---|:---|:---|
| R-01 | `L349` / 14:52:33.189 | `[Info] [pid=95164] [HookExtensionLoader]  Loaded hooks configuration from extension: principles-disciple@principles-disciple-market` | 插件配置**已加载**（`L1706` 14:52:35.596 重复一次） |
| R-02 | `L1573` / 14:52:34.949 | `[Info] [pid=95164] [HookManager] event=SessionStart matched 2 distinct hook entries (after dedupe): command:bash "…workbuddy-docx…setup.sh" \| command:node "…principles…"` | 同事件多 Hook 匹配（去重后仍 2 条） |
| R-03 | `L1574` / 14:52:34.977 | `[Info] [pid=95164] [HookExecutor] spawn pid=27720 shell=…\bash.exe timeout=5000ms cmd=bash "…workbuddy-docx/5.9.2-…/scripts/wb/local/setup.sh" </dev/null >/dev/null 2>&1 &` | 其它插件 hook 并发 |
| R-04 | `L1575` / 14:52:34.977 | `[Info] [pid=95164] [HookExecutor] spawn pid=66216 shell=…\bash.exe timeout=30000ms cmd=node "/c/Users/Administrator/.workbuddy/plugins/cache/principles-disciple-market/principles-disciple/0.2.2/scripts/wrapper.cjs" SessionStart` | **PD 0.2.2 / SessionStart / 30 s**；与 R-03 同时间戳 → **并发实证** |
| R-05 | `L2403` / **14:52:36.544** | `[Info] [pid=95164] [HookExecutor] spawn pid=85740 shell=…\bash.exe timeout=15000ms cmd=node "/c/Users/Administrator/.workbuddy/plugins/cache/principles-disciple-market/principles-disciple/0.2.2/scripts/wrapper.cjs" UserPromptSubmit` | **决定性：当前生效 UPS = 15 s / 0.2.2** |
| R-06 | `L2600` / 14:54:19.844 | `[HookExecutor] spawn pid=92036 … timeout=30000ms cmd=node "…/0.2.2/scripts/wrapper.cjs" PreToolUse` | PreToolUse 实际派发 |
| R-07 | `L2610` / 14:54:22.232 | `[HookExecutor] spawn pid=48148 … timeout=30000ms cmd=node "…/0.2.2/scripts/wrapper.cjs" PostToolUse` | PostToolUse 实际派发 |
| R-08 | **14:52:48.651** | `[Warning] [pid=95164] [cbc-kw=HOOK] [HookExecutor] abnormal exit pid=85740 code=1 elapsed=12113ms timedOut=false cmd=node "…/0.2.2/scripts/wrapper.cjs" UserPromptSubmit` | **本次 UPS hook 12.113 s 以 exit 1 退出，非宿主超时** |
| R-09 | **14:52:48.651** | `[Info] [pid=95164] Hook exited with non-blocking error code 1: [PD] status=degraded reason=workbuddy_wrapper:entry_deadline_exceeded:12021ms_budget_12000ms nextAction=The hook degraded at its self-deadline before the host timeout (non-blocking: the prompt/tool call survived). …` | **P0：PD 自降级、exit 1 非阻断、提交未受阻** |
| R-10 | 14:52:48.652–.658 | `[addHistory] START/COMPLETED …`、`[MCP][cacheDbg] getConnectedServers()…`、`[Startup] McpConfigManager.list…` | 会话正常继续 → 提交未被阻断 |
| R-11 | 14:52:50.518 | `[Warning] [HookExecutor] abnormal exit pid=66216 code=0 elapsed=15552ms timedOut=false cmd=node "…/0.2.2/scripts/wrapper.cjs" SessionStart` | SessionStart 耗时 15.552 s |
| R-12 | `L2506/L2507` / 14:52:50.518–.519 | `[SessionHookManager] executeSessionStartHooks source=startup hasHooksCheck=0ms executeHooks=15613ms total=15613ms`；`emitSessionStartWithPreflight: emitSessionStart completed in 15613ms, total=16736ms` | **整链 16.736 s / 30 s budget** |
| R-13 | `L346/L1704` | `[Error] [HookExtensionLoader] [Error: EISDIR: illegal operation on a directory, read] … tencent-docs-plugin/5.9.2-…` | 唯一 hook 加载错误，与 PD 无关 |
| R-14 | 全文统计 | 总 `[HookExecutor] spawn` **332**；PD wrapper：UPS **1**、SessionStart **1**、PreToolUse **164**、PostToolUse **162**、PostToolUseFailure **0**、Stop/PreCompact/SessionEnd **0** | 事件派发分布 |
| R-15 | 全文统计 | `timeout=[0-9]*ms` 分布：`15000ms`×4、`30000ms`×327、`5000ms`×353、`120000ms`×92、`1500ms`×1 | 各 hook 生效 timeout 实证（120000ms 为 BashTool 非 hook） |
| R-16 | 全文精确检索 | `[cbc-kw=HOOK] Hook timed out` / `HookBlockedError` / `User input blocked by hook` / `Hook blocked with exit code 2` = **0**；宽匹配得到的 3 条（`L12579/L12580/L12623/L13178` 等）经逐行核对全部是取证命令的 `[BashTool]` 回显 | **真实超时 / 阻断 0 条** |
| R-17 | 全文统计（排除工具回显） | `runtime_v2_prompt_activations_injected` 真实记录 **0**；`entry_deadline_exceeded` **1**；`[PD] status=` 真实记录 **1**（degraded） | **本次会话原则注入丢失** |
| R-18 | 全文统计 | `principles-disciple/0.2.2` 命中 **292** 次；`0.1.0` / `0.2.0` 路径命中 **0** 次 | 本次只加载 0.2.2 |
| R-19 | 全文统计 | `2.165.0` 命中 3 次；`chat/completions` 命中 223 次（多为取证命令回显，**不作为模型请求注入证据**） | 版本佐证 / 日志污染提示 |

> **取证污染说明**：本次审计的 grep / node 命令被宿主写入同一会话日志（BashTool 回显），因此所有关键词统计都必须排除 `[BashTool]` / `[Sandbox*]` / `scan(` / `for(const` 行。R-16、R-17、R-19 均按此规则处理。

---

# 7. 历史探针证据（HISTORICAL_PROBE，不冒充本轮结果）

| ID | 产物 | 基线 | 结论 | 与本轮关系 |
|:---|:---|:---|:---|:---|
| H-01 | `hook-runtime-contract.json:1-115` | engine **2.161.0** / Desktop **5.8.1** / SHA `fd9d20c75264…` / 2026-10-12 / win32 x64 Git Bash | 5 事件 payload、exit code 矩阵、UPS exit2/deny/continue:false 阻断、exit1 非阻断、PreToolUse timeout fail-closed、SessionStart timeout 不阻断、`generation_id` 同轮稳定、`call_id` 无宿主去重、`PreToolUse continue:false` 导致 prompt 重新提交、forbiddenForV1 四项 | **基线已 EXPIRED**（E-12）；作为语义对照，与当前 S-12/S-14/S-16 一致 |
| H-02 | `model-request-injection-shapes.json:1-77` | P04 / 同一历史基线 / 本地 mock model 捕获 request body | UPS `additionalContext` → `role:"user"`、`<system-reminder data-role="hook">` 在 `<user_query>` 前；PostToolUse → tool-hint；PreToolUse deny → `role:"tool"` `Error:…` | 与当前 S-16/S-17 **跨版本一致**，共同支撑注入角色判定；但**当前版本请求级证据仍 NOT_RUN** |
| H-03 | `scripts/dev/workbuddy-probe/README.md:1-58` | 同上 | P01–P06 隔离方法（`WORKBUDDY_CONFIG_DIR` + `CODEBUDDY_CONFIG_DIR` 双变量 + 本地 mock model）、`-p` 模式首条 prompt 不触发 UPS、`resume/compact persistence UNKNOWN` | 本轮按用户约束未重建 lab（见 §10） |
| H-04 | `docs/plans/2026-08-28-workbuddy-adapter-verification.md:56-83` | 5.3.14 时代 | http hook 三条失败路径全部 `allowed:true`（fail-OPEN P0） | 与当前 `command` 方案无关，不沿用 |
| H-05 | `docs/plans/2026-08-28-workbuddy-capability-map-for-pd.md` | 5.3.14 静态计数 | 「27 事件」能力面，自注「未逐项运行验证」 | 本轮 S-19 给出当前引擎枚举 29 项，取代历史计数 |

---

# 8. 测试与断言清单（本轮实际执行 / 未执行）

| ID | 项 | 结果 | 类型 |
|:---|:---|:---|:---|
| T-01 | `node <engine> --version` | `2.165.0` | `RUNTIME_VERIFIED`（只读） |
| T-02 | `sha256sum` × 5 个关键文件 | 见 §3 / E-06 / C-11 | `STATIC_CONFIG` |
| T-03 | `settings.json` 读取（仅键名 + PD 布尔） | `PD_enabled=true`, `has_top_level_hooks=false` | `STATIC_CONFIG` |
| T-04 | 生效 `hooks.json` 全文读取（0.2.2 / 0.2.0 / canonical） | 15/30 vs 全 30 vs 15/30 | `STATIC_CONFIG` |
| T-05 | 运行时日志统计（派发数 / timeout 分布 / 并发 / 降级 / 注入记录） | 见 R-14…R-19 | `RUNTIME_VERIFIED` |
| T-06 | 隔离 lab 目录存在性检查 | `D:/Code/_worktrees/wb-probe-lab/` **NOT_FOUND** | `NOT_RUN` 依据 |
| T-07 | 官方文档抓取 × 3 | 全部成功，无重定向 | `OFFICIAL_DOC` |
| T-08 | 真实引擎 Mock 探针（P1/P3/P4/P6 新样本） | **NOT_RUN**（原因见 §10） | — |
| T-09 | 修改任何配置 / 插件 / 数据库 / 会话 | **未执行** | 纪律 |
| T-10 | 触发付费模型调用 | **未执行** | 纪律 |

**仓库既有测试**（本轮只读核对，未运行）：P-16…P-19；真实宿主派发的自动化断言、当前版本注入进入模型请求的运行时确认、hostVersion 绑定、cache↔canonical 一致性守卫、Desktop/IDE 覆盖均**缺失**。

---

# 9. 官方文档 / 源码 / 运行差异登记（分别记录，不取舍）

| # | 议题 | 官方 CLI (D1/D3) | 官方 IDE (D2) | 当前源码 / 运行 | 主证据 |
|:--|:---|:---|:---|:---|:---|
| X1 | 事件总数 | 27+ / D3 列 27 | 7 | 引擎枚举 29 | S-19 / D1 / D2 |
| X2 | 配置优先级 | 合并而非覆盖 | 项目级覆盖用户级 | `mergeHooks` 数组拼接 | S-28 / E-10 |
| X3 | exit 2 消息来源 | stdout 优先、stderr 兜底 | stdout 忽略、stderr 传给 Agent | stdout JSON reason / stderr fallback | S-12/S-13 |
| X4 | `SessionStart.source` | startup/resume/clear/**compact** | 仅 startup | startup/resume/clear（无 compact） | S-24 / R-12 |
| X5 | `SessionStart` 重复 | resume 会再触发 | 每会话一次（conversationId） | resume / clear 会派发 | S-24 |
| X6 | async / 后台 | 未声明 | 未声明（仅脚本级建议） | `async:true` + `asyncTimeout` detach 存在 | S-07 |
| X7 | 配置路径 | `~/.codebuddy/settings.json` | 同 | **`~/.workbuddy/settings.json`**，无顶层 hooks | E-10 |
| X8 | 生效机制 | 启动快照 + `/hooks` 审查 | 重启 + 新会话 | 启动时 `HookExtensionLoader` 加载 | R-01 / S-28 |
| X9 | `additionalContextLimit` | 有规范 | 未提 | 引擎零命中 | S-31 |
| X10 | `tool_name` | CLI-style | IDE-style | CLI-style（引擎子进程） | D2 附录 E / S-26 |
| X11 | `PostCompact` | Y | 未列出 | Y | S-23 / D1 |
| X12 | 注入角色 | 未说明 | 未说明 | **`user` 内 hook system-reminder** | S-16/S-17 / H-02 |
| X13 | 引擎版本 | 文档要求 v1.16.0+ | 无版本 | `@genie/agent-cli 2.165.0` | E-05 |

---

# 10. NOT_RUN / UNKNOWN / NOT_FOUND 清单

| ID | 项 | 状态 | 具体原因 |
|:---|:---|:---|:---|
| N-01 | 真实引擎 Mock 探针 P1（成功 additionalContext 进入当前版本模型请求） | `NOT_RUN` | 隔离 lab 已清理（T-06）；当前为真实生产会话，无法独立证明第二引擎实例不写共享日志 / 不读全局插件注册；禁止用真实用户请求测试阻断 Hook、禁止付费模型调用 |
| N-02 | P3 Task / Subagent 运行时派发 | `NOT_RUN` | 本次会话无 Task 工具调用 / Subagent 事件，零样本；仅有 `SOURCE_CONFIRMED` 派发点 |
| N-03 | P4 Compaction 前后上下文捕获 | `NOT_RUN` | 本次会话无压缩事件；历史探针明确 `resume/compact injection persistence UNKNOWN` |
| N-04 | P6 真实宿主 8 场景超时注入 | `NOT_RUN` | 同 N-01；本轮已给出基于 S-12/S-13/S-14 的源码推演表，但不冒充运行时验证 |
| N-05 | `async:true` 运行时验证 | `NOT_RUN` | 源码确认存在（S-07），未启动隔离探针 |
| N-06 | Desktop UI-only 能力（`/hooks` review panel、交互 TUI） | `NOT_RUN` | headless 环境不可用，历史 README 明确 UNKNOWN |
| N-07 | standalone IDE 运行时 | `NOT_RUN` | 本机未运行独立 IDE 进程；仅有 D2 官方文档 |
| N-08 | 模型是否看到完整注入内容 / 压缩期并发竞争 | `UNKNOWN` | 本次无注入；未做请求级与压缩期观测 |
| N-09 | `SessionStart.source="compact"` | `NOT_FOUND` | 当前引擎字面检索未找到（D1 列出该值） |
| N-10 | `TaskUpdated` / `UserPromptExpand` 事件 | `NOT_FOUND` | 引擎枚举与字面检索均为 0 |
| N-11 | `additionalContextLimit` 支持 | `NOT_FOUND` | 引擎全文 0 命中（S-31） |
| N-12 | 显式删除旧版本 `hooks.json` 的宿主代码 | `NOT_FOUND` | 仅发现 `.orphaned_at` 标记 + `.in_use/` 引用计数 + `.last_inuse_sweep` |
| N-13 | `MessageUtils.addSystemReminder` 函数体 / 枚举对象 `Y` 定义体 | `NOT_FOUND` | 未逐字提取；但 `isUserMessage` 守卫 + `role:"user"` 构造 + `t.input` 目标三处一致，故注入角色判定标 `SOURCE_CONFIRMED`（含少量 `INFERRED` 成分） |
| N-14 | 「PD Host Event Capability Matrix v0.1 — Live Runtime Verification」独立文件 | `NOT_FOUND` | `docs/audit/` 及全仓未找到；最接近的是 `docs/audit/pri-807-phase0/HOST_CAPABILITY_MATRIX.md`（历史快照） |
| N-15 | 私有 `docs/reports/workbuddy-host-adapter-20261012/agents/probe-fg0phy/` 原始探针证据 | `NOT_FOUND` | P-22/P-23 指向该路径，仓库内不存在 |
| N-16 | `HostRuntimeCapabilityProfile` 运行时实现 | `NOT_FOUND` | 全仓 `packages/*.ts` 无实现（P-15） |
| N-17 | `workbuddy.db` / `*.db` 结构化内容 | `NOT_RUN` | 避免只读 sqlite3 CLI 未确认造成锁 / 状态变化 |
| N-18 | 进程 CommandLine | `NOT_RUN` | 可能含凭据，按脱敏约束跳过 |
| N-19 | 跨进程共享同一 Session ID 的稳定性 | `NOT_RUN` | 需隔离多进程探针 |

---

# 11. 关键结论 → 证据索引映射

| # | 关键结论 | 证据 ID | 最高等级 |
|:--|:---|:---|:---|
| 1 | 当前宿主 = WorkBuddy Desktop 5.9.2 / 引擎 2.165.0 / Electron 37.10.3 / PD 0.2.2 | E-01…E-09 | `RUNTIME_VERIFIED` |
| 2 | 当前运行模式是 Desktop 承载 CLI 引擎子进程，`lite-wb` 只是引擎文件名 | E-07, S-33 | `RUNTIME_VERIFIED` |
| 3 | 当前生效 `UserPromptSubmit` timeout = **15 s**、`0.2.2`，由 `hooks.json` 的秒值 ×1000 覆盖宿主默认 60 s | R-05, C-01, S-01, S-02 | `RUNTIME_VERIFIED` |
| 4 | canonical 与当前安装副本字节级一致；15/30 差异属于已 orphaned 的 0.2.0 | C-01, C-02, C-03, E-12 | `STATIC_CONFIG` |
| 5 | 三版 `hooks.json` 并存 + `mergeHooks` 拼接 → 重复注册/注入风险 | C-03, C-04, S-28, R-18 | `SOURCE_CONFIRMED` |
| 6 | 插件已 installed / enabled / loaded / dispatched | E-09…E-11, R-01, R-04, R-05 | `RUNTIME_VERIFIED` |
| 7 | **本次会话原则注入已丢失**（12.113 s 自降级 exit 1，零注入记录） | R-08, R-09, R-10, R-17, P-02, P-07 | `RUNTIME_VERIFIED` |
| 8 | exit 1 非阻断放行；只有 exit 2 / deny / continue:false / 宿主 kill 才阻断 UPS | S-12, S-14, R-09, R-10, H-01 | `SOURCE_CONFIRMED + RUNTIME_VERIFIED` |
| 9 | wrapper 硬编码 12 s/25 s，不读取实际生效 timeout | P-02, C-01, C-03, S-02, R-09 | `SOURCE_CONFIRMED` |
| 10 | 注入内容进入 **`user` 消息内 `<system-reminder data-role="hook">`**，UPS=`last`、SS=`first` | S-16, S-17, S-15, H-02 | `SOURCE_CONFIRMED`（+ HISTORICAL_PROBE） |
| 11 | 本轮无「模型请求包含注入内容」的运行时确认 | R-17, R-19, N-01 | `NOT_RUN` |
| 12 | 宿主支持 29 事件；Task/Subagent/Session/Compaction/Tool 均有真实派发点 | S-19…S-25, R-14 | `SOURCE_CONFIRMED` |
| 13 | WorkBuddy tool events 已大量真实派发（164/162），SPEC 的 NOT_RUN 结论过时 | R-14, R-06, R-07 | `RUNTIME_VERIFIED` |
| 14 | 宿主原生支持 `async:true` detached hook，可作 Deferred Refresh 载体 | S-07 | `SOURCE_CONFIRMED`（运行时 `NOT_RUN`） |
| 15 | 多 Hook 并行、每 hook 独立子进程、结果聚合任一 `!allowed` 即阻断 | S-03, S-08, S-10, R-02, R-03, R-04 | `SOURCE_CONFIRMED + RUNTIME_VERIFIED` |
| 16 | `additionalContextLimit` 当前引擎不存在，宿主无注入长度闸门 | S-31, P-01, C-08 | `SOURCE_CONFIRMED` |
| 17 | SessionStart 整链 16.736 s / 30 s budget | R-11, R-12 | `RUNTIME_VERIFIED` |
| 18 | 无 PD 版本与宿主不兼容迹象；引擎不读取 PD pins | E-13, S-34 | `RUNTIME_VERIFIED / SOURCE_CONFIRMED` |
| 19 | `HostRuntimeCapabilityProfile` 只有 SPEC 接口、无运行时实现 | P-14, P-15, N-16 | `NOT_FOUND / CODE` |
| 20 | CLI / IDE / Desktop 文档与源码在 12+ 议题上互相矛盾 | D1, D2, D3, §9 | `OFFICIAL_DOC + SOURCE_CONFIRMED` |
| 21 | 历史探针基线 2.161.0 / 5.8.1 已 EXPIRED | E-12, H-01, P-20, P-23 | `HISTORICAL_PROBE` |
| 22 | 真实超时 / 阻断记录 0 条（宽匹配 3 条为取证命令回显） | R-16 | `RUNTIME_VERIFIED` |
| 23 | SPEC 引用的 Matrix v0.1 原始证据在本仓库不可复核 | N-14, N-15, P-22, P-23 | `NOT_FOUND` |
| 24 | adapter 无法区分「已安装/已加载/已派发/已注入」四层 | P-07, P-06, R-17 | `CODE + RUNTIME_VERIFIED` |

---

# 12. 复现命令（只读，供独立复核）

```bash
# 版本
cat "/d/Program Files/WorkBuddy/version"
node -e "console.log(require('D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/package.json').version)"
node "D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs" --version

# 生效配置
cat "/c/Users/Administrator/.workbuddy/plugins/cache/principles-disciple-market/principles-disciple/0.2.2/hooks/hooks.json"
node -e "const o=require('C:/Users/Administrator/.workbuddy/settings.json'); console.log(o.enabledPlugins['principles-disciple@principles-disciple-market'], Object.prototype.hasOwnProperty.call(o,'hooks'))"

# 指纹
sha256sum "/d/Code/principles/docs/specs/PD Adaptive Activation SPEC v0.4.md" \
  "/c/Users/Administrator/.workbuddy/plugins/cache/principles-disciple-market/principles-disciple/0.2.2/hooks/hooks.json" \
  "/c/Users/Administrator/.workbuddy/plugins/cache/principles-disciple-market/principles-disciple/0.2.0/hooks/hooks.json" \
  "/d/Code/principles/packages/workbuddy-adapter/plugin/hooks/hooks.json" \
  "/d/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs"

# 运行时（注意排除取证命令回显）
LOG="/c/Users/Administrator/.workbuddy/logs/2026-11-04/principles__97f0a2a3eefec09106aaa9b4220263bb.log"
grep -a "\[HookExecutor\] spawn" "$LOG" | grep -a "UserPromptSubmit" | head -3
grep -a "entry_deadline_exceeded" "$LOG" | grep -a -v -E "BashTool|Sandbox" | head -3
grep -a -c -E "\[cbc-kw=HOOK\] Hook timed out|HookBlockedError|User input blocked by hook" "$LOG"
```

---

**END OF PD_WORKBUDDY_EVIDENCE_MANIFEST_v0.1.md**
