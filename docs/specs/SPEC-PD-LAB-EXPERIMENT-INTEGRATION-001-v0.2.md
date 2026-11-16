# SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001

## PD-Lab：内部研发实验、Benchmark 组合与生产晋级治理规范

| 文档属性            | 内容                                                               |
|---------------------|--------------------------------------------------------------------|
| SPEC ID             | `SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001`                           |
| 版本                | v0.2                                                               |
| 状态                | DRAFT — 已完成针对性 Reality Audit，待 Owner 评审                  |
| 文档类型            | 长期架构与研发治理上位规范                                         |
| 适用项目            | Principles Disciple（PD）                                          |
| 当前源码基线        | `592f50b4aa0c6135128dc63e951efe1496ac8356`                         |
| 资产盘点 PR         | [\#2672](https://github.com/csuzngjh/principles/pull/2672)，已合并 |
| 资产盘点合并 SHA    | `2af0110a47acc8c48eec9bd04b55b5826f3f4588`                         |
| Prompt V2 PR        | [\#2653](https://github.com/csuzngjh/principles/pull/2653)，已合并 |
| Prompt V2 合并 SHA  | `63e76a8bd6911db6d0a654897e0280e326a83e7e`                         |
| 最新源码基线合并 PR | [\#2670](https://github.com/csuzngjh/principles/pull/2670)，已合并 |
| 最新基线提交        | `592f50b4aa0c6135128dc63e951efe1496ac8356`                         |
| Owner               | PD Owner                                                           |

> **重要声明**
>
> v0.2 是在 v0.1 基础上完成最新源码核验后的修订版。它纠正了 v0.1 对现有
> Dataset、Benchmark、Evidence 和发布边界的若干错误或过度概括。
>
> 本 SPEC
> 定义长期目标、架构边界、实验治理规则和阶段验收要求，不代表所有目标能力已经实现。
>
> 本 SPEC 不授权自动修改生产行为、自动激活
> Principle、自动部署、自动合并或重写历史数据。所有实现必须先遵循当前
> `main` 做针对性 Reality Audit，并形成范围明确的实施任务。
>
> **核心修订：PD 已经存在多套 Dataset、行为演化
> Benchmark、研究协议和领域 Evidence。PD-Lab
> 的任务是把它们治理、关联、验证和逐步打通，而不是另建一套 Dataset
> Store、Benchmark、Runner、Evaluator 或 Evidence 平台。**

------------------------------------------------------------------------

# 1. Executive Summary

## 1.1 一句话定义

**PD-Lab 是 PD 内部的一等研发验证与晋级治理能力：让 PD
的重要行为和核心管道变更，在隔离、可比较、可审计的实验中接受验证；只有证据足以证明候选版本达到预先定义的改善目标且未违反硬性护栏，Owner
才能批准其进入生产使用。**

PD-Lab 是研发基础设施和研发治理流程，不是面向 PD 用户的产品功能。

它不是一个必须新建成单一 package
的实验平台，而是由现有实验工具族、数据集、Benchmark、领域
Runner/Evaluator、证据与报告能力，通过最小关联方式组成的内部研发验证体系。

## 1.2 Owner 的长期目标

1.  **重要变更先验证、后生产使用。** Prompt、Agent 决策策略、算法、核心
    Pipeline、Principle
    生成/选择/激活、Runtime、数据与权限边界等重要行为变更，必须有与风险相匹配的实验论证。
2.  **证明改善，而不是证明代码能运行。** 单元测试、CI 通过、Demo
    成功、模型自评高分，都不能单独证明新版本优于旧版本。
3.  **以完整工作流为评价对象。** 对跨阶段变更，应观察
    Pain、Diagnosis、Candidate、Owner
    Decision、Activation、Behavior/Outcome 等相关链路，不能只看单个
    Prompt 或接口。
4.  **建设 PD 自有数据资产。** 在授权和隐私边界内，持续积累真实 PD
    工作流样本；复用现有合成数据、挑战集和历史实验数据；保留来源、版本、用途、脱敏状态和
    lineage。
5.  **形成 PD 自有 Benchmark 组合。** Benchmark 应覆盖 PD
    的核心能力和真实工作流，且能随系统演进持续回归。现有 Pipeline
    Evolution Benchmark 是重要基础，不应另建平行体系。
6.  **保留负结果和不确定性。**
    没有改善、结果不确定、实验无效，都必须如实记录；不能通过删样本、改指标、换评价器或只报告成功案例来制造改善。
7.  **复用优先，复杂度克制。**
    允许针对真实缺口做重构，但不允许为统一而统一。
8.  **研发能力与用户发版隔离。** 新增的内部实验编排、研究数据、Benchmark
    管理和研发治理代码不得进入用户安装包、npm 发布包、Docker
    用户镜像、插件载荷或生产 Runtime。现有明确产品化的
    Examiner/Challenge
    运行模块是单独的既有例外，必须保留其明确白名单边界。

## 1.3 v0.2 相对 v0.1 的关键修正

| v0.1 的说法/设计                                     | 最新核验结果                                                                                   | v0.2 修正                                                             |
|------------------------------------------------------|------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------|
| PD 还需要建设自己的 Dataset / Benchmark              | 已有多套领域 Dataset、合成研究集、Pipeline Evolution 行为演化 Benchmark 和真实 Prompt A/B 数据 | 建设 Benchmark Portfolio，先盘点、治理和复用，不新建统一 Dataset 平台 |
| Prompt V2 是第一个要执行的实验                       | \#2653 已完成真实 Pain A/B，已有 `PASS_WITH_LIMITATIONS` 报告                                  | 将其作为第一个历史实验接入/归档案例，不默认重跑                       |
| 所有 Lab 代码必须排除在用户发版外                    | `principle-learning-lab` 的 Examiner/Challenge 子集已通过显式白名单打包进 `console/lab`        | 仅新增的内部 PD-Lab 研发工具必须排除；保留现有产品化 Examiner 子集    |
| Evidence Package 是全仓库缺失                        | Pipeline Evolution、G1、Examiner、Prompt V2 各有领域 Evidence/报告能力                         | 缺口是跨领域关联与 \#2653 接入，不是从零创建全局 Evidence 系统        |
| 所有数据统一为 development/validation/holdout 三分法 | PLE 使用外层来源泄漏组与内层未来 Probe；Prompt V2 是配对真实 Pain A/B；PRR 有独立协议          | Split 策略按研究问题与泄漏单位确定，不强制统一                        |
| 统一 Runner / Evaluator / Replay                     | 现有 Runner、Evaluator、Replay 语义不同                                                        | 保留领域专用实现，只统一确有必要的关联信息                            |
| 立即建设通用 Promotion 状态和 CI                     | 当前尚无覆盖所有 L2/L3 研发变更的统一实验门禁                                                  | 先建立人工可执行的 Promotion 流程，再逐步加入 CI 证据检查             |

------------------------------------------------------------------------

# 2. 事实基线与证据等级

## 2.1 最新源码基线

本版基于 GitHub `main`：

`592f50b4aa0c6135128dc63e951efe1496ac8356`

核对结果：

- PR \#2672 已合并，合并
  SHA：`2af0110a47acc8c48eec9bd04b55b5826f3f4588`。
- PR \#2653 已合并，合并
  SHA：`63e76a8bd6911db6d0a654897e0280e326a83e7e`。
- PR \#2670 已合并，合并
  SHA：`592f50b4aa0c6135128dc63e951efe1496ac8356`。
- `2af0110...` 到 `592f50b...` 只有一个后续提交，即 PR
  \#2670；其变更集中在 Candidate/Ledger/Owner Decision
  等生产逻辑，没有改动本 SPEC 所核验的 Lab、Dataset、Pipeline Evolution
  和 Prompt V2 实验源码路径。

因此，#2672 对其调查范围内源码的结论仍可作为当前基线；但 \#2672
没有覆盖的其他研究 SPEC、Benchmark
文档和实验报告，必须纳入本版补充核验。

## 2.2 事实标签

- **VERIFIED**：在当前 `main` 源码、文档、测试或 PR 状态中直接确认。
- **PARTIAL**：实现存在，但只覆盖部分场景或尚未达到完整运行/治理要求。
- **PLANNED**：只有设计或声明，未形成完整实现。
- **UNKNOWN**：现有证据不足，不推断。
- **TARGET**：本 SPEC 希望未来达到的目标，不表示已实现。

不得把文档设计写成代码实现，也不得把测试通过写成真实宿主验证。

## 2.3 关键基线事实

| 事项                         | 当前判断                                                                | 证据                                                                                                 |
|------------------------------|-------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| `experiment-manifest.v1`     | VERIFIED，已被 Pipeline Evolution 和 PLE G1 使用                        | `scripts/dev/pipeline-evolution/lib/experiment-manifest.mjs`；`principle-learning-lab/run-pilot.mjs` |
| PLE Dataset / Fixture        | VERIFIED，当前为合成研究集                                              | `scripts/dev/principle-learning-lab/fixtures/`；`lib/fixture.mjs`                                    |
| PLE Research Sidecar         | VERIFIED，`principle-study.v1` / `adjudication.v0.1`                    | `lib/sidecar.mjs`                                                                                    |
| PLE G1                       | VERIFIED，离线确定性闭环                                                | `run-pilot.mjs`；README；测试                                                                        |
| PLE G2 真实 Actor            | PARTIAL，接线与离线演练存在，真实 Agent Pilot 仍未运行/未授权           | `README.md`；`pilot-run-config.json`；`preregistration.json`                                         |
| PRR A/C Dataset              | VERIFIED，独立合成数据协议                                              | `prr/lib/prr-dataset.mjs`                                                                            |
| PRR 真实样本                 | UNKNOWN/未授权；当前 SPEC 明确记录 `AUTHORIZED_REAL_SAMPLE = 0`         | `SPEC-PD-PRR-001-Gate-B0-AC-preregistration-20261022.md`                                             |
| Pipeline Evolution Benchmark | VERIFIED，已有 S001–S006 场景、Episode 报告和 Evidence 流程；成熟度不一 | `docs/pipeline-evolution/`                                                                           |
| Prompt V2 A/B                | VERIFIED，真实 Pain A/B 已执行并生成报告                                | `experiment/prompt-v2/reports/`                                                                      |
| 全局实验注册中心             | 不存在；当前不需要先建设                                                | \#2672 审计报告                                                                                      |
| 通用 Runner / Evaluator      | 不存在，也不应强行统一                                                  | \#2672 审计报告                                                                                      |
| 跨领域统一 Evidence 契约     | 不存在；已有多套领域 Evidence                                           | \#2672 审计报告 + 当前源码                                                                           |
| 通用真实宿主 Trace Replay    | MISSING                                                                 | \#2672 审计报告                                                                                      |
| 内部 PD-Lab 用户发版隔离     | TARGET；需要按模块闭包验证                                              | `lab-payload.mjs` 现有边界测试                                                                       |

------------------------------------------------------------------------

# 3. PD-Lab 的概念边界

## 3.1 必须区分三个容易混淆的概念

### A. PD-Lab Internal R&D

本 SPEC 所定义的内部研发实验能力，包括：

- 实验编排与对照；
- 内部 Dataset / Benchmark；
- Prompt / Runtime / Pipeline 研究脚本；
- 实验结果与证据关联；
- 实验报告；
- 研发 Promotion Gate；
- 研发人员使用的内部工具。

它不面向 PD 用户，不进入用户发布包，不成为生产 Runtime 的依赖。

### B. Principle Learning Lab Research

现有 `scripts/dev/principle-learning-lab/` 下的研究能力，包括：

- PLE G1/G2；
- PLE / PRR 数据集和研究 Sidecar；
- 研究 Runner、Evaluator、Oracle、Report；
- Challenge/Examiner 相关模块。

该目录名称中有
`lab`，但不能因此将整个目录视为同一种发布属性。必须按实际依赖闭包区分。

### C. 产品化 Examiner / Challenge Runtime

当前 Console 通过 `scripts/build/lab-payload.mjs` 的 `LAB_ENTRY_MODULES`
显式打包七个模块到 `console/lab`，供 Examiner 路由动态加载。

这七个入口为：

- `examiner-study.mjs`
- `challenge-runner.mjs`
- `challenge-behavior-report.mjs`
- `challenge-actor.mjs`
- `examiner-injection-evidence.mjs`
- `examiner-v07-cases.mjs`
- `examiner-v2-cases.mjs`

该子集是已经存在的产品化运行能力，不等于本 SPEC 所定义的内部研发
PD-Lab。

**本 SPEC 不得以“Lab 不发版”为由删除、迁移或破坏该既有产品化子集。**

同时，不得把新的内部实验编排、研究数据或研发工具加入
`LAB_ENTRY_MODULES`。

## 3.2 PD-Lab 的正确定位

PD-Lab 不是一个需要拥有所有实验代码的中央平台。

它应当成为：

1.  **研发质量制度**：规定哪些重要变更必须有实验依据。
2.  **Benchmark Portfolio**：管理和持续改进 PD 自有的多个领域
    Benchmark。
3.  **实验关联层**：让现有 Manifest、Dataset、Run、Evaluation、Evidence
    和 Report 能够互相追溯。
4.  **证据决策层**：把实验结果转换为 Owner 可以审查的生产晋级依据。
5.  **隔离和发布保护层**：确保实验不污染生产状态，也不进入用户发布包。

------------------------------------------------------------------------

# 4. 当前 PD 实验与 Benchmark 资产盘点

## 4.1 资产总览

当前至少存在以下领域资产：

| 资产族                       | 主要位置                                                                   | 当前职责                                           | 当前成熟度                             | v0.2 决策                           |
|------------------------------|----------------------------------------------------------------------------|----------------------------------------------------|----------------------------------------|-------------------------------------|
| Pipeline Evolution Benchmark | `docs/pipeline-evolution/` + `scripts/dev/pipeline-evolution/`             | Agent 核心工作流演化、场景、真实 Episode、Evidence | PARTIAL，最接近核心管道 Benchmark      | 作为核心管道 Benchmark 的首要基础   |
| Principle Learning Lab G1/G2 | `scripts/dev/principle-learning-lab/`                                      | 经验是否改变 Agent 未来行为的受控研究              | G1 已实现；G2 真实 Agent 未运行        | 保留其独立研究协议                  |
| PRR A/C                      | `scripts/dev/principle-learning-lab/prr/` + `docs/specs/SPEC-PD-PRR-001-*` | Principle Recall / 行为价值对照研究                | 合成预演与数据协议已存在；真实样本为 0 | 保留独立协议，不重复建设            |
| Prompt V2 A/B                | `experiment/prompt-v2/`                                                    | 六 Agent Prompt V1/V2 真实 Pain A/B                | 已完成一次真实 A/B，有限样本           | 作为第一个历史实验接入案例          |
| Challenge / Examiner         | `principle-learning-lab/lib/challenge-*`、Console `/api/examiner/*`        | Examiner 行为挑战、授权、评分与证据                | 有独立执行闭环，部分产品化             | 保留领域边界                        |
| Pipeline Closure Lab         | `scripts/dev/pipeline-closure-lab/`                                        | 确定性场景夹具和机械验证                           | 多个场景已有                           | 作为 Pipeline Evolution 的夹具来源  |
| Adaptive Selector Lab        | `scripts/dev/adaptive-selector-lab/`                                       | 模型/选择策略受控研究                              | 独立实验资产，部分为一次性批准运行     | 保留，不抽象为通用 Runner           |
| Behavior Signature           | `docs/experiments/`                                                        | 声明某次实验可观察行为与窗口                       | 声明资产，校验主要在测试中             | 不视为已运行的 Benchmark 或生产机制 |

## 4.2 Pipeline Evolution Benchmark：核心基础

权威入口：

- [Pipeline Evolution
  README](https://github.com/csuzngjh/principles/blob/592f50b4aa0c6135128dc63e951efe1496ac8356/docs/pipeline-evolution/README.md)
- [Baseline
  Report](https://github.com/csuzngjh/principles/blob/592f50b4aa0c6135128dc63e951efe1496ac8356/docs/pipeline-evolution/baseline-report.md)
- [Episode 001
  Report](https://github.com/csuzngjh/principles/blob/592f50b4aa0c6135128dc63e951efe1496/docs/pipeline-evolution/reports/episode-001-report.md)
- [Episode 002-R3
  Report](https://github.com/csuzngjh/principles/blob/592f50b4aa0c6135128dc63e951efe1496/docs/pipeline-evolution/reports/episode-002-r3-report.md)

### 已有场景

| 场景 | 问题                             | 当前状态        |
|------|----------------------------------|-----------------|
| S001 | 修改重要状态前未建可恢复检查点   | `fixture-ready` |
| S002 | 执行未经验证的命令/脚本          | `defined`       |
| S003 | 证据不足即行动                   | `defined`       |
| S004 | 长任务中遗忘早期约束             | `fixture-ready` |
| S005 | 修复旧问题引入新问题             | `fixture-ready` |
| S006 | 学到的是原则还是案例：跨资产泛化 | `fixture-ready` |

场景状态遵循既有约定：

`defined → fixture-ready → validated → behavioral-verified`

v0.2 不另造一套替代状态。

### 已有真实 Episode 的限制

- Episode 001：Pain → Diagnosis → Principle → Rule → Evaluation
  真实走通；Owner Review 生产路径未到达，Activation 未完成，Behavior
  Transfer 为 `INCONCLUSIVE`，最终为 `PARTIAL_EPISODE`。
- Episode 002-R2：最终为 `NOT_REACHED`。
- Episode 002-R3：真实 Pain、Principle、RuleCode、Evaluation 和 Owner
  Decision 有证据；未形成 live Activation，Behavior A/B 不适用。

因此，Pipeline Evolution 已是 PD 自有 Benchmark
的核心基础，但不能声称它已经证明所有核心管道行为都能被完整、稳定、自动化地评价。

### 重要架构判断

Pipeline Evolution 已有：

- 场景定义；
- 基线和 Episode 记录；
- 实验 Manifest；
- `collect-evidence.mjs`；
- `evidence-package.mjs`；
- Evidence Index、Metrics、Pipeline Trace、Owner Review；
- 跨版本比较的报告约定。

它不是一个通用 A/B Runner，也不需要被重写成 Prompt A/B 执行器。

**后续 PD-Lab 应优先增强 Pipeline Evolution 作为核心管道 Benchmark
的完整性、可复现性和覆盖率，而不是新建另一个核心管道 Benchmark。**

## 4.3 Principle Learning Lab G1/G2

权威资产：

- `docs/specs/SPEC-PD-PL-001-principle-learning-dataset-v0.3.md`
- `scripts/dev/principle-learning-lab/README.md`
- `scripts/dev/principle-learning-lab/run-pilot.mjs`
- `scripts/dev/principle-learning-lab/lib/fixture.mjs`
- `scripts/dev/principle-learning-lab/lib/sidecar.mjs`
- `scripts/dev/principle-learning-lab/lib/prereg.mjs`

### 已实现内容

G1 离线闭环已经实现：

- 冻结研究 Dataset；
- Fixture Hash 和健康检查；
- Actor 可见输入组装；
- Gold / Judge-only 泄漏扫描；
- 24 个 arm 的确定性模拟；
- 机械 Oracle；
- 三层评价：行为对齐、任务后果、Owner 成本；
- 研究 Sidecar；
- 校准电池；
- G1 Gate；
- JSON / Markdown 比较报告。

`run-pilot.mjs` 直接复用 `experiment-manifest.v1`，并写出
`principle-study.json`、`adjudications.jsonl`、`comparison-report.json`
和 Markdown。

### 数据性质

`PLE-PILOT-01` 的 Dataset Manifest 明确标记：

- `schemaVersion = pd-principles-dataset.v0.1`
- `synthetic = true`
- `episodeKind = synthetic_pilot`
- 历史世界、Probe 环境均为合成研究世界；
- 不代表真实 Owner、真实 Pain、真实 Activation 或生产 Principle。

### G2 限制

真实 Actor 的 transport 和 runner 已有接线及离线演练，但当前 README /
`pilot-run-config.json` 明确保留：

- `NOT_AUTHORIZED`
- `OWNER_DECISION_REQUIRED`
- 真实 Agent Pilot `NOT_RUN`

因此 G1 PASS 只能证明实验夹具、Oracle
和评价协议在受控模拟中具有区分能力，不能证明真实 PD
用户或宿主的长期行为已经改善。

## 4.4 PRR A/C 研究 Dataset

权威资产：

- `docs/specs/SPEC-PD-PRR-001-Gate-B0-AC-preregistration-20261022.md`
- `scripts/dev/principle-learning-lab/prr/lib/prr-dataset.mjs`

已实现：

- `prr-ac-dataset.v0.1`；
- canonical JSON / SHA-256 冻结；
- 数据完整性校验；
- 合成 Principle、Task、Gold、行为与设计检查；
- Gold 泄漏和身份伪造防护。

当前 PRR 规范明确区分 `FIXTURE_ONLY`、`SCHEMA_CAPABILITY` 与
`AUTHORIZED_REAL_SAMPLE`，且当前授权真实样本为 0。

**不得把 PRR 的合成预演结果写成真实用户行为收益。**

## 4.5 Prompt V2 A/B：已完成的历史实验

权威资产：

- `experiment/prompt-v2/`
- `experiment/prompt-v2/reports/AB_EXPERIMENT_ACCEPTANCE_REPORT.md`
- `experiment/prompt-v2/reports/EXPERIMENT_REPRODUCIBILITY_REPORT.md`
- `experiment/prompt-v2/PUBLIC_DATA_REDACTION_AUDIT.md`

### 已确认的实验结果

- 16 条真实 Pain 样本；
- V1 / V2 两臂；
- 完成 Grid-2；
- 109/109 盲评包完成评价；
- Pipeline completion 两臂均为 16/16；
- 总体盲评分 V1 78.86，V2 81.50，差值 +2.64；
- 5/6 Agent 阶段改善；
- Pairwise 决胜结果中 V2 为 70.7%；
- Dreamer 是唯一退化阶段，下降 1.25；
- 平均阶段延迟下降约 20%；
- 总 Token 字符统计下降约 14.2%；
- 结论为 `PASS_WITH_LIMITATIONS`，不是统计显著性结论；
- 总体 +2.64 未达到报告中建议的 +5 门槛；
- 评价模型与生成模型同为 GLM-5.3
  家族，虽然独立会话和盲化，仍有评价独立性限制。

### 复现和数据限制

- \#2653 使用自己的
  `ab-grid`、`ab-run`、`ab-lib`、`ab-eval`、`ab-metrics` 和
  `ab-blindpack`。
- 执行通过两个独立 worktree 中编译后的生产 CLI dist。
- `ab-lib.mjs` 当前包含绝对 Windows worktree 路径和生产 workspace
  路径，具有明显的单机实验特征。
- 实验执行要求本地全保真数据；公开仓库提交的是脱敏版本。
- 全保真数据位于 gitignored `.tmp`；报告中的大量 Run 产物也位于
  `.tmp`，并未作为完整的可移植实验包提交。
- 当前公开文件经过脱敏和扫描，但 `PUBLIC_DATA_REDACTION_AUDIT.md`
  记录早期未完整脱敏的数据曾进入已推送 PR 分支历史；历史处置仍需 Owner
  单独决定。

### 对 PD-Lab 的意义

\#2653 已证明 PD 可以针对真实 Pain 对核心 Agent Prompt 做真实生产链路
A/B，并形成有价值的量化报告。

但它还不是通用 PD Benchmark：

- 样本规模有限；
- 只覆盖特定 Prompt/Agent 变更；
- 评价独立性受限；
- 完整全保真数据与运行产物不具备通用可移植性；
- 其执行器和评分器仍高度领域专用。

因此，它应当成为 PD-Lab
的**第一个历史实验接入案例**，而不是要求重新执行的“第一个实验”。

## 4.6 Evidence / Report 的真实状态

当前存在多套领域 Evidence：

| 能力                                                | 当前用途                                                                                           | 不应误判为                |
|-----------------------------------------------------|----------------------------------------------------------------------------------------------------|---------------------------|
| Pipeline Evolution `evidence-package.mjs`           | 从只读 store / trajectory / telemetry 派生 Pipeline Evidence Index、Metrics、Trace 和 Owner Review | 通用 A/B Evidence Store   |
| PLE `sidecar.mjs` + `report.mjs`                    | G1 研究 Sidecar、Adjudication、校准和比较报告                                                      | 全仓通用实验报告          |
| Examiner `examiner-injection-evidence.mjs`          | 六级注入证据链，具有 Examiner 领域身份绑定                                                         | 通用实验 Evidence Package |
| Prompt V2 `ab-blindpack` / `ab-eval` / `ab-metrics` | 盲包、盲评、指标和报告                                                                             | 全局 Scorer / Report 系统 |
| PRR Dataset / Adjudication                          | PRR 专属数据与研究评价                                                                             | PLE 的统一替代品          |

当前真正的缺口是：

**不同实验资产之间没有足够稳定的跨域关联和统一的 Owner Review
入口；不是全仓不存在 Evidence 或 Report。**

## 4.7 Replay 的边界

必须区分：

- G1 确定性模拟重执行；
- Fixture / Closure Lab 重新生成和机械验证；
- Challenge Study 的 Resume；
- RuleCode 沙箱重执行；
- 已退役的 ReplayEngine 历史报告查询；
- 真实宿主 Trace Replay。

当前没有证据证明 PD 已具备通用的真实宿主 Trace Replay。

v0.2 不把通用 Trace Replay 作为首阶段依赖，也不允许把普通重新运行称为
Trace Replay。

------------------------------------------------------------------------

# 5. 目标架构：Benchmark Portfolio，而不是统一平台

## 5.1 逻辑架构

``` text
                    Owner / Researcher
                            |
                            v
                 Change Classification
                            |
                            v
                 Experiment / Research Plan
                            |
              +-------------+-------------+
              |             |             |
              v             v             v
        Pipeline Evo    Prompt A/B     PL / PRR
        Benchmark       Experiment     Research
              |             |             |
              v             v             v
        Existing Runner  Existing Runner  Existing Runner
              |             |             |
              +-------------+-------------+
                            |
                            v
                 Domain Evaluators / Scorers
                            |
                            v
                 Existing Evidence / Reports
                            |
                            v
               Minimal Cross-Reference Layer
                            |
                            v
                  Owner Promotion Review
                            |
                            v
              Normal PR / CI / Release Process
```

该架构不要求新建中央 Runner、Evaluator、Dataset Store、Evidence Store 或
Registry。

## 5.2 核心组成

| 组成                  | 目标职责                                          | 实施策略                                             |
|-----------------------|---------------------------------------------------|------------------------------------------------------|
| Experiment Definition | 说明研发问题、假设、对照、主要指标和限制          | 复用 `experiment-manifest.v1` 与领域 Preregistration |
| Benchmark Portfolio   | 组织多个领域 Benchmark 的身份、范围、成熟度和证据 | 先目录化现有资产，不建中央服务                       |
| Dataset / Fixture     | 提供冻结输入、样本、场景和 Gold                   | 复用领域数据结构，不统一底层 Schema                  |
| Domain Runner         | 执行特定实验                                      | 保留现有 Runner                                      |
| Domain Evaluator      | 对特定任务和结果进行评价                          | 保留现有 Evaluator                                   |
| Evidence / Report     | 保存原始证据、评价和结果                          | 复用领域 Evidence；必要时增加薄引用 Adapter          |
| Promotion Review      | 判断是否允许生产使用                              | 先人工执行，后逐步自动化证据检查                     |

## 5.3 不建设中央 Registry 作为前置

当前没有全局 Experiment Registry，也没有跨实验 Dataset Registry。

v0.2 不要求先建设 Registry。

优先使用已有目录、Manifest、Sidecar 和报告中的稳定
ID。只有当多个真实案例反复出现同一管理需求时，才评估是否需要一个机器可读的轻量目录文件。

禁止因为希望“统一”而先建设：

- 数据库；
- Daemon；
- Worker；
- 在线服务；
- 用户控制台；
- 第二个 Manifest 系统。

------------------------------------------------------------------------

# 6. PD Native Dataset 与 Benchmark Portfolio

## 6.1 关键概念

**Dataset 是数据样本及其来源、版本和标签；Benchmark
是围绕评价目标建立的任务协议、样本选择、评价方法、指标和判定规则。**

一个 Dataset 可以服务多个实验；一个 Benchmark 可以引用多个 Dataset。

测试 Fixture、Synthetic Dataset、真实生产样本和 Longitudinal Cohort
不是同一种数据资产。

## 6.2 数据资产分类

| 类型                 | 定义                             | 示例                                  | 可支持的结论                                     |
|----------------------|----------------------------------|---------------------------------------|--------------------------------------------------|
| `REAL_AUTHORIZED`    | 获得明确授权的真实 PD 工作流样本 | 经授权 Pain、真实执行轨迹、Owner 决策 | 在明确样本范围内的现实表现                       |
| `REAL_REDACTED`      | 从真实样本派生的脱敏版本         | Prompt V2 公开数据副本                | 结构、覆盖和公开审计；不能直接代替全保真运行输入 |
| `SYNTHETIC`          | 人工构造的研究世界               | PLE-PILOT-01、PRR A/C                 | 机制区分、边界和方法学验证，不代表真实分布       |
| `CHALLENGE`          | 专门设计的对抗/边界案例          | Examiner Challenge Suite              | 特定能力和安全边界                               |
| `REGRESSION_FIXTURE` | 用于重复验证既有 Bug / 契约      | Closure Lab S001 等                   | 回归与不变量，不代表总体能力                     |
| `LONGITUDINAL`       | 经授权、跨时间持续观察的真实样本 | 原则激活后的后续行为机会              | 长期行为变化，需明确时间窗口和归因限制           |
| `EXTERNAL_LICENSED`  | 有合法许可的外部数据             | 经授权外部任务集                      | 受许可和分布限制的外部对照                       |

不得将 Synthetic、Challenge、Regression Fixture
与真实用户样本合并计算“真实准确率”。

## 6.3 数据源权威与隔离

- 生产数据库、`state.db`、`trajectory.db`、Ledger
  和真实运行事件仍是各自业务事实的权威来源。
- Dataset 是经过授权、冻结和治理的研究视图，不是新的生产事实源。
- 不允许为了实验而在研究 JSON 中伪造正式 Ledger、Owner
  Approval、Activation 或 Principle Revision。
- 真实样本只保留研究所需字段，必须保留来源引用和 lineage。
- 全保真数据默认不得进入公开 Git。
- Gitignored `.tmp` 不是长期安全数据仓库，也不是跨机器共享方案。
- 如果当前没有获得批准的安全存储和访问方式，正式真实 Benchmark
  的共享运行必须阻塞；可以继续做合成夹具和离线协议工作。
- 脱敏必须有可重复生成、canary 正控、泄漏扫描和 fail-closed 检查。
- 数据撤回、删除或授权变化必须能定位受影响的 Dataset、Benchmark、Run 和
  Evidence。

## 6.4 Dataset 版本规则

- 已被正式实验引用的 Dataset Version 不得原地修改。
- 样本、标签、脱敏规则、Schema 或分割变化必须产生新版本。
- 实验必须引用明确 Dataset Version 和冻结摘要。
- 每种 Dataset 可以保留自己的 canonicalization 与 hash 实现。
- 上层必须说明 Digest 的算法、对象范围、规范化方式、来源和版本。
- 不强制所有数据资产使用同一 Hash 算法。

## 6.5 不强制统一数据目录和 Schema

当前真实数据资产分别位于：

- `scripts/dev/principle-learning-lab/fixtures/`
- `scripts/dev/principle-learning-lab/prr/`
- `experiment/prompt-v2/dataset/`
- `docs/pipeline-evolution/` 与外部实验数据目录
- Examiner / Challenge 的领域数据目录

v0.2 不要求全部迁移到 `datasets/pd-principles/` 或其他新根目录。

现有 PLE SPEC 曾提出过一种建议目录，但当前实现选择将 Fixture 保存在对应
Lab 目录内。应尊重已验证的仓库结构，除非真实维护成本证明需要迁移。

## 6.6 Benchmark Portfolio 的首批组合

| Benchmark / Suite       | 目标                         | 当前基础                                        | 当前限制                                                               | v0.2 定位                     |
|-------------------------|------------------------------|-------------------------------------------------|------------------------------------------------------------------------|-------------------------------|
| Core Pipeline Evolution | PD 核心链路与 Agent 行为演化 | S001–S006、Episode 001/002、Pipeline Evidence   | 多个场景尚未达到 behavioral-verified，Episode 有 PARTIAL / NOT_REACHED | 首要核心管道 Benchmark        |
| Prompt / Agent Quality  | Prompt、Agent 输出和下游质量 | \#2653 真实 Pain A/B                            | 16 样本、评价独立性有限、完整产物不便共享                              | 历史实验与领域 Benchmark Seed |
| Principle Learning      | 经验是否改善未来判断         | PLE-PILOT-01、G1 Oracle、14-case Calibration    | 全合成；G2 真实 Agent 未运行                                           | 方法学与受控行为研究          |
| PRR A/C                 | Principle Recall / 行为价值  | PRR 合成数据与预注册                            | 真实样本 0                                                             | 独立研究协议                  |
| Examiner Challenge      | Claim/Evidence 行为验证      | Challenge Runner、Frozen Suite、Examiner Scorer | 领域绑定，不是全局 Runner                                              | Examiner 专属 Benchmark       |
| Adaptive Selector       | 模型选择和决策策略           | Synthetic decision fixtures、受控实验记录       | 场景和执行授权专用                                                     | 独立研究 Suite                |

## 6.7 首个核心 Benchmark 的选择

**建议将 Pipeline Evolution 作为 PD 核心管道 Benchmark 的首要基础。**

原因：

1.  它直接覆盖 PD 的核心工作流和真实 Agent 行为；
2.  已有 S001–S006 场景；
3.  已有真实 Episode 和报告；
4.  已有 `experiment-manifest.v1` 与 Evidence Package；
5.  能观察 Pipeline 是否到达 Owner Decision、Activation
    和后续行为，而不仅是 Prompt 输出。

但在正式宣布“Core Benchmark
v0”前，必须完成一次场景成熟度与证据可复现性盘点：

- 哪些场景可在隔离环境中稳定执行；
- 哪些场景仅有 Fixture；
- 哪些场景已有真实 Agent 行为证据；
- 哪些场景有 Activation / Behavior Transfer 证据；
- 哪些 Episode 数据仍只存在于本地外部目录；
- 哪些指标可在当前版本可靠计算。

**不得把 `fixture-ready` 场景称为已经通过真实行为验证的 Benchmark。**

## 6.8 Benchmark 的最低说明要求

每个 Benchmark Suite 应有可审查说明，至少列出：

1.  评价目标和适用变更类型；
2.  场景 / Dataset ID 与版本；
3.  数据来源类型和授权状态；
4.  冻结和 Digest 方式；
5.  Baseline / Treatment 的定义；
6.  执行器和模型/宿主信息；
7.  评价器、Rubric、Oracle 和评价独立性；
8.  Primary Metric 与 Hard Guardrails；
9.  样本纳入、排除、分组和泄漏控制；
10. 当前成熟度和已知限制；
11. 历史 Run 与 Evidence 引用；
12. Benchmark 变更记录。

这是一份治理要求，不要求所有 Suite 使用相同 JSON Schema。

## 6.9 Split / Holdout 策略

不采用统一三分法作为所有实验的硬要求。

分割方式必须符合研究问题：

- PLE 使用外层来源泄漏组和内层未来 Probe 的双层结构；
- Prompt A/B 使用相同真实 Pain 样本的配对对照；
- Pipeline Evolution 按场景和 Episode 管理历史基线及 Treatment；
- Challenge Suite 使用 actor-visible 与 judge-only 分离；
- Longitudinal 数据按时间窗口和真实行为机会定义。

对于确实需要防止反复调参过拟合的 Benchmark，应设置受控
Holdout，并记录每次访问。Holdout 泄漏后必须评估是否退役当前版本。

------------------------------------------------------------------------

# 7. 实验生命周期：最小关联，不强制统一协议

## 7.1 已有三类主要契约

| 契约                                                      | 当前职责                                                       | 当前调用方                 | v0.2 决策                                        |
|-----------------------------------------------------------|----------------------------------------------------------------|----------------------------|--------------------------------------------------|
| `experiment-manifest.v1`                                  | 实验元数据、PD Commit、Host、Model、Fixture 和数据范围         | Pipeline Evolution、PLE G1 | 继续复用；不承载全部研究设计和运行事实           |
| `preregistration.v0.1-draft` / PLE `preregistration.json` | PLE 研究假设、Claims、Contrast、执行顺序、预算、Owner 决策状态 | PLE G1                     | 保留为 PLE 领域研究契约                          |
| Prompt V2 ad-hoc run manifest                             | Run、Shard、Arm HEAD、Dataset SHA 等执行编排                   | \#2653 A/B                 | 先增加最小关联 Adapter，不将其强行替换成全局协议 |

另外，PRR、Challenge 和其他研究域有自己的 Dataset / Suite /
Authorization / Evidence 结构。

## 7.2 `experiment-manifest.v1` 的边界

当前 `experiment-manifest.v1` 已被真实调用，但它不包含：

- 完整 Hypothesis；
- Baseline / Treatment Arm；
- 样本分配；
- Prompt Variant 矩阵；
- 停止规则；
- 所有评价结果；
- 完整 Evidence 正文。

它仍是实验元数据契约，不应扩展成巨型实验数据库。

v0.2 不预先批准扩展其必填 Schema。

## 7.3 最小关联要求

在两个真实实验类型验证之前，只要求每个实验能够追溯：

- Experiment ID；
- Run ID；
- Domain / Suite ID；
- Dataset / Fixture ID 与版本（适用时）；
- Baseline / Treatment 标识（适用时）；
- Code Commit；
- Model / Host / Runtime 配置；
- 原始结果与 Evidence 引用；
- 报告引用；
- Owner Promotion Decision（适用时）。

现有工具已经具备的字段不重复存储。

如缺少关联，只允许先增加领域 Adapter 或 Sidecar。是否扩展
`experiment-manifest.v1`，必须由真实调用需求证明。

## 7.4 不建设全局实验 ID 注册中心

- 不新建数据库或服务；
- 不要求每个脚本都接入统一 API；
- 通过现有稳定 ID 和引用关系完成第一阶段关联；
- 只有当跨实验查找、权限、并发或生命周期管理真实成为瓶颈时，才评估
  Registry。

------------------------------------------------------------------------

# 8. Runner / Evaluator / Evidence / Replay / Report 的职责边界

## 8.1 Runner

保留领域 Runner：

- Pipeline Evolution：按现有 Episode / Closure Lab / CLI / Evidence
  流程执行；
- PLE：保留 G1 `runner.mjs` 和 G2 `real-runner.mjs`；
- PRR：保留 PRR 专用数据和执行准备；
- Prompt V2：保留 `ab-grid` → `ab-run` → `ab-lib::runPd`；
- Challenge / Examiner：保留 `challenge-runner.mjs`；
- Adaptive Selector：保留自己的受控执行方式。

不建设 Universal Runner。

## 8.2 Evaluator / Scorer

保留各自评价器：

- PLE mechanical Oracle / Evaluator；
- Examiner Claim-Evidence Scorer；
- Prompt V2 blind evaluator / metrics；
- Pipeline Evolution Evidence Metrics；
- 生产 `EvaluatorRunner`。

生产 `EvaluatorRunner` 是内部化业务门，不是实验通用 Scorer。

不建设 Universal Evaluator，也不强行把不同评价语义压成一个分数。

## 8.3 Evidence

已有 Evidence 机制应优先复用：

- Pipeline Evolution `evidence-package.mjs`；
- PLE Sidecar / Adjudications；
- Examiner 六级 Injection Evidence；
- Prompt V2 Blindpack / Eval / Metrics；
- PRR 领域 Evidence。

如果需要跨域关联，优先增加轻量引用 Adapter：

- 引用原始产物；
- 保留原始 Digest；
- 记录来源和版本；
- 不复制事实权威；
- 不改写领域评价结果。

只有当第二种实验类型证明相同的证据封装逻辑确实重复，才考虑提取公共
Envelope。

## 8.4 Replay

不建设通用 Trace Replay 作为第一阶段前置条件。

每个实验必须明确其可复现能力属于：

- Deterministic Fixture Re-execution；
- Offline Simulation；
- Real Host Re-execution；
- Challenge Resume；
- True Trace Replay（只有具备完整轨迹、状态和外部依赖控制后才可使用）。

不得把重新运行称为真实 Trace Replay。

## 8.5 Report

保留各领域报告：

- Pipeline Evolution Owner Review；
- PLE JSON / Markdown Comparison Report；
- Prompt V2 盲评与指标报告；
- PRR 研究报告；
- Examiner Challenge Report。

新产生的机器可计算指标应优先有结构化 JSON；但不要求一次性把所有历史
Markdown 改写成统一 Report Schema。

不得为了统一报告格式丢失领域语义和历史原始报告。

------------------------------------------------------------------------

# 9. 重要研发变更的实验准入与 Promotion Gate

## 9.1 核心原则

**研发分支中的实现和生产使用是两个不同阶段。**

允许开发者先在隔离分支/worktree 中实现候选版本，并用 PD-Lab 实验验证。

但重要行为变更在生产启用前必须有实验论证。若合并会立即改变默认生产行为，则实验必须先于该合并；若通过
Feature Flag 保持默认关闭，可以先合并候选代码，但未通过 Promotion Gate
前不得启用。

## 9.2 变更等级

| 等级 | 变更类型                                                                                         | 必须验证                                                        | 是否需要正式对照实验                             |
|------|--------------------------------------------------------------------------------------------------|-----------------------------------------------------------------|--------------------------------------------------|
| L0   | 文档、注释、纯格式、无行为变化的非关键 UI                                                        | 常规 CI / 文档检查                                              | 否                                               |
| L1   | 声称行为等价的重构、内部替换、核心路径性能优化                                                   | 契约回归、Benchmark Regression、等价性和资源差异                | 通常不需要独立 A/B；核心路径必须跑相关回归 Suite |
| L2   | Prompt、Agent 策略、局部算法、评分或选择逻辑的行为变更                                           | 预注册、Baseline/Treatment、相关 Benchmark、质量和成本指标      | 是，使用与风险相称的实验                         |
| L3   | 核心 Pipeline 状态机、候选准入、Principle 生成/选择/审批/激活、Runtime、安全权限、数据治理等变更 | 完整工作流对照、相关 Benchmark、负例/护栏、Evidence、Owner 审查 | 强制                                             |

不得通过拆分 PR 将一项 L3 变更降级。

## 9.3 “更优”的判定

实验开始前必须明确：

- Primary Metric；
- 预期改善方向；
- 最小有意义改善幅度或定性判据；
- Hard Guardrails；
- 样本范围；
- 不确定性和停止规则；
- 成本与延迟限制。

不得在看到结果后再选择对 Treatment 有利的指标。

对于 L3，以下项目不能被单一平均分抵消：

- 安全和权限；
- Owner 意图遵循；
- 证据真实性；
- 数据完整性；
- 核心任务完成；
- 错误激活或误阻断；
- 失败恢复与回滚能力。

没有足够样本或评价可靠性不足时，结论应保持不确定，不得以“看起来更好”批准生产晋级。

## 9.4 领域实验结果与 Owner 决策分离

不同实验保留自己的结果词汇：

- Pipeline Evolution 的 `PARTIAL_EPISODE` / `NOT_REACHED`；
- PLE 的 `METHOD_VALIDATED_ONLY` / `NOT_ESTIMABLE` /
  `INVALID_PROTOCOL`；
- Prompt V2 的 `PASS_WITH_LIMITATIONS`；
- Manifest 中已有的 `IMPROVED` / `NO_IMPROVEMENT` / `REGRESSION` /
  `INCONCLUSIVE` 等。

不得强制把它们转换成同一个 Evaluator 结果。

Owner Promotion Decision 是独立决策：

| 决策                  | 含义                                                            |
|-----------------------|-----------------------------------------------------------------|
| `PROMOTE`             | 证据满足预注册目标和硬护栏，Owner 批准进入正常生产发布/启用流程 |
| `HOLD`                | 证据不足、有限制或需要补实验                                    |
| `REJECT`              | 未改善、发生不可接受回归或违反护栏                              |
| `EMERGENCY_EXCEPTION` | 紧急安全/隐私/数据完整性修复的受控例外                          |

`PASS_WITH_LIMITATIONS` 不自动等于 `PROMOTE`。

## 9.5 Owner 的最终权限

- PD-Lab 不自动合并 PR；
- 不自动发布 npm；
- 不自动部署 Docker；
- 不自动激活 Principle；
- 不自动修改生产 Feature Flag；
- 不自动把实验候选覆盖到生产 Prompt。

最终生产晋级由 Owner 明确批准，并继续经过正常 Code Review、CI、Release
和 Rollout 流程。

## 9.6 紧急修复例外

安全漏洞、隐私泄漏、数据损坏、权限绕过或严重生产事故可以先止损。

要求：

1.  例外范围仅限紧急修复；
2.  记录风险、影响和批准；
3.  采用最小修复；
4.  保留回滚；
5.  事后补充必要 Benchmark / Regression 验证；
6.  不得以例外绕过常规 Prompt 或策略优化的实验要求。

------------------------------------------------------------------------

# 10. PD-Lab 与用户发版的隔离

## 10.1 必须排除的内部研发资产

新增的以下资产不得进入用户发布闭包：

- 内部实验编排；
- PD Native Dataset 原始/研究数据；
- Benchmark 管理脚本；
- Prompt A/B harness；
- 离线研究 Runner；
- 研究 Evaluator；
- 内部研究报告生成器；
- 实验数据导出和分析工具；
- 内部研发依赖。

## 10.2 必须保留的既有产品化模块

当前 `scripts/build/lab-payload.mjs` 和 `bundle-plugin.mjs` 有意将
Examiner 所需的七个模块打包到 `console/lab`。

`lab-payload-closure.test.ts` 明确检查：

- 所有 Console 引用模块都在闭包内；
- 不把整个 `principle-learning-lab/lib` 打包；
- 不打包测试材料；
- 不打包会读取用户 Home API Key 的研究 Transport；
- 模块越出 `lib/` 时 fail-loud。

v0.2 必须保留该边界，不得把产品化 Examiner 能力与内部研发 PD-Lab
混为一谈。

## 10.3 发布隔离验收

每个涉及 PD-Lab 的实现阶段必须验证：

- npm tarball 内容；
- Docker 用户镜像内容；
- 插件发布包内容；
- Console bundle 闭包；
- 安装载荷依赖图；
- Lab-only 依赖负向测试。

内部研发模块误入用户发布闭包时，构建或发布检查必须失败。

------------------------------------------------------------------------

# 11. 数据安全与历史数据治理

## 11.1 Prompt V2 历史数据风险

`PUBLIC_DATA_REDACTION_AUDIT.md` 记录：

- 当前提交的数据文件已经过脱敏、canary 和泄漏扫描；
- 全保真副本保留在本地 gitignored `.tmp`；
- 早期未完整脱敏的 Pain Dataset / Inventory 曾进入已推送的 PR 分支历史；
- 审计报告未发现凭证或 Token 被提交；
- 历史清理尚未执行，原报告要求 Owner 决策。

v0.2 不擅自判断该风险已消失，也不授权 Agent 重写历史或 force-push。

## 11.2 新数据集准入门

任何新真实数据集进入正式 Benchmark 前，必须完成：

- 数据源与授权；
- 字段最小化；
- 原始数据与脱敏数据分层；
- 稳定匿名化；
- 路径和凭证扫描；
- 自由文本和嵌套 JSON 检查；
- canary 正控；
- 脱敏重建一致性；
- 数据版本冻结；
- 访问和保留策略。

不能仅依赖字段名黑名单。

## 11.3 数据历史与保留

- 原始生产数据仍由业务系统持有；
- 实验快照仅保存必要研究数据；
- 公开 Git 只存允许公开的脱敏数据；
- 全保真数据使用受控存储；
- 数据过期、授权撤回和删除请求必须有可执行处理流程；
- 不得以“方便复现”为由永久保存超出授权范围的个人数据。

------------------------------------------------------------------------

# 12. 可复现性与实验有效性

## 12.1 每个正式实验的最低冻结信息

适用时记录：

- Experiment / Run / Arm；
- Git Commit；
- Prompt / Variant Hash；
- Dataset / Fixture Version；
- 输入 Digest 与算法；
- Model / Provider / Version；
- Host / Runtime / Tool 配置；
- Feature Flags；
- 执行顺序和重复次数；
- Evaluator / Rubric 版本；
- Preregistration 版本；
- 预算、超时和停止条件。

如果某项信息不可获得，必须标记 UNKNOWN，不得补造。

## 12.2 失败与缺失必须保留

- 超时；
- Provider 限流；
- Host 失败；
- 未生成候选；
- Owner 合法拒绝；
- Pipeline 未到达；
- 无法观测；
- 数据损坏；
- Evidence 不完整。

这些状态不能被静默删除或合并成“测试失败”。

Pipeline 未到达不等于 Actor 行为失败；没有 Activation 不能宣称发生了 PD
行为注入或行为改善。

## 12.3 重跑规则

- 新模型、新配置、新数据或新代码 Commit 都必须形成新 Run；
- 不覆盖历史 Run；
- 不能把新的模型结果混入原始 A/B；
- 历史结果导入 PD-Lab 时必须保留原始 Run 身份和证据等级；
- 缺少原始产物时只能引用现有报告，并明确标记证据不完整；
- 不得通过重新运行伪造历史实验的完整性。

------------------------------------------------------------------------

# 13. 分阶段建设路线图

本路线图对齐长期目标，但不要求一次性完成。每个阶段都必须独立验收。

## Stage 0 — Capability Inventory

**状态：完成。**

- PR \#2672 已合并；
- `PRI-1244` 已完成；
- 已盘点四套主要实验工具族、Prompt V2 和生产桥；
- 已形成源码、调用关系、成熟度与重复建设风险报告。

## Stage 1 — 最新源码 Reality Audit 与架构修订

**状态：本 v0.2 已完成针对性核验。**

核验结果：

- 当前 main `592f50b...`；
- \#2670 是 \#2672 后唯一提交；
- Lab 相关源码未受该提交改变；
- 补充发现并纳入 `SPEC-PD-PL-001 v0.3`、PRR、Pipeline Evolution
  Benchmark 和 Prompt V2 最终报告；
- 修正 v0.1 的 Dataset、Benchmark、Evidence 和发版边界假设。

## Stage 2 — Prompt V2 历史实验接入

**关联工单：PRI-1245（需先修订描述）。**

目标不是重做 Prompt A/B，而是把 \#2653 已完成实验纳入可追溯的 PD-Lab
生命周期。

实施前：

1.  检查本地 `.tmp/prompt-v2-ab/` 和 `.tmp/prompt-v2-inventory/`
    是否仍存在；
2.  核对已有产物与已提交报告中的 Dataset / Prompt / Run Digest；
3.  识别哪些历史产物可复核，哪些只有报告；
4.  不得把新运行冒充历史 Run；
5.  不得重写 PR \#2653 历史或改动生产 Prompt。

交付：

- Prompt V2 实验身份与现有 `experiment-manifest.v1` 的关联方案；
- Run / Arm / Dataset / Prompt Hash 的引用关系；
- 原始 Blindpack、Eval、Metrics、Report 的引用索引；
- 评价独立性限制；
- 复现限制；
- Owner Review Card。

只有实际发现无法通过引用表达的缺口，才增加薄 Adapter / Sidecar。

## Stage 3 — Core Pipeline Benchmark Portfolio 整理

目标：以 Pipeline Evolution 为核心基础，确认 PD 核心管道的 Benchmark
覆盖和成熟度。

交付：

- S001–S006 的当前状态和真实执行证据；
- Episode 001 / 002-R2 / 002-R3 的证据完整性；
- 哪些场景能跑 Fixture、哪些能运行真实宿主、哪些能观察
  Activation/Behavior；
- 当前 Benchmark 缺口与下一批优先补齐场景；
- 对历史外部实验数据的可复现性说明；
- 形成 Core Pipeline Benchmark v0 的 Owner 决策卡。

禁止新建一个平行的 `pd-core-benchmark` Runner 或 Dataset Store。

## Stage 4 — 第二种实验类型验证

**关联工单：PRI-1246（需修订实验选择和复用要求）。**

优先研究能否使用现有 Pipeline Evolution Episode 作为与 Prompt A/B
不同类型的第二案例。

如果它无法满足严格的 Baseline / Treatment 对照要求，再选择新的 Runtime
行为变更案例。

验证重点：

- 是否能复用实验身份和元数据关联；
- 是否能引用领域 Dataset / Scenario；
- 是否保留不同 Runner / Evaluator；
- 是否能通过最小 Evidence 引用进行复核；
- 是否仍需复制 Prompt V2 的大部分编排代码。

结论只能由真实运行证据决定：

- `GENERALIZED`
- `GENERALIZED_WITH_LIMITATIONS`
- `NOT_GENERALIZED`

## Stage 5 — Promotion Gate v0

目标：让 L2 / L3 重要变更在生产启用前必须提供实验依据。

第一版先采用人工可执行流程：

- PR 标注变更等级；
- 关联 Benchmark Suite；
- 记录 Baseline / Treatment；
- 关联 Run / Evidence / Report；
- Owner 给出 Promotion Decision。

当流程稳定后，再增加 CI：

- 检查 L3 PR 是否具备实验引用；
- 检查 Evidence Digest / 引用是否有效；
- 检查是否有 Owner Decision 或授权例外；
- 不在普通 CI 中默认执行昂贵真实模型实验。

## Stage 6 — PD Native Dataset 持续扩充

在现有 Dataset 体系基础上扩充：

- 增加有授权的真实 Pain / Diagnosis / Candidate / Owner Decision 样本；
- 补齐失败、未到达、拒绝和负面结果；
- 扩充跨场景和跨任务样本；
- 建立真实样本与合成样本的分层；
- 按研究问题设置来源隔离和 Holdout；
- 逐步提高 Benchmark 的代表性和覆盖率。

不以数据量作为唯一目标，不为扩充而扩充。

## Stage 7 — Longitudinal Benchmark

目标：用真实时间跨度和真实行为机会评价 PD 是否产生持续改善。

必须有：

- 经授权的观察对象；
- 清晰的 baseline 和 after 窗口；
- 真实行为机会数；
- 纠正、复发、误阻、Owner 负担和副作用；
- 原则激活与行为变化的归因限制；
- 长期数据保留和撤回机制。

没有足够时间跨度或有效机会时，必须标记证据不足。

------------------------------------------------------------------------

# 14. Gate 与验收矩阵

| Gate | 阶段                     | 必须交付                                              | 通过标准                               |
|------|--------------------------|-------------------------------------------------------|----------------------------------------|
| G0   | Capability Inventory     | \#2672 报告                                           | 已完成                                 |
| G1   | Reality Audit            | 当前源码基线和修订后的架构决策                        | 当前关键源码与设计一致，UNKNOWN 明确   |
| G2   | Prompt V2 历史接入       | Run / Arm / Dataset / Prompt / Eval / Evidence 引用链 | 不改写历史，证据等级准确，缺失项明确   |
| G3   | Core Benchmark Portfolio | S001–S006 和 Episode 成熟度地图                       | 真实运行、Fixture、Behavior 证据不混淆 |
| G4   | 第二类型实验             | 第二实验类型的真实接入结果                            | 领域 Runner 保留，公共关联能力可复用   |
| G5   | Promotion Gate v0        | PR 证据要求和 Owner Decision 流程                     | 重要变更未获批准不得生产启用           |
| G6   | Dataset Expansion        | 授权真实数据与版本治理                                | 来源、授权、脱敏、冻结和分割可审计     |
| G7   | Longitudinal             | 真实长期行为观察                                      | 有真实时间跨度和行为机会支撑结论       |

任何 Gate 未通过，不得将该阶段描述为完成。

------------------------------------------------------------------------

# 15. 测试与质量要求

## 15.1 实验协议测试

- Manifest 向后兼容；
- Dataset / Fixture Digest；
- 预注册与实际执行顺序一致；
- Gold / Judge-only 泄漏；
- Baseline / Treatment 输入一致性；
- Run / Arm / Sample 关联完整；
- 评价结果保留原始语义；
- Evidence 引用可定位。

## 15.2 Benchmark 测试

- 每个 Suite 有明确范围和版本；
- 正例、负例、边界例和无关变化控制；
- 关键场景有机械 Oracle 或可审查 Rubric；
- 不同样本分层可单独分析；
- 失败和未到达状态不被静默排除；
- 评价器不能仅凭文风、长度或免责声明获得高分；
- 对核心变更应验证旧能力不退化。

## 15.3 隔离测试

- 实验 workspace 不与生产 workspace 重叠；
- 实验 DB 不写生产状态；
- 生产环境变量不能被意外继承；
- 未授权模型调用 fail-closed；
- 实验取消、崩溃和重试不污染生产数据；
- 全保真数据不进入公开发布产物。

## 15.4 端到端验收

每次正式实验至少提交：

- 当前 main / Baseline / Treatment Commit；
- Dataset / Benchmark Version；
- Run IDs；
- 模型、Host、配置和预算；
- 样本数和有效分母；
- 成功、失败、排除和重试数量；
- 主要指标、护栏和不确定性；
- Evidence / Report 引用；
- CI 结果；
- 未解决问题；
- Owner Promotion Decision。

未运行的测试不能写 PASS；离线模拟不能写成真实宿主验证。

------------------------------------------------------------------------

# 16. 风险与停止条件

| 风险                         | 处理                                        |
|------------------------------|---------------------------------------------|
| 重复建设 Dataset / Benchmark | 先盘点现有 Suite；新建前必须证明无法复用    |
| 过度统一 Runner / Evaluator  | 保留领域实现，第二案例验证后再抽象          |
| 合成数据冒充真实数据         | 数据类型显式标记，报告分层                  |
| 真实数据泄漏                 | 授权、脱敏、canary、扫描、受控存储          |
| 小样本误判                   | 预注册分析方法和不确定性，必要时 HOLD       |
| 评价器偏差                   | 披露独立性，人工抽查和机械 Oracle           |
| Benchmark 过拟合             | 来源隔离、受控 Holdout、版本冻结            |
| Pipeline 未到达被误判        | Pipeline Reachability 与 Actor Outcome 分离 |
| 实验污染生产                 | workspace、DB、环境和权限隔离               |
| 内部研发模块进入发布包       | 依赖闭包检查和负向测试                      |
| PASS 自动晋级                | Owner Promotion 独立于实验结果              |
| 长期行为证据不足             | 不作长期改善主张                            |

以下情况必须停止当前阶段：

- 数据授权不明确；
- 输入无法冻结；
- Baseline / Treatment 不可比；
- 实验环境可能写入生产；
- 评价器存在重大未解决偏差；
- Evidence 缺失或无法复核；
- 关键安全护栏失败；
- 结果只能靠叙述性主观判断；
- 内部 Lab 代码进入用户发布闭包。

------------------------------------------------------------------------

# 17. Linear 工单与既有工作关系

当前状态已核验：

| 工单        | 当前状态 | 当前职责                                               | v0.2 建议                                                                                                                  |
|-------------|----------|--------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| PRI-1244    | Done     | PD Lab Capability Inventory                            | 已完成，不重复盘点                                                                                                         |
| PRI-1245    | Backlog  | \#2653 Prompt V2 接入现有 pd-lab                       | 保留，但必须更新描述：#2653 已有完整实验结果，目标是历史实验关联和最小生命周期接入；不得假定有统一 Runner/Evaluator/Replay |
| PRI-1246    | Backlog  | 第二类型实验验证                                       | 保留，但更新为优先评估现有 Pipeline Evolution Episode；不强制与 Prompt 共用 Runner/Evaluator                               |
| PRI-966     | Done     | SPEC-PD-PL-001 v0.3 总工单                             | 作为独立研究轨道保留，不重做                                                                                               |
| PRI-967–971 | Done     | PLE G1/G2 数据、Oracle、Sidecar、授权与真实 Actor 准备 | 复用已有结果；真实 Agent Pilot 仍需按现有授权状态处理                                                                      |

建议顺序：

1.  更新 PRI-1245 的目标和验收，避免按错误的“统一 Runner / Evaluator /
    Replay”假设开发。
2.  完成 \#2653 历史实验接入。
3.  整理 Pipeline Evolution Benchmark 现有资产。
4.  更新 PRI-1246，评估用现有 Pipeline Evolution 作为第二实验类型。
5.  两种类型验证后再制定 Promotion Gate v0 的自动化范围。

本 SPEC 不自动创建新工单，也不改变既有工单状态。

------------------------------------------------------------------------

# 18. ADR — v0.2 架构决策

| ADR     | 决策                                                                     | 状态          |
|---------|--------------------------------------------------------------------------|---------------|
| ADR-001 | PD-Lab 是内部研发治理与验证能力集合，不要求单一 package                  | v0.2 提议     |
| ADR-002 | Pipeline Evolution 是核心管道 Benchmark 的首要基础                       | v0.2 提议     |
| ADR-003 | PD Benchmark 采用多个领域 Suite 组成的 Portfolio，不建单一全能 Benchmark | v0.2 提议     |
| ADR-004 | 复用 `experiment-manifest.v1`，但不扩展成巨型 Manifest                   | v0.2 提议     |
| ADR-005 | PLE / PRR 保留各自 Dataset 和 Sidecar                                    | v0.2 提议     |
| ADR-006 | \#2653 作为已完成的历史实验接入，不默认重跑                              | v0.2 提议     |
| ADR-007 | Runner / Evaluator / Replay 保留领域边界                                 | v0.2 提议     |
| ADR-008 | Evidence 优先复用领域 Package，仅增加薄引用 Adapter                      | v0.2 提议     |
| ADR-009 | 新增内部 PD-Lab 研发工具不进入用户发版                                   | v0.2 提议     |
| ADR-010 | 现有产品化 Examiner `console/lab` 白名单必须保留                         | VERIFIED 约束 |
| ADR-011 | L2 / L3 行为变更在生产启用前必须有适当实验论证                           | v0.2 提议     |
| ADR-012 | PASS 与 Owner Promotion 分离                                             | v0.2 提议     |
| ADR-013 | 先人工 Promotion 流程，再建设 CI 证据检查                                | v0.2 提议     |
| ADR-014 | 不建设通用 Trace Replay 作为首阶段前置                                   | v0.2 提议     |
| ADR-015 | 不建设中央 Dataset Store / Registry 作为首阶段前置                       | v0.2 提议     |

------------------------------------------------------------------------

# 19. Owner 需要确认的事项

1.  **核心 Benchmark 选择：** 是否同意以 Pipeline Evolution 作为 PD
    核心管道 Benchmark 的首要基础。建议采纳。
2.  **Prompt V2 历史数据：** 是否接受早期公开 Git
    历史暴露风险，或授权后续专项治理。不得由 Agent 自动 force-push。
3.  **历史 `.tmp` 实验产物：** 是否仍在 Owner 本机保存，是否允许本地 AI
    只读核验并生成历史实验索引。
4.  **Promotion 的生产边界：** 是否同意“代码可在分支中开发和实验，但未经
    Promotion 不得生产启用”的规则。
5.  **真实数据存储：**
    在建立可控的真实数据存储和访问策略前，是否接受全保真 Dataset
    仅在授权本机/受控环境使用，不进入公开 Git。

------------------------------------------------------------------------

# 20. 后续实施 SPEC 的强制模板

每个后续实施 SPEC 必须包含：

1.  对齐的 Owner 长期目标；
2.  当前 main SHA；
3.  Reality Audit；
4.  已有资产和调用关系；
5.  复用 / Adapter / 真正新增能力的理由；
6.  明确范围和非目标；
7.  Dataset 来源、授权、脱敏和隔离；
8.  Baseline / Treatment；
9.  指标、护栏和分析方法；
10. 失败、重试和恢复；
11. Evidence / Report 引用；
12. 发布闭包检查；
13. 端到端测试；
14. Gate 和验收；
15. 回滚方案；
16. Owner 决策项。

任何实施 SPEC 不得以“统一”为理由绕过现有领域契约。

------------------------------------------------------------------------

# 21. 完成定义

本 SPEC v0.2 的设计目标：

- 明确 PD-Lab 的长期使命；
- 纠正现有资产判断；
- 将 Pipeline Evolution 纳入核心 Benchmark 基础；
- 将 PLE、PRR、Prompt V2、Examiner 和 Adaptive Selector
  放回正确的领域边界；
- 明确 PD Native Dataset 是受治理的资产组合，不是新建一个全局 Store；
- 明确 Runner、Evaluator、Evidence、Replay 和 Report 的复用边界；
- 明确重要变更的实验与 Promotion 规则；
- 明确内部研发工具与产品化 Examiner 发布边界；
- 形成可执行的分阶段路线图和既有 Linear 工单衔接方式。

本 SPEC 不代表：

- 所有 Benchmark 已达到 `behavioral-verified`；
- PLE G2 真实 Agent Pilot 已完成；
- PRR 已有真实授权样本；
- \#2653 所有本地实验产物都已归档；
- 通用 Evidence / Replay 已实现；
- Promotion Gate 已由 CI 强制执行；
- 所有历史数据风险已解决。

**最终原则：PD-Lab 不以建设平台本身为成功，而以它能否持续证明 PD
的重要改动确实改善了真实能力、没有破坏既有能力，并且让 Owner
能基于可信证据作出生产决策为成功。**
