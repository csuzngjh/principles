# 3-Arm Comparison Evaluation Report

**Date**: 2026-06-12T04:56:04.909Z
**Language Controlled**: zh-CN

## Model: SenseNova 6.7 Flash-Lite

### Headline Metrics

* **Arm 1 (Monolith baseline) average abstraction**: **4.07 / 5**
* **Arm 3 (Split pipeline) average abstraction**: **4.71 / 5** (Delta: **+0.64**)
* **Arm 3 completion rate**: **100%** (14/14 valid)
* **Arm 3 axiom fabrication count**: **0**

> [!WARNING]
> **RECOMMENDATION: NO-GO for SenseNova 6.7 Flash-Lite**
> The split pipeline did not satisfy all validation gates:
> - Abstraction Lift >= +0.7: ❌ (Actual: +0.64)
> - Zero Axiom Fabrication: ✅ (Actual: 0)
> - Completion Rate >= 85%: ✅ (Actual: 100%)

### 3-Arm Comparison Table

| Arm Name | Completion Rate | Average Abstraction | Avg Latency | Avg Total Score |
|---|---|---|---|---|
| Arm 1 (Monolith baseline) | 100% | 4.07 | 15.4s | 82 |
| Arm 2 (Grounded Monolith) | 100% | 4.14 | 13.5s | 78 |
| Arm 3 (Split pipeline) | 100% | 4.71 | 34.6s | 98 |

### Scenario-by-Scenario Detailed Results

| Scenario ID | RootCause Category | Arm 1 Abstraction | Arm 2 Abstraction | Arm 3 Abstraction | Arm 3 Axioms Tied |
|---|---|---|---|---|---|
| **R1** | Design | 1 | 1 | 5 | T-08, T-09 |
| **R2** | Design | 4 | 1 | 5 | T-05, T-09 |
| **R3** | Tooling | 4 | 4 | 5 | T-01, T-04, T-05, T-08 |
| **R5** | Design | 5 | 5 | 5 | T-01, T-05, T-08 |
| **R6** | Design | 4 | 4 | 4 | T-01, T-08, T-09 |
| **R7** | People | 5 | 5 | 5 | T-05 |
| **R8** | Assumption | 1 | 5 | 4 | T-05 |
| **R9** | Design | 4 | 4 | 5 | T-01, T-05 |
| **R10** | Design | 5 | 5 | 5 | T-01, T-08, T-09 |
| **R11** | Design | 5 | 5 | 4 | T-01, T-03, T-08 |
| **R12** | Design | 5 | 5 | 4 | T-01, T-08, T-09 |
| **R13** | Design | 5 | 5 | 5 | T-01, T-08, T-09 |
| **R14** | Tooling | 4 | 4 | 5 | T-05, T-09 |
| **R15** | Tooling | 5 | 5 | 5 | T-05, T-01 |

### Output Principles & Quality Comparison

#### R1 — PEAT-B1 PR #838: test绿灯遗漏生产路径副作用和不可达high-confidence upgrade，owner无法信任PR质量。证据：llm.ts triage后仍调用evalua...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "(None)"
* **Arm 3 Split**: "设计阶段应引入动态验证机制，避免静态配置导致的环境行为差异"

#### R2 — OpenClaw missed a valid outside-diff review comment in PR #840: after_tool_call still silently retur...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "Always reconcile all external feedback before declaring task completion."
* **Arm 3 Split**: "在任务完成前强制验证所有反馈项是否已处理，防止过早结束流程"

#### R3 — Tool edit failed on /project/packages/pd-cli/tests/commands/pain-evidence.test.ts; diagnos...
* **RootCause category**: `Tooling`
* **Arm 1 Monolith**: "在调用编辑工具前，必须验证目标文件状态与上下文完整性。"
* **Arm 3 Split**: "在执行高风险操作前验证必要上下文并设计容错机制，防止因条件缺失导致失败"

#### R5 — PR #852 CLI routing: pain retry 丢选项，canary 错调 handler，evidence 读错 log 路径。这是一个真实操作者信任失败。...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "建立CLI路由强契约设计规范"
* **Arm 3 Split**: "设计阶段应引入强契约约束与静态校验机制，防止参数传递与组件绑定的静默失败"

