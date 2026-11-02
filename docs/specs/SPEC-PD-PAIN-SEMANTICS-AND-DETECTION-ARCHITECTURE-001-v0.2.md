# PD Pain Semantics & Detection Architecture v1.0
## Evidence-driven Revision (v0.2)

**Status:** Proposed — Owner Final Review
**Revision:** v0.2（基于 v0.1 与独立架构审查报告的逐条证据修订）
**Code Baseline:** `main@457bbf0fcd8df85c069b78ce60858acf742fe970`（与 v0.1 相同；v0.1 头部 SHA 缺一个 `f`，本版修正）
**Evidence Base:** `docs/reviews/2026-11-02-pain-architecture-spec-v0.1-audit.md`（下称"审查报告"，其发现编号 F-* 在本文引用）
**Scope:** Pain Semantics / SignalCollector / OpenClaw / Codex / WorkBuddy
**Priority:** Core Architecture
**Change Authority:** Owner

---

## 0. Architecture Decision

本规范重新确立 PD Pain 的语义，并约束三个宿主的 Pain 信号采集方式。

目标不变：

1. 彻底消除 Error / Failure / Exception 与 Pain 之间的概念混淆。
2. 保留并完善现有 OpenClaw 两阶段纠正检测机制。
3. 将现有共享检测能力完整接入 Codex 和 WorkBuddy。
4. 删除退役机制在 Pain 路径中的残留。
5. 删除工具失败和 RuleHost Block 的自动 Pain 准入。
6. 最大程度复用已有数据结构、服务、队列和 Worker。

**v0.2 相对 v0.1 的实质变化（详见 §13）：**

- 修正三个已被源码审查证伪的技术前提：跨宿主共享队列、高精度直通无防护、先删后建的迁移顺序。
- 补齐 Pain 语义的三层边界（Signal Capture / Pain Evidence / Pain Diagnosis）与能力边界声明。
- 给出 Pending 候选持久化的具体技术选型（零 DDL，决策值域扩展）。
- GFI 从"全量退役"改为"有界退役"两阶段方案。
- 所有删除动作以新能力验收为前置，不再接受检测真空窗口。

**核心原则不变：删除多余机制，统一现有能力，不再增加一套架构。**

---

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

### 1.2 Three Layers: Signal Capture / Pain Evidence / Pain Diagnosis

必须区分三个层次，不得混用：

| 层次 | 职责 | 现有承载 |
|---|---|---|
| **A. Signal Capture** | 捕获 Owner 报告、用户纠正及其他可能反映行为偏差的信号。信号本身不构成任何结论。 | 关键词扫描、Stage 2 分类、显式 Owner Statement 采集 |
| **B. Pain Evidence** | 保存能够关联宿主行为与 Owner 意图的证据，通过准入获得候选资格。 | `pain_events`、PainIngress 判定、`governance_signal_admissions` 标记 |
| **C. Pain Diagnosis** | 由现有 Diagnostician 判断是否存在真正的行为偏差及其根因，并提炼原则。 | `PainToPrincipleService`、Diagnostician、`admission-gate` |

### 1.3 Capability Boundary（诚实声明）

- 自动纠正检测只是**当前可落地的高价值信号来源**，不是 Pain 的全部来源。
- Correction 不等于已经确认原则违反；它进入诊断，不预设结论。
- 当前**没有**静默偏差、长期目标漂移的自动发现能力；此类发现依赖 Diagnostician 对跨任务证据的分析，本次不新增该能力。
- 本次改造**不宣称**解决所有隐性行为偏差检测问题。
- 明确禁止为此新增 BehavioralDeviationEngine 或 LongitudinalPainPatternDetector（与 §7 约束一致）。

### 1.4 Error Is Not Pain — 含 RuleHost 特殊边界

以下行为不得独立形成 Pain：

- API 请求失败、工具调用失败、文件写入失败、编译失败、普通重试、网络超时、模型输出异常。
- Agent 正常进行复杂推理。
- 一次或多次技术失败，都不能仅凭次数升级为 Pain。

反过来，Agent 即使成功完成任务，也可能因为违背 Owner 意图而产生重要的 Pain 信号。

**RuleHost 三分边界**（不得将治理机制自身的错误与正确治理行为混淆）：

1. **正确阻止**违反 Owner 原则的行为：不是 Pain。
2. **错误阻止** Owner 已明确授权的行为：可以成为 Pain Evidence（治理机制自身偏离了 Owner 意图）。
3. Owner 对 RuleHost 错误判断进行纠正：进入现有 Correction Detection（与普通纠正同路径，不新建机制）。

### 1.5 Owner Behavioral Context

Pain 的判断需要结合：Owner 的 Principles & Values、当前 Goal、当前 Task Intent、授权和行为约束、Agent 实际行为及其结果。

本规范不创建新的 OwnerBehavioralContract 数据模型，不创建 ObjectiveStore、MissionStore 或新的 Goal 管理系统。能够从现有 Principle、Task、Intent 文档和行为轨迹获得的信息直接复用。缺失的信息必须显式标记（如 WorkBuddy 无前置 Assistant Turn），不能由模型自行编造。

---

## 2. Pain Signal Sources

保留 v0.1 的两类核心来源，边界不变：

### 2.1 Explicit Owner Report

入口：OpenClaw `/pd-pain`、Codex `PD记录痛苦：` 前缀、WorkBuddy 显式 Owner Statement、CLI `pd pain record`。

规则不变：不经关键词检测、不需 LLM 判断 Owner 是否不满、保留原始表达、关联会话与证据、进入现有 Pain Admission 和 Diagnostician 链路、不受自动检测开关影响。

现有实现已经具备 `explicitOwnerStatement` 跳过关键词的准入语义（`governance-signal-admission.ts:751-757`），本规范将其作为现状保留，而非新设计。

### 2.2 Automatic Correction Detection

