# PD Pipeline Safety Net v1.2 — Backend Execution Instructions
## 单 Session 实施任务：Reality Check → 最小实现 → Fault Injection → CI 接线 → PR 交付

> **Authoritative SPEC**: `PD_PIPELINE_SAFETY_NET_V1_2_FINAL_CANDIDATE.md`  
> **Repository**: `csuzngjh/principles`  
> **Verified main at handoff**: `45e115363a8ac1aed30a42f0c027ca07032af791`  
> **Execution mode**: 一个后端执行 AI 长 Session，自主完成到 PR Review-ready  
> **Core principle**: **Connection Before Creation / 先看清，再动手**

---

# 0. Mission

实施 `PD Pipeline Safety Net v1.2`。

本任务不是重新设计 PD Pipeline，也不是继续 Episode 002。

目标是把已经真实跑通的 Owner-Governed Intervention Lifecycle，固化成**最小、确定性、merge-time 可运行的机械安全网**，以便后续大胆进行 Trinity Simplification / Artifact Store Convergence，而不把核心价值闭环重新弄断。

你必须从 Reality Check 开始，但**不要停在调查报告**。

若没有触发明确 STOP 条件，应继续：

```text
Reality Check
→ Reuse Matrix
→ 最小实施
→ targeted tests
→ fault injection
→ CI / merge gate wiring
→ verify
→ PR
→ Linear 更新
→ Owner Review Card
```

不要等待 Owner 在中间逐步确认普通实现细节。

---

# 1. 开工前同步

先执行：

```bash
git fetch origin
git status
git rev-parse origin/main
```

以执行时的最新 `origin/main` 为真实基线。

若 main 已领先 handoff SHA：

```text
45e115363a8ac1aed30a42f0c027ca07032af791
```

重新核对相关代码和测试事实，不要假设旧行号仍成立。

创建独立 worktree / branch，遵循仓库现有开发流程与 lease 机制。

不要直接在主工作区实施。

---

# 2. 先读这些权威材料

至少阅读：

```text
PD_PIPELINE_SAFETY_NET_V1_2_FINAL_CANDIDATE.md

docs/specs/PD_CORE_VALUE_PIPELINE_GOVERNANCE_SPEC.md

docs/audit/pri-807-phase0/
  BASELINE.md
  SYNTHESIS.md
  PROTECTION_GAP_MATRIX.md
  LINEAGE_CHAIN.md
  TOPOLOGY.md
  HOST_CAPABILITY_MATRIX.md
```

以及 current main 上相关生产代码和现有测试。

SPEC 是目标约束。

代码是 current fact。

Audit 是事实种子，不是不可变真理。

如果 SPEC 与 current main 冲突：

```text
先核实 current main
→ 判断是 SPEC drift 还是代码缺陷
→ 不得为了符合文档而强行改正确代码
```

---

# 3. Linear 治理

先检查 PRI-807 及其现有子工单。

原则：

```text
已有工单覆盖 → 复用
没有实施工单且确有必要 → 创建一个最小子工单
```

不要为 C0/C1/C2/J1/J2/J4 分别建多个工单。

本次是一轮 Safety Net v1.2 实施，应尽量保持单一实施工单 / 单 PR。

Linear 全中文。

不得删除旧工单。

不得改动 Episode 002 已关闭结论。

---

# 4. Phase A — Reality Check / Reuse Matrix

先只读调查现有资产。

必须输出一张：

```text
SAFETY_NET_REUSE_MATRIX
```

每项只允许四种分类：

```text
REUSE
EXTEND
NEW_MINIMAL
DO_NOT_BUILD
```

至少核查以下资产：

```text
formation runner-chain tests
internalization input/bridge tests
OUTPUT_SCHEMA_REGISTRY tests
routing / CHANNEL_EDGES tests
owner-review / stale-review tests
activation-dispatcher tests
approval queue / approval completion tests
promotion-readiness tests
rulecode-owner-decision-service tests
sqlite-activation-safety-store tests
recovery-to-shadow tests
production host-runtime tests
OpenClaw host adapter block/blockReason mapping tests
RuleHost cache invalidation / deactivation tests
Principle prompt activation/exposure tests
synthetic shadow telemetry fixtures
current vitest include globs
CI workflow jobs
verify:merge
package.json scripts
```

