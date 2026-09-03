# Replay Gate 分析 — PRI-634-E

## 1. 定位

确定性对抗重放门位于 `evaluator-runner.ts` 的 `evaluateWithAdversarialLoop` 方法（约 2150–2210 行），
处理后置评估阶段（evaluator 的 LLM 决断后、rollout 前）。

## 2. 输入

| 输入 | 来源 | 类型 |
|---|---|---|
| Artificer 产物 | `pi_artifacts` 表 | `ArtificerRuleOutput`（json） |
| Evaluator 决断 | `output_payload` | `EvaluatorOutputV1` 或 `V2` |
| `affectedTools` | Artificer 产物 | `string[]` |
| `goldenTraceCases` | Artificer 产物 | `GoldenTraceCaseInput[]`（含 positive + negative） |
| `adversarialCases` | Evaluator 输出（仅 V2） | `AdversarialCase[]` |

## 3. 验证逻辑（流水线，顺序执行，前三步任一步 0 则死锁）

```
Step 1: extractPositiveCases(goldenTraceCases)
   条件：≥1 条 kind='positive'
   失败：no_positive_case_in_artificer_golden_trace → skip

Step 2: llmCases = isEvaluatorOutputV2(output) ? output.adversarialCases ?? [] : []
   条件：V2 shape 且 LLM 填充了 adversarialCases
   失败（V1 输出或 V2 但 LLM 没填）：[]（合法非错误）

Step 3: v2Cases = generateV2CasesFromArtificer(affectedTools, positiveCases, ...)
   子步骤：
   a) resolve toolName ← affectedTools[0] || positiveCases[0].toolName
       失败：no_tool_name → []
   b) resolveCasePathParam(positiveCases[0].params) ← 查 params.path 或 params.file_path
       失败：no_path_param → []
   c) canonicalizeToolKind(toolName) → CanonicalKind
       失败（kind !== 'write'）：non_write_canonical_kind → []

Step 4: merged = [...v2Cases, ...llmCases]
   条件：merged.length > 0
   失败：no_adversarial_cases_after_merge → TERMINAL（对 code-bearing artifact）

Step 5: adversarialCasesToGoldenTrace(merged) → all-negative GoldenTrace
   失败：adversarial_conversion_failed → skip

Step 6: 并发运行 RuleHost 沙箱（deterministic replay）
   输出：adversarialResult（{passed, failedCases, summary}）
```

## 4. 通过条件

- `merged.length > 0`（至少 1 条对抗用例）
- 沙箱中所有对抗用例的 `expectedDecision` 与 RuleHost 实际决断一致（全 passed）
- 或：不一致但在 `adversarialResult.failedCases` 中如实报告（evaluator 可据此调整决断）

## 5. 失败原因分类（3 种已知）

| 失败原因 | 触发条件 | 代码位置 |
|---|---|---|
| `no_positive_case_in_artificer_golden_trace` | 无 positive case | 2157 |
| `no_adversarial_cases_after_merge` | v2Cases + llmCases 合并后为空 | 2191 |
| `adversarial_conversion_failed` | 合并后无法转化为 all-negative GoldenTrace | 2202 |

## 6. 设计适应度分析

### 6.1 假设：规则必须绑定 write 工具

**是**。`generateV2CasesFromArtificer` 的 v2 模板（PRI-485 Phase 6）只实现了
**write-path 语义**的 5 种对抗场景（alias、path-boundary、combination、truncation、
unavailable）。代码注释明说：

> 非 write 工具退化为仅依赖 LLM 提供的 adversarialCases（PRI-485 Phase 6: 5 个 v2 模板
> 都是 write-path 语义，为 read/search/execute/agent/other 工具生成它们会产生不匹配的负例）。

设计文档（ADR-2026-06-28 rulecode-context-v2 + PRI-439 设计）确认：RuleHost 最初
（MVP）针对的是`code_tool_hook` 通道的**文件写入安全规则**（write 工具拦截）。
PRI-484/485/490 系列正在向行为规则扩展，但对抗重放层（v2 模板生成器）**没有同步扩展**。

### 6.2 假设：必须有 LLM 辅助或 evaluator V2 输出携带 adversarialCases

**是**。`canonicalKind !== 'write'` 时，v2 生成直接返回 `[]`，**唯一救生筏**是
LLM 填写的 adversarialCases（evaluator V2 输出）。但 V1 输出格式合法（无 adversarialCases 字段）
且 validator 不拒绝 V1——因此当 LLM（巧合地）输出 V1 形状时，execute 类规则一定死锁。

### 6.3 假设：positive case 必须携带 path 参数

**是**。v2 模板生成时需要 `resolveCasePathParam(firstPositive.params)` 返回非 null。
这假设规则的目标动作一定有文件路径（write 语义），对纯行为规则（如"检查解释器版本"）
不成立——行为规则可能只有 `command`/`encoding` 参数而无文件路径。

## 7. 结论

**B. Replay Gate 设计不适配**是本次失败的核心根因。确定性对抗重放（PRI-485 Phase 6）
的 v2 自动生成器在**设计上**只覆盖 write 语义工具，gate 的结构性假设（规则 = 文件写入安全规则）
在行为规则（execute 类）前失效。LLM-supplied adversarialCases 是唯一逃生路径，但
V1 evaluator 输出合法地关闭了该通道。

详见 failed-rule-analysis.md（真实失败追踪）与 rulecode-graduation-design.md（优化方案）。