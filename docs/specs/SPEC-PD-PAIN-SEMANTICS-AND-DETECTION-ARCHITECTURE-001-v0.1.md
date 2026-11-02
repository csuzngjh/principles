# PD Pain Semantics & Detection Architecture v1.0
## Simplified Owner Review Revision

**Status:** Proposed — Owner Review  
**Revision:** Simplified Architecture  
**Code Baseline:** `main@457bbf0fcd8d85c069b78ce60858acf742fe970`  
**Scope:** Pain Semantics / SignalCollector / OpenClaw / Codex / WorkBuddy  
**Priority:** Core Architecture  
**Change Authority:** Owner

---

## 0. Architecture Decision

本规范重新确立 PD Pain 的语义，并约束三个宿主的 Pain 信号采集方式。

本次工作的目标不是建立新的 Pain 检测系统，而是：

1. 彻底消除 Error / Failure / Exception 与 Pain 之间的概念混淆。
2. 保留并完善现有 OpenClaw 两阶段纠正检测机制。
3. 将现有共享检测能力完整接入 Codex 和 WorkBuddy。
4. 删除 Semantic / GFI / Paralysis / Empathy 等退役机制在 Pain 路径中的残留。
5. 删除工具失败和 RuleHost Block 的自动 Pain 准入。
6. 最大程度复用已有数据结构、服务、队列和 Worker。

**核心原则：删除多余机制，统一现有能力，不再增加一套架构。**

## 1. Pain Semantics

### 1.1 Definition

Pain 是宿主在执行任务、决策和与 Owner 协作的过程中，产生的与 Owner 原则、价值观、目标、意图及授权边界相关的行为偏差证据。

这种偏差可能导致：

- Owner 的原则和价值观被违背。
- 任务目标或整体战略方向偏离。
- Owner 的真实意图被误解。
- Agent 擅自改变决策或执行方向。
- Agent 忽略 Owner 的明确约束。
- 已经纠正的行为模式持续复现。
- Owner 失去对 Agent 的信任或决策控制权。

Pain 的核心是 Owner 相关的行为偏差，而不是宿主是否正常运行。

### 1.2 Pain Signal Is Evidence, Not Diagnosis

Pain Signal 是行为证据的输入。

它不等于：

- 已经证明某项原则被违反。
- 已经确认行为偏差的根本原因。
- 已经形成可复用的原则。
- 已经证明某个行为模式具有跨任务的稳定性。

这些判断属于现有 Diagnostician 和后续验证流程。

### 1.3 Error Is Not Pain

以下行为不得独立形成 Pain：

- API 请求失败。
- 工具调用失败。
- 文件写入失败。
- 编译失败。
- 普通重试。
- 网络超时。
- 模型输出异常。
- Agent 正常进行复杂推理。
- RuleHost 正确阻止危险操作。

一次或多次技术失败，都不能仅凭次数升级为 Pain。

反过来，Agent 即使成功完成任务，也可能因为违背 Owner 意图而产生重要的 Pain 信号。

### 1.4 Owner Behavioral Context

Pain 的判断需要结合：

1. Owner 的 Principles & Values。
2. 当前 Goal。
3. 当前 Task Intent。
4. 授权和行为约束。
5. Agent 实际行为及其结果。

这些是现有上下文中的语义依据。

**本规范不创建新的 OwnerBehavioralContract 数据模型，不创建 ObjectiveStore、MissionStore 或新的 Goal 管理系统。**

能够从现有 Principle、Task、Intent 文档和行为轨迹获得的信息直接复用。

缺失的信息必须明确标记，不能由模型自行编造。

---

## 2. Pain Signal Sources

当前正式保留两类核心来源。

### 2.1 Explicit Owner Report

Owner 主动报告 Pain。

入口：

- OpenClaw `/pd-pain`。
- Codex 显式 Owner Statement。
- WorkBuddy 显式 Owner Statement。
- CLI `pd pain record`。

