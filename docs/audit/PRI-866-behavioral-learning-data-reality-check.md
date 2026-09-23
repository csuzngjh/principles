# PRI-866 Behavioral Learning Data Reality Check

> 只读现实核查。未修改任何代码 / schema / 数据库 / 配置 / feature flag；未创建 PR / Linear 工单。
> 唯一产物：本文档。
> 本审计**推翻 PRI-865 的关键 UNKNOWN**：PRI-865 只查到两个近乎空的小库，得出"本机行为数据为 0"。
> 实际存在一个真实 dogfood 工作区（`D:\.openclaw\workspace`，state.db 9MB / trajectory.db 18MB），内含完整前段学习链数据。

## Executive Summary

**Q1（是否存在至少一条完整链路？）：PARTIAL —— 链路一直通到"运行时效果回执"，但断在最后一环"结果(Outcome)"。**
找到一条真实、可重建的端到端案例（一条 code_tool_hook 规则）：
`pain → 201 tasks → 143 artifacts → 6 approvals → 12 activations(带时间戳) → shadow 观测 340 → live → rule_blocked 效果回执`。
但 `task_outcomes = 0`、`correction_samples.principle_ids_json = []`，即"结果反馈"这一终节点**没有任何数据**。

**Q2（能否计算 Activation Before vs After 行为差？）：NO（行为层）。**
- 时间戳齐备（`activated_at` + `created_at` + `idx_pa_principle_time`），**结构上可按激活时刻分桶**；
- 但**算不出行为差**，因为：effect 回执 `activation_id` 全部为 NULL（70/70，与 activations 的 JOIN 结果 = 0）；无错误/pain 签名聚类可判定"同一错误是否复犯"；effect 回执中 69/70 是 `self_reported`（Agent 自称遵守，非独立度量），真正机器强制的 `rule_blocked` 全程只有 **1 条**。

**真实生产 effect 数据是否存在？YES —— 但有效行为结果数据近乎为零。**
存在 presence(737)+effect(70) 回执与 1 份 shadow 快照；但独立、可归因于 activation 的行为结果证据缺失。

**结论性质：混合缺口，主因是"判断 + 结果节点的数据/连接"，而非"前段采集能力"。**
前段数据充足；缺的是激活后**行为结果**证据的采集与关联，以及据此的 before/after 计算。

`PRI_866_RESULT = DOGFOOD_DATA_REQUIRED`

---

## Baseline

```
BASE_SHA (local main)  = 47946c16cf6dbf88234c03b1038c401aea4fde86
origin/main            = 9fe17fcd83eb654b2277a769100a2e1e6b6cfd16   ← 绑定此 SHA
branch                 = main
installed productVer   = 1.76.1  (releaseId 48ef51db…, sourceCommit 7ab348ea)
layoutMode             = canonical, hosts=[openclaw]
workspaces             = D:\.openclaw\workspace  |  C:\Users\Administrator\.openclaw\workspace
environment            = win32 单开发者机 (Administrator)，dogfood 用途
```
运行时数据查询均为只读（`sqlite3` SELECT / `.schema` / PRAGMA）。

---

## Runtime Data Inventory

禁止假设路径 —— 穷举后实际存在数据的学习链 DB（>4KB 且有相关表）：

| Database | Exists | Size | Relevant Tables(行数) |
|---|---|---|---|
| `D:\.openclaw\workspace\.pd\state.db` | ✅ | 9.4 MB | **真实主库**：principle_applications=807, activations=12, approvals=6, principle_candidates=67, pi_artifacts=508, tasks=718, activation_evidence_snapshots=1 |
| `D:\.openclaw\workspace\.state\trajectory.db` | ✅ | 18.2 MB | pain_events=28, principle_events=127, correction_samples=3, **task_outcomes=0**, sessions=694, tool_calls=11767 |
| `D:\.openclaw\workspace\e2e\.pd\state.db` / `.state/trajectory.db` | ✅ | 450KB/1.2MB | e2e 测试数据，非真实使用 |
| `C:\Users\Administrator\.openclaw\workspace\.pd\state.db` | ✅ | 372KB | **全空**(activations=0/receipts=0) — PRI-865 误查此库 |
| `C:\Users\Administrator\.openclaw\trajectory.db` | ✅ | 32KB | pain_events=3 — PRI-865 误查此库 |
| `AppData\Local\hermes\state.db` + `state-snapshots/…pre-update\state.db` | ✅ | 20.8MB×2 | 旧代际(pre-1.74)快照，非当前 dogfood |
| `D:\.openclaw\pd-reset-backups/`, `pd-retirement-backup-2026-08-19/` | ✅ | 多个 | 备份/重置历史，只作旁证 |

