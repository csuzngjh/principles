# PRI-1294 Phase 4b — LLM 阶段合并 PD-Lab 评估准备报告（2026-11-27）

> **性质声明**：本报告是只读评估设计交付。未运行任何真实模型实验（`lab:run` / `lab:eval` 均未执行，结果一律记 `NOT_RUN`，真实实验资格记 `BLOCKED`）；未提交任何阶段合并代码；未修改任何生产或测试文件。全部「生产现状」断言来自基线提交的生产源码，全部漏斗数字来自 Phase 0 基线报告照录，未做二次推断。

## 0. 元信息

| 项 | 值 |
|---|---|
| 分析基线 | `origin/main` = `3f068988cf04b22501a5c190f52f88630d1cb12f`（2026-11-27） |
| 生成日期 | 2026-11-27 |
| 交付物 | `docs/reports/PD_PIPELINE_SPINE_PHASE4_PDLAB_ASSESSMENT_20261127.md`（本文件） |
| 工单 | Linear PRI-1294 Phase 4b（执行者 Agent E） |
| 使用指南 | `docs/process/PD-LAB-USAGE.md`（AGENTS §25A 认定的唯一权威使用指南） |
| 结果词汇 | `PASS` / `PASS_WITH_LIMITATIONS` / `BLOCKED` / `NOT_RUN`（PD-LAB-USAGE §5.4） |

**SPEC 版本注记**：工单引用 SPEC-PD-PIPELINE-SPINE-001 v0.9 §6；仓库当前为 v0.14（`docs/specs/SPEC-PD-PIPELINE-SPINE-001.md:3-5`，状态「Draft for Owner Review（未批准）」）。Phase 4 条文在 v0.14 与 v0.9 两版**逐字节一致**（本次以基线提取件 diff 验证为 IDENTICAL）。Phase 4b 原文：

> 「4b 若漏斗证明中段跳数是真实瓶颈，按 `docs/process/PD-LAB-USAGE.md`（AGENTS §25A）完成离线对照实验后方可合并阶段。」

该条文规定了严格的前提顺序：**漏斗证明瓶颈 → 对照实验 → 才可合并**。本报告对两个候选的评估全程遵守该顺序，不把「实验可行」当作「应当合并」。

**与 Phase 4a 的交互**：候选 A 与 4a 共享 `diagnostician_split_pipeline` 开关（quiet、默认 ON，`packages/principles-core/src/runtime/feature-flags/feature-flag-contract.ts:266`；lifecycle 记录 KEEP_QUIET、decided 2026-08-27，retirementCriteria 明文包含「Pipeline re-merged or diagnostician redesigned」——`packages/principles-core/src/runtime/feature-flags/feature-flag-lifecycle.ts:118-125`）。若 4a 先清理该 flag 的 OFF 分支，候选 A 实验的双臂构造方式随之改变（详见 §3.6 与 §5.1）。候选 B 不与 4a 共享开关：dreamer→philosopher 拓扑无 flag 门控（`prompt_full_pipeline` 只覆盖 full-chain 强制路径且默认 OFF，`feature-flag-contract.ts:219`）。

---

## 1. Phase 0 基线证据审查

审查对象：`docs/reports/PD_PIPELINE_FUNNEL_BASELINE_20261124.md`（PRI-1290 Phase 0 只读基线，工作区 `D:\.openclaw\workspace`，快照 T1 = 2026-11-24T02:34:24Z）。

### 1.1 报告自述限制（原样保留，贯穿本报告全部引用）

以下四条限制来自该报告自述，**本报告引用其任何数字时同时携带这些限制**：

1. **快照生成于最终修复前**（报告头注：「此报告保留的是本轮最终修复前生成的生产只读快照。PR #2780 的最终修复更新了 Owner 决策状态口径与近 30 天窗口上界」）。
2. **修复后生产基线未重生成**（「本轮远程 GitHub 修复未访问生产工作区，因此本报告尚未重新生成。修复后的生产基线必须在受控生产只读环境重新运行脚本后确认，不能把本文件中的旧窗口/Owner 等待数字当作修复后结果」）。
3. **近 30 天是事件窗口统计非严格 Cohort 转化率**（报告 §12：「近 N 天漏斗按各阶段自身的创建/请求/激活时间计数，不是同一批 Pain 的队列（cohort）转化：跨窗口血缘（窗口前创建的候选在窗口内播种）会使相邻阶段比例偏离真实转化」）。
4. **现有报告不能单独证明「增加的 LLM 阶段跳数」是真瓶颈**——这是本报告对 Phase 4b 前置条件的直接核对结论（依据见 §1.4/§1.5），并得到 Phase 4b 前置条文自身支持：瓶颈证明是实验的前置条件，而非实验的产出。

另保留报告 §12 的口径性警告：5s/60s 两个窗口阈值未经生产写入链路实证校准，跨库缺失全部按 `skew_window_candidate` 输出；task→pain 缺失可能由 trajectory-retention 清理造成，不解读为写入断线。

### 1.2 各阶段任务量与流转（全量，自库创建起）

照录基线报告 §5：

```text
Pain 提交总量            107
诊断父任务 diagnostician 107
  └ diag_rootcause       110
  └ diag_distiller        95
  └ diag_router           90
诊断持久化 pain_diagnoses 83
候选 principle_candidates 247
账本 principles           54
内化 dreamer              174
  └ philosopher           213
  └ scribe                248
  └ artificer             249
  └ evaluator             130
  └ rollout_reviewer      119
审批 approvals             63
激活 activations           48
```

近 30 天窗口（事件窗口口径，限制 ③ 适用）：Pain 10、Diagnostician 类任务（父+子）69、Dreamer 12、Philosopher 19、Scribe 26、Artificer 12、Evaluator 2、RolloutReviewer 5、审批请求 6、激活 16。

**解读红线（按工单要求明示）**：`diag_rootcause 110 → diag_distiller 95 → diag_router 90` 的数量差**不得**解释成「合并 distiller+router 可消除的浪费」。各阶段任务数是各自登记面的计数（子任务创建、失败终止、恢复复用都会改变数量），不是同一批工作量在多阶段的重复计量；数量差更接近「Stage A 失败较多导致下游任务少创建」的漏斗自然收缩（diag_rootcause failed 14，而 distiller/router 失败极少，见 §1.3）。同理，philosopher（213）> dreamer（174）的反向差在基线报告中没有分拆解释（与修订级联 reopen 会为同一链创建后继任务的机制一致，但基线未逐条归类），**不得**用于任何收益推断。

### 1.3 失败/重试分布

全量任务状态（基线报告 §7，task_kind × status 照录，仅列本报告相关阶段）：

| task_kind | succeeded | failed | retry_wait | needs_human_review | pending | 成功率（succeeded/总数） |
|---|---|---|---|---|---|---|
| diagnostician（父） | 83 | 24 | — | — | — | 77.6%（83/107） |
| diag_rootcause | 96 | 14 | — | — | — | 87.3%（96/110） |
| **diag_distiller** | 92 | 1 | 2 | — | — | **96.8%（92/95）** |
| **diag_router** | 83 | 0 | 7 | — | — | **92.2%（83/90）** |
| **dreamer** | 173 | 1 | — | — | — | **99.4%（173/174）** |
| **philosopher** | 212 | 1 | — | — | — | **99.5%（212/213）** |
| scribe | 237 | 8 | — | 3 | — | 95.6%（237/248） |

一致性核验：diag_router succeeded（83）= pain_diagnoses（83）= diagnostician 父任务 succeeded（83）——三段链条的终点产量一致，说明 distiller/router 阶段在「成功诊断产量」上不是主要损耗点；父任务失败的 24 例主要损耗在更上游（父 24 failed + rootcause 14 failed）。

运行失败 error_category（按 run/尝试计数，非任务计数；基线报告 §9）：诊断类（diagnostician + diag_*）max_attempts_exceeded 42、timeout 39、execution_failed 35、rate_limit 29、lease_conflict 22、output_invalid 11；内化类（dreamer/philosopher/scribe/…）execution_failed 284、max_attempts_exceeded 202、timeout 87、output_invalid 47、rate_limit 41、input_invalid 14。注意该分布是全部尝试的聚合，基线报告未按 task_kind 分拆每类阶段的 error_category，因此**无法从中得出「distiller 或 router 的失败集中在哪类错误」**。

