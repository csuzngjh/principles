# PRI-836 Implementation Reality Map

> 只读实现现实映射审计（Implementation Reality Mapping）。未修改代码、schema、runtime、配置或 feature flag；未创建 PR / Linear 工单；未新增框架。
> 唯一产物：本文档。
>
> **审查对象**：`docs/specs/BEHAVIORAL_LEARNING_MVP_ACCEPTANCE_v3.md`（Draft v3，6268 B，2026-09-22 18:24，工作树 untracked）
> **基线**：`BASE_SHA = e5e2b16b4e1aa18e0b736a6957613906cf65d582`（main）
> **运行时数据**（只读 `better-sqlite3 {readonly:true}` + 只读读 `events_*.jsonl`）：
> `D:\.openclaw\workspace\.pd\state.db` / `.state\trajectory.db` / `.pd\logs\` / `.state\logs\`
> **已确认在基线内的近期合并**：PRI-889 `62374d27`（Console Owner 决策按钮）、PRI-890 `fcaf7e46`（approve 预算感知警告）——两者 `git merge-base --is-ancestor` 均为 HEAD 祖先。

---

## Executive Summary

**Question 1 的直接回答：NO —— PRI-836 不需要新系统。**

而且本次审计找到了比预期强得多的证据：**v3 SPEC 中 Layer 2 最难的一项要求（Eligible Opportunity + 行为命中计数 + 时间窗 + 代表性样本）已经在生产代码里实现并已在 Console 上渲染**，只是它目前只消费 `rulehost_evaluated` 这一类事件。

```
ActivationsConsoleModel.readRuleCodeTelemetry(workspaceDir, activationId, decisions)
  packages/pd-console/src/server/models/ActivationsConsoleModel.ts:221-247
  └─ collectRuleCodeEventEntries()  :193-219   读 .pd/logs + .state/logs 的 events_*.jsonl（近 7 个文件）
  └─ 按 entry.data.activationId === activationId 过滤          ← activation 级血缘
  └─ 窗口聚合 last24Hours / last7Days：eligible / matched / blocked / unhealthy / circuitTrips
  └─ toolDistribution + representativeSamples(≤6, toolName+decision+pathCategory)
  └─ 渲染于 Activation 页：eligibleEvaluations / matched / blocked / shadowWindow / 以及 Owner 决策按钮
