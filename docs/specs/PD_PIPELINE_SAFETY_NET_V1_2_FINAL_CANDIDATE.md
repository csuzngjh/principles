# PD Pipeline Safety Net v1.2 — Final Candidate
## 最小机械安全网：保护 Owner-Governed Intervention Lifecycle，不冻结当前 Pipeline 实现

> **Status**: Final Candidate for Owner approval  
> **Version**: v1.2  
> **Date**: 2026-09-17  
> **Target**: PRI-807 Phase 2/3 的最小落地子集  
> **Architecture basis**: `PD Core Value Pipeline Contract & Governance SPEC v0.3`  
> **Evidence basis**: EP002 production closure + Final Evidence Freeze + independent GPT6 Architecture Red Team  
> **Baseline at review**: `45e115363a8ac1aed30a42f0c027ca07032af791`  
> **Principle**: **保护价值契约，不保护历史偶然实现。**

---

# 0. Executive Decision

PD 的核心生产行为闭环已经真实跑通。

Safety Net v1.2 的任务不是继续扩建 Pipeline，而是防止未来重构把已经跑通的价值链静默弄断。

v1.2 只保护六个最小不变量：

```text
1. 真实输入能形成可治理产物
2. 身份与来源不能被替换或猜测
3. 权限必须来自当前有效授权
4. 治理变更不能分叉、重复增权或通过恢复增权
5. 合法干预必须真正到达 runtime 消费边界
6. 撤销必须准确终止目标干预的后续作用
```

另有一个工程前提：

```text
C0：Safety Net 本身必须真的被 test runner / CI 执行
```

v1.2 明确不冻结：

```text
Dreamer / Philosopher / Scribe 的数量
当前 DB 表
当前 artifact envelope
固定 CHANNEL_EDGES 边集合
固定 schema registry key 集合
run15 baseline/hash 业务语义
OpenClaw 私有事件格式
Principle Receipt 作为必经节点
```

---

# 1. 为什么现在做

EP002 已证明真实 production 中：

```text
Pain / Rule
→ Owner Governance
→ shadow
→ readiness
→ Console promote
→ live block
→ Agent-visible feedback
→ Agent changes next action
→ first legal retry succeeds
→ positive control
→ revoke
→ subsequent runtime effect disappears
```

因此当前主要风险从：

```text
“管道根本没接通”
```

转为：

```text
“后续重构把主血管重新弄断，但局部测试仍然全绿”
```

尤其接下来可能进行：

```text
Dreamer durable
→ Philosopher durable
→ Scribe durable
```

收敛为：

```text
PrincipleFormation
  ├ propose
  ├ critique
  └ formalize
→ one canonical Principle
```

Safety Net 必须允许这种内部结构变化。

---

# 2. Evidence Semantics：PASS / FAIL / KNOWN_GAP 的严格边界

这是 v1.2 最重要的语义修正。

## 2.1 KNOWN_GAP 只允许表示“历史证据不存在”

例如当前已确认：

```text
approved historical artifact digest
executed historical artifact digest
exact Principle historical revision digest
```

没有被独立 durable 保存。

这属于：

```text
KNOWN_EVIDENCE_GAP
```

Safety Net 不应为了填满历史账本，在本任务顺手增加 schema。

---

## 2.2 当前授权违规绝不能降级成 KNOWN_GAP

例如：

```text
review A
→ artifact 内容替换成 B
→ 旧授权仍让 B 生效
```

如果 deterministic test 证明这种当前行为存在：

```text
FAIL
```

不能写：

```text
KNOWN_GAP
```

因为这不是“过去无法审计”，而是“现在权限边界错误”。

---

## 2.3 当前行为尚未验证

如果 current product 是否能阻止某种 stale authorization 还未验证：

```text
UNVERIFIED
```

并收窄 Safety Net 的 PASS claim。

不能把：

```text
“没测试到”
```

写成：

```text
“已经安全”
```

---

# 3. Safety Net v1.2 最小不变量

---

## INV-01 — Real Input Must Reach Governable Output

必须至少有一条 deterministic test 从**正式生产输入入口**开始：

```text
正式输入
→ production formation wiring
→ 最终可治理 Principle
```

允许替换：

```text
非确定性的模型输出
```

但不允许测试一开始就手工预制：