近 30 天窗口内结果拆分（基线报告 §6）：diagnostician 类任务 failed 17 / succeeded 6；dreamer failed 1 / succeeded 11；philosopher failed 1 / succeeded 18。

### 1.4 Owner 等待、中间阶段耗时、创建/完成时间、LLM 调用次数、token/成本

逐项核对基线报告的**字段覆盖**：

| 证据维度 | 基线报告是否包含 | 说明 |
|---|---|---|
| 各阶段任务量 | 有 | §5/§6/§7 |
| 流转比例 | 有（观测比例口径） | §6/§8，报告自述非严格漏斗转化 |
| 失败/重试分布 | 有（任务状态 + run 级 error_category 聚合） | §7/§9 |
| Owner 等待 | 仅**计数**（候选 awaiting_owner 56、approvals pending 22、rollout_reviewer needs_human_review 28），**无等待时长** | §7 |
| 中间阶段耗时 | **无任何逐阶段耗时/延迟字段** | 全文无 |
| 创建/完成时间 | 仅快照 T1 与窗口边界；无逐任务创建→完成时延 | §2/§6 |
| LLM 调用次数 | **无直接字段**；最接近的代理是 run/尝试计数的 error_category 聚合，且未按阶段分拆 | §9 |
| token / 成本 | **无** | 全文无 |
| 最终质量 | 无输出质量度量（仅有状态分布与准入学 reason 分布） | §7 |

### 1.5 对两个候选的证据可用性判定

按工单要求「必须先看漏斗数据里这两个阶段的真实耗时/调用量/失败率——证据不足就如实说」：

- **调用量**：可核对（§1.2）。两个候选触及的阶段在生产中的绝对量都很小：全量 diag_distiller 95 / diag_router 90 / dreamer 174 / philosopher 213；近 30 天 Diagnostician 类合计 69、dreamer 12、philosopher 19（事件窗口口径）。
- **失败率**：可核对（§1.3）。四个涉事阶段成功率 92.2%–99.5%，失败极低；诊断产量的主要损耗在父任务/rootcause 层（77.6%/87.3%），不在候选 A 拟合并的两段。
- **耗时 / token / 成本 / LLM 调用次数**：**基线报告不含这些字段，证据不足**。因此「合并可缩短 Owner 等待 / 降低成本」在现有基线下没有任何可直接引用的生产数字支撑。

**结论（对 Phase 4b 前置条件的核对）**：Phase 4b 要求「漏斗证明中段跳数是真实瓶颈」作为实验前置。现有基线（含其四条自述限制）**未满足**该前置：它既无耗时数据，也无调用/token/成本数据，且其 30 天比例是事件窗口统计而非 Cohort 转化。现有报告能证明的只有「这两个阶段本身几乎不失败」——这恰恰是**弱化**合并动机的证据，而不是支持合并的证据。若 Owner 未来要重启此项评估，第一步是扩展 Phase 0 快照脚本输出逐阶段耗时、逐阶段 run/尝试数、token 与估算成本（只读、无生产改动），再重跑修复后基线。

---
## 2. 现有 PD-Lab 资产清单（只读盘点）

### 2.1 命令面（`package.json:60-69`，与 `docs/process/PD-LAB-USAGE.md` §6 一一对应）

| 命令 | 脚本 | 职责 | 授权要求 |
|---|---|---|---|
| `lab:preflight` | `experiment/prompt-v2/scripts/ab/ab-preflight.mjs` | 实验配置与双臂工作区 fail-fast 预检 | 无 |
| `lab:run` | `experiment/prompt-v2/scripts/ab/ab-grid.mjs` | A/B 双臂 grid 执行（每 sample×arm 驱动诊断链与 formation） | 按所触数据分级：D2/D3/D4/D6/D5 |
| `lab:metrics` | `.../ab-metrics.mjs` | layer1 指标提取 | 无 |
| `lab:blindpack` | `.../ab-blindpack.mjs` | 盲评包生成（arm 身份入 blindmap） | 无 |
| `lab:eval` | `.../ab-eval.mjs` | 裁判评估（ZAI glm-5.3 外部调用，需 `ZAI_API_KEY`；旧版百分制，**不是** jp-pd-lab@1 协议裁判记录） | 需 D2 |
| `lab:summary` | `.../ab-blind-summary.mjs` | 盲评聚合 + unblinding | 无 |
| `lab:card` | `scripts/dev/pd-lab/build-decision-input.mjs` | 冻结计划+裁判记录 → decision-input.json | 无 |
| `lab:probe` | `scripts/dev/pd-lab/admission-probe.mjs` | 准入探测（只读） | 只读；真实快照路径受 D6 约束（指南 §5.2 澄清） |
| `lab:judge-validate` | `scripts/dev/pd-lab/judge-protocol-validate.mjs` | jp-pd-lab@1 协议记录校验（只读） | 只读 |
| `lab:qualify` | `scripts/dev/pd-lab/t6-qualify.mjs` | T6 资格机械判定（只复算 D2/D5/D6 绑定，`APPROVAL_KEYS = ["d2","d5","d6"]`） | 只读 |

协议模块 `scripts/dev/pd-lab/judge-protocol.mjs`（jp-pd-lab@1 纯函数：buildJudgePackage / swapJudgePackage / parseJudgeResponse / buildProtocolRecord / validateProtocolRecord）与资格核心 `scripts/dev/pd-lab/t6-qualification.mjs` 均已落地。

### 2.2 可复用的实验配置与双臂设施

- **配置 schema**：`pd-lab-experiment-config.v1`（arms 为两个独立 worktree + `expectedHead` + `featureOverrides`；dataset/snapshot 带 SHA-256 绑定；`experimentRoot` 隔离根；`additionalForbiddenRoots`；`modelEnv`）。样例：`scripts/dev/pd-lab/experiment-config.example.json`。
- **历史配置（照录批次，非默认值）**：`experiment/prompt-v2/configs/prompt-v2-round1.json`、`configs/dreamer-v21-round2.json`。两者 `_note` 均声明：历史快照无 blob-manifest（空摘要占位，加载即 fail-closed）、experimentRoot 位于臂 worktree 内不满足 v0.3 隔离契约（T3a 已披露）、缺失路径机器上 `lab:preflight` 会逐项报告缺失并非零退出。
- **双臂执行器**：`experiment/prompt-v2/scripts/ab/ab-grid.mjs`（grid 驱动）+ `ab-run.mjs`（单臂执行器）。`ab-run.mjs:7-8` 自述执行路径：「pd diagnose run（Stage A/B/C + candidate intake + dreamer seeding）→ pd runtime internalization run-once --runner dreamer|philosopher|scribe」。历史两臂同档模型（zai glm-5.3），`diagnostician_async_cli: true` 为两臂共同 override。
- **已知的拓扑硬编码缺口（对本评估直接相关）**：`ab-run.mjs:197,206-207,213-216,235,500` 硬编码派生 `diag_rootcause-{taskId}` / `diag_distiller-{taskId}` / `diag_router-{taskId}` 三个子任务 ID 做产物收集、schema 校验与恢复核查（`ab-run.mjs:262` 按 `diag_<stage>-` 前缀分桶）；formation 侧 `ab-run.mjs:537` 只驱动 `dreamer|philosopher|scribe` 三个 runner（不含 rollout_reviewer）。**含义**：候选 A 的 candidate 臂若改为合并拓扑，产物收集层必须做有界的拓扑感知扩展（预注册后实施）——这是对既有收集层的适配，不是新建 Runner；候选 B 的链在 lab:run 中止于 scribe，对测量 dreamer/philosopher 合并足够。
- **隔离/审计**：`experiment/prompt-v2/isolation/EXPERIMENT_ISOLATION_REPORT.md`、`EXPERIMENT_CURRENT_STATE_AUDIT.md`、`EXPERIMENT_INTEGRITY_REMEDIATION_REPORT.md`（v0.3 隔离契约缺口的历史披露）。

### 2.3 数据集 / 快照 / 样本

