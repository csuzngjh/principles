# 用户情绪痛点引擎 (User-Driven Pain Engine) 设计方案

> **版本**: 1.2.0 (OpenClaw API-Verified Proposal)
> **目标**: 赋予 Principles Disciple “数字共情”能力，将用户负面情绪（不满、责怪、挫败）转化为可控的 GFI (Global Friction Index) 信号，并确保方案对 OpenClaw 当前 Hook/API 语义可直接落地。

---

## 1. 核心挑战与设计哲学 (The "Why")

### 1.1 现状痛点：缺乏情绪感知的“冷血机器”
当前 `Pain Signal` 主要来自技术失败（命令错误、异常、死循环）。现实中更常见的是“技术成功但方向错误”：用户多次表达失望或愤怒，系统却缺乏可量化反馈，继续错误推进。

### 1.2 为什么不使用关键词/正则作为主链路
关键词方案无法可靠覆盖反讽、间接表达和上下文依赖，误伤与漏检都高。

### 1.3 设计原则
1. **模型负责语义判断**：利用 LLM 对上下文情绪的理解能力。  
2. **系统负责风控护栏**：来源校验、去重、限流、分级计分。  
3. **可审计可回滚**：所有惩罚都可追溯，不做黑箱决策。

---

## 2. OpenClaw 兼容架构（已核验）

### 2.1 Prompt 注入：使用 `before_prompt_build`

**目标文件**: `packages/openclaw-plugin/src/hooks/prompt.ts`

在 OpenClaw 中，`before_prompt_build` 可返回：
- `prependContext`
- `systemPrompt`
- `prependSystemContext`
- `appendSystemContext`

建议将“稳定共情策略”放到 `prependSystemContext`（便于系统前缀缓存），将“本轮动态提醒”放到 `prependContext`。

**建议注入内容（示意）**：
```xml
<system_override:empathy_engine>
[CRITICAL DIRECTIVE]
你必须在执行任务前先判断用户上一条消息是否包含挫败/愤怒/指责（含反讽与间接表达）。
若判定存在情绪伤害：
1) 先进行简短道歉 + 情绪安抚（承认感受、降低紧张）；
2) 复述你理解的偏差点，并给出“纠偏计划”选项（A/B）；
3) 暂停高风险改动，先澄清并等待确认；
4) 在 assistant 文本末尾追加一个不可见业务标记（legacy fallback 仍支持）。
</system_override:empathy_engine>
```

> 注意：OpenClaw 当前 `llm_output` 事件并没有“独立结构化 empathy 字段”标准位，必须由插件自行从 `assistantTexts` / `lastAssistant` 中提取信号，因此“结构化元数据”在落地上应理解为“插件可解析的结构化片段约定”，而非框架原生字段。

### 2.2 情绪捕获：使用 `llm_output`（后处理链路）

**目标文件**: `packages/openclaw-plugin/src/hooks/llm.ts`

OpenClaw 的 `llm_output` 事件可用字段（核心）：
- `assistantTexts: string[]`
- `lastAssistant?: unknown`
- `usage?: { input/output/cacheRead/cacheWrite/total }`

**落地约束（很关键）**：
- `llm_output` 在运行层是“异步触发 + 异常吞掉告警”语义，属于后处理观察钩子；
- 不应依赖它去“阻断当轮回复”；
- 它适合记录信号、更新状态、影响下一轮策略。

因此推荐流程：
1. 从 `assistantTexts.join("\n")` 提取情绪标记（优先解析结构化片段，标签为兜底）。
2. 来源校验（必须来自 assistant 输出，不接受用户注入同名标记作为等价信号）。
3. 去重（如 60 秒窗口）+ 限流（每轮/每小时上限）。
4. 分级计分（`mild/moderate/severe`），再 `trackFriction`。
5. 记录 `eventLog.recordPainSignal` 审计字段。

### 2.3 消息净化：使用 `before_message_write`

如果要避免 `[EMOTIONAL_DAMAGE_DETECTED]` 等内部标记污染会话展示，建议使用 `before_message_write`：
- 该钩子支持返回 `message`（改写）或 `block`（阻止落盘）。
- 这里可只做“标记剔除/替换”，不阻塞正常消息。

这样可同时满足：
- Hook 层可消费内部标记；
- 用户侧看到的是干净文本。

