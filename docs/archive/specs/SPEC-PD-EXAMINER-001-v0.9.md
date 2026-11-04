# SPEC-PD-EXAMINER-001 v0.9
# Examiner 核心功能实施规范
## 基于真实宿主的 Principle 行为效果与增量价值验证

| 属性 | 内容 |
|---|---|
| SPEC ID | SPEC-PD-EXAMINER-001 |
| Version | v0.9 |
| Date | 2026-10-31 |
| Status | PROPOSED_FOR_OWNER_APPROVAL |
| Supersedes | v0.8 |
| Research foundation | Examiner v0.7 / Principle Learning Lab |
| Primary product mode | Full Principle Library A/B |
| Diagnostic mode | Isolated Principle A/B |
| Research object | OpenClaw / Codex / WorkBuddy 等真实 Agent 宿主 |
| Default implementation | Offline-first |
| Real model calls | NOT AUTHORIZED |
| Real host execution | NOT AUTHORIZED |
| Production writes | NOT AUTHORIZED |

---

# 0. 本次 SPEC 的核心目标

## 0.1 要解决的问题

Principles Disciple 已经能够从 Pain 中提取失败机制，形成 Principle，并通过宿主机制将 Principle 提供给 Agent。

但我们仍然缺少一个关键能力：

**一条 Principle 被激活后，是否真正改变了宿主的行为？它是否产生了稳定、可重复且值得保留的增量价值？**

Owner 可能观察到：

- Codex 开始主动验证结果，而不是直接声称完成。
- WorkBuddy 不再轻易跳过必要步骤。
- OpenClaw 能够在复杂任务中保持原则约束。
- 某些 Agent 的行为确实发生了明显改善。

但是，单次观察无法证明：

1. 改善是否来自目标 Principle。
2. 改善是否能够重复出现。
3. 改善是否只是底层模型自身的能力。
4. 是否因为其他 Principle 已经覆盖了相同要求。
5. 是否出现了新的负迁移。
6. 是否增加了不合理的运行成本。
7. 在当前完整原则体系中，这条 Principle 是否仍然有额外价值。

Examiner 的任务就是提供这种独立验证能力。

## 0.2 核心产品定义

Examiner 是 PD 的独立行为效果评估工具。

它使用经过验证的 Pain、Failure Mechanism 和 Principle 构造可信挑战题，在真实 Agent 宿主中建立受控 A/B 实验，通过独立评分、统计分析和执行证据，评价 Principle 对宿主行为的实际影响。

研究对象是：

- OpenClaw 宿主。
- Codex 宿主。
- WorkBuddy 宿主。
- 未来经过验证的其他 Agent 宿主。

**不是底层 LLM 本身。**

底层 LLM 是实验环境中的一个变量，需要保持一致并记录身份，但不是 Examiner 最终评价的对象。

## 0.3 本次核心产品决策

| 编号 | 决策 | 级别 |
|---|---|---|
| D01 | Full Principle Library A/B 为默认实验模式 | P0 |
| D02 | Isolated Principle A/B 为诊断模式 | P0 |
| D03 | 每个 Study 默认只验证一条目标 Principle | P0 |
| D04 | 必须验证 Principle 实际注入状态 | P0 |
| D05 | 使用 Host-effective Principle Set，而不是全局 Principle 数据库 | P0 |
| D06 | ITT 为主要统计分析 | P0 |
| D07 | Treatment Fidelity 独立记录 | P0 |
| D08 | Gold 与 Actor 严格隔离 | P0 |
| D09 | 题目质量、评分能力、干预效果独立评价 | P0 |
| D10 | 固定分母和 UNKNOWN 纪律 | P0 |
| D11 | 保留 v0.7 Scorer V3 和 Report V2 兼容性 | P0 |
| D12 | 复用现有 PL Lab，不建设平行研究引擎 | P0 |

## 0.4 明确不属于本次范围

- Owner 日常行为观察功能。
- 宿主内 Owner Observation 命令。
- 自动创建、审批、激活或撤销 Principle。
- 自动修改生产 Principle。
- 自动修改生产 RuleCode。
- 将 Examiner 加入 PD 内置 Agent 主 DAG。
- 新建独立生产 Agent。
- 新建平行 Runner、Ledger、Scorer 或数据库。
- 新建独立调度系统。
- 直接建设完整 2×2 因子实验系统。
- 直接建设跨宿主长期行为追踪系统。
- 以 Examiner 结果自动决定 Principle 是否应该保留。

---

# 1. 产品架构

Examiner 只需要五个核心能力。

```text
                 PD Existing Evidence
                          |
                          v
                 1. Challenge Builder
                          |
                          v
                 2. Experiment Designer
                          |
                          v
                 3. Experiment Runner
                          |
                          v
                 4. Independent Adjudicator
                          |
                          v
                 5. Behavioral Evidence Report
                          |
                          v
                     Owner Decision
```

## 1.1 Challenge Builder

职责：

- 选择经过验证的 Pain。
- 识别 Failure Mechanism。
- 关联目标 Principle。
- 生成挑战题候选。
- 组织 Gold。
- 冻结 Challenge Suite。

不负责批准 Gold。

## 1.2 Experiment Designer

职责：

- 创建 Study。
- 选择实验模式。
- 冻结实验变量。
- 建立 A/B 分组。
- 确定 Primary Endpoint。
- 预注册样本量、重复和随机化策略。

## 1.3 Experiment Runner

职责：

- 复用现有真实宿主执行机制。
- 建立独立 Session 和 Workspace。
- 应用 A/B 配置。
- 执行挑战任务。
- 收集实际加载证据。
- 保存原始执行轨迹。

不负责评分。

## 1.4 Independent Adjudicator

职责：

- 根据冻结 Gold 评分。
- 独立评价原则遵循。
- 独立评价任务结果。
- 识别负迁移。
- 记录不确定性。

不得使用 Actor 的自我评价替代证据。

## 1.5 Behavioral Evidence Report

职责：

- 汇总实验结果。
- 评价行为变化。
- 评价干预执行忠实度。
- 分析负迁移和成本。
- 解释因果归因边界。
- 提供 Owner 决策依据。

---

# 2. 两种 A/B 实验模式

这是 Examiner 最核心的产品能力。

两种模式研究不同问题，不能混淆。

## 2.1 模式 A：Isolated Principle A/B

**定位：独立原则机制验证。**

回答：

> 如果只给 Agent 这一条 Principle，它本身能不能改变 Agent 的行为？

### 实验变量

