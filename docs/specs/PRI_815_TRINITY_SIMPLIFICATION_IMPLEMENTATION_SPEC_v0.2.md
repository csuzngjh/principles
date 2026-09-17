# PRI-815 Trinity Simplification — Implementation SPEC v0.2
## PrincipleFormation：以“更高质量 + 不降稳定性 + 更低协调复杂度”为生产切换门

> **Status**: Optimized Draft for Owner Review  
> **Version**: v0.2  
> **Date**: 2026-09-17  
> **Issue**: PRI-815  
> **Architecture verdict**: `SIMPLIFY_PARTIALLY`  
> **Dependency**: Pipeline Safety Net v1.2 merge + implementation-state compatibility PASS  
> **Evidence basis**: PRI-815 read-only spike、生产 state.db、消费者/治理边界审计、离线 A/B、Safety Net v1.2 直接兼容性复核  
> **Owner value gate**: **“只是更稳定”不够；生产切换必须证明输出质量有实质提升，同时稳定性不下降、复杂度真实下降。**

---

# 0. Executive Decision

当前：

```text
Dreamer
  task / run / lease / retry / recovery / artifact
    ↓
Philosopher
  task / run / lease / retry / recovery / artifact
    ↓
Scribe
  task / run / lease / retry / recovery / artifact
    ↓
canonical Principle + intentContract
```

目标：

```text
PrincipleFormation
  ├─ propose        ← Dreamer cognition
  ├─ critique       ← Philosopher cognition
  └─ formalize      ← Scribe cognition
       ↓
one durable lifecycle
one canonical governance artifact
```

本次不是删除认知能力，而是：

```text
认知步骤：3 → 3
durable lifecycle：3 → 1
governance boundary：3 → 1
跨阶段 identity handoff：显著减少
```

正式生产切换必须同时满足：

```text
QUALITY_SUPERIORITY = PASS
STABILITY_NON_INFERIORITY = PASS
DOWNSTREAM_UTILITY = PASS
COMPLEXITY_REDUCTION = PASS
SAFETY_NET = PASS
```

如果只是：

```text
QUALITY = EQUAL
STABILITY = IMPROVED
COMPLEXITY = REDUCED
```

结论只能是：

```text
HOLD
```

不能进入生产 cutover。

---

# 1. What Is Already Decided

以下不再重复调查：

1. Dreamer / Philosopher / Scribe 三种认知职责都有真实价值；
2. Philosopher 作为独立 durable lifecycle 没有独立生产消费者或独立治理边界；
3. Dreamer 有真实下游消费者，但消费者需要的是 proposal evidence，不需要 Dreamer 独立 task / lease / recovery authority；
4. Scribe 当前承载 canonical Principle + intentContract，是真正治理边界；
5. 当前三阶段 durable handoff 存在真实协调成本与信息丢失；
6. Safety Net v1.2 明确允许 Trinity 内部阶段数量、固定边和 runner fixture 改变，只保护 Owner 可观察价值契约。

因此本 SPEC 不再回答：

> “要不要精简？”

而回答：

> “如何证明目标形态真的更好，然后以最小风险实施？”

---

# 2. Two Hypotheses Must Be Separated

本次有两个不同假设，不能混成一个结论。

## H1 — Structural Hypothesis

把三个 durable lifecycle 收敛为一个，可以减少：

```text
task/run 放大
lease/retry/recovery 协调
跨 artifact identity handoff
lineage drift
阶段级 adapter 注入点
状态推进崩溃窗口
```

且不破坏：

```text
provenance
Owner authority
RuleCode governance
runtime effect
revocation
```

H1 由：

```text
代码结构
生产状态
Safety Net
复杂度计数
```

验证。

---

## H2 — Quality Hypothesis

目标 PrincipleFormation 不只是把旧流程塞进一个 runner。

它应消除当前最重要的信息损失：

```text
formalize 只看到 critique
看不到原始 proposal candidates / source evidence
```

