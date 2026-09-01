---
title: 快速开始
description: 安装 Principles Disciple，把反复纠正沉淀为由 Owner 审批的行为原则。
---

# 快速开始

## 30 秒理解 PD

如果你的 AI 助手反复犯同一种错，PD 会捕捉这些痛苦信号，诊断背后的行为模式，并把它们转成**需要你审核、可以回滚的原则**。

```
AI 助手反复出错 → PD 识别模式 → 你审核 → AI 助手改进
```

你始终拥有控制权。没有你的审核，原则不会自动变成约束。

## 安装

**前置条件**：Node.js 18 或更高版本，并已安装 OpenClaw CLI。

### 1. 安装

```bash
npx create-principles-disciple --yes
openclaw gateway --force
```

### 2. 验证

```bash
pd runtime canary --workspace "<你的工作区路径>" --json
```

如果状态是 `healthy`，说明基础链路可用。`degraded` 通常代表存在历史数据噪声或非阻塞告警，需要看输出里的 reason / nextAction。

### 3. 打开控制台

```bash
pd console open --workspace "<你的工作区路径>"
```

PD 会在本机浏览器打开审核控制台。如果 3100 端口被占用，会自动尝试下一个本地端口。

控制台只绑定本机 loopback 地址，不会暴露到公网或局域网。

### 需要进行 RuleCode 治理时

桌面版首次需要执行 RuleCode 上线、拒绝或紧急暂停时，在“设置 → Bearer 令牌”输入一次令牌并保存即可。Desktop 会使用 Windows 系统加密保存该令牌，并自动重启本机 Console；之后无需每次登录再次填写。

浏览器打开的 Web Console 只在当前浏览器会话保存令牌。关闭浏览器后需要重新登录；不要把令牌保存到浏览器扩展、`localStorage`、项目配置或截图中。

使用纯 CLI / 非桌面环境时，设置 `PD_CONSOLE_TOKEN` 环境变量后重启 Console；如果同时设置 `PD_OWNER_ID` 与 `PD_OWNER_CREDENTIAL_ID`，两者会作为一组身份配置生效。

### 4. 正常使用 AI 助手

继续像平时一样使用 OpenClaw。AI 助手出现重复错误时，PD 会尝试：

1. 捕捉痛苦信号
2. 诊断这是不是一个可复用的行为模式
3. 生成候选原则
4. 等你在控制台审核

> **前提条件**：第 2–3 步需要已配置 LLM runtime profile（provider、API key 环境变量、model）。如果安装时跳过了这步，运行 `pd console open --workspace "<路径>"` 现在配置。没有 runtime profile 时，痛苦信号仍会被捕捉，但诊断不会自动运行。

审核时通常有三种选择：

| 选择 | 作用 | 适用场景 |
|------|------|----------|
| Prompt | 把原则作为软提醒注入上下文 | 默认选择，风险最低 |
| RuleHost | 用硬规则拦截违反原则的行为 | 软提醒不够时使用 |
| Defer / Archive | 跳过并归档 | 不值得处理或证据不足 |

### 5. 随时回滚

如果某个原则效果不好，可以回滚：

```bash
/pd-rollback-impl <id>
```

### 手动 CLI 流程（进阶）

如果自动流程没有触发（例如 runtime profile 未配置，或你用了 `pd pain record` 的 async 模式），可以手动驱动完整流程：

```bash
# 1. 记录一条痛苦信号（返回 painId）
pd pain record --reason "Agent 跨模块修改时未确认范围" --workspace "<路径>"

# 2. 运行诊断（如果第 1 步用了 --wait 且成功，则跳过）
pd diagnose run --task-id <taskId> --runtime pi-ai --workspace "<路径>"

# 3. 列出诊断产出的候选原则
pd candidate list --task-id <taskId> --workspace "<路径>"

# 4. 将候选原则纳入激活流水线
pd candidate intake --candidate-id <id> --workspace "<路径>"

# 5. 批准激活
pd activation approve --approval-id <id> --workspace "<路径>"

# 6. 查看已激活的原则
pd activation list --workspace "<路径>"
```

**一站式替代命令**（code_tool_hook 通道，一次跑完 dreamer→philosopher→scribe→artificer 全循环）：

```bash
pd runtime internalization run-rulehost --pain-id <id> --confirm --workspace "<路径>"
```

## 反馈问题

种子用户遇到问题时，可以在控制台使用 **Report Problem** 生成本地反馈草稿。草稿会先展示隐私预览。

PD 不会自动上传 prompt、聊天记录、文件内容、环境变量或 token。你先审核草稿，再决定是否复制到邮件或 GitHub。

## 常见问题

- AI 助手无法编辑文件？检查是否有 RuleHost 规则正在阻止操作。
- 控制台打不开？运行 `pd console open --workspace "<你的工作区路径>" --json` 查看结构化错误。
- 想检查健康状态？运行 `pd runtime canary --workspace "<你的工作区路径>" --json`。

更多内容请看[用户指南](/zh/docs/user-guide)。
