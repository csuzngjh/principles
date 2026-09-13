# PRI-750 — Learning Loop Capability Reality Audit

- 日期：2026-09-13
- 调查人：AI（CNB NPC `PD Developer`，Issue #13；遵循 AGENTS.md P1 Evidence Over Assumption / P2.1 Reality Audit）
- 调查对象：`main` @ `6ee3c2ffbbe5340bc78566cb780ba9e512dfaf66`
- 任务性质：**只读审计**。未修改任何代码、未新增 schema、未设计新模块。
- 唯一产物：本文档。

---

## 0. 结论先行（Executive Summary）

**核心问题的直接回答：PD 已经具备 Learning Loop 的绝大部分能力，缺口不是"能力"而是"连接"。**

三条论断与证据强度：

| 论断 | 判定 | 关键证据 |
|---|---|---|
| 数据采集层是否已存在？ | **是，且远超预期** | trajectory.db 15 张表 + state.db 20+ 张表（含 `pain_events`/`correction_samples`/`principle_applications`） |
| 判断层是否已存在？ | **是，且不止一个** | `quality-scorecard`（PRI-361）+ `evaluator-runner` + `v_principle_effectiveness` 视图 |
| 缺口性质 | **连接（Connect）> 增强（Improve）>> 新增（New）** | 见 §6 Disconnected Graph |

最容易被误判为"缺失"、实际已存在的三项：

1. **Activation Receipt** —— `principle_applications` 已是完整的"哪个原则、何时、哪个 session、如何注入、是否执行"记录表（PRI-531），有 Console 读模型与 BDD 契约。**不是缺失，是已建成。**
2. **效果判断** —— `v_principle_effectiveness` 视图已存在；`quality-scorecard` 已有 7 维 rubric + MVP 阈值 + 强模型裁决接口。**不应新造 Evaluator。**
3. **Correction → Pain → Principle** —— `correction_samples` → `correction_rejected` pain event → Diagnostician 链路已打通并被测试保护。

**最真实的缺口（按重要性）：**

- **G-1（连接）**：`v_principle_effectiveness` 只统计 `principle_events` 的 event_type 计数，**完全不 JOIN `principle_applications`** —— "哪个原则有效"这一问题在 SQL 层无法回答。
- **G-2（连接）**：`principle_applications.session_id` ↔ `trajectory.db.sessions.session_id` 两库物理隔离（`.pd/state.db` vs `.state/trajectory.db`），无外键、无跨库 JOIN，只能靠 session_id 字符串约定关联。
- **G-3（缺失的字段级连接）**：receipt 表记录了 session + tool + file，但**没有 `assistant_turn_id` / `run_id`** —— 无法回答"哪个 Agent turn"。这是本审计最确凿的"真缺数据"项。
- **G-4（判断缺位）**：receipt 有 presence/effect 计数，但**没有"效果结论"字段**（如 effective / ineffective）。Owner 目前只能看次数，不能看结论。
- **G-5（连接）**：Turn 级 Before/After 行为重建**技术上可行但没有任何现成消费者**（`trajectory-turn-reader.ts` 存在，仅供 Diagnostician 上下文使用）。

**Minimal SPEC Boundary 建议摘要：** 1 项 Improve（effectiveness 视图 JOIN receipt）、1 项 Connect（trajectory 反向锚点）、1 项 New（且仅有 1 项真正需要新增：receipt 的 turn 级锚点字段，或跨库读取端口）。详见 §7。

---

## 1. Capability Map（Phase 0）

格式：`| Capability | Existing Module | Data Source | Writer | Consumer | Status |`

### 1.1 Pain Signal

| Capability | Existing Module | Data Source | Writer | Consumer | Status |
|---|---|---|---|---|---|
| Pain 语义判定（单一权威） | `pain-ingress.ts`（PRI-642） | 内存/PainIngressReport | 各 host adapter | `evaluatePainIngress` 调用方 | ✅ 完整 |
| Pain 准入判断 | `admission-gate.ts` | 内存 | 纯函数 | `pain-to-principle-service` | ✅ 完整 |
| Pain 事件持久化 | `trajectory.ts:664 recordPainEvent` | `trajectory.db.pain_events` | openclaw-plugin hook | Console/CLI/scorecard | ✅ 完整 |
| Pain 可观测性（CLI/gate 路径） | `pain-signal-observability.ts`（PRI-453） | `pain_events` + `events_*.jsonl` + `evolution.jsonl` | core SDK | CLI / gate-block | ✅ 完整 |
| Codex 共享准入 | `governance-signal-admission.ts`（PRI-623） | 同上 + 准入 marker | host-runtime | Codex + OpenClaw | ✅ 完整 |
| Canonical pain 去重 | `pain_events.canonical_pain_id` UNIQUE 索引 | `trajectory.db` | 准入事务 | 重放/重试路径 | ✅ 完整 |

