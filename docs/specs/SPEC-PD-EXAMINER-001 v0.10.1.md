# SPEC-PD-EXAMINER-001 v0.10.1
## Owner-controlled Behavioral Evaluation Workflow

**版本：** v0.10.1  
**状态：** PROPOSED — 待 Owner 审核  
**日期：** 2026-11-02  
**源码基线：** `main@9a2bd5efbdfeea5c01468f1beff5f86e4078c3ae`  
**前置版本：** SPEC-PD-EXAMINER-001 v0.9 / v0.10  
**产品归属：** Principles Disciple  
**核心原则：** Product-first · Owner-controlled · Evidence-first · Reuse-first

---

# 1. Executive Summary

## 1.1 产品定位

Examiner 是 Principles Disciple 的 Principle 效果评估与决策支持系统。

它不是一个通用 Agent Benchmark，也不是一个独立的科学实验平台。

它的根本任务是：

> 帮助 Owner 判断：PD 的 Principle 是否真正改善了 Agent 在真实工作中的行为，以及这种改善是否值得保留、强化或推广。

Examiner 应当服务于 PD 的长期产品目标：

**Owner-controlled Behavioral Evolution**

通过真实行为证据、原则干预、持续观察和 Owner 决策，逐步改善 Agent 的行为质量，降低 Owner 的纠正成本，提高复杂任务的委托可信度。

## 1.2 为什么需要 v0.10.1

v0.9 已经完成了重要的研究基础设施建设：

- Full Library Incremental A/B。
- Isolated Principle Diagnostic。
- HEPS。
- RuleCode Policy。
- Pair Assignment。
- Preregistration。
- Study Freeze。
- Scorer V3。
- Report V2。
- Offline Study Execution。

Console 也已经提供离线研究入口。

但是，当前产品仍存在三个关键断点：

1. Examiner Console 只能运行确定性 Offline Stub。
2. 真实宿主 F2 能力没有进入 Examiner Console 的执行工作流。
3. 已有的生产 Intervention Evidence 尚未进入 Examiner 的评估和报告。

更深层的问题是：

我们已经能够创建实验、运行实验、生成报告，但还不能把这些信息充分转化成 Owner 的实际决策依据。

v0.10.1 的目标不是扩大研究引擎，而是连接已有产品能力。

## 1.3 核心产品闭环

```text
真实 Agent 工作
       |
       v
Pain / Behavior Evidence
       |
       v
Principle Formation
       |
       v
Owner Approval
       |
       v
Runtime Activation
       |
       v
Production Evidence
       |
       +----------------------+
       |                      |
       v                      v
Behavior Observation    Controlled Evaluation
       |                      |
       |                Examiner A/B
       |                      |
       +----------+-----------+
                  |
                  v
             Evaluation
                  |
                  v
             Owner Decision
                  |
         +--------+--------+
         |        |        |
         v        v        v
        保留     修订      撤销
         |        |        |
         +--------+--------+
                  |
                  v
          下一轮行为演进
```

这里必须明确：

- 生产观察用于了解真实运行情况。
- 受控实验用于比较特定干预条件。
- Owner Outcome 用于记录 Owner 对结果的反馈。
- Examiner 负责整合证据，不负责自动作出治理决定。

这四种事实不能混为一谈。

## 1.4 v0.10.1 的最终交付

Owner 应当能够：

1. 选择一条真实 Principle。
2. 查看其关联 Pain 和 Failure Mechanism。
3. 查看其在真实宿主中的激活状态。
4. 查看生产行为证据和历史评估。
5. 创建受控 A/B Study。
6. 检查真实宿主和实验准备状态。
7. 在授权后执行 OpenClaw 受控实验。
8. 查看行为变化、负迁移、成本和证据限制。
9. 进入现有 Principle 决策与生命周期工作流。

首期只支持 OpenClaw 的 F2 真实宿主评估。

Codex、WorkBuddy 不进入本版本真实宿主执行范围。

---

# 2. 产品架构：两条证据通道

v0.10.1 最重要的架构调整，是把生产行为证据与受控实验分开。

它们互补，但不能相互替代。

## 2.1 Production Evidence Lane

负责回答：

- Principle 是否进入生产宿主的激活体系？
- 实际发生了多少次 Delivery？
- 有多少 Application Evidence？
- Agent 在什么情况下发生了行为偏差？
- 是否出现 RuleHost Enforcement？
- 是否存在可观察的行为效果？
- Owner 是否提供了结果反馈？

复用现有：

- Runtime V2。
- Intervention Evidence。
- ReceiptsConsoleModel。
- SqliteInterventionEvidenceStore。
- Evidence Ingress。

主要数据：

| Evidence | 含义 |
|---|---|
| Delivery | 原则提交到宿主的证据 |
| Application | 应用事实，区分 Agent Claim 和 Runtime Verified |
| Behavior Episode | 发生的行为事件 |
| Effect | 可观察的效果事实 |
| Outcome | 结果观察或 Owner 反馈 |
| Capability Declaration | 宿主能够证明的能力范围 |

这些数据是观察事实，不是效果评分。

例如：

`submitted` 不代表模型已经消费内容。

`runtime_verified` 也不代表长期行为已经改善。

