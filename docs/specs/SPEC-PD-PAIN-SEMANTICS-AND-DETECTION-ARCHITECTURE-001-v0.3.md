# PD Pain Semantics & Detection Architecture v1.0
## Evidence-driven Revision (v0.3)

**Status:** Superseded for implementation by v0.3.1（v0.3.1 为增量实施契约；本文保留为历史设计基线，不作当前生产状态声明）
**Revision:** v0.3（v0.2 定点证伪修订：Pending 状态机、事务与幂等契约、OpenClaw 兜底能力边界、词表与引用防护、跨宿主语义契约、GFI 阶段去重）
**Code Baseline:** `main@457bbf0fcd8df85c069b78ce60858acf742fe970`（交付时已复核 HEAD == origin/main == 此 SHA，无源码漂移）
**Current Implementation Status:** 见 `SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001-v0.3.1.md` §8（2026-11-07 最终收敛）与 `docs/reports/PAIN_ARCHITECTURE_FINAL_CLOSURE_2026-11-07.md`。
**Evidence Base:**
- `docs/reviews/2026-11-02-pain-architecture-spec-v0.1-audit.md`（v0.1 全仓审计）
- `docs/reviews/2026-11-02-pain-architecture-v0.2-targeted-review.md`（本轮定点审查，含对上轮审计两处结论的修正）
**Scope:** Pain Semantics / SignalCollector / OpenClaw / Codex / WorkBuddy
**Priority:** Core Architecture
**Change Authority:** Owner

---

## 0. Architecture Decision

目标不变：消除 Error/Failure 与 Pain 的概念混淆；保留并完善 OpenClaw 两阶段纠正检测；将共享检测能力接入 Codex/WorkBuddy；删除退役机制的 Pain 残留；删除工具失败与 RuleHost Block 的自动 Pain 准入；最大程度复用已有结构。

v0.3 相对 v0.2 的实质变化（详见 §13）：

1. **Pending 状态机定案**（§4.4）：修复 v0.2 中 §3.2（低置信度→待确认）与 §4.4（低置信度→resolved_none）的定义冲突；给出完整的转换图、事务与幂等契约、四个故障场景的处置。
2. **事实修正**（定点审查证实）：OpenClaw 确认消费在 `signal_collector`（默认 ON）门控下**实际在运行**；`correction_observer` 只门控学习/观察功能。v0.2 沿用的"消费者默认 OFF、队列停摆"表述被修正；真实边界是无行级 TTL、classifier 未配置时永久 pending、无周期外触发（§3.5/§4.1）。
3. **词表逐词裁定**（§3.2）：基于真实种子词表（代码内 SSoT）的逐词风险分类与降级清单；引用防护细化为七类语义规则；声明"学习词永不直通"是对 PRI-788 G3 现行设计的显式逆转。
4. **Worker 预算定案**（§4.4）：v0.2 隐含的"每轮 LIMIT 20"被证伪（会饿死诊断任务与 liveness）；改为每轮 ≤2 条 + 60s 分类超时 + 认领 TTL。
5. **跨宿主语义契约修正**（§4.5/§8）：统一的是语义契约与准入规则，不是 LLM 输出的逐字一致；给出 Diagnostician 上下文的**真实**能力清单（Goal/TaskIntent/Owner ledger 原则均不可用）。
6. **GFI 阶段去重**（§6.5/§9）：Phase 0 只处理 Semantic/Paralysis；GFI 触发与写入全部归 Phase C。
7. **实施范围收敛**（§4.2/§9）：Codex transcript 三缺口改为"未来开启 ingestion 的前置条件"（其中文件名解析缺口有一个不受 flag 门控的小型现役暴露面，单独说明）。

**核心原则不变：删除多余机制，统一现有能力，不再增加一套架构。**

---

## 1. Pain Semantics

### 1.1 Definition

（与 v0.2 相同，全文保留。）Pain 是宿主在执行任务、决策和与 Owner 协作的过程中，产生的与 Owner 原则、价值观、目标、意图及授权边界相关的行为偏差证据。Pain 的核心是 Owner 相关的行为偏差，而不是宿主是否正常运行。

### 1.2 Three Layers: Signal Capture / Pain Evidence / Pain Diagnosis

（与 v0.2 相同。）A. Signal Capture（捕获信号，不作结论）；B. Pain Evidence（经准入的行为-意图关联证据）；C. Pain Diagnosis（现有 Diagnostician 判定偏差与根因）。

### 1.3 Capability Boundary（诚实声明）

（与 v0.2 相同，另加本轮核实的诊断上下文事实，见 §4.6。）

- 自动纠正检测只是当前可落地的高价值信号来源，不是 Pain 的全部来源。
- Correction 不等于已经确认原则违反；它进入诊断，不预设结论。
- 当前没有静默偏差、长期目标漂移的自动发现能力；本次不新增。
- 明确禁止为此新增 BehavioralDeviationEngine 或 LongitudinalPainPatternDetector。

### 1.4 Error Is Not Pain — 含 RuleHost 特殊边界

（与 v0.2 相同。）技术失败不得独立形成 Pain；成功任务也可产生 Pain。

RuleHost 三分边界：

1. 正确阻止违反 Owner 原则的行为：不是 Pain。**Gate Block 事实本身不得自动创建 Pain**（Phase A 删除现有 `gate-block-helper.ts:198-275` 自动路径）。
2. 错误阻止 Owner 已明确授权的行为：可以成为 supporting evidence（进入 §2.3 的既有轨迹，供诊断关联）。
3. Owner 对 RuleHost 错误判断进行纠正：进入现有 Correction Detection，与普通纠正同路径。**不为 RuleHost 新增独立 Pain 检测器。**

### 1.5 Owner Behavioral Context

（与 v0.2 相同。）不创建新的 Owner 行为模型；缺失信息显式标记，不编造。

---

## 2. Pain Signal Sources

（与 v0.2 相同。）2.1 Explicit Owner Report（四入口，`explicitOwnerStatement` 跳过关键词为现状保留）；2.2 Automatic Correction Detection；2.3 Supporting Evidence 不自动创建 Pain。

---

