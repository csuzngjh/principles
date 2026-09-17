# PRI-815 Trinity Simplification Spike — 调查报告

> **性质**：纯调查 / 只读架构 Spike。本报告不修改任何生产源码、DB/schema、CI、activation 或 RuleCode 管道，不创建 PR，不实现 PrincipleFormation。
> **状态**：In Review candidate（等待 Pipeline Safety Net v1.2 合并 + Owner 评审后才可进入实施）

---

## 0. 基线与方法

| 项 | 值 |
|---|---|
| BASE_SHA | `45e115363a8ac1aed30a42f0c027ca07032af791` |
| 验证方式 | `git ls-remote origin refs/heads/main` → `45e115363a8ac1aed30a42f0c027ca07032af791`（即 HEAD = origin/main tip，2026-09-17 16:04 +0800，PR #1741 merge） |
| BRANCH | `main` |
| WORKTREE | `D:/Code/principles`（主检出；未新建工作树，因为本任务零代码改动） |
| 起点状态 | 工作区仅有 2 个未跟踪审计文档（PRI-813 系列），无 modified 文件 |
| ⚠️ 环境注记 | 本机 `origin/main` 远程跟踪 ref 因沙箱无法持久化 ref 写入而停留在 `46495378`；**以 `ls-remote` 结果为准**，上文 BASE_SHA 已由 `ls-remote` 独立确认 |
| 生产证据源 | `D:/.openclaw/workspace/.pd/state.db`（**只读**打开：`new Database(path,{readonly:true,fileMustExist:true})`），schema_version 000/001/002 |
| 离线实验 | `D:/pd-probe-815/`（repo 外），复用仓库 `dist` 的真实 prompt builder 与 validator |

### 0.1 已遵守的硬约束

本报告全程未触碰：生产源码本体、DB/schema、runtime service、第二套 pipeline、activation/approval、RuleCode pipeline、CI / Safety Net、PR。
所有实验 harness 位于 `D:/pd-probe-815/`（repo 外），未写入生产 DB，未改动生产配置。**没有出现「必须改源码才能回答」的情形。**

### 0.2 关于 "Pipeline Safety Net v1.2 Final Candidate"——已从「材料缺失」升级为「直接复核」

**初版（2026-09-17 上午）**：该文件在本仓库、Linear Issues、Linear Documents（共 7 篇）中均未找到（grep 全仓 `docs/`、`.workbuddy/`、`tmp/`、`memory/`，并查询 Linear GraphQL `documents`）。当时 §10 的 Safety Net 兼容性分析**基于仓库现存的等价保护资产推断**，并显式标注为推断。

**增量复核（2026-09-17 晚）**：正式材料已就位并可完整读取：

| 文件 | 行数 | 说明 |
|---|---|---|
| `docs/specs/PD_PIPELINE_SAFETY_NET_V1_2_FINAL_CANDIDATE.md` | 1511 | **权威 SPEC**（Status: Final Candidate for Owner approval，Date 2026-09-17，Baseline at review = `45e11536…` 与本报告 BASE_SHA **一致**） |
| `docs/specs/PD_PIPELINE_SAFETY_NET_V1_2_BACKEND_EXECUTION_INSTRUCTIONS.md` | 1115 | 后端单 Session 实施指令（含 Phase A–E、Fault Injection、STOP 条件） |

⇒ §10 已**重写为直接对照该 SPEC 原文的兼容性复核**（不再依赖推断）。本报告其余章节（生产数据统计 / Consumer Map / A/B 原始结果 / Historical Defect Attribution）**未因该材料改动**——SPEC 原文未反驳其中任何一条结论。

**⚠️ 版本控制状态（必须记录的限定）**：这两份 SPEC **目前只存在于工作区，是未跟踪文件**，尚未进入版本历史：

```text
$ git status --short
?? docs/specs/PD_PIPELINE_SAFETY_NET_V1_2_FINAL_CANDIDATE.md
?? docs/specs/PD_PIPELINE_SAFETY_NET_V1_2_BACKEND_EXECUTION_INSTRUCTIONS.md

$ git cat-file -e origin/main:docs/specs/PD_PIPELINE_SAFETY_NET_V1_2_FINAL_CANDIDATE.md
fatal: path … exists on disk, but not in 'origin/main'
```

⇒ 本次复核的有效性边界：**针对 Owner 于 2026-09-17 交付的这份 Final Candidate 文本**（其自身 Status 亦为 *Final Candidate for Owner approval*），而**不是**针对一个已合并的冻结版本。若 Owner 在批准前修改 SPEC，§10 的复核需按修改点增量重做（结论方向预计不变：SPEC §1/§17 的 Trinity 授权段是其核心设计意图，非偶然措辞）。

**同时确认**：`check:pipeline-contract` 在 current main 上**尚不存在**（root `package.json` 无该 script，`verify:merge` 仍是 16 步且不含它），与 SPEC 的 Final Candidate 状态一致 —— Safety Net 尚未实施，本报告做的是**实施前的规格级复核**。

> 关键背景：SPEC 第 17 节有专门一节 **"Trinity Simplification Compatibility"**，逐条授权本报告推荐的收敛形态；第 1 节更把 Trinity 收敛列为**做 Safety Net 的直接动机之一**。这是本次复核最强的相容性证据。

---

## 1. Executive Verdict

### **VERDICT = SIMPLIFY_PARTIALLY**

**一句话结论**：Dreamer / Philosopher / Scribe 三者的**认知职责应当全部保留**，但其中只有 **Scribe（canonical Principle + intentContract）** 具备成为独立 durable governance boundary 的证据；Dreamer 与 Philosopher 作为**独立分布式生命周期**（task / lease / retry / recovery / NHR / 独立 lineage 身份）在代码、生产数据、历史缺陷归因与离线 A/B 四类证据上**均未找到产品需求的支撑**，应降级为同一条 PrincipleFormation 生命周期内的**认知步骤 + 非治理 checkpoint**。

**为什么不是 B（SIMPLIFY_TO_ONE_LIFECYCLE）**：Dreamer 的产物在**生产链路上有 2 条真实的、独立于 Philosopher 的消费通道**（Artificer F2、Evaluator Stage2）。把它们整体变成「纯 transient」会切断下游读取，必须保留**可被下游按 id 读取的 checkpoint（非治理）**。因此最终形态是「一条 durable lifecycle + 一个 canonical artifact + 两个非治理 checkpoint」，按任务书 §12 的分类落在 C。

**为什么不是 A（KEEP_CURRENT）**：A 的四项充分条件**一项都不成立**（详见 §12.1 逐条判定）。

**为什么不是 D**：样本量充足（56 条真实三阶段链路、41 条历史缺陷、12 组离线配对 A/B），无需 INCONCLUSIVE。

### 1.1 增量复核结论（2026-09-17 晚 · Safety Net v1.2 直接对照）

| 复核项 | 结果 |
|---|---|
| Safety Net v1.2 hard invariant（INV-01…INV-06 + C0） | **全部 PASS**（八行矩阵，§10.4） |
| 是否需要削弱任何 invariant 才能收敛 Trinity | **否** |
| 是否需要改产品 contract | **否**：authorization / revocation / provenance / runtime exposure / RuleCode 治理 全部零改动 |
| 是否需要改 test setup | **是**，且仅 fixture/断言级（3 项「锁错层」+ 4 项正常迁移），被 SPEC §17 `:1361-1369` 明文授权 |
| **TRINITY VERDICT** | **UNCHANGED —— 维持 SIMPLIFY_PARTIALLY** |

> 依据任务书判据：「如果只需要修改 test setup：这是正常迁移」⇒ **COMPATIBILITY = PASS**。SPEC 第 17 节的合格标准「**内部接线可以更新，Owner 可观察的行为断言无需削弱**」在本次复核对中被逐条满足。

---

## 2. Current Architecture Map

### 2.1 运行时事实

| 维度 | 事实 | 证据 |
|---|---|---|
| 六个 peer runner | `dreamer`, `philosopher`, `scribe`, `artificer`, `evaluator`, `rollout_reviewer` | `packages/principles-core/src/runtime-v2/internalization/peer-runner-contracts.ts:54-60`（常量表 `:189-196`） |
| 三条非 peer 诊断阶段 | `diag_rootcause`, `diag_distiller`, `diag_router`（同构的第二条多阶段边界，本报告不计入 Trinity） | `peer-runner-contracts.ts:68-71` |
| 任务存储 | **不存在 `pitask` 表**。六个 runner 与诊断任务**全部是同一张 `tasks` 表的行**；PI 专有字段以 `pi_metadata` 信封塞进 `tasks.diagnostic_json` | `store/sqlite-connection.ts:224-243`；`internalization/pitask-metadata.ts:39,472-496` |
| artifact 存储 | 三阶段**全部写 `artifact_kind='principle'` 到同一张 `pi_artifacts` 表**，靠 `source_task_id → tasks.task_kind` 反推阶段 | `internalization/dreamer-runner.ts:302-318`、`philosopher-runner.ts:314-327`、`scribe-runner.ts:379-391`；`candidate-lineage.ts:5-8` 注释原文「all internalization artifacts are `principle`」 |
| 状态机 | 6 态 9 边，**单一定义**，但**不是被强制的权威**（`failed→pending` 由裸 SQL 直写） | `internalization-task-guards.ts:111-134`；`store/lifecycle/recovery-sweep.ts:95-129`；`store/task/sqlite-task-store.ts:137-163` |
| DAG 边 | 全链 5 条线性边 `dreamer→philosopher→scribe→artificer→evaluator→rollout_reviewer`；prompt/`defer_archive` 通道 3 条边（跳过 artificer/evaluator）；**Dreamer 无任何旁路** | `internalization-job-graph.ts:35-41`（`ALLOWED_EDGES`）、`:52-56`（`PRINCIPLE_SEMANTIC_EDGES`）、`:63-70`（`CHANNEL_EDGES`） |
| 依赖边实现 | 线性单依赖：`dependencyTaskIds: [currentTask.taskId]`，`parentTaskId` 亦为前驱 | `internalization-state-machine.ts:375-384` |
| 共享基础设施 | 三阶段**完全同质**地共用 BasePeerRunner / lease / retry policy / recovery sweep / heartbeat 原语 | `runner/base-peer-runner.ts:183`（1462 行）、`store/lifecycle/lease-manager.ts:122-184`、`store/lifecycle/retry-policy.ts:87-119`、`store/lifecycle/recovery-sweep.ts:59-66` |

### 2.2 每个阶段的真实作用域

```
pain → diag_rootcause → diag_distiller → diag_router
                                            │
                                            ▼
        ┌──────────┐   ┌──────────────┐   ┌──────────┐   ┌──────────┐   ┌───────────┐
        │ Dreamer  │──▶│ Philosopher  │──▶│  Scribe  │──▶│ Artificer│──▶│ Evaluator │──▶ rollout
        │ 1–5 候选 │   │ 单一 thesis  │   │ 正式化 + │   │ RuleCode │   │  对抗验证 │
        │(独立 task)│   │(独立 task)   │   │intentCtr │   │          │   │           │
        └──────────┘   └──────────────┘   └──────────┘   └──────────┘   └───────────┘
             │                                      ▲            ▲
             └────────── 旁路消费（不经 Philosopher）────────────┘
```

**关键结构事实（本 Spike 最重的一条）**：Scribe 的 prompt **只接收 philosopher artifact**（`scribe-prompt-builder.ts:158-167`，payload 仅含 `philosopherArtifact` + 两个 id）。因此**Dreamer 的 1–5 个候选在 Scribe 处被结构性丢弃**。

`philosopher-runner.ts:321` 的注释声称会把 dreamer 五维「forward 到 `predecessorSummary` 以便 scribe 读取」，`SCRIBE_MANIFEST`（`context-manifests.ts:80-91`）也确实声明了 `philosopher.predecessorSummary.{badDecision,betterDecision,rationale,riskLevel,strategicPerspective}` —— 但这条通道有两个串联开关，且生产实测**从未生效**：

| 检查 | 结果 |
|---|---|
| `artifact_summary_redundancy` 默认值 | `enabled: false`（`feature-flag-contract.ts:340`） |
| 生产 workspace 实际值 | `enabled: false`（`D:/.openclaw/workspace/.pd/config.yaml:91-93`） |
| 生产 artifact 实测 | **33 个 dreamer + 63 个 philosopher + 56 个 scribe = 152 个工件中，带 `summary` 的 0 个、带 `predecessorSummary` 的 0 个** |
| 后果 | `SCRIBE_MANIFEST` 的 5 条 dreamer 路径**结构性 absent** → 恒 fallback 到全量 philosopher artifact 注入 → **Scribe 从未看到 Dreamer 的候选** |

这同时独立复现了历史审计 R-06（`docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md:94`）与 A-14（`d83cb2bb`），并把它从「偶发」升级为「生产 100% 发生的结构性丢失」。

### 2.3 Q1 —— 每个阶段的独有价值（逐阶段）