- **冻结数据集**：`pain-dataset`（16 条真实 Pain，S01–S16），冻结 2026-11-15T02:45:25Z，全保真文件 SHA-256 `0db86954ab6c22474de64188142aed10df8479ab6c797634bb27ee54baec7d6b`；权威清单 `experiment/prompt-v2/dataset/dataset-manifest.json`（16 个 inputDigest）；选取依据 `dataset/DATASET_SELECTION.md`。
- **公开脱敏副本**：`experiment/prompt-v2/dataset/pain-dataset.json`、`pain-inventory.json`（脱敏审计 `PUBLIC_DATA_REDACTION_AUDIT.md`）。
- **全保真副本 + 快照**：历史路径在某 worktree 的 gitignored `.tmp` 下（`.../adhoc-20261115-prompt-v2-k4wz9t/.tmp/prompt-v2-inventory/`），索引自述为「唯一已知副本，存储归档待 Owner 决策」（`PD_LAB_HISTORICAL_EXPERIMENT_INDEX.md` §2/§9 F-1）。**本报告未读取也未验证该路径当前是否存在**——它是 gitignored 本地资产，不在仓库内；任何新实验要么经 Owner 重新授权（D3/D6）后重新采集快照与数据集，要么确认旧副本仍完整可用。
- **快照指纹（历史）**：state `f25c8fab…`（67,334,144 B）/ trajectory `4dcb401e…`（43,515,904 B）/ blobManifest 空摘要占位。

### 2.4 Prompt 变体资产

- V1 基线：`experiment/prompt-v2/baseline/prompt-hashes.json` + `baseline/runtime-prompts/*.txt`；V2：`prompts/prompt-hashes-v2.json` + `prompts/runtime-prompts/*.txt`；19↔19 严格配对，SHA+chars 双重核验（2026-11-16 审计 19/19 一致）。
- 涉及本评估两候选的阶段 prompt 变体已存在：`prompts/rootcause-v2.txt`、`distiller-v2.txt`、`router-v2.txt`、`dreamer-v2.txt`、`philosopher-v2.txt`、`scribe-v2.txt`——即实验可以直接以这些冻结 prompt 为「不变量」基座（合并臂的合并 prompt 除外，见 §5.3）。
- 生产 prompt 构建器（事实源）：`packages/principles-core/src/runtime/diagnostician/{distiller,router}-prompt-builder.ts`、`packages/principles-core/src/runtime/internalization/{dreamer,philosopher}-prompt-builder.ts`。

### 2.5 Metrics / Blindpack / Evaluator / Summary / Decision Card

- **Metrics**：`ab-metrics.mjs`；历史产物形态 `layer1-metrics.json`（逐 sample×stage×rep×arm 配对，missing/invalid 结构化列出）。
- **Blindpack**：`ab-blindpack.mjs` / `ab-blindpack-paired.mjs`；历史 grid-2 产出 109 包 + blindmap（泄露扫描，泄露即拒绝）。
- **Evaluator**：`ab-eval.mjs`（glm-5.3 外部裁判，同族披露；历史约束：免费档 ~40% 失败率有选择性偏差，故选同档）＋ jp-pd-lab@1 协议裁判链（`judge-protocol.mjs` + `lab:judge-validate` + Owner 抽查脚本 `scripts/analysis/owner-spotcheck-list.mjs`）。指南 §6 明确：`lab:eval` 是旧版百分制评分器，不能充当新版裁判证据。
- **Summary**：`ab-blind-summary.mjs`。
- **Decision Card 模板**：`experiment/prompt-v2/reports/DREAMER_V22_OWNER_DECISION_CARD.md`、`reports/PHASE7_OWNER_DECISION_CARD.md`、`experiment/intent-engineering-onoff/DECISION_CARD.md`（后者是含真实机械复算输出的最新样例）。

### 2.6 历史实验与既有授权记录的存放位置、当前适用状态

- **历史实验索引**：`experiment/prompt-v2/reports/PD_LAB_HISTORICAL_EXPERIMENT_INDEX.md`（PD-SPEC-001 prompt-v2 A/B，PR #2653，判定 PASS_WITH_LIMITATIONS，明确「≠ PROMOTE」）。可复用结论：16 样本双臂管线完成率 1.00、schema pass 0.981/0.990、盲评 V1 78.86 → V2 81.50（+2.64 未达 +5 建议门槛）、平均阶段延迟 34.3s → 27.5s（−20%）；限制（同族裁判、n=16 方向性、全保真仅本地）必须随实验保留。
- **预注册**：`experiment/prompt-v2/reports/DREAMER_V22_ROUND3_PREREGISTRATION.md`（历史线）；`experiment/intent-engineering-onoff/PREREGISTRATION.md`（**DRAFT / NOT FROZEN**，PRI-1259）。
- **授权记录存放位置（按指南 §4 步骤 5 / §5.1 核实）**：
  1. 权威**参数清单**：`docs/plans/PD-LAB-V03-IMPLEMENTATION-HANDOFF.md`（状态 DRAFT、尚未实施；其自述「本文件……不授权真实模型调用……需要这些的步骤都标了所需的 Owner 决策」）——参数清单不等于批准记录。
  2. 每轮实验的**批准记录**：以该轮独立 Owner 决策记录为准，在资格判定输入中以 `evidence.approvals.{d2,d5,d6}`（`{artifactRef, sha256}` 绑定）机械复算；D3/D4 须人工逐项核对绑定范围。仓库内目前**不存在**绑定「阶段合并实验」的任何轮次批准 artifact。
  3. 历史授权实例：prompt-v2 数据集的「Owner 生产数据本地授权（v0.2 §19-3）」记录在历史索引 §2——绑定该实验的该数据集，按指南 §5.1「跨实验/跨数据的旧授权不构成批准」。
- **当前适用状态（对本研究问题）**：最近一次机械复算（2026-11-22，main `3b8d1e303`，intent-engineering-onoff 试点）结果为 `BLOCKED`，阻断原因含 `D2_NOT_APPROVED / D5_NOT_APPROVED / D6_NOT_APPROVED / MODEL_CALIBRATION_NOT_RUN / EVIDENCE_MISSING_FOR_CLAIM` 等，其决策卡 §2 表格列明 D2–D6 全部 `NOT_GRANTED / UNVERIFIED`（`experiment/intent-engineering-onoff/DECISION_CARD.md:12-30`）。该复算虽然绑定的是另一个实验，但它证明：**截至该日期，PD-Lab 体系内不存在任何已批准的 D2/D5/D6 绑定可供新实验继承**。本报告据此判定：本研究问题的 D2–D6 当前均为「无适用授权记录」，真实实验资格 `BLOCKED`。

### 2.7 复用边界（硬约束对照）

本次设计的全部实验均复用上述设施：不新建 Runner / Evaluator / Evidence Store / Metrics / 报告系统（AGENTS §25A、PD-LAB-USAGE §4 复用纪律）。唯一需要触碰实验脚本面的点是 §2.2 所列 `ab-run.mjs` 拓扑硬编码的**有界适配**（收集查询按预注册的臂拓扑参数化），该适配不产生任何第二系统。

---

## 3. 候选 A 分析：合并 `diag_distiller`（Stage B）+ `diag_router`（Stage C）

### 3.1 生产拓扑与装配事实（源码还原）