```text
最终 Principle artifact
所有中间 lineage
所有 task 状态
```

否则 Trinity 的生产接线即使断掉，也可能假绿。

### 断言什么

```text
输入来源可回链
最终 Principle 可治理
所需当前 schema 能解析
无效输出明确失败
```

### 不断言什么

```text
必须经过 Dreamer
必须经过 Philosopher
必须经过 Scribe
必须有三个 durable artifact
```

---

## INV-02 — Identity and Provenance Must Not Be Guessed

长期保护：

```text
Pain provenance
Principle identity
Rule identity
authorization identity
activation identity
runtime intervention identity
```

不能使用：

```text
title
latest row
timestamp proximity
“看起来是同一个”
```

作为 silent fallback。

### Pain 命名空间

当前存在：

```text
canonical pain_host_* ID
internal derivedFromPainIds UUID
```

Safety Net 保护：

```text
两者之间存在可核验 provenance bridge
```

不要求：

```text
两个字符串相等
```

### Principle

v1.2 hard gate：

```text
Rule.source_principle_id
→ authoritative Principle UUID
```

当前 exact historical Principle version/digest：

```text
KNOWN_EVIDENCE_GAP
```

但如果当前授权下 artifact 内容被替换后仍无重新授权生效：

```text
FAIL
```

---

## INV-03 — Permission Must Come From Valid Authority

PD 是 Owner-governed，不等于“所有 intervention 都必须逐条人工批准”。

当前至少存在：

```text
authority = owner
authority = system_policy
```

Safety Net 必须保护：

### Owner-required path

```text
没有有效 Owner approval
→ 不得产生 Owner-authorized effect
```

### Policy-authorized path

```text
只能按当前 policy authority 生效
不得被表示为 Owner-approved
不得扩大为高风险 Owner-only 权限
```

### Observation is not authorization

以下永远不能自己生成权限：

```text
readiness
telemetry
shadow observation
receipt
event count
successful evaluation
```

即：

```text
Observation State
≠
Governance State
```

---

## INV-04 — Governance Changes Must Not Fork or Escalate Authority

保护当前正式治理语义：

```text
multiple callers
→ canonical mutation authority
```

但 v1.2 不承诺：

```text
“任何未来新增第二 writer 都一定被自动发现”
```

主证明方法：

```text
service-level behavioral contract
```

通过已知 production entrypoint 驱动真实持久化 authority。

必须保护：

```text
重复提交不会创造第二份权限
ready 不会自动 promote
旧请求不能覆盖更新后的 revoke/decision
恢复不能直接扩大回 live
恢复最多回到当前契约允许的安全状态
提交时必须重新检查当前 control state/version
```

完整 J3 Revision/Recovery Journey 可以延后。

但：

```text
recovery must not escalate authority
```

不能延后。

---

## INV-05 — Intervention Must Reach the Actual Runtime Consumer Boundary

不能只测试内部 helper：

```text
compileRule()
RuleHost.evaluate()
```

然后声称 production wiring 正常。

### Principle

必须至少到：

```text
production prompt activation/exposure boundary
```

并确认授权来源不会被误标。

不要求 Principle Receipt feature 必须启用。

### RuleCode

deterministic Journey 必须至少到：

```text
production host runtime / host adapter callable boundary
→ block / allow
→ consumer-visible reason
```

无需启动真实 OpenClaw process。

但不能只读取内部 evaluator result 后手工把 reason 交给 harness。

### Failure policy

Safety Net 不新建：

```text
“所有错误一律 block”
```

之类通用规则。

授权失败：

```text
不得扩大权限
```

执行故障：

```text
遵守当前 host-liveness / fail-open/fail-closed 契约
```

两者不能混为一类。

---

## INV-06 — Revocation Must Accurately Stop Future Effect

撤销必须验证：

```text
目标 intervention A
→ revoke
→ 存活 runtime 的下一次调用
→ A 不再施加作用
```

重点：

```text
无需重启
```

fresh session 可作为补充，但不能作为唯一证明。

同时 fixture 至少保留另一个仍然有效的 intervention B：

```text
revoke A
→ A disappears
→ B remains effective
```

防止“全局清空”冒充精确撤销。

只有在 fixture 中 A 本来就是唯一规则时，才允许断言：

```text
no_rules_armed
```