规则：

- 不经过关键词检测。
- 不需要 LLM 判断 Owner 是否不满。
- 保留原始 Owner 表达。
- 关联当前会话和可用证据。
- 进入现有 Pain Admission 和 Diagnostician 链路。

### 2.2 Automatic Correction Detection

识别 Owner 对 Agent 行为的纠正。

包括：

- 明确指出 Agent 做错了什么。
- 重申已经给出的约束。
- 指出 Agent 曲解了意图。
- 纠正 Agent 的决策方向。
- 指出 Agent 擅自改变任务范围。
- 要求 Agent 回到原始目标。
- 对已经发生的行为偏差再次提出纠正。

Correction 是高价值 Pain 信号，但普通需求变化和正常信息补充不应误判为纠正。

### 2.3 Supporting Evidence

以下数据可以继续保留在现有轨迹中：

- `user_turns`
- `assistant_turns`
- `tool_calls`
- `gate_blocks`
- `task_outcomes`
- `principle_receipts`

它们可以为诊断提供上下文。

但不能仅因为某条数据被记录，就自动创建 Pain。

---

## 3. Unified Correction Detection

### 3.1 Reuse Existing SignalCollector

唯一共享检测核心：

`packages/principles-core/src/runtime-v2/signal-collector/`

不新建 UnifiedPainDetector 或 BehavioralDeviationEngine。

### 3.2 Stage 1 — Keyword Detection

复用现有 `scanKeywords()`。

识别三种情况：

| 结果 | 处理 |
|---|---|
| High precision correction | 直接进入纠正信号准入 |
| Ambiguous correction | 等待 Stage 2 |
| No match | 受预算限制进入 Stage 2 发现路径 |

Stage 1 只识别纠正线索。

不得重新引入 Empathy 分类和 WEAK 信号分流。

WorkBuddy 的 `startsWith` 前缀限制不再作为独立检测规则。其防止引用、转述误报的目的，应由共享检测路径统一处理，同时允许句子中间出现的有效纠正被发现。

### 3.3 Stage 2 — LLM Correction Classification

复用现有：

- `buildLlmPrompt()`
- `SignalLlmClassifier`
- `mapLlmResultToOutput()`
- `PiAiRuntimeAdapter`
- 现有 SignalCollector Runtime Profile。

Stage 2 只回答：

**当前用户消息是否表达了对 Agent 行为、理解、决策或执行方向的纠正？**

结果：

- CORRECTION
- NONE

不再输出：

- EMPATHY
- WEAK
- SEMANTIC_CONFUSION
- PARALYSIS

Stage 2 不负责判断某项原则是否违反，也不负责确定 Pain 的根本原因。

这属于 Diagnostician 的职责。

### 3.4 Cost and Failure Boundaries

保留现有成本控制：

- 歧义关键词命中才进行必要的确认调用。
- 零命中发现继续使用已有 `discoveryRateLimitPerHour`。
- 不对每条普通消息无限调用 LLM。
- LLM 不可用时，高精度路径仍可运行。
- 歧义候选可以进入现有持久化确认队列。
- 不再把无法确认的信号降级为 GFI 或 WEAK Pain。

保持现有 OpenClaw 同步 Hook 不被 LLM 阻塞。

---

## 4. Cross-host Integration

### 4.1 OpenClaw

保留现有：

- `SignalCollectorHost`
- Stage 1 实时检测。
- Stage 2 异步 LLM 分类。
- `signal_confirmations`。
- `CorrectionObserverService` 的待确认消费能力。

删除：

- WEAK → GFI 分流。
- Empathy 自动 Pain。
- GFI 阈值触发。

`CorrectionObserver` 的关键词学习功能与实时纠正检测分离，维持现有独立开关，不扩大其职责。

### 4.2 Codex

保留：

- `codex-adapter` 实时 Hook。
- Transcript 增量摄入。
- `catchUpCodexIngestion`。
- 现有 Codex Workspace Worker。
- `governance-signal-admission`。

