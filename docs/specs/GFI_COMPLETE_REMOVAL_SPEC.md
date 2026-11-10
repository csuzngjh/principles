# GFI_COMPLETE_REMOVAL_SPEC

## v1.3 — Complete Removal & Behavioral Preservation（v1.1/v1.2 设计条款保留；DC-01 方案 A 已批准，Post-Implementation Closure 见 §15）

| 属性 | 内容 |
|---|---|
| SPEC ID | GFI-COMPLETE-REMOVAL-001 |
| Version | 1.3（代码实施已合并；DC-01 方案 A 已批准并完成 SPEC 对齐；见 §15 Post-Implementation Closure） |
| Status | **Partially Implemented** — 生产逻辑/DB/CLI/Console 已移除（PR #2332）；纯防御性 `gone` 墓碑经 Owner 批准保留；GFI-1 历史 JSON 迁移未实施（PRI-1149） |
| Priority | P1 |
| Target | Principles Disciple |
| Strategy | Complete Removal + Behavior-Preserving Simplification |
| Compatibility | No GFI Legacy Compatibility |
| Data Integrity | Preserve All Non-GFI Data |
| Deployment | Explicit Owner Authorization |

---

# 1. Executive Objective

## 1.1 核心目标

彻底移除 GFI（General Friction Index）及其相关的生产实现、数据结构、计算机制、状态管理、接口和展示。

本次不是关闭 GFI，不是保留 GFI 作为只读观测模块，也不是将 GFI 改名为另一个指标。

**GFI 必须从 PD 的运行时架构中彻底消失。**

同时，本次工作不能退化为单纯删除代码。

需要借此机会：

1. 消除重复状态和重复统计。
2. 消除没有实际业务价值的评分计算。
3. 消除 Correction Detection 与情绪识别之间的语义混淆。
4. 恢复原始工具事实作为唯一事实来源。
5. 保留 Session 生命周期及 Principle Receipt。
6. 保留全部 Pain、Diagnostician、Principle 和 RuleHost 核心能力。
7. 改进 `/pd-status` 和运行健康观测的真实性。
8. 减少跨包依赖、公共接口和维护负担。

## 1.2 最终架构原则

```text
Tool Execution
    |
    +-- Tool Call
    +-- Success / Failure
    +-- Error Evidence
    +-- Gate Block
    |
    +-- Raw Trajectory
            |
            +-- Behavior Evidence

Owner Correction
    |
    +-- Correction Detection
    +-- Stage 2 Confirmation
    +-- Pending State Machine
    +-- Evidence Verification
    |
    +-- Pain Admission
            |
            +-- Diagnostician
                    |
                    +-- Candidate
                    +-- Principle Intake
                    +-- Principle Ledger

Principle Activation
    |
    +-- RuleHost
    +-- Runtime Enforcement
    +-- Injection Receipt
    +-- Behavior Evidence
```

GFI 不再出现在任何链路中。

---

# 2. 核心设计约束

## 2.1 删除评分，不删除事实

必须严格区分：

| 对象 | 处理 |
|---|---|
| 工具执行失败 | 保留 |
| 工具执行成功 | 保留 |
| 错误类型 | 保留 |
| 错误原因 | 保留 |
| 重复错误原始记录 | 保留 |
| Gate Block | 保留 |
| GFI 分数 | 删除 |
| GFI 来源权重 | 删除 |
| GFI 重复错误倍率 | 删除 |
| GFI 衰减 | 删除 |
| GFI 恢复 | 删除 |
| GFI 阈值 | 删除 |

同一错误可以在真实轨迹中出现多次，但不再将其累加为一个虚构的摩擦指数。

## 2.2 不建立替代评分系统

明确禁止：

- 新增 Tool Failure Score。
- 新增 Agent Fatigue Score。
- 新增 Behavior Friction Score。
- 新增多维综合健康评分。
- 用工具失败次数直接触发 Pain。
- 用工具失败次数直接影响 RuleHost 决策。

允许展示真实统计数据，例如：

- 工具调用总数。
- 成功次数。
- 失败次数。
- 失败率及其统计窗口。
- 不同宿主的执行情况。
- Gate Block 次数。

这些都是事实统计，不是行为评分。

## 2.3 现有功能不变量

必须保持：

- Owner Manual Pain。
- Correction Detection。
- Stage 2 LLM Confirmation。
- Pending State Machine。
- PainIngress。
- Diagnostician。
- Candidate Generation。
- Principle Intake。
- Principle Ledger。
- RuleHost。
- EP。
- Principle Injection。
- Receipt。
- OpenClaw / Codex / WorkBuddy 三宿主能力。

---

# 3. 完整删除清单

## 3.1 Core GFI Kernel

删除：

`packages/principles-core/src/runtime-v2/gfi/`

包括：

- gfi-types.ts
- gfi-policy.ts
- gfi-kernel.ts
- gfi-read-model.ts
- 专属测试和 Fixture。

删除所有 GFI 公共 API：

- GfiState
- GfiEvent
- GfiPolicy
- GfiSnapshot
- GfiStats
- GfiWorkspaceSnapshot
- GfiWorkspaceHealthAssessment
- applyFriction
- applyRelief
- applyDecay
- classifyGfiStage
- createGfiSnapshot
- buildGfiWorkspaceSnapshot
- classifyGfiWorkspaceHealth
- DEFAULT_GFI_POLICY

同步清理：