```

**`eligible` 就是 v3 要的 Opportunity 分母；`matched / blocked` 就是行为命中；`last24Hours / last7Days` 就是 before/after 窗口。**
v3 Layer 2 的形状在生产里已经存在——**缺的是让它消费 prompt 通道的两类事件**，而不是发明一套行为引擎。

三层证据总体状态：

| Layer | v3 要求 | 现有载体 | 状态 |
|---|---|---|---|
| **L0 Process** | Pain→Diagnosis→Principle→Approval→Activation | 五张表全部真实有数据 | ✅ **Exists** |
| **L1 Exposure** | session/task + principle + activation_id + timestamp + runtime exposure reference | **五要素全部落在同一个已存在事件** `runtime_v2_prompt_activations_injected` | ✅ **Strong** |
| **L2 Behavior** | Behavior Signature + Before/After + 强度分级 | 声明侧 = `IntentContractV1`（218 artifact）；观测侧原料 = `tool_calls` + event log；**观测读模型已有前例（RuleCode 通道）** | ⚠️ **Partial（原料足、装配缺）** |
| **L3 Outcome** | 五类可接受结果，禁止 `task_outcomes.completed` | `v_daily_metrics` 已算 failures + user_corrections；`task_outcomes` 真语义 = Completion Record | ⚠️ **Partial（两口径可算、判定缺）** |

**最具决定性的一步验证**：本次审计用现有表**实际重建了 PRI-768 v6 那条链的 Before 与 After**，未依赖任何新数据（见 §PRI-768 Mapping）。

```
PRI_836_IMPLEMENTATION_MAP = READY_AFTER_MINIMAL_PREPARATION
```

---

## New System Decision

### Question 1：PRI-836 当前是否需要新系统？

```
NO
```

**证明方式（反证）**：逐条把 v3 的要求映射到**已存在的**载体；若全部命中，则"新系统"命题不成立。

| v3 要求 | 已存在的载体 | 位置 | 需要新系统？ |
|---|---|---|---|
| Pain / Diagnosis / Principle / Approval / Activation | 5 张表 | `trajectory-schema.ts:91`；`sqlite-connection.ts:350/379/395/439/678` | 否 |
| task/session identity（暴露） | `sessionId` + **`runId`** | injection event `data.sessionId/runId` | 否 |
| principle identity（暴露） | `principleIds[]` | 同上 | 否 |
| activation_id（暴露） | **`activationIds[]`（与 principleIds 同序对齐）** | 同上 + `principle_applications.activation_id` | 否 |
| timestamp（暴露） | event `ts` + 各表 `created_at` | 同上 | 否 |
| runtime exposure reference | `budget` / `injectedCharCount` / `v2Truncated` / `artifactIds` / `legacyTruncated` / `crossBlockDuplicateIds` / `workspaceDir` | 同上 | 否 |
| Behavior Signature：Target / Forbidden / EvidenceSource / ValidationExpectation | `IntentContractV1`（5 个非空必填字段） | `intent-contract.ts:40-51`，真实落在 **218 个 artifact** | 否 |
| Eligible Opportunity | **`eligible` 计数（RuleCode 通道已实现）** | `ActivationsConsoleModel.ts:234` | 否（缺泛化） |
| Behavior 观测：action sequence | `tool_calls`（session_id 有序 + `params_json`） | `trajectory-schema.ts:90` | 否 |
| Behavior 观测：tool / file changes | `tool_calls.params_json.path` + event log `tool_call.filePath` | 见 §Layer 2 | 否 |
| Before/After 窗口 | `last24Hours / last7Days` 窗口模式 + `v_daily_metrics`（按天 failures / user_corrections） | `ActivationsConsoleModel.ts:226`；`trajectory-schema.ts` 视图 | 否 |
| Owner 治理决策 | `activation_decisions`（append-only、不可变触发器）+ Console 决策按钮（PRI-889 已合并） | `sqlite-connection.ts:502`；`ActivationPage.tsx:78-125` | 否 |
| 结果证据：error / correction 趋势 | `v_daily_metrics`（真实输出见下） | 视图 | 否 |
| 暴露证据的读取范式 | `collectRuleCodeEventEntries` + 窗口聚合 | `ActivationsConsoleModel.ts:193-247` | 否 |

**→ 缺的是 lineage / read model / query / evidence assembly / validation，不是新能力。**

结论：v3 里每一项"看起来像要造东西"的要求，都能指到一个已经在跑的载体。
真正为 0 的只有四件事，且全部属于"连接/装配"：

1. **effect 回执 → activation 的连接**（93/93 NULL）
2. **prompt 通道的暴露/行为读模型**（范式已有，只是消费的事件类型不同）
3. **实验级 Behavior Signature 的观测侧声明**（`Eligible Opportunity` + `Previous Behavior` 无载体）
4. **Evidence Bundle 的装配器**（11 个 artifact 无一由代码产出）

---

## Evidence Layer Mapping

### Layer 0 — Process Evidence

| Requirement | Exists? | Location | Missing Connection |
|---|---|---|---|
| **Pain** | ✅ | `trajectory.db.pain_events`（`trajectory-schema.ts:91`）；**55 行**，52+ 带 `runtime_task_id`；`origin` = system_infer / user_manual；改正原文另有 `user_turns`（976 行，`correction_detected`=47）+ `correction_samples`(9) | Pain→Diagnosis 经 `runtime_task_id = diagnosis_<canonical_pain_id>` 字符串约定（非 FK） |
| **Diagnosis** | ✅ | `state.db.pain_diagnoses`（`sqlite-connection.ts:678-691`）；**28 行**；`category ∈ {People,Design,Assumption,Tooling}`；写入 `pain_diagnosis_store.ts:113`（flag `pain_diagnosis_persistence=true`） | 无 Console 生产读者（`getDiagnosesByPainId` 仅测试调用） |
| **Principle** | ✅ | `principle_candidates`(134) + `pi_artifacts`(904，含 `intentContract` 218) + ledger `_tree`（116 原则） | `principle_candidates` **无 pain_id 列**；`pi_artifacts.source_principle_id` 仅 27/904 非空；`derivedFromPainIds` 实存 UUID 而非 pain_id |
| **Approval** | ✅ | `approvals`（`sqlite-connection.ts:395`）；**40 行**（approved **5** / pending 33 / rejected 2） | 无 candidate/principle 外键，经 `artifact_id` 间接 |
| **Activation** | ✅ | `activations`（`:439`）；**15 行，10 条仍 live**；`activated_at/promoted_at/deactivated_at` 真实；`activation_decisions`(3) 带不可变触发器 | 无 principle_id/approval_id 外键；prompt 激活的 artifact **12/13 `source_principle_id` 为 NULL** |

**Example（PRI-768 真实链，DB 现查）**：
```
pain_events.id=44  canonical=pain_host_f31331de…  origin=system_infer score=70  2026-09-21T17:35:28
  runtime_task_id = diagnosis_pain_host_f31331de…
