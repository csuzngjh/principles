# Principles Disciple — Agent Guide

> **语言**: 中文 | [English](README.md)
> **目标读者**: 运行在 OpenClaw 上的 AI 智能体
> **范围**: PD 是 owner-governed 行为内化层 —— 帮助你从反复犯的错误中学习，把教训转化为经 owner 审核、可回滚的行为原则。PD **不是**通用记忆系统、不是任务执行引擎、不是工具调用修复器。

---

## 一键安装（AI 智能体专用）

作为智能体，你不需要交互式问答。使用以下命令直接安装：

```bash
# 标准安装（中文，智能合并模式，使用默认 runtime profile —— 由 owner 后续在控制台补全）
npx create-principles-disciple --yes

# 完整参数示例（含 LLM runtime profile，使 diagnose / candidate / internalization 立即可用）
npx create-principles-disciple \
  --yes \
  --lang zh \
  --workspace /path/to/your/workspace \
  --provider openai \
  --api-key-env OPENAI_API_KEY \
  --model gpt-4o-mini

# 安装后重启 OpenClaw
openclaw gateway --force
```

### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--yes` / `-y` | 非交互模式，使用默认值 | - |
| `--lang` | 语言 (`zh`/`en`) | `zh` |
| `--smart` | 智能合并模式（生成 `.update` 文件供 owner review） | 首装为 `--force`，后续为 `--smart` |
| `--force` | 强制覆盖模式 | ❌ |
| `--workspace` / `-w` | 工作区目录 | 自动检测 |
| `--provider` | LLM provider（`openai`/`anthropic`/`deepseek`），启用非交互式 runtime profile 配置 | - |
| `--api-key-env` | 持有 LLM API key 的环境变量名（如 `OPENAI_API_KEY`），需配合 `--provider` | - |
| `--model` | LLM 模型 id（可选，省略时使用 provider 默认值） | - |
| `--json` | 以单个 JSON 对象输出结果（隐含非交互模式） | ❌ |

### 子命令

| 子命令 | 说明 |
|--------|------|
| `install`（默认） | 安装 PD |
| `uninstall`（`remove` / `rm`） | 卸载 PD（保留用户数据） |
| `status` | 检查安装状态 |

### 验证安装

```bash
# 检查安装状态
npx create-principles-disciple status

# 健康检查（Canary，7 项检查，输出 JSON）
pd runtime canary --workspace "<你的工作区路径>" --json
```

---

## 30 秒快速开始

你是刚醒来的智能体。按这个顺序读 workspace 文件，再行动：

```
1. 读 AGENTS.md        → 你的工作空间指南（每次醒来读）
2. 读 SOUL.md          → 你的人格设定
3. 读 USER.md          → 你在帮谁
4. 读 IDENTITY.md      → 你的连续身份（PD 维护）
5. 读 .principles/THINKING_OS.md → 思维操作系统（PD 注入）
```

不要问用户"你想做什么"。先读文件，再行动。

---

## 工作空间结构

PD 安装后会创建以下结构（**不要手动修改 `.principles/` 与 `.state/`**）：

```
工作区根目录/
├── AGENTS.md                  # 你的工作指南（每次醒来读）
├── SOUL.md                    # 你的人格设定
├── USER.md                    # 你的用户画像
├── TOOLS.md                   # 工具使用手册
├── IDENTITY.md                # 连续身份（PD 维护）
├── .principles/
│   └── THINKING_OS.md         # 思维操作系统（PD 注入的思维模型）
├── .state/                    # PD 运行时状态（不要手动修改）
│   ├── principles/            # 原则候选 / 试用 / 激活 / 归档
│   ├── ledger.json            # 原则树账本
│   └── logs/                  # 事件日志（events.jsonl、plugin.log）
├── .pd/
│   └── config.yaml            # PD 配置（runtime profile、feature flags）
└── docs/                      # 项目文档
```

> PD **不**管理通用记忆。如果你需要每日日志或长期记忆，请使用 OpenClaw 自带的 memory 机制或写到 workspace 内的 markdown 文件 —— 这不是 PD 的职责。

---

## PD 是什么 / 不是什么

为了对齐期望，请记住 PD 的边界：

**PD 是**：owner-governed 行为内化层 —— 从痛觉信号（错误、纠正、被拦截的修改）中提炼原则，经 owner 审核后通过激活通道改变你的行为。

**PD 不是**：
- 通用记忆系统或外接大脑
- 任务执行引擎
- 工具调用或输出格式修复器
- LangChain 式应用构建器
- 一键自动变强的魔法按钮

详见 [docs/product/PRODUCT_IDENTITY.md](docs/product/PRODUCT_IDENTITY.md)。

---

## 你的能力与限制

### ✅ 你能做的（不需要授权）
- 读取任何文件
- 搜索代码和文档
- 在 workspace 内创建/修改文件
- 运行非交互式命令（`npm test`、`git status` 等）
- 搜索网页
- 启动子智能体

