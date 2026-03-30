# Principles Disciple Command Reference

> 当前版本重点：EP (Evolution Points) 系统已接替 trust score 成为唯一门控机制。  
> `rollback` 只回滚 `user_empathy` slice，`/pd-evolution-status` 读的是运行时 summary。

---

## 核心命令

| 命令 | 用途 | 当前口径 |
|---|---|---|
| `/pd-evolution-status` | 查看控制面与进化面的当前状态 | 读取 `RuntimeSummaryService` 的 canonical state |
| `/pd-status empathy` | 查看情绪/共情事件统计 | 用于观察 `user_empathy` 与 `system_infer` 事件是否稳定落日志 |
| `/pd-rollback last` | 回滚最近一次情绪惩罚 | 只回滚 `user_empathy` 对应的 GFI slice |
| `/pd-evolve` | 执行进化任务 | 属于学习面，通过 EP 积累提升权限 |
| `/pd-help` | 显示帮助 | |

---

## `/pd-evolution-status`

### 它现在显示什么

- `EP Tier`: 当前 EP 等级 (Seed → Sprout → Sapling → Tree → Forest)
- `Session GFI`: 当前会话 GFI 与峰值
- `GFI Sources`: 当前 summary 能解释出来的 friction 来源
- `Pain Flag`: pain flag 是否激活
- `Gate Events`: 最近的 block / bypass
- `Queue / Directive`: evolution queue 与 directive 的当前状态

### 重要说明

- 这是当前控制面的权威读模型入口。
- 它优先读取 canonical `.state`，并尽量合并 live session / buffered events。
- 如果数据不完整，会显示 `partial` 或 warning，而不是静默显示 `0`。

---

## `/pd-rollback`

### 当前行为

- `/pd-rollback last`
- `/pd-rollback <event-id>`

回滚的是最近一次或指定的 `user_empathy` 事件。

### 重要变化

- 现在只回滚 `user_empathy` 对应的 GFI slice
- 不再把整段 session GFI 一起清空
- 如果事件不存在或来源不匹配，不会误伤其他 friction

---

## EP 等级说明

| 等级 | EP 要求 | 权限 |
|---|---|---|
| Seed | 0 | 只读 + 基础文档 |
| Sprout | 50 | 单文件编辑 |
| Sapling | 200 | 多文件 + 测试 + 子智能体 |
| Tree | 500 | 重构 + 风险路径 |
| Forest | 1000 | 无限制 |

---

## 观察窗口建议

在进入 `Phase 3 capability shadow` 之前，优先每天检查：

1. `user_empathy` / `system_infer` 是否稳定进入 `events.jsonl`
2. rollback 是否只影响 empathy slice
3. `evolution_queue.json`、`evolution_directive.json` 与 status 是否一致
4. summary 是否仍然需要 `partial` 警告才能解释当前状态
5. EP 积累是否正常驱动等级提升
