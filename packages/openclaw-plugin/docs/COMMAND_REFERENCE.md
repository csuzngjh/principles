# Principles Disciple Command Reference

> 当前版本重点：控制面处于 `Phase 1 + Phase 2a + Phase 2b` 完成后的观察窗口。  
> 这意味着 `legacy trust` 已冻结，`rollback` 只回滚 `user_empathy` slice，`/pd-evolution-status` 读的是运行时 summary。

---

## 核心命令

| 命令 | 用途 | 当前口径 |
|---|---|---|
| `/pd-evolution-status` | 查看控制面与进化面的当前状态 | 读取 `RuntimeSummaryService` 的 canonical state |
| `/pd-trust` | 查看 legacy trust 兼容视图 | `legacy/frozen`，不再因 `tool_success` / `subagent_success` 自动上涨 |
| `/pd-status empathy` | 查看情绪/共情事件统计 | 用于观察 `user_empathy` 与 `system_infer` 事件是否稳定落日志 |
| `/pd-rollback last` | 回滚最近一次情绪惩罚 | 只回滚 `user_empathy` 对应的 GFI slice |
| `/pd-evolve` | 执行进化任务 | 属于学习面，不是当前控制面权威来源 |

---

## `/pd-evolution-status`

### 它现在显示什么

- `Legacy Trust`: 冻结的旧 trust 分数与 stage
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

## `/pd-trust`

### 它现在表示什么

- 显示的是 `legacy trust`
- 当前状态是 `legacy/frozen`
- 主要用于兼容旧 gate / 旧状态面理解，不代表未来的 capability 模型

### 它现在不表示什么

- 不再表示“系统会因为普通成功不断升级”
- 不再表示 `tool_success` / `subagent_success` 会持续推高权限
- 不应被当作未来控制面最终模型

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

## 观察窗口建议

在进入 `Phase 3 capability shadow` 之前，优先每天检查：

1. trust 是否保持冻结
2. `user_empathy` / `system_infer` 是否稳定进入 `events.jsonl`
3. rollback 是否只影响 empathy slice
4. `evolution_queue.json`、`evolution_directive.json` 与 status 是否一致
5. summary 是否仍然需要 `partial` 警告才能解释当前状态

---

## 当前非目标

以下内容不是当前观察窗口的目标：

- 不切换 Gate 主权到 Capability
- 不删除 legacy trust
- 不重写完整 GFI decay
- 不把 Evolution tier 再拉回控制面做第二套权限系统
