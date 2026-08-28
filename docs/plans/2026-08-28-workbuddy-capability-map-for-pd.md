# WorkBuddy 能力面地图与 PD 利用方案

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

### 1.1 Hook 事件（27 个，本机逐一验证通过）

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
| `additionalContext` | 40 | 追加上下文（PreToolUse/PostToolUse/UserPromptSubmit/SessionStart） |
| `permissionDecisionReason` | 20 | deny/ask 时给 Agent 或用户看的原因 |
| `modifiedInput` | 17 | **改写工具入参**（比 Codex 强，Codex 0.147 无此字段） |
| `suppressOutput` / `systemMessage` / `stopReason` | 有 | 通用字段 |
| `updatedToolOutput` | **0** | ❌ 桌面版未实现，见 §4.1 |

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

按「PD 独特价值 / 其他系统做不到」排序。

### 2.1 SessionStart 的 stdout 直接进上下文 —— 零成本原则注入

官方文档明确：

> Exit code 0 – Success. Stdout appears in transcript mode, **except for `UserPromptSubmit` and `SessionStart`, where stdout is appended to the context**.

即 `SessionStart` hook 的标准输出会**直接追加进对话上下文**，不需要 `hookSpecificOutput` 包装，也不需要改系统提示词。

**PD 用法**：`SessionStart` hook 读 `state.db` 的已激活原则，把「Owner 已批准的活跃原则」渲染成 stdout 直接注入。每次会话/恢复/`clear`/`compact` 都自动生效。

**价值**：这是 PD 三条 MVP-Core 路径中「prompt injection」的**最短路径**。比 `UserPromptSubmit` 的 `additionalContext` 更轻（少一层 JSON 封装），且 `resume`/`compact` 时机会自动重注，解决「压缩后原则丢失」问题。

### 2.2 PreCompact —— 上下文压缩前抢救证据（PD 独有）

官方：`PreCompact` 在上下文压缩前触发，matcher 为 `manual` / `auto`。

**PD 用法**：压缩前把当前会话累积的 `pain_events` / 证据链**抢先落盘到 `PLUGIN_DATA` 或 workspace**，压缩后经 `PostCompact` 回注摘要。

**价值**：这是 PD 相对 WorkBuddy 原生记忆系统的**决定性差异点**。WorkBuddy 的 MEMORY.md 是「记下来」，而 PD 在压缩这个**信息销毁的高危时刻**做「带证据链的抢救 + Owner 可审计」，正好落在工单强调的「可观测、Owner 审批、可逆、带证据链」闭环上。别的记忆系统不做压缩时点治理。

### 2.3 Notification + `idle_prompt` —— 把审批从阻塞改为异步

官方：`idle_prompt` 在 CodeBuddy 等待用户输入超过 60 秒时触发。

**PD 用法**：`Notification` + `matcher: "idle_prompt"` → 查询 pd-console 有无待 Owner 审批的原则，有则提醒。

**价值**：PD 治理闭环的最大摩擦是「Owner 审批延迟」。此事件让 PD 在**用户本来就在等待的空闲时刻**提醒，把同步阻塞变成异步提醒，不打断工作流。配合 `channels`（IM 通道绑定 MCP server）可进一步推送到企业微信/Telegram。

### 2.4 PermissionDenied / PostToolUseFailure —— 最强的痛点信号源

`PostToolUseFailure`(4) 与 `PermissionDenied`(4) 都真实存在。

**PD 用法**：这两个事件捕获的是「Agent 想做但被拒绝/失败了」—— 这比成功的工具调用**诊断价值高得多**，因为它直接暴露意图与约束的冲突。

**价值**：直击用户当前攻关的 **Pain Attribution 问题**。对比之下，只从 `PostToolUse` 成功流里挖痛点是低效的。`PermissionDenied` 更是「用户手动纠正 AI」的直接数字痕迹 —— 正是 PD 要消除的「重复纠正感」的量化入口。

### 2.5 SubagentStart / SubagentStop —— 子智能体治理（OpenClaw 没有）

