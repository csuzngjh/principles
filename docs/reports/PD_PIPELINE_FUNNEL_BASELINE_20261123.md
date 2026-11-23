# PD Pipeline Funnel Baseline — 20261123

- 规范：SPEC-PD-PIPELINE-SPINE-001 v0.9 §6 Phase 0（PRI-1290）
- 性质：**只读基线**。未修改生产数据库、账本文件与任何运行中 Agent 的状态。
- 工作区：`D:\.openclaw\workspace`

## 1. 数据来源与快照方式

- 两个数据库均通过 `stageWalSnapshot`（WAL 双文件 T0/T1 指纹校验暂存快照）复制到系统临时目录后以 `{ readonly: true, fileMustExist: true }` 打开；源库从未被 SQLite 打开，源目录零 `-shm` 新增。
- 数据库路径经 canonical `resolveStateDbPath` / `resolveTrajectoryDbPath` 解析（`.pd/state.db`、`.state/trajectory.db`），无硬编码路径。
- 账本为纯 JSON 文件，经既有 `readLedgerFileState` 只读读取（无 WAL 语义）。

## 2. 快照时间（T1 线性化点）与文件指纹

| 库 | T1 (capturedAt) | main SHA-256 | main size | wal state | wal SHA-256 | 快照尝试次数 |
|---|---|---|---|---|---|---|
| state.db | 2026-11-23T16:42:11.710Z | `3d2e7cb52702cb2b0c87e79e39e354fee37b54f108afd27190e96e2c95d6263c` | 76079104 | quiet | — | 1 |
| trajectory.db | 2026-11-23T16:42:11.832Z | `b4e4867ddf3d7167a23f1c8a98a56a1c768546382dd24a288a7939a449842d79` | 43970560 | active | `23ca7d0915957ab27bb1716109e00737863736656b97fe06b9dfa71c6736773b` | 1 |
| ledger.json | 2026-11-23T16:42:11.857Z | （整文件读取，availability=ok） | — | — | — | 1 |

## 3. 快照偏差窗口（两 T1 之差）

- 实测偏差：**122 ms**（建议阈值 ≤ 5000 ms，未经生产校准）。
- 超差重试：未触发。

## 4. 跨库写入允许延迟假设

- 建议值 ≤ 60 s，**未经生产实证校准**。
- 判定规则：跨库关联缺失以**现存记录自身时间戳 vs 对方库 T1** 判定；窗口内（以及校准前超窗）一律标 `skew_window_candidate`，可延迟复查；本基线不据此判定确定流失。

## 5. 全量漏斗（自库创建起）

```text
Pain 提交总量            107
  └ 有 canonical id      107
  └ 引用 runtime task    86
诊断父任务 diagnostician 107
  └ diag_rootcause       110
  └ diag_distiller       95
  └ diag_router          90
死信 dead_letter_pains    0（未重放 0）
诊断持久化 pain_diagnoses 83
候选 principle_candidates 247
账本 principles           54
内化 dreamer               174
  └ philosopher           213
  └ scribe                248
  └ artificer             249
  └ evaluator             130
  └ rollout_reviewer      119
审批 approvals             63
激活 activations           48
应用 principle_applications 2978（原则数 42）
拦截 gate_blocks            1
```

近 30 天（2026-10-24T16:42:11.832Z 之后，按各表 created_at）：

```text
Pain                    10
新建任务（全部 kind）    145
候选                    18
诊断持久化              6
原则应用                822
gate_blocks             0
```

## 6. 阶段明细与状态分布

### Pain（trajectory.pain_events）

- 来源分布：user_correction: 52, manual: 33, llm_paralysis: 19, user_empathy: 1, tool_failure: 1, mcp_agent_assisted: 1
- 宿主分布：openclaw: 100, (null): 6, codex: 1
- 严重度分布：severe: 79, (null): 20, moderate: 8

### 诊断（state.tasks / runs / dead_letter_pains）

- task_kind × status：artificer/failed: 96, artificer/needs_human_review: 35, artificer/succeeded: 118, diag_distiller/failed: 1, diag_distiller/retry_wait: 2, diag_distiller/succeeded: 92, diag_rootcause/failed: 14, diag_rootcause/succeeded: 96, diag_router/retry_wait: 7, diag_router/succeeded: 83, diagnostician/failed: 24, diagnostician/succeeded: 83, dreamer/failed: 1, dreamer/succeeded: 173, evaluator/failed: 4, evaluator/pending: 1, evaluator/succeeded: 125, philosopher/failed: 1, philosopher/succeeded: 212, rollout_reviewer/needs_human_review: 28, rollout_reviewer/pending: 1, rollout_reviewer/succeeded: 90, scribe/failed: 8, scribe/needs_human_review: 3, scribe/succeeded: 237
- 失败任务（按 kind）：artificer: 96, diagnostician: 24, diag_rootcause: 14, scribe: 8, evaluator: 4, philosopher: 1, dreamer: 1, diag_distiller: 1
- 运行失败（runs.error_category Top）：execution_failed: 319, max_attempts_exceeded: 244, timeout: 126, rate_limit: 70, output_invalid: 58, lease_conflict: 22, input_invalid: 14

### 候选与准入（principle_candidates / admission_json）

- 状态分布：consumed: 216, pending: 31
- 原始 recommendation_kind 分布（该列即原始持久化值，非归一化视图）：principle: 85, rule: 69, implementation: 44, prompt: 40, defer: 9
- 准入决定分布：admitted: 217, needs_evidence: 21, deferred: 9
- 当前评估 reason Top（含 admitted）：evidence_sufficient: 217, recommendation_kind_defer_not_actionable: 9, evidence_array_empty: 6, confidence_below_threshold:0.35<0.5: 5, confidence_below_threshold:0.42<0.5: 4, confidence_below_threshold:0.45<0.5: 3, confidence_below_threshold:0.40<0.5: 3
- processing.state 分布：awaiting_owner: 56, complete: 191
- 文档缺失：0；文档损坏（JSON 无效）：0；带 Owner 决策记录：0

