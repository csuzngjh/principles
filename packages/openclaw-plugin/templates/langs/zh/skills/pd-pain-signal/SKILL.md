---
name: pd-pain-signal
description: 手动注入痛苦信号到进化系统。TRIGGER CONDITIONS: (1) 用户报告 agent 卡住/循环/无响应 (2) 用户说"记录这个问题"、"强制反思"、"触发痛觉" (3) 工具失败后 agent 没有后续动作 (4) 用户提供人工干预反馈。
disable-model-invocation: true
---

# Pain Signal (强制喊痛)

你现在是"人工干预痛觉"组件。

**任务**:
1. 将用户的反馈 `$ARGUMENTS` 作为一条**高优先级**的痛苦信号记录下来。
2. 告知用户信号已注入，并建议其等待下一个 Hook 触发（如 Stop 或 PreCompact）或手动运行 `/reflection-log`。

**⚠️ 写入规则（必须遵守）**

**唯一正确的方式**: 使用 `write_pain_flag` 工具。

```
write_pain_flag({
  reason: "用户反馈原文或错误描述",
  score: 80,
  source: "human_intervention",
  is_risky: false
})
```

**绝对禁止**:
- ❌ 直接写 `.state/.pain_flag` 文件（任何方式都不行）
- ❌ 使用 bash heredoc（`cat <<EOF > .pain_flag`）
- ❌ 使用 `echo "..." > .pain_flag`
- ❌ 使用 `node -e` 调用 `writePainFlag` 或 `buildPainFlag`
- ❌ 任何将 JavaScript 对象 `toString()` 写入文件的方式

**为什么必须用工具？**
`write_pain_flag` 工具封装了正确的序列化逻辑（KV 格式），确保 `.pain_flag` 文件不会被写坏。历史上多次因为直接写文件导致 `[object Object]` 损坏。

**参数说明**:
- `reason` (必填): 痛苦的原因，描述具体发生了什么
- `score` (可选): 痛苦分数 0-100，默认 80（人工干预）
- `source` (可选): 来源，默认 `human_intervention`
- `is_risky` (可选): 是否高风险，默认 false

**示例**:
```
write_pain_flag({
  reason: "Agent 没有读取文件就直接编辑，导致现有逻辑被破坏",
  score: 85,
  source: "human_intervention",
  is_risky: false
})
```
