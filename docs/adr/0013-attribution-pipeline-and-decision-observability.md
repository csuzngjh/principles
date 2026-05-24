# ADR-0013: Attribution Pipeline and Decision Observability

> **Status**: ⚠️ **Superseded by ADR-0014 — Deferred**（2026-05-24）
> **Date**: 2026-05-24（initial Proposed → Deferred 同日）
> **Reason for Defer**: PD 进入 MVP-First 阶段（ADR-0014）。Attribution Pipeline 的实施依赖真实种子客户的使用数据；在零外部用户的情况下构建会变成基于推演的 mock。
> **Restart Conditions**: 见 [docs/plans/post-mvp-conditional-roadmap.md §1](../plans/post-mvp-conditional-roadmap.md)
> **Original Status**: Proposed
> **Influenced by**: AHE (Agentic Harness Engineering, 2026-04 preprint) — three-pillar observability model

> **重要提示**：本 ADR 的概念分析仍然有价值（特别是 §3.1.1 PrincipleScopeSignature 与 §3.1.2 BaselineRateProvider 的 baseline 设计），保留作为未来重启时的输入。但**当前不实施**。任何 Linear issue 引用本 ADR 要求即时实施时，必须先核对 post-mvp-conditional-roadmap.md §1 的重启条件是否真实满足，并先与维护者确认。


## 1. Context

PD 的 Pain → Diagnosis → Internalization → Activation 链路已落地并通过 baseline / live / chaos 验证。但系统在"激活之后"立即失明：一个 principle 被注入 prompt 或一个 RuleHost 实现被启用之后，PD 没有任何机制衡量：

1. 它声称要消除的痛苦类别在后续观测窗口内是否真的减少了；
2. 同一窗口内是否引入了新类别的痛苦；
3. 它和其他 active principles 之间是否在打架。

这导致几个具体的失控：

- L1 容量只能依靠 LRU + cap = 12（PRI-139）兜底——无效但被频繁触发的原则会一直占住 cap。
- 三振出局（PRI-141）只能捕获**人类显式拒绝**的循环失败，沉默无效不可见。
- Pruning 决策依赖 `lifecycleEvidence`，但 evidence 是启发式估算，没有"实证测量"。
- Diagnostician 是无记忆的——每次跑都从空白开始，反复发明同类原则。

把这一缺口对照 AHE 论文的三支柱框架，缺的是 **Decision Observability**：每个激活动作必须是可证伪契约，下一轮观测裁决 keep / improve / rollback。

## 2. Decision

引入 **Attribution Pipeline** 作为 PD 的第四条数据流，与 Pain / Internalization / Activation 流水线并列。

```
[active principle X]
       │
       ▼ (固定观测窗口)
[ActivationOutcomeAttribution]
   ├ painsEliminated:   该 principle 声称要消除的类别中实际减少了多少
   ├ painsIntroduced:   同一窗口内新增的、可归因到该 principle 的痛苦
   ├ adherenceObserved: 实际行为与原则触发条件的偏差
   ├ conflictWith[]:    与哪些其他 active principles 在同窗口被同时违反
   └ verdict:           confirmed | uncertain | regressed
       │
       ├──────────────────┬──────────────────┐
       ▼                  ▼                  ▼
   auto-archive       update            re-diagnose
   (regressed)        adherence/        (uncertain → 重新挂诊断任务)
                      learning summary
                      (confirmed)
```

同时引入两个支撑组件：

- **WorkspaceLearningSummary**：跨会话的元经验视图，注入下一轮 Diagnostician prompt。
- **Activation Probation Window**：approval → fully active 之间的过渡态，attribution 数据决定是否真正成 active。

## 3. Architecture

### 3.1 新组件清单