- runtime-v2/index.ts
- 公共 API 导出。
- architecture-regression tests。
- runtime-v2-barrel-surface.json。
- golden-trace.ts 中的 currentGfi 默认值。
- 其他引用 GFI 类型的测试。

不得保留 deprecated export 或空壳。

## 3.2 Session Tracker

目标：

`packages/openclaw-plugin/src/core/session-tracker.ts`

删除纯 GFI 状态：

- currentGfi
- gfiBySource
- lastErrorHash
- lastErrorSource
- consecutiveErrors（仅限 SessionState 中 GFI 专用字段）
- lastGfiDecayAt
- dailyGfiPeak

删除函数：

- trackFriction
- resetFriction
- decayGfi
- getGfiDecayElapsed
- toGfiState
- applyGfiResult
- 所有 GFI Kernel Adapter。

同时删除经消费者扫描确认没有实际使用的 Session 日统计 API：

- getDailySummary
- resetDailyStats
- dailyToolCalls
- dailyToolFailures
- dailyPainSignals

特别说明：当前 dailyToolFailures 由 trackFriction 写入，但 trackFriction 同时接收工具失败、WEAK 和手动 Pain 信号，统计语义并不准确。该计数没有独立生产消费者，不应继续保留。

### 必须保留

Session Tracker 不是 GFI 子系统。

以下功能必须原样保留：

- Session 创建和恢复。
- lastActivityAt。
- lastControlActivityAt。
- toolReadsByFile。
- llmTurns。
- blockedAttempts。
- totalInputTokens。
- totalOutputTokens。
- cacheHits。
- stuckLoops。
- injectedPrincipleIds。
- injectedActivationIds。
- receiptAutoCorrects。
- Session 持久化与清理。
- Principle Injection Receipt。

### Session 活动时间保护

原先 trackFriction / resetFriction 同时负责更新 Session 活动时间。

删除后不得让工具执行事件失去活动时间更新。

新增最小职责函数：

`trackSessionControlActivity(sessionId, workspaceDir?)`

只负责：

1. 获取或创建 Session。
2. 更新 lastActivityAt。
3. 更新 lastControlActivityAt。
4. 调度 Session 持久化。

不计算分数，不维护统计账本。

在原有工具成功、失败和 Owner 手动 Pain 路径中，替换原先由 GFI 函数附带完成的 Session 活动更新。

不得修改其他 Session 生命周期策略。

## 3.3 Tool Call Recording

目标：

`packages/openclaw-plugin/src/hooks/after-tool-call-helpers.ts`

原有两个函数：

- handleFrictionTrackingForFailure
- handleFrictionTrackingForSuccess

改为纯工具事实记录职责。

可以保留成功和失败两个明确函数，也可以在确认行为一致后合并为一个 recordToolCallOutcome。

删除：

- GFI 累积。
- GFI 恢复。
- gfiBefore。
- gfiAfter。
- GFI 来源分类。
- 重复错误倍率。
- GFI 专属 EventLog 数据。

保留：

- toolName。
- outcome。
- durationMs。
- exitCode。
- errorType。
- errorMessage。
- paramsJson（现有脱敏逻辑）。
- resultPreview。
- runId。
- toolCallId。
- hostKind。
- sessionId。
- 原有去重、关联和事务语义。

### 额外死代码清理

当前：

- ToolCallObservation.painScore。
- computePainScore。
- packages/openclaw-plugin/src/core/pain.ts。

代码检索显示 computePainScore 只有 after-tool-call 观察构造路径使用，painScore 没有实际生产消费者。

实施前再次核实：

如果全仓确认无有效消费者，则一并删除：

- painScore。
- computePainScore。
- 仅用于该计算的字段。
- 专属测试。

如果 errorHash、relPath 或 isRisk 还有非 GFI 消费者，必须保留其对应功能，不能因为同属 ToolCallObservation 就批量删除。

## 3.4 Manual Pain

目标：

`packages/openclaw-plugin/src/hooks/pain.ts`

删除：

```ts
trackFriction(sessionId, 100, 'manual_pain', ...);
```

但必须完整保留：

- MANUAL_PAIN 日志。
- EventLog.recordPainSignal。
- trajectory.recordPainEvent。
- canonicalPainId。
- buildManualPainObservation。
- evaluateEvidenceTriage。
- evaluateTriggerController。
- PainIngress。
- Diagnostician Task。
- correctionEvidence。
- 诊断任务幂等和 cooldown。

如果删除 GFI 调用导致 Session 活动时间不再更新，使用纯 Session 活动函数补齐。

Owner 手动报告 Pain 的行为和结果不得改变。

## 3.5 LLM Hook

目标：

`packages/openclaw-plugin/src/hooks/llm.ts`

删除 GFI 自动 Pain 分支：

- highGfiThreshold。
- currentGfi 判断。
- isGfiTriggered。
- painScore 覆盖。
- user_empathy GFI 自动来源。
- GFI 触发理由。
- GFI 自动 Pain 的事件写入。
- 仅服务于上述逻辑的配置和 import。

不能只删除 if 条件而留下无意义的 painScore 计算、空分支或写入代码。

保留：

- trackLlmOutput。
- Token Usage。
- stuckLoops 效率观察。
- assistant_turn 轨迹记录。
- task_outcome 轨迹记录。
- 独立 Empathy Rollback。
- 其他非 GFI LLM 功能。

Empathy Rollback 中原先用于回退 GFI 的 resetFriction 调用删除，但原有 rollback 事件及其实际独立行为必须保留。

## 3.6 Prompt Hook

目标：