## 3. Unified Correction Detection

### 3.1 Shared Core and Terminology

唯一共享检测核心仍是 `packages/principles-core/src/runtime-v2/signal-collector/`。术语：**Correction Candidate ≠ Pain；准入 ≠ 诊断结论**。

### 3.2 Stage 1 — Keyword Detection（v0.3 修订：词表逐词裁定 + 引用防护细则）

前置条件 P-1~P-5 保留（core 引用/位置防护；学习词升级门；置信度门；负向矩阵；WB startsWith 保留至验收）。本轮定点审查补齐以下事实与规则：

**3.2.1 种子词表现状与逐词裁定**

种子词表为代码内 SSoT（无独立 seed JSON）：high overlay（`governance-signal-admission.ts:113-123`）、empathy overlay（:126-128）、`CORRECTION_SEED_KEYWORDS` 16 词（`correction-types.ts:60-79`，weight≥0.7 → high）。匹配为裸子串 `includes`（`keyword-stage.ts:31`），无引号/否定/人称处理。

逐词裁定（v0.3 要求实施时按此调整代码常量）：

| 词 | 风险 | 裁定 |
|---|---|---|
| 不要自作主张 / 不应该这么做 | 低（强第一人称命令） | 保留 high |
| 你理解错了(0.8) / you are wrong(0.7) | 中低（第二人称指向） | 保留 high（加否定前置守卫） |
| 这是错的(0.9) | **极高**：转述/引用/条件句均命中 | 保留 high 但必须受 P-1 位置守卫约束（Codex 路径现状无任何守卫） |
| 我说的是(0.9) / 都说了(0.8) | **高**：日常高频口语，可被嵌入引用 | **降级 ambiguous** |
| 不是让你(0.85) / 谁让你(0.85) | 中：否定句含同形子串 | 保留 high（加否定前置守卫） |
| 又搞错(0.8) / 搞错了(0.7) / 理解错了(0.7) | 中：情绪化、可指第三方 | 保留 high（加第三人称前置守卫），负向矩阵不达标则降 ambiguous |
| 权重 <0.7 的种子（不对/错了/again 等） | 仅 ambiguous | 维持 ambiguous |

**3.2.2 引用与位置防护（P-1 细则）**

匹配层必须实现以下确定性规则（不新建 NLP 框架，全部在 `scanKeywords` 匹配路径内）：

1. **成对引号内的命中不单独构成 STRONG**；引号外存在第一/第二人称纠正语义段时按普通命中处理。
2. **第三人称转述前缀**（他说/她说/有人说/据说 等）紧邻命中词时降级 ambiguous。
3. **否定前置**（我不是让你/并不是/没让你 等）命中时降级 ambiguous。
4. 上表降级词（我说的是/都说了）无论位置只按 ambiguous。

**七类输入的预期走向**（负向矩阵验收基准）：

| 输入类型 | 预期 |
|---|---|
| 单纯引用第三方观点 | 不命中（引号内不单独成 STRONG） |
| 引用 Agent 原话 + 明确纠正，引号外含提示词 | 正常命中引号外提示词（**不得被一律过滤**） |
| 引用 Agent 原话 + 明确纠正，引号外无提示词 | 高精度不命中；走零命中 discovery 路径（预算内可达 Stage 2）——**如实声明为覆盖边界，不虚构已解决** |
| 第三人称转述纠正表达 | 降级 ambiguous → Stage 2 |
| 普通口语（我说的是/都说了单独出现） | 降级后不直通 |
| 否定语境 | 降级 ambiguous |
| 普通需求变化/信息补充（无词表词） | not_a_signal 或 discovery 路径，不产 Pain |

**3.2.3 学习词（P-2 的契约声明）**

现行设计：`source=llm` 学习词 TP≥3 且 FP=0 → `precision='high'`（gsa:167-178），经 `projectLearnedStore` 投影即获 `collectSync` 确定性 STRONG 直通（`needsLlmConfirmation=false`）——这是 PRI-788 G3 的**有意设计**。

v0.3 **显式逆转**该默认（契约变更，见 §10）：学习词升级后只进入 **Stage 2 优先候选**（ambiguous 词表 + 免 discovery 预算），**永不获得直通**；在共享防护与负向矩阵未累积足够精度证据前，"仅凭 TP/FP 计数升直通"的证据基础不成立。

**3.2.4 WorkBuddy startsWith 的真实语义（修正 v0.2 表述）**

`startsWith`（gsa:1078）是**句首提示词闸门**，不是逐词防线：前缀词与 collectSync 命中词**可以不同**（如"搞什么…这是错的"以歧义词开头、后文 high 词仍命中）。因此：P-5 保留它是合理的最小防线，但移除它之后的替代物必须是 P-1 位置守卫，而非假设"startsWith 已覆盖的语义"自动继承。

### 3.3 Stage 2 — LLM Correction Classification

与 v0.2 相同：目标语义收敛 Correction/None；变更清单（prompt/schema/映射/EMPATHY 降级/置信度保留）不变；reason、confidence、原始用户表达、可获得的 Assistant Turn 引用全部保留；Codex/WorkBuddy 缺前置 Assistant Turn 显式标记，不伪造。

v0.3 修订：置信度处理的完整语义移交 §4.4 状态机（修复 v0.2 §3.3/§4.4 的低置信度定义冲突）：

- **CORRECTION 且 confidence ≥ θ_confirm** → 进入 Pain Admission（§4.4 场景 A）。
- **NONE 且 confidence ≥ θ_none** → 终态 `resolved_none`（不确定性不得伪装成否定结论；低于 θ_none 的 NONE 不产生终态结论）。
- **低置信度（任一判定）** → 不创建 Pain、不产生终态；`attempts+1` 后回到 pending，达上限转 `abandoned`（原因=low_confidence）。**低置信度不得导致无限重复 LLM 调用**（上限见 §4.4）。
- **LLM 超时/异常** → 与低置信度同样处理（attempts+1 回 pending），**不得记为 NONE**。
- 阈值 θ_confirm/θ_none 为实现常量（建议初始 θ_confirm=0.7、θ_none=0.7，实施期以负向矩阵调参），常量值不是本 SPEC 的验收对象，可观察性是。