改造：

- 使用同一共享 `SignalCollector` Stage 1。
- 使用同一 Stage 2 分类器。
- 利用现有 Transcript Catch-up Worker 处理待确认纠正。
- 不再只依赖确定性 high precision 关键词。
- 不为 Codex 单独创建一套 LLM 纠正检测规则。

`codex_conversation_ingestion` 保持现有默认关闭状态，不自动扩大 Transcript 采集授权。

### 4.3 WorkBuddy

保留：

- UserPromptSubmit Hook。
- 当前用户消息采集。
- 原生会话身份验证。
- 显式 Owner Statement。
- 现有 WorkBuddy Workspace Worker。
- 现有 Companion 监督机制。

改造：

- 使用同一共享 Stage 1。
- 使用同一 Stage 2。
- 移除 `startsWith` 作为检测边界。
- 不在 15 秒同步 Hook 中等待 LLM。
- 对需要 Stage 2 的候选写入现有 `signal_confirmations`。
- 由现有 WorkBuddy Worker 消费待确认记录。

队列如需跨宿主共享，只允许在现有 `signal_confirmations` 表增加必要的 `host_kind` 字段，不新建队列表。

只记录需要确认的用户纠正候选，不因此开启完整 Transcript 采集。

WorkBuddy 当前不具备前置 Assistant Turn 和完整 Transcript，必须将这一证据限制明确传递给诊断流程。

`host.workbuddy` 和 `workbuddy_live_keyword_pain` 继续保持现有默认关闭，不自动开启。

### 4.4 Cross-host Invariant

三个宿主必须使用：

- 同一关键词检测逻辑。
- 同一高精度门槛。
- 同一 LLM 分类 Prompt。
- 同一 Stage 2 输出契约。
- 同一纠正语义。
- 同一 Pain 来源边界。

允许各宿主拥有不同的上下文采集和异步执行方式。

不得为了形式上的一致性伪造缺失的行为证据。

---

## 5. Existing Admission and Diagnosis

### 5.1 No New Admission Layer

复用：

- OpenClaw / CLI：`PainIngress`。
- Codex / WorkBuddy：现有 `governance-signal-admission`。
- 公共诊断服务：`PainToPrincipleService`。
- 公共诊断桥接：`PainSignalBridge`。

目前 WorkBuddy 的关联准入仍与 OpenClaw / Codex 存在实现差异，本次不新增第三套准入机制。

后续如需进一步统一，单独评估现有两个入口的收敛，不与本次信号清理捆绑。

### 5.2 Diagnostician Owns Semantic Diagnosis

Diagnostician 负责：

- 理解 Owner 的原则、目标和意图。
- 分析 Agent 的实际行为。
- 关联相关对话和执行轨迹。
- 识别行为偏差。
- 发现跨任务重复模式。
- 提炼可长期改善的原则。

不在 Diagnostician 之前增加第二套完整的 Semantic Deviation Assessment。

### 5.3 No New Domain Model

明确禁止为本次工作新增：

- OwnerBehavioralContract。
- ContextEnvelope。
- PainCandidate 独立数据模型。
- PainEpisode Runtime Entity。
- BehavioralDeviationAssessment Service。
- LongitudinalPainPatternDetector。
- 新的 Canonical Pain Event Schema。

复用现有 `pain_events`、`PainIngressV1`、`signal_confirmations`、`governance_signal_admissions` 和 Runtime V2 Task Store。

历史数据保留，不进行破坏性迁移。

---

## 6. Legacy Mechanism Retirement

以下机制从 Pain 生产路径中正式退役：

