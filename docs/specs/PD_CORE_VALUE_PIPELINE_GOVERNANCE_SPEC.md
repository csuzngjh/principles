# PD Core Value Pipeline Contract & Governance SPEC v0.3
## Owner-Governed Intervention Lifecycle × Core Value Pipeline × Causal Evidence

> **Status**: Owner-aligned architecture SPEC  
> **Version**: v0.3  
> **Date**: 2026-09-15  
> **Primary long-term purpose**: 定义 PD 核心价值系统未来 12–24 个月应长期保护的稳定契约  
> **Primary current use**: 为 PRI-803 RuleCode Runtime Closure 提供不误导的执行地图与验收边界  
> **Evidence basis**: PR #1707 / #1710 / #1717 + GPT-6 independent architecture review  
> **Core principle**: **先看清，再动手。先证明真实行为改变，再固化治理。**

---

# 0. Executive Summary

PD 不应该长期把“数据管道”本身当作最终治理对象。

更稳定的长期治理对象是：

> **Owner-Governed Intervention Lifecycle**  
> 一次有明确来源、明确内容版本、明确授权范围、真实运行时作用、可验证证据、可撤销边界的行为干预生命周期。

因此 v0.3 采用三层模型：

```text
长期治理对象
Owner-Governed Intervention Lifecycle

架构审查视角
Evidence Flow
×
Decision Flow
×
Authority Flow
×
Behavior Change Flow

工程实现地图
Core Value Pipeline
```

Pipeline 仍然重要，但它是：

```text
实现投影
+
定位工具
```

而不是：

```text
系统本体
```

---

# 1. v0.3 相比 v0.2 的核心变化

v0.3 不继续把 SPEC 写得更长，而是重新分层。

主要修正：

1. 把“Pipeline”从长期治理对象降为工程实现地图；
2. 引入 **Owner-Governed Intervention Lifecycle** 作为长期宪法级抽象；
3. 引入 **Causal Evidence**，明确：
   ```text
   lineage / event ordering
   ≠
   causal attribution
   ```
4. 把：
   ```text
   reviewed = approved = activated
   ```
   升级为：
   ```text
   reviewed = approved = activated = executed
   ```
5. 不再把 OpenClaw 当成单一能力面；
6. rollback 不再要求 Agent“遗忘”，而是要求：
   ```text
   runtime intervention effect stops
   ```
7. “One fact → one writer”重写为：
   ```text
   One fact
   → one mutation authority
   → multiple callers may enter through that authority
   → no independent competing writer
   ```
8. 长期 Contract 与 Current Snapshot 明确拆开；
9. 把 current-main 的 flag、pin、stage list、host matrix、具体 writer 方法移到 Audit Snapshot；
10. 增加：
    - temporal validity
    - retries / idempotency
    - evidence contamination
    - rule interaction
    - Owner cognitive load
    - governance ossification
    等长期系统风险。

---

# 2. 系统真正要保护什么

PD 的核心价值不是：

```text
Pain 被写进数据库
```

不是：

```text
Principle 被生成
```

不是：

```text
RuleCode 被批准
```

也不是：

```text
activation row 存在
```

真正要保护的是：

> **一次来自真实 Pain 的行为干预，在 Owner 授权下进入运行时，并且能够被证明对 Agent 的后续行为产生了真实、可归因、可撤销的影响。**

长期目标链：

```text
Evidence
→ Interpretation
→ Intervention Proposal
→ Owner Governance
→ Authorization
→ Runtime Enforcement / Exposure
→ Agent Response
→ Outcome Evidence
→ Attribution
→ Revision / Revocation / Reinforcement
```

---

# 3. 三层架构模型

## 3.1 Layer A — Owner-Governed Intervention Lifecycle

这是长期治理本体。

一个 Intervention 至少必须回答：

```text
为什么产生？
是什么内容？
哪一版？
谁批准？
批准什么范围？
什么时候有效？
在哪里生效？
执行的是哪一版？
产生了什么行为反馈？
结果如何？
证据强度是多少？
如何撤销？
撤销后什么必须停止？
```

