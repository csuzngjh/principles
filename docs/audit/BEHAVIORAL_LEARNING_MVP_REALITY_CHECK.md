# Behavioral Learning MVP Reality Check

> 只读现实核查（Reality Check）。未修改代码、schema、数据库、配置或 feature flag；未创建 PR / Linear 工单。
> 唯一产物：本文档。
>
> **审查对象**：`docs/specs/BEHAVIORAL_LEARNING_MVP_ACCEPTANCE_v2.md`（Draft v2，**未提交**，工作树 untracked）
> **目标工单**：PRI-836（Behavioral Learning MVP）
> **基线**：
> ```
> BASE_SHA (HEAD/main) = e5e2b16b4e1aa18e0b736a6957613906cf65d582
> branch               = main
> spec                 = docs/specs/BEHAVIORAL_LEARNING_MVP_ACCEPTANCE_v2.md（?? untracked；v1 不存在）
> runtime 数据         = D:\.openclaw\workspace\.pd\state.db (15.0 MB, 2026-09-22 17:45)
>                        D:\.openclaw\workspace\.state\trajectory.db (22.9 MB, 2026-09-22 16:32)
> 查询方式             = better-sqlite3 `{readonly:true}` SELECT only
> feature flags (workspace config.yaml) = principle_receipt_ledger=true,
>                        principle_receipt_self_report=true, pain_diagnosis_persistence=true
> ```

---

## Executive Summary

**Core Question：当前 PD 是否已经具备完成一次 Behavioral Learning MVP 验收所需的全部能力？**

**答案：不具备"全部"，但缺的不是能力，是最后一层证据的载体与判定。**

四层证据模型的真实状态：

| Layer | SPEC 要求 | 真实状态 | 判定 |
|---|---|---|---|
| **L0 Process** | Pain→Diagnosis→Principle→Approval→Activation 可追溯 | 五张表全部存在**且都有真实数据**（pain_events 54 / pain_diagnoses 27 / principle_candidates 132 / approvals 39 / activations 15） | ✅ **Exists** |
| **L1 Exposure** | task_id + principle_id + activation_id + timestamp + runtime context ref | presence 回执 **1085 行，activation_id 100% 非空，JOIN activations = 1085/1085**；且 `task_outcomes` 新增逐轮注入记录（300 行，304/304 可 join 到 run_id） | ✅ **Strong** |
| **L2 Behavior** | Behavior Signature + Before/After 可比较 | **声明侧已存在且真实**（`IntentContractV1`：targetBehavior/forbiddenBehavior/evidenceSource，落在 212+3 个 artifact）；**观测侧不存在**：无 before 基线判定、无 opportunity 计数、无 before/after 消费者 | ⚠️ **Partial** |
| **L3 Outcome** | error↓ / repeated pain↓ / owner correction↓ / validation↑ | `task_outcomes` 首次有写入者（304 行），但 **outcome 恒为硬编码 `'completed'`**——正是 SPEC 明文排除的那一类；`correction_samples` 9 行 `principle_ids_json` **全为 `[]`**；**无任何消费者** | ❌ **Missing** |

**最重要的一条现实（直接回答"是否只能看到 Agent 自称"）：**

```
真实 dogfood 库中：
  effect 回执 = 93 行
    ├─ self_reported  = 92 行   ← Agent 自称
    └─ rule_blocked   =  1 行   ← 唯一机器强制证据
  assistant_turns 中字面包含 "📌 应用了你的原则「…」" 的轮次 = 105 次
```

**是的——当前 effect 层的绝对主力就是 Agent 自己写下的"我遵守了这条原则"。**

`self_reported` 的写入标记由注入指令模板要求模型输出（`principle-application-ledger.ts:188,196`），
且 PRI-755 只保证"该 id 确实被注入过本 session"（`principle-application-ledger.ts:236-254`），
**它验证的是"声称的对象存在"，不是"声称的行为发生"。**

> **self-report != behavior evidence。** 这不是措辞之争：92:1 的比例意味着
> 若把现有 effect 回执直接当作行为证据，整个 MVP 会退化为"Agent 自评"。

**结论性质**：混合缺口，但入口不在"采集能力"，而在
(a) 一条连接（effect.activation_id 全 NULL）、(b) 一个判定口径（谁是 Eligible Opportunity）、
(c) 一个消费者（谁把 before/after 算出来）。三者都不需要新子系统。

```
PRI_836_REALITY_CHECK = YES_WITH_SMALL_PREPARATION
```

---

## Capability Matrix