目标 formalize 应能看到：

```text
source diagnosis
source evidence
all proposals
critique / scope / risks
core grounding
provenance
```

因此最终 Principle 应：

```text
更忠实于原始 Pain
更具体
边界更完整
更少退化成“大而正确”的泛格言
更适合下游 RuleCode 生成与验证
```

H2 必须通过预注册、盲化、同输入 A/B 实验验证。

---

# 3. Important Correction: A/B Does Not Test “Durable Topology” Directly

输出质量实验不能把：

```text
durable task 数量
```

本身当作模型质量变量。

如果两个认知流程收到完全相同的信息和 prompt：

```text
是否持久化成 3 个 task
```

理论上不应直接改变文本质量。

因此本 A/B 的语义变量是：

```text
A：当前 lossy handoff cognitive contract
B：目标 shared-context cognitive contract
```

结构变量 H1 单独验证。

这样避免错误结论：

> “B 输出更好，所以一个 task 比三个 task 更聪明。”

正确结论应是：

> “单 lifecycle 让我们可以用更直接、低损耗的 shared formation context；质量提升来自更好的信息流，而复杂度下降来自 durable boundary 收敛。”

---

# 4. Target Cognitive Contract

```text
Diagnosis / source evidence
        │
        ▼
PrincipleFormation
        │
        ├─ propose
        │    output:
        │    - 1..5 candidates
        │    - badDecision / betterDecision
        │    - rationale
        │    - strategicPerspective
        │    - confidence
        │    - riskLevel
        │
        ├─ critique
        │    input:
        │    - source evidence
        │    - all proposals
        │    output:
        │    - synthesis
        │    - scope
        │    - risks
        │    - conflicts
        │    - preserved dissent / alternatives
        │
        └─ formalize
             input:
             - source diagnosis / evidence
             - all proposals
             - critique
             - core grounding
             - provenance

             output:
             - principleDraft
             - applicability
             - antiPatterns
             - risks
             - intentContract
        │
        ▼
Canonical Principle
```

仍保留三次认知职责。

第一轮 implementation 不以减少 LLM call 为目标。

---

# 5. Formalize Must Receive Full Formation Context

v0.2 的关键 hard contract：

```text
formalizeInput = {
  sourceDiagnosis,
  sourceEvidence,
  proposals[],
  critique,
  coreGrounding,
  provenance
}
```

禁止退化为：

```text
formalizeInput = critique only
```

否则：

```text
H2 无法成立
```

这也是 A/B 中 Arm B 与当前 Arm A 的主要语义差异。

---

# 6. One Durable Lifecycle

生产目标：

```text
task_kind = principle_formation
```

一个 task/run lifecycle 承载：

```text
load source
→ propose
→ validate proposal
→ critique
→ validate critique
→ formalize
→ validate canonical Principle
→ persist canonical Principle
→ advance
```

禁止：

```text
propose → 创建 durable successor task
critique → 创建 durable successor task
```

propose / critique 是 cognitive step，不是 governance state。

---

# 7. Governance Boundary

唯一允许：

```text
Owner review
approval
activation
revision governance
```

绑定的 formation 产物是：

```text
canonical Principle artifact
```

禁止：

```text
proposal checkpoint
critique output
intermediate formation state
```

成为：

```text
approval object
activation identity
promotion authority
canonical Principle bearer
```

---

# 8. Proposal Evidence Persistence — Deliberately Deferred

v0.1 倾向把 proposals 直接塞进 canonical Principle 的 `formationEvidence`。

复核后，本 SPEC **不再预先锁定这个方案**。

原因：

1. proposal evidence 是非治理证据；
2. canonical Principle 是治理对象；
3. 把两者强绑定可能扩大 approval/content-authorization 的语义范围；
4. PRI-814 正在处理 artifact identity / revision / overwrite 语义；
5. 当前不能为了 Trinity 提前发明第二套 artifact identity。

因此实施前必须 Reality Check 两个选项：