#### R6 — PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "重构状态机或枚举值时，必须同步更新所有依赖断言与集成测试，确保行为等价性承诺不被破坏。"
* **Arm 3 Split**: "在系统重构或状态变更时，必须同步验证所有依赖项的行为等价性，防止承诺破裂"

#### R7 — PRI-363 验收报告失真：标注 npm run test 通过（1727 passing），实际有 8 个测试失败（pain.test.ts 2条行为回归 + auto-entry-gate TC...
* **RootCause category**: `People`
* **Arm 1 Monolith**: "建立零容忍的测试状态传播机制，确保任何单点失败都能准确反映至最终验收结论。"
* **Arm 3 Split**: "确保关键验证流程中的状态准确传播，避免聚合掩盖局部失败"

#### R8 — PRI-363 在验收报告中标注 npm run test 通过（1727 passing），但实际有 8 个测试失败，包括 pain.test.ts 和 auto-entry-gate.test.t...
* **RootCause category**: `Assumption`
* **Arm 1 Monolith**: "(None)"
* **Arm 3 Split**: "生成状态报告时必须强制验证客观指标而非依赖启发式解析"

#### R9 — PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "重构状态机或枚举值时，必须保持行为等价性承诺。任何底层状态变更都需通过契约测试验证下游消费逻辑的兼容性。"
* **Arm 3 Split**: "系统变更时需验证行为等价性并同步更新依赖契约，防止静默回归"

#### R10 — PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "建立重构行为等价性审查规范，确保状态机或枚举变更时同步验证所有下游依赖路径与测试契约。"
* **Arm 3 Split**: "重构时应建立行为等价性保障机制，确保状态变更与契约测试同步更新，防止控制流偏离预期"

#### R11 — PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "建立重构行为等价性验证原则，确保状态机变更不破坏现有测试契约。"
* **Arm 3 Split**: "在系统重构或变更时，必须验证核心行为契约的等价性，确保下游依赖的兼容性"

#### R12 — PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "建立重构行为等价性保障原则"
* **Arm 3 Split**: "修改系统状态或结构时，必须通过契约测试验证对现有行为承诺的影响，确保副作用逻辑的等价性"

#### R13 — PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "建立严格的行为等价保障机制，确保状态机或枚举变更时下游契约同步演进。"
* **Arm 3 Split**: "系统重构时需建立状态变更与下游契约的同步演进机制，确保行为等价性验证贯穿全链路"

#### R14 — PEAT-5强模型GLM-5.1测试-双模型对比验证...
* **RootCause category**: `Tooling`
* **Arm 1 Monolith**: "建立诊断入口的上下文完整性校验规范，确保所有手动或CLI提交的请求必须绑定有效会话ID与基础行为快照。"
* **Arm 3 Split**: "系统设计需确保所有输入渠道的上下文完整性，以支持有效分析"

#### R15 — 测试GLM-5.1双模型配置-PEAT5验证...
* **RootCause category**: `Tooling`
* **Arm 1 Monolith**: "建立诊断数据的最小上下文契约，确保所有上报的痛点均携带可追溯的会话标识或明确的Agent交互日志。"
* **Arm 3 Split**: "关键操作需强制绑定可验证的上下文凭证，确保行为轨迹可追溯"

### Failure and Boundary Case Analysis

No failure cases. All 3 stages of Arm 3 successfully validated against their schemas across all tested scenarios.

---

## Model: DeepSeek V4 Flash

### Headline Metrics

* **Arm 1 (Monolith baseline) average abstraction**: **1.79 / 5**
* **Arm 3 (Split pipeline) average abstraction**: **4.14 / 5** (Delta: **+2.35**)
* **Arm 3 completion rate**: **93%** (13/14 valid)
* **Arm 3 axiom fabrication count**: **0**

> [!NOTE]
> **RECOMMENDATION: GO for DeepSeek V4 Flash**
> The split pipeline meets all criteria: abstraction lift >= +0.7, zero core axiom ID fabrication, and high completion rate. Proceed with the cutover plan (PRI-373).

### 3-Arm Comparison Table

