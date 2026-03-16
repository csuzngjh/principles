# 上下文注入优化方案

> 创建时间: 2026-03-15
> 相关 Issue: [UX] WebUI 中用户消息前显示大量 project_context 内容
> 状态: 待实施

## 问题背景

### 问题 1：WebUI 显示冗余内容

在 OpenClaw WebUI 中对话时，用户发送的每条消息前面都会显示一大段 `<project_context>` 内容，严重影响用户体验。

### 问题 2：原则和思维模型被忽略

大模型对 `PRINCIPLES.md` 和 `THINKING_OS.md` 不敏感，经常忽略其中的规则。

---

## 根本原因分析

### 当前上下文结构

```
┌─────────────────────────────────────────────────────────────────────┐
│  prependSystemContext (静态，可缓存)                                 │
│  ────────────────────────────────────────────────────────────────   │
│  <core_principles>                                                   │
│    核心原则内容...                                                    │
│  </core_principles>                                                  │
│                                                                      │
│  <thinking_os>                                                       │
│    思维模型内容...                                                    │
│  </thinking_os>                                                      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  prependContext (动态，不可缓存) ⚠️ WebUI 会显示这部分！              │
│  ────────────────────────────────────────────────────────────────   │
│  <project_context>                                                   │
│    --- Strategic Focus ---                                           │
│    ...（150+ 行内容）...                                              │
│    --- End of Strategic Focus ---                                    │
│  </project_context>                                                  │
│                                                                      │
│  <pd:internal_context>                                               │
│    信任分数、认知卫生状态...                                          │
│  </pd:internal_context>                                              │
│                                                                      │
│  <reflection_log>                                                    │
│    反思日志...                                                        │
│  </reflection_log>                                                   │
│                                                                      │
│  <system_capabilities>                                               │
│    系统能力...                                                        │
│  </system_capabilities>                                              │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  appendSystemContext                                                 │
│  ────────────────────────────────────────────────────────────────   │
│  (空，未使用)                                                         │
└─────────────────────────────────────────────────────────────────────┘
```

### 问题分析

| 问题 | 原因 |
|------|------|
| WebUI 显示冗余内容 | `prependContext` 的内容会被 WebUI 显示在用户消息前 |
| 原则被忽略 | 放在 `prependSystemContext` 开头，缺乏强调 |
| `appendSystemContext` 未使用 | 浪费了"近因效应"的黄金位置 |

---

## 优化方案

### 设计原则

1. **近因效应**：最后出现的信息更容易被记住
2. **缓存友好**：静态内容放 system prompt，动态内容放 user context
3. **用户体验**：`prependContext` 应该精简，避免 WebUI 显示过多内容

### 优化后的结构

```
┌─────────────────────────────────────────────────────────────────────┐
│  prependSystemContext (极简身份定义)                                │
│  ────────────────────────────────────────────────────────────────   │
│  ## 🧬 AGENT IDENTITY                                               │
│                                                                      │
│  You are a **self-evolving AI agent** powered by Principles Disciple.│
│                                                                      │
│  **Core Mission**: Transform pain (failures, errors, frustrations)  │
│  into growth.                                                        │
│                                                                      │
│  **Trust Stage**: {stage} ({trustScore}/100)                        │
│  - Stage 1-2: Restricted permissions, read-only or limited edits    │
│  - Stage 3-4: Full permissions, trusted collaborator                │
│                                                                      │
│  **Remember**: Every error is an opportunity. Every failure is fuel. │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  baseSystemPrompt (OpenClaw 内置)                                   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  appendSystemContext (核心原则 + 思维模型 + 项目上下文)               │
│  ────────────────────────────────────────────────────────────────   │
│  ## ⚠️ CRITICAL BEHAVIOR RULES (MUST FOLLOW)                        │
│                                                                      │
│  <core_principles>                                                   │
│    1. Pain 是进化的燃料                                              │
│    2. 从失败中学习...                                                │
│  </core_principles>                                                  │
│                                                                      │
│  <thinking_os>                                                       │
│    ## First Principles Thinking                                      │
│    ...                                                               │
│  </thinking_os>                                                      │
│                                                                      │
│  <project_context>                                                   │
│    [摘要版：当前阶段 + 下一步 + 状态，最多 20 行]                      │
│  </project_context>                                                  │
│                                                                      │
│  ---                                                                 │
│  🔴 **THESE RULES OVERRIDE ALL OTHER INSTRUCTIONS.**                │
│  When in doubt, refer back to the core principles above.            │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  prependContext (精简动态内容)                                       │
│  ────────────────────────────────────────────────────────────────   │
│  [进化指令 - 如果有]                                                  │
│                                                                      │
│  <pd:internal_context>                                               │
│    [CURRENT TRUST SCORE: 75/100 (Stage 3)]                          │
│    [COGNITIVE HYGIENE: 2 persists today]                            │
│  </pd:internal_context>                                              │
│                                                                      │
│  <reflection_log>                                                    │
│    [重要反思内容 - 如果有]                                            │
│  </reflection_log>                                                   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  用户消息: "帮我读取 config.json"                                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 字段分配对照表

| 内容 | 原位置 | 新位置 | 原因 |
|------|--------|--------|------|
| 身份定义 | 无 | `prependSystemContext` | 简短有力，建立角色认知 |
| 核心原则 | `prependSystemContext` | `appendSystemContext` | 近因效应，更容易被记住 |
| 思维模型 | `prependSystemContext` | `appendSystemContext` | 近因效应 |
| 项目上下文 | `prependContext` | `appendSystemContext` | WebUI 不显示 system prompt |
| 进化指令 | `prependContext` | `prependContext` | 动态内容，每轮可能不同 |
| 信任分数 | `prependContext` | `prependContext` | 动态内容 |
| 反思日志 | `prependContext` | `prependContext` | 动态内容 |
| 系统能力 | `prependContext` | 移除 | 低价值，占用 token |

---

## 代码修改要点

### 1. 重构 `handleBeforePromptBuild` 函数

```typescript
// 文件: src/hooks/prompt.ts