## Option A — Canonical artifact 内的 non-authoritative evidence envelope

仅在以下条件满足时采用：

```text
不会改变 Owner approval 的治理语义
不会导致 evidence-only 变化错误地继承/失效 authority
现有 C5 content authorization 能明确解释
```

## Option B — Existing store 中的 non-governance formation checkpoint

仅在以下条件满足时采用：

```text
复用现有 store
不可 approval
不可 activation
不可 promotion
immutable / identity 可解释
无独立 task
无独立 retry/recovery
无第二 writer
```

禁止：

```text
新建专用 DB table
新建 checkpoint subsystem
新建第二 artifact authority
```

在 PRI-814 语义未明确前，不允许“为了方便”直接选择某一种。

---

# 9. Experiment First, Production Later

顺序必须是：

```text
Safety Net merged
→ A/B protocol freeze
→ offline / non-authoritative experiment
→ Owner decision
→ production implementation
```

不能：

```text
先重构 production
→ 再看看质量有没有变好
```

---

# 10. Pre-registration

为了避免边看结果边改规则，实验开始前必须冻结：

```text
sample IDs
Arm A prompt/version hashes
Arm B prompt/version hashes
model + endpoint family
temperature
maxTokens
core grounding version
judge rubric
primary endpoint
stability endpoint
acceptance thresholds
```

实验开始后：

```text
不得因为结果不好临时改 B prompt
不得换 judge rubric
不得删困难样本
```

如果 B 需要调优：

```text
使用 development set
→ 冻结新版本
→ 对 holdout set 从头跑
```

---

# 11. Development Set vs Holdout Set

调查显示可用的 unique historical Dreamer 来源有限，因此不应把全部样本同时用于调 prompt 和评估。

建议：

```text
Development set: 8 个 unique inputs
Holdout evaluation set: 24 个 unique inputs
Total: 32
```

如果 Reality Check 发现可用独立输入 >32：

优先扩 holdout 到：

```text
32–40
```

绝不通过：

```text
把同一 Pain 的多个 retry/revision 当成多个独立样本
```

虚增 n。

---

# 12. Sampling Stratification

Holdout 至少覆盖：

```text
明确单一纠正
模糊多义 Pain
多候选冲突
core-axiom conflict
Prompt-only Principle
RuleCode downstream
历史 revision / repair
高/中风险
中英文
```

每个样本记录：

```text
sample_id
source Pain / diagnosis id
channel
risk
language
historical outcome class
```

---

# 13. Arms

## Arm A — Current Cognitive Contract

```text
Diagnosis
→ Dreamer
→ Philosopher
→ Scribe
```

关键是严格复现当前信息可见性：

```text
Scribe 只收到当前 production contract 实际给它的信息
```

不能偷偷把 Dreamer proposals 补给 A。

---

## Arm B — Target Shared-context Contract

```text
Diagnosis
→ propose
→ critique
→ formalize(full shared context)
```

认知职责和调用数保持与 A 尽量一致。

formalize 明确收到：

```text
source evidence
all proposals
critique
```

---

# 14. Optional Diagnostic Arm C — Attribution Only

如果预算允许，可加入：

```text
C = 当前 propose→critique→formalize 三步
    但 formalize 获得 full shared context
    不讨论 durable topology
```

用途：

```text
判断质量增益主要来自“信息恢复”还是其它 prompt 差异
```

C 仅用于因果解释。

正式生产接受仍看：

```text
A vs target B
```

若预算有限，C 可以不做。

---

# 15. Same-input Requirement

A/B 同一个 sample 必须共享：

```text
source Pain
diagnosis
source evidence
Core Principles
model version
temperature
maxTokens
language
```

不能：

```text
A = 历史生产输出
B = 今天新模型输出
```

作为主比较。

两臂必须在同一实验窗口重新生成。

---

# 16. Repeats and the Statistical Unit

为了测稳定性：

```text
每个 holdout input
A × 3 repeats
B × 3 repeats
```

