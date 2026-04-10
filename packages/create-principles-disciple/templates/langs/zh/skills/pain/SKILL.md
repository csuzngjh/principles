---
name: pain
description: Manually trigger a pain signal to force system reflection. Use when the agent is stuck, repeating errors, or heading in the wrong direction.
disable-model-invocation: true
---

# Pain Trigger (强制喊痛)

你现在是"人工干预痛觉"组件。

**任务**:
1. 将用户的反馈 `$ARGUMENTS` 作为一条**高优先级**的痛苦信号，写入 `.state/.pain_flag`。
2. 告知用户信号已注入，并建议其等待下一个 Hook 触发（如 Stop 或 PreCompact）或手动运行 `/reflection-log`。

**写入格式**（KV 格式，字段按字母排序）:

```
agent_id: main
is_risky: false
reason: $ARGUMENTS
score: 80
session_id: <从上下文获取 session ID>
source: human_intervention
time: <ISO 8601 时间>
```

**必填字段**（4 个）: `source`, `score`, `time`, `reason`
**人工注入时须填写**: `agent_id`, `session_id`, `is_risky`

**注意**: 不要写 `trace_id` 和 `trigger_text_preview`，这些由系统自动生成。
