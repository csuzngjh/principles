# 同理心引擎：旁路解耦观察者架构设计 (v3.0 - 最终版)

## 1. 背景与痛点分析

### 当前架构：强耦合的主链路同理心引擎
目前，Principles Disciple 的同理心引擎采用的是**主链路耦合设计（In-band signaling）**。即在 `before_prompt_build` 阶段，向主模型的 System Prompt 注入一段指令，要求其在回答代码问题的同时，如果感知到用户愤怒或挫败，必须在回复末尾附带 `<empathy>` 标签。

### 核心痛点：指令遗忘（Instruction Dropping）
当主模型在面临高认知负载任务（如：复杂重构）时，会优先保证代码逻辑，而忽略情绪标签的输出。这种“指令遗忘”是导致同理心引擎不稳定的根本原因。

## 2. 解决方案：旁路解耦观察者架构

为了彻底解决上述问题，我们引入**旁路解耦观察者（Asynchronous Decoupled Observer）**架构。

核心思想：**关注点分离（Separation of Concerns）**。不要让主模型一边写代码一边做心理医生。我们将同理心分析任务从主模型中剥离，交给一个专门在后台运行的、异步的轻量级模型来处理。

---

## 3. 架构优化与灵活性设计 (v3.0 核心更新)

### 3.1 封装管理服务：`EmpathyObserverManager`
所有观察者的生命周期管理（启动、回收、状态追踪）均由 `EmpathyObserverManager` 统一负责。它与主逻辑解耦，保证了系统的整洁度。

### 3.2 灵活的模型路由 (Adaptive Model Routing)
不再绑定单一模型，用户可以在 `pain_settings.json` 中灵活配置旁路观察者使用的模型：

- **本地化支持**：支持配置为 `ollama/llama3`, `ollama/phi3` 等。利用本地算力进行情绪分析，实现**零成本、高隐私**的共情检测。
- **极速云端支持**：默认推荐 `openai/gpt-4o-mini`, `anthropic/claude-3-haiku` 等廉价且极速的模型。
- **动态升降级策略**：
    - **常规检测**：默认使用用户配置的廉价/本地模型。
    - **冲突增强 (GFI > 70)**：当系统检测到严重冲突或用户极端愤怒时，观察者可临时升级到更强模型进行深度语义判定，确保不漏过任何关键信号。

### 3.3 全量异步观察 (Full Asynchronous Observation)
为了解决正则预筛可能导致的“隐晦愤怒漏报”问题，系统默认对**每一条用户消息**都启动旁路观察者。由于是纯异步非阻塞，且使用了极低成本（或本地）模型，这种“大力出奇迹”的方案在成本与准确率之间达到了最优平衡。

### 3.4 并发与资源保护 (Lock & Circuit Breaker)
- **并发锁**：每个会话同一时刻仅允许一个活跃的观察者，防止刷屏攻击。
- **断路器**：如果旁路模型（特别是本地 Ollama）响应时间超过 3s 或连续失败，自动切断旁路，防止拖慢主系统，并退回轻量级语义预估模式。

---

## 4. 实施方案变更

### 阶段 1：配置更新 (config.ts)
新增 `empathy_engine.observer_model` 配置项，允许用户指定 `provider/model`。

### 阶段 2：触发分流 (Hook: `before_prompt_build`)
识别到用户消息后，通过 `EmpathyObserverManager.spawn()` 立即入队。

### 阶段 3：结果回收 (Hook: `subagent_ended`)
监听 `empathy_obs:*` 会话结束，解析 JSON 并实时更新 GFI 状态。

---
*Principles Disciple - Strategic Design Doc v3.0 (Validated for Local/Hybrid Model Orchestration)*
