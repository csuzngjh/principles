# 🛠️ 工具能力矩阵

**目的**：避免再次发生"误解工具可用性"的错误。每次引入新工具/技能，必须在此记录基本信息。

---

## 通用检查清单

对于每个工具，回答以下问题：

| 项目 | 说明 |
|------|------|
| **工具名称** | 如 `acpx`, `sessions_spawn`, `gemini` |
| **CLI路径** | 二进制文件位置（`which <cmd>`） |
| **调用方式** | 直接 CLI 调用 / OpenClaw 工具 / 其他 |
| **是否受 agents_list 限制** | Y / N（Y 表示需要 agents 配置） |
| **最小测试命令** | 验证工具是否可用的最短命令 |
| **典型用例** | 什么情况下使用此工具 |
| **配置要求** | 需要什么配置文件或环境变量 |

---

## 已记录的工具

### acpx

| 项目 | 信息 |
|------|------|
| **工具名称** | acpx |
| **CLI路径** | `~/.npm-global/bin/acpx` |
| **调用方式** | 直接 CLI 调用（shell exec） |
| **是否受 agents_list 限制** | **N** - 直接调用系统 CLI 工具，不受 OpenClaw agents 配置限制 |
| **最小测试命令** | `acpx claude "OK" --print` 或 `acpx gemini exec "test"` |
| **典型用例** | 快速调用 AI 编程助手（Claude, Gemini, OpenCode, Codex）执行一次性任务 |
| **配置要求** | 目标 agent CLI 必须已安装（claude, gemini, opencode, codex） |

**关键认知纠正** (2026-03-16):
- 我之前混淆了 `acpx` 和 `sessions_spawn`。
- `acpx` 直接调用本地 CLI，**不需要** `agents_list` 中的配置。
- `sessions_spawn runtime="acp"` 才需要 `acp.allowedAgents` 配置。
- **教训**：看到 `agents_list` 只返回 `main` 时，不要推断 `acpx` 不可用。直接测试 `acpx <agent> "test"`。

---

### sessions_spawn

| 项目 | 信息 |
|------|------|
| **工具名称** | sessions_spawn |
| **调用方式** | OpenClaw 内置工具（`sessions_spawn` 函数） |
| **是否受 agents_list 限制** | **Y** - 必须检查 `agents_list`，agentId 需在允许列表中 |
| **最小测试命令** | `agents_list` 查看允许的 agentId，然后 `sessions_spawn(agentId="xxx", ...)` |
| **典型用例** | 启动持久化 ACP 会话（thread-bound、sub-agent 协作） |
| **配置要求** | `~/.openclaw/openclaw.json` 中的 `acp.allowedAgents` 列表 |

**注意**：如果 `agents_list` 为空或只有 `main`，说明未配置外部 agents，此时 `sessions_spawn` 失败是正常的。不要误判为整个 ACP 系统不可用。

---

### claude (Claude Code)

| 项目 | 信息 |
|------|------|
| **工具名称** | claude |
| **CLI路径** | `/home/linuxbrew/.linuxbrew/bin/claude` |
| **调用方式** | 直接 CLI (`claude --print ...`) 或通过 `acpx claude` |
| **是否受 agents_list 限制** | N（直接调用） |
| **最小测试命令** | `claude --print --permission-mode bypassPermissions "OK"` |
| **典型用例** | 需要 Claude 模型执行代码生成、分析任务 |
| **配置要求** | 通过 `claude auth` 登录（已配置） |

---

### gemini (Gemini CLI)

| 项目 | 信息 |
|------|------|
| **工具名称** | gemini |
| **CLI路径** | `~/.npm-global/bin/gemini` |
| **调用方式** | 直接 CLI (`gemini run ...`) 或通过 `acpx gemini` |
| **是否受 agents_list 限制** | N（直接调用） |
| **最小测试命令** | `gemini run "test"` |
| **典型用例** | 一次性问答、摘要、生成（Google Gemini 模型） |
| **配置要求** | 通过 `gemini auth` 登录（已配置） |

**注意**：模型名需带 `-preview` 后缀（如 `gemini-3.1-pro-preview`），否则可能报错。

---

### opencode (OpenCode)

