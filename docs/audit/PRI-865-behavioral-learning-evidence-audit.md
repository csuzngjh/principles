# PRI-865 Behavioral Learning Evidence Audit

> 只读审计。未修改任何代码、schema、配置、feature flag；未创建 PR / Linear 工单。
> 唯一产物：本文档。

## Executive Summary

**核心问题的直接回答：不能。PD 当前无法证明一次 Principle Activation 带来了 Behavioral Change。**

三个层次的区分（本审计的判据）：

| 层次 | 状态 | 结论 |
|---|---|---|
| **Capability Exists**（能否采集行为原始数据） | ✅ 大部分存在 | receipts / corrections / outcomes / activations 表和写入路径已建成 |
| **Evidence Exists**（是否真的产生了行为证据） | ❌ 本机运行时几乎为空 | activations=0、principle_applications=0、correction_samples=0、task_outcomes=0 |
| **Measurement Exists**（能否算出 before/after 行为差值） | ❌ 不存在 | 无任何消费者做激活前后对比；"effectiveness" 视图只数事件类型 |

关键区分：PD 闭环目前**收在"规则/产物质量"上，而不是收在"未来行为改变"上**。
Evaluator 评的是 *Rule 是否忠实表达 Principle*（静态、激活前），rollout-reviewer 评的仍是 *evaluator 产物*，没有任何代码路径度量"激活后 Agent 行为是否改变"。

这与 PRI-750（2026-09-13）结论一致并被其强化：**缺口是"连接 + 判断"，不是"能力"；且新增证据表明判断层（before/after delta）根本未被计算，运行时数据也未产生。**

`PRI_865_RESULT = MEASUREMENT_GAP_ONLY`

---

## Baseline

```
BASE_SHA (local main)   = 47946c16cf6dbf88234c03b1038c401aea4fde86
origin/main (fetched)   = 9fe17fcd83eb654b2277a769100a2e1e6b6cfd16   ← 本审计绑定此 SHA
branch                  = main
local main 落后 origin  = 23 commits
```

- 23 个领先 commit 中，仅 6 个核心学习链路源文件发生变化，全部在
  `packages/principles-core/src/runtime-v2/internalization/`（PRI-858 owner-decision-review、PRI-859 artificer contextHash、PRI-862 dreamer sourcePainId 溯源守卫）。
  这些改动**加强的是"形成期(provenance/lineage)"证据，不是"激活后行为度量"**。
  经 `git show origin/main:` 逐一核对：`owner-decision-review.ts` / `formation-context.ts` 只新增
  `intent contract forbiddenBehavior`、`diagnosis block` 等**形成上下文**字段，无 activated_at / before-after / effect 相关逻辑。
- 其余为 installer / update-chain / console（PRI-847~854），与本审计无关。
- 因此：学习链路的 **schema / store / activation / outcome 子系统在 local 与 origin/main 之间未变**，工作树探索结论对 origin/main 成立。
- Installed runtime（只读查询）：`~/.pd/`（install.json 存在），运行时 DB 见"Behavior Measurement"节。

---

## Current Learning Loop

真实链路（逐阶段，均含 file:line 证据）：

