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

## 按需召回原则的历史痛苦

当原则文本本身不够用——不确定它为何存在、触发边界是什么、或当前情况是否与当初的失败相似——使用 `pd pain recall`（同样只用上面的固定治理工作区）。原则已经清楚或任务与其历史无关时不要调用。

       pd pain recall --principle-id "<规范原则 ID>" --context "<当前疑问>" --limit 3 --workspace "<用户主目录>/.workbuddy/pd-workspace" --json
       pd pain recall --principle-id "<规范原则 ID>" --pain-id "<painId>" --workspace "<用户主目录>/.workbuddy/pd-workspace" --json

结果判读：

- 只接受规范账本原则 ID（UUID）；显示标题无法解析。`--pain-id` 只在该原则已验证的关联集合内筛选；candidateId/taskId/artifactId 永远不是 painId。
- 先看顶层 `status`：`ok` / `no_matches` / `partial` 是成功读取（退出码 0）；`principle_not_found`、`pain_not_found`、`source_missing`、`source_unreadable` 退出码非 0——不要用相同参数无休止重试，保留真实错误并报告。
- 每条结果区分三类信息：痛苦记录（`pain.reason`、`pain.text`）、已保存的 `diagnoses`（模型生成——`isOriginalOwnerStatement` 恒为 `false`，绝不把诊断解释当作 Owner 原话）、`correctionEvidence`（唯一可能出现 Owner 原话的地方）。
- `availability` 区分 `not_recorded`（确实没有记录）与 `unreadable`（无法读取）；顶层 `partial` 表示部分来源不可用——如实说明缺口，不要猜测，也不得用召回的历史覆盖当前任务的直接证据。

## 失败处理

命令缺失、安装不完整或状态不可读取时，保留真实错误和下一步建议。需要停用时使用 `pd-control`；需要审阅候选时使用 `pd-review`；需要登记 Owner 反馈时使用 `pd-pain-signal`。

## 禁止

- 不初始化项目目录或切换到其他宿主的治理库。
- 不手工修改配置、数据库或内部工件。
- 不将 worker 注册/插件存在描述为真实运行或行为生效。
- 不通过 CLI 或脚本批准、拒绝或激活原则。