### 2.4 配置前置条件
若部署配置中将 `plugins.entries.<id>.hooks.allowPromptInjection` 设为 `false`，则 `before_prompt_build` 会被核心阻止。上线前必须确认插件注入权限开启。

---

## 3. 关键风控策略（可落地）

### 3.1 来源校验
- `assistant_self_report`: 仅来自 assistant 输出的信号（主计分）。
- `user_manual`: 用户直接输入标签或命令触发（低权重或仅审计）。

### 3.2 去重与限流
- `dedupe_window_ms`: 60s（建议）。
- `max_per_turn`: 避免流式重复触发。
- `max_per_hour`: 防止爆表。

### 3.3 分级计分
- `mild=10`
- `moderate=25`
- `severe=40`

替代固定 +50，减少噪声放大。

### 3.4 审计字段
在 `eventLog.recordPainSignal` 增加：
- `origin`, `severity`, `confidence`, `detection_mode`, `deduped`, `trigger_text_excerpt`。


### 3.5 情绪安抚响应协议（替代“只道歉”）
检测到用户挫败/愤怒时，响应必须包含 4 个元素：
- **承认情绪**：明确识别用户不满（不辩解）。
- **短句安抚**：使用降压话术（如“我理解这让你很烦，我先把范围收紧并确保不再重复这个错误”）。
- **纠偏承诺**：给出下一步可验证动作（例如“先只改 X 文件，改前先给你确认”）。
- **选择权交还**：提供 A/B 方案让用户决定推进路径。

> 实施建议：把“安抚模板”做成可配置文案片段，按 `severity` 选择不同强度，避免机械化重复。

---

## 4. 建议配置

**文件**: `.state/pain_settings.json`

```json
{
  "empathy_penalties": {
    "mild": 10,
    "moderate": 25,
    "severe": 40
  },
  "rate_limit": {
    "max_per_turn": 40,
    "max_per_hour": 120
  },
  "dedupe_window_ms": 60000,
  "manual_pain_weight": 0.2
}
```

---

## 5. 分阶段实施（按 OpenClaw 真实语义）

### Phase 1（MVP）
- `before_prompt_build` 注入共情约束。
- `llm_output` 做后处理计分（不做当轮阻断）。
- 加来源校验 + 去重 + 分级计分。

### Phase 2（可观测）
- 补齐审计字段。
- `/pd-status` 增加情绪事件卡片（次数、严重度、去重命中率）。

### Phase 3（体验）
- `before_message_write` 净化内部标记，避免 UI 污染。
- 增加人工回滚误触发能力。

### Phase 4（优化）
- A/B：固定罚分 vs 分级罚分。
- 指标：二次投诉率、回滚率、满意度、GFI 波动稳定性。

---

## 6. 实现细节清单（给开发同学）

1. **Prompt Hook**: 在 `prompt.ts` 返回 `prependSystemContext`，不要把稳定策略塞进 `prependContext`。  
2. **LLM Output Hook**: 在 `llm.ts` 从 `assistantTexts` 解析信号；`lastAssistant` 只作补充证据。  
3. **状态更新**: 仅在通过来源校验且未命中去重/限流后调用 `trackFriction`。  
4. **日志落盘**: `SystemLogger` 与 `eventLog` 同步记录，字段保持一致。  
5. **消息净化**: 使用 `before_message_write` 统一剔除内部控制标记。  
6. **配置兜底**: 若 `.state/pain_settings.json` 缺失，采用内置默认值并告警一次。

---

## 7. OpenClaw API 核验记录（外部仓库调研）

本方案已对 OpenClaw 主仓代码进行核验，结论如下：

1. `before_prompt_build` 的返回字段与合并顺序已在官方文档定义，可直接用于系统上下文注入。  
2. `llm_output` 事件结构为 `assistantTexts/lastAssistant/usage`，无原生 empathy 专用字段；需插件自定义解析。  
3. `llm_output` 在运行时为异步后处理，不适合作为“阻断当轮输出”的硬控制点。  
4. `before_message_write` 支持消息改写与阻止落盘，适合做内部标签净化。  
5. `allowPromptInjection` 配置可直接禁用 prompt 注入，属于部署前硬性检查项。

> 结论：本版方案已从“概念正确”升级为“与 OpenClaw 真实 Hook 契约对齐，可执行落地”。

---
*设计方案修订: 2026-03-16 | Spicy Evolver Architecture Team*