| Stage | Source | Storage | Consumer | Evidence(是否真产生/真读取) |
|---|---|---|---|---|
| **Pain** | `host-runtime/src/production-pain-evidence.ts:418`、`governance-signal-admission.ts:703` | `trajectory.db.pain_events(canonical_pain_id, runtime_task_id, created_at)` @ `core:trajectory-schema.ts:91` | `core:store/trajectory/sqlite-source-trace-locator.ts:109` | 写入✅；本机仅 3 行(`~/.openclaw/trajectory.db`) |
| **Diagnosis** | `core:pain-signal-bridge.ts:729` | `pain_diagnoses(pain_id, task_id, diagnosis_id, root_cause, artifact_id)` @ `sqlite-connection.ts:678` | `getDiagnosesByPainId` **仅测试调用**，无生产消费者 | 表存在；读取链路未接入生产 |
| **Principle Candidate** | `core:candidate-intake.ts` | `principle_candidates(candidate_id, artifact_id, task_id, source_run_id)` @ `sqlite-connection.ts:350` — **无 pain_id 列** | `core:pain-chain-read-model.ts:134` | ✅ |
| **Approval** | `core:activation/activation-dispatcher.ts:313` | `approvals(approval_id, artifact_id, channel, status, decided_at)` @ `sqlite-connection.ts:395` — **无 candidate/pain/principle_id 列** | `pd-console/.../PrincipleTrajectoryModel.ts:269` 经 artifact 连接 | 表存在；本机 0 行 |
| **Activation** | `activation-dispatcher.ts:380`（先 `approval-completion-service.ts:155`） | `activations(activation_id, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at)` @ `sqlite-connection.ts:439` — **无 principle_id/approval_id 列** | `host-runtime/src/production-rulehost-gate.ts:209`、Console `:282` | 记录+时间戳✅；本机 0 行 |
| **Runtime Injection** | `openclaw-plugin/src/hooks/prompt.ts:782` "Owner-Approved Behavior Directives (Runtime V2 activated principles)" | presence receipt `kind='prompt_injected'` @ `prompt.ts:725` | 自身即终端消费者 | 注入✅，写 presence receipt |
| **Future Execution** | `hooks/gate.ts` | `principle_applications(level∈{effect,presence}, kind∈{rule_blocked,auto_correct_applied,self_reported,prompt_injected}, session_id, created_at)` @ `sqlite-connection.ts:463` | `principles-stats.ts:301`、`ReceiptsConsoleModel.ts:187`（**仅做窗口内 presence/effect 计数**） | effect 写入存在(gate.ts:191,361,689)；本机 0 行 |
| **Outcome** | —— | `task_outcomes(principle_ids_json)` @ `trajectory-schema.ts:95`、`correction_samples` @ `:96` | **无任何生产读取/聚合** | 空表；无 join 到 activated_at |

**链路形状**：Pain→…→Injection→Receipt 的**采集管段存在**，但 Receipt/Outcome 到"行为改变结论"之间的**度量与判断段完全断开**。

---

## Pain-Principle Traceability

`pain_id → principle_candidate_id → principle_id → activation`：

**Traceability: PARTIAL（间接、单向、靠字符串约定，且非端到端可重建）**

Evidence:
- `sourcePainId` **不是列**，只存在于 `tasks.diagnostic_json` JSON blob（`store/task/sqlite-task-store.ts:66`，写入 `intake-to-internalization-bridge.ts:248,323`，读取 `sqlite-context-assembler.ts:112`）。`traceByPainId` 靠字符串约定 `diagnosis_${painId}` 反查（`pain-signal-bridge.ts:222`）。
- `principle_candidates` **无 pain_id 列**；candidate→principle 经一个 **JSON ledger 文件**，且字段 `derivedFromPainIds` 实际存的是 **candidate ID**（`adapter/principle-tree-ledger-adapter.ts:40,79,108`；`owner-decision-view.ts:471` 印证）——命名与语义不符。
- principle→activation 需经 `pi_artifacts.source_principle_id` join（`sqlite-connection.ts:382`；`PrincipleTrajectoryModel.ts:284`）。该字段仅对 rule artifact 由 `evaluator-runner.ts:3222` 设置；scribe 'principle' artifact **从不设置**（`scribe-runner.ts:410`），绑定依赖 pd-cli backfill（`rulehost-pipeline-runner.ts:1086`）。
- `ArtifactLineageRecord.sourcePainIds`（`types/artifact-lineage.ts:15`）**已退役**：数据源抛 `LineageSourceRetiredError`（`pd-console/.../ConsoleLifecycleDatasource.ts:82`）。
- `listLineage`（`sqlite-pi-artifact-store.ts:124`）**无生产调用者** → 父链从不被真正遍历重建。

结论：**单跳可追，全链不可自动重建**。PRI-862 刚加固的正是 dreamer `sourcePainId` 溯源（形成期），但没有把 pain→principle 变成一条可查询的关系。

---

## Activation Evidence

