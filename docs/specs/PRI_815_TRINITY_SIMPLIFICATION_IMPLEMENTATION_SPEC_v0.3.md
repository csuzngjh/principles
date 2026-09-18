# PRI-815 Trinity Simplification — Implementation SPEC v0.3
## Quality First → Architecture Second

> **Status**: Optimized Draft for Owner Review  
> **Version**: v0.3  
> **Date**: 2026-09-17  
> **Issue**: PRI-815  
> **Architecture direction**: `SIMPLIFY_PARTIALLY` retained as a candidate target, not yet approved for implementation  
> **Primary principle**: **先证明信息流修复能显著提升 Principle 质量，再决定是否收敛 durable execution lifecycle。**  
> **Production cutover principle**: **最终系统必须同时满足：输出质量更高、稳定性不下降、下游行为不回退、协调复杂度下降、Safety Net 全绿。**

---

# 0. Executive Decision

本 SPEC 将原来的“一次性 PrincipleFormation 重构”拆成两个独立阶段：

```text
Phase A — Quality First
当前 topology 保持不变
只修复 formation 信息流
验证：
  输出质量是否显著提升
  稳定性是否不下降
  下游行为是否更好

        ↓ 仅在 PASS 后

Phase B — Architecture Second
冻结已经验证过的认知契约
把：
  Dreamer durable lifecycle
  Philosopher durable lifecycle
  Scribe durable lifecycle
收敛为：
  one PrincipleFormation durable execution lifecycle

验证：
  相对 Phase A 质量不回退
  runtime reliability 可接受
  revision / rollback 闭合
  净复杂度真实下降
  Safety Net PASS
```

最终系统与最初 baseline 比较，必须：

```text
QUALITY = IMPROVED
STABILITY = NON_REGRESSED
DOWNSTREAM BEHAVIOR = NON_REGRESSED OR IMPROVED
DURABLE EXECUTION COMPLEXITY = REDUCED
SAFETY_NET = PASS
```

如果只是：

```text
QUALITY = EQUAL
STABILITY = IMPROVED
COMPLEXITY = REDUCED
```

仍然：

```text
HOLD
```

不进入生产 cutover。

---

# 1. What Is Already Supported by Evidence

现有 Spike 已经支持以下结论：

1. Dreamer / Philosopher / Scribe 三种认知职责都有真实价值；
2. Philosopher 作为独立 durable lifecycle，没有独立生产治理边界；
3. Dreamer 有真实下游消费者，但它们需要 proposal evidence，不需要独立 task / lease / retry / recovery authority；
4. Scribe 承载 canonical Principle + intentContract，是当前真正的 formation governance bearer；
5. 当前 D→P→S 的跨阶段 handoff 存在结构性信息损失；
6. 当前多 durable lifecycle 已制造 lineage / retry / recovery / identity 协调成本；
7. Safety Net v1.2 的长期保护对象是 Owner 可观察价值契约，不是 Dreamer / Philosopher / Scribe 固定数量与固定拓扑。

因此本 SPEC 不再把：

```text
“是否应该调查 Trinity”
```

作为问题。

现在的问题是：

```text
A. 信息流修复是否真的让 Principle 变得更好？
B. 如果变得更好，是否还值得进一步收敛 lifecycle？
C. lifecycle 收敛能否在不损失质量的前提下净减少复杂度？
```

---

# 2. Correct Complexity Baseline

必须纠正旧表述：

错误：

```text
canonical governance boundary: 3 → 1
```

正确：

```text
durable execution lifecycle: 3 → 1
canonical governance boundary: 1 → 1
```

因为当前真正进入：

```text
Owner review
approval
activation
runtime
```

的 formation bearer 本来就集中在 canonical Principle。

本次想删除的是：

```text
多余的 durable execution / coordination boundary
```

而不是三份真实 governance authority。

---

# 3. Separate the Two Hypotheses

## H1 — Information-Flow / Quality Hypothesis

当前：

```text
Dreamer:
  1..5 proposals

        ↓

Philosopher:
  synthesis / scope / risks

        ↓

Scribe:
  主要看到 Philosopher 输出
  无法可靠获得完整 source evidence + all proposals
```

目标最小修复：

```text
Scribe / formalize 同时获得：

source diagnosis
source evidence
all Dreamer proposals
existing Philosopher critique
core grounding
provenance
```

假设：

> 恢复这部分信息后，canonical Principle 会更忠实、更具体、边界更完整，并提升实际干预质量。