24 个 holdout 时：

```text
24 × 2 × 3 = 144 final formations
```

但：

> **144 不是 144 个独立样本。**

正式质量统计单元是：

```text
24 个独立 input
```

每个 input 内的 repeats：

```text
用于稳定性
用于形成 input-level majority preference
```

禁止把同一 input 的三次 repeat 当作三个独立样本来制造显著性。

---

# 17. Randomization

每个 input/repeat：

```text
A/B 输出随机标记为 X/Y
```

judge 不得看到：

```text
Arm A
Arm B
current
simplified
PrincipleFormation
Trinity
```

建议 20% 样本做一次：

```text
X/Y order reversal
```

检查明显 position bias。

---

# 18. Evaluation Stack

采用四层证据。

## Layer 1 — Deterministic Contract

Hard gate：

```text
schema validity
validator pass
intentContract required fields
provenance validity
required semantic fields
core grounding reference validity
```

---

## Layer 2 — Downstream Utility

对 final Principle 运行同一 production-equivalent downstream contract。

至少观察：

```text
Artificer generation success
Evaluator parse success
Evaluator approval / requiredChanges
repair / revise need
deterministic replay
adversarial replay
```

若真实 downstream LLM 成本过高：

```text
全量做 deterministic validators
分层抽样做真实 Artificer/Evaluator
```

抽样规则必须预注册。

---

## Layer 3 — Blind Pairwise Judge

主 judge 要求：

```text
尽量与 generator 不同模型家族
```

避免：

```text
glm-5.3 生成
→ glm-5.3 自评
```

这种同族偏差成为唯一证据。

GPT6 不必跑全部样本。

推荐：

```text
主 judge：独立强模型
GPT6：只 adjudicate
  - 主 judge 不确定
  - A/B judge 分歧
  - 高风险样本
  - 12–16 个代表性 pair
```

这样既降低额度消耗，又保留高质量外部校准。

---

## Layer 4 — Owner Calibration

Owner 不需要逐条评分。

抽：

```text
8 个随机 holdout
+
最多 4 个 judge disagreement / high-risk pair
```

Owner只回答：

```text
X 更像我希望 Agent 学会的
Y 更像
无实质差异
两者都不好
```

用途：

```text
校准 automated judge 是否真正贴近 Owner value
```

---

# 19. Blind Judge Rubric

每组只评价 final governed behavior contract，不评价架构。

维度：

```text
1. Intent fidelity
2. Evidence grounding
3. Specificity
4. Generalization without overreach
5. Boundary clarity
6. Actionability
7. Contradiction avoidance
8. Anti-pattern quality
9. Risk completeness
10. Unnecessary abstraction / padding
```

judge 指令禁止：

```text
偏好更长
偏好更短
偏好更多条目
偏好所谓“新架构”
```

---

# 20. Primary Quality Endpoint

正式 primary endpoint：

```text
input-level blind pairwise preference
```

对每个 holdout input：

```text
3 repeats
→ 3 个 blind pair comparisons
→ 聚合为该 input 的：
   B_WIN / A_WIN / TIE
```

最终：

```text
B input-level win rate
```

而不是 run-level win rate。

---

# 21. Quality Superiority Gate

质量优越必须同时满足：

## QG-1 Point estimate

```text
B input-level win rate >= 60%
```

## QG-2 Confidence

对排除 tie 后的 B/A 胜负做：

```text
Wilson 95% confidence interval
```

要求：

```text
lower bound > 50%
```

避免：

```text
24 个样本里偶然 14:10
→ 就宣称新架构更好
```

## QG-3 Critical dimensions

以下不能出现系统性回退：

```text
intent fidelity
evidence grounding
boundary clarity
```

## QG-4 Owner calibration

Owner spot-check 中：

```text
B 不得明显输给 A
```

若 automated judge 强烈偏 B、Owner 明显偏 A：

```text
STOP
```

先查 rubric/model bias。

---

