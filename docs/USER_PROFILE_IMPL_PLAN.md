# 用户画像闭环实现方案

## 目标
建立一套自动化的用户画像更新与使用机制，实现：
1.  **能力画像**：根据用户指令的质量（Accept/Reject），自动调整用户在各领域（Frontend/Backend...）的可信度分值。
2.  **偏好记忆**：捕捉用户的交流习惯（语言、详略、代码风格）。
3.  **持久生效**：确保这些画像信息在会话压缩、重启后依然能被系统“看见”。

## 架构设计

### 1. 数据结构 (Schema)

**增量凭证 (`docs/.user_verdict.json`)** - *由 LLM 在任务结束时生成*
```json
{
  "updates": [
    { "domain": "frontend", "delta": 1, "reason": "Fix worked" }
  ],
  "preferences": {
    "language": "zh-CN",
    "verbosity": "brief"
  }
}
```

**主数据库 (`docs/USER_PROFILE.json`)** - *由脚本维护的单一事实来源*
```json
{
  "domains": { "frontend": 5, "backend": 0 },
  "preferences": { "language": "zh-CN" },
  "history": [ ...last 10 events... ]
}
```

**上下文投影 (`docs/USER_CONTEXT.md`)** - *挂载到 CLAUDE.md 的只读指令*
```markdown
# User Profile
- Frontend: Proficient (Score: 5)
- Preferences: Use zh-CN.
```

### 2. 实现步骤

#### Step 1: 生产端 - 更新 `/evolve-task` Skill
在 Step 9 (结束阶段) 增加指令，要求 LLM 复盘用户表现，并**强制写入** `.user_verdict.json`。如果用户有明确偏好，也一并写入。

#### Step 2: 处理端 - 更新 `stop_evolution_update.sh` Hook
修改现有的 Stop hook。
- **逻辑**：检查是否存在 `.user_verdict.json`。
- **动作**：
  - 使用 `jq` 将 `delta` 累加到 `USER_PROFILE.json` 的对应分数。
  - 使用 `jq` 将 `preferences` 覆盖更新。
  - 记录日志到 `history` 数组（保留最近 10 条）。
  - 删除 `.user_verdict.json`。

#### Step 3: 消费端 - 增强 `sync_user_context.sh`
修改同步脚本。
- **新增**：读取 `USER_PROFILE.json` 中的 `preferences` 字段。
- **动作**：将其翻译为自然语言指令（如 "User prefers brief answers"），写入 `USER_CONTEXT.md`。

---

## 执行计划

1.  **修改 Skill**: `D:\Code\principles\.claude\skills\evolve-task\SKILL.md`
2.  **修改 Hook**: `D:\Code\principles\.claude\hooks\stop_evolution_update.sh`
3.  **修改 Sync**: `D:\Code\principles\.claude\hooks\sync_user_context.sh`

我将按顺序执行这些修改。