特别回答：

```text
1. 哪些 v1.2 invariant 已经由现有测试直接保护？
2. 哪些只缺“接到统一执行入口”？
3. 哪些现有测试其实从未被 Vitest/CI 收集？
4. 哪些 test 只测 helper/mock，没有打到 production boundary？
5. 哪些新增测试是真正不可避免的？
```

---

# 5. Reality Check 后的执行原则

不要机械实现 SPEC 每一节。

优先级：

```text
REUSE existing behavioral test
>
EXTEND existing production-boundary test
>
NEW_MINIMAL focused test
>
禁止新 framework
```

如果现有测试已经完整证明某 invariant：

```text
不要重写一个“Safety Net 专用版本”
```

只把它接入正式 Safety Net command。

---

# 6. C0 — Safety Net 自己必须真的运行

这是第一实施优先级。

实现薄命令：

```bash
npm run check:pipeline-contract
```

要求：

```text
无网络
无 API key
无真实 LLM
无真实 OpenClaw 安装要求
无 production workspace mutation
deterministic
失败返回 non-zero
```

它只负责：

```text
选择已有 focused tests
执行
传播退出码
打印最小摘要
```

禁止：

```text
新测试注册表
新结果数据库
新 DSL
新 scanner framework
新 generic AST framework
```

必须机械证明 Safety Net 选择的每个测试实际被 test runner 收集。

如果发现现有目标测试位于 Vitest include 之外：

优先修正正确测试发现路径。

不要用额外 shell 直接绕过错误 test config，把长期 discoverability 问题藏起来。

---

# 7. INV-01 — 正式输入必须形成可治理 Principle

必须有至少一条 deterministic test：

```text
正式 production input
→ production formation wiring
→ governable Principle
```

允许 stub：

```text
LLM/model result
```

禁止直接预制：

```text
最终 Principle artifact
全部中间 task
全部 lineage
```

测试的意义是防：

```text
formation production wiring 断掉
但后续 artifact-level tests 全绿
```

断言：

```text
最终 Principle 存在
来源可回链
可进入现有 governance path
无效模型输出 fail loud
```

禁止断言：

```text
必须 Dreamer
必须 Philosopher
必须 Scribe
必须三阶段
```

优先复用现有 runner-chain / live-runner-chain 测试。

---

# 8. INV-02 — Identity / Provenance 不得靠猜

保护 current producer→consumer relationship。

至少包含：

```text
canonical Pain provenance
→ formation / diagnosis bridge
→ Principle identity

Principle UUID
→ Rule.source_principle_id

Rule artifact
→ approval
→ activation
→ runtime intervention identity
```

重要：

```text
canonical pain_host_* ID
≠
internal derivedFromPainIds UUID
```

不要为了测试把两个命名空间强行统一。

测试应验证：

```text
bridge 可核验
```

而不是字符串相等。

所有缺失 / mismatch 必须：

```text
fail loud
或 explicit unavailable
```

禁止 fallback：

```text
title
latest row
timestamp proximity
```

---

# 9. INV-03 — Authorization Boundary

必须区分：

```text
authority=owner
authority=system_policy
```

不要把 Owner-governed 错写成“所有 activation 都必须人工批准”。

至少复用/补齐以下 current behavior：

```text
Owner-required path:
无有效 Owner approval
→ 不得产生 Owner-authorized effect

Policy path:
system_policy 只能按现有低风险 policy 生效
→ 不得冒充 owner
→ 不得升级成 Owner-only 权限

Observation:
readiness / telemetry / shadow evidence
→ 不得自动产生 promote authority
```

如果 current test 发现：

```text
ready 自动变 live
```

必须 FAIL。

---

# 10. INV-04 — Governance 不能重复增权 / 恢复增权

优先复用真实 service/store tests。

必须覆盖：