# 22. Downstream Utility Gate

“文本更漂亮”不够。

至少满足：

```text
RuleCode generation compatibility = non-regressed
Evaluator hard failures = non-increased
requiredChanges / repair burden = non-increased
```

并要求至少一个下游指标出现实质改善，优先级：

```text
1. deterministic/adversarial replay pass
2. requiredChanges 降低
3. repair/revise rate 降低
4. evaluator approval 提升
```

如果 blind judge 说 B 更好，但 downstream 明显更差：

```text
QUALITY_SUPERIORITY = FAIL
```

---

# 23. Stability Endpoint

稳定性不是“文本相似度”。

真正关心：

```text
同一 input 多次生成
是否仍表达同一个行为意图
```

每个 input 的 3 repeats 对比：

```text
intentContract.targetBehavior
forbiddenBehavior
applicability
antiPatterns
risk posture
```

分类：

```text
STABLE
MATERIAL_DRIFT
CONTRADICTION
```

允许：

```text
措辞不同
顺序不同
例子不同
```

不允许：

```text
关键禁止行为消失
行为方向反转
适用边界互相矛盾
一次要求 A、另一次允许 A
```

---

# 24. Stability Non-inferiority Gate

至少满足：

```text
B contradiction count <= A contradiction count
B material drift rate <= A + 5 percentage points
B schema/validator failure <= A
B truncation rate <= A
```

任何：

```text
P0/P1 semantic contradiction
```

直接 FAIL。

---

# 25. Token / Cost Guard

质量提升不能主要靠：

```text
把 prompt 和输出无限加长
```

记录：

```text
input tokens
output tokens
total tokens
wall time
```

默认要求：

```text
B total inference tokens <= A + 20%
```

如果超过：

```text
必须由 Owner 明确接受“质量收益值得成本”
```

不能自动 PASS。

---

# 26. Experiment Result Classes

只允许：

```text
ACCEPT_EXPERIMENT
HOLD
REJECT
INCONCLUSIVE
```

## ACCEPT_EXPERIMENT

```text
quality superiority PASS
stability non-inferiority PASS
downstream utility PASS
cost acceptable
```

这只表示：

```text
允许进入 production implementation
```

不是 production rollout 已批准。

## HOLD

例如：

```text
质量持平
稳定性更好
复杂度预期更低
```

正是 Owner 指定的：

> 稳定而不更好，不够。

## REJECT

```text
质量回退
或稳定性回退
或 downstream 回退
```

## INCONCLUSIVE

```text
样本不足
judge 严重冲突
数据污染
模型/配置不一致
```

---

# 27. Complexity Is a Separate Post-implementation Gate

A/B 通过后才写 production implementation。

因此：

```text
complexity reduction
```

不能在实验阶段假装已经发生。

production PR 完成后再机械核验：

```text
formation durable task kinds: 3 → 1
formation durable lifecycle: 3 → 1
stage-specific runner lifecycle: 3 → 1
cross-stage named identity handoffs: 显著减少
task/run rows per formation: 显著减少
recovery decision points: 3 → 1
adapter slots: 3 → 1
```

如果只是：

```text
新建 PrincipleFormation wrapper
里面继续创建 Dreamer/Philosopher/Scribe 三个 task
```

则：

```text
COMPLEXITY_REDUCTION = FAIL
```

---

# 28. Safety Net Gate

production implementation 必须：

```text
npm run check:pipeline-contract
npm run verify:merge
```

PASS。

不得为了 Trinity：

```text
删 Safety Net invariant
弱化 authorization negative
弱化 revoke precision
把 provenance assertion 改成更松
```

允许修改：

```text
test setup
runner fixture
routing fixture
历史兼容 fixture
```

只要 Owner 可观察行为断言不弱化。

---

# 29. Tests That Are Explicitly Setup, Not Long-term Contract

以下 current assertions 必须在 Trinity 实施时调整，而不是阻挡架构：