pain_diagnoses     pain_id=pain_host_f31331de…  category=People conf=0.76     17:35:28
approvals          apr_prompt_pi-art-scribe-95427453-…  status=approved        19:20:48.735
activations        act_prompt_结论必须由可观察证据背书：无查验则显式降级为推断   19:20:48.751  deactivated_at=NULL
```

### Layer 1 — Exposure Evidence

**v3 要求的五要素，全部命中同一个已存在事件。**

| v3 要求 | 事件字段 | 实测值示例 |
|---|---|---|
| task/session identity | `data.sessionId` + **`data.runId`** | `974cb8b3-…` / `51cc09c0-5db1-4226-80d7-934041773582` |
| principle identity | `data.principleIds[]` | 10 条原则标题数组 |
| **activation_id** | `data.activationIds[]` | `act_prompt_意图锚定：…` 等，与 principleIds 同序 |
| timestamp | `ts` / `date` | `2026-09-22T…` |
| **runtime exposure reference** | `budget` / `injectedCharCount` / `injectedCount` / **`v2Truncated`** / `artifactIds` / `legacySelectedCount` / `legacyTruncated` / `crossBlockDuplicateIds` / `workspaceDir` | 预算 2000c、1864/2000c 不再截断 |

事件落盘：`.state/logs/events_*.jsonl`（`.pd/logs` 为候选第二源）：
```
events_2026-09-20.jsonl  注入事件 104
events_2026-09-21.jsonl  注入事件 509
events_2026-09-22.jsonl  注入事件  88      （当日事件总数 1156：hook_execution 660 / tool_call 243 / rulehost_evaluated 155 / injection 88 / pain_signal 10）
```

**Question：当前 exposure 能证明 A / B / C 中的哪一级？**

```
等级 A：Principle was injected                  → ✅ 已证明（DIRECT）
等级 B：Specific task was influenced            → ⚠️ 可逼近（runId 级暴露 + 动作序列可对齐），但"influenced"仍需裁定
等级 C：Specific action was caused by Principle → ❌ 不可证明（属 Effect Attribution，v3 已划归 Future）
```

**结论：PD 当前稳定在 A 级，且能到 B 级的"暴露粒度"——即能回答"哪个 runId 注入了哪条 activation"，但 token 注入 ≠ 决策时刻在场 ≠ 因果。**

同时存在两个必须写进结论的粒度事实：
1. `principle_applications` presence 回执去重键是 `(principle_id, session_id)`，**session 粒度**（v3 也自己指出"Session 级 presence 不应被描述为行为影响证据"——SPEC 判断正确）；
2. injection event 带 `runId`，是**turn 粒度**，比回执更强。**v3 的 `exposure.json` 应以 injection event 为源，而非 presence 回执。**

**特别检查：activation_id lineage**

| 路径 | 状态 | 数据 |
|---|---|---|
| activation → **presence** 回执 | ✅ **已连通** | 1085/1085 非空，`JOIN activations` = 1085 |
| activation → **effect** 回执 | ❌ **断开** | 93/93 全部 NULL，`JOIN activations` = **0** |

最小修复（见 M1）：`gate.ts:187 / 357 / 685` 调用 `recordPrincipleApplication` 时未传 `activationId`，
**而 `report.liveDecisionActivationId` 在同一作用域已可用**（`gate.ts:154` 就在用它）。
→ 纯参数漏传，非能力缺失。

### Layer 2 — Behavior Evidence（最高优先级）

**v3 把行为证据分 4 级，逐级核对现有载体：**

| v3 等级 | 定义 | 现有载体 | 状态 |
|---|---|---|---|
| **Level 0** Self Report | Agent 声明遵守 | `principle_applications kind=self_reported`（**92 行**）+ `assistant_turns` 含 `📌 应用了你的原则「…」`（**按天分布：09-13 11 / 09-14 5 / 09-15 5 / 09-16 12 / 09-17 7 / 09-18 7 / 09-19 7 / 09-20 2 / 09-21 13 / 09-22 2**） | ✅ 有（v3 正确分类为"不属于行为证据"） |
| **Level 1** Trajectory Observation | assistant turns / action sequence | `assistant_turns`(2350) + `tool_calls`(14412，按 `session_id`+`created_at` 可重建有序动作序列) | ✅ **有** |
| **Level 2** Tool / Artifact Verification | tool calls / file changes / generated artifacts | `tool_calls.params_json`（edit/write 含 `path` + `oldText/newText` 逐字 diff；已脱敏为 `<path:…>`）+ event log `tool_call.filePath` + `result_preview` + `exit_code` | ✅ **有** |
| **Level 3** Runtime Enforcement | hook / rulehost | `principle_applications kind=rule_blocked`（**1 行**）+ `rulehost_evaluated` 事件（**155/日**）+ `gate_blocks`(1) | ⚠️ **有但仅 code_tool_hook 通道** |

**IntentContract 检查（v3 明确要求优先复用）——已具备：**

```
IntentContractV1 (packages/principles-core/src/runtime-v2/internalization/intent-contract.ts:40-51)
  ownerIntent            ✅
  targetBehavior         ✅  ← v3 Target Behavior
  forbiddenBehavior      ✅  ← v3 Forbidden Pattern
  evidenceSource         ✅  ← v3 Evidence Source
  validationExpectation  ✅  ← v3 Expected New Behavior
  真实落地：218 个 artifact 的 content_json 含 intentContract
```

**Trajectory 检查：能否观察 Before: Agent did X / After: Agent did Y？**

**能。本次审计用现有表实际重建了 PRI-768 的 After 行为（未造任何新数据）：**

```
AFTER — session a83b09f0-afb7-4aef-831b-5f0d31608fc4（tool_calls 有序）
  19:34:59 read    ~/.openclaw/agents/main/agent/workshop-skills/service-config-value-…
  19:35:09 exec    Get-ChildItem -Path D:\ -Directory -Filter "*cron-notify*"
  19:35:38 process kill            (failure)
  19:35:38 ls      pri768v6-lab\cron-notify-service
  19:35:45 read    pri768v6-lab\cron-notify-service\scheduler.py
  19:36:26 exec    git -C pri768v6-lab\cron-notify-service log --oneline --all
  19:36:27 exec    rg -n --hidden 'MAX_RETRIES'      (failure)
  19:37:07 exec    rg -n -i --hidden 'cron-notify'