H1 可以在**不改变 durable topology**的情况下验证。

---

## H2 — Lifecycle Simplification Hypothesis

如果 H1 已经成立，则冻结已经验证过的认知契约：

```text
propose
→ critique
→ formalize(full context)
```

再把：

```text
3 durable execution lifecycle
```

收敛为：

```text
1 PrincipleFormation durable execution lifecycle
```

假设：

> 可以降低协调复杂度，同时保持 Phase A 已验证的输出质量和产品行为。

H2 不再被要求“再次提升文本质量”。

H2 的标准是：

```text
QUALITY = NON_REGRESSED vs Phase A
STABILITY = NON_REGRESSED
RUNTIME RELIABILITY = PASS
COMPLEXITY = REDUCED
SAFETY_NET = PASS
```

---

# 4. Why Quality First

如果直接做：

```text
shared context + lifecycle collapse
```

然后 B 变好了，我们无法知道：

```text
是信息恢复带来的
还是 prompt 重写带来的
还是其它上下文变化带来的
还是 topology 变化带来的
```

其中最后一项其实本来就不应该直接提升模型智力。

因此先做最小信息修复，可以回答一个更干净的问题：

> **当前被丢掉的 formation evidence，是否真的值得恢复？**

如果答案是 NO：

```text
停止 Trinity collapse
```

因为精简架构虽然工程上可能更美，但不值得为核心学习链承担迁移风险。

---

# 5. Phase A — Minimal Information-Flow Experiment

Phase A 不修改 production topology。

目标实验：

## Arm A — Current

```text
Diagnosis
→ Dreamer
→ Philosopher
→ Scribe(current visibility)
```

Scribe 必须严格复现 current production contract。

禁止给 A 偷偷补：

```text
all proposals
source evidence
```

---

## Arm B — Minimal Information Repair

仍然：

```text
Diagnosis
→ Dreamer
→ Philosopher
→ Scribe
```

只改变：

```text
Scribe input
```

使其额外获得：

```text
source diagnosis
source evidence
all Dreamer proposals
existing Philosopher critique
provenance
```

禁止同时：

```text
重写 Dreamer strategy
重写 Philosopher strategy
删除 Philosopher
改成 one-shot prompt
改 durable topology
```

B 的目标是：

> 只验证“恢复丢失信息”这一个最有证据支持的质量干预。

---

# 6. Candidate Priority Rule

完整 proposals 重新暴露给 formalize 后，必须防止：

```text
被 critique 否定的候选
因为又出现在上下文中
被错误复活
```

因此 B 的 formalize contract 必须明确：

```text
source intent > critique conclusions > proposals as evidence
```

其中：

```text
proposals = candidate evidence
critique = evaluated synthesis
canonical intent = final authority
```

formalize 不得：

```text
无条件拼接所有 proposals
把 mutually exclusive proposals 全部塞进 Principle
让 proposal 覆盖 critique 已确认的风险/冲突
```

---

# 7. Experiment Sample Independence

这是正式实验的第一前提。

现有 Spike 的不同 Dreamer artifact **不等于不同独立样本**。

独立单位必须按：

```text
original Pain / source event lineage
```

分组。

同一来源的：

```text
retry
revision
不同 Dreamer artifact
语言改写
人工同义改写
合成变体
```

均属于：

```text
same source group
```

不能增加独立 n。

---

# 8. Sample Manifest

实验前必须冻结：

```text
sample_manifest.json / md
```

至少包含：

```text
source_group_id
pain_id
diagnosis_id
channel
risk
language
historical status
whether_seen_in_previous_spike
dev_or_holdout
```

并遵守：

```text
同源组不能跨 dev / holdout
```

---

# 9. Existing Samples Are Development / Regression Evidence

已经在 PRI-815 Spike 中：

```text
人工审读
用于理解失败模式
用于旧 A/B
用于 prompt 调整
```

的样本，原则上归入：

```text
development / regression set
```

不能再把它们包装成新的 confirmatory holdout。

---

# 10. Confirmatory Holdout Can Only Be Opened Once

dev 用于：

```text
B prompt 调整
schema mapping
rubric 校准
judge 校准
failure handling
```

confirmatory holdout：

```text
只打开一次
```

如果看过 holdout 结果后又修改 B：

```text
原 holdout 自动降级为 regression set
下一轮确认必须使用新的独立 source groups
```

不能：

```text
“改 prompt 后重新在同一个 holdout 从头跑”
```

