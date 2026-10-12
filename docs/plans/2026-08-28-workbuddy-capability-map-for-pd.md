# WorkBuddy 能力面地图与 PD 利用方案

> **2026-10-12 第二轮整改**：本文保留历史调研和取证，不是当前宿主运行验收。实现基线见 [SPEC v0.3.0](../specs/workbuddy-host-adapter-spec.md)，重点阅读 §4 契约、§5 改动面、§7 探针及 §8 验收。第一轮评审清单须逐项复核；“已改文字”不等于“已验证能力”。
> **开发状态**：可进入隔离探针开发；生产适配器按探针结论与 Owner 决策冻结后实施。历史引擎字符串命中仅证明存在性，不能证明实际触发、完整实现或用户效果。


> **日期**：2026-08-28
> **目的**：梳理 WorkBuddy 对外暴露的 API / 扩展点，并给出 PD 在每个点上的利用方式
> **方法**：官方文档（plugins-reference / hooks / sub-agents / sdk）+ 本机引擎取证（WorkBuddy 桌面版 5.3.14, build `825709d`）
> **取证位置**：`D:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\dist\codebuddy.js`
> **前置阅读**：`docs/plans/2026-08-28-workbuddy-adapter-verification.md`（可行性复核，含 http fail-OPEN 的 P0 发现）

---

## 0. 对上一份报告的更正

上一份报告称 WorkBuddy 支持「20 个 hook 事件」，**该数字有误，实为 27 个**。原因是我当时只枚举了自己列出的候选名单，遗漏了 `StopFailure`、`PermissionDenied`、`FileChanged`、`CwdChanged`、`WorktreeCreate`、`WorktreeRemove`、`TaskCreated`。已按官方文档事件表逐一复核，**27 个事件在本机全部存在**（见 §1.1 计数表）。

---

## 1. 能力面全景

### 1.1 Hook 事件（5.3.14 历史静态计数，未逐项运行验证）

| 事件 | 本机命中 | matcher | PD 利用 |
|---|---:|---|---|
| `PreToolUse` | 6 | 工具名 | **RuleHost 闸门**：`permissionDecision: deny` + reason |
| `PostToolUse` | 6 | 工具名 | **痛点证据采集**；`additionalContext` 回注证据 |
| `PostToolUseFailure` | 4 | 工具名 | 失败即痛点信号，比成功更有诊断价值 |
| `UserPromptSubmit` | 5 | — | **意图/原则注入** `additionalContext`；`continue:false` 可阻断 prompt |
| `SessionStart` | 4 | `startup`/`resume`/`clear`/`compact` | **原则注入主通道**（stdout 直接进上下文，见 §2.1） |
| `SessionEnd` | 5 | `clear`/`logout`/`prompt_input_exit`/`other` | 收尾、证据落盘、会话级复盘 |
| `Stop` | 4 | — | `continue:false` 强制 Agent 继续（收敛治理） |
| `StopFailure` | 2 | — | 停止失败的信号捕获 |
| `SubagentStart` | 3 | — | **子智能体治理**（OpenClaw 无此事件） |
| `SubagentStop` | 4 | — | 子智能体产出回收、二次校验 |
| `Notification` | 4 | `permission_prompt`/`idle_prompt`/`auth_success`/`elicitation_dialog` | **Owner 审批提醒**（见 §2.3） |
| `PermissionRequest` | 5 | — | 权限请求即治理介入点 |
| `PermissionDenied` | 4 | — | 「被拒绝」是强痛点信号 |
| `PreCompact` | 4 | `manual`/`auto` | **上下文压缩前抢救证据**（见 §2.2，PD 独有） |
| `PostCompact` | 2 | — | 压缩后回注 |
| `InstructionsLoaded` | 2 | — | 规则文件加载时点，可做注入校验 |
| `ConfigChange` | 2 | — | 配置漂移监控 |
| `TaskCreated` / `TaskCompleted` | 2 / 2 | — | 任务粒度归因 |
| `TeammateIdle` | 2 | — | 多智能体协作空闲点 |
| `FileChanged` | 2 | — | 文件变更级证据 |
| `CwdChanged` | 2 | — | 工作区切换，切换原则集 |
| `WorktreeCreate` / `WorktreeRemove` | 4 / 4 | — | 隔离工作区生命周期 |
| `Elicitation` / `ElicitationResult` | 2 / 2 | — | MCP 主动向用户提问（PD 可做审批交互） |
| `Setup` | 2 | — | 初始化 |