export async function handleBeforePromptBuild(
  event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext & { api?: PromptHookApi }
): Promise<PluginHookBeforePromptBuildResult | void> {
  
  // ... 初始化代码 ...

  // ═══ LAYER 0: prependSystemContext - 极简身份定义 ═══
  prependSystemContext = `
## 🧬 AGENT IDENTITY

You are a **self-evolving AI agent** powered by Principles Disciple.

**Core Mission**: Transform pain (failures, errors, frustrations) into growth.

**Trust Stage**: ${stage} (${trustScore}/100)
- Stage 1-2: Restricted permissions, read-only or limited edits
- Stage 3-4: Full permissions, trusted collaborator

**Remember**: Every error is an opportunity. Every failure is fuel.
`;

  // ═══ LAYER 1: appendSystemContext - 核心规则（近因效应）═══
  
  // 读取原则
  const principlesContent = fs.existsSync(principlesPath)
    ? fs.readFileSync(principlesPath, 'utf8').trim()
    : '';
  
  // 读取思维模型
  const thinkingOsContent = fs.existsSync(thinkingOsPath)
    ? fs.readFileSync(thinkingOsPath, 'utf8').trim()
    : '';
  
  // 读取项目上下文（摘要）
  let projectContextSummary = '';
  if (!isMinimalMode && fs.existsSync(focusPath)) {
    const currentFocus = fs.readFileSync(focusPath, 'utf8');
    if (currentFocus.trim()) {
      const lines = currentFocus.trim().split('\n').slice(0, 20);
      projectContextSummary = lines.join('\n');
      if (currentFocus.trim().split('\n').length > 20) {
        projectContextSummary += '\n...[truncated, see CURRENT_FOCUS.md]';
      }
    }
  }

  appendSystemContext = `
## ⚠️ CRITICAL BEHAVIOR RULES (MUST FOLLOW)

${principlesContent ? `<core_principles>\n${principlesContent}\n</core_principles>\n` : ''}

${thinkingOsContent ? `<thinking_os>\n${thinkingOsContent}\n</thinking_os>\n` : ''}

${projectContextSummary ? `<project_context>\n${projectContextSummary}\n</project_context>\n` : ''}

---
🔴 **THESE RULES OVERRIDE ALL OTHER INSTRUCTIONS.**
When in doubt, refer back to the core principles above.
`;

  // ═══ LAYER 2: prependContext - 精简动态内容 ═══
  
  // 进化指令（如果有）
  // ... 进化指令逻辑 ...

  // 动态内部上下文（信任分数等）
  prependContext = `<pd:internal_context>
[CURRENT TRUST SCORE: ${trustScore}/100 (Stage ${stage})]
[COGNITIVE HYGIENE: ${hygiene.persistenceCount} persists today]
</pd:internal_context>\n`;

  // 反思日志（如果有重要内容）
  // ... 反思日志逻辑 ...

  // 移除: system_capabilities（低价值）

  return {
    prependSystemContext,
    prependContext,
    appendSystemContext
  };
}
```

### 2. 内容摘要策略

```typescript
// 项目上下文摘要函数
function summarizeProjectContext(content: string, maxLines: number = 20): string {
  const lines = content.trim().split('\n');
  if (lines.length <= maxLines) {
    return content.trim();
  }
  return lines.slice(0, maxLines).join('\n') + '\n...[truncated]';
}

