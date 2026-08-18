# MVP Core Loop Contract — 权威语义基线

- 状态: **Accepted** (本轮 MVP 核心闭环收敛, 2026-08-18)
- 适用范围: Correction sensing / Internalization state machine / Owner governance
- 上游事实: `D:\pd-fact-audit\` (2026-08-17 全链事实审计)
- 地位: 本文档定义的 invariants 是本轮改造的验收语义基线。代码与本文冲突 = bug(除非本文标记为 deferred)。

产品边界(承 PRODUCT_IDENTITY / ADR-0014): PD 拥有 owner-reviewed、reversible 的行为内化闭环:
**Observe → Understand → Internalize → Verify/Repair → Govern → Activate → Observe Again**。

---

## INV-01 Correction Sensing 闭环

Owner correction 的正常路径:

```
Owner Message
  → Stage1 fast deterministic sensing (keyword scan, 同步零成本)
  → Stage2 semantic detection (LLM, 异步, 需要 typed structured output)
  → Correction Signal (STRONG/WEAK)
  → durable evidence (trajectory user_turns / pain_events)
  → Pain / diagnostician task
```

约束:
1. **Stage2 的 runtime contract 是 typed structured output**: 分类器经 `outputSchemaRef: signal-classification-output-v1` 从 RuntimeAdapter 获得 schema-validated 对象;legacy string payload 仅作 compatibility fallback。禁止 object→stringify→parse 的补丁路径作为 canonical。
2. semantic detector 不得结构性不可用(producer/consumer payload 形状必须匹配——ISSUE-001 类 bug 属于本 invariant 的违反)。
3. **learned correction cue 必须进入 production detection**: 检测侧词库 = seed ∪ learned(correction_keywords.json,由 KeywordOptimizationService 写入),且无需重启 OpenClaw 即生效(mtime 驱动 reload)。
4. LLM 不可用必须显式 degraded(`SIGNAL_LLM_DEGRADED*` 日志),不得静默表现为"系统正常但没有纠正"。
5. Empathy cue store 与 correction cue store 并存,不得因统一而破坏 empathy 降级路径(WEAK/GFI)。
6. 高精度 deterministic path 存在且有限: 仅 weight ≥ 高精度阈值(默认 0.7)的 correction 词可不经 LLM 直接触发 STRONG;FP 权重衰减(×0.8)是自然降级机制。

## INV-02 needs_revision (evaluator/rollout reviewer 决策语义)

`needs_revision` 的产品语义唯一: **MACHINE REVISION REQUIRED**。

它:
- 不是成功完成;
- 不是 Owner Approval 请求;
- 不是普通 failure;
- 不是 terminal orphan。

必须拥有**自动 revision 出边**(bounded,见 INV-07)。在同一时刻**不得**同时创建正常后继(rollout_reviewer)——runner 输出与状态迁移是单一决策(InternalizationTransitionDecision),不允许并行分支。

## INV-03 needs_human_review (人工注意队列)

`needs_human_review` 语义: **AUTOMATIC REPAIR EXHAUSTED / MACHINE NEEDS OWNER ATTENTION**。

它属于 Exception/Attention Queue,与 Activation Approval(机器已完成验证,等待授权)严格区分。Owner 至少能够: inspect / retry / revise / reject-archive。它必须有出边(retry = 重新入队),不得是 display-only 终态。

## INV-04 Rollout Reviewer 出边

```
approve_rollout → 自动 Activation Policy Dispatch(见 INV-06)
needs_revision  → revision loop(回到可修复 stage,见 INV-02/07)
reject          → rejected / no activation
```

**严禁** `needs_revision → require_approval`(CLI `mapRolloutDecision` 的旧映射已废除)。需要修改的评审结论不得伪装成正常审批进入 approval 队列。

## INV-05 Activation Authority

每一个真正进入 active/shadow/live 的行为改变必须可回答 **WHO AUTHORIZED THIS?**

authority ∈ {`owner`, `system_policy`}:
- 低风险(prompt/defer_archive)经 policy 自动激活 → authority=system_policy,不得标记为 Owner-approved;
- 高风险(code_tool_hook)经 Owner approve → authority=owner;
- skill 自动晋升(≥0.95)→ authority=system_policy。

prompt 注入标题不得对 system auto-activated artifact 声称 "OWNER-APPROVED"(中性标题 `ACTIVE BEHAVIOR DIRECTIVES` + 逐项 authority)。

## INV-06 Risk-based Governance(保留分层,不搞一刀切人工)

| 风险 | 渠道 | 路径 | authority |
|---|---|---|---|
| 低 | prompt / defer_archive | system policy auto-activate | system_policy |
| 中 | skill | 现有策略(≥0.95 自动晋升,否则 approval) | system_policy / owner |
| 高 | code_tool_hook | Owner Approval → SHADOW → Owner Promote → LIVE | owner |

- SHADOW 必须 observation-only(永不 block 真实调用);
- 禁止 approve 直接 live(两阶段安全模型不可删除);
- RolloutReviewer `approve_rollout` 后的 dispatch 必须自动发生(调用 ActivationDispatcher,非 shell CLI),幂等且 restart-safe(`${artifactId}::${channel}` idempotency key)。

## INV-07 State-machine liveness

每个非终态至少满足其一:
- A. 有自动 successor(revision/advance/dispatch);
- B. 有清晰的 Owner action(Console 可见 + 可操作)。

不允许: pending forever / needs_revision forever / needs_human_review 无出口 / validated but nowhere to go(rollout approve 后必须自动 dispatch)。

Revision budget: evaluator 侧沿用 repairIteration(2 轮上限);rollout 侧 revision 受 per-lineage budget 约束(复用 rejectionCount 三振 + revisionBudget 上限)。耗尽 → needs_human_review(INV-03)。

## INV-08 Idempotency / Restart Safety

所有 repair / approval / activation / promotion / migration:
- 可重复执行不产生重复副作用(idempotency key / INSERT OR IGNORE / dedupe by parentTaskId+kind+channel);
- OpenClaw restart 不得破坏状态机(所有状态在 durable store;内存 rate-limit 丢失可接受)。

---

## Owner Read Model(derived,非新真值库)

Console 的 Owner 视角是现有底层状态(evolution/ledger/candidates/artifacts/tasks/approvals/activations)的**确定性投影**,不是第五个状态数据库。Owner 生命周期视图:

```
OBSERVED → UNDERSTANDING → INTERNALIZING → REVISING → VALIDATED
  → WAITING_FOR_OWNER → SHADOW → LIVE
  |→ NEEDS_ATTENTION (repair exhausted)
  |→ FAILED / DISABLED