### 1.2 Hook 输出字段（本机验证）

| 字段 | 命中 | 说明 |
|---|---:|---|
| `hookSpecificOutput` | 50 | 容器字段 |
| `additionalContext` | 40 | 追加上下文（PreToolUse/PostToolUse/UserPromptSubmit/SessionStart；**PreToolUse 一项系本机取证，官方快照 PreToolUse Decision Control 节未列该字段**——2026-10-12 勘误） |
| `permissionDecisionReason` | 20 | deny/ask 时给 Agent 或用户看的原因 |
| `modifiedInput` | 17 | **改写工具入参**（比 Codex 强，Codex 0.147 无此字段） |
| `suppressOutput` / `systemMessage` / `stopReason` | 有 | 通用字段 |
| `updatedToolOutput` | **0** | ⚠️ 5.3.14 取证时未实现；**本机 2026-10-11 已升级 5.8.1，现行引擎 12 处命中**——见 §4.1 补记 |

`permissionDecision` 三态：`allow`（绕过权限直接执行）/ `deny`（阻断，reason 给 Agent）/ `ask`（强制弹窗让用户确认）。

### 1.3 插件清单字段（本机验证）

| 字段 | 命中 | 用途 |
|---|---:|---|
| `commands` / `agents` / `skills` | 支持 | 自定义路径（会**替换**默认目录） |
| `hooks` | 支持 | `./hooks/hooks.json` 或内联 |
| `mcpServers` | 支持 | `.mcp.json` 或内联 |
| `lspServers` | 11 | 语言服务器 |
| `userConfig` | 19 | 启用时收集配置，`${user_config.KEY}` 引用；敏感值进钥匙串 |
| `outputStyles` | 14 | 输出样式 |
| `defaultEnabled` | 13 | 默认启用开关 |
| `dependencies` | 150 | 插件依赖（含跨 marketplace 白名单） |
| `channels` | 73 | **IM 消息注入通道**（企业微信/Telegram 等），绑定 MCP server |

环境变量（均验证存在）：`CODEBUDDY_PLUGIN_ROOT` / `CODEBUDDY_PLUGIN_DATA`（跨更新持久化）/ `CODEBUDDY_PROJECT_DIR` / `CODEBUDDY_PLUGIN_OPTION_<KEY>`。
`bin/` 目录会被加入 Bash tool 的 PATH，插件可执行文件可当裸命令调用。

### 1.4 Sub-agent

- **独立上下文窗口**，不污染主会话
- 嵌套上限 5 层；每会话 spawn 预算 200（workflow/skill 路径可绕过）
- `background: true` 后台运行，返回 Task ID，用 `TaskOutput` 查
- **可按 `agentId` resume**，跨轮次保持完整上下文
- frontmatter 字段：`name` `description` `tools` `model` `permissionMode` `skills` `mcpServers` `disallowedTools` `effort` `maxTurns` `background` `initialPrompt` `memory`
- `memory` 可指定 `user`/`project`/`local` 作用域，自动注入 `MEMORY.md`
- ⚠️ **Plugin agent 不支持 `hooks` / `mcpServers` / `permissionMode`**（安全限制）
- 内置三类：`Explore`（只读，lite）/ `Plan`（plan mode）/ `general-purpose`

### 1.5 Agent SDK（Preview）

包名：`@tencent-ai/agent-sdk`（TS，Node ≥ 18.20）/ `codebuddy-agent-sdk`（Python ≥ 3.10）

| 能力 | 支持 | 说明 |
|---|---|---|
| Streaming | ✅ | `query()` 异步迭代，system/assistant/result 消息 |
| 多轮 Session | ✅ | TS `unstable_v2_createSession`；Python `CodeBuddySDKClient` |
| Resume | ✅ | 按 `session_id` 恢复 |
| **权限回调 `canUseTool`** | ✅ | `behavior: allow/deny`，可 `updatedInput` 改参，deny 时可 `interrupt` 中断整个会话 |
| Hooks | ✅ | SDK 侧 8 类事件 |
| Subagent 定义 | ✅ | `agents` + `AgentDefinition` 程序化定义 |
| 自定义工具 | 仅 MCP | 无进程内注册函数的 API |
| 环境隔离 | — | **默认不加载任何文件系统配置**（settings/CODEBUDDY.md/MCP/subagent/skills/rules 全不加载），需显式 `settingSources: ['user'|'project'|'local']` |