### 3.4 Runtime Dependency

（与 v0.2 相同。）共享工厂只依赖现有 Adapter 边界；PiAiRuntimeAdapter 从 `@earendil-works/pi-ai/compat`（pin 1.2.0，临时入口，`getModel` 已 deprecated）迁移到 pi-ai 现行 API 列为 Phase B 显式任务；迁移前 pin 不动；不新增第二套模型运行时。

### 3.5 Cost and Failure Boundaries — OpenClaw 兜底的诚实能力边界（v0.3 修正）

保留：歧义命中才确认调用；discovery 预算 6/h；不无限调用 LLM；种子高精度路径 LLM 不可用时仍可运行；同步 Hook 不被 LLM 阻塞（入队为同步 SQLite 写，刻意设计，signal-collector-host.ts:326-330 AUDIT-P2-01）。

**定点审查修正后的事实边界（替代 v0.2 的模糊表述）：**

- Stage 2 失败（抛错/超时返回 null）→ 候选写入 `signal_confirmations`（仅 ambiguous 且命中词非空的候选；高精度直通路径不入队）。
- 消费由 **`signal_collector`** 门控（默认 ON）："confirmation-consumer-only mode" 15 分钟周期（correction-observer-service.ts:409-428）；`correction_observer` 只门控学习/观察功能。生产 DB 复核：15 行 = confirmed 2 / rejected 7 / abandoned 6，pending 0——**无积压，机制在运行**。
- 真实边界（如实定义为 **best-effort fallback**，不宣称完整自动恢复）：
  1. **无行级 TTL**（schema 无过期列）；classifier 已配置但通道故障 → 约 5 个周期（~75 分钟）内 attempts≥5 转 abandoned（信号丢失但落库可查）；**classifier 未配置 → 整批跳过且不计 attempts，pending 永久停留**（correction-observer-service.ts:94-102）。
  2. **无周期外触发机制**：无 CLI 命令、无手动批量确认入口、OpenClaw 不运行则零消费。
  3. 可观察性存在且足够：`signal-health.json`（pendingCount 等）、`pd config doctor` 的 Signal detection health、SystemLogger 事件（7 天滚动）。
- 本 SPEC **不修改任何 flag 默认值**，不为该兜底新增 Worker 或触发机制；以上边界如实写入文档与 §8 测试。

---

## 4. Cross-host Integration

### 4.1 OpenClaw

（与 v0.2 相同：保留 `signal_confirmations` 原样，不加 host_kind，不要求他宿依赖 openclaw-plugin；删 WEAK→GFI/Empathy 残留/GFI 阈值触发；学习与检测维持分离。）

v0.3 修正事实性描述：该队列由 `signal_collector` 门控的消费周期正常运行（见 §3.5），其定位是 **OpenClaw 本地 best-effort 兜底**；能力边界以 §3.5 为准。

### 4.2 Codex

（与 v0.2 相同：现有 Hook/Worker/governance 准入；5 秒同步 Hook 内零 LLM；`codex_conversation_ingestion` 默认关闭不扩大授权。）

v0.3 收敛 Transcript 三缺口的实施范围（定点审查证据）：

| 缺口 | 现役暴露面 | 处置 |
|---|---|---|
| revert 文件名解析（`codex-transcript-locate.ts:34-44`） | **不受 flag 门控**：`validateCodexTranscriptPath` 被 `explicit-owner-statement.ts:96` 使用（仅校验路径不读内容）——revert 格式会话上的显式 Owner 声明路径校验会失败 | 小型独立正确性修复，允许作为 Phase 0 可选项或独立 follow-up（不阻塞本 SPEC 主体） |
| `.jsonl.zst` 压缩归档不可见 | 仅 catch-up（flag ON）与只读 CLI 诊断消费 | **未来开启 ingestion 的前置条件**，移出本 SPEC 实施范围 |
| SessionStart 时 rollout 延迟建档 | 仅 catch-up 消费 | 同上 |

`codex_conversation_ingestion` 保持默认关闭；本 SPEC 的 Phase 0/B/A 不依赖 Transcript 摄入开启。

### 4.3 WorkBuddy

（与 v0.2 相同：UserPromptSubmit 仅同步采集与 pending 写入；12 秒约束内零 LLM；Stage 2 由现有 Worker 新增步骤执行——如实声明为职责扩展；startsWith 按 §3.2 P-5 与 §3.2.4 处理；缺失 Assistant Turn 显式标记；`host.workbuddy`/`workbuddy_live_keyword_pain` 默认关不自动开启；不开启 Transcript。）

### 4.4 Pending Candidate Persistence — 状态机与事务契约（v0.3 全面修订）

**4.4.1 状态机（基于现有 `decision` 字段，最简设计）**

```
                    ┌────────────────────────────────────────────────┐
                    │  (Stage-1 ambiguous 命中, 准入事务内写入)         │
                    ▼                                                │
             ┌─────────────────┐    CAS 认领(claim)                    │
             │ pending_llm_review│◄──────────────┐                     │
             └───┬──────┬───────┘               │                     │
    CORRECTION   │      │  NONE 且 conf≥θ_none  │ attempts+1          │
    conf≥θ_confirm│     │  (高置信度否定)        │ (低置信度/LLM超时/异常)│
                 ▼      ▼                       │ (≤MAX_ATTEMPTS=5)   │
        ┌────────────┐ ┌───────────────┐        │                     │
        │  admitted  │ │ resolved_none │        │                     │
        │ (既有终值)  │ │  (新,终态)     │        │                     │
        └─────┬──────┘ └───────────────┘        │                     │
              │ ensureDiagnosticianTask          │ attempts≥5          │
              │ (既有 Case A/B 崩溃恢复适用)       │ 或年龄≥TTL(72h)      │
              ▼                                  ▼                     │
        诊断任务(既有机制)                   ┌───────────┐              │
                                          │ abandoned │──────────────┘
                                          │ (新,终态)  │  reason∈{low_confidence,
                                          └───────────┘   llm_error, ttl_expired}
```