`observed` 不代表 Principle 有因果效果。

## 2.2 Controlled Evaluation Lane

负责回答：

> 在可控制的任务条件下，启用目标 Principle 是否比不启用它产生更好的行为结果？

复用 Examiner v0.9 和 PL Lab：

- Study Designer。
- HEPS。
- RuleCode Policy。
- A/B Payload。
- Pair Assignment。
- Preregistration。
- Freeze。
- Challenge Runner。
- Scorer V3。
- Report V2。

首期使用：

`full_library_incremental`

Control：

```text
完整 Host-effective Principle Library
- Target Principle
```

Treatment：

```text
完整 Host-effective Principle Library
+ Target Principle
```

保持现有配对、随机化、预算和评分机制。

## 2.3 两条证据通道的融合

Report V2 增加生产证据摘要。

但不允许将生产观察记录直接加入实验分母，也不允许把 Owner 自述作为客观评分。

最终报告分别展示：

**Controlled Effect**

来自冻结 A/B 实验的结果。

**Production Observation**

来自真实运行中的 Evidence Records。

**Owner Outcome**

来自 Owner 明确提交的结果反馈。

**Longitudinal Assessment**

跨时间的观察趋势，仅在证据覆盖充分时展示。

不得把四者简单相加生成一个 Principle Effectiveness Score。

---

# 3. 当前源码核验与复用方案

## 3.1 Examiner 研究引擎

| 现有能力 | 源码 | 决策 |
|---|---|---|
| Study Design | `examiner-study.mjs` | 复用 |
| HEPS | `buildHostEffectivePrincipleSet()` | 复用 |
| RuleCode Policy | `buildRuleCodePolicy()` | 复用 |
| A/B Payload | `buildDualModeArmPayloads()` | 复用 |
| Pair Assignment | `assignPairs()` | 复用 |
| Study Freeze | `writeExaminerStudyArtifacts()` | 复用 |
| Binding Verification | `verifyExaminerStudyBindings()` | 复用 |
| Preflight | `runExaminerPreflight()` | 复用 |
| Runner | `runChallengeStudy()` | 复用 |
| Scorer | `claim-evidence-scorer.mjs` | 复用 |
| Report | `challenge-behavior-report.mjs` | 复用 |
| Study Ledger | `challenge-ledger.mjs` | 复用 |

不建设第二套实验引擎。

## 3.2 Production Evidence

| 现有能力 | 源码 | 决策 |
|---|---|---|
| Evidence Ingress | `getInterventionEvidenceIngress()` | 复用 |
| Evidence Store | `SqliteInterventionEvidenceStore` | 复用 |
| Evidence Audit | `ReceiptsConsoleModel.getEvidenceAudit()` | 复用 |
| Evidence API | `routes/receipts.ts` | 复用 |
| Owner Outcome | `routes/evidence-outcomes.ts` | 复用 |
| OpenClaw Evidence Recorder | `intervention-evidence-recorder.ts` | 复用 |
| Prompt Activation | `PromptActivationReader` | 复用 |
| Prompt Projection | `buildLivePromptInjectionProjection()` | 复用 |
| RuleCode Activation | `ActivationsConsoleModel` | 复用 |

不建设第二套 Evidence Store、Receipt API 或 Owner Outcome API。

## 3.3 Host Execution

| 现有能力 | 源码 | 决策 |
|---|---|---|
| OpenClaw Transport | `challenge-openclaw-host.mjs` | 复用 |
| Host Actor | `challenge-actor-transport.mjs` | 复用 |
| Stage R Gate | `challenge-stage-r-gate.mjs` | 复用 |
| Isolation Probe | `challenge-isolation-probe.mjs` | 复用 |
| Host Baseline | `challenge-baseline.mjs` | 复用 |
| Request Ledger | `challenge-ledger.mjs` | 复用 |

只允许增加 Examiner 与现有 F2 Runner 之间的集成层。

## 3.4 不允许重复建设

禁止：

- 第二套 Runner。
- 第二套 Host Adapter。
- 第二套 Stage R Authorization。
- 第二套 Isolation Probe。
- 第二套 Scorer。
- 第二套 Report Generator。
- 第二套 Evidence Store。
- 第二套 Principle Registry。
- 第二套 Owner Decision 状态机。
- 第二套 RuleCode Activation 管理。

---

# 4. Production Runtime Integration

## 4.1 Principle Source

继续使用：

`PrinciplesConsoleModel`

权威原则资产来源：

`<workspace>/.state/principle_training_state.json`

读取：

- Principle ID。
- 内容。
- 版本。
- 生命周期状态。
- Derived Pain IDs。
- Rule IDs。

Ledger ACTIVE 不能直接代表 Runtime Activated。

## 4.2 Runtime Activation

复用：

- `PromptActivationReader`。
- `SqliteActivationStateStore`。
- `filterPromptActivations()`。
- `resolvePrincipleFromArtifact()`。

重点源码：

`packages/openclaw-plugin/src/core/runtime-v2-prompt-activation-reader.ts`

### 完整性要求

当前 Reader 遇到异常 Artifact 时会返回 warnings 并跳过相关条目。

因此，Examiner 不能仅因为 Reader 成功返回就认为整个 Principle Library 已经完整。

