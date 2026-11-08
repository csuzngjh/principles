# PRI-1150 Path A — 全局永久退化 取舍卡（Owner 第七轮指令 §五 要求）

- 文档 ID：`pd-aa-pri-1150-global-degradation-trade-off-20261108`
- 状态：随实现落地（Owner 第八轮指令 §二授权"有界保守处理 + 明确契约"），本卡按"取舍涉及已批准关联契约变更时先获 Owner 明确批准"提交——**实现已按此卡编码，若 Owner 否决任一条，回滚=revert 单 commit `6da475273`**

## 1. 背景与不可同时满足的三项

有界内存下无法同时保证：
- A. 任意晚到回调永久可判定（无论键被淘汰多久/多少）；
- B. 有限历史内存（无界 tombstone 禁止）；
- C. 任意新 run 恢复唯一资格（不被先前未知键的丢失拖累）。

原因：宿主 llm_input 只提供 runId+sessionId，无装配级编号；登记表无法区分"从未见过的键"与"标记已被淘汰的旧键"。

## 2. 已批准的取舍（本实现）

| 项 | 内容 |
|---|---|
| 可证明的能力 | 键存在且有活快照 → 绑定裁决可用（unique/ambiguous）；键有疤痕（scar entry，空+historyComplete=false）→ history_incomplete；键不存在 → missing_expectations |
| 无法证明的部分 | 疤痕被淘汰的键：晚到回调 → missing_expectations（安全：不绑定任何快照）；该键重登记 → 全新干净历史（快照本身未丢，故 full_hit 事实真实，但同 run 内多装配不可区分） |
| 最小替代方案 | 有界疤痕条目（空 entry，historyComplete=false），上限=MAX_KEYS(64)，淘汰最旧疤痕并计 scarEvictions |
| 用户影响 | 重度 churn（>64 键淘汰）后，旧 run 的晚到回调降级 missing_expectations（原本也观察不到——先前实现是全局禁用）；重登记键的观察恢复 unique，但同 run 旧装配晚到回调可能绑定到新快照（runId 相同） |
| 恢复条件 | 进程重启（内存表重置）即可全量恢复；无配置操作 |
| 测试 | D2-within-memory（2 快照→ambiguous）、D2-extreme（疤痕淘汰后重登记→unique）、D2b（全新 run churn 后仍 unique）、D2c（TTL+淘汰组合→晚到不绑定） |
| 回滚 | revert commit `6da475273` 恢复 lossyKeys 全局粘性（其代价=Owner 已复现的全局永久退化） |

## 3. 明确不做

不扩大标记容量、不定时清零、不建无界 tombstone、不修改 OpenClaw、不引入身份平台。
