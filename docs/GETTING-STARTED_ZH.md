# Principles Disciple 入门

> **一句话说清楚 PD 是什么：** 你的 AI 助理总犯同样的错误？PD 能发现规律、让你审核，然后让 AI 不再重复犯。全程由你做主。

---

## PD 是什么

Principles Disciple（简称 PD）做的事情很简单：

```
你的 AI 犯错 → PD 发现模式 → 你来审核 → AI 下次不再犯
```

每一步都由你**掌控**。没有你的批准，什么都不会生效。所有更改都可以**撤销**——如果改得不好，一键就能恢复。

PD 改变的是 AI 的**行为模式**——不是某个命令错误，不是它记住了什么，而是它的*做事方式*。类似你告诉朋友："删东西前先问一声。" PD 让这种习惯跨会话持续生效，AI 会自动做对，不用每次都重新教。

## PD 不是什么

| 不是这个 | 原因 |
|----------|------|
| 任务执行器 | PD 不做你的工作。它改变*AI 怎么做工作*。 |
| 记忆系统 | PD 不帮 AI 记事实。那是 AI 自己的事。 |
| 自动修复机器人 | PD 提建议，**你来批准**。没有暗箱操作。 |
| 统计仪表盘 | PD 关心的是*你实际看到的行为变化*，不是图表。 |
| 惩罚系统 | PD 不惩罚错误。它从模式中学习。 |

PD 是 AI 行为的**治理层**。就这么简单，但这已经很有用了。

---

## 快速安装（Windows/Mac/Linux 通用）

### 前提条件

确保已经安装了这两样：

1. **Node.js** ≥ 18（从 [nodejs.org](https://nodejs.org) 下载）
2. **OpenClaw CLI** — AI 助理运行的环境

验证方式：
```bash
node --version
openclaw --version
```

### 一行命令安装

```bash
npx create-principles-disciple --yes
openclaw gateway --force
```

大约需要 2 分钟。安装三样东西：

- **PD 插件** — 运行在 AI 助理内部，观察行为模式
- **`pd` CLI** — 命令行工具，检查状态、管理原则
- **PD Console** — 网页界面，审核和批准原则

### 验证安装

```bash
pd runtime canary --workspace "<你的工作区路径>"
```

看到 `healthy` 就对了。Console 在 **http://127.0.0.1:3100**（运行 `pd console --workspace "<你的工作区路径>"` 打开它）。

---

## Console / CLI / Plugin 分别是什么

### PD 插件（运行在 OpenClaw 内部）

这是核心引擎。安装到 OpenClaw 的扩展目录后，每次你用 AI 助理它都在工作：

- ❤️ **观察**行为模式（不是记录你做的所有事——只关注行为信号）
- 🔍 **诊断**这个模式是偶然事件还是值得你关注
- 📨 **提议**原则，等你来审核

你不用直接和插件打交道。它是幕后引擎。

### PD CLI（`pd` 命令）

命令行工具，用于检查状态和管理安装：

```bash
pd runtime canary    # 一切正常吗？
pd status            # 当前状态
pd activation list   # 哪些原则已生效
```

### PD Console（网页界面）

浏览器界面，你可以在这里：
- 审核原则提议
- 批准或拒绝
- 查看什么是活跃的、什么是存档的
- 提交反馈

打开方式：`pd console --workspace "<你的工作区路径>"` → http://127.0.0.1:3100

---

## 如何提交反馈

PD 重视你的隐私。反馈采用**本地优先**设计：

1. **打开 Console**：运行 `pd console --workspace "<你的工作区路径>"`
2. **进入反馈页**：点击反馈入口
3. **填写发生了什么**：类型、标题、描述
4. **查看隐私预览**：PD 会明确展示哪些信息会被包含
5. **保存本地草稿**（可选）：保存在 `<工作区>/.pd/feedback/drafts/`
6. **自行复制或提交**：PD 永远不会自动发送任何内容

### 隐私保证

| 包含 | 不包含 |
|------|--------|
| 插件版本、操作系统信息 | 原始聊天内容 |
| Feature flag 状态 | 你的文件内容 |
| 有限的诊断摘要 | 完整的堆栈跟踪 |
| 你输入的反馈文本 | 环境变量、令牌、API 密钥 |

任何信息离开你的电脑之前，你都能看到具体包含什么。

**[在 GitHub 上反馈问题](https://github.com/csuzngjh/principles/issues/new)** — 把本地草稿的 Markdown 复制粘贴到 issue 中。这是推荐的做法。

---

## 如何关闭/回滚已激活的原则

反悔了？没问题。

### 通过 CLI

```bash
# 查看哪些原则已激活
pd activation list

# 禁用其中一个
pd activation disable <id> --reason "改主意了"

# 或者回滚到上一个版本
pd rollback-impl <id> --reason "行为出现退化"
```

### 通过 Console

1. 打开 Console（http://127.0.0.1:3100）
2. 进入 Principles 或 Approvals 页面
3. 找到已激活的原则
4. 点击"禁用"或"回滚"

**效果**：原则立即停止生效。AI 助理恢复到之前的行为。原则保留在历史记录中——以后可以重新启用。

---

## 安装后会发生什么

正常使用你的 AI 助理就行。PD 默认是被动的——它需要先观察模式，然后才会提建议。

当它发现模式时：

1. PD 捕获**痛觉信号**（行为证据）
2. **诊断**这个模式是否值得你关注
3. 在 Console 中**提议**一条原则
4. 你审核后选择三种之一：

| 操作 | 效果 | 什么时候用 |
|------|------|-----------|
| **Prompt** | AI 的上下文中加入软提示 | 默认选择 — 风险低 |
| **RuleHost** | 硬性拦截违规操作 | 软提示不够用时 |
| **Defer** | 跳过，存档以备后需 | 这个模式不值得处理 |

---

## 常见问题

### "插件加载不了"

```bash
cd ~/.openclaw/extensions/principles-disciple
npm install micromatch@^4.0.8 @sinclair/typebox@^0.34.48
openclaw gateway --force
```

### "找不到 `pd` 命令"

`pd` CLI 安装在 `~/.openclaw/bin/`。把以下路径加入 PATH：

```bash
export PATH="$HOME/.openclaw/bin:$PATH"
```

或者用完整路径：`~/.openclaw/bin/pd`

### "AI 不让编辑文件"

检查是不是有 RuleHost 规则在拦截：
```bash
pd activation list
```

### 随时检查健康状态

```bash
pd status
```

---

## 下一站

- **[用户手册](./USER_GUIDE_ZH.md)** — 日常命令和工作流程
- **[配置文档](./configuration/CONFIGURATION.md)** — 环境变量和设置
- **[价值主张](./VALUE_PROPOSITION_ZH.md)** — 更深的愿景
- **[产品定位](./PRODUCT_IDENTITY.md)** — PD 做什么和不做什么
- **[GitHub Issues](https://github.com/csuzngjh/principles/issues)** — 反馈问题、请求功能