| 能力 | 状态 | 事实依据（file:line / 数据） |
|---|---|---|
| Pain 采集与持久化 | ✅ Strong | `trajectory-schema.ts:91`；`pain_events`=54，52/54 带 `runtime_task_id`；origin=system_infer 34 / user_manual 20 |
| Pain 人工确认/否决 | ✅ Exists | `signal_confirmations`=11（confirmed 2 / rejected 7 / abandoned 2）— Owner 已在真实治理 pain |
| Diagnosis 持久化 | ✅ Exists | `sqlite-connection.ts:678-691`；`pain_diagnoses`=27（**较 PRI-866 的 1 行大幅增长**），27/27 pain_id 唯一，category=People/Design/Assumption/Tooling |
| Diagnosis 读取链路 | ⚠️ Weak | `SqlitePainDiagnosisStore.getDiagnosesByPainId` 存在；无 Console 生产消费者（PRI-865 结论在本 SHA 未见改变） |
| Principle 候选 | ✅ Exists | `principle_candidates`=132；**仍无 pain_id 列**（`pragma_table_info` 16 列） |
| Principle → Pain 血缘 | ⚠️ Misnamed | ledger `derivedFromPainIds` **116/116 全部有值，但存的是 candidate/artifact UUID**（如 `86dcdcdb-…`），非 pain_id（形如 `pain_host_…`）→ 名实不符（PRI-865 结论在 HEAD 仍成立） |
| Approval | ✅ Exists (thin) | `approvals`=39：**approved 5 / pending 32 / rejected 2**；无 candidate/principle 外键，经 `artifact_id` 关联 |
| Activation identity + 时间窗 | ✅ Strong | `activations`=15（prompt_activate 13 / shadow 1 / live 1）；`activated_at`/`promoted_at`/`deactivated_at` 真实；`activation_decisions`=3（append-only + 不可变触发器） |
| Activation 运行时强制 | ✅ Exists | `production-rulehost-gate.ts:217` — **仅 `channel='code_tool_hook' AND deactivated_at IS NULL`** 才被 gate 执行 |
| Behavior 声明（Target/Forbidden/Evidence） | ✅ **Strong（意外收获）** | `intent-contract.ts:40-51` `IntentContractV1{ownerIntent,targetBehavior,forbiddenBehavior,evidenceSource,validationExpectation}`；真实落在 **212 个 principle + 3 个 rule artifact**；**14/15 个被激活 artifact 都带 intentContract** |
| Behavior 合成样例 | ✅ Exists | `behavior-example-pack.ts:39`（sourceNegativeCase / positiveCounterexamples）+ `goldenTrace` 落在 243+4 个 artifact |
| Behavior 观测（After 实际行为） | ⚠️ 原料在、未组装 | `tool_calls`=14,385（357 session，2026-09-01→09-22，含 `outcome`/`error_type`）+ `assistant_turns`=2343 + `user_turns`=975；**无任何 before/after 消费者** |
| Behavior Signature（观测侧） | ❌ Missing | 无 `behavior_signature` 概念（全仓 grep 0 命中）；无 Eligible Opportunity 计数（ledger `totalOpportunities` = **0/23**） |
| Exposure（session 级） | ✅ Strong | `principle_applications` presence=1085，`activation_id` **0 个 NULL**，JOIN activations 成功 1085 |
| Exposure（turn 级） | ⚠️ Partial | `task_outcomes.principle_ids_json` 300/300 有值且可 join `assistant_turns.run_id`；但仅覆盖 304/2343 轮 |
| Runtime context reference | ❌ Missing | 回执表列仅 `(id, principle_id, activation_id, rule_id, channel, level, kind, session_id, tool_name, file_path, digest, created_at)` — **无 runtime 版本 / 上下文引用** |
| Outcome: task completion | ⚠️ 有数据但不当证据 | `task_outcomes`=304 全 `'completed'`；SPEC §Layer3 明文排除该形态 |
| Outcome: owner correction | ⚠️ **可算但未算** | `user_turns`=975 中 `correction_detected`=46、`correction_cue`=81；与 `principle_applications.session_id` **可按 session JOIN** → 无需新数据 |
| Outcome: error reduction | ⚠️ **可算但未算** | `tool_calls`：success 13,428 / failure 959；`v_error_clusters` 真实产出（exec 313 / browser 128 / view_image 123…）；日粒度失败数可得 |
| Outcome: repeated pain reduction | ❌ Missing | `pain_events` canonical_pain_id **54/54 唯一**（无复犯签名）；`pain_diagnoses.category` 提供**类别级**粗聚类（Partial） |
| Outcome: validation improvement | ⚠️ 形成期代理 | `pi_artifacts.validation_status`（854 pending / 62 validated）+ 129/890 含 `"score"`；测的是**产物质量**，非任务结果 |
| Outcome 消费者 | ❌ Missing | `task_outcomes` 全仓**无任何读取者**（仅 writer `trajectory.ts:562-576`） |
| 自动"effectiveness"指标 | ❌ 命名幻觉（仍存在） | `trajectory-schema.ts:197` `v_principle_effectiveness` 实际输出 = `{pain_detected:101, pain_recorded:63}`；ledger metrics 23 条 **valueScore/adherenceRate/painPreventedCount/totalOpportunities 全 0** |
| Owner 治理决策（Keep/Revise/Revoke/Continue） | ❌ Missing | `DecisionState` 取值 = `needs_owner_decision / processing / blocked / recovery_needed / decided / no_action` — **不含实验后处置语义**；`activation_decisions` 只覆盖激活级操作 |
| 测试覆盖（Process/Exposure） | ✅ Exists | `gate-receipt-integration` / `principle-application-ledger` / `receipt-self-report` BDD / `runtime-v2-prompt-activation` / `activations-console-model` 等 |
| 测试覆盖（Behavior/Outcome） | ❌ Missing | 无 behavior-signature / before-after / outcome 语义测试（`pain-outcome-convergence` 测的是形成期收敛） |
| Counterfactual / Effect attribution | ❌ Missing（且属 Next Scope） | 全仓无反事实实现；shadow 仅 1 条快照（observed 340 / wouldBlock 3） |

