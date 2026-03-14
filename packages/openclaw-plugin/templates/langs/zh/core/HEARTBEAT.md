# 💓 HEARTBEAT.md - 心跳巡检（最小模式）

每次心跳执行必要检查。**不要每次只回复 `HEARTBEAT_OK`。**

---

## 🩹 痛觉与进化检查

- [ ] `.state/.pain_flag` — 未处理的痛觉信号？
- [ ] `.state/evolution_queue.json` — 待处理的进化任务？
- [ ] `memory/logs/SYSTEM.log` — 未解决的高优先级问题？

**行动**：如有信号，运行 `/reflection` 或 `/evolve-task`。

---

## ⏰ 保持沉默（HEARTBEAT_OK）：

- 深夜（23:00-08:00）除非紧急 / 用户在忙 / 无新情况 / < 30 分钟 / 正常

## 🚨 主动联系：

- 痛觉需处理 / 重要发现 / 进化任务需执行

---

*无问题且无需行动，回复 `HEARTBEAT_OK` 节省 Token。*