来恢复确认性。

---

# 11. If Independent Sources Are Insufficient

如果当前只有少量独立 Pain，例如：

```text
~9 independent source groups
```

那么当前只能做：

```text
EXPLORATORY A/B
```

输出：

```text
PROMISING
NOT_PROMISING
INCONCLUSIVE
```

不能输出：

```text
QUALITY_SUPERIORITY_PROVEN
```

需要等后续真实新 Pain 积累成新的 confirmatory set。

禁止为了凑 n：

```text
把 retry / revision / artifact fan-out 当独立样本
```

---

# 12. Input Freeze

每个 sample 的 generator 输入必须冻结在：

```text
formation start time
```

当时可获得的信息。

禁止泄漏：

```text
后续 Owner decision
最终 Principle
后续 repair
Evaluator 最终结果
由该样本后来形成的 Core Principle
```

否则产生未来信息泄漏。

---

# 13. Same-Input Execution

A/B 必须共享：

```text
same source Pain
same diagnosis
same source evidence
same Core grounding snapshot
same model family/version
same temperature
same maxTokens
same retry budget
same timeout
same truncation policy
```

A/B 应交错运行：

```text
A1 B1
B2 A2
A3 B3
```

或随机顺序，降低时间/服务波动偏差。

---

# 14. Repeats

每个 independent input：

```text
A × 3 repeats
B × 3 repeats
```

repeats 用来衡量：

```text
stability
input-level preference consistency
```

不是独立统计 n。

---

# 15. Primary Statistical Unit

唯一 primary unit：

```text
independent source group / input
```

不是：

```text
formation run
artifact
repeat
```

例如：

```text
9 source groups × 3 repeats
```

仍然：

```text
N = 9
```

不是 N=27。

---

# 16. Pairwise Aggregation

每个 input 有 3 组 A/B paired outputs。

规则：

```text
至少 2 / 3 pair 明确偏 B
→ B_WIN

至少 2 / 3 pair 明确偏 A
→ A_WIN

其它
→ TIE
```

若任一 pair：

```text
BOTH_BAD
```

单独记录。

`BOTH_BAD` 不能因为一边“没那么坏”就变成质量胜出。

---

# 17. Primary Quality Gate

正式 confirmatory experiment 使用：

```text
W = B_WIN inputs
L = A_WIN inputs
T = TIE inputs
N = W + L + T
```

第一层：

```text
Net advantage = (W - L) / N
```

要求：

```text
Net advantage >= 20 percentage points
```

第二层：

对非 tie：

```text
W vs L
```

执行预注册的：

```text
one-sided exact sign test
alpha = 0.05
```

要求：

```text
PASS
```

若：

```text
趋势偏 B
但独立样本不足以通过
```

结论：

```text
INCONCLUSIVE
```

不是：

```text
EQUAL
```

---

# 18. Exploratory Experiment Gate

如果独立样本不足：

不跑确认性显著性门。

只报告：

```text
W / L / T / BOTH_BAD
Net advantage
关键质量差异
stability
downstream
```

结论：

```text
PROMISING
NOT_PROMISING
INCONCLUSIVE
```

只有后续新独立 Pain 的 confirmatory experiment 才能正式批准 Phase B。

---

# 19. Judge Design

主 judge 必须：

```text
看相同的原始 evidence
看相同 Core grounding
只不知道 X/Y 对应哪一臂
```

如果 judge 只看最终文本，就无法可靠判断：

```text
evidence grounding
intent fidelity
无证据细节
```

---

# 20. Judge Rubric

固定评价：

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

额外明确：

```text
无证据的具体化要扣分
无必要的过度保守要扣分
把有条件行为写成绝对禁止要扣分
泛化到原 Pain 未支持的场景要扣分
```

支持：

```text
X
Y
TIE
BOTH_BAD
```

---

# 21. Judge Independence

优先：

```text
generator model family ≠ primary judge model family
```

GPT6 不需要评全部样本。

建议 GPT6：

```text
预先随机抽取一部分普通样本
+
高风险样本
+
主 judge 不确定样本
+
judge 分歧样本
```

不能只让 GPT6 看“有争议”的 case，否则无法发现：

```text
两个 judge 一致犯错
```

---

# 22. Owner Calibration

Owner spot-check：

```text
8 个随机 holdout
+
最多 4 个 high-risk / judge-disagreement
```

Owner 只回答：

```text
X 更好
Y 更好
无实质差异
两者都不好
```