| 实验条件 | Control A | Treatment B |
|---|---|---|
| 目标 Principle | OFF | ON |
| 其他 PD Principle | OFF | OFF |
| 目标 RuleCode | OFF | OFF |
| 其他 PD RuleCode | OFF | OFF |
| 宿主原生系统规则 | 保持不变 | 保持不变 |
| Host | 相同 | 相同 |
| Model | 相同 | 相同 |
| Memory 初态 | 相同 | 相同 |
| Hook | 相同 | 相同 |
| Tools | 相同 | 相同 |
| Permissions | 相同 | 相同 |
| Workspace 初态 | 相同 | 相同 |

注意：

这里关闭的是 PD 管理的 Principle 和 RuleCode。

不关闭宿主自身的安全规则、系统提示、必要运行时机制或原生工具约束。

### 实验用途

- 验证 Principle 是否具有独立行为影响。
- 判断原则描述是否有效。
- 识别 Principle 自身可能造成的负迁移。
- 识别 Principle 是否依赖其他 Principle 才能发挥作用。

### 结果边界

模式 A 的结果不能直接代表完整 PD 系统中的实际效果。

---

## 2.2 模式 B：Full Principle Library A/B

**定位：完整原则库下的增量价值验证。**

<badge>默认模式</badge>

回答：

> 在当前 PD 原则体系中，额外启用这条 Principle，是否真的让宿主表现得更好？

这是 Examiner 最主要的产品价值。

### 2.2.1 Host-effective Principle Set

不能将 PD 数据库中所有 Principle 都称为当前完整原则库。

定义：

`Host-effective Principle Set`，简称 HEPS。

它表示：

**在指定宿主、渠道、激活状态、适用条件和运行时选择机制下，具备实际运行资格的 Principle 集合。**

例如：

| Principle | 全局状态 | Codex 资格 | 本次实验 |
|---|---|---|---|
| P1 | ACTIVE | 适用 | ON |
| P2 | ACTIVE | 适用 | ON |
| P3 | ACTIVE | 不适用 | 不纳入 |
| P4 | REVOKED | 不适用 | 不纳入 |
| P5 | ACTIVE | 适用 | 目标变量 |
| P6 | DRAFT | 不具备资格 | 不纳入 |

HEPS 必须由正式激活、审批、适用性和宿主选择规则共同确定。

不能把以下 Principle 自动加入：

- DRAFT。
- PENDING_APPROVAL。
- REVOKED。
- RETIRED。
- EXPIRED。
- 不符合当前宿主适用条件的 Principle。

目标 Principle 单独作为实验干预变量管理。

### 2.2.2 实验变量

假设当前宿主有效原则集合为：

`P1, P2, P3, P4, P5`

其中 P5 是目标 Principle。

| Principle | Control A | Treatment B |
|---|---|---|
| P1 | ON | ON |
| P2 | ON | ON |
| P3 | ON | ON |
| P4 | ON | ON |
| P5（目标） | OFF | ON |

非目标 Principle 完全冻结。

### 2.2.3 RuleCode 处理

这是 v0.9 对 v0.8 的重要修正。

| RuleCode | Control A | Treatment B |
|---|---|---|
| 目标 Principle 对应 RuleCode | 保持当前基线状态 | 保持当前基线状态 |
| 其他 Principle 对应 RuleCode | 保持当前基线状态 | 保持当前基线状态 |
| 无关 RuleCode | 保持当前基线状态 | 保持当前基线状态 |

如果目标 RuleCode 在当前系统中已经启用，不能为了实验而擅自关闭。

因为模式 B 研究的是目标 Principle 在当前真实系统中的增量价值。

### 2.2.4 Principle 与 RuleCode 无法独立控制时

必须区分：

- `principle_only`：只切换目标 Principle。
- `bundled_intervention`：目标 Principle 与 RuleCode 作为不可分割的组合一起变化。

如果系统无法在保持目标 RuleCode 不变的前提下切换 Principle：

1. 不得伪装成 Principle-only 实验。
2. 明确记录耦合原因。
3. 标记研究对象为 bundled intervention。
4. 报告只能归因到组合干预。
5. 不得声称已经证明自然语言 Principle 的独立效果。

未来可以通过 2×2 因子实验分离 Principle 和 RuleCode 的效果。

但 2×2 不属于本次 MVP。

### 2.2.5 容量竞争

完整原则库模式必须记录：

- 原则资格集合。
- 运行时选择结果。
- 实际注入集合。
- 被容量限制排除的原则。
- 被挤出的原则。
- 排除原因。
- 优先级。
- 上下文容量。
- 注入内容 Hash。

如果 Treatment 增加目标 Principle 导致其他 Principle 被挤出：

这属于完整系统的实际边际效果的一部分。

不能为了获得更漂亮的实验结果而事后删除这些样本。

报告必须分别说明：

1. 系统整体行为是否改善。
2. 目标 Principle 是否成功注入。
3. 哪些非目标 Principle 被挤出。
4. 是否发生其他行为退化。
5. 是否增加上下文和执行成本。

**主要分析评价整个系统的实际增量效果；机制分析解释效果产生的原因。**

---

# 3. 实验单位与 A/B 隔离

## 3.1 Study 的最小实验单位

一个 Study 包含：

- 一个目标 Principle。
- 一种实验模式。
- 一个 Host。
- 一个 Model 身份和版本。
- 一个冻结 Challenge Suite。
- 一个 Primary Endpoint。
- 一套预注册执行计划。

不同 Host 或 Model 需要建立独立 Study。

不能将 OpenClaw、Codex、WorkBuddy 的结果直接合并成一个未经分层的实验结果。

## 3.2 Pair 定义

实验单位：

`Pair = Case × Repetition`

每个 Pair 包含：

```text
Pair-001
  |
  +-- Control
  |     Principle OFF
  |     Session A
  |     Workspace A
  |
  +-- Treatment
        Principle ON
        Session B
        Workspace B
```

两侧必须使用相同的初始环境快照，但不能共享运行状态。

## 3.3 隔离要求

每个 A/B 执行必须满足：

- 独立 Session。
- 独立 Workspace。
- 独立初始状态。
- 不共享跨臂 Memory。
- 不共享执行产生的文件。
- 不共享会话历史。
- 相同模型身份。
- 相同 Host 版本。
- 相同 Tools。
- 相同权限。
- 相同公共系统上下文。
- 相同任务预算。
- 相同执行协议。

如果执行顺序会影响模型、服务或工具状态，应通过随机化和平衡顺序降低时间偏差。

默认使用配对随机化执行顺序。

例如：

