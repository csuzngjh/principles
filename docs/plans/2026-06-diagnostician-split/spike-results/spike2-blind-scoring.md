# Spike-2 Blind Abstraction Scoring

Score each Option A/B on the 1-5 abstraction scale:

| Score | Meaning |
|-------|---------|
| 1 | Specific code patch |
| 2 | Rule-level constraint |
| 3 | Scenario-level advice |
| 4 | Domain-level principle |
| 5 | Cross-domain abstraction |

---

## row-1: real/r1 × qwen3.6-27b
**Expected axiom**: T-03

| | Principle Text | Abstraction (1-5) |
|--|----------------|-------------------|
| Option A | Verify system integrity by validating observable runtime outcomes rather than assuming correctness from static code structure or mocked states. | _fill_ |
| Option B | Safety gates must dynamically evaluate runtime context; test suites must explicitly validate production path side effects to prevent silent bypasses. | _fill_ |

---

## row-2: real/r2 × qwen3.6-27b
**Expected axiom**: T-08

| | Principle Text | Abstraction (1-5) |
|--|----------------|-------------------|
| Option A | Enforce mandatory validation checkpoints that confirm full requirement satisfaction before permitting state transitions to completion, preventing premature closure driven by partial success assumptions. | _fill_ |
| Option B | Complete feedback convergence must precede any task closure or merge readiness declaration. | _fill_ |

---

## row-3: real/r3 × qwen3.6-27b
**Expected axiom**: T-03

| | Principle Text | Abstraction (1-5) |
|--|----------------|-------------------|
| Option A | Design systems to verify required state before execution, implementing graceful degradation for missing context rather than relying on implicit assumptions. | _fill_ |
| Option B | 工具执行前置校验原则：无明确上下文或轨迹缺失时，禁止盲目执行文件修改操作。 | _fill_ |

---

## row-4: real/r5 × qwen3.6-27b
**Expected axiom**: T-02

| | Principle Text | Abstraction (1-5) |
|--|----------------|-------------------|
| Option A | Institute explicit validation guardrails at every state transition to prevent silent degradation from unverified assumptions. | _fill_ |
| Option B | CLI路由设计必须遵循显式契约原则，所有参数传递与处理器绑定需具备强类型校验与失败快速反馈机制。 | _fill_ |

---

## row-5: real/r6 × qwen3.6-27b
**Expected axiom**: T-01

| | Principle Text | Abstraction (1-5) |
|--|----------------|-------------------|
| Option A | Validate structural changes against explicit behavioral contracts using empirical evidence, ensuring internal refactoring never silently breaks external expectations. | _fill_ |
| Option B | 状态枚举变更需强制同步更新全量依赖测试，保障行为等价性 | _fill_ |

---

## row-6: real/r7 × qwen3.6-27b
**Expected axiom**: T-03

| | Principle Text | Abstraction (1-5) |
|--|----------------|-------------------|
| Option A | Always ground status conclusions and automated summaries in verifiable raw data rather than superficial indicators or assumed defaults. | _fill_ |
| Option B | 验收报告必须严格映射底层测试执行结果，禁止使用聚合通过数掩盖局部失败或超时异常。 | _fill_ |

---

## row-7: real/r8 × qwen3.6-27b
**Expected axiom**: none

| | Principle Text | Abstraction (1-5) |
|--|----------------|-------------------|
| Option A | Validate input completeness before initiating processing to prevent deriving outcomes from absent or malformed data. | _fill_ |
| Option B | (no principle found) | _fill_ |

---

## row-8: synthetic/blast-radius-too-large × qwen3.6-27b
**Expected axiom**: T-07

| | Principle Text | Abstraction (1-5) |
|--|----------------|-------------------|
| Option A | Always verify dependencies and constrain modifications to the smallest necessary scope before execution to prevent unintended side effects and reduce blast radius. | _fill_ |
| Option B | Always apply the principle of least modification: restrict changes to the smallest set of files necessary to resolve the issue. | _fill_ |

---

## row-9: synthetic/irreversible-change × qwen3.6-27b
**Expected axiom**: T-04

| | Principle Text | Abstraction (1-5) |
|--|----------------|-------------------|
| Option A | Enforce contextual verification and protective constraints prior to executing high-impact or irreversible operations to prevent unintended destructive outcomes. | _fill_ |
| Option B | Enforce branch protection validation before executing destructive version control operations to prevent irreversible data loss. | _fill_ |

---

## row-10: synthetic/no-memory-externalization × qwen3.6-27b
**Expected axiom**: T-10

| | Principle Text | Abstraction (1-5) |
|--|----------------|-------------------|
| Option A | Persist intermediate findings to disk during multi-step tasks to preserve context and enable iterative review. | _fill_ |
| Option B | Externalize intermediate findings and state beyond volatile working memory to preserve continuity across extended or complex workflows. | _fill_ |

---

## row-11: synthetic/no-task-division × qwen3.6-27b
**Expected axiom**: T-09

| | Principle Text | Abstraction (1-5) |
|--|----------------|-------------------|
| Option A | Decompose complex system transformations into incremental, independently verifiable phases to prevent cascading failures and maintain control over change scope. | _fill_ |
| Option B | Always decompose complex migrations into isolated, testable increments before execution. | _fill_ |

---

## row-12: synthetic/over-engineering × qwen3.6-27b
**Expected axiom**: T-06

| | Principle Text | Abstraction (1-5) |
|--|----------------|-------------------|
| Option A | Always implement the simplest solution that satisfies the immediate requirement; defer extensibility until explicitly requested or proven necessary. | _fill_ |
| Option B | Calibrate implementation complexity strictly to the immediate problem scope, avoiding premature abstraction and defaulting to the simplest viable approach. | _fill_ |

---

## Summary

After scoring all rows, de-anonymize using spike2-key.json.

| Metric | Arm 1 (Monolith) | Arm 3 (Split) | Delta |
|--------|------------------|---------------|-------|
| Average abstraction | _fill_ | _fill_ | _fill_ |
| Rule-like leakage | _fill_ | _fill_ | _fill_ |
| Axiom accuracy | _fill_ | _fill_ | _fill_ |

## Split GO / NO-GO

GO criteria (ALL must hold):
- Arm 3 avg abstraction >= Arm 1 + 0.7
- Arm 3 rule-like-leakage materially lower than Arm 1
- Lift is larger for weak model (qwen3.6-27b) than strong model (deepseek-v4-flash)
- Stage A root-cause quality does not regress

- [ ] **GO** — Build T-F + T-G (split pipeline)
- [ ] **NO-GO** — Ship only async + grounding + Q2 unify; defer T-F/T-G

Rationale: _fill_