| 组件 | 类型 | 包 | 状态 |
|------|------|---|------|
| `AttributionWindowScheduler` | 🔵 Service | core | 待建 |
| `ActivationOutcomeAttribution` | 📋 Schema + 🟡 Store | core | 待建 |
| `PainAttributionResolver` | 🔧 Util | core | 待建 |
| `PrincipleScopeSignature` | 📋 Schema | core | 待建 |
| `BaselineRateProvider` | 🔵 Service | core | 待建 |
| `ConflictDetector` | 🔧 Util | core | 待建 |
| `AttributionVerdictDispatcher` | 🔵 Service | core | 待建 |
| `WorkspaceLearningSummaryReadModel` | 🟣 ReadModel | core | 待建 |
| `LearningSummaryPromptInjector` | 🔧 Util | core | 待建 |
| `ProbationActiveStateMachine` | 🔧 Util | core | 待建 |
| `BundledProvenanceTagger` | 🔧 Util | core | 待建 |
| `AttributionShadowMode` | 🔵 Service | core | 待建（启动期默认开启）|

### 3.1.1 PrincipleScopeSignature（关键：决定 attribution 怎么归因）

> **设计动机（v2.0 review 补充）**: 仅靠 `PainCategory` 这种粗类（tool_failure/user_correction）做归因会让所有 tool_failure pain 互相错配。我们需要一个**更细的等价类签名**来判定"两个 pain 是不是同一类"。

```typescript
interface PrincipleScopeSignature {
  /** 粗类，来自 GAP layer（兜底信号） */
  painCategory: PainCategory;
  /** 工具范围：principle 声称要影响的工具集 */
  affectedToolNames: string[];
  /** 触发条件的归一化指纹，例如 "tool_call::write_file::path_under(/etc/)" */
  triggerFingerprint: string;
  /** 原则 derivedFromPainIds 中各 painId 的根因哈希集合（用于精确 mat ching）|
  rootCauseHashes: string[];
}

// 两个 pain 属于同一 scope 的判定（按 v 优先级）
//   v1 (强): rootCauseHashes 交集非空（相同根因）
//   v2 (中): triggerFingerprint 一致 + painCategory 一致
//   v3 (弱): 仅 painCategory 一致 → 不计入归因（噪声过大）
```

**重要**: MVP (PRI-232) 只用 v1 + v2；v3 一律不计入归因。如果某 principle 没有可计算的 rootCauseHashes（旧数据 / bundled 默认信号缺失），整个 principle 不进入 attribution（保守 fail-safe）。

### 3.1.2 BaselineRateProvider（关键：解决 PRRR baseline 定义）

PRRR 的核心难题是：激活后没法和"未激活时的同一刻同 agent"对比，因为时间不可回。我们使用**三段式 baseline**：

| Baseline 策略 | 适用条件 | 计算方法 |
|--------------|---------|---------|
| **B-Pre**：激活前等长窗口 | 工作区有 ≥ 1 个完整 pre-activation 窗口的同 scope pain 数据 | 取 principle 激活前 N 个工具调用的同 scope pain 计数 |
| **B-Workspace**：工作区滚动均值 | B-Pre 不可用（新工作区 / pain 太少） | 取过去 14 天工作区内同 scope pain 的滚动 P50 速率 |
| **B-None**：无 baseline | 工作区数据严重不足（< 10 同 scope pain in 14d） | verdict 强制 = uncertain（不下结论）|

实施细节：

```typescript
type BaselineKind = 'pre_activation' | 'workspace_rolling' | 'none';

interface BaselineSnapshot {
  kind: BaselineKind;
  paneSize: number;              // baseline 窗口长度（工具调用数）
  painCountInPane: number;       // baseline 期内同 scope pain 数
  ratePerThousand: number;       // 归一化速率
  capturedAt: string;
  fallbackReason?: string;       // 如果不是 pre_activation 为什么 fall back
}

// PRRR 计算（修订版）
interface PRRRComputeInput {
  baseline: BaselineSnapshot;
  observed: { painCountInWindow: number; windowSize: number };
}

function computePRRR(input: PRRRComputeInput): PRRRResult {
  // 边界 1: baseline.kind === 'none' → verdict='uncertain'
  // 边界 2: baseline.painCountInPane === 0 → 不能除零
  //          降级为绝对数比较：if observed.painCount > 0 → verdict='regressed'
  //                            else verdict='confirmed' with low confidence
  // 边界 3: observed.rate > baseline.rate → 负 PRRR → verdict='regressed'
  //          PRRR 字段截断到 [-1, 1] 区间
  // 标准: PRRR = max(-1, min(1, 1 - observed.rate / baseline.rate))
}
```

