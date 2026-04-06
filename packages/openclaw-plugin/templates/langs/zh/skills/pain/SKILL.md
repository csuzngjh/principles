---
name: pain
description: >
  手动注入痛苦信号到进化系统，写入 .state/.pain_flag。
  当用户报告 agent 卡住、重复犯错、方向跑偏、长时间无响应，或要求手动触发系统反思时使用。
  触发场景：用户说"你卡住了"、"又在循环了"、"方向不对"、"怎么没反应"、"强制反思"、"记录这个问题"、
  或提供人工干预反馈。这是可执行技能 — 收到触发立即写入 pain flag，不要说"没有这个技能"或去找别的技能列表。
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