`packages/openclaw-plugin/src/hooks/prompt.ts`

删除：

- Manual Pain Clearance 的 GFI 清零。
- decayGfi。
- getGfiDecayElapsed。
- Heartbeat GFI 衰减。
- GFI 日志。
- GFI import。

明确保留：

`buildIntentFrictionBlock`

Intent Engineering 不属于 GFI，不得误删。

同时保留：

- Principle Injection。
- Reflection Log。
- Project Context。
- 其他 Prompt Budget 和注入控制。

## 3.7 Correction Detection 语义收敛

这是本次架构简化的重要组成部分。

目标：

- packages/principles-core/src/runtime-v2/signal-collector/
- packages/openclaw-plugin/src/core/signal-collector-host.ts

当前代码仍存在：

- KeywordCategory = correction | empathy。
- LLM type = correction | empathy | none。
- SignalStrength = STRONG | WEAK。
- WEAK → trackFriction。
- LLM 不可用时 empathy ambiguous → WEAK。
- suggestedType = correction | empathy。

这与之前 Pain SPEC v0.2/v0.3 的语义决策不一致。

### 新契约

Correction Detection 只负责识别纠正：

```text
Correction
    |
    +-- STRONG
    |      |
    |      +-- Existing STRONG admission
    |
    +-- AMBIGUOUS
           |
           +-- Stage 2 LLM
           +-- Pending
           +-- Confirmed / Rejected / Abandoned
```

删除：

- Correction Collector 中的 empathy 类别。
- WEAK 类型。
- routeWeak。
- WEAK → GFI。
- empathy ambiguous → GFI fallback。
- LLM empathy 分类结果。
- 仅服务于该路径的 WEAK 测试和代码。

将 LLM 分类契约收敛为 correction / none。

同步更新：

- SignalCollectorOutput。
- LlmClassificationResult。
- SignalClassificationOutput Schema。
- LLM Prompt。
- Keyword Store。
- Pending suggestedType。
- 所有三宿主消费者。

如修改了公开的 `signal-classification-output-v1`，使用新的 v2 契约并删除旧版定义，不保留旧版兼容适配。

### 必须保留

- STRONG 识别。
- AMBIGUOUS 识别。
- P-1 引用、否定和转述防护。
- P-2 学习词门。
- P-3 置信度门。
- Stage 2 Worker。
- Pending CAS。
- Retry。
- TTL。
- Owner Correction 证据回写。
- 三宿主统一分类和准入。
- 同步 Hook 零 LLM。

当 LLM 不可用时，纠正候选继续走已有 Pending 机制，不能重新退化成 WEAK，也不能静默升级为 STRONG。

原有独立 Empathy Engine、Empathy Event、Empathy Rollback 和 `/pd-status empathy` 完整保留。

## 3.8 RuleHost

删除：

- RuleHostInput.session.currentGfi。
- RuleInputEnrichment.currentGfi。
- currentGfi 默认值 0。
- _getCurrentGfi。
- GFI enrichment。
- GFI 专属测试 Fixture。

目标：

- packages/principles-core/src/runtime-v2/internalization/rule-host-contracts.ts
- packages/host-runtime/src/production-rulehost-gate.ts
- packages/openclaw-plugin/src/hooks/gate.ts

### 必须保留

- EP Tier。
- bashRisk。
- estimatedLineChanges。
- workspace。
- canonicalKind。
- recoveryControl。
- RuleContextV2。
- Tool Semantic Registry。
- Gate Block。
- RuleHost 安全约束。
- RuleCode Safety Circuit Breaker。
- Auto Correct。
- Approval。
- Receipt。

不要因为删除 GFI 而删除 RuleCode Safety Circuit Breaker 中独立的 consecutiveErrors。

### 外部 RuleCode

内置规则目前未发现有效 currentGfi 业务消费者。

但 Owner 实际工作区的已激活 RuleCode 尚须只读扫描。

如果存在 currentGfi 依赖：

1. 找到具体规则。
2. 删除 GFI 判断条件。
3. 保留其他独立规则条件。
4. 重新编译。
5. 重新执行 RuleHost 决策矩阵。

不得保留 currentGfi = 0 兼容字段。

---

# 4. Observability / CLI / Console

## 4.1 EventLog

目标：

- packages/principles-core/src/runtime-v2/types/event-types.ts
- packages/openclaw-plugin/src/core/event-log.ts

删除：

- ToolCallEventData.gfi。
- gfiBefore。
- gfiAfter。
- ToolCallEventData.consecutiveErrors（确认仅为 GFI 统计用途后）。
- DailyStats.gfi。
- stats.gfi.samples。
- stats.gfi.total。
- stats.gfi.peak。
- 所有 GFI 统计聚合。

保留：

- stats.tools。
- tools.total。
- tools.success。
- tools.failure。
- stats.empathy。
- stats.hooks。
- stats.evolution。
- 所有其他有效统计。

对 `.state/logs/daily-stats.json` 执行局部清理：仅删除 gfi 子对象，不改变其他统计。

历史 `events_*.jsonl` 保持 append-only，不篡改历史记录。

## 4.2 Operator Health

目标：

`packages/principles-core/src/runtime-v2/operator-health-read-model.ts`

删除：

- GFI Read Model。
- readPersistedSessions 中的 GFI 解析。
- GFI Workspace Snapshot。
- GFI Health Classification。
- GFI 对 overallStatus 的影响。
- GFI recommendedActions。

保留：