- **CORRECTION 才能进入 Pain Admission**（经既有 `insertCorrectionPain` + 限流 + canonical id，语义不变）。
- **NONE 必须达到 θ_none** 才产生 `resolved_none`；不确定性停留 pending 或转 abandoned，绝不伪装为否定。
- 全部终态（admitted/resolved_none/abandoned）在 `reason` + `task_payload_json` 保留判定原因、confidence、必要证据。

**4.4.2 载体与幂等（全部一手复核）**

`governance_signal_admissions`（CREATE：gsa:347-363）：`host_kind`、`UNIQUE(logical_observation_key)` 幂等键、`decision TEXT NOT NULL`（无 CHECK）、索引 `(decision, diagnostician_task_id)`（:364-365）、`task_payload_json TEXT`（候选摘要/证据/审查结果的既有载体）。当前唯一写入值为 `'admitted'`（insertAdmissionMarker :699-705 硬编码），reconcile 仅扫 `decision='admitted'`（:1650-1657）→ **新决策值对所有既有消费者惰性**。

候选身份：Codex `codex|<rollout>|<turn>|user`（admission.ts:48）；WB `['workbuddy',session,generation]|user`（gsa:1126-1135）——均嵌入宿主会话身份，满足 rc-6 lineage 一致性。

**4.4.3 场景 A：Pending → Admitted（不得复用 admitOne 的 INSERT 路径）**

关键事实：`admitOne` 的 marker 预探（gsa:952-963）对任何已存在 key 返回 `already_admitted`（pending 行 canonical_pain_id 为 NULL 时返回空 id）——**因此确认转换必须使用专用函数**（同一 gsa 模块、同一事务模式），并给预探增加 pending 守卫（同 key 再交付时返回 pending-重复语义，不得返回空 id 的 already_admitted）。

专用确认函数（单事务，顺序固定）：

1. `UPDATE ... SET decision='admitted', canonical_pain_id=?, rule_version=?, reason=?, updated_at=? WHERE logical_observation_key=? AND decision='pending_llm_review'` —— WHERE 子句即 CAS；`changes!==1`（并发竞争败方）→ 回滚退出，零副作用。
2. 派生 canonical id（`deriveProductionCorrectionPainIdentity`，gsa:777-785——由宿主身份事实确定性派生，与 LLM 结果无关，故 pending 阶段与确认阶段派生一致）。
3. `pain_events` 去重探针（既有 duplicate 语义，:791-797）。
4. `tryConsumeRateLimit`（同一 `governance_correction_rate_limits` 桶，事务内，:802；被限流 → 抛 RateLimitedSignal 事务回滚 → **行停留 pending，不计 attempts**（非 LLM 失败），`review_result` 已持久化在 payload，后续周期仅重试数据库转换、不重复调用 LLM；TTL 兜底）。
5. `insertCorrectionPain`（既有）。
6. 事务外：`ensureGovernanceDiagnosticianTask`（既有，幂等）→ 崩溃恢复由既有 reconcile Case A/B 承担（`decision='admitted' AND task_id IS NULL`，:1652-1657 + 任务创建 Case B 收敛 :1286-1297，均已一手复核）。

结果：不产生重复记录（UNIQUE+CAS）、不产生重复 Pain（canonical 去重探针）、不产生重复诊断任务（确定性 task id + PK 收敛）、限流与证据创建保持既有语义（同一事务）。

**4.4.4 场景 B：Worker 并发**

并发可能性真实存在：worker 由 pd-companion 每 workspace spawn 一个子进程（120s 周期），**无 OS 级单实例锁**（任务并发由 Runtime V2 task lease 保护；registry release-identity handover 只防新旧双实例）——手动 `pd-cli <host> worker` 可与 companion worker 并发。

防护 = 两级 CAS，均不依赖 UNIQUE 约束：

- **认领 CAS**：`UPDATE ... SET task_payload_json=<附 claimed_at/attempt 的载荷> WHERE key=? AND decision='pending_llm_review' AND task_payload_json=<原载荷文本>` —— 载荷全文比对乐观锁；`changes===0` → 本周期跳过该行。
- **终态 CAS**：场景 A 第 1 步的 `WHERE decision='pending_llm_review'` changes 检查。

最坏代价是并发双方各消耗一次 LLM 调用（结果正确性不受影响）；判定"只有一个有效消费者完成状态转换"的依据是 changes 计数，不是 UNIQUE。

**4.4.5 场景 C：Worker 崩溃恢复**

- LLM 已返回、payload 未写 → 认领 TTL（建议 10 分钟）过期后行可被重新认领，重新调用 LLM（浪费一次调用，结果正确）。
- LLM 结果已写入 payload、终态转换前崩溃 → 下一周期读取 `review_result` **直接做数据库转换，不再调用 LLM**。
- marker 已转 admitted、task link 未写 → 既有 reconcile Case A/B 恢复（:1652-1657）。
- 任务已建、link 未写 → 既有 Case B 收敛（:1286-1297）。

**4.4.6 场景 D：TTL 与重试**

- **attempts 计数时机**：每次完成的 LLM 审查（无论成功/超时/异常/低置信度）写回 payload 时 +1。不计入：限流导致的终态转换重试（无 LLM 调用）、认领过期后的重认领（若 LLM 结果已在 payload 则零 LLM 重做）。
- **上限**：MAX_ATTEMPTS=5（与 OpenClaw `SIGNAL_CONFIRM_MAX_ATTEMPTS` 对齐）。
- **TTL**：`created_at` 起算，建议 72 小时；过期 pending → `abandoned(reason=ttl_expired)`，由 worker 步骤在批处理时判定（批次有界，内存过滤即可，**不要求 SQL 级过滤**；若性能证据要求，才启用 §10 兜底 DDL）。
- **超时 vs 低置信度的不同处理**：两者都 attempts+1 回 pending，但 `reason` 分别记录 `llm_error` / `low_confidence`，终态 abandoned 携带末次原因。
- 终态行永久保留（可审计），不清理。

**4.4.7 Worker 执行边界（v0.3 定案，替代 v0.2 的隐含 LIMIT 20）**

