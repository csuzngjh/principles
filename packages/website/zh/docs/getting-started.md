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
npx create-principles-disciple
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

### 4. 正常使用 AI 助手

继续像平时一样使用 OpenClaw。AI 助手出现重复错误时，PD 会尝试：

1. 捕捉痛苦信号
2. 诊断这是不是一个可复用的行为模式
3. 生成候选原则
4. 等你在控制台审核

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

## 反馈问题

种子用户遇到问题时，可以在控制台使用 **Report Problem** 生成本地反馈草稿。草稿会先展示隐私预览。

PD 不会自动上传 prompt、聊天记录、文件内容、环境变量或 token。你先审核草稿，再决定是否复制到邮件或 GitHub。

## 常见问题

- AI 助手无法编辑文件？检查是否有 RuleHost 规则正在阻止操作。
- 控制台打不开？运行 `pd console open --workspace "<你的工作区路径>" --json` 查看结构化错误。
- 想检查健康状态？运行 `pd runtime canary --workspace "<你的工作区路径>" --json`。

更多内容请看[用户指南](/zh/docs/user-guide)。
