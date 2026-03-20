# Principles Disciple 用户指南

> 当前版本重点不是“继续堆机制”，而是让控制面更少、更清楚、更可观察。  
> 现在系统处于 `Phase 1 + Phase 2a + Phase 2b` 完成后的生产观察窗口。

---

## 你现在最需要知道的 4 件事

1. `legacy trust` 还在，但已经冻结。
   现在它主要用于兼容旧逻辑，不再因为普通成功自动上涨。

2. `GFI` 代表短期摩擦和风险。
   当系统不断失败、误解、卡住时，GFI 会升高，Gate 会更谨慎。

3. `rollback` 只回滚情绪误判那一部分。
   现在撤销的是 `user_empathy` 对应的 GFI slice，不会再把整段会话 GFI 一起清掉。

4. `Evolution` 仍然存在，但它是学习面，不是当前唯一控制权来源。

---

## 常用命令

### `/pd-evolution-status`

看当前控制面和进化面的综合状态，包括：

- frozen 的 legacy trust
- 当前 session GFI 和峰值
- 已知 GFI 来源
- pain flag
- gate block / bypass
- evolution queue / directive

如果某些数据还不完全可靠，它会明确显示 `partial` 或 warning，不会假装是 0。

### `/pd-trust`

看 frozen 的 legacy trust 兼容视图。

请注意：

- 这不是未来的 capability 模型
- `tool_success` 和 `subagent_success` 不再自动加 trust
- 它主要用于兼容和解释旧控制面

### `/pd-status empathy`

看情绪/共情事件统计，用来检查：

- `user_empathy` 是否被记录
- `system_infer` 是否被记录
- 当前观察窗口里 empathy 事件是否稳定落日志

### `/pd-rollback last`

撤销最近一次情绪惩罚。

当前行为：

- 只回滚 `user_empathy` 对应的那部分 GFI
- 不再清空整段 session GFI

---

## 什么时候该用这些命令

### AI 明显误解你、让你很烦

先正常指出问题，必要时再看：

- `/pd-status empathy`
- `/pd-rollback last`

### AI 连续失败、像在原地打转

先看：

- `/pd-evolution-status`

重点看：

- GFI 是否升高
- Gate 是否在拦
- 最近 pain signal 是什么

### 你想知道系统现在到底信不信任它

用：

- `/pd-trust`

但要记住：

- 这是 frozen 的 legacy trust，不是未来能力模型

---

## 当前阶段不要误解的地方

### 不是所有旧文档里的 Trust 描述都还有效

如果你看到某些历史文档还写着：

- “成功会持续涨 trust”
- “trust score 决定未来一切”

请以当前命令输出和观察窗口文档为准。

### 现在不该直接进入 Phase 3 主切换

正确顺序是：

1. 先观察生产数据 3 到 7 天
2. 确认 trust freeze、empathy eventing、rollback 行为、summary 可解释性都稳定
3. 再考虑进入 `Capability shadow`
4. 不是立刻切 Gate 主权

---

## 生产观察期重点

每天优先看这几件事：

1. trust 有没有继续偷偷上涨
2. `user_empathy` / `system_infer` 有没有进入 `events.jsonl`
3. rollback 后有没有误伤无关 GFI
4. `evolution_queue.json`、`evolution_directive.json` 和 status 是否一致
5. status 的 warning 是否能真实解释当前数据质量

---

## 一句话总结

现在的 Principles Disciple，更像一个“先把仪表盘修好、再决定怎么换引擎”的系统。  
先看清，再切换；先观察，再进第三阶段。
