# Replay Gate 分析 — PRI-634-E（v2，核查修订版）

> 本版为**核查修订版**：修正初版"重放从未运行"的表述——运行时事件证据显示
> cf9ceca8 链 run_1 的重放**实际执行**（LLM 提供对抗用例时 gate 可达且正确工作）。
> 根因重新精确化为：**gate 可达性依赖 LLM 输出形状的不确定性**。

审计基线：origin/main `2e97ce1e`（与 PRI-634-C 修复分支在全部相关文件零差异；
canonicalizeToolKind 行为经运行时 node 调用验证）。

## 1. 定位与双路径

对抗重放逻辑位于 `evaluator-runner.ts`。**存在两条重放路径**（初版审计遗漏）：

| 路径 | 触发条件 | 用例来源 | 用例 ID 组成 |
|---|---|---|---|
| **门路径**（runAdversarialReplay，2150–2306） | evaluator 判 `approved` 且 artifact code-bearing | v2 自动生成 + LLM adversarialCases | positive(3) + adversarial(N) |
| **诊断路径**（executeDeterministicReplay，998–1059） | evaluator 判 `needs_revision` 且 wantsGate | 同上（verdict-agnostic 核心） | 重放结果仅作诊断证据，不翻转 verdict |

## 2. 门路径流水线（输入 → 验证逻辑 → 通过条件）

```
Step 1: extractPositiveCases(goldenTraceCases) ≥1 positive
Step 2: llmCases = isEvaluatorOutputV2(output) ? output.adversarialCases ?? [] : []
        — V2 判定（evaluator-output.ts:389）：output 含 codeReview / adversarialCases /
          adversarialResult / painCoverage / compressionFidelity 任一合法字段即为 V2
        — V1 shape 合法（validator 不拒）→ llmCases = []
Step 3: v2Cases = generateV2CasesFromArtificer(affectedTools, positiveCases)
   3a. toolName ← affectedTools[0] || positive[0].toolName
   3b. pathParam ← resolveCasePathParam(positive[0].params)   ← 只认 path / file_path
   3c. canonicalKind ← canonicalizeToolKind(toolName)          ← 只认 write
   任一失败 → return []（no_tool_name / no_path_param / non_write_canonical_kind）
Step 4: merged = [...v2Cases, ...llmCases]；空 → no_adversarial_cases_after_merge
        对 code-bearing artifact = TERMINAL（R3 拒绝报告成功）
Step 5: adversarialCasesToGoldenTrace(merged) + positiveCases → mergedTrace
        （caseCount = |positive| + |adversarial|；查重 + 保留 __*__ 哨兵校验）
Step 6: evaluateRefinerRuleHostGate({code, goldenTrace}) — 确定性沙箱
Step 7: adversarialResult = { passed: accepted, failedCases }；
        accepted 仅当 gateResult.decision === 'accepted_shadow'
```

## 3. 通过条件

1. `merged.length > 0`（gate 可达）
2. 沙箱中所有用例 actualDecision 与 expectedDecision 一致（`accepted_shadow`）
3. 任何 `expected block got allow`（规则漏拦）→ `rejected_validation_failed`

## 4. 运行时证据（critical-events.jsonl，真实链）

| 时刻 | 链 | 事件 | 关键 payload |
|---|---|---|---|
| 07:34:30 | cf9ceca8 run_1 | `evaluator_adversarial_replay` | **gateDecision=rejected_validation_failed, caseCount=7, failedCaseCount=2**（v2-path-boundary、v2-combination：expected block, actual allow） |
| 07:37:13 | e6e9636b run_1 | `evaluator_adversarial_replay_skipped` | no_adversarial_cases_after_merge |
| 07:41:35 | 70c44b4a run_1 | `evaluator_adversarial_replay_skipped` | 同上 |
| 07:56:01 | cf9ceca8 run_3 | `evaluator_adversarial_replay_skipped` | 同上 |

**运行时已验证**：`canonicalizeToolKind('execute_command') → 'other'`（node 直调 dist），
`'write_file' → 'write'`、`'exec' → 'execute'`。

## 5. 可达性矩阵（根因核心）

merged > 0 的充要条件：**（write-canonical 工具 AND positive[0] 带 path/file_path）OR（LLM 输出 V2 且自带 adversarialCases）**。

| 工具类型 | LLM 提供 V2 用例 | LLM V1 输出（合法） |
|---|---|---|
| write 类（write_file/edit_file） | 可达 | 仅当 positive[0] 带 path 可达 |
| **execute 类（execute_command 等）** | **可达**（cf9ceca8 run_1 实证，caseCount=7） | **结构性死锁**（v2 自动生成 [] + llmCases=[]） |

初版报告"execute 类结构性不可达"**表述过强**——正确表述：
**gate 对 execute 类规则的可达性 100% 依赖 LLM 恰好输出 V2 并自带对抗用例；
V1 输出（与 V2 同等合法）时零兜底。** LLM 输出形状在修订轮间不稳定
（cf9ceca8：run_1 V2 → run_2 schema invalid → run_3 V1），使这种依赖不可靠。

## 6. 观测缺口（审计中发现）

- 中间态 `v2_adversarial_cases_skipped` 子原因（no_path_param / non_write_canonical_kind）
  **不落盘**（emitEvent 只进内存事件流；critical-events.jsonl 只收终态事件）。
  死因子原因只能靠确定性代码路径推导（本审计已用运行时验证的输入补全）。
- `evaluator_adversarial_replay` 事件的 payload 不含用例清单/LLM 用例来源标注，
  caseCount=7 的构成（3 positive + 4 LLM）需从 run payload 反推。

## 7. 结论

**B. Replay Gate 设计不适配**成立，但精确化为：
1. v2 自动生成器只覆盖 write 语义（设计文档 PRI-485 Phase 6 明示这是当时范围），
   对 execute 类工具无模板、无兜底；
2. gate 可达性把"提供对抗用例"的责任随机落在 LLM 输出形状上（V1/V2 均合法），
   行为规则在修订轮间经历 V2→V1 漂移后必然死锁；
3. gate 本身的判定逻辑工作正常（run_1 正确抓到规则的 2 处漏拦）——
   问题不在门太严，而在**到达门的路径不可靠** + **修订环不修复到达条件**
   （见 failed-rule-analysis.md 新增 F-1 反馈错位发现）。