- Pain Chain。
- Candidate Ledger Audit。
- Pruning。
- Orphan Candidate。
- 数据库状态。
- 现有诊断任务状态。

overallStatus 只依据剩余有效健康检查。

不得把 GFI degraded 简单映射成 healthy；必须彻底移除 GFI 对状态计算的影响。

## 4.3 CLI

删除：

- runtime-gfi-snapshot.ts。
- pd runtime health gfi。
- GFI snapshot 相关命令注册。
- runtime-canary 中 gfi_snapshot。
- runtime-diagnostics-export 中 gfi-snapshot 工件。

修改：

- runtime-health-snapshot.ts：删除 GFI 区块。
- runtime-canary.ts：删除 GFI flag 判断和 GFI 健康检查。
- runtime-diagnostics-export.ts：删除 GFI 状态采集和输出。

保留：

- Schema Conformance。
- Candidate Audit。
- Pruning。
- Internalization Queue。
- Pain Chain Integrity。
- 其他健康检查。

不要新增另一个综合评分 Canary。

## 4.4 Console

目标：

`packages/pd-console/src/server/models/HealthCheckModel.ts`

删除：

- checkGfiHealth。
- gfi_health。
- GFI HealthCheck DTO。
- GFI 展示组件和 API 字段。

保留：

- SQLite。
- Pain Chain。
- Task Queue。
- Principle Tree。
- 其他真实健康检查。

如果现有 SQLite 检查没有覆盖 trajectory.db，可以复用已有 Schema Conformance 能力补充数据可用性检查，但不能增加 GFI 替代评分。

同时清理：

`packages/pd-console/src/server/types/index.ts`

中的 GFI 专属字段，例如 EmpathyEvent.gfiAfter。

GateBlockItem.gateType 中的历史 `gfi` 类型必须先核实其语义：如果只是历史 Gate 分类，可以在读取时映射为中性历史类型；不得误删真实 Gate Block 记录或安全行为。

## 4.5 /pd-status

保留 `/pd-status` 命令。

保留：

- `/pd-status data`
- `/pd-status empathy`

删除：

- GFI 进度条。
- Mental Mode。
- 疲劳判断。
- GFI 健康等级。
- `/pd-status reset`。

重新组织默认状态输出，使用已有真实数据：

| 指标 | 数据来源 |
|---|---|
| 当前 Session | Session Tracker |
| LLM Turns | Session Tracker |
| Principle Injection | injectedPrincipleIds |
| Auto Correct | receiptAutoCorrects |
| Gate Block | blockedAttempts / 真实 Gate 记录 |
| 工具调用统计 | EventLog tools |
| Pain / Trajectory | trajectory.getDataStats() |
| 规则数量 | dictionary.getStats() |
| Empathy 事件 | EventLog.getEmpathyStats() |

要求：

- 不新增数据库表。
- 不新增 Session 统计账本。
- 不编造心理状态。
- 不把规则命中误称为实际拦截。
- 所有指标必须有真实生产者。

输出目标：让 Owner 能够了解 PD 实际运行、原则注入、治理执行和证据采集情况。

---

# 5. Config / Feature Flag 清理

## 5.1 Feature Flag

目标：GFI **不得作为有效 Feature Flag 存在**；允许保留**纯防御性 `gone` tombstone**。

删除 / 退役：

- 所有 GFI flag 的 quiet / disabled 执行路径，以及配置模板中的 GFI flag；
- `feature-flag-lifecycle.ts` 中任何可执行 GFI 生命周期；
- 依赖 GFI flag 开启 / 关闭行为的测试（替换为墓碑防御性测试）。

保留（Owner 2026-11-07 批准，DC-01 方案 A）：

- `feature-flag-contract.ts` 中的 `gfi` 条目，`category: 'gone'`；
- 仅用于**旧配置识别**：旧 override 被明确拒绝，不执行任何 GFI 逻辑；
- 不得作为有效 Feature Flag 被启用；`gone` 不可被 override 重新启用。

保留理由：

- 旧 `gfi` override 可能残留在用户配置中；墓碑使失败模式可观测且稳定（明确拒绝），
  优于依赖 unknown-flag warning 的隐式忽略；
- 墓碑无执行能力，无法重新激活旧逻辑；删除墓碑只降低可观测性，不降低风险。

行为边界：

1. `gfi` 不驱动任何生产路径；
2. 旧配置不得重新激活 GFI；
3. 不得将 `gfi` 重新标为 `quiet` / `active`。

测试要求：

- 必须保留测试证明 `gfi` 为 `gone` 且不可被 override 重新启用；
- 必须证明加载旧 `gfi` 配置不会产生任何 GFI 行为。

> **历史对照：** v1.2 曾规定“不保留 gone tombstone”。2026-11-07 Owner 批准方案 A，
> 本版（v1.3）将规定修改为“允许纯防御性墓碑，但不得具有任何执行能力”。
> 该变更不删除历史决策记录；历史验收报告与审计证据保持原样。

> **2026-11-07 实施状态：** 实际合并代码保留了 `gfi` 的 `gone` tombstone（无执行能力），
> 与本版一致。状态：`OWNER_APPROVED / SPEC_ALIGNMENT_REQUIRED` → 本轮已对齐。
> 详见 §15.3 GFI-2。

## 5.2 PainConfig

目标：

`packages/openclaw-plugin/src/core/config.ts`

删除确认无消费者的：

- scores.tool_failure_friction。
- thresholds.pain_trigger。
- severity_thresholds.high。
- 其他仅被 GFI 或已经删除的 computePainScore 消费的配置。

