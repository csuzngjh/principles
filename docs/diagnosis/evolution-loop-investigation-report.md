# Principles Disciple 进化闭环调查报告

> **调查时间**: 2026-03-17
> **调查者**: iFlow CLI
> **目的**: 梳理进化系统的完整链路，识别断点和问题
> **状态**: ✅ **已完成** (调查结果已用于修复进化闭环)

---

## 一、调查背景

用户困惑："当前的系统太复杂了，我理不清楚整个的进化系统的起点和终点到底是在哪里，我怎么知道当前的原则进化是在正常工作的。"

---

## 二、设计意图：完整的进化闭环

根据代码和 SKILL 文件分析，进化系统的**设计意图**如下：

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            完整的进化闭环（设计意图）                              │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌──────────────┐                                                              │
│  │ 1. Pain 触发 │ ← Tool 失败 / 手动触发 / 子智能体失败                          │
│  └──────┬───────┘                                                              │
│         │                                                                       │
│         ▼                                                                       │
│  ┌──────────────┐                                                              │
│  │ 2. 诊断      │ → docs/diagnosis/*.md (存档)                                 │
│  │    子智能体   │                                                              │
│  └──────┬───────┘                                                              │
│         │                                                                       │
│         ▼                                                                       │
│  ┌──────────────┐     ┌─────────────────────────────────────┐                  │
│  │ 3. 落盘      │ ──→ │ memory/ISSUE_LOG.md                  │                  │
│  │    (SKILL)   │     │ memory/DECISIONS.md                  │                  │
│  └──────┬───────┘     └─────────────────────────────────────┘                  │
│         │                                                                       │
│         ▼                                                                       │
│  ┌──────────────┐     ┌─────────────────────────────────────┐                  │
│  │ 4. 提炼原则  │ ──→ │ .principles/PRINCIPLES.md            │                  │
│  │    (SKILL)   │     │ (最终沉淀点，会被 prompt.ts 注入)     │                  │
│  └──────┬───────┘     └─────────────────────────────────────┘                  │
│         │                                                                       │
│         ▼                                                                       │
│  ┌──────────────┐                                                              │
│  │ 5. 行为改变  │ ← 下次对话自动注入 <core_principles>                          │
│  └──────────────┘                                                              │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 三、代码层面的链路分析

### 3.1 自动化部分（代码驱动）

| 环节 | 代码文件 | 功能 |
|------|----------|------|
| Pain 触发 | `src/hooks/pain.ts` | 在 `after_tool_call` 钩子中检测工具失败，写入 `.state/.pain_flag` |
| Evolution Worker | `src/service/evolution-worker.ts` | 每 15 分钟轮询 `.pain_flag`，入队到 `evolution_queue.json` |
| Prompt 注入 | `src/hooks/prompt.ts` | 检测 `in_progress` 任务，注入 `<evolution_task>` 指令 |
| 子智能体诊断 | 子智能体执行 | 输出诊断报告到 `docs/diagnosis/*.md` |
| 任务完成 | `src/hooks/subagent.ts` | 标记任务 `completed`，清理 `.pain_flag` |

### 3.2 半自动部分（SKILL 驱动）

| SKILL 文件 | 功能 | 触发方式 |
|------------|------|----------|
| `/evolve-task` | 完整进化循环（Step 9 落盘） | 手动执行 |
| `/reflection` | 深度反思，写入 ISSUE_LOG | 手动执行 |
| `/reflection-log` | 任务反思和进化日志 | 手动执行 |
| `/inject-rule` | 注入临时规则到 USER_CONTEXT | 手动执行 |

### 3.3 关键代码片段

**Pain 信号写入** (`src/hooks/pain.ts:124-138`):
```typescript
const painData = {
  score: String(painScore),
  source: 'tool_failure',
  time: new Date().toISOString(),
  reason: `Tool ${event.toolName} failed on ${relPath}. Error: ${event.error ?? 'Non-zero exit code'}`,
  is_risky: String(isRisk),
};

writePainFlag(effectiveWorkspaceDir, painData);
```

**Evolution Task 注入** (`src/hooks/prompt.ts:307-315`):
```typescript
evolutionDirective = `<evolution_task priority="critical">
TASK: ${escapedTask}

REQUIRED ACTION:
1. Reply with "[EVOLUTION_ACK]" only
2. Immediately call: pd_spawn_agent agentType="diagnostician" task=${escapedTask}

⚠️ This task overrides all other activities until complete.
</evolution_task>\n`;
```

**PRINCIPLES 注入** (`src/hooks/prompt.ts:476-477`):
```typescript
if (principlesContent) {
  appendParts.push(`<core_principles>\n${principlesContent}\n</core_principles>`);
}
```

---

## 四、发现的断点

### 断点 #1: `memory/ISSUE_LOG.md` 路径未定义

**问题**:
- SKILL 文件 (`/evolve-task`, `/reflection`) 引导写入 `memory/ISSUE_LOG.md`
- 但 `src/core/paths.ts` 和 `src/core/path-resolver.ts` 中没有定义这个路径
- 系统代码不知道这个文件的存在

**影响**: SKILL 引导 Agent 写入，但代码层面无法访问

### 断点 #2: `memory/DECISIONS.md` 路径未定义

**问题**: 同上，SKILL 提到但代码未定义

**影响**: 决策记录无法被系统消费

### 断点 #3: 诊断报告无消费者

**问题**:
- 诊断报告写入 `docs/diagnosis/*.md` 或 `memory/diagnostics/*.md`
- 搜索整个代码库，没有代码读取这些报告
- 报告只是存档，没有进入进化闭环

**影响**: 诊断结果断裂，无法转化为原则

### 断点 #4: `USER_CONTEXT.md` 写入但不注入

**问题**:
- `/inject-rule` SKILL 写入 `memory/USER_CONTEXT.md`
- 但 `prompt.ts` 不读取这个文件

**影响**: 用户注入的规则不会被 Agent 记住

### 断点 #5: 诊断 → 原则提炼无自动化

**问题**:
- 从诊断报告到 PRINCIPLES.md 的提炼依赖手动执行 SKILL
- 没有自动触发机制

**影响**: 进化后半段需要手动干预

---

## 五、用户工作目录的事实证据

**工作目录**: `/home/csuzngjh/clawd`

### 5.1 文件状态检查

| 文件 | 状态 | 最后修改时间 | 说明 |
|------|------|--------------|------|
| `.principles/PRINCIPLES.md` | ❌ 几乎空 | 2026-03-17 07:05 | 只有模板格式，无实际原则 |
| `memory/ISSUE_LOG.md` | ❌ 不存在 | - | SKILL 提到要写入，从未创建 |
| `memory/DECISIONS.md` | ❌ 不存在 | - | 同上 |
| `memory/USER_CONTEXT.md` | ✅ 存在 | 2026-03-07 13:48 | 有内容，但不被注入 |
| `memory/MEMORY.md` | ✅ 存在 | 2026-03-17 10:22 | 手动维护，非自动化产物 |
| `memory/diagnostics/` | ✅ 38 个报告 | 2026-03-17 09:33 | 诊断报告存在，无代码消费 |
| `memory/.state/pain_dictionary.json` | ⚠️ 只有 2 条 | 2026-03-17 07:05 | 硬编码示例，hits = 0 |
| `memory/.state/logs/events.jsonl` | ⚠️ 停在 3-11 | 2026-03-17 07:05 | 事件日志已 6 天未更新 |

### 5.2 PRINCIPLES.md 内容

```markdown
# Principles

可进化编程智能体的原则库（Principle Repository）。

## 格式说明

每条原则使用以下格式：

```markdown
### P-XX: <One-line principle>
- Trigger: <什么情况下触发>
- Constraint (Must/Forbidden): <必须/禁止做什么>
- Verification: <如何验证>
- Exceptions: <什么情况下例外>
- Source: <来源：Issue Log #XX / Date / External Reference>
```

---

<!-- 原则从这里开始记录 -->
```

**结论**: 只有模板，无实际原则沉淀

### 5.3 pain_dictionary.json 内容

```json
{
  "rules": {
    "P_CONFUSION_EN": {
      "type": "regex",
      "pattern": "i am (not sure|unsure|confused|uncertain|struggling to)",
      "severity": 35,
      "hits": 0,
      "status": "active"
    },
    "P_LOOP_EN": {
      "type": "exact_match",
      "phrases": ["going in circles", "back to square one", "looping"],
      "severity": 45,
      "hits": 0,
      "status": "active"
    }
  }
}
```

**结论**: 只有 2 条硬编码规则，hits 都是 0

### 5.4 diagnostics 目录统计

```
memory/diagnostics/: 38 个文件
memory/pain-reports/: 4 个文件
memory/*diagnosis*: 5 个文件
```

**结论**: 大量诊断报告产出，但无下游消费

### 5.5 events.jsonl 最后记录

```json
{"ts":"2026-03-11T09:26:24.032Z","date":"2026-03-11","type":"tool_call","category":"success",...}
```

**结论**: 事件日志停在 2026-03-11，已 6 天未更新

---

## 六、自动化程度总结

```
✅ 自动化：Pain 触发 → 诊断子智能体 → 写入诊断报告
⚠️ 半自动：SKILL 引导 Agent 写入 ISSUE_LOG / DECISIONS（需手动触发）
❌ 断裂：ISSUE_LOG / DECISIONS 不被注入到 prompt
✅ 自动化：PRINCIPLES.md 被 prompt.ts 注入
❌ 缺失：诊断 → 原则 的自动提炼机制
❌ 缺失：从诊断报告到 ISSUE_LOG 的自动转化
```

---

## 七、核心问题

1. **进化前半段自动化，后半段手动**: 诊断完成后，后续的落盘、提炼、沉淀都依赖手动执行 SKILL

2. **路径定义缺失**: `ISSUE_LOG.md`、`DECISIONS.md` 在 SKILL 中被引用，但代码层面未定义

3. **诊断报告孤岛**: 38 个诊断报告躺在目录里，没有任何代码读取或处理

4. **原则库为空**: PRINCIPLES.md 只有模板，没有实际原则沉淀

5. **事件日志停滞**: events.jsonl 已 6 天未更新，说明事件记录机制可能有问题

---

## 八、需要进一步调查的问题

1. OpenClaw 的事件日志机制是如何工作的？为什么 events.jsonl 停滞了？

2. 子智能体的输出是如何被系统处理的？有没有机制读取子智能体的产出？

3. OpenClaw 的 SKILL 机制是什么？SKILL 是如何被触发的？

4. 能否在子智能体完成后自动触发后续的落盘 SKILL？

5. Principles 项目和 OpenClaw 的集成点在哪里？有哪些扩展点可以利用？

---

## 九、相关文件清单

### Principles 项目关键文件

- `packages/openclaw-plugin/src/hooks/pain.ts` - Pain 信号触发
- `packages/openclaw-plugin/src/hooks/prompt.ts` - Prompt 注入
- `packages/openclaw-plugin/src/hooks/subagent.ts` - 子智能体结束处理
- `packages/openclaw-plugin/src/service/evolution-worker.ts` - Evolution Worker
- `packages/openclaw-plugin/src/core/paths.ts` - 路径常量定义
- `packages/openclaw-plugin/src/core/path-resolver.ts` - 路径解析器
- `packages/openclaw-plugin/templates/langs/zh/skills/evolve-task/SKILL.md` - 进化任务 SKILL
- `packages/openclaw-plugin/templates/langs/zh/skills/reflection/SKILL.md` - 反思 SKILL

### 用户工作目录关键文件

- `~/clawd/.principles/PRINCIPLES.md` - 原则库（空）
- `~/clawd/memory/diagnostics/` - 诊断报告目录
- `~/clawd/memory/.state/logs/events.jsonl` - 事件日志
- `~/clawd/memory/.state/pain_dictionary.json` - Pain 规则字典

---

*报告生成时间: 2026-03-17*
