# PD Pipeline Funnel Baseline — 20261124

- 规范：SPEC-PD-PIPELINE-SPINE-001 v0.9 §6 Phase 0（PRI-1290）
- 性质：**只读基线**。未修改生产数据库、账本文件与任何运行中 Agent 的状态。
- 工作区：`D:\.openclaw\workspace`

## 1. 数据来源与快照方式

- 两个数据库均通过 `stageWalSnapshot`（WAL 双文件 T0/T1 指纹校验暂存快照）复制到系统临时目录后以 `{ readonly: true, fileMustExist: true }` 打开；源库从未被 SQLite 打开，源目录零 `-shm` 新增。
- 数据库路径经 canonical `resolveStateDbPath` / `resolveTrajectoryDbPath` 解析（`.pd/state.db`、`.state/trajectory.db`），无硬编码路径。
- 账本为纯 JSON 文件，经既有 `readLedgerFileState` 只读读取（无 WAL 语义）。
- 报告是本脚本唯一的写入：目标路径经白名单校验（仅限仓库 `docs/reports/` 下、真实父目录逐字相等、文件名固定、拒绝符号链接/硬链接/非常规文件），经同目录临时文件原子替换写入；被拒绝时不产生任何写入。
- 快照所有权在取得时即登记：第二个库失败或超差补拍失败时，本轮已创建的全部暂存副本都会被释放。

## 2. 快照时间（T1 线性化点）与文件指纹

| 库 | T1 (capturedAt) | main SHA-256 | main size | wal state | wal SHA-256 | 快照尝试次数 |
|---|---|---|---|---|---|---|
| state.db | 2026-11-24T02:34:24.574Z | `f513cccc1210275d4bca73305af760f8c8314a8fb8a5711a0d07d5981c9f060e` | 76562432 | quiet | — | 1 |
| trajectory.db | 2026-11-24T02:34:24.702Z | `b4e4867ddf3d7167a23f1c8a98a56a1c768546382dd24a288a7939a449842d79` | 43970560 | active | `45276770fd80c3dbd0ed045ec9a142659ac97d4a0cf04c863ce7223bcd071f89` | 1 |
| ledger.json | 2026-11-24T02:34:24.731Z | （整文件读取，availability=ok） | — | — | — | 1 |

## 3. 快照偏差窗口（两 T1 之差）

- 实测偏差：**128 ms**（建议阈值 ≤ 5000 ms，未经生产校准）。
- 超差重试：未触发。

## 4. 跨库写入允许延迟假设

- 建议值 ≤ 60 s，**未经生产实证校准**。
- 判定规则：跨库关联缺失以**现存记录自身时间戳 vs 对方库 T1** 判定；窗口内（以及校准前超窗）一律标 `skew_window_candidate`，可延迟复查；本基线不据此判定确定流失。
- 适用范围：仅两端分属不同数据库的关系（`pain→task`、`task→pain`）。同一快照内的关系（`candidate→dreamer`）不存在快照时间差，单独统计，不计入跨库偏斜。

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

## 6. 近 30 天漏斗（窗口 [2026-10-25T02:34:24.702Z, 快照 T1)）

每个阶段使用自身的真实事件时间列（见「时间列」），全部落在同一个窗口内；表缺失时记 `NA(表缺失)`，不补零。

| 阶段 | 表 | 时间列 | 窗口内数量 | 无法解析时间戳 |
|---|---|---|---|---|
| Pain | trajectory.pain_events | created_at | 10 | 0 |
| Diagnostician 任务（父任务 + diag_* 子任务） | state.tasks | created_at | 69 | 0 |
| Dreamer | state.tasks | created_at | 12 | 0 |
| Philosopher | state.tasks | created_at | 19 | 0 |
| Scribe | state.tasks | created_at | 26 | 0 |
| Artificer | state.tasks | created_at | 12 | 0 |
| Evaluator | state.tasks | created_at | 2 | 0 |
| RolloutReviewer | state.tasks | created_at | 5 | 0 |
| Approval 请求 | state.approvals | requested_at | 6 | 0 |
| Activation | state.activations | activated_at | 16 | 0 |