定点审查证伪大批次：worker 周期 120s、每周期恰好 1 个诊断任务、诊断 LLM 默认超时 300s（adapter :675）——每轮 20 条 Stage-2 最坏 20×300s 将饿死诊断与 liveness 判活。定案：

- **每周期 Stage-2 候选 ≤ 2 条**（LIMIT 2，与后处理 LIMIT 2/cycle 同量级）。
- **Stage-2 分类调用使用独立短超时**（`timeoutMs` 每调用可传，建议 60s——分类 prompt 远小于诊断 prompt；不得复用 300s 默认）。
- 周期墙钟守卫：本周期预算耗尽则跳过剩余候选（下一周期继续）。
- 确认路径触碰 tasks（ensureGovernanceDiagnosticianTask）→ 作为与 reconcile 相邻的**串行步骤**执行，沿用 RuntimeStateManager 每步开闭纪律（:1243-1311 现状模式）；marker 表操作的正确性由 SQLite 单写者 + 事务 CAS 保证（如实声明：不引入新锁框架）。
- **不新增 Worker 进程、不新增 Feature Flag**：Codex/WB 的 Stage-2 步骤随现有 worker 周期执行；是否执行由"是否存在 pending 行"决定，无独立开关（现有 flag 边界不变）。

**4.4.8 对现行"静默"契约的显式变更**

现行：ambiguous 候选 = "no pain, no task, no quota, **and no marker**"（gsa:772-774，SPEC §18 scenario 6 明文静默）。本方案将 ambiguous 候选写入 pending marker——这是对该契约的**显式变更**（静默 → 可审计候选），限流/无 Pain/无任务三不变。见 §10。

### 4.5 Cross-host Invariant（v0.3 修订：语义契约一致 ≠ LLM 输出逐字一致）

三个宿主必须统一：同一关键词检测逻辑（含 P-1 守卫）、同一高精度门槛与词表裁定、同一 LLM 分类 Prompt、同一 Stage 2 输出契约、同一置信度阈值语义、同一准入规则（§4.4 状态机 + §5 语义接入）、同一 Pain 来源边界。

**允许并预期的差异**：上下文不同 → 分类置信度可以不同 → 允许保守降级（如 WorkBuddy 缺前置 Assistant Turn 时证据标记缺失、置信度偏低、候选可能落入低置信度路径）。这不违反不变量：**相同输入 + 相同有效上下文必须满足相同检测契约**；上下文差异导致的判定差异是诚实的，不是不一致。

不得伪造上下文；不得因 WorkBuddy 上下文简化而开启完整 Transcript 采集。

### 4.6 Diagnostician 上下文现实（v0.3 新增，替代猜测性表述）

定点审查沿 `executePendingDiagnosis → runner.run → buildContext → assemble → buildPrompt` 真实链路核实：

| 上下文 | 现状 | 状态 |
|---|---|---|
| reasonSummary / source / severity / evidence[] | 三宿主可用 | ✅ 当前能力 |
| correctionEvidence（显式纠正原文） | 进 PHASE 1.5 专属块 + diagnosisTarget JSON（bridge:408-432 → assembler:404-425 → builder:186-200） | ✅ 当前能力 |
| Owner 原则 | **注入的是 10 条固定核心公理**（core-axiom-block.ts:1-16），不是 Owner ledger 原则；ledgerAdapter 仅诊断后使用 | ⚠️ 部分（如实命名） |
| conversationWindow（会话轨迹回退） | 需 trajectoryTurnReader，仅 OpenClaw 注入；Codex/WB worker 未注入 → 首轮恒空 | ⚠️ 宿主差异 |
| fullTrace | state.db 中同 sourcePainId 的其它任务 runs，常 unavailable_with_reason | ⚠️ 部分 |
| INTENT.md（最接近 Task Intent 的存在） | `intent_engineering` 默认 **false** + 仅 OpenClaw 接线 | ⚠️ 默认不可用 |
| Goal / Task Intent / Owner ledger 原则 / 跨任务历史 / 历史 Correction 汇总 | **均不可用** | ❌ 未来方向 |

本 SPEC 不虚构以上任何能力：**当前能力**=上表 ✅ 项；**未来方向**=❌ 项（不在本次实施范围）；⚠️ 项按宿主差异如实传递给诊断流程。长期行为偏差分析（跨任务模式）属于未来方向，本次不做、不宣称。

---

## 5. Admission Unification（v0.3：真实字段映射）

现状不变：`PainIngress`（principles-core，纯函数语义层，`evaluatePainIngress` 为唯一权威）+ Codex/WB 事务性准入；`ensureGovernanceDiagnosticianTask` 硬编码 `provenance:'host_context_bound'`（gsa:1269，一手复核确认）。

**改造：在 ensureGovernanceDiagnosticianTask 准入路径用 marker 数据构造 `PainIngressReport`，调用 `evaluatePainIngress()`。**

**Governance Marker → PainIngressReport 字段映射**（以 openclaw-plugin/hooks/pain-ingress-adapter.ts 构造为参照，pain-ingress.ts:125-151 的 buildLegacy/deriveProvenance 为权威）：

| Report 字段 | 来源 | 说明 |
|---|---|---|
| origin.kind | 显式 Statement → `owner_manual`；关键词/Stage-2 纠正 → `automatic_hook` | 与 plugin adapter（:82-85）同构 |
| origin.channel / source | 按宿主与通道取 payload 契约枚举；**pain-ingress-payload 需扩展 codex/workbuddy 通道枚举**（见 §10） | 不复用 openclaw 专属通道值 |
| correlation | `{status:'bound', hostKind, rootSessionId, rolloutIdentity, logicalObservationKey, hostTurnId}` ← marker 列 + payload | marker 天生 bound，永不 unbound；rc-6 由 `isCodexLineageConsistent`（pain-ingress.ts:107-111）与 payload 校验执行 |
| evidence.entries | 触发用户文本 + correctionEvidence 构造 `behavior_trace` 条目；sourceRef 命名沿用 `user_message:<ts>` 等惯例 | **必须至少包含触发文本条目**：否则 `automatic_hook + evidence unavailable → observation_only`（pain-ingress.ts:198-207）会阻断现有 Codex 纠正准入能力——映射不得造成能力回退 |
| identity | 显式 → `manual_pain_id(canonical)`；自动纠正 → observation 识别（payload 契约既有 kind） | painId 用既有 canonical id，不新铸 |
| painType / source / reason / score | marker payload 既有字段直传 | — |
| **provenance** | `deriveProvenanceFromIngressFacts(origin, correlation)`（pain-ingress.ts:24,126） | **禁止硬编码**，取代 'host_context_bound' |