| Mechanism | Required Action |
|---|---|
| Semantic Confusion | 删除旧检测和 Pain 记录路径 |
| GFI Threshold | 删除 Pain 触发逻辑 |
| LLM Paralysis | 删除旧检测和 Pain 记录路径 |
| Empathy Inferred | 删除自动 Pain 分流 |
| WEAK Signal | 删除 WEAK → GFI 分支 |
| Tool Failure Pain | 删除自动 Pain 准入 |
| Repeated Tool Failure | 不再因次数达到阈值创建 Pain |
| RuleHost Block Pain | 删除直接 Pain 触发 |
| Fatal Intercept Pain | 转为运行时健康或故障记录 |
| Correction Sample Reject Pain | 保留学习质量反馈，不创建宿主 Pain |

### 6.1 Preserve Existing Evidence

不得因此删除：

- Tool Call 轨迹。
- RuleHost 阻断事实。
- Assistant Turn。
- User Turn。
- Principle Receipt。
- 历史 Pain Event。

这些记录可能仍服务于 RuleCode、Trajectory 和诊断证据。

它们不再独立创建 Pain。

### 6.2 Retire Redundant Decision Infrastructure

在所有调用点完成迁移后，删除不再需要的：

- `evidence-triage`。
- `TriggerController`。
- `trigger-cooldown-tracker`。
- 旧的 GFI Pain 升级策略。
- 旧的 tool failure / rulehost block Pain scoring。

保留 `admission-gate.ts` 及其下游候选准入能力，不得与旧 TriggerController 混为一谈。

`llm_output` Hook 仍然负责 Assistant Turn 和 Task Outcome 记录，只移除旧的 Semantic / Paralysis / GFI 检测逻辑。

### 6.3 GFI Full Retirement

GFI 不再属于 Pain 语义和检测架构。

在检查实际部署 RuleCode 是否依赖 `currentGfi` 后，若无有效消费者，则一并删除：

- GFI Kernel。
- Session Tracker GFI 状态。
- RuleHost `currentGfi` 输入。
- GFI CLI / Console / Health Read Model。
- GFI 相关配置和测试。

不得保留无实际用途的兼容子系统。

---

## 7. Complexity Constraints

本次架构优化遵守以下不可突破的约束：

1. 不新增独立 Pain Detection Package。
2. 不新增 Pain Runtime。
3. 不新增 Diagnostician 前置 LLM 诊断。
4. 不新增 PainEvidence / PainEpisode 数据表。
5. 不新增异步 Worker 或后台进程。
6. 不新增独立消息队列。
7. 不新增功能开关。
8. 不新增重复的 Admission Controller。
9. 不重复实现已有 PainIngress 和 PainToPrincipleService。
10. 不因宿主不同而创建不同 Pain 语义。

允许对现有模块进行必要的提取、合并和删除。

唯一可能涉及的数据库结构变更，是为了让现有纠正确认队列支持宿主归属而增加字段；不得借此扩展成新的事件系统。

---

## 8. Acceptance Criteria

### Positive Cases

| Scenario | Expected |
|---|---|
| Owner 明确报告 Agent 违反原则 | 进入 Owner-confirmed Pain |
| 用户纠正 Agent 的错误理解 | 识别为 Correction |
| 用户要求 Agent 回到原始目标 | 识别为 Correction |
| Agent 忽略已经明确给出的约束 | 可形成 Pain 证据 |
| 同类行为跨任务反复出现 | 由 Diagnostician 分析长期模式 |
| Agent 成功完成任务但违背原始意图 | 不因任务成功而排除行为偏差 |

### Negative Cases

| Scenario | Expected |
|---|---|
| API 超时后重试成功 | No Pain |
| 单次工具调用失败 | No Pain |
| 多次工具调用失败但遵循 Owner 意图 | No Pain |
| 普通编译失败 | No Pain |
| Agent 正常复杂推理 | No Pain |
| RuleHost 正确阻止危险操作 | No Pain |
| Semantic Confusion | 不创建 Pain |
| GFI 达到旧阈值 | 不创建 Pain |
| LLM Paralysis | 不创建 Pain |
| Empathy 语言 | 不创建 Pain |
| Correction Sample Reject | 不创建宿主 Pain |