### 3.1.3 painsIntroduced 归因规则

新增的 pain **不**自动归责给所有 active principles。唯一被归因为"X 引入"的条件：

1. 该 pain 发生在工具调用 T 之中
2. principle X 的 trigger 条件在生成 T 的 trajectory 段被命中（actually fired）
3. 同窗口内没有其他更新的 active principle 在该 pain 上有更紧匹配的 trigger

如果同窗口被多个 principle 命中且没有"更紧匹配"的判别能力，pain 计为"shared"——不计入任何单一 principle 的 painsIntroduced，但记录到工作区级 `sharedPainEvents` 字段供 R5 冲突检测使用。

实施保守优先：**MVP 阶段，painsIntroduced 计数仅在条件 1 + 条件 2 严格满足时计入**；模糊归因 → 不计入。这意味着 MVP 的 verdict=regressed 会保守低估 false positive。

### 3.2 数据契约

```typescript
type AttributionVerdict =
  | { kind: 'confirmed'; pRecurrenceReduction: number; adherenceObserved: number }
  | { kind: 'uncertain'; reason: 'insufficient_signal' | 'window_too_short'; nextWindowAt: string }
  | { kind: 'regressed'; painDeltaIntroduced: number; conflictWith: string[]; rationale: string };

interface ActivationOutcomeAttribution {
  attributionId: string;          // 确定性: hash(principleId, windowId)
  principleId: string;
  windowId: string;               // 例如 "2026-05-24T10:00Z..2026-05-24T11:00Z" 或 "tools_500..tools_600"
  windowKind: 'time' | 'tool_count' | 'pain_count';
  windowStartAt: string;
  windowEndAt: string;
  paneSizes: { before: number; after: number };
  painsEliminatedCategories: PainCategoryDelta[];   // 该原则 derivedFromPainIds 对应类别
  painsIntroducedCategories: PainCategoryDelta[];   // 同窗口内新增类别
  adherenceObserved: number;       // 0..1, 基于 trajectory 中触发条件的实际命中
  conflictWith: ConflictPair[];
  verdict: AttributionVerdict;
  evidenceTraceRefs: string[];     // 指向 trajectory 关键证据
  computedAt: string;
}

interface PainCategoryDelta {
  category: string;            // PainCategory enum
  countBefore: number;
  countAfter: number;
  delta: number;               // negative = improved
}

interface ConflictPair {
  otherPrincipleId: string;
  conflictKind: 'co_violated' | 'mutually_exclusive_action' | 'same_trigger_different_action';
  observationCount: number;
}
```

### 3.3 状态机扩展

`LedgerPrincipleEntry.status` 从原 5 状态扩展为 6 状态：

```
candidate ──→ probation ──→ probation_active ──→ active ──→ archived
                                  │                  │           ▲
                                  │                  │           │
                                  │                  │           ├── verdict=regressed (auto, evolved only)
                                  │                  │           ├── human reject from active
                                  │                  │           └── manual archive command
                                  │                  │
                                  │                  └─→ probation_active (refresh window)
                                  │                       (rare; manual override only)
                                  │
                                  ├── verdict=confirmed ─→ active
                                  ├── verdict=regressed ─→ archived
                                  ├── verdict=uncertain (×3) ─→ probation_review (new sub-status, manual queue)
                                  └── human reject from probation_active ─→ archived
```

**关键设计澄清（v2.0 review 补充）**:

- **MVP 兼容路径**: PRI-232 MVP 只发 `regressed`。在 PRI-232 → PRI-235 过渡期间，MVP 会发 `verdict=confirmed_no_baseline`（一种特殊 confirmed），让 PRI-235 引入的 STATE-2 在仅 MVP 已部署、PRI-232 升级版尚未上线时仍能让 principle 升到 active，避免永久卡住。