---

## Evidence Layer Audit

### Layer 0 — Process Evidence Reality Check

| Evidence | Status | Location |
|---|---|---|
| **Pain ID** | ✅ Exists | `trajectory.db.pain_events`（`trajectory-schema.ts:91`）；54 行；52/54 带 `runtime_task_id` |
| **Diagnosis** | ✅ Exists（读取弱） | `state.db.pain_diagnoses`（`sqlite-connection.ts:678`）；27 行；写入经 `sqlite-pain-diagnosis-store.ts:113`，flag `pain_diagnosis_persistence=true` |
| **Principle lineage** | ⚠️ Partial | `principle_candidates`=132；**无 pain_id 列**；`pi_artifacts.source_principle_id` **仅 27/894 非空**（principle 类 23/890、rule 类 4/4）；13 个 prompt 激活指向的 principle artifact **12 个 source_principle_id 为 NULL**；ledger `derivedFromPainIds` 存的是 UUID 非 pain_id |
| **Approval** | ✅ Exists | `approvals`（`sqlite-connection.ts:395`）；39 行；approved 5 / pending 32 / rejected 2；`decided_at` + `decided_by` |
| **Activation identity** | ✅ Exists | `activations`（`sqlite-connection.ts:439`）；15 行；`activated_at` 真实（2026-09-01→09-21）；**无 principle_id/approval_id 外键**，唯一 `activation_id` |

**链路形状**：Pain→…→Activation 这一段**真实、充沛、可重建**。
**唯一的结构性弱点**：principle↔activation 之间缺 FK，靠 `activation_id` 字符串内嵌原则标题
（如 `act_prompt_约定召回门：Owner 约定首次表达即持久化…`）与 `source_principle_id` 兜底。
→ 结论：**L0 已经足够支撑 MVP，不需要补 schema。**

### Layer 1 — Exposure Evidence Reality Check

SPEC 要求五要素，逐项核对：

| 要素 | 状态 | 事实 |
|---|---|---|
| `task_id` | ⚠️ Partial | 回执表**无 task_id 列**，只有 `session_id`；turn 级身份来自 `task_outcomes.task_id = host runId`（304/304 join 成功） |
| `principle_id` | ✅ 有（但非规范身份） | 有列、有值；但真实取值是**标题/UUID/legacy 混用**（16 个 distinct，见下方风险） |
| `activation_id` | ✅ **Strong** | presence 1085/1085 非空，JOIN activations = 1085；**对照 effect 93/93 全 NULL** |
| `timestamp` | ✅ Exists | `created_at`（presence/effect 均有），`idx_pa_principle_time` 支持按时间窗口切片 |
| `runtime context reference` | ❌ Missing | 无 runtime 版本 / prompt-builder 版本 / 上下文摘要字段 |

**`Exposure Capability = Strong`（但为 session 粒度，非 turn 粒度）**

原因：
1. presence 回执的**去重键是 `(principle_id, session_id)`**（`idx_pa_presence_dedup ON … WHERE kind='prompt_injected'`），
   即"某原则在本 session 至少被注入过一次"——**不证明决策时刻仍在上下文里**。
2. 真正的 turn 级载体是 `task_outcomes.principle_ids_json`（llm.ts:233-241 逐轮写入，源自
   `getInjectedPrincipleIds(sessionId)`），但仅 304/2343 轮有记录（该写入是 PRI-768 v5 新增）。