---

## 3.2 Layer B — Four Flows Review Model

长期审查任何核心改动时，都从四条 flow 看。

### Evidence Flow

```text
真实发生了什么？
什么证据证明它发生了？
证据来自哪里？
证据是否污染？
证据是否可回链？
```

### Decision Flow

```text
系统如何从 Evidence
推导出 Diagnosis / Principle / Rule？
```

### Authority Flow

```text
谁有权接受？
谁有权批准？
批准的内容、范围、时间是什么？
谁有权撤销？
```

### Behavior Change Flow

```text
Intervention 如何进入 runtime？
Agent 是否收到？
下一步行为是否改变？
改变是否来自当前 intervention？
```

---

## 3.3 Layer C — Core Value Pipeline

用于工程定位。

```text
Observe
→ Pain Admission
→ Diagnosis
→ Principle Formation
→ Channel Decision
→ Internalization
→ Evaluation
→ Rollout
→ Owner Governance
→ Activation
→ Runtime Enforcement
→ Agent Adaptation
→ Outcome Evidence
```

该 Pipeline：

```text
用于定位代码
用于理解 producer / consumer
用于识别 contract seam
```

但不能作为因果证明。

---

# 4. 核心长期不变量

以下是不依赖 Runtime V2、OpenClaw、Codex、具体 DB Schema、Prompt 实现的长期约束。

## INV-01 — Owner Authority

价值判断、原则接受、授权范围和高风险例外最终属于 Owner authority。

AI 可以：

```text
分析
建议
代做已授权判断
```

但不能自行扩大授权。

---

## INV-02 — Rejection Is Valid

以下都必须是合法结果：

```text
reject
archive
defer
do nothing
```

不是所有 Pain 都必须转化为行为干预。

---

## INV-03 — Exact Intervention Identity

以下必须可验证为同一内容身份：

```text
reviewed
=
approved
=
activated
=
executed
```

不能仅依赖：

```text
logical artifact id
```

应至少绑定不可歧义：

```text
revision
或
content digest/hash
```

---

## INV-04 — Authorization Is Temporal

批准不是永久真理。

授权必须包含：

```text
content identity
scope
control state
validity
```

执行时必须确认授权仍然有效。

---

## INV-05 — One Mutation Authority

每类核心治理事实：

```text
Pain admission
approval
activation
promotion
disable
rollback
Owner resolution
```

必须有：

```text
one mutation authority
```

允许多个 caller：

```text
Console
CLI
repair
automation
```

但 caller 必须进入同一个 authority。

禁止：

```text
独立 competing writer
```

---

## INV-06 — Governance State ≠ Observation State

必须长期保持：

```text
Observation / Evidence
≠
Governance / Control
```

trajectory / telemetry 不能成为第二治理状态源。

---

## INV-07 — Retry Must Not Duplicate Meaning

retry / replay / resume / recovery：

不得自动产生：

```text
第二个授权
第二个 Pain
第二个成功样本权重
第二个独立 outcome
```

除非业务语义明确要求。

---

## INV-08 — Recovery Must Not Escalate Authority

恢复任务执行：

```text
≠
重新批准内容
≠
扩大 scope
≠
解除隔离
```

---

## INV-09 — Runtime Capability Must Be Proven

```text
source supports
```

不等于：

```text
published package supports
```

不等于：

```text
pinned runtime supports
```

不等于：

```text
installed runtime supports
```

不等于：

```text
current process loaded it
```

声明 runtime capability 必须有真实运行证据。

---

## INV-10 — Evidence Strength Limits Claim Strength

不能用：

```text
activation exists
receipt exists
task succeeded
```

直接推出：

```text
Rule caused improvement
```

结论强度必须匹配证据强度。

---

# 5. 因果性：PD 长期最重要的新增契约

## 5.1 关键区分

```text
Correlation
≠
Causation
```

以下链条即使全部真实：

```text
Rule approved
→ Rule activated
→ receipt exists
→ Agent later succeeds
```

仍不能自动证明：

```text
Agent success
是由当前 Rule 导致
```

---