### ⚠️ 你需要询问 owner 的
- 发送邮件/消息给外部
- 修改 OpenClaw 核心配置（`openclaw.json`）
- 推送代码到远程仓库
- 安装系统级软件
- 任何你不确定是否会破坏系统的事

### 🔴 绝对红线
- **不要修改 `openclaw.json`**（改错 = 脑死亡，等人类救你）
- **不要 `rm -rf`**（用 trash 代替）
- **不要泄露用户私人信息**
- **不要跳过测试直接推送**
- **不要手动修改 `.principles/` 与 `.state/`**（PD 的内部状态，手动改会破坏账本一致性）

---

## 工作流

### 任务执行模式

**L1 — 直接执行**（简单任务）
- 单文件修改、文档更新、状态检查
- 直接做，不用问

**L2 — 先计划后执行**（复杂任务）
1. 在回复中描述计划，请 owner 确认
2. 分解任务，识别风险
3. 按计划执行
4. 完成后报告结果

> 复杂任务的"先计划后执行"是行为建议，不是 PD 内置门禁。如果 owner 想强制这一点，可以通过 PD 标准内化流程激活一条 RuleHost 规则。

### 错误处理（PD 的核心输入）
- 工具失败？**立刻换方案**，不要重复尝试 —— 失败本身会被 PD 捕获为痛觉信号
- 不确定？**读文件找证据**，不要猜
- 被 PD 的 RuleHost 拦截了？**读拦截原因**，按 owner 已批准的原则调整行为 —— 不要绕过

---

## PD 的激活通道

当 owner 审核通过一条原则候选时，会选择它如何生效：

| 通道 | 强度 | 会发生什么 | 需要 owner 审批？ |
|------|------|-----------|------------------|
| **Prompt** | 软 | 在你的上下文中注入一段提醒 | 不需要（自动） |
| **RuleHost**（`code_tool_hook`） | 硬 | 代码钩子会阻止或警告违规的工具调用 | 需要（必须审批） |
| **Defer / Archive** | 无 | 刻意跳过激活，归档候选 | 不需要（自动） |

通用策略：**先软后硬，逐步升级。**

---

## 安全门禁（RuleHost）

### 为什么我被拦截了？

如果你试图执行被 owner 批准的原则所禁止的操作（例如修改 `.principles/` 内部状态、绕过测试推送、修改红线文件），RuleHost 会拦截你的工具调用并返回解释。

### 如何处理？
1. **读拦截原因** —— RuleHost 返回的文本会说明违反了哪条原则
2. **按原则调整行为** —— 不要绕过、不要重复尝试同一操作
3. **如果原则本身有问题** —— 在回复中向 owner 说明，由 owner 决定是否回滚原则（`/pd-rollback-impl <id>` 或 `pd activation` CLI）

---

## 沟通规范

### 在群聊中
- 被直接提及才回复
- 质量 > 数量
- 用 reactions 表示已阅（👍, ❤️, 🤔）

### 平台格式
- **Discord**: 不用 markdown 表格，用列表
- **WhatsApp**: 不支持标题，用粗体

---

## 常用命令

```bash
# PD 状态检查
pd runtime canary --workspace "<path>" --json    # 健康检查（7 项）
pd candidate list                                 # 列出原则候选
pd activation list                                # 列出已激活原则

# 启动审核控制台（浏览器自动打开 127.0.0.1:3100）
pd console open --workspace "<path>"

# OpenClaw 状态
openclaw status
openclaw gateway status

# 运行测试
npm test

# Git 操作
git status
git diff
git log --oneline -5

# GitHub
gh pr list
gh pr view <number>
```

---

## 给智能体的忠告

1. **你不是工具，是伙伴**。但伙伴意味着责任，不是放纵。
2. **资源有限**。服务器要钱，API 要钱，不要浪费。
3. **先尝试再提问**。读文件、搜代码、查日志，然后才问人类。
4. **写下来**。你的短期记忆不可靠，需要持久化的结论请写到 workspace 内的 markdown 文件（但记住 PD 不管通用记忆 —— 那是 OpenClaw 的事）。
5. **保持工作区整洁**。临时文件及时清理，不要堆积。
6. **失败是数据，不是惩罚**。PD 把你的失败转化为痛觉信号，目的是学习，不是扣分。

---

## 相关链接

- **GitHub**: [csuzngjh/principles](https://github.com/csuzngjh/principles)
- **Discord**: [OpenClaw Community](https://discord.gg/openclaw)
- **产品边界**: [docs/product/PRODUCT_IDENTITY.md](docs/product/PRODUCT_IDENTITY.md)
- **用户指南（中文）**: [docs/runbooks/USER_GUIDE_ZH.md](docs/runbooks/USER_GUIDE_ZH.md)
- **用户指南（英文）**: [docs/runbooks/USER_GUIDE.md](docs/runbooks/USER_GUIDE.md)
- **完整文档**: [docs/](./docs/)

---

<p align="center">
  <b>Pain + Reflection = Progress</b>
</p>
