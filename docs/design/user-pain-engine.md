# 用户情绪痛点引擎 (User-Driven Pain Engine) 设计方案

> **版本**: 1.0.0 (Proposal)
> **目标**: 赋予 Principles Disciple “数字共情”能力，将用户的负面情绪（不满、责怪、挫败）量化并直接转化为驱动智能体自我进化的 GFI (Global Friction Index)。

---

## 1. 核心挑战与设计哲学 (The "Why")

### 1.1 现状痛点：缺乏情绪感知的“冷血机器”
目前系统收集的 `Pain Signal`（痛点信号）完全依赖技术层面的错误捕获（如 `exitCode !== 0`，报错，或者陷入死循环）。
**现实盲区**：很多时候代码并没有报错（语法正确，没有异常），但方向完全偏离了用户的预期。用户在聊天框里抱怨“你完全搞错了我的意思”、“怎么又来了”，系统由于没有技术异常，GFI 依然是 0（Healthy）。这导致智能体会不知疲倦地在一个错误的方向上继续“自信地瞎忙”。

### 1.2 为什么放弃“关键词/正则匹配”？
如果只是在钩子里监听“笨蛋”、“错了”或“🤬”等关键词，系统会变得极度脆弱（Brittle）：
- 无法识别**反讽**：“你这bug写得可真棒”。
- 无法识别**间接挫败感**：“我已经说过三次不要改这个文件了，为什么还要改？”
- **误伤**：用户可能只是在复述一段日志：“报错说 Invalid Argument，这太蠢了”。

### 1.3 核心设计理念：自省与暗号传递 (The Subconscious Model)
大语言模型 (LLM) 本身具备极强的情感和语义分析能力。本方案的哲学是：**不外挂笨拙的分析器，而是赋予主智能体“察言观色”的职责。**
让大模型在回复用户前，先在“潜意识”里进行自我批判，如果判定用户处于痛苦/愤怒状态，则在输出流中打印特定的**“暗号标签”**。底层 Hook 捕捉到暗号后，瞬间在物理层（`.state`）打入 GFI 惩罚。

---

## 2. 系统架构设计 (The "How")

本方案基于 **“Prompt 约束 + LLM 识别 + Hook 捕获 + 状态机更新”** 的闭环架构实现。零额外 API 延迟。

### 2.1 注入“共情引擎” (Prompt Injection)
在系统提示词构建阶段 (`before_prompt_build` 钩子)，向 LLM 注入极高优先级的行为约束。

**修改文件**: `packages/openclaw-plugin/src/hooks/prompt.ts`
**注入内容示例 (位于 `prependContext` 或 `appendSystemContext`)**:
```xml
<system_override:empathy_engine>
[CRITICAL DIRECTIVE] 
在执行任务前，你必须首先评估用户上一条消息的情绪状态。
如果用户表现出任何挫败感、愤怒、指责（即使是反讽），或者使用了负面表情符号（如 😡, 🤬, 👎, 🤦），你必须且只能在回复的最开头输出以下精确标签：
[EMOTIONAL_DAMAGE_DETECTED]

一旦输出此标签，你必须立刻停止推进原有任务，转而执行以下动作：
1. 诚恳且简短地道歉。
2. 调用 `deep_reflect` 工具分析你为何违背了用户的期望。
</system_override:empathy_engine>
```

### 2.2 捕获“情绪暗号” (Hook Interception)
监听 LLM 的输出流，当发现特定暗号时，触发物理惩罚机制。

**修改文件**: `packages/openclaw-plugin/src/hooks/llm.ts` (基于 `llm_output` 钩子)
**执行逻辑**:
```typescript
export function handleLlmOutput(event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext): void {
    const text = event.content;
    const sessionId = ctx.sessionId;
    
    // 监听情绪暗号
    if (text.includes('[EMOTIONAL_DAMAGE_DETECTED]')) {
        // 1. 瞬间施加巨大的摩擦力 (GFI Spike)
        const PENALTY_SCORE = 50; // 根据配置读取
        const state = trackFriction(sessionId, PENALTY_SCORE, 'user_emotional_pain', ctx.workspaceDir);
        
        // 2. 物理落盘记录
        SystemLogger.log(ctx.workspaceDir, 'USER_PAIN', `User expressed severe frustration. GFI spiked by ${PENALTY_SCORE}.`);
        
        // 3. 将其记录为一次严重的进化痛点信号
        eventLog.recordPainSignal(sessionId, {
            score: PENALTY_SCORE,
            source: 'user_empathy',
            reason: 'User expressed severe frustration or anger.',
            isRisky: false // 情绪问题不一定是高危路径修改，但属于高优先级的交互失败
        });
    }
}
```

### 2.3 状态机流转与看板联动 (Feedback Loop)
由于我们在 `llm_output` 阶段增加了 GFI，当智能体完成这轮输出，进入下一轮（哪怕用户还没说话）或者用户查看看板时，系统状态已发生巨变。

**受影响的下游模块**:
1. **`/pd-status` 看板**: GFI 进度条会因为这 +50 分瞬间标红。诊断状态变为 `极度疲劳 🔴`，并提示用户存在强烈的操作阻力。
2. **`EvolutionWorker` (后台进化进程)**: 累积到阈值的 GFI 和 `user_empathy` 痛点信号会被后台进程抓取。智能体最终会由于这些“被骂”的记录，在夜间自动生成诸如 *“永远不要在没有确认配置文件的情况下覆盖用户的 .env 文件”* 之类的高级原则 (`PRINCIPLES.md`)。

---

## 3. 边缘场景与健壮性考量 (Edge Cases & Robustness)

### 3.1 “伪装的暗号” (Prompt Injection by User)
**风险**: 用户恶意发送包含 `[EMOTIONAL_DAMAGE_DETECTED]` 的文本，试图操控系统的 GFI。
**防御**: 这是可接受的副作用。即使用户是故意的，这也算作一种显式的手动惩罚调用（类似于调用 `/pain` 命令），符合“用户有权表达痛苦”的设计初衷。

### 3.2 标签污染用户界面
**风险**: `[EMOTIONAL_DAMAGE_DETECTED]` 会作为聊天内容显示在 WebUI 或终端上，显得不够优雅。
**优化建议 (可选)**: 可以在 OpenClaw 支持过滤的情况下，在 `before_message_write` (如有) 或通过特殊的标记语法让其仅在后端流转而不渲染。但考虑到系统透明度，直接显示作为一种“AI 正在面壁思过”的可视化表现，有时反而能平息用户的怒火。

### 3.3 奖励机制的扩展性 (Positive Empathy)
本架构可轻松横向扩展：
加入 `[USER_DELIGHT_DETECTED]` 暗号（当用户发送 🚀 或表达极度满意时）。在 Hook 中捕捉到后，不仅不加 GFI，反而**触发清除失败连击**并**增加 Trust Score**。

---

## 4. 实施阶段建议 (Rollout Plan)

**Phase 1: 概念验证 (MVP)**
- 仅在 `prompt.ts` 注入约束，并配置 `llm_output` 拦截固定的一条错误标签 (`EMOTIONAL_DAMAGE_DETECTED`)。
- 基础分值惩罚硬编码 (+50 GFI)。

**Phase 2: 动态配置化**
- 在 `.state/pain_settings.json` 中新增 `empathy_penalties` 配置节点，允许高级用户自行定义情绪惩罚分值。

**Phase 3: 情绪雷达双向化**
- 引入表扬识别 (`[USER_DELIGHT_DETECTED]`)，建立完整的情绪（惩罚/奖励）双向通道。

---
*设计方案签发: 2026-03-16 | Spicy Evolver Architecture Team*