AFTER — 对应回复（assistant_turns.sanitized_text）
  "核查完毕，结论如下：**当前重试上限：MAX_RETRIES = 5**（…scheduler.py:3）
   **漏改核查：没有漏改。** 逐项证据：- 改动史：内嵌 git 仓库提交 7a2ab9d… "
  → 每个事实结论都绑定了一次实际查验动作并带 file:line 引用 = 目标行为可观察
```

```
BEFORE — 失败模式（user_turns 真实纠正原文）
  2026-09-21T17:29:43  "你说这个目录「未纳入 git 跟踪」…你没查过就下结论。
                        第二，你说「验证通过」——你到底验证了什么？"
  2026-09-21T18:19:04  "汇报太啰嗦了…改一个数字的事你写了三大段"
  + pain #44 / #45（score 70）作为该失败模式的入库证据
  + 激活前 session 的动作序列可作 B0 对照（13234968 末次 19:16 / 974cb8b3 末次 19:00…）
```

**Artifact Evidence 检查（git diff / generated files / test results / validation output）：**

| 载体 | 状态 | 说明 |
|---|---|---|
| file changes | ✅ | `tool_calls.params_json`（`path` + 逐字 diff）+ event log `tool_call.filePath` |
| generated files | ⚠️ | 只能从 `tool_calls` 推断（无独立"产物清单"表）；`result_preview` 可佐证 |
| test results | ⚠️ | 表现为 agent 执行的 `exec`（如 `py_compile`）落在 tool_calls，**无结构化"测试通过"记录** |
| validation output | ⚠️ | `pi_artifacts.validation_status`（validated / pending）+ `runs.execution_status`（succeeded 1017 / failed 546）——**测的是 PD 管道产物质量**，非任务验证结果 |
| state.db `commits` / `artifacts` 表 | ⚠️ | 存在（各 51），但记录的是**PD 自己的任务/运行**（`task_id=diag_router-…`），不是用户工程仓库的 commit |

```
Behavior Evidence Capability = Partial
  声明侧（该做什么）      : Strong —— IntentContractV1 真实在库
  观测侧原料（做了什么）  : Strong —— tool_calls + event log 可重建动作序列（本审计已实证）
  观测侧装配（算出来）    : Missing —— 无 before/after 消费者（见下）
```

**最后一个坑（实务性，必须写进实验设计）**：暴露的 session 大多是**长生命周期主会话**
（如 `974cb8b3` 从 09-04 跨到 09-22，1243 次调用；`13234968` 973 次）。
→ **B0/A1/A2 不能按 session 切分，必须按 `created_at` 时间窗或 `runId` 切分。**
这是 v3 "至少两个独立任务机会"在实现层最容易被做错的地方。

### Layer 3 — Outcome Evidence

**`task_outcomes` 的真实语义（v3 已点名禁止）：**

```
SELECT outcome, COUNT(*) FROM task_outcomes  →  307 行，DISTINCT outcome = 1
outcome 恒为 'completed'
写入者：packages/openclaw-plugin/src/hooks/llm.ts:226-244（每轮 assistant 输出写一行）
        taskId = host runId；principleIdsJson = getInjectedPrincipleIds(sessionId)
读取者：全仓 0（仅 writer）
```

**回答：它是什么？**

```
task_outcomes ∈ { Outcome, Opportunity, Completion Record, Unknown }
             →  Completion Record（同时是 Opportunity 分母的载体）
```

**理由**：`outcome` 是硬编码字面量 `'completed'`，不含任何成功/失败/验证判定；
其 `principle_ids_json` 承载的是**该轮的注入原则清单**（= 暴露/机会），
`task_id = runId` 使其成为"逐轮机会分母"。**它不是 Outcome Evidence，v3 的禁止项判断正确。**

**已有 Outcome 来源清单：**

| Evidence | Exists? | Location | Can prove improvement? |
|---|---|---|---|
| **Task success** | ⚠️ 有记录，**不可作证** | `task_outcomes`(307, 全 completed)；`tasks`(1052: succeeded 921/failed 70/pending 39/needs_human_review 6/retry_wait 4)；`runs`(1573: succeeded 1017/failed 546) | ❌ 完成 ≠ 成功（v3 明确） |
| **Error reduction** | ✅ **可算** | `v_daily_metrics` 真实输出：`09-22 calls 243/fail 15/corr 9`、`09-21 1799/104/23`、`09-20 404/18/4`、`09-19 528/31/3`、`09-18 286/16/1`；另有 `v_error_clusters`（exec 313 / browser 128 / view_image 123…） | ⚠️ 能测"错误总量趋势"，**"目标类错误是否减少"需实验声明目标类** |
| **Pain recurrence** | ⚠️ **可降级实现** | `pain_events` 55 行，`canonical_pain_id` **55/55 唯一** → 无复犯签名；但 `pain_diagnoses.category`（People/Design/Assumption/Tooling）提供**类别级**聚类；`signal_confirmations`(11) 提供 Owner 对 pain 的真伪裁定 | ⚠️ 类别粒度可测"同类 pain 是否减少" |
| **Owner correction** | ✅ **可算** | `user_turns.correction_detected`=47 / `correction_cue` 81，带 `session_id`+`created_at`；与 presence 回执**可按 session JOIN** → 注入前后纠正率 | ⚠️ 可算；但 `correction_samples`(9) 的 `principle_ids_json` **全为 `[]`**，现成归因链为空 |
| **Validation improvement** | ⚠️ 形成期代理 | `pi_artifacts.validation_status`、evaluator `"score"`（129/890） | ❌ 测产物质量，非任务验证结果 |
| **Rollback / 治理反转** | ✅ | `activations.deactivated_at`；`activation_decisions`（3 条：emergency_deactivate / promote_live / emergency_deactivate）；event log `governance_action`（09-21 两条 deactivate，含 `activationId` + `reasonCode` + `outcome:authorized`） | ⚠️ 可作为"结果不良"的反向信号 |

```
Outcome Evidence Capability = Partial
  error reduction ✅ 可算 / owner correction ✅ 可算（均为现成视图或一跳 JOIN）
  pain recurrence ⚠️ 仅类别粒度 / validation ⚠️ 仅形成期代理
  判定（"这是好还是坏"）      : Missing —— 无消费者、无实验级判定口径
