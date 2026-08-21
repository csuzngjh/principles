# PD 作为 WorkBuddy 插件：可行性评估（给维护者）

> 状态：调研结论（未进入实现） · 日期：2026-08-21
> 目的：回答"PD 能不能做成 WorkBuddy 插件"，并核实官方材料与 PD 源码，给出可落到 MVP 的判断。

## 0. 结论（TL;DR）

**可以做，且可行性已被官方文档与 PD 源码双向证实。** 关键阻塞点——"WorkBuddy 是否暴露可供插件订阅的 Agent 生命周期 Hook"——已确认存在：WorkBuddy（底层引擎 CodeBuddy）提供 **Beta 阶段的 Hooks 系统**，插件可通过 `hooks/hooks.json` 订阅与 OpenClaw 同构的 `PreToolUse / PostToolUse / UserPromptSubmit / SessionStart …` 事件，且 `PreToolUse` 原生支持 `allow/deny/ask` 决策。

PD 今天在 OpenClaw 上跑的核心机制（拦截→检测痛点→提案→审批→注入）**每一步都能映射到 WorkBuddy 的对应 Hook**，且 PD 的治理/检测引擎（pd-console、runtime-v2）几乎可以不改地复用。

**推荐落地形态：混合方案**——WorkBuddy 插件只做薄薄的 `hooks/hooks.json`（PreToolUse/PostToolUse → `http` 转发到 PD 既有 HTTP 服务），拦截语义与治理闭环留在 PD。详见 §5。

> ⚠️ 治理前提（必须如实告知维护者）：按 `AGENTS.md` 的 MVP-First 分层（ADR-0014），"WorkBuddy 插件"是一个**新的接入面（surface）**，不是 PD 既有核心功能。默认应归入 **MVP-Quiet**（feature flag 默认 off、不进 UI），除非维护者明确批准升为 MVP-Core。本报告未替维护者做此批准决定。

---

## 1. PD 当前架构与 Hook 依赖（已核实）

PD 是 OpenClaw 的插件，其价值闭环强依赖宿主把 Agent 生命周期事件暴露给插件。核实证据：

| PD 闭环步骤 | 实现位置（源码） | 关键事实 |
|---|---|---|
| 声明依赖宿主 Hook | `openclaw.plugin.json` | `"activation": { "onCapabilities": ["hook"] }`（第 6–9 行） |
| 拦截 + 闸门（RuleHost） | `host-runtime/dist/production-rulehost-gate.js` | `createProductionRuleHostGate` 返回 `async (event) => …`；读取 `event.context.toolName / workspaceDir / sessionId` 与 `event.rawPayload.toolInput`；查询 `state.db` 中 `channel='code_tool_hook'` 的激活规则；命中返回 `decision: 'deny'` + `reason`（第 64–66、69–75、120–138、277–283 行） |
| 激活原则注入上下文 | `host-runtime/dist/active-principle-prompt.js` | `buildActivePrinciplePromptContext` 从 `state.db` 读取已激活原则，经 `renderPrinciplesToDirectives` 渲染为指令，返回 `additionalContext`（第 6、35–67、81–105 行） |
| 检测痛点（失败/重复纠错） | `host-runtime/dist/production-pain-evidence.js` | `createProductionPainEvidenceHandler` 读取 `event.context.toolName / toolInput / toolOutput`，将 `tool_calls` 与 `pain_events` 写入 `.state/trajectory.db`；写工具失败时触发诊断任务（第 177–179、216–234、248–255 行） |
| 治理台（审批/证据链） | `packages/pd-console` | 独立 HTTP 服务，`host='127.0.0.1'`、`port=3100`（`src/server/index.ts` 第 114–115 行）；`GET /api/v1/evidence-chain` 返回 JSON 证据链（`src/server/routes/evidence-chain.ts` 第 4、35 行）；其余路由含 `principles / activations / approvals / governance / intent` 等 |
| 提案智能体管线 | `packages/principles-core/src/runtime-v2/` | 9 个智能体均已实现：`diagnostician`、`dreamer`、`philosopher`、`scribe`、`artificer`、`evaluator`（`internalization/` 与 `diagnostician/`）、`rolloutReviewer`、`correctionObserver`（`observer/`）、`empathyObserver`（`observer/`） |

**结论**：PD 的三个运行时集成点（闸门、注入、痛点检测）都是"读 hook 事件 + 读写本地 SQLite"，没有任何 OpenClaw 私有 API 深度耦合——这正是它能迁移到 WorkBuddy 的根本原因。