同时核查：

- GfiGateSettings。
- gfi_gate。
- 其他 GFI 专属模板和默认值。

当前代码搜索未发现 gfi_gate 的生产读取者。确认全仓及实际工作区无消费者后，将其作为死配置一并删除。

注意：不得删除独立的 RuleHost 安全规则。

保留：

- thresholds.cognitive_paralysis_input。
- Empathy Engine 独立配置。
- 其他仍有生产消费者的配置。

## 5.3 旧配置迁移

PainConfig.deepMerge 会保留旧配置中的未知字段。

因此只删除 TypeScript 默认值是不够的。

必须清理实际工作区的 `pain_settings.json`：

- GFI 专属阈值。
- GFI 评分参数。
- GFI Gate 死配置。

同时清理 `.pd/config.yaml` 中的 gfi flag override。

迁移必须保留所有非 GFI 用户配置。

---

# 6. 数据库与持久化迁移

## 6.1 trajectory.db

当前 Schema 唯一权威定义：

`packages/principles-core/src/runtime-v2/trajectory-schema.ts`

当前 `TRAJECTORY_SCHEMA_VERSION = 1`。

不得重新建立重复 DDL 或第二套 Schema 管理系统。

### 删除字段

`tool_calls`：

- gfi_before
- gfi_after

同步修改：

- TRAJECTORY_SCHEMA_VERSION。
- canonical CREATE TABLE。
- applyTrajectorySchemaBase。
- production-pain-evidence.ts 的 REQUIRED_COLUMNS。
- production-pain-evidence 的 INSERT。
- TrajectoryToolCallInput。
- TrajectoryDatabase.recordToolCall。
- 所有 SQL 参数绑定。
- 测试 Fixture。
- E2E BASELINE_DDL。
- scripts/dev 中的数据库 Fixture。

Schema 版本提升为 2。

增加一次明确、幂等的 GFI 列删除迁移。

迁移必须由现有 canonical schema authority 执行，覆盖 Core Profile A 和 OpenClaw Profile B/C。

### 数据不变量

迁移前后：

- tool_calls 行数一致。
- 所有非 GFI 列值一致。
- id 不变。
- session_id 不变。
- tool_use_id 不变。
- project_dir 不变。
- host_kind 不变。
- 现有索引保留。
- 其他表完全不受影响。

迁移后执行：

- PRAGMA integrity_check。
- PRAGMA foreign_key_check。
- PRAGMA table_info(tool_calls)。

确认 GFI 列彻底不存在。

不得删除 tool_calls 表或 trajectory.db。

## 6.2 Session JSON

扫描全部：

`.state/sessions/*.json`

清理 GFI 状态字段。

对所有文件执行，包括已经过期的 Session。

保留：

- sessionId。
- workspaceDir。
- lastActivityAt。
- lastControlActivityAt。
- toolReadsByFile。
- llmTurns。
- blockedAttempts。
- Token Usage。
- stuckLoops。
- injectedPrincipleIds。
- injectedActivationIds。
- receiptAutoCorrects。

必须验证 Receipt 信息迁移前后完全一致。

使用原子写入。迁移失败时不得破坏原文件。

## 6.3 EventLog Daily Stats

清理：

`.state/logs/daily-stats.json`

仅删除 GFI 聚合对象。

保留：

- tools。
- empathy。
- hooks。
- evolution。
- 其他有效字段。

不得删除历史事件 JSONL。

## 6.4 Pending Confirmation

对于旧的 `signal_confirmations` 中仍处于 pending 状态、且 suggested_type 为 empathy 的历史项目：

- 不再交给 correction classifier 作为有效纠正候选。
- 使用现有 abandoned/rejected 终态处理。
- 记录明确的 retirement reason。
- 保留原始记录，不删除整张表。

其他 correction pending 项不受影响。

---

# 7. 复杂度收益目标

本次不仅统计删除 LOC，还要统计架构复杂度变化。

## 7.1 必须消除

- GFI Kernel。
- GFI Read Model。
- GFI Policy。
- GFI Session State。
- GFI Event Aggregation。
- GFI Config。
- GFI Flag。
- GFI CLI。
- GFI Console。
- GFI RuleHost Contract。
- GFI 自动 Pain。
- WEAK → GFI。
- GFI Persistence。
- GFI 专属测试与 Fixture。
- GFI 专属公共 API。

## 7.2 不允许新增

- 新数据库表。
- 新 Worker。
- 新 Feature Flag。
- 新综合评分机制。
- 新的并行事实存储。
- GFI 兼容 Adapter。
- GFI 空实现。
- 新的 GFI 替代子系统。

允许：

- 一个小型 Session 活动时间函数。
- 一次性数据清理脚本。
- 必要的数据库 Schema 迁移。
- 对 `/pd-status` 的事实型展示调整。

这些不是替代 GFI 的新架构。

## 7.3 复杂度指标

最终报告量化：

- GFI 生产代码删除 LOC。
- GFI 测试 LOC 删除。
- 删除的 Session 字段。
- 删除的公共 API。
- 删除的配置项。
- 删除的数据库字段。
- 删除的跨包调用点。
- 净新增 LOC。
- 新增抽象数量。
- 新增运行时状态数量。

预期新增抽象尽可能为零，唯一例外是必要的 Session 活动时间职责函数。

---

# 8. 功能保全与增强验收

## 8.1 Tool Execution

使用同一组工具事件进行差异测试。

删除前后：