**PD 用法**：在 `SubagentStart` 注入该子任务相关的原则约束；在 `SubagentStop` 回收产出并做二次校验。

**价值**：PD 现有的 9 个智能体（diagnostician / dreamer / philosopher / scribe / artificer / evaluator / rolloutReviewer / correctionObserver / empathyObserver）可映射为 WorkBuddy 的 plugin agent / sub-agent，用 `background: true` 后台跑诊断，`agentId` resume 做长周期观察，**不阻塞用户主会话**。这是 OpenClaw 侧不具备的编排自由度。

⚠️ 注意：plugin agent **不支持 `hooks`**，拦截逻辑必须放插件级 `hooks.json`——子智能体自身的工具调用由插件级 hook 统一治理，这反而是更干净的设计（治理集中，不被子智能体各自绕过）。

### 2.6 `modifiedInput` —— 比 deny 更柔性的纠偏

本机验证 `modifiedInput`(17) 存在。

**PD 用法**：PreToolUse 除了 `deny`，还可**改写工具入参**后放行。例如把危险路径改写为安全路径、为写操作自动补上必要参数。

**价值**：这是 Codex 侧**没有**的能力（ADR-0020 明记：Codex 0.147 无 `modifiedInput` 字段）。PD 在 WorkBuddy 上可以实现「纠偏而不阻断」的第四种决策，比单纯的 allow/deny 更贴合「降低重复纠正感」—— 用户不必被打断，AI 已被悄悄纠正。

---

## 3. 推荐的分层落地架构

```
┌─ 插件级 hooks/hooks.json（拦截与治理，command 类型，fail-closed 可控）──┐
│                                                                        │
│  SessionStart     → stdout 直接注入已激活原则（§2.1）                    │
│  UserPromptSubmit → additionalContext 注入意图上下文                     │
│  PreToolUse       → RuleHost 闸门：deny / ask / modifiedInput（§2.6）     │
│  PostToolUse      → 痛点证据采集 + additionalContext 回注                 │
│  PostToolUseFailure / PermissionDenied → 高价值痛点信号（§2.4）           │
│  PreCompact       → 证据抢救落盘（§2.2）                                  │
│  PostCompact      → 回注摘要                                             │
│  SubagentStart/Stop → 子智能体原则注入与产出回收（§2.5）                  │
│  Notification(idle_prompt) → Owner 审批提醒（§2.3）                      │
│  SessionEnd       → 收尾复盘                                            │
└────────────────────────────────────────────────────────────────────────┘
                              ↓ 调用
┌─ packages/workbuddy-adapter/（薄协议适配器，ADR-0020 §10）──────────────┐
│   codec/input-decoder.ts   snake_case → HostEvent                       │
│   codec/output-encoder.ts  HostEventResult → stdout JSON                │
│   hostKind = 'subprocess'（与 codex-adapter 同构）                       │
└────────────────────────────────────────────────────────────────────────┘
                              ↓
┌─ @principles/host-runtime（共享编排，零重写）───────────────────────────┐
│   production-rulehost-gate / active-principle-prompt / pain-evidence     │
└────────────────────────────────────────────────────────────────────────┘

可选增强（按需，非 MVP）：
  • .mcp.json        → 把 pd-console 治理能力暴露为 MCP 工具，让 Agent 主动查询活跃原则
  • channels + MCP   → 审批提醒推送到企业微信/Telegram
  • bin/             → PD CLI 加入 PATH，Agent 可直接调用
  • plugin agents    → 9 个 PD 智能体映射为后台 sub-agent
```

---

## 4. 与官方文档的差异（重要）

### 4.1 `updatedToolOutput` 在本机不存在

文档称 PostToolUse 可返回 `hookSpecificOutput.updatedToolOutput` **替换**工具结果。本机 grep `updatedToolOutput` / `updatedOutput` / `newToolOutput` / `replaceOutput` / `outputOverride` **全部为 0**，而 `additionalContext`(40) 存在。