## 5.2 Minimum Causal Evidence

单次行为闭环最低要求：

1. 明确目标错误行为；
2. before / after case 可比较；
3. host / runtime / profile /关键上下文差异可解释；
4. reviewed / approved / activated / executed 是同一 intervention revision；
5. actual hook 明确 block/correct；
6. feedback 确实进入 Agent 可见上下文；
7. Agent 下一动作响应这个反馈；
8. 原目标随后完成；
9. positive case 不被误伤；
10. rule-off / rollback 后，同类受控输入不再受该 activation 作用；
11. 排除明显污染：
    - 人工提示
    - 旧会话
    - 其他 Rule
    - 旧 receipt
    - 选取成功 retry
    - 环境改变。

满足以上：

```text
可以声称：
“本次受控案例提供了 intervention 导致行为改变的机制性证据”
```

不能声称：

```text
跨模型普遍有效
跨宿主普遍有效
长期统计收益已证明
```

---

## 5.3 Strong Causal Evidence

在 Minimum 基础上：

```text
off → on → off
```

或类似可逆对照。

最好再增加：

- clean session；
- independent case；
- 少量重复；
- 失败结果也保留；
- 排除其他 active intervention。

---

## 5.4 Insufficient Evidence

以下都不足：

- activation 后成功；
- Agent 自述“我遵守了规则”；
- helper 返回 blocked；
- replay test 通过；
- receipt 单独存在；
- rollback 只改 DB；
- artifact ID 相同但执行内容未验证；
- positive control 通过但没有 rule-off；
- before / after 环境不同且未说明；
- 只报告最后一次成功 retry。

---

# 6. Golden Journeys

长期只保留四条，不绑定当前具体 stage 名。

## J1 — Principle Intervention

```text
真实 Pain
→ Principle Proposal
→ Owner Accept / Reject
→ Authorized Exposure
→ Agent receives Principle
→ Behavior Evidence
→ Outcome Assessment
```

重点：

```text
曝光 ≠ 改善
```

---

## J2 — RuleCode Intervention

```text
真实 Pain
→ Rule Proposal
→ Evaluation
→ Owner Approval
→ Authorized Runtime Enforcement
→ actual block/correct
→ Agent receives feedback
→ Agent changes next action
→ task completes
→ positive control
→ revocation
```

当前 PRI-803 就是 J2 的首个真实验证基线。

---

## J3 — Revision / Recovery

```text
old intervention
→ revision
→ old authorization no longer applies
→ new revision reviewed
→ new approval
→ runtime receives exact new revision
```

恢复执行不得偷偷继承新授权。

---

## J4 — Revocation

```text
active intervention
→ disable / isolate / rollback
→ subsequent controlled runtime call
→ intervention effect no longer applied
```

这里验证的是：

```text
runtime effect disappears
```

不是：

```text
Agent forgets previous correction
```

---

# 7. Revocation / Rollback Contract

长期必须区分：

### Control revocation

```text
future execution no longer authorized
```

### Runtime revocation

```text
actual host no longer applies intervention
```

### Cognitive residue

Agent 之前已经获得的信息可能仍在：

```text
conversation
memory
context
workspace
```

不能把这种 residue 误判为 rollback 失败。

---

# 8. Trust Boundary

不可信来源包括：

```text
generated RuleCode
model output
external evidence
host-provided untrusted payload
```

原则：

> 不可信内容不得因为“尚未正式激活”就获得更弱的执行隔离。

长期目标不是：

```text
更强 blacklist
```

而是：

```text
clear trust boundary
+
safe capability crossing
```

R-19 属于当前实现 finding，应留在 Audit / Linear，不作为长期 Contract 细节。

---

# 9. Owner Governance Boundary

## 9.1 Owner MUST Decide

长期建议保留 Owner authority：

- value judgment；
- principle acceptance；
- activation authorization；
- high-risk exception；
- trust-boundary override；
-不可逆治理策略变更；
- 改变产品风险承诺的行为。

---

## 9.2 AI May Recommend

AI 可：