---

## 2. PD 的六个高价值利用点

以下是候选机会，不代表已获批准的开发范围；当前优先级见 §7。

### 2.1 原则注入
官方快照描述 SessionStart/UserPromptSubmit 输出进入上下文，真实行为待探针验证。首版采用 UserPromptSubmit 主注入、SessionStart 健康检查，避免直接复用 Codex session_start 提前返回路径却承诺会注入。恢复/压缩覆盖、内容更新和重复注入须实测。

### 2.2 PreCompact/PostCompact
属于后续机会。先证明压缩导致既有证据丢失；上下文被压缩不等于 SQLite 已持久化事实被删除。未证明缺口前，不建立新的“抢救”存储或声称独有优势。

### 2.3 Notification/IM
先验证审批延迟和漏审，再考虑提醒。“空闲”不证明提醒不会打断。网络通知、身份与隐私约束独立评审，不纳入首版。

### 2.4 工具失败与权限拒绝
真实失败采集直接关系首版证据承诺，优先验证 PostToolUse 与 PostToolUseFailure 的分流和载荷。拒绝权限只是拒绝事实，不能自动当作 AI 犯错或 Owner 纠正；需要来源与原因区分。

### 2.5 子智能体与 SDK
事件存在性不能证明每个子代理都受统一治理。首版复用 PD 既有消费者和调度；不把九个智能体搬成宿主代理，不重建编排。相关能力需后续独立验证。

### 2.6 modifiedInput
历史静态字段命中不是纠偏效果证明。自动改参可能改变用户意图，需要权限、误改、审计与恢复设计；首版 encoder 拒绝该字段。

## 3. 当前落地基线
command 插件→WorkBuddy 薄协议适配器→共享 host-runtime→既有原则/审批/证据/消费者。

首版四事件基线为 PreToolUse、PostToolUse、UserPromptSubmit、SessionStart；P03 决定失败事件是否需要最小追加。工具输入、结果和真实身份必须显式标准化，不能只做 snake_case 重命名。

本机插件发现、治理目录解析、分发产物和后台推进都属于接线面。完整名单和验收见 SPEC §5/§8；不得用架构箭头证明运行连接成立。

## 4. 与官方文档的差异（重要）

### 4.1 updatedToolOutput 的历史静态证据

文档称 PostToolUse 可返回 `hookSpecificOutput.updatedToolOutput` **替换**工具结果。本机 grep `updatedToolOutput` / `updatedOutput` / `newToolOutput` / `replaceOutput` / `outputOverride` **全部为 0**，而 `additionalContext`(40) 存在。

**2026-10-12 快照补证**：官方 hooks 文档对 `updatedToolOutput` 的规范相当完整——适用于全部工具（含 MCP，数组返回值原样用作 MCP content array）、与 `additionalContext` 可同时返回（先替换后追加）、典型用途是压缩冗长工具输出省 token，并明确 `decision: "block"` 已废弃（PostToolUse 在工具执行后触发，阻断无意义）。**零命中不能区分未实现、路径变化或其他实现形态**——若桌面版引擎升级，该能力可能直接可用。SPEC 中应将其标记为版本依赖能力并加契约测试。

**结论（5.3.14 历史取证）**：桌面版 5.3.14 的 PostToolUse 只能**追加**上下文，不能替换/压缩工具输出。

**2026-10-12 晚补记（版本升级，证据核查 M1）**：本机 WorkBuddy 已于 2026-10-11 从 5.3.14 升级至 **5.8.1**（install-manifest.json），引擎文件由 `cli/dist/codebuddy.js` 变为 `cli/dist/codebuddy-lite-wb.mjs`；在现行引擎中 `updatedToolOutput` **12 处命中**——「桌面版未实现」仅为 5.3.14 历史取证，现时表述已推翻。SPEC（v0.2）的版本门禁设计保留，但门禁依据从「未实现」改为「未复验」，Phase 0 探针须以现行版本重新确认。本报告全部 5.3.14 计数类取证（§1.1 事件命中数、§1.2 payload 字段计数、§3.1 http fail-OPEN 代码摘录、本节 0 命中）均为历史取证，复核前先查 install-manifest 与引擎目录。