识别 Owner 对 Agent 行为的纠正（明确指出做错、重申约束、指出曲解意图、纠正决策方向、指出擅自扩大范围、要求回到原始目标、对已纠正行为的复现再次纠正）。

Correction 是高价值 Pain 信号，但普通需求变化和正常信息补充**不得**误判为纠正（防护见 §3.2）。

### 2.3 Supporting Evidence

`user_turns`、`assistant_turns`、`tool_calls`、`gate_blocks`、`task_outcomes`、`principle_receipts` 继续保留在现有轨迹中，为诊断提供上下文。不能仅因为某条数据被记录，就自动创建 Pain。

---

## 3. Unified Correction Detection

### 3.1 Shared Core and Terminology

唯一共享检测核心仍是 `packages/principles-core/src/runtime-v2/signal-collector/`（`scanKeywords`、`buildLlmPrompt`、`mapLlmResultToOutput` 均在此，为现状）。

不新建 UnifiedPainDetector 或 BehavioralDeviationEngine。

**术语约定（贯穿全文）：**

- **Correction Candidate（纠正候选）**：Stage 1/2 产出的信号，未获准入前不是 Pain。
- **Admitted Pain Evidence（已准入 Pain 证据）**：通过准入的 `pain_events` 行 + 诊断任务。
- 候选 ≠ Pain；准入 ≠ 诊断结论。

### 3.2 Stage 1 — Keyword Detection（修订）

复用现有 `scanKeywords()` 的三分支结构（high / ambiguous / no-match + discovery 预算）。**但高精度直通不再是"词典名称"赋予的默认特权，而受以下前置条件约束：**

审查证实的现状（审查报告 F-P0-3）：纯子串 `includes` 匹配（`keyword-stage.ts:31`）、高频口语词表、学习词 TP≥3 且 FP=0 自动升级直通（`governance-signal-admission.ts:167-179`）、confidence 无门控。

**前置条件（全部满足前不扩大直通面）：**

1. **P-1 引用与位置防护**：在 core 层实现统一的引用、转述及匹配位置防护（引号内表达不命中、第三人称转述降级、否定语境处理）。这是共享检测路径的职责，任何宿主不得再依赖各自的局部防线替代。
2. **P-2 学习词升级门**：学习获得的关键词**永远不获得直接准入权限**。学习词命中一律按 ambiguous 处理，进入 Stage 2 确认。直接准入保留给**人工维护的种子高精度词表**。现有"TP≥3 且 FP=0 自动升 high 直通"逻辑必须移除或改为"升入 ambiguous 词表"。
3. **P-3 置信度门**：经 Stage 2 确认的候选，`confidence` 不得再被映射函数忽略（现状 `mapLlmResultToOutput` 忽略 confidence）；低于阈值的确认结果降级为待确认候选，不直接准入。
4. **P-4 正负向回归**：§8 的高精度负向测试矩阵全部通过，作为直通路径的持续验收条件。
5. **P-5 WorkBuddy startsWith 防线保留**：在 P-1 + P-4 通过验收之前，**不删除** WorkBuddy 的 `startsWith` 前缀过滤（`governance-signal-admission.ts:1078`）。

**直通资格（对"是否允许高精度跳过 Stage 2"的回答）：**

- 种子高精度词在 P-1/P-4 满足后**保留直通**（这是 OpenClaw 已验证的成熟能力，不回归）。
- 学习词、以及任何无法提供精度证据的命中，**一律进入 Stage 2**。
- 未来若要将新词加入直通词表，必须以负向测试矩阵上的实测精度为依据，不能仅凭词典类别名称。

高精度命中（即使在直通路径）也必须经过现有准入（PainIngress 语义层 / governance 准入事务、限流、canonical 去重），不得绕过证据准入直接创建已诊断的 Pain。

不得为此新增独立的检测器；P-1 防护实现在现有 `scanKeywords` 匹配路径内。

### 3.3 Stage 2 — LLM Correction Classification（修订）

复用现有 LLM Classifier 结构。**目标语义结果收敛为 Correction / None 两种。**

审查证实这是**真实的代码变更**，不是现状（现状契约 `{is_feedback, type: correction|empathy|none, confidence, reason}`，`signal-collector/src/types.ts:89-104`；且 v0.1 所列 SEMANTIC_CONFUSION 枚举在代码中不存在）。变更面清单：

| 变更点 | 现状 | 目标 |
|---|---|---|
| Prompt | `llm-stage.ts:14-25` 含 empathy 分类语义 | 只判定"是否表达对 Agent 行为/理解/决策/执行方向的纠正" |
| Output Schema | `type: correction\|empathy\|none`（types.ts:113-119） | `correction\|none`（empathy 移出纠正检测语义） |
| `mapLlmResultToOutput()` | 忽略 confidence（core/signal-collector.ts:64-94） | 保留并传递 confidence，供 P-3 置信度门使用 |
| EMPATHY 降级路径 | LLM 不可用时 empathy 歧义降级 WEAK（host:331-348） | 随 WEAK→GFI 分流一并删除，降级为"入 pending 候选" |
| 保留字段 | reason 存在 | reason、confidence、原始用户表达、可获得的 Assistant Turn 引用全部保留 |

**不允许因为二分类而丢失 Diagnostician 所需的原始证据。**

被纠正 Assistant Turn 的锚定现状：OpenClaw 在宿主层经 `referencesAssistantTurnId` 附着（host:207、prompt.ts:306-315）。**Codex 与 WorkBuddy 的 Worker 路径当前缺少该信息**：两个宿主必须在候选与证据中显式标记 `assistant_turn_available: false` 之类的缺失声明，不允许伪造上下文（违反即 rc-9 silent fallback）。

不为此新增复杂数据模型；缺失标记复用现有 evidence note / marker 字段。

### 3.4 Runtime Dependency（新增）