- 分析 evidence；
- 起草 Principle / Rule；
- 做风险判断；
- 给 Owner 提供选项；
- 在明确委托范围内代 Owner 做判断。

但：

```text
recommendation
≠
authorization
```

---

## 9.3 System May Auto-Resolve

系统应自动消化：

- deterministic retry；
- idempotent dedupe；
- evidence linking；
- safe recovery；
- health diagnostics；
- schema normalization；
- bounded repair；
- known-safe rollback execution。

原则：

> Owner 决定承诺与例外，系统消化机械确定性工作。

---

# 10. Owner Cognitive Load

PD 长期不能变成：

```text
AI 生成 100 个东西
→ Owner 批 100 次
```

长期必须保护：

```text
Owner attention
```

只有以下事情值得升级：

```text
新的价值判断
新的授权
新的高风险例外
真正证据冲突
不可逆动作
```

以下不应升级：

```text
机械 retry
确定性 recovery
重复 warning
已知健康检查
可自动归并 evidence
```

---

# 11. Governance Ossification

治理本身不能成为架构僵化来源。

所有 guard 分四类。

## Hard Gate

长期不可违反：

- exact intervention identity；
- active authorization；
- trust boundary；
- mutation authority；
- executed-test truth；
- installed/runtime capability truth；
- revocation correctness。

---

## Soft Gate / Warning

适合提醒：

- prompt example drift；
- capability matrix freshness；
- noncritical parity gap；
- deprecated path；
- audit staleness。

---

## Review Question

只要求解释：

- 是否改变 topology；
- 是否新增 caller；
- 是否改变 host-specific behavior；
- 是否改变 retry semantics；
- 是否改变 evidence interpretation。

---

## Current Assumption

不得固化：

- 当前 stage 数量；
- 当前函数名；
- 当前 writer 数量；
- 当前 schema 名；
- 当前 runtime pin；
- 当前 host parity；
- 当前 feature flag。

---

# 12. Core Value Pipeline — Current Engineering Map

> 本节是 **Current Snapshot / Engineering Map**，不是长期宪法。

当前工程地图：

```text
Observe
→ Pain Admission
→ Diagnosis
→ Principle Formation
→ Channel Decision
→ Internalization
→ Evaluation / Rollout
→ Owner Governance
→ Activation
→ Runtime Exposure / Enforcement
→ Agent Adaptation
→ Outcome Evidence
```

---

# 13. Effective Topology

当前工程理解：

```text
Effective Runtime Topology
=
Declared DAG
+
Transition Authority
+
Bypass / Ingress Paths
```

### Declared DAG

代表：

```text
legal edge declaration
```

不代表完整生产拓扑。

### Transition Authority

决定：

```text
verdict
→ next legal state/task
```

### Bypass / Ingress

包括：

- manual ingress；
- special runner；
- recovery；
- synthetic baseline；
- adversarial loop；
- direct production entry。

---

# 14. Current Five-Layer Contract Model

对于当前结构化 LLM Stage：

```text
Prompt Contract
↓
Tool / Provider Schema
↓
Canonical Output Schema
↓
Normalizer / Adapter
↓
Semantic Validator
```

这是当前实现的重要审查框架。

但长期 Contract 不应要求永远“恰好五层”。

长期真正不变量是：

> **模型被要求产生的内容、系统允许的内容、系统解释的内容与系统最终判定的内容必须语义一致。**

---

# 15. Current Lineage Model

当前执行时必须能回答：

```text
Pain
→ Diagnosis
→ Principle
→ Internalization Task
→ Artifact Revision
→ Evaluation
→ Approval
→ Activation
→ Execution
→ Runtime Evidence
→ Outcome
```

关键：

```text
executed
```

必须进入 identity chain。

---

# 16. Exact Execution Identity

每次行为闭环至少记录：

```text
intervention content hash / revision
approval id
activation id
host
host mode
runtime/package version
process/session/run id
tool call / hook invocation
receipt/evidence id
control state
```

目的不是增加数据库，而是：

> 防止把旧 artifact、旧 activation、旧 receipt、旧 runtime 的证据拼到当前闭环上。

