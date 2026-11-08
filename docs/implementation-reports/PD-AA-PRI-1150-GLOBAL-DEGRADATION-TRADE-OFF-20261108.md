# PRI-1150 Path A — 全局永久退化 取舍卡（Owner 第七轮指令 §五 要求）

- 文档 ID：`pd-aa-pri-1150-global-degradation-trade-off-20261108`
- 状态：随实现落地（Owner 第八轮指令 §二授权"有界保守处理 + 明确契约"）。**更正（Owner 第九轮 §一，2026-11-08）**：本卡 v1 中"疤痕被淘汰的键重登记 → 全新干净历史"的陈述已被**取代**——Owner 第九轮 §一判定该放宽未获批准；现行契约见 Path A 设计 v2 §4 与本卡 §2 更正版：capacityExhausted（sticky）后，无 entry 的键（含被淘汰键重登记与全新键）一律 historyComplete=false → history_incomplete，**永不恢复 unique**（进程重启前）。v1 陈述仅作历史保留。
- 本卡按"取舍涉及已批准关联契约变更时先获 Owner 明确批准"提交——**实现已按此卡编码，若 Owner 否决任一条，回滚=revert 单 commit `6da475273`**

## 1. 背景与不可同时满足的三项

有界内存下无法同时保证：
- A. 任意晚到回调永久可判定（无论键被淘汰多久/多少）；
- B. 有限历史内存（无界 tombstone 禁止）；
- C. 任意新 run 恢复唯一资格（不被先前未知键的丢失拖累）。

原因：宿主 llm_input 只提供 runId+sessionId，无装配级编号；登记表无法区分"从未见过的键"与"标记已被淘汰的旧键"。

## 2. 已批准的取舍（本实现，v2 更正版）

| 项 | 内容 |
|---|---|
| 可证明的能力 | 键存在且有活快照 → 绑定裁决可用（unique/ambiguous）；键有疤痕（scar entry，空+historyComplete=false）→ history_incomplete；键不存在 → missing_expectations |
| 无法证明的部分（v2 更正） | **capacityExhausted（sticky）后**：疤痕被淘汰的键重登记 → historyComplete=false → history_incomplete；**全新键也无法自证未经历过淘汰** → 同样 history_incomplete。晚到回调 → missing_expectations（安全：不绑定任何快照）。唯一资格在耗尽后**不恢复**（进程生命周期内） |
| 最小替代方案 | 有界疤痕条目（空 entry，historyComplete=false），上限=MAX_KEYS(64)，淘汰最旧疤痕并计 scarEvictions，同时置 capacityExhausted=true |
| 用户影响（作用域=进程） | 耗尽后**所有新键**（全新或重登记）降级 history_incomplete；耗尽前已连续存在的键保持其既定资格；观察事件（containment facts）仍全部发出，只是绑定裁决降级 |
| 恢复条件 | 进程重启（内存表重置）即可全量恢复；无配置操作 |
| 测试 | D2-within-memory（2 快照→ambiguous）、D2-extreme（疤痕淘汰后重登记与全新键均→history_incomplete）、D2b（耗尽前→unique）、D2c（TTL+淘汰组合→晚到不绑定） |
| 回滚 | revert commit `6da475273` 恢复 lossyKeys 全局粘性（其代价=Owner 已复现的全局永久退化） |

## 3. 明确不做

不扩大标记容量、不定时清零、不建无界 tombstone、不修改 OpenClaw、不引入身份平台。
