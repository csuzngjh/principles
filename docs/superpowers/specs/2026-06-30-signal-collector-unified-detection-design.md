# SignalCollector — 统一信号采集层重构设计

**Date**: 2026-06-30
**Status**: Spec (pending owner approval)
**Scope**: correction + empathy 检测层重构（上游融合、下游分流）+ 接断裂 ③④ 桥
**Related**: ADR-0010（信号分层）、ADR-0014（MVP-First）、`PD_Pain_Signal_Audit.md`（断裂记录 F1/F3）、`2026-06-27-empathy-observer-cost-hint.md`（互补，UI 提示）

---

## 0. 摘要（TL;DR）

PD 当前有两套并行、互相割裂的"用户反馈检测"系统——**correction**（纠正检测，Layer 2 强信号）和 **empathy**（共情检测，Layer 3 弱信号）。经四轮代码+数据考古证实：

1. 两套系统**词表严重重叠**（`不对/错了/搞错了/redo/wrong` 两套都有），且各维护一份 seed 关键词库（correction 16 词、empathy 52 词，**LLM 发现词 = 0**）。
2. **correction 从检测到产出的整条链路有 4 处断裂**，16 天里产出 0 个样本、0 条 rejected pain、0 次 review（详见 `PD_Pain_Signal_Audit.md` F1）。
3. empathy 的 LLM 发现机制因 `ANTHROPIC_API_KEY` 未设而**从未跑过**；且存在**双轨配置割裂**——correction 走 `.pd/config.yaml`（web console 可配），empathy 走 `workflows.yaml`（web console 不碰，`.pd/config.yaml` 里的 empathy binding 是死配置）。

本设计采用**方案 B：上游融合、下游分流**——新建框架无关的 `SignalCollector`（core 纯逻辑）统一采集，本地 LLM（LMStudio）优先 + 关键词降级双保险，下游按信号强度分流（STRONG 立即触发诊断 / WEAK 走 GFI 累积），并接通 correction 的断裂 ③④ 桥。

---

## 1. 问题陈述与真实事实基础

### 1.1 当前双系统的断裂（证据已在前序对话中逐条验证）

| 断裂点 | 位置 | 现状证据（用户环境实测） |
|--------|------|------------------------|
| ① 检测召回率 0% | `correction-cue-learner.ts:97-131` 16 词子串匹配 | 26 条 user_turn 仅 1 条 `correction_detected=1`，且为误报 |
| ② 样本生成条件卡死 | `trajectory.ts:1810` 要求 `references_assistant_turn_id` 非空 | `correction_samples` 表 = 0 行 |
| ③ ★下游无产原则出口 | correction 4 个出口无一调 `emitPainDetectedEvent` | 无任何 correction 来源的 pain 触发诊断 |
| ④ rejected 桥是假桥 | `trajectory.ts:1480-1510` 只调 `recordPainEvent`（写 DB），不触发诊断 | `pain_events` 里 `source='correction_rejected'` = 0 条 |

### 1.2 配置双轨割裂（子代理调查证实）

- **CorrectionObserver**：读 `.pd/config.yaml`（`resolveObserverConfig`，`pd-config-loader.ts:211`），web console 可配（选 profile + 开关，白名单锁死 `runtimeProfile/enabled` 两字段，`pd-config-store.ts:45`）。当前 `feature flag = false`，不跑。
- **EmpathyObserver**：读 `.state/workflows.yaml` 的 `pd-empathy-observer` funnel（`prompt.ts:1108`），**web console 完全不碰**。`.pd/config.yaml` 里的 `empathyObserver` binding 是**死配置**（运行时不读）。当前 `workflows.yaml` 无此 funnel → fallback 到 `ANTHROPIC_API_KEY`（未设）→ observer = null → LLM 发现从未执行。

### 1.3 GFI 累积触发机制的现状

- empathy 关键词命中后调 `trackFriction` 累积 GFI（`prompt.ts:380`），GFI 过 `highGfiThreshold`（默认 70，`prompt.ts:375`）才 `emitPainDetectedEvent`（`prompt.ts:389`）。
- 用户环境实测：`gfi_state.current_gfi = 0.0`，`pain_events` 中 empathy 来源 = 0 条。**机制活着但从未触发**（因 observer null + 真人交互少）。
- ADR-0010 `:35-36,50` 规定 Layer 3 信号"禁止独立触发，由 GAP Generator 聚合"。GFI 累积过阈值才触发，本质上是一种"聚合"，**勉强符合 ADR 精神**。

---

## 2. 目标与非目标

### 2.1 目标