1. **activation 是否可追踪？** 部分可。`activations` 表存在且持久化，但 **无 principle_id / approval_id 外键**（仅 `artifact_id`），必须经 `pi_artifacts.source_principle_id` 间接 join 才知道"哪个原则"。
2. **activation 时间是否存在？** ✅ 是。`activated_at / promoted_at / deactivated_at` 持久化且被 gate 强制执行（`production-rulehost-gate.ts:217`）；owner 决策 append-only（`activation_decisions`，`sqlite-connection.ts:502`）。
3. **activation 前后是否可比较？** **结构上部分可行、实践上未实现**。
   - `principle_applications(principle_id, created_at)` 有 `idx_pa_principle_time`（`sqlite-connection.ts:479`），理论上可取某原则 activated_at 前后的 receipt 分布。
   - 但：effect receipt 在激活前**逻辑上不可能存在**（规则未 live），该表天然给不出"before"基线；且 `activation_id` 列在 6 个写入点中 5 个为 NULL、**无任何读取查询**（死列，`docs/audit/pri-807-phase0/LINEAGE_CHAIN.md:207`）。
   - **没有任何生产代码执行 activated_at 前/后的对比。**

---

## Behavior Measurement

| Metric | Exists | Source | 实际度量的是 |
|---|---|---|---|
| Before/After comparison | ❌ | 无消费者；`trajectory-turn-reader.ts` 仅供 Diagnostician 上下文，无 delta 计算 | —— |
| Repeat-mistake reduction | ❌ | `lifecycle-read-model.ts:97` 的 `repeatedErrorSignal = painIds.size + gateBlockIds.size` 是**来源(provenance)计数**，非激活后复犯；`v_error_clusters` 视图从不被查询 | 生命周期簿记 |
| Correction frequency | ⚠️ 数据在，无度量 | `correction_samples`（有 `principle_ids_json`+`created_at`）仅按 `review_status` 过滤，无 join 到 `activatedAt` | —— |
| Rule adherence | ❌ | `adherenceRate = coverage*0.7 + repeatedErrorReduction*0.3`（`lifecycle-metrics.ts:185`）；coverage 来自**离线 replay 分类**，非在线行为；schema 声明的 `adheredCount/violatedCount`（`types/principle-value-metrics.ts`）**无写入者** | 规则代码是否仍能命中历史用例（replay 代理） |
| Outcome quality | ❌ | `task_outcomes` 表存在但从不被查询；`store/task/task-types.ts` 与 activated 规则**无 link** | —— |

**关键证据 — "effectiveness" 是命名幻觉**：
```sql
-- core:trajectory-schema.ts:197
CREATE VIEW v_principle_effectiveness AS
  SELECT event_type, COUNT(*) AS total
  FROM principle_events GROUP BY event_type;
```
名为 effectiveness，实为**按类型数 principle 生命周期事件**，不 JOIN receipts、不含行为、不含 before/after。（PRI-750 G-1 至今未修。）`valueScore/adherenceRate/painPreventedCount` 在 ledger adapter 中**写死为字面量 0**（`principle-tree-ledger-adapter.ts:37`）。

**运行时数据实况（只读查询本机 4 个 DB）**：

| 表 | 最大行数 | 位置 |
|---|---|---|
| activations | 0 | 两个 state.db |
| principle_applications | 0 | 两个 state.db |
| approvals | 0 | 两个 state.db |
| correction_samples | 0 | trajectory.db |
| task_outcomes | 0 | trajectory.db |
| principle_events | 0 | trajectory.db |
| pain_events | 3 | `~/.openclaw/trajectory.db` |
| sessions | 60 | `.state/trajectory.db` |

即便采集管段接线完整，**本机根本没有产出行为证据数据**（effect receipts 恒为 0，与 `docs/audit/graduation-day0...` 记录的 39/39 全 presence 一致：presence 有、effect 无）。Measurement 在数据层同样不成立。

---

## Counterfactual Capability

**Counterfactual Capability: MISSING**

全仓 `grep -i counterfactual` → **0 命中**。被误当作反事实机制的东西都另有含义：

