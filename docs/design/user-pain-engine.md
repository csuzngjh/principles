# 用户情绪痛点引擎 (User-Driven Pain Engine) 设计方案

> **版本**: 1.1.0 (Revised Proposal)
> **目标**: 赋予 Principles Disciple “数字共情”能力，将用户的负面情绪（不满、责怪、挫败）量化并转化为驱动智能体自我进化的 GFI (Global Friction Index)，同时保证可控、可审计、可回滚。

---

## 1. 核心挑战与设计哲学 (The "Why")

### 1.1 现状痛点：缺乏情绪感知的“冷血机器”
目前系统收集的 `Pain Signal`（痛点信号）主要依赖技术层面的错误捕获（如 `exitCode !== 0`、报错、死循环）。
**现实盲区**：代码可能没有报错，但方向已偏离用户预期。用户在聊天里表达“你完全搞错了我的意思”“怎么又改这个文件”，系统若只看技术异常，GFI 仍可能为低值，导致智能体继续在错误方向“高置信度推进”。

### 1.2 为什么不采用“关键词/正则匹配”作为主方案？
仅靠钩子中监听“错了”“笨蛋”“🤬”会产生脆弱性：
- 无法稳健识别**反讽**与上下文依赖语义。
- 无法可靠识别**间接挫败感**（重复提醒、范围约束被忽略）。
- **误伤率高**：用户可能在复述日志或引用他人语句。

### 1.3 核心设计理念：模型自省 + 结构化回传 + 系统护栏
大模型具备语义与情绪判断能力。本方案不引入额外高延迟分析链路，而采用：
1. 在 Prompt 注入“先评估情绪”的高优先级行为约束。
2. 由模型回传**结构化情绪元数据**（优先）或兼容标签（次级）。
3. Hook 层执行来源校验、去重限流、分级计分，再更新 GFI 与事件日志。

> 设计原则：**情绪信号可用，但不放任；可惩罚，但需可解释；可演进，但可回滚。**

---

## 2. 系统架构设计 (The "How")

本方案基于 **Prompt 约束 + LLM 识别 + Hook 护栏 + 状态机更新 + 看板审计** 的闭环架构实现。

### 2.1 注入“共情引擎”约束 (Prompt Injection)

**修改文件**: `packages/openclaw-plugin/src/hooks/prompt.ts`

在系统提示词构建阶段 (`before_prompt_build`)，注入高优先级指令，要求模型：
- 先评估用户上一条消息的情绪状态。
- 在响应元数据中回传结构化字段（而非在正文暴露内部控制标签）。
- 若判定存在情绪伤害，先道歉，再进行反思（如调用 `deep_reflect`）。

**建议注入片段（示意）**:
```xml
<system_override:empathy_engine>
[CRITICAL DIRECTIVE]
在执行任务前，你必须先评估用户上一条消息的情绪状态。
若识别到挫败/愤怒/指责（包括反讽与间接表达），请在响应元数据中返回：
{
  "empathy": {
    "damageDetected": true,
    "severity": "mild|moderate|severe",
    "confidence": 0.0-1.0,
    "reason": "简短原因"
  }
}
若 damageDetected=true：
1) 先进行诚恳且简短的道歉；
2) 再调用 deep_reflect 分析偏离用户预期的根因；
3) 暂停继续推进高风险改动，先与用户对齐意图。
</system_override:empathy_engine>
```

> 兼容策略：若模型暂不支持元数据通道，允许输出 `[EMOTIONAL_DAMAGE_DETECTED]` 作为降级信号，但仅作为次级路径处理。

### 2.2 捕获“情绪信号”并执行护栏 (Hook Interception + Guardrails)

**修改文件**: `packages/openclaw-plugin/src/hooks/llm.ts`（`llm_output` 钩子）

**核心执行逻辑（升级点）**：
1. **优先读取结构化元数据**（如 `event.meta.empathy.*`）。
2. 若无元数据，再解析 legacy 标签 `[EMOTIONAL_DAMAGE_DETECTED]`。
3. **来源校验**：仅接受 assistant 当前轮输出触发；用户输入中的同名标签记为 `manual_pain_request`。
4. **去重与限流**：同一会话短窗口内去重，单轮/单小时惩罚上限。
5. **分级计分**：按 `severity` 映射惩罚分，替代固定 +50。