不要求：

```text
Agent 忘记之前学到的信息
中断已经开始的调用
```

---

# 4. C0 — Test Discoverability / CI Execution

Safety Net 自己必须先证明会运行。

必须机械证明：

```text
每一个 Safety Net test
→ 被目标 Vitest/test config 收集
→ 被 check:pipeline-contract 实际执行
→ CI / merge verification 有正式入口
→ failure 会传播非零退出码
```

禁止：

```text
测试文件存在
→ 默认认为 CI 执行
```

不建立新的 test registry 真相源。

聚合器只负责：

```text
选择已有正式测试入口
执行
传播退出状态
输出最小摘要
```

---

# 5. Contract Guards：从 C1–C6 收敛为行为保护

v1.2 不要求“每个 Guard 都新写一套测试”。

同一个 Golden Journey 可以同时证明多个 invariant。

---

## C1 — Current Contract Resolution

保护：

```text
当前 production 请求的 schema / contract
→ 能从当前 authority 解析
未知 contract
→ fail loud
```

不保护：

```text
OUTPUT_SCHEMA_REGISTRY 当前所有 key 永远存在
每个兼容性旧 schema 永远必须有活跃 production consumer
```

旧 schema 的历史读取兼容属于具体 migration 模块。

---

## C2 — Current Routing Policy

只保护：

```text
当前受 channel policy 治理的 production path
→ 遵守当前 routing authority
```

不冻结：

```text
当前 edge set
stage count
Dreamer → Philosopher → Scribe
pipelineMode 历史形状
```

如果 Trinity 简化后 router 实现改变，只要价值行为保持，相关 setup/test 可以调整。

---

## C3 — Provenance / Lineage

由 INV-01 + INV-02 的 Journey 共同证明。

至少覆盖：

```text
formal input
→ formation
→ governable Principle
→ Rule provenance（如适用）
→ authorization
→ activation
→ runtime identity
```

fixture 不得手工填满整条 lineage 绕过生产 formation。

---

## C4 — Authorization Boundary

至少复用/选择现有负例保护：

```text
Owner identity required where policy says owner
observation/readiness cannot self-promote
artifact mismatch rejected
channel mismatch rejected
stale/current control state checked at commit
duplicate commit idempotent
recovery does not regain live authority automatically
```

这比“只证明 Owner approve 后能成功”更重要。

---

## C5 — Current Content Authorization

保护两个层面：

### Durable historical evidence

```text
approved digest
executed digest
Principle exact historical revision digest
```

当前：

```text
KNOWN_GAP
```

### Current behavior

必须测试：

```text
授权绑定 artifact A
→ 当前 authoritative content 被替换/变更
→ 不得在没有符合当前授权规则的重新授权下悄悄获得新权限
```

具体正确行为可以是：

```text
reject
re-review required
new identity required
explicit invalidation
```

由 current architecture 决定。

但：

```text
旧授权静默覆盖新内容
```

不得成为 PASS。

---

## C6 — Mutation Authority

主方法：

```text
service-level contract
```

通过真实 store / authority 证明：

```text
Console/CLI/known production caller
→ 同一治理语义
→ 同一拒绝语义
→ 同一幂等语义
→ 同一 current-state check
```

允许有针对性的入口 wiring assertion。

不新增：

```text
writer registry
AST scanner
全仓 SQL writer detector
```

也不声称有限行为测试可以发现任意未知旁路。

---

# 6. Golden Journeys

v1.2 保留：

```text
J1 Principle
J2 RuleCode
J4 Revocation
```

完整 J3 延后。

---

# 7. J1 — Principle Journey

## 起点

必须从正式输入 / formation 接线进入。

允许：

```text
stub deterministic LLM result
```

但不能直接插最终 Principle artifact 作为唯一 setup。

## 主路径

```text
formal input
→ production formation wiring
→ governable Principle
→ valid authority
→ activation
→ production prompt exposure
```

## Negative

### Owner-required

```text
no valid Owner approval
→ no Owner-authorized exposure
```

### system_policy

```text
policy-authorized exposure
→ authority=system_policy
→ must not be represented as Owner-approved
```

### current content replacement

```text
authorization for A
→ replace/mutate content
→ current authorization rule must be enforced
```

如果系统静默让未经授权的新内容生效：