- 三段拆分管道由 `SplitDiagnosticianRunner` 编排（`packages/principles-core/src/runtime/internalization/split-diagnostician-runner.ts:218`），实现与 `DiagnosticianRunner` 相同的 `run(taskId)` 接口，在 `diagnostician_split_pipeline` flag（quiet、默认 ON，`feature-flag-contract.ts:266`）开启时作为 PainSignalBridge 的 drop-in 替换（`split-diagnostician-runner.ts:2-9`）。顺序执行 A（diag_rootcause）→ B（diag_distiller）→ C（diag_router），子任务依赖边 B←A、C←[A,B]（`:419-483`）；作业图边定义同构（`internalization-job-graph.ts:101-104`）。
- 每段独立子任务：`ensureSubTask` 创建 `maxAttempts: 3` 的独立任务（`split-diagnostician-runner.ts:706-729`）；段间恢复复用已 succeeded 的 A/B（`reuseSucceededStage`，`:761-765`）；Stage C 另有已成功 run 的缓存校验复用路径（解析持久化 payload 并过与生产路径同一权威 `DefaultDiagnosticianValidator`，不合格则重置重跑，`:486-570`）。
- 段重试由 `runStageWithRetry` 驱动：`retried` 状态等待 retry policy backoff 后重跑，最多 10 轮循环、受父预算（默认 3×单段 600s）硬约束（`:778-865`、`:245-253`）。
- 只有 Stage C 提交诊断：Stage B 只写 PIArtifact 不提交候选（`diag-distiller-runner.ts:2-22`、`:333`「NO candidate commit」）；Stage C 经 `DiagnosticianCommitter` 在单事务内完成 artifact + candidate + pi_artifacts + 任务终态（`diag-router-runner.ts:2-30`、`:673-698`）。`onDiagnosisComplete` 由 bridge 调用，router/orchestrator 均不调用（`split-diagnostician-runner.ts:584-586`）。

### 3.2 Distiller（Stage B）职责：抽象，不路由

- 输入：Stage A root cause artifact（`DiagRootCauseOutputV1Schema` 运行时校验后使用，`diag-distiller-runner.ts:149-177`）。
- 输出契约 `DiagDistillerOutputV1`：单一 `abstractedPrinciple`（≤200 字符的跨场景抽象原则）、`rationale`、`groundedOnCorePrincipleIds`（T-01..T-10 核心公理注册表；伪造 ID 会被校验失败）、`confidence`、可选 `ambiguityNotes`（`packages/principles-core/src/runtime/diagnostician/diag-distiller-output.ts:38-64`）。
- 独立质量门禁：注入式 `DiagDistillerValidator`（`diag-distiller-runner.ts:303-311`）；血缘完整性硬校验 `sourceRootCauseArtifactId` 与上下文不符即抛 `output_invalid`（`:437-446`）；核心公理 grounding 由 `diagnostician_core_grounding` flag 控制并在输出校验层核对（`:179-184`）；PRI-1283 R2 模型调用边界最近同意权检查（`:197-206`）；Stage B 专属上下文预算投影与超限 fail-loud（`:213-242`）。
- prompt 角色（生产 prompt 构建器原文）：「You are a principle distiller. … You are NOT a second root-cause analyst.」（`distiller-prompt-builder.ts:135`），并明确要求输出 ABSTRACT、避免 rule-like 触发模式（`:178-200`）。

### 3.3 Router（Stage C）职责：路由载体选择，不重新抽象

- 输入：A、B 两个前驱 artifact（均过各自 TypeBox schema 运行时校验，`diag-router-runner.ts:238-303`），外加模型调用**之前**从权威账本读取的 canonical principle 暴露集（读失败走 typed unavailable 而非猜测，`:305-329`）。
- 输出契约：`DiagnosticianOutputV2`（唯一生产诊断契约），`recommendations[]` 每项带 kind ∈ {principle, rule, implementation, prompt, defer} + `recommendationRef`（`diag-router-runner.ts:542-580` 校验链）。
- 独立质量门禁：V2 schema 检查（`:544-554`）；cardinality 契约——至多一个 `kind:"principle"` 条目（因 Stage B 只携带一个抽象原则，`:556-571`）；`DefaultDiagnosticianValidator` 语义 + ASSC 关联校验（`:573-580`）；修复反馈（validationFeedback）随重试前传，避免同 prompt 重掷（`:335-355`）。
- **确定性继承（合并分析的核心事实）**：`postFetchTransform` 在校验前把 `rootCause`、`evidence` ← Stage A、`confidence`、`abstractedPrinciple` ← Stage B 以系统数据覆盖注入，LLM 不得改写；代码注释明示设计动机——「Eliminate the risk of LLM rephrasing rootCause or inventing evidence / Reduce LLM output complexity (fewer fields = fewer errors on weak models)」（`diag-router-runner.ts:763-913`，引文出自 `:766-772` 注释）。Stage B 无可用抽象原则时 Stage C 硬失败 `input_invalid`（不静默降级，`:843-883`）；intentTension 仅透传、不生成（`:885-911`）。
- 证据与收据：提交时持久化 `trustedContextReceipt`（messageDigest / systemPromptDigest / predecessorDigests / evidenceRefs / canonicalPrinciples）并在写边界做 `verifyRouterContextReceipt` 全量校验（`:631-663`）；只读关联校验结果入 envelope（不 gate 提交、不授权绑定，`:162-178`、`:649`）。
- prompt 角色原文：「You are a principle router. … decide the concrete carrier(s).」并给出 kind 决策规则与默认（`router-prompt-builder.ts:210-242`）；runner 头注明示「Router MUST NOT re-derive root causes or invent new principles」（`diag-router-runner.ts:26`）。

### 3.4 两阶段的耦合点与独立性

**Router 是否依赖 Distiller 结构化输出**：是，且是三层依赖——(a) 构建期依赖：buildContext 要求 ≥2 前驱且 distiller artifact 必须过 `DiagDistillerOutputV1Schema`（`diag-router-runner.ts:234-303`）；(b) 语义依赖：cardinality 契约以「Stage B 恰好携带一个抽象原则」为不变量（`:556-571`）；(c) 权威依赖：`abstractedPrinciple`/`confidence` 的最终值由确定性注入保证来自 Stage B（`:811-883`）。**合并并不消除这三层依赖，而是把它们的执行点从「两个任务 + 确定性拷贝」变成「同一次生成的自我一致」**——抽象与路由由同一个模型调用产出，原本「LLM 物理上无法改写抽象原则」的保证降级为「同一输出的内部一致性」，抽象文本可能被路由偏好（如倾向 rule 载体）反向塑形。

**失败/重试策略差异**：两段同为 BasePeerRunner 语义（maxAttempts 3、retry policy backoff、permanent error categories 相同集合，`diag-distiller-runner.ts:127-129` / `diag-router-runner.ts:221-223`），但重试预算独立、失败投影独立——父任务失败时 `failed_stage` 投影携带失败段的 attempt/error/validatorErrors 细节（`split-diagnostician-runner.ts:59-168`、`:867-935`）。合并后单段单预算：原本「B 失败即终止、C 不消耗任何调用」的早停优势消失（B 的失败在合并形态下要连带重掷 C 侧的生成与输出 token）。

**独立质量门禁清单（合并时会折叠为单门禁）**：distiller 侧 3 项（DiagDistillerValidator、core grounding 注册表核对、血缘 ID 硬校验）+ router 侧 4 项（V2 schema、cardinality、DefaultDiagnosticianValidator/ASSC、收据完整性）。合并形态可以把两套校验串接在同一输出上（工程上可行），但**丢失的是中间产物证据**：当前 B 的 PIArtifact 是独立可查询的中间证据（validationStatus pending、`pi-art-{taskId}-{runId}`，`diag-distiller-runner.ts:355-367`），Owner 与后续诊断可以单独审阅「抽象层做对了没有」；合并后要么不再产出该中间 artifact（证据链少一跳），要么由单次调用双写两份 artifact（此时「两份 artifact 独立生成」的证据价值已不成立，只是格式遗产）。

**是否损害诊断可解释性与复核能力**：会。现有形态下 Owner 复核路径是「A 根因 → B 抽象 → C 路由」逐段可查、失败可定位到段（failed_stage 投影）、恢复可从任意 succeeded 段续跑（`reuseSucceededStage`）。合并后：失败定位粒度从段级退化为合并段整体；恢复粒度同样退化（A 成功后 B/C 任一失败都要整段重跑，之前只需重跑失败段——生产数据中 router retry_wait 7 例正是发生在 B 已成功之后）；receipt 的 predecessorDigests 结构（A+B 双前驱）也要重新定义。

**是否损害拒绝能力**：间接损害。拒绝能力体现在两处：(a) `defer` kind 路由决策（router prompt `:229-242`：噪声信号或证据不足 → defer）；(b) B 的 `ambiguityNotes`/confidence 校准在进入路由**之前**独立成型。合并后「先抽象、后判断证据是否足以承载」的认知顺序压进单次生成，defer 决策与抽象生成同源，缺乏「抽象者不知道路由后果」的隔离——这正是原拆分设计（PRI-372）要避免的自我偏见。