---

# 17. Mutation Authority

长期采用：

```text
One fact
→ one mutation authority
```

允许：

```text
Console
CLI
automation
repair
```

作为 caller。

不允许：

```text
caller 自己建立平行 mutation logic
```

例如：

```text
Console → Authority
CLI → Authority
Repair → Authority
```

而不是：

```text
Console → DB write A
CLI → DB write B
Repair → DB write C
```

---

# 18. Persistence Boundary

## Observation Plane

回答：

```text
发生了什么？
```

例如：

- session；
- messages；
- tool calls；
- receipts；
- runtime event；
- behavior evidence。

---

## Governance Plane

回答：

```text
系统允许什么？
当前授权是什么？
当前 intervention 状态是什么？
```

---

## Diagnostic Plane

回答：

```text
为什么失败？
```

这三者可以有交叉链接，但不能互相替代 authority。

---

# 19. Deployment Projection Contract

必须长期保护：

```text
Source Contract
↓
Published Package
↓
Bundle / Pin
↓
Installed Runtime
↓
Loaded Runtime
↓
Actual Host Capability
```

其中任何一层都可能漂移。

所以：

```text
source green
```

不能作为：

```text
live host ready
```

的证据。

---

# 20. Host Reality

长期 Contract 不应该规定：

```text
OpenClaw 一定完整
Codex 一定不完整
```

这些属于 Current Snapshot。

长期只规定：

> **每个 host 的 capability 必须被明确、可验证、不可假设。**

当前 PRI-803 执行时，应进一步区分：

```text
OpenClaw legacy
OpenClaw shared runtime
Codex
```

不能把“OpenClaw”作为单一 capability。

---

# 21. Test Truth

新增长期原则：

```text
Test file exists
≠
test executes
```

一个机械 guard 只有在：

```text
真实 discovery
+
真实执行
+
失败可见
```

时才算保护。

---

# 22. Mechanical Guards — 最小长期集合

长期只建议五类强 guard。

## G1 — Exact Intervention Identity Guard

保护：

```text
reviewed
approved
activated
executed
```

同一 revision/hash。

覆盖：

- stale approval；
- overwrite；
- concurrent revision；
- old activation；
- old receipt。

---

## G2 — Mutation Authority Guard

禁止：

```text
未经 authority 的独立 writer
```

尤其：

- approval；
- activation；
- promotion；
- disable；
- rollback；
- recovery。

---

## G3 — Runtime Capability Guard

声明某能力存在时：

必须验证：

```text
installed
+
loaded
+
actual host behavior
```

---

## G4 — Production Contract Guard

代表性输入必须穿过真实：

```text
adapter
schema
normalizer
validator
consumer
```

而不是仅测试局部 schema。

---

## G5 — Test Discovery Guard

任何被宣称保护核心 Contract 的测试：

```text
必须被发现
必须执行
失败必须阻止错误结论
```

---

# 23. PRI-803 Current Sprint Contract

当前主目标：

```text
J2 RuleCode Runtime Closure
```

不是：

```text
架构治理改造
```

---

## 23.1 PRI-803 必须证明

```text
真实 Pain
→ Rule generated
→ Evaluated
→ Owner decision
→ Console Approval
→ Exact activation
→ Exact execution
→ Real host hook
→ block/correct
→ feedback reaches Agent
→ Agent next action changes
→ task completes
→ positive control
→ runtime revocation
```

---

## 23.2 PRI-803 必须记录

至少：

```text
Pain identity
Rule revision/hash
Approval id
Activation id
Executed revision/hash
host
host mode
runtime/package version
run/session
hook invocation
receipt
before evidence
after evidence
positive control
revocation evidence
```

---

## 23.3 PRI-803 不得用作成功证据

以下均不能单独判成功：

- Linear Done；
- PR merged；
- activation row；
- helper blocked=true；
- replay test；
- Agent 自述；
- receipt；
- test green；
- schema valid。

---

# 24. PRI-803 Sprint Guardrails