| 阶段 | 输入 | 输出 | 独有认知职责 | 只是格式转换？ | 有独立判断？ | 产生新语义？ | 被下游直接消费？ | **若删除 durable stage 但保留内部认知调用，最终 Principle 会失去什么？** |
|---|---|---|---|---|---|---|---|---|
| **Dreamer** | `diag_router` 产出的诊断（`dreamer-runner.ts:139-212`：`dependencyTaskIds` → 前驱 artifact → `predecessorOutput`） | `DreamerOutput{valid, taskId, candidates[1..5], sourcePrincipleId?, sourcePainId?, contextRefs, generatedAt}`（`dreamer-output.ts:47-64`） | **多候选发散**：每个候选带独立 `strategicPerspective`、`confidence`、`riskLevel`；5 个候选是 5 条互不相同的可执行纠正 | 否 | 是（每候选独立风险分级与置信度） | 是（5 条候选而非 1 条结论） | 是（Artificer F2、Evaluator Stage2 直读） | **会失去「纠正候选的多样性」**：Philosopher/Scribe 都会收敛为单一表述（生产实测 4.77 → 1 → 1），下游 Artificer/Evaluator 只能看到 `candidates[0]` 或整数组快照。**保留内部调用可避免此项损失** |
| **Philosopher** | Philosopher artifact **只接收 dreamer artifact**（`philosopher-runner.ts:186-220`）；`coreGrounding=true` ⇒ 注入 CORE AXIOMS 全文 | `PhilosopherOutputV1{sourceDreamerArtifactId, thesis, principleCandidate{title,rationale,scope,confidence}, risks[]}`（`philosopher-output.ts:22-29`） | **多候选收敛为单一 thesis**；表述 `scope`（适用边界）；枚举 `risks`；对照核心公理识别重叠/冲突（prompt 第 113 行明确要求） | 否（但见下） | 是 | 是（`scope`、`risks`、`thesis` 三项为 Dreamer schema 所无） | 生产上**否**（唯一结构化消费者是 Scribe）；UI/audit 侧有 | **会失去 3 项**：(a) 候选收敛的**单一化表述**；(b) `applicability`/`scope` 的边界描述（实测存活进 Scribe）；(c) `risks`（实测 83.2% 存活进 canonical artifact）。**但这 3 项的认知价值可由同 lifecycle 内的 critique 步骤保留** |
| **Scribe** | Scribe 只接收 philosopher artifact（`scribe-prompt-builder.ts:158-167`），`coreGrounding=true` | `ScribeOutputV1{sourcePhilosopherArtifactId, principleDraft{title,statement,rationale,applicability[],antiPatterns[],confidence}, sourceTrace, risks[], intentContract?}`（`scribe-output.ts:30-46`） | **哲学表述 → 可执行/可校验契约**：`statement`/`applicability`/`antiPatterns`，以及 `intentContract` 五字段（Owner 意图 / 目标行为 / 禁止行为 / 证据来源 / 验证期望） | **部分**（title 80.4% 逐字节复制 Philosopher，但 new statement/applicability/antiPatterns/intentContract 是新增） | 是（独立做 core-axiom 重叠检查——实测 s00 中 Scribe **自加**了 Philosopher 没有的 T-01..T-07 重叠告警） | 是（`intentContract` 是全链唯一的机器可校验对齐锚） | **是，9+ 条独立生产消费者**（含运行时激活与 Owner 治理） | **会失去 canonical Principle 与 intentContract 本身** —— 这是全链唯一同时触碰 Owner authority 与 runtime effect 的产物，**不可删除** |

**Q1 综合判定**：

- 三个阶段的认知职责**都有真实内容**，没有一个是纯格式转换；且每个都有独立判断（Dreamer 的风险分级、Philosopher 的公理冲突识别、Scribe 的公理重叠检查）。
- 但**只有 Scribe 的输出有不可替代的独立消费者**；Philosopher 的输出消费者 **0 个**（除下一阶段）；Dreamer 的输出消费者有 2 个，但都通过 `candidates[0]`/整数组快照读取，**不需要 Dreamer 作为独立生命周期**。
- **关键结论**：删除 Dreamer/Philosopher 的 **durable stage**（而非认知步骤）导致的损失是**可枚举且可补偿的**——只要 (a) Dreamer 的候选集以 checkpoint 形式持久化、(b) critique 步骤保留在同一 lifecycle 内。而删除 Scribe 的 durable 边界会导致 canonical artifact 与 governance 落点整体消失，不可接受。

**补充观察**：`scribe-output.ts:35` 的 `risks` 是**必填字段**，实测 Philosopher 的 risks 有 **83.2%** 存活进 Scribe 的 risks（§8.3）——即 risks 通道是贯通的，Philosopher 的 risk 职责确实传到了 canonical artifact。但 **`scope` 在 Scribe 处被改名/展开为 `applicability` 数组**，而 Dreamer 的 5 候选**没有任何一条通道进入 Scribe**。

### 2.4 问题答复索引

| 问题 | 章节 |
|---|---|
| Q1 独有价值 | §2.3 |
| Q2 中间 artifact 消费者 | §3 |
| Q3 独立 pause/approve/recover 边界 | §4 |
| Q4 复杂度成本 | §5 |
| Q5 历史缺陷归因 | §6 |
| Q6 Philosopher 的质量增益 | §7–§8 |

---

## 3. Consumer Map（Q2）

> 判定口径：**「独立消费者」= 不经过下一阶段、直接读取该 artifact 的生产代码路径**。仅由下一阶段读取的，单独标注为**非独立**。

### 3.1 Dreamer artifact

| 消费者 | 位置 | 类别 | 读的字段 | 独立？ |
|---|---|---|---|---|
| Philosopher | `philosopher-runner.ts:186-220` | 生产（下一阶段） | 整个 contentJson | **否** |
| Artificer F2 通道 | `artificer-runner.ts:254-370`（`resolveDreamerContext`）、调用点 `:814-819`、进 prompt `:917` | 生产 | `candidates[0].{badDecision,betterDecision,rationale,riskLevel,strategicPerspective}` | **是** |
| Artificer manifest tier2 | `context-manifests.ts:134-138`、使用点 `artificer-runner.ts:871-878` | 生产（flag 依赖） | `dreamer.raw.candidates.0.*` | **是（仅 1 个候选）** |
| Evaluator Stage1 manifest | `context-manifests.ts:248-251` | 生产（**结构性 absent**，见 §2.2） | `dreamer.summary.*` | 名义是、实际恒 absent |
| Evaluator Stage2 manifest | `context-manifests.ts:298-304`、使用 `evaluator-runner.ts:826-833` | 生产（需 `progressive_evaluator`，生产已 ON） | `dreamer.raw.candidates`（**整个数组**） | **是** |
| Scribe | — | — | **无**（见 §2.2） | 否（结构上不读） |
| Console Owner 评审 UI | `pd-console/src/server/models/ApprovalsGroupedConsoleModel.ts:104-112` | debug/UI | `candidates[0].betterDecision` | 是（UI 侧） |
| Dreamer 自身遥测 | `dreamer-runner.ts:388-396` | 自读 | candidateIndex/confidence/riskLevel | 否 |

**结论**：Dreamer artifact **有 2 条真实独立生产通道**，但两条都**只取 `candidates[0]` 或整数组**，且都不需要 Dreamer 作为独立生命周期——只需要旧产物在 DB 里可读。

### 3.2 Philosopher artifact

| 消费者 | 位置 | 类别 | 独立？ |
|---|---|---|---|
| Scribe | `scribe-runner.ts:212-265`；`scribe-prompt-builder.ts:149-172` | 生产（下一阶段） | **否** |
| Scribe manifest 透传 | `context-manifests.ts:123`（`scribe.predecessorSummary.headline`） | 生产（下一阶段的一部分） | **否** |
| Console Owner 评审 UI | `ApprovalsGroupedConsoleModel.ts:97-101`（读 `principleCandidate.title`） | debug/UI | 是（UI 侧） |
| `mainline-snapshot-assembler.ts:426-438` | 读 `principleCandidate.principleId` —— **该字段在 `philosopher-output.ts:15-20` 的 schema 中不存在**（legacy 死字段） | debug，无效读取 | 名义是 |
| Philosopher 自身 summary 派生 | `artifact-summary.ts:252-264` | 写侧，flag 关闭 → 不写 | 否 |

**结论**：**Philosopher artifact 不存在任何独立于 Scribe 的真实生产消费者**（唯一两个"独立"一个是 UI、一个是读不存在字段的 legacy 死代码）。

### 3.3 Scribe artifact（= 代码中的 canonical Principle）

| 消费者 | 位置 | 类别 |
|---|---|---|
| Artificer（RuleCode 生成） | `artificer-runner.ts:800-830`、`extractIntentContract` `:898` | 生产（直系后继） |
| Evaluator | `evaluator-runner.ts:521-534,800-870,3343-3345` | 生产（**独立**） |
| Rollout Reviewer（principle_semantic） | `rollout-reviewer-runner.ts:447-479,517-536` | 生产（**独立**） |
| Owner Decision Review（治理面） | `owner-decision-review.ts:305-343,374-431`；`OwnerDecisionConsoleModel.ts:126-151` | 生产（治理） |
| 运行时 prompt 激活 | `activation/prompt-activation-reader-contract.ts:88-93`；`host-runtime/src/active-principle-prompt.ts:69-84` | 生产（**运行时**） |
| 激活决策 / principleId | `activation/low-risk-writers.ts:21-26`；`activation-dispatcher.ts:310,346` | 生产 |
| 规则回执 metadata | `openclaw-plugin/src/core/principle-receipt-metadata.ts:85-91,128-136` | 生产 |
| Console 三处 | `ApprovalsGroupedConsoleModel.ts:87-95`、`ApprovalsConsoleModel.ts:246`、`ActivationsConsoleModel.ts:301` | 生产/UI |
| 轨迹 & 治理 read model | `PrincipleTrajectoryModel.ts:255-292`、`GovernanceProjectionCollector.ts:152-155` | 只读元数据列 |
| pd-cli 主链 | `rulehost-pipeline-runner.ts:941-1008` | 生产 |

**结论**：Scribe artifact **有 9+ 条独立生产消费者，含运行时激活与 Owner 治理面**。它是当前事实上的 canonical Principle 载体（`evaluator-runner.ts:3343-3345` 原文：「the Scribe artifact carries principleDraft」）。**Scribe 不可能被合并掉。**

---

## 4. Governance / Recovery Boundary Map（Q3）

### 4.1 结论先行

**不存在独立的 Owner governance boundary，也不存在独立的 recovery boundary 落在 Dreamer↔Philosopher↔Scribe 之间。**真实的边界全部集中在链路末端（evaluator / rollout_reviewer / 激活审批）。

### 4.2 三重硬编码证据（D→P 与 P→S 之间无门）

| 证据 | 内容 | 位置 |
|---|---|---|
| 迁移仲裁无条件 ADVANCE | `decideInternalizationTransition` 对非决策型 runner（dreamer/philosopher/scribe/artificer 常规）**无条件返回 `ADVANCE`** | `internalization-transition-decision.ts:126-127` |
| `needs_human_review` 的三个前段 runner 零命中 | 全仓 grep：`dreamer-runner.ts` / `philosopher-runner.ts` / `scribe-runner.ts` 对 `needs_human_review` **零命中**；只有 `evaluator-runner.ts:1641`、`rollout-reviewer-runner.ts:1146` 会写 | — |
| Owner 决策面结构上排除前段 | `deriveOwnerDecisionCapability` 硬门：`if (task.taskKind !== 'evaluator' && task.taskKind !== 'rollout_reviewer') return infeasible('task_kind_not_decision_capable')` | `owner-review.ts:502-504` |

### 4.3 逐机制边界归属

| 机制 | 治理粒度 | 落在哪一段 | D↔P 之间可打断？ |
|---|---|---|---|
| Owner review / decision | 单任务，且**仅** evaluator / rollout_reviewer | evaluator 之后、激活之前 | **否** |
| Owner retry | 单任务，仅 `needs_human_review` | 仅由 evaluator/rollout 产生 | **否** |
| revision reopen | 单任务；**修订目标被穷举为 `'scribe' \| 'artificer'`** | `artificer_repair_complete→evaluator`、`owner_revise_once→target` | **否**（dreamer/philosopher **永不可达**） |
| repair / replay | evaluator 的对抗重放证据 | evaluator 侧 | **否** |
| recovery sweep（租约超时） | 单条 task 行，**任何 kind** | 与阶段无关 | 形式上能，但**无人工、无审批** = 通用基础设施 |
| stalled read model | 硬编码 `taskKind === 'diagnostician'` | 只覆盖诊断父任务，**6 个 peer runner 无 stalled 读模型** | 不适用 |
| 激活审批 ApprovalQueue | artifact 级 | rollout 之后 | 不适用 |

### 4.4 STRUCTURAL_OVERHEAD 判定（"代码支持" ≠ "产品需要"）

| # | 机制 | 证据 | 判定 |
|---|---|---|---|
| A | `renewLease`（心跳/续租） | 定义 `lease-manager.ts:226-270`；**全仓除定义与测试外零调用者** | **零生产入口** |
| B | 三振出局 → 人工升级（`recordRejection` / `decideArtifactRejectionFeedback`） | 唯一调用者是 `task-three-strikes.test.ts` / `runnerkind-seam.test.ts`；`rejectionCount` 生产上恒 0 ⇒ `isUnresolvable` 永不触发 | **该 Owner 升级路径从未在产品中发生** |
| C | `workspace_dirty → needs_human_review` | `'workspace_dirty'` 作为 lastError 的**生产写入者不存在**（仅 `error-categories.ts` 定义 + 测试） | **只有测试能触发** |
| D | `stalled-diagnostician-task-read-model` | 硬编码排除 6 个 peer runner | Trinity 无 stalled 治理面 |
| E | 三阶段各自的 retry/recovery | 全部来自 `BasePeerRunner.retryOrFail`（`:775-919`）+ 通用 `retry-policy.ts:87-119` + 通用 `recovery-sweep.ts:59-66` | **基础设施继承，无差异化产品需求** |
| F | `philosopher` 的 enabled 开关 | 默认 `false`（`pd-config-defaults.ts:64`）| 见 §4.5，**架构上失效** |
| G | 渐进披露三层 | `artifact_summary_redundancy` / `context_manifest_budget` / `progressive_evaluator` 默认全 `false`；生产把后两者开成 `true` 但依赖的第一层仍 `false` ⇒ 见 §2.2 实测 0/152 | **"打开也不通"** |

### 4.5 一个高价值反证：Philosopher 的存在开关是架构上失效的

| 事实 | 位置 |
|---|---|
| 默认配置中 `philosopher: enabled=false` | `pd-config-defaults.ts:61-75` |
| 但 DAG / 编排**完全不读这个开关**：`createNextTaskProposal()` 签名无 config 参数、`InternalizationOrchestratorDeps` 只有 `{ stateManager }` | 见 `philosopher-toggle-characterization.test.ts:16-26` 的正式 characterization 结论 |
| 后果：`philosopher.enabled=false` 时 philosopher 后继**照常创建、照常可租约** | 同上 |
| 开关真正的作用：adapter 解析时**拒绝整条运行**（`agent_runtime_resolution_failed`，exitCode 1） | `pd-cli/src/commands/runtime-internalization-run-rulehost.ts:124-126,417-428` |
| 结论 | **不存在「跳过 philosopher」的链形态**：要么 philosopher 跑，要么整条链被拒 |

这意味着：产品曾试图让 Philosopher 可关，但因为拓扑被硬编码成三节点线性链，`关` 只能实现为「整链瘫痪」。**这正是 durable boundary 与认知职责被错误耦合的自证。**