随机样本用于：

```text
总体 calibration
```

定向样本只用于：

```text
风险审查
```

不能混成一个准确率数字。

若：

```text
automated judge 强烈偏 B
Owner 随机样本明显偏 A
```

则：

```text
STOP
```

先审 rubric / judge bias。

---

# 23. Stability Is Behavioral Contract Stability

稳定性不以文本相似度定义。

必须比较完整行为契约：

```text
ownerIntent
targetBehavior
forbiddenBehavior
evidenceSource
validationExpectation

actor
action
condition
scope
exception
obligation / prohibition
```

---

# 24. Deterministic Normalization

只允许规范化：

```text
object key order
whitespace
明确无序集合的顺序
格式差异
```

禁止 normalize 掉：

```text
否定
条件
例外
阈值
强制程度
```

---

# 25. Stability Scenarios

每个 independent input 在生成前预定义固定行为场景：

至少：

```text
1. expected trigger
2. valid compliant behavior
3. legitimate exception
4. out-of-scope / boundary case
```

对于 RuleCode 相关 Principle，再增加：

```text
5. target violation
6. near-boundary legal behavior
```

这些 scenario 必须先于候选输出冻结。

不能让 A/B 各自定义自己更容易通过的 test cases。

---

# 26. Stability Classification

同一 input 的 repeats 两两检查，取最严重类别：

## CONTRADICTION

同一场景出现：

```text
相反义务
相反许可
一次 forbid 一次 allow
```

## MATERIAL_DRIFT

没有直接反转，但：

```text
关键行为改变
关键条件消失
例外改变
适用范围显著改变
```

## STABLE

所有预定义关键场景和 contract field：

```text
无实质变化
```

LLM 可以辅助判断自然语言歧义，但必须输出：

```text
具体冲突字段
具体反例场景
```

不能只给标签。

---

# 27. Stability Gate for Small N

小样本阶段不声称：

```text
“证明 5pp non-inferiority”
```

而只声称：

```text
Observed stability non-regression
```

要求：

```text
0 unresolved P0/P1 contradiction introduced by B
0 unresolved new critical semantic drift introduced by B
B validator/schema failures <= A
B truncation failures <= A
```

同时完整报告：

```text
paired stability outcomes
```

如果未来样本量足够，再考虑正式 paired non-inferiority interval。

---

# 28. Channel-specific Downstream Utility

不能把所有 Principle 都用：

```text
RuleCode 更容易生成
```

衡量。

必须按渠道。

---

## 28.1 RuleCode-capable Principle

验证：

```text
canonical intent fidelity
target violation → BLOCK
valid behavior → ALLOW
boundary case → correct
repair 不改变 original intent
deterministic replay
adversarial replay
```

关注：

```text
false-positive / overblocking
```

不能只看 evaluator approval。

---

## 28.2 Prompt-only Principle

验证：

```text
prompt exposure 保留 intent
固定行为 scenario 中行为符合要求
合法行为仍可执行
不增加 unnecessary refusal
```

---

## 28.3 Principle Not Suitable for RuleCode

```text
RuleCode generation = N/A
```

不能为了指标完整：

```text
强制编译 RuleCode
```

按实际 intervention channel 验证。

---

# 29. Downstream Primary Metric Must Be Pre-registered

每种 channel 在实验前选择：

```text
primary downstream metric
material improvement threshold
```

不能事后在：

```text
approval rate
requiredChanges
repair rate
replay pass
```

里挑一个上涨的就算成功。

辅助指标可以全部报告。

---

# 30. Failure Outputs Stay in the Denominator

以下不能删除：

```text
generation failure
timeout
schema invalid
validator failure
truncation
judge BOTH_BAD
```

否则会产生 survivor bias。

---

# 31. Cost Guard

记录：

```text
input tokens
output tokens
total tokens
wall time
retry count
```

默认：

```text
B total inference tokens <= A + 20%
```

如果超过：

```text
Owner explicit decision required
```

质量提升不能简单来自：

```text
无限增大上下文
无限增大输出长度
```

---

# 32. Phase A Acceptance

确认性 Phase A 只有以下四类：

```text
QUALITY_PASS
QUALITY_FAIL
INCONCLUSIVE
EXPERIMENT_INVALID
```

进入 Phase B 必须：

```text
Quality net advantage PASS
+
sign test PASS
+
stability observed non-regression
+
channel-specific downstream non-regression
+
Owner calibration not conflicting
+
cost acceptable
```