3. 所以系统**能回答"某次任务是否加载了某条 Principle"**——session 级确定能答，turn 级部分能答。

⚠️ **这是 Exposure→Influence 滑坡的第一道缺口**：`exposure.json` 若只从 presence 回执生成，
它会天然带着"整个 session 都暴露着"的过强含义。

### Layer 2 — Behavior Evidence Reality Check（最高优先级）

**这是 MVP 的核心，也是当前最诚实的缺口。**

**先说好消息 —— SPEC 的 `Behavior Signature` 有 60~80% 已经存在，只是不叫这个名字：**

```
SPEC 要求                     PD 已有载体（真实数据）
──────────────────────────────────────────────────────────────
Target Behavior        ←→  IntentContractV1.targetBehavior
Forbidden Pattern      ←→  IntentContractV1.forbiddenBehavior
Evidence Source        ←→  IntentContractV1.evidenceSource
Expected New Behavior  ←→  IntentContractV1.validationExpectation + goldenTraceCases
Eligible Opportunity   ←→  ❌ 无（ledger totalOpportunities = 0/23）
Previous Behavior      ←→  ❌ 无（无 before 基线判定）
```

- `intent-contract.ts:40-51` 定义 5 个**非空字符串**必填字段，`isValidIntentContractV1` 严格校验；
- 真实数据：**212 个 principle artifact + 3 个 rule artifact** 携带 `intentContract`；
  **被激活的 15 个 artifact 中 14 个带 intentContract**（唯一例外是 09-01 的 legacy 激活）。
- 即：**"Agent 应该做什么/不许做什么"这条判据，在库里已经是结构化数据，不是散文。**

**再说坏消息 —— 观测侧完全不存在：**

| 检查项 | 状态 | 依据 |
|---|---|---|
| behavior representation（观测） | ❌ Missing | 无 `behavior_signature` 概念；全仓 grep `behaviorSignature/behavior_signature/beforeAfter/behaviorDelta` **0 命中** |
| trajectory evidence | ⚠️ 原料充足 | `assistant_turns` 2343 + `user_turns` 975 + `tool_calls` 14,385（357 session） |
| tool call evidence | ⚠️ 原料充足 | `tool_calls(tool_name, outcome, error_type, exit_code, params_json, result_preview, created_at)`；46 种工具 |
| action sequence | ❌ 无消费者 | 无任何代码按 session 重建"动作序列"再比对；`tool_calls` 唯一生产消费者是 pain 去重（`production-pain-evidence.ts:295`）与 `exportAnalytics` 计数 |
| before/after comparison | ❌ Missing | **没有任何生产代码以 `activated_at` 为界做前后对比** |

**能否证明 `Before: Agent did X` → `After: Agent did Y`？**

- **结构上：可以。** `activations.activated_at`（真实时间戳）+ `principle_applications.created_at` + `tool_calls.created_at` 三者可对齐；
  `tool_calls` 覆盖 09-01→09-22，09-18 批次的 13 条 prompt 激活前后**都有充足 session**（presence 每原则 51 行）。
- **语义上：还不行。** 因为缺三件事（见下）。

**关键判定 —— `self-report != behavior evidence`：**

```
当前系统能看到的"行为"证据分布：

  Agent said: "📌 应用了你的原则「…」"    105 轮 / 92 条 effect 回执     ← 自称
  机器强制拦截 (rule_blocked)                1 条                     ← 客观
  通过 gate 后的自主行为实际改变          看不到                     ← 缺观测
```

**明确结论：当前 PD 对 prompt-channel 原则，能看到的只有 Agent 自称。**
对 code_tool_hook 原则，能看到 1 条机器强制拦截——**样本量 n=1，不足以支撑任何比较**。

```
Behavior Evidence Capability = Partial
  ├─ 声明侧（该做什么）：Strong
  └─ 观测侧（实际做了没）：Missing
```

### Layer 3 — Outcome Evidence Reality Check

| Outcome Type | Supported | 事实 |
|---|---|---|
| **Task completion** | ⚠️ 有数据，**不构成 Outcome** | `task_outcomes`=304，**100% 为 `'completed'`**（llm.ts:238 硬编码字面量）。SPEC §Layer3 明文："`assistant completed` / `agent claimed success` / `task record exists`"不能单独作为 Outcome |
| **Validation result** | ⚠️ Partial（形成期代理） | `pi_artifacts.validation_status`（validated 62 / pending 854）；`runs.execution_status`（succeeded 1017 / failed 546）；`tasks`（succeeded 921 / failed 70）。均为**管道运行结果**，非任务语义结果 |
| **Pain recurrence** | ❌ Missing（可降至类别级） | `pain_events` canonical_pain_id **54/54 唯一** → 无复犯签名；`pain_diagnoses.category`（People/Design/Assumption/Tooling）提供**粗粒度**同类聚类 |
| **Owner correction** | ⚠️ **可算但未算** | `user_turns.correction_detected`=46、`correction_cue`=81，带 `session_id`+`created_at`；与 presence 回执**可按 session JOIN** → 无需新数据即可算"注入前后纠正率"。但 `correction_samples`（9 行）的 `principle_ids_json` **全部为 `[]`** → 现有归因链为空 |