**四问回答：**

**1) Pain 从哪里产生？** 三个来源，均有代码证据：

- 工具失败：`after-tool-call-helpers.ts:568` `wctx.trajectory?.recordPainEvent(...)`
- LLM 输出信号：`hooks/llm.ts:292` `eventLog.recordPainSignal(...)`
- 用户纠正（correction）：`hooks/pain.ts:489/538`
- 手动上报：`hooks/pain.ts:519 handleManualPain`（＋ `pd pain record` CLI 路径走 `pain-signal-observability.ts`）

**2) 谁写入？** 双写（有意的）：`eventLog.recordPainSignal` → `.pd/logs/events_*.jsonl`；`trajectory.recordPainEvent` → `.state/trajectory.db` 的 `pain_events` 表。`pain-signal-observability.ts:20` 明确记录"避免 triple-write"的设计决策。

**3) 谁消费？** `GovernanceConsoleModel`（今日拦截计数）、`PainPage.tsx`、`pd pain list`、`quality-scorecard/data-extractor.ts`、`evidence-chain` 读模型。

**4) 是否关联 session/trajectory？** **是。** `pain_events.session_id NOT NULL`（`trajectory.ts:235`），另有 `runtime_task_id`、`host_kind`、`canonical_pain_id` 列（`sqlite-connection.ts:263-272` 迁移）。

### 1.2 Principle Lifecycle

| Capability | Existing Module | Data Source | Writer | Consumer | Status |
|---|---|---|---|---|---|
| Pain → Candidate | `pain-to-principle-service.ts`、`candidate-intake-service.ts` | `state.db.principle_candidates` | Diagnostician 链 | Console Principles 页 | ✅ 完整 |
| Candidate → 内化产物 | `internalization-orchestrator.ts` | `state.db.pi_artifacts` | dreamer/scribe/artificer… | evaluator/rollout-reviewer | ✅ 完整 |
| Evaluation | `evaluator-runner.ts`（PRI-67） | `pi_artifacts` | Evaluator peer runner | 内化状态机 | ✅ 完整 |
| Approval | `approvals` 表 + `approval-queue.ts` | `state.db.approvals` | Owner（Console） | 激活派发 | ✅ 完整 |
| Activation | `activations` 表 + `activation-dispatcher.ts` | `state.db.activations` | 审批完成服务 | PromptActivationReader | ✅ 完整 |
| Activation 安全权威 | `activation_decisions`（不可变 + 触发器保护） | `state.db` | Owner/系统安全 | RuleCode 门 | ✅ 完整（超预期） |
| Retirement / Pruning | `pruning-read-model.ts`、`principle-enums.ts:55 'retired'` | ledger + state.db | pruning mask | Prompt 注入过滤 | ✅ 存在 |

**结论：链路完整。** Pain → Candidate → Review → Approval → Activation → Retirement 六段全部有实现与数据表，且关键决策（activation_decisions）有数据库级不可变保护（`sqlite-connection.ts:533-538` 的 `BEFORE UPDATE/DELETE` 触发器）。

### 1.3 Activation Receipt（重点——已在，非缺失）

| Capability | Existing Module | Data Source | Writer | Consumer | Status |
|---|---|---|---|---|---|
| Receipt 账本 | `principle-application-ledger.ts`（PRI-531） | `state.db.principle_applications` | prompt/gate hook | Console/CLI | ✅ 完整 |
| Presence 级（注入） | 同上 | `kind='prompt_injected'` | `prompt.ts:694-718` | ReceiptsConsoleModel | ✅ 完整 |
| Effect 级（执行） | 同上 | `rule_blocked`/`auto_correct_applied`/`self_reported` | `gate.ts:175/345`、`trajectory-collector.ts:139` | 同上 | ✅ 完整 |
| 去重 | `idx_pa_presence_dedup` / `idx_pa_self_report_dedup` | 部分唯一索引 | SQLite | —— | ✅ 完整 |
| 覆盖度披露 | `receipt-coverage.ts`（PRI-590..594） | 派生（无新事实源） | 纯函数 | Console | ✅ 完整（超预期） |
| Block 文案归因 | `principle-receipt-metadata.ts`（PRI-530） | `approvals`/`activations`/`pi_artifacts` | 只读 | gate-block copy | ✅ 完整 |
| 会话回执 UI | `commands/context.ts` + `pd-context-receipt.feature` | `session-tracker` 内存 | 内存态 | `/pd-context status` | ✅ 完整 |
| 保留期 | `RECEIPT_RETENTION_POLICY_DAYS = 90`（单一 SSoT） | —— | sweep | 读写双方 | ✅ 完整 |