---

## 5. TRINITY_COMPLEXITY_INVENTORY（Q4）

### 5.1 定量清单

| # | 维度 | 计数 | 代表位置 |
|---|---|---|---|
| 1 | PeerRunnerKind | 6 | `peer-runner-contracts.ts:55-60` |
| 2 | 三阶段 runner 实现 | 397 + 405 + 488 = **1290 行** | `dreamer/philosopher/scribe-runner.ts` |
| 3 | 共享父类 | `BasePeerRunner` **1462 行** | `runner/base-peer-runner.ts:183` |
| 4 | output schema + validator | 3 schema + 3 手写 validator 类（510 行）；1 个 registry + ≥4 个注入点 | `dreamer-output.ts:117`、`philosopher-output.ts:69`、`scribe-output.ts:98`；`adapter/output-schema-registry.ts:41-43`；注入点 `host-runtime/src/internalization-consumer-cycle.ts:598/604/610`、`pd-cli/src/commands/runtime-internalization-run-once.ts:580/587/594`、`pd-cli/src/services/rulehost-pipeline-runner.ts:337/354/370` |
| 5 | prompt builder | 139 + 146 + 173 = **458 行** | `*-prompt-builder.ts` |
| 6 | PIArtifactKind 枚举 | 4（`principle`/`rule`/`skill`/`patch`）；**三阶段全部写 `principle`** | `peer-runner-contracts.ts:86-89` |
| 7 | 跨阶段命名身份字段 | **6 个**：`sourceDreamerArtifactId`、`sourcePhilosopherArtifactId`、`sourceTrace.philosopherArtifactId`、`sourceTrace.dreamerArtifactId`、`sourceScribeArtifactId`、`sourceTrace.scribeArtifactId` | 见 §5.2 |
| 8 | 身份语义复刻 | 三阶段 id 在 `artificer/evaluator/rollout-reviewer` 的 `sourceTrace` 命名空间内**各自再复刻一遍 = 3×3 = 9 处** | `artificer-output.ts:10-12,72-74` 等 |
| 9 | durable 血缘数组 | `pi_artifacts.lineage_artifact_ids`（无类型字符串数组，由 `CandidateLineage` BFS 遍历，459 行，含 PRI-717 重绑定/环检测/深度限制） | `candidate-lineage.ts:38-114,200-370` |
| 10 | transition decision kind | 7 | `internalization-transition-decision.ts:26-38` |
| 11 | 状态转移边 | 9 | `internalization-task-guards.ts:111-134` |
| 12 | recovery sweep 分支 | 3 | `recovery-sweep.ts:101/111/121` |
| 13 | recovery decision point（阶段级） | 每阶段各 1 组（retry_wait / needs_human_review / failed）= **3 组** | `base-peer-runner.ts:852-883,885-918` |
| 14 | telemetry 事件常量 | **97**（`telemetry-event.ts` 中含三阶段名的 `Type.Literal` 行；去重字符串 103） | 单一注册表 `packages/principles-core/src/telemetry-event.ts` |
| 15 | 专职测试 | **16 文件 / 5031 行** | 见 §5.3 |
| 16 | 触及三阶段的测试文件 | **193 / 991**（19.5%） | 见 §5.3 |
| 17 | 生产特判分支（严口径，排除 `__tests__` 与 `dist`） | **68** | 见 §5.3 |
| 18 | DB 写入面 | 3 表（`tasks` / `runs` / `pi_artifacts`）+ 1 JSONL（`<ws>/.pd/telemetry/critical-events.jsonl`） | `sqlite-task-store.ts:107,156,229`、`sqlite-run-store.ts:98,174`、`sqlite-pi-artifact-store.ts:48,79`、`workspace-telemetry-emitter.ts:58,76` |
| 19 | read model / console model | 4 个 core read-model + 8 个 console 文件 | `internalization-chain-integrity-read-model.ts`（17 处）、`Activations/Approvals/ApprovalsGrouped/EvidenceChain/GovernanceConsoleModel` |

### 5.1.1 可复现命令

```bash
cd /d/Code/principles
# #14 telemetry 事件常量
grep -c "Type.Literal('dreamer\|Type.Literal('philosopher\|Type.Literal('scribe" \
  packages/principles-core/src/telemetry-event.ts            # → 97
# #15 专职测试文件与行数
find packages -type f \( -name '*.test.ts' -o -name '*.spec.ts' \) \
  -not -path '*/node_modules/*' -not -path '*/dist/*' | grep -Ei 'dreamer|philosopher|scribe' | wc -l   # → 16
find packages -type f \( -name '*.test.ts' -o -name '*.spec.ts' \) \
  -not -path '*/node_modules/*' -not -path '*/dist/*' | grep -Ei 'dreamer|philosopher|scribe' | xargs wc -l | tail -1  # → 5031
# #16 触及三阶段的测试文件
grep -rlE '\b(dreamer|philosopher|scribe)\b' --include='*.test.ts' --include='*.spec.ts' \
  --exclude-dir=node_modules --exclude-dir=dist packages | wc -l   # → 193
# #17 生产特判分支（严口径）
grep -rEo "(===|!==) ?['\"](dreamer|philosopher|scribe)['\"]|case ['\"](dreamer|philosopher|scribe)['\"]|['\"](dreamer|philosopher|scribe)['\"] ?(\|\||&&)|(includes|startsWith)\(['\"](dreamer|philosopher|scribe)['\"]\)" \
  --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=__tests__ packages | wc -l   # → 68
```

> ⚠️ 在 Git Bash 下这些命令需先 `export PATH="<PortableGit>/mingw64/bin:<PortableGit>/usr/bin:/c/Windows/System32:/c/Windows"`（本机 PATH 默认无 coreutils）。

### 5.2 跨边界数量（Identity Edges）—— 复杂度真正的来源

| 边 | typed 命名身份字段 | durable 数组 | 合计 |
|---|---|---|---|
| Dreamer → Philosopher | `sourceDreamerArtifactId`（`philosopher-output.ts:24/42`，校验 `:85-86`，强校验 `philosopher-runner.ts:270-275`） | `lineageArtifactIds`（`philosopher-runner.ts:318`） | **2** |
| Philosopher → Scribe | `sourcePhilosopherArtifactId`（`scribe-output.ts:32/64`）、`sourceTrace.philosopherArtifactId`（`:27/59`） | `lineageArtifactIds`（`scribe-runner.ts:383`） | **3** |
| Dreamer → Scribe（传递式） | `sourceTrace.dreamerArtifactId`（`scribe-output.ts:26/58`，`extractSourceDreamerArtifactId` 从 philosopher 的 `sourceDreamerArtifactId` **改名映射**） | — | **1** |
| Scribe → Artificer | `sourceScribeArtifactId`、`sourceTrace.scribeArtifactId`（+ 传递式 `sourceTrace.{philosopher,dreamer}ArtifactId`） | `lineageArtifactIds` | **3（+2 传递式）** |
| 全仓字段命中文件数 | `scribeArtifactId` **111**、`sourceArtifactId` **88**、`philosopherArtifactId` **74**、`dreamerArtifactId` **61** | | |

**结论**：主干只有 **3 跳**，却衍生出 **6 个命名身份字段 + 9 处 trace 复刻 + 1 个 durable 数组 + 一套 BFS 遍历器**。这才是 Trinity 复杂度的主要来源——**不是认知步骤，而是跨持久化边界的身份持有**。

### 5.3 生产数据侧的同源证据

| 观测 | 值 | 含义 |
|---|---|---|
| 生产 `tasks` 中 dreamer 行 | 33 succeeded + 12 pending | |
| 生产 `tasks` 中 philosopher 行 | **63 succeeded**（无 pending） | 约 1.9× dreamer |
| 单 -dreamer-artifact 的 philosopher 扇出 | `[1,1,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,11,2,2,2,3,15]` | **同一 dreamer 产物的 philosopher 任务数最高 15、次高 11** |
| 唯一 dreamer / philosopher / scribe artifact | 32 / 55 / **56** | 32 个真实提案 → 56 个 canonical 候选 = **1.75× 放大** |
| 三阶段 artifact 全部 `artifact_kind='principle'` | 317 个 principle + 3 个 rule | 阶段身份只能靠 join `tasks.task_kind` 反推 |

**「一个 dreamer 产物被重跑 15 次 philosopher」是 Trinity durable boundary 制造纯协调成本的最直接生产证据**：每次重跑都要新建 task 行、run 行、lease、retry 状态、artifact 行，而输入完全没变。

---

## 6. Historical Defect Attribution（Q5）

### 6.1 归因分布（41 条样本）

| 归类 | 条数 | 占比 |
|---|---|---|
| **A — 与 Trinity durable boundary 强相关** | **15** | **36.6%** |
| B — 普通 bug（合并三段也修不掉） | 14 | 34.1% |
| C — 其它子系统 | 12 | 29.3% |

> 若把命题放宽为「多阶段 durable boundary 这一类」，诊断链（rootcause→distiller→router）同构的 4 条应并入 → **19/41 = 46.3%**。本报告主口径取 36.6%。

### 6.2 A 类集中在四个机制

1. **跨阶段持久 ID 的持有与失效**（A-2/A-3/A-4/A-11/A-13，占 A 类 1/3）
   - PRI-541 `b334027b`：LLM 回显长 ID 被截断 ⇒ `output_invalid` 永久失败
   - PRI-717 `2a16f352`：上游 revision 重跑覆写 `artifact_id` ⇒ 跨阶段 lineage 边悬空、BFS 塌缩到起点
   - `LINEAGE_CHAIN.md:99,168-182,291`：`pi_artifacts UNIQUE(source_task_id, artifact_kind)` + `DO UPDATE SET artifact_id=excluded.artifact_id` ⇒ **instance id 可回收**，approval/activation 绑 id 不绑内容 ⇒ 悬空且无失效机制
2. **跨阶段字段命名契约**（A-1/A-12/A-14/A-15）
   - R-01：生产者写 `sourceDreamerArtifactId`、scribe prompt 教模型写 `dreamerArtifactId` ⇒ artificer `resolveDreamerContext` 三处 `return undefined` **零事件静默**（已于 `eaa2d72b`/`48fc0a75` 修复）
   - A-12：dreamer 的 1–5 候选在 philosopher 处坍缩为 `candidates[0]`，「候选多样性」是幻觉产能（`REPORT.md:122,1342`）
   - A-14 `d83cb2bb`：evaluator manifest 的跨两跳祖先 summary 路径**结构上永远 absent**（`readSummaryField` 只读单一前驱）⇒ 恒 fallback
3. **跨阶段迁移裁决的缺失/多权威**（A-5/A-6/A-10）
   - PRI-718 `7b310c9a`：「revise is not resume」——反复评估**已被取代的同一 artifact**
   - `c41e9103`：`needs_revision` 未阻断正常 successor ⇒ 双播种
4. **阶段完成与链路推进被切成两次 durable 写**（A-7/A-8/A-9）
   - `c40984e6` verdict drift（T1–T4 四类副作用与 durable verdict 矛盾）
   - `fda57961`/`b452b836`：`markTaskSucceeded` 与 `commitNextTaskProposal` 之间的崩溃窗口产生孤儿 succeeded

### 6.3 明确不作为 A 类的（避免过度归因）

- **B-1** `tasks.attempt_count` 双源（`WRITER_AUTHORITY_MATRIX.md:231-246`）：虽然表现为 duplicate state 且被 revision reopen 触发，但合并 D/P/S**不会消除 task 级重试计数器** ⇒ 判 B。
- **B-4** 空 `requiredChanges` 使 `parsePITaskMetadata` 整块返回 null：解析器原子性设计问题 ⇒ B。
- **B-5/B-7/B-8** prompt↔schema 漂移（artificer 示例违反自身契约、scribe `intentContract` 为兼容旧产物用 `Type.Optional(Type.Unknown())`、rollout 空 requiredChanges 无硬约束）⇒ B。
- **C 类**：拓扑通道路由、宿主能力对等（Codex 无 shadow 通道）、安全沙箱 R-19、Console 授权不对称、`verify:merge` 组成、Owner inbox 分类 ⇒ 与 Trinity 无关。

---

## 7. A/B Method（Q6 实验设计）

### 7.1 为什么用真实历史数据 + 补充离线 A/B

历史数据**部分足以**回答 Q6，但有两处不足，故补做离线 A/B：
- 生产链路的 A（D→P→S）有 56 组完整三元组，可用于度量 **B 的对照物**；
- 但历史数据里**不存在 B（无 Philosopher）的产物**，无法直接比较最终质量；
- 且历史 A 由生产模型（`deepseek-v4-flash` 等）生成，与 B 必须同模型才能公平比较。

### 7.2 实验设计（MEASURED）

| 项 | 设计 |
|---|---|
| 样本 | **12 组**，取自生产库中 32 个**不同 Dreamer 产物**（按时间分层抽样）。固定输入 = 真实 Dreamer 产物 ⇒ 消除上游方差，使 delta **只反映 Philosopher 的贡献** |
| 配对 | 同一 Dreamer 输出同时喂给两条臂（paired design，A 与 B 共用同一次 Dreamer 调用） |
| Arm A | `Philosopher(realDreamer)` → `Scribe(philosopherOut)`，**复用仓库真实 prompt builder**（`dist/runtime-v2/internalization/*-prompt-builder.js`），coreGrounding=true，与生产一致 |
| Arm B1b | `Scribe(realDreamer)`，**对 Scribe instruction 做最小适配**：`philosopherArtifact→dreamerArtifact`、`sourcePhilosopherArtifactId→sourceDreamerArtifactId`、`the Philosopher's analysis→the Dreamer's analysis` 等 7 处字符串替换，其余**逐字节不变** |
| 模型 / 参数 | `glm-5.3`（ZAI，生产 profile 家族之一），`temperature=0`，`max_tokens=8000`，两臂完全一致 |
| 校验 | 复用仓库真实 `DefaultPhilosopherValidator` / `DefaultScribeValidator`（**未修改**） |
| 参照臂 | `A*`=生产真实 Scribe 产物（零成本），用于确认复刻保真度 |
| 未执行 | **B1a（naive deletion，Scribe instruction 完全不改）**：设计完成但未运行；其成本已在 B1b 的 lineage 校验失败中体现（见 §7.4） |
| B2（propose+critique+formalize 同一 lifecycle） | **仅设计未实现**：按任务书 §1「Do NOT implement PrincipleFormation」，其 runtime 与 A 完全相同（3 次 LLM 调用），差异是纯结构性的，故用**结构静态估算**并标注 ESTIMATED |

