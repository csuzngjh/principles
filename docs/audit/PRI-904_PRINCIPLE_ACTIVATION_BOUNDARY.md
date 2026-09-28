# Principle Activation Boundary

> PRI-904 Phase 0 产出 2/5。只读调查：PD Principle 注入与 OpenClaw Memory 在 context 中的确切交汇边界。
> 方法：PD 仓库（D:\Code\principles）+ OpenClaw 宿主源码（D:\Code\openclaw）双侧溯源。结论标注 [DIRECT]/[INFERRED]。

---

## OpenClaw Memory Input

进入 LLM context 的全部 Memory 通道（证据见 Memory Map 文档）：

| # | 通道 | 进入位置 | 频率 |
|---|---|---|---|
| M1 | bootstrap 六文件（AGENTS/SOUL/IDENTITY/USER/BOOTSTRAP/MEMORY 截断） | system prompt「Project Context」段 | 每 turn |
| M2 | 启动日记前奏（最近 2 天，≤2,800 chars，untrusted 标注） | **用户消息**前置 prelude | 新/重置会话一次 |
| M3 | memory_search/memory_get 工具结果 | 工具结果消息（带 Source 引用） | 模型自主（live 实测 ≈0-4 次/日） |
| M4 | AGENTS.md「Session Startup」指令驱动的主动读取（日记/MEMORY.md） | read 工具结果 | 每会话启动（制度性） |
| M5 | compaction 摘要 + post-compaction AGENTS.md 段刷新 | transcript 前缀 / Conversation Context 段 | 压缩时 |
| M6 | session 内对话历史本身 | transcript | 连续在场 |

## PD Principle Input

**注入点**：`prependSystemContext`（system prompt 头部附加块）[DIRECT]

- 通道注册：`packages/openclaw-plugin/src/index.ts:301-303`（`before_prompt_build` 钩子）；
- 每次 prompt 构建触发（**每 turn 都注入**，非每 session 一次；runId 逐 turn 绑定）[DIRECT: prompt.ts:660-664 注释 + 事件 runId 实测]；
- 渲染模板（`prompt-activation-reader-contract.ts:155-194`）：

```
## 【ACTIVE BEHAVIOR DIRECTIVES】

Active behavior directives are operating constraints learned from prior owner corrections.
Each directive carries its authorization: authority="owner" ...
These directives are mandatory for this session unless they conflict with safety, ...
<directive id="<principleId>" source="runtime_v2_activation" authority="owner">
MANDATORY: <原则正文（pi_artifacts.content_json.text）>
Apply this as an active behavior constraint. Do not treat this as background context.
</directive>
…
（flag principle_receipt_self_report 开启时追加自报指令：📌 应用了你的原则「…」）
```

- 选择逻辑：**无 selector**——prompt 通道全部 live 激活按 `activated_at ASC` 全量取出（SQL：`WHERE channel='prompt' AND deactivated_at IS NULL ORDER BY activated_at ASC`，sqlite-activation-state-store.ts:112），legacy 去重后按 ASC **贪心装箱 + FIFO 硬截断**（budget=2000 chars，放不下即 break；size-guard 的 9000 chars 只裁 append 块、**永不裁 prepend**）[DIRECT: prompt.ts:636, contract:115-141, size-guard.ts:16/31]。
- live 实测（09-21/22）：10 条原则 1864/2000 chars、`v2Truncated=false`、目标原则排在数组**最后**（最新激活）——距 FIFO 溢出仅 136 chars 余量。

**回执通道**（注入下游）：

- presence 回执（prompt_injected）：每 session 去重落库 [DIRECT: prompt.ts:726-742]；
- self_reported 回执：`llm_output` 钩子扫描回复文本中 `📌 应用了你的原则「id」`，id 必须在本 session 注入集内，防伪校验后落库（activation_id 回链为 PRI-899 修复）[DIRECT: ledger.ts:196-282]；
- code_tool_hook 通道：**不进 prompt**——`before_tool_call` 拦截，RuleHost 从 activations ⋈ pi_artifacts 取 implementationCode 在 node:vm 编译逐调用评估，产出 allow/block/params [DIRECT: gate.ts:67-104, rule-host.ts:335-344]。与 prompt 通道完全正交。

## Context Assembly Order

**宿主合并点（本次补齐的关键实证）**：