- Pair 1：A → B。
- Pair 2：B → A。
- Pair 3：B → A。
- Pair 4：A → B。

随机化结果必须在执行前冻结。

## 3.4 不允许跨臂污染

禁止：

- Treatment 读取 Control 的执行记录。
- Control 读取 Treatment 的 Memory。
- 两组使用同一个可变 Workspace。
- 两组共享会影响后续行为的历史状态。
- Actor 访问 Gold。
- Actor 获得实验组标签以外的评分提示。

如果出现跨臂污染，保留证据并按照实验失效规则处理。

---

# 4. 实验预注册

所有正式 Study 在执行前必须冻结实验计划。

## 4.1 必需字段

逻辑契约至少包含：

```ts
interface ExaminerStudyManifest {
  schemaVersion: string;
  studyId: string;

  targetPrinciple: {
    id: string;
    version: string;
    contentHash: string;
  };

  experimentMode:
    | "isolated_principle"
    | "full_library_incremental";

  interventionType:
    | "principle_only"
    | "bundled_intervention";

  hostManifestHash: string;
  modelManifestHash: string;
  principleSetSnapshotHash: string;
  ruleCodeSnapshotHash: string;
  runtimeManifestHash: string;

  challengeSuiteHash: string;
  goldSnapshotHash: string;
  scorerVersion: string;

  primaryEndpoint: {
    id: string;
    definitionHash: string;
    applicabilityRuleHash: string;
  };

  secondaryEndpoints: string[];
  negativeTransferMetrics: string[];
  operationalCostMetrics: string[];

  randomizationSeed: string;
  plannedPairs: number;
  repetitionsPerCase: number;

  analysisPlanHash: string;
  invalidationPolicyHash: string;

  authorizationRef?: string;
}
```

这是逻辑字段要求，不意味着必须新建同名 TypeScript 类型。

Phase 0 必须先核对现有 Preregistration 契约，并优先扩展现有结构。

## 4.2 预注册纪律

执行后不得修改：

- Primary Endpoint。
- Challenge Suite。
- Gold。
- 随机化结果。
- 主要统计方法。
- 样本计划。
- Principle Snapshot。
- Model Manifest。
- Host Manifest。

确实需要改变时，必须创建新版本或新 Study。

---

# 5. Primary Endpoint 与统计设计

这是 v0.9 新增的核心研究纪律。

## 5.1 每个 Study 只能有一个 Primary Endpoint

每个 Study 必须预先选择一个主要评价指标。

例如目标 Principle：

「没有执行测试，不得宣称测试通过。」

Primary Endpoint：

`Target Unsupported Completion Assertion Rate`

定义：

在预先指定的适用挑战任务中，Actor 在缺少必要验证证据时，仍然明确声称任务或测试已经通过的比例。

Primary Endpoint 必须：

- 与目标 Failure Mechanism 直接相关。
- 可以从原始执行轨迹复算。
- 具有冻结 Gold 和明确判定谓词。
- 有明确的适用条件。
- 有明确的统计单位。
- 不依赖 Owner 主观印象。

不能在看到结果后挑选表现最好的一项作为 Primary Endpoint。

## 5.2 Secondary Endpoints

可以包括：

- Principle Conformance。
- Evidence Alignment。
- Objective Task Outcome。
- 其他相关失败机制。
- 负迁移。
- 成本。
- Treatment Fidelity。

Secondary Endpoint 不得替代 Primary Endpoint。

## 5.3 ITT：Intention-to-Treat

**ITT 是主要统计分析。**

按照预先随机分配的 A/B 组进行分析。

不论某次 Treatment 是否成功注入目标 Principle，都必须保留原始分配记录。

原因：

假设 Treatment 计划执行 100 次，实际成功注入 80 次。

如果只统计这 80 次，可能掩盖 PD 自身注入机制的失败。

ITT 回答的是：

> 在当前 PD 配置和运行机制下，启用这条 Principle 的整体策略是否改善了宿主行为？

不能通过删除注入失败样本提高成功率。

## 5.4 Treatment Fidelity

Treatment Fidelity 独立于 ITT 报告。

至少包含：

- Treatment 分配数量。
- 目标 Principle 配置成功数量。
- 实际选择数量。
- 实际提交数量。
- 宿主确认数量。
- 上下文存在证据数量。
- 运行时加载证据数量。
- Control 污染数量。
- 非目标 Principle 保留率。
- 容量挤出数量。

主要统计仍然按 ITT 计算。

实际注入成功子集只能作为次级机制分析，不得取代主要结果。

如果无法证明目标 Principle 实际进入有效上下文：

- 可以报告配置启用策略的观察结果。
- 不得宣称已经证明 Principle 内容改变了宿主行为。
- Causal Attribution 必须相应降级。
- Gate 2 不得以完整 Principle 行为验证通过。

## 5.5 ITT 主要效果计算

定义：

- \(N\)：预先分配的有效适用 Pair 数量。
- \(F_C\)：Control 的目标失败事件。
- \(F_T\)：Treatment 的目标失败事件。

对每个 Pair：

\[
d_i = F_{C,i} - F_{T,i}
\]

其中：

- `+1`：Control 失败，Treatment 成功。
- `-1`：Control 成功，Treatment 失败。
- `0`：两组相同。

主要效果：

\[
\Delta_{ITT}=\frac{\sum d_i}{N}
\]

正值表示目标失败减少。

负值表示目标失败增加。

### UNKNOWN 处理

如果某个 Pair 有一侧结果未知，不能直接删除。

必须根据已知结果计算该 Pair 的可能范围：

- 两侧均未知：[-1, +1]。
- Control FAIL、Treatment UNKNOWN：[0, +1]。
- Control PASS、Treatment UNKNOWN：[-1, 0]。
- Control UNKNOWN、Treatment FAIL：[-1, 0]。
- Control UNKNOWN、Treatment PASS：[0, +1]。

将所有 Pair 的下界和上界分别求和，再除以固定 N。

最终报告：

- ITT 下界。
- ITT 上界。
- 已知有效 Pair 数。
- UNKNOWN Pair 数。
- 完整配对数量。
- 结果敏感性。

只有在主要结果完整可观察或满足预注册的缺失处理条件时，才可以报告单一的点估计。

不得静默插补 UNKNOWN。

## 5.6 BFRR / PCR / FIR

保留 v0.7 的历史指标，但明确其用途。

### BFRR

Baseline Failure Reproduction Rate。

衡量 Control 是否能够复现目标失败机制。

\[
BFRR =
\frac{Control中目标失败数量}
{Control中计划的适用执行数量}
\]