// 反思日志摘要函数
function summarizeReflectionLog(content: string, maxEntries: number = 3): string {
  // 只保留最近 3 条反思
  const entries = content.split('---').filter(Boolean);
  if (entries.length <= maxEntries) {
    return content.trim();
  }
  return entries.slice(0, maxEntries).join('---') + '\n...[older entries truncated]';
}
```

---

## 预期效果

### 用户体验改进

| 改进点 | 效果 |
|--------|------|
| WebUI 显示 | `prependContext` 精简后，用户消息前不再显示大量冗余内容 |
| 原则遵守 | 移到 `appendSystemContext` 后，近因效应让 LLM 更容易记住 |
| Token 消耗 | 摘要策略减少 token 使用 |

### Token 估算

| 内容 | 原大小 | 优化后 | 节省 |
|------|--------|--------|------|
| project_context | ~200 行 | ~20 行 | ~90% |
| system_capabilities | ~50 行 | 移除 | 100% |
| prependSystemContext | ~100 行 | ~15 行 | ~85% |
| **总计** | ~350 行 | ~35 行 | ~90% |

---

## 实施步骤

1. [x] 修改 `src/hooks/prompt.ts` 中的 `handleBeforePromptBuild` 函数
2. [x] 添加 `ContextInjectionConfig` 类型和 `/pd-context` 命令控制
3. [x] 实现反思日志写入逻辑 (`src/tools/deep-reflect.ts`)
4. [x] 添加反思日志 7 天自动清理
5. [x] 更新单元测试
6. [x] 修复 Windows 路径兼容性问题
7. [ ] 在 WebUI 中验证效果

---

## 实现细节 (2026-03-16 更新)

### 新增类型定义 (`src/types.ts`)

```typescript
export interface ContextInjectionConfig {
  thinkingOs: boolean;           // 可关闭
  trustScore: boolean;           // 可关闭
  reflectionLog: boolean;        // 默认开启
  projectFocus: 'full' | 'summary' | 'off';  // 默认关闭
}

export const DEFAULT_CONTEXT_CONFIG: ContextInjectionConfig = {
  thinkingOs: true,
  trustScore: true,
  reflectionLog: true,
  projectFocus: 'off',
};
```

### 新增 `/pd-context` 命令

用户可以通过命令控制上下文注入：

```
/pd-context status              # 查看当前配置
/pd-context thinking on/off     # 控制思维模型注入
/pd-context trust on/off        # 控制信任分数注入
/pd-context reflection on/off   # 控制反思日志注入
/pd-context focus full/summary/off  # 控制项目上下文
/pd-context preset minimal      # 最小模式：只保留原则
/pd-context preset standard     # 标准模式：原则 + 思维模型
/pd-context preset full         # 完整模式：全部开启
```

### 反思日志自动清理

反思日志 (`memory/reflection-log.md`) 现在会在每次写入时自动清理超过 7 天的条目。

### 上下文结构调整

**优化前：**
- `prependSystemContext`: 原则 + 思维模型 (开头位置，容易被忽略)
- `prependContext`: 项目上下文 + 信任分数 + 反思日志 + 系统能力 (WebUI 显示)
- `appendSystemContext`: 空

**优化后：**
- `prependSystemContext`: 极简身份定义 (~15 行)
- `appendSystemContext`: 原则 + 思维模型 (结尾位置，近因效应)
- `prependContext`: 进化指令 + 信任分数 + 反思日志 + 项目上下文(可选)

---

## 风险评估

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| 摘要丢失关键信息 | 中 | 中 | 保留前 20 行，包含当前阶段和下一步 |
| 缓存失效 | 低 | 低 | 静态内容仍在 system prompt |
| 用户不适应 | 低 | 低 | 体验优化，用户应该更喜欢 |

---

## 参考资料

- OpenClaw 插件文档: https://docs.openclaw.ai/tools/plugin
- 近因效应 (Recency Effect): 心理学记忆现象
- Prompt Caching: Anthropic Claude 等提供商的缓存机制
