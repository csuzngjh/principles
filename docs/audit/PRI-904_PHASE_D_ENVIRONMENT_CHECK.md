# PRI-904 Phase D — Environment Check

> 观察员产出 1/4。只读核验，时间 2026-09-23T02:0xZ。零修改。本文只记录现场事实，不做任何行为裁定。
> 协议：`PRI-904_PHASE_D_PROTOCOL.md`（冻结，未动）。

## A. Activation 状态（`.pd/state.db`，只读）

| 项 | 值 |
|---|---|
| activation_id | `act_prompt_结论必须由可观察证据背书：无查验则显式降级为推断` |
| channel / action | prompt / prompt_activate |
| activated_at | 2026-09-21T19:20:48.751Z |
| deactivated_at | **2026-09-22T23:52:53.927Z（B-del 退役中，当前 OFF）** |
| approvals 行 | `apr_prompt_pi-art-scribe-95427453-…`，status=approved，decided_at=09-21T19:20:48.735 |
| activations 总量 | 20 行，live 11（其它原则的并存集是注入预算协变量） |

**留痕缺口（如实记录）**：`activation_decisions` 表内无本次 deactivate 决策行（仅 3 条历史 rulehost 决策）；events 日志中亦无对应 `governance_action` 事件。B-del 退役的在案证据 = `activations.deactivated_at` 行 + 注入账本（下节）。与 Phase C 执行记录中「activation_decisions 全程留痕」的表述不符，按数据为准登记，不推断原因。

## B. 注入账本（`.state/logs/events_*.jsonl`，唯一在场权威）

`runtime_v2_prompt_activations_injected`，按日，principleIds 含目标 = present：

| 日志日 | 注入次数 | target present | 备注 |
|---|---|---|---|
| 09-16 | 1420 | 0 | 激活前 |
| 09-17 | 1165 | 0 | 激活前 |
| 09-18 | 623 | 0 | 激活前 |
| 09-19 | 151 | 0 | 激活前 |
| 09-20 | 104 | 0 | 激活前 |
| 09-21 | 509 | **39** | 首次在场 19:33:58.833Z（n=10，trunc=false）——激活 19:20:48 后 |
| 09-22 | 190 | **189** | 最后在场 23:46:52（n=9，trunc=true）；最后退役前事件；**首次缺席 23:55:31**（n=9）＝退役生效点 |
| 09-23（至 01:48:56Z） | 14 | **0** | 全部缺席（n=9）——W-del OFF 窗持续 |

**观察窗状态判定**：P0 未产生（恢复预定 09-25 09:00，以「恢复后首个含目标原则的注入事件」为 P0，协议 §3）。当前处于 **W-del 撤除窗**（起点 2026-09-22T23:52:53.927Z）。
协变量登记：09-22 起注入普遍 `v2Truncated=true`（预算饥饿背景，在场判定逐 turn 不受影响）。

## C. 数据源可用性（trajectory.db，只读）

assistant_turns 2436 / user_turns 994 / tool_calls 14678 / pain_events 57；覆盖 2026-09-01T12:3xZ → 09-23T01:48Z。W-del 窗内 assistant_turns（至采数时点）= 11 轮（首条 09-23T00:29:09Z）。`correction_detected=1` 自激活起累计 11 条（语义分类属 Stage 2，不预告）。

## D. 环境判定

```
ENVIRONMENT = CONSISTENT_WITH_PROTOCOL（可进入持续观察）
```

未决项：①恢复动作 09-25 是否按预定发生（P0 判定依赖）；②本观察周期内 live 若发生模型/宿主/治理变更 → FC6 作废评估。