```

---

## PRI-768 Mapping

**不重新设计实验。把已成功的 Golden Journey（PRI-768 v6，2.5 小时内两条真实 Owner 纠正全链贯通）映射到 v3。**
以下每一行均为**本次审计对生产库的现查结果**。

| v3 Requirement | PRI-768 Evidence | Status |
|---|---|---|
| **Pain** | `pain_events.id=44` `pain_host_f31331de…` origin=system_infer score=70 @09-21T17:35:28；`correction_samples.sample_b9c76258de98`（bad_turn 2239 / correction_turn 939，逐字原文） | **DIRECT** |
| **Diagnosis** | `pain_diagnoses` `pain_host_f31331de…` category=**People** conf=0.76 @17:35:28.585；诊断工件 `pi-art-diag_rootcause/distiller/router-…`；evidence[0] = `{sourceRef:"owner_correction", note:"Owner 原话（逐字）…"}` | **DIRECT** |
| **Principle** | `principle_candidates` 95427453（approve）/ 94aa1711（pending）/ f063087f（code 通道被 PRI-780 门拦）；`pi_artifacts` scribe 工件带 **intentContract**（evidenceSource 逐字引用 owner_correction）；ledger `643884a7-6e9e-427a-a8f7-37bb35221093` candidate→**active** | **DIRECT** |
| **Approval** | `approvals.approval_id = apr_prompt_pi-art-scribe-95427453-ff20-45e9-bd9d-0592affdd86b-prompt-run_scribe-95427453-…-prompt_1`，status=**approved**，decided_at=**09-21T19:20:48.735** | **DIRECT** |
| **Activation** | `activations` `act_prompt_结论必须由可观察证据背书：无查验则显式降级为推断`，action=prompt_activate，activated_at=**19:20:48.751**（批准后 16ms），**`deactivated_at` 仍为 NULL（至今 live）** | **DIRECT** |
| **Exposure** | `principle_applications` presence **11 行**（id 16823/16833/16844/16854/16864/16874/16884/16894/16924/16934/17104），**activation_id 全部回链**，覆盖 10 个 session，时间 **19:33:58 → 23:20:43**；且 injection event 带 `runId` 与 `v2Truncated` 状态 | **DIRECT** |
| **Behavior Before** | `user_turns` 纠正原文 @17:29:43（"你没查过就下结论…你到底验证了什么？"）+ @18:19:04（"汇报太啰嗦"）；pain #44/#45；激活前 session 动作序列（13234968 末次 19:16 / 974cb8b3 末次 19:00） | **DIRECT**（本次现查） |
| **Behavior After** | session `a83b09f0` 有序动作序列（read→exec→ls→read→git log→rg，19:34:59→19:37:07）+ 回复原文"当前重试上限 MAX_RETRIES=5（scheduler.py:3）…漏改核查：没有漏改。逐项证据：" | **DIRECT**（本次现查，Level 1+2） |
| **Outcome** | `task_outcomes` #211/#212（session 89e13a8b）/ #216（session a83b09f0），`principle_ids_json` 含新原则，created_at 19:26/19:28/19:37 | **PARTIAL**——行存在且可 join，但 `outcome='completed'`（Completion Record，v3 禁止作 Outcome）；另有 `principle_applications` effect 行 #17826（self_reported，**activation_id=NULL**，09-22T08:31） |

**Question：PRI-768 是否已经接近 PRI-836？**

**是，而且比预期更近。** 分项判定：

| 维度 | 结论 |
|---|---|
| L0 Process（五节点） | **已达成**——九节点全部 DIRECT，DB 现查一致 |
| L1 Exposure | **已达成**——11 条 presence 回执带 activation_id；injection event 五要素齐备 |
| L2 Behavior | **行为事实已存在**（Before 纠正原文 + After 动作序列与回复），但**未被装配成 before/after 对照证据**；effect 侧仍是 self_reported（且 activation_id=NULL） |
| L3 Outcome | **未达成**——outcome 节点只有 `completed` 记录；error/correction 趋势可算但未算 |
| 实验协议（B0/A1/A2） | **未声明**——v6 的窗口是操作性的，不是实验声明的 |
| Owner 决策 | **部分达成**——激活级决策已有（activation_decisions + Console 按钮）；**实验级 Keep/Revise/Revoke/Continue Observation 无载体** |

**关键判断：PRI-768 已经完成了 PRI-836 最难的部分（真实激活 + 真实暴露 + 可观察的行为前后事实），
它缺的恰好是 v3 要补的那一层"装配与声明"。因此 PRI-836 更像 PRI-768 的收口，而不是新工程。**

---

## Existing Capabilities

**可直接复用，禁止重建：**

1. **candidate key 的激活血缘**：`activations`（15，10 live）+ `activated_at/promoted_at/deactivated_at` + `activation_decisions`（append-only + `no_update`/`no_delete` 触发器）
2. **注入事件的完整暴露载荷**：`runtime_v2_prompt_activations_injected`（`event-log.ts:212`；`.state/logs/events_*.jsonl`）——含 `sessionId/runId/principleIds/activationIds/artifactIds/budget/v2Truncated`
3. **事件日志读取范式**：`collectRuleCodeEventEntries()`（`ActivationsConsoleModel.ts:193-219`）——双候选目录、近 7 文件、按优先级去重、坏行单条剔除
4. **按 activation 聚合 + 窗口 + 机会分母 + 命中计数 + 代表性样本**：`readRuleCodeTelemetry()`（`:221-247`）
5. **行为原料**：`tool_calls`(14412, `params_json` 含 path/逐字 diff) + `assistant_turns`(2350) + `user_turns`(976, `correction_detected`/`correction_cue`)
6. **行为声明判据**：`IntentContractV1`（218 artifact）+ `goldenTraceCases`（243+4 artifact）
7. **趋势聚合**：`v_daily_metrics`（按天 tool_calls / failures / user_corrections）、`v_error_clusters`、`v_sample_queue`、`getDataStats()`、`exportAnalytics()`
8. **Owner 决策面**：`ActivationPage.tsx:78-125`（continueObserving / rejectAfterShadow / promote / recoverToShadow）+ PRI-889 刚合并的 `PendingReviewCard` 接线 + `/approvals/grouped`
9. **证据链读模型骨架**：`EvidenceChainConsoleModel` + `GET /api/v1/evidence-chain` + `assembleEvidenceChain()`
10. **降级契约（rc-9）**：`status: 'degraded'` + `reason` + `nextAction`（`ReceiptsConsoleModel`、`ActivationsConsoleModel` 均已实现）——新读模型应沿用此契约而非另造

---

## Missing Connections

**用户预设的三个 Gap，逐条判定：**

### Gap 1 — Activation → Effect：**成立**，且只是缺 activation_id propagation

- 事实：presence 已连通（1085/1085），**effect 93/93 全 NULL，JOIN = 0**。
- 位置：`gate.ts:187`（rule_blocked）/ `:357`（auto_correct_applied）/ `:685`（shared rule_blocked）调用 `recordPrincipleApplication` 时未传 `activationId`。
- **决定性证据**：同一作用域内 `report.liveDecisionActivationId` **已存在且正在使用**（`gate.ts:154`；`production-rulehost-gate.ts:444` 为每个 candidate 输出 `activationId`）。
- → **纯参数漏传。最小修复 = 传参 + 一条断言测试。**

### Gap 2 — IntentContract → Behavior Evidence：**成立**，缺 experiment observation（不是缺模型）

- 判据侧已在库（218 artifact 带 intentContract；`targetBehavior/forbiddenBehavior/evidenceSource/validationExpectation` 齐备）。
- 观测侧原料已在库（tool_calls 有序序列 + 回复原文 + 事件日志 filePath）。
- **真正缺的只有两件事**：
  1. **实验级声明**：`Eligible Opportunity`（如何判定"这是一次适用机会"）+ `Previous Behavior`/B0 窗口 —— v3 自己也只新增这两项；
  2. **裁定（adjudication）**：把"这次动作序列是否体现 targetBehavior"从原始轨迹推到结论。**prompt 通道无法机器验证散文式遵守**，必须由 Owner/evaluator 显式裁定并记为证据（不能伪装成自动测量）。
- → **缺的是 experiment observation + 裁定口径，不是 Behavior Engine。**

### Gap 3 — Existing Data → Evidence Bundle：**成立**，缺 read model

- §Evidence Bundle 的 11 个 artifact **没有一个由代码产出**。
- 但数据齐备：pain/diagnosis/principle/approval/activation = 直查；exposure = injection event；behavior-* = tool_calls + 裁定；outcome = `v_daily_metrics` + 裁定；owner-decision = 新记录。
- → **缺一个只读装配器。范式（`collectRuleCodeEventEntries` + 窗口聚合 + coverage 披露）已存在。**

### 额外发现（不在用户预设的 3 个 Gap 内，但会直接毁掉实验）

| # | 发现 | 影响 |
|---|---|---|
| **G4** | **B0/A1/A2 不能按 session 切分**——暴露的 session 是长生命周期主会话（`974cb8b3` 跨 09-04→09-22，1243 calls） | 必须按 `created_at` 时间窗 / `runId` 切；否则 before/after 混在同一 session 内 |
| **G5** | **13/15 激活是 prompt 通道**，而 `production-rulehost-gate.ts:217` 只强制 `channel='code_tool_hook' AND deactivated_at IS NULL` | prompt 原则**结构性**无 Level 3 证据；其 effect 只能是 self_report |
| **G6** | `principle_id` 非规范身份（16 个 distinct，混用标题/UUID/legacy，含近重复） | bundle 若以 principle_id 为键会碎片化血缘；**建议锚 activation_id** |
| **G7** | `v_principle_effectiveness` 命名幻觉（实输出 `{pain_detected:101, pain_recorded:63}`）；ledger `totalOpportunities/valueScore/adherenceRate` 全 0 | **禁止 bundle 消费**，否则主动制造假证据 |
| **G8** | `effect` 自报解析对长 ID 截断敏感（PRI-768 v6-07）——但本次现查发现 `#17826` self_reported 行**已入账**（09-22T08:31），说明该缺陷是**部分自愈/时序性**的 | effect 计数对新长 ID 原则系统性偏低，需在实验中按 presence 兜底 |

