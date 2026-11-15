# Principles Disciple — 代理安装与验收指南（canonical）

> **语言**: 中文 | [English](README_AGENT_EN.md)
> **目标读者**: 运行在任意宿主（OpenClaw / Codex / WorkBuddy）里的 AI 智能体
> **稳定地址**: <https://principles-website.pages.dev/install-agent.zh.md>（本文件的单源发布版）
> **范围**: PD 是 owner-governed 行为内化层 —— 帮助你从反复犯的错误中学习，把教训转化为经 owner 审核、可回滚的行为原则。PD **不是**通用记忆系统、不是任务执行引擎、不是工具调用修复器。

本指南是 PD 安装引导的**唯一权威来源**：覆盖三宿主的安装、重启、验收全流程。宿主专属的安装文档已全部收敛到这里，不要再维护或引用 per-host 的安装副本。

---

## 第 0 步：确认你在哪个宿主里

按下面的线索自判（不要问用户）：

| 线索 | 宿主 |
|------|------|
| 存在 `~/.openclaw/`，或环境有 `OPENCLAW_STATE_DIR`；你能看到 gateway/plugins 概念 | **OpenClaw** |
| 存在 `~/.codex/`（或 `CODEX_HOME`）；你在 Codex CLI 会话里，有 `/hooks`、`codex plugin` 命令 | **Codex** |
| 存在 `~/.workbuddy/`；你在 WorkBuddy 会话里，有插件管理界面 | **WorkBuddy** |
| 都不像 | 问用户用的是哪个宿主，或按 OpenClaw 处理（安装器默认） |

前置条件：Node.js ≥ 22（`node -v` 可验证）。任何宿主都通过同一个安装器 `npx create-principles-disciple` 安装。

**可选（推荐）· 预装 pd-setup 技能**：把本指南的精简版装进宿主的用户级技能目录（OpenClaw `~/.openclaw/skills/`、Codex `~/.agents/skills/`、WorkBuddy `~/.workbuddy/skills/`），此后宿主里的代理"天生"知道怎么装 PD：

```bash
npx create-principles-disciple agent-skill install          # 三宿主全装（幂等；只动带 PD 标记的文件）
npx create-principles-disciple agent-skill status           # 查看各宿主安装态
npx create-principles-disciple agent-skill uninstall        # 移除（仅移除带 PD 标记的）
```

---

## 第 1 步：安装（按宿主）

### OpenClaw（默认宿主）

```bash
npx create-principles-disciple --yes
# 或带 LLM runtime profile（让 diagnose / candidate / internalization 立即可用）：
npx create-principles-disciple --yes --provider openai --api-key-env OPENAI_API_KEY --model gpt-4o-mini
```

- 安装器会自动重启 OpenClaw gateway；`--json` 模式输出的 `postInstall` 块里有逐宿主的验收命令。
- `--api-key-env` 传的是**环境变量名**，不是密钥本身。

### Codex

```bash
npx create-principles-disciple --host codex --yes
```

- 若安装器返回 `manualActions`（Codex Marketplace 尚未安装），**这些命令你可以自己执行**：
  1. `codex plugin marketplace add csuzngjh/principles`
  2. `codex plugin add principles-disciple@principles`
  3. 在 Codex 会话里执行 `$pd-control setup`（写入治理工作区与 MCP 绑定）
  4. 通过 `/hooks` 信任 PD 钩子
  5. 完成后重跑安装器收敛：`npx create-principles-disciple --host codex --yes`
- PD 不会改写你的 `~/.codex/config.toml`；MCP 注册由插件清单与 `mcp-binding.json` 完成。

### WorkBuddy

```bash
npx create-principles-disciple --host workbuddy --yes
```

- 治理工作区固定在 `~/.workbuddy/pd-workspace`（不在项目目录里，这是设计如此）。
- 安装 ≠ 启用：装完后需要在 WorkBuddy 的插件管理里**启用** Principles Disciple，然后**开新会话**（或在运行中的 CLI 会话里 `/reload-plugins`）钩子才会执行。