### 账本（ledger.json）

- 原则总数 54；带 reuseEvidence 2（共 3 条边）；带 derivedFromPainIds 54；关联候选数 57

### 内化（peer 任务 × status）

- dreamer：174
- philosopher：213
- scribe：248
- artificer：249
- evaluator：130
- rollout_reviewer：119

### 激活（approvals / activations / pi_artifacts）

- approvals 状态：approved: 39, pending: 22, rejected: 2
- approvals 渠道：prompt: 60, code_tool_hook: 3
- activations 动作：prompt_activate: 46, code_tool_hook_shadow_activate: 1, code_tool_hook_live_activate: 1
- activations 渠道：prompt: 46, code_tool_hook: 2
- 激活目标形态：{"distinct":47,"uuidShaped":0,"otherShaped":47}
- pi_artifacts：总数 1276，带 source_principle_id 56，验证状态 pending: 1167, validated: 109

### 注入/拦截（principle_applications / gate_blocks）

- 应用类型：prompt_injected: 2844, self_reported: 133, rule_blocked: 1
- 应用层级：presence: 2844, effect: 134
- 拦截工具分布：write: 1
- 干预证据记录：18393

## 7. 转化率（分子/分母口径逐条声明）

| 转化 | 分子（口径） | 分母（口径） | 值 |
|---|---|---|---|
| Pain→诊断 | diagnostician 父任务数 | pain_events 总量（两者为不同登记面，仅作比例参考） | 1.000 |
| 诊断→候选 | principle_candidates 总量 | diagnostician 父任务数 | 2.308 |
| 候选consumed→播种 | dreamer 任务数 | status='consumed' 的候选数 | 0.806 |
| 播种→Scribe | scribe 任务数 | dreamer 任务数 | 1.425 |
| 审批通过 | approvals status='approved' | approvals 全部 | 0.619 |
| 激活→应用 | DISTINCT principle_id in principle_applications | 激活目标 DISTINCT target_ref | 0.894 |

> 上述比率是**观测比例**而非严格漏斗转化（各阶段登记面与去重口径不同，已在分子/分母列声明）。

## 8. 失败与拒绝原因分布

- 诊断运行失败 error_category：execution_failed: 319, max_attempts_exceeded: 244, timeout: 126, rate_limit: 70, output_invalid: 58, lease_conflict: 22, input_invalid: 14
- 任务失败（status='failed'，按 kind）：artificer: 96, diagnostician: 24, diag_rootcause: 14, scribe: 8, evaluator: 4, philosopher: 1, dreamer: 1, diag_distiller: 1
- 非 admitted 决定的 reason Top：recommendation_kind_defer_not_actionable: 9, evidence_array_empty: 6, confidence_below_threshold:0.35<0.5: 5, confidence_below_threshold:0.42<0.5: 4, confidence_below_threshold:0.45<0.5: 3, confidence_below_threshold:0.40<0.5: 3

## 9. 跨库关联缺失与偏斜记录

```text
pain→task:     引用 runtime_task_id 的 pain 86 条，其中任务缺失 4 条 → {"skew_window_candidate":4}（阈值未校准 4）
task→pain:     带 diagnostic_json 的 diagnostician 任务 107 条，pain 可见 82 条，缺失 25 条 → {"skew_window_candidate":25}（阈值未校准 25）
candidate→dreamer: consumed 但无 dreamer 任务 44 条（按原始 kind：implementation: 40, principle: 4）→ {"skew_window_candidate":44}
  注：implementation/defer/prompt 候选本就不播种 dreamer（合法路由），其缺失不计为管道缺口。
```

## 10. skew_window_candidate 总数：**73**

（全部跨库缺失均落入该桶；其中标注「阈值未校准」的条目为超出 60 s 建议窗口者——在校准完成前不判定确定流失，可延迟复查。）

## 11. 当前无法确定的问题

- 5 s / 60 s 两个窗口阈值未经生产写入链路实证校准；本报告的跨库缺失因此全部按 `skew_window_candidate` 输出。
- Shadow 与 Live 激活的区分依赖 activations.channel/action 的语义组合，本报告只按原始值分布输出，不做语义归类。
- 候选→账本 的未关联候选包含合法 pending/待审路径（Owner 未 intake 的候选本就不在账本），该差值不是流失。
- task→pain 的缺失可能由 trajectory.db 的保留期清理（trajectory-retention）造成——旧 pain 行被清理后诊断任务仍在；该方向缺失在保留策略确认前不解读为写入断线。

## 12. 对 D1/D2/D4 与架构收敛工作的影响判断

- 本基线为 Phase 1A/1B（PRI-1291）的红灯对照与漏斗对照提供**修复前**的真实分布快照；
- `candidate→dreamer` 缺失与 `principle_candidates.recommendation_kind` 原始分布可直接用于验证 D4 修复后的播种门禁效果；
- `task→pain` 缺失与诊断任务分布可作为 D1（同步授权与轨迹读取器）修复后诊断覆盖率的对照基线；
- Pain 阶段的来源/宿主分布为后续阈值校准（写入链路节奏）提供样本量依据。

---

生成命令：`node scripts/dev/pipeline-funnel-snapshot.mjs --workspace "D:\.openclaw\workspace"`（PRI-1290 Phase 0，只读）