**示意逻辑**:
```typescript
const empathy = extractEmpathySignal(event); // meta first, tag fallback
if (!empathy.detected) return;

if (!isAssistantOrigin(event)) {
  eventLog.recordPainSignal(sessionId, { source: 'user_manual', origin: 'user_manual' });
  return;
}

if (isDuplicatedWithinWindow(sessionId, empathy)) {
  recordAudit({ deduped: true });
  return;
}

const score = mapSeverityToPenalty(empathy.severity, settings.empathy_penalties);
const boundedScore = applyRateLimit(sessionId, score, settings.rate_limit);

trackFriction(sessionId, boundedScore, 'user_emotional_pain', ctx.workspaceDir);
eventLog.recordPainSignal(sessionId, {
  score: boundedScore,
  source: 'user_empathy',
  origin: 'assistant_self_report',
  severity: empathy.severity,
  confidence: empathy.confidence,
  detection_mode: empathy.mode, // structured | legacy_tag
  deduped: false
});
```

### 2.3 UI 输出净化（防标签污染）

**目标**：内部控制信号不应污染用户可见输出。

- 在消息写入链路增加输出净化：过滤 legacy 标签。
- 若处于调试模式，可在开发日志保留原始内容。
- 默认用户界面仅显示“道歉 + 对齐动作”，不显示内部暗号。

### 2.4 状态机流转与下游联动 (Feedback Loop)

情绪惩罚写入 GFI 后，下游将自动感知：
1. **`/pd-status` 看板**：展示 GFI 变化与“情绪事件”统计卡片（24h 次数、严重度分布、去重命中率）。
2. **EvolutionWorker**：将 `user_empathy` 事件纳入原则生成素材，但按来源和置信度加权，避免被恶意输入主导。
3. **策略层**：在情绪高压区间触发“先澄清后执行”的安全工作流。

---

## 3. 边缘场景与健壮性考量 (Edge Cases & Robustness)

### 3.1 用户伪造暗号 / Prompt Injection
**风险**：用户输入中直接包含 `[EMOTIONAL_DAMAGE_DETECTED]` 试图刷分。  
**策略**：
- 不按同权重直接计入 `assistant_self_report`。
- 记录为 `manual_pain_request` 事件，默认低权重或仅审计。
- 看板分开展示，避免污染主质量信号。

### 3.2 连续触发导致 GFI“爆表”
**风险**：流式重复片段或短时多轮触发导致异常累加。  
**策略**：
- 去重窗口（建议 30–120 秒）。
- 单轮最大增量、单小时最大增量。
- 严重度分级取代固定罚分。

### 3.3 误判与漏判
**风险**：模型情绪识别并非总是准确。  
**策略**：
- 记录 `confidence` 与 `reason`，支持后续抽样复盘。
- 允许人工回滚单次事件并统计“误触发回滚率”。
- 逐步调参而非一次性重惩罚。

### 3.4 正向情绪扩展（可选）
可扩展 `[USER_DELIGHT_DETECTED]` 或结构化 `delightDetected` 通道：
- 清理失败连击、恢复部分信任分；
- 但必须独立于惩罚链路，避免“奖惩互相覆盖”导致可解释性下降。

---

## 4. 配置与数据模型建议

### 4.1 配置文件（建议）
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

### 4.2 事件日志字段（建议）
为 `eventLog.recordPainSignal` 增加字段：
- `origin`: `assistant_self_report | user_manual | system_infer`
- `severity`: `mild | moderate | severe`
- `confidence`: `0.0 ~ 1.0`
- `detection_mode`: `structured | legacy_tag`
- `trigger_text_excerpt`: 脱敏短摘要
- `deduped`: `true | false`

---

## 5. 实施阶段建议 (Rollout Plan)

### Phase 1: 受控 MVP（建议先做）
- Prompt 注入结构化情绪约束。
- `llm_output` 实现：元数据优先 + 标签兜底。
- 上线最小护栏：来源校验 + 去重窗口 + 分级计分。
- 看板新增基础统计（触发次数、严重度分布）。

### Phase 2: 配置化与审计完善
- 启用 `.state/pain_settings.json` 动态参数。
- 完善事件字段与审计日志。
- 增加人工回滚与误触发追踪。

### Phase 3: 双向情绪通道
- 增加正向情绪奖励通道（delight）。
- 与 EvolutionWorker 联动形成“惩罚-修复-奖励”闭环。

### Phase 4: A/B 与阈值优化
- 对比固定惩罚 vs 分级惩罚策略。
- 评估指标：用户二次投诉率、回滚率、任务完成满意度、GFI 波动稳定性。

---

## 6. 采纳结论

该方案值得推进，但应以**受控上线**替代“明文标签 + 固定重罚”的一次性激进上线。推荐优先落地：
1. 结构化信号通道（标签仅兜底）；
2. 来源校验与去重限流；
3. 分级惩罚与可观测审计；
4. 看板可解释展示与人工回滚能力。

---
*设计方案修订: 2026-03-16 | Spicy Evolver Architecture Team*