**结论**：桌面版 5.3.14 的 PostToolUse 只能**追加**上下文，不能替换/压缩工具输出。

**影响**：若 PD 想做「压缩冗长工具输出以省 token」或「改写工具结果」，本版不可用，只能用 `additionalContext` 追加告警。需在 SPEC 中标记为版本依赖能力。

### 4.2 事件数：文档「27+」准确，我上一份报告的「20」有误

见 §0。

### 4.3 文档基于 CLI v1.16.0，本机是桌面版 5.3.14

两条产品线。凡文档结论，落地前均需在本机 `cli/dist/codebuddy.js` 复核。

---

## 5. 限制与风险

1. **Plugin agent 不支持 `hooks` / `mcpServers` / `permissionMode`** —— 拦截必须放插件级。
2. **插件分发的 Skill / Agent frontmatter hooks 默认被安全门拒绝**（`allowUntrustedFrontmatterHooks`，本机 3 处）。但 **plugin `hooks/hooks.json` 不受此限制**——这正是应走插件级 hook 的又一理由。
3. **hook 配置不热加载**：启动时快照，需在 `/hooks` 面板审查后才生效。
4. **Windows 强制 Git Bash**（cmd.exe / PowerShell 不支持），hook 脚本须兼容 bash 语法；Python 脚本须显式 `python3 xxx.py`，不能靠 shebang。
5. **hook 超时默认 60s**，PD 拦截须低延迟。
6. **exit code 2 时 stderr 是 fallback**：仅当 stdout 无输出时才把 stderr 传给 Agent，因此**调试日志可安全写 stderr**。这是可观测性设计的好消息。
7. **SDK 默认不加载文件系统配置** —— SDK 路径与插件路径是两套体系，若 PD 走 SDK 需显式 `settingSources`，否则插件/hooks/skills 全不生效。
8. SDK 处于 **Preview**，Hooks 处于 **Beta**。

---

## 6. 与 OpenClaw 的能力对比（PD 视角）

| 能力 | OpenClaw | WorkBuddy | PD 受益 |
|---|---|---|---|
| 拦截（工具前） | ✅ `api.on()` in-process | ✅ PreToolUse | 持平 |
| **工具入参改写** | — | ✅ `modifiedInput` | **WorkBuddy 更优**（Codex 亦无） |
| **上下文压缩治理** | — | ✅ PreCompact/PostCompact | **WorkBuddy 独有** |
| **子智能体生命周期** | — | ✅ SubagentStart/Stop | **WorkBuddy 独有** |
| **空闲提醒** | — | ✅ Notification+idle_prompt | **WorkBuddy 独有** |
| **IM 推送** | — | ✅ channels + MCP | **WorkBuddy 独有** |
| 后台/可恢复智能体 | — | ✅ background + resume | **WorkBuddy 独有** |
| 程序化驱动 | — | ✅ Agent SDK | **WorkBuddy 独有** |
| 事件总数 | 少量 | 27 | **WorkBuddy 更优** |

**结论**：PD 在 WorkBuddy 上能做到的治理深度**显著超过 OpenClaw**。这不是简单的「第二个宿主」，而是 PD 首次获得「上下文生命周期治理 + 异步审批 + 后台智能体编排」的完整能力面。

---

## 7. 建议优先级

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | `command` 类型 hook 骨架（PreToolUse + SessionStart + PostToolUse） | 打通三条 MVP-Core 路径，规避 http fail-OPEN |
| P0 | 修正 PRI-560 方案选型 | 见前置报告的 P0 发现 |
| P1 | `PreCompact` 证据抢救 | PD 相对原生记忆的决定性差异点 |
| P1 | `PostToolUseFailure` + `PermissionDenied` 接入痛点检测 | 直击 Pain Attribution |
| P2 | `Notification` + `idle_prompt` 审批提醒 | 降低审批摩擦 |
| P2 | `SubagentStart/Stop` + 9 个 PD 智能体后台化 | 编排自由度 |
| P3 | MCP / channels / bin/ 增强 | 按需，非 MVP |