审查证实 `PiAiRuntimeAdapter` 从 `@earendil-works/pi-ai/compat` 导入（pin 1.2.0），而 compat 层是 pi-ai 明文声明的**临时兼容入口**（"Temporary compatibility entrypoint… deleted with the coding-agent ModelManager migration"），`getModel` 已 @deprecated。

要求：

- 共享分类器工厂下沉时，**只依赖现有 Adapter 边界**，不得新建第二套模型运行时。
- 将"Adapter 从 compat 入口迁移到 pi-ai 现行 API（`createModels()` / `Models.getModel()`）"列为 Phase B 内的显式任务（含版本升级兼容验证），不得把临时兼容层当作长期共享基础。
- 迁移完成前，现状 1.2.0 pin 保持不变（不为迁移而提前升级破坏其他调用点）。

### 3.5 Cost and Failure Boundaries

保留 v0.1 全部成本边界（均已验证属实）：

- 歧义关键词命中才进行必要的确认调用。
- 零命中发现继续使用已有 `discoveryRateLimitPerHour`（现状 6/h）。
- 不对每条普通消息无限调用 LLM。
- LLM 不可用时，种子高精度路径仍可运行。
- 保持现有 OpenClaw 同步 Hook 不被 LLM 阻塞（fire-and-forget 现状保留）。

v0.2 修订两点：

- "歧义候选进入现有持久化确认队列"仅对 OpenClaw 成立；Codex/WorkBuddy 的候选持久化见 §4.4。
- "不把无法确认的信号降级为 GFI 或 WEAK"——随 WEAK→GFI 分流删除一并落实，无法确认的信号停留在 pending 状态或按 TTL 废弃，可观察（rc-9）。

---

## 4. Cross-host Integration

### 4.1 OpenClaw — 不改动确认队列

- **保留**原有 `signal_confirmations` 表、原有 Producer（Stage 2 失败兜底入队）/ Consumer（CorrectionObserverService 周期消费）结构，**不增加 `host_kind`**。
- **不要求**其他宿主依赖 openclaw-plugin。
- 删除项与 v0.1 相同：WEAK→GFI 分流、Empathy 自动 Pain 残留、GFI 阈值触发。
- CorrectionObserver 关键词学习与实时检测维持分离与各自开关（现状已满足）。
- 已知事实如实记录：该队列在生产近 5 周无新增（审查报告 F-P2-13），其定位见 Owner 决策 D3。

### 4.2 Codex

保留：`codex-adapter` 实时 Hook、Transcript 增量摄入、`catchUpCodexIngestion`、现有 Codex Workspace Worker、`governance-signal-admission`。

**Hook 时间预算模型（新增，按宿主现实建模）**：Codex Hook 为同步进程、宿主硬 5s 超时、每事件冷启动。因此：

- Hook 只执行有严格预算的轻量工作（Stage 1、候选构造、pending 写入、显式 Statement）。
- **不在 5 秒同步 Hook 中执行 LLM**；Stage 2 由现有 Codex Workspace Worker 执行（Worker 已具备经 `PiAiRuntimeAdapter` 的 LLM 调用能力）。
- `codex_conversation_ingestion` 保持默认关闭；不默认开启 Transcript 授权。

**Transcript 摄入前置修复（新增，审查报告 F-P1-6）**：在开启 ingestion 之前必须修复三个会导致 catch-up **静默漏数据**的缺口：

1. revert 会话文件名格式（`rollout-<ts>-<thread>_<rollout>.jsonl`）与 `codex-transcript-locate.ts:34-44` 解析器不兼容；
2. `.jsonl.zst` 压缩归档不可见；
3. 新会话 rollout 延迟建档导致 SessionStart 时路径不存在。

任何无法定位/解析的情况必须显式降级并记录原因（rc-9），不得静默跳过。

Codex 接入共享 Stage 1/Stage 2 后，不再只依赖确定性 high precision 关键词；不为 Codex 单独创建一套 LLM 纠正检测规则。

### 4.3 WorkBuddy

保留：UserPromptSubmit Hook、当前用户消息采集、原生会话身份验证、显式 Owner Statement、现有 WorkBuddy Workspace Worker。

修订：

- UserPromptSubmit 只负责必要的同步采集与 pending 写入；**不在 12 秒 Hook 约束内等待 LLM**（现状 wrapper 自杀线 12s，物理上不可行，予以确认而非改变）。
- **不新增独立 Worker 进程**；Stage 2 由现有 WorkBuddy Workspace Worker 新增一个执行步骤完成（这是现有 Worker 的职责扩展，不是新 Worker——如实声明，不包装成"零改动"）。
- `startsWith` 防线按 §3.2 P-5 处理：防护验收前保留，验收后由共享防护取代。
- WorkBuddy 无前置 Assistant Turn 与完整 Transcript 的证据限制，显式传递给诊断流程（§3.3）。
- `host.workbuddy` 和 `workbuddy_live_keyword_pain` 保持默认关闭，不自动开启。
- 只记录需要确认的用户纠正候选，不因此开启完整 Transcript 采集。

### 4.4 Pending Candidate Persistence（新增——替代 v0.1 的"跨宿主共享队列 + host_kind"方案）

v0.1 的 `signal_confirmations + host_kind` 设计被审查证伪（三宿主默认不同 workspace、不同 `trajectory.db`；`user_turn_rowid NOT NULL UNIQUE` 绑定 OpenClaw 专属行；生产者/消费者在 openclaw-plugin 内）。本节给出替代方案的完整技术比较与推荐。

**问题**：Codex 与 WorkBuddy 的歧义纠正候选如何在各自本地库中持久化，并被各自 Worker 可靠发现、处理和去重。

**候选载体技术比较**（基于当前源码复核）：