```text
duplicate commit 不产生第二份权限
stale request 不能覆盖更新后的 revoke/decision
commit 时重新核对 current control state/version
recovery 不得直接恢复到 live authority
recovery 最多回到 current contract 允许的安全状态
```

完整 J3 可以不做。

但：

```text
recovery must not escalate authority
```

必须进入 v1.2。

---

# 11. INV-05 — 必须走到真实 runtime consumer boundary

## Principle

至少走到当前 production：

```text
prompt activation / exposure boundary
```

确保：

```text
正确内容被注入
正确 authority 被标记
unknown authority 不冒充 Owner
```

Principle Receipt 不是必经节点。

不要为了 Safety Net 强制开启 receipt flag。

## RuleCode

J2 不能止步于：

```text
RuleHost.evaluate()
```

至少走到：

```text
production host-runtime / host adapter callable boundary
→ host-visible block / allow
→ consumer-visible reason
```

OpenClaw 当前具体 adapter 可以作为 current implementation test，但不要把其私有 event format 固化成长期 contract。

无需启动真实 OpenClaw process。

---

# 12. Current Content Authorization — 最关键负例

必须调查并明确 current behavior：

```text
review / authorize artifact A
→ authoritative artifact content 被替换/覆盖成 B
→ 旧 authorization 是否还能让 B 生效？
```

这里严格分类：

```text
如果当前会静默让 B 生效
→ REAL DEFECT / FAIL

如果 current code 明确拒绝 / 要求重新授权
→ PASS

如果现有测试和静态事实仍无法证明
→ UNVERIFIED
```

禁止写成：

```text
KNOWN_EVIDENCE_GAP
```

历史缺少 approved/executed digest 才是 KNOWN_GAP。

如果发现真实 defect：

创建/更新一个最小 Linear defect。

允许在本 Session 内做最小修复，前提是：

```text
不新增第二套 artifact authority
不新建 schema 只为了填历史
不扩大到 Artifact Store 全面重构
```

如果修复需要改变 artifact identity/revision architecture 或大规模 migration：

STOP，交 Owner 裁决。

---

# 13. J1 — Principle Golden Journey

目标：

```text
formal input
→ formation
→ governable Principle
→ valid authority
→ activation
→ production prompt exposure
```

Negative 至少包含：

```text
Owner-required path without Owner approval
→ no Owner-authorized exposure

system_policy path
→ authority=system_policy
→ not owner

current content replacement
→ current authorization contract enforced
```

Revocation：

```text
same/live runtime
→ deactivate A
→ next exposure no longer includes A
```

不要只通过 fresh session 证明。

---

# 14. J2 — RuleCode Golden Journey

允许在 temp workspace deterministic 构造：

```text
LLM output
shadow observations
>= readiness threshold fixture
```

但必须走真实：

```text
readiness reader
promotion authority
activation state transition
production host runtime / adapter boundary
```

Journey：

```text
Rule artifact
→ evaluation
→ authorization
→ shadow
→ readiness
→ explicit promotion
→ illegal action BLOCK
→ host-visible reason
→ deterministic prerequisite correction
→ first legal retry ALLOW
→ positive control ALLOW
```

不要永久使用 run15 的：

```text
baseline/hash
```

作为 Safety Net 系统契约。

fixture 只需要一个简单 deterministic prerequisite。

---

# 15. J4 — Precise Revocation

至少验证目标 intervention A。

优先加入第二 intervention B。

```text
A active
B active
revoke A
→ same live runtime next call
→ A effect disappears
→ B remains
```

若当前 fixture 难以同时运行两条 Rule：

至少 Principle 路径或 Rule 路径之一必须证明 A/B precision。

另一条可以保留单规则 fixture。

只有单规则 fixture 才可断言：

```text
no_rules_armed
```

禁止把 `no_rules_armed` 作为全局 revoke contract。

---

# 16. KNOWN_EVIDENCE_GAPS — 只报告，不顺手修

必须保留：

```text
approved historical artifact digest = KNOWN_GAP
executed historical artifact digest = KNOWN_GAP
exact Principle historical revision digest = KNOWN_GAP
```

本任务禁止仅为了这些 gap：

```text
加 DB column
做 migration
修改 production event schema
回填历史记录
```