**PRI-865 修正**：其"activations/receipts/corrections/outcomes 全空"结论源于查了空的小 workspace 库；真实 dogfood 主库 `D:\.openclaw\workspace` 有充足前段数据。

---

## Learning Loop Trace

各阶段真实数据量与关联状态（主库 `D:\.openclaw\workspace`）：

| Stage | Table | Count | 关联/时间戳真实性 |
|---|---|---|---|
| Pain | `trajectory.pain_events` | 28 | 有 created_at；origin=user_manual(17)/user_correction(9)/tool_failure(1)/empathy(1)；**canonical_pain_id UNIQUE(去重)→无同类复犯签名列** |
| Diagnosis | `pain_diagnoses` | **1** | 仅 1 条，读取链路无生产消费者(PRI-865) |
| Candidate | `principle_candidates` | 67 | 有 consumed_at(最早 2026-09-01)；**无 pain_id 列**，经 task_id `diag_router-diagnosis_…` 约定回连 |
| Approval | `approvals` | 6 | 有 decided_at/status(approved·rejected·pending)；**无 principle/candidate 列**，靠 artifact_id |
| Activation | `activations` | 12 | **activated_at / deactivated_at 真实**(09-01→09-18)；含 1 对 shadow_activate→live_activate |
| Runtime App | `principle_applications` | 807 | presence/prompt_injected=737(**全部带 activation_id**)；effect=70 |
| Effect Receipt | 同上 level=effect | 70 | self_reported=69、**rule_blocked=1**；**activation_id 全 NULL** |
| Outcome | `task_outcomes` | **0** | 表存在但**完全为空**，principle_ids_json 无数据 |

---

## Complete Case Search

不统计，找一条：

```
Case ID:   code_tool_hook 规则 (pain host_cffdcb9f5d02…faf0c2f1)
Pain:      pain_events 命中 1 条 (canonical LIKE %cffdcb9f%)
           ↓ 该 pain id 以【字符串】嵌入下游每一个 id
Principle: 201 个 tasks(diagnostic_json) + 143 个 pi_artifacts 含该 pain 引用
           candidate/artifact 链存在（scribe→evaluator artifacts）
Activation:approvals: apr_code_tool_hook_…evaluator-r1-mu3ayqqa = approved @ 2026-09-15T23:31:11
           activations: act_code_rule-…mu3ayqqa  code_tool_hook_live_activate @ 09-15T23:31:11 → deact 09-17T07:54
           (其前 09-15T17:51 有 shadow_activate)
Runtime App:principle_applications: principle_id=2d23707d-11a3-… level=effect kind=rule_blocked @ 2026-09-17T07:47:22
Shadow证据:activation_evidence_snapshots(1 行): shadow_summary {observed:340, matched:3, wouldBlock:3, wouldAllow:337}
Outcome:    【断裂】task_outcomes=0；correction_samples.principle_ids_json=[]
```

判定：**存在一条 Pain→…→Activation→Effect Receipt→(Shadow Baseline) 的真实完整链，
唯一缺失的是终末"Outcome(行为结果判定)"节点。** 且链的"连接"靠 pain-id 字符串嵌入 + `source_principle_id`，非 FK。

---

## Before After Feasibility

**Before/After Feasible: NO（行为层） / 部分（规则触发层）**