- toolName 一致。
- outcome 一致。
- durationMs 一致。
- exitCode 一致。
- errorType 一致。
- errorMessage 一致。
- hostKind 一致。
- runId / toolCallId 一致。
- 脱敏结果一致。
- trajectory 行为一致。

允许变化：GFI 字段消失。

验证：

- 成功调用。
- 失败调用。
- 连续失败。
- 不同错误类型。
- 工具执行后 Session 活动时间。
- 真实 SQLite 写入。

## 8.2 Session / Receipt

重点回归：

- Session 创建。
- Session 恢复。
- Session 过期清理。
- lastActivityAt。
- lastControlActivityAt。
- Principle Injection。
- injectedActivationIds。
- receiptAutoCorrects。
- Receipt 关联与验证。

必须证明 GFI 删除没有破坏 Principle Receipt。

## 8.3 Manual Pain

真实执行完整链：

```text
Owner /pd-pain
    |
    +-- MANUAL_PAIN
    +-- pain_events
    +-- PainIngress
    +-- TriggerController
    +-- Diagnostician Task
    +-- Diagnosis
    +-- Candidate
    +-- Principle Intake
```

删除前后，Manual Pain 准入和诊断链行为保持一致。

## 8.4 Correction Detection

三宿主全部回归：

- OpenClaw。
- Codex。
- WorkBuddy。

重点验证：

- STRONG 纠正。
- AMBIGUOUS 纠正。
- 引号。
- 第三人称。
- 否定。
- 转述。
- 句中纠正。
- 学习词 TP/FP。
- 低置信度。
- LLM 异常。
- Pending CAS。
- Worker 并发。
- 崩溃恢复。
- TTL。
- 终态数据最小化。

删除 GFI 后，STRONG 和 AMBIGUOUS 行为必须保持。

Empathy 事件独立测试，确保没有因为移除 correction collector 的 empathy 分类而误删全局 Empathy 功能。

## 8.5 RuleHost

运行现有 RuleHost 5×5 或完整生产决策矩阵。

验证：

- Dangerous Command。
- Risk Path。
- Approval。
- Auto Correct。
- Recovery Control。
- EP Tier。
- RuleContext V2。
- Safety Circuit Breaker。

所有非 GFI 条件下的决策必须与基线一致。

## 8.6 Runtime Health

验证：

- Operator Health。
- Console Health。
- CLI Runtime Health。
- Canary。
- Diagnostics Export。

确保剩余健康检查正常。

GFI 不再影响 overallStatus。

## 8.7 数据完整性

迁移前后：

- Pain 历史记录不丢失。
- Candidate 不丢失。
- Principle Ledger 不丢失。
- Pending Correction 不丢失。
- Session Receipt 不丢失。
- 工具轨迹不丢失。
- 非 GFI EventLog 统计一致。

---

# 9. 实施流程

## Stage 0 — Read-only Preflight

以最新 origin/main 为基线。

必须检查：

1. Git SHA。
2. 所有 GFI 生产引用。
3. 全部生产消费者。
4. 全部 GFI 配置。
5. EventLog 统计。
6. SQLite Schema。
7. Session JSON。
8. RuleHost 实际激活规则。
9. 所有三宿主适配。
10. 现有功能基线。

生成：

`GFI_DEPENDENCY_INVENTORY.md`

以及：

`GFI_BEHAVIOR_BASELINE.json`

不得在此阶段修改生产文件或生产数据。

## Stage 1 — Source Removal

在独立 worktree 完成：

- Core。
- Session Tracker。
- Hooks。
- Pain。
- Signal Collector。
- RuleHost。
- EventLog。
- Operator Health。
- CLI。
- Console。
- Config。
- Feature Flags。

一次性完成 GFI 生产路径退役。

## Stage 2 — Schema & State Migration

完成：

- trajectory.db schema v2。
- tool_calls GFI 字段删除。
- EventLog daily-stats 清理。
- Session JSON 清理。
- pain_settings.json 清理。
- signal keyword store 清理。
- 旧 empathy pending 终态处理。

在隔离工作区副本上运行迁移。

提供 dry-run 和迁移报告。

不得直接操作真实 Owner 数据库。

## Stage 3 — Functional Regression

完成所有受影响包的测试：

- principles-core。
- host-runtime。
- openclaw-plugin。
- codex-adapter。
- workbuddy-adapter。
- pd-cli。
- pd-console。

包括：

- Unit。
- Integration。
- SQLite。
- Concurrency。
- E2E。
- 三宿主回归。
- RuleHost。
- Pain 全链路。
- Receipt。

真实 LLM BDD 如环境不可用，明确标记 BLOCKED，不得伪称通过。

## Stage 4 — Independent Architecture Audit

由独立评审角色只读检查：

- 所有 GFI 生产引用。
- 所有 GFI 类型。
- 所有 GFI 状态。
- 所有 GFI API。
- 所有 GFI 配置。
- 所有 GFI 数据库字段。
- 所有 GFI 运行时消费者。
- 所有替代评分路径。

历史文档、历史日志和不可变证据不要求删除。

必须逐项分类命中结果。

## Stage 5 — PR Delivery

交付一个独立 PR。

- OPEN。
- CI 全绿。
- READY_FOR_OWNER_REVIEW。
- 工作区干净。
- writer lease 释放。
- 未合并。
- 未部署。
- 未执行真实工作区迁移。

---

# 10. 最终验收门禁

## Gate A — Complete Removal