---

# 33. What Phase A Proves

Phase A PASS 只能证明：

> **恢复 formation evidence 的目标认知方案优于 current lossy cognitive contract。**

不能证明：

> **生命周期必须收敛成一个。**

这两个结论必须保持分离。

---

# 34. Freeze the Improved Cognitive Contract

Phase A PASS 后冻结：

```text
propose prompt / contract
critique prompt / contract
formalize input contract
formalize prompt / contract
core grounding behavior
context pruning policy
```

产生：

```text
COGNITIVE_CONTRACT_VERSION
```

Phase B 不允许顺手：

```text
重新优化 prompt
重新改 critique strategy
再加一堆信息
```

否则无法判断 lifecycle collapse 是否保持质量。

---

# 35. Phase B — Lifecycle Collapse Candidate

冻结 cognition 后目标：

```text
PrincipleFormation
  propose
  → critique
  → formalize
```

一个：

```text
durable execution lifecycle
```

而不是三个。

注意：

```text
canonical governance boundary 仍然是 1
```

---

# 36. PrincipleFormation Runner Target

目标 runner：

```text
PrincipleFormationRunner
```

逻辑：

```text
load source
→ propose
→ validate proposals
→ critique
→ validate critique
→ formalize
→ validate canonical Principle
→ persist canonical
→ commit successor
```

禁止：

```text
propose 后建 durable successor task
critique 后建 durable successor task
```

---

# 37. Internal Step State

默认：

```text
propose / critique / formalize
```

属于：

```text
run-local step state
```

不是 durable governance state。

在实现前必须选择失败策略：

## Strategy A — Whole-formation Retry

任一步失败：

```text
整次 formation 重跑
```

优点：

```text
结构最简单
```

缺点：

```text
LLM 重算成本
重复 proposal 可能变化
```

## Strategy B — Durable Step Checkpoint

允许从中间恢复。

但会重新引入：

```text
step identity
step version
recovery semantics
attempt semantics
```

默认优先 A。

只有真实 fault/cost evidence 证明 A 不可接受时才考虑 B。

---

# 38. Phase B Reliability Test Matrix

Phase B 生产切换前必须覆盖：

```text
1. propose failure
2. critique failure
3. formalize failure
4. lease expiry
5. process restart
6. duplicate execution
7. canonical persistence 成功、successor commit 前崩溃
8. successor commit 重试
```

验收：

```text
无 duplicate canonical effect
无 evidence mismatch
无 silent orphan task
无 authority duplication
重试语义可解释
```

---

# 39. Proposal Evidence Semantics

Phase A 实验：

```text
可以完全 transient
```

Phase B 生产持久化前才决定。

但权限语义必须先冻结：

> **proposal evidence 不是治理对象，但如果它影响后续 RuleCode / Evaluator，它仍然是安全相关输入。**

因此：

```text
“non-governance”
≠
“可以在批准后随便变”
```

---

# 40. Preferred Evidence Model

优先验证：

```text
one canonical Principle artifact
+
frozen minimal formation evidence snapshot
```

消费者：

```text
通过 canonical identity
读取当时用于形成该 Principle 的 proposals / critique evidence
```

原则：

```text
canonical intent = behavior authority
formation evidence = immutable supporting evidence
```

这样避免新增独立 checkpoint identity。

---

# 41. Evidence Authorization Rule

如果 evidence snapshot 是 canonical artifact 内容的一部分：

必须明确：

```text
evidence-only change
是否构成 canonical content change
是否需要重新 review / new revision
```

不能因为字段叫：

```text
formationEvidence
```

就自动获得 authorization exemption。

如果当前 authority 模型无法清晰表达：

```text
先完成 PRI-814 所需最小 identity/revision 前提
```

再生产落地。

---

# 42. Independent Checkpoint Is Fallback Only

只有现有 canonical artifact 无法合理携带冻结 evidence，才考虑：

```text
existing store 中的 non-governance checkpoint
```

必须：

```text
immutable or exact-version addressable
canonical revision 能明确定位它
不可 approval
不可 activation
不可 promotion
无独立 task
无独立 retry/recovery
无第二 writer
无新 DB table
```

当前 `(source_task_id, artifact_kind)` overwrite 语义不能直接假设满足这些条件。

---

# 43. Revision Semantics

不能只说：

```text
旧 task 只读兼容
```

因为历史 Principle 未来可能合法 revision。

必须定义两代对象的 revision：

## Historical Principle

