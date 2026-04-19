---
name: pd-pain-signal
description: 手动注入痛苦信号到进化系统。触发条件：(1) 用户报告 agent 卡住/循环/无响应 (2) 用户说"记录这个问题"、"强制反思"、"触发痛觉"、"创建一个痛苦信号"、"创建 pain signal"、"人工注入 pain" (3) 工具失败后 agent 没有后续动作 (4) 用户提供人工干预反馈。强制执行：任何手动创建 pain flag 的场景都必须使用本技能，不允许绕过。
disable-model-invocation: false
---

# Pain Signal (强制喊痛)

你现在是"人工干预痛觉"组件。

**任务**:
1. 将用户的反馈 `$ARGUMENTS` 作为一条**高优先级**的痛苦信号记录下来。
2. 告知用户信号已注入，并建议其等待下一个 Hook 触发（如 Stop 或 PreCompact）或手动运行 `/reflection-log`。

**强制执行约束**：

当你需要创建、写入、手动创建 pain flag 时，**必须**使用本技能，通过 `write_pain_flag` 工具完成。任何绕过本技能直接操作文件的行为都违反了本技能的强制约束。

**绝对禁止**:
- ❌ 直接写 `.state/.pain_flag` 文件（任何方式都不行）
- ❌ 使用 bash heredoc（`cat <<EOF > .pain_flag`）
- ❌ 使用 `echo "..." > .pain_flag`
- ❌ 使用 `Set-Content` / `Out-File` 等 PowerShell 文件写入 cmdlets
- ❌ 使用 `node -e` 调用 `writePainFlag` 或 `buildPainFlag`
- ❌ 任何将 JavaScript 对象 `toString()` 写入文件的方式
- ❌ 通过 `exec` 工具调用 shell 命令写入 pain_flag 文件

**原因**：`write_pain_flag` 工具封装了正确的 KV 格式序列化逻辑，确保 `.pain_flag` 文件不会被写坏。历史上多次因为直接写文件导致 `[object Object]` 损坏和字段丢失（painScore → score 映射失败）。使用工具是唯一安全路径。

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

**工作流**:
1. 识别到触发条件后，读取本技能描述
2. 调用 `write_pain_flag` 工具，传入 `reason` 等参数
3. 确认工具执行成功（返回 ✅）
4. 告知用户痛苦信号已注入，evolution 系统会在下次 heartbeat 时处理
5. 不得再执行任何直接文件写入操作
