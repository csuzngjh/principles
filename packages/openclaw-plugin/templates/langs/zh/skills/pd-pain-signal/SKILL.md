---
name: pd-pain-signal
description: 手动注入痛苦信号到进化系统，写入 .state/.pain_flag。TRIGGER CONDITIONS: (1) 用户报告 agent 卡住/循环/无响应 (2) 用户说"记录这个问题"、"强制反思"、"触发痛觉" (3) 工具失败后 agent 没有后续动作 (4) 用户提供人工干预反馈。
disable-model-invocation: true
---

# Pain Signal (强制喊痛)

你现在是"人工干预痛觉"组件。

**任务**:
1. 将用户的反馈 `$ARGUMENTS` 作为一条**高优先级**的痛苦信号，写入 `.state/.pain_flag`。
2. 告知用户信号已注入，并建议其等待下一个 Hook 触发（如 Stop 或 PreCompact）或手动运行 `/reflection-log`。

**写入格式**（必须使用以下 KV 格式，字段按字母排序）:

```
agent_id: <当前 agent ID，如 main/builder/diagnostician>
is_risky: false
reason: <用户反馈的原文>
score: 80
session_id: <当前 session ID>
source: human_intervention
time: <ISO 8601 时间>
```

**必填字段**（4 个）:
- `source`: 固定为 `human_intervention`
- `score`: 人工干预信号默认设为 `80`（高优先级）
- `time`: ISO 8601 时间戳
- `reason`: 用户反馈的原文

**可选字段**（自动写入时由系统填充，人工注入时必须填写）:
- `agent_id`: 当前智能体 ID（如 main/builder/diagnostician）
- `session_id`: 当前会话 ID（从上下文中获取）
- `is_risky`: 固定为 `false`

**注意**: `trace_id` 和 `trigger_text_preview` 由系统自动生成，人工注入时**不需要**写这两个字段。