**`completed != success` 是否成立？——成立，而且刚被代码"制造"了一次风险。**

`llm.ts:226-244` 的注释明确写着补齐了 task_outcomes 的写入者（PRI-768 v5 follow-up），
但写入的 `outcome` 是**硬编码 `'completed'`**。也就是说：
**代码库刚刚创建了一张名为 `task_outcomes`、内容恒为 `completed` 的表，
而 SPEC 正好明文禁止把这类记录当作 Outcome。** 这是本次审查发现的**最高风险命名冲突**。

```
Outcome Evidence Capability = Missing
  （原料：Owner correction 与 error reduction 已经可算；
    缺的是判定口径 + 读取者；validation 只有形成期代理）
```

---

## Current Support

### 1. 已经直接支持（无需任何新代码即可取数）

| 能力 | 取数路径 |
|---|---|
| Pain→Diagnosis→Activation 全链事实 | `state.db` / `trajectory.db` 现表直查 |
| 暴露（session 级） | `principle_applications WHERE level='presence'`（1085 行，activation_id 齐备） |
| 暴露（turn 级） | `task_outcomes.principle_ids_json` join `assistant_turns.run_id` |
| 激活时间窗 | `activations.activated_at / promoted_at / deactivated_at` |
| 行为判据（声明） | `pi_artifacts.content_json → intentContract.{targetBehavior, forbiddenBehavior, evidenceSource}` |
| 合成行为样例 | `goldenTraceCases` / `behaviorExamplePack`（后者未落库，仅进 prompt 上下文） |
| 行为原始轨迹 | `assistant_turns` / `tool_calls` / `user_turns`（按 session + 时间） |
| Owner 纠正原始信号 | `user_turns.correction_detected / correction_cue` |
| 错误原始信号 | `tool_calls.outcome='failure'` + `error_type` + `v_error_clusters` |
| Owner 治理动作 | `activation_decisions` / `signal_confirmations` |

### 2. 需要最小增强（小字段 / 小工具 / 小测试，**不改架构**）

| # | 项 | 体量 | 为什么必要 |
|---|---|---|---|
| **M1** | effect 回执写入 `activation_id` | ~1 行 × 3 处 + 测试 | `gate.ts:187 / 357 / 685` 调用 `recordPrincipleApplication` 时**未传 `activationId`**，而该作用域内 `report.liveDecisionActivationId` **已存在**（gate.ts:154 就在用）。纯连接漏写 → 当前 effect 93/93 NULL，`JOIN activations = 0`，任何 effect 都无法归因到某次 activation |
| **M2** | 实验声明文件（Behavior Signature 观测侧） | 1 个 JSON，无 schema 变更 | `totalOpportunities=0/23`、无 Previous Behavior 载体。Owner 需为**一次实验**显式声明：Target Behavior（可直接引用已有 `intentContract.targetBehavior`）、Eligible Opportunity 判据、Before 窗口。这不是新系统，是一次实验的输入参数 |
| **M3** | Evidence Bundle 读取者 | 1 个只读读模型 | §7 的 11 个 artifact 目前**没有一个**由代码产出；数据都在，缺的是组装 + 判定 |
| **M4** | Owner correction 归因 join | 1 条查询 | `user_turns` × `principle_applications(session_id)`；同时把 `correction_samples.principle_ids_json` 的 `[]` 填上 |
| **M5** | 消除 `task_outcomes` 语义歧义 | 注释/命名或读模型映射 | 明确 `task_outcomes` 是**暴露/机会分母**，不是 outcome；否则 `outcome.json` 会被它污染 |

### 3. 复用而非新建（SPEC §9 合规性说明）

M1–M5 全部落在**现有表 + 现有 writer 参数 + 一个新只读读模型**范围内：
- 不新增 Memory System / Runtime / Control Plane / Evaluation Platform；
- 不新增数据库、不新增表（M2 用文件，M1 复用已有列）；
- 不改变 `level/kind` 语义，不改变 feature flag 契约。

---

## Missing Pieces

按"是否阻塞一次真实验验"排序：