1. **上游融合**：correction 和 empathy 共享单一采集入口 `SignalCollector`，每条用户消息只跑一次检测，消除两套词库/检测器的冗余。
2. **源头升级关键词提取**：本地 LLM（LMStudio）优先做语义判断，LLM 不可用时降级为纯关键词；LLM 发现的新词回喂**一个**统一词库。
3. **下游分流**：collector 输出信号强度，STRONG（明确纠错）→ 立即触发诊断（修断裂 ③④），WEAK（情绪推测）→ 走 GFI 累积（维持现状，不让 empathy 退步）。
4. **配置单轨化**：SignalCollector 的 provider 统一走 `.pd/config.yaml` runtimeProfile，移除 empathy 的 `workflows.yaml` 分支和 `ANTHROPIC_API_KEY` 硬编码 fallback。
5. **跨框架就绪**：采集纯逻辑放 `principles-core`（框架无关），I/O 外壳放 `openclaw-plugin`，未来接其他 agent 框架时 core 零改动。

### 2.2 非目标（YAGNI / MVP 纪律）

- ❌ 不新建 runtime profile CRUD API（web console 现有"选 profile + 开关"够用，profile 本身仍手动改 YAML）
- ❌ 不重构 `correction_samples` 的人工 review / CLI / 导出运营面（留到下阶段）
- ❌ 不删除 `CorrectionCueLearner` / `empathy-keyword-matcher`（复用为 collector 子模块，避免大爆炸）
- ❌ 不动 Layer 3 WEAK 信号的"GFI 累积后才触发"规则（符合 ADR-0010，且维持现状不退步）
- ❌ 不改 web console 的成本提示 UI（已由 `2026-06-27-empathy-observer-cost-hint.md` 覆盖，零重叠）

---

## 3. 整体架构

### 3.1 Core / Plugin 分层（跨框架关键）

```
┌─ principles-core (框架无关纯逻辑) ──────────────────────────┐
│                                                             │
│  runtime-v2/signal-collector/   ← 新建                       │
│    • SignalCollector (纯逻辑, 三阶段流水线)                  │
│    • Stage1: 关键词快扫 (复用 core 已有 match 函数)          │
│    • Stage2: LLM 语义判断 (调 PDRuntimeAdapter 接口)         │
│    • Stage3: 强度分流 (输出 STRONG/WEAK + evidence)          │
│    • LLM prompt 模板 + 结果解析 (TypeBox 校验, ERR-001 防御) │
│                                                             │
│  依赖: PDRuntimeAdapter 接口 (已有, 不依赖 fs / 不依赖 openclaw) │
│        关键词匹配纯函数 (已有: empathy-keyword-matching.ts)  │
└────────────────────────┬────────────────────────────────────┘
                         │ 依赖注入 (adapter 由 plugin 提供)
┌─ openclaw-plugin ──────┴────────────────────────────────────┐
│  SignalCollectorHost (I/O 外壳, 新建)                        │
│    • 从 .pd/config.yaml 读 runtimeProfile → 构造 adapter     │
│    • 读写统一关键词库 json                                   │
│    • 接进 prompt.ts 钩子 (替代原 prompt.ts:262 + :350 两处)   │
│    • STRONG → emitPainDetectedEvent (修断裂 ③④)              │
│    • WEAK  → trackFriction 累积 GFI + 写 evidence            │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 信号流（含 WEAK 的 GFI 累积分流）

```
                    用户消息 (trigger=user)
                         │
        ┌────────────────┴────────────────┐
        │ SignalCollector (core 纯逻辑)     │ ← 统一入口, 每条消息只跑一次
        │  Stage1: 关键词快扫 (合并词库)    │   零成本, 同步
        │     命中 → 直接出结果, 不走 LLM  │
        │  Stage2: 本地 LLM 语义判断       │   关键词未命中时
        │     LLM 不可用 → 降级纯关键词    │   (本地优先 + 降级双保险)
        │  Stage3: 输出 {strength, ...}    │
        └────────────────┬────────────────┘
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
    STRONG (明确纠错)              WEAK (情绪推测)
    Layer 2 强信号                 Layer 3 弱信号
          │                             │
          ▼                             ▼
   emitPainDetectedEvent         trackFriction() 累积 GFI
   → 立即诊断 → 原则候选 ✅       写 pain_events 当证据
   [修断裂 ③④]                        │
                              GFI ≥ 阈值(70)?
                              ├─否: 停留 (维持现状)
                              └─是: emitPainDetectedEvent
                                     [聚合后触发, 符合 ADR]
