# 痛苦信号渐进式上下文加载设计

> **核心理念**: 诊断智能体使用 OpenClaw 内置工具自行获取上下文。

---

## 一、OpenClaw Session 工具真实能力（基于源码调查）

### sessions_list
**参数**: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?(0-20)`
**输出**: `{count, sessions: [{key, kind, label, displayName, sessionId, status, messages?}]}`
**关键**: `messageLimit > 0` 时，每个 session 附带最后 N 条消息（已 strip tool messages）

### sessions_history
**参数**: `sessionKey`(必须), `limit?`, `includeTools?`
**输出**: `{sessionKey, messages: [...], truncated, droppedMessages, contentTruncated, contentRedacted, bytes}`
**关键**: 返回完整消息历史，自动脱敏，截断到 80KB，每条文本最大 4000 字符

### 结论
**两个工具都不支持模糊搜索消息内容。** 诊断智能体需要：
1. `sessions_list(messageLimit=10)` → 获取最近会话+最后10条消息
2. 找到相关 session → `sessions_history(sessionKey, limit=30)` → 获取完整历史
3. **自己扫描消息找相关内容**（LLM 擅长语义理解）

---

## 二、设计方案

### 2.1 HEARTBEAT.md 注入

```markdown
## Evolution Task [ID: {taskId}]
**Pain Score**: {score}
**Source**: {source}
**Reason**: {reason}
**Trigger**: "{trigger_text_preview}"
**Session ID**: {session_id || 'N/A'}
**Agent ID**: {agent_id || 'main'}

## Available Tools for Context Search

1. **sessions_list** — List sessions (searches metadata only, NOT message content)
2. **sessions_history** — Get full message history (requires sessionKey)
3. **read_file / search_file_content** — Search codebase

⚠️ sessions_list.search does NOT search message content.
To find relevant messages, you must:
  a. Use sessions_list to find candidate sessions
  b. Use sessions_history to get their messages  
  c. Analyze the messages yourself for relevance

## Progressive Context Loading SOP

1. **Check basic info** — Do you have enough from the Reason field?
2. **If Session ID known**: 
   → `sessions_history(sessionKey="agent:{agentId}:run:{sessionId}", limit=30)`
3. **If no Session ID**:
   a. `sessions_list(last=10, agentId="main")` to find candidates
   b. `sessions_history(sessionKey=...)` for promising sessions
4. **Search codebase** if reason mentions specific files
5. **Stop when** you have enough evidence for diagnosis

---

## Diagnostician Protocol
...
```

### 2.2 诊断智能体 SKILL.md 更新

Phase 0 改为渐进式上下文获取，包含准确的工具能力说明。

---

## 三、实施计划

| 步骤 | 文件 | 操作 |
|---|---|---|
| 1 | `evolution-worker.ts` | 移除 `extractRecentConversation` 调用 |
| 2 | `pain-context-extractor.ts` | 删除 |
| 3 | `evolution-worker.ts` HEARTBEAT 模板 | 添加准确的工具使用说明 |
| 4 | `pd-diagnostician/SKILL.md` | Phase 0 改为渐进式 |
| 5 | `pain-context-extractor.test.ts` | 删除 |
