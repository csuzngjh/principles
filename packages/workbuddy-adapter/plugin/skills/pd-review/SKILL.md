---
name: pd-review
description: 打开 WorkBuddy 的 PD Owner 审阅控制台，查看痛苦、诊断、原则候选或进行 Owner 审批。
---

# WorkBuddy Owner 审阅

将用户主目录解析为绝对路径，然后运行正式 CLI：

```text
pd console open --workspace "<用户主目录>/.workbuddy/pd-workspace"
```

只报告命令实际返回的控制台地址和状态。失败时保留错误原因，不声称已打开。此工作区与 WorkBuddy Hook、worker 使用的治理库相同；当前项目目录不能替代它。

Owner 在控制台审阅证据并决定批准、拒绝或关闭。展示 Owner 原话、模型诊断和已核实证据之间的区别。打开控制台不构成审批或激活，代理不得自动代替 Owner 决策。