| 优先级 | 缺口 | 分类 | 阻塞性 |
|---|---|---|---|
| **P0** | effect 回执 `activation_id` 93/93 为 NULL（`JOIN activations` = 0） | **Connection gap** | **硬阻塞**：不修则"行为变化"永远无法归因到某次 activation |
| **P0** | 无 `Eligible Opportunity` 判据与分母（`totalOpportunities` = 0/23） | **Definition gap** | **硬阻塞**：没有分母，"After 出现了目标行为"只是轶事，无法与 Before 比较 |
| **P0** | 无 before/after 消费者（0 命中） | **Measurement gap** | **硬阻塞**：数据齐了也没人算 |
| **P1** | 无 Outcome 判定来源（`task_outcomes` 恒 `completed`，无 reader） | **Measurement gap** | 阻塞 PASS 判定（只影响 L3，不影响 L2） |
| **P1** | Owner correction 未归因（`correction_samples.principle_ids_json` 全 `[]`） | **Connection gap** | 可绕过（用 session JOIN），但会让 L3 证据变薄 |
| **P2** | `principle_id` 非规范身份（16 值混用标题/UUID/legacy，含近重复） | **Data identity gap** | 不阻塞单次实验，但会让 bundle 血缘碎片化 |
| **P2** | 无 runtime context reference | **Schema gap** | 不阻塞 MVP（SPEC 要求但可用 `channel`+时间近似） |
| **P2** | `pain_events` 无复犯签名 | **Capability gap** | 阻塞"repeated pain↓"，可降级为 `pain_diagnoses.category` 粒度 |
| **P3** | `v_principle_effectiveness` / ledger metrics 命名幻觉（值全 0） | **Misleading artifact** | 不阻塞，但**必须禁止 bundle 消费**，否则害人 |
| **Next Scope** | Counterfactual / Effect attribution / 自动排序 | **Out of PRI-836** | 属 PRI-837 及以后 |

---

## Scope Boundary

### Already Supported（当前代码直接支持，禁止为此扩系统）

- 全链 Process 五表（pain/diagnosis/candidate/approval/activation）+ 真实数据
- session 级与 turn 级暴露回执
- `IntentContractV1` 作为行为判据（含 targetBehavior / forbiddenBehavior / evidenceSource）
- `goldenTraceCases` 合成行为样例
- 原始行为轨迹（tool_calls / assistant_turns / user_turns）
- Owner 纠正与错误的原始信号
- 激活时间窗与 append-only 治理决策

### Need Minimal Enhancement（PRI-836 范围内可做）

- M1 回填 `activationId` → effect 回执（1 行 × 3）
- M2 一次实验的 Behavior Signature 声明（文件）
- M3 Evidence Bundle 只读读模型（11 artifact 组装）
- M4 Owner correction 归因 join
- M5 明确 `task_outcomes` = 机会分母，非 outcome

### Future Scope（**不得混入 PRI-836**）

- Effect Attribution：结果改善是否由该 Principle 导致（PRI-837）
- Counterfactual Reasoning：若无此 Principle 是否更差
- Causal Inference / 统计显著性 / 置信区间
- Automatic Principle Ranking / 自动评分 / 自动淘汰
- 机会的自动化发现（M2 里必须由 Owner 显式声明，自动发现属未来）
- 复犯签名聚类（pain category 之外的细粒度签名）

---

## Recommendation

**保持 PD 原则：先看清，再动手。不要为了满足 SPEC 而增加系统。**

### 1. 立即可做（PRI-836 可作为一次"人工裁定 + 只读组装"的实验启动）

选一条**已有真实 activation、且能拿到机器或裁定证据**的 Principle，跑一次 B0→A1→A2：

- **推荐候选**：`code_tool_hook` 通道那一条
  （pain `host_cffdcb9f…`，approval 09-15T23:31 approved，live activation 09-15T23:31→09-17T07:54，
  `rule_blocked` effect + shadow snapshot observed=340/wouldBlock=3）。
  理由：**它是全库唯一同时具备"机器强制 effect"与"before 语义 shadow 基线"的案例**。
- **B0 基线**：`activated_at` 之前的 `tool_calls` 失败分布 + `user_turns.correction_detected` +
  shadow `wouldBlock=3/340`（唯一带 before 语义的线上行为邻接证据）。
- **A1/A2**：激活后两个独立 session（presence 回执可定位；25 个 session 同时具备 outcome 与 tool_calls）。
- **行为判定**：优先采用**机器可验证**的 `rule_blocked` / `auto_correct_applied`；
  无法机器验证的部分，由 Owner（或 evaluator）**显式裁定**并记为 evidence，不伪装成自动测量。

### 2. 必须先补的最小能力（否则实验不成立）