```

### 3.3 关键设计决策

1. **SignalCollector 是唯一入口**，替代当前 `prompt.ts:262`（CorrectionCueLearner）和 `prompt.ts:350`（matchEmpathyKeywords）两处分散调用，合并为一次 `collect(message)`。
2. **三阶段流水线**（本地优先 + 关键词降级，用户决策）：
   - Stage 1 关键词快扫：合并 correction+empathy 词库为一套，零成本同步。**关键词分两级精度**（评审意见4）：
     - **高精度短语**（如"你不应该…/下次先确认/这是错的，因为…"）→ 命中可直接判定，不走 LLM。
     - **普通歧义词**（如"wrong/不对/搞错了"，上下文歧义大）→ 仅作 evidence 候选，**强制过 Stage2 LLM 二次确认**，不直接触发 STRONG。
   - Stage 2 本地 LLM 判断：普通歧义词命中或关键词全未命中时，调本地 LLM 判断"这是不是对 AI 行为的不满/纠错，强度多少"。LLM 不可用 → 降级纯关键词（此时普通歧义词不触发 STRONG，仅高精度短语能触发，避免误判泛滥）。
   - Stage 3 强度分流：输出 `{ isSignal, type, strength, evidence }`，按 strength 走不同下游。
   - **LLM 判断异步执行**（评审意见5）：见 §4.2，同步路径只做关键词 + 入队，LLM 不阻塞 prompt hook。
3. **Provider 配置统一为单轨**（用户决策）：SignalCollector 统一走 `.pd/config.yaml` runtimeProfile，web console binding 真正生效。移除 `resolveEmpathyObserver` 的 `workflows.yaml` 分支 + `ANTHROPIC_API_KEY` 硬编码 fallback。
4. **旧组件降级为 collector 子模块**（不删，复用）：`CorrectionCueLearner.match()` 和 `matchEmpathyKeywords()` 成为 Stage 1 的子调用，两套词库**逻辑合并**为统一 store。
5. **下游接桥**（修断裂 ③④）：STRONG 信号调 `emitPainDetectedEvent`；修复 `recordCorrectionRejectedPain` 假桥改调 `emitPainDetectedEvent`。

---

## 4. 组件设计

### 4.1 SignalCollector（core 纯逻辑）

**位置**：`packages/principles-core/src/runtime-v2/signal-collector/`

**职责**：对一条用户消息执行三阶段检测，输出结构化信号。不持有任何 I/O。

**依赖**（全部接口/纯函数，无 fs/DB/openclaw）：
- `PDRuntimeAdapter`（已有接口，`runtime-v2/adapter/`）—— Stage 2 LLM 调用
- 关键词匹配纯函数（复用 `prompt-builder/empathy-keyword-matching.ts` + `runtime-v2/correction/correction-types.ts` 的 match 逻辑）

**核心接口**：

```typescript
// 输入：用户消息 + 已注入的 adapter（可能为 null）+ 关键词库快照
interface SignalCollectorInput {
  text: string;                          // 用户消息原文（已脱敏）
  sessionId: string;
  adapter: PDRuntimeAdapter | null;      // null → Stage2 降级
  keywordStore: UnifiedKeywordStore;     // 合并后的统一词库快照（纯数据）
  config: SignalCollectorConfig;         // 阈值、开关、prompt 模板路径
}

// 输出：结构化信号
interface SignalCollectorOutput {
  isSignal: boolean;                     // 是否检测到任何反馈信号
  type: 'correction' | 'empathy' | null; // 信号类型
  strength: 'STRONG' | 'WEAK' | null;    // 强度（correction→STRONG, empathy→WEAK）
  matchedTerms: string[];                // Stage1 命中词（可能为空,表示走LLM）
  matchedPrecision: 'high' | 'ambiguous' | null;  // 命中精度(评审意见4)
  detectionSource: 'keyword' | 'llm' | 'none';    // 哪个阶段判定的
  needsLlmConfirmation: boolean;         // 普通歧义词命中→需 LLM 二次确认
  llmReason?: string;                    // LLM 判断理由（Stage2）
  evidence: {                            // 给诊断的证据片段
    excerpt: string;
    detectedAt: string;
  };
}

