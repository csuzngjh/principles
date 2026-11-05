# WorkBuddy「自动纠正直写痛点」通道只读核算

日期：2026-11-05
范围：`~/.workbuddy/pd-workspace` 的 `trajectory.db` / `state.db`（只读副本）
方法：复制数据库到 `d:\Code\principles\.tmp\wb-audit-20261105\` 后用 `better-sqlite3` 以 `readonly: true` 查询；未运行安装器/宿主，未写入 Owner 工作区，未改动任何原库。

---

## 结论先行

**自动纠正通道在本工作区的历史实际产出：0 条。**

- 本工作区 `pain_events` 共 **3 行**，全部是 Owner 显式 `PD记录痛苦：` 前缀产生的痛，自动纠正产生的痛 **0 行**。
- 其中 1 行来自 `smoke-s7-session`（明显是 smoke 测试会话），真实 Owner 显式记录为 **2 行**。
- 这 3 行同时证明：`insertCorrectionPain` 这条写库路径在当前代码里是活的，**不能把「表里没有自动纠正的痛」等同于「代码不会产生」**。
- 但对 WorkBuddy 自动纠正在当前实现下，入口可达、写库不可达：WB 没有 `governance_observations` 写入方 → 自动信号的 ingress 证据恒为不可用 → 判定 `observation_only` → 写 `abandoned` marker → **不会执行 `insertCorrectionPain`**。
- 本工作区历史数据无法证明「全局从未产出」：只能证明这个工作区在这段时间内为 0，且自动通道连一次 admission marker 都没有留下。所以结论是「本工作区历史 0 条」，不是「从未产出」，也不是「数据不足」。

---

## A. 代码可达性

### A1. `insertCorrectionPain` 的定义与两个调用点

- 定义：[governance-signal-admission.ts:560](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L560-L573)
- 调用点 1（inline admission）：[governance-signal-admission.ts:1294](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L1294)
- 调用点 2（pending → admitted Stage 2 结算）：[governance-signal-admission.ts:1867](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L1867)

### A2. 四条会走到它的调用链

| 入口 | 调用链 | 是否写 Pain |
|---|---|---|
| Codex 自动纠正 | [codex-adapter/pd-hook.ts:194](file:///d:/Code/principles/packages/codex-adapter/src/pd-hook.ts#L194) → [ingestion/admission.ts:97](file:///d:/Code/principles/packages/codex-adapter/src/ingestion/admission.ts#L97) → `admitGovernanceSignals` → `admitOne` → `admitCorrection` → `insertCorrectionPain` | 可以（前提是 Codex ingestion 已持久化 observation 证据） |
| Codex 显式 Owner 语句 | [ingestion/explicit-owner-statement.ts:120](file:///d:/Code/principles/packages/codex-adapter/src/ingestion/explicit-owner-statement.ts#L120) → `admitGovernanceSignals` → … → `insertCorrectionPain` | 可以 |
| WorkBuddy 显式 `PD记录痛苦：` | [workbuddy-adapter/pd-hook.ts:286](file:///d:/Code/principles/packages/workbuddy-adapter/src/pd-hook.ts#L286) → [explicit-owner-statement.ts:34](file:///d:/Code/principles/packages/workbuddy-adapter/src/explicit-owner-statement.ts#L34) → `admitGovernanceSignals` → … → `insertCorrectionPain` | **可以**（DB 中 3 行即此链产物） |
| WorkBuddy 自动关键词 | [workbuddy-adapter/pd-hook.ts:313](file:///d:/Code/principles/packages/workbuddy-adapter/src/pd-hook.ts#L313) → [governance-signal-admission.ts:1994](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L1994) → internal :2031 → `admitOne` → `admitCorrection` | **不可以**：ingress 先判 `observation_only`，写 `abandoned` marker 后返回 |
| WorkBuddy pending 的 Stage 2 | [workbuddy-adapter/worker/workspace-worker.ts:275](file:///d:/Code/principles/packages/workbuddy-adapter/src/worker/workspace-worker.ts#L275) → `runStage2CorrectionCycle` → `settlePendingCorrection` → :1867 | **不可以**：结算前重新过 ingress，WB 自动信号同样 `observation_only` |

关键事实：`insertCorrectionPain` 是 `host-runtime` 私有函数，WorkBuddy adapter **没有直接 import 它**；adapter 引用的是它的两个公共入口 `admitGovernanceSignals` 与 `admitTrustedWorkbuddyLiveCorrection`。因此问题不是「有没有引用」，而是「公共入口在 WB 自动路径上会不会走到写库」。

### A3. 触发 `insertCorrectionPain` 的前置条件（逐条）

| # | 前置条件 | 代码位置 | 实际 WB 配置/数据下是否满足 |
|---|---|---|---|
| 1 | 宿主门：Codex，或 `workbuddy` + `explicitOwnerStatement`，或 `workbuddy` 的 trusted live 入口 | [governance-signal-admission.ts:1329](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L1329) | 显式：满足；自动：trusted 入口满足 |
| 2 | 没有已存在的 marker（否则走 duplicate/终态分支） | [governance-signal-admission.ts:1333](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L1333) | 首次满足 |
| 3 | 自动路径必须命中 `STRONG` + `high precision`；否则只落 pending、不写痛 | [governance-signal-admission.ts:1111](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L1111-L1115) | 需要真实触发词；历史未观察到 |
| 4 | 自动路径：`startsWith` 高精度词前缀预过滤，且 prompt ≤ 16KB | [governance-signal-admission.ts:1957](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L1957-L1963) | 代码满足，取决于真实输入 |
| 5 | 自动路径：原生当前用户事件（`UserPromptSubmit`、`is_internal_continuation=false`、有 `session_id`/`generation_id`/`prompt`） | [governance-signal-admission.ts:2001](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L2001-L2012) | 真实 hook 满足 |
| 6 | 双 flag：`host.workbuddy` + `workbuddy_live_keyword_pain` | [governance-signal-admission.ts:2016](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L2016) | 仓库默认 **OFF**；本机实际 config **两个都 ON** |
| 7 | **自动路径：ingress 必须有可用证据**；自动信号无证据 → `observation_only`，不写痛 | [pain-ingress.ts:189-209](file:///d:/Code/principles/packages/principles-core/src/runtime-v2/pain-ingress.ts#L189-L209)；证据来自 [governance_observations 查询:609](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L609-L620) | **不满足**：WB 无 `governance_observations` 写入方，查询恒为空 |
| 8 | 显式路径例外：`owner_manual` + bound，证据不可用只 `degrade` 不阻断 | [pain-ingress.ts:214-228](file:///d:/Code/principles/packages/principles-core/src/runtime-v2/pain-ingress.ts#L214-L228)；[显式 ingress:1140](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L1140-L1164) | 满足（DB 3 行证明） |
| 9 | canonical pain 未存在（否则 duplicate，不插新行） | [governance-signal-admission.ts:1280](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L1280-L1286) | 首次满足 |
| 10 | 限流：每 session 每 rule version 每小时 5 条 | [governance-signal-admission.ts:77](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L77)、[:1291](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L1291) | DB 中 `governance_correction_rate_limits` 3 行，未触顶 |

结论：WB 自动通道的**唯一结构性阻断点是第 7 条**。其余条件在当前配置下都能满足。

代码注释也明确写了这一点：[governance-signal-admission.ts:592-597](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L592-L597)（“WorkBuddy currently has no observation writer”），并由测试 [governance-signal-admission.workbuddy-live.test.ts:136-159](file:///d:/Code/principles/packages/host-runtime/tests/governance-signal-admission.workbuddy-live.test.ts#L136-L159) 固定为 `observation_only`、`painCount() === 0`。

---

## B. 历史数据事实

### B0. 实际执行的查询

数据库副本：

```text
trajectory.db  8,888,320 bytes  (源文件 LastWriteTime 2026-11-05 07:53:34)
state.db         753,664 bytes
```

以下为实际执行的核心 SQL（`better-sqlite3`，`readonly: true`）：

```sql
-- 1. 总行数与分类
SELECT COUNT(*) AS n FROM pain_events;
SELECT source, origin, host_kind, COUNT(*) AS n
FROM pain_events GROUP BY source, origin, host_kind;

