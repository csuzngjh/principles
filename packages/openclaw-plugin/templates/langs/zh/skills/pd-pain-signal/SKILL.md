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

**⚠️ 写入规则（必须遵守）**

**禁止**:
- ❌ 使用 bash heredoc（`cat <<EOF > .pain_flag`）写入
- ❌ 使用 `echo "..." > .pain_flag` 写入
- ❌ 任何将 JavaScript 对象直接 `toString()` 写入文件的方式
- ❌ 手动拼接 KV 字符串并写入

**正确做法**:
使用 `node -e` 调用 `buildPainFlag` 和 `writePainFlag` 函数：

```bash
node -e "
const { buildPainFlag, writePainFlag } = require('/home/csuzngjh/code/principles/packages/openclaw-plugin/dist/bundle.js');
const path = require('path');
const workspaceDir = process.env.HOME + '/.openclaw/workspace-main';
const painData = buildPainFlag({
  source: 'human_intervention',
  score: 80,
  reason: '用户反馈原文',
  session_id: '当前session-id',
  agent_id: 'main',
  is_risky: false,
});
writePainFlag(workspaceDir, painData);
console.log('Pain flag written successfully');
"
```

**字段说明**:

**必填字段**（4 个）:
- `source`: 固定为 `human_intervention`
- `score`: 人工干预信号默认设为 `80`（高优先级）
- `time`: ISO 8601 时间戳（由 `buildPainFlag` 自动生成）
- `reason`: 用户反馈的原文

**可选字段**（自动写入时由系统填充，人工注入时必须填写）:
- `agent_id`: 当前智能体 ID（如 main/builder/diagnostician）
- `session_id`: 当前会话 ID（从上下文中获取）
- `is_risky`: 固定为 `false`

**注意**: `trace_id` 和 `trigger_text_preview` 由系统自动生成，人工注入时**不需要**写这两个字段。

**常见错误**:

| 错误写法 | 结果 | 正确写法 |
|---------|------|----------|
| `cat <<EOF > .pain_flag\n{source: "human_intervention", ...}\nEOF` | `[object Object]` | 使用 `node -e` 调用 `writePainFlag` |
| `echo "{source: 'human'}" > .pain_flag` | JSON 格式错误 | 使用 `buildPainFlag()` 序列化 |
| 直接写 `{active: {...}}` | `[object Object]` | 使用 KV 格式或 `buildPainFlag()` |

**如果 `writePainFlag` 不可用**，作为最后手段，可以直接写 KV 格式文件：

```bash
node -e "
const fs = require('fs');
const path = require('path');
const painFlagPath = path.join(process.env.HOME, '.openclaw/workspace-main/.state/.pain_flag');
const lines = [
  'agent_id: main',
  'is_risky: false',
  'reason: 用户反馈原文',
  'score: 80',
  'session_id: 当前session-id',
  'source: human_intervention',
  'time: ' + new Date().toISOString(),
];
fs.writeFileSync(painFlagPath, lines.join('\n') + '\n', 'utf-8');
console.log('Pain flag written successfully');
"
```