**七个问题的逐项回答：**

| 问题 | 能否回答 | 字段级证据 |
|---|---|---|
| 哪个原则？ | ✅ **能** | `principle_applications.principle_id NOT NULL` |
| 什么时候？ | ✅ **能** | `created_at NOT NULL` |
| 哪个 session？ | ✅ **能** | `session_id`（可空，唯一索引语义注明 NULL 互异） |
| 哪个 Agent turn？ | ❌ **不能** | **表无 turn 列**——只有 `session_id`/`tool_name`/`file_path` |
| 如何注入？ | ⚠️ **部分能** | 有 `channel`（`code_tool_hook`\|`prompt`）+ `activation_id` + `rule_id` + `digest`；**无 prompt 片段指纹** |
| 是否执行？ | ⚠️ **部分能** | 有 `level`（effect/presence）+ `kind`（4 值枚举），即"被执行过"有记录；**无"执行是否有效"** |
| 回滚/可信度？ | ✅ 能 | `coverage.sourceStatus/validationStatus` 三态 + 明确 consumer 规则（receipt-coverage.ts:36-45） |

> 注意 `receipt-coverage.ts:47` 的诚实约束：90 天保留窗口内的**观察证据**，非完整历史声明。

### 1.4 Trajectory Data

`trajectory.db` 15 张表（`trajectory.ts:180-303`）：`sessions`、`assistant_turns`、`user_turns`、`tool_calls`、`pain_events`、`gate_blocks`、`trust_changes`、`principle_events`、`task_outcomes`、`correction_samples`、`sample_reviews`、`exports_audit`、`ingest_checkpoint`、`schema_version` + 3 视图。

| 重建环节 | 可用数据 | 强度 |
|---|---|---|
| Before behavior | `assistant_turns`（含 `raw_text`/`sanitized_text`/`thinking_blocks_count`）+ `tool_calls`（含 `params_json`/`result_preview`） | ✅ 强 |
| Correction | `user_turns.correction_detected` + `correction_cue` + `references_assistant_turn_id` | ✅ 强（**有显式外键指向被纠正的 turn**） |
| Correction sample | `correction_samples.bad_assistant_turn_id` + `user_correction_turn_id` + `recovery_tool_span_json` | ✅ 强 |
| Principle activation | `principle_applications`（**在另一个库**） | ⚠️ 有数据，无连接 |
| After behavior | `assistant_turns`/`tool_calls` 同 session 后续行 | ✅ 强 |

**结论：`Before → Correction` 是完整的；`Correction → Activation → After` 的每一段都存在，但中间**没有物理/结构连接** —— 见 §6。

### 1.5 RuleCode / Runtime Enforcement

| 层 | 实现 | 证据 |
|---|---|---|
| A. Prompt 提醒 | `prompt.ts` 注入 `<evolution_principles>` + 核心公理 | `prompt.ts:444-465`；`principle-injection.ts` 预算裁剪 |
| B. Runtime 强制 | `RuleHost.evaluate()` 在 `before_tool_call` 判定并 **deny** | `gate.ts:69/159` `eventLog.recordRuleHostBlocked(...)`；`rule-host.ts:182` |
| B. Auto-correct | RuleCode 可请求改写参数 | `gate.ts:246/322/345` |
| B. 沙箱 | `rule-implementation-runtime.ts` VM + 双超时（compile 1000ms / eval 3000ms） | 文件头注释 + `nodeVm` |
| B. 紧急停机 | `rulecode-safety-circuit-breaker.ts` + `global_rulecode_pauses` 表 + `activation_decisions` 不可变 | `sqlite-connection.ts:568` |
| 强制事件记录 | `rule_blocked` effect 行 + `gate_blocks` 行 | `gate.ts:175` `recordPrincipleApplication(workspaceDir, {kind:'rule_blocked'...})` |

**判定：C（两者都有）。** 且 enforcement 有独立的安全权威与回滚机制，成熟度高于 prompt 层。

### 1.6 AI User QA

| 项 | 现状 | 证据 |
|---|---|---|
| 框架存在 | ✅ PRI-754 | `packages/pd-console/tests/ai-user/README.md` |
| 机制 | Playwright 驱动真实 Console，LLM 决策，输出 `report.json`/`report.md` | 同上 |
| 覆盖 | **仅 1 个场景** `first-run-onboarding.yaml` | `scenarios/` 目录仅 1 文件 |
| 入口 | 仅 Web Console；Electron 未接入（README「已知限制」） | 同上 |