阶段转化率（观测比例；相邻阶段窗口内数量之比）：

| 转化 | 分子 | 分母 | 值 |
|---|---|---|---|
| Pain→诊断 | Diagnostician 任务（父任务 + diag_* 子任务） | Pain | 6.900 |
| 诊断→候选 | 候选（principle_candidates.created_at） | Diagnostician 任务（父任务 + diag_* 子任务） | 0.261 |
| 候选→播种 | Dreamer | 候选 | 0.667 |
| 播种→Philosopher | Philosopher | Dreamer | 1.583 |
| Philosopher→Scribe | Scribe | Philosopher | 1.368 |
| Scribe→Artificer | Artificer | Scribe | 0.462 |
| Artificer→Evaluator | Evaluator | Artificer | 0.167 |
| Evaluator→RolloutReviewer | RolloutReviewer | Evaluator | 2.500 |
| RolloutReviewer→审批请求 | Approval 请求 | RolloutReviewer | 1.200 |
| 审批请求→激活 | Activation | Approval 请求 | 2.667 |

窗口内结果拆分（失败 / 等待 Owner / 合法跳过 / 缺失关联分开计）：

- diagnostician 任务状态：failed: 17, succeeded: 6
- dreamer 任务状态：failed: 1, succeeded: 11
- philosopher 任务状态：failed: 1, succeeded: 18
- scribe 任务状态：failed: 8, needs_human_review: 3, succeeded: 15
- artificer 任务状态：failed: 6, needs_human_review: 5, succeeded: 1
- evaluator 任务状态：failed: 1, succeeded: 1
- rollout_reviewer 任务状态：needs_human_review: 4, succeeded: 1
- 候选（窗口内 18）：按原始 kind principle: 6, rule: 5, implementation: 4, prompt: 3；按状态 consumed: 16, pending: 2；已消费 16
  - 合法跳过（implementation/defer，本就不播种）：4
  - 等待 Owner（准入 processing.state=awaiting_owner，或文档带 Owner 决策记录）：3；准入耗尽（processing.state=exhausted）：0；processing.state：complete: 15, awaiting_owner: 3
- Approval 请求按状态（pending=等待 Owner）：approved: 4, pending: 2
- Activation 按动作：prompt_activate: 16
- 缺失关联（已消费但无 Dreamer，全量口径，同库）：44（分类见第 10 节）

## 7. 阶段明细与状态分布

### Pain（trajectory.pain_events）

- 来源分布：user_correction: 52, manual: 33, llm_paralysis: 19, user_empathy: 1, tool_failure: 1, mcp_agent_assisted: 1
- 宿主分布：openclaw: 100, (null): 6, codex: 1
- 严重度分布：severe: 79, (null): 20, moderate: 8

### 诊断（state.tasks / runs / dead_letter_pains）

- task_kind × status：artificer/failed: 96, artificer/needs_human_review: 35, artificer/succeeded: 118, diag_distiller/failed: 1, diag_distiller/retry_wait: 2, diag_distiller/succeeded: 92, diag_rootcause/failed: 14, diag_rootcause/succeeded: 96, diag_router/retry_wait: 7, diag_router/succeeded: 83, diagnostician/failed: 24, diagnostician/succeeded: 83, dreamer/failed: 1, dreamer/succeeded: 173, evaluator/failed: 4, evaluator/pending: 1, evaluator/succeeded: 125, philosopher/failed: 1, philosopher/succeeded: 212, rollout_reviewer/needs_human_review: 28, rollout_reviewer/pending: 1, rollout_reviewer/succeeded: 90, scribe/failed: 8, scribe/needs_human_review: 3, scribe/succeeded: 237
- 失败任务（按 kind）：artificer: 96, diagnostician: 24, diag_rootcause: 14, scribe: 8, evaluator: 4, philosopher: 1, dreamer: 1, diag_distiller: 1
- 诊断运行失败（runs ⋈ tasks，仅 Diagnostician 类任务；按 run/尝试计数）error_category：max_attempts_exceeded: 42, timeout: 39, execution_failed: 35, rate_limit: 29, lease_conflict: 22, output_invalid: 11

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
- 内化运行失败（runs ⋈ tasks，仅 peer runner 任务；按 run/尝试计数）error_category：execution_failed: 284, max_attempts_exceeded: 202, timeout: 87, output_invalid: 47, rate_limit: 41, input_invalid: 14