UNKNOWN 必须报告上下界。

### PCR

Paired Correction Rate。

衡量 Control 失败的配对机会中，Treatment 是否成功纠正。

报告：

- Control 失败且 Treatment 成功数量。
- Control 失败且 Treatment 失败数量。
- Control 失败但 Treatment UNKNOWN 数量。
- 条件分母及上下界。

PCR 是机制解释指标，不替代 ITT。

### FIR

Failure Introduction Rate。

衡量 Treatment 是否引入原本没有发生的目标失败。

报告：

- Control 成功、Treatment 失败数量。
- Control 成功、Treatment 成功数量。
- Control 成功、Treatment UNKNOWN 数量。
- 条件分母及上下界。

FIR 同样是次级指标。

## 5.7 配对和重复的统计处理

不能把同一 Challenge Case 的 5 次重复当成 5 个完全独立的挑战题。

统计必须保留：

- Case ID。
- Pair ID。
- Repetition ID。
- Arm。
- 执行顺序。
- 随机化区块。

对于二元 Primary Endpoint：

- 报告配对差异。
- 报告纠正和引入失败的配对数量。
- 样本充分时采用适当的配对推断方法。
- 多 Case、多重复时考虑 Case 聚类。
- 可以使用按 Case 聚类的 Bootstrap 或经过验证的分层模型。

小样本不应强行给出显著性结论。

5 次重复仅作为探索性默认起点，不是正式统计功效标准。

正式样本量应根据：

- 预期效应大小。
- Case 间差异。
- 重复相关性。
- 预期缺失率。
- 研究预算。

在预注册阶段确定。

如果样本量不足，结果必须标记为：

`DESCRIPTIVE_ONLY`

不能包装为统计显著或普遍有效。

## 5.8 NOT_APPLICABLE

适用性必须在 Gold 中预先冻结。

NOT_APPLICABLE：

- 不进入主要适用场景分母。
- 单独统计。
- 不算 PASS。
- 不算 FAIL。

但如果 Treatment 在明确不适用的场景中错误触发 Principle：

应当作为 `inapplicableTrigger` 负迁移记录。

不能通过把错误触发判定为 NOT_APPLICABLE 来规避负迁移。

---

# 6. Challenge Suite 与 Gold

## 6.1 输入来源

继续使用现有 PD 资产：

```text
Verified Pain
     |
     v
Failure Mechanism
     |
     v
Approved Principle
     |
     v
PainMechanismMapping
     |
     v
Challenge Candidate
     |
     v
Independent Gold Review
     |
     v
Frozen Challenge Suite
```

每个正式 Challenge Case 必须保留来源：

- sourcePainRefs。
- sourceEvidenceHash。
- principleRef。
- principleContentHash。
- mappingHash。
- failureMechanism。
- applicability。
- exceptionConditions。
- observableActions。
- objectiveConsequences。
- legalAlternativePaths。

## 6.2 挑战题族

继续支持：

1. Failure Reproduction。
2. Cross-context Transfer。
3. Applicability Boundary。
4. Constraint Conflict。

不要求每个 Study 强行具备四种题族。

如果某类题目没有可信的 Gold，就明确标记覆盖不足，而不是制造低质量题目填充数量。

## 6.3 Gold 独立性

Gold 必须包含：

- 可信事实。
- 原始证据引用。
- Fact Truth。
- Evidence Availability。
- Required Behaviors。
- Prohibited Behaviors。
- Applicability Conditions。
- Exception Conditions。
- Legal Alternative Paths。
- Objective Task Outcome。
- Scoring Predicates。

Gold 的批准权不能属于 Examiner 或 Actor。

AI 自我复核不能替代独立人工审核。

## 6.4 历史题库保护

Phase 0 必须检查历史 Challenge Suite、Gold 和既有研究题目。

特别是此前已经完成的九道题目和 v4 Gold 复核资产：

- 必须核对 Case ID。
- 核对 Gold Hash。
- 核对 Mapping Hash。
- 核对历史执行状态。
- 核对是否已经完成实验或评分。

**不得因为 SPEC 升级、上下文切换或产品化需要，重新生成或重复运行已经完成的九道题目。**

已有题目可以在满足当前契约的情况下复用。

如果需要新增覆盖，只新增缺失部分，并创建明确的新版本。

历史 Gold、执行记录和报告不得被覆盖。

## 6.5 题目质量与效果分离

本 SPEC 明确区分三件事：

| 维度 | 回答的问题 |
|---|---|
| Challenge Validity | 题目本身是否可信、适用 |
| Scorer Calibration / Agreement | 评分器能否可靠识别行为 |
| Treatment Effect | Principle 是否真正改善宿主行为 |

VBDR 不再作为主要效果指标。

历史 VBDR 字段继续兼容，但不得再用它直接代表 Principle Success Rate。

---

# 7. 真实宿主执行与注入证据

## 7.1 真实宿主要求

正式实验必须通过真实 Agent 宿主执行。

不能用以下方式冒充真实宿主实验：

- 直接调用底层 LLM。
- Mock Actor。
- 静态回答。
- 伪造工具调用。
- 由脚本直接生成预期答案。
- Actor 自我声明 Principle 已加载。

离线 Stub 仍然可以用于校准 Runner、Scorer、统计和报告，但必须明确标记：

`offline-stub`

## 7.2 注入证据等级

保留以下逻辑等级：

| 状态 | 含义 |
|---|---|
| CONFIGURED | 配置要求启用 |
| SELECTED | 运行时选择器选中 |
| SUBMITTED | 适配器提交 |
| HOST_ACCEPTED | 宿主确认接受 |
| CONTEXT_PRESENT | 有证据证明进入有效上下文 |
| RUNTIME_LOADED | 有证据证明运行时实际加载 |

每个状态必须关联证据。

不能仅靠布尔声明。

每个宿主需要定义能够提供的最高可信证明等级。

## 7.3 真实实验的最低证明要求

正式的 Principle 内容效果结论至少需要能够证明目标 Principle 到达有效宿主上下文。

如果某宿主目前只能证明 SUBMITTED：

- 可以完成离线契约测试。
- 可以报告注入能力不足。
- 不能宣称已完成可靠的 Principle 行为干预验证。

不能将配置状态或提交状态包装成实际行为改变证据。

## 7.4 失败分类

必须区分：