1. **MUST** 用运行证据判断闭环，不用任务状态判断。
2. **MUST** 证明 reviewed/approved/activated/executed 是同一内容身份。
3. **MUST** 记录实际 host mode，不只写 OpenClaw。
4. **MUST** 记录实际 loaded runtime capability。
5. **MUST** 在真实 hook 上做 sentinel。
6. **MUST** 证明 block/correction feedback 进入 Agent。
7. **MUST** 明确指出 Agent 哪个下一动作改变。
8. **MUST** 检查污染：人工提示、其他 Rule、旧上下文、旧 receipt。
9. **MUST** 做 positive control。
10. **MUST** 做 runtime revocation test。
11. **MUST NOT** 用 helper / DB 直改 / test-only writer 替代 production path。
12. **MUST NOT** 为未命中的架构债暂停主冲刺。

---

# 25. R-19 Sprint Policy

R-19 属于当前实现安全 finding，不属于长期 Contract 细节。

当前规则：

```text
如果 PRI-803 即将让不可信生成代码
进入已确认缺乏有效隔离的 pre-activation execution path
→ 在执行前 STOP
→ 最小修复或重新选择安全路径
```

不是：

```text
等发生逃逸以后再处理
```

也不是：

```text
先重构整个 sandbox 再冲刺
```

---

# 26. Current Host Choice for PRI-803

基于当前审计：

```text
优先 OpenClaw
```

但必须具体到：

```text
OpenClaw legacy/shared mode
```

当前目标不是：

```text
证明跨宿主 parity
```

而是：

```text
先证明一个真实宿主上的 J2
```

---

# 27. Current vs Long-term 分离

长期 Contract：

```text
保存稳定不变量
```

Audit Snapshot：

```text
保存 current implementation facts
```

Linear：

```text
保存已知 defect / follow-up
```

Source：

```text
保存真实 runtime authority
```

---

# 28. 应移动出长期 SPEC 的内容

以下 current fact 不应长期固化：

- 当前具体 Stage 名单；
- 当前 `CHANNEL_EDGES` 结构；
- 当前 schema ref 名称；
- 当前 writer 方法；
- 当前 flag 默认值；
- 当前 OpenClaw/Codex capability；
- 当前 runtime pin；
- 当前 R-19 / NEW-E1 状态；
- 当前 Vitest include bug；
- current-main file:line。

这些应进入：

```text
docs/audit/
Linear
source code
```

---

# 29. Audit Freshness

长期只保留原则：

```text
Architecture claim
must name evidence baseline
```

对于长审计：

```text
Immutable Worker Baseline
→ Review / Synthesis
→ Final-main Delta Sync
→ Owner Decision
```

不把具体流程机械化成唯一标准。

---

# 30. Change Classification

## Class A — Contract Change

改变：

- authorization semantics；
- intervention identity；
- execution identity；
- mutation authority；
- trust boundary；
- revocation；
- evidence semantics；
- behavior attribution；
- persistence authority；
- host capability contract。

要求：

```text
明确受影响 invariant
+
相关 Golden Journey evidence
```

不强制每次新建 guard。

---

## Class B — Internal Implementation Change

例如：

- Prompt wording；
- retry tuning；
- model profile；
- internal refactor；
- telemetry enrichment。

前提：

```text
不改变 Class A semantics
```

---

## Class C — Pure Refactor / Docs

证明：

```text
no contract delta
```

即可。

---

# 31. 长期治理最容易失败的十种方式

1. **False causality**  
   activation 后成功被误认为 Rule 导致。

2. **Evidence self-reinforcement**  
   Rule 自己制造的 block/event 又被当成 Rule 必要性的证据。

3. **Revocation incompleteness**  
   DB disable 了，runtime 仍继续执行。

4. **Temporal authorization drift**  
   内容相同，但旧授权已经不应继续有效。

5. **Rule interaction deadlock**  
   单规则合法，组合后互相阻塞。

6. **Owner overload**  
   Owner 被大量低价值审批淹没。

7. **Retry evidence inflation**  
   多次 retry 被当成多次独立成功样本。

8. **Recovery becomes authorization**  
   repair/reopen 偷偷扩大权限。

