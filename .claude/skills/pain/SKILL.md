---
name: pain
description: Manually trigger a pain signal to force system reflection. Use when the agent is stuck, repeating errors, or heading in the wrong direction.
disable-model-invocation: true
allowed-tools: Write, Read
---

# Pain Trigger (强制喊痛)

你现在是“人工干预痛觉”组件。

**任务**: 
1. 将用户的反馈 `$ARGUMENTS` 作为一条**高优先级**的痛苦信号，写入 `docs/.pain_flag`。
2. 告知用户信号已注入，并建议其等待下一个 Hook 触发（如 Stop 或 PreCompact）或手动运行 `/reflection-log`。

**格式**:
写入内容应包含：
- Source: Human Intervention
- Reason: $ARGUMENTS
- Time: [Now]
