# RuleHost MVP 可用化：从文本原则到可执行约束

> Status: Draft for owner review.
>
> 基于 2026-06-17 grill-with-docs 会话中达成的全部设计决策。

## Problem Statement

PD 的内化管线（diagnostician → dreamer → scribe → artificer → evaluator）能够产出高质量的"原则文本"（principle artifact），但这些原则只能通过 **prompt 通道**（注入到 agent 的系统提示词）来影响行为。

第二条通道 **code_tool_hook**（RuleHost）虽然在架构上已就绪（vm sandbox、gate.ts 拦截、RuleHostWriter.canActivate 验证链），但存在一个数据断层：**没有任何 runner 产出 `artifactKind: 'rule'` 且包含 `implementationCode` + `goldenTrace` 的 artifact**。

Artificer 产出的是 `artifactKind: 'principle'`（实施计划文档），Trainer 虽然写 `artifactKind: 'rule'` 但被限制在 `model_training` channel（MVP-Gone），且其输出也不含 `implementationCode`。

结果：RuleHost 在 MVP 阶段完全无法自动化工作。agent 的行为约束只能靠 LLM 阅读提示词后的"自觉"，无法程序化地拦截、修正或阻断工具调用。

## Solution

扩展 Artificer 使其在产出实施计划的同时生成可执行的 `evaluate()` 函数代码和 golden trace 测试用例。将 Evaluator 从 MVP-Quiet 移回 MVP-Core，扩展其审查范围覆盖代码质量。Evaluator 批准后，在其 succeedTask() 中执行 golden trace sandbox replay 并组装 rule artifact。

最终管道：

```
pain → diagnostician → dreamer → scribe → artificer(plan+code+cases)
                                                  ↓
                                    ┌──────── evaluator ────────┐
                                    │  passive review (3维)     │
                                    │       ↓ 通过              │
                                    │  adversarial attack       │
                                    │  (生成对抗用例)           │
                                    │       ↓                   │
                                    │  sandbox replay 对抗用例  │
                                    └────────┬──────────────────┘
                                        ↙    ↓     ↘
                                  approved  needs_rev  rejected
                                     ↓      (≤2轮对抗)    ↓
                            rule artifact    ↓          terminate
                                     回artificer      (prompt通道
                                     (带攻击反馈)      仍可用)
                                     ↓
                              owner approve
                                     ↓
                           RuleHost loads → gate.ts enforces
```

## User Stories

1. As a PD 系统维护者, I want Artificer to generate `implementationCode` alongside the implementation plan, so that the principle-to-rule pipeline is fully automated without manual code injection.
2. As a PD 系统维护者, I want Artificer to generate golden trace test cases alongside the code, so that every generated rule has automated correctness verification.
3. As a PD 系统维护者, I want Evaluator to review the generated code for intent consistency (代码逻辑是否匹配 principle 文本), so that misaligned rules are caught before activation.
4. As a PD 系统维护者, I want Evaluator to review the generated code for scope precision (匹配条件是否过度宽泛或狭窄), so that rules don't produce excessive false positives or false negatives.
5. As a PD 系统维护者, I want Evaluator to review the golden trace cases for coverage (测试用例是否覆盖 principle 描述的关键场景), so that sandbox replay is meaningful.
6. As a PD 系统维护者, I want Evaluator to run sandbox replay (evaluateRefinerRuleHostGate) on approved code, so that runtime errors and timeout issues are caught before the rule enters the activation queue.
7. As a PD 系统维护者, I want the rule artifact to be written as `artifactKind: 'rule'` with correct content structure, so that existing RuleHostWriter.canActivate can process it without modification.
8. As a PD 系统维护者, I want `needs_revision` decisions to trigger up to 2 rounds of adversarial feedback with Artificer retry, so that code gaps are fixed iteratively and don't waste the entire upstream pipeline cost.
9. As a PD 系统维护者, I want `rejected` decisions to terminate the code path while keeping the principle artifact available for prompt channel, so that valuable principles aren't lost just because code generation failed.
10. As a PD 系统维护者, I want the rule artifact to carry `ruleHostGateDecision: 'accepted_shadow'` after successful sandbox replay, so that the existing shadow-mode activation flow is preserved.
11. As an OpenClaw 用户, I want RuleHost to automatically load and enforce rules generated from my pain events, so that agent behavior is constrained programmatically without me manually writing evaluate() functions.
12. As an OpenClaw 用户, I want to see the generated code and golden trace in the PD console before approving activation, so that I can exercise owner governance over automated behavior changes.
13. As a PD 系统维护者, I want the Evaluator's code review output to be structured and stored in the artifact, so that debugging failed reviews is possible without re-running LLM calls.
14. As a PD 系统维护者, I want the Artificer retry (on `needs_revision`) to include the Evaluator's specific concerns in its prompt, so that the retry is targeted rather than a blind regeneration.
15. As a PD 系统维护者, I want Artificer to use an L2 write-test-fix loop (generate code → sandbox replay → fix on failure → retry up to 3 times), so that transient code errors are self-corrected before reaching Evaluator.
16. As a PD 系统维护者, I want the sandbox replay error feedback (caseId, errorType, message) to be injected back into Artificer's prompt on failure, so that the LLM can make targeted corrections instead of blind regeneration.
17. As a PD 系统维护者, I want Artificer to gracefully degrade to V1 output (plan only, no code) when all 3 L2 attempts fail, so that the principle text is never lost due to code generation failure.
18. As a PD 系统维护者, I want Evaluator to generate adversarial test cases after passive review passes, so that gaps between the principle text and the code's actual behavior are proactively exposed.
19. As a PD 系统维护者, I want adversarial cases to cover three attack types (boundary/omission/inversion), so that the code is tested against edge cases, missing conditions, and precision inversions.
20. As a PD 系统维护者, I want the adversarial loop to run up to 2 rounds with Artificer retry on failure, so that code gaps are fixed iteratively rather than accepted with hidden weaknesses.
21. As a PD 系统维护者, I want adversarial cases to be executed via the existing sandbox replay infrastructure (evaluateRefinerRuleHostGate), so that no new execution environment needs to be built.

## Implementation Decisions

### Decision 1: ArtificerOutputV1 → V2 Schema 演进

Artificer 的输出 schema 增加三个字段：