| 方案 | 证据 | 判定 |
|---|---|---|
| A. `governance_observations` | `rollout_row_id INTEGER NOT NULL`（store.ts:221）绑定 `governance_rollouts` 注册表，整表以 Codex rollout 身份为substrate；WorkBuddy 无 rollout 身份，写入即伪造 transcript substrate；retention 生命周期（operational/promoted/expired）与候选语义不匹配 | **否决** |
| B. OpenClaw `signal_confirmations` | `user_turn_rowid INTEGER NOT NULL UNIQUE`（trajectory-schema.ts:98）要求 OpenClaw `user_turns` rowid；Codex/WB 不写 user_turns（host-runtime/src/index.ts:277）；生产者/消费者在 openclaw-plugin | **否决**（v0.1 方案） |
| C. 新建 pending 表 | 违反 §7"不新增数据表"约束；无必要 | **否决** |
| D. **`governance_signal_admissions` 决策值域扩展** | 表已含 `host_kind`（多宿主列已就位）、`UNIQUE(logical_observation_key)` 幂等键、`decision TEXT NOT NULL` **无 CHECK 约束**、现成索引 `(decision, diagnostician_task_id)`；当前仅写 `'admitted'`（gsa:702 硬编码），reconcile 只扫 `decision='admitted'`（gsa:1652-1657）——新值对全部现有消费者**惰性**；Codex/WB 的候选本来就在 `admitGovernanceSignals` 事务内流动（现状 ambiguous 在 gsa:774 被丢弃为 `not_a_signal`） | **推荐** |

**推荐方案 D 的具体设计：**

1. **决策值域扩展**（非 DDL 变更，但属于行为契约变更，必须如实声明）：
   - `pending_llm_review`：Stage 1 ambiguous 命中时，在现有准入事务内写入（取代现状的静默丢弃）。`reason` 存命中词与摘要，`task_payload_json` 存 excerpt、命中词、`assistant_turn_available` 标记。
   - `resolved_none`：Worker Stage 2 判定 NONE 或低置信度后的终态（保留 reason 与 confidence 供审计）。
   - `abandoned`：超过 TTL 或重试上限后的终态。
2. **去重与幂等**：复用 `UNIQUE(logical_observation_key)`。Hook 重试天然不产生重复候选；同一候选只可能被处理一次。
3. **Worker 消费**：各宿主 Worker 新增步骤 `SELECT ... WHERE decision='pending_llm_review' ORDER BY id LIMIT n`（现成索引可用）；以 `task_payload_json` 内嵌 attempts 计数 + 乐观更新实现单消费者安全认领（沿用 OpenClaw 确认路径已验证的乐观锁模式）。每个 workspace 只有一个 Worker 消费者，无跨进程竞争。
4. **确认后的准入**：CORRECTION 且过 P-3 置信度门的候选，复用现有 `admitOne` 准入路径（写 `'admitted'` + canonical id + 诊断任务），并经过同一 `governance_correction_rate_limits` 限流桶——与 OpenClaw `confirmPendingSignal` 复用同一限流桶的语义对齐。
5. **TTL**：pending 候选超过 TTL（建议与 OpenClaw 队列 attempts≥5 语义对齐）转 `abandoned`，计数上报，不静默丢弃。
6. **实现约束**：所有新增查询使用参数绑定（沿用现有 prepared statement 风格）；不得拼接 SQL。

**显式 Schema 声明（不做零变更包装）**：

- 首选形态：**零 DDL**（无新列、无新索引、无新表）。`decision` 为无 CHECK 约束的 TEXT 列，值域扩展是行为契约变更而非 schema 变更；现有 `(decision, diagnostician_task_id)` 索引直接可用。
- 兜底形态：若 payload 内嵌 attempts 被证明不足以支撑 SQL 级过滤（例如需要 `WHERE attempts < 5` 的批量查询），则按仓库既有幂等 ALTER 模式（gsa:376-384 的 `ALTER TABLE ADD COLUMN` + 列存在性检查先例）新增 `attempts INTEGER NOT NULL DEFAULT 0`。这是**显式 schema 变更**：需迁移说明（历史行默认 0、加列幂等）、兼容策略（旧代码不读新列，安全）、回滚方案（停写新值即可，列保持惰性；无破坏性迁移）。
- 回滚总方案：停止写入新决策值即可整体回退；已存在的 pending 行对旧代码不可见、无副作用；不做破坏性清理。

### 4.5 Cross-host Invariant

三个宿主必须使用：同一关键词检测逻辑（含 P-1 防护）、同一高精度门槛、同一 LLM 分类 Prompt、同一 Stage 2 输出契约、同一纠正语义、同一 Pain 来源边界。

允许各宿主拥有不同的上下文采集与异步执行方式（这是现实，不是妥协：OpenClaw 有完整轨迹，Codex 有 rollout substrate，WorkBuddy 只有当前消息）。

不得为了形式上的一致性伪造缺失的行为证据。

**"同一 Pain 语义"的实现路径**：见 §5（PainIngress 语义接入 governance 准入）——在此之前，三宿主仅有"同一检测语义"，不宣称"同一 Pain 语义"已达成。

---

## 5. Admission Unification（修订）

现状（审查证实）：

- `PainIngress`（principles-core，纯函数语义层）：origin/correlation/evidence/lineage → submit/degrade/refuse/observation_only 判定。OpenClaw/CLI 在用。
- `governance-signal-admission`（host-runtime，事务性准入）：Codex/WorkBuddy 在用，但 `ensureGovernanceDiagnosticianTask` **硬编码** `provenance:'host_context_bound'`（gsa:1269），桥接端走 legacy payload 分支（pain-signal-bridge.ts:377-382）——三宿主的 Pain 语义实际上未统一。

**最小改造（Connection Before Creation）**：

在现有 `ensureGovernanceDiagnosticianTask` 准入路径中，使用 marker 已有数据构造 `PainIngressReport`，调用现有 `evaluatePainIngress()`，用其判定结果取代硬编码 provenance。

保持不变：

- 原有事务边界（单事务写 pain_events + admissions + 限流桶）。
- 幂等性（`UNIQUE(logical_observation_key)` + already_admitted 语义）。
- Canonical Identity（`deriveProductionCorrectionPainIdentity` 体系）。
- 现有诊断任务创建机制（asyncMode 入队）。