Reason：
- **可分桶**：`activations.activated_at` + `principle_applications.created_at` 有索引，日历上可做 before/after 粗计（如该规则 live 09-15T23:31 前后 pain：before=20 / after=8）。
- **但不能当作行为差**：
  1. effect 回执 `activation_id` 70/70 为 NULL，`JOIN activations` 结果 = 0 → 无法把某条 effect 归因到某次 activation。
  2. effect 回执逻辑上不可能有"before"（规则激活前不 live）→ 该表结构上给不出 before 基线。
  3. 无同类错误的**签名聚类**（canonical_pain_id 去重、无 category/error-signature），无法回答"该规则针对的那类 pain 在激活后是否更少发生"。
  4. 独立行为信号稀缺：`rule_blocked` 全程 1 条；`self_reported`(69) 是 **Agent 自称遵守**(`principle-application-ledger.ts:190,262`，每 principle×session 一条)，非客观度量。
- **唯一近似 before**：shadow 快照(observed=340 / wouldBlock=3) 给出"若强制会拦 3 次"——但只测**规则触发**，不测**底层行为/错误**，且仅 1 条规则。

→ 即使有真实 activation 与真实 effect 回执，当前数据**不足以构建可信的 before/after 行为差**。

---

## Metric Reality Check

禁止以名推断义，逐一查真实产出：

| Metric | Source | Real Data? | Actually Measures |
|---|---|---|---|
| `v_principle_effectiveness` | `trajectory-schema.ts:197` | 本机实际输出 = `{pain_detected:101, pain_recorded:26}` | **按 event_type 数 pain 生命周期事件**。与"原则是否有效/行为是否改变"零相关。命名幻觉。 |
| `adherenceRate` | `lifecycle-metrics.ts:185` | ❌ 无行为数据支撑 | `coverage*0.7 + repeatedErrorReduction*0.3`，coverage 来自**离线 replay 分类**，非在线遵守 |
| `repeatedErrorReduction` | `lifecycle-metrics.ts:180` | ❌ | `100 − (painIds.size+gateBlockIds.size)*10 − …`，repeatedErrorSignal 是**来源计数(provenance)**，非激活后复犯下降 |
| `painPreventedCount` | ledger adapter | ❌ | 写死字面量 `0`(`principle-tree-ledger-adapter.ts:37`) |
| `valueScore` | ledger adapter | ❌ | 写死字面量 `0` |
| `activation_evidence_snapshots.shadow_summary` | 该表(1 行) | ✅ 真实(observed=340/wouldBlock=3) | **规则在真实流量上的"会拦截"计数** — 全系统唯一带 before 语义的行为邻接证据，但仅测触发、仅 1 条规则 |

**判据**：所有被冠以"effectiveness/adherence/value"之名的指标，其真实数据**都不来自** receipts/outcome/pain 的行为比较；唯一含真实线上行为数字的是 shadow 快照，且它测的是规则触发频率。

---

## Data Gaps

分类（可多选，主因标注）：

| Gap | 证据 | 类别 |
|---|---|---|
| Effect 回执未回填 `activation_id`（presence 已回填、effect 70/70 空） | `JOIN` 结果 0；presence null_act=0 vs effect null_act=69 | **B Connection gap** |
| Outcome 节点无数据（task_outcomes=0；correction_samples 未归因原则） | `.pd`/`.state` 查询 | **A Capability/Data gap（终节点采集未跑通）** |
| 缺同类错误签名聚类，无法测"复犯下降" | pain_events 仅 canonical UNIQUE，无 category | **A Capability gap** |
| 独立行为 effect 稀缺（rule_blocked=1；其余为 self_reported 自称） | 回执 level×kind 分布 | **D Environment gap（dogfood 流量小 + 强制规则少）** |
| before/after delta 无任何代码消费者 | PRI-865：lifecycle 全为离线 replay/生命周期 | **C Measurement gap** |
| `v_principle_effectiveness`/valueScore 命名与真实含义不符 | 实输出=事件计数 / 写死 0 | **C Measurement gap（含误导风险）** |

**主因**：前段采集**不缺**（807 回执、12 激活、shadow 基线为证）。缺的是激活后**行为结果**证据的采集与关联（Outcome 空、effect↔activation 未连、无复犯签名），以及据此的 before/after 计算。**是"数据+连接+判断"三重叠加，但入口在数据/连接。**

