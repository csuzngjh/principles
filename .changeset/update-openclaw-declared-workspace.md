---
"create-principles-disciple": patch
---

更新安装改为写入 OpenClaw 声明固定的工作区（`~/.openclaw/principles-disciple.json` 的 `workspace`），而非发起方 Console 当前绑定的工作区。修复三宿主工作区拆分后、Console 绑定到其他宿主工作区（如 Codex pd-workspace）时，apply 透传错误 workspaceDir 触发声明冲突拒绝、更新必败的问题。