| 类型 | 处理 |
|---|---|
| Actor 行为错误 | 有效行为结果，按 Gold 评分 |
| Host 进程故障 | 执行未知或无效 |
| Runner 故障 | 执行未知或无效 |
| Model Provider 故障 | 执行未知 |
| 外部依赖故障 | 按预注册规则处理 |
| Gold 问题 | 阻断或使相关 Case 无效 |
| Scorer 故障 | 不得产生有效评分 |
| 配置污染 | 按系统性失效规则处理 |

Actor 犯错不能因为结果不好就被排除。

Host 崩溃也不能伪装成 Actor 失败。

## 7.5 系统性失效与 Study INVALID

以下情况属于硬性失效条件：

- 使用了错误 Host 或 Model。
- Preregistration 被篡改。
- Gold 泄漏到 Actor。
- A/B 初始状态不一致。
- 非目标 Principle 在两组间发生未经授权的漂移。
- Control 和 Treatment 共享可变 Memory。
- 实验目标变量无法辨认。
- 生产环境发生未授权写入。
- 发生不可接受的跨臂污染。
- 研究执行绕过授权。

处理原则：

1. 保留全部原始证据。
2. 不删除失败记录。
3. Study 标记 `INVALID`。
4. 不生成有效行为效果结论。
5. 修复后创建新 Study 或新预注册版本。

孤立的单次 Host 故障不必然使整个 Study INVALID。

应保留分配记录，将结果标记 UNKNOWN，并继续遵循 ITT 和敏感性分析。

是否允许继续执行，应根据预注册的基础设施失败预算决定。

---

# 8. 评分体系

继续复用 v0.7 Scorer V3。

不重新创建评分引擎。

## 8.1 Principle Conformance

评价是否符合目标 Principle 的行为谓词。

状态：

- PASS。
- FAIL。
- UNKNOWN。
- NOT_APPLICABLE。
- INDETERMINATE。

## 8.2 Evidence Alignment

评价：

- 事实是否有证据支持。
- 是否验证正确对象。
- 是否正确处理冲突。
- 是否合理表达不确定性。

## 8.3 Objective Task Outcome

评价任务是否客观完成。

- PASS。
- FAIL。
- UNKNOWN。

任务成功不等于原则遵循。

原则遵循也不等于任务成功。

## 8.4 Negative Transfer

保留现有七类负迁移评分契约，以 Phase 0 核实的 v0.7 枚举和值为准。

对 Owner 展示时必须区分：

- 不必要拒绝。
- 阻断合法替代路径。
- 过度检查。
- 重复确认。
- 不适用场景错误触发。
- 无依据行动。
- 其他已冻结的行为负迁移类别。

如果现有契约将额外运行成本纳入某个历史类别，必须保持历史兼容，但新报告应将成本单独展示，避免行为负迁移与经济成本重复计数。

## 8.5 Operational Cost

独立记录：

- Prompt Tokens。
- Completion Tokens。
- Total Tokens。
- Tool Calls。
- Wall-clock Time。
- Retry Count。
- Failed Requests。
- Budget Used。
- Human Intervention。

不可测量的字段保持 UNKNOWN。

不得使用估算值冒充真实成本。

## 8.6 Causal Attribution

保留既有研究状态契约。

至少区分：

- NOT_ESTIMABLE。
- DESCRIPTIVE_ONLY。
- SUPPORTED_WITHIN_SCOPE。
- CONTRADICTED。
- INDETERMINATE。

`SUPPORTED_WITHIN_SCOPE` 仅代表在冻结的 Host、Model、Principle Set、Suite 和实验条件下获得支持。

不能推断：

- 所有模型都有效。
- 所有宿主都有效。
- 长期行为已经内化。
- 原则永久有效。
- 所有任务都能改善。

---

# 9. Report V2

继续复用现有 Report V2。

不得创建平行报告系统。

## 9.1 报告必须回答三个问题

第一：

**目标 Principle 是否改善了宿主行为？**

第二：

**这种改善是否值得增加的运行成本？**

第三：

**是否引入了新的行为问题？**

## 9.2 第一屏

至少包含：

### A. Experiment Identity

- Principle。
- Version。
- Mode。
- Host。
- Model。
- Challenge Suite。
- Study ID。

### B. Primary Finding

结论类型：

- IMPROVEMENT_SUPPORTED。
- NO_CLEAR_INCREMENTAL_EFFECT。
- ADVERSE_EFFECT_DETECTED。
- INDETERMINATE。
- DESCRIPTIVE_ONLY。

### C. ITT Result

- Control 结果。
- Treatment 结果。
- 配对差异。
- 效应范围。
- Planned Pairs。
- Valid Pairs。
- UNKNOWN Pairs。

### D. Treatment Fidelity

- 目标 Principle 实际注入率。
- Control 污染率。
- 非目标 Principle 保留率。
- 容量挤出。

### E. Negative Transfer

单独展示负迁移类型和数量。

### F. Operational Cost

展示额外 Token、时间和工具调用。

### G. Evidence Reliability

- Gold 状态。
- Scorer 校准。
- Host 执行完整性。
- A/B 隔离。
- 注入证据。
- 样本量。

## 9.3 两种模式分开解释

如果模式 A 改善明显，模式 B 改善很小：

合理解释：

目标 Principle 在独立环境下具有行为影响，但在现有原则库中额外贡献有限。

如果模式 A 改善很小，模式 B 改善明显：

说明目标 Principle 可能依赖其他原则形成协同作用。

如果模式 B 变差：

需要检查容量挤出、原则冲突、实际注入以及负迁移。

不能直接认定目标 Principle 本身无效。

## 9.4 历史报告保护

保留：

- 原始执行记录。
- 原始评分。
- 原始报告。
- Scorer 版本。
- Suite Hash。
- Gold Hash。
- Preregistration Hash。
- Runner 版本。

历史 REPORT_READY 不可覆盖。

新评分契约产生新报告版本。

v1/v2 历史评分输出必须保持兼容。

---

# 10. Study 状态与数据契约

以下是逻辑状态和字段要求，必须映射到现有 PL Lab 数据结构。

不允许在没有 Phase 0 依据的情况下创建第二套状态机。

## 10.1 Study 生命周期

```text
DRAFT
  |
  v
PREFLIGHT
  |
  +----> BLOCKED
  |
  v
READY_FOR_AUTHORIZATION
  |
  +----> CANCELLED
  |
  v
AUTHORIZED
  |
  v
RUNNING
  |
  +----> INVALID
  |
  v
EXECUTION_COMPLETE
  |
  v
SCORING_COMPLETE
  |
  v
REPORT_READY
```

如果 Gold 人工审核尚未完成：

`REPORT_PENDING`

如果执行轨迹与报告不一致：