必须：

1. 读取完整 Activation。
2. 校验 Artifact 存在。
3. 校验 Artifact Kind。
4. 校验 Validation Status。
5. 校验 Principle ID。
6. 校验内容 Hash。
7. 记录所有 warnings。
8. 对影响基线完整性的未解析 Activation 作阻断。

禁止静默丢弃可能影响实验基线的原则。

## 4.3 Production Prompt Projection

复用：

`buildLivePromptInjectionProjection()`

以及：

`resolveLivePromptInjectionProjection()`

位置：

`packages/host-runtime/src/prompt-injection-projection.ts`

复用其生产计算能力：

- 实际 Host Route。
- Prompt Budget。
- Principle Selection。
- Injected Principle IDs。
- Activation IDs。
- Truncation。
- Dropped Activations。
- Selection Policy。
- Budget Provenance。
- Warnings。

优先复用：

`readPromptActivationInjectionStatuses()`

以及现有 Runtime Budget Observation。

### 重要证据边界

Prompt Projection 是生产注入路径的只读投影，不是模型实际消费证明。

因此报告必须分别记录：

| 状态 | 语义 |
|---|---|
| Projection | 按当前生产策略预测的注入结果 |
| Submitted | Prompt Hook 提交证据 |
| Presence | Runtime 记录的注入存在事实 |
| Context Present | 有可信证据证明内容进入模型上下文 |
| Runtime Loaded | 有对应 Runtime 加载证据 |

不得将 Projection、Submitted 或 Presence 自动提升为 Context Present。

## 4.4 Production Prompt Budget

原 v0.10 保留固定 2000 字符预算作为默认值，这不够准确。

生产系统已经实现：

- `resolvePromptBudget()`。
- `trimToBudget()`。
- `renderPrinciplesToDirectives()`。
- `buildLivePromptInjectionProjection()`。

生产预算依据包括：

1. Owner 显式声明。
2. Host 有效上下文窗口。
3. 精确 Provider + Model Catalog。
4. 固定预算回退。

当前生产策略具有 1250–16000 UTF-16 字符的动态范围。

2000 字符是参考预算及未知容量时的回退值，不是所有生产宿主的实际预算。

### v0.10.1 要求

- 读取实际生产预算及来源。
- 冻结 Budget Policy Version。
- 记录 Budget Capacity Status。
- 记录 Budget Scope。
- 记录实际预算单位。
- A/B 两组使用相同冻结预算。
- 记录实验预算与生产预算的差异。

注意：F2 实验专用 Payload 不等于生产 Prompt Hook 的实际输出。

如果实验专用预算与生产路径不一致，报告必须明确标记：

`EXPERIMENT_CONFIGURATION_DIFFERS_FROM_PRODUCTION`

不能声称实验完整复现了生产注入路径。

---

# 5. Intervention Evidence Integration

## 5.1 现有能力

源码已经存在：

`ReceiptsConsoleModel.getEvidenceAudit()`

接口：

```text
GET /api/v1/receipts/evidence-audit
```

查询维度：

- principle
- activation
- episode
- effect

返回：

- Deliveries。
- Applications。
- Episodes。
- Effects。
- Outcomes。
- Pagination。
- Unresolved References。
- Capability Declarations。
- Coverage。
- As Of。

另外已有：

`POST /api/v1/evidence/outcomes`

用于 Owner 对已有 Behavior Episode 提交结果观察。

## 5.2 Examiner 的接入方式

Examiner 不重新读取底层 SQLite 表，不直接写 Evidence Store。

统一通过现有 `ReceiptsConsoleModel` 或对应的受控只读服务读取证据。

Report V2 增加：

```json
{
  "productionEvidence": {
    "status": "available",
    "principleId": "...",
    "deliveries": {},
    "applications": {},
    "episodes": {},
    "effects": {},
    "outcomes": {},
    "unresolvedReferences": [],
    "capabilityDeclarations": [],
    "coverage": {},
    "asOf": "..."
  }
}
```

以上为报告新增投影结构，不是第二套 Evidence 数据模型。

## 5.3 证据分类

必须分别展示：

### Delivery Evidence

证明提交尝试及其能够证明的边界。

### Application Evidence

区分：

- `agent_claimed`
- `runtime_verified`

不能将 Agent 自述视为 Runtime 验证。

### Behavior Episode

记录发生的行为事件及其来源。

### Effect Evidence

记录 RuleHost Block、Auto-correct 等可观察效果。

### Outcome Evidence

记录实际结果或 Owner 提供的反馈。

Owner Feedback 必须标记：

`sourceKind = owner_console_input`

不得将 Owner 的判断包装成独立客观测量。

## 5.4 Evidence Coverage

所有生产证据都必须展示：

- Source Status。
- Validation Status。
- Observed From。
- As Of。
- Retention Policy。
- Missing / Unresolved References。

当前 Evidence 有明确的保留期限和可观察窗口，不能将 90 天观察范围描述成完整历史。

当 Feature Flag 关闭、SQLite 不可读、表不存在或 Evidence 缺失时：

显示 `UNAVAILABLE` 或 `DEGRADED`，不能显示为零事件。

## 5.5 不允许的行为

禁止：