四种 decision 的处理（pain-ingress.ts:157-239 既有语义，保持不变）：

- **submit** → 按既有路径建任务（payload/legacy 字段进 `recordPain`）。
- **degrade**（Owner 显式 + 证据不可用）→ 照常提交、携带诚实空证据与 warning（Owner 报告不得因证据缺失被拒）。
- **refuse**（lineage 不一致 / origin-correlation 违例）→ 记录 reasonCode，不建 Pain、不建任务（可观察，rc-6 硬约束）。
- **observation_only**（自动 + 无绑定/无证据）→ 无任务无 LLM，仅可观察投影；§5 映射通过 evidence 条目要求避免正常纠正落入此支。

保持：原有事务边界、幂等（UNIQUE + Case A/B）、canonical identity、诊断任务创建机制。不新建第三套 Admission Controller。

**发现的契约缺口（实施前置）**：`PainIngressCorrelationV1` 当前无 `workbuddy` 变体（pain-ingress-payload.ts:44-55，定点审查新发现）；且上下文装配器将 `hostKind:'workbuddy'` 丢弃为 undefined（sqlite-context-assembler.ts:453-456）。两者必须在 Phase B §5 接线时一并修复，属核心类型/映射扩展，列入 §10。

---

## 6. Legacy Mechanism Retirement

退役总表与 v0.2 相同（十机制逐项现状与处置不变），含：Semantic/Paralysis 写行在 triage 之前（llm.ts:312-317 事件 + :323-331 pain_events，须一并停写）；Empathy 死代码随删；Tool Failure 三路径 + WB `admitBareHostPains` 待 Phase B 验收后删；RuleHost Block 自动 Pain 仅 OpenClaw 旧路由；Fatal Intercept 与 Sample Reject 直通优先整改（§6.2/§6.4 边界表述不变）。

### 6.1 Preserve Existing Evidence（不变）

### 6.2 Fatal Intercept / Sample Reject（与 v0.2 相同：精确门禁表述、去重双写、样本学习不回归）

### 6.3 Evidence Triage — 收缩而非直删（与 v0.2 相同：手动 `/pd-pain` 先迁移，全程连续可用）

### 6.4 GFI Bounded Retirement（v0.3：阶段边界去重）

**Phase 0 范围（仅此两项）**：Semantic 检测与无用写行；LLM Paralysis 检测与无用写行。定点审查证实三分支共享局部变量但可独立删除（删 :247-260 与 :284-292、painScore 置 0，:296-307 GFI 分支原样保留）；assistant_turn（:208-224）/task_outcome（:233-244）记录与检测零耦合，不动。

**Phase C 范围（唯一实施阶段）**：GFI Pain 触发（llm.ts:296-307）+ GFI 相关无用写入 + GFI Pain 路径清理。**Phase 0 不触碰 GFI。**

两阶段共同边界（不变）：健康观测面保留（`/pd-pain` GFI 条、Console、CLI、operator-health）；`tool_calls.gfi_before/after` 列保留并继续写入（REQUIRED_COLUMNS 校验 + 健康遥测）；session-tracker 及 receipt 链不动；GFI 摩擦累积的健康侧生产者（host:724 / after-tool-call:251 / pain:545）随 D2 处置；第二阶段经 D4 只读扫描后由 Owner 决定剩余面。

每项删除只有一个实施阶段与验收责任（Phase 0=Semantic/Paralysis；Phase C=GFI）。

---

## 7. Complexity Constraints

（与 v0.2 相同的十条不变约束。）

v0.3 实质新增工作清单（全部为现有模块职责扩展，更新自 v0.2）：

1. core 关键词匹配防护（P-1 细则 + §3.2.1 词表常量调整）。
2. Stage 2 契约变更 + 置信度状态机语义（§3.3/§4.4）。
3. 分类器工厂下沉 + PiAiRuntimeAdapter compat 迁移（§3.4）。
4. Codex/WB Worker 各新增一个 Stage-2 消费步骤（≤2 条/周期、60s 超时、认领 TTL，§4.4.7）。
5. `decision` 值域扩展（pending_llm_review/resolved_none/abandoned）+ `admitOne` 预探 pending 守卫 + 专用确认函数（§4.4.3）。
6. `ensureGovernanceDiagnosticianTask` 接入 `evaluatePainIngress` + pain-ingress-payload 的 workbuddy/通道枚举扩展（§5）。
7. Phase 0 可选项：revert 文件名解析小修复（§4.2）。

无新包/新 Worker 进程/新表/新 Feature Flag/新消息队列。

---

## 8. Acceptance Criteria

Positive / Negative 全表继承 v0.1-v0.2。v0.3 修订与新增：

### High Precision Negative Tests（更新）

- `他说这是错的` 不得直接 STRONG（**Codex 子串路径当前无此保护且无测试——双缺口，本项为新增验收**）。
- `我说的是` / `都说了` 不得仅凭子串命中直接准入（词表降级后验证）。
- 引用 Agent 原话并明确纠正：引号外含提示词 → 正常命中；引号外无提示词 → 高精度不命中、discovery 可达（如实在案）。
- 单纯第三方引用 / 第三人称转述 / 否定语境 → 不直通。
- 普通需求变化与信息补充不误判。
- 学习词永不直通（**逆转 PRI-788 G3 后的行为验证**）。
- 低置信度匹配不直接准入。
- WorkBuddy startsWith 退役以上述全矩阵通过为唯一前置。

### Pending State Machine Tests（新增）

