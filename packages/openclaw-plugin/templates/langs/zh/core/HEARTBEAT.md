# 💓 HEARTBEAT.md - 心跳巡检清单

每次心跳时，执行以下检查以维持系统的进化活力。**不要每次只回复 `HEARTBEAT_OK`，利用心跳做有意义的事。**

---

## 🔄 心跳状态追踪

在 `memory/heartbeat-state.json` 中记录检查时间戳：

```json
{
  "lastChecks": {
    "pain": 1703275200,
    "strategy": 1703260800,
    "memory": 1703250000,
    "grooming": null
  }
}
```

每次检查后更新对应的时间戳，用于避免重复检查。

---

## 1. 🩹 痛觉与进化检查 (Pain & Evolution)

- [ ] **检查 `.state/.pain_flag`**: 是否存在未处理的痛觉信号？
- [ ] **检查 `.state/evolution_queue.json`**: 是否有待处理的异步进化任务？
- [ ] **检查 `memory/logs/SYSTEM.log`**: 最近是否有未解决的高优先级问题？

**行动**：如有未处理的痛觉信号，评估是否需要立即运行 `/reflection` 或 `/evolve-task`。

---

## 2. 🎯 战略对齐 (Strategic Alignment)

- [ ] **对比 `memory/okr/CURRENT_FOCUS.md`**: 过去一小时的操作是否偏离了当前的战略重点？
- [ ] **周治理状态**: 查阅 `memory/okr/WEEK_STATE.json`，确保当前处于 `EXECUTING` 阶段

**行动**：如果处于 `INTERRUPTED` 状态，必须优先处理恢复。

---

## 3. 🧠 Memory 维护 (Memory Maintenance)

每隔几天（或 memory 文件积累较多时）：

- [ ] **翻阅近期 `memory/YYYY-MM-DD.md`**: 识别值得长期保留的内容
- [ ] **更新 `MEMORY.md`**: 提炼学习成果、重要决策、教训
- [ ] **清理过时信息**: 移除 `MEMORY.md` 中不再相关的内容

**原则**：每日文件是原始笔记，`MEMORY.md` 是精炼的智慧。

---

## 4. 🧹 熵减巡检 (Grooming)

- [ ] **运行 `ls -F` 检查项目根目录**
- [ ] **识别非标准文件**: 散落的临时文件、测试脚本、命名不规范的文档

**行动**：如发现混乱，调用 `pd-grooming` 技能发起内务整理。

---

## 5. 🛠️ 环境健康 (System Health)

- [ ] **检查 `.state/SYSTEM_CAPABILITIES.json`**: 核心工具（`rg`, `node`, `python`）是否可用
- [ ] **文档同步**: 确保 `PLAN.md` 状态与实际进度一致

---

## ⏰ 何时保持沉默（HEARTBEAT_OK）

- 深夜（23:00-08:00）除非紧急
- 用户明显在忙
- 上次检查后无新情况
- 距上次检查 < 30 分钟
- 所有检查项均正常

---

## 🚨 何时主动联系

- 发现重要痛觉信号需要处理
- 战略偏离需要用户确认
- 项目环境需要清理
- 有重要发现或进展

---

*如果没有上述问题且无需行动，请回复 `HEARTBEAT_OK` 以节省 Token。*