- 从空 Evidence 推断没有行为。
- 从 Agent 自述推断 Principle 有效。
- 从 Presence 推断行为改变。
- 从单次 RuleHost Block 推断长期改善。
- 把 Owner Feedback 作为独立 Gold。
- 将生产 Evidence 直接加入 A/B 实验分母。
- 为了生成报告而自动补造 Evidence。

---

# 6. Host-backed Experiment

## 6.1 F2 的准确定位

现有 OpenClaw F2 是一个真实宿主执行的受控实验环境。

它不是生产 Runtime V2 的直接 A/B。

现有：

`createOpenClawHostTransport()`

采用：

- `openclaw agent exec`。
- 独立 Round Directory。
- 独立 `AGENTS.md`。
- 独立 `--state-dir`。
- 独立 Session。
- 固定 Config。
- 固定 Model / Provider。
- Host Identity 验证。
- Runtime Trajectory 取证。

实验指令通过：

`workspace-agents-md`

注入，而不是 Provider API 的独立 System Role。

Actor 使用固定 JSON Action Protocol：

- observe
- ask-owner
- deploy
- report

因此 F2 能够证明：

- 真实 OpenClaw 执行。
- 指定模型和 Provider 的身份。
- 受控实验条件下的行为表现。
- 特定任务协议下的 A/B 差异。

但不能直接证明：

- 生产 Runtime V2 的完整激活链路。
- Owner 日常工作流中的行为变化。
- 原则已经被模型长期内化。
- Agent 已经形成稳定行为习惯。

**报告必须把 F2 结果称为 Controlled Host-backed Evaluation，而不是 Production Behavioral Improvement。**

## 6.2 Host Baseline

为了验证 PD 相对原有 Agent 能力的增量价值，必须冻结非 PD 基线。

最小清单：

- OpenClaw CLI Version。
- Model Identity。
- Provider Identity。
- Config Hash。
- Host System Prompt / Bootstrap。
- AGENTS.md 内容 Hash。
- Tool Set。
- Plugin Set。
- Skills Set。
- Runtime Feature Flags。
- Workspace Identity。
- Session Isolation。
- Actor Protocol Version。

必须区分：

1. Owner 原始工作区的生产基线。
2. F2 实验隔离工作区的实验基线。

不能把两者合并。

F2 的实验工作区必须保持隔离，不得直接修改 Owner 的生产工作区。

如果某些非 PD 基线内容无法采集，报告必须记录未知项，并限制结论范围。

## 6.3 A/B 不变量

两组必须保持：

- 相同 OpenClaw 版本。
- 相同 Model / Provider。
- 相同配置。
- 相同 Tool / Plugin / Skills。
- 相同基础系统指令。
- 相同 Actor Protocol。
- 相同 Challenge Suite。
- 相同任务预算。
- 相同重复次数。
- 独立 Session。
- 独立 Workspace。
- 相同执行规则。

唯一计划干预变量：

目标 Principle 的启用状态。

若 RuleCode 与目标 Principle 耦合，则不能声称是 Principle-only。

## 6.4 Full Library Incremental

默认模式：

`full_library_incremental`

复用 v0.9：

- HEPS。
- RuleCode Policy。
- A/B Payload。
- Pair Assignment。
- Isolation Audit。

完整原则库的基线必须来自真实可验证输入。

如果目标 Principle 在当前宿主中没有实际激活，不能伪称是在生产状态上移除了一条已生效原则。

报告必须明确说明 A/B 的起点与实际生产状态之间的差异。

## 6.5 Isolated Principle

保留：

`isolated_principle`

只作为诊断工具。

不能取代默认 Full Library Incremental，也不能单独代表 PD 的真实产品价值。

---

# 7. RuleCode Integration

## 7.1 现有能力

复用：

- `ActivationsConsoleModel`。
- `SqliteActivationStateStore`。
- `SqliteActivationSafetyStore`。
- RuleHost Runtime State。
- Feature Flag 状态。
- RuleCode Owner Decision Service。

现有 `ActivationsConsoleModel` 已能够读取：

- Activation。
- Artifact。
- Control State。
- Decision。
- Global Pause。
- Shadow Evidence。
- Live Metrics。

这些能力可以作为 RuleCode Baseline 的权威输入。

## 7.2 独立性证据

当前：

`buildRuleCodePolicy()`

接收：

`principleRuleCodeIndependence`

作为输入。

它能够执行拒绝判断，但本身不是独立性证据的生产者。

v0.10.1 不允许直接把这个布尔值写成 `true`。

必须由真实数据建立：

- Principle 与 RuleCode 关联。
- RuleCode Activation。
- 实际 Control State。
- Runtime Feature Flag。
- 其他 RuleCode 的基线状态。
- 目标 RuleCode 是否能够单独控制。

### 不可识别处理

以下情况必须拒绝 Principle-only 结论：

- RuleCode 缺失。
- RuleCode 状态未知。
- Activation 不完整。
- Control State 无法读取。
- Feature Flag 导致实际状态不确定。
- Principle 与 RuleCode 无法独立控制。

沿用：

`INTERVENTION_NOT_IDENTIFIABLE`

如果目标 Principle 与 RuleCode 无法独立分离，可以明确报告：

`bundled_intervention`