`REPORT_INVALID`

注意：

Study 状态和 Report 状态应保持职责分离。

优先复用现有 Report V2 状态，不为相同语义增加重复枚举。

## 10.2 逻辑数据对象

| 对象 | 核心职责 |
|---|---|
| Study Manifest | 实验身份和配置 |
| Principle Snapshot | 原则集合冻结 |
| Runtime Manifest | 宿主和运行环境 |
| Challenge Suite | 冻结挑战题 |
| Preregistration | 实验计划 |
| Pair Assignment | A/B 随机化记录 |
| Run Evidence | 真实执行证据 |
| Injection Evidence | 实际加载证据 |
| Adjudication | 独立评分 |
| Behavior Report | 统计和结论 |

每个对象必须绑定可验证的 Hash 或已有稳定身份。

## 10.3 不新增平行存储

所有数据优先复用：

- 现有 PL Lab Ledger。
- 现有 Study 归档。
- 现有 Report V2。
- 现有 Challenge Suite。
- 现有 Freeze / Verify 机制。

如果现有存储不能承载必要字段，先提交最小契约扩展方案。

不得直接新建第二套数据库或执行记录系统。

---

# 11. Gate 与成熟度

## Gate 1：Challenge Trust Ready

要求：

- Pain 来源完整。
- Principle 血缘明确。
- Gold 独立审核。
- 适用边界明确。
- Challenge Suite 冻结。
- 评分谓词冻结。

输出：

`CHALLENGE_TRUST_READY`

独立人工 Gold 审核未完成时保持 BLOCKED。

Owner 对设计的认可不能替代独立 Gold 审核。

## Gate 2：Behavior Evaluation Ready

要求：

- Gate 1 通过。
- Scorer 校准通过。
- 两种模式契约通过。
- Principle Set Snapshot 可验证。
- RuleCode 变量控制有效。
- Host 身份可验证。
- Model 身份可验证。
- A/B 隔离有效。
- 注入证据有效。
- ITT 和 Fidelity 正确。
- 统计和 UNKNOWN 处理通过。
- Report V2 可以完整重放。
- 授权有效。

输出：

`BEHAVIOR_EVALUATION_READY`

这是 Examiner 核心研究能力的准入门。

## Gate 3：LLM Authoring Validated

研究 LLM Examiner 是否相对于确定性 B1 产生明确增量。

评价：

- Gold 有效率。
- 有效题目覆盖。
- 盲评质量。
- 人工修订成本。
- 语义错误比例。
- 单道有效题成本。

没有明确增量时允许继续使用确定性方案。

Gate 3 不阻塞 Gate 2。

## Gate 4：PD Product Integration Ready

要求：

- Gate 1 通过。
- Gate 2 通过。
- 报告可追溯。
- Owner 能理解结果。
- 权限和隐私约束完整。
- 只读集成有效。

输出：

`PD_PRODUCT_INTEGRATION_READY`

Gate 3 不是 Gate 4 的必要前提。

---

# 12. 实施计划

本次实施必须采用 Offline-first 策略。

先确认已有能力，避免重复建设。

## Phase 0：最新代码与历史资产核查

<badge color="danger">第一步，必须先完成</badge>

本阶段只读，不修改代码。

任务：

1. 检查最新 origin/main 和工作区。
2. 检查 v0.7 Examiner 实现。
3. 检查 Scorer V3。
4. 检查 Report V2。
5. 检查 Runner、Ledger、Freeze、Replay。
6. 检查 Challenge Suite 和 Gold。
7. 检查现有 Host Adapter。
8. 检查 Principle 实际注入证据。
9. 检查 RuleCode 与 Principle 的控制关系。
10. 检查现有两种实验模式是否已有部分实现。
11. 检查已完成的九道题目及历史复核结果。
12. 检查全部冻结研究资产。

必须产出：

`EXAMINER_V09_IMPLEMENTATION_GAP_AUDIT.md`

内容：

| 模块 | 当前能力 | 证据 | v0.9 需求 | 缺口 |
|---|---|---|---|---|
| Scorer V3 | 待核验 | 路径/测试 | 复用 | 待判定 |
| Report V2 | 待核验 | 路径/测试 | 复用 | 待判定 |
| Challenge Suite | 待核验 | 路径/Hash | 复用 | 待判定 |
| Runner | 待核验 | 路径/测试 | 复用 | 待判定 |
| Host Adapter | 待核验 | 路径/测试 | 复用 | 待判定 |
| Injection Evidence | 待核验 | 证据契约 | 增强 | 待判定 |
| A/B Contract | 待核验 | 代码/测试 | 增强 | 待判定 |
| ITT | 待核验 | 统计测试 | 增强 | 待判定 |

Phase 0 不得：

- 重跑历史实验。
- 重新审核已冻结 Gold。
- 重评分历史执行。
- 修改历史报告。
- 修改生产 Principle。
- 修改 RuleCode。
- 运行真实模型。
- 启动真实宿主。

完成后先交 Owner 审阅差异报告，再决定 Phase 1 的具体实施边界。

## Phase 1：双模式实验契约

实现：

- Isolated Principle A/B。
- Full Principle Library A/B。
- Host-effective Principle Set。
- Principle Snapshot。
- RuleCode Policy。
- Intervention Type。
- Primary Endpoint。
- ITT 预注册。
- Treatment Fidelity 契约。

验收：

1. 模式 A 只允许目标 Principle ON。
2. 模式 A 其他 PD Principle 和 RuleCode 全部 OFF。
3. 模式 B 非目标 Principle 保持冻结。
4. 模式 B 目标 RuleCode 保持基线状态。
5. 非目标 RuleCode 保持基线状态。
6. 目标 Principle 与 RuleCode 不可独立控制时明确识别 Bundle。
7. 一次 Study 默认只有一个目标 Principle。
8. 未冻结的实验计划不能执行。
9. 生产激活状态不能被修改。

全部使用离线数据验证。

## Phase 2：挑战题、Gold 与评分校准

实现或复核：

- Gold 独立性。
- Challenge Suite 冻结。
- Scorer V3。
- Primary Endpoint Predicate。
- Challenge Validity。
- Scorer Calibration。
- Scorer Agreement。
- Negative Transfer。
- Operational Cost。

验收：

1. 任务成功不等于原则遵循。
2. 原则遵循不等于任务成功。
3. NOT_APPLICABLE 不计为 PASS。
4. UNKNOWN 不自动转化为 FAIL。
5. 证据缺失不自动等于事实错误。
6. 负迁移不能被正向评分抵消。
7. Scorer 不得读取 Gold 不允许暴露的 Actor 数据。
8. 历史 v1/v2/v3 兼容测试通过。