如果原 lineage 来自：

```text
Dreamer → Philosopher → Scribe
```

未来 Owner 要 revision：

目标优先：

```text
进入 PrincipleFormation revision path
```

而不是永久唤醒旧 Trinity。

但必须保留：

```text
old canonical identity
→ new revision identity
```

的明确关系。

---

# 44. Revision Migration Contract

生产 cutover 前必须回答：

```text
1. old Scribe-based Principle 如何找到 revision source context？
2. revision 是否读取历史 proposals / critique？
3. 若历史 evidence 不完整，如何明确标记？
4. new revision 是否成为 PrincipleFormation canonical output？
5. old approval / activation 如何失效或保持？
```

不能依赖：

```text
find taskKind='scribe'
```

作为长期 revision contract。

---

# 45. Migration Routing Seam

允许一个短期 routing seam：

```text
只决定新 lineage 从哪个 formation generation 开始
```

例如：

```text
generation=v1 → old Trinity
generation=v2 → PrincipleFormation
```

要求：

```text
不双写
不双跑
不产生第二 authority
后继任务沿 lineage generation 继续
不可半途换代
```

---

# 46. Rollback Target Must Be a Compatible Version

真正可回滚目标不能简单是：

```text
git revert 到完全不认识 principle_formation 的旧版本
```

因为数据库里可能已经有：

```text
principle_formation pending / leased / retry_wait
```

正确 rollback 版本必须：

```text
认识 old + new 两代 task
停止 admission 新 generation
仍能 drain / recover 已存在 new tasks
```

只有：

```text
无未完成 new tasks
所有 canonical output 可被旧 read/governance/runtime 正常读取
```

后，才允许退到完全旧版。

---

# 47. Stop-claim / Drain Procedure

如果新 runner 本身故障：

```text
1. 停止创建新的 v2 formation
2. 停止新 runner 领取新的 lease
3. 让已 leased task 到安全点 / lease expire
4. 保留 retry/recoverable state
5. 不删除 task
6. 不伪造 succeeded
7. 由兼容版本恢复
```

必须测试。

---

# 48. Complexity Measurement — Migration vs Steady State

复杂度必须分两列：

```text
migration period
steady state
```

迁移期允许暂时增加兼容分支。

最终只能在 steady state 宣称：

```text
complexity reduced
```

---

# 49. Complexity Metrics

必须统计：

## Durable execution state

```text
task kinds
task rows per formation
run rows per formation
retry/recovery decision points
durable step checkpoint count
```

## Identity / reference

```text
canonical identity fields
evidence identity fields
revision links
legacy compatibility fields
lineage parsing branches
```

## Wiring

```text
runner registrations
adapter slots
producer branches
consumer branches
old path reachability
```

## Failure / recovery

```text
commit crash windows
retry granularity
recompute behavior
orphan risk
```

## Runtime cost

```text
success-path LLM calls
failure-path repeated LLM calls
tokens
latency
```

禁止用：

```text
删除多少测试行
删了多少文件
```

作为复杂度收益。

---

# 50. Phase B Complexity Gate

最终 steady state 至少要求：

```text
formation durable execution lifecycle: 3 → 1
formation task kinds: 3 → 1
stage-specific runner admission: 3 → 1
named cross-stage identity handoff: 显著减少
recovery decision surface: 减少
task/run amplification: 减少
```

同时：

```text
内部 durable step checkpoint
不能把被删的复杂度重新造回来
```

---

# 51. Safety Net Implementation-state Gate

在 Phase B 前必须确认 merged Safety Net 实际代码：

```text
不冻结 Dreamer/Philosopher/Scribe 数量
不冻结 fixed edge count
不把 intermediate evidence 当 canonical bearer
```

并继续保护：

```text
formal input → governable Principle
provenance
Owner/system_policy authority
current content authorization
idempotency / recovery no escalation
runtime consumer boundary
precise revocation
```

---

# 52. Routing Tests Must Evolve, Not Disappear

以下 current 测试：

```text
fixed chain
fixed edge count
fixed successor
```

可以调整。

但不能把 routing protection 弱化成：

```text
“只要无环就行”
```

新的 routing test 仍必须证明：

```text
不会绕过 required governance / evaluator / rollout / activation boundary
```

---

# 53. Phase B Quality Gate

Phase B 不要求再次显著提升质量。

相对 Phase A frozen cognitive contract：

```text
QUALITY = NON_REGRESSED
STABILITY = NON_REGRESSED
DOWNSTREAM BEHAVIOR = NON_REGRESSED
```