不能伪装成 Principle-only。

## 7.3 不重复建设

不得新增第二套 RuleCode Registry 或 Activation Manager。

---

# 8. Injection Evidence 与结论资格

## 8.1 保留六级证据

继续复用：

`examiner-injection-evidence.mjs`

证据等级：

```text
CONFIGURED
    |
SELECTED
    |
SUBMITTED
    |
HOST_ACCEPTED
    |
CONTEXT_PRESENT
    |
RUNTIME_LOADED
```

每一级必须由实际证据支撑。

## 8.2 生产能力边界

当前生产 Evidence Recorder 明确规定：

OpenClaw Prompt Delivery：

```text
confirmation = submitted
outcome = attempted
```

原因是 Prompt Hook 能够证明内容已提交给 Host，但不能证明 Host 最终消费了它。

RuleHost Enforcement 有独立的 Runtime Evidence，但不能替代 Principle Prompt 的上下文消费证据。

因此：

- Prompt Delivery 不能升级为 Context Present。
- RuleHost Runtime Loaded 不能替代 Prompt Context Present。
- Host Identity Verified 不能替代 Injection Verified。

当前 OpenClaw 的 Principle Prompt 证据上限保持：

`SUBMITTED`

除非未来出现真实、可验证的更高等级证据。

## 8.3 不将 Context Present 作为执行资格的唯一条件

这是对原 v0.10 的重要修正。

必须区分三个独立判断：

### A. Execution Eligibility

决定是否允许执行。

依据：

- Owner Authorization。
- Host Identity。
- Isolation Probe。
- Frozen Study。
- Request Budget。
- Stage R Gate。

### B. Evidence Qualification

决定实际拥有哪一级证据。

依据：

- Production Delivery Evidence。
- Host Evidence。
- Injection Evidence。
- Runtime Evidence。

### C. Conclusion Eligibility

决定报告允许作出什么结论。

依据：

- Gold Trust。
- Study Validity。
- Treatment Fidelity。
- Scoring Validity。
- Injection Evidence。
- RuleCode Identifiability。
- 其他混杂因素。

三者不能合并成一个 Gate。

## 8.4 受限结论

如果实验通过执行资格和 Gold Gate，但 Principle Prompt 只能证明 SUBMITTED：

允许产生受限实验报告。

ITT 可以描述分配到 A/B 条件的效果，但必须明确：

> 这是按实验分配条件估计的效果，不是已经验证模型实际消费了 Principle 内容的直接因果效果。

不得将这种结果包装成 Principle Content Effect。

如果没有 Gold 独立审核，则不能生成正式效果结论，即使 Runner 已经执行成功。

## 8.5 报告等级

```text
REPORT_PENDING
REPORT_INCONCLUSIVE
REPORT_VALID_WITH_LIMITATIONS
REPORT_READY
```

含义：

- `REPORT_PENDING`：实验尚未完成。
- `REPORT_INCONCLUSIVE`：证据不足或结果无法解释。
- `REPORT_VALID_WITH_LIMITATIONS`：执行和部分评估有效，但结论存在明确边界。
- `REPORT_READY`：满足预注册研究所要求的全部结论资格。

不能将 REPORT_READY 等同于长期行为改善已经成立。

---

# 9. Challenge Suite 与 Gold

## 9.1 复用现有研究资产

不建设新的 Challenge Authoring 系统。

复用：

- Pain。
- Pain Mechanism Mapping。
- Challenge Suite。
- `compileCase()`。
- `compileSuite()`。
- `freezeMapping()`。
- Scoring Contract。

优先选择现有已冻结且审核材料完整的 Suite。

## 9.2 Suite 选择条件

每个 Suite 必须验证：

- Suite ID。
- Suite Hash。
- Mapping Hash。
- Grader Hash。
- Principle Binding。
- Pain Lineage。
- Failure Mechanism。
- Gold Provenance。
- Independent Review。
- Scoring Compatibility。

## 9.3 Gold Gate

保留独立 Gold 审核。

`SYNTHETIC_OFFLINE` 只能用于：

- Offline Calibration。
- Pipeline Regression。
- Contract Validation。

不能用于正式真实行为效果结论。

如果当前没有可用的独立 Gold Suite：

允许完成离线产品流程，但正式真实评估保持阻塞。

不允许通过自动生成 Gold 或修改状态绕过 Gate。

---

# 10. Console 产品体验

## 10.1 产品原则

UI 必须以 Owner 的问题组织，而不是以内部技术模块组织。

建议分成四个主要页面。

### Page 1：Principle Evaluation

回答：

**我为什么需要评估这条 Principle？**

展示：

- Principle 内容。
- 关联 Pain。
- Failure Mechanism。
- 当前生命周期状态。
- 当前宿主激活状态。
- Production Evidence 摘要。
- 历史评估。
- 适用边界。

### Page 2：Study Configuration

回答：

**这个评估究竟要比较什么？**

展示：

- Target Principle。
- Full Library Incremental。
- Challenge Suite。
- Gold Status。
- Host。
- Model / Provider。
- RuleCode Baseline。
- A/B 对照内容。
- Production / Experimental Configuration Difference。

### Page 3：Execution & Evidence

回答：