```

每条 Principle 必须能回答: currentStage / why / since / nextAutomaticAction / ownerActionRequired / ownerAvailableActions / authority / shadow-live / lineage / lastError。

## 两类 Owner Queue(不可混淆)

- **Queue A — Approval**: 机器已完成验证,行为改变待授权。Owner: Approve / Reject / Edit。
- **Queue B — Needs Attention**: 机器无法自行解决(repair 耗尽/schema 反复无效/lineage 不可解)。Owner: Inspect / Retry / Revise / Reject-Archive。

needs_revision / needs_human_review 永远不得进入 Queue A。

## 交付验收 Gate(摘要)

- **Gate A Correction**: Stage2 typed E2E 成功(真实 adapter);semantic correction 成功;learned cue 无需 restart 被 production detector 消费;non-correction 不误触发;degraded 可观测。
- **Gate B Internalization**: needs_revision 有出边;revision 时绝不 seed 正常后继;repair bounded;耗尽 → needs_human_review 且 Owner 可操作。
- **Gate C Rollout**: approve_rollout → auto policy dispatch;needs_revision → revision;reject → no activation;needs_revision 永不进入 approval。
- **Gate D Governance**: 低风险 system-policy provenance 正确;高风险 approve → shadow;shadow 不 block;promote → live 真实 block;deactivate 后 block 消失。
- **Gate E Owner Comprehension**: Console 每条 Principle 可回答 currentStage/why/action-required/available-action/affects-agent/authority/shadow-live;空态必须带解释 + next action。