1. **M1**：`gate.ts` 三处 effect 回执传入 `activationId`（当前 effect 与 activation 完全断链）。
2. **M2**：为本次实验写下 Behavior Signature 的观测侧（Eligible Opportunity + Before 窗口 + Target/Forbidden，可直接引用已有 `intentContract`）。
3. **M3**：一个只读读取者，把 §7 的 11 个 artifact 组装出来（不改表、不加库、不加 flag）。
4. **M5**：把 `task_outcomes` 明确当**机会分母**用，**严禁**映射为 `outcome.json`。

### 3. 不要做的事

- ❌ 不要把 presence 回执（1085 行、activation_id 齐备）当影响力证据——它只是暴露，且是 session 粒度。
- ❌ 不要把 `self_reported`（92 行）/ `task_outcomes.completed`（304 行）当行为或结果证据。
- ❌ 不要消费 `v_principle_effectiveness` 或 ledger metrics（值全是事件计数/字面量 0）。
- ❌ 不要为本次实验新增 memory system / Runtime / 控制平面 / 评估平台 / 新库新表。
- ❌ 不要把 counterfactual / effect attribution / 自动排序塞进 PRI-836。

### 4. 是否应该进入 PRI-837

**暂不。** PRI-837 的前提是"行为改变已被观测到"，而当前 L2 观测侧还缺 M1/M2/M3。
先完成一次 L2 级别的真实验证（能回答"behavior changed at all"），
再谈"change created reliable improvement"。

---

## Challenge Previous Assumptions

主动寻找 SPEC 仍存在的隐藏问题：

### A. 是否仍把 Exposure 误认为 Influence？——SPEC 文本已防住，但构造上留了滑坡

- SPEC §2 明确 `Exposure != Influence`，写得对。
- **隐藏问题 1**：presence 回执的去重键是 `(principle_id, session_id)`，
  **它只能证明"本 session 注入过"，无法证明"决策时刻仍在上下文"**。
  `exposure.json` 若直接从 presence 生成，会自然带上"整个 session 持续暴露"的过强含义。
  → 建议：`exposure.json` 必须以 **turn/opportunity 粒度**表述（用 `task_outcomes.principle_ids_json`），
  并在 artifact 内显式声明粒度，否则它就成了 influence 的替身。
- **隐藏问题 2**：effect 回执的 `activation_id` 全 NULL，意味着**连"哪次激活产生了效果"都无法回答**；
  在补 M1 之前，"Exposure→Behavior"在数据上不可连接。

### B. 是否仍把 Outcome 误认为 Effect？——SPEC 文本已防住，但**代码刚刚制造了陷阱**

- SPEC §Layer3 明确排除 `assistant completed` / `task record exists`。
- **隐藏问题**：`llm.ts:226-244` 新增的写入者，使 `task_outcomes` 恒为 `outcome='completed'`（304 行）。
  **表名（task_outcomes）与 SPEC 禁忌项（task record exists）几乎同名。**
  任何"有 outcome 表 → 填 outcome.json"的直觉都会直接违规。
  → 必须把该表重新定位为**暴露/机会分母**，并把 outcome 判定改为 Owner 裁定 + 可算指标（correction/failure/validation）。
- 另外：即便 Owner correction reduction 可算，它也是**结果**而非**效果**——
  不能反推"是这条 Principle 造成的"。这条边界要在 bundle 文案里写死，否则 PRI-837 的价值会被提前透支。

### C. 是否仍然需要 Behavior Signature 才能执行？——需要，但成本被高估了

- **需要**：没有判据，"行为改变"无法判定，实验会退化为叙事。
- **但成本被高估**：`IntentContractV1` 已在库中真实存在（212+3 artifact，14/15 激活都带），
  `targetBehavior` / `forbiddenBehavior` / `evidenceSource` / `validationExpectation` 四项**开箱即用**。
- **真正缺的只有两项**：`Eligible Opportunity`、`Previous Behavior`（B0 基线）。
  → 因此 §8 的"DoD：Behavior Signature 已定义"应改写成
  **"Behavior Signature 的观测侧已声明，且目标行为可在原始轨迹中被裁定"**，
  避免团队误以为要从零发明一套行为表示法。

### D.（新增发现）principle_id 不是规范身份 —— 会让 bundle 血缘碎片化

真实 `principle_applications.principle_id` 有 **16 个 distinct 值，格式三种混用**：

```
"约定召回门：Owner 约定首次表达即持久化，阶段切换或敏感操作前强制召回校验"   ← 人类标题
"2d23707d-11a3-4484-a35d-124e19904eac"                                ← UUID
"T-06 最简单干预" / "Model-Evidence-Reversibility-Verification Loop"   ← legacy id
"先以可观察证据验证系统状态"  vs  "先以可观察证据验证系统状态，再给出干预建议"  ← 近重复（同一原则两种写法）
```

