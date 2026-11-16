# PD_LAB_CROSS_DOMAIN_VALIDATION — 两种实验类型的最小跨域关联验证

> 阶段 6（Stage 6）输出 · 验证时间 2026-11-16 · 基线 `origin/main @ 23f2c17fd`
>
> 用两种真实实验资产检验 SPEC v0.2 的核心架构（Benchmark Portfolio + 最小关联层）是否成立：
> ① Prompt V2（真实 Pain 配对 A/B）；② Pipeline Evolution（真实工作流 Episode 与行为演化观察）。

## 0. 判定（先行）

**`GENERALIZED_WITH_LIMITATIONS`**

两种异构实验类型可以在不建中央 Registry、不建统一 Runner/Evaluator、不建统一 Replay、
不新建公共 Schema 的前提下，各自保持领域身份并通过稳定引用完成相互定位与审计。
限制（为何不是完全 `GENERALIZED`）见 §3。

### 0.1 本结论不证明什么（r2 按 Owner 评审意见显式化）

`GENERALIZED_WITH_LIMITATIONS` 证明的**只有一件事**：Prompt A/B 与 Pipeline Evolution
两种不同领域的既有资产，可以通过现有引用方式建立**可追溯的关联关系**。

它**不证明**：

1. 第二种实验（Pipeline Evolution）已经完成真实 Baseline/Treatment 对照——现状是
   R2 有 Baseline 设计、Treatment 未运行，三轮 episode activations=0；
2. 通用实验执行生命周期已经建立——两域仍是各自的领域契约，无统一执行协议；
3. PD-Lab 已经可以自动评价任意核心管道变更——当前 0 场景达到 `validated` /
   `behavioral-verified`，无 Activation 与 Behavior Transfer 成功证据，Promotion Gate
   v0 仍是人工方案且未生效。

后续 PRI-1246 仍有实际工作（第二案例的对照条件评估与完整验收）。

## 1. 十个验证问题的逐项回答

### Q1 能否追溯两个实验各自的身份？
能。Prompt V2：Experiment ID `PD-SPEC-001-prompt-v2-ab` + PR #2653 + 合并 SHA
`63e76a8bd`（索引 `experiment/prompt-v2/reports/PD_LAB_HISTORICAL_EXPERIMENT_INDEX.md` §1）。
Pipeline Evolution：`experimentId/scenarioId/pdCommit` 由 `experiment-manifest.v1` 承载
（必填校验含 pdCommit fail-loud），三轮 episode 以报告 + 机器快照（R3
`state-snapshot-final.json`）定身份。**两种身份机制不同但各自稳定。**

### Q2 能否定位各自的 Dataset / Scenario？
能。Prompt V2 → `pain-dataset`（16 样本，datasetFullSha256 `0db86954…` + 16 个
inputDigest）。Pipeline Evolution → S001–S006 场景文件 + closure-lab 6 夹具
（fixtureHash 进 manifest）。

### Q3 能否追溯代码 Commit？
能。Prompt V2：v1BaseCommit `0485046e7`（= PR base）+ 19 变体 prompt 指纹 +
v2 运行 head `520edea85`。Pipeline Evolution：manifest.pdCommit（fail-loud 必填，
"an experiment that cannot name its code is not reproducible"）。

### Q4 能否定位原始 Run？
能。Prompt V2：`runs/grid-2/`（grid-manifest + 4 shard run-manifest + records 52）。
Pipeline Evolution：R3 机器快照 `evidence/state-snapshot-final.json`（18 tasks/50 runs）+
报告内 Pipeline Trace 表；R2 机器结论在仓外 `pd-labs/evolution-ep002-r2/`（限制 L2）。

### Q5 能否定位各自的 Evidence？
能。Prompt V2：blindpack/evals/layer1-metrics（全保真本地，哈希钉定）。
Pipeline Evolution：`collect-evidence.mjs`/`evidence-package.mjs` 派生的 Evidence Index、
Metrics、Pipeline Trace、Owner Review（有 602 行测试保障 deterministic）。

### Q6 能否定位各自的 Report？
能。Prompt V2：`AB_EXPERIMENT_ACCEPTANCE_REPORT.md`（PASS_WITH_LIMITATIONS）。
Pipeline Evolution：`episode-001/002-r2/002-r3-report.md`（PARTIAL_EPISODE /
NOT_REACHED / NOT_REACHED）。

### Q7 能否识别不同实验的评价方法？
能，且语义未被压平。Prompt V2 = 盲评 LLM judge（109 包，pairwise 65:27:17）+
机械层指标（completion/schema/latency/token）。Pipeline Evolution = 机械 Oracle
（verify.js / audit.js 逐位数字 / oracle JSON）+ 治理门证据（evaluator 分数、
rollout NHR、Owner resolution）。两者的证据词汇（`PASS_WITH_LIMITATIONS` vs
`PARTIAL_EPISODE`/`NOT_REACHED`）保持领域原义，互不换算——符合 SPEC §9.4。