---

## 2. WorkBuddy 官方能力（已逐字核实）

信源：WorkBuddy 官网《CodeBuddy Plugin Reference》《Hooks Reference》（见 §8）。

### 2.1 插件可携带 Hooks

> "A **plugin** is a self-contained component directory that extends CodeBuddy with custom functionality. Plugin components include **Skills, Agents, Hooks, MCP servers, and LSP servers**."

> "**Location**: `hooks/hooks.json` under the plugin root, or inline configuration in `plugin.json`."

官方给出的 `hooks.json` 示例（与 OpenClaw/Claude Code 同构）：

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Write|Edit",
        "hooks": [ { "type": "command",
                     "command": "${CODEBUDDY_PLUGIN_ROOT}/scripts/format-code.sh" } ] }
    ]
  }
}
```

`plugin.json` 清单也直接支持 `"hooks"` 字段（指向 `./config/hooks.json`）。

### 2.2 插件可订阅的生命周期事件（节选，与 PD 一一对应）

> "Plugin hooks respond to the same lifecycle events as user-defined hooks:"

| 事件 | 触发时机 | PD 对应步骤 |
|---|---|---|
| `PreToolUse` | 工具执行前；**可阻断** | 拦截 / RuleHost 闸门 |
| `PostToolUse` | 工具调用成功后 | 检测痛点（含 `tool_input`/`tool_response`） |
| `UserPromptSubmit` | 用户提交 prompt（AI 处理前） | 检测痛点 / 上下文注入 |
| `SessionStart` | 会话开始/恢复 | 激活原则注入 |
| `InstructionsLoaded` | `CODEBUDDY.md`/rules 载入上下文时 | 激活原则注入 |
| `Stop` | AI 回复结束 | 闭环收尾 |

文档称支持 **27+ 事件**，覆盖工具生命周期、会话、子代理、用户交互、上下文压缩等。

### 2.3 Hook 类型（含 `http` —— 混合方案的关键）

官方列出四种 `type`：`command` / `prompt` / `agent` / **`http`**。

> "**http**: Sends the event JSON as a POST request to a URL."

`http` 类型带 `url` 与 `method` 字段——意味着 WorkBuddy 可以把 Hook 事件**原样 POST 给 PD 既有的 HTTP 服务**（pd-console :3100），由 PD 处理后返回决策。

### 2.4 PreToolUse 阻断语义（= RuleHost 闸门）

> "**Exit code 2** – Blocking error. … **PreToolUse** Blocks the tool call and surfaces message to Agent"

进阶模式还支持结构化决策：

```jsonc
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "…",
    "modifiedInput": { "field_to_modify": "new value" } } }