### 7.3 缺失与限制（诚实声明）

- **样本 12 组**，低于任务书建议的 10–20 上限区间内但偏小；受限于「生产库中带可解析上游诊断的独立 Pain 仅 9 个」，故改用以 Dreamer 产物为固定输入的设计把样本扩到 12（不同 Dreamer 产物共 32 个，本次抽样 12）。
- **判分模型非生产模型**（`glm-5.3` 判 `glm-5.3` 生成的产物）；按任务书 §7 要求，**LLM judge 仅作辅助**，主判据是确定性指标与真实 validator。
- 12 组样本中带 dreamer 候选计数的为 0（harness 未落 `dreamerOut` 字段，已按 artifact id 从生产 `chains.json` 回填）。
- 生产数据全部来自**单一 canonical workspace**（`D:\.openclaw\workspace`），非多用户样本。

### 7.4 一个必须记录的实验副产品：合并会暴露 2 个身份字段

B1b 的产物在**未修改的** `DefaultScribeValidator` 下 **12/12 失败**，且失败原因**只有两条**：

```
["sourcePhilosopherArtifactId must be non-empty string",
 "sourceTrace.philosopherArtifactId must be non-empty string"]
```

对 B1b 产物做**规范 B1 映射**（把 `sourceDreamerArtifactId`→`sourcePhilosopherArtifactId`、`sourceTrace.dreamerArtifactId`→`sourceTrace.philosopherArtifactId`，即"删掉 Philosopher 节点后必然要做的机械改名"）后重新校验：**11/12 通过**，唯一失败样本是 `generatedAt must be non-empty string`（模型输出抖动，与结构无关）。

**这说明：合并的真实结构化迁移成本可被穷举为「2 个 lineage 字段名 + 1 处 validator 期望参数」，而不是不可控的质量损失。** 这与 P2「Minimal Change Surface」一致，也是把该工作分类为 `MIGRATION_COMPAT_ONLY` 而非架构风险的依据。

---

## 8. A/B Results

### 8.1 运行时 / 协调指标（MEASURED，n=12）

| 指标 | Arm A（P→S） | Arm B1b（仅 S） | 差异 |
|---|---|---|---|
| LLM 调用数（P→S 段） | 2 | 1 | −1 |
| 输入 token 合计 | 39,730 | 24,342 | −38.7% |
| 输出 token 合计 | 63,571 | 47,918 | −24.6% |
| **段内 token 合计（均值）** | **8,608** | **6,022** | **Philosopher 带来 +43.0%** |
| 串行 wall-clock 均值 | 123,732 ms | 91,674 ms | −25.9% |
| 单次调用均值（philosopher / scribe） | 43.1 s / 80.6 s | — / 91.7 s | — |
| 错误数 | 0 | 0 | — |

**反直觉但重要的发现**：删掉 Philosopher **不会降低 Scribe 单次调用的成本**（B1b 的 scribe 调用 6,022 token **高于** A 的 5,469 token），因为 5 个原始候选直接进入 prompt 反而更长。**省下的是那一次 philosopher 调用本身**。若走 B2（三步同一 lifecycle），token 成本与 A 持平，收益**纯结构性**。

### 8.2 结构与完整性指标（MEASURED，均值）

| 指标 | A（P→S） | B1b（直接） | A*（生产真实） |
|---|---|---|---|
| schema 校验通过（原始） | 12/12 | **0/12**（仅 2 个 lineage 字段名） | n/a |
| schema 校验通过（规范 B1 改名后） | — | 见下 | n/a |
| `principleDraft.applicability` 条数 | 4.58 | 4.00 | 3.50 |
| `principleDraft.antiPatterns` 条数 | **5.58** | 4.83 | 3.92 |
| `risks` 条数 | 4.92 | 4.67 | 3.50 |
| `intentContract` 5 字段齐全 | **5.00 / 5** | **5.00 / 5** | 0.42 / 5 |
| `intentContract` 总字符 | 1,712.8 | 1,440.2 | 128.8 |
| statement 长度 | 613.3 | 473.9 | 442.1 |
| core-axiom（T-xx）提及次数 | 9.00 | 5.42 | 4.67 |
| 产物总字符 | 5,979.8 | 4,966.6 | 3,433.8 |
| confidence | 0.81 | 0.85 | 0.86 |

**读法**：A 的产物**更宽**（antiPatterns +0.75、applicability +0.58、T-xx 提及 +3.58、statement +139 字符），B1b **更紧**且 confidence 略高。两者在**最关键的可机检契约**（intentContract 5 字段齐全）上**打平**。

### 8.3 生产真实数据侧的质量证据（MEASURED，n=56）

| 指标 | 值 | 含义 |
|---|---|---|
| Philosopher 标题 == Scribe 标题（逐字节相同） | **45 / 56 = 80.4%** | **Philosopher 事实上已经决定了 canonical title**；Scribe 大多在复述 |
| Philosopher risks 存活进 Scribe risks 的比例（bigram 包含 > 0.5） | 均值 **0.832**，中位 **1.0** | risks 通道贯通，Philosopher 的 risk 认知**确实到达了 canonical artifact** |
| `intentContract` 存在率 | 30 / 56 | 旧产物缺（向后兼容设计） |
| Dreamer 候选数 | 均值 4.77，中位 5 | Dreamer 稳定产出 5 个多视角候选 |
| Dreamer 候选进入 Scribe 的通道 | **0 条**（§2.2 实测 0/152 带信封） | **5 个候选 → 1 个 thesis → canonical**，多样性在此断裂 |

> ⚠️ **度量告诫**：本次尝试用 bigram Jaccard 度量「Philosopher 是否只是复述 Dreamer」，实测均值 0.035。但该指标**被两件事污染**：(a) 56 组中 50 组同语言但存在大量改写（paraphrase）；(b) 早期样本 Dreamer 英文 / 后续 Dreamer 中文。**因此本报告不把词面重叠当作「语义新颖度」证据**，Q6 的结论改由 §8.2 的结构指标 + §8.4 的定性审读 + §8.5 盲评共同支撑。

### 8.4 定性审读（3 组完整链路人工比对）

**样本 s00（2026-09-01）**：
- Dreamer 给出 5 个**互不相同**的候选，各自带独立战略视角：`model_before_act`(0.92, high)、`intent_alignment`(0.90, high)、`evidence_driven`(0.88, high)、`safety_first`(0.85, high)、`verify_after_act`(0.87, medium)。
- Philosopher 把 5 个候选**合成一句五连复合格言**：*"Understand before acting; act with intent, evidence, safety, and verification."* 其自陈 risks 即承认 *"The principle is broad and may be difficult to apply consistently"*。
- Scribe **逐字节沿用 Philosopher 标题**，把 statement 展开，risks 抄 3 条 + 自加 1 条：*"Overlaps significantly with core axioms T-01, T-02, T-03, T-04, T-07 — this principle serves as a meta-synthesis but may introduce redundancy."*
- **判读**：这一组里 Philosopher 的合成**降低了特异性**（5 条可执行纠正 → 1 条泛格言），而 Scribe 独立地补上了核心公理重叠告警（说明 axiom-overlap 检查**不是 Philosopher 独有**，Scribe 也带 `coreGrounding`）。
- **反例**：另有两组 Philosopher 的 risks 明确点出与 `T-06`（最简单干预）的潜在冲突——那是 Dreamer **没有**提供的约束识别。所以 **Philosopher 的认知贡献是真实存在的（冲突识别 + 收敛 + scope），但它是"时好时坏"的**：它既可能提升边界条件识别，也可能抹平行为特异性。

**样本 s00 的 B1b 侧**：*"Build an Explicit System Model Before Consequential Change"*，其 intentContract 的 `evidenceSource` 甚至能引用 `strategicPerspective 'model_before_act'` 与 `sourcePrincipleId T-01` —— **这是 Philosopher 产物中被剥掉的元数据，B1 反而保住了**。

### 8.5 盲评（LLM judge，辅助）

**设置**：12 组，每组把 A 与 B1b 随机标为 X/Y（顺序逐样本随机、记录于 `ab2/_judge_*.json`），judge 不知道臂归属。8 维度 × 0–10（满分 80）+ winner + 理由，`temperature=0`，并发 3，重试 5 次，原始 judgment 全部落盘。

**结果（MEASURED）**：

| 指标 | 值 |
|---|---|
| 有效评判 | 12 / 12 |
| **A 胜** | **2** |
| **B1b 胜** | **10** |
| 平局 | 0 |
| 平均总分（满分 80） | A = **61.42**，B1b = **66.75**（差 **+5.33**，+8.7%） |
| 单样本差异范围 | 逐样本总分差 −5 ～ +16（12 组中 10 组偏向 B1b） |

**⚠️ 该结果的三条必须声明的偏差**，因此**仅作辅助证据、不作判决依据**：

1. **评分 rubric 结构性偏向 B1b**：judge 被明确要求「reward specificity traceable to the actual evidence over generic maxims; penalise padding」。而 B1b 的输入**本身就是原始证据**（5 个候选），A 的输入是**已收敛的哲学表述**。这等于让 B1b 拿证据去比 A 的第二手概括——**rubric 与"证据保真度"维度天然耦合**。
2. **同族模型自评**：judge（`glm-5.3`）与被评产物同族同参（`temperature=0`），存在家族偏好风险。
3. **维度权重不可控**：8 个维度等权合计，而 `unnecessary_complexity_inverse` 与 `boundary_specificity` 同样偏向"更短、更贴原始证据"的产物。

**为什么这仍然有价值**：它与 §8.2 的确定性指标**指向一致**——A 的产物"更宽"（antiPatterns +0.75、applicability +0.58、T-xx 提及 +3.58、总字符 +20.4%），B1b 的产物"更紧、更贴原始证据"。两者在**可机检契约（intentContract 5/5）上打平**，差异集中在「覆盖广度 vs 证据特异性」的取舍。

**因此 Q6 的最终判读不由盲评决定，而由下面这条证据链决定**：
- 生产实测：risks 存活率 **83.2%**、canonical title 与 Philosopher title 逐字节一致率 **80.4%** ⇒ Philosopher 的 `risks` 与 `title` 认知**确实在创造最终产物的内容**；
- 但 Philosopher 的产物**没有任何独立生产消费者**，且其信息到 Scribe 的通道**在生产中 100% 断裂**（0/152）；
- ⇒ **认知有价值、durable boundary 无价值**。这正是 Linear 假设的首选方案：*「保留 Philosopher 作为认知角色，删除 Philosopher 作为独立分布式生命周期」*。

> 原始数据：`D:/pd-probe-815/ab2/_judge.json` 与 `_judge_<tag>.json`（含每样本的随机顺序与逐维度得分）。

### 8.6 Q6 结论

> **Philosopher 的独立 durable boundary 没有带来可测量的最终质量增益；但 Philosopher 的认知步骤（收敛、scope 表述、core-axiom 冲突识别、risks 枚举）有真实且部分有价值的作用——其中 risks 有 83.2% 存活率，标题在 80.4% 情况下直接成为 canonical title。**

因此 Q6 的答案是**双重的**：
- 「Philosopher 作为**独立调用**是否提升质量？」→ 在**可机检契约完整性上为零增益**（intentContract 5/5 打平）；在**覆盖度**上有 +0.6~0.75 条/产物的差异（antiPatterns/applicability）；在**证据保真度**上为负增益（丢掉 `candidates[0]` 的元数据与 `sourcePrincipleId`，B1 反而保住了）。辅助盲评 10:2 偏向"直接 Scribe"，但该 rubric 结构性偏向 B1b，故只作旁证。
- 「Philosopher 作为**认知角色**是否应保留？」→ **是**（不得仅凭本次 A/B 就删除该步骤）。其最有价值的产物（risks + title）应**继续流向 canonical artifact**，只是**不必经由一个独立的 task/lease/artifact/recovery 边界**。

**对 §12 决策的直接贡献**：Q6 的结论**既不满足 A 的第 ③ 条**（拆开并未显著提升最终质量），**也不构成 B1 的依据**（不推荐删除 critique 认知）。它支持 C：**认知保留，边界收敛**。

---

## 9. Downstream Compatibility（Q9）

### 9.1 下游真正依赖的是「canonical contract」，不是「三阶段过程」

| 下游 | 真实输入 | 依赖中间 artifact 吗？ |
|---|---|---|
| final Principle identity | `principleDraft.title` 作 principleId（`activation/low-risk-writers.ts:21-26`、`evaluator-runner.ts:2843-2849`） | 否——只要 canonical artifact 的 title 保持 |
| `intentContract` | `intent-contract.ts:71-77` 提取；Artificer `:898`、Evaluator `:869` | 否 |
| source Pain provenance | `pi_artifacts.lineage_artifact_ids` + `source_task_id` | 否——但**需要 provenance 边继续存在且可解析** |
| Artificer 输入 | scribe artifact（`artificer-runner.ts:800-830`）+ **dreamer `candidates[0]`（F2 直取，`:254-370`/`:814-819`）** | **是**（dreamer checkpoint 必须可读） |
| Rule generation | `intentContract`（Artificer） | 否 |
| Evaluator 输入 | `resolvePrincipleBearerArtifact` → scribe artifact（`evaluator-runner.ts:3351-3416`）+ **dreamer `raw.candidates` 整数组（Stage2）** | **是**（dreamer checkpoint 必须可读） |
| Owner governance 输入 | `principleDraft.*` + `intentContract.forbiddenBehavior`（`owner-decision-review.ts:305-343,374-431`） | 否 |
| Prompt activation 输入 | `principleDraft.{title,statement}`（`prompt-activation-reader-contract.ts:88-93`） | 否 |

### 9.2 精确的兼容性要求（不笼统写"可能依赖"）

收敛后必须保证的两条具体契约：

