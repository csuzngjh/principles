# Principle Receipt Effect Evidence Pipeline Investigation (PRI-573)

> 只读调查报告，2026-08-24。未修改任何产品逻辑；发现的唯一代码级缺口已拆分到独立修复 PR。

## 1. Effect 数据来源完整链路（代码实证）

| 来源 kind | 写入点 | 触发条件 | flag 门控 | 状态 |
| --- | --- | --- | --- | --- |
| `prompt_injected` (presence) | `openclaw-plugin/src/hooks/prompt.ts:621` → `recordInjectionPresence` | 每次指令块注入原则后 | `principle_receipt_ledger`（毕业后默认 ON） | ✅ live 活跃（39 行，持续更新至 2026-08-24） |
| `rule_blocked` (effect) | `openclaw-plugin/src/hooks/gate.ts:158` → `recordPrincipleApplication(level=effect)` | RuleHost 决策 = block 且写入成功 | 同上 | ✅ 已接线；flag 开启后尚无 block 事件发生 |
| `auto_correct_applied` (effect) | `gate.ts:322` 附近，仅在 `appliedFields.length > 0` 后写（SPEC 诚实规则：先验证应用再记行） | RuleHost auto_correct 实际应用字段 | 同上 + `trackReceiptAutoCorrect` 计数独立于 ledger flag | ✅ 已接线；无事件 |
| `self_reported` (effect) | prompt.ts 注入 📌 自述行 + llm_output / before_message_write 捕获去重 | Agent 在回复中自述遵循 | **`principle_receipt_self_report` 默认 OFF**（PRI-532，实验性，不在毕业范围） | ⛔ 设计上休眠 |

链路模型：`Presence（注入上下文）→ Intervention（block/auto_correct）→ Reflection（self-report）`，
三级分别对应 ledger 的 presence 行、确定性 effect 行、概率性 effect 行（分列展示）。

## 2. "effect 长期为 0" 的归因（live 数据时间线）

| 时间 | 事件 |
| --- | --- |
| 08-20/08-21 | events jsonl 记录 40 次 `rulehost_blocked`（rule-real-diagnosis-first-v2 等）——但当时 live config 的 ledger flag 尚为 false |
| 08-23 | PRI-555 live apply，ledger/block_copy flag 开启 |
| 08-23 之后 | presence 行继续增长（最新 08-24T00:47Z）；**rulehost_blocked 事件数为 0** |

**结论**：当前 effect=0 是「flag 开启以来没有发生过干预事件」的真实反映，不是管道断裂。
捕获代码路径存在且被测试覆盖（gate-receipt-integration.test.ts 等）。真正的验证要等
第一次真实 block/auto_correct 发生后回收（见 graduation-day0 报告 §5 UNKNOWN）。

## 3. 发现的缺口

### GAP-1（代码级，已修）：block 路径的静默跳过无 rc-9 警告
`gate.ts` 的 rule_blocked 分支：
```ts
const ledgerPrincipleId = hostResult.principleId ?? hostResult.ruleId;
if (ledgerPrincipleId) { /* 写入 */ }
```
`RuleHostResult.ruleId / principleId` 均为可选（rule-host-contracts.ts:72-81）。
当两者皆缺时该分支**静默跳过写入且不产生任何日志**——违反 rc-9（可观测性强制）。
auto_correct 分支有 `String(proposal.ruleId ?? 'unknown')` 兜底，不受影响。
→ 修复：跳过时输出结构化 warn。**独立 PR**（不与 Graduation PR 混合）+ 回归测试。

### GAP-2（语义级，已由 PRI-572 缓解）
effect=0 时 UI 曾把 presence 展示成 effect（headline 无条件宣称"正在影响行为"）。
PRI-572 已改为按 effectCount 门控 + zero-effect 解释文案。

### GAP-3（设计性缺口，非 bug）
`self_reported` 证据源默认关闭（实验性能力），因此 effect 三源中一源默认缺席。
这符合 ADR-0014"不自动开启实验性能力"约束；若 Owner 希望补全证据链，需单独决策开启
（PRI-532 已提供 config 覆盖路径）。

### GAP-4（观测建议，未实施）
`INSERT OR IGNORE` 把唯一索引去重与其他约束失败合并为同一结果，调用方无法区分
"duplicate" 与 "constraint failure"。量级小、影响低，列为后续可选项，不在本任务实施。

## 4. Non-goal 确认

- 未修改任何统计口径、未降低 effect 判定标准、未伪造数据。
- gate_blocks 表（trajectory.db）为 0 与本调查正交：那是另一条 event-log 写入路径的
  历史缺口（此前审计已记录），不属于 receipt effect 链。