```typescript
interface ArtificerOutputV2 extends ArtificerOutputV1 {
  readonly implementationCode: string;          // evaluate() 函数源码
  readonly goldenTraceCases: readonly GoldenTraceCaseInput[];  // 测试用例输入
  readonly affectedTools: readonly string[];     // 受影响的工具名列表
}
```

`implementationCode` 必须是一个导出 `evaluate(input, helpers)` 函数的 JS 模块，遵循现有 RuleHost runtime 的契约（同步返回 `{ decision, matched, reason }`）。

`goldenTraceCases` 使用现有 `GoldenTraceCase` 结构（已在 golden-trace.ts 定义），Artificer 至少产出 2 个用例（1 positive + 1 negative），最多 10 个。

**GoldenTraceDecision 与 RuleHostDecision 的关系**：

- **GoldenTraceDecision**（测试用例期望值）= `'allow' | 'block' | 'propose_correction'`
- **RuleHostDecision**（evaluate() 运行时决策）= `'allow' | 'block' | 'requireApproval' | 'auto_correct'`

Sandbox replay 的比较逻辑（`refiner-sandbox-wrapper.ts:129-187`）将两者映射：

| GoldenTraceDecision (expected) | 可接受的 RuleHostDecision (actual) | 说明 |
|-------------------------------|------------------------------------|------|
| `allow` | `allow` | 精确匹配 |
| `block` | `block` 或 `requireApproval` | `requireApproval` 在 golden trace 中用 `block` 表示 |
| `propose_correction` | `auto_correct` | 需同时检查 `result.correctionProposal` 存在 |

这意味着：
- Artificer 写 `expectedDecision: 'block'` 时，代码返回 `block` 或 `requireApproval` 都通过
- Artificer 写 `expectedDecision: 'propose_correction'` 时，代码必须返回 `auto_correct` 且携带 `correctionProposal` 字段
- `propose_correction` 用例需额外提供 `expectedProposedParams` 和 `expectedApplicationMode`（可选）

`affectedTools` 明确声明这条规则影响哪些工具，用于 RuleHost 的 toolName 过滤。Artificer LLM 需根据 principle 文本推导受影响的工具列表（例如原则禁止修改测试文件，则 affectedTools = ['edit']）。

**affectedTools 与 riskLevel 耦合**（`rule-host-writer.ts:55-66`）：
- `canActivate` 调用 `assessRiskLevel(affectedTools)` 评估风险等级
- 若 affectedTools 含 `edit`、`write`、`delete`、`bash`、`exec`、`remove` 等前缀 → `riskLevel = 'critical'`
- 否则 → `riskLevel = 'high'`
- `critical` 风险的规则在 owner 审批 UX 中会显示更高优先级的警告（User Story 12）

向后兼容策略：Validator 同时接受 V1（无代码字段，走原有 principle artifact 路径）和 V2（含代码字段，走新的 rule artifact 路径）。V1 输出不会产生 rule artifact。

### Decision 2: EvaluatorOutputV1 → V2 Schema 演进

Evaluator 的输出 schema 增加 `codeReview` 和 `adversarialCases` 字段：

```typescript
interface EvaluatorOutputV2 extends EvaluatorOutputV1 {
  readonly codeReview?: {
    readonly intentConsistency: {
      readonly aligned: boolean;
      readonly explanation: string;
    };
    readonly scopePrecision: {
      readonly verdict: 'precise' | 'too_broad' | 'too_narrow';
      readonly explanation: string;
    };
    readonly traceCoverage: {
      readonly sufficient: boolean;
      readonly gaps: readonly string[];
      readonly explanation: string;
    };
  };
  readonly adversarialCases?: readonly AdversarialCase[];
  readonly adversarialResult?: {
    readonly passed: boolean;
    readonly failedCases: readonly {
      readonly caseId: string;
      readonly attackType: 'boundary' | 'omission' | 'inversion';
      readonly actualDecision: string;
      readonly expectedDecision: string;
      readonly rationale: string;
    }[];
  };
}
```

`codeReview` 仅在 Artificer 输出了 V2（含 implementationCode）时存在。V1 Artificer 输出 → Evaluator 跳过代码审查，行为与现有逻辑一致。

三个维度的语义：
- **intentConsistency**：代码逻辑是否匹配上游 scribe principle 文本描述的约束意图
- **scopePrecision**：匹配条件是否过度宽泛（false positive 风险）或过度狭窄（false negative 风险）
- **traceCoverage**：golden trace 测试用例是否覆盖了 principle 描述的关键场景

`adversarialCases` 在 passive review 全部通过后由 LLM 生成（3-5 个），格式为 `{ caseId, attackType, toolName, params, expectedDecision, rationale }`。

`adversarialResult` 在对抗用例经 sandbox replay 后填充，记录哪些攻击用例通过了、哪些失败了。失败的用例及其 rationale 构成打回 Artificer 的核心反馈。

### Decision 3: Evaluator MVP-Core 范围调整

ADR-0014 §2.5 修正：Evaluator 从 MVP-Quiet 移回 MVP-Core。

`MVP_CORE_TASK_KINDS` 中已包含 `'evaluator'`（无需代码改动），但 ADR 文档需要同步更新以反映这一范围变更。

### Decision 4: 多轮对抗循环（Adversarial Loop）

Evaluator 的审查分为两个阶段，形成一个对抗循环，最多 2 轮：

**阶段 A — Passive Review（被动审查）**：
Evaluator LLM 审查 Artificer 输出的 3 个维度（intentConsistency / scopePrecision / traceCoverage）。如果任一维度不通过，直接 `needs_revision`。

**阶段 B — Adversarial Attack（对抗攻击）**：
Passive review 通过后，Evaluator LLM 额外生成 3-5 个**对抗性测试用例**（adversarial cases），目标是找到 Artificer 代码与 principle 文本之间的语义缺口：

- **边界值攻击**：principle 说"核心文件"，代码用 `.ts` 后缀匹配 — 攻击用例尝试 `package.json`、`.env`、`README.md`
- **条件遗漏攻击**：principle 有 3 个条件（核心文件 + 无 PLAN.md + 大改动），但代码只检查了 1 个 — 攻击用例满足另外 2 个条件但不满足被忽略的那个
- **反转攻击**：把 Artificer 的 positive case 参数微调，使其应该变成 negative — 验证代码是否能正确区分