- **probation_review 子状态**: uncertain × 3 后进入此状态，等待人工 review。pd-console 显示。本 ADR 不展开实现，作为 PRI-236 后续延伸。

新增不变量（修订版）：

- `STATE-1`：`probation → active` 必须经过 `probation_active`，时间或工具调用次数 ≥ 配置最小值。
- `STATE-2`：`probation_active → active` 仅在以下任一条件时合法：
  - attribution `verdict.kind ∈ {'confirmed', 'confirmed_no_baseline'}`，**或**
  - 操作员显式发起 `pd activation promote --confirm`（写审计日志）
- `STATE-3`：`probation_active → archived` 唯一合法路径是 attribution `verdict=regressed` 或人工 reject。
- `STATE-4`：`active → archived (auto)` 必须由 attribution verdict=regressed + provenance=evolved 同时满足。
- `STATE-5`：任何被 attribution 错误归档的 principle，**必须可由人工通过 `pd principle restore <id> --confirm` 恢复至 probation_active（不是直接 active）**，并且 restore 操作记录在审计日志，下次 attribution 自动跳过该 principle 一个完整窗口（防止立即被同类 verdict 再次归档）。

### 3.4 观测窗口策略

| 通道 | 默认窗口 kind | 默认窗口大小 | 最小 verdict 样本 |
|-----|--------------|------------|----------------|
| prompt | tool_count | 100 工具调用 | 至少 5 次 trigger 命中 |
| skill | tool_count | 200 工具调用 | 至少 5 次 trigger 命中 |
| code_tool_hook | tool_count | 50 工具调用（更高频） | 至少 3 次 gate 决策 |
| model_training | time | N/A — 模型训练通道不进入 attribution（独立评估）|
| defer_archive | N/A — 不需要 |

如果窗口结束时样本不足，verdict=uncertain，自动延长一次窗口；连续 3 次 uncertain 视为低价值 → 进入人工 review 队列。

### 3.5 Attribution 何时不适用

以下情况 attribution 不进行裁决：

- principle.provenance = `bundled`（PD 项目级预装的基础原则）
- principle 创建时间 < 24h（避免噪声）
- 工作区内总 pain count 过低（最近 24h < 10）→ 整个工作区 attribution 暂停
- principle 缺少有效 PrincipleScopeSignature（rootCauseHashes 为空且 triggerFingerprint 不可计算）→ 整个 principle 永远 verdict=uncertain，进入人工 review 队列
- principle 在过去 30 天内被 `pd principle restore` 恢复过 → 跳过下一个完整窗口（防止 attribution 抖动）

### 3.5.1 Shadow Mode（MVP 默认开启）★ 新增

> **设计动机（v2.0 review 补充）**: AHE 论文实证 attribution 自身也会有错（regression precision 仅 11.8%）。直接上 auto-archive 是高风险。MVP 必须先 shadow 验证。

实施分三阶段：

1. **Shadow Mode（默认 30 天）**：Attribution 计算并写入 `activation_outcome_attributions`，但 `verdict=regressed` **不**触发 auto-archive；只发 telemetry + 在 pd-console 上展示"如果上线会被归档"的列表，由人工抽样校准。
2. **Half-live（默认 30 天）**：仅对 confidence ≥ 0.9（多窗口连续 regressed）+ provenance=evolved 的 principle 触发 auto-archive；其他仍走 shadow。
3. **Full-live**：condition 1+2 数据通过校准（人工抽样 false positive < 5%）后启用全量 auto-archive。

| 配置 | 默认值 | 描述 |
|-----|-------|------|
| `attribution.shadow_mode` | `true` (启动时) | 开/关 shadow |
| `attribution.shadow_min_verdicts_before_live` | 50 | 至少 50 个 verdict 通过抽样后才能切到 live |
| `attribution.shadow_max_false_positive_rate` | 0.05 | 抽样 false positive 超阈值禁止切 live |
| `attribution.regress_confidence_threshold` | 0.7 (shadow) / 0.9 (half-live) | regressed 触发 archive 的最低 confidence |

