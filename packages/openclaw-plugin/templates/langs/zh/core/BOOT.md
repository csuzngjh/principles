# BOOT.md - 启动指令

启动时应执行的简短明确指令。

宿主（OpenClaw）已经会加载它所需的工作区指南文件（AGENTS.md、SOUL.md、USER.md、
IDENTITY.md、TOOLS.md、HEARTBEAT.md、memory）。PD 不需要重新读取它们，也不拥有
通用记忆或身份。

---

## 启动检查清单

1. **确认工作空间**：检查当前工作目录是否正确。
2. **PD 审阅队列**：运行 `pd candidate list`，检查是否有等待 Owner 审阅的原则提案。
   - 如有待审提案，**一次性**给出精简摘要 + 审阅决策选项（approve / reject / defer / rollback）。
   - 否则静默继续。

---

## 边界

- **不要**在启动时写入环境快照或运行时状态文件——环境发现是宿主/OpenClaw 自身能力，
  PD 不拥有通用记忆或环境持久化。
- **不要**在 PD 启动流程中读取或管理 `memory/` 文件——那是宿主/OpenClaw 的职责。

---

_此文件可由用户自定义，添加特定的启动任务。_
