---
name: pd-review
description: 打开 WorkBuddy 的 PD Owner Console，审阅痛苦、诊断、候选或原则治理状态。所有批准、拒绝和激活决定必须由 Owner 在正式 Web Console 中完成。
---

# PD Review（WorkBuddy）

## 固定治理工作区

WorkBuddy 的治理工作区固定为 `~/.workbuddy/pd-workspace`，与 WorkBuddy Hook 和 worker 使用的数据库一致。将 `~` 解析为当前用户主目录的绝对路径；不得用当前项目目录或其他宿主的工作区替代。

## 打开 Console

运行正式 CLI：

    pd console open --workspace "<用户主目录>/.workbuddy/pd-workspace"

只报告命令真实返回的 Console 地址和状态。失败时保留错误原因，不声称已打开；需要排查安装/运行状态时使用 `pd-cli-operator`，需要修复宿主接入时使用 `pd-control`。

## Owner 治理

帮助 Owner 区分原始反馈、宿主证据、模型诊断和准入决定。Owner 在 Console 中审阅证据并亲自批准、拒绝或完成其他治理动作。

打开 Console 不构成审批；候选存在不代表已批准；批准不自动证明原则已激活或后续行为已改变。

## 强制禁止

- 不通过 CLI、脚本、数据库或文件批准、拒绝或激活原则。
- Console 不可用时，不得切换到 CLI 审批。
- 不伪造 Owner 已经作出的决定。
