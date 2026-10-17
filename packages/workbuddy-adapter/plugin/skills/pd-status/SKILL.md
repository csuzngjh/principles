---
name: pd-status
description: 检查 WorkBuddy 的 Principles Disciple 运行状态、治理开关或诊断 worker 状态。
---

# WorkBuddy PD 状态

使用当前用户固定治理工作区 `~/.workbuddy/pd-workspace`，将 `~` 解析为操作系统用户主目录的绝对路径，再运行：

```text
pd runtime features --workspace "<用户主目录>/.workbuddy/pd-workspace" --json
pd workbuddy worker --status --workspace "<用户主目录>/.workbuddy/pd-workspace" --json
```

报告实际命令结果、`host.workbuddy` 有效开关和 worker 模式；命令失败或安装缺失时如实报告错误，建议通过正式安装器修复。不要初始化项目目录或切换到其他宿主的治理库。

worker 状态不证明当前痛苦已完成诊断，插件存在也不证明技能已加载或原则已生效。核对具体任务应使用真实登记回执中的 ID，在 `pd-review` 指向的同一工作区审阅。
