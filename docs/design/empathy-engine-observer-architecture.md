# 同理心引擎：旁路解耦观察者架构设计

## 1. 背景与痛点分析

### 当前架构：强耦合的主链路同理心引擎
目前，Principles Disciple 的同理心引擎采用的是**主链路耦合设计（In-band signaling）**。即在 `before_prompt_build` 阶段，向主模型的 System Prompt 注入一段指令，要求其在回答代码问题的同时，如果感知到用户愤怒或挫败，必须在回复末尾附带 `<empathy>` 标签。

### 核心痛点：指令遗忘（Instruction Dropping）
当主模型（如 GPT-4o 或 Claude 3.5）面临高认知负载任务（例如：梳理多文件依赖、编写复杂的重构代码）时，其**注意力机制（Attention Mechanism）**会高度集中在代码逻辑上。在这种状态下，"附加标签"这类非主线任务极易被模型舍弃，导致虽然模型看懂了用户的愤怒，但却"忘记"输出 `<empathy>` 标签。

这种因认知过载导致的指令遗忘，是当前同理心引擎频频漏报、运行不稳定的根源。

## 2. 解决方案：旁路解耦观察者架构

为了彻底解决上述问题，我们引入**旁路解耦观察者（Asynchronous Decoupled Observer）**架构。

核心思想：**关注点分离（Separation of Concerns）**。不要让主模型一边写代码一边做心理医生。我们将同理心分析任务从主模型中剥离，交给一个专门在后台运行的、异步的轻量级模型来处理。

### 架构优势
1. **彻底消除遗忘**：旁路模型的唯一任务就是输出情绪 JSON，不存在多任务竞争，标签输出遵从度可达 100%。
2. **零用户感知延迟**：旁路调用是纯异步的，完全不会阻塞主模型返回代码的速度。
3. **主模型减负**：移除主模型 Prompt 中冗长的共情指令，节约 Token，让主模型专注于代码生成。
4. **准确率极高**：相比于穷举正则表达式（永远无法覆盖反讽、阴阳怪气），使用 LLM 进行旁路语义分析能完美捕捉复杂语境。

---

## 3. 技术落地可行性验证（基于 OpenClaw v1.5+）

经过对 OpenClaw 核心源码（特别是 `PluginRuntime` 和 `Hooks` 系统）的分析，该方案在现有架构下是**完全可行的**。

### 3.1 核心 API 支持
OpenClaw 的 `PluginRuntime` 提供了底层的子代理运行接口：
```typescript
api.runtime.subagent.run(params: SubagentRunParams): Promise<SubagentRunResult>
```
该接口支持将任务推入后台队列执行（Fire-and-Forget），不需要 `await waitForRun`，因此天然支持非阻塞异步操作。

### 3.2 状态闭环机制
OpenClaw 提供了完善的 Hook 机制：
- `before_prompt_build`: 用于拦截用户输入并触发旁路。
- `subagent_ended`: 用于捕获旁路模型的执行结果，并更新系统 GFI（摩擦指数）。

---

## 4. 详细实施方案

### 阶段 1：触发与旁路分流 (Hook: `before_prompt_build`)

在用户消息发出时，提取最新一条用户文本。为了防止每个毫无意义的简短指令（如 "继续"）都触发 LLM 分析，可以加入一个轻量级的正则初筛，或者对长度/关键词进行基础过滤。

```typescript
// packages/openclaw-plugin/src/hooks/prompt.ts

const lastUserMsg = extractLastUserMessage(event.messages);

if (lastUserMsg && shouldTriggerEmpathyCheck(lastUserMsg)) {
    // 异步触发，不 await，不阻塞主流程
    api.runtime.subagent.run({
        sessionKey: `empathy_obs:${ctx.sessionId}:${Date.now()}`,
        message: lastUserMsg,
        extraSystemPrompt: `你是一个极简情绪分类器。判断用户的输入是否包含愤怒、挫败或反讽。
严格输出 JSON，无其他废话：
{"detected": true, "severity": "mild"|"moderate"|"severe", "reason": "描述原因"}`,
        lane: 'background',
        deliver: false 
    }).catch(err => {
        api.logger.warn(`[Empathy] Failed to dispatch observer: ${err}`);
    });
}
```

### 阶段 2：结果捕获与 GFI 更新 (Hook: `subagent_ended`)

当旁路的情绪分析子代理执行完毕后，会触发 `subagent_ended` Hook。我们在这里拦截特定命名的 `sessionKey`，提取 JSON，并更新 GFI。

```typescript
// packages/openclaw-plugin/src/hooks/subagent.ts

export async function handleSubagentEnded(
    event: PluginHookSubagentEndedEvent,
    ctx: PluginHookSubagentContext & { workspaceDir: string, api?: any }
): Promise<void> {
    
    // 拦截旁路情绪观察者
    if (event.targetSessionKey.startsWith('empathy_obs:')) {
        if (event.outcome !== 'ok') return;
        
        try {
            // 获取旁路模型的输出
            const msgs = await ctx.api.runtime.subagent.getSessionMessages({ 
                sessionKey: event.targetSessionKey 
            });
            const output = extractAssistantText(msgs);
            
            // 解析 JSON
            const result = JSON.parse(output);
            if (result.detected) {
                // 提取原始对话的 sessionId
                const originalSessionId = event.targetSessionKey.split(':')[1];
                
                // 直接调用现有的摩擦力更新函数
                const penalty = mapSeverityToPenalty(result.severity, config);
                trackFriction(originalSessionId, penalty, 'empathy_observer', ctx.workspaceDir);
                
                // 记录疼痛日志
                eventLog.recordPainSignal(originalSessionId, {
                    score: penalty,
                    source: 'empathy_observer',
                    reason: result.reason,
                    severity: result.severity
                });
            }
        } catch (e) {
            // 解析失败忽略，保证主流程不受影响
        } finally {
            // 清理临时 Session，防止磁盘膨胀
            ctx.api.runtime.subagent.deleteSession({ 
                sessionKey: event.targetSessionKey 
            }).catch(() => {});
        }
        return; 
    }
    
    // ... 现有的其他子代理处理逻辑 ...
}
```

### 阶段 3：主模型减负 (移除 System Override)

删除 `prompt.ts` 中原有的 `<system_override:empathy_engine>` 注入逻辑。让主模型彻底解放，不再被强制要求输出 `<empathy>` 标签。

## 5. 潜在挑战与应对

1. **API 频率限制 (Rate Limit)**：高频对话可能导致旁路小模型触发 API 限制。
   * **应对**：在 `shouldTriggerEmpathyCheck` 中加入 15-30 秒的节流（Throttle），或者仅对长度大于一定字符（如 10）或匹配初步关键词的消息进行旁路检测。
2. **异步状态竞争**：旁路更新 GFI 可能在主模型回复之后才完成，导致当前回合的 `prompt` 没有获取到最新的 Trust Score。
   * **应对**：这是可以接受的妥协。情绪反馈具有滞后性，在**下一轮**对话生效完全符合真实人类交流的节奏。并且由于避免了阻塞，用户体验是丝滑的。