### 3.5 漏斗证据对照（合并动机核查）

- **调用量**：diag_distiller 95 / diag_router 90（全量）；近 30 天 Diagnostician 类（父+子）合计 69（§1.2）。绝对量小：全库历史合计约 90 次诊断，合并即便完美成立，节省的是每月个位数到两位数的 LLM 调用。
- **失败率**：distiller 96.8%、router 92.2%（含 retry_wait 未遂），失败集中在父任务（77.6%）与 rootcause（87.3%）——**拟合并的两段不是诊断链条的失败热点**（§1.3）。
- **耗时/成本**：基线报告无逐阶段耗时、无 token/成本字段（§1.4）。「合并节省一段延迟/成本」的假设没有任何生产数字支持。
- **结论**：Phase 4b 前置「漏斗证明中段跳数是真实瓶颈」在现有证据下**不成立**（限制 ①–④ 全部适用）。

### 3.6 合并假设的影响面汇总（若强行实施）

1. `SplitDiagnosticianRunner` 三段编排改两段；`DIAGNOSTICIAN_EDGES`、任务 kind、pi_artifact 双写、receipt 结构、失败投影、恢复缓存语义全部联动。
2. `diagnostician_split_pipeline` flag 语义重写或退役（其 lifecycle retirementCriteria 本来就包含「Pipeline re-merged」）；与 Phase 4a 的开关清理竞争同一处代码（§0 交互注记）。
3. 合并 prompt 需要新 artifact（distiller 与 router 两套系统指令的合成），这是拓扑处置的衍生物而非独立变量（§5.3 单因素声明）。
4. 下游消费不受契约破坏：候选准入读 `DiagnosticianOutputV2`（不变），但 `diag_distiller` 中间证据的消费者（诊断复核、`pd` 展示面）会失去对象——基线报告没有统计该中间 artifact 的独立消费量，此影响无法用现有数据量化。

---
## 4. 候选 B 分析：prompt 渠道合并 `dreamer` + `philosopher`

**范围声明**：本节仅覆盖 prompt 激活渠道（`InternalizationChannel = 'prompt'`）的 dreamer→philosopher 链。`code_tool_hook`、`skill`、`defer_archive` 渠道与 full-chain 拓扑不在本候选范围内。

### 4.1 渠道拓扑事实（源码还原）

- 通道感知作业图是拓扑唯一权威：`CHANNEL_EDGES.prompt = PRINCIPLE_SEMANTIC_EDGES = [dreamer→philosopher, philosopher→scribe, scribe→rollout_reviewer]`；`code_tool_hook`/`skill` 保持完整线性链 dreamer→philosopher→scribe→artificer→evaluator→rollout_reviewer（`packages/principles-core/src/runtime/internalization/internalization-job-graph.ts:35-70`）。prompt 渠道按设计跳过 RuleCode 子链（artificer/evaluator），rollout_reviewer 以 principle 语义模式运行（`:44-51` 注释）。
- 该拓扑**无 feature flag 门控**（`resolveChannelEdges` 只按 channel + pipelineMode 解析，`internalization-job-graph.ts:84-95`）；`prompt_full_pipeline` flag（quiet、默认 OFF，`feature-flag-contract.ts:219`）仅在 Owner 显式开启时把**新播种的** prompt/defer 链强制回完整链——它与候选 B 的合并不是同一件事，且默认状态下与本研究无关。
- 后继任务由 `InternalizationOrchestrator.proposeNextTask` + 稳定 taskId 派生创建：root = intake 时的 candidateId，后继形如 `${kind}-${root}-${channel}`，杜绝渠道后缀逐跳累积（`internalization-orchestrator.ts:894-914`）； PRI-1293 后父子扫描 `(parentTaskId, kind, channel)` 是唯一后继权威（`:922-944`）。
- Dreamer 播种来源：intake-to-internalization-bridge 按候选 kind 路由（`internalization-route.ts:47`：`prompt → 'prompt-injection-candidate'`）；生产漏斗中 prompt kind 候选全量 40/247、近 30 天窗口 3/18（§1.2）——**prompt 渠道是产量最小的渠道之一**。

### 4.2 Dreamer 职责：多样化探索，不当最终作者

- 输入：前驱诊断 artifact（经 `intent_engineering` flag 门控裁剪策略性字段，`dreamer-runner.ts:181-197`）+ 任务种子中的 canonical `sourcePainId`（仅接受种子权威，LLM 回显值被丢弃/覆盖，`:389-414`）。
- 输出契约 `DreamerOutput`：1–5 条 `candidates[]`，每条含 `badDecision` / `betterDecision` / `rationale` / `confidence [0,1]` / `riskLevel(low|medium|high)` / `strategicPerspective`（`dreamer-output.ts:23-87`；validator 强制 1–5 条、逐字段类型检查，`:117-178`）。
- 独立处理门禁：lineage echo gate（taskId/sourcePainId 以系统值为权威，`dreamer-runner.ts:394-414`）；`stripFabricatedCorePrincipleIds`（`:415`）；`valid` 自证字段归一化为运行时真值（`:424-434`，历史案例：glm-5.3-flash 3/3 因此字段单点失败，`:136-142` 注释）；identity 断言不携带、由账本盖戳（`:295-313`）。
- prompt 角色原文：「You are a Dreamer agent … You are an exploration agent, not the final principle author. Philosopher will critically evaluate your candidates and select the strongest defensible insight.」（`dreamer-prompt-builder.ts:93-95`），并要求 2–4 条机制性不同候选、仅在有 5 条真实不同候选时才返回 5（`:186-188`）、「Never invent candidates to reach a target count」（`:188`）。

### 4.3 Philosopher 职责：独立批判与收敛，不接受全部候选

- 输入：dreamer artifact（JSON 解析）+ **经由 dreamer 依赖链解析出的诊断 artifact**（SIA v1.2 战略基础；解析失败可观察降级 `diagnosis_unavailable` 而非编造，`philosopher-runner.ts:161-254`）。
- 输出契约 `PhilosopherOutputV1`：单一 `thesis` + `principleCandidate{title, rationale, scope, confidence}` + `risks[]`（`philosopher-output.ts:24-48`；validator 逐字段检查，confidence ∈ [0,1]）。
- 独立处理门禁：血缘硬校验 `sourceDreamerArtifactId` 必须与上下文一致否则 `output_invalid`（`philosopher-runner.ts:350-356`）；lineage echo reconcile（`:459-474`）。
- prompt 角色原文：「You are a Philosopher agent … critically evaluate the Dreamer's alternative decision analysis and distill the STRONGEST defensible principle candidate from it. You are NOT required to accept every Dreamer candidate.」；要求「Do NOT combine mutually exclusive strategies」；冲突无法调和时降低 confidence 并把冲突写入 risks、不发明掩盖冲突的折中（`philosopher-prompt-builder.ts:111-118`）。另有 Stage A 战略权威约束：「Stage A is the ONLY authority for strategic relevance. Do not re-derive, re-label, or override it」（`:80`）。

### 4.4 两阶段数据契约与独立价值

数据契约是显式的双 artifact 链：dreamer 产出 PIArtifact（1–5 候选集，含血缘 `lineageArtifactIds`），philosopher 以 `sourceDreamerArtifactId` 显式引用并自证血缘一致性。这条链的结构价值：