---

## Scope Creep Detection

**结论：v3 SPEC 本身没有 scope creep，且主动收敛。** 逐项核查用户列出的禁区：

| 禁区 | v3 是否引入 | 判定 |
|---|---|---|
| 新 Memory System | ❌ 明确列为"不包含" | ✅ 清洁 |
| 新 Learning Framework | ❌ 未提及，且把 counterfactual/attribution 划归 Future | ✅ 清洁 |
| 新 Behavior Model | ⚠️ **有风险表述**——v3 要求"定义 Behavior Signature"。但 **Target/Forbidden/EvidenceSource/ValidationExpectation 明确要求"优先复用现有 IntentContract"**，真正新增只有 `Eligible Opportunity` + `Previous Behavior` | ⚠️ **需盯防但不构成 creep**（见下） |
| 新 Evaluation Platform | ❌ 明确"不包含新 Runtime / 新 Control Plane"；未要求评估平台 | ✅ 清洁 |
| Counterfactual System | ❌ 明确列为"不包含" | ✅ 清洁 |
| Causal Engine | ❌ 明确"Effect Attribution 属于未来阶段" | ✅ 清洁 |
| 新增 schema / runtime | ❌ 未要求；v3 的 M1–M5 全部是连接/读模型/声明 | ✅ 清洁 |