- `repair-replay-resolver.ts` — "replay" = 重读**同一** evaluator artifact 的 `adversarialResult` 喂给修复 prompt，非一次运行。
- `golden-trace-replay-validator.ts` — replay = 对合成 `{toolName, params, expectedDecision}` 用例跑生成代码的单测；无 Agent 轨迹、无"没有规则会怎样"。
- `activation/rulecode-shadow-summary.ts:32` — shadow = 线上流量**评估但不强制**（`wouldBlock/wouldAllow`）。**最接近反事实**，但只测"规则会不会触发"，从不测"底层错误是否仍发生"；`neutralControl` 指"规则未命中"，不是对照臂。
- A/B / holdout / control group 仅出现在**文档**（PRI-815 prompt 质量、手工 `r2b-gentest-ctrl`），未产品化。
- rollback/deactivate 是生命周期状态翻转，无 before/after diff。

---

## Evaluator Capability

**Evaluator Scope: A — Rule quality only（静态、激活前）**

`evaluator-prompt-builder.ts` 权威指令：
- `:159` "critically review the Artificer's **implementation plan**"
- `:184` "Evaluate the plan against … completeness, feasibility, test coverage, risk mitigation"

产出维度（`evaluator-output.ts:196`）全部关于产物：
- `intentConsistency`（:192）——代码逻辑是否匹配 scribe 原则文本意图；
- `scopePrecision`（:198）——匹配条件宽窄/误报；
- `traceCoverage`（:199）——goldenTraceCases 覆盖度；
- `adversarialCases`（:203）——合成输入，在 sandbox 跑（`evaluator-runner.ts:2434`）。

PRI-843 补录（`evaluator-prompt-builder.ts:264`）确有一句"该 Principle 是否真的解决 `sourceDiagnosis` 描述的 pain"——但 `:265` **明令该项不得影响 score/decision**，仅作为给 Owner 的 `[principle_pain_mismatch]` concern。所以连这唯一一句行为向的问询也被路由成静态证据保真度检查。

`rollout-reviewer` 也**不**评部署后行为：输入仅 `evaluatorArtifact`/`scribeArtifact`（`rollout-reviewer-prompt-builder.ts:180`），`safetyChecks` 是散文式"部署后监控 24h 错误率"（`:63`），非度量。

→ **闭环收在规则/产物质量，不收在未来行为。** 这就是 PD 距离"原则改变 Agent 下一次行为"的核心距离。

---

## Evidence Gaps

| Finding | Evidence | Severity | Category |
|---|---|---|---|
| 无 before/after 行为 delta 的任何消费者 | lifecycle-metrics/read-model 全为生命周期+离线 replay；`trajectory-turn-reader.ts` 无度量消费者 | BLOCKER | **A VERIFIED GAP** |
| `v_principle_effectiveness` 名不副实，不 JOIN receipts | `trajectory-schema.ts:197` | HIGH | **A VERIFIED GAP** |
| Evaluator 只评规则质量，行为向问询被禁止计分 | `evaluator-prompt-builder.ts:184,264-267` | HIGH | **B DESIGN CHOICE**（MVP 阶段刻意收在规则质量）|
| effect receipt 无 pre-activation 基线、无 opportunity 分母 | `principle_applications` 结构 + `principles-stats.ts:301` 仅窗口计数 | HIGH | **A VERIFIED GAP** |
| pain→principle→activation 全链不可自动重建（单向/JSON blob/死列） | `sourcePainId` 在 JSON；`derivedFromPainIds` 名实不符；`activation_id` 5/6 NULL 无读取；`listLineage` 无调用者 | MEDIUM | **A VERIFIED GAP** |
| `activation_id` / adherence / valueScore 等 schema 已声明但无写入者 | `principle-value-metrics.ts`、`principle-tree-ledger-adapter.ts:37` 写死 0 | MEDIUM | **A VERIFIED GAP** |
| 本机运行时行为数据为 0（activations/receipts/corrections/outcomes 全空） | 4 个 DB 只读查询 | HIGH | **D UNKNOWN**（单开发机，非代表性生产流量；需 Owner 确认是否有真实生产部署） |
| Counterfactual 机制缺失，shadow 仅测触发不测错误复现 | `rulecode-shadow-summary.ts:32` | MEDIUM | **B DESIGN CHOICE / C LOW VALUE**（反事实是 post-MVP 概念，MVP 未必需要真 A/B） |
| 跨库物理隔离 state.db vs trajectory.db，仅 session_id 字符串关联 | PRI-750 G-2 | MEDIUM | **A VERIFIED GAP** |