1. **发散-收敛（generate-and-select）分离**：dreamer 被明确禁止做最终作者、philosopher 被明确赋予拒绝权（「NOT required to accept every Dreamer candidate」）。合并后「生成 1–5 候选并自我择优」退化为单次生成内的隐式选择——独立批判消失，择优与生成同源（同一次采样），候选多样性从**持久化证据**（5 条候选可逐条复核）退化为合并输出的自我陈述。
2. **候选级可追溯**：Owner 目前能看到「曾考虑过哪些替代方案、各自 rationale/risk/confidence 是什么」——这是治理指标「Owner 独立理解中间证据」的实物载体。合并后该证据要么消失、要么只是同一输出里的装饰性列表。
3. **失败恢复粒度**：dreamer 失败（1/174）与 philosopher 失败（1/213）在全量中各仅 1 例，且链路按阶段独立重试（maxAttempts 3）。合并后单段单预算——但鉴于两段失败率都极低，此损失的实际量级很小（如实陈述：不是主要论据）。
4. **上游成本结构**：philosopher 输入只含 dreamer artifact + 诊断 artifact，不含完整 Pain 轨迹；合并节省的是一次「读 dreamer artifact → 生成批判」的往返调用与该次调用的系统 prompt/上下文重载，规模为每条 prompt 渠道链省 1 次调用。**工单红线适用：不得仅以「省一次 LLM 调用」作为合并理由**——该理由必须与质量/证据/拒绝能力的损失放在同一张表上比较，而漏斗数据（§4.6）不支持存在值得此损失的瓶颈。

### 4.5 合并假设的影响面（若实施）

1. `CHANNEL_EDGES.prompt`（与 `defer_archive` **共享** `PRINCIPLE_SEMANTIC_EDGES` 常量，`internalization-job-graph.ts:52-70`）需要拆分——合并 prompt 渠道会波及 defer_archive 渠道，除非为两渠道分别定义边集；这是本次范围声明（仅 prompt 渠道）在实现层的第一个约束。
2. `code_tool_hook`/`skill` 的完整链同样含 dreamer→philosopher 边；实现必须保持这两个渠道逐字节不受影响（范围红线）。
3. 合并阶段的输出契约需要一个同时承载「候选集 + 择优 + thesis + principleCandidate + risks」的新 schema（或放弃候选集证据，见 §4.4-2 冲突）。
4. 下游 scribe 消费 philosopher artifact（`philosopher → scribe` 边 + scribe 读上游 artifact 的既有机制）；合并臂必须保证 scribe 输入契约不变，否则实验测的就不只是合并效应。
5. 无既有开关可承载合并拓扑——实验臂用 worktree 承载拓扑差异即可（§5.2）；若未来真要合并入生产，才需要按 §16 论证新控制机制。

### 4.6 漏斗证据对照（合并动机核查）

- **调用量**：dreamer 174 / philosopher 213（全量）；近 30 天 12 / 19（事件窗口口径）。prompt kind 候选全量 40、近 30 天 3——prompt 渠道链的绝对产量很小。
- **失败率**：99.4% / 99.5%，各仅 1 例 failed（§1.3）。
- **耗时/成本**：基线报告无字段（§1.4）。
- **结论**：与候选 A 同构——Phase 4b 前置在现有证据下不成立；且 philosopher(213) > dreamer(174) 的计数反转（30 天 19 vs 12）基线未分拆解释（与修订级联 reopen 机制一致但未归类），按 §1.2 解读红线不得用于收益推断。

---

## 5. 实验矩阵（两候选各自独立设计）

**设计原则**：单因素对照；两臂唯一差异 = 阶段拓扑（合并指定两阶段）；其余 prompt（除合并段衍生物，见 §5.3）、模型、输入样本、配置、其他阶段全部不变。两候选是两个独立实验，禁止合并为一个实验（不同链路、不同合并对象、不同下游契约）。

### 5.1 候选 A 实验矩阵

| 项 | 设计 |
|---|---|
| 研究问题 | 将诊断 Stage B（抽象）+ Stage C（路由）合并为单次 LLM 调用，是否在不损害最终诊断质量、证据完整性与拒绝能力的前提下减少调用次数/延迟/成本？ |
| baselineArm | `split3`：现生产拓扑 A→B→C（`diagnostician_split_pipeline` 默认 ON），origin/main HEAD，全部现有 prompt 与校验 |
| candidateArm | `merged_bc`：A→BC（合并段），candidate 臂 worktree = main + 合并实现；两臂 `expectedHead` 在配置中钉定，唯一代码差异 = 合并段实现 |
| 不变量 | Stage A（diag_rootcause）实现、prompt、预算投影；模型/provider/档位；数据集与快照；`diagnostician_*`/`internalization_*` 等 featureOverrides（两臂一致）；重试策略参数；候选准入与下游消费 |
| 唯一差异 | Stage B 与 C 是否为两次独立 LLM 调用（含各自独立任务、独立重试预算、独立 artifact） |
| 样本 | 冻结真实 Pain 数据集（历史 16 条 S01–S16 为现成候选；须 Owner 授权 D3/D6 后重新冻结或确认旧副本） |
| 配对方式 | 同一样本双臂（paired A/B，沿用 `ab-dreamer-paired.mjs`/`ab-blindpack-paired.mjs` 的配对设施思路） |
| 触达链路 | `lab:run`（ab-grid 驱动 `pd diagnose run` 诊断链 + intake）；formation 不在本实验测量范围（诊断阶段合并效应在诊断产物与候选产出上即可观测） |
| 已知适配点 | `ab-run.mjs` 产物收集硬编码三段 task ID（§2.2）——预注册时声明合并臂的收集映射（合并段 task kind 与 artifact 槽位），实施为收集层的有界参数化 |
| 统计参数 | α、重复次数、最低独立来源组数 → **D2 Owner 决策项**，本报告只声明需要什么，不代填 |
| 前置链 | ① 修复后 Phase 0 基线重生成并证明 B/C 跳数是真实瓶颈（Phase 4b 前置）；② D2–D6 授权；③ 预注册冻结 |

### 5.2 候选 B 实验矩阵

| 项 | 设计 |
|---|---|
| 研究问题 | 在 prompt 渠道将 Dreamer（生成 1–5 候选）+ Philosopher（独立批判择优）合并为单次调用，是否在不损害原则候选质量、候选多样性与证据链的前提下减少一次调用？ |
| baselineArm | `two_stage`：prompt 渠道 dreamer→philosopher→scribe（现生产拓扑），origin/main HEAD |
| candidateArm | `merged_dp`：prompt 渠道 合并段→scribe（candidate 臂 worktree = main + 合并实现）；`code_tool_hook`/`skill` 渠道拓扑在两臂均逐字节不变 |
| 不变量 | Dreamer 与 Philosopher 各自的 prompt 语义（合并段的合成 prompt 见 §5.3）；诊断上游（两臂共享同一批诊断产物作为播种输入）；模型；数据集；scribe 及下游；`intent_engineering` 等开关状态 |
| 唯一差异 | dreamer 与 philosopher 是否为两次独立 LLM 调用（含独立任务、独立校验、独立 artifact） |
| 样本 | 需要能产出 prompt kind 候选的 Pain 样本。历史 16 条数据集中 prompt kind 占比未在索引中披露——样本量是本实验的**统计前置风险**（§6 分母规则），最低独立来源组数须由 D2 决策；若 16 条不足，须扩充数据集（新的 D6 授权范围） |
| 配对方式 | 同一样本双臂 paired |
| 触达链路 | `lab:run` formation 侧（`ab-run.mjs:537` 已驱动 `dreamer|philosopher|scribe`），链止于 scribe 即可完成测量（rollout_reviewer 不在 lab:run 驱动范围，不阻塞本实验） |
| 已知适配点 | 合并臂的 formation runner 驱动参数（runner 名与拓扑）需在收集层声明；PRINCIPLE_SEMANTIC_EDGES 与 defer_archive 共享的实现约束（§4.5-1）在 candidate 臂实现中必须显式处理 |
| 统计参数 | α、重复次数、最低独立来源组数 → D2 |
| 前置链 | 与候选 A 相同：① Phase 4b 前置证明；② D2–D6；③ 预注册冻结 |

### 5.3 单因素边界的如实声明（两候选共用）

合并段**必然**需要一个合成 prompt（两套系统指令与输出 schema 的合并物）。本报告将其归类为「拓扑处置的衍生物」：唯一实验因素是拓扑，合并 prompt 是该因素在 candidate 臂的具体实现，必须随预注册全文冻结（SHA 绑定），且其内容构造规则须事先声明（例如：逐段保留 distiller/router（或 dreamer/philosopher）原指令文本、只合并输出 schema 与角色声明，不引入任何新行为指令），使评审能核实 candidate 臂没有夹带第二个因素。若评审认为合成 prompt 本身构成独立变量，则本实验设计不成立，须改为三臂（split / merged-合成prompt / merged-备选合成prompt）——这已经不是单因素设计，本报告不预设该扩展。