如果 lifecycle collapse 后输出变差：

```text
REJECT COLLAPSE
```

即使复杂度明显下降也不接受。

---

# 54. Final End-to-End Comparison

最终还要比较：

```text
Original Baseline A0
vs
Final PrincipleFormation B2
```

确保整体目标仍满足：

```text
QUALITY ↑
STABILITY ≥
COMPLEXITY ↓
```

不能出现：

```text
Phase A 提升质量
Phase B 又吃掉提升
最终只剩“差不多”
```

---

# 55. Short Soak

生产 cutover 前后做最小真实 soak。

不仅观察 formation error，还要覆盖选定真实 host 的：

```text
Principle exposure
RuleCode downstream（若该样本适用）
feedback
revoke
```

不要求完整重跑 EP002。

按影响面选择最小真实闭环。

---

# 56. Progressive Disclosure P1

已知：

```text
artifact_summary_redundancy OFF
context_manifest_budget ON
progressive_evaluator ON
→ summary/predecessorSummary 生产结构性 absent
```

Phase A 会绕开这一信息损失。

但该 P1：

```text
仍独立存在
```

不得在 Trinity 项目中偷偷关闭。

原因：

```text
其它 consumer / 旧 flow 仍可能依赖它
```

---

# 57. Delivery Phases

## Phase 0 — Safety Net

```text
#1742 修复
→ merge
→ implementation-state check
```

---

## Phase 1 — Sample Reality Check

```text
按 Pain/source lineage 分组
确认 independent source count
冻结 sample manifest
```

若：

```text
N 不足
```

明确进入：

```text
exploratory mode
```

---

## Phase 2 — Minimal Information-Flow Harness

只构建：

```text
A current
B minimal information repair
```

不改 topology。

---

## Phase 3 — Dev Tuning

只用 development source groups。

完成后冻结：

```text
B prompt
context composition
rubric
judge policy
failure policy
```

---

## Phase 4 — Exploratory / Confirmatory A/B

如果新独立 holdout 足够：

```text
confirmatory
```

否则：

```text
exploratory
```

---

## Phase 5 — Owner Quality Decision

只有：

```text
QUALITY PASS
```

才允许继续。

---

## Phase 6 — Freeze Cognitive Contract

生成：

```text
COGNITIVE_CONTRACT_VERSION
```

---

## Phase 7 — PrincipleFormation Implementation

做 lifecycle collapse。

---

## Phase 8 — Reliability / Revision / Rollback Validation

覆盖：

```text
step failure
lease
restart
duplicate execution
commit crash
revision
two-generation routing
rollback/drain
```

---

## Phase 9 — Complexity + Safety Net Verification

```text
net complexity
check:pipeline-contract
verify:merge
historical read compatibility
```

---

## Phase 10 — Short Real Soak

选定 host 做最小真实闭环。

---

## Phase 11 — Retire Old Reachability

只在：

```text
无未完成 old lineage
revision path 已迁移
rollback seam 可删除
```

后进行。

---

# 58. Stop Conditions

任一发生即 STOP：

1. 独立 source 数量不足却试图包装成 confirmatory；
2. 看过 holdout 后修改 B 又继续复用同一 holdout；
3. B 质量没有明确优于 A；
4. B 只是更稳定但质量持平；
5. B 新增 P0/P1 semantic contradiction；
6. Owner calibration 与 judge 明显冲突；
7. channel-specific downstream 行为回退；
8. B 质量优势主要依赖不可接受 token 暴涨；
9. Phase B 需要第二 durable authority；
10. Phase B 需要长期 dual pipeline；
11. Phase B 需要弱化 Safety Net；
12. revision 无法闭合；
13. rollback 会产生 orphan new tasks；
14. 为避免重算而新增 step-level durable lifecycle，导致净复杂度不降；
15. lifecycle collapse 吃掉 Phase A 的质量提升。

---

# 59. Phase A Report

