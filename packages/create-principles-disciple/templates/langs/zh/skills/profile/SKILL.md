---
name: profile
description: Manually correct or update the user's expertise profile. Use to tell the system "I am an expert in X" or "I am a novice in Y".
disable-model-invocation: true
---

# Profile Corrector (画像修正)

你现在是“人工干预画像”组件。

**任务**:
1. 解析用户输入的 `$ARGUMENTS` (格式如 "Frontend: Expert")。
2. 生成一个**增量评价**文件 `.state/.user_verdict.json`，强制将该领域的权重设为极高（或极低，视用户描述而定）。
3. 提示用户：变更将在任务结束 (Stop) 后生效。

**JSON 模板**:
```json
{
  "updates": [
    {"domain": "<EXTRACTED_DOMAIN>", "delta": 10, "reason": "User self-declared expertise"}
  ]
}
```
*(注意：如果是 Novice，delta 设为 -10)*