**"能否评价用户是否理解原则 / 是否感受到变化"？**

- 理解程度：⚠️ **部分能**——`success` 标准可写成"用户能说出原则含义"，但当前唯一场景与原则无关。
- 感受到变化：❌ **不能**——该工具无 Before/After 对比机制，也无原则使用的前后行为采样。
- 且 README 明确：结果来自 AI User 自评 `finish(success)`，**非独立仲裁**。

### 1.7 Existing Evaluation Mechanism（重点扫描）

**已有 3 套彼此独立的"判断"能力：**

| # | 机制 | 位置 | 判断对象 | 输出 |
|---|---|---|---|---|
| 1 | Quality Scorecard | `packages/principles-core/src/quality-scorecard/`（PRI-361） | **诊断质量** | 7 维 rubric（G1–G7）、0–2 分、`meetsMvpThreshold`、`StrongModelAdjudication` |
| 2 | Evaluator peer runner | `internalization/evaluator-runner.ts`（PRI-67） | **原则能否内化** | `EvaluatorOutputV1/V2`、对抗用例结果、code review |
| 3 | `v_principle_effectiveness` 视图 | `trajectory.ts:418` | **原则事件计数** | `event_type` + `total` |

另有：`promotion-readiness-evaluator.ts`（晋升就绪）、`adversarial-loop.ts`、`golden-trace-replay-validator.ts`、`rollout-reviewer-runner.ts`。

**"是否已经存在效果判断能力？" → 部分存在，但都不回答"这个原则改变了行为吗"。**

- Scorecard 判的是**诊断文本质量**，不是行为改变。
- Evaluator 判的是**内化产物合规性**，不是上线后效果。
- `v_principle_effectiveness` 名为 effectiveness，实为**事件类型直方图**（`SELECT event_type, COUNT(*) FROM principle_events GROUP BY event_type`），与 `principle_applications` 零关联。

---

## 2. Existing Module Inventory

### 2.1 数据存储（两个物理库）

**A. `.state/trajectory.db`** —— 行为轨迹库（`trajectory.ts:180`）

写入者：`openclaw-plugin` 的 `TrajectoryDatabase`（`core/paths.ts` 的 `PD_FILES.TRAJECTORY_DB`）
读取者：`principles-core/trajectory-store.ts`（`resolveTrajectoryDbPath`，有 round-trip 测试保护）

关键表：`sessions`、`assistant_turns`、`user_turns`、`tool_calls`、`pain_events`、`gate_blocks`、`correction_samples`、`task_outcomes`、`principle_events`

**B. `.pd/state.db`** —— 运行时/治理库（`sqlite-connection.ts:224+`）

写入者：`principles-core` 的 `SqliteConnection` 各 store
读取者：`pd-console` 各 Console Model、`pd-cli`

关键表：`tasks`、`runs`、`artifacts`、`commits`、`principle_candidates`、`pi_artifacts`、`approvals`、`activations`、`activation_decisions`、`activation_control_states`、`principle_applications`、`intent_decisions`、`pain_diagnoses`

**C. `.pd/` 文件态**：`principle_training_state.json`（ledger）、`correction_keywords.json`

### 2.2 核心模块清单

| 层 | 模块 | 职责 |
|---|---|---|
| 语义权威 | `pain-ingress.ts` | Pain 语义**唯一**权威（PRI-642 明确"adapters MUST NOT re-implement"） |
| 准入 | `admission-gate.ts` | admitted / needs_evidence / deferred |
| 编排 | `pain-to-principle-service.ts` | `recordPain` 门面（PRI-12） |
| 生命周期 | `internalization-orchestrator.ts` + `internalization-state-machine.ts` | 8 阶段内化 |
| Peer 运行器 | `runner/base-peer-runner.ts` + 8 个 runner | dreamer/scribe/artificer/philosopher/evaluator/rollout-reviewer… |
| 强制 | `rule-host.ts` + `rule-implementation-runtime.ts` | RuleCode 沙箱执行 |
| 账本 | `principle-application-ledger.ts` | Receipt 写入 |
| 读模型 | 7 个 `*-read-model.ts` | operator-health / pain-chain / pruning / schema-conformance / internalization-chain-integrity / activation-compatibility / lifecycle |
| 反馈 | `feedback/`（`createFeedbackReport`） | 隐私保护草稿，非发布 |
| 遥测 | `product-telemetry/snapshot-contract.ts` | 里程碑布尔事实 + 隐私字段名断言 |