### Q8 能否清楚表达不同证据等级？
能。Prompt V2：审计六级（VERIFIED/PARTIAL/REPORT_ONLY/MISSING/MISMATCH/UNKNOWN）
—— 主批次 VERIFIED、后续扩展轮 PARTIAL（如实标注）。
Pipeline Evolution：成熟度阶梯 `defined → fixture-ready → validated → behavioral-verified`
—— 全部场景处于前两级；八阶段链逐阶段标注 ✅/⚠️/❌。
两套等级语义不同但都可审查，不混淆。

### Q9 是否需要新的公共 Schema？
**不需要。** 两个域的关联所需信息已全部由既有载体表达：
Prompt V2 = dataset-manifest + prompt-hashes + run-manifest + blindpack + 索引 Markdown；
Pipeline Evolution = experiment-manifest.v1 + evidence-package + 场景/报告 Markdown。
跨域互连由两份索引/审计文档的稳定路径引用完成。提前抽取公共 Envelope
（SPEC §8.3 的条件）未被满足——没有出现「相同证据封装逻辑的第二次重复」。

### Q10 若需要，最小公共字段是什么？
（Q9 判定为不需要，但为未来留档）若第三种实验类型出现且三域重复出现同一管理需求，
最小公共字段将是 v0.2 §7.3 已列的十个：Experiment ID / Run ID / Domain-Suite ID /
Dataset-Fixture ID+版本 / Baseline-Treatment 标识 / Code Commit / Model-Host-Runtime /
Evidence 引用 / Report 引用 / Owner Promotion Decision。这些字段今天已各自存在于
两域的现有载体中，公共化只是「目录化」而非「新建权威」。

## 2. 跨域关联的实证（本次交付形成的互连）

```text
docs/reports/PD_LAB_V02_EXECUTION_BASELINE.md ──┐
docs/reports/PD_LAB_SPEC_V02_INDEPENDENT_REVIEW.md（F-2/F-3 引用两域产物）
docs/reports/PROMPT_V2_HISTORICAL_ARTIFACT_AUDIT.md（20/20 核验）
docs/reports/PD_CORE_PIPELINE_BENCHMARK_PORTFOLIO_AUDIT.md（场景/episode 成熟度地图）
        │
        ├── experiment/prompt-v2/reports/PD_LAB_HISTORICAL_EXPERIMENT_INDEX.md
        │       └── 引用 dataset-manifest.json / prompt-hashes*.json / 本地 runs/grid-2/*
        │           （digest 级锚定，20/20 VERIFIED）
        └── docs/pipeline-evolution/*（场景/episode 原文引用 + 行号）
                └── 引用 experiment-manifest.v1 / evidence-package / closure-lab GROUND_TRUTH
```

两张不同类型的实验资产通过**稳定路径 + Digest/Commit 锚**互相可定位，全程零新代码、
零新存储、零语义压平。

## 3. 限制（为什么不是 `GENERALIZED`）

| # | 限制 | 影响 |
|---|---|---|
| L1 | 关联是**文档引用层**，非机器可查询——跨实验查找靠人/Agent 读 Markdown | 可接受（v0.2 §5.3：只有多案例反复出现同一管理需求才评估轻量目录文件）；当前恰好 2 个案例，不满足该条件 |
| L2 | Pipeline Evolution 三轮 episode 的机器结论 JSON 在仓外本地目录（`pd-labs/…`），Prompt V2 全保真产物在 worktree 池 `.tmp`——**两侧的「原始执行证据」都不在仓库内**，跨域审计的完整性依赖本机存储存活 | 已在两份审计报告披露（F-1 同类风险）；Owner 归档决策 pending |
| L3 | 两域的 Owner Promotion Decision 字段当前都是**缺省**（Prompt V2 无 Owner 决策记录；episode 无激活可晋级） | 事实如实；Promotion Gate v0（Stage 7）为未来实验补齐该字段 |
| L4 | 两域证据等级词汇不同（六级 vs 四级阶梯 vs 八阶段 ✅/⚠️/❌） | 刻意保留领域语义（SPEC §9.4），代价是跨域阅读需要两份对照说明（本报告 §1 Q7/Q8 即对照） |

## 4. 反面检验：如果强行统一会怎样（论证「不建」的正确性）

- 把 Prompt V2 的 109 包盲评塞进 `experiment-manifest.v1` → 需虚构 scenarioId/fixtureHash，
  违反 rc-6 lineage 一致性原则，制造第二真相。
- 为 Pipeline Evolution 引入盲评 LLM judge → 破坏机械 Oracle 的确定性，602 行
  deterministic 测试作废。
- 建中央 Registry → 当前 2 个案例、查找频率≈每任务一次，无真实瓶颈（SPEC §5.3 停止条件
  全部未触发）。

**最终判定：`GENERALIZED_WITH_LIMITATIONS`** —— v0.2 的「Benchmark Portfolio + 最小关联」
架构在两种异构实验类型上成立；限制 L1-L4 均已披露且不阻塞下一阶段。