| Arm Name | Completion Rate | Average Abstraction | Avg Latency | Avg Total Score |
|---|---|---|---|---|
| Arm 1 (Monolith baseline) | 93% | 1.79 | 19.4s | 21 |
| Arm 2 (Grounded Monolith) | 93% | 2.29 | 22.3s | 33 |
| Arm 3 (Split pipeline) | 93% | 4.14 | 66.9s | 84 |

### Scenario-by-Scenario Detailed Results

| Scenario ID | RootCause Category | Arm 1 Abstraction | Arm 2 Abstraction | Arm 3 Abstraction | Arm 3 Axioms Tied |
|---|---|---|---|---|---|
| **R1** | Design | 1 | 1 | 1 | None |
| **R2** | Design | 1 | 1 | 5 | T-05, T-08 |
| **R3** | Tooling | 1 | 1 | 5 | T-05 |
| **R5** | Design | 1 | 1 | 5 | T-03, T-05, T-08 |
| **R6** | Design | 4 | 1 | 5 | T-05, T-08 |
| **R7** | People | 1 | 1 | 4 | T-05, T-08 |
| **R8** | Assumption | 1 | 1 | 4 | T-03, T-05 |
| **R9** | Design | 1 | 4 | 5 | T-01, T-05, T-06 |
| **R10** | Design | 1 | 5 | 5 | T-01, T-08 |
| **R11** | Design | 5 | 5 | 1 | None |
| **R12** | Design | 5 | 5 | 4 | T-01, T-05, T-08 |
| **R13** | Design | 1 | 1 | 4 | T-01, T-05 |
| **R14** | Tooling | 1 | 4 | 5 | T-05, T-08 |
| **R15** | Tooling | 1 | 1 | 5 | T-05, T-08 |

### Output Principles & Quality Comparison

#### R1 — PEAT-B1 PR #838: test绿灯遗漏生产路径副作用和不可达high-confidence upgrade，owner无法信任PR质量。证据：llm.ts triage后仍调用evalua...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "(None)"
* **Arm 3 Split**: "(None)"

#### R2 — OpenClaw missed a valid outside-diff review comment in PR #840: after_tool_call still silently retur...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "(None)"
* **Arm 3 Split**: "在宣告任务完成前，系统地调和所有反馈和未解决项。"

#### R3 — Tool edit failed on /project/packages/pd-cli/tests/commands/pain-evidence.test.ts; diagnos...
* **RootCause category**: `Tooling`
* **Arm 1 Monolith**: "(None)"
* **Arm 3 Split**: "优先在自动化流程的关键操作前设置前置条件验证，以确保上下文完整性"

#### R5 — PR #852 CLI routing: pain retry 丢选项，canary 错调 handler，evidence 读错 log 路径。这是一个真实操作者信任失败。...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "(None)"
* **Arm 3 Split**: "在系统组件交互中，采用显式契约和自动验证机制，防止依赖隐式假设导致的静默失败。"

#### R6 — PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "核心状态枚举变更时，必须通过静态分析工具自动扫描所有引用点（含测试断言和集成逻辑），强制同步更新以维护行为等价性。"
* **Arm 3 Split**: "对系统行为契约的任何修改，都应自动触发依赖方的全面回归验证，以确保行为等价性不被无声破坏。"

#### R7 — PRI-363 验收报告失真：标注 npm run test 通过（1727 passing），实际有 8 个测试失败（pain.test.ts 2条行为回归 + auto-entry-gate TC...
* **RootCause category**: `People`
* **Arm 1 Monolith**: "(None)"
* **Arm 3 Split**: "聚合指标必须附带对底层细粒度失败信号的强制检验，以防止局部失败被总体成功掩盖。"

#### R8 — PRI-363 在验收报告中标注 npm run test 通过（1727 passing），但实际有 8 个测试失败，包括 pain.test.ts 和 auto-entry-gate.test.t...
* **RootCause category**: `Assumption`
* **Arm 1 Monolith**: "(None)"
* **Arm 3 Split**: "报告结论前必须强制基于客观、可验证的指标（如退出码）进行验证，而非依赖启发式解析。"