---

## 3. Data Flow Diagram

```
[Agent 运行时]
     │
     ├─ before_tool_call ──► gate.ts ──► RuleHost.evaluate()  ←── activations(状态库B)
     │                          │                                  │
     │                          ├─ deny ──► gate_blocks(库A)        │
     │                          │        └─► principle_applications(库B) [kind=rule_blocked]
     │                          └─ auto_correct ──► principle_applications(库B)
     │
     ├─ llm_output / after_tool_call ──► hooks/pain.ts ──► pain-ingress ──► admission-gate
     │                                        │
     │                                        ├─► pain_events(库A)  [canonical_pain_id UNIQUE]
     │                                        └─► events_*.jsonl + evolution.jsonl
     │
     ├─ before_message_write ──► trajectory-collector.ts ──► assistant_turns/user_turns(库A)
     │                                        │                     │
     │                                        │                     └─ correction_detected + references_assistant_turn_id
     │                                        └─► recordSelfReportFromText ──► principle_applications(库B) [self_reported]
     │
     └─ prompt 构建 ──► prompt.ts ──► setInjectedPrincipleIds(内存 session-tracker)
                                     └─► principle_applications(库B) [kind=prompt_injected]

[治理链 — 库B]
  pain_events(库A) ──► principle_candidates ──► pi_artifacts ──► evaluator ──► approvals ──► activations
                                                                                             │
                                                                              (回到 RuleHost / Prompt)

[读侧]
  principle_applications ──► ReceiptsConsoleModel / /pd-context status
  pain_events ──► EvidenceChainConsoleModel / PainPage / quality-scorecard
  principle_events(库A) ──► v_principle_effectiveness  ← ⚠️ 与 principle_applications 无关联
```

**关键观察：** 图中所有箭头都存在，唯一"断"的是**跨库横切关联**——
`principle_applications(库B) ↔ pain_events/correction_samples/assistant_turns(库A)` 之间没有结构连接，只有 `session_id` 字符串约定。

---

## 4. Duplication Risk Analysis（Phase 1）

| Existing Concept | Responsibility | Overlap Risk | 说明 |
|---|---|---|---|
| `quality-scorecard` | 诊断文本质量评分（7 维） | **高** | 若新 Learning Loop 造 "Evaluator"，与 PRI-361 直接冲突 |
| `evaluator-runner` | 内化产物合规判断 | **高** | 冲突同上；已有 peer runner 框架与对抗用例 |
| `v_principle_effectiveness` | 原则事件计数 | **中** | 名字承诺 ≥ 实现；新造 "Effectiveness Tracker" 会形成第二事实源（违反 P4） |
| `principle_applications`（Receipt ledger） | 应用历史 | **极高** | 任何"Principle Usage Store"都是重复 |
| `correction_samples` + `correction-cue-learner` | 纠正样本与可学习关键词 | **高** | 已有"从纠正中学习"的能力与持久化关键词库（200 条上限） |
| `evolution-reducer.ts` | 原则状态流转 + `recordProbationFeedback` | **高** | 已有 feedback 入口；虽 worker 于 PRI-737 退役，reducer 仍在 |
| `SignalCollector` / `signal-collector-host.ts` | 信号采集（correction + empathy 合并） | **中** | 采集层已存在，flag `signal_collector` 默认 off |
| `product-telemetry` | 匿名里程碑事实 | **中** | 已有隐私边界与字段名断言；不要新建遥测通道 |
| `feedback/`（PRI-543） | Owner→维护者反馈草稿 | **低** | 方向不同（对外），不重叠 |
| `pain-diagnoses` / `pain_diagnosis` store | 诊断结果 | **中** | 与"效果"不同，但易被误用为效果源 |
| `dreamer/scribe/artificer/philosopher` | 内化生成链 | **中** | 若新造 "Reflection Agent"，与 dreamer/philosopher 重复 |
| `adversarial-loop.ts` | 对抗自检 | **中** | 与"效果验证"相邻，可复用不宜重建 |

**判定：如果新增一个 Learning Loop 模块，重复风险为"高"。**
现有仓库已覆盖 Memory（trajectory stores）、Feedback（3 处）、Evaluation（3 套）、Reflection（dreamer/philosopher）、Evolution（reducer + store）、Optimization（keyword-optimization + correction-observer）。

**特别提示：** `evolution-store.ts` 的类型注释明确记录了 `evolution_tasks` 写入者于 PRI-737 退役、`evolution_worker` flag 已转入 `gone` tombstone（`feature-flag-contract.ts:241`）。**任何试图复活该 worker 的设计都是逆流。**