// 配置（纯数据,由 plugin 注入）
interface SignalCollectorConfig {
  enableLlmStage: boolean;               // Stage2 开关（默认 true）
  llmTimeoutMs: number;                  // 异步 LLM 超时（默认 30000,不阻塞 hook,见§4.2）
  promptTemplate: string;                // LLM 判断 prompt（见 4.3）
  highPrecisionTerms: string[];          // 高精度短语清单(可直接判定)
}
```

**Stage1 精度分级逻辑**（评审意见4）：
- 高精度短语命中（`matchedPrecision: 'high'`）→ 直接出 `strength`，`needsLlmConfirmation: false`。
- 普通歧义词命中（`matchedPrecision: 'ambiguous'`）→ `needsLlmConfirmation: true`，**不立即出 strength**，等 Stage2 LLM 确认。
- 全未命中 → `needsLlmConfirmation: true`（走 LLM 发现新信号）。

**降级契约**（rc-9-no-silent-fallback）：
- `adapter === null` 或 `enableLlmStage === false`：Stage2 跳过，输出 `detectionSource: 'keyword'`（或 `'none'`），并在 plugin 层日志记录降级原因（不静默）。

### 4.2 SignalCollectorHost（plugin I/O 外壳）

**位置**：`packages/openclaw-plugin/src/core/signal-collector-host.ts`

**职责**：把 core 的纯逻辑接进 openclaw 运行时。

```typescript
class SignalCollectorHost {
  // 构造时从 .pd/config.yaml 读 runtimeProfile → 构造 PDRuntimeAdapter（复用 resolveObserverConfig）
  constructor(wctx: WorkspaceContext, logger: PluginLogger) { ... }

  // ★ 同步路径（在 prompt.ts before_prompt_build 钩子里调用,绝不能阻塞）
  //    只做：trigger 门控 + Stage1 关键词快扫 + 写 user_turns
  //    不做：任何 LLM 调用
  detectSync(userMessage: string, sessionId: string, trigger: string): void {
    // 1. trigger !== 'user' → return（保留现有 trigger 门控）
    // 2. Stage1 关键词快扫（同步,零成本）
    // 3. 写 user_turns（复用 recordUserTurn,带 correctionDetected/cue）
    // 4. 高精度短语命中(high) → 直接走 STRONG 分流(同步,见下)
    // 5. 普通歧义词/未命中 → 入队异步 LLM 确认(不阻塞)
  }

  // ★ 异步路径（fire-and-forget,仿现有 prompt.ts:537 的 void scheduler.dispatch 模式）
  //    LLM 判断 + 后续分流都在这里,失败不影响用户消息处理
  private async detectAsyncAndRoute(
    pendingSignal: PendingSignal,   // 来自 detectSync 入队的候选
  ): Promise<void> {
    // 1. Stage2 LLM 确认（超时 30s,但已在后台,不阻塞用户）
    // 2. LLM 不可用 → 降级：丢弃 ambiguous 候选(不触发 STRONG),仅高精度短语保留
    // 3. 按 strength 分流:
    //    STRONG → emitPainDetectedEvent（修断裂 ③）
    //    WEAK   → trackFriction 累积 GFI + 写 evidence
    //    none   → 仅记录,无副作用
  }
}
```

**为什么必须异步（评审意见5）**：`prompt.ts` 的 `before_prompt_build` 是**同步阻塞**钩子——用户发消息后，openclaw 要等这个钩子返回才能继续构建 prompt 发给 LLM。原设计 `detectAndRoute(): Promise<void>` 同步等 LLM（默认超时 30s）会让普通用户消息卡 30 秒。现有 EmpathyObserver 已用 `void scheduler.dispatch(...)` 异步模式（`prompt.ts:537`），本设计沿用此范式。

**同步路径的唯一副作用**：高精度短语命中时直接走 STRONG 分流（极快，纯内存）。普通歧义词一律入队异步确认，绝不阻塞。

**配置读取**（消除双轨）：
- 复用 `resolveObserverConfig(workspaceDir, 'signal_collector', 'signalCollector')` —— 新增一个 internal agent name，走 `.pd/config.yaml` 同一套机制。
- 移除 `resolveEmpathyObserver` 的 `workflows.yaml` 分支（`prompt.ts:1108-1141`）和 `ANTHROPIC_API_KEY` fallback（`prompt.ts:1112-1121`）。

### 4.3 Stage 2 LLM 判断的 prompt 模板

**原则**：prompt 极简、输出结构化（JSON）、可被 TypeBox 校验（ERR-001 防御）。

```
你是一个用户反馈分类器。判断下面这条用户消息是否表达对 AI 助手行为的不满或纠正。

只输出 JSON，格式：{"is_feedback": bool, "type": "correction"|"empathy"|"none", "confidence": 0-1, "reason": "一句话理由"}

定义：
- correction：用户明确指出 AI 做错了什么、应该改什么（如"这是错的""不要自作主张""应该先确认"）
- empathy：用户表达挫败/不满情绪，但没明确指出 AI 错在哪（如"搞什么啊""又来了""算了"）
- none：正常任务指令或闲聊