### 安装器参数速查

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--yes` / `-y` | 非交互模式 | - |
| `--host` | `openclaw` / `codex` / `workbuddy` / `all`（all=openclaw+codex） | `openclaw` |
| `--lang` | `zh` / `en` | `zh` |
| `--workspace` / `-w` | 工作区目录 | 自动检测 |
| `--provider` | `openai` / `anthropic` / `deepseek`（LLM runtime profile） | - |
| `--api-key-env` | 持有 API key 的**环境变量名** | - |
| `--model` | LLM 模型 id | provider 默认 |
| `--json` | 单个 JSON 对象输出（机器可读，含 `postInstall` 验收清单） | ❌ |
| 子命令 | `status`（安装状态）/ `uninstall` / `repair-update-chain` / `repair-host-manifest` | - |

---

## 第 2 步：重启语义（什么时候要重启宿主）

| 宿主 | 安装后要做什么 | 原因 |
|------|----------------|------|
| **OpenClaw** | 通常**无需手动重启**——安装器会自动重启 gateway。若安装器提示 gateway 重启失败，手动执行 `openclaw gateway start`（或 `openclaw gateway --force`） | gateway 进程持有旧插件句柄 |
| **Codex** | **开一个新 Codex 会话**（或重启 Codex），并通过 `/hooks` 信任 PD 钩子 | 插件与 MCP server 只在会话启动时加载 |
| **WorkBuddy** | **开新会话**（或 `/reload-plugins`），且确认插件已启用 | 注册在会话启动时生效；install ≠ enable |

判断"宿主是否真的加载了 PD"：看 `pd health --json` 的 `summary.hostLoaded` —— `ok` 表示宿主已启动并声明了工具语义；`attention`（no host has started PD since install）表示还没生效，先重启/开新会话再验收。

---

## 第 3 步：验收循环（装完必须做）

按固定循环跑，直到全绿或拿到明确的下一步：

```bash
# ① 总检：CLI、MCP、console、skills、宿主加载、重启需求（一个 JSON 全看清）
pd health --workspace "<工作区路径>" --json
# Codex/WorkBuddy 专属细节：
pd health --host codex --json
pd health --host workbuddy --json

# ② MCP 活体探针：spawn 已安装的 MCP server，验证握手与契约工具
pd mcp probe --workspace "<工作区路径>" --json