攻击用例生成后，通过 `evaluateRefinerRuleHostGate()` 在 sandbox 中执行，验证代码的实际决策是否与攻击用例的 expectedDecision 一致。

**循环控制**：

```
Round 1:
  Artificer L2(code + goldenTrace)
    → Evaluator passive review → 通过
    → Evaluator adversarial attack → 生成对抗用例
    → Sandbox replay 对抗用例
      → 全部通过 → approved ✓
      → 有失败 → needs_revision（带失败用例 + 缺口描述）

Round 2（如果 Round 1 adversarial 失败）:
  Artificer L2(code + goldenTrace)  ← 含对抗失败的反馈
    → Evaluator passive review
    → Evaluator adversarial attack → 生成新一轮对抗用例
    → Sandbox replay
      → 全部通过 → approved ✓
      → 有失败 → needs_revision

Round 3（如果 Round 2 仍失败）:
  降级为 rejected → principle artifact 仍走 prompt 通道
```

**对抗用例格式**（复用 GoldenTraceCase 结构）：

```typescript
interface AdversarialCase {
  readonly caseId: string;            // 'adversarial-1', 'adversarial-2', ...
  readonly attackType: 'boundary' | 'omission' | 'inversion';
  readonly toolName: string;
  readonly params: Record<string, unknown>;
  readonly expectedDecision: 'allow' | 'block' | 'propose_correction';  // 匹配 GoldenTraceDecision
  readonly rationale: string;         // 为什么这个用例能暴露缺口
}
```

**与 AutoHarness 的关键差异**：
- AutoHarness 的 Verification Engine 是**单次事后审计**（regex 匹配 tool history），没有反馈回路
- PD 的对抗循环是**多轮主动攻击**（LLM 生成对抗用例 + sandbox 执行验证），有完整反馈回路
- AutoHarness 纯规则引擎（零 LLM 成本），PD 混合 LLM + 结构化验证

**关键约束**：
- 最多 2 轮对抗循环（Round 1 + Round 2），Round 3 直接降级
- 每轮 Evaluator 生成 3-5 个对抗用例（限制 LLM 输出大小）
- 对抗用例复用 `evaluateRefinerRuleHostGate()` 执行（零新基础设施）
- 失败反馈包含：failing adversarial case + rationale + 具体缺口描述 → Artificer 可针对性修正

### Decision 5: Rule Artifact Assembly 位置

Assembly 在 Evaluator.succeedTask() 内部执行，步骤如下：

1. 从 Artificer artifact 读取 `implementationCode` + `goldenTraceCases` + `affectedTools`
2. 从 scribe artifact 读取 `painReasonSummary`（原则文本摘要）
3. 使用 `buildGoldenTraceFromArtificer()` 构造 GoldenTrace 对象（**新函数**，将 Artificer 的 2-10 个 GoldenTraceCase[] 包装为完整 GoldenTrace，添加 traceId/createdAt/version 等元数据。不复用 `createGoldenTraceFixture()`，后者只支持固定 2 case）
4. 调用 `evaluateRefinerRuleHostGate()` 在 sandbox 中执行 golden trace replay
5. 根据 replay 结果确定 `ruleHostGateDecision`：
   - replay 全通过 → `'accepted_shadow'`
   - replay 有用例决策不匹配 → `'rejected_validation_failed'`（每个 failedCase 含 caseId + message）
   - replay 超时/运行时错误 → `'rejected_runtime_error'`
6. 写入 **两个 artifact**：
   - 先写 principle artifact（`artifactKind: 'principle'`，`validationStatus: 'validated'`，现有行为）
   - 再写 rule artifact（`artifactKind: 'rule'`，`validationStatus: 'pending'`，含 implementationCode + goldenTrace + ruleHostGateDecision）
7. **对 rule artifact 调用 `updateValidationStatus('validated')`**（`canActivate` 第 82 行检查 `validationStatus !== 'validated'`，否则拒绝）
8. Evaluator task 标记为 succeeded（无论 replay 结果如何，Evaluator 本身完成了审查工作）

**降级路径细节**：
- Sandbox replay 失败 → rule artifact 写入但 `ruleHostGateDecision` 为 rejected → canActivate 拒绝 → prompt 通道仍可用
- Assembly 失败（如 artifactStore 写入失败）→ principle artifact 仍写入 → prompt 通道可用

### Decision 11: 执行模型与责任分层

#### 单轮对抗检查（Evaluator.succeedTask 内部）

`Evaluator.succeedTask()` 负责单次运行内的被动审查 + 对抗攻击检查：

```typescript
Evaluator.succeedTask(taskId, runId, output: EvaluatorOutputV2, ...): Promise<PeerRunnerResult>
  1. 写 principle artifact（现有行为）
  2. 如果 Artificer 输出是 V2（含 code）:
     a. 读取 codeReview（已在 LLM 输出中）
     b. 如果 passive review 不通过 → needs_revision → 不写 rule artifact → 返回
     c. 如果 passive review 通过 → 读取 adversarialCases
     d. 调用 adversarialCasesToGoldenTrace() 转换（每个 case 设置 kind='negative'）
     e. **合并 Artificer golden trace 的 positive case 进对抗 trace**
        （`adversarialCasesToGoldenTrace()` 的输出故意不含 positive case ——
        对抗用例全是 negative expectation，合成假 positive 会让对抗 replay
        结果失真。转换后的 trace 单独不通过 `validateGoldenTrace()`，这是
        设计契约，不是 bug。owner 2026-06-17 确认接受此偏差。）
     f. 调用 evaluateRefinerRuleHostGate(code, mergedTrace) 执行单轮 sandbox replay
     g. 如果对抗 replay 通过 → approved → 写 rule artifact + updateValidationStatus('validated')
     h. 如果对抗 replay 失败 → needs_revision → 记录失败用例 → 不写 rule artifact
  3. 返回 EvaluatorRunnerResult（含 decision + adversarialResult）
```

**关键约束**：
- `succeedTask` 在 BasePeerRunner 的 `invokeRuntime` 返回 final output 之后执行，无法回头重试 LLM
- 单轮 sandbox replay 是纯函数调用（`evaluateRefinerRuleHostGate`），不消耗 LLM 调用，可在 `succeedTask` 中执行
- `adversarialCases` 已在 `invokeRuntime` 阶段由 Evaluator LLM 生成，`succeedTask` 只负责执行和判断