**需要盯防的两个潜在 creep 点（本审计提出的防护建议）：**

1. **`behavior-signature.json` 可能被误做成 schema** —— v3 说"新增 Eligible Opportunity / Previous Behavior"。
   若实现成**新表或新列**，即为 scope creep。
   → **正确做法：一个实验级 JSON 声明文件**（复用 `IntentContractV1` 已有字段 + 补 2 个字段），零 schema 变更。
   现有先例：`activation_evidence_snapshots`（`:552`）就是"一次快照一个 artifact"的既有模式，可直接照抄其形状。

2. **"Behavior Engine" 诱惑** —— 本审计已证明：**窗口 + 机会分母 + 命中计数 + 代表性样本的范式已在 `readRuleCodeTelemetry` 存在**。
   若新写一个独立的"行为引擎"，就是把同一个读模型做第二遍。
   → **正确做法：泛化既有读模型的输入事件类型（`runtime_v2_prompt_activations_injected` + `tool_call`），不新造组件。**

**反向声明**：本次审计提出的 5 项最小准备，全部落在
`已有 writer 参数` / `实验级 JSON 声明` / `只读读模型` / `只读装配器` / `已有决策面` 范围内，
**不新增表、不新增库、不新增 flag、不新增运行时**。

---

## Minimal Preparation Plan

**最多 5 项，全部为连接/声明/只读装配，均不引入新系统。**

### M1 — effect 回执补 `activation_id`（连接，最高价值）

- **改哪里**：`packages/openclaw-plugin/src/hooks/gate.ts` 三处 `recordPrincipleApplication`（`:187` rule_blocked / `:357` auto_correct_applied / `:685` shared rule_blocked）传入 `activationId: report.liveDecisionActivationId`。
- **为什么最小**：`recordPrincipleApplication` 的入参**已支持** `activationId`（`principle-application-ledger.ts:30,90`）；`liveDecisionActivationId` **已在该作用域可用**（`:154` 在用）。
- **验收**：新 effect 行 `JOIN activations` 非 0；补一条断言测试（现有 `gate-receipt-integration.test.ts` 可挂）。
- **不做会怎样**：行为证据永远无法归因到 activation → L2 不成立。

### M2 — 实验级 Behavior Signature 声明（声明，零 schema 变更）

- **产出**：1 个 JSON（例：`docs/audit/pri768b-experiment/behavior-signature.json` 或实验目录下）。
- **内容**：`targetBehavior` / `forbiddenBehavior` / `evidenceSource` / `validationExpectation` **逐字引用该原则 artifact 的 `intentContract`**；**新增** `eligibleOpportunity`（判定规则）+ `previousBehavior`（B0 时间窗 + 失败模式 + 频次）+ `observationWindows`（A1/A2）。
- **对齐 v3**：这正是 v3 §Behavior Signature 里"新增 Eligible Opportunity / Previous Behavior"两项，也是 ledger `totalOpportunities`（当前 0/23）**在实验层面的替代口径**——无需回填 schema。

### M3 — 暴露与行为的只读读模型（读模型，泛化既有范式）