```text
FAIL
```

## Revocation

J1 可以复用 J4 setup：

```text
deactivate
→ same live runtime next exposure
→ target Principle absent
```

不依赖 Principle Receipt 为必经节点。

---

# 8. J2 — RuleCode Journey

## Setup

可以 deterministic 构造模型产出与 shadow observations，但必须进入 production services。

synthetic telemetry 只能位于：

```text
temp workspace
```

不能复制 production data。

## Journey

```text
Rule proposal / artifact
→ evaluation
→ authorization
→ shadow activation
→ real readiness reader
→ explicit Owner promotion path
→ production host runtime / adapter boundary
→ illegal call BLOCK
→ consumer-visible reason
→ corrected fixture prerequisite
→ first legal retry ALLOW
→ positive control ALLOW
```

## 重要

`corrected fixture prerequisite` 不固定为：

```text
baseline/hash
```

run15 的 baseline/hash 只是一个真实案例。

Safety Net 保护的是：

```text
block
→ feedback
→ contract-satisfying correction
→ allow
```

## Authorization negative set

至少选择已有测试覆盖：

```text
readiness ready ≠ automatically promoted
non-owner cannot Owner-promote
stale/current state checked on commit
duplicate promotion has no new authority
recovery does not jump from isolated/revoked to live
shadow does not interfere with live winner
```

---

# 9. J4 — Revocation Journey

J4 是独立可识别的 contract，但复用 J1/J2 setup。

至少验证：

## Principle

```text
A active
B active
revoke A
→ live runtime next exposure:
   A absent
   B retained
```

## RuleCode

```text
Rule A live
Rule B remains valid（若 fixture 支持）
revoke A
→ same live runtime next evaluation:
   A no longer acts
   B unaffected
```

如果 fixture 只有 A：

```text
no_rules_armed
```

可以作为该 fixture 的具体结果，但不是系统级永久契约。

---

# 10. Merge-time vs Release/Dogfood

Safety Net v1.2 严格区分两层。

---

## Tier A — Merge-time Deterministic

应证明：

```text
formal input production wiring remains connected
current contract authority resolves
current authorization boundaries hold
governance commit is idempotent/current-state-aware
runtime adapter boundary receives correct intervention result
feedback contract reaches deterministic consumer
revocation is precise
synthetic evidence stays isolated
```

要求：

```text
no network
no API key
no real LLM
no production workspace
deterministic
```

---

## Tier B — Release / Dogfood

应证明：

```text
source
→ package
→ installer
→ installed runtime
→ loaded process
→ real host registration
→ real Agent behavior
```

至少按影响面复核：

```text
real hook invoked
real prompt exposure / live block
real Agent receives feedback
real Agent changes next action
real valid retry
real revoke in installed runtime
```

---

## Dogfood Trigger 不只看“核心 Pipeline 代码”

以下变化也可能要求短 dogfood：

```text
installer
packaging
runtime pin
entrypoint
hook registration
host adapter
configuration default
capability declaration
activation/promotion wiring
```

无需每次完整重跑 EP002。

按影响面选最小真实验证。

---

# 11. check:pipeline-contract

提供薄命令：

```bash
npm run check:pipeline-contract
```

它只做：

```text
选择现有正式 tests
执行 focused journeys
传播退出状态
打印最小 claim summary
```

不做：

```text
新的结果数据库
新的 DSL
新的 scanner framework
新的 artifact registry
新的 writer registry
新的 test registry
```

输出示例：

```text
PD Pipeline Safety Net v1.2

C0 Test execution                    PASS
I1 Formation wiring                  PASS
I2 Provenance / identity             PASS
I3 Authorization boundary            PASS
I4 Governance idempotency / recovery PASS
I5 Runtime consumer boundary         PASS
I6 Precise revocation                PASS

J1 Principle                         PASS
J2 RuleCode                          PASS
J4 Revocation                        PASS

Known historical evidence gaps:
- approved artifact digest            KNOWN_GAP
- executed artifact digest            KNOWN_GAP
- exact Principle historical revision KNOWN_GAP

Result:
PASS — merge-time mechanical contract only
```

若某个 current behavior 尚未验证：

```text
UNVERIFIED
```

则输出必须收窄整体 claim，不能混进 PASS。

---

# 12. Failure Diagnostics