#### 多轮对抗循环（上层 Orchestrator）

跨 runner 的 2 轮对抗循环由 orchestrator（pipeline-orchestrator 或 story-a-demo）编排：

```typescript
Orchestrator（伪代码）:
  let round = 1
  let adversarialFeedback = undefined

  while (round <= 2) {
    // Artificer 运行（含 L2 write-test-fix，已在 adapter 内部）
    const artificerOutput = await runArtificer(
      sourcePainId,
      adversarialFeedback  // Round 2 时注入对抗失败用例
    )

    // 如果 Artificer L2 降级为 V1 → 直接走 prompt 通道
    if (!artificerOutput.implementationCode) {
      await runEvaluator(artificerOutput)  // 跳过代码审查
      break
    }

    // Evaluator 运行（单轮对抗检查）
    const evaluatorResult = await runEvaluator(artificerOutput)

    if (evaluatorResult.decision === 'approved') {
      return  // success，rule artifact 已在 succeedTask 中写入
    }

    if (evaluatorResult.decision === 'rejected') {
      return  // fail，principle artifact 仍走 prompt 通道
    }

    // needs_revision：准备下一轮
    adversarialFeedback = evaluatorResult.adversarialResult?.failedCases
    round++
  }

  // Round 3：降级为 rejected
  // principle artifact 仍走 prompt 通道
```

**Orchestrator 职责**：
- 维护 `round` 计数器（最多 2 轮）
- `needs_revision` 时把 `adversarialResult.failedCases` 注入 Artificer prompt（通过 Artificer 的 retry 机制）
- `rejected` 时确保 principle artifact 存在（prompt 通道可用）
- 根据 Evaluator 的 `decision` 决定是否重新调度 Artificer

这样设计的原因：
- 单次运行内的逻辑（sandbox replay、artifact 写入）在 `succeedTask` 中，符合 BasePeerRunner 分层
- 跨 runner 的多轮循环在 orchestrator 层，避免在 `succeedTask` 中试图回到 `invokeRuntime`（违反执行模型约束）

### Decision 12: Evaluator.buildContext() 扩展

当前 Evaluator.buildContext() 只加载 Artificer artifact。为支持对抗攻击（需要 principle 文本推导 expectedDecision），需要扩展 buildContext：

- 同时加载 Artificer artifact **和** Scribe artifact
- Scribe artifact 通过 Artificer 的 `sourceTrace.scribeArtifactId` 定位
- Prompt builder 将两者一起传入 Evaluator 的 LLM prompt

### Decision 6: Artificer Prompt 扩展

Artificer 的 LLM prompt 需要增加代码生成指令：

- 输入：scribe principle artifact（含约束描述）+ 现有 implementationPlan 上下文
- 输出要求：
  - `implementationCode`：一个 JS 模块，导出 `evaluate(input, helpers)` 函数。函数签名遵循 RuleHost runtime 契约（`input: RuleHostInput`, `helpers: RuleHostHelpers` → `RuleHostResult { decision: RuleHostDecision, matched: boolean, reason: string }`）。`RuleHostDecision` = `'allow' | 'block' | 'requireApproval' | 'auto_correct'`
  - `goldenTraceCases`：至少 2 个测试用例（1 positive + 1 negative），每个含 `{ caseId, kind, toolName, params, expectedDecision }`，`expectedDecision` 为 `'allow' | 'block' | 'propose_correction'`
  - `affectedTools`：该规则影响的工具名列表
- 约束：
  - 代码不能使用 require/import/eval（sandbox 会拦截，但应在生成时就避免）
  - 代码必须是纯函数，不能依赖外部状态
  - 代码必须同步返回（不能 async）

### Decision 7: Evaluator Prompt 扩展

Evaluator 的 LLM prompt 需要增加代码审查 + 对抗攻击指令，在一次 LLM 调用中同时输出两部分：

**Part A — Passive Review（代码审查）**：

- 输入：Artificer 输出的 implementationCode + goldenTraceCases + scribe principle 文本
- 审查要求（三个维度）：
  1. 读 principle 文本，读代码，判断代码逻辑是否精确实现了 principle 描述的约束（intentConsistency）
  2. 检查匹配条件是否过度宽泛（例如用 `includes()` 匹配子串导致 false positive）或过度狭窄（例如硬编码路径导致 false negative）（scopePrecision）
  3. 检查 golden trace 用例是否覆盖了 principle 描述的正向和反向场景（traceCoverage）
- 输出：结构化的 `codeReview` 对象（见 Decision 2）
- **短路逻辑**：如果任一维度不通过，Evaluator 不生成对抗用例（节省 LLM 输出 token），直接输出 `needs_revision` + concerns

**Part B — Adversarial Attack（对抗攻击）**：

仅在 Part A 全部通过时生成。Evaluator 扮演**攻击者**角色：

- 输入：同 Part A + 已通过 passive review 的代码
- 攻击要求：
  1. 生成 3-5 个对抗用例，每个属于以下攻击类型之一：
     - `boundary`：测试原则文本中模糊边界的参数（如"核心文件"的边界是 `.ts` 还是 `.json`？）
     - `omission`：测试原则文本中提到但代码可能遗漏的条件（如原则有 3 个条件，代码只检查了 2 个）
     - `inversion`：微调 Artificer 的 positive case 参数，使其应该变成 negative（验证代码的判断精度）
  2. 每个用例必须包含 `rationale`：解释为什么这个攻击能暴露代码与原则的缺口
  3. 用例的 `expectedDecision` 必须基于 principle 文本推导，而非基于代码行为
- 输出：`adversarialCases` 数组
- 对抗用例随后由 orchestrator 通过 `evaluateRefinerRuleHostGate()` 在 sandbox 中执行（不消耗 LLM 调用）

### Decision 8: Artificer L2 升级 — Write-Test-Fix 循环（Adapter 模式）

当前所有 runner（dreamer、scribe、artificer、evaluator）都是 L1 模式（单次 LLM 调用 → 结构化输出）。Artificer 升级为 L2 模式，因为代码生成与其他 runner 的自然语言产出有本质区别：代码有可验证的正确性标准（sandbox replay 通过/不通过），这为迭代修正提供了确定性反馈信号。

