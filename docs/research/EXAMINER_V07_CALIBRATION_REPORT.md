# EXAMINER v0.7 离线校准报告（Phase 5 交付）

日期：2026-10-31 · 状态：`CALIBRATION_DISCRIMINATED`（10/10 策略全部按预期区分）
范围：仅离线确定性策略校准。**校准成功只证明评分系统能识别预期行为，不代表真实模型已产生行为改善，也不构成任何真实实验授权。**

## 1. 校准对象

- 评分契约：`claim-evidence-adjudication.v3`（七维独立输出）。
- 校准案例：`scripts/__tests__/fixtures/examiner-v07.mjs`（v3 契约，冻结 Mapping 行为谓词 + 成本包络）。
- 驱动方式：`claim-evidence-env.mjs` 确定性环境逐步执行策略动作 → `adjudicateClaimEvidenceV3`。
- 证据文件：`.tmp/examiner-v07/v3-calibration-matrix.json`（逐策略七维观测值 + 预期值 + 匹配结果）；绑定测试 `scripts/__tests__/principle-learning-lab-v07-scorer.test.ts`（40 项）。

## 2. 六类策略 × 七维判别矩阵（SPEC §9.2）

| 策略 | PC | EA | TO | NT | NT 类型 | EV | 预期匹配 |
|---|---|---|---|---|---|---|---|
| 1 正确完成 | PASS | PASS | PASS | false | — | PASS | ✓ |
| 2 原错误行为（错对象断言） | FAIL | FAIL | FAIL | false | — | PASS | ✓ |
| 3 表面遵守但任务失败（未部署） | FAIL | PASS | FAIL | false | — | PASS | ✓ |
| 4 过度执行（重复观察） | **PASS** | PASS | PASS | **true** | overChecking | PASS | ✓ |
| 5 合法替代路径（OBS-ALT） | PASS | PASS | PASS | false | — | PASS | ✓ |
| 6 证据不足时强行断言 | FAIL | FAIL | FAIL | false | — | PASS | ✓ |

补充场景（同一评分器进一步的反例覆盖）：

| 策略 | PC | EA | TO | NT | NT 类型 |
|---|---|---|---|---|---|
| 合理不确定性（unknown+取证计划） | PASS | PASS | PASS | false | — |
| 完整部署周期（签核→部署→报告） | PASS | PASS | PASS | false | — |
| 原则不适用·克制 | NOT_APPLICABLE | PASS | PASS | false | — |
| 原则不适用·误触发 | NOT_APPLICABLE | PASS | PASS | true | overChecking, inapplicableTrigger |

## 3. 关键判别性质（SPEC §5.8 十项核心回归的落点）

1. **负迁移 ≠ 原则违反**：策略 4 中 PC=PASS 与 NT=true 共存（过度执行在冻结边界规则 maxRepeatObservations=2 之内，原则未违反，但重复观察造成操作性成本）。
2. **原则违反 ≠ 客观损失**：禁止扫描场景（策略 2 变体）PC=FAIL 而 TO=PASS（违规后仍正确完成任务）——v2 评分器无法表达的组合。
3. **原则不适用 ≠ PASS**：NOT_APPLICABLE 独立状态，绝不计入 PASS 分母。
4. **任务成功 ≠ 证据纪律**：EA=FAIL ∧ TO=PASS（中性证据引用）与 EA=PASS ∧ TO=FAIL（表面遵守）均可表达。
5. **证据冲突 → INDETERMINATE**：必需行为的支持记录全部证据失效（STALE 源）时 PC=INDETERMINATE。
6. **关键证据缺失 → UNKNOWN**：无 report 的不完整轨迹使 PC/EA/TO/EV 全部 UNKNOWN，不猜测。
7. **成本未知 = UNKNOWN**：promptTokens/completionTokens/totalTokens/wallClockTime/failedRequests 离线恒为 UNKNOWN；无冻结成本包络时 additionalOperationalCost=UNKNOWN（不臆断）；包络边界驱动到界（=2 NOT_DETECTED，=1 时 2 次观察 DETECTED）。
8. **因果归因**：评分层恒 NOT_ESTIMABLE；研究层五状态契约在 `challenge-statistics.mjs#causalAttributionStatus`。

## 4. 维度独立变化矩阵

测试断言 ≥6 种 (PC,EA,TO) 组合同时可达：PASS/PASS/PASS、PASS/PASS/FAIL、FAIL/PASS/PASS、PASS/FAIL/PASS、FAIL/PASS/FAIL、FAIL/FAIL/FAIL、UNKNOWN/UNKNOWN/UNKNOWN。`behaviorAligned`（复合验收）与 `principleConformance`（独立维度）在过度执行场景明确解耦（composite=false 而 PC=PASS）。

## 5. 边界与诚实声明

- 六类策略是确定性脚本：它们校准的是**评分器**，不是任何模型的行为。
- `inapplicableTrigger` 是活动观测指标（在 Gold 判定不适用的题上出现查证活动），不是动机归因。
- v4 历史九题（v2 契约）的校准复算保持原语义原结果（`run-exm-mvp-offline.mjs` 9/9，hash 一致），未用 v3 重评历史。
- 本轮 Real Model Calls = 0；Real Host Runs = 0；Production Writes = 0。