**分母红线**：所有指标按 plannedGroups/plannedSamples 全分母报告；失败、降级、`UNKNOWN`、未到达样本一律留在分母（PD-LAB-USAGE §5.4 NOT_RUN 语义 + HANDOFF §7「缺结果删掉就能算分」反模式）。合成 fixtures 的离线验证通过**不得**改写真实实验的 `BLOCKED` 判定。

---
## 6. 质量指标（两候选分别定义）

全部质量指标以全分母（plannedSamples 含失败/降级/UNKNOWN）计算；逐样本×臂提取走 `lab:metrics`（layer1），盲评走 blindpack/jp-pd-lab@1 链。

### 6.1 候选 A 质量指标

| 指标 | 定义 | 提取来源 |
|---|---|---|
| 诊断产出有效率 | 两臂各自产出通过 `DiagnosticianOutputV2Schema` 校验的诊断的样本比例（分母=全部样本） | 诊断提交 envelope |
| 最终输出正确性（盲评） | 盲评 pairwise（A_BETTER/TIE/B_BETTER）+ Owner ≥20% 抽查一致率 | blindpack + jp-pd-lab@1 + owner-spotcheck |
| 抽象原则质量 | abstractedPrinciple 与 baseline 臂同一产出的语义等价性评审（事实/推断区分、抽象层级、≤200 字符约束下信息保真）；candidate 臂额外检查抽象文本是否出现 rule-like 触发模式（distiller prompt 明令禁止的形态） | 盲评维度 + 结构化检查 |
| 证据覆盖率 | 提交 envelope 的 `evidenceRefs` 对 Stage A evidence 的覆盖完整性（router 现状：`exposedEvidenceRefs` 取自 Stage A evidence sourceRef 去重集） | envelope.trustedContextReceipt |
| 事实/推断区分 | rootCause/evidence（应为 Stage A 确定性拷贝）与生成字段（recommendations）的混淆率——candidate 臂合并后 LLM 同时生成两类内容，`invariant_override` 类事件不再存在，需以逐字段溯源评审替代 | 盲评 + 人工评审项 |
| 结构化输出有效率 | V2 schema 首过率、cardinality 违规率（>1 principle entry）、ASSC 关联校验结果分布 | validateOutput 链遥测 |
| 幻觉/编造率 | canonical_principle 关联目标不在暴露集的比例（现状会降级为 unresolved 而非丢弃诊断）；core grounding 伪造 ID 率（candidate 臂合并后仍应保持 registry 校验） | associationValidation + validator 错误 |
| 拒绝能力保留 | `defer` kind 的分布与基线臂的差异；「噪声信号/证据不足」样本被正确 defer 的比例 | recommendations kind 分布 |
| 失败样本比例 | 每臂 failed/retry_wait/timeout 样本比例（全分母） | 任务/run 记录 |

### 6.2 候选 B 质量指标

| 指标 | 定义 | 提取来源 |
|---|---|---|
| 原则候选有效率 | 每链产出通过 `PhilosopherOutputV1` 校验（或合并段等价校验）的比例（分母=全部链） | runner 校验记录 |
| 原则候选质量（盲评） | thesis/principleCandidate 的盲评 pairwise + Owner 抽查一致率 | blindpack + jp-pd-lab@1 |
| 候选多样性证据 | baseline 臂：dreamer artifact 中 candidates[] 的机制性不同候选数与 rationale 质量（持久化证据）；candidate 臂：合并输出中候选列表的存在性与其「生成-选择同源」结构。两臂不可直接比数量，须比「替代方案证据对 Owner 复核的可用性」 | PIArtifact 对照评审 |
| 事实/推断区分 | risks[] 是否如实携带未解决冲突（philosopher prompt 要求：冲突时降 confidence + 写 risks，不发明折中）；合并臂自查风险（生成者自评 risks 的独立性下降） | 盲评维度 + 人工评审项 |
| 推理一致性 | sourceDreamerArtifactId 血缘一致率（baseline 硬校验）；合并臂等价血缘字段的一致率 | runner 校验 |
| 遗漏率 | baseline 臂 philosopher 显式拒绝候选（未采纳）的事件在合并臂中是否被静默吞并 | 候选对照评审 |
| 结构化输出有效率 | schema 首过率；`valid` 自证覆盖事件率 | 校验遥测 |
| 下游兼容质量 | scribe 接收输入的 schema 通过率与产物质量（两臂 scribe 不变，其产出差异反映上游合并的真实效应） | scribe 产物 |
| 失败样本比例 | 每臂链级失败比例（全分母） | 任务/run 记录 |

---

## 7. 性能指标（两候选共用定义、分别报告）

| 指标 | 定义 | 说明 |
|---|---|---|
| 单样本端到端延迟 | 样本进入测量链路到链路终点产物落库的墙钟时间 | 历史 layer1 已有阶段延迟口径（grid-2 平均阶段延迟 34.3s → 27.5s 可复用其提取方式） |
| P50 / P95 | 逐样本延迟的分位数 | 预注册声明分位数口径 |
| LLM 调用次数/样本 | 每 sample×arm 的模型调用计数（含重试） | 候选 A 预期 3→2；候选 B 预期 2→1；以实测为准 |
| token（输入/输出） | 逐调用 token 与逐样本合计 | 历史指标有总字符口径（~492.8K → ~423.0K），token 口径须在 D2 批准的模型下定义 |
| 单样本估算成本 | token × D2 批准的模型单价 | 估算值，须披露单价来源 |
| 重试次数 | run/尝试计数分布（对照生产 retry_wait 形态） | runs 表 |
| 阶段失败率 | 按臂按阶段的 failed/retry_wait 比例 | 全分母 |
| 首过率 vs 重试后通过率 | 区分「一次生成即过校验」与「消耗重试预算后通过」——合并增加单次输出复杂度，预期在首过率上可观测 | 校验遥测 |

---

## 8. 授权门检查（D2–D6 逐项）

判定基准：`docs/process/PD-LAB-USAGE.md` §4 步骤 5、§5.1–§5.3；「口头授权、聊天摘要、旧实验授权、合成 fixture 均不构成批准」。`lab:qualify` 只机械复算 D2/D5/D6 绑定，D3/D4 须人工核对——本报告按此分工逐项记录。

| 门 | 控制内容（本研究问题下的具体形态） | 当前有无绑定本实验的授权记录 | 证据位置 | 状态 |
|---|---|---|---|---|
| **D2** | 生成/裁判模型与档位、预算上限、α、重复次数、最低独立来源组数；`lab:eval`（外部 glm-5.3）与 `lab:run` 真实调用 | **无** | 仓库内无绑定本研究的批准 artifact；最近机械复算（2026-11-22）`D2_NOT_APPROVED`（`experiment/intent-engineering-onoff/DECISION_CARD.md` §1–2）；参数清单在 `docs/plans/PD-LAB-V03-IMPLEMENTATION-HANDOFF.md`（DRAFT，非批准） | **BLOCKED** |
| **D3** | 真实快照执行人/窗口/存储（修复后基线重采或复用旧快照均需） | **无** | 同上；历史快照授权（prompt-v2 v0.2 §19-3）绑定旧实验数据集，不可继承 | **BLOCKED** |
| **D4** | 进入实验工作区的 INTENT 内容/路径 | **无适用记录**；适用性取决于冻结配置——两臂 `intent_engineering` 保持生产默认 OFF 时不触发真实 INTENT 注入（D4 不适用须在预注册显式声明），若 Owner 要求生产同态开启则须完整 D4 决策 | `experiment/intent-engineering-onoff/DECISION_CARD.md` §2（D4 NOT_GRANTED 范例） | **BLOCKED（或经预注册声明 N/A）** |
| **D5** | Owner 盲评（样本量、一致率、仲裁） | **无** | 最近机械复算 `D5_NOT_APPROVED`；Owner 抽查脚本与 20% 抽查协议已就绪但未获授权 | **BLOCKED** |
| **D6** | 全保真数据使用（范围/存储/保留/撤回） | **无**；且历史全保真副本为 gitignored 本地单副本、存在性未验证（§2.3） | 最近机械复算 `D6_NOT_APPROVED` + `DATA_PATH_AUTHORIZATION_INVALID`；历史索引 F-1（归档待 Owner 决策） | **BLOCKED** |