-- 2. 自动 vs 显式（reason 是对 pain 行唯一可靠的来源标记）
SELECT CASE
  WHEN reason LIKE '%explicit owner statement%' THEN 'explicit_owner_statement'
  WHEN reason LIKE 'User correction detected%' THEN 'auto_user_correction'
  ELSE 'other' END AS bucket,
  COUNT(*) AS n
FROM pain_events GROUP BY bucket;

-- 3. admission 事实
SELECT host_kind, decision, COUNT(*) AS n
FROM governance_signal_admissions GROUP BY host_kind, decision;
SELECT id, host_kind, decision, rule_version, created_at,
       json_extract(task_payload_json,'$.correctionEvidence.channel') AS channel
FROM governance_signal_admissions ORDER BY id;

-- 4. WorkBuddy 观测表
SELECT COUNT(*) AS n FROM governance_observations;

-- 5. 关联任务/运行/候选
SELECT task_kind, status, COUNT(*) AS n FROM tasks GROUP BY task_kind, status;
SELECT execution_status, COUNT(*) AS n FROM runs GROUP BY execution_status;
SELECT status, recommendation_kind, COUNT(*) AS n
FROM principle_candidates GROUP BY status, recommendation_kind;
```

### B1. `pain_events` 原始结果片段

```json
[{"n": 3}]
```

按来源/原因字段分类：

```json
[
 {"source":"user_correction","origin":"system_infer","host_kind":"workbuddy","severity":"severe","score":70,"n":3}
]
[
 {"bucket":"explicit_owner_statement","n":3},
 {"bucket":"auto_user_correction","n":0},
 {"bucket":"other","n":0}
]
```

> 注意：`origin` 字段在显式语句上也被写成 `system_infer`（[insertCorrectionPain:571](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L571) 硬编码 `origin='system_infer'`），所以**不能靠 `origin` 区分自动/显式**。可靠判据是 `reason` + admission payload 的 `correctionEvidence.channel`。

### B2. 3 条 pain 的明细

| id | 时间（UTC） | host | reason | channel | canonical pain 已生成 | 关联诊断 task |
|---|---|---|---|---|---|---|
| 1 | 2026-10-17T08:27:15 | workbuddy | WorkBuddy explicit owner statement (PD记录痛苦 prefix) | workbuddy_explicit_prefix | 是 | `diagnosis_pain_host_01…` |
| 2 | 2026-10-17T08:28:19 | workbuddy | WorkBuddy explicit owner statement (PD记录痛苦 prefix) | workbuddy_explicit_prefix | 是 | `diagnosis_pain_host_cd…` |
| 3 | 2026-10-22T14:49:57 | workbuddy | WorkBuddy explicit owner statement (PD记录痛苦 prefix) | workbuddy_explicit_prefix | 是 | `diagnosis_pain_host_21…` |

**能判定为「自动纠正产生的痛」的行：0 条。** 不存在 `reason = "User correction detected…"` 或 `correctionEvidence.channel` 非显式的 pain 行。

### B3. `governance_signal_admissions`：3 行，且全是显式

```json
[{"host_kind":"workbuddy","decision":"admitted","n":3}]
```

- `abandoned` / `pending_llm_review` / `resolved_none`：**0 行**。
- `signal_kind`：全部 `user_correction`。
- `rule_version`：3 行全部为 `null`（显式语句跳过关键词检测，符合代码中 `detection` 缺失的语义）。
- 时间分布：全部 2026-10。

这条数据很重要：如果历史上 WB 自动关键词真的命中过 `strong`/`ambiguous`，这里至少会出现 `abandoned` 或 `pending_llm_review` marker。当前 0 行说明：**在本工作区已记录的期间，自动关键词路径连一次候选都没有进入 admission**。

### B4. `governance_observations` 实际行数

```json
[{"n": 0}]
```

按 host/kind 分组为空数组。与复核结论一致：WB 工作区没有任何持久化 observation。这是自动通道被 `observation_only` 挡住的直接原因。

### B5. 关联 task / run / candidate

```json
tasks: 32 行；其中 3 行 task_kind=diagnostician，对应上述 3 个 pain，全部 status=succeeded，创建于 2026-10-17 / 2026-10-22。
runs: 31 行，全部 execution_status=succeeded，全部 2026-10；上述 3 个诊断 task 对应 3 次 runtime_kind=openclaw 的 run。
pain_diagnoses: 0 行。
principle_candidates: 7 行（5 consumed + 2 pending），直接关联 diagnosis_pain_host_* 的 candidate：0 行。
artifacts: 4 行（diagnostician_output）；commits: 4 行。
dead_letter_pains: 0 行。
```

### B6. 时间分布（按月）

- `pain_events`：2026-10 = 3，2026-11 = 0。
- `governance_signal_admissions`：2026-10 = 3，2026-11 = 0。
- `sessions`：2026-10 = 29，2026-11 = 2。
- `runs`：2026-10 = 31，2026-11 = 0。

---

## C. 「表里没有」≠「代码不会产生」

分开说：

1. **代码会写痛**：`insertCorrectionPain` 是活的。WorkBuddy 显式路径的 3 行就是它写出来的；Codex 自动路径也走同一个函数。
2. **WB 自动通道在当前实现下写不了痛**：不是代码写错，而是 ingress 的证据门（第 7 条前置条件）结构性不满足。WB adapter 里没有任何 `governance_observations` 写入方，[`persistedBehaviorTraceEvidence`](file:///d:/Code/principles/packages/host-runtime/src/governance-signal-admission.ts#L599-L621) 的查询恒为空。
3. **历史 0 行有两种可能，数据只能证明合并结果**：
   - 自动关键词从未命中过任何一次真实 prompt（没有 marker）；
   - 或 hook 在这段时间没有真正执行到关键词分支（也没有 marker）。
   
   仅凭 DB 无法区分这两者，因为「未命中」和「跳过」都不落 admission 表。能确定的是：**没有一条自动纠正痛，也没有一次自动候选进入 admission**。

---

## D. 要做真实触发率测量还需要什么

当前系统的可观测性缺口：自动路径的 `not_a_signal`、`observation_only`、`rate_limited` 只写进 hook 的 `autoDiagnostics`（stdout 诊断），**不落持久化事件日志**（admitted/pending 才写 `workbuddy_keyword_*` event）。因此没有分母，算不出触发率。

最小测量方案（按依赖顺序）：

1. **加计数器（必须先做）**：在 WB `pd-hook` 的自动分支持久化至少 5 个事实：hook 被调用的次数、prompt 被扫描次数、`startsWith` 命中次数、`strong`/`ambiguous`/`none` 分布、ingress 最终 decision/reason。否则只有「产出 0」，没有「尝试 N 次」。
2. **确认 hook 真实注册并在跑**：核对 WorkBuddy 侧 `UserPromptSubmit` hook 配置指向当前 adapter；用一次带 `generation_id` 的真实当前用户消息验证。
3. **Owner 侧的真实输入**：需要 Owner 在真实会话中自然说出句首高精度纠正词（如 `这是错的`、`不要自作主张`、`不应该这么做`、`又搞错`），或明确授权做一次标注过的真实会话实验。合成测试只能证明代码分支，不构成触发率。
4. **证据策略的决定（关键前置）**：要么给 WB 建一个真实的 observation/证据写入方（新的耐久数据源，需要单独 SPEC 与 Complexity Delta），要么接受「WB 自动纠正永远不产生痛」，把这条路径明确降级/移除。
5. **隔离实验工作区**：测量必须在独立 workspace 或明确标记的测试会话中进行，不能污染 Owner 的 `~/.workbuddy/pd-workspace`。

---

## E. 建议

**这条路不值得继续投入，除非同时决定做 WorkBuddy 的持久化 observation/证据能力。**

理由：

- 当前实现下，WB 自动纠正的 Pain 产出是**设计上恒为 0**，不是偶发缺陷；继续在 admission/检测词表上加投入不会改变产出，因为阻断点在证据门，而不是检测灵敏度。
- 真实数据里双 flag 已开启、31 个会话（2026-10 至 2026-11）、0 条自动痛、0 条自动 admission marker，没有观察到任何「差一点就成功」的信号。
- 真正缺的能力是「WB 可持久化、可校验的行为证据」；如果产品目标是自动捕捉纠正，应把投入放到这个耐久证据源（并单独评估复杂度与隐私边界），而不是继续打磨直写痛点的旁路。
- 如果产品不打算为 WB 建证据源，更合理的动作是**明确下线/降级该自动通道**，避免它继续以「存在但永远不产出」的形态占用维护与审查成本。