**不新建第三套 Admission Controller；不为统一而重构全部数据库事务。**

---

## 6. Legacy Mechanism Retirement（修订）

v0.1 退役表格的逐项修订（现状依据见审查报告 Part 5）：

| Mechanism | 现状 | v0.2 Required Action |
|---|---|---|
| Semantic Confusion | 两机制混淆：lifecycle.ts:111-117 版本只写 memory 不发 Pain（可删）；llm.ts:248-260 版本写 pain_events 行但诊断已被 triage 阻断 | 停止 llm_output 路径的无用 Pain 行写入（llm.ts:323-331 写行点在 triage 之前，必须覆盖）；删除检测分支；lifecycle memory 备注按现状保留或随删 |
| GFI Threshold | 触发存在（llm.ts:298-307）、诊断被阻断、仍写行 | 删 Pain 触发 + 停写；GFI 其余部分按 §6.3 有界退役 |
| LLM Paralysis | 同上（llm.ts:283-292；生产仍有 19 行 llm_paralysis） | 同 Semantic 处置 |
| Empathy Inferred | **已是死代码**（`buildEmpathyObservation` 生产零调用） | 随死代码清理删除（Phase 0）；注意 evidence-chain-contract 读模型保留历史字符串 |
| WEAK Signal | 活：唯一效果是喂 GFI（host:718-730） | 随 WEAK→GFI 分支删除；LLM 不可用降级改为"入 pending 候选" |
| Tool Failure Pain | **活（三宿主）；Codex/WorkBuddy 当前唯一自动 Pain 源** | **Phase B 验收后再删**（§9 Phase A）；删除时覆盖三条路径 + WB `admitBareHostPains` 及其报告字段 |
| Repeated Tool Failure | 活（OpenClaw）；Codex transcript 路径本就不生效 | 随 Tool Failure 删除；不引入"次数升级"替代 |
| RuleHost Block Pain | 活（仅 OpenClaw 旧路由，gate-block-helper.ts:198-275） | 删除自动 Pain 触发；**保留** §1.4 的错误阻止→Owner 纠正→Correction Detection 路径 |
| Fatal Intercept Pain | **活且绕过诊断前门禁**：painType 伪装 `tool_failure`、score 100（lifecycle.ts:152-168） | **优先整改**（见下） |
| Correction Sample Reject | 活：samples.ts:53-70 绕过 triage 直通；与 trajectory.ts:1332 双写 | 保留样本质量反馈；删除直通诊断触发；去重双写（见下） |

### 6.1 Preserve Existing Evidence

与 v0.1 相同，不得因此删除：Tool Call 轨迹、RuleHost 阻断事实、Assistant/User Turn、Principle Receipt、历史 Pain Event。它们不再独立创建 Pain。

### 6.2 Evidence Triage — 收缩而非直删

审查证伪了 v0.1"evidence-triage 只服务旧 Pain 来源"的前提：它当前有 8 个生产调用点，其中**手动 `/pd-pain` 的准入（pain.ts:573-598）与共享路由 tool-failure 路径（ppe:613-621、gsa:870-871）仍依赖它**。

收缩顺序：

1. 先迁移手动 `/pd-pain` 路径：优先直接复用现有 `PainIngress`（Owner 身份验证 `isOwnerManual`、幂等、冷却语义全部保留，cooldown 内联进手动路径）。**手动 `/pd-pain` 在整个过程中必须连续可用。**
2. Phase A 中随 Tool Failure 退役切断共享路由调用点。
3. 全部调用点切断后，整体删除 `evidence-triage` 模块 + `triage-adapter.ts` + `trigger-cooldown-tracker.ts`（OpenClaw 旧路由专用）+ `raw-observation-adapter.ts`。

**不保留一个只有恒等映射作用的庞大兼容引擎**（审查证实"只删 applyUpgradeRules 保留 1400 行恒等映射"认知负担更高）。

`admission-gate.ts`（诊断后门）与 TriggerController（诊断前门）职责不同，保留不动。

### 6.3 Fatal Intercept — 优先整改（新增）

**它实际绕过的门禁（精确表述，不笼统声称"绕过全部门禁"）：**

1. **绕过 Evidence Triage / TriggerController（诊断前准入门）**：`lifecycle.ts:152-168` 直接 `emitPainDetectedEvent`，不经任何 `evaluateTriage` 调用——这是 after_tool_call / gate / llm 路径都必须经过的门，Fatal Intercept 完全跳过。
2. **借用 `tool_failure` 身份规避来源策略**：painType 伪装为 `tool_failure` 且 score=100，使任何 score-based 策略视其为最高风险。
3. **不绕过**：PainIngress 语义层与 canonical 去重（它经 `emitPainDetectedEvent` → PainIngress），因此去重仍然生效。

整改要求：

- 不再创建宿主 Pain。
- 保留运行时健康/故障事实（安全拦截行为本身**不变**——Fatal Intercept 的宿主保护功能与其 Pain 上报是两件事，只动后者）。
- 保留必要的诊断与故障记录（健康日志/可观测面）。

### 6.4 Correction Sample Reject

- 保留样本质量反馈与 Correction Sample Learning（`maybeCreateCorrectionSample` 学习链路不回归）。
- 删除 samples.ts:53-70 的直接诊断触发（绕过 triage 的 `emitPainDetectedEvent`）。
- 解决 trajectory.ts:1332 与 samples.ts 的双写（可能产生重复 pain_events 行）——以单一写方为准。

### 6.5 GFI Bounded Retirement（替代 v0.1 全量退役）

**第一阶段（随 Phase C 执行，Pain 范围内）：**