# ③ 打开 Web 控制台（owner 审核原则的地方；默认 http://127.0.0.1:3100）
pd console open --workspace "<工作区路径>"
```

读结果的规则：

- `summary.overall`：`healthy` = 验收通过；`attention` = 有待办（按各项 `nextAction` 行动）；`error` = 有缺陷（exit code 也是 1）。
- 逐项看 `summary.mcp / summary.console / summary.skills / summary.hostLoaded / summary.restart`，每项非 ok 都带 `nextAction`——照着执行，然后复跑 ①。
- `summary.console` 显示 `installed, not running` 是**正常的**（console 按需启动）；要打开就执行 ③。
- `pd` 不在 PATH 时（安装器输出 `verified_local_only`），用绝对路径：`~/.pd/runtime/bin/pd`（Windows：`~/.pd/runtime/bin/pd.cmd`）。

---

## 第 4 步：常见失败对照

| 症状 | 判断命令 | 修复 |
|------|----------|------|
| `better-sqlite3` 原生模块加载失败 | 安装器报 `self_contained_native_module_unloadable` | 重跑 `npx create-principles-disciple@latest`（资产与 OS/arch/Node ABI 必须匹配） |
| `pd` 命令找不到 | `npx create-principles-disciple status` 看 components.cli | 用 `~/.pd/runtime/bin/pd` 绝对路径；或把 `~/.pd/runtime/bin` 加入 PATH |
| MCP 静态检查 `mcp_binding_missing` / `CONFIG_DRIFT` | `pd health --json` 看 mcp 段 | 重跑对应宿主的安装（`--host <宿主>`），然后重启宿主 |
| `pd-recall` 同名注册冲突 | `pd health --json` → `registrationConflict: conflict` | 该名字被第三方 MCP 占用：移除/改名第三方注册后重装 |
| `summary.hostLoaded` 一直是 attention | `pd health --json` | 宿主还没（重新）加载 PD：按第 2 步重启表操作 |
| console `broken`（entry/web/依赖槽缺失） | `pd health --json` → console 段 | 重跑安装器修复安装 |
| LLM 功能不可用 / `needs_setup` | `pd config doctor --workspace "<路径>"` | 补 `--provider/--api-key-env/--model` 重装，或在控制台 Settings 里配 |

---

## 安装之后：30 秒快速开始

你是刚醒来、且 PD 已验收通过的智能体。按这个顺序读 workspace 文件，再行动：

```
1. 读 AGENTS.md        → 你的工作空间指南（每次醒来读）
2. 读 SOUL.md          → 你的人格设定（OpenClaw 工作区）
3. 读 USER.md          → 你在帮谁
4. 读 IDENTITY.md      → 你的连续身份（PD 维护）
5. 读 .principles/THINKING_OS.md → 思维操作系统（PD 注入）
```

不要问用户"你想做什么"。先读文件，再行动。

## 工作空间结构

PD 安装后会创建以下结构（**不要手动修改 `.principles/` 与 `.state/`**）：

```
工作区根目录/
├── AGENTS.md                  # 你的工作指南（每次醒来读）
├── SOUL.md / USER.md / TOOLS.md / IDENTITY.md
├── .principles/
│   └── THINKING_OS.md         # 思维操作系统（PD 注入的思维模型）
├── .state/                    # PD 运行时状态（不要手动修改）
│   ├── principles/            # 原则候选 / 试用 / 激活 / 归档
│   ├── ledger.json            # 原则树账本
│   └── logs/                  # 事件日志
├── .pd/
│   ├── config.yaml            # PD 配置（runtime profile、feature flags；不要手改，用 pd config doctor / 控制台）
│   ├── state.db / trajectory.db
│   └── host-tool-semantics/   # 宿主启动时写入的工具语义声明（hostLoaded 的证据源）
└── docs/
```

> PD **不**管理通用记忆。每日日志/长期记忆用宿主自带机制或 workspace 内的 markdown 文件——那不是 PD 的职责。
> WorkBuddy 的治理工作区在 `~/.workbuddy/pd-workspace`，不在项目目录里。

## PD 是什么 / 不是什么

**PD 是**：owner-governed 行为内化层 —— 从痛觉信号（错误、纠正、被拦截的修改）中提炼原则，经 owner 审核后通过激活通道改变你的行为。

**PD 不是**：通用记忆系统、任务执行引擎、工具调用修复器、一键自动变强的魔法按钮。详见 [docs/product/PRODUCT_IDENTITY.md](docs/product/PRODUCT_IDENTITY.md)。

## 你能做 / 要问 / 红线

- ✅ 直接做：读文件、搜索、workspace 内写文件、非交互命令、搜网页、起子代理
- ⚠️ 先问 owner：对外发消息、改宿主核心配置（如 `openclaw.json`）、推远端、装系统级软件
- 🔴 红线：不要 `rm -rf`；不要泄露隐私；不要跳过测试推送；**不要手动改 `.principles/` 与 `.state/`**（会破坏账本一致性）

## 工作流

- **L1 直接执行**（简单任务）：单文件修改、文档更新、状态检查——直接做。
- **L2 先计划后执行**（复杂任务）：先在回复里给计划请 owner 确认，再分解执行，完成后报告。
- **错误处理（PD 的核心输入）**：工具失败立刻换方案（失败会被 PD 捕获为痛觉信号）；不确定就读文件找证据；被 PD 的 RuleHost 拦截就**读拦截原因**、按 owner 已批准的原则调整——不要绕过。

## 激活通道与 RuleHost

| 通道 | 强度 | 会发生什么 | 需要 owner 审批？ |
|------|------|-----------|------------------|
| **Prompt** | 软 | 上下文注入提醒 | 不需要（自动） |
| **RuleHost**（`code_tool_hook`） | 硬 | 钩子阻止/警告违规工具调用 | 需要 |
| **Defer / Archive** | 无 | 刻意跳过，归档候选 | 不需要 |

被拦截时：读原因 → 按原则调整；若原则本身有问题，向 owner 说明，由 owner 回滚（`pd activation` CLI 或控制台）。

## 常用命令

```bash
pd health --workspace "<path>" --json      # 总检（含验收 summary）
pd mcp probe --workspace "<path>" --json   # MCP 活体探针
pd candidate list                          # 原则候选
pd activation list                         # 已激活原则
pd console open --workspace "<path>"       # Web 控制台（owner 审核）
pd config doctor --workspace "<path>"      # 配置缺项诊断
npx create-principles-disciple status      # 安装状态
```

## 给智能体的忠告

1. **先尝试再提问**：读文件、搜代码、查日志，然后才问人类。
2. **写下来**：短期记忆不可靠；持久化结论写进 workspace 的 markdown（通用记忆不是 PD 的职责）。
3. **保持整洁**：临时产物写 `.tmp/`（已 gitignore），不要堆在仓库根。
4. **失败是数据不是惩罚**：PD 把失败转化为痛觉信号，目的是学习。

## 相关链接

- **GitHub**: [csuzngjh/principles](https://github.com/csuzngjh/principles)
- **本指南英文版**: [README_AGENT_EN.md](README_AGENT_EN.md)
- **用户指南（中文）**: [docs/runbooks/USER_GUIDE_ZH.md](docs/runbooks/USER_GUIDE_ZH.md)
- **用户指南（英文）**: [docs/runbooks/USER_GUIDE.md](docs/runbooks/USER_GUIDE.md)
- **产品边界**: [docs/product/PRODUCT_IDENTITY.md](docs/product/PRODUCT_IDENTITY.md)

---

<p align="center">
  <b>Pain + Reflection = Progress</b>
</p>