**执行模型约束**：`BasePeerRunner.run()` 是严格线性流程（`lease → buildContext → invokeRuntime → poll → fetch → validate → succeedTask`），`succeedTask` 在 `invokeRuntime` 返回 final output 之后执行，无法回头重试 LLM。因此 L2 的多轮循环**不能塞进 runner 的 succeedTask()**，必须通过 `PDRuntimeAdapter` 层封装（与 Dreamer L2 的 `L2AgentLoopAdapter` 先例一致）。

**Artificer L2 实现方案**：新建 `ArtificerL2Adapter implements PDRuntimeAdapter`，在 adapter 内部封装 write-test-fix 循环：

```
ArtificerL2Adapter.startRun():
  Round 1: LLM 生成 implementationCode + goldenTraceCases
    → Sandbox replay: evaluateRefinerRuleHostGate(code, goldenTrace)
    → 通过 → 返回 StructuredRunOutput(V2)
    → 失败 → 将 RefinerSandboxFailedCase[] 注入下一轮 prompt

  Round 2: LLM 修正代码（带错误反馈）
    → Sandbox replay
    → 通过 → 返回 V2
    → 失败 → 注入错误反馈

  Round 3: LLM 修正代码（带错误反馈）
    → Sandbox replay
    → 通过 → 返回 V2
    → 失败 → 降级返回 V1（只有 plan，不含 code）
```

**与 Dreamer L2 的对比**：
- Dreamer L2 用 `L2AgentLoopAdapter` + `agentLoop()` + read-only tools，循环在 agent loop turn 中
- Artificer L2 用新的 adapter + `completeSimple()` + inline sandbox replay，循环在 adapter 内部
- 两者都遵循 `PDRuntimeAdapter` 接口契约，BasePeerRunner 无需改动

**关键约束**：
- 最多 3 次 LLM 调用（1 初始 + 2 重试），不会无限循环
- Sandbox replay 的错误信息是结构化的（`RefinerSandboxFailedCase[]`），每类错误有明确的修正方向：
  - `forbidden_pattern` → "代码使用了 require/import/eval，请移除"
  - `runtime_error` → 具体异常信息，LLM 可针对性修正
  - `timeout` → 代码执行超时，可能存在死循环
  - `validation_failed` → 返回值不符合 RuleHostResult schema
- Evaluator 保持 L1（对抗攻击用例生成是 LLM 单次调用的一部分，不需要迭代）
- Artificer L2 的 3 次 LLM 调用封装在 adapter 内部，BasePeerRunner 只看到 1 次 `startRun()` 调用

**对抗攻击是 Evaluator LLM 调用的一部分**：Evaluator 的 LLM 在一次调用中同时输出 passive review（3 维度）+ adversarial cases（3-5 个对抗用例）。Passive review 不通过时不生成对抗用例（短路优化）。

### Decision 9: 代码生成质量保障 — 四层防线

不发明新协议，复用 PD 已有的四层防线：

**第一层：Prompt 中嵌入完整契约**

Artificer 的 LLM prompt 包含 RuleHost 的完整接口定义：
- `RuleHostInput`（frozen snapshot，含 action/workspace/session/evolution/derived 五个子结构）
- `RuleHostDecision`（四选一：allow / block / requireApproval / auto_correct）
- `RuleHostResult`（返回值结构）
- `RuleHostHelpers`（可用辅助函数：isRiskPath / getToolName / getEstimatedLineChanges / getBashRisk / hasPlanFile / getPlanStatus / getEpTier）
- 一个通过 replay 的完整示例代码
- 硬性约束清单（同步函数、禁止 require/import/eval/Function、禁止文件系统和网络访问、返回值必须匹配 RuleHostResult）

**第二层：Golden Trace Replay 自动验证（Artificer L2 循环内）**

`evaluateRefinerRuleHostGate` 在 node:vm sandbox 中执行代码，检测：
- forbidden patterns（require/eval 等）→ `rejected_forbidden_pattern`
- 执行超时（>1000ms）→ `rejected_timeout`
- 运行时错误 → `rejected_runtime_error`
- 返回值不符合 schema → `rejected_validation_failed`
- 测试用例结果不匹配 → `validation_failed`（附具体 caseId 和期望 vs 实际决策）

**第三层：Golden Trace 结构验证**

`validateGoldenTrace` 验证测试用例完整性：
- 至少 1 个 positive case（expectedDecision='allow'）
- 至少 1 个 negative case
- 每个 case 必须有 caseId、kind、toolName、params、expectedDecision
- positive case 的 expectedDecision 必须为 'allow'

**第四层：RuleHostWriter.canActivate 最终门控**

在 owner 审批前做最终检查：
- artifactKind === 'rule'
- implementationCode 非空
- goldenTrace 非空且 cases 非空
- ruleHostGateDecision === 'accepted_shadow'
- sandbox replay 再次通过（防止 artifact 存储后被篡改）

### Decision 10: 降级路径

当代码生成或审查失败时，principle artifact 的降级路径：

- Artificer 生成代码失败（LLM 错误/格式错误）→ principle artifact 仍写入，不含代码字段 → prompt 通道可用
- Evaluator `needs_revision` 重试后仍失败 → 降级为 rejected → principle artifact 仍走 prompt 通道
- Evaluator `rejected` → principle artifact 仍走 prompt 通道
- Sandbox replay 失败 → rule artifact 写入但 `ruleHostGateDecision` 为 rejected → canActivate 拒绝 → prompt 通道仍可用

核心原则：**代码路径的失败永远不阻断原则文本的价值**。

L2 循环失败降级：Artificer 3 次尝试均无法通过 sandbox replay → 输出 V1 artifact（只有 plan）→ 进入 Evaluator 但 Evaluator 不执行代码审查和 assembly → principle artifact 仍写入 → prompt 通道可用。

## Testing Decisions

### 测试原则

- 只测外部行为（输入输出），不测 LLM prompt 内部措辞
- Artificer 代码生成用 mock LLM response 测试，不依赖真实 LLM 调用
- Evaluator 代码审查用预构造的 code + principle 对测试，不依赖 Artificer 实际输出
- Assembly 流程用 mock artifactStore + 真实 evaluateRefinerRuleHostGate 测试

### 测试模块

1. **ArtificerOutputV2 Validator**
   - V2 字段完整性验证（implementationCode 非空、goldenTraceCases ≥2、affectedTools 非空）
   - V1 向后兼容（无代码字段的旧输出仍通过验证）
   - 边界：implementationCode 为空字符串、goldenTraceCases 只有 1 个用例、affectedTools 为空数组