---

## 5. Missing Connection Analysis（Phase 2）

不建新模块，只指出已有模块之间断在哪。

### 断点 D-1：Receipt ↔ Trajectory（最严重）

```
principle_applications(库B)  ──X──  sessions/assistant_turns/tool_calls(库A)
```
- 断因：物理分库（`.pd/state.db` vs `.state/trajectory.db`），`governance-signal-admission.ts` 头注释承认"cannot share a transaction"。
- 现有妥协：`session_id` 字符串约定 + 一条"窄的幂等对账 pass"（同一注释）。
- 后果：无法在 SQL 层回答"某 session 的第 N 个 turn 之后，原则 X 改变了什么"。

### 断点 D-2：Receipt ↔ Outcome（任务已识别的正是此断点）

```
principle_applications.principle_id  ──X──  task_outcomes.principle_ids_json
```
- `task_outcomes`（库A）的 `principle_ids_json` 是**自由 JSON 字符串**，与 receipt 的 `principle_id` 无结构约束。
- 断因：无 JOIN、无校验、无共享枚举。

### 断点 D-3：`v_principle_effectiveness` ↔ Receipt

```
v_principle_effectiveness (读 principle_events，库A)  ──X──  principle_applications(库B)
```
- 视图定义（`trajectory.ts:418-422`）根本不涉及 receipt 表。
- 后果：名字里的 "effectiveness" 是**误导性命名**——它统计的是"事件类型有多少条"，不是"原则是否有效"。

### 断点 D-4：Trajectory turn ↔ Receipt（字段级缺失）

```
principle_applications  ──X──  assistant_turns.id   ← 表里没有这个列
```
- 这是**唯一确凿的"确实缺字段"**：receipt 记录了 session/tool/file，但没有 turn/run 锚点。
- 对比：`correction_samples` **有** `bad_assistant_turn_id` + `user_correction_turn_id`（`trajectory.ts:284-285`）——**同一仓库内的两条记录链路，一条有 turn 锚点，一条没有。**

### 断点 D-5：Correction-cue learner ↔ 判断层

```
correction_keywords.json（可学习）  ──X──  原则生成/验证
```
- 关键词库会随检测增长（有 weight 与 200 上限），但**没有消费者**把"哪些关键词识别准确"回写给判断层。

### 断点 D-6：AI User QA ↔ 原则效果

```
ai-user-runs/*.json（存在）  ──X──  principle_applications / 原则场景
```
- 框架可运行，但唯一场景是 onboarding，且报告是 gitignored 产物、无入库路径。

### 断点 D-7：Scorecard ↔ 上线原则

```
quality-scorecard（判诊断质量）  ──X──  已激活原则的实际行为效果
```
- Scorecard 在**创建时**评估，activation 之后**不再复评**。

### Disconnected Graph（汇总）

```
                    ┌───────────────────────────┐
                    │   库A: trajectory.db      │
                    │  sessions/assistant_turns │
                    │  correction_samples ●─────┼── 有 turn 锚点
                    │  pain_events              │
                    │  task_outcomes            │
                    │  principle_events ──►v_effectiveness
                    └────────────┬──────────────┘
                                 ╳  D-1/D-2/D-3/D-4（session_id 字符串约定）
                    ┌────────────┴──────────────┐
                    │   库B: state.db           │
                    │  principle_applications ●─┼── 无 turn 锚点
                    │  activations/approvals    │
                    │  pi_artifacts/candidates  │
                    └───────────────────────────┘
                                 ╳  D-5/D-6/D-7
                    ┌───────────────────────────┐
                    │  判断层（三套互不连通）    │
                    │  scorecard │ evaluator    │
                    │  v_effectiveness          │
                    └───────────────────────────┘
```

---

## 6. Minimal SPEC Boundary Recommendation（Phase 3）

严格按任务要求四分类。**每项 New 均需证明现有模块无法表达。**

### Existing（已存在，SPEC 不得重建）

1. Pain 采集与准入 —— `pain-ingress.ts` / `admission-gate.ts`
2. Receipt 账本 —— `principle_applications` 表 + `principle-application-ledger.ts`
3. Receipt 读侧 —— `ReceiptsConsoleModel` + `receipt-coverage.ts`
4. Principle 全生命周期 —— `candidates → pi_artifacts → approvals → activations`
5. RuleCode 强制与安全 —— `rule-host.ts` + `activation_decisions`
6. 判断能力三套 —— scorecard / evaluator / v_effectiveness
7. 行为数据 —— `trajectory.db` 15 表
8. AI User QA 框架 —— `tests/ai-user/`
9. 纠正学习 —— `correction_samples` + `correction-cue-learner`