- 删除 GFI Pain 触发（llm.ts:298-307）。
- 停止 Semantic/GFI/Paralysis 无用 Pain 行写入。
- **保留** GFI 健康观测面：`/pd-pain` GFI 条、Console "GFI 健康度"、CLI `pd runtime gfi` / snapshot / canary / diagnostics-export、operator-health read model（这些是活跃产品面，删除属产品决定，见 D2）。
- **保留** `tool_calls.gfi_before/gfi_after` 列并继续正常写入（它们参与 `REQUIRED_COLUMNS` schema 校验，且作为健康遥测无 Pain 语义）。
- **保留** session-tracker 及其 receipt 链依赖（session-tracker.ts:434-484）——不得因为 GFI 不再产生 Pain 就删除整个 Session Tracker；GFI 字段的去留是后续独立评估。

**第二阶段（独立于 Pain 迁移）：**

- 对真实部署 RuleCode 做**只读依赖扫描**（含真实 workspace 的 principle ledger / 激活实现源码中 `currentGfi` 的消费），明确外部消费者（现状：内置 RuleCode 零依赖，唯一命中是校验 fixture）。
- 扫描结果提交 Owner，决定健康观测面与剩余输入契约（`rule-host-contracts.ts:43`、`production-rulehost-gate.ts` 默认 0 注入）的去留。

---

## 7. Complexity Constraints

保留 v0.1 十条约束（不新增独立 Pain Detection Package / Pain Runtime / Diagnostician 前置 LLM 诊断 / PainEvidence/PainEpisode 数据表 / 异步 Worker 或后台进程 / 独立消息队列 / 功能开关 / 重复 Admission Controller / 不重复实现 PainIngress 与 PainToPrincipleService / 不因宿主不同创建不同 Pain 语义）。

**v0.2 诚实声明（不做零成本包装）：**

本方案包含以下**实质新增工作**，均为现有模块的职责扩展而非新架构：

1. core 层关键词匹配防护（P-1）——现有 `scanKeywords` 路径内的增强。
2. Stage 2 契约变更（prompt/schema/映射/置信度门）——§3.3 清单。
3. 分类器工厂从 openclaw-plugin 下沉到共享 owner（host-runtime），PiAiRuntimeAdapter 迁移 compat 入口——§3.4。
4. Codex/WorkBuddy Worker 各新增一个 Stage 2 消费步骤——§4.3/§4.4。
5. `governance_signal_admissions.decision` 值域扩展（行为契约变更，零 DDL 首选形态）——§4.4。
6. `ensureGovernanceDiagnosticianTask` 接入 `evaluatePainIngress`——§5。
7. Codex transcript 摄入三缺口修复——§4.2。

唯一可能的 DDL 变更是 §4.4 兜底形态的 `attempts` 列，须按其声明的迁移与回滚方案执行。

---

## 8. Acceptance Criteria

### Positive Cases

（继承 v0.1 全表：Owner 明确报告 → Owner-confirmed Pain；纠正错误理解/要求回到原始目标 → Correction；忽略明确约束 → 可成 Pain 证据；跨任务反复 → Diagnostician；任务成功但违背意图 → 不因成功排除。）

### Negative Cases

（继承 v0.1 全表：API 超时/工具失败/编译失败/复杂推理/RuleHost 正确阻断/Semantic Confusion/GFI 旧阈值/LLM Paralysis/Empathy 语言/Correction Sample Reject → No Pain。）

### High Precision Negative Tests（新增——P-1/P-4/P-5 的验收矩阵）

- 引号内的纠正表达不直接命中高精度直通。
- 转述中的纠正表达（"他说这是错的"）不直接命中。
- 第三人称描述不命中。
- 否定句处理符合预期。
- 普通口语（"我说的是""都说了"等日常高频语）不产生 STRONG 直通。
- 普通需求变更、事实信息补充不误判为纠正。
- 学习词误报：学习词命中不进入直通路径。
- 低置信度匹配不直接准入。

**WorkBuddy startsWith 删除必须以本矩阵全部通过为前置条件（P-5）。**

### Runtime Tests（新增）

- Codex Hook 满足宿主 5 秒硬超时约束（flag-on 摄入链实测耗时入验收）。
- WorkBuddy Hook 满足 12 秒自杀线约束。
- Stage 2 仅在 Worker 中执行，Hook 内零 LLM 调用。
- Worker 重试与幂等：同一 pending 候选不产生重复诊断任务（UNIQUE 键 + 乐观认领验证）。
- LLM 超时不误判为 NONE（进 pending/重试，可观察）。
- 不产生重复 Pain（canonical id 去重 + Correction Sample 双写修复验证）。
- 缺少前置 Assistant Turn 时显式标记缺失，不伪造上下文。
- 不自动开启 Transcript 采集（三 flag 默认值不变、关闭时零行为差异）。
- Pending 候选 TTL 到期转 abandoned 且计数可见。

### Pain Semantics Tests（新增）

- 正确 RuleHost Block 不产生 Pain。
- 错误 RuleHost Block 可经 Owner 纠正进入现有 Correction Detection / Pain 证据路径。
- 工具失败不产生 Pain（Phase A 后回归确认不再写 pain_events 行）。
- Fatal Intercept 不产生宿主 Pain，健康/故障记录仍产生。
- Correction Sample Reject 不直接产生宿主 Pain，样本学习不回归。
- 显式 Owner Pain Report 在所有阶段保持可用（含手动 `/pd-pain` 迁移期间连续性验证）。

### Regression

（继承 v0.1：PainIngress 原有边界、PainToPrincipleService 任务创建、PainSignalBridge 幂等、governance-signal-admission canonical identity、Correction Keyword Learning、历史 Pain Event 可读、RuleHost 实际执行与阻断行为不受影响。）

### Cross-host Tests

（继承 v0.1 全表，并新增：同一纠正候选在三宿主的 pending → Stage 2 → admission 全链路结果一致；`decision='admitted'` 以外的历史行对旧消费者惰性验证。）

---

## 9. Migration Plan（重排）

**执行顺序：Phase 0 → Phase B → Phase A → Phase C。每个阶段结束系统保持完全可用；默认关闭的生产功能保持关闭。**

