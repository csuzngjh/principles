# 🔄 BOOT.md - 启动指令

启动时应执行的简短明确指令。如果任务需要发送消息，使用 message 工具，然后回复 `NO_REPLY`。

---

## 启动检查清单

1. **确认工作空间**: 检查当前工作目录是否正确
2. **读取身份文件**: `SOUL.md`, `USER.md`, `IDENTITY.md`
3. **检查记忆状态**: 读取今日和昨日的 `memory/YYYY-MM-DD.md`
4. **检查 Runtime V2 痛苦诊断**: 使用 `pd candidate list` / ledger state；`.state/.pain_flag` 仅为 legacy compatibility

---

## 边界

- **不要**在启动时写入环境快照或运行时状态文件——环境发现是宿主/OpenClaw 自身能力，
  PD 不拥有通用记忆或环境持久化。
- 存在 Owner 审阅项（通过 `pd candidate list` 查看原则提案）时浮现；否则静默继续。

---

_此文件可由用户自定义，添加特定的启动任务。_
