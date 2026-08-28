<!--
PR template policy:
- Agent sections: completed by the implementation agent.
- Owner Taste Audit: completed by the Owner; agent must not impersonate the Owner.
- Stable rule IDs are defined in AGENTS.md:
 mvp-q-* / rc-* / cli-* / antipattern-*.
-->

## Owner Review Card（agent 填）

### 1. Problem

本次核实到的真实问题是什么？

---

### 2. Before

修改前系统实际发生什么？

---

### 3. After

修改后系统发生什么？

---

### 4. Existing mechanism reused

本次复用了哪个既有 authority / module / subsystem？

---

### 5. Complexity Delta

* New durable source of truth: YES / NO
* New persisted schema/state: YES / NO
* New subsystem/service/background process: YES / NO
* New public abstraction/interface: YES / NO
* New runtime feature flag: YES / NO
* New cross-package dependency: YES / NO
* New host/platform-specific behavior: YES / NO
* New external/network capability: YES / NO

如有 YES，请解释为什么现有机制无法满足，以及为什么这是最小合理方案：

---

### 6. Verification

什么证据证明新行为正确？

---

### 7. Risk

当前仍有哪些主要风险？

---

### 8. Rollback / recovery

如何禁用、回滚或恢复？

---

### 9. Follow-ups

哪些相邻问题被有意排除在本 PR 之外？

---

---

## 产品意图（agent 填，Owner 确认）

* 对应 Linear issue: ___
* 解决的产品问题（一句话）: ___

### 是否触及产品边界

* [ ] 否
* [ ] 是，需要 Owner/maintainer 明确批准

说明：

---

### MVP Questions

#### `mvp-q-1-what-if-skip`

如果不做，会发生什么？为什么这是当前值得处理的问题？

---

#### `mvp-q-2-how-observed`

Owner / operator 如何观察它确实生效？

---

#### `mvp-q-3-how-disabled`

本次 rollback / disable / recovery strategy 是什么？

* [ ] existing flag/config
* [ ] existing deactivation/state transition
* [ ] backward-compatible revert
* [ ] new feature flag
* [ ] N/A — no meaningful runtime rollback requirement

说明：

---

> 新 feature flag 不是默认答案。只有独立 runtime disable 能提供真实风险控制时才新增。

#### `mvp-q-4-emotional-value`

* [ ] Owner-facing change
* [ ] N/A — internal engineering change

如 Owner-facing：

降低：

* [ ] 失控感
* [ ] 疲惫感
* [ ] 重复纠正感
* [ ] 信息过载
* [ ] 其他: ___

创造：

* [ ] 安心感
* [ ] 掌控感
* [ ] 沉淀感
* [ ] 清醒感
* [ ] 其他: ___

说明：

---

---

## 变更概览（agent 填）

### 变更类型

* [ ] 🐛 Bug 修复
* [ ] ✨ 新功能
* [ ] 📝 文档
* [ ] 🔧 重构 / architecture health
* [ ] 🧪 测试
* [ ] 🔒 Security / safety
* [ ] 📦 Build / dependency / release

### 高层变更

1. ---
2. ---
3. ---

### 影响范围

* [ ] principles-core
* [ ] host-runtime
* [ ] openclaw-plugin
* [ ] codex-adapter
* [ ] pd-cli
* [ ] pd-console
* [ ] pd-companion
* [ ] installer / install-layout
* [ ] website
* [ ] docs
* [ ] scripts / CI / tooling
* [ ] other: ___

---

## Verification Evidence（agent 填）

### Targeted verification

| Command / scenario | Result | Why it matters |
| ------------------ | ----------- | -------------- |
| ___ | PASS / FAIL | ___ |
| ___ | PASS / FAIL | ___ |

### Production-path evidence

本次是否验证了真实 consumer / wiring？

* [ ] 是
* [ ] 不适用

说明：

---

### Merge gate

* [ ] `npm run verify:merge` PASS
* [ ] 未通过，但确认是 pre-existing/environmental failure，并附证据

证据：

---

---

## Relevant ERR Patterns（0..N）

<!--
Read ERROR_PATTERN_INDEX.md and list only materially relevant entries.
Zero is valid.
Do not manufacture three entries to satisfy process.
-->

* ERR-___ — ___
* ERR-___ — ___

如无匹配：

`No materially relevant existing ERR pattern identified.`

### New reusable error lesson discovered?

* [ ] 否
* [ ] 是，已按 Error Experience policy 记录/更新

说明：

---

---

## Runtime Contract（条件性）

本 PR 是否处理以下不可信运行时数据？

* parsed JSON

* LLM output

* DB rows / diagnosticJson

* artifact metadata

* YAML/config input