这些属于后续 identity/history governance。

但再次强调：

```text
KNOWN_GAP
不能豁免 current authorization bug
```

---

# 17. Mutation Authority 的证明边界

不要试图声称：

```text
Safety Net 能发现任意未知第二 writer
```

这无法由有限 behavior tests 证明。

本轮目标：

```text
已知 production entrypoints
→ canonical service
→ same validation
→ same idempotency
→ same current-state semantics
```

主方法：

```text
service-level behavioral contract
```

必要时加一个很小的 wiring assertion。

不要新增：

```text
writer registry
全仓 SQL scanner
AST architecture framework
```

---

# 18. Fault Injection — 必须做，但只做一次性验收

完成实现后，在临时 branch/worktree 对正式 Safety Net 做受控 mutation。

至少：

### FI-1 Contract ref

破坏一个 production schema ref：

```text
期望 Safety Net 红
```

### FI-2 Formation wiring

断开正式 input → formation：

```text
期望 J1 / formation guard 红
```

### FI-3 Authorization

制造 stale/mismatched authorization：

```text
期望 authorization guard 红
```

### FI-4 Host feedback mapping

破坏：

```text
deny → host-visible blockReason
```

映射：

```text
期望 J2 红
```

### FI-5 Revocation

让 revoke 后缓存中的 A 继续执行，或让 revoke A 误删 B：

```text
期望 J4 红
```

每个 probe：

```text
记录失败 test
记录错误信息
立即 revert mutation
重新跑回绿
```

禁止建设长期 mutation-testing framework。

---

# 19. CI / Merge Gate

Reality Check 后选择最轻接法。

目标：

```text
npm run check:pipeline-contract
```

必须在正式 CI / merge verification 路径执行。

避免：

```text
为了 Safety Net 再跑整个 monorepo 全量 test 两遍
```

优先 focused test selection。

完成后证明：

```text
fresh worktree
→ npm run check:pipeline-contract
→ PASS
```

以及：

```text
故意破坏
→ command non-zero
```

如果直接接入 `verify:merge` 合适：

接入。

如果 CI 已有更正确、不会重复的大门：

可以接入该正式 required path。

但必须留下清楚证据：

```text
PR 合并时它一定会运行
```

---

# 20. Release/Dogfood 不属于本 PR 的实时执行要求

本 PR 不需要：

```text
真实 LLM
真实 OpenClaw Agent
重新跑 EP002
production promote
```

但必须在文档/测试 claim 中明确：

Merge Safety 不能证明：

```text
packaged runtime 正确
installer 正确
loaded process 正确
真实 hook 注册正确
真实 Agent 理解反馈
真实行为改善
```

如果本 PR 修改了：

```text
installer
packaging
runtime pin
hook registration
host adapter production semantics
```

则 scope 已异常扩大。

除非是修复本任务发现的真实 blocker，否则 STOP。

---

# 21. Complexity Guard

最终 Complexity Delta 目标：

```text
New runtime subsystem = NO
New durable source of truth = NO
New DB/schema = NO
New feature flag = NO
New external dependency = NO
New scanner framework = NO
New test registry = NO
New writer registry = NO
New mutation framework = NO

Thin command = YES
Focused fixtures = YES
Focused missing tests = YES
CI wiring = YES
```

如果实现开始演化成：

```text
“Safety Net 平台”
```

立即收缩。

---

# 22. 测试要求

实施过程中不要一开始就跑所有测试。

顺序：

```text
affected focused tests
→ check:pipeline-contract
→ affected package suites
→ verify:merge
```

然后根据 CI 需要补跑。

若测试失败：

```text
先判断是 regression 还是历史 flaky / test discovery bug
```

不要直接删测试或放宽 assertion。

---

# 23. PR 要求

尽量单 PR。

PR title 建议：

```text
test(pri-807): add Pipeline Safety Net v1.2 merge-time guards
```

PR 描述必须包含：

```text
Problem
Before
After
Reused mechanisms
Complexity Delta
Safety Net claim boundary
Known evidence gaps
Tests
Fault injection results
Trinity compatibility
```

