# 上下文注入优化方案

> 创建时间: 2026-03-15
> 更新时间: 2026-03-16
> 相关 Issue: [UX] WebUI 中用户消息前显示大量 project_context 内容
> 状态: ✅ 已实施

## 问题背景

### 问题 1：WebUI 显示冗余内容

在 OpenClaw WebUI 中对话时，用户发送的每条消息前面都会显示一大段 `<project_context>` 内容，严重影响用户体验。

### 问题 2：原则和思维模型被忽略

大模型对 `PRINCIPLES.md` 和 `THINKING_OS.md` 不敏感，经常忽略其中的规则。

### 问题 3：Prompt Caching 失效

将动态内容放在 `prependContext` (User Message 级别) 会导致模型提供商（如 Anthropic）的 Prompt Caching 失效，增加 API 成本。

---

## 最终方案 (2026-03-16 更新)

### 核心改动

**关键优化**：将 `project_context` 和 `reflection_log` 从 `prependContext` 移到 `appendSystemContext`

**原理**：
1. **WebUI UX**: `prependContext` 是 User Message 级别，WebUI 会完整展示。移到 `appendSystemContext` 后 WebUI 不显示。
2. **Prompt Caching**: `appendSystemContext` 是 System Prompt 的一部分，可以被模型提供商缓存。

### 最终上下文结构

```text
┌─────────────────────────────────────────────────────────────────────┐
│  prependSystemContext (极简身份定义，~15 行)                        │
│  ────────────────────────────────────────────────────────────────   │
│  ## 🧬 AGENT IDENTITY                                               │
│  You are a self-evolving AI agent powered by Principles Disciple.   │
│  **Core Mission**: Transform pain into growth.                       │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  baseSystemPrompt (OpenClaw 内置)                                   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  appendSystemContext (所有长内容，WebUI 隐藏，Prompt 可缓存)          │
│  ────────────────────────────────────────────────────────────────   │
│  ## ⚠️ CRITICAL BEHAVIOR RULES (MUST FOLLOW)                        │
│                                                                      │
│  <project_context>           ← 从 prependContext 移入               │
│    [当前阶段 + 下一步 + 状态]                                         │
│  </project_context>                                                  │
│                                                                      │
│  <reflection_log>            ← 从 prependContext 移入               │
│    [最近 7 天的反思条目]                                              │
│  </reflection_log>                                                   │
│                                                                      │
│  <thinking_os>                                                       │
│    [思维模型内容]                                                     │
│  </thinking_os>                                                      │
│                                                                      │
│  <core_principles>           ← 永远注入，不可关闭                     │
│    [核心原则]                                                         │
│  </core_principles>                                                  │
│                                                                      │
│  ---                                                                 │
│  🔴 **THESE RULES OVERRIDE ALL OTHER INSTRUCTIONS.**                │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  prependContext (仅保留短动态指令)                                   │
│  ────────────────────────────────────────────────────────────────   │
│  [进化指令 - 如果有]  ← 短内容，< 500 字符                            │
│                                                                      │
│  <pd:internal_context>       ← 短内容，< 300 字符                    │
│    [CURRENT TRUST SCORE: 75/100 (Stage 3)]                          │
│    [COGNITIVE HYGIENE: 2 persists today]                            │
│  </pd:internal_context>                                              │
│                                                                      │
│  <heartbeat_checklist>       ← 仅 heartbeat 触发时                   │
│    [心跳检查清单]                                                     │
│  </heartbeat_checklist>                                              │
└─────────────────────────────────────────────────────────────────────┘
```

### 内容顺序 (Recency Effect)

`appendSystemContext` 中的内容顺序按重要性从低到高排列（最重要的放在最后）：

1. `project_context` - 项目上下文（优先级最低）
2. `reflection_log` - 反思日志
3. `thinking_os` - 思维模型
4. `core_principles` - 核心原则（优先级最高，放在最后）

---

## 字段分配对照表

| 内容 | 原位置 | 新位置 | 原因 |
|------|--------|--------|------|
| 身份定义 | 无 | `prependSystemContext` | 简短有力，建立角色认知 |
| 核心原则 | `prependSystemContext` | `appendSystemContext` | 近因效应，更容易被记住 |
| 思维模型 | `prependSystemContext` | `appendSystemContext` | 近因效应 |
| 项目上下文 | `prependContext` | `appendSystemContext` | WebUI 不显示，Prompt 可缓存 |
| 反思日志 | `prependContext` | `appendSystemContext` | WebUI 不显示，Prompt 可缓存 |
| 进化指令 | `prependContext` | `prependContext` | 短动态指令，< 500 字符 |
| 信任分数 | `prependContext` | `prependContext` | 短动态指令，< 300 字符 |
| 心跳检查 | `prependContext` | `prependContext` | 仅 heartbeat 触发 |
| 系统能力 | `prependContext` | 移除 | 低价值，占用 token |

---

## 实施步骤

1. [x] 修改 `src/hooks/prompt.ts` 中的 `handleBeforePromptBuild` 函数
2. [x] 添加 `ContextInjectionConfig` 类型和 `/pd-context` 命令控制
3. [x] 实现反思日志写入逻辑 (`src/tools/deep-reflect.ts`)
4. [x] 添加反思日志 7 天自动清理
5. [x] 更新单元测试
6. [x] 修复 Windows 路径兼容性问题
7. [x] **将 `project_context` 和 `reflection_log` 移到 `appendSystemContext`** (2026-03-16)
8. [ ] 在 WebUI 中验证效果

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