* external host payload

* [ ] 否 — Runtime Contract N/A

* [ ] 是

如是，检查适用规则：

* [ ] `rc-1-treat-as-unknown`
* [ ] `rc-2-no-as-bypass`
* [ ] `rc-3-fail-loud-missing`
* [ ] `rc-4-validate-array-elements`
* [ ] `rc-5-object-hasown-not-in`
* [ ] `rc-6-lineage-consistency`
* [ ] `rc-7-loop-state-freshness`
* [ ] `rc-8-safe-serialization`
* [ ] `rc-9-no-silent-fallback`

遵守方式 / N/A 说明：

---

---

## CLI / Operator Gate（条件性）

* [ ] N/A — 未触及 CLI/operator contract
* [ ] 触及 CLI/operator contract

如适用：

* [ ] `cli-1-strict-json`
* [ ] `cli-2-exit-stops`
* [ ] `cli-3-negated-flags-parser-tests`
* [ ] `cli-4-dry-run-confirm-mutex`
* [ ] `cli-5-failure-no-mutation`
* [ ] `cli-6-output-next-action`
* [ ] `cli-7-test-wiring`

证据：

---

---

## BDD Impact（条件性）

本 PR 是否触及：

* MVP-Core Owner journey

* CLI/operator behavior

* existing `.feature` contract

* Owner-visible workflow already covered by BDD

* [ ] 否 — N/A

* [ ] 是

对应 `.feature`：

---

处理方式：

* [ ] observable contract unchanged
* [ ] intentionally updated; reason documented
* [ ] contract removed/paused with Owner approval

不得通过删除 `.feature`、禁用 scenario 或降低 observable expectation 让测试变绿。

---

## Core I/O Boundary（条件性）

本 PR 是否在 `packages/principles-core/src/` 新增/改变 runtime I/O？

* [ ] 否 — N/A
* [ ] 是

如是：

* owning responsibility: ___
* existing registered seam reused: ___
* new seam required: YES / NO
* `packages/principles-core/io-seam-registry.json` updated if required: YES / NO
* architecture/lint guards PASS: YES / NO

规则引用：

`antipattern-core-io`

---

## Feature Flag（条件性）

本 PR 是否新增 runtime feature flag？

* [ ] 否
* [ ] 是

如是：

* flag name: ___
* why existing control was insufficient: ___
* category/default: ___
* rollback purpose: ___
* lifecycle metadata updated when required: YES / NO
* production loader exercised by test: YES / NO
* flag-off behavior verified where relevant: YES / NO

---

## Cross-package Contract Audit（条件性）

本 PR 是否修改：

* shared schema/type

* store contract

* runtime protocol

* public package export

* shared default

* shared service signature

* [ ] 否 — N/A

* [ ] 是

受影响 consumer：

* ---
* ---
* ---

实际 consumer-path verification：

---

---

## Anti-pattern Review

检查是否存在以下推理：

* [ ] 无 `antipattern-future-extensibility`
* [ ] 无 `antipattern-completeness`
* [ ] 无 `antipattern-new-research`
* [ ] 无 `antipattern-adr-accepted`
* [ ] 无 `antipattern-review-missing`
* [ ] 无 `antipattern-prep-next-phase`
* [ ] 无 `antipattern-core-io`

如有命中但仍决定继续，请说明证据与 Owner/maintainer approval：

---

---

## Adversarial Self-review（agent 填）

* [ ] 没有根据 SPEC 假设代替代码事实
* [ ] 没有制造第二 source of truth
* [ ] 没有 speculative seam
* [ ] 没有不必要 shallow wrapper
* [ ] 没有扩大 PR scope
* [ ] production wiring 已核实
* [ ] tests 没有只测 helper 而漏掉真实 caller
* [ ] cross-package consumers 已检查
* [ ] failure / degraded paths 已检查
* [ ] 没有为了测试绿而弱化 contract
* [ ] 没有复活 retired architecture

Self-review finding / fix：

---

---

## Review Convergence（已有 PR 时填写）

* comments/reviews fetched: ___
* valid blockers fixed: ___
* deferred follow-ups: ___
* duplicates / misunderstandings: ___
* unresolved P0/P1: 0 / ___
* unresolved acceptance-blocking P2: 0 / ___

---

## 产品品味审计（Owner 填，agent 不得代填）

* [ ] 提醒方式是否克制？
* [ ] 是否降低 Owner 认知负担？
* [ ] 命名是否自然？
* [ ] 行为是否可理解、可观察？
* [ ] 错误路径是否给出有用 nextAction？
* [ ] 是否符合 PD 产品边界？
* [ ] 新概念是否真的值得 Owner 以后继续理解？

Owner notes：

---