**影响**：若 PD 想做「压缩冗长工具输出以省 token」或「改写工具结果」，本版不可用，只能用 `additionalContext` 追加告警。需在 SPEC 中标记为版本依赖能力。

### 4.2 事件数：我上一份报告的「20」有误；「27」的准确口径如下

见 §0。**2026-10-12 快照补证**：官方 hooks 文档称「27+ events」，但官方 plugins-reference 事件表只列 **26** 个（不含 `Setup`）；本机二进制含 `Setup` 共 **27** 个。三个数字的关系：官方文档自身两处不一致，能力面以本机取证的 27 个为准；`Setup` 无官方文档，属取证独有发现。

### 4.3 文档基于 CodeBuddy Code v1.16.0+，本机是桌面版 5.3.14

**2026-10-12 勘误**：原文「两条产品线」表述不准确。桌面版引擎本体即 `cli/dist/codebuddy.js`，官方文档 canonical 指向 codebuddy.ai（CodeBuddy CLI 文档）——**同引擎同源**，差异在发布列车与版本基线（v1.16.0+ vs 5.3.14）。27 事件集两处一致，能力下限已确认；Beta 演进风险仍在，复核须先确认产品版本/manifest，再枚举当前引擎文件并记录哈希，不能固定使用已失效的 codebuddy.js 路径。本地已存官方快照：`docs/plans/2026-10-12-workbuddy-official-{plugins-reference,hooks-reference}.md`。

---

## 5. 限制与风险

1. **Plugin agent 不支持 `hooks` / `mcpServers` / `permissionMode`** —— 拦截必须放插件级。
2. **插件分发的 Skill / Agent frontmatter hooks 默认被安全门拒绝**（`allowUntrustedFrontmatterHooks`，本机 3 处）。但 **plugin `hooks/hooks.json` 不受此限制**——这正是应走插件级 hook 的又一理由。
3. **hook 配置不热加载**：启动时快照，需在 `/hooks` 面板审查后才生效。
4. **Windows 强制 Git Bash**（cmd.exe / PowerShell 不支持），hook 脚本须兼容 bash 语法；Python 脚本须显式 `python3 xxx.py`，不能靠 shebang。官方快照补充：可用 `CODEBUDDY_CODE_GIT_BASH_PATH` 环境变量指定 bash.exe 路径；Git Bash 缺失时会提示安装 Git for Windows。
5. **hook 超时默认 60s**（`prompt` 类型 hook 默认 30s，均可按 hook 覆盖），PD 拦截须低延迟。
6. **exit code 2 时 stderr 是 fallback**：仅当 stdout 无输出时才把 stderr 传给 Agent，因此**调试日志可安全写 stderr**。这是可观测性设计的好消息。
7. **SDK 默认不加载文件系统配置** —— SDK 路径与插件路径是两套体系，若 PD 走 SDK 需显式 `settingSources`，否则插件/hooks/skills 全不生效。
8. SDK 处于 **Preview**，Hooks 处于 **Beta**。

---

## 6. 跨宿主比较的证据边界
本调研没有当前 OpenClaw/WorkBuddy 的同任务运行对照，不能据 WorkBuddy 文档或字符串计数断言“独有”“更优”或治理深度超过 OpenClaw。比较必须分别写清宿主协议、PD 已连接能力、当前健康与真实用户效果。

首版的可比较目标是同一批准意图、真实拦截、可观测降级和可撤回；v2 上下文缺失时明确 unsupported，不假装与 OpenClaw 功能全等。

## 7. 建议优先级

| 顺序 | 事项 | 开始/完成条件 |
|---|---|---|
| 1 | 可靠接入：插件加载、目录身份、权限保持、安装产物 | P01–P06 有真实证据；Owner 决策冻结 |
| 2 | 三条路径及可撤回 | 真实注入、未发生的禁止副作用、正确证据、下一轮撤回 |
| 3 | 完整治理闭环 | 真实信号经后台形成提案、人工审批后生效；不用模拟替代 |
| 后续 | 压缩、通知、reasoning、改参、子代理/SDK | 先证明现有机制无法满足的缺口，再独立评审 |