用户消息：<text>
```

**LLM 输出校验**（core 层，rc-1/rc-2）：
- 用 TypeBox schema 校验 LLM 返回 JSON，校验失败 → 当作 `none` 处理 + 日志（不静默）。
- `type === 'correction'` → strength = STRONG；`type === 'empathy'` → strength = WEAK。

---

## 5. 数据流与存储

### 5.1 统一关键词库（合并）

**新文件**：`<stateDir>/signal_keywords.json`（合并 correction + empathy）

```jsonc
{
  "version": 1,
  "terms": {
    "不对":   { "category": "correction", "weight": 0.7, "source": "seed" },
    "错了":   { "category": "correction", "weight": 0.7, "source": "seed" },
    "这是错的": { "category": "correction", "weight": 0.8, "source": "seed" },
    "不要自作主张": { "category": "correction", "weight": 0.9, "source": "seed" },
    "垃圾":   { "category": "empathy", "weight": 0.6, "source": "seed" },
    "搞什么啊": { "category": "empathy", "weight": 0.6, "source": "seed" }
    // ... seed 词按 category 归类, 消除重复
  }
}
```

**迁移**：旧 `correction_keywords.json`（16 词）+ `empathy_keywords.json`（52 词）的 seed 词按 category 合并去重；新增"这是错的/不要自作主张/下次应该先"等中文纠正句式（修断裂 ① 的召回率）。

**LLM 发现词的处理（owner-governed，评审意见3）**：Stage 2 LLM 发现的新词**不直接写入触发词库**——这违反 PRODUCT_IDENTITY 的"owner-reviewed behavior internalization"核心边界（未审核的检测规则自演化会固化误判）。正确流程：
1. LLM 发现的新词写入 `signal_pending_terms.json`（候选池，source = `llm_candidate`），**不参与检测**。
2. owner/maintainer 通过 CLI 或 console 审核候选词 → promote 进 `signal_keywords.json` 的触发词库（source 标记 `owner_promoted`）。
3. 候选词带 LLM 给出的 `reason` 和 `suggestedCategory`，供 owner 决策。

这把"自动回写"改成"owner-governed promote"，符合 PD 的产品边界。

### 5.2 下游落库（复用现有表，不新增表）

- `user_turns` 表：复用，`correction_detected` 字段含义扩展为"isSignal && strength=STRONG"。
- `pain_events` 表：复用。STRONG 信号 source 用 `user_correction`（修断裂 ③）；WEAK 累积触发时 source 用 `user_empathy`（维持现状）。
- `correction_samples` 表：复用。STRONG 信号触发后，现有 `maybeCreateCorrectionSample`（`trajectory.ts:1794`）正常工作（因为断裂 ② 的 `references_assistant_turn_id` 条件会在 prompt.ts 钩子里顺带填充——见 6.2）。

### 5.3 旧 internal agent name 的迁移时序

旧的 `empathyObserver` / `correctionObserver`（`.pd/config.yaml` 的 `internalAgents.agents`）处理方式：
- **`empathyObserver`**：废弃（它是死配置，运行时从不读）。迁移期保留 YAML 键避免解析报错，但代码不再读取。web console 的 AgentCard 若仍显示它，由 cost-hint spec 的后续工作处理。
- **`correctionObserver`**：废弃（其 keyword optimization 职责被 SignalCollector 的 LLM 发现词回喂取代）。保留 YAML 键同理。
- **新增 `signalCollector`**：唯一的采集层 agent binding，web console 的 binding 对它真正生效（消除双轨）。

**迁移不破坏现有数据**：`signal_keywords.json` 是新文件；旧 `correction_keywords.json` / `empathy_keywords.json` 首次启动时一次性合并迁移（source 标记 `migrated`），之后不再读写。

---

## 6. 关键修复点（接断裂 ③④）

### 6.1 修断裂 ③ — STRONG 信号接入诊断

**当前**：correction 检测成功只写 `user_turns`，不调 `emitPainDetectedEvent`。

**修复**：`SignalCollectorHost.detectAndRoute` 中，当 `output.strength === 'STRONG'` 时：

```typescript
await emitPainDetectedEvent(wctx, {
  ts: new Date().toISOString(),
  type: 'pain_detected',
  data: {
    painId: `correction_${Date.now()}`,
    painType: 'user_correction',
    source: 'user_correction',          // Layer 2 强信号
    reason: output.llmReason || `User correction detected: ${output.matchedTerms.join(', ')}`,
    score: STRONG_PAIN_SCORE,           // 见下方取值依据
    sessionId,
    agentId: 'main',
    provenance: 'openclaw_context_bound',
    evidence: output.evidence,
  },
}, { recordObservability: true });
```

**score 取值依据**：现有 pain_events 实测分布——`manual` 平均 77.6（41-92），`owner_reported_no_host_trace` = 80，empathy GFI 触发上限 `Math.min(currentGfi, 60)`（`prompt.ts:390`）。STRONG（明确纠错，Layer 2）的可信度介于 manual（owner 亲口）和 empathy（系统推断）之间，取 **`STRONG_PAIN_SCORE = 70`**（config 可调）。这低于 manual 均值（保留 owner 亲口最高优先级），高于 empathy 上限（体现"比情绪推断更可信"），符合 ADR-0010 的 Layer 2 定位。

**符合 ADR-0010**：`user_correction` 是 Layer 2，本就允许独立触发（`:29-31`）。

### 6.2 修断裂 ② — references_assistant_turn_id 填充

`prompt.ts:281-289` 现有逻辑已会查 `listAssistantTurns` 填充该字段。断裂 ② 的真因是"唯一被检测到的纠正是会话首条消息（无前置 assistant）"。SignalCollector 接通后，真实纠正（非首条）能正常填充该字段，`maybeCreateCorrectionSample` 不再被卡。

### 6.3 修断裂 ④ — rejected 假桥

**当前**：`recordCorrectionRejectedPain`（`trajectory.ts:1480-1510`）只调 `recordPainEvent`（写 DB），不触发诊断。

**修复决策（已拍板）**：保持 `trajectory.ts` 纯 DB 层不动，**把 emit 职责上移到 CLI 层**。具体：`commands/samples.ts:38` 调用 `reviewCorrectionSample(sampleId, 'rejected')` 后，由该 CLI handler 再调一次 `emitPainDetectedEvent`（source = `correction_rejected`）。

**理由**：`trajectory.ts` 是纯 DB 层（无 wctx、无 evolution reducer 依赖），强行注入 wctx 会破坏分层。CLI handler 已持有 wctx，是 emit 的天然归属。`reviewCorrectionSample` 需返回足够信息（session_id、quality_score、diff_excerpt）供 CLI 构造 emit payload——当前返回值 `CorrectionSampleRecord`（`trajectory.ts:1416`）已含这些字段，无需改 schema。

---

## 7. 错误处理与可观测性

### 7.1 降级不静默（rc-9）

| 场景 | 行为 | 可观测 |
|------|------|--------|
| 本地 LLM 不可用（LMStudio 没跑） | Stage2 降级纯关键词 | SystemLogger `SIGNAL_LLM_DEGRADED` + reason |
| LLM 返回非法 JSON | 当 `none` 处理 | SystemLogger `SIGNAL_LLM_PARSE_FAIL` + 原文截断 |
| 关键词库读失败 | 用内置默认 seed | SystemLogger `KEYWORD_STORE_LOAD_FAIL` |
| STRONG 触发 emitPainDetectedEvent 失败 | 不阻断用户消息处理 | SystemLogger `SIGNAL_EMIT_FAIL`（catch，不 throw） |

### 7.2 误判校准（本地 LLM 质量风险）

**风险**：本地模型（Qwen3.6-27B）判断不准，可能把弱信号误判成 STRONG 导致诊断泛滥，或漏掉真纠正。

**本次 scope 内的缓解**：
1. **STRONG 信号 rate limit**：单个 session 每小时最多触发 N 次 STRONG → emitPainDetectedEvent（防泛滥，N 可配，默认 5）。这是对 `emitPainDetectedEvent` 调用点的简单计数门控，不引入新子系统。
2. **可观测指标**（写 event_log，复用现有 `recordError`）：每小时统计 `detectionSource=keyword vs llm`、`strength=STRONG vs WEAK vs none` 分布。owner 可在 console 看到分布异常。

**降级到未来（超出本次 scope）**：
- ❌ GFI 熔断（短时间 GFI 飙升触发 cooldown）——这是对现有 GFI 机制的新改造，超出"检测层+接桥"范围。列为 follow-up，待本次接桥后观察 GFI 实际行为再决定是否需要。

### 7.3 ERR 合规

| ERR | 防御措施 |
|-----|---------|
| ERR-001（as 绕过） | LLM 输出用 TypeBox 校验，不用 `as` |
| ERR-002（静默降级） | 所有降级路径走 SystemLogger（见 7.1） |
| ERR-014/016（不安全序列化） | evidence excerpt 用 `safeStringifyPreview`，限长 |
| rc-5（Object.hasOwn） | 关键词库字段检查用 `Object.hasOwn`，不用 `in` |

---

## 8. 配置契约

### 8.1 `.pd/config.yaml` 新增 internal agent

```yaml
internalAgents:
  defaultRuntime: pi-ai.sensenova   # 或 pi-ai.lmstudio
  agents:
    signalCollector:                 # 新增（替代 empathyObserver + correctionObserver 的 binding 死配置）
      enabled: true
      runtimeProfile: pi-ai.lmstudio # 推荐指向本地（成本敏感场景）
  runtimeProfiles:
    pi-ai.lmstudio:
      type: pi-ai
      provider: lmstudio
      model: qwen3.6-27b-mtp
      apiKeyEnv: LMSTUDIO_API_KEY    # LMStudio 本地通常随便填
      baseUrl: http://127.0.0.1:12341/v1
      timeoutMs: 30000