- **做法**：复用 `collectRuleCodeEventEntries()`（`:193-219`）读 `.state/logs/events_*.jsonl`，把 `readRuleCodeTelemetry` 的窗口聚合格式（`:221-247`）套到两类事件：
  - `runtime_v2_prompt_activations_injected`（按 `data.activationIds.includes(activationId)` 过滤）→ **exposure.json**
  - `tool_call`（按 `data.runId` 关联到该 activation 的暴露 runId）→ **behavior-before/after 的动作序列**
- **契约**：沿用既有 `status: ok|degraded` + `reason` + `nextAction` + coverage 披露（`ReceiptsConsoleModel` 范式），**不新造降级语义**。
- **不做会怎样**：数据齐但无人产出证据。

### M4 — Evidence Bundle 只读装配器 + Outcome 口径

- **做法**：一个只读导出，产出 §Evidence Bundle 的 11 个 `*.json`；
  outcome 口径明确取自：`v_daily_metrics`（failures / user_corrections 趋势）+ 目标类错误筛选 + Owner 裁定；
  **`task_outcomes` 仅作 Opportunity 分母，不映射进 outcome.json**（v3 已禁止）。
- **对齐 v3**：满足 §Evidence Bundle 与 §PRI-836 Scope 的"Evidence Bundle 组装"。

### M5 — 实验级 Owner 裁定记录（决策面扩展，非新表）

- **问题**：现有 `activation_decisions` 只覆盖**激活级**操作（promote / deactivate / safety_isolate…），**没有实验级 `Keep / Revise / Revoke / Continue Observation`**。
- **最小做法**：把实验裁定写进实验目录的 `owner-decision.json`（引用 `activation_id` + 实验声明 + bundle digest），**不加表**；如需持久化，优先复用 `activation_evidence_snapshots` 的"一次快照一 artifact"既有形状而非新建表。
- **对齐 v3**：满足 §Owner Governance Decision。

### 附带（不算独立项，写进实验设计即可）

- **实验选型**：优先选 **code_tool_hook 通道**的原则（有 Level 3 机器证据），或对 prompt 通道**明确采用 Owner/evaluator 裁定**作为行为证据来源——v3 对此沉默，必须在实验声明里写死（G5）。
- **切分轴**：B0/A1/A2 按 `created_at` 时间窗或 `runId` 切，**不得按 session 切**（G4）。
- **主键**：bundle 血缘以 `activation_id` 为锚，`principle_id` 仅作展示（G6）。

---

## Final Verdict

### Can PRI-836 proceed?

```
READY AFTER MINIMAL PREPARATION
```

**不是 READY**：`effect 回执 → activation` 仍然断开（93/93 NULL，`JOIN = 0`），
且 `Eligible Opportunity` + `Previous Behavior` + 11 个 bundle artifact 均无载体与消费者——
v3 §Experiment Result 的 PASS 判定今天无法完整落笔。

**不是 NOT READY**：本次审计已用**现有表实际重建了 PRI-768 的 Before 与 After**，
并确认 v3 最难的一项（机会分母 + 命中计数 + 窗口 + 代表性样本）**已在生产代码中实现**，
只是当前只服务 `rulehost_evaluated` 一类事件。

### 最小准备项（5 项，全部不新造系统）

| # | 项 | 类型 | 体量 |
|---|---|---|---|
| **M1** | effect 回执传 `activationId`（`gate.ts:187/357/685`） | 参数漏传修复 | ~1 行 ×3 + 1 测试 |
| **M2** | 实验级 Behavior Signature 声明（复用 intentContract + 新增 Eligible Opportunity / Previous Behavior） | 声明文件 | 1 个 JSON |
| **M3** | 暴露与行为的只读读模型（泛化 `readRuleCodeTelemetry` 的事件类型） | 读模型 | 1 个只读模块 |
| **M4** | Evidence Bundle 只读装配器 + outcome 口径（`task_outcomes` 只作分母） | 装配 + 口径 | 1 个只读导出 |
| **M5** | 实验级 Owner 裁定记录（Keep/Revise/Revoke/Continue Observation） | 决策面扩展 | 1 个 artifact（优先复用快照形状） |

### 必须同时写进实验设计的三条约束

1. **通道选择**：优先 code_tool_hook；prompt 通道必须显式采用人工/评估器裁定作为行为证据（G5）。
2. **切分轴**：按时间窗 / `runId`，不按 session（G4）。
3. **主键**：以 `activation_id` 为锚（G6）；**禁止消费** `v_principle_effectiveness` 与 ledger metrics（G7）。

### 一句话结论

> **PD 当前的问题不是"缺少新的智能模块"，而是"已有能力没有形成证据链"。**
>
> 本次审计最强的证据是：v3 要求的行为证据读模型范式
> （`collectRuleCodeEventEntries` + 按 activation 聚合 + 24h/7d 窗口 + eligible/matched/blocked + representative samples + coverage 降级契约）
> **已经存在于 `ActivationsConsoleModel.ts:193-247` 并在 Console 上渲染**。
>
> PRI-836 的实现工作量，本质上等于**把这条既有读模型从 RuleCode 通道泛化到 prompt 通道，并补一个实验声明与一个只读装配器**。

---

*End of Implementation Reality Map.*