```text
EXPECTED_CHAIN = dreamer→philosopher→scribe
ALLOWED_EDGES.length === fixed value
dreamer successor === philosopher
three tasks must be generated
totalDreamerTasks / totalPhilosopherTasks 作为结构真相
```

这些属于：

```text
implementation snapshot
```

不是：

```text
Owner-governed invariant
```

---

# 30. PrincipleFormation Runner

只有实验 ACCEPT 后实现。

目标：

```text
PrincipleFormationRunner
```

流程：

```text
loadSource()
propose()
validateProposal()
critique()
validateCritique()
formalize()
validateCanonical()
persistCanonical()
commitNext()
```

整个 formation 只拥有一个 durable task/run lifecycle。

---

# 31. Internal Step Contracts

优先复用现有 schema/validator 逻辑，改成内部 type：

```text
FormationProposal
FormationCritique
CanonicalPrinciple
```

原则：

```text
reuse > rename > adapt > new
```

不要把：

```text
DreamerOutput
PhilosopherOutput
ScribeOutput
```

整套重写，只因为改了 lifecycle。

---

# 32. Canonical Principle Contract

尽量维持下游接口：

```text
principleDraft
intentContract
risks
source provenance
```

Owner Review / Prompt Activation / Artificer / Evaluator / Rollout 不应该需要知道：

```text
内部有几个 cognitive step
```

---

# 33. Provenance Target

新 flow 长期只需要：

```text
Pain / diagnosis
→ PrincipleFormation
→ canonical Principle
→ Rule
```

不再制造新的：

```text
sourceDreamerArtifactId
sourcePhilosopherArtifactId
sourceTrace.dreamerArtifactId
sourceTrace.philosopherArtifactId
```

历史旧字段：

```text
read-only compatibility
```

---

# 34. Migration Rule

默认：

```text
old tasks/artifacts = immutable historical truth
new inputs = PrincipleFormation
```

禁止：

```text
改写历史 task_kind
改写历史 artifact ID
伪造 lineage
历史回填成“新结构”
```

---

# 35. No Long-lived Dual Pipeline

迁移期可以存在：

```text
旧 task_kind → 旧 runner（仅完成旧任务）
新 task_kind → PrincipleFormationRunner
```

但同一个新 input：

```text
只能选择一条 authoritative path
```

禁止：

```text
双写 canonical Principle
双 approval
双 activation
两条 flow 同时拥有 governance authority
```

---

# 36. Rollback Seam

不新增长期 feature flag。

允许一个**短期、迁移专用 routing seam**，前提：

```text
只决定“新 input 创建哪种 task”
不双写
不双跑
不产生第二 authority
有明确删除日期/退出条件
```

rollback 时：

```text
停止创建新的 principle_formation
新输入回旧 flow
已经存在的 principle_formation task 由新 runner 完成/安全终止
```

不能通过代码回退让已有新 task 变成无人可执行状态。

迁移稳定后删除该 seam。

---

# 37. In-flight Cutover

正式 cutover 前：

```text
盘点 old Dreamer/Philosopher/Scribe pending/retry_wait
```

优先：

```text
drain
```

无法 drain：

```text
明确列出并让旧 runner 完成
```

禁止：

```text
同一 lineage 中途切 topology
```

---

# 38. Historical Read Compatibility

Console / audit / read models：

```text
历史 D/P/S
→ 继续可读
```

新：

```text
PrincipleFormation
→ 新口径
```

兼容是：

```text
read compatibility
```

不是：

```text
write compatibility
```

---

# 39. Progressive Disclosure P1

已知独立 P1：

```text
artifact_summary_redundancy OFF
context_manifest_budget ON
progressive_evaluator ON
→ summary/predecessorSummary 生产 100% absent
```

Trinity 新 flow 可以不再依赖这条 broken handoff。

但不得：

```text
把该 P1 标记成“Trinity 已修”
```

它仍应独立登记/处置，因为其它旧 flow / consumer 可能仍依赖它。

---

