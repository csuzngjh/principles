---
title: 用户指南
description: Principles Disciple MVP 功能、命令和工作流的完整参考。
---

# 用户指南

本指南涵盖使用 Principles Disciple（PD）所需的一切。PD 是一个面向 AI 智能体的行为内化系统——它帮助你的智能体从反复犯的错误中学习，把这些教训转化为经过审核、可回滚的行为原则。

## PD 是怎么工作的

PD 遵循一个简单的闭环：

```
智能体犯错（痛觉信号）
       ↓
PD 诊断出行为模式（诊断）
       ↓
PD 提出原则候选（候选）
       ↓
你审核并决定（审核）
       ↓
PD 激活原则（激活）
       ↓
智能体下次表现更好（观察）
```

你始终掌控全局。没有你的审核，任何原则都不会生效。

## 核心概念

### 痛觉信号（Pain Signal）

**痛觉信号**是"出了问题"的结构化证据。它不是惩罚——它是数据。痛觉信号来自：

- 工具失败（例如，一个命令反复报错）
- 用户纠正（例如，"不要这样做"）
- 编辑被拦截（例如，工作区门禁阻止了一次危险修改）
- 危险接近（例如，差点覆盖了重要文件）

### 原则（Principle）

**原则**是一条高度抽象、跨场景的指导方针。它回答"智能体为什么要改变行为？"和"应该朝什么方向改变？"

原则的生命周期：

| 状态 | 含义 |
|------|------|
| `candidate` | 新提出，尚未审核 |
| `probation` | 试用中 / 影子模式 |
| `active` | 正式生效 |
| `archived` | 保留历史记录，不再生效 |

### 规则（Rule）

**规则**是从原则推导出的硬性、可测试的契约。它回答"什么时候适用？"和"智能体应该怎么响应？"

### 实现（Implementation）

**实现**是承载规则的具体代码或提示词。它是真正改变智能体行为的东西。

### 激活通道

当你批准一个原则时，你需要选择它如何生效：

| 通道 | 强度 | 会发生什么 | 需要你审批吗？ |
|------|------|-----------|--------------|
| **Prompt** | 软 | 在智能体的上下文中注入一段提醒 | 不需要（自动） |
| **RuleHost** | 硬 | 代码钩子会阻止或警告违规操作 | 需要（必须审批） |
| **Defer / Archive** | 无 | 刻意跳过激活，归档候选 | 不需要（自动） |

通用策略：**先软后硬，逐步升级。**

## 工作区安全门禁

PD 使用 RuleHost — 一套 owner 管控的动态规则系统 — 来执行行为原则。当 owner 批准的原则阻止了工具调用时，智能体会收到如何继续的指导。

### 工作原理

RuleHost 会对每个变更工具调用进行已激活规则的评估：

- 如果规则匹配并阻止 → 智能体会收到解释和指导
- 如果没有规则阻止 → 操作正常进行
- 规则通过 MVP 通道激活：prompt 注入、code_tool_hook 和 defer_archive

### 计划引导

对复杂任务，建议智能体先描述计划并获得 owner 确认后再做大幅修改。这是行为建议，不是内置门禁。如果 owner 想要强制"先计划后执行"，可以通过标准内化流程激活一条 RuleHost 规则。
4. 重试操作

### 配置风险路径

编辑工作区的 `docs/PROFILE.json`：

```json
{
  "progressive_gate": {
    "enabled": true,
    "plan_approvals": {
      "enabled": true,
      "allowed_patterns": ["docs/**", "skills/**"],
      "allowed_operations": ["write", "edit"]
    }
  }
}
```

## 斜杠命令

PD 通过斜杠命令与 OpenClaw 集成。以下是 MVP 命令：

### 初始化

| 命令 | 缩写 | 说明 |
|------|------|------|
| `/pd-init` | `/pdi` | 初始化工作区 |
| `/pd-bootstrap` | `/pdb` | 扫描环境工具 |
| `/pd-research` | `/pdr` | 研究工具和能力 |
| `/pd-help` | `/pdh` | 显示命令参考 |

### 痛觉与监控

| 命令 | 说明 |
|------|------|
| `/pd-pain` | 从当前会话报告痛觉信号 |
| `/pd-status` | 查看系统健康状态、钩子状态和错误率 |
| `/pd-evolution-status` | 查看原则演化状态 |

### 原则管理

| 命令 | 说明 |
|------|------|
| `/pd-promote-impl list` | 列出所有实现候选 |
| `/pd-promote-impl eval <id>` | 评估指定候选 |
| `/pd-promote-impl show <id>` | 查看候选详情 |
| `/pd-promote-impl <id>` | 将候选晋升为激活状态 |
| `/pd-disable-impl <id>` | 禁用一个激活的实现 |
| `/pd-rollback-impl <id>` | 回滚到之前的状态 |
| `/pd-archive-impl <id>` | 归档一个实现 |
| `/pd-principle-rollback` | 将原则回滚到试用状态 |