且 `principle_candidates` **无 pain_id 列**、ledger `derivedFromPainIds` 存的是 UUID（116/116）。
→ 若 bundle 直接以 `principle_id` 为主键，会出现**同一原则被拆成两条血缘 / 不同原则被合并**。
必须先定义"实验主键"（建议：以 `activation_id` 为锚，`principle_id` 只作展示）。
**这是 SPEC 未覆盖的新风险。**

### E.（新增发现）13/15 的 prompt-channel 激活**结构上无法产出机器行为证据**

`production-rulehost-gate.ts:217` 只对 `channel='code_tool_hook'` 的 activation 强制执行。
prompt-channel 原则只能进入 prompt 注入 → 其唯一的 `level='effect'` 记录必然是 `self_reported`。
→ **如果 PRI-836 选一条 prompt-channel 原则，行为证据会结构性退化为"Agent 自称"。**
→ 这是**最重要的范围决策**：要么选 code_tool_hook 原则，要么明确采用"人工/评估器裁定轨迹"作为行为证据来源，
并在 SPEC 中写清哪一种是可接受的。当前 SPEC 对此**完全沉默**。

---

## Final Verdict

### Can PRI-836 Start?

```
YES WITH SMALL PREPARATION
```

**不是 YES** —— 因为当前 `effect.activation_id` 全 NULL（93/93），行为与激活之间**没有任何数据连接**；
且 `Eligible Opportunity` / `Before` 两要素无载体、无消费者，SPEC §8 的 Acceptance Criteria 中
"Before / After behavior 可比较"与"Outcome Evidence 存在"**今天无法满足**。

**不是 NO** —— 因为缺口全部落在"连接 + 判定 + 组装"，没有一处需要新子系统：
L0 已充沛、L1 已 Strong、L2 声明侧已在库、L3 有两类指标**已经可算**。

### 最小阻塞（Minimum Blocking Set）

| # | 阻塞项 | 体量 | 不做的后果 |
|---|---|---|---|
| **1** | effect 回执传入 `activation_id`（gate.ts 3 处） | ~1 行 × 3 + 测试 | 行为变化永远无法归因到某次 activation → L2 不成立 |
| **2** | 声明实验的 Behavior Signature **观测侧**（Eligible Opportunity + Before 窗口） | 1 个 JSON | 无分母 → After 只是轶事，无法与 Before 比较 |
| **3** | 一个只读读取者组装 §7 Evidence Bundle | 1 个读模型 | 数据齐备但无人产出证据 → Acceptance 无法勾选 |
| **4** | 明确 `task_outcomes` = 机会分母，**不是** outcome；Outcome 判定来自 Owner 裁定 + correction/failure/validation | 语义约定 + 读模型映射 | `outcome.json` 会被 `completed` 污染 → 实验自证自明 |

**完成 1–4 后**：一次 L2 级别的真实验（"did behavior change at all?"）即可启动；
PASS/FAIL/INCONCLUSIVE 三分类与 Owner Keep/Revise/Revoke/Continue 决策可在
**现有 `activation_decisions` + 人工裁定**下完成，无需新表。

### 是否应该进入 PRI-837

**否，先完成 PRI-836 的一次 L2 验证。**
PRI-837（reliable improvement）的前提是行为改变已被观测到；
在 `activation_id` 未连通、机会分母未声明之前进入 PRI-837，
会把"无法归因"误判为"效果不显著"。

### 是否存在架构风险

**没有需要新增子系统的架构风险**，但有三个**语义风险**必须在 PRI-836 内先消除：

1. **命名幻觉扩散**：`v_principle_effectiveness`（实为事件计数）、ledger `valueScore/adherenceRate`（全 0）、
   以及**新出现的 `task_outcomes`（恒 `completed`）**——三者都会被误当"效果"消费。
2. **粒度偷换**：presence 回执是 session 粒度，`task_outcomes` 是 turn 粒度，`activations` 是 activation 粒度，
   而 SPEC 用 `task_id` 一以贯之。三者混用会让 exposure→influence 边界消失。
3. **身份漂移**：`principle_id` 三格式混用 + `source_principle_id` 仅 27/894 非空 +
   `derivedFromPainIds` 名实不符。不先定锚（建议以 `activation_id` 为锚），bundle 血缘会碎。

> **先看清，再动手。本次审查未发现任何一项需要"为了满足 SPEC 而新增系统"的缺口；
> 反而发现 SPEC 所要求的 Behavior Signature，其判据部分早已以 `IntentContractV1` 的形式存在于库中。**

---

*End of Reality Check.*