# 40. Phased Delivery

## Phase 0 — Safety Net

```text
#1742 修复
→ merge
→ implementation-state compatibility check
```

要求确认：

```text
Safety Net 没冻结 D/P/S 数量
没冻结 fixed edge count
没把 intermediate checkpoint 当 governance artifact
```

---

## Phase 1 — Experiment Protocol

只建立：

```text
sample manifest
prompt/version hashes
A/B harness
repeat runner
validator exporter
blind judge package
metrics report
```

不改 production。

---

## Phase 2 — Development-set Tuning

只用 8 个 dev samples。

允许：

```text
调 B prompt/context
修 schema mapping
修 obvious contract bug
```

完成后 freeze B。

---

## Phase 3 — Holdout A/B

对 24+ holdout inputs：

```text
A × 3
B × 3
```

生成、验证、盲评。

不再调 prompt。

---

## Phase 4 — Owner Decision

输出：

```text
QUALITY_SUPERIORITY
STABILITY_NON_INFERIORITY
DOWNSTREAM_UTILITY
COST
```

Owner：

```text
ACCEPT_EXPERIMENT
HOLD
REJECT
```

---

## Phase 5 — Production Implementation

只有：

```text
ACCEPT_EXPERIMENT
```

才能开始。

---

## Phase 6 — Mechanical Verification

实现后验证：

```text
COMPLEXITY_REDUCTION
SAFETY_NET
historical read compatibility
migration behavior
```

---

## Phase 7 — Short Soak

新 formation 在真实开发环境短期运行。

只观察：

```text
formation failure
retry
output invalid
downstream repair
unexpected governance behavior
```

不要求再重跑完整 EP002。

---

## Phase 8 — Remove Old Reachability

满足退出条件后：

```text
停止创建 old Dreamer/Philosopher/Scribe tasks
删除新输入到旧 flow 的 routing
保留历史读取
逐步删除死生产入口
```

禁止永久并存。

---

# 41. Production Acceptance Matrix

```text
Experiment quality superiority PASS
+
Experiment stability non-inferiority PASS
+
Downstream utility PASS
+
Implementation complexity reduction PASS
+
Safety Net PASS
+
Migration/read compatibility PASS
+
Short soak no critical regression
=
PRODUCTION CUTOVER ACCEPT
```

---

# 42. Stop Conditions

任一发生即 STOP：

1. holdout 上 B 质量没有明确优于 A；
2. B 只是更稳定但质量持平；
3. B 平均更好但 semantic contradiction 增加；
4. Owner spot-check 与 automated judge 明显反向；
5. downstream RuleCode / Evaluator 明显回退；
6. B 质量优势主要来自 >20% token 暴涨且 Owner 不接受；
7. checkpoint 需要第二 durable store / second authority；
8. 必须削弱 Safety Net 才能实现；
9. 必须长期双 pipeline；
10. implementation 只是 wrapper，实际 durable boundary 没减少；
11. current provenance / authorization 无法在新 flow 清楚表达。

---

# 43. Experiment Report Template