> **SPEC 中任何"设计 Memory System / Evaluation Engine / 数据库"的条款都应被此清单驳回。**

### Connect（只需接线，最高性价比）

| # | 接线 | 具体动作 | 涉及文件 |
|---|---|---|---|
| C-1 | `v_principle_effectiveness` → Receipt | 让视图（或替代视图）按 `principle_id` 聚合 `principle_applications` 的 effect/presence | `trajectory.ts:418`（需跨库，见 New-2）/ 或改在 Console 读模型内合并 |
| C-2 | Receipt → Trajectory session | 为 receipt 读侧补一个"按 session_id 拉取库A turn 序列"的读路径 | 消费 `store/context/trajectory-turn-reader.ts` |
| C-3 | Receipt → task_outcomes | 用结构化字段替代 `principle_ids_json` 自由字符串（或至少加读取侧校验） | `trajectory.ts`（只读校验属 core） |
| C-4 | AI User QA → 原则场景 | 新增一个"原则可见性"场景 YAML，复用现有 runner | `tests/ai-user/scenarios/` |
| C-5 | Scorecard → 上线后复评 | 在 activation 之后复用既有 rubric 触发一次评估（仅在确有流程时） | 消费 `quality-scorecard` |

### Improve（已有能力增强）

| # | 增强 | 说明 |
|---|---|---|
| I-1 | `v_principle_effectiveness` 更名或语义修正 | 当前名与实现不符（P4 命名诚实性）；建议改名 `v_principle_event_counts` 或真正实现 effectiveness |
| I-2 | Receipt coverage 增加"跨库关联完整度"披露 | 现有 coverage 只披露库B状态，未披露"与库A无法关联"这一事实 |
| I-3 | `receipt-coverage.ts` 的 `validationStatus` 扩展到跨库对账结果 | 复用既有三态模式，不新造概念 |

### New（真正需要新增——仅 2 项，且均需 Owner 裁决）

**N-1：Receipt 的 turn 级锚点字段（唯一确凿的"缺数据"）**

- **为何现有无法满足：** `principle_applications` 表结构（`sqlite-connection.ts:463-479`）无 `assistant_turn_id`/`run_id` 列；`correction_samples` 有同类锚点而 receipt 没有，属结构性不对称。
- **最小形态：** 为表增加可空列 `assistant_turn_id INTEGER`（或 `run_id TEXT`），由已存在的调用方（`gate.ts:175/345`、`prompt.ts:694`）传入。
- **风险：** 需要 schema 版本迁移（`schema_version` 表已存在），且写入方在库B、turn 身份来自库A，仍是字符串/整数约定而非外键。
- **裁决点：** 是否接受"跨库弱锚点"作为 turn 归因的正式方案。

**N-2：跨库读取端口（若 Owner 要求 SQL 层 JOIN）**

- **为何现有无法满足：** 两库物理分离且**无意共享事务**（`governance-signal-admission.ts` 明确记录）。
- **最小形态：** 一个 core 侧只读聚合函数（如 `assemblePrincipleEffectiveness(workspaceDir)`），内部两次查询 + 内存关联，**不建新表、不建新库**。
- **注意：** 这更接近 `Connect` 的实现手段，列在 New 仅因它需要一个新的公开函数边界——**若 Owner 认为可放在现有 Console 读模型内，则降级为 C-1。**

### 明确不推荐（违反 P3/P7/anti-pattern）

- ❌ 新建 Learning Engine / Learning Loop 模块
- ❌ 新建 Memory System
- ❌ 新建 Agent Evaluator（已有 3 套）
- ❌ 新建数据库或表（除 N-1 的单列迁移）
- ❌ 复活 `evolution_worker`（PRI-737 已退役，flag 为 `gone` tombstone）
- ❌ 新建独立遥测通道

---

## 7. Confidence & 未确认项

**本审计证据强度分级：**

| 领域 | 强度 | 依据 |
|---|---|---|
| 数据库 schema | **高** | 直接读 `CREATE TABLE` 语句 |
| 模块职责 | **高** | 文件头设计注释 + 导出符号 |
| 写入路径 | **高** | 生产代码调用点（已排除测试文件） |
| 消费路径 | **中高** | 已定位 CLI/Console 调用方 |
| 跨库关联缺失 | **高** | 两库 schema 与读路径均已核实 |

**未确认（如实声明）：**