- [ ] GFI Kernel 删除。
- [ ] GFI Policy 删除。
- [ ] GFI Read Model 删除。
- [ ] Session GFI 状态删除。
- [ ] GFI 生产调用点清零。
- [ ] GFI 自动 Pain 删除。
- [ ] WEAK→GFI 删除。
- [ ] GFI EventLog 统计删除。
- [ ] GFI RuleHost 输入删除。
- [ ] GFI Config 删除。
- [ ] GFI Flag 删除。
- [ ] GFI CLI 删除。
- [ ] GFI Console 删除。
- [ ] GFI 数据库字段删除。
- [ ] 无 GFI 兼容层。
- [ ] 无 GFI 替代评分。

## Gate B — Functional Preservation

- [ ] Tool Execution 保持。
- [ ] Tool Failure Evidence 保持。
- [ ] Gate Block 保持。
- [ ] Session Lifecycle 保持。
- [ ] Receipt 保持。
- [ ] Manual Pain 保持。
- [ ] Correction STRONG 保持。
- [ ] Correction AMBIGUOUS 保持。
- [ ] Stage 2 保持。
- [ ] Pending 保持。
- [ ] PainIngress 保持。
- [ ] Diagnostician 保持。
- [ ] Candidate / Ledger 保持。
- [ ] EP 保持。
- [ ] RuleHost 保持。
- [ ] 三宿主保持。
- [ ] Intent Engineering 保持。
- [ ] Empathy 独立能力保持。

## Gate C — Data Integrity

- [ ] trajectory.db 非 GFI 数据一致。
- [ ] tool_calls 行数一致。
- [ ] Schema Integrity PASS。
- [ ] Session Receipt 数据一致。
- [ ] EventLog 非 GFI 统计一致。
- [ ] Pain 历史完整。
- [ ] Principle Ledger 完整。
- [ ] 配置迁移保留其他配置。
- [ ] 无无意的数据删除。

## Gate D — Complexity Reduction

- [ ] GFI 生产 LOC 清零。
- [ ] GFI 状态清零。
- [ ] GFI 公共 API 清零。
- [ ] GFI 配置清零。
- [ ] GFI 持久化字段清零。
- [ ] 无新评分机制。
- [ ] 无新增平行架构。
- [ ] 无无意义兼容代码。
- [ ] 净复杂度下降有量化证据。

## Gate E — Engineering

- [ ] 所有受影响包测试通过。
- [ ] TypeScript 全量通过。
- [ ] Lint 通过。
- [ ] 全仓 Build 通过。
- [ ] Verify Merge Gate 通过。
- [ ] Release Build Parity 通过。
- [ ] E2E 通过。
- [ ] CI Required Checks 全绿。
- [ ] 最终 HEAD 一致。
- [ ] Changesets 正确。
- [ ] 工作区干净。

---

# 11. 明确排除范围

本次不允许顺手重构：

- Diagnostician 架构。
- PainIngress 架构。
- Candidate / Principle Intake。
- RuleHost 安全执行引擎。
- EP。
- Intent Engineering。
- Receipt 系统。
- Memory 系统。
- OpenClaw / Codex / WorkBuddy Worker 架构。
- 其他非 GFI 评分系统。

RuleCode Safety Circuit Breaker 的 consecutiveErrors 与 GFI 无关，必须保留。

历史审计报告、历史 CHANGELOG 和 Phase 0 的 GFI 正向实验记录作为不可变历史证据保留。

活跃架构文档应更新或标记 superseded。

---

# 12. 回滚

代码：

- 单 PR revert。

数据：

- 数据库迁移前备份。
- Session JSON 迁移前备份。
- pain_settings.json 迁移前备份。
- daily-stats.json 迁移前备份。

如果回滚代码，需要同时恢复对应旧 Schema 数据库备份。

不为回滚而保留 GFI 兼容代码。

---

# 13. 最终交付报告

必须包含：

1. 完整 GFI 依赖图。
2. 删除文件和符号清单。
3. 删除前后 LOC 对比。
4. Session 状态复杂度变化。
5. 数据库 Schema 变化。
6. 非 GFI 数据迁移证据。
7. Tool Execution 行为差异。
8. Manual Pain 回归证据。
9. 三宿主 Correction Detection 证据。
10. RuleHost 5×5 / 完整矩阵证据。
11. Receipt 保全证据。
12. CLI / Console 验收。
13. 全仓残留扫描。
14. CI 和 E2E 结果。
15. 真实模型验证边界。
16. Rollback 说明。

最终状态只能是：

- READY_FOR_OWNER_REVIEW
- BLOCKED

不得以测试通过代替架构删除证明。

---

# 14. 最终设计原则

**GFI Complete Removal 不是一次功能关闭，而是一次架构去冗余。**

PD 应当直接使用真实行为证据，而不是依靠一个综合摩擦分数解释 Agent 的状态。

最终应形成：

- 工具执行只记录真实事实。
- Correction Detection 只负责识别纠正。
- Pain 只承载经过证据和准入验证的行为问题。
- Diagnostician 只负责诊断。
- Principle 只负责长期行为约束。
- RuleHost 只负责执行治理约束。
- Receipt 负责证明原则是否真正到达执行现场。

**No Legacy Compatibility.**

**No Dormant Abstraction.**

**No Parallel Scoring System.**

**No Duplicate Facts.**

**Preserve All Non-GFI Capabilities.**

最终目标：更少的状态、更少的算法、更少的依赖、更清晰的职责，以及不降低任何 PD 核心能力的长期行为治理系统。