```

这与 `production-rulehost-gate.js` 输出的 `decision: 'allow' | 'deny'` + `reason` **语义同构**，迁移几乎零转换。

### 2.5 Hook 输出注入上下文（= 原则注入）

`PostToolUse` / `UserPromptSubmit` / `SessionStart` 的 `hookSpecificOutput` 均支持 `additionalContext` 字段——对应 `active-principle-prompt.js` 返回的 `additionalContext`。

### 2.6 版本与状态（重要前提）

> "**Version requirement:** This guide targets the Hooks implementation shipped with CodeBuddy Code v1.16.0 and later. **Feature status:** Hooks are currently in **Beta**; APIs and runtime behavior may evolve."

---

## 3. 可行性映射总览

| PD 闭环步骤 | WorkBuddy 对应 Hook / 能力 | 可行性 |
|---|---|---|
| 1 拦截行为（可阻断） | `PreToolUse` + `exit 2` / `permissionDecision: deny` | ✅ 直连，语义同构 |
| 2 检测痛点 | `PostToolUse`（含 `tool_input`/`tool_response`）+ `UserPromptSubmit`（`prompt`） | ✅ 数据齐备 |
| 3 提案原则（9 智能体） | 复用 `runtime-v2` 管线；或包装为 WorkBuddy Plugin Agent | ✅ 逻辑可复用 |
| 4 Owner 审批 | 复用 pd-console（Skill/UI 不变） | ✅ 已具备 |
| 5 强制注入原则 | `SessionStart` / `InstructionsLoaded` 注入 `additionalContext`，或 `PreToolUse` 复核闸门 | ✅ 直连 |
| 证据链 | Hook payload 自带 `session_id` + `transcript_path` | ✅ 数据源已现成 |

---

## 4. 三种落地路径

### 路径 A — 桥接（Connector / MCP）
- 做法：WorkBuddy 通过 MCP Connector 调 pd-console 的 `:3100` JSON API，仅做治理可见性（审批/查证据链）。
- 优点：半天出原型，不动核心架构。
- 缺点：**拿不到拦截**。PD 仍需跑在 OpenClaw 或独立服务上，WorkBuddy 只是远程仪表盘。
- 可行性：✅（API 已现成），但**不完整**——缺 PD 最关键的拦截/注入闭环。

### 路径 B — 原生移植（Expert / Agent / Hook）
- 做法：把 9 智能体搬成 WorkBuddy Plugin Agents，RuleHost 改造成 WorkBuddy Hook 注入，完整闭环脱离 OpenClaw。
- 优点：完整闭环，WorkBuddy 原生体验。
- 缺点：近乎重写；且**Plugin Agent 不允许挂 Hook**（见 §6 坑 3）——拦截逻辑必须放在插件级 `hooks.json`，不能塞进子 Agent。
- 可行性：✅（Hook 面已证实），但工作量大。

### 路径 C — 混合（推荐）
- 做法：WorkBuddy 插件只含 `hooks/hooks.json`，用 `http` 类型把 `PreToolUse`/`PostToolUse` 事件 POST 给 PD 既有 HTTP 服务；PD 的 RuleHost / 痛点检测 / 审批 / 证据链**完全不动**。
- 优点：改动最小、风险最低、PD 引擎零重写；同时拿到完整拦截闭环。
- 缺点：依赖 PD 服务在本地运行（与今天 OpenClaw 宿主并存）；Beta Hook API 可能演进。
- 可行性：✅✅（Hook 面 + `http` 类型 + PD 既有 HTTP 服务三者俱备）。

---

## 5. MVP 三问 + 情绪价值对齐（按 `AGENTS.md`）

`AGENTS.md` 规定每个新 issue 必须回答四问（第 22–25 行）：

> 1. `mvp-q-1-what-if-skip` — 不做会怎样？30 天后还有人会提吗？
> 2. `mvp-q-2-how-observed` — 如何被观测？用户怎么验证它生效？
> 3. `mvp-q-3-how-disabled` — 如何关闭？feature flag 还是 PR revert？
> 4. `mvp-q-4-emotional-value` — 交付什么情绪价值？

### mvp-q-1（不做会怎样）
PD 继续只在 OpenClaw 上可用。WorkBuddy 是种子用户日常开发的主环境；若不做，种子用户在 WorkBuddy 里仍要**重复纠正同一个 AI 行为**——而这正是 PD 要消除的痛点（`AGENTS.md` 第 31 行核心承诺："把 … 重复纠正感 … 转化为 … 沉淀感"）。30 天后会被反复提起。**但**：这是新接入面，按 ADR-0014 默认应 MVP-Quiet，需维护者批准才升 MVP-Core（见 §0 警告）。

### mvp-q-2（如何观测）
- 拦截生效：Hook 决策日志（`allow`/`deny`），pd-console 的 `activations` 路由可查已激活规则。
- 注入生效：`active-principle-prompt` 的 `principleIds` 计数；`SessionStart` 注入的 `additionalContext` 长度。
- 痛点检测：`GET /api/v1/evidence-chain`（已确认返回 JSON，§1）展示 `pain_events` 与证据链。
- 以上三条都有**可观测路径**，满足要求。

### mvp-q-3（如何关闭）
PD 已有 feature-flag 契约（`feature-flag-contract.ts`，注册于 `{workspace}/.pd/config.yaml`，`category: core|quiet|gone`）。WorkBuddy 插件 Hook 可经同一 flag 关闭；或在 WorkBuddy 侧卸载插件 / 移除 `hooks.json`。**满足"从第一天起带 feature flag"的要求**。

### mvp-q-4（情绪价值）
直接对齐 `docs/product/emotional-value.md` 核心承诺（第 31 行）：
- 降低：**失控感**（是否生效不可知）→ 通过 pd-console 可见的审批流消除；**重复纠正感** → 原则沉淀后下次自动遵守。
- 提升：**安心感 / 掌控感**（Owner 对每个原则显式批准）、**沉淀感**（纠正变成可复用原则）。

---

## 6. 风险与前提（必须核实项）

1. **Beta 状态**：官方明确 "Hooks are currently in Beta; APIs and runtime behavior may evolve"。锁定具体 WorkBuddy 版本后再实现，并为 Hook 适配层留版本开关。
2. **命名两套**：底层引擎 CodeBuddy（配置 `~/.codebuddy/settings.json`），产品 WorkBuddy（用户级 `~/.workbuddy/settings.json`）；插件清单统一 `plugin.json`（亦支持 `.workbuddy-plugin/plugin.json`）。写入路径需按目标版本确认。
3. **Plugin Agent 不能挂 Hook**：官方明确 "For security reasons, plugin agents do not support the `hooks`, `mcpServers`, or `permissionMode` fields"。因此拦截逻辑**必须放在插件级 `hooks.json`**，不能放进某个子 Agent——路径 B 的设计要避开这个坑。
4. **"文档列了 ≠ 桌面版一定触发"**：社区实测（探针脚本跑真实任务）确认桌面版会触发 `PreToolUse / PostToolUse / UserPromptSubmit / SessionStart / Stop / PermissionRequest / Notification`——恰好是 PD 依赖的。但**正式开工前仍需在本机用探针脚本验证 `PreToolUse/PostToolUse` 的触发与 payload 字段齐全**（尤其 `tool_input`/`tool_response`/`session_id`/`transcript_path`）。
5. **与 WorkBuddy 记忆系统重叠风险**：WorkBuddy 已有 MEMORY.md / 云端记忆 / 工作区记忆做跨会话沉淀。PD 的差异点必须是"**可观测、Owner 审批、可逆、带证据链**"的治理闭环——若只做"记下来"，WorkBuddy 记忆已能覆盖，价值不成立。

---

## 7. 推荐下一步（验证动作）

1. **探针脚本**（最高优先）：在目标 WorkBuddy 版本上挂 `PreToolUse`/`PostToolUse` 探针，确认触发与 payload 字段；预计 0.5 天。
2. **骨架 PR（MVP-Quiet）**：写 `plugin.json` + `hooks/hooks.json`（`http` 转发到 pd-console），配 feature flag 默认 off；预计 1–2 天。
3. **原生闭环验证**：在骨架上接 PD 的 `production-rulehost-gate` 决策与 `active-principle-prompt` 注入，跑一端到端 demo。

---

## 8. 参考信源

### 官方文档（URL，均于 2026-08-21 访问核实）
- WorkBuddy 插件参考：https://www.workbuddy.ai/docs/cli/plugins-reference
  - 插件组件列表、Hooks 位置、Plugin Agent 限制、plugin.json 字段 —— 见 §2.1、§2.2、§6 坑 3。
- WorkBuddy Hooks 参考：https://www.workbuddy.ai/docs/cli/hooks
  - 版本/Beta、事件矩阵、Hook 类型、PreToolUse 阻断、输出 JSON、退出码 —— 见 §2.2–§2.6。
- WorkBuddy 中文 Hook 文档（交叉核对 payload/output 格式）：https://www.workbuddy.cn/docs/ide/Features/Hooks
- WorkBuddy 简介：https://www.workbuddy.cn/docs/workbuddy/Overview

### PD 源码（文件:行号）
- `C:/Users/Administrator/.openclaw/extensions/principles-disciple/openclaw.plugin.json:6-9`（onCapabilities: hook）
- `…/host-runtime/dist/production-rulehost-gate.js:64-66, 69-75, 120-138, 277-283`（闸门 allow/deny）
- `…/host-runtime/dist/active-principle-prompt.js:6, 35-67, 81-105`（原则注入 additionalContext）
- `…/host-runtime/dist/production-pain-evidence.js:177-179, 216-234, 248-255`（痛点检测写入 trajectory.db）
- `D:/Code/principles/packages/pd-console/src/server/index.ts:114-115`（host 127.0.0.1 / port 3100）
- `D:/Code/principles/packages/pd-console/src/server/routes/evidence-chain.ts:4, 35`（`GET /api/v1/evidence-chain` JSON）
- `D:/Code/principles/packages/principles-core/src/runtime-v2/`（9 智能体实现：diagnostician / dreamer / philosopher / scribe / artificer / evaluator / rolloutReviewer / correctionObserver / empathyObserver）
- `D:/Code/principles/AGENTS.md:22-25, 31`（MVP 三问 + 情绪价值核心承诺）