### 激活（approvals / activations / pi_artifacts）

- approvals 状态：approved: 39, pending: 22, rejected: 2
- approvals 渠道：prompt: 60, code_tool_hook: 3
- activations 动作：prompt_activate: 46, code_tool_hook_shadow_activate: 1, code_tool_hook_live_activate: 1
- activations 渠道：prompt: 46, code_tool_hook: 2
- 激活目标形态：{"distinct":47,"uuidShaped":0,"implUriShaped":2,"otherShaped":45}（规则激活的 target_ref 是 `impl://<ruleId>_<artifactVersion>`——规则身份，不是 principle UUID；principle UUID 以 `pi_artifacts.source_principle_id` / `principle_applications.principle_id` 为准。）
- pi_artifacts：总数 1276，带 source_principle_id 56，验证状态 pending: 1167, validated: 109

### 注入/拦截（principle_applications / gate_blocks）

- 应用类型：prompt_injected: 2844, self_reported: 133, rule_blocked: 1
- 应用层级：presence: 2844, effect: 134
- 拦截工具分布：write: 1
- 干预证据记录：18573

## 8. 转化率（全量；分子/分母口径逐条声明）

| 转化 | 分子（口径） | 分母（口径） | 值 |
|---|---|---|---|
| Pain→诊断 | diagnostician 父任务数 | pain_events 总量（两者为不同登记面，仅作比例参考） | 1.000 |
| 诊断→候选 | principle_candidates 总量 | diagnostician 父任务数 | 2.308 |
| 候选consumed→播种 | dreamer 任务数 | status='consumed' 的候选数 | 0.806 |
| 播种→Scribe | scribe 任务数 | dreamer 任务数 | 1.425 |
| 审批通过 | approvals status='approved' | approvals 全部 | 0.619 |
| 激活→应用 | DISTINCT principle_id in principle_applications | 激活目标 DISTINCT target_ref | 0.894 |

> 上述比率是**观测比例**而非严格漏斗转化（各阶段登记面与去重口径不同，已在分子/分母列声明）。

## 9. 失败与拒绝原因分布（按阶段分开）

- 诊断运行失败 error_category（仅 Diagnostician 任务：diagnostician, diag_rootcause, diag_distiller, diag_router）：max_attempts_exceeded: 42, timeout: 39, execution_failed: 35, rate_limit: 29, lease_conflict: 22, output_invalid: 11
- 内化运行失败 error_category（仅 peer runner 任务：dreamer, philosopher, scribe, artificer, evaluator, rollout_reviewer）：execution_failed: 284, max_attempts_exceeded: 202, timeout: 87, output_invalid: 47, rate_limit: 41, input_invalid: 14
- 全管道运行失败 error_category（全部任务类型，含上述两类；单独命名，不与诊断混同）：execution_failed: 319, max_attempts_exceeded: 244, timeout: 126, rate_limit: 70, output_invalid: 58, lease_conflict: 22, input_invalid: 14
- 任务失败（status='failed'，按 kind）：artificer: 96, diagnostician: 24, diag_rootcause: 14, scribe: 8, evaluator: 4, philosopher: 1, dreamer: 1, diag_distiller: 1
- 非 admitted 决定的 reason Top：recommendation_kind_defer_not_actionable: 9, evidence_array_empty: 6, confidence_below_threshold:0.35<0.5: 5, confidence_below_threshold:0.42<0.5: 4, confidence_below_threshold:0.45<0.5: 3, confidence_below_threshold:0.40<0.5: 3

## 10. 关联缺失记录

### 10.1 跨库关联缺失（计入 skew_window_candidate）

```text
pain→task:     引用 runtime_task_id 的 pain 86 条，其中任务缺失 4 条 → {"skew_window_candidate":4}（阈值未校准 4）
task→pain:     带 diagnostic_json 的 diagnostician 任务 107 条，pain 可见 82 条，缺失 25 条 → {"skew_window_candidate":25}（阈值未校准 25）
```