```

**LMStudio 兼容性已验证（实现可行性前提）**：`PiAiRuntimeAdapter.resolveModel`（`principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts:104-145`）原生支持自定义 OpenAI 兼容 provider——当 provider 不在内置注册表（`lmstudio` 不在）且提供了 `baseUrl` 时，自动构造 `api: 'openai-completions'` 的 Model 对象。这正是 `openclaw.json` 里 lmstudio 的现有配置方式（`api: openai-completions, baseUrl: /v1, port 12341`）。**无需改 adapter，仅需 config.yaml 指向它。**

### 8.2 feature flag 注册（ADR-0014 MVP 纪律，评审意见2）

新增 feature flag `signal_collector`（**category: quiet, enabled: false** —— dogfood-only 默认关）。

**为什么是 quiet 而非 core（评审意见2纠正）**：
- `INTERNAL_AGENT_NAMES`（`principles-core/src/runtime-v2/config/pd-config-types.ts:64-73`）是 `as const` 封闭列表，目前不含 `signalCollector`。新增它要牵动 config schema、console metadata、installer、doctor、测试矩阵——**这不是只加 YAML，是 schema 变更**。
- 我原设计写 `core, enabled: true` 并声称"flag 改 false 即回退"，但新增 InternalAgentName 本身不可逆，rollback 路径是假的。
- **正确做法**：先以 `quiet` + 默认关 ship，在 owner 的 dogfood 环境手动 `enabled: true` 验证一段时间，确认无误判泛滥后再考虑升 core。这符合 ADR-0014 "新功能默认 MVP-Quiet（off + flag-registered）"。

旧的 `empathy_observer` / `correction_observer` flag 保留但标记 deprecated（运行时不再读，留作迁移期兼容）。

**Feature flag 注册依赖**：按 AGENTS.md，`PRI-239`（feature flag registry）需先合并。本设计的 flag 注册动作在 PRI-239 合并后执行；在那之前，配置可读但不上线新 flag 文件（遵循"bug fix / 配置对齐可先行"例外）。

**InternalAgentName schema 变更清单**（quiet ship 也要做，但作为一次性 schema 扩展，不随每次部署开关）：
- `pd-config-types.ts:64-73`：`INTERNAL_AGENT_NAMES` 数组追加 `'signalCollector'`
- console metadata（AgentCard 列表）：新增 signalCollector 行
- installer / doctor：新工作区初始化时写入 signalCollector quiet 默认值
- 测试矩阵：config 解析测试覆盖新 name

---

## 9. 测试策略

### 9.1 core 纯逻辑测试（`principles-core`，无 I/O）

- **Stage 1 关键词快扫**：mock `UnifiedKeywordStore`，验证 correction/empathy 词命中正确归类。
- **Stage 2 LLM 判断**：mock `PDRuntimeAdapter`，验证合法/非法/超时 JSON 的处理（rc-1/rc-9）。
- **Stage 3 分流**：验证 correction→STRONG、empathy→WEAK、none 的映射。
- **降级**：`adapter=null` 时走纯关键词，输出 `detectionSource='keyword'`。
- **架构回归**：`signal-collector/` 下所有文件无 `import fs`（加入 architecture-regression 白名单检查）。

### 9.2 plugin I/O 外壳测试

- **配置读取**：mock `.pd/config.yaml`，验证 `signalCollector` binding 正确解析为 adapter。
- **接桥**：mock `emitPainDetectedEvent`，验证 STRONG 信号触发、WEAK 走 trackFriction。
- **集成**：用真实 `prompt.ts` 钩子，喂入前序对话验证的 3 条铁证消息：
  - "你又自作主张了，这是错的！" → 应判 STRONG → 触发（修断裂 ① 的召回）
  - "搞什么啊" → 应判 WEAK → 累积 GFI
  - "[System] gateway restart..." → 应判 none（修误报）

### 9.3 验收标准（owner-visible，评审意见6 纠正）

**主验收标准（必须满足）**：
1. 用前序验证的 id=942 真纠正消息，SignalCollector 判定 STRONG 且 `emitPainDetectedEvent` 被调用（可在 event_log 看到 `source='user_correction'`）。
2. **该 user_correction pain event 触发了诊断任务创建**（tasks 表出现新 diagnostician task，`input_ref` 关联到该 pain）——这是"断裂 ③ 真接通"的直接证据。
3. **诊断 evidence 带上前置 assistant turn**（验证断裂 ② 的 `references_assistant_turn_id` 正确填充，evidence chain 完整）。
4. LMStudio 不可用时，系统降级为纯关键词不报错，且 SystemLogger 有记录；**普通歧义词在降级模式下不触发 STRONG**（避免误判泛滥）。
5. `.pd/config.yaml` 里改 `signalCollector.runtimeProfile` 能真正改变检测用的 LLM（配置单轨生效）。
6. **prompt hook 不阻塞**：从用户消息到 openclaw 开始构建 prompt 的延迟 < 200ms（验证意见5 的异步化生效）。

**二级验收标准（软指标，不强求）**：
- `correction_samples` 表从 0 增长——**不作为主验收**（评审意见6：依赖会话结构/时序，不够稳）。仅作为接通后的副作用观察。

---

## 10. 改动清单（供 writing-plans 细化）

### 新建
- `packages/principles-core/src/runtime-v2/signal-collector/`（SignalCollector + types + tests）
- `packages/openclaw-plugin/src/core/signal-collector-host.ts`（I/O 外壳）

### 修改
- `packages/openclaw-plugin/src/hooks/prompt.ts`：合并 `:262` + `:350` 两处为 `SignalCollectorHost.detectSync`（同步）+ `detectAsyncAndRoute`（异步）调用；移除 `resolveEmpathyObserver` 的 workflows.yaml 分支 + ANTHROPIC fallback（`:1106-1148`）。
- `packages/openclaw-plugin/src/core/trajectory.ts`：`recordCorrectionRejectedPain` 配合 host 层 emit（断裂 ④）。
- `packages/openclaw-plugin/src/commands/samples.ts`：reject 路径加 emitPainDetectedEvent（断裂 ④）。
- `packages/principles-core/src/runtime-v2/config/pd-config-types.ts`：`INTERNAL_AGENT_NAMES` 追加 `'signalCollector'`（评审意见2 schema 变更）。

### 配置/数据
- `.pd/config.yaml`：新增 `signalCollector` agent binding + runtimeProfile（指向本地 LMStudio）。
- `signal_keywords.json`：新建统一触发词库（合并 + 补中文纠正句式）。
- `signal_pending_terms.json`：新建候选词池（LLM 发现词暂存，owner 审核后 promote，评审意见3）。
- feature flag：`signal_collector`（**quiet, enabled: false** —— 待 PRI-239）。

### 不动（明确边界）
- `CorrectionCueLearner` / `empathy-keyword-matcher`：保留，降级为子模块。
- `correction_samples` 表 schema：不改。
- web console UI：不改（由 cost-hint spec 覆盖）。

---

## 11. 风险与权衡

| 风险 | 等级 | 缓解 |
|------|------|------|
| 本地 LLM 误判导致诊断泛滥 | 中 | STRONG rate limit（7.2，本次 scope）；GFI 熔断列为 follow-up |
| 重构碰 MVP-Core（prompt.ts 已 1148 行） | 中 | 只合并两处调用点，不重写 prompt.ts；SignalCollector 抽到 core |
| 旧 `empathyObserver`/`correctionObserver` 配置残留误导 | 低 | 废弃但保留 YAML 键；文档说明迁移到 `signalCollector`（§5.3） |
| feature flag registry (PRI-239) 未合并 | 低 | 配置可读先行，flag 文件待 PRI-239（§8.2） |
| correction_samples 表填充依赖 `references_assistant_turn_id` | 低 | SignalCollector 接通后真实纠正（非首条）能正常填充（§6.2） |
| LMStudio 服务未启动（本地 LLM 不可用） | 低 | 降级纯关键词不报错（7.1），SystemLogger 记录；用户需自行保证 LMStudio 运行 |

---

## 12. MVP Decision Gate（PRODUCT_IDENTITY.md）

1. **改善治理循环哪一步**：behavior evidence 采集（第一步）——让强信号真正进入诊断。
2. **owner-visible evidence**：真纠正消息触发诊断任务（可在 console 看到），`correction_samples` 从 0 增长。
3. **disable/rollback/defer**：`signal_collector` feature flag（config 改 enabled:false 即回退到旧行为）。
4. **是否复制 host 能力**：否，信号采集是 PD 自有职责。
5. **emotional value**：降低**失控感**（owner 的纠正终于被听见）、**重复纠正感**（同一类纠正会被沉淀成原则）；创造**沉淀感**（反馈不丢失）。符合 emotional-value §核心承诺。

---

## 附录 A：与前序考古证据的对应

- 断裂 ①②③④ → 第 1.1 节 + 第 6 节
- 配置双轨 → 第 1.2 节 + 第 4.2 节 + 第 8 节
- GFI 累积现状 → 第 1.3 节 + 第 3.2 节
- 方案 A/B/C 对比 → 已在对话中讨论，本设计采用 B
