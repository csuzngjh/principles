---
name: pd-cli-operator
description: 检查 WorkBuddy 中 PD 的运行状态、治理开关、worker 活性，或只读查询痛苦、任务和证据链。使用 WorkBuddy 固定治理工作区，不负责登记痛苦、Owner 审阅或启停操作。
---

# PD CLI Operator（WorkBuddy）

## 工作区

始终使用 WorkBuddy 固定治理工作区 `~/.workbuddy/pd-workspace`，先将 `~` 解析为当前用户主目录的绝对路径。不得切换到当前项目目录、Codex 工作区或 OpenClaw 工作区。

## 检查步骤

1. 先运行以下只读命令，确认 Runtime 功能和 worker 状态：

       pd runtime features --workspace "<用户主目录>/.workbuddy/pd-workspace" --json
       pd workbuddy worker --status --workspace "<用户主目录>/.workbuddy/pd-workspace" --json

2. 按需使用 CLI 帮助确认其他只读命令的可用性，再查询痛苦、任务、运行记录、候选或证据链，例如 `pd pain list --workspace "<workspace>" --json`、`pd task show "<taskId>" --workspace "<workspace>" --json`、`pd run show "<runId>" --workspace "<workspace>"`、`pd runtime trace show --pain-id "<painId>" --workspace "<workspace>" --json`。其中 `<workspace>` 必须替换为上面的 WorkBuddy 固定治理工作区，不能换成当前项目目录。
3. 报告真实输出中的 `host.workbuddy` 开关、worker 模式和错误原因。worker 已注册不等于 worker 正在运行；插件存在不等于技能已加载；健康检查通过不等于某条痛苦已经完成诊断。
4. 追踪具体问题时使用登记回执中的真实 ID，逐段核实登记、诊断、候选准入和治理状态。

## 失败处理

命令缺失、安装不完整或状态不可读取时，保留真实错误和下一步建议。需要停用时使用 `pd-control`；需要审阅候选时使用 `pd-review`；需要登记 Owner 反馈时使用 `pd-pain-signal`。

## 禁止

- 不初始化项目目录或切换到其他宿主的治理库。
- 不手工修改配置、数据库或内部工件。
- 不将 worker 注册/插件存在描述为真实运行或行为生效。
- 不通过 CLI 或脚本批准、拒绝或激活原则。