### Phase 0 — Safe Cleanup（不依赖任何新能力）

1. 删除生产零调用死代码：`admission-events.ts` 工厂、`buildEmpathyObservation` / `buildLlmDetectionObservation`。
2. 停止 Semantic / GFI / Paralysis 无用 Pain 行写入（llm.ts:323-331 写行点 + 检测分支）。
3. 下线 Fatal Intercept 错误 Pain 路径（保留健康/故障记录与安全拦截行为）。
4. 下线 Correction Sample Reject 直通诊断，修复双写。
5. 收敛重复配置键（`painEvidenceAdmissionDefault` / `pain_evidence_admission_default` 同义双键，确认 loader 实际消费方后保留单一权威）。

**保留**：手动 Pain 准入现状、Tool Failure 过渡能力、全部轨迹记录。

### Phase B — Shared Correction Detection（先建设新能力）

1. core 引用与位置防护（P-1）+ 学习词升级门（P-2）+ 置信度门（P-3）。
2. 高精度负向测试矩阵（§8）落地并通过。
3. Stage 2 契约变更（§3.3 清单）+ 分类器工厂下沉 + PiAiRuntimeAdapter compat 迁移（§3.4）。
4. `governance_signal_admissions.decision` 值域扩展 + Codex/WorkBuddy 候选持久化与去重（§4.4）。
5. Codex Worker 接入 Stage 2（flag 边界不变）。
6. WorkBuddy Worker 接入 Stage 2（新增消费步骤，flag 默认关不变）。
7. `ensureGovernanceDiagnosticianTask` 接入 `evaluatePainIngress`（§5）。
8. Codex transcript 三缺口修复（§4.2）。
9. WorkBuddy startsWith 退役（以矩阵验收通过为唯一前置）。
10. 跨宿主正反向验收（§8 全表）。

### Phase A — Legacy Retirement（以 Phase B 验收为前置）

1. 删除 Tool Failure Pain 三条路径（OpenClaw after_tool_call、共享 ppe、Codex gsa `admitToolFailure`）。
2. 删除 Repeated Tool Failure 升级。
3. 删除 RuleHost Block 自动 Pain（保留错误阻止→Owner 纠正路径）。
4. 删除 WorkBuddy `admitBareHostPains` 及其报告字段依赖。
5. 收缩并删除旧 Evidence Triage（手动路径已迁移为前置）。
6. 保留全部原始技术轨迹与健康记录。

**手动 `/pd-pain` 全程连续可用。**

### Phase C — GFI Bounded Retirement（独立执行，不与 Pain 迁移捆绑）

按 §6.5 两阶段：先 Pain 范围内清理（保留健康面与字段），后经 D4 只读扫描结果由 Owner 决定剩余面。

各阶段均需显式迁移步骤与回滚路径；不触碰未经授权的生产部署。

---

## 10. Schema & Contract Changes（诚实清单）

| 变更 | 类型 | 迁移/兼容 | 回滚 |
|---|---|---|---|
| `governance_signal_admissions.decision` 新增值 `pending_llm_review`/`resolved_none`/`abandoned` | 行为契约变更（零 DDL；该列无 CHECK 约束） | 旧消费者全部按 `decision='admitted'` 过滤，新值惰性（gsa:1652 复核确认）；历史行不变 | 停写新值；遗留 pending 行不可见于旧代码，无副作用 |
| （兜底，仅当需要时）`attempts INTEGER NOT NULL DEFAULT 0` | **DDL 变更**（幂等 ALTER，沿用 gsa:376-384 先例） | 历史行默认 0；旧代码不读新列 | 列保持惰性；无破坏性迁移 |
| OpenClaw `signal_confirmations` | **不变更**（不加 host_kind，不放宽约束） | — | — |
| `pain_events` / `tool_calls`（含 gfi_before/after） | **不变更** | — | — |

---

## 11. Documentation Alignment

继承 v0.1 §10 全部同步项（PRODUCT_IDENTITY / ADR-0014 新决策记录 / DOMAIN_MODEL / GLOSSARY / INTERNALIZATION_PIPELINE / PD_ARCHITECTURE_OVERVIEW / SignalCollector 设计文档 / Codex·WorkBuddy 规范），补充：

9. `AGENTS.md §1.1`：按安装实况修正插件目录布局描述（审查证实为全量拷贝而非 symlink）——独立小改动，可与任一 PR 搭载。

---

## 12. Owner Decisions

只保留真正需要 Owner 决定的问题；已有明确技术答案的事项（原 D5 候选持久化选型）已在 §4.4 以技术证据定案并给出推荐，不再提交 Owner。

**D1 — Tool Failure Pain 退役时机**
代码审计无法决定产品风险偏好。选项：① 保留至 Phase B 验收后删除（**推荐**：零检测真空，退役推迟一个阶段）；② 立即删除（Codex/WorkBuddy 在新能力验收前仅剩显式报告与纠正检测）。

**D2 — GFI 健康观测面去留**
`/pd-pain` GFI 条、Console 健康度、CLI 面板是活跃产品面，删除属产品决定。**推荐：暂时保留，只删除 Pain 职责**（与 Fatal Intercept"转为健康记录"同一逻辑，避免三处产品面联动改动）；待 D4 扫描完成后一并终审。

**D3 — Confirmation Queue 定位**
生产事实：OpenClaw `signal_confirmations` 近 5 周零新增、confirmed 仅 2/15、消费者 flag 默认 OFF。**推荐：不扩展跨宿主共享队列；Stage 2 由各宿主 Worker 执行；现有 OpenClaw 队列仅作为本地过渡/兜底**（v0.2 §4.1/§4.4 即按此设计）。若 Owner 希望保留人工确认为主路径，需追加 consumer 默认开启的决策。