- 高置信度 CORRECTION → admitted → 恰好一个诊断任务；重复确认零副作用。
- 高置信度 NONE → resolved_none；低置信度 NONE **不得**产生 resolved_none。
- 低置信度/LLM 超时/异常 → attempts+1 回 pending；≥5 → abandoned 且原因正确；全过程无 Pain、无任务。
- LLM 超时不被记为 NONE（负向断言）。
- 并发双 worker 认领：恰好一个 changes=1（CAS 证据，非 UNIQUE 证据）。
- 崩溃恢复四分支（§4.4.5）各自可验证；marker 已 admitted 无 task link → reconcile 补链。
- TTL 过期 → abandoned(reason=ttl_expired)；限流阻塞 → 行停留 pending 且 attempts 不变。
- 决策新值对既有消费者惰性（reconcile 只扫 admitted 的回归）。

### Runtime Tests（更新）

- Codex Hook 5s / WB 12s 约束；Stage 2 仅在 Worker 中执行。
- Worker Stage-2 步骤 ≤2 条/周期、60s 超时生效、同周期诊断任务不被饿死（liveness 不失真）。
- OpenClaw 兜底边界按 §3.5 断言：classifier 未配置 → pending 不计 attempts（现状行为钉住）；无 CLI 触发（不虚构能力）。
- LLM 超时不误判 NONE；无重复 Pain；缺上下文显式标记；不自动开启 Transcript。
- PainIngress 接入后：Codex/WB 纠正不因 observation_only 回退（evidence 条目要求验证）；refuse 路径可观察。

### Pain Semantics Tests / Regression

（与 v0.2 相同：RuleHost 三分、Fatal Intercept/Sample Reject 不产 Pain、手动 `/pd-pain` 连续可用、PainIngress/Governance/Bridge/Diagnostician/Learning/历史数据回归。）

### Cross-host Tests（v0.3 修订）

- 同一候选在三宿主满足**同一语义契约与准入规则**；上下文不同导致的置信度差异是允许结果（断言契约一致，不断言 LLM 输出逐字相同）。
- 相同输入 + 相同有效上下文 → 相同检测契约结果。
- `decision='admitted'` 以外历史行对旧消费者惰性验证。

---

## 9. Migration Plan（v0.3：GFI 阶段去重 + 范围收敛）

**执行顺序：Phase 0 → Phase B → Phase A → Phase C。每阶段结束系统完全可用；默认关闭的功能保持关闭。**

### Phase 0 — Safe Cleanup

1. 删除零调用死代码（admission-events 工厂、buildEmpathyObservation/buildLlmDetectionObservation）。
2. **停止 Semantic 与 LLM Paralysis 的检测及无用 Pain 写行**（llm.ts 检测分支 :247-260/:283-292 + 写行点 :312-317/:323-331 中对应来源）。**不含 GFI。**
3. 下线 Fatal Intercept 错误 Pain 路径（保留健康/故障记录与安全拦截）。
4. 下线 Correction Sample Reject 直通，修复双写。
5. 收敛重复配置键（双 admission 键）。
6. （可选，独立小修复）revert 文件名解析缺口——影响 revert 会话上的显式 Owner 声明路径校验，与 ingestion 开关无关。

保留：手动 Pain 准入、Tool Failure 过渡能力、全部轨迹。

### Phase B — Shared Correction Detection

1. P-1 防护实现 + 词表常量调整（§3.2.1 降级清单）+ P-2 学习词门（逆转 G3）+ P-3 置信度门。
2. 高精度负向矩阵落地并通过（含 `他说这是错的` Codex 路径新增测试）。
3. Stage 2 契约变更 + 分类器工厂下沉 + compat 迁移。
4. `decision` 值域扩展 + 专用确认函数 + `admitOne` pending 守卫（§4.4.3）。
5. Codex Worker Stage-2 步骤（≤2/周期 + 60s 超时 + 认领/TTL 常量）。
6. WorkBuddy Worker Stage-2 步骤（同边界）。
7. `ensureGovernanceDiagnosticianTask` 接入 `evaluatePainIngress` + pain-ingress-payload workbuddy/通道扩展 + 装配器 hostKind 丢失修复。
8. 跨宿主验收（§8 全表）。
9. WorkBuddy startsWith 退役（矩阵通过为唯一前置）。

（Transcript `.zst`/延迟建档修复**不在本 Phase**——见 §4.2 前置条件表。）

### Phase A — Legacy Retirement（Phase B 验收为前置）

（与 v0.2 相同六项：Tool Failure 三路径、Repeated、RuleHost Block 自动 Pain、WB admitBareHostPains、Evidence Triage 收缩（手动路径已迁移为前置）、轨迹保留。手动 `/pd-pain` 全程连续可用。）

### Phase C — GFI Bounded Retirement（独立执行）

GFI Pain 触发（llm.ts:296-307）+ GFI 相关无用写入——**本阶段唯一实施责任区**。健康观测面/字段/session-tracker 保留；第二阶段经 D4 扫描后 Owner 终审。

---

## 10. Schema & Contract Changes（诚实清单，更新）

| 变更 | 类型 | 迁移/兼容 | 回滚 |
|---|---|---|---|
| `governance_signal_admissions.decision` 新增 `pending_llm_review`/`resolved_none`/`abandoned` | 行为契约变更（零 DDL；列无 CHECK） | 既有消费者全部按 `decision='admitted'` 过滤（gsa:1652 复核）；新值惰性 | 停写新值；遗留行不可见于旧代码 |
| **对 gsa:772-774 静默契约（§18 scenario 6）的显式变更**：ambiguous 候选从"无 marker"改为写入 pending marker | 行为契约变更 | 无 Pain/无任务/限流三不变；UNIQUE 键防重复 | 停写即恢复静默 |
| **逆转 PRI-788 G3**：学习词不再升 high 直通 | 行为契约变更 | 学习词降入 ambiguous 优先候选；`projectLearnedStore` 投影逻辑调整 | 恢复 G3 投影 |
| `pain-ingress-payload` 扩展：workbuddy correlation 变体 + codex/workbuddy 通道枚举（定点审查新发现缺口） | 核心类型扩展（加法） | 既有 openclaw/codex 序列化不变；payload validator 同步 | 类型加法，可逆 |
| `admitOne` 预探 pending 守卫（同 key pending 再交付返回 pending 语义而非空 id already_admitted） | 行为修正 | 仅影响 pending 行存在时的重交付路径 | 可逆 |
| （兜底，仅当性能证据要求）`attempts INTEGER NOT NULL DEFAULT 0` 幂等 ALTER | **DDL 变更** | 历史行默认 0；旧代码不读 | 列惰性保留 |
| OpenClaw `signal_confirmations` / `pain_events` / gfi 列 | **不变更** | — | — |

