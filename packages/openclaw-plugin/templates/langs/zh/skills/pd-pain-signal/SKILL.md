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

**写入格式**（必须使用以下 KV 格式，与自动检测渠道保持一致）:

```
agent_id: <当前 agent ID，如 main/builder/diagnostician>
is_risky: false
reason: <用户反馈的原文>
score: 80
session_id: <当前 session ID>
source: human_intervention
time: <ISO 8601 时间>
trace_id:
trigger_text_preview:
```

**字段说明**:
- `source`: 固定为 `human_intervention`
- `score`: 人工干预信号默认设为 `80`（高优先级）
- `session_id`: 当前会话 ID（从上下文中获取）
- `agent_id`: 当前智能体 ID（从上下文中获取）
- `is_risky`: 固定为 `false`
- `trace_id` / `trigger_text_preview`: 留空即可

**⚠️ 注意**: 不要使用其他格式（如只写 Source/Reason/Time 三行），下游诊断系统依赖完整的 KV 字段。