9. **Governance ossification**  
   当前实现被 CI 永久固化。

10. **Proxy success**  
    schema/CI/approval/activation/receipt 全绿，却没有真实行为改善。

---

# 32. AI-Maintained Repository Contract Priority

对于主要由 AI 持续修改的系统，长期 Contract 有效性排序：

1. 真实 production boundary 上可执行 invariant；
2. runtime assertion / transaction constraint；
3. Golden Journey；
4. executable schema + real consumer validation；
5. enforceable authority boundary；
6. generated/verifiable contract snapshot；
7. graph constraint；
8. executable example；
9. prose documentation。

Prose 仍用于：

```text
解释 WHY
解释 Owner intent
解释价值边界
```

但不能单独承担保护。

---

# 33. 最终长期文档结构建议

冲刺之后，建议将长期稳定版本收敛为：

```text
docs/architecture/
PD_CORE_VALUE_PIPELINE_CONTRACT.md
```

内容只保留：

1. Owner-Governed Intervention Lifecycle；
2. Four Flows；
3. 10 Long-term Invariants；
4. 4 Golden Journeys；
5. Causal Evidence Standard；
6. Mutation Authority；
7. Revocation Contract；
8. Trust Boundary；
9. Deployment Projection；
10. 5 Mechanical Guards；
11. Change Classification；
12. Owner Governance Boundary。

---

# 34. Current Snapshot 文档

所有 current implementation truth：

```text
docs/audit/
```

例如：

- Topology；
- Stage；
- Schema registry；
- Host Matrix；
- Writer Matrix；
- Known Red Zone；
- pin；
- flag；
- current defect。

---

# 35. Done Definition — PRI-803

PRI-803 Done 不是：

```text
文档完成
工单完成
PR merged
```

而是存在真实证据证明：

- [ ] exact Pain 已确认；
- [ ] exact Rule revision 已生成；
- [ ] evaluation 未弱化；
- [ ] Owner decision 有证据；
- [ ] Console 批准真实发生；
- [ ] approved revision = activated revision；
- [ ] activated revision = executed revision；
- [ ] actual host hook 执行；
- [ ] block/correct feedback 送达 Agent；
- [ ] Agent 下一动作可指出；
- [ ] 原任务完成；
- [ ] positive control pass；
- [ ] runtime revocation 后 intervention effect 消失；
- [ ] pollution check 完成；
- [ ] outcome 标记为：
  - IMPROVED
  - NO_IMPROVEMENT
  - REGRESSION
  - INCONCLUSIVE
  - NOT_REACHED。

---

# 36. Done Definition — Long-term Governance

长期治理成熟，不等于 guard 数量多。

Done 标准：

- [ ] Owner authority 清晰；
- [ ] intervention identity 可验证；
- [ ] executed identity 可回链；
- [ ] authorization temporal validity 明确；
- [ ] mutation authority 无 competing writer；
- [ ] revocation 有 runtime evidence；
- [ ] evidence claim strength 有等级；
- [ ] causal evidence 有最低标准；
- [ ] retry/recovery 不制造重复意义；
- [ ] trust boundary 清晰；
- [ ] installed/live capability 可验证；
- [ ] Golden Journeys 可重复；
- [ ] governance 不绑定当前 stage 名；
- [ ] Owner cognitive load 可控；
- [ ] governance 不阻碍合理架构演化。

---

# 37. Final Principle

PD 的长期核心不是：

```text
让每个模块都正确
```

而是：

> **让一次由真实 Pain 产生的行为干预，在正确的授权下，以正确的内容版本进入真实运行时，并用与证据强度相匹配的方式证明它真的改变了 Agent 的行为，而且可以可靠撤销。**

因此长期保护模型是：

```text
Evidence
×
Decision
×
Authority
×
Behavior Change
```

Pipeline 是地图。

Intervention Lifecycle 是治理对象。

Causal Evidence 是价值证明。

Owner Authority 是最终边界。

最后仍然遵循：

> **先看清，再动手。  
> 先证明真实行为改变，再固化治理。**