2. **EvaluatorOutputV2 Validator**
   - codeReview 字段结构验证（三个维度各自必填）
   - codeReview 可选（V1 Artificer 输出时 Evaluator 不产生 codeReview）

3. **Evaluator 代码审查逻辑（mock LLM response）**
   - intentConsistency: aligned=true 场景 + aligned=false 场景
   - scopePrecision: precise/too_broad/too_narrow 各一场景
   - traceCoverage: sufficient=true（无 gaps）+ sufficient=false（有 gaps）

4. **Rule Artifact Assembly（integration test）**
   - Happy path: Evaluator approved → sandbox replay 通过 → rule artifact 写入成功，`ruleHostGateDecision === 'accepted_shadow'`
   - Sandbox replay 失败: 代码逻辑错误（对某个 case 返回错误决策）→ `ruleHostGateDecision === 'rejected_validation_failed'`
   - Sandbox runtime error: 代码抛异常 → `ruleHostGateDecision === 'rejected_runtime_error'`

5. **否决重试流程（含对抗循环）**
   - Passive review `needs_revision` → Artificer 重试（带 Evaluator feedback）→ 第二轮 passive review approved → 对抗攻击 → 通过 → rule artifact 写入
   - Passive review approved → 对抗攻击失败 → `needs_revision`（带攻击失败用例 + rationale）→ Artificer 重试 → 第二轮对抗通过
   - Round 1 对抗失败 → Round 2 Artificer 重试 → Round 2 passive review + 对抗攻击 → 仍然失败 → 降级为 rejected
   - `rejected` → 直接终止 → 不写 rule artifact → principle artifact 仍存在

6. **降级路径**
   - Artificer 无代码输出 → principle artifact 正常写入 → prompt 通道可用 → rule artifact 不写入
   - Evaluator 否决 → principle artifact 存在 → prompt 通道仍可注入

7. **Artificer L2 Write-Test-Fix 循环**
   - Happy path: 首次生成代码 → sandbox replay 通过 → 输出 V2（1 次 LLM 调用）
   - 修正路径: 首次生成代码 → sandbox replay 失败 → 注入错误反馈 → 第二次生成 → replay 通过 → 输出 V2（2 次 LLM 调用）
   - 耗尽重试: 3 次尝试均失败 → 降级输出 V1（只有 plan）→ principle artifact 仍写入
   - 错误类型覆盖: forbidden_pattern / runtime_error / timeout / validation_failed 各一个修正场景
   - V1 向后兼容: L2 循环耗尽后输出的 V1 artifact 不触发 Evaluator 的代码审查和 assembly

8. **对抗攻击循环**
   - Happy path: passive review 通过 → 生成 3 个对抗用例 → sandbox replay 全部通过 → approved
   - Boundary 攻击: principle 说"核心文件" → 代码用 `.ts` 后缀 → 对抗用例测试 `package.json` → 代码误判 block → 打回修正
   - Omission 攻击: principle 有 3 个条件 → 代码只检查 2 个 → 对抗用例满足第 3 个条件但其他不满足 → 代码错误 allow → 打回
   - Inversion 攻击: Artificer positive case 微调参数 → 对抗用例应该变成 block → 代码仍然 allow → 打回
   - 短路优化: passive review 不通过时不生成对抗用例 → 直接 needs_revision
   - 两轮耗尽降级: Round 1 + Round 2 对抗均失败 → rejected → principle artifact 仍走 prompt 通道

### Prior Art

- `packages/principles-core/tests/architecture-regression.test.ts` — 架构回归测试模式
- `packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts` 中的现有单元测试 — mock LLM + validator 测试模式
- `packages/principles-core/src/runtime-v2/internalization/refiner-rulehost-gate.ts` 的现有测试 — sandbox replay 测试模式
- `packages/principles-core/src/runtime-v2/golden-trace.ts` 中的 `createGoldenTraceFixture` — golden trace 构造辅助

## Out of Scope

1. **RolloutReviewer** — 保持在 MVP-Quiet。不重启 rollout review 流程。
2. **Trainer** — 保持在 MVP-Gone。不涉及 model_training channel。
3. **Owner 审批 UI** — 本 PRD 只覆盖从 pain event 到 rule artifact 写入的自动化部分。Owner 审批（shadow → enforce 的状态转换）由现有 `owner-approved` action 机制处理，不在本 PRD 范围内。
4. **Prompt 通道改动** — prompt 注入机制已可用且稳定，本 PRD 不修改 `prompt-activation-reader.ts` 或 `prompt.ts`。
5. **RuleHostWriter.canActivate 修改** — 现有验证链已覆盖所有必要检查（artifactKind、implementationCode、goldenTrace、gateDecision、sandbox replay、validationStatus），无需修改 canActivate 逻辑。Assembly 流程中显式调用 `updateValidationStatus('validated')` 确保验证通过。
6. **代码审查维度 4（安全性）** — 由 vm sandbox 兜底，不在 Evaluator LLM 审查范围内。
7. **代码审查维度 5（可逆性）** — deactivate 机制已存在（artifact 状态设为 inactive），不需要代码层面的额外工作。
8. **对抗循环上限** — 严格限制对抗循环最多 2 轮（Round 1 + Round 2），不引入自适应重试策略。Round 3 直接降级。

## Further Notes

### 与 Trainer Runner 的关系

当前 `trainer-runner.ts` 是唯一写 `artifactKind: 'rule'` 的 runner（第 418-427 行），但被限制在 `model_training` channel（MVP-Gone）。本 PRD 让 Evaluator 也成为写 rule artifact 的节点。未来 Trainer 从 Gone 恢复时，需要明确两者的职责边界：Evaluator 写的 rule artifact 来自内化管线（pain → principle → rule），Trainer 写的 rule artifact 来自 model training channel（独立路径）。两者通过 `sourceTaskId` 区分来源。

### ADR-0014 同步更新

本 PRD 要求对 ADR-0014 进行以下修正：
- §2.4：明确 Artificer 在 MVP 阶段同时产出 implementationPlan 和 implementationCode
- §2.5：Evaluator 从 MVP-Quiet 移回 MVP-Core，并说明其扩展职责（计划审查 + 代码审查 + rule artifact assembly）
- §2.6：Trainer 保持 MVP-Gone 不变