### 10.2 同库关联缺失：已消费候选无 Dreamer 任务（不计入跨库偏斜）

- 已消费候选 216 条，其中无 Dreamer 任务 44 条；按原始 kind：implementation: 40, principle: 4
- 分类：legal_no_seed_route: 40, legal_reuse_resolved: 1, awaiting_owner_decision: 3
  - `legal_no_seed_route`：implementation（通道 MVP 未启用）/ defer（延迟路由）——设计上不播种，不是异常。
  - `legal_reuse_resolved`：账本 reuseEvidence 记录该候选已复用既有原则——按设计抑制独立 Dreamer 播种。
  - `awaiting_owner_decision`：准入处理停在 awaiting_owner（等待 Owner 决策/入库），尚未入账本——不播种是规定行为，属 Owner 待办而非管道缺口。
  - `invalid_raw_kind`：原始 kind 不在已知集合——数据问题，逐条列出。
  - `unexplained_requires_investigation`：既无不播种理由、无 reuse 证据、也未停在等待 Owner——需要逐条调查。
  - 等待 Owner 决策的候选（候选 ID / 原始 kind / 创建时间 / 准入决定 / processing.state）：
    - `3616c395-63b5-4655-90f0-a173f3af4a75` · principle · 2026-10-06T12:21:49.940Z · admitted · awaiting_owner
    - `60dcfb34-4ebc-4a9a-9486-397a649df18f` · principle · 2026-10-06T04:32:54.131Z · admitted · awaiting_owner
    - `f8278b35-80c9-4328-89c2-2ab9603701a6` · principle · 2026-10-06T12:28:49.833Z · admitted · awaiting_owner
  - 需调查样本：无。

## 11. skew_window_candidate 总数（跨库）：**29**

- 口径：仅 pain→task（4）+ task→pain（25）两类跨库关系之和。
- 同库的「已消费无 Dreamer」（44）不计入本总数，见第 10.2 节。

（跨库缺失均落入该桶；其中标注「阈值未校准」的条目为超出 60 s 建议窗口者——在校准完成前不判定确定流失，可延迟复查。全部样本 ID 见 `--json` 输出的 `model.linkage`。）

## 12. 当前无法确定的问题

- 5 s / 60 s 两个窗口阈值未经生产写入链路实证校准；本报告的跨库缺失因此全部按 `skew_window_candidate` 输出。
- Shadow 与 Live 激活的区分依赖 activations.channel/action 的语义组合，本报告只按原始值分布输出，不做语义归类。
- 候选→账本 的未关联候选包含合法 pending/待审路径（Owner 未 intake 的候选本就不在账本），该差值不是流失。
- task→pain 的缺失可能由 trajectory.db 的保留期清理（trajectory-retention）造成——旧 pain 行被清理后诊断任务仍在；该方向缺失在保留策略确认前不解读为写入断线。
- 近 N 天漏斗按各阶段自身的创建/请求/激活时间计数，不是同一批 Pain 的队列（cohort）转化：跨窗口血缘（窗口前创建的候选在窗口内播种）会使相邻阶段比例偏离真实转化。

## 13. 对 D1/D2/D4 与架构收敛工作的影响判断

- 本基线为 Phase 1A/1B（PRI-1291）的红灯对照与漏斗对照提供**修复前**的真实分布快照；
- `candidate→dreamer`（同库）缺失按原始 kind 与账本证据分类：合法不播种路由与 reuse 解决不计为缺口，其余 principle/rule/prompt 候选逐条列出候选 ID 供调查；
- `task→pain` 缺失与诊断任务分布可作为 D1（同步授权与轨迹读取器）修复后诊断覆盖率的对照基线；
- Pain 阶段的来源/宿主分布为后续阈值校准（写入链路节奏）提供样本量依据。

---

生成命令：`node scripts/dev/pipeline-funnel-snapshot.mjs --workspace "D:\.openclaw\workspace"`（PRI-1290 Phase 0，只读）