1. **`pi_artifacts` 中 dreamer 派生 checkpoint 必须仍可按 id 读取**，且须保留 `contentJson.candidates[]`（Artificer 读 `candidates[0]`：`badDecision`/`betterDecision`/`rationale`/`riskLevel`/`strategicPerspective`；Evaluator Stage2 读整个 `candidates` 数组）。字段名与数组形状**不可改**。
2. **canonical artifact 的 `principleDraft.title` 语义保持**（它同时是 principleId 与 activation 身份来源），且 `source_principle_id` 的第 4 步回退逻辑（`principleDraft.title` 当身份）不能被破坏。

其余全部下游（激活、治理、RuleCode、prompt 注入、Console）**只依赖 canonical contract**，与三阶段过程解耦。

---

## 10. Safety Net Compatibility（Q10）— 已基于正式 SPEC 完成直接兼容性复核

> **权威材料**（完整读取，已核对实际文件名）：
> - `docs/specs/PD_PIPELINE_SAFETY_NET_V1_2_FINAL_CANDIDATE.md`（1511 行；Status: *Final Candidate for Owner approval*；Date 2026-09-17；**Baseline at review = `45e115363a8ac1aed30a42f0c027ca07032af791`，与本报告 BASE_SHA 完全一致**）
> - `docs/specs/PD_PIPELINE_SAFETY_NET_V1_2_BACKEND_EXECUTION_INSTRUCTIONS.md`（1115 行；后端单 Session 实施指令）
>
> **本节不再使用任何「等价资产推断」**；凡结论均给出 SPEC 原文位置。§0.2 记录了从「材料缺失」到「直接复核」的升级过程。

### 10.1 v1.2 真正保护的 hard invariant（原文提取）

SPEC §0 把保护面收敛为 **六个不变量 + 一个工程前提**（原文 §0 / §3 / §4）：

| ID | 名称（原文） | 原文关键要求 |
|---|---|---|
| **INV-01** | Real Input Must Reach Governable Output | 至少一条 deterministic test 从**正式生产输入入口**经 **production formation wiring** 到**最终可治理 Principle**；断言「输入来源可回链 / 最终 Principle 可治理 / 所需当前 schema 能解析 / 无效输出明确失败」（§3, `:186-219`） |
| **INV-02** | Identity and Provenance Must Not Be Guessed | 保护 `Pain provenance / Principle identity / Rule identity / authorization identity / activation identity / runtime intervention identity`；**不得**以 `title` / `latest row` / `timestamp proximity` / 「看起来是同一个」作 silent fallback；Pain 双命名空间之间须有**可核验 provenance bridge**（不要求字符串相等）；hard gate = `Rule.source_principle_id → authoritative Principle UUID`（§3, `:232-296`） |
| **INV-03** | Permission Must Come From Valid Authority | 区分 `authority=owner` 与 `authority=system_policy`；Owner-required path 无有效 approval **不得**产生 Owner-authorized effect；policy path **不得被表示为 Owner-approved**、不得扩大为高风险 Owner-only 权限；**`Observation State ≠ Governance State`**（readiness/telemetry/shadow/receipt/event count/successful evaluation **永不自己生成权限**）（§3, `:300-347`） |
| **INV-04** | Governance Changes Must Not Fork or Escalate Authority | 主证明方法是 **service-level behavioral contract**；须保护：重复提交不创造第二份权限 / ready 不自动 promote / 旧请求不能覆盖更新后的 revoke 或 decision / **恢复不能直接扩大回 live**、最多回到当前契约允许的安全状态 / 提交时重新检查 current control state+version。完整 J3 可延后，但 **`recovery must not escalate authority` 不可延后**（§3, `:351-393`） |
| **INV-05** | Intervention Must Reach the Actual Runtime Consumer Boundary | 不得只测 `compileRule()` / `RuleHost.evaluate()`：Principle 至少到 **production prompt activation/exposure boundary**（不要求启用 Principle Receipt）；RuleCode 至少到 **production host runtime / host adapter callable boundary → block/allow → consumer-visible reason**（§3, `:397-456`） |
| **INV-06** | Revocation Must Accurately Stop Future Effect | A 被 revoke 后**存活 runtime 的下一次调用** A 不再施效（**无需重启**）且 **B 仍然有效**；fresh session 只能作补充，不得作为唯一证明；只有单规则 fixture 才允许断言 `no_rules_armed`（§3, `:460-501`） |
| **C0** | Test Discoverability / CI Execution | Safety Net 自己必须机械证明「每个 test 被目标 test config 收集 → 被 `check:pipeline-contract` 执行 → CI/merge 有正式入口 → failure 传播非零退出码」；**禁止**「测试文件存在 → 默认认为 CI 执行」（§4, `:504-535`） |

### 10.2 SPEC 原文明确**不冻结**的东西（这是 Trinity 相容性的根基）

SPEC 把「不保护历史偶然实现」写成了总原则（`:11` **「保护价值契约，不保护历史偶然实现。」**），并在三处点名 Trinity：

**① §0 Executive Decision（`:38-49`）—— 明确不冻结清单，第一项就是本 Spike 的对象：**

```text
v1.2 明确不冻结：
Dreamer / Philosopher / Scribe 的数量
当前 DB 表
当前 artifact envelope
固定 CHANNEL_EDGES 边集合
固定 schema registry key 集合
run15 baseline/hash 业务语义
OpenClaw 私有事件格式
Principle Receipt 作为必经节点
```

**② §1 为什么现在做（`:84-102`）—— Trinity 收敛被列为做 Safety Net 的直接动机：**

```text
尤其接下来可能进行：
Dreamer durable → Philosopher durable → Scribe durable
收敛为：
PrincipleFormation
  ├ propose
  ├ critique
  └ formalize
→ one canonical Principle

Safety Net 必须允许这种内部结构变化。
```

**③ §17 Trinity Simplification Compatibility（`:1331-1384`）—— 专门一节**，逐条给出：

| SPEC §17 的判定 | 原文位置 |
|---|---|
| **应继续 PASS**：formal input reaches governable Principle / provenance remains verifiable / authorization remains correct / Principle exposure works / RuleCode governance works / runtime feedback works / revocation works | `:1349-1359` |
| **可以修改 setup**：`formation model stub` / `runner-chain test fixture` / `current routing implementation` / `schema mapping` / `migration compatibility tests` | `:1361-1369` |
| **反面清单（= 锁错对象的判据）**：若这些「长期契约」因为阶段删除而必须保留旧结构才绿，说明 Safety Net 锁错对象 —— 具体列出的四条正是 `Dreamer stage must exist` / `Philosopher artifact must persist` / `fixed edge set must remain` / `three tasks must be generated`，并明确写「**这些不能成为 v1.2 invariant**」 | `:1371-1380` |
| **合格标准**：「**内部接线可以更新，Owner 可观察的行为断言无需削弱。**」 | `:1382-1384` |

**补充原文（同向）：**
- §3 INV-01「**不断言什么**」：`必须经过 Dreamer / 必须经过 Philosopher / 必须经过 Scribe / 必须有三个 durable artifact`（`:221-228`）。
- §5 C2「**不冻结**」：`当前 edge set / stage count / Dreamer → Philosopher → Scribe / pipelineMode 历史形状`，并补一句「如果 Trinity 简化后 router 实现改变，只要价值行为保持，相关 setup/test 可以调整」（`:577-586`）。
- §16 Done Definition Formation 项：`不锁 Dreamer/Philosopher/Scribe 数量`（`:1284`）。
- §18 Artifact Store Convergence：只保护 `identity / provenance / authorization / runtime behavior`，**不保护** `表名 / JOIN 路径 / 当前唯一索引 / 当前 envelope`；「store migration 可以改测试 setup。**不允许削弱价值行为断言**」（`:1388-1418`）。
- **§22 Final Recommendation 第 5 条**：`Safety Net 完成后再进入 PRI-815 Trinity Simplification`（`:1506`）——即本 Spike 的**实施时序**已被 SPEC 正式排定。
- 实施指令 §26 **STOP 条件 7**：若「发现 Safety Net 正确实现会要求保留 Dreamer/Philosopher/Scribe 固定拓扑」→ **STOP 交 Owner**（`:1021`）。SPEC 作者已预先识别该风险，并把它定义为**设计缺陷信号**而非 Trinity 的罪状。
- 实施指令 §7：INV-01「**优先复用现有 runner-chain / live-runner-chain 测试**」，并「**禁止断言**：必须 Dreamer / 必须 Philosopher / 必须 Scribe / 必须三阶段」（`:308,299-306`）；§24 自审清单含「**有没有锁死 Dreamer/Philosopher/Scribe？**」（`:960`）。

### 10.3 逐条判断 SPEC 是否允许 PRI-815 的推荐架构

| PRI-815 动作 | SPEC 是否允许 | SPEC 依据 |
|---|---|---|
| **Dreamer durable task — 删除** | **ALLOWED** | §0 `:41` 不冻结「Dreamer/Philosopher/Scribe 的数量」；§3 INV-01 `:221-228` 明确「不断言必须经过 Dreamer」；§17 `:1371-1380` 把「Dreamer stage must exist」列为**不可成为 invariant**的反面清单项 |
| **Philosopher durable task — 删除** | **ALLOWED** | 同上；§1 `:84-102` 直接以 `propose/critique/formalize` 为目标形态；§17 反面清单含「Philosopher artifact must persist」 |
| **Scribe durable lifecycle — 收敛为 PrincipleFormation 的 `formalize`** | **ALLOWED** | §17 `:1349-1359` 要求 `formal input reaches governable Principle` 继续 PASS，但**不要求携带着 `Scribe` 这个名字**；§0 `:44` 不冻结 `固定 CHANNEL_EDGES 边集合`；§5 C2 `:586` 明示 router 实现可改 |
| **Dreamer 产出 — 保留为非治理 checkpoint** | **ALLOWED，且是现状** | ① SPEC 只要求 *governable Principle* 可达，未要求中间产物不得持久化；② 生产实测：`activations` 绑定 evaluator(2)+scribe(2)、`approvals` 绑定 evaluator(3)+scribe(3)，**dreamer/philosopher 绑定数 = 0** ⇒ 中间产物今天就不是治理对象；③ §18 `:1401-1414` 只保护 identity/provenance/authorization/runtime behavior，**不保护 envelope**，故 checkpoint 形态可自定 |
| **Philosopher 认知 — 保留为内部 `critique`** | **ALLOWED** | §1 `:95-100` 的目标形态**就包含 `critique`**；SPEC 从未要求删除任何认知步骤，只要求不把认知步骤当成治理边界（§17 合格标准 `:1384`） |

**⇒ SPEC 层面：Trinity 收敛 `SIMPLIFY_PARTIALLY` 与 v1.2 **完全相容**，无需削弱任何一个 hard invariant。**

### 10.4 Compatibility Matrix

| Safety Net invariant | Trinity 收敛后是否保持 | 是否需要改 test setup | 是否需要改产品 contract |
|---|---|---|---|
| **INV-01 Formation wiring**（formal input → formation → governable Principle） | **PASS** | **是**（fixture 级）：INV-01 的复用首选是 `c2-live-runner-chain.test.ts`，其 `EXPECTED_CHAIN` / `EXPECTED_PROMPT_CHAIN`（`:43-50`/`:57-…`）硬编码 `dreamer, philosopher, scribe, …`；须改为新 lifecycle 的链形态。SPEC §17 `:1365` 已授权「runner-chain test fixture」可改 | **否**。正式输入入口、formation wiring 的可观察行为断言、fail-loud 语义均不变 |
| **INV-02 Provenance / identity** | **PASS（见 §10.5-C）** | **是**（fixture + 期望字段）：断言具体 lineage 字段名的 fixture 须跟随收敛后的字段集 | **否**（对外契约不变）。⚠️ **但 INV-02 与现状存在一处既存冲突**：读侧身份解析第 4 步回退到 `principleDraft.title`（自由文本），正属 INV-02 禁止的 silent fallback（`docs/audit/pri-807-phase0/LINEAGE_CHAIN.md` F-02；`prompt-activation-reader-contract.ts:96`、`ActivationsConsoleModel.ts:281`、`ApprovalsConsoleModel.ts:232`）。**该冲突与 Trinity 无关**（Trinity 前后 canonical artifact 都含 `principleDraft.title`），应由 Safety Net 实施单独作为真实 defect 处理（SPEC §2.2 / §5 C5 / 实施指令 §12） |
| **INV-03 Authorization（Owner vs system_policy / stale-current / observation≠authorization）** | **PASS** | **否**（Trinity 不触碰这些测试的对象） | **否**。实证：`activations` 与 `approvals` 的全部生产绑定落在 `evaluator` 与 `scribe`，**dreamer/philosopher 各 0**；`deriveOwnerDecisionCapability` 硬门只放行 `evaluator`/`rollout_reviewer`（`owner-review.ts:502-504`）；`insufficient`/`no_principle_id` 仍 fail-loud（`activation-dispatcher.ts:346-349`） |
| **INV-04 Governance idempotency / recovery 不增权** | **PASS** | **否** | **否**。这些机制全部作用在 approval / activation / promotion / recovery 面，与实际执行 `recovery-sweep`、`owner-retry`、`revision-reopen` 的阶段编码无关；⚠️ 注意：实施指令 §10 要求的 `recovery must not escalate authority` 覆盖的是 **治理恢复**，与 §4.4 判定为 `STRUCTURAL_OVERHEAD` 的 **lease/retry 基础设施**不是同一层，不可混为一谈 |
| **INV-05 Runtime consumer boundary**（Principle→prompt exposure；RuleCode→host adapter→block/allow→reason） | **PASS** | **否** | **否**。运行时读取的是 canonical artifact：`prompt-activation-reader-contract.ts:88-93` → `host-runtime/src/active-principle-prompt.ts:69-84`；RuleCode 侧 Artificer→Evaluator→RuleHost 全链不读 dreamer/philosopher **生命周期**（只读 dreamer checkpoint 的内容，属 formation 内部） |
| **INV-06 Precise revocation**（A 消失、B 保留、无需重启） | **PASS** | **否** | **否**。撤销对象是 activation/rule 身份，与 formation 内部阶段数无关 |
| **C0 Test discoverability / CI execution** | **PASS（条件性）** | **是（实施侧）**：`check:pipeline-contract` 在 current main **尚不存在**（root `package.json` 无该 script），且 `verify:merge` 仍是 16 步不含它。这是 **Safety Net 自身的实施任务**（SPEC §4 / Phase B/E），**不是 Trinity 引入的** | **否** |
| **§21 Merge-time vs Dogfood claim boundary** | **PASS** | **否** | **否**。Trinity 不触碰 installer / packaging / runtime pin / hook registration / host adapter 生产语义 ⇒ 不扩大 claim 边界（SPEC §21 `:1469-1493`、实施指令 §20 `:849-861`） |