1. **运行时实证缺失。** 本审计为静态代码审计，未执行 `pd` 命令、未打开任何真实 workspace 的 `.pd/state.db` 或 `.state/trajectory.db`（任务约束禁止写入运行时状态；读取亦未进行）。所有表结构与列名来自建表代码，**未与真实数据库文件比对**。
2. **`principle_events` 的实际写入频率未确认。** 已定位 `evolution-reducer.ts` 与 `trajectory.ts:1657` 的写入点，但未验证生产环境是否有调用者，因此 `v_principle_effectiveness` 是否有数据**未确认**。
3. **`task_outcomes` 的实际填充率未确认。** 仅有 `trajectory.ts` 的 `recordTaskOutcome` 定义与 import 路径，未确认生产调用点。
4. **`correction_samples` 的生成条件未完整追溯。** 已见 `trajectory.ts:1745+` 的构造逻辑与 `quality_score` 计算，但未确认触发上游。
5. **G-3（turn 锚点缺失）的判定基于建表代码。** 若存在迁移文件中已 ADD COLUMN 而建表代码未同步，则判定需修正——**未检查全部迁移路径**。
6. **Linear PRI-750 工单内容未读取**（章程 §6 已知局限：CNB 侧零密钥，Linear 不可用）。本审计仅依据 Issue #13 描述。
7. **CNB 镜像与 GitHub main 的漂移状态未核验**（PRI-766 曾报告镜像漂移问题）。本次审计对象为本地 `main @ 6ee3c2ff`。

---

## 8. 给 Owner 的下一步

本审计**停在调查**。任务书明确要求"完成后停止，等待 Owner 基于 Reality Audit 设计 SPEC"。

若 Owner 要设计 SPEC，本审计建议的决策点：

1. **接受"Connect 优先"吗？** 若接受，SPEC 主体应是 C-1..C-5，规模小于"新模块"方案一个数量级。
2. **N-1（turn 锚点列）是否进入范围？** 这是唯一需要 schema 变更的项，且变更在 D1 允许范围之外（`packages/**`），**必须由 Owner 或其授权会话实施**。
3. **`v_principle_effectiveness` 的命名欺骗如何处理？** 改名是 breaking-ish 变更（有测试引用），实现真语义则等于 C-1。
4. **是否接受"跨库弱关联"作为长期方案？** 若否，则需先解决 CNB/GitHub 之外更深的问题：两库是否应合一——**这是架构决策，不属本任务**。

---

## 附：证据索引（文件:行号）

```
trajectory.ts:180-303          库A 全部 CREATE TABLE
trajectory.ts:213-215          user_turns correction 字段
trajectory.ts:233-247          pain_events 表
trajectory.ts:281-293          correction_samples 表（含 turn 外键）
trajectory.ts:418-422          v_principle_effectiveness 视图定义 ★
trajectory.ts:664,1437,1657    recordPainEvent 写入点
trajectory.ts:1745-1806        correction sample 构造

sqlite-connection.ts:224-320   tasks/runs/artifacts/commits
sqlite-connection.ts:350-375   principle_candidates
sqlite-connection.ts:395-409   approvals
sqlite-connection.ts:439-450   activations
sqlite-connection.ts:463-479   principle_applications 表 ★（无 turn 列）
sqlite-connection.ts:502-568   activation_decisions + 不可变触发器
sqlite-connection.ts:678-691   pain_diagnoses

principle-application-ledger.ts:1-35     receipt 写入契约（双 level）
principle-application-ledger.ts:217-262  self_reported 写入
receipt-coverage.ts:1-60                 coverage 三态 + consumer 规则 ★
prompt.ts:681-720                        presence 行写入 + session tracking

pain-ingress.ts:1-30                     单一语义权威声明
admission-gate.ts:1-60                   准入三态
pain-to-principle-service.ts:1-30        门面
pain-signal-observability.ts:1-20        三方写入者分工说明
governance-signal-admission.ts:1-45      跨库不可共享事务声明 ★

gate.ts:69,159,175,246,322,345           RuleHost deny / auto-correct / receipt 写入
rule-host.ts:182                         evaluate 入口
rule-implementation-runtime.ts:1-40      沙箱双超时

quality-scorecard/types.ts:11-90         7 维 rubric + MVP 阈值
evaluator-runner.ts:1-30                 Evaluator peer runner
evolution-reducer.ts:41-55               promote/deprecate/feedback 接口

feature-flag-contract.ts:241             evolution_worker = gone tombstone ★
tests/ai-user/README.md                   AI User QA 能力与限制
docs/specs/features/receipt/*.feature     5 个 receipt BDD 契约
```

---

*本文档为只读审计产物。未修改任何代码、schema、运行时状态。*