### Cross-host Tests

使用同一组纠正场景测试三个宿主：

- 同一输入的 Correction 分类结果一致。
- 高精度与歧义词处理一致。
- LLM 超时不会被误认为 NONE。
- LLM 不可用不会产生 WEAK / GFI。
- 同一信号不会创建重复 Pain。
- 显式 Owner 报告不受自动检测开关影响。
- Codex / WorkBuddy 默认关闭时不新增自动行为。
- WorkBuddy 不读取 Transcript。
- 不因缺少上下文而伪造行为证据。

### Regression Tests

必须证明：

- `PainIngress` 原有边界不回归。
- `PainToPrincipleService` 原有任务创建能力不回归。
- `PainSignalBridge` 幂等性不回归。
- `governance-signal-admission` 的 canonical identity 不回归。
- Correction Keyword Learning 不回归。
- 历史 Pain Event 可继续读取。
- RuleHost 的实际执行和阻断行为不受 Pain 清理影响。

---

## 9. Migration Plan

### Phase A — Semantic and Legacy Cleanup

1. 冻结新的 Pain 语义。
2. 删除 Semantic / GFI / Paralysis / Empathy 的 Pain 生产路径。
3. 删除工具失败和 RuleHost Block 的自动 Pain 准入。
4. 删除 WorkBuddy bare failure Pain admission。
5. 简化显式 Owner 报告路径。
6. 清理不再有消费者的 Evidence Triage / Trigger Controller 代码。
7. 保留所有必要的轨迹记录和历史数据。

### Phase B — Shared Correction Detection

1. 复用现有 SignalCollector。
2. 提取现有 LLM 分类器的共享调用能力。
3. Codex 接入 Stage 2。
4. WorkBuddy 接入 Stage 2。
5. 复用现有确认队列和宿主 Worker。
6. 保持现有同步 Hook 性能与功能开关边界。
7. 完成跨宿主正向和反向测试。

### Phase C — GFI Full Removal

完成部署规则兼容性核查后，删除没有有效消费者的 GFI 状态、RuleHost 字段、CLI、Console 和配置。

三个阶段均不得触碰未经授权的生产部署或数据库迁移。

---

## 10. Documentation Alignment

本规范获 Owner 批准后，需要同步：

1. `PRODUCT_IDENTITY.md`：保持 Owner-relevant behavioral evidence 的定义。
2. `ADR-0014`：通过新的 Owner 决策记录明确退役 GFI / Empathy Pain 路径。
3. `DOMAIN_MODEL.md`：修正 Pain Signal 的领域定义。
4. `GLOSSARY.md`：删除将 Pain 等同于工具错误的描述。
5. `INTERNALIZATION_PIPELINE.md`：移除过期的 GAP / Tool Failure / Empathy 分层描述。
6. `PD_ARCHITECTURE_OVERVIEW.md`：同步当前实际 Pain Pipeline。
7. `SignalCollector` 设计文档：保留两阶段纠正检测，删除 WEAK / GFI 分流。
8. Codex / WorkBuddy 规范：同步 Stage 2 的迁移和异步执行边界。

ADR-0015 和 Unified Friction Observer 的历史设计不作为本规范的实施依据。

---

## 11. Final Decision

PD Pain Architecture v1.0 的核心目标是：

**让 PD 专注于识别宿主偏离 Owner 行为预期的证据，而不是监控宿主发生了多少技术异常。**

在架构上：

- 一个共享纠正检测核心。
- 三个轻量宿主适配器。
- 一套已有证据准入和任务处理基础设施。
- 一个现有 Diagnostician 负责深层行为诊断。

不增加第二套检测体系，不增加第二套诊断体系，不增加新的 Pain 数据模型。

**这次工作的成功标准不是新增了多少功能，而是删除了多少不再需要的机制，同时没有损害 PD 已经成熟的纠正检测能力。**