---

## Recommendation

**不新增** memory system / 数据库 / agent / 评估框架（遵守 Phase 9）。缺口是"连接 + 判断 + 真实数据"，最小路径复用现有权威：

1. **让 effectiveness 视图真起来（Connect，最高价值）**：新增/改写一个读模型，把 `v_principle_effectiveness` 从"数 principle_events 类型"改为**以 `activations.activated_at` 为分界**、JOIN `principle_applications`(effect) 与 `correction_samples` 的 per-principle before/after 聚合。全部数据源现有，缺的只是这条 JOIN 与消费者。
2. **补 effect receipt 的基线与分母（Improve）**：receipt 已有 `principle_id/session_id/created_at/level`；只需在激活时记录一个"该原则历史 pain 复现基线率"，即可给出 before。避免新库。
3. **把已声明字段接上写入者（Connect）**：`valueScore/adherenceRate/painPreventedCount` 目前写死 0、`activation_id` 多数 NULL 无读取——要么由 #1 的聚合真正填值，要么按 P4/清理删除以免误导 Owner（命名幻觉本身是风险）。
4. **pain→principle 至少一跳可查（Connect）**：给 `principle_candidates` 加一个真正被写的 `source_pain_id` 关系（PRI-862 已加固上游溯源，此处顺势落地），替代 JSON 字符串约定。
5. **先取真实生产数据再定 SPEC（D→事实）**：本机行为数据为 0；SPEC 前应由 Owner 确认是否存在产生 effect receipts 的真实部署，否则 #1/#2 无米下锅。

Counterfactual（真 A/B / shadow 测复现率）应作为 **post-MVP 候选**记录，不进当前范围。

---

## Final Result

```
PRI_865_RESULT = MEASUREMENT_GAP_ONLY
```

能力（采集）大体存在、设计选择在规则质量处收口，真正缺的是"把现有 receipts/corrections/outcomes 连成 before/after 行为度量"这一段，且本机未见真实行为证据数据产生。未发现需要新建子系统，未发现产品边界问题。

---

## Required Final Summary

- **Learning Loop Status:** 采集管段(Pain→…→Injection→Receipt)已接线；度量/判断段(Receipt→行为改变结论)断开。链路"能跑不能证"。
- **Pain→Principle Trace:** PARTIAL — 单跳可追、靠 JSON blob 与字符串约定，全链不可自动重建；`sourcePainId`/`derivedFromPainIds`/`activation_id` 存在名实不符或死列。
- **Activation Evidence:** 有 activation 记录与 `activated_at` 时间戳✅；但"哪个原则"须经 artifact 间接 join，且无代码做激活前后比较。
- **Behavior Change Measurement:** MISSING — 无任何消费者计算 before/after；`adherenceRate`/`repeatedErrorReduction` 是生命周期+离线 replay 代理，非在线行为；`v_principle_effectiveness` 只数事件类型；本机行为数据表全空。
- **Counterfactual Capability:** MISSING — 无 replay/baseline/A/B/shadow 对照能测"无此规则是否复犯"；shadow 只测规则触发。
- **Biggest Gap:** 判断层缺位——PD 有原始素材(principle_applications.effect、correction_samples、task_outcomes、activations.activated_at)却从不 JOIN 成"激活前后行为差值"；闭环停在规则质量(Evaluator Scope A)，未收到未来行为。
- **Recommendation:** `MEASUREMENT_GAP_ONLY`。以 1 条 Connect 为主的读模型(activated_at 分界的 per-principle before/after 聚合)+ 接上已声明字段的写入者 + 先取得真实生产 effect 数据；不新建 memory/DB/agent/评估框架；反事实留作 post-MVP 候选。