---

## Recommendation

不新建 memory / DB / agent / 评估框架（沿用 PRI-865 Phase 9 约束）。据现实核查结果：

**选 Option B —— 先补 Dogfood 行为结果数据采集，再进 SPEC。**

理由：Option A 要求"存在真实 activation + effect receipt **且** before/after 可计算"——前半满足，后半因连接/结果数据缺失**不满足**，故不能直接进 SPEC。Option C（数据位置未知）已被本次穷举否定。

进入 SPEC 前需先落地以下**最小数据采集**（全部复用现有表，无新增库）：
1. **回填 effect 回执的 `activation_id`**（presence 已证明该字段可写；让 effect 也能 JOIN 回 activation）——纯 Connection 修复。
2. **让 `task_outcomes.principle_ids_json` 真正写入**并关联 activated 原则（现 0 行）；把 `correction_samples.principle_ids_json` 的 `[]` 填上（现 3 条全空）。
3. **给 pain 增加可聚类签名**（category/error-cluster，供"复犯下降"比较）——否则 before/after 无从对齐同类行为。
4. 提升**独立行为信号密度**（鼓励 code_tool_hook 类强制规则的 live 激活，扩大 rule_blocked/verified 样本，减少对 self_reported 的依赖）。

完成 1–3 后，"per-principle 以 activated_at 分界的 before/after 行为聚合"即退化为纯 Connect/Measurement 工作，届时再进 Effectiveness Measurement SPEC（PRI-865 Recommendation #1）才成立。

Counterfactual（shadow wouldBlock 是好苗子，应纳入 before/after 对照臂的正式建模）列为该 SPEC 范围内，非独立新框架。

---

## Final Result

```
PRI_866_RESULT = DOGFOOD_DATA_REQUIRED
```

真实生产/使用数据**存在**（推翻 PRI-865 的 UNKNOWN），前段学习链充足且已找到一条通到效果回执的真实案例；
但支撑"原则改变下一次行为"度量的**行为结果数据 + 关联 + 计算**尚不具备，
须先补采集，再进 Effectiveness Measurement SPEC。

---

## Final Summary

- **Real Data Status:** 存在。真实 dogfood 主库 `D:\.openclaw\workspace`(state.db 9MB / trajectory.db 18MB)：activations=12、approvals=6、candidates=67、receipts=807、pain_events=28、tool_calls=11767。PRI-865 曾误查空库。
- **Complete Trace:** PARTIAL —— 找到 1 条真实端到端链(pain host_cffdcb9f→201 tasks→143 artifacts→approval→live activation→rule_blocked effect→shadow observed=340)，**断在 Outcome**（task_outcomes=0、correction 未归因）。链靠 pain-id 字符串嵌入而非 FK。
- **Activation Evidence:** 强。12 条真实 `activated_at`/`deactivated_at`，含 shadow→live 配对；但 activations 无 principle_id/approval_id FK，须经 artifact 间接 join。
- **Effect Receipt Evidence:** 存在但弱/未连。70 条 effect，其中 self_reported=69(Agent 自称、每 principle×session)、rule_blocked=1(唯一机器强制)；**activation_id 全 NULL，与 activations JOIN=0**，无法归因。presence=737 反已回填 activation_id。
- **Before/After Feasible:** NO。可按 activated_at 分桶但算不出行为差：effect 无 before 基线、无同类错误签名聚类、effect↔activation 未连、独立行为样本 n=1。shadow wouldBlock 是唯一 before 语义证据但仅测规则触发。
- **Biggest Blocker:** 行为"结果"节点的采集与关联缺失（Outcome 表空 + correction 未归因 + effect 无 activation_id + 无复犯签名），叠加"无 before/after 计算消费者"。非前段能力缺失。
- **Recommendation:** `DOGFOOD_DATA_REQUIRED`（Option B）。先做 4 项最小采集/连接（回填 effect.activation_id；写入 task_outcomes/correction 的原则关联；加 pain 聚类签名；扩大强制规则样本），再进 Effectiveness Measurement SPEC；不新建子系统，反事实以 shadow 为对照臂纳入该 SPEC。