**D4 — 外部部署 RuleCode 的 `currentGfi` 依赖**
静态审计已达边界（内置零依赖，外部不可达）。**要求：对真实部署 RuleCode 做只读依赖扫描后再决定** GFI 第二阶段范围（§6.5）；扫描授权与范围由 Owner 批准。

---

## 13. Modification Record（相对 v0.1）

### 13.1 被推翻的原始假设

| v0.1 假设 | 证据 | v0.2 处置 |
|---|---|---|
| 队列跨宿主共享只需加 `host_kind`（§4.3/§7） | 三宿主不同 workspace/DB；`user_turn_rowid NOT NULL UNIQUE` 绑 OpenClaw rowid；生产/消费者在 openclaw-plugin | 删除；改为 §4.4 决策值域扩展方案 |
| 防引用/转述误报"由共享检测路径统一处理"（§3.2） | `scanKeywords` 为纯子串匹配，无任何防护 | 改为 P-1 前置条件 + startsWith 保留至验收 |
| 高精度命中直接准入为合理现状（§3.2） | 子串匹配×口语词表×学习词自动升直通×confidence 无门控 | 直通资格限定为种子词表 + P-1~P-5 前置 |
| Stage 2 二分是"复用现状"（§3.3） | 现契约含 empathy、映射忽略 confidence、SEMANTIC_CONFUSION 枚举不存在 | 列为显式契约变更清单 |
| evidence-triage 可整体删除（§6.2） | 兼任手动 `/pd-pain` 准入 + 共享路由 tool-failure 路径 | 改为"先迁移后收缩"（§6.2） |
| Empathy Inferred 有活跃自动 Pain 分流（§6） | 已是死代码 | 如实标注，随死代码清理 |
| GFI 无有效消费者即可全量删除（§6.3） | 健康观测面活跃 + gfi 列参与 schema 校验 + session-tracker 耦合 + 外部规则 UNVERIFIED | 改为有界退役两阶段（§6.5） |
| Phase A 先删后建可行（§9） | Tool Failure 是 Codex/WB 唯一自动 Pain 源 | 重排为 Phase 0→B→A→C |
| 基线 SHA `457bbf0fcd8d85c…` | 实际 `457bbf0fcd8df85c…` | 修正 |

### 13.2 保留的设计

Pain 语义定义与 Error-not-Pain 边界；两类信号来源与 supporting evidence 边界；共享 SignalCollector 核心（signal-collector 目录、scanKeywords、buildLlmPrompt、mapLlmResultToOutput、PiAiRuntimeAdapter 边界）；OpenClaw 两阶段结构与 `signal_confirmations` 原样保留；Codex/WorkBuddy 现有 Hook/Worker/flag 边界；admission-gate 与 TriggerController 的职责区分；§7 十条复杂度约束；v0.1 §8 大部分验收用例；ADR-0015 及 Unified Friction Observer 不作为实施依据的声明。

### 13.3 被删除的设计

`signal_confirmations + host_kind` 跨宿主共享队列；"学习词 TP≥3/FP=0 自动升 high 直通"；GFI 全量退役（Kernel/字段/健康面一次性删除）；"只删 applyUpgradeRules 保留恒等映射引擎"的收缩方式；先删后建的 Phase A→B 顺序。

### 13.4 被替换的设计

v0.1 §3.2 Stage 1 → v0.2 §3.2（直通五项前置条件 + 直通资格规则）。
v0.1 §3.3 Stage 2 → v0.2 §3.3/§3.4（契约变更清单 + adapter 迁移要求 + 证据保留）。
v0.1 §4.3/§7 队列 → v0.2 §4.4（pending 候选持久化：决策值域扩展，含比较、DDL 声明、回滚）。
v0.1 §5 准入 → v0.2 §5（PainIngress 接入 gsa，消除 provenance 硬编码）。
v0.1 §6 退役表 → v0.2 §6（逐项现状标注 + Fatal Intercept 优先整改 + 精确门禁表述）。
v0.1 §9 Phase A/B/C → v0.2 §9 Phase 0/B/A/C。

### 13.5 新增的必要 Schema 变更

首选形态零 DDL（`decision` 值域扩展，行为契约变更，§10 全量声明迁移/兼容/回滚）；兜底形态一个幂等 ALTER 列，仅在 payload 内嵌计数被证明不足时启用。

### 13.6 复杂度净变化

| 维度 | 变化 |
|---|---|
| 新包 / 新服务 / 新 Worker 进程 / 新表 / 新 Feature Flag | 0 |
| 新增数据库字段 | 0（首选）/ 1（兜底 attempts） |
| 新增决策状态 | 3 个（同一现有列的值域扩展） |
| 删除模块 | evidence-triage 全模块、triage-adapter、trigger-cooldown-tracker、raw-observation-adapter、admission-events、empathy 匹配死代码、WEAK→GFI 分流、Fatal Intercept Pain 路径、Sample Reject 直通、学习词直通升级 |
| 删除判定分支 | GFI/Paralysis/Semantic 检测分支、tool-failure 三条 Pain 路径、RuleHost Block 自动 Pain |
| 净效果 | **负**（删除量显著大于新增量；新增项全部为现有模块职责扩展） |

---

## 14. Final Decision

PD Pain Architecture 的核心目标不变：**让 PD 专注于识别宿主偏离 Owner 行为预期的证据，而不是监控宿主发生了多少技术异常。**

架构形态：

- 一个共享纠正检测核心（带统一防护与置信度门）。
- 三个轻量宿主适配（真实预算模型：OpenClaw fire-and-forget / Codex 5s / WorkBuddy 12s）。
- 一套已有证据准入和任务处理基础设施（PainIngress 语义统一接入）。
- 一个现有 Diagnostician 负责深层行为诊断。

不增加第二套检测体系，不增加第二套诊断体系，不增加新的 Pain 数据模型。

**成功标准不是新增了多少功能，而是删除了多少不再需要的机制，同时以验收证据（而非时间顺序承诺）证明没有损害 PD 已经成熟的纠正检测能力。**
