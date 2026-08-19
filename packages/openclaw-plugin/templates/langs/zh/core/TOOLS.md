# TOOLS.md - 工具约定

本文件供宿主/OpenClaw 用于本地工具约定。

Principles Disciple 只补充与 PD 自身命令相关的约定。其余一切（编辑器习惯、
搜索偏好、Shell 工作流）由你决定——PD 不预设通用编码行为。

---

## PD 专属命令

- **记录行为证据**：`pd pain record`——对 Owner 相关的行为证据手动触发（不是每次工具失败）。
- **审阅原则提案**：`pd candidate list`——等待 Owner 决策（approve / reject / defer / rollback）。
- **Owner 控制台**：`pd console open`——可视化审阅与回滚控制。
- **RuleHost / code_tool_hook 激活**：通过 `pd` 管理——已批准原则的硬门禁激活通道。

---

_在这里添加你自己的工具约定。_