特别写明：

```text
这不是新的 runtime framework。
```

---

# 24. Code Review 前自审

提交 PR 前，自行核对：

```text
有没有重复已有测试？
有没有锁死 Dreamer/Philosopher/Scribe？
有没有锁 DB table / schema key snapshot？
有没有把 system_policy 错当 Owner？
有没有把 historical gap 当 current security exemption？
有没有只测 RuleHost helper 而没到 host adapter？
有没有只用 fresh session 做 revoke？
有没有让 Safety Net 自己不在 CI 跑？
有没有新造第二套 authority？
```

任一 YES：

先修正。

---

# 25. Linear 更新

完成 PR 后，把关键事实更新到 PRI-807 或本轮唯一实施子工单。

必须记录：

```text
Reuse Matrix
真正新增了哪些测试
真正复用了哪些测试
C0 如何证明会执行
J1/J2/J4 覆盖边界
Fault Injection 结果
Known Evidence Gaps
Complexity Delta
PR URL
```

不要因为 PR 创建就提前把父 Epic PRI-807 整体 Done。

只关闭实际完成的实施工单。

---

# 26. STOP Conditions

只有以下情况需要停止并交 Owner：

1. 发现 current authorization 真实允许：
   ```text
   artifact content replacement
   → old authorization silently gains authority
   ```
   且最小修复要求 artifact store / revision architecture 大改；

2. 必须新增 DB/schema 才能实现 Safety Net 基本 contract；

3. 需要新增第二 mutation authority / writer；

4. 必须改变现有 Owner vs system_policy 产品政策；

5. current main 与 v1.2 的核心价值契约存在根本冲突；

6. 需要修改 production installer / release topology 才能完成 merge-time Safety Net；

7. 发现 Safety Net 正确实现会要求保留 Dreamer/Philosopher/Scribe 固定拓扑。

普通测试缺口、wiring 缺口、fixture 缺口、CI wiring 问题：

```text
不要 STOP
```

自行完成。

---

# 27. Final Owner Review Card

最后只输出一张：

```text
PIPELINE_SAFETY_NET_V1_2

BASE_SHA =
HEAD_SHA =
LINEAR =
PR =

REALITY_CHECK =
REUSE =
EXTEND =
NEW_MINIMAL =
DO_NOT_BUILD =

C0_TEST_EXECUTION = PASS / FAIL
FORMATION_WIRING = PASS / FAIL
PROVENANCE_IDENTITY = PASS / FAIL
AUTHORIZATION_BOUNDARY = PASS / FAIL
GOVERNANCE_IDEMPOTENCY_RECOVERY = PASS / FAIL
RUNTIME_CONSUMER_BOUNDARY = PASS / FAIL
PRECISE_REVOCATION = PASS / FAIL

J1 = PASS / FAIL
J2 = PASS / FAIL
J4 = PASS / FAIL

FAULT_INJECTION_FI1 = PASS / FAIL
FAULT_INJECTION_FI2 = PASS / FAIL
FAULT_INJECTION_FI3 = PASS / FAIL
FAULT_INJECTION_FI4 = PASS / FAIL
FAULT_INJECTION_FI5 = PASS / FAIL

KNOWN_EVIDENCE_GAPS =
- approved historical digest
- executed historical digest
- exact Principle historical revision

NEW_DEFECTS =
TRINITY_COMPATIBILITY = PASS / FAIL
COMPLEXITY_DELTA =

CHECK_PIPELINE_CONTRACT =
VERIFY_MERGE =
CI =

FINAL_VERDICT =
```

成功时：

```text
FINAL_VERDICT =
Pipeline Safety Net v1.2 implemented.
Core merge-time contract protected.
No runtime architecture added.
Ready for Owner review and, after merge, PRI-815 Trinity Simplification.
```

---

# 28. 最后一条纪律

本 Session 的价值不是：

```text
新增多少测试
```

而是：

```text
用最少的新机制
把真正已经跑通的价值边界锁住
```

如果 80% 可以靠选择、连接、加强现有测试完成：

这比重新写一个漂亮的新 Safety Net test suite 更正确。