```text
PRI_815_INFORMATION_FLOW_AB

BASE_SHA =
SAFETY_NET_SHA =

MODE =
EXPLORATORY / CONFIRMATORY

INDEPENDENT_SOURCE_GROUPS =
DEV_GROUPS =
HOLDOUT_GROUPS =

GENERATOR =
GENERATOR_CONFIG_HASH =
A_PROMPT_HASHES =
B_PROMPT_HASHES =
CORE_GROUNDING_HASH =

REPEATS_PER_INPUT = 3

W =
L =
T =
BOTH_BAD =

NET_ADVANTAGE =

SIGN_TEST =
PASS / FAIL / N/A_EXPLORATORY

STABILITY
A_CONTRADICTION =
B_CONTRADICTION =
A_MATERIAL_DRIFT =
B_MATERIAL_DRIFT =

DOWNSTREAM_BY_CHANNEL =
...

OWNER_CALIBRATION =
...

TOKENS
A =
B =
DELTA =

QUALITY_VERDICT =
PASS / FAIL / INCONCLUSIVE

STABILITY_OBSERVED =
NON_REGRESSED / REGRESSED / INCONCLUSIVE

FINAL =
PROCEED_TO_COGNITIVE_CONTRACT_FREEZE /
HOLD /
REJECT /
INCONCLUSIVE
```

---

# 60. Phase B Implementation Report

```text
PRI_815_PRINCIPLE_FORMATION_COLLAPSE

BASE_SHA =
HEAD_SHA =
PR =

COGNITIVE_CONTRACT_VERSION =

DURABLE_EXECUTION_LIFECYCLE
BEFORE = 3
AFTER =

CANONICAL_GOVERNANCE_BOUNDARY
BEFORE = 1
AFTER = 1

FORMATION_TASK_KINDS
BEFORE = 3
AFTER =

TASK_ROWS_PER_FORMATION
BEFORE =
AFTER =

RUN_ROWS_PER_FORMATION
BEFORE =
AFTER =

NAMED_CROSS_STAGE_IDENTITY_HANDOFF
BEFORE =
AFTER =

RECOVERY_DECISION_SURFACE
BEFORE =
AFTER =

DURABLE_INTERNAL_STEP_CHECKPOINTS =

REVISION_COMPATIBILITY =
PASS / FAIL

ROLLBACK_DRAIN =
PASS / FAIL

FAULT_SCENARIOS =
PASS / FAIL

QUALITY_VS_PHASE_A =
NON_REGRESSED / REGRESSED

STABILITY_VS_PHASE_A =
NON_REGRESSED / REGRESSED

SAFETY_NET =
PASS / FAIL

VERIFY_MERGE =
PASS / FAIL

NET_COMPLEXITY =
REDUCED / NOT_REDUCED

SHORT_SOAK =
PASS / FAIL

FINAL =
CUTOVER_ACCEPT /
DO_NOT_CUTOVER
```

---

# 61. Final Acceptance

最终生产 cutover 只有：

```text
Phase A Quality PASS
+
Phase A Stability not regressed
+
Phase A Downstream acceptable
+
Phase B Quality non-regressed vs Phase A
+
Phase B Runtime reliability PASS
+
Revision PASS
+
Rollback/drain PASS
+
Net complexity REDUCED
+
Safety Net PASS
+
Short soak PASS
```

才成立。

---

# 62. Final Architecture Target

条件性目标仍然是：

```text
PrincipleFormation
  ├─ propose
  ├─ critique
  └─ formalize
       ↓
canonical Principle
```

其中：

```text
durable execution lifecycle = 1
canonical governance identity = 1
critique 默认 transient
proposal evidence 默认优先作为 canonical-linked frozen evidence
```

但：

```text
SIMPLIFY_PARTIALLY
```

现在表示：

> **候选目标架构。**

不再表示：

> **已经证明应该立即实施。**

---

# 63. Non-goals

本 SPEC 不做：

```text
删除 critique cognition
把三次 LLM call 强行压成一次
重构 Evaluator
重构 Owner Approval
全面 Artifact Store 重构
全面 PRI-814
Diagnostician rootcause/distiller/router 收敛
新 observability platform
新 memory system
长期 dual pipeline
```

---

# 64. Owner Decision Summary

v0.3 的核心变化：

旧思路：

```text
先设计 PrincipleFormation
→ 做 A/B
→ 如果质量和稳定性都更好就上线
```

新思路：

```text
先修最有证据的信息流缺口
→ 单独证明质量收益

再冻结认知契约
→ 单独验证 lifecycle collapse 的可靠性和复杂度收益
```

最终标准仍然没有降低：

```text
更好的输出
+
不更差的稳定性
+
正确的下游行为
+
更低的 durable coordination complexity
+
完整 Safety Net
```

只是把：

```text
“质量为什么变好”
```

和：

```text
“架构为什么变简单”
```

从同一个实验里拆开，使每个结论都能被单独证明。