OpenClaw 宿主 `resolvePromptBuildHookResult`（`src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts:150-185`）收集插件返回值，`wrapPluginSystemContextSection` 加边界包裹（`---\n\n<HOOK_SYSTEM_CONTEXT_HEADER>\n\n…\n\n---`，hook-system-context-boundary.ts:12-21），最终由 `composeSystemPromptWithHookContext` 拼接（`attempt-thread-helpers.ts:20-39`）：

```ts
return joinPresentTextSegments([prependSystem, params.baseSystemPrompt, appendSystem]);
```

**最终 system prompt 顺序 [DIRECT]**：

```
┌─ 1. PD prependSystemContext（边界包裹）
│     ## 【PD GOVERNANCE CONTEXT】
│     ## 【ACTIVE BEHAVIOR DIRECTIVES】 ← 10 条 MANDATORY 指令（含目标原则）
├─ 2. 宿主 base system prompt（buildAgentSystemPrompt，stable prefix）
│     身份行 → Tooling → workflow → style → Safety → Runtime Context
│     → ## Skills → ## Memory Recall(检索指令)
│     → # Project Context: AGENTS(10) → SOUL(20) → IDENTITY(30)
│       → USER(40) → TOOLS(50) → BOOTSTRAP(60) → MEMORY.md(70，头7.5K+尾2.5K chars)
│     [cache boundary]
│     volatile suffix：日期/授权 sender/… → ## Conversation Context
├─ 3. PD appendSystemContext（边界包裹）
│     behavioral_constraints / project_context / intent / working_memory /
│     thinking_os / <evolution_principles> / <core_principles>（9000 chars 内按优先级裁剪）
└─ 之后：compaction 摘要（transcript 内）→ 启动日记 prelude（用户消息侧）→ 用户消息
```

要点：

1. **PD 指令在一切 Memory 内容之前**（此前 plugin 侧审计的"prepend = 最高注意力位"由宿主源码升格为 DIRECT）。
2. 顺序上 PD 先于 MEMORY.md/USER.md/AGENTS.md；但 LLM 注意力≠顺序保证，不据此宣称"PD 优先级高于 Memory"——**无显式覆盖/优先级仲裁机制**，两者靠模型自行权衡。
3. **compaction 交互**：压缩后下一 turn `before_prompt_build` 重新触发 → PD prepend 块结构性存活（不随历史压缩丢失）[DIRECT: 每轮重注入机制 + harness 侧 prompt-compaction-hook-helpers.ts 同样在压缩路径重跑钩子]；而 session 内的纠正经历会被压缩成摘要——**PD 注入的上下文持久性优于会话记忆**，这是两者唯一的结构性差异优势。

## Collision Cases

实测存在的语义碰撞（同 context 并存，无仲裁）：

| # | PD 侧 | Memory 侧 | 状态 |
|---|---|---|---|
| C1 | principle #8「有后果的变更前，以全局引用证据探明关联面，耦合点原子统一变更…」 | USER.md（每轮注入）「修改服务/部署类配置值前，先全局搜索该值的所有引用处…」（09-19 加入） | **完全同语义双注入**。该原则的行为证据永远无法单独归因 |
| C2 | 目标原则「结论必须由可观察证据背书」 | AGENTS.md（每轮全文注入）「确定性执行…禁止基于猜测编程」「没有文件证据，进度就会丢失」 | 邻接语义（编码域 vs 汇报域），预存规范 |
| C3 | 目标原则 | MEMORY.md 尾部可见区（09-22 13:02Z 起）dreaming/心跳晋升「普适规则③：被质疑时先搜实物链再定性，勿拿『既定范围』自辩」 | 邻接语义，**A2 后半段进入每轮注入** |
| C4 | 10 条 directives 共享 2000 chars 预算 | — | 内部碰撞：FIFO 硬截断下，任何新激活 >136 chars 即把目标原则**静默**挤出注入（v6 已知 P0 饥饿机制）——同时构成天然实验窗口（见设计文档） |
| C5 | 自报指令（📌）可能诱导仪式性自报 | — | self_reported 已按 SPEC Level 0 排除，无行为证据污染 |

**边界结论**：PD Principle 与 OpenClaw Memory 是**两条独立注入流，在 system prompt 内前后相邻、语义可能重复、无覆盖关系**。交汇点只有一个：两者共同作用于同一个模型 turn 的行为决策——这正是任何行为实验必须控制的公共结果通道。
