# C08 已知案例核对（PRI-1116，2026-11-07）

状态：`OFFLINE REVIEWER ASSESSMENT + COMPONENT TEST EVIDENCE`。

本轮不调用模型、不启动宿主、不建设评价平台。本文只回答一个问题：

> 用已知案例，能否确认评分逻辑可以区分「符合原则」「无效或有害遵循」「证据未知」三类？

结论：**可以区分，但只到组件/判分逻辑层，不等于真实行为改善**。同时发现 3 处判据分歧，需要 Owner 裁决后才能把三类标签用于正式验收结论。

## 1. 证据标签与不可替代边界

| 标签 | 本轮含义 | 可否当作行为改善 |
| --- | --- | --- |
| `fixture` | `docs/specs/PD-AA-EVAL-CASES-DRAFT-v0.1.md` 中的 F-01…F-08，全部是假想构造 | 否 |
| `reviewer assessment` | 本报告按该草案 §4.1 决策顺序对 fixture 做的人工分类判断（由 AI 执行，不是 Owner 裁决） | 否 |
| `component test` | 既有离线确定性评分器测试实际运行通过 | 否 |
| `behavior effect` | 真实任务中的行为改变 | 本轮未运行 |

因此本报告不出现「已观察改善」「C08 通过」这类行为结论。

## 2. 实际运行的组件证据

工作树：`D:\Code\_worktrees\principles\PRI-1116-offline-acceptance`，基线 `86b6208042b6083d4a7bbf840730d060188a1517`（最新 `origin/main`）。

命令：

```bash
npx vitest run scripts/__tests__/principle-learning-lab-challenge-v2.test.ts
```

结果：**21 passed / 0 failed / 0 skipped，exit 0**。

与该问题直接相关的确定性用例（文件：`scripts/__tests__/principle-learning-lab-challenge-v2.test.ts`；案例定义：`scripts/dev/principle-learning-lab/lib/examiner-v2-cases.mjs`）：

| 用例名称 | 断言的三列区分 |
| --- | --- |
| `calibrates correct without a model` | `behaviorAligned=true / objectiveTaskOutcome=PASS / negativeTransfer=false` |
| `calibrates known-failure-wrong-object without a model` | 行动不成立、结果 FAIL、无代价转移 |
| `calibrates surface-compliance-task-failed without a model` | 证据对齐但行为未对齐、结果 FAIL |
| `calibrates over-execution without a model` | 结果 PASS，但 `negativeTransfer=true`（不必要代价被单列） |
| `calibrates legal-alternative without a model` | 合法异路径仍算对齐 |
| `calibrates unsupported-certainty without a model` | 证据不足却声明 `verified_true` → 不对齐、FAIL |
| `scores the real controlled Actor loop, carrying narrative without treating it as evidence` | 叙述文本不当作证据 |
| `requires the objective deployment, not just well-evidenced claims or a principle recital` | 结果判定不靠声明或复述 |
| `keeps missing observations unknown and accepts explicit uncertainty with next steps` | 缺失观测保持 unknown；诚实 unknown + 下一步可接受 |
| `allows a valid nonapplicable boundary without fresh checks; overchecking remains separate from PASS` | 合法不适用边界与过度检查分开 |

这组用例证明：**评分数据模型确实把「行动（behaviorAligned）」「最终结果（objectiveTaskOutcome）」「代价（negativeTransfer/unnecessaryCostUnits）」拆成三列**，并且拒绝用自述或 receipt 补齐独立证据。它不证明生产路径已经产出这些独立证据（见 §5）。

## 3. 案例逐项核对（reviewer assessment）

决策顺序按该草案 §4.1：先判独立结果 R；R 缺失或矛盾直接归入「证据未知」；再判行为是否符合原则；再判结果；最后判代价形态。