失败输出至少包含：

```text
invariant
entrypoint
authority
expected behavior
actual behavior
nextAction
```

例如：

```text
FAIL Authorization Boundary

Entry:
promotion commit

Expected:
current Owner authority + current control version required

Actual:
stale request committed after revoke

NextAction:
fix canonical promotion authority;
do not add a parallel guard in Console.
```

禁止只输出：

```text
AssertionError
```

---

# 13. Fault Injection Acceptance

Fault injection 是一次性验收，不建立长期 mutation framework。

至少证明：

## FI-1 Contract resolution

破坏当前 production schema ref：

```text
→ Safety Net red
```

## FI-2 Formation wiring

断开正式 input → formation successor：

```text
→ J1/forming journey red
```

而不是靠最终 artifact fixture 继续绿。

## FI-3 Authorization

让 stale / mismatched authorization 尝试生效：

```text
→ authorization test red
```

## FI-4 Host adapter feedback

临时破坏：

```text
deny/block
→ host-visible blockReason
```

映射：

```text
→ J2 red
```

## FI-5 Revocation precision

临时让撤销后 A 仍被缓存执行：

```text
→ J4 red
```

或临时让 revoke A 同时移除 B：

```text
→ J4 red
```

全部完成后 revert。

Fault injection 只证明：

> 对应注入缺陷能被正式 Safety Net 捕获。

不能宣称：

```text
所有同类缺陷均可自动发现
```

---

# 14. Reuse-first Reality Check

实施前先只读 inventory。

每项标：

```text
REUSE
EXTEND
NEW_MINIMAL
DO_NOT_BUILD
```

必须调查：

```text
formation runner-chain tests
schema registry tests
owner decision / stale review tests
approval dispatcher tests
promotion readiness tests
activation safety store tests
recovery-to-shadow tests
production host-runtime tests
OpenClaw adapter mapping tests
cache invalidation / deactivation tests
existing synthetic shadow fixture
CI test discovery
verify:merge / CI wiring
```

核心原则：

```text
已有能力 → 连接
部分能力 → 扩展
只有真正缺失 → 最小新增
```

---

# 15. Implementation Phases

## Phase A — Reuse Map

只读。

输出：

```text
SAFETY_NET_REUSE_MATRIX.md
```

不改产品。

---

## Phase B — C0 + Minimal Selection

先证明：

```text
所选测试真的会运行
```

建立薄：

```text
check:pipeline-contract
```

不要先写大量新测试。

---

## Phase C — Fill Only Real Gaps

只补：

```text
formal input → formation wiring
current content authorization negative
runtime host adapter feedback boundary
precise live revocation
```

中现有测试确实缺失的部分。

---

## Phase D — Fault Injection

执行 FI-1 ~ FI-5。

确认正式入口会红。

---

## Phase E — CI Wiring

接进正式 CI / merge verification。

避免重复全量 package test。

最终证明：

```text
fresh worktree
→ npm run check:pipeline-contract
→ deterministic PASS
```

---

# 16. Done Definition

## Execution

- [ ] Safety Net tests 被真实 test config 收集；
- [ ] `check:pipeline-contract` 真实执行它们；
- [ ] CI/merge 路径真实调用该命令；
- [ ] failure 传播非零退出码。

## Formation

- [ ] 至少一条正式 input → production formation wiring → governable Principle；
- [ ] 不通过预制最终 artifact 绕过 formation；
- [ ] 不锁 Dreamer/Philosopher/Scribe 数量。

## Authorization

- [ ] Owner-required path 无 Owner approval 不产生 Owner-authorized effect；
- [ ] system_policy 与 Owner authority 明确区分；
- [ ] readiness/telemetry 不产生 promotion authority；
- [ ] artifact/channel mismatch 被拒绝；
- [ ] current state/control version 在 commit 时生效；
- [ ] duplicate governance commit 不增权；
- [ ] recovery 不直接恢复 live authority；
- [ ] content replacement/stale authorization 有明确 current behavior，违规则 FAIL。

## Runtime

- [ ] Principle 到 production exposure boundary；
- [ ] RuleCode 到 production host runtime/adapter boundary；
- [ ] block reason 到 consumer-visible boundary；
- [ ] corrected fixture first legal retry allow；
- [ ] positive control allow。