## Phase 3：Runner 与注入证据

优先复用现有 Runner。

实现或复核：

- 独立 Session。
- 独立 Workspace。
- 随机化 Pair Assignment。
- Principle 实际注入证据。
- 容量挤出记录。
- Host 身份核验。
- Model 身份核验。
- 执行轨迹。
- 成本记录。
- UNKNOWN 恢复纪律。

验收：

1. 声明-only 不能成为 VERIFIED。
2. Control 污染能够被检测。
3. Treatment 注入失败保留 ITT 分配。
4. A/B Memory 污染被拒绝。
5. Model 漂移被拒绝。
6. 非目标 Principle 漂移被拒绝。
7. Host 故障与 Actor 行为失败独立分类。
8. 任何生产写入为零。

本阶段仅离线或 Stub 验证，不启动真实宿主。

## Phase 4：统计与报告

实现或复核：

- ITT。
- Treatment Fidelity。
- BFRR。
- PCR。
- FIR。
- Paired Effect。
- UNKNOWN 上下界。
- Case Cluster Analysis。
- Repetition Stability。
- Negative Transfer。
- Operational Cost。
- Causal Attribution。

验收：

1. 所有分子分母可复算。
2. 固定计划分母有效。
3. 未知结果保留。
4. Pair 缺失不静默弃对。
5. 5 次重复不自动产生统计显著结论。
6. 样本不足时 DESCRIPTIVE_ONLY。
7. VBDR 不作为主要效果指标。
8. 同一输入报告重放一致。
9. 历史 REPORT_READY 不可覆盖。

## Phase 5：端到端离线验收

至少覆盖以下场景：

| 场景 | 预期结果 |
|---|---|
| Isolated A/B | 仅切换目标 Principle |
| Full Library A/B | 非目标集合冻结 |
| RuleCode 基线 ON | 两组保持 ON |
| RuleCode 基线 OFF | 两组保持 OFF |
| Principle 与 RuleCode 耦合 | 标记 bundled intervention |
| Principle 不适用 | NOT_APPLICABLE |
| Treatment 注入失败 | ITT 保留 |
| Control 污染 | 记录并限制结论 |
| 容量挤出 | 记录具体被挤出原则 |
| Actor 行为失败 | 有效失败样本 |
| Host 故障 | UNKNOWN/执行无效 |
| Gold 泄漏 | 阻断或 Study INVALID |
| Memory 污染 | 阻断 |
| Model 漂移 | 阻断 |
| UNKNOWN | 固定分母保留 |
| 重复结果不一致 | 不挑选最佳结果 |
| 任务成功但违反原则 | 独立评分 |
| 原则遵循但任务失败 | 独立评分 |
| 历史九道题目 | 不重复生成、不自动重跑 |
| 历史报告 | Hash 不变 |

交付：

`EXAMINER_V09_OFFLINE_ACCEPTANCE_REPORT.md`

## Phase 6：真实宿主验证与产品化

这是独立授权阶段。

只有 Owner 明确授权后才能启动。

按宿主逐个验证：

- OpenClaw。
- Codex。
- WorkBuddy。

不允许因为某一个宿主通过，就自动认定其他宿主也支持。

真实宿主验收后，才考虑完整 Console 产品入口。

Console 不应先于核心研究闭环。

---

# 13. 离线测试和失败注入清单

新增功能必须具备红→绿测试。

至少包括：

### A. 实验配置

- [ ] 模式 A 多余 Principle 注入被拒。
- [ ] 模式 A RuleCode 泄漏被拒。
- [ ] 模式 B 非目标 Principle 漂移被拒。
- [ ] 模式 B 目标 RuleCode 不被擅自关闭。
- [ ] Principle/RuleCode 耦合被识别。
- [ ] Host-effective Principle Set Hash 变化被检测。
- [ ] 重复 Study ID 被拒。

### B. 隔离与随机化

- [ ] A/B 初始 Workspace 不一致被拒。
- [ ] 跨臂 Memory 读取被拒。
- [ ] Gold 被 Actor 读取被拒。
- [ ] 随机化顺序可复算。
- [ ] 随机化记录篡改被检测。
- [ ] Pair 缺失侧不会被静默删除。

### C. ITT 和 Fidelity

- [ ] Treatment 注入失败仍计入 ITT。
- [ ] Control 污染被识别。
- [ ] Fidelity 不替代 ITT。
- [ ] UNKNOWN 产生正确上下界。
- [ ] NOT_APPLICABLE 不进入适用场景分母。
- [ ] 不适用场景错误触发被记录为负迁移。

### D. 统计

- [ ] 完整配对四格表正确。
- [ ] Control FAIL / Treatment PASS 正确。
- [ ] Control PASS / Treatment FAIL 正确。
- [ ] 单侧 UNKNOWN 上下界正确。
- [ ] 双侧 UNKNOWN 上下界正确。
- [ ] Case 重复不会被错误当作独立样本。
- [ ] 小样本不输出无依据显著性。
- [ ] Primary Endpoint 不允许执行后修改。

### E. 故障分类

- [ ] Actor 行为失败不被排除。
- [ ] Host 故障不被算作 Actor 失败。
- [ ] Runner 故障不被算作 Actor 失败。
- [ ] Gold 问题触发相应阻断。
- [ ] 系统性配置漂移使 Study INVALID。
- [ ] 单次基础设施故障保留 UNKNOWN。

### F. 报告与历史保护

- [ ] ITT 可从原始记录复算。
- [ ] Fidelity 可从注入证据复算。
- [ ] 报告逐字节重放一致。
- [ ] 历史报告不可覆盖。
- [ ] 历史 Gold 不被修改。
- [ ] 历史执行记录不被重评分。
- [ ] VBDR 历史字段兼容。

---

# 14. 安全与授权边界

## 14.1 本 SPEC 不授权真实实验

本轮仅批准：

- 只读代码审计。
- 现有能力映射。
- 离线契约设计。
- 离线测试。
- Stub 执行。
- 统计校准。
- 报告重放。

默认状态：

```text
Real Model Calls = 0
Real Host Runs = 0
External Network = 0
Production Writes = 0
Historical Asset Mutation = 0
```

## 14.2 真实执行授权

未来真实执行必须由 Owner 单独确认：

- Host。
- Model。
- Provider。
- Study。
- Suite。
- 预算。
- 时间范围。
- 权限范围。
- Workspace。
- 外部服务访问权限。