**矩阵结论**：**八行全部 PASS**；需要改动的只有 **test setup / fixture**（且改动被 SPEC §17 明文授权），**产品 contract 零改动、hard invariant 零削弱**。

### 10.5 五个高风险点逐条检查

#### A. Formal input → formation（INV-01）

- **要求**：至少一条测试从正式输入经 **production formation wiring** 到 governable Principle，且**不得**预制最终 artifact / 全部中间 task / 全部 lineage（SPEC §3 `:186-228`、§7 `:723-746`、实施指令 §7）。
- **Trinity 后是否仍可通过**：**是**。SPEC 明确列举「**可以修改 setup**」包含 `formation model stub` 与 `runner-chain test fixture`（§17 `:1361-1369`），并且「不断言必须经过 Dreamer/Philosopher/Scribe」（§3 `:221-228`、实施指令 §7 `:299-306`）。
- **唯一实施动作**：把 `c2-live-runner-chain.test.ts` 的 `EXPECTED_CHAIN`（`:43-50`）与 `EXPECTED_PROMPT_CHAIN`（`:57-…`）从「三阶段 + 后继」改写为「`principle_formation` + 后继」。断言的对象从 *stage 名称* 变为 *价值行为*（可回链 / 可治理 / 可解析 / 无效必失败）—— 这正是 SPEC §17 要求的「内部接线更新、行为断言不削弱」。
- **判定：PASS**（不依赖三阶段 task 名称）。

#### B. Dreamer checkpoint 不得被误当治理对象

- **实证（只读确认，非重跑分析）**：生产库中 `activations.artifact_id` 指向的产物来源阶段 = `evaluator`(2) / `scribe`(2)；`approvals.artifact_id` 来源阶段 = `evaluator`(3) / `scribe`(3)；**dreamer 0、philosopher 0**。⇒ **中间产物今天就不是 governance artifact / approval object / activation identity**，checkpoint 只是把这一既存事实显式化。
- **必须同时成立的三条约束**（否则才是冲突）：
  1. checkpoint **不得**被 `resolvePrincipleBearerArtifact` / C5 content-authorization / activation 认作 canonical bearer（今天 canonical bearer 是 scribe 产物，见 `evaluator-runner.ts:3343-3345`；收敛后应为 `formalize` 产物）；
  2. checkpoint **不得**新建第二套 authority 或第二 durable store —— SPEC §18/§20 与实施指令 §21 均禁止 `New durable source of truth` / `New DB/schema`；⇒ checkpoint 应**复用现有存储**，不新增表；
  3. checkpoint **不得**出现在 approval queue / activation identity 通道。
- **服务对象**仅两条真实读取路径（§3.1）：Artificer F2（`artificer-runner.ts:254-370`）与 Evaluator Stage2（`context-manifests.ts:298-304` + `evaluator-runner.ts:826-833`）。
- **需要怎么调整 setup**：若 Safety Net 的 exact-identity / authorization guard 以「`artifact_kind='principle'` ⇒ 可能是 canonical」的方式枚举候选，就应改为**按 canonical bearer 解析规则**判定（今天已是如此），而不是按 `artifact_kind` 判定——**这样 checkpoint 无论用什么 kind 都不会被误认**。
- **判定：NON_GOVERNANCE，无冲突**（条件：不新建 authority；Bearer 解析按规则而非 kind）。

#### C. Provenance（可追溯性）

保留或删除的判定标准 = 「**是否是跨 durable 边界的身份持有**」。不因为历史代码里有就保留。

| lineage 字段 | 收敛后 | 理由 |
|---|---|---|
| `sourceDreamerArtifactId`（philosopher 侧） | **DELETE** | 存在的唯一目的是把 dreamer 的持久 id 交给下一个 durable stage（`philosopher-output.ts:24`、强校验 `philosopher-runner.ts:270-275`）。边界消失 ⇒ 字段无对象 |
| `sourcePhilosopherArtifactId` / `sourceTrace.philosopherArtifactId` | **DELETE** | 同上（`scribe-output.ts:32/27`、`scribe-runner.ts:335-340`）。注意正是这两个字段导致实测「原始 validator 0/12 → 规范改名后 11/12」的迁移成本 |
| `sourceTrace.{dreamer,philosopher}ArtifactId` 在 artificer / evaluator / rollout-reviewer schema 中的 **6 处复刻**（3×3 中的 6） | **DELETE** | 纯传递式复刻；边界消失后无传递需求 |
| 指向 Dreamer checkpoint 的单一引用（如 `provenance.checkpointIds[]` 或保留 `sourceTrace.dreamerArtifactId` 一处） | **KEEP（收敛为 1）** | 下游 Artificer F2 / Evaluator Stage2 需要按 id 取 checkpoint 内容 |
| **Pain / diagnosis → formation 的输入可回链**（今天：dreamer task 的 `dependencyTaskIds` → `diag_router` task/artifact；以及 `pi_artifacts.lineage_artifact_ids`） | **KEEP（必须）** | INV-01「输入来源可回链」+ INV-02「Pain provenance」 |
| **`canonical pain_host_*` ↔ `derivedFromPainIds` 的 provenance bridge** | **KEEP（必须，且不得合并两个命名空间）** | INV-02 `:256-276` 明文：保护 bridge **可核验**，不要求字符串相等 |
| **`Rule.source_principle_id → authoritative Principle UUID`** | **KEEP（必须，hard gate）** | INV-02 `:279-284` |
| `pi_artifacts.lineage_artifact_ids` 数组本身 | **KEEP（收敛为 1 条 provenance 数组）** | 承载上表所有「必须保留」的关系 |

- **判定：PASS** —— Pain→diagnosis→formation→canonical Principle→Rule 仍可追溯；删除的只是 6 个「为跨边界而存在」的命名身份字段。

#### D. Authorization 是否被 Trinity 改动

- Owner approval / `system_policy` / activation / promotion / revocation 的**全部**实现与测试都不在 Trinity 的作用域内：
  - Owner 决策面硬门只放行 `evaluator` / `rollout_reviewer`（`owner-review.ts:502-504`）；生产绑定实证见 §10.5-B（**dreamer/philosopher 各 0**）。
  - 修订目标枚举为 `'scribe' | 'artificer'`（`revision-reopen.ts:119-122`）——Trinity 收敛**不改变**这个集合（`scribe` 仍存在，只是不再是独立 stage）。
- **是否需要因 Trinity 改动**：**否**。若实施中发现必须改动，即为 **scope 扩大的信号**（SPEC 实施指令 §20 `:849-861` / §26 STOP `:1002-1021`），应 STOP。
- **判定：PASS，scope 未扩大。**

#### E. Runtime boundary 是否依赖 D/P 生命周期

| 路径 | 依赖 | 结论 |
|---|---|---|
| canonical Principle → Prompt exposure | `prompt-activation-reader-contract.ts:88-93` → `host-runtime/src/active-principle-prompt.ts:69-84` | 只读 canonical artifact，**不依赖** D/P durable lifecycle |
| canonical Principle / intentContract → RuleCode | `intent-contract.ts:71-77` 提取；Artificer `:898`；Evaluator `:869`；`Rule.source_principle_id` | 只读 canonical artifact + checkpoint 内容，**不依赖** D/P durable lifecycle |
| RuleCode → RuleHost → block/allow → reason | `refiner-rulehost-gate.ts`、`RuleHost` live 路径 | **完全不受影响** |
| 反向依赖（唯一一处） | `artificer-runner.ts:254-370` / `evaluator-runner.ts:826-833` 读 **Dreamer 产物内容** | 这是 **formation 内部**的下游读取，位于 runtime consumer boundary **之前**；只需 checkpoint 可读，不需要 Dreamer 是独立生命周期 |

- **判定：PASS。**

### 10.6 需要改的 test setup（精确清单）与「锁错层」判定

**总原则（SPEC §17 `:1371-1384`）**：只需改 test setup = 正常迁移；若必须保留 `Dreamer stage must exist` / `Philosopher artifact must persist` / `fixed edge set must remain` / `three tasks must be generated` 才绿 ⇒ **Safety Net 锁错对象**。

| # | 资产 | 现状断言 | 收敛后 | 分类 |
|---|---|---|---|---|
| 1 | `c2-live-runner-chain.test.ts:43-50` `EXPECTED_CHAIN`、`:57-…` `EXPECTED_PROMPT_CHAIN` | `['dreamer','philosopher','scribe',…]` 硬编码 | 改为新 lifecycle 链形态 | **锁错层**（SPEC §17 `:1365` 明文授权「runner-chain test fixture」可改） |
| 2 | `philosopher-toggle-characterization.test.ts:203-212` | `expect(ALLOWED_EDGES).toHaveLength(5)`；`expect(getAllowedSuccessors('dreamer')).toEqual(['philosopher'])` | 改为断言不变量（合法边、无环、无绕过权威 DAG） | **锁错层**（直接冻结 stage 数量与命名，正是 §17 反面清单第 1、3 条） |
| 3 | `internalization-job-graph.test.ts:11-22,125-172` | 逐条断言 `ALLOWED_EDGES` 与每 kind 的 successor/predecessor | 改为不变量断言 | **锁错层**（第 3 条 `fixed edge set must remain`） |
| 4 | `architecture-regression.test.ts` + `__tests__/fixtures/runtime-v2-barrel-surface.json` | barrel 导出面快照 | 随导出面变更一次性更新快照 | **正常迁移**（这是仓库既有的「导出面变更必须显式确认」机制，**不属于 Safety Net invariant**，应保留机制本身） |
| 5 | `internalization-chain-integrity-read-model.ts:19-30` 的 `totalDreamerTasks` / `totalPhilosopherTasks` | 按阶段计数的只读指标 | 改为按 lifecycle / checkpoint 计数 | **正常迁移**（它们是**观测**，不是不变量） |
| 6 | 生产 `task_kind in ('dreamer','philosopher','scribe')` 特判（68 处严口径） | — | 改为新 kind 或 checkpoint 类型判断 | **正常迁移**（非 Safety Net 资产） |
| 7 | `runtime-internalization-run-once.ts:59`（`SUPPORTED_RUNNERS`）、`:580/587/594`；`rulehost-pipeline-runner.ts:299-301`；`internalization-consumer-cycle.ts:596-610` | 3 个 runner 各一个 adapter 槽（实际都指向同一 adapter 实例） | 合并为 1 槽 | **正常迁移** |

**「锁错层」清单（3 项，#1–#3）**：它们的共同特征是**把当前 stage 数量 / 名称 / 边集当成长期契约**，与 SPEC §17 `:1371-1380` 的反面清单逐条对应。实施 Safety Net 时（Phase A Reuse Matrix）必须把这三项标为 **EXTEND（改断言）而非 REUSE（原样接入）**，否则会**在实现 Safety Net 的同一轮里把 Trinity 的合法收敛判成红灯**——这正是实施指令 §26 STOP 条件 7 描述的情形，且 SPEC 已明确把它归因为 **Safety Net 侧设计缺陷**，不是 Trinity 的罪状。

### 10.7 本报告其余章节是否需因 SPEC 修正

**不需要。** SPEC 原文未反驳以下任一结论：生产数据统计（§2.2 的 0/152；§5.3 的扇出）、Consumer Map（§3）、A/B 原始结果（§8）、Historical Defect Attribution（§6）。两处**新增的 SPEC 侧发现**（INV-02 与 `principleDraft.title` 回退的既存冲突；`check:pipeline-contract` 尚未存在）已登记于 §10.4 与 §15，均**不属于** Trinity 命题。

### 10.8 §10 结论

> **SPEC 层面：`SIMPLIFY_PARTIALLY` 与 Pipeline Safety Net v1.2 完全相容。六个 hard invariant 全部 PASS，产品 contract 零改动，唯一需要动的是被 SPEC §17 明文授权的 test setup / fixture 与「锁错层」断言改写。**
>
> 对照 SPEC 自己的判据（§17 `:1371-1384`）：Trinity 收敛后**不需要**保留 `Dreamer stage must exist` / `Philosopher artifact must persist` / `fixed edge set must remain` / `three tasks must be generated` 中的任何一条 —— 因此 v1.2 的 Safety Net 断言**没有**锁在会被 Trinity 破坏的那一层。

---

## 11. Migration Risk（Q11）

| 风险项 | 现状规模（实测） | 迁移方案 | 风险 |
|---|---|---|---|
| historical tasks | 33 dreamer / 63 philosopher / 56 scribe 行（单 workspace） | **只读兼容**：保留 task 行与其 `task_kind` 作为历史事实，不迁移、不改写 | 低 |
| historical artifacts | 152 个 phase artifact（全部 `artifact_kind='principle'`） | 保留；新 lifecycle 的 checkpoint 用新 `artifact_kind`（如 `principle_proposal`）或 `source_task_id` 前缀区分 | 中：读侧靠 `join tasks` 的阶段反推逻辑要兼容两代 |
| in-flight tasks | 当前 12 dreamer `pending` + 3 scribe `pending`/`2 retry_wait` + 12 artificer pending + 13 artificer retry_wait | **完成或显式终止**后再切换；切换点必须有「老 task_kind 走老 runner、新 kind 走新 lifecycle」的短窗口 | 中 |
| recovery state | 通用 lease/retry 与阶段无关 ⇒ 自动兼容 | 无需专门迁移 | 低 |
| old approvals | approval 绑 artifact id（不绑内容） | **不需要迁移**，但**必须保持不变**（PRI-814 的 `attempt` 双源 + `pi_artifacts` 覆盖语义是独立问题，不在本 Spike 范围） | 中（依赖 PRI-814 单独修） |
| old activation references | activation 绑 id | 同上，不变 | 低 |
| audit / history UI | Console 的 `ApprovalsGroupedConsoleModel` 有 dreamer/philosopher/scribe 三个分支 | 需保留历史分支（读旧 `artifact_kind`/task_kind），新产物走新分支 | 低 |
| migration compatibility | — | 新任务走新 lifecycle；旧任务只读兼容 | 低 |
| rollback | — | 单 flag 回退（保留旧 runner 注册但不可达） | 低 |

