# PD Core Value Pipeline Governance SPEC — v0.3 Snapshot 归档

> **性质**：Current Snapshot 归档，**不是**长期契约。
> **来源**：自 `docs/specs/PD_CORE_VALUE_PIPELINE_GOVERNANCE_SPEC.md` v0.3 → v0.4（PRI-909，2026-09-24）迁移的章节，内容逐字保留、未改写。
> **迁移原则**：长期 SPEC 描述 invariant；Audit 描述 snapshot（SPEC v0.4 §27/§28）。移出章节的编号在 SPEC 中保留空位、不复用。
> **移出理由**：以下章节均为 PRI-803 冲刺专属契约或当时的工程快照；PRI-803 已收官，继续留在长期 SPEC 会误导后续读者把当前实现当作永久契约。

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