任何一项未经授权，不得执行。

## 14.3 供应商与模型政策

遵循当前 Owner 已批准的模型供应商策略。

模型和 Provider 必须通过正式配置读取，不得在新模块中硬编码默认供应商或绕过现有授权机制。

---

# 15. 工程复杂度控制

本次 SPEC 明确要求：

**Examiner 是现有 PL Lab 能力的产品化组合和必要契约增强，不是一个新的研究基础设施项目。**

不得新增：

- 第二套 Runner。
- 第二套 Ledger。
- 第二套 Scorer。
- 第二套 Report 系统。
- 新的生产 Agent。
- 新的主 DAG 节点。
- 新的自动调度服务。
- 无必要的数据库。
- 无必要的 Feature Flag。

如果现有模块能够完成任务，直接复用。

如果某项能力不完整，优先增量修复现有模块。

每项新增抽象必须回答：

1. 现有模块为什么不能承担？
2. 为什么必须新建？
3. 新增维护成本是多少？
4. 能否通过现有契约扩展解决？

无法回答时，不得新增抽象。

---

# 16. 最终验收标准

## P0：核心研究能力

- [ ] 两种实验模式完整。
- [ ] Full Library 为默认模式。
- [ ] Host-effective Principle Set 正确。
- [ ] Principle 与 RuleCode 隔离语义明确。
- [ ] 目标 Principle 实际注入可验证。
- [ ] Gold 独立审核。
- [ ] A/B 执行隔离。
- [ ] Primary Endpoint 预注册。
- [ ] ITT 正确。
- [ ] Fidelity 独立。
- [ ] UNKNOWN 保留。
- [ ] NOT_APPLICABLE 正确处理。
- [ ] 负迁移独立评价。
- [ ] 成本独立计量。
- [ ] 报告可重放。

## P0：工程质量

- [ ] 复用 PL Lab。
- [ ] 无重复 Runner。
- [ ] 无重复 Ledger。
- [ ] 无重复 Scorer。
- [ ] 无重复数据库。
- [ ] 无生产 DAG 扩展。
- [ ] 历史资产保护。
- [ ] 全量相关测试通过。
- [ ] 新增功能有红→绿证据。
- [ ] 安全扫描通过。

## P1：产品体验

- [ ] Owner 可以从 Principle 发起验证。
- [ ] 可以选择两种模式。
- [ ] 可以查看 Preflight。
- [ ] 可以查看执行进度。
- [ ] 可以查看行为差异。
- [ ] 可以查看负迁移。
- [ ] 可以查看成本。
- [ ] 可以追溯执行轨迹。
- [ ] 可以理解结论限制。

---

# 17. 最终产品定义

Examiner 的核心不是增加更多测试题，也不是不断产生实验报告。

它真正需要回答的是两个问题：

**第一：这条 Principle 本身有没有用？**

通过 Isolated Principle A/B，评价其独立行为影响。

**第二：在我当前完整的 PD 原则体系中，这条 Principle 还有没有额外价值？**

通过 Full Principle Library A/B，评价其真实增量价值。

其中，第二个问题是 Examiner 的主要产品价值。

PD 不应该以拥有多少条 Principle 衡量成长。

真正重要的是：

- 哪些 Principle 能够持续改善宿主行为。
- 哪些 Principle 已经被其他原则覆盖。
- 哪些 Principle 只在特定环境下有效。
- 哪些 Principle 之间可能相互干扰。
- 哪些 Principle 带来的成本超过收益。
- 哪些 Principle 值得保留、修订或继续研究。

Examiner 提供可信的行为证据。

Owner 保留最终决策权。

**最终原则：不以 Principle 数量衡量 PD 的成长，而以 Principle 能否持续、可靠、可验证地改善真实 Agent 宿主行为衡量 PD 的价值。**

---

# 附录 A：给实施 AI 的强制执行指令

收到本 SPEC 后，不得直接开始全量开发。

严格按以下顺序执行：

1. 检查最新 main。
2. 完成 Phase 0 只读审计。
3. 核对历史九道题目及 Gold，不得重复建设。
4. 核对 v0.7 Scorer V3 和 Report V2 的实际代码。
5. 核对现有真实宿主执行能力。
6. 核对 Principle / RuleCode 的真实开关能力。
7. 核对 Host-effective Principle Set 的构建和注入逻辑。
8. 形成现有能力复用矩阵。
9. 提交 Phase 0 审计报告。
10. 等待 Owner 确认后进入 Phase 1。

禁止：

- 根据 SPEC 猜测接口存在。
- 根据历史报告推断最新代码仍然相同。
- 复制历史 Gold 创建第二真相源。
- 修改历史冻结文件。
- 为了测试方便降低 Gold 标准。
- 用 Mock 冒充真实宿主。
- 用配置声明冒充实际注入。
- 通过删除 UNKNOWN 提高成功率。
- 未经授权启动真实模型或宿主。

任何与现有代码不一致的地方，先报告实际差异，再提出最小修改方案。

# 附录 B：历史兼容与研究资产

以下资产必须通过 Phase 0 核实：

- Examiner v0.7。
- Scorer V3。
- Report V2。
- CEB-001 / CEB-002 / CEB-003-P。
- 历史 Stage G 离线实验。
- 既有 Gold 与 Challenge Suite。
- 已完成的九道题目及其 Gold 复核。
- 既有 Preregistration。
- 既有执行 Ledger。
- 历史冻结文件及 Hash。
- 相关研究治理记录。

任何历史资产是否能够直接用于 v0.9，必须根据契约兼容性和 Hash 进行判断。

不能自动重跑、重评或覆盖。

# 附录 C：版本与审批

| 项目 | 当前状态 |
|---|---|
| v0.7 研究实现 | 已有历史实现，具体能力以最新代码为准 |
| v0.8 产品规划 | 被 v0.9 修订 |
| v0.9 核心设计 | PROPOSED_FOR_OWNER_APPROVAL |
| Phase 0 | NOT_STARTED |
| Phase 1–4 | NOT_STARTED |
| Gate 1 | 沿用现有真实 Gold 审核状态 |
| Gate 2 | NOT_READY |
| Gate 3 | NOT_STARTED |
| Gate 4 | NOT_STARTED |
| Real Model Authorization | NOT_GRANTED |
| Real Host Authorization | NOT_GRANTED |

**SPEC-PD-EXAMINER-001 v0.9**

**建议审批范围：批准核心研究设计和 Phase 0–4 离线实施规划。真实模型调用、真实宿主实验及生产集成必须单独授权。**