| 项目 | 信息 |
|------|------|
| **工具名称** | opencode |
| **CLI路径** | `/home/csuzngjh/.npm-global/bin/opencode` |
| **调用方式** | 直接 CLI (`opencode run ...` 或 `opencode acp`) 或通过 `acpx opencode` |
| **是否受 agents_list 限制** | N（直接调用） |
| **最小测试命令** | `opencode models` 查看可用模型，`opencode run "test"` |
| **典型用例** | 免费模型任务（OpenAI、NVIDIA、OpenRouter 等），支持 ACP 服务模式 |
| **配置要求** | 通过 `opencode auth` 登录（已配置） |

**注意**：`opencode run` 启动 TUI 交互模式，适合手工操作；`opencode acp` 启动 ACP 服务供其他工具连接。

---

## 维护规则

1. **每次引入新工具**：立即在此文件添加条目，填写所有字段。
2. **工具能力变更**：更新对应条目，记录变更日期和原因。
3. **踩坑记录**：在条目下添加"⚠️ 警告"小节，记录常见误解和错误用法。
4. **会话启动检查**：每次新会话开始时，快速浏览此文件，确保对工具能力的认知是最新的。

---

## ⚠️ 2026-03-17 重要教训：智能体类型混淆

### 问题复现
- 看到 `agents_list` 没有 `diagnostician`，误以为不可用
- 错误使用 `sessions_spawn(agentId="diagnostician")`（需要预配置 agentId）
- 正确方式：`pd_spawn_agent(agentType="diagnostician")`（无需预配置）

### 智能体分类速查

| 分类 | 启动方式 | 配置要求 | 查看方式 | 示例 |
|------|----------|----------|----------|------|
| **独立 Agent** | `sessions_spawn(agentId=...)` | 需在 `openclaw.json` → `agents.list` 配置 | `agents_list` 返回 `id` | `pm`, `resource-scout` |
| **子智能体类型** | `pd_spawn_agent(agentType=...)` | **无需预配置**，运行时动态派生 | `pd_spawn_agent` 错误信息列出可用类型 | `diagnostician`, `explorer`, `auditor`, `implementer`, `planner`, `reporter`, `reviewer` |

### 决策流程图
```
需要启动智能体？
  ↓
检查 agents_list 是否包含目标 ID？
  ├─ 是 → 独立 Agent → 用 sessions_spawn(agentId=...)
  └─ 否 → 是否 pd_spawn_agent 支持的 agentType？
        ├─ 是 → 子智能体 → 用 pd_spawn_agent(agentType=...)
        └─ 否 → 未配置或类型错误 → 检查配置或修正类型拼写
```

---

## 📂 仓库映射表（避免错提交 Issue）

| 仓库 | 用途 | 问题提交流程 |
|------|------|--------------|
| **openclaw/openclaw** | OpenClaw 核心平台（网关、插件系统、工具链） | Bug 发生在 `gateway/`, `packages/openclaw/`, `cli/` → 提交到此 |
| **csuzngjh/evolving-claw** | Principles Disciple 插件（思维操作系统、进化框架） | Bug 发生在 `extensions/principles-disciple/` 或 `memory/` 相关 → 提交到此 |

**提交前验证命令**：
```bash
# 1. 确认当前仓库
git remote -v
# 2. 确认问题路径
pwd
# 3. 如不确定，先搜索文件路径包含的关键词
ls -la | grep -E "openclaw|principles"
```

**重大提醒**：2026-03-17 我误将 Principles 插件的 bug 提交到 OpenClaw 仓库，导致 issue #48575 需要关闭和重新提交。**务必核实**！

---

## 快速参考：哪些工具需要 agents_list 配置？

| 需要 agents_list 配置 | 不需要 agents_list 配置 |
|----------------------|------------------------|
| `sessions_spawn` (ACP harness) | `acpx` (直接 CLI) |
| `pd_spawn_agent` (sub-agent) | 所有系统 CLI (`claude`, `gemini`, `opencode`, `codex`) |
| `agent-browser` (通过 OpenClaw) | 直接 `exec` 调用的 CLI |

**核心原则**：`agents_list` 只限制 OpenClaw 内部的 agent 启动机制（`sessions_spawn` 和 `pd_spawn_agent`）。`acpx` 和直接 `exec` 调用的是系统级 CLI，完全独立。

---

*最后更新: 2026-03-16 23:55 UTC*
*维护者: 麻辣进化者*
