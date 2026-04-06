# 痛苦信号双通路上下文加载设计

> **核心理念**: 诊断智能体使用 OpenClaw 内置工具优先，JSONL 直接读取作为备份降级路径。

---

## 一、为什么需要双通路？

### OpenClaw 内置工具的局限性

根据代码调研，诊断代理通过 HEARTBEAT 在**主会话 LLM** 中运行，使用 `tree` 可见性模式：

```typescript
// 默认配置
tools.sessions.visibility = "tree";  // 只能看到自己 + 衍生的子 sessions
```

**关键问题**: 如果 pain 信号来自**其他 agent 的 session**（如 builder session），内置工具可能看不到！

### 两种方案对比

| 维度 | OpenClaw 内置工具 (P1) | JSONL 直接读取 (P2) |
|------|------------------------|---------------------|
| **可见性** | 受 tree 模式限制 | 无限制，知道路径就能读 |
| **数据安全** | 自动脱敏、截断到 80KB | 原始内容（可控制） |
| **可靠性** | 依赖工具注册和 gateway | 直接读文件，更稳定 |
| **适用场景** | pain 发生在当前 session 树内 | pain 发生在其他 session |

**结论**: 两种方案**互补**，不是互斥！

---

## 二、双通路策略

### Phase 0 执行流程

```
P1: sessions_history 工具
  ↓ 失败（可见性限制/工具不可用）
P2: JSONL 直接读取
  ↓ 失败（文件不存在/不可读）
P3: task 内嵌上下文
  ↓ 不存在
P4: 推断诊断（Phase 1 增强）
```

### 输出字段

```json
{
  "phase": "context_extraction",
  "session_id": "xxx或null",
  "agent_id": "main",
  "context_source": "sessions_history|jsonl|task_embedded|inferred",
  "jsonl_available": true,
  "conversation_summary": "..."
}
```

---

## 三、HEARTBEAT.md 注入内容

```markdown
## Evolution Task [ID: {taskId}]
**Pain Score**: {score}
**Source**: {source}
**Reason**: {reason}
**Session ID**: {session_id || 'N/A'}
**Agent ID**: {agent_id || 'main'}

## Available Tools for Context Search (P1 - Preferred)
1. **sessions_history** — Get full message history (requires sessionKey)
2. **sessions_list** — List sessions (metadata only)
3. **read_file / search_file_content** — Search codebase

**P1 SOP**: sessions_history(sessionKey="agent:{agentId}:run:{sessionId}", limit=30)

## Pre-extracted Context (P2 - JSONL Fallback)
If OpenClaw tools cannot access the session (visibility limits),
use this pre-extracted context below:

[预提取的 JSONL 上下文]
```

---

## 四、实施文件

| 文件 | 角色 |
|------|------|
| `pain-context-extractor.ts` | P2 实现（JSONL 读取） |
| `evolution-worker.ts` | 注入工具说明 + 预提取上下文 |
| `pd-diagnostician/SKILL.md` | Phase 0 双通路协议 |