## Revocation

- [ ] live runtime 不重启即可观察 target effect disappear；
- [ ] revoke A 不误伤 B；
- [ ] fresh session 可作为补充；
- [ ] 不把 cognitive forgetting 当成 rollback 目标。

## Evidence

- [ ] historical approved digest 明确 KNOWN_GAP；
- [ ] historical executed digest 明确 KNOWN_GAP；
- [ ] exact Principle historical revision 明确 KNOWN_GAP；
- [ ] KNOWN_GAP 不得豁免 current authorization violation。

## Complexity

- [ ] no new runtime subsystem；
- [ ] no new durable source of truth；
- [ ] no new DB/schema for Safety Net；
- [ ] no generic scanner framework；
- [ ] no test registry；
- [ ] no writer registry；
- [ ] no long-running mutation framework。

---

# 17. Trinity Simplification Compatibility

Safety Net v1.2 必须允许：

```text
Dreamer task
→ Philosopher task
→ Scribe task
```

变成：

```text
PrincipleFormation lifecycle
```

之后：

## 应继续 PASS

```text
formal input reaches governable Principle
provenance remains verifiable
authorization remains correct
Principle exposure works
RuleCode governance works
runtime feedback works
revocation works
```

## 可以修改 setup

```text
formation model stub
runner-chain test fixture
current routing implementation
schema mapping
migration compatibility tests
```

## 如果这些“长期契约”因为阶段删除而必须保留旧结构才绿，说明 Safety Net 锁错对象

```text
Dreamer stage must exist
Philosopher artifact must persist
fixed edge set must remain
three tasks must be generated
```

这些不能成为 v1.2 invariant。

合格标准：

> **内部接线可以更新，Owner 可观察的行为断言无需削弱。**

---

# 18. Artifact Store Convergence Compatibility

未来如果：

```text
legacy artifacts
→ pi_artifacts
→ another canonical representation
```

Safety Net 应继续保护：

```text
identity
provenance
authorization
runtime behavior
```

而不是保护：

```text
表名
JOIN 路径
当前唯一索引
当前 envelope
```

store migration 可以改测试 setup。

不允许削弱价值行为断言。

---

# 19. Explicit Non-goals

v1.2 不做：

```text
完整 J3
全 topology convergence
全 writer 静态证明
multi-host parity 全覆盖
Rule interaction matrix
historical digest schema migration
Principle revision schema migration
generic Prompt analyzer
LLM quality benchmark
实时 causality metric platform
```

这些只有真实需要时再做。

---

# 20. Complexity Delta

| 项目 | v1.2 |
|---|---|
| New runtime subsystem | NO |
| New durable store | NO |
| New DB/schema | NO |
| New feature flag | NO |
| New network dependency | NO |
| New generic scanner | NO |
| New test registry | NO |
| New writer registry | NO |
| Thin test aggregator | YES |
| Focused deterministic fixtures | YES |
| Small missing contract tests | YES |
| One-time fault injection | YES |

目标：

```text
少量机械保护
→ 换取大胆删除内部复杂度的自由
```

---

# 21. Final Claim Boundary

当 Safety Net v1.2 全绿时，只允许声称：

> **当前选择的核心 Owner-governed intervention 机械契约，在确定性 merge-time 环境中保持连通。**

不能声称：

```text
installed runtime 一定正确
真实 OpenClaw 一定注册成功
真实 Agent 一定理解反馈
真实行为改善具有统计因果性
所有未知 writer 都不存在
所有 Rule 组合都安全
历史 approval/execution digest 已完整保存
```

这些属于：

```text
release/dogfood
或
future governance work
```

---

# 22. Final Recommendation

批准实施 Safety Net v1.2 的前提：

```text
1. Reality Check 先做 REUSE/EXTEND/NEW_MINIMAL 矩阵；
2. 优先选择现有有效测试，不重写已有保护；
3. 不用 Safety Net 顺手修 historical evidence schema；
4. current authorization bug 一旦被测试发现，必须单独作为真实 defect 处理；
5. Safety Net 完成后再进入 PRI-815 Trinity Simplification。
```

最终目的：

> **不是让 PD 的当前 Pipeline 永远不变，而是确保我们删除内部复杂度时，不会把 Owner 真正买单的价值闭环一起删掉。**