## PD 命令行工具

`pd` 命令行工具提供了 OpenClaw 会话之外的额外功能。

### 记录痛觉信号

```bash
pd pain record --reason "编辑文件前没有先阅读" --score 75
```

选项：
- `--reason, -r` — 痛觉原因（必填）
- `--score, -s` — 痛觉严重程度，0–100（默认：80）
- `--session-id` — 会话 ID（默认：自动生成）

### 健康检查（Canary）

```bash
pd runtime canary --workspace "<路径>" --json
```

Canary 运行 7 项检查，报告三种状态之一：

| 状态 | 含义 |
|------|------|
| `healthy` | 所有检查通过 |
| `degraded` | 发现非关键问题（孤立候选、队列阻塞等） |
| `error` | Schema 失败或异常——需要调查后再继续 |

### 启动控制台

```bash
pd console --workspace "<路径>" --no-auth
```

在浏览器中打开 [http://127.0.0.1:3100](http://127.0.0.1:3100)。

::: warning
控制台默认绑定到 `127.0.0.1`（仅本机回环），其他机器无法访问。如果需要网络访问，请使用 `--host <ip>` 配合 `--token <密钥>`。
:::

## 审核控制台

本地控制台是你观察 PD 活动的主要窗口。

### 你能看到什么

- **痛觉趋势** — 智能体遇到问题的频率如何？
- **原则候选** — 有哪些新原则被提出？
- **激活的原则** — 当前有什么在指导或约束智能体？
- **审批队列** — 有什么在等待你的决定？
- **演化事件** — 所有原则生命周期变更的时间线

### 审核原则候选

1. 打开控制台
2. 进入 **原则** 页面
3. 选择一个候选进行审核
4. 阅读痛觉证据和提议的原则文本
5. 选择激活通道：
   - **Prompt** — 软性引导，适合首次尝试
   - **RuleHost** — 硬性拦截，软引导不够时使用
   - **Defer / Archive** — 暂时跳过这个候选

### 回滚

如果激活的原则导致了问题：

```bash
/pd-rollback-impl <id>
```

这会恢复到之前的状态。你也可以只禁用而不回滚：

```bash
/pd-disable-impl <id>
```

## 配置

### 工作区配置

PD 需要知道你的智能体工作区在哪里。这通常在安装时设置，但你也可以手动配置。

**方式一：配置文件**（推荐）

创建 `~/.openclaw/principles-disciple.json`：

```json
{
  "workspace": "/path/to/your/workspace",
  "state": "/path/to/your/workspace/.state",
  "debug": false
}
```

**方式二：环境变量**

```bash
export PD_WORKSPACE_DIR=/path/to/your/workspace
export PD_STATE_DIR=/path/to/your/workspace/.state
```

**配置优先级**（从高到低）：

1. 环境变量（`PD_WORKSPACE_DIR`、`PD_STATE_DIR`）
2. 配置文件（`~/.openclaw/principles-disciple.json`）
3. OpenClaw 环境（`OPENCLAW_WORKSPACE`）
4. 默认值（`~/.openclaw/workspace`）

### 插件配置

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `language` | `zh` | 交互语言（`en` 或 `zh`） |
| `auditLevel` | `medium` | 安全门禁级别（`low`、`medium`、`high`） |
| `riskPaths` | `[]` | 需要显式授权的高风险目录 |

## 常见问题

### 插件加载失败

**错误**：`Cannot find module 'micromatch'`

**解决**：
```bash
cd ~/.openclaw/extensions/principles-disciple
npm install micromatch@^4.0.8 @sinclair/typebox@^0.34.48
```

### 更新后插件仍显示旧版本

**解决**：
```bash
rm -rf ~/.openclaw/extensions/principles-disciple
cd /path/to/principles
./packages/openclaw-plugin/scripts/install.sh
```

### 配置错误

**错误**：`Invalid config: plugin not found: principles-disciple`

**解决**：
```bash
openclaw doctor --fix
./packages/openclaw-plugin/scripts/install.sh
```

### 日志在哪里

默认位置：`~/.openclaw/workspace/memory/.state/logs/`

| 文件 | 内容 |
|------|------|
| `events.jsonl` | 结构化事件日志（工具调用、痛觉信号、门禁拦截、演化任务） |
| `plugin.log` | 运行时插件日志 |
| `daily-stats.json` | 每日统计汇总 |

## PD 不是什么

为了明确期望：

- PD **不是**任务执行引擎
- PD **不是**通用记忆系统或外接大脑
- PD **不是**通用工具调用或输出格式修复工具
- PD **不是** LangChain 式应用构建器
- PD **不是** SaaS 产品或聊天机器人
- PD **不是**一键自动变强的魔法按钮

PD 是 OpenClaw 编程智能体的**行为内化层**。它帮助你的智能体从痛觉中学习——而你始终在环。