shadow → half-live → full-live 切换必须人工 `pd attribution mode set --confirm`，不允许自动升级。

### 3.6 与现有组件的关系（更新）

| 现有组件 | 关系 |
|---------|------|
| `LifecycleEvidence` (现) | 保留；其字段 `lastTriggeredAt`、`triggerCount` 由 attribution 自动维护 |
| `RoutingPolicy` (现) | 保留；新增对 attribution `confidence` 信号的读取 |
| `RolloutReviewerRunner` (现) | **不变**——它仍负责"激活前"判断；attribution 是"激活后"裁决 |
| `PruningReadModel` (现) | 保留作为人工 review 入口；attribution 是其自动化版本 |
| `ApprovalQueue` (现) | 保留；approve 后进入 probation_active 而非直接 active |
| `Auto-Promotion by Confidence (PRI-145)` | **协调 (v2.0 修订)**：PRI-145 当前在 RolloutReviewer 阶段跳过 approval。本 ADR 改为：跳过 approval 仍允许，但**不**跳过 probation_active 阶段——所有自动通过的 principle 仍要先进入 probation 受 attribution 验证。即 `auto-promotion` 仅替代 *human approval*，不替代 *probation window*。需要在 PRI-235 中显式实现这一协调。 |
| `RejectionFeedbackService` (PRI-148) | 保留；它处理"人工显式 reject"；attribution 处理"沉默无效" |
| `ThreeStrikesOut` (PRI-141) | 保留；它在 dreamer 创建前；attribution 在激活后；二者互补 |

### 3.7 archivedReason 规范化（避免双路径冲突）★ 新增

PD 现在有 4 个 archive 来源，每个必须使用规范化前缀：

| 来源 | archivedReason 前缀 | 触发者 |
|------|-------------------|--------|
| Attribution auto-archive | `attribution_regressed:{windowId}` | system (PRI-232) |
| 人工 reject from approval queue | `human_rejected:{userId}:{approvalId}` | actor=human (PRI-148) |
| 人工 pruning review approve | `pruning_review:{reviewId}:{userId}` | actor=human (existing) |
| 操作员手工归档 | `manual_archive:{userId}:{reason}` | actor=human (existing) |
| LRU eviction (cap 触发) | `lru_eviction:{evictedAt}` | system (PRI-139) |

**冲突处理**：如果一条 principle 在同一时间收到两个 archive 信号（例如 attribution=regressed 与人工 reject 同时），**人工优先**；attribution 写入会检测当前 status 并在 `status=archived` 时跳过（idempotent no-op），不重写 archivedReason。

## 4. Why this and not alternatives

| 替代方案 | 拒绝理由 |
|---------|---------|
| 让 Diagnostician 自归因（每次出 verdict） | AHE 数据：fix prediction precision 33.7% 但 regression precision 仅 11.8%。Diagnostician 对副作用是盲的；归因必须由"系统裁决"而非"代理自评" |
| 完全依靠人工 Pruning Action | 人工瓶颈，无法跟上每个 active principle 的窗口；阻塞 R3 闭合 |
| 把 attribution 直接嵌入 RolloutReviewer | RolloutReviewer 是激活前；attribution 是激活后；语义混淆会让审计困难 |
| 不做 probation_active，直接复用 lifecycleEvidence | 缺少"已批准但试运行中"的明确语义；UI 与权限边界都会乱 |
| 把 attribution 数据写入新物理目录 | 违反 PRI-205 决议；继续走 SQLite metadata + JSON ledger |

## 5. Consequences

### Positive

- L1 容量自动收敛到"实际有效原则集"，R3（Decoupling Loop）真正闭合。
- Pruning Pipeline 不再依赖人工启发式 review；只在 attribution=uncertain 三次时才升级到人工。
- Diagnostician 跨会话有记忆，避免重复发明同类原则。
- 决策可观测性补齐 → PD 第一次具备完整的 AHE 三支柱。

### Negative / Cost