### Feature Flag 注册

当 PRI-239（feature flag registry）合并后，需要在 `.pd/feature-flags.yaml` 中注册：
- `rulehost-code-generation`（Artificer 代码生成功能）：`category: core`, `enabled: true`
- `rulehost-evaluator-code-review`（Evaluator 代码审查 + 对抗攻击功能）：`category: core`, `enabled: true`

在此之前，这两个功能通过 ADR-0014 修正间接获得 MVP-Core 地位。

### 成本考量

每条 pain → rule 的完整链路涉及的 LLM 调用：

**典型情况**（Artificer L2 首次通过 + Evaluator passive review 通过 + 对抗攻击通过）：
- dreamer(1) + scribe(1) + artificer(1) + evaluator(1) = **4 次 LLM 调用**

**含对抗修正的常见情况**（Round 1 对抗失败 → Round 2 通过）：
- dreamer(1) + scribe(1) + artificer-R1(1-3) + evaluator-R1(1) + artificer-R2(1-3) + evaluator-R2(1) = **6-10 次 LLM 调用**

**最坏情况**（Artificer L2 耗尽重试 + Evaluator 对抗循环 2 轮都失败 → 降级）：
- dreamer(1) + scribe(1) + artificer-R1(3) + evaluator-R1(1) + artificer-R2(3) + evaluator-R2(1) = **10 次 LLM 调用**
- Round 2 仍失败 → 降级为 rejected，不再 Round 3

**Sandbox replay 成本**：零 LLM 调用（纯程序化执行）。每轮对抗中 sandbox 执行 2 次（Artificer 自身的 golden trace + Evaluator 的对抗用例）。

## TDD 开发计划

采用严格的 Red-Green-Refactor 循环。每个 Phase 先写失败的测试（Red），再写最小实现使其通过（Green），然后重构（Refactor）。

**测试基础设施约定**：
- 所有 LLM 交互用 mock，不依赖真实 LLM 调用
- sandbox replay 用真实的 `evaluateRefinerRuleHostGate`（它是纯函数，零副作用）
- artifact store 用现有的 `MemoryArtifactReadModel`
- 每个 Phase 完成后运行完整测试套件（`npm run test`），确认无回归

### Phase 1: Schema 与 Validator（测试模块 1 + 2）

**文件**：
- `packages/principles-core/src/runtime-v2/internalization/artificer-output.ts`
- `packages/principles-core/src/runtime-v2/internalization/evaluator-output.ts`
- `packages/principles-core/tests/__tests__/artificer-output-v2.test.ts`（新）
- `packages/principles-core/tests/__tests__/evaluator-output-v2.test.ts`（新）

**TDD 循环**：

```
1.1 RED: 写 ArtificerOutputV2 validator 测试
  - V2 字段完整性（implementationCode 非空、goldenTraceCases ≥2、affectedTools 非空）
  - V1 向后兼容（无代码字段仍通过）
  - 边界：空字符串 implementationCode、只有 1 个 case、空 affectedTools
  → npm run test → 预期失败

1.2 GREEN: 实现 ArtificerOutputV2 schema + validator
  - 在 artificer-output.ts 中新增 V2 schema 和 validator
  - Validator 同时接受 V1 和 V2
  → npm run test → 预期全绿

1.3 RED: 写 EvaluatorOutputV2 validator 测试
  - codeReview 三维度结构验证
  - codeReview 可选（V1 时不存在）
  - adversarialCases 结构验证
  - adversarialResult 结构验证
  → npm run test → 预期失败

1.4 GREEN: 实现 EvaluatorOutputV2 schema + validator
  → npm run test → 预期全绿

1.5 REFACTOR: 检查 V1/V2 validator 的重复代码，提取共享逻辑
```

### Phase 2: GoldenTrace 构建辅助（Decision 5 前置）

**文件**：
- `packages/principles-core/src/runtime-v2/golden-trace.ts`
- `packages/principles-core/tests/__tests__/build-golden-trace-from-artificer.test.ts`（新）

**TDD 循环**：

```
2.1 RED: 写 buildGoldenTraceFromArtificer() 测试
  - 输入 2 个 cases → 输出合法 GoldenTrace
  - 输入 10 个 cases → 全部保留
  - 输入 0 个 cases → 返回错误或抛出
  - 验证 traceId/createdAt/version 元数据正确填充
  - 验证与 validateGoldenTrace() 兼容
  → npm run test → 预期失败

2.2 GREEN: 实现 buildGoldenTraceFromArtificer()
  → npm run test → 预期全绿

2.3 REFACTOR: 检查与 createGoldenTraceFixture 的共享逻辑
```

### Phase 3: AdversarialCase 转换（Decision 11 前置）

**文件**：
- `packages/principles-core/src/runtime-v2/internalization/adversarial-case.ts`（新）
- `packages/principles-core/tests/__tests__/adversarial-case.test.ts`（新）

**TDD 循环**：

```
3.1 RED: 写 adversarialCasesToGoldenTrace() 测试
  - 3 个 adversarial cases → 转换为 GoldenTrace（kind 全部为 'negative'）
  - caseId 前缀 'adversarial-' 保留
  - 验证转换结果通过 validateGoldenTrace()（需要手动添加 positive case）
  - 空数组 → 错误处理
  → npm run test → 预期失败

3.2 GREEN: 实现 AdversarialCase 类型 + adversarialCasesToGoldenTrace()
  → npm run test → 预期全绿
```

### Phase 4: Artificer L2 Adapter（测试模块 7）

**文件**：
- `packages/principles-core/src/runtime-v2/adapter/artificer-l2-adapter.ts`（新）
- `packages/principles-core/src/runtime-v2/adapter/__tests__/artificer-l2-adapter.test.ts`（新）

**TDD 循环**：

```
4.1 RED: 写 ArtificerL2Adapter 测试
  - Happy path: 首次生成代码 → sandbox replay 通过 → 返回 V2（1 次 LLM）
  - 修正路径: 首次失败 → 注入错误反馈 → 第二次通过 → 返回 V2（2 次 LLM）
  - 耗尽重试: 3 次均失败 → 返回 V1（只有 plan）
  - 错误类型覆盖: forbidden_pattern / runtime_error / timeout / validation_failed
  → npm run test → 预期失败

4.2 GREEN: 实现 ArtificerL2Adapter implements PDRuntimeAdapter
  - startRun() 内部循环调用 completeSimple() + sandbox replay
  - 失败时将 RefinerSandboxFailedCase[] 注入重试 prompt
  - 3 次失败后降级为 V1
  → npm run test → 预期全绿

4.3 REFACTOR: 检查 L2 循环的 prompt 构建逻辑是否可测
```