**实验是否真正执行？证据可靠吗？**

展示三种运行模式：

| 模式 | 功能 | 真实模型调用 |
|---|---|---|
| Offline Stub | 离线研究管线验证 | 否 |
| Host Dry-run | Host 配置、身份、授权和冻结准备检查 | 否 |
| F2 Real Host | 真实 OpenClaw 受控实验 | 是 |

同时展示：

- 执行进度。
- Gate 状态。
- Request Consumption。
- RESULT_UNKNOWN。
- Host Identity。
- Injection Evidence。
- 失败和异常。

### Page 4：Evaluation Report

回答：

**这条 Principle 值得保留吗？下一步怎么办？**

展示：

1. Controlled A/B Effect。
2. Production Observation。
3. Negative Transfer。
4. Operational Cost。
5. Owner Outcome。
6. Evidence Coverage。
7. 结论边界。
8. 推荐后续动作。

不新增第二套设计系统。

保留 PD Console 现有 UI 风格。

---

# 11. Owner Decision Integration

## 11.1 复用现有治理能力

复用：

- `OwnerDecisionViewModel`。
- `deriveOwnerDecisionView()`。
- 现有 Principle Decision Inbox。
- Principle Detail。
- Activation Lifecycle。
- Owner Decisions。
- 现有治理审计。

必须注意：

`OwnerDecisionViewModel` 是只读决策投影。

现有 `POST /api/v1/governance/owner-decisions/:taskId/resolve` 是任务决策接口，不是通用 Examiner Study 决策接口。

因此不能直接把它当成 Examiner 的决策写入接口。

## 11.2 最小决策闭环

Examiner 报告完成后：

1. 关联目标 Principle。
2. 保留 Report ID 和 Hash。
3. 在 Principle Detail 中提供评估报告入口。
4. 将评估结果作为 Owner 决策参考。
5. Owner 进入现有 Principle Governance / Lifecycle 工作流执行实际动作。
6. 通过现有审计机制记录治理变更。

Owner 可采取的决策：

| 决策 | 后续动作 |
|---|---|
| 保留 | 继续观察 |
| 强化 | 进入既有原则修订和审批流程 |
| 修订 | 创建新版本并重新评估 |
| 暂缓 | 保留现状，等待更多证据 |
| 撤销 | 进入既有停用流程 |

如果需要记录 Owner 对真实行为结果的反馈，使用现有：

`POST /api/v1/evidence/outcomes`

该接口记录的是 Outcome Fact，不是 Principle Lifecycle Decision。

## 11.3 不新建决策系统

v0.10.1 不新增：

- `examiner_decisions` 数据库。
- 第二套 Principle Lifecycle。
- 自动 Promote。
- 自动 Deactivate。
- 自动修改 RuleCode 状态。

如果后续发现现有治理记录无法关联 Examiner Report，再独立评估最小扩展，不在本版本预先建设新的决策账本。

---

# 12. API 与执行架构

## 12.1 保留现有 Examiner API

继续使用：

```text
GET  /api/v1/examiner/overview
GET  /api/v1/examiner/principles

POST /api/v1/examiner/studies
GET  /api/v1/examiner/studies/:id

POST /api/v1/examiner/studies/:id/preflight
POST /api/v1/examiner/studies/:id/run

GET  /api/v1/examiner/studies/:id/report
POST /api/v1/examiner/studies/:id/report
```

## 12.2 新增必要的只读集成

建议：

```text
GET /api/v1/examiner/principles/:id/evidence
GET /api/v1/examiner/suites
GET /api/v1/examiner/suites/:suiteId
GET /api/v1/examiner/hosts/openclaw/readiness
```

这些接口只做聚合和只读投影。

底层继续使用现有 Model 和 Store。

如果现有路由可以直接提供所需信息，则优先复用现有路由，不强制新增 API。

## 12.3 F2 异步执行

当前 Examiner Console `/run` 是同步等待 Offline Runner 完成的路径。

不能直接将真实 F2 长时间执行简单塞进同步 HTTP Request。

v0.10.1 必须为真实执行定义最小异步契约：

```text
POST /studies/:id/run
          |
          v
    Validate Gates
          |
          v
    Acquire Study Lock
          |
          v
    Durable RUN_STARTED
          |
          v
    Invoke Existing Runner
          |
          v
    Append Execution Events
          |
          v
    Report V2
```

要求：

- Run 请求成功接受后返回 `202 Accepted`。
- 返回稳定的 Study ID 和 Run ID。
- 状态从现有 Study Ledger / Events 派生。
- 使用现有 Study Lock。
- 不允许同一个 Study 并发启动两个 Run。
- 重复请求必须幂等或明确拒绝。
- 不自动重试 RESULT_UNKNOWN。
- 服务器重启后必须能够识别未完成 Run。
- 不得把未完成 Attempt 自动视为失败。
- 继续遵循现有 Reservation / Result / Settlement 机制。

执行器优先复用：

`runChallengeStudy()`

允许增加薄的 Worker/Process Lifecycle Adapter，但不得新增通用任务调度器、DAG 或第二套 Execution Ledger。

具体 Worker 生命周期必须在 Phase 0 核对现有部署和进程管理约束后确定。

如果无法保证恢复和幂等，禁止启用 Console F2。