#### R9 — PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "(None)"
* **Arm 3 Split**: "修改具有系统级语义约束的抽象标识符时，优先通过自动化机制验证所有已知消费点的行为等价性，以确保下游兼容。"

#### R10 — PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "(None)"
* **Arm 3 Split**: "在演化内部实现时，应优先验证对外行为承诺的维持，而非仅关注结构正确性。"

#### R11 — PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "建立重构行为等价性验证原则，确保状态机变更不破坏现有测试契约。"
* **Arm 3 Split**: "(None)"

#### R12 — PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "建立重构行为等价性保障原则"
* **Arm 3 Split**: "修改系统状态时，必须通过行为等价性契约验证所有依赖该状态的副作用路径，确保变化不会意外破坏已有行为。"

#### R13 — PRI-363 重构后 pain.test.ts 出现行为回归：stage 枚举值从 gate_admitted/triage_evidence_only 改为 trigger_rejected，导致...
* **RootCause category**: `Design`
* **Arm 1 Monolith**: "(None)"
* **Arm 3 Split**: "对系统核心抽象（如枚举、状态机）的变更，必须通过行为等价性验证，确保所有下游契约同步演进，防止无意的行为回归。"

#### R14 — PEAT-5强模型GLM-5.1测试-双模型对比验证...
* **RootCause category**: `Tooling`
* **Arm 1 Monolith**: "(None)"
* **Arm 3 Split**: "优先显式验证关键前置条件，而非依赖隐含假设。"

#### R15 — 测试GLM-5.1双模型配置-PEAT5验证...
* **RootCause category**: `Tooling`
* **Arm 1 Monolith**: "(None)"
* **Arm 3 Split**: "确保每个接受关键输入的入口携带足够的上下文以重构因果链。"

### Failure and Boundary Case Analysis

#### R11 (Arm 3 Failed)
* **Error**: `Stage C (Router) failed validation: /rootCause: Expected required property (got undefined); /evidence: Expected required property (got undefined); /confidence: Expected required property (got undefined); /rootCause: Expected string (got undefined); /evidence: Expected array (got undefined); /confidence: Expected number (got undefined)`
* **Risk Analysis**: DeepSeek V4 Flash failed at the Stage C Router for Scenario R11. The model output was missing the required fields `rootCause`, `evidence`, and `confidence`, which caused schema validation to fail. This indicates that even with a strong model, the split pipeline carries a non-zero risk of structured schema failures in production (completion rate of 93%). A fallback mechanism to the monolith baseline or a retry/repair loop should be considered during cutover.

---

## Evaluation Limitations & Quality Risks

### 1. Corpus Distribution Skewness
The 14-scenario evaluation corpus is heavily skewed towards certain categories:
* **Design**: 9 samples (64.3%)
* **Tooling**: 3 samples (21.4%)
* **People**: 1 sample (7.1%)
* **Assumption**: 1 sample (7.1%)

Furthermore, Scenarios R14 and R15 are "PEAT-5/GLM double-model configuration validation" meta-test pains rather than actual user dogfood pain signals. While sufficient for a spike comparison, this sample skewness limits generalizability and should not be treated as a definitive validation across all root cause domains.

### 2. Heuristic Scoring Disclaimer
The `abstractionQuality` metric is a heuristic score based on a keyword-like exclusion list (penalizing rule leakage terms such as `always`, `never`, `.ts`, `.json`, `read_file`, `write_file`, etc.). It is highly valuable for evaluating comparative quality trends and detecting rule leakage, but it does **not** equal a human quality assessment.

---

## GO / NO-GO Verdict

Based on the evaluation of both weak and strong models:

* **DeepSeek V4 Flash Abstraction Lift**: **+2.35**
* **SenseNova 6.7 Flash-Lite Abstraction Lift**: **+0.64**

### **FINAL RECOMMENDATION: Owner override: strong-model-only GO**
While the weak model (SenseNova) did not meet the strict +0.7 lift threshold (+0.64), the strong model (DeepSeek) achieved a massive quality leap (+2.35) with zero axiom ID fabrication. Since production environments run on strong models, we recommend proceeding with the split pipeline cutover (PRI-373) specifically for strong models, while keeping the monolith baseline for weak models or implementing a feature flag to disable the split pipeline if issues arise.