**与 Dreamer L2 对比**：
- Dreamer L2 用 `L2AgentLoopAdapter` + `agentLoop()` + read-only tools
- Artificer L2 用 `ArtificerL2Adapter` + `completeSimple()` + inline sandbox replay
- 两者都实现 `PDRuntimeAdapter` 接口，BasePeerRunner 侧无感知差异

### Phase 5: Evaluator 代码审查 + 对抗攻击（测试模块 3 + 8）

**文件**：
- `packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts`
- `packages/principles-core/src/runtime-v2/internalization/evaluator-prompt-builder.ts`
- `packages/principles-core/tests/__tests__/evaluator-code-review.test.ts`（新）
- `packages/principles-core/tests/__tests__/evaluator-adversarial.test.ts`（新）

**TDD 循环**：

```
5.1 RED: 写 Evaluator 代码审查测试（mock LLM response）
  - intentConsistency: aligned=true / aligned=false
  - scopePrecision: precise / too_broad / too_narrow
  - traceCoverage: sufficient=true / sufficient=false
  - 短路优化: passive review 不通过时不生成对抗用例
  → npm run test → 预期失败

5.2 GREEN: 实现 Evaluator 代码审查逻辑
  - 修改 evaluator-runner.ts 处理 V2 输出
  - 修改 evaluator-prompt-builder.ts 包含代码审查指令
  → npm run test → 预期全绿

5.3 RED: 写对抗攻击循环测试
  - Happy: passive review 通过 → 生成对抗用例 → sandbox replay 通过 → approved
  - Boundary 攻击: 代码误判 → needs_revision
  - Omission 攻击: 代码遗漏条件 → needs_revision
  - Inversion 攻击: 代码精度不足 → needs_revision
  - 两轮耗尽降级: R1+R2 均失败 → rejected
  → npm run test → 预期失败

5.4 GREEN: 实现对抗攻击逻辑
  - 在 Evaluator.succeedTask() 中添加**单轮**对抗执行流程
  - 调用 adversarialCasesToGoldenTrace() + evaluateRefinerRuleHostGate()
  - 写入 rule artifact（含 updateValidationStatus）
  → npm run test → 预期全绿

5.5 REFACTOR: 检查 prompt builder 的 Part A/Part B 结构
```

### Phase 6: Rule Artifact Assembly（测试模块 4）

**文件**：
- `packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts`
- `packages/principles-core/tests/__tests__/evaluator-assembly.test.ts`（新）

**TDD 循环**：

```
6.1 RED: 写 Rule Artifact Assembly 测试
  - Happy path: approved → sandbox replay 通过 → rule artifact 写入，gateDecision='accepted_shadow'
  - Sandbox 失败: 代码决策不匹配 → gateDecision='rejected_validation_failed'
  - Sandbox runtime error: 代码抛异常 → gateDecision='rejected_runtime_error'
  - 验证同时写入 principle + rule 两个 artifact
  - 验证 contentJson 结构匹配 RuleHostWriter.canActivate 期望
  → npm run test → 预期失败

6.2 GREEN: 实现 Assembly 逻辑
  - 在 Evaluator.succeedTask() 中添加 rule artifact 写入
  - 使用 buildGoldenTraceFromArtificer() 构造 GoldenTrace
  → npm run test → 预期全绿

6.3 REFACTOR: 确保 Assembly 失败不影响 principle artifact 写入
```

### Phase 7: 否决重试 + 降级路径（测试模块 5 + 6）

**文件**：
- `packages/principles-core/tests/__tests__/adversarial-loop-integration.test.ts`（新）

**TDD 循环**：

```
7.1 RED: 写**单轮**对抗检查集成测试（mock LLM + 真实 sandbox）
  - Passive review needs_revision → Evaluator 返回 needs_revision
  - Passive review approved → 对抗失败 → Evaluator 返回 needs_revision（带 failedCases）
  - Passive review approved → 对抗通过 → Evaluator 返回 approved，rule artifact 写入成功
  → npm run test → 预期失败

7.2 RED: 写降级路径测试
  - Artificer V1 输出 → Evaluator 跳过代码审查 → principle artifact 正常写入
  - Evaluator rejected → principle artifact 仍存在 → prompt 通道可用
  → npm run test → 预期失败

7.3 RED: 写多轮对抗循环测试（orchestrator 层）
  - R1 对抗失败 → Artificer 重试 → R2 对抗通过 → approved
  - R1+R2 对抗均失败 → rejected → principle artifact 仍存在
  → npm run test → 预期失败

7.4 GREEN: 实现 orchestrator 层的多轮循环控制
  - 维护 round 计数器（最多 2 轮）
  - needs_revision 时注入 adversarialResult.failedCases 到 Artificer prompt
  → npm run test → 预期全绿

7.5 REFACTOR: 检查错误分类与 ERR 手册一致性
```

### Phase 8: 架构回归测试

```
8.1 在 architecture-regression.test.ts 中添加:
  - ArtificerOutputV2 schema 注册检查
  - EvaluatorOutputV2 schema 注册检查
  - buildGoldenTraceFromArtificer 导出检查
  - adversarialCasesToGoldenTrace 导出检查
  → npm run test → 预期全绿

8.2 运行完整测试套件:
  - cd packages/principles-core && npm run build && npm run test
  - cd packages/openclaw-plugin && npm run build && npm run test
  - npm run lint
```

### Phase 依赖关系

```
Phase 1 (Schema)  ─────┐
                          ├── Phase 4 (Artificer L2)
Phase 2 (GoldenTrace) ─┤
                          ├── Phase 5 (Evaluator 审查 + 对抗)
Phase 3 (AdversarialCase)┘         │
                                        ├── Phase 6 (Assembly)
                                        │         │
                                        └── Phase 7 (集成测试)
                                                  │
                                              Phase 8 (回归)
```

Phase 1-3 可并行开发，Phase 4-5 依赖 Phase 1-3，Phase 6-7 依赖 Phase 4-5，Phase 8 收尾。