```text
PRI_815_PRINCIPLE_FORMATION_AB

BASE_SHA =
SAFETY_NET_SHA =

GENERATOR =
GENERATOR_CONFIG_HASH =

A_PROMPT_HASHES =
B_PROMPT_HASHES =
CORE_GROUNDING_HASH =

DEV_SAMPLE_COUNT =
HOLDOUT_SAMPLE_COUNT =
REPEATS_PER_ARM =

PRIMARY_UNIT =
independent input

A =
current lossy D→P→S cognitive contract

B =
propose→critique→formalize(full shared formation context)

DETERMINISTIC_CONTRACT
A =
B =

INPUT_LEVEL_PAIRWISE
B_WIN =
A_WIN =
TIE =
B_WIN_RATE =
WILSON_95_CI =

CRITICAL_DIMENSIONS
INTENT_FIDELITY =
EVIDENCE_GROUNDING =
BOUNDARY_CLARITY =

STABILITY
A_MATERIAL_DRIFT =
B_MATERIAL_DRIFT =
A_CONTRADICTIONS =
B_CONTRADICTIONS =
A_VALIDATOR_FAIL =
B_VALIDATOR_FAIL =

DOWNSTREAM
A_RULE_GENERATION =
B_RULE_GENERATION =
A_EVALUATOR_APPROVAL =
B_EVALUATOR_APPROVAL =
A_REQUIRED_CHANGES =
B_REQUIRED_CHANGES =
A_REPAIR_RATE =
B_REPAIR_RATE =
A_REPLAY_PASS =
B_REPLAY_PASS =

COST
A_TOKENS =
B_TOKENS =
DELTA =
A_WALL_TIME =
B_WALL_TIME =

OWNER_CALIBRATION
B_WIN =
A_WIN =
TIE =
BOTH_BAD =

QUALITY_SUPERIORITY =
PASS / FAIL / INCONCLUSIVE

STABILITY_NON_INFERIORITY =
PASS / FAIL

DOWNSTREAM_UTILITY =
PASS / FAIL

COST_ACCEPTABLE =
PASS / OWNER_DECISION_REQUIRED

EXPERIMENT_VERDICT =
ACCEPT_EXPERIMENT / HOLD / REJECT / INCONCLUSIVE
```

---

# 44. Implementation Report Template

```text
PRI_815_PRINCIPLE_FORMATION_IMPLEMENTATION

BASE_SHA =
HEAD_SHA =
PR =

FORMATION_DURABLE_TASK_KINDS_BEFORE = 3
FORMATION_DURABLE_TASK_KINDS_AFTER =

FORMATION_DURABLE_LIFECYCLE_BEFORE = 3
FORMATION_DURABLE_LIFECYCLE_AFTER =

CANONICAL_GOVERNANCE_ARTIFACTS_BEFORE =
CANONICAL_GOVERNANCE_ARTIFACTS_AFTER =

NAMED_CROSS_STAGE_IDENTITY_FIELDS_BEFORE =
NAMED_CROSS_STAGE_IDENTITY_FIELDS_AFTER =

TASK_RUN_ROWS_PER_FORMATION_BEFORE =
TASK_RUN_ROWS_PER_FORMATION_AFTER =

RECOVERY_DECISION_POINTS_BEFORE =
RECOVERY_DECISION_POINTS_AFTER =

SECOND_WRITER = NO
NEW_DURABLE_STORE = NO
LONG_LIVED_DUAL_PIPELINE = NO

HISTORICAL_READ_COMPATIBILITY =
PASS / FAIL

CHECK_PIPELINE_CONTRACT =
PASS / FAIL

VERIFY_MERGE =
PASS / FAIL

SHORT_SOAK =
PASS / FAIL

COMPLEXITY_REDUCTION =
PASS / FAIL

FINAL =
PRODUCTION_CUTOVER_ACCEPT /
DO_NOT_CUTOVER
```

---

# 45. Non-goals

本 SPEC 不做：

```text
删除 critique cognition
把 3 次 LLM call 强行压成 1 次
重构 Evaluator
重构 Owner Approval
Artifact Store 全面重构
PRI-814 全量修复
Diagnostician rootcause/distiller/router 同构收敛
新 observability platform
新 memory subsystem
```

这些若有价值，单独立项。

---

# 46. Final Decision Principle

本次 Trinity Simplification 的成功定义不是：

> “少了两个 runner，所以架构更漂亮。”

也不是：

> “更稳定，所以就值得迁移。”

成功必须是：

> **在不削弱 Owner governance 和 runtime contract 的前提下，通过更低损耗的 formation information flow，得到显著更好的 Principle；同时把没有产品治理价值的 durable boundary 删除。**

因此最终门槛是：

```text
更好的输出
+
不更差的稳定性
+
更低的协调复杂度
+
不削弱 Safety Net
```

缺一不可。