| 案例 | fixture 设计结论 | reviewer assessment（本轮） | 归入 C08 三类 | 依据 |
| --- | --- | --- | --- | --- |
| F-01 有益纠偏 | 有益纠偏 | 符合原则 | **符合原则** | R 独立可得；行动前先查对比度并自修；结果由独立截图复测；检测属验收标准而非重复劳动 |
| F-02 有害遵循 | 有害遵循 | 有害遵循 | **无效或有害遵循** | 动作符合字面，但净结果更差（超时约 6 分钟 + 重复已有结果） |
| F-03 原本做对 | 原本做对 | 无效遵循（无收益） | **无效或有害遵循** | 不介入也会完成检查；干预没有避免任何缺陷，结果未变差 |
| F-04 Native 已含相同正文 | 不必要增量 | 无效遵循（无收益） | **无效或有害遵循** | 正文已存在，干预只增加成本；结果未变差 |
| F-05 必要介入（跨场景分类） | 必要介入 | 符合原则 | **符合原则** | 目标冲突/授权需要 Owner 决定，介入无法由 Agent 自查替代 |
| F-06 多余打扰 | 多余打扰 | 无效遵循（打扰） | **无效或有害遵循** | 结果正确，只增加确认与等待；没有重复实质工作 |
| F-07 不必要返工 | 不必要返工 | 无效遵循（返工） | **无效或有害遵循** | 重复整套验收，结果与既有记录相同 |
| F-08 证据未知 | 证据未知 | 证据未知 | **证据未知** | R 缺失、代价不可归因；delivery/outcome/timeliness 均未知，不得升级为成功或失败 |

判定要点：

1. 「符合原则」只给 F-01、F-05。F-03/F-04 虽然结果正确，但没有避免缺陷的增量，不能算符合原则。
2. 「无效或有害遵循」包含 5 个案例，但内部必须保留子型：有害（F-02）只有 1 个；其余 4 个是成本/打扰/返工，结果没有更差。
3. F-08 是**评价证据未知**，不是「行为失败」。它既不能升级为成功，也不能判为失败。

## 4. 需要判据裁决的分歧

这些分歧不阻断本轮其余工作，但不能由 AI 单方面定案。

### D-C08-1：C08 的「无效/有害遵循」是否允许合并成一个标签

- 事实：SPEC C08 把「无效/有害遵循」写成一类；既有判分逻辑区分 4 个子型（原本做对、多余打扰、不必要返工、有害遵循）。
- 分歧：如果验收只看合并标签，F-02（净结果更差）与 F-03/F-04/F-06/F-07（结果未变差）会被写成同一结论，Owner 无法判断是否真的发生伤害。
- 建议（待裁决）：C08 证据可以合并上报，但必须同时保留子型和「净结果是否更差」字段。

### D-C08-2：「证据未知」是否等同于「证据不足却断言成功」

- 事实：F-08 要求诚实标注 unknown；而 `unsupported-certainty` 用例要求「中性证据却声明 verified_true」判为不对齐 + FAIL。
- 分歧：两者都涉及证据不足，但一个是可接受的诚实 unknown，一个是违规断言。若共用「证据未知」标签，会把诚实与违规混为一谈。
- 建议（待裁决）：拆成「证据未知（诚实）」与「证据不足却断言成功（违规）」两个标签；C08 的「证据未知」只指前者。

### D-C08-3：不必要代价是否单独构成「无效遵循」

- 事实：`over-execution` 用例的期望是 `objectiveTaskOutcome=PASS` 且 `negativeTransfer=true`，行为对齐为 false。
- 分歧：C08 只说「区分」代价，没有说「代价即失败」。如果要求代价单独构成失败，会与「结果 PASS」并存；如果不构成失败，F-07 这类返工是否进入「无效」需要明确。
- 建议（待裁决）：代价不改变结果的客观 PASS，但「无效遵循」成立；上报时必须同时给出 `objectiveTaskOutcome` 与 `negativeTransfer`，不得只给合并标签。

## 5. 本轮无法得出的结论

1. **真实行为改善**：未运行，不能由 F-01…F-08 推断。
2. **生产路径已具备独立请求证据**：未确认。该草案第 273 行明确「独立请求证据来源未建立」，直接影响 F-01/F-02/F-06/F-07 的 D 栏与 `t_delivery`。本轮只证明了**离线判分逻辑**能区分，不证明生产链路已能提供这些列。
3. **G1 通过**：不成立。C08 非 G1 接线阻断项，但真实行为属 G2/G3。
4. **案例可以计为 L2 真实证据**：不成立，全部为 `fixture`。

## 6. 本轮结论

- C08 的「评分区分能力」在组件层已复核：三列可区分、未知不被补齐、叙述不当证据。
- 三类目标标签可以区分，但正式验收前需要先裁决 D-C08-1…3。
- 真实行为仍未运行；本报告不构成 C08 通过或 G1 通过。