---

## 11. Documentation Alignment

（继承 v0.2，含 AGENTS §1.1 布局描述修正；另补：SignalCollector 设计文档同步 §3.5 兜底边界与 §4.4 状态机。）

---

## 12. Owner Decisions（更新）

**D1 — Tool Failure Pain 退役时机**。推荐：保留至 Phase B 验收后删除（Phase A 前置即此）。

**D2 — GFI 健康观测面**。推荐：暂时保留，只删 Pain 职责；摩擦累积的健康侧生产者（含手动 pain 的 trackFriction）随本决策一并定去留。

**D3 — Confirmation Queue 定位（v0.3 修正依据后的推荐，结论不变）**。定点审查修正了"消费者默认 OFF"的误判：OpenClaw 消费周期在 `signal_collector` 门控下正常运行，队列是**有界 best-effort fallback**（无行级 TTL、无周期外触发、classifier 未配置时永久 pending）。推荐不变：不建跨宿主共享队列；Stage 2 由各宿主 Worker 执行；OpenClaw 队列保持本地兜底现状（含其已知边界，不再追加机制）。

**D4 — 外部部署 RuleCode 的 `currentGfi` 依赖**。要求真实工作区只读扫描后再决定 GFI 第二阶段范围。

（v0.2 的 D5 候选持久化选型已于 v0.2 §4.4 技术定案；本轮按定点审查进一步落实为状态机与事务契约，仍非 Owner 事项。）

---

## 13. Modification Record（v0.2 → v0.3）

### 13.1 被定点审查推翻/修正的 v0.2 内容

| v0.2 内容 | 定点审查证据 | v0.3 处置 |
|---|---|---|
| §4.1/§12-D3："消费者 flag 默认 OFF、队列停摆" | 双 flag 解耦：signal_collector(ON) 门控确认消费周期（correction-observer-service.ts:409-428）；生产 15 行 pending=0 | §3.5/§4.1 修正为 best-effort fallback + 真实边界；D3 依据修正、结论不变 |
| §4.4 隐含"每周期 LIMIT 20" | worker 周期 120s/1 诊断任务/LLM 300s 超时——20 条饿死诊断与 liveness | §4.4.7 定案 ≤2/周期 + 60s + 认领 TTL |
| §3.2(P-3) 低置信度→待确认 vs §4.4 低置信度→resolved_none（自相矛盾） | — | §4.4.1 状态机统一：低置信度永不终态，attempts+1 回 pending |
| §4.4 "复用 admitOne 准入路径" | marker 预探 :952-963 对任何已存 key 返回 already_admitted（pending 行→空 id） | §4.4.3 专用确认函数 + 预探 pending 守卫 |
| §4.2 transcript 三缺口列入 Phase B | 文件名缺口不受 flag 门控（explicit-owner-statement.ts:96）；zst/延迟建档仅 catch-up 消费 | §4.2 表：文件名=Phase 0 可选小修；zst/延迟=未来开启 ingestion 前置，移出范围 |
| §5 只写"调用 evaluatePainIngress()" | payload 无 workbuddy correlation 变体（pain-ingress-payload.ts:44-55）；装配器丢 workbuddy hostKind；automatic+无证据→observation_only 会阻断现有准入 | §5 完整字段映射 + 类型扩展 + evidence 条目要求 |
| §3.2 P-2"学习词永不直通"未声明与现行设计关系 | TP≥3/FP=0 升直通是 PRI-788 G3 有意设计（gsa:167-178 + projectLearnedStore） | §3.2.3 声明显式逆转，列入 §10 契约变更 |
| §9 Phase 0 与 Phase C 均含 GFI 写行清理 | 三分支共享变量但可独立删除；写行点 :312-317/:323-331 | §6.4/§9：Phase 0=Semantic/Paralysis，Phase C=GFI 唯一责任区 |
| 上轮审计两处连带修正 | 同上（消费门控误判）；"Owner Principles 注入"实为 10 条固定公理非 ledger（core-axiom-block.ts:1-16） | §4.6 真实上下文清单；v0.1 审计报告按纪律不回改，以本轮报告为准 |

### 13.2 保留（与 v0.2 一致）

Pain 语义与三层边界、RuleHost 三分、共享检测核心与 Stage 2 契约变更方向、三宿主执行方案（OpenClaw 队列原样/Codex 5s 模型/WB 12s 模型）、`decision` 值域扩展的载体选型（governance_signal_admissions）、PainIngress 接入方向、GFI 有界退役、Phase 0→B→A→C 顺序、§7 十条约束、v0.2 §10 的 DDL 声明框架。

### 13.3 新增/收紧

Pending 状态机与四场景事务契约；词表逐词裁定与引用七类规则；Worker 执行边界数值；Diagnostician 真实上下文清单（§4.6）；PainIngress 完整字段映射与契约缺口；transcript 范围收敛表；GFI 阶段去重；OpenClaw 兜底诚实边界。

### 13.4 复杂度净变化

新增决策值 3（同一现有列值域）；核心类型加法 2（correlation 变体 + 通道枚举）；新增函数 ~3（确认函数、预探守卫、worker 步骤）；删除量与 v0.2 持平（十机制退役 + evidence-triage 模块族 + 死代码）。净效果仍为**负**；无新包/Worker 进程/表/flag/队列。

---

## 14. Final Decision

（与 v0.2 相同的收束表述，附 v0.3 注脚：所有跨宿主契约以"语义与准入规则统一、上下文差异诚实标记"为准；所有删除以验收证据为前置；所有能力边界以定点审查证据为准，不虚构。）