---

# 13. Gates 与权限

## Gate 0：Input Integrity

要求：

- Principle 来源正确。
- Activation 来源可信。
- Suite Frozen。
- Mapping 正确。
- RuleCode Baseline 完整。
- Host Baseline 可识别。

## Gate 1：Challenge Trust

要求：

- Gold 独立审核通过。
- Grader 与 Suite 匹配。
- Challenge 适用于目标 Failure Mechanism。
- 不存在 Gold 泄漏。

Gate 1 不通过，不允许正式效果裁定。

## Gate 2：Execution Eligibility

要求：

- Owner Authorization 有效。
- Study Hash 匹配。
- Suite Hash 匹配。
- Host 身份符合授权。
- Isolation Probe PASSED。
- Budget 未超限。
- Runner Preflight 通过。
- A/B 执行条件一致。

Gate 2 不要求提前证明 CONTEXT_PRESENT。

它只决定能否安全执行。

## Gate 3：Evidence Qualification

根据实际 Evidence 等级裁定：

- SUBMITTED。
- HOST_ACCEPTED。
- CONTEXT_PRESENT。
- RUNTIME_LOADED。

不允许通过修改 Host Capability Table 提升证据等级。

## Gate 4：Conclusion Qualification

要求：

- Gold Trust。
- Study Validity。
- A/B 执行有效。
- RuleCode Identifiability。
- Treatment Fidelity。
- Scorer Validity。
- Injection Evidence。
- 混杂因素评估。

根据证据等级限制最终结论。

## Gate 5：Owner Governance

Owner 明确作出最终决策。

Examiner 不拥有 Principle Lifecycle 的写入权。

---

# 14. 实施计划

原则：

**先让 Owner 获得真实产品价值，再逐步开放更强的真实宿主评估能力。**

## Phase 0：Source Reuse Audit

状态：本轮源码核验已完成。

交付：

- v0.10.1 SPEC。
- 源码复用矩阵。
- 产品差距清单。
- 关键证据边界。

后续实施时只对具体变更点补充源码核验，不重新进行全仓泛化审计。

## Phase 1：Owner Workflow Productization

目标：让 Examiner 从技术导向界面变成 Owner 决策界面。

工作：

- Principle Evaluation。
- Production Evidence Panel。
- Study Configuration。
- Execution & Evidence。
- Evaluation Report。

复用现有 API 和 Model。

交付：

真实浏览器可操作的 Examiner 页面。

## Phase 2：Production Evidence Integration

目标：让 Examiner 能够查看真实 Principle 的生产状态和行为证据。

工作：

- Prompt Activation Snapshot。
- Production Prompt Projection。
- RuleCode Activation。
- Intervention Evidence。
- Receipts。
- Owner Outcome。

不创建新的数据存储。

交付：

一条 Principle 的生产证据完整展示。

## Phase 3：Host-backed Study Inputs

目标：让 Study 不再依赖固定合成输入。

工作：

- 选择真实 Principle。
- 关联真实 Pain。
- 选择可信 Challenge Suite。
- 读取真实 HEPS。
- 读取 RuleCode Baseline。
- 冻结生产与实验基线。
- 完成 Preflight。

继续使用 v0.9 Study Engine。

交付：

真实输入、冻结、可复算的 Host-backed Study。

本阶段不调用真实模型。

## Phase 4：Offline End-to-end Product Closure

目标：先证明整条产品工作流能够完成。

工作：

- 创建 Study。
- 冻结 Study。
- 执行 Offline Stub。
- 生成 Report V2。
- 读取 Production Evidence。
- 显示 Owner Decision Handoff。

交付：

真实浏览器完整业务流程通过。

离线测试不产生真实宿主结论。

## Phase 5：OpenClaw F2 Integration

目标：将现有 Stage R / F2 接入 Examiner。

工作：

- 复用 OpenClaw Host Transport。
- 复用 Actor Adapter。
- 复用 Stage R Gate。
- 复用 Isolation Probe。
- 复用 Budget Ledger。
- 实现最小异步执行契约。
- 验证 Host Baseline。
- 验证 Session / Workspace 隔离。
- 验证 Injection Evidence。

交付：

Host Dry-run 通过。

没有 Owner 授权时，真实模型调用必须为零。

## Phase 6：Owner-authorized Real Evaluation

只有 Phase 0–5 全部通过后才能启动。

要求：

- Gate 1 通过。
- Gate 2 通过。
- Gate 3 证据边界明确。
- Gate 4 结论范围预先确定。
- Owner 单独授权。
- Study 与 Authorization 完全绑定。
- 有限规模真实 OpenClaw A/B。
- Report V2 完成。
- Owner Review。

本阶段不属于默认授权。

---

# 15. 验收标准

