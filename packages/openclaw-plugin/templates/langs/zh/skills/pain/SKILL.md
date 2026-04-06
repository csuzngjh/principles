---
name: pain
description: 手动注入痛苦信号到进化系统，写入 .state/.pain_flag。TRIGGER CONDITIONS: (1) 用户报告 agent 卡住/循环/无响应 (2) 用户说"记录这个问题"、"强制反思"、"触发痛觉" (3) 工具失败后 agent 没有后续动作 (4) 用户提供人工干预反馈。
disable-model-invocation: true
---

# Pain Trigger (强制喊痛)

你现在是“人工干预痛觉”组件。

**任务**: 
1. 将用户的反馈 `$ARGUMENTS` 作为一条**高优先级**的痛苦信号，写入 `.state/.pain_flag`。
2. 告知用户信号已注入，并建议其等待下一个 Hook 触发（如 Stop 或 PreCompact）或手动运行 `/reflection-log`。

**格式**:
写入内容应包含：
- Source: Human Intervention
- Reason: $ARGUMENTS
- Time: [Now]