本 SPEC 是本次实施的唯一范围依据。Owner 保留最终合并和部署授权。

---

# 15. Post-Implementation Closure（2026-11-07）

> 本节只追加**实施后状态与剩余事项**，不改变 §1–§14 的设计条款。
> 完整矩阵见 `docs/reports/PAIN_ARCHITECTURE_FINAL_CLOSURE_2026-11-07.md`。

## 15.1 基线

- 代码基线：`origin/main@9c07876207655b4ac9757fb3510a69f3bb9dfa30`（PR #2401 rebase 后基线）。
- 实施 PR：**#2332**（GFI Complete Removal，已合并）。
- 路径变更：PRI-1136 已把 `packages/principles-core/src/runtime-v2/` 改名为
  `packages/principles-core/src/runtime/`；§6.1 中 `runtime-v2/trajectory-schema.ts`
  的现行路径为 `runtime/trajectory-schema.ts`（历史写法保留，不改原文）。

## 15.2 已完成（IMPLEMENTED）

| 项 | 证据 |
| --- | --- |
| GFI 评分内核 / session state / 观测面删除 | `packages/principles-core/src/runtime/gfi/` 目录已完全不存在 |
| SQLite GFI 列删除 | `runtime/trajectory-schema.ts`；迁移器与防御性拒绝见 `host-runtime/src/production-pain-evidence.ts` |
| CLI / Console GFI 表面与命令删除 | 全仓 `packages/**/src/**/*.ts` 扫描无 GFI 打分逻辑 |
| RuleHost / Manual Pain / Receipt / Diagnostician 不受损 | 既有测试套件通过（见 §15.4） |
| `gfi` flag 无执行能力 | `feature-flag-contract.ts:235` 为 `category: 'gone'`；`gone` 不可被 override 重新启用 |

## 15.3 未完成 / 例外（PARTIALLY_IMPLEMENTED）

### GFI-1 — 历史 workspace JSON 数据清理（NOT_IMPLEMENTED）

- §6.2 `.state/sessions/*.json` 与 §6.3 `.state/logs/daily-stats.json` 的 GFI 字段
  **未执行迁移**。
- 现状：`session-tracker.ts` / `event-log.ts` 读取原始对象后原样写回，会保留未知历史键
  （GFI 字段可能仍留在 Owner 工作区文件中）。
- 本轮**不触碰真实 Owner 数据**；没有可靠迁移方案前不实施。
- 独立跟踪：**Linear PRI-1149**（备份 / 原子写入 / 完整性校验 / 回滚策略）。
  该事项**不归入** PRI-1104（V1/V2 架构任务）。
- 2026-11-10 进展：迁移工具已实现（`scripts/gfi-workspace-json-migration.mjs`，
  `npm run gfi:migrate`），含 dry-run / 备份 / 原子写入 / 回读校验 / 自动回滚 / 幂等；
  测试 `scripts/__tests__/gfi-workspace-json-migration.test.ts` 18/18 通过，
  测试全程只使用隔离临时工作区。完整说明见
  `docs/reports/GFI_WORKSPACE_JSON_MIGRATION.md`。
- **真实 Owner 数据迁移仍未执行**：`--apply` 需显式 `--confirm-owner-authorization`，
  实际执行须 Owner 单独授权。在该步骤完成前 GFI-1 仍保持 NOT_IMPLEMENTED。

### GFI-2 — `gone` tombstone（**OWNER_APPROVED / SPEC_ALIGNMENT_REQUIRED → 已对齐**）

- Owner 2026-11-07 正式选择**方案 A**：保留 `gfi` 的纯防御性 `gone` tombstone。
- 已同步 §5.1：允许保留墓碑，但必须满足——
  1. 保留旧配置识别能力；
  2. 明确标记为 `gone`；
  3. 不执行任何 GFI 逻辑；
  4. 旧配置不得重新激活 GFI；
  5. 不得作为有效 Feature Flag 被启用；
  6. 保留测试证明墓碑无执行能力。
- 保留理由：旧 override 的失败模式可观测且稳定；墓碑无执行能力，删除只降低可观测性。
- 相关测试：`feature-flag-lifecycle.test.ts`、`architecture-regression.test.ts`（须覆盖
  `gone` 不可被 override 重新启用、旧配置不产生 GFI 行为）。

### GFI-3 — 文档与索引不一致（本轮修复）

- 本 SPEC 状态：`Proposed` → `Partially Implemented`（本文件头部）。
- `docs/archive/specs/INDEX.md` 中“Phase A / Phase C 未做、GFI 仍喂 Pain 写点”为过期结论，本轮更正。
- `docs/architecture/README.md` 将 GFI 标为 `Active` → 更正为 `Retired`。
- `docs/architecture/COMPONENTS.md` 称 `runtime-v2/gfi/` “仅剩空 `__tests__` 占位”
  → 更正为“目录已完全不存在，仅保留 `gone` 墓碑”。
- `docs/reports/GFI_FINAL_ACCEPTANCE.md` 仅在末尾追加 2026-11-07 状态；历史正文不改。

## 15.4 本轮验证命令

```text
packages/principles-core: npx vitest run architecture-regression /
  feature-flag-lifecycle  -> passed（随 core 套件 546 passed）
packages/host-runtime: npx vitest run governance-signal-admission 系列 -> 89 passed
```

真实模型验证、三宿主最终验收、`verify:merge` 全链**未在本轮运行**；
未执行项在最终报告中标记 NOT RUN。