**综合判定**：两个候选的真实对照实验当前均为 **BLOCKED**（无任何适用的 D2–D6 授权记录）；本报告完成的设计、指标与授权缺口清单属指南 §5.2 明确允许的无授权工作（离线设计与只读盘点）。API Key 环境变量（如 `ZAI_API_KEY`）存在于本机配置这一事实**不构成** D2 授权，本报告未读取、未使用任何密钥。

---

## 9. 是否建议正式实验（两候选分别，五选一）

### 9.1 候选 A（diag_distiller + diag_router）

**结论：③ 不建议合并（职责独立性有实际价值）。**

理由链（按证据强度排序）：

1. **职责分离是代码明文的质量机制，不是历史包袱**。抽象与路由被 prompt 角色声明、runner 注释、确定性注入（`postFetchTransform`）、cardinality 契约四层机制强制分离；`diag-router-runner.ts:766-772` 注释明言减少单次 LLM 输出复杂度是弱模型错误率的直接防线。合并把「LLM 物理上无法改写抽象」降级为「同一次生成的自我一致」，是已知风险方向的变更。
2. **漏斗证据不支持瓶颈前提**。两段成功率 96.8%/92.2%，诊断产量损耗在父任务/rootcause；无耗时/token/成本字段（§1.4/§1.5，限制 ①–④ 全适用）。Phase 4b 前置（「漏斗证明中段跳数是真实瓶颈」）未满足——合并的动机侧证据不存在。
3. **合并损失是具体的**：中间 distiller artifact 证据、段级失败定位（failed_stage 投影）、段级恢复缓存（router retry_wait 7 例正是 B 成功后才发生）、B 失败早停优势、defer 决策与抽象生成的隔离。
4. **附随记录**（不改变主结论，供 Owner 完整决策）：
   - 若 Owner 不接受 ③ 并想推进：则按顺序先补 ② 的前置（扩展 Phase 0 脚本输出逐阶段耗时/调用/token → 修复后基线重跑 → 证明瓶颈），再走 ④ 的授权链，实验设计按 §5.1。即 ② 与 ④ 是 ③ 被否决后的顺序化路径，不是并列选项。
   - 真实实验现状：**BLOCKED**（D2–D6 无适用授权）＋ **NOT_RUN**（未运行）。

### 9.2 候选 B（prompt 渠道 dreamer + philosopher）

**结论：③ 不建议合并（职责独立性有实际价值）。**

理由链：

1. **发散-收敛分离是这两个 prompt 的明文契约**：「exploration agent, not the final principle author」（`dreamer-prompt-builder.ts:93-95`）与「critically evaluate … NOT required to accept every Dreamer candidate」（`philosopher-prompt-builder.ts:111-118`）。合并后独立批判消失、择优与生成同源，候选多样性证据退化为自我陈述——直接命中治理指标「Owner 独立理解中间证据」。
2. **漏斗证据不支持瓶颈前提**：两段成功率 99.4%/99.5%、各仅 1 例失败；prompt 渠道候选产量全量 40/247、近 30 天 3/18——即便合并完美成立，绝对节省是每月个位数调用。Phase 4b 前置同样未满足。
3. **「省一次调用」被工单红线明确排除为合并理由**（§4.4-4）；在质量/证据损失不为零的前提下，该理由不足以支撑变更。
4. **附随记录**：与候选 A 相同的顺序化路径适用（② 前置补证 → ④ 授权 → §5.2 实验）。真实实验现状：**BLOCKED**（D2–D6 无适用授权）＋ **NOT_RUN**（未运行）。另有候选 B 特有的统计前置风险：prompt kind 样本占比可能不足以支撑最低独立来源组数（§5.2）。

### 9.3 结论矩阵

| 候选 | ① 进入正式实验 | ② 暂不建议实验（缺瓶颈证据） | ③ 不建议合并 | ④ BLOCKED | ⑤ NOT_RUN |
|---|---|---|---|---|---|
| A：distiller+router | 否 | **适用（前置未证）** | **主结论** | 真实实验 BLOCKED | 全部运行 NOT_RUN |
| B：dreamer+philosopher（prompt 渠道） | 否 | **适用（前置未证）** | **主结论** | 真实实验 BLOCKED | 全部运行 NOT_RUN |

> 注：②与③同时成立时按工单五选一要求择一为主——本报告以 ③ 为主结论，因为职责独立性分析基于源码事实（更强证据），瓶颈缺失是基于基线字段覆盖的事实（次强证据）；若未来瓶颈证据被补齐且 Owner 仍倾向合并，③ 的前提（职责独立性价值 > 合并收益）需要由 §5 实验的实际结果来推翻，而不是被讨论推翻。

---

## 10. Owner 决策卡

1. **现有很多阶段职责**：源码证实两个候选的四段拆分各自携带独立 prompt 角色、独立输出 schema、独立校验门禁与独立 artifact 证据（A：抽象 vs 路由 + 确定性继承；B：发散探索 vs 独立批判择优）。分离不是编排副产品，是被 prompt 与校验层显式执行的设计。
2. **瓶颈证据**：Phase 0 基线**不能**证明中段跳数是真实瓶颈——报告无逐阶段耗时、无调用/token/成本字段，且带四条自述限制（修复前快照、修复后未重生成、事件窗口非 Cohort、无法单独证明跳数瓶颈）。能证明的是：四段成功率 92.2%–99.5%，失败热点在更上游。
3. **合并假设**：「合并相邻 LLM 阶段可省一次调用/一段延迟」。该假设的收益侧无生产数字支撑；成本侧有具体清单：中间证据丢失、失败定位与恢复粒度退化、确定性继承保证弱化、defer/批判的独立性消失、合并段首过率风险（单次输出复杂度上升）。
4. **实验设计**：两候选各自的单因素 paired A/B 已设计完毕（§5），复用现有 lab:run/metrics/blindpack/judge-protocol/summary/card 全链，不新建任何系统；已知适配点（ab-run 拓扑硬编码、合并 prompt 冻结、defer_archive 共享边集）已如实列出。
5. **质量风险**：A——抽象被路由偏好反向塑形、证据链少一跳；B——候选多样性证据消失、生成者自评风险。两者都直接命中 PD 的 Owner 复核与可解释性产品边界。
6. **成本延迟收益假设**：按生产量级（全量约 90 次诊断、174 条 dreamer 链/自库创建起），绝对节省为每月个位数到两位数调用；无基线数字可算出金额或时长。
7. **PD-Lab 资格**：设施与历史经验齐备（16 样本 paired A/B 已有一次 PASS_WITH_LIMITATIONS 完整先例）；但 T6 资格链上最近一次机械复算为 BLOCKED，且无任何可继承的批准绑定。
8. **授权缺口**：D2（模型/预算/统计）、D3（快照治理）、D5（Owner 盲评）、D6（全保真数据）全部无适用授权记录；D4 取决于冻结配置（`intent_engineering` OFF 时可声明 N/A）。全部缺口需 Owner 逐项决策，且每轮授权绑定本实验、本数据集/快照与本 INTENT 哈希。
9. **建议结论**：候选 A 与候选 B 均 **③ 不建议合并**；两个真实实验均 **BLOCKED**（授权）且 **NOT_RUN**（未运行）。保留原管道结构是本评估的成功结论之一，不是未完成。
10. **若 Owner 想推翻本结论的最低路径**：(a) 扩展 Phase 0 快照脚本输出逐阶段耗时/尝试/token/成本（只读）并重跑修复后基线；(b) 若瓶颈成立，按 §8 缺口逐项取得 D2–D6 授权；(c) 按 §5 冻结预注册后运行实验；(d) 以实验结果（含全分母）而非讨论结论决定是否合并。任何一步缺失都应停在原地。

---

*报告结束。生成者：PRI-1294 Phase 4b Agent E（zcode）。分析基线 `3f068988c`；生产事实以该基线源码为准；引用行号均出自该基线。*