### 11.1 对「双跑」的明确立场

**禁止长期双 pipeline。** 若 Owner 要求 shadow 验证，其允许条件必须限定为：

```
1. 短期实验：有明确结束日期（建议 ≤ 2 周）
2. 无第二 authority：新 lifecycle 在 shadow 期只写「观测产物」，不得写任何 canonical / governance 事实
3. 无双写 production truth：pi_artifacts 中 canonical 行只由一条路径写
4. 明确退出条件：连续 N 个样本上 B2 产物通过 evaluator + Artificer 兼容 + Owner 抽查，且无 regression
```

**推荐的第一阶段（风险最低）**：
> **只让新任务走新 lifecycle，旧任务与旧 artifact 只读兼容；不迁移数据；不双写。** 这是本 Spike 认为唯一可接受的默认路径。

---

## 12. Decision Framework

### 12.1 A. KEEP_CURRENT 的四项充分条件逐条判定

| 条件 | 判定 | 证据 |
|---|---|---|
| ① 中间 artifact 有不可替代独立消费者 | **不成立**（Philosopher）/ **部分成立**（Dreamer） | Philosopher artifact 无任何独立生产消费者（§3.2）；Dreamer 有 2 条但只读 checkpoint，不需独立生命周期（§3.1） |
| ② 中间 stage 有真实独立治理/恢复边界 | **不成立** | 三重硬编码证据（§4.2）；Philosopher/ Dreamer 永不可作为 revision 目标（`revision-reopen.ts:119-122`） |
| ③ 拆开显著提升最终质量，且无法用 transient internal step 保留 | **不成立** | intentContract 完整性打平（5/5 vs 5/5）；覆盖度差异 +0.6~0.75 条且审读显示为"时好时坏"（§8.4） |
| ④ 合并会明显削弱可恢复性/审计性 | **不成立** | 恢复机制 100% 来自 `BasePeerRunner` + 通用 lease/retry（§4.4 E）；审计性由 artifact checkpoint + provenance 边保留 |

### 12.2 B. SIMPLIFY_TO_ONE_LIFECYCLE 的六项要求逐条判定

| 要求 | 判定 |
|---|---|
| Dreamer / Philosopher artifacts 无独立生产 consumer | **部分不成立**（Dreamer 有 2 条）⇒ 阻止了纯 B |
| 无中间 Owner governance boundary | ✅ 成立 |
| 中间 retry/recovery 主要是基础设施继承 | ✅ 成立（且 `renewLease`/three-strikes 零生产入口） |
| B2 质量不显著下降 | ✅ 成立（intentContract 打平；覆盖度差异需 Owner 判定是否可接受） |
| intentContract / RuleCode compatibility 不下降 | ✅ 成立（§9） |
| 复杂度显著减少 | ✅ 成立（§13） |

### 12.3 最终判定

### **C. SIMPLIFY_PARTIALLY**

**推荐目标架构**：

```
PrincipleFormation                     ← 一个 durable task / lease / retry / recovery 生命周期
  ├─ propose      (Dreamer 认知职责)    → checkpoint A（非治理，仍持久化供下游按 id 读取）
  ├─ critique     (Philosopher 认知职责) → checkpoint B（非治理）
  └─ formalize    (Scribe 认知职责)      → canonical Principle artifact + intentContract
                                              ↓ ONE durable governance boundary
                                        Artificer → Evaluator → Owner 治理 → Activation
```

**为什么保留"form (canonical Principle + intentContract)"作为唯一 durable boundary**：
1. 它有 9+ 条独立生产消费者，含**运行时激活**与 **Owner 治理面**（§3.3）——这是唯一同时触碰 Owner authority 与 runtime effect 的边界。
2. `intentContract` 是 RuleCode 生成 / 评估 / 修复的**唯一对齐锚**（`scribe-output.ts:37-45` 注释原文），它必须有一个可被治理、可被修订（`revision-reopen.ts` 目标枚举含 `scribe`）、可被审批绑定的落点。
3. 它是 `needs_human_review` 之后所有治理动作的**事实来源**。

**为什么 propose/critique 保留为"步骤 + 非治理 checkpoint"而不是纯 transient**：
- Dreamer checkpoint 有 2 条**真实存在的**下游读取路径（Artificer F2 `artificer-runner.ts:254-370`、Evaluator Stage2 `evaluator-runner.ts:826-833`），若变成纯内存 transient 会**直接破坏这两条生产路径**。
- 但 checkpoint 不需要：独立 task 行 / lease / 独立 run / 独立 retry 预算 / 独立 recovery sweep 覆盖 / 独立 `sourceXArtifactId` 强校验链 / DAG 边。

**判定的证据基础（五类，互不替代）**：① 代码级消费者地图（§3）；② 治理/恢复边界硬编码证据（§4）；③ 生产库实测（§2.2 / §5.3 / §8.3）；④ 历史缺陷归因 41 条（§6）；⑤ 离线 A/B 12 组 + 盲评（§8）。
**第六类（增量复核新增）**：⑥ **Pipeline Safety Net v1.2 正式 SPEC 的直接对照**（§10）—— 其第 17 节逐条授权本判定的收敛形态，六个 hard invariant 全部 PASS，**未提供任何反对 B/C 的证据，也未要求保留 `Dreamer stage must exist` / `Philosopher artifact must persist` / `fixed edge set must remain` / `three tasks must be generated`**。因此 §12.1（A 的四项条件一项不成立）与 §12.2（B 有两项不成立）的判定均**不变**，最终结论仍为 C。

---

## 13. Complexity Reduction Estimate

> 分类口径：DELETE = 直接删除；MERGE = 收敛为一个；KEEP = 保留；MIGRATION_COMPAT_ONLY = 仅为读旧数据保留。
> 标注：**[M]** = 由 §5 实测计数推导；**[E]** = 结构静态估算（未实现 B2，不混写）

| 类别 | 对象 | 动作 | 依据 |
|---|---|---|---|
| **DELETE** | `philosopher` 作为 task_kind | DELETE | [M] `peer-runner-contracts.ts:55-60` |
| **DELETE** | `dreamer` 作为 task_kind | DELETE | [M] 同上 |
| **DELETE** | `sourceDreamerArtifactId`（philosopher 侧） | DELETE | [M] §5.2 6→2 |
| **DELETE** | `sourcePhilosopherArtifactId` / `sourceTrace.philosopherArtifactId` | DELETE | [M] §5.2 |
| **DELETE** | `sourceTrace.{dreamer,philosopher}ArtifactId` 在各下游 schema 的 3×3 复刻中的 6 处 | DELETE | [M] §5.1 #8 |
| **DELETE** | `philosopher` 的 adapter 槽（`runtime-internalization-run-once.ts:587`、`rulehost-pipeline-runner.ts:300`、`internalization-consumer-cycle.ts:604`） | DELETE | [M] 3 槽 → 1 |
| **MERGE** | Dreamer + Philosopher + Scribe task 生命周期 | MERGE → 1 | [M] 3 → 1 |
| **MERGE** | 3 个 output schema + 3 个 validator 类 | MERGE → 1 canonical + 2 internal types | [E] 510 行 → ~250 行 |
| **MERGE** | telemetry 事件 | MERGE：97 → ~40 [E] | [M] `grep -c "Type.Literal('dreamer\|Type.Literal('philosopher\|Type.Literal('scribe" telemetry-event.ts` = 97 |
| **MERGE** | 3 个 adapter 注入点各 3 处 → 1 处 | MERGE | [M] ≥4 注入点 |
| **KEEP** | Scribe 认知步骤与 canonical artifact | KEEP | §12.3 |
| **KEEP** | Dreamer / Philosopher 认知步骤（prompt + 内部 LLM 调用） | KEEP（降为 internal step） | §8.6 |
| **KEEP** | `instruction_contract`、`principleDraft`、canonical 下游全部 | KEEP | §9 |
| **KEEP** | 全部 evaluator / rollout / Owner 治理 / activation 机制 | KEEP | §4.1 |
| **KEEP** | `ALLOWED_EDGES` 机制本身（改为不变量断言） | KEEP 机制、改断言 | §10.6 |
| **MIGRATION_COMPAT_ONLY** | 旧 `task_kind in ('dreamer','philosopher','scribe')` 的**读侧**分支（Console/read model/audit） | MIGRATION_COMPAT_ONLY | §11 |
| **MIGRATION_COMPAT_ONLY** | `--runner dreamer|philosopher|scribe` 的 CLI 参数 | MIGRATION_COMPAT_ONLY | `runtime-internalization-run-once.ts:59` |
| **MIGRATION_COMPAT_ONLY** | `revision-reopen.ts` 的 `'scribe' \| 'artificer'` 目标枚举 | MIGRATION_COMPAT_ONLY（保留 scribe） | [M] `revision-reopen.ts:119-122` |
| **不变** | revision / retry / recovery 机制本身 | **不减少** | [M] 修订目标枚举**本就不含** dreamer/philosopher ⇒ Trinity 收敛**不减少** revision 复杂度（诚实说明） |

### 13.1 量化汇总

| 指标 | Before | After | 说明 |
|---|---|---|---|
| **durable boundary（lifecycle）** | **6**（dreamer/philosopher/scribe/artificer/evaluator/rollout_reviewer） | **4** | [M] 本次收敛涉及 3→1 |
| durable boundary（Principle formation 段） | **3** | **1** | [M] |
| canonical durable artifact（Principle formation 段） | **3**（全部 `artifact_kind='principle'`） | **1** + 2 非治理 checkpoint | [M]/[E] |
| **lineage edge（命名身份字段）** | **6** 命名 + **9** 处 trace 复刻 + 1 durable 数组 | **2** 命名 + 0 复刻 + 1 provenance 数组 | [M] §5.2 |
| **recovery decision point（阶段级）** | **3** 组（每阶段 retry_wait / NHR / failed） | **1** 组 | [M] §5.1 #13 |
| retry / revise 分支 | 不变（2 个修订目标） | 不变 | [M] 诚实 |
| 生产特判分支（严口径） | 68 | ~25 [E] | [M] §5.3 |
| 专职测试文件 / 行 | 16 / 5031 | ~10 / ~3200 [E] | [M] §5.3 |
| 三阶段 runner 实现 | 1290 行 | ~700 行 [E] | [M]/[E] |
| 单次内化链 LLM 调用（B2 vs A） | 3 | 3（不变） | [M] §8.1 |
| 单次内化链 token（B2 vs A） | 8,608（P→S 段） | 约同 | [M] §8.1 |
| 若采用 B1（删 critique 认知） | — | 段内 token −43%，但覆盖度 −0.6~0.75 条/产物 | [M] §8.2（**不推荐**） |

---

## 14. Recommendation

1. **判定：SIMPLIFY_PARTIALLY。** 保留三个认知步骤，收敛为一个 `PrincipleFormation` durable lifecycle，只保留 `formalize`（canonical Principle + intentContract）作为唯一治理边界。（增量复核后**维持不变**，见 §14.1）
2. **B1（删除 Philosopher 认知）不推荐。** 证据不支持，且会损失 risks/title 的实际贡献（83.2% / 80.4%）。
3. **B2（propose + critique + formalize 同一 lifecycle）推荐为实施形态。** token 成本不变，收益全部来自结构简化。

### 14.1 实施前置条件（已按正式 Safety Net v1.2 SPEC 更新 · 全部满足才开工）

| # | 前置条件 | 依据 |
|---|---|---|
| 1 | **Pipeline Safety Net v1.2 SPEC 必须先获批并 merge，其实施 PR 必须先落地**（当前 SPEC 仍是工作区未跟踪文件、未进 `origin/main`；`check:pipeline-contract` 不存在、`verify:merge` 仍是 16 步不含它） | SPEC §22 `:1506`「Safety Net 完成后再进入 PRI-815 Trinity Simplification」 |
| 2 | **Trinity 实施必须保持 v1.2 全部 6 个 hard invariant（INV-01…INV-06）+ C0 不变**；不得为了让实现变简单而放宽其中任何一条 | SPEC §3 / §4；§10.4 矩阵八行 PASS |
| 3 | **Dreamer checkpoint 只能是 NON_GOVERNANCE checkpoint**：不得被 `resolvePrincipleBearerArtifact` / C5 content-authorization / approval queue / activation identity 认作 canonical；**不得新建第二套 authority，也不得新增 durable store / DB 表**（复用现有存储） | SPEC §18 `:1388-1418`、§20；实施指令 §21；生产实证 dreamer/philosopher 治理绑定 = 0 |
| 4 | **旧数据只读兼容，不双写 production truth**：旧 `task_kind` 行与其 artifact 保留为历史事实，新 lifecycle 的 canonical 行只由一条路径写 | SPEC §17 `:1361-1369`（migration compatibility tests 可改 setup）；§18 |
| 5 | **不允许长期双 pipeline**（若做 shadow，须短期 + 无第二 authority + 无双写 + 明确退出条件） | §11.1；SPEC §20「target: 少量机械保护 → 换取大胆删除内部复杂度的自由」 |
| 6 | **不因为迁移方便削弱 authorization / revocation / provenance**：Owner vs system_policy 区分、stale/current 检查、recovery 不增权、precise revocation、Pain provenance bridge、`Rule.source_principle_id → Principle UUID` 全部不得因 Trinity 改动 | SPEC §17 `:1382-1384`「内部接线可以更新，Owner 可观察的行为断言无需削弱」；§10.5-C/D |
| 7 | 开工前先完成 §10.6 的「锁错层」清单改写（3 项标为 **EXTEND** 而非 REUSE），否则会在同一轮把合法收敛判成红灯 | SPEC §17 `:1371-1380`；实施指令 §14（Phase A Reuse Matrix）、§26 STOP 7 |
| 8 | Owner 评审本 Spike 与 Safety Net v1.2 SPEC | — |

4. **实施第一步应是最小可逆的**：只让**新**任务走新 lifecycle，旧任务/旧 artifact 只读兼容，不迁移数据，不双写 production truth。
5. **不要把这算作 Trinity 的功劳**：`revision`/`retry`/`recovery` 机制本身（`revision-reopen.ts` 的双目标、`recovery-sweep.ts` 的三分支）**不会因本次收敛而减少**，它们是独立的复杂度债。

