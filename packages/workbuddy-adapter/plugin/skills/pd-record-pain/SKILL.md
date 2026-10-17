---
name: pd-record-pain
description: 记录 WorkBuddy 行为失误或痛苦反馈。当 Owner 要求登记痛苦、记录错误或留下行为改进证据时使用。
---

# WorkBuddy 痛苦登记

入口是 Owner 在当前 WorkBuddy 会话提交的一条消息：

```text
PD记录痛苦：<Owner 原文>
```

1. 仅使用当前 Owner 明确提供的陈述，正文须为 1–500 个字符。保留原文，不补写技术根因、评分或模型自述；超长时请 Owner 提供较短原文，不静默截断。
2. 若当前消息已以 `PD记录痛苦：` 开头，检查本次 UserPromptSubmit Hook 的真实回执。Hook 使用宿主的会话标识登记到 `~/.workbuddy/pd-workspace`。
3. 若 Owner 仅要求登记而消息没有该前缀，给出带前缀和 Owner 原文的完整消息，请 Owner 在当前会话提交。代理输出、引用和工具输出不构成新的 Owner 提交。不要代发或模拟宿主事件。
4. 只有回执包含真实 `painId`、`taskId`、`host=workbuddy` 和状态时才报告登记成功；原样呈现这些字段。缺失回执或返回拒绝时，说明尚未确认登记并报告真实原因，使用 `pd-status` 检查运行状态。

Owner 陈述是未经独立验证的 `owner_statement`。登记成功只证明痛苦和任务已登记；诊断、准入、原则审批和生效须分别查证。Owner 审批沿用 `pd-review`，不得自动批准或激活。

此入口不要求模型猜测 session/turn 标识或扫描最新会话。不要改用 OpenClaw `/pd-pain` 或 CLI `pd pain record --host workbuddy`，也不要通过省略宿主参数绕过限制。