| ID | 验收项 | 标准 |
|---|---|---|
| AC-01 | v0.9 兼容 | 历史 Study 可读 |
| AC-02 | Offline Study | 原有能力完整保留 |
| AC-03 | Principle Source | 正式 Ledger |
| AC-04 | Runtime Activation | 真实 Activation |
| AC-05 | Activation Completeness | warnings 可见，关键缺失阻断 |
| AC-06 | Production Projection | 复用生产计算逻辑 |
| AC-07 | Prompt Budget | 使用实际预算来源及单位 |
| AC-08 | Production Evidence | 接入 Receipts |
| AC-09 | Evidence Coverage | 展示完整性与保留范围 |
| AC-10 | RuleCode | 真实状态可核验 |
| AC-11 | RuleCode Independence | 无证据不得声称独立 |
| AC-12 | Challenge Suite | Frozen + Independent Gold |
| AC-13 | Full Library A/B | 唯一目标干预变量 |
| AC-14 | Host Baseline | 非 PD 基线冻结 |
| AC-15 | OpenClaw F2 | 复用现有 Transport |
| AC-16 | Stage R | 原有授权门不降低 |
| AC-17 | Async Run | 幂等、可恢复、状态可读 |
| AC-18 | Injection Evidence | 等级真实 |
| AC-19 | Scorer | 复用 V3 |
| AC-20 | Report | 复用 V2 |
| AC-21 | Owner Decision | 接入既有治理流程 |
| AC-22 | Browser | 完整真实浏览器验收 |
| AC-23 | Unauthorized Calls | 零真实调用 |
| AC-24 | Production Mutation | 未授权时零生产状态变更 |

最终交付状态：

```text
READY_FOR_OWNER_REVIEW
READY_FOR_AUTHORIZATION
READY_FOR_REAL_HOST_EXECUTION
PASS_WITH_LIMITATIONS
BLOCKED
```

---

# 16. 长期行为改善的评价边界

Examiner 的长期产品价值不是一次 A/B 实验的提升幅度。

真正重要的是：

- Agent 是否减少重复犯错？
- Owner 是否减少反复纠正？
- Agent 是否能够在不同任务中迁移原则？
- 是否减少人工监督成本？
- 行为改善是否能够持续？
- 是否产生新的负迁移？

但是 v0.10.1 不建设新的长期观察引擎。

优先复用现有：

- Behavior Episodes。
- Intervention Evidence。
- Owner Outcomes。
- Runtime Activation。
- Existing Pain Signals。

后续只有在数据覆盖充分、时间窗口足够、对照条件明确时，才开展长期趋势评价。

尤其注意：

90 天 Evidence Coverage 不等于 90 天内行为改善已经得到因果证明。

短期 F2 A/B 也不等于长期 Principle Internalization。

报告必须保持这些概念的独立性。

---

# 17. 禁止事项

1. 不重写 Examiner v0.9。
2. 不重写 Runner。
3. 不重写 Scorer V3。
4. 不重写 Report V2。
5. 不重写 Stage R。
6. 不重写 OpenClaw Transport。
7. 不建设第二套 Evidence Store。
8. 不建设第二套 Owner Decision 系统。
9. 不建设新的通用 Scheduler。
10. 不将 Ledger ACTIVE 当成 Runtime Activated。
11. 不将 Prompt Projection 当成实际消费证明。
12. 不将 SUBMITTED 升级为 CONTEXT_PRESENT。
13. 不将 RuleHost Evidence 当成 Principle Prompt Evidence。
14. 不将 Owner Feedback 当成独立 Gold。
15. 不将 F2 受控实验当成生产长期行为改善。
16. 不使用 Synthetic Gold 生成正式效果结论。
17. 不将未知 RuleCode 状态当作 OFF。
18. 不自动修改生产 Activation。
19. 不自动修改 RuleCode。
20. 不自动修改 Principle Lifecycle。
21. 不复用过期授权。
22. 不执行未经授权的真实模型调用。
23. 不自动合并 PR。
24. 不自动部署生产环境。
25. 不因为非核心问题无限扩大整改范围。

---

# 18. 最终产品定义

Examiner 的最终价值，不是让 PD 拥有一个越来越复杂的实验系统。

而是让 PD 能够真正回答：

**我们引入的 Principle，是否让 Agent 在真实工作中变得更值得信任？**

要回答这个问题，Examiner 必须同时利用两类证据：

- 受控实验：判断目标 Principle 的增量行为效果。
- 生产观察：判断 Principle 在真实运行环境中的表现。

再由 Owner 结合证据作出治理决策。

这意味着 Examiner 的产品目标应当是：

**从 Principle Evaluation 走向 Owner-controlled Behavioral Evolution。**

我们不是为了增加实验数量而建设 Examiner。

我们是为了让 Owner 能够减少对 Agent 的反复纠正，更放心地委托复杂任务，并且能够知道这种改善是否真实、持续、可解释。

最终原则：

> Evidence informs decisions. Decisions govern activation. Activation changes behavior. Behavior produces new evidence.

**Examiner 不负责证明 PD 一定有效。它负责帮助 Owner 识别 PD 在什么条件下有效、何时无效，以及下一步应该如何改进。**

---

## Owner Decision

本 SPEC 提交 Owner 审核。

默认允许：

- 源码只读审查。
- 增量实现。
- 离线测试。
- 真实浏览器验收。
- 只读生产 Evidence 接入。

默认不允许：

- 真实模型调用。
- 真实 OpenClaw 实验。
- 生产 Principle / RuleCode 状态变更。
- 自动治理决策。
- 自动合并。
- 自动部署。

所有真实宿主实验必须另行获得明确 Owner 授权。