### 14.2 本轮（增量复核）明确不处理的事项

以下项**只在本报告登记影响，不实施**（沿用任务书 §8 的边界）：PRI-814（`attempt` 双源 + `pi_artifacts` 覆盖语义）、Artifact Store revision 设计、progressive disclosure P1（§15 第 6 条）、Diagnostician 三阶段（§15 第 5 条）、checkpoint 最终存储 schema（§15 第 3 条）、Trinity 实施 SPEC、migration code。

---

## 15. Open Questions

1. **B2（propose+critique+formalize 同 lifecycle）本次未实现**（任务书 §1 明确禁止）。其真实质量表现只在 §8 的**代理指标**上被间接覆盖：B2 的 formalize 步与 A 的 scribe 步**输入相同**（都收到 philosopher 产物），因此 §8.2 的 A 列就是 B2 的质量上界代理。**建议在实施前的首个 PR 内做一个真正的 B2 shadow 对照。**
2. **~~`Pipeline Safety Net v1.2` 原文缺失~~ → 已关闭。** 正式 SPEC 已于 2026-09-17 就位并完整复核（`docs/specs/PD_PIPELINE_SAFETY_NET_V1_2_FINAL_CANDIDATE.md`，1511 行，Baseline = 本报告 BASE_SHA；**当前为工作区未跟踪文件、尚未进入 `origin/main`**）。**结论：TRINITY VERDICT `UNCHANGED`；hard invariant 全部 PASS，无需削弱任何一条**（见 §10）。剩余动作已收窄为 SPEC 自己排定的下一步：**等 Safety Net 实施 PR 落地后做一次「实现态校验」**（检查代码是否偏离 SPEC），而**不是**重新评审 Trinity。
3. **Dreamer checkpoint 的持久化形态未定**：是否复用 `pi_artifacts`（新 `artifact_kind`）还是独立表？**SPEC 约束已收窄此问题**：必须复用现有存储、不得新增 DB/schema（§10.5-B 三条约束）；且 canonical bearer 判定应**按解析规则而非 `artifact_kind`**，否则会与 checkpoint 混淆。仍会影响 PRI-814 的修复顺序。
4. **`philosopher.enabled` 开关的终局**：收敛后是删除该配置项，还是让它真正控制 critique 步骤（而非整链拒绝）？
5. **诊断链（rootcause→distiller→router）是否应做同构收敛**？§6.1 显示其同构缺陷占 C 类 1/3。本 Spike 未评估，作为 follow-up 候选登记。
6. **`progressive disclosure` 三层（`artifact_summary_redundancy` / `context_manifest_budget` / `progressive_evaluator`）的独立债**：生产把后两层打开而第一层关闭，导致 §2.2 的 100% 结构性丢失。**这是一个与 Trinity 无关的独立 P1 级缺陷**，建议单独登记（本 Spike 不创建工单，见 §16 纪律）。
7. **【SPEC 侧新增】INV-02 与 `principleDraft.title` 身份回退的既存冲突**：读侧身份解析第 4 步回退到自由文本标题，属 INV-02 明文禁止的 silent fallback。**与 Trinity 无关**（收敛前后 canonical artifact 都含该字段），应由 Safety Net 实施按 SPEC §2.2 / §12 判为 `FAIL`/真实 defect 并单独处理。Trinity 的一个轻微副作用：收敛后非 canonical 产物数量减少，该回退的误命中面**变小**。
8. **【SPEC 侧新增】C0 依赖 `check:pipeline-contract`，而它当前不存在**：Safety Net 的 C0（测试可发现性 / CI 执行）是其自身 Phase B/E 的实施产物。Trinity 实施前必须先有它，否则 §10.4 的 C0 行无法从「条件性 PASS」转成「已验证 PASS」。

---

## 16. 纪律声明

**初版（2026-09-17 上午 · 原始 Spike）**
- **CODE_CHANGES = NONE**
- **PRODUCTION_STATE_CHANGES = NONE**（生产 DB 全程 `readonly:true` 打开；未写 config；未触碰 `~/.pd/runtime` 与 `~/.openclaw/extensions`）
- **PR_CREATED = NONE**
- 未改动 CI / Safety Net；未实现 PrincipleFormation；未创建第二套 pipeline；未删任何 stage。
- PRI-815 状态**未改为 Done**；本报告落地后按团队流程可转 In Review。
- **未创建子工单**。§15 第 6 条（progressive disclosure 结构性丢失）与 §6.1 的 B 类缺陷均按「与 Trinity 无关的独立问题」记录在报告内，是否登记由 Owner 决定。

**增量复核（2026-09-17 晚 · Safety Net v1.2 直接对照）**
- **CODE_CHANGES = NONE**
- **PRODUCTION_STATE_CHANGES = NONE**（新增的一次确认性查询仍以 `readonly:true` 打开生产库）
- **PR_CREATED = NONE**
- 未重跑生产数据分析、未重做 A/B、未修改 Consumer Map / Historical Defect Attribution。
- 只改动了本报告中与 Safety Net 兼容性直接相关的章节：§0.2、§1.1、§10（整节重写）、§14、§15、§16、§17、§18。
- **未削弱任何 SPEC invariant**；**未实现任何 Safety Net 或 Trinity 代码**。
- 本轮未处理的项（PRI-814 / Artifact Store revision / progressive disclosure P1 / Diagnostician 三阶段 / checkpoint schema / Trinity 实施 SPEC / migration code）**只登记影响，不实施**（§14.2）。

## 17. 证据与复现资产

| 资产 | 路径 | 说明 |
|---|---|---|
| 主报告 | `docs/audit/PRI-815-trinity-simplification-spike.md` | 本文件 |
| 生产链路导出 | `D:/pd-probe-815/chains.json` | 56 组真实 D→P→S 三元组（含原始输出） |
| 语义增量分析 | `D:/pd-probe-815/analyze.cjs` → `analysis.json` | §8.3 指标 |
| A/B 输入 | `D:/pd-probe-815/ab-inputs.json` | 共享前驱诊断 |
| A/B harness | `D:/pd-probe-815/ab-run2.cjs` → `ab2/*.json` | 12 组配对，原始输出与 usage |
| 指标 + 盲评 | `D:/pd-probe-815/ab-judge.cjs` → `ab2/_metrics.json`、`ab2/_judge.json` | 确定性指标 + 原始 judgment |
| 只读探针 | `D:/pd-probe-815/probe{1..5}.cjs` | 生产库只读盘点与链路重建 |
| **Safety Net v1.2 权威 SPEC** | `docs/specs/PD_PIPELINE_SAFETY_NET_V1_2_FINAL_CANDIDATE.md` | §10 直接复核对象（1511 行，Baseline = 本报告 BASE_SHA） |
| **Safety Net v1.2 实施指令** | `docs/specs/PD_PIPELINE_SAFETY_NET_V1_2_BACKEND_EXECUTION_INSTRUCTIONS.md` | §10.6 / §14.1 依据（1115 行） |

> 全部 harness 位于 repo 外，未进入生产代码路径；`state.db` 全程以只读模式打开。
> 增量复核（§10）只读了两份 SPEC + 一次针对「治理绑定落在哪个阶段」的确认性查询（`activations`/`approvals` join `pi_artifacts` join `tasks`），未重跑生产数据分析、未重做 A/B。

---

## 18. Final Owner Review Card

```text
PRI_815_TRINITY_SIMPLIFICATION_SPIKE

BASE_SHA = 45e115363a8ac1aed30a42f0c027ca07032af791

VERDICT = SIMPLIFY_PARTIALLY

DREAMER_INDEPENDENT_CONSUMERS      = 2（Artificer F2 `artificer-runner.ts:254-370`；Evaluator Stage2 `context-manifests.ts:298-304`+`evaluator-runner.ts:826-833`）—— 均只读 checkpoint，不需独立生命周期
PHILOSOPHER_INDEPENDENT_CONSUMERS  = 0（唯一结构化消费者是 Scribe；另仅 UI 与一处读不存在字段的 legacy 代码）
SCRIBE_INDEPENDENT_CONSUMERS       = 9+（含运行时激活、Owner 治理、RuleCode 生成、Rollout、Console）

INDEPENDENT_GOVERNANCE_BOUNDARY = NONE（D↔P 与 P↔S 之间；真实边界仅在 evaluator / rollout / 激活审批）
INDEPENDENT_RECOVERY_BOUNDARY   = NONE（D/P/S 的 retry/recovery 100% 继承自 BasePeerRunner + 通用 lease/retry；`renewLease` 与 three-strikes 路径零生产入口）

A_B_SAMPLE_COUNT      = 12（paired，固定输入 = 真实 Dreamer 产物；另 56 组生产三元组用于质量基线）
A_CURRENT_QUALITY     = intentContract 5/5 字段齐全；antiPatterns 5.58；applicability 4.58；risks 4.92；T-xx 提及 9.0；产物 5979.8 字符
B_SIMPLIFIED_QUALITY  = intentContract 5/5 字段齐全；antiPatterns 4.83；applicability 4.00；risks 4.67；T-xx 提及 5.42；产物 4966.6 字符（B1b，最小 prompt 适配）
QUALITY_REGRESSION    = NOT_SIGNIFICANT_ON_MACHINE_CHECKABLE_CONTRACT（intentContract 5/5 打平，B1b 在规范 lineage 改名后 11/12 通过 schema 校验）；
                        覆盖度差异 −0.75 antiPatterns / −0.58 applicability / −3.58 T-xx 提及（A 更宽）；辅助盲评 10:2 偏向 B1b（mean 66.75 vs 61.42 / 80）但 rubric 结构性偏向 B1b；
                        生产实测 Philosopher 的 risks 存活率 83.2%、title 逐字节一致率 80.4% ⇒ 认知有真实贡献 ⇒ 故不推荐 B1（删 critique），推荐 B2（保认知、去边界）

RULECODE_COMPATIBILITY       = NO_CHANGE（Artificer 只读 canonical scribe artifact + dreamer checkpoint；intentContract 提取路径不变）
INTENT_CONTRACT_COMPATIBILITY = NO_CHANGE（`intent-contract.ts` 提取契约与 5 字段语义不变）

DURABLE_BOUNDARIES_BEFORE = 6（dreamer/philosopher/scribe/artificer/evaluator/rollout_reviewer）；Principle formation 段 = 3
DURABLE_BOUNDARIES_AFTER  = 4；Principle formation 段 = 1（+2 非治理 checkpoint）

LINEAGE_COMPLEXITY      = BEFORE 6 命名身份字段 + 9 处 trace 复刻 + 1 durable 数组 + 459 行 BFS 遍历器 → AFTER 2 命名字段 + 1 provenance 数组
RETRY_RECOVERY_COMPLEXITY = BEFORE 3 组阶段级 decision point → AFTER 1 组；⚠️ revision 机制不变（修订目标枚举本就不含 dreamer/philosopher）

SAFETY_NET_COMPATIBILITY = **已基于正式 SPEC 直接复核（非推断）**：`docs/specs/PD_PIPELINE_SAFETY_NET_V1_2_FINAL_CANDIDATE.md`
                           （1511 行；Baseline at review = 45e11536… = 本报告 BASE_SHA；SPEC §17 有专门的 "Trinity Simplification Compatibility" 一节）
                           HARD_INVARIANTS_PRESERVED = YES（INV-01 Formation wiring / INV-02 Provenance / INV-03 Authorization / INV-04 Governance idempotency+recovery / INV-05 Runtime consumer boundary / INV-06 Revocation / C0 Test execution / §21 Claim boundary —— 八行全 PASS，无需削弱任何一条）
                           需要改的只有 test setup / fixture（3 项「锁错层」+ 4 项正常迁移），**被 SPEC §17 明文授权**（「可以修改 setup: runner-chain test fixture / current routing implementation / migration compatibility tests」）
                           PRODUCT_CONTRACT_CHANGES = NONE
                           ⚠️ SPEC 侧既存发现（与 Trinity 无关）：INV-02 禁止 title 作 silent fallback，而读侧身份解析第 4 步回退到 `principleDraft.title`（F-02）；`check:pipeline-contract` 当前尚未存在

SAFETY_NET_SPEC            = docs/specs/PD_PIPELINE_SAFETY_NET_V1_2_FINAL_CANDIDATE.md
SAFETY_NET_COMPATIBILITY_RESULT = PASS
TRINITY_VERDICT_REVIEW_RESULT   = UNCHANGED
DREAMER_CHECKPOINT_GOVERNANCE   = NON_GOVERNANCE（实证：生产 activations 绑定 evaluator 2 / scribe 2，approvals 绑定 evaluator 3 / scribe 3，**dreamer 0、philosopher 0**）

RECOMMENDED_TARGET_ARCHITECTURE =
  PrincipleFormation（ONE durable lifecycle）
    ├─ propose   → 非治理 checkpoint（仍持久化，供 Artificer F2 / Evaluator Stage2 按 id 读取）
    ├─ critique  → 非治理 checkpoint
    └─ formalize → canonical Principle + intentContract（唯一 durable governance boundary）
        ↓ Artificer → Evaluator → Owner 治理 → Activation（全部不变）

IMPLEMENTATION_READY = NO

BLOCKERS =
  1. Pipeline Safety Net v1.2 SPEC 尚未获批/merge（当前仍是工作区未跟踪文件，不在 origin/main），其实施 PR 亦未落地；`check:pipeline-contract` 不存在
  2. Owner 尚未评审本 Spike 与 Safety Net v1.2 SPEC
  3. Dreamer checkpoint 的持久化形态未定（SPEC 已收窄：必须复用现有存储、不得新增 DB/schema；canonical bearer 按解析规则而非 artifact_kind 判定），仍与 PRI-814 的修复顺序耦合
  4. B2（同 lifecycle 三步）未做真实 shadow 对照，仅有代理指标
  5. §10.6「锁错层」3 项（c2-live-runner-chain / philosopher-toggle-characterization / internalization-job-graph）需标为 EXTEND 而非 REUSE 后，才能与 Safety Net 实施同轮安全推进
  6. 本次复核绑定的是「2026-09-17 交付的 Final Candidate 文本」；若 SPEC 在批准前被修改，§10 需按修改点增量重做

CODE_CHANGES = NONE
PRODUCTION_STATE_CHANGES = NONE
PR_CREATED = NONE
```