- 增加每个 active principle 的存储开销（每个窗口一个 attribution 记录）。缓解：attribution append-only 但提供周期归档。
- 新增对 trajectory 数据的可靠读出依赖（PRI-118 必须先做扎实）。
- WorkspaceLearningSummary 注入会增加 Diagnostician prompt 长度。缓解：summary 严格 token 预算（默认 ≤ 500 token），超出时 LRU 截断最旧的 verdict。

## 6. Guardrails

新增架构守护测试断言：

- `ATTRIBUTION-1`：Attribution Pipeline 不得直接修改 `Ledger.principles[id].status`；必须通过 `ActivationDispatcher.deactivate(reason='attribution_regressed:<windowId>')`。
- `ATTRIBUTION-2`：Attribution verdict 写入幂等键 = `(principleId, windowId)`；重复写返回 `ALREADY_COMPUTED`。
- `ATTRIBUTION-3`：Attribution 不得读取/修改 `provenance=bundled` 的 principle；不得对缺少 PrincipleScopeSignature 的 principle 下 `regressed` 裁决。
- `ATTRIBUTION-4`（新增）：Shadow mode 下 verdict=regressed **不得**触发 ActivationDispatcher.deactivate。架构守护测试用 mock dispatcher 校验。
- `ATTRIBUTION-5`（新增）：archivedReason 必须命中表 §3.7 中规范化前缀的 enum。
- `ATTRIBUTION-6`（新增）：在同一 principle 已 status=archived 时，attribution 写入必须是 idempotent no-op（不更新 archivedReason）。
- `LEARN-1`：`WorkspaceLearningSummary` 是只读视图，禁止写入 API。
- `LEARN-2`：`LearningSummaryPromptInjector` 必须强制 token 预算（默认 500），超出时按时间倒序截断。
- `LEARN-3`（新增）：summary 缺失 / 计算失败时，Diagnostician prompt 仍应可用（fail-open with structured warning），不允许因 summary 失败 fail-close 阻塞 Diagnostician。
- `STATE-1` 至 `STATE-5`：见 §3.3。
- `RESTORE-1`（新增）：`pd principle restore` 命令成功后，下次 attribution 必须跳过该 principle 一个完整窗口。
- `BUNDLED-1`：见 PRI-234；attribution + auto-archive 都必须跳过 bundled。

## 7. Implementation phases（修订版）

按 docs/plans/2026-05-roadmap/06-ahe-informed-architecture-review.md §5 执行：

1. **Phase 1C-1: Attribution Shadow MVP**（PRI-232）
   - 计算并写入 verdict
   - **强制 shadow mode**，不触发 auto-archive
   - 30 天观察期 + 至少 50 个 verdict 经人工抽样
   - 退出条件：抽样 false positive < 5%

2. **Phase 1C-2: Attribution Half-live**（PRI-232 第二阶段，可拆为独立 issue）
   - 仅 confidence ≥ 0.9 + provenance=evolved 触发 auto-archive
   - 还需要 PRI-234 (provenance) 完成

3. **Phase 1D-1**：WorkspaceLearningSummary（PRI-233）+ Bundled provenance（PRI-234）+ Probation Window（PRI-235）

4. **Phase 1D-2**：Pruning Action MVP via Attribution（PRI-236）— 替代当前的"等待独立人工 Pruning Action"。要求 Phase 1C-2 通过抽样校准。

## 8. Out of scope

- 不引入 LLM-based attribution。verdict 只来自结构化 trajectory + pain delta；不做"让另一个 LLM 评判"。
- 不引入 cross-workspace attribution。learning 是工作区局部的；跨工作区聚合是 Phase 3+ 议题。
- 不替代 ApprovalQueue 或 RejectionFeedback。这些都保留。

## 9. References

- AHE: "Agentic Harness Engineering: Observability-Driven Automatic Evolution of Coding-Agent Harnesses"（特别是 §3.3 Decision Observability 与 §4.4.2 Self-Attribution Reliability）
- ADR-0006 §2.6 RejectionFeedback（本 ADR 的姐妹流程）
- ADR-0010 GAP（attribution 的 pain category 取自此处）
- PD_System_Dynamics_Model.md R3/R4/R5（本 ADR 是 R4 在工程层的具象化）
