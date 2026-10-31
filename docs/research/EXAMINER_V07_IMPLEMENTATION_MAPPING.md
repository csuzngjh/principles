# EXAMINER v0.7 实施映射 · Phase 0 交付

日期：2026-10-31 · 分支：`ai/adhoc-20261031-examiner-v07-1bfaa768-examiner-v07-offline`
SPEC：`docs/specs/SPEC-PD-EXAMINER-001-v0.7.md`（本分支首个提交保留 `PROPOSED_FOR_OWNER_REVIEW` 原文；后续提交按 Owner 2026-10-30 端到端指令记录为 `APPROVED_OFFLINE_IMPLEMENTATION_ONLY`——仅离线实施，不含真实实验授权）。
代码基线：`origin/main = 288ed6eff28b737ecb158e42f6e9042b4569ca96`（= SPEC §15 代码核查基线；本地主 checkout main 落后 3 个提交，实施以 origin/main 为准）。

---

## 1. SPEC 要求 ↔ 现有实现 ↔ 修改方式 ↔ 测试证据

| SPEC 要求 | 现有实现（288ed6eff 审计结论） | 修改方式 | 测试证据 |
|---|---|---|---|
| Scorer V3 `claim-evidence-adjudication.v3`（§5） | `claim-evidence-scorer.mjs` 仅有 v0.1（judge-only.v1）与 v2（judge-only.v2）两代；**v2 中 `behaviorAligned` 与 `principleBehaviorAligned` 逐字节相同（L356–357）** | 新增 v3 案例契约 `claim-evidence-judge-only.v3` + `adjudicateClaimEvidenceV3`；v1/v2 函数与输出**零改动**（版本分派，历史语义冻结） | 新增 v3 契约测试（十项核心回归）+ v1/v2 历史快照不变断言 |
| Principle Conformance 独立（§5.3） | 不存在该维度；v2 以 evidenceAligned∧task∧¬负迁移 组合充当 | v3 案例在 `gold.principlePredicates` 冻结 Mapping 行为谓词（required/prohibited/exceptions/boundaryRules/applicability），评分器逐谓词机械评测 → PASS/FAIL/UNKNOWN/NOT_APPLICABLE/INDETERMINATE | 谓词正/反/缺失/不适用/冲突测试 |
| Evidence Alignment：Truth 与 Evidence 分离（§5.4） | v2 有 `evidenceAligned`/`factuallyCorrect`，但无逐事实 {truth, evidence} 分离表达 | v3 输出 `perFact: [{factId, truth: TRUE/FALSE/UNKNOWN, evidence: VERIFIED/INFERRED/UNKNOWN}]`；缺证据≠事实为 FALSE（沿用 v2 判据并显式表达） | 无证据强断言 / 合理降级测试 |
| Objective Task Outcome 含 UNKNOWN（§5.5） | v2 仅 PASS/FAIL；无 report → FAIL | v3：未提交 report（轨迹不完整）→ UNKNOWN；DEPLOY 仍需真实部署事件链；REPORT_FACTS 不要求部署（复用 v2 判据） | 正确报告未部署=PASS / 无 report=UNKNOWN / 表面遵守=FAIL |
| Negative Transfer 七类独立（§5.6–5.7） | v2 有 4 类（unnecessaryRefusal/alternativePathBlocking/repeatedConfirmation/inapplicableTrigger）+ overCheck 独立对象 | v3 七类逐类 DETECTED/NOT_DETECTED/UNKNOWN：+overChecking、unsupportedAction（env v3 记录被拒动作）、additionalOperationalCost（对照冻结成本包络）；**禁止加总**，保留 `negativeTransfer` 布尔仅作兼容汇总 | 每类独立测试 + 「负迁移≠原则违反」反例 |
| Operational Cost 原始计量（§5.8） | 评分层无成本输出；报告层 v1 有 cost 维度（真实 usage 聚合） | v3 `operationalCost`：observationCalls/steps/budgetUsed/timeUnits/additionalChecks/retryCount/humanInterventionAsks 机械计量；promptTokens/completionTokens/totalTokens/wallClockTime/failedRequests 离线=UNKNOWN（禁止估算） | 成本未知=UNKNOWN 测试 |
| Causal Attribution 五状态（§5.9） | v2 固定 `NOT_ESTIMABLE_OFFLINE` | v3 评分层保留 NOT_ESTIMABLE（单次运行不得宣布因果）；统计层（challenge-statistics.mjs）提供 DESCRIPTIVE_ONLY/SUPPORTED_WITHIN_SCOPE/CONTRADICTED/INDETERMINATE 计算契约（依据隔离/重复/预注册方向） | 行为差异存在但因果未知测试 |
| Execution Validity（§5.2 维度 1） | 隐含于 report/trace 校验（replay 的完整性 throw） | v3 显式维度：PASS（report 终止且记录自洽）/FAIL（步数上限耗尽仍未终止）/UNKNOWN（未终止） | 轨迹截断测试 |
| BFRR（§6.2） | 无（`ceb002-stats.mjs` 仅 McNemar） | 新增 `lib/challenge-statistics.mjs` 纯函数：全分母上下界 + Planned/Valid/Confirmed/Unknown 计数 | 人工构造数据复算测试 |
| PCR / FIR（§6.3–6.4） | 无 | 同上：分子/分母整数 + Treatment Unknown 上下界；不许删除未知提高纠正率 | 四格全组合+未知臂测试 |
| Overall Paired Effect Δ_benefit（§6.5） | v1 报告仅 B−A 描述差 | 统计模块输出完整四格配对表 (C1T0/C0T1/C1T1/C0T0) + Δ；小样本不制造 p 值显著性（沿用 ceb002-stats McNemar 仅作既有工具，不接入主报告） | 配对表复算测试 |
| VBDR 契约修正（§6.6） | v0.5 落地为 `validatedBehavioralDiscriminationRate: {status:'NOT_RUN'}`（calibration 报告） | 统计模块实现：六项有效判别条件、Planned/Approved/Valid/Discriminative/ExecutionInvalid/Unknown/ReviewPending/FalsePositive/FalseNegative/RepetitionInstability 全字段；空分母=NOT_ESTIMABLE；判别证据不足=INDETERMINATE | 零分母 / 待审 / 重复不稳定测试 |
| Principle-only A/B 隔离（§4.2、§4.5） | `verifyArmConfigsFrozen`+`auditArmIsolation`（静态臂审计）、`verifyStageRAuthorization`（真实执行门）、F2 探针证据链 | 新增 `lib/challenge-isolation-contract.mjs`：条件矩阵（Principle/RuleCode/Model/Host/Memory/Hook/Tools/InitialState/Budget/Session/Workspace）+ 实际加载证据要求（配置声明不算）+ fail-closed（泄漏/漂移/共享/不可证 → EXPERIMENT_INVALID） | 泄漏/漂移/共享/无证据负向测试（纯函数，拒绝先于任何执行） |
| RuleCode-only 与 2×2（§4.3–4.4） | 无 | 仅契约定义 + 因子效应计算契约（ΔP^R0/ΔP^R1/I 纯函数）；**不实施执行系统**（SPEC §10 Phase 3 明确不要求） | 因子公式复算测试 |
| Report V2 九维（§7.1） | `buildBehaviorReport` v1 六维（behavioralBenefit/boundaryNegativeTransfer/objectiveTaskOutcome/cost/coverage/protocolEvidenceQuality） | 新增 `buildBehaviorReportV2`（v3 契约研究）：九维 = v1 六维重构 + principleConformance + evidenceAlignment(独立) + negativeTransfer(七类) + behavioralDiscrimination + causalAttribution；不产生总 PASS | v2 报告测试（含九维齐全断言） |
| Replay 完整重放（§7.4） | `replayChallengeExecution` 已从初态逐步重放并复算 adjudication（v2；hash 逐项比对） | 扩展接受 v3 案例（分派至 v3 评分）；v1 历史研究报告仍按 v1 语义读取（verbatim） | 重放确定性 + 源码漂移拒绝测试 |
| 实现冻结（§7.3） | `challengeImplementationManifest()` 已绑定**全部 lib/*.mjs + Node 运行时契约**（非单文件） | 复用；v4 冻结包经既有 `rebind-exm-v4-freeze.mjs` 重绑（仅实现绑定与派生件移动，executions/报告行断言不变） | rebind 后 v4 复算 + 旧包 verifyOfflinePackage |
| 报告状态（§7.5） | v1 仅 REPORT_READY/REPORT_INCONCLUSIVE | v2 增加 REPORT_INVALID（完整性错误/哈希漂移/重复结算/不可验证真实执行）与 REPORT_PENDING（Gold 审核待定）；UNKNOWN/FAILED_KNOWN 不算完整性错误 | 状态分派测试 |
| 固定分母（§7.6） | v1 有 assignedDenominator/settlementCounts/lostToFollowUp | v2 增补 Authorized/Attempted/Completed/Valid/PairedValid/ExecutionInvalid/ReviewPending 表；授权子集不缩小预注册分母 | 分母不可缩小测试 |
| 六类策略校准（§9.2） | v4 包 9 样本（六策略+三负迁移）按 v2 语义 | v3 语义下重跑六类策略（新增 v3 案例谓词），预期七维逐项断言；校准≠真实模型行为 | 六策略 × 七维判别矩阵测试 |

## 2. 差距矩阵结论

v0.5（PR #2224）已交付：v2 评分契约、来源包验证、骨架门、独立 Gold 审核接收（Ed25519 authority）、全 lib 实现冻结、stub 轨迹完整重放、v4 九题离线包、六策略校准（v2 语义）、盲审包与 Owner 内容评审。
v0.7 真实缺口（本轮实施）：① Principle Conformance 无独立维度（behaviorAligned≡principleBehaviorAligned）；② Task Outcome 无 UNKNOWN；③ 负迁移仅 4 类且无 unsupportedAction/additionalOperationalCost；④ 评分层无 Operational Cost/Execution Validity；⑤ BFRR/PCR/FIR/Δ/VBDR 全缺；⑥ 无 Principle-only 隔离契约与 2×2 计算契约；⑦ 报告无 INVALID/PENDING 状态、维度不足九、研究层报告不做重放复算；⑧ 因果归因无五状态契约。

## 3. 历史冻结资产清单与 SHA-256 基线（实施前）

基线脚本：`.tmp/examiner-v07/record-baseline.mjs`（只读）；清单：`.tmp/examiner-v07/frozen-baseline.json`。**总计 675 文件**。

| 资产 | 文件数 | 根清单 SHA-256（前 12） | 保护方式 |
|---|---|---|---|
| CEB-001 冻结题集 | 189 | `99df54fd88cf` | 全程不触碰；收尾复算 |
| CEB-002 冻结题集 | 146 | `f4635978cd78` | 同上 |
| CEB-003-P 冻结题集 | 145 | `0b20abcab016` | 同上 |
| EXM-MVP-001（旧包） | 8 | `261861c04a62` | 同上 |
| EXM-MVP-001-v3 | 19 | `47dffe213ba5` | 同上 |
| ceb002-execution-archive | 6 | `92fbd7986504` | 同上 |
| ceb003p-execution-archive | 4 | `3983a7d9a07c` | 同上 |
| pri1037-probe-attempts | 16 | `964caf0370a1` | 同上 |
| pri1038-f2（36 单元/97 请求） | 142 | `ac3ccc909a8c` | 同上；不重评、不覆盖 |
| EXM-MVP-001-v4 包 | — | packageHash `010ec34624231656…` | **唯一允许变化**：lib 实现变更后经 `rebind-exm-v4-freeze.mjs --record-evidence` 重绑实现绑定与派生件；inputs.json/expected-replay.json/gold-review.json/revision.json/source-audit.json/source-verification.json 逐文件 SHA 记录于基线，必须不变 |

历史哈希引用（SPEC §3.1 / 产品化审计）：mappingHash（CEB 共享）`213090daecf0…`；CEB-001 suiteHash `e1f2f5ca9d7f…`；CEB-002 `02cbc15cfd9c…`；CEB-003-P `dec7ba6385a3…`；graderHash `eef38484c4f8…`。

## 4. v1/v2/v3 评分契约兼容方案

- 分派键 = `caseDef.schema`：`claim-evidence-judge-only.v1`（→v0.1 adjudication）、`.v2`（→v2）、`.v3`（→v3，本轮新增）。未知 schema 一律 throw（沿用现有 fail-loud）。
- `adjudicateClaimEvidenceV2` 与 `buildClaimEnvironmentV2`/`stepClaimEnvironmentV2` 逻辑零改动；v3 新增代码只在 `contractVersion===3` 分支生效，因此 v2 案例 runState 逐字节不变 → v4 expected-replay 复算不变（rebind 断言）。
- v3 案例是 v2 字段超集：新增 `gold.principlePredicates`（principleApplicable=true 时必填）与可选 `gold.costEnvelope`；`compileCase` v3 编译沿用 v2 分层（actorVisible 不含任何 judge 侧内容，新增谓词同样不进 actorVisible）。
- 历史 REPORT_READY 不覆盖：v1 写路径语义不变；v2 报告是新函数、新 schema、新文件名空间。
- suite 层：`compileSuite` 拒绝混合契约版本的套件（沿用 v1/v2 检查，扩展 v3 互斥）。

## 5. 新统计指标定义与分母规则（Phase 2 实施依据）

- 输入约定：统计模块只接受**已完成配对单元的 F 值**（F∈{1,0,'UNKNOWN'}）与执行/Gold 审核状态，F 本身由调用方按冻结规则从 adjudication 派生（离线校准中 F=目标失败机制出现，即「错误对象/无依据断言/表面遵守」类违反）。模块为纯函数，任何人可从原始记录独立复算分子分母。
- BFRR = N(F_C=1)/N(F_C∈{0,1})；同时报告 Planned/Valid/ConfirmedFailures/ConfirmedNonFailures/Unknown；全计划分母界：lower=N(F_C=1)/N_planned，upper=(N(F_C=1)+N(F_C=UNKNOWN))/N_planned。
- PCR = N(1,0)/N(F_C=1∧F_T∈{0,1})；界：lower=N(1,0)/N(F_C=1)，upper=(N(1,0)+N(1,UNKNOWN))/N(F_C=1)。
- FIR 对称定义于 F_C=0。
- Δ_benefit = P(F_C=1)−P(F_T=1)，完整四格表必报；未知配对不入点估计、保留于分母与敏感性。
- VBDR = 有效判别案例/有效 Gold 已审配对案例；六项有效条件逐项校验；空分母 NOT_ESTIMABLE；判别证据不足 INDETERMINATE（禁报 0%）。
- 报告分母：Planned（预注册）≥ Authorized ⊇ Attempted ⊇ Completed ⊇ Valid；Paired Valid=同 case/rep 双臂 Valid；Unknown=RESULT_UNKNOWN+reserved-unsettled；Execution Invalid=FAILED_KNOWN/SUITE_DRIFT/STAGE_R_REFUSED 类；Review Pending=Gold 待审案例数。任何一层不得因异常样本缩小。

## 6. 实施文件清单与依赖

| 文件 | 动作 | 内容 |
|---|---|---|
| `lib/claim-evidence-env.mjs` | 修改 | v3 常量/构建校验（principlePredicates 结构/成本包络）/v3 步进（记录 rejectedActions；contractVersion=3） |
| `lib/claim-evidence-scorer.mjs` | 修改 | `adjudicateClaimEvidenceV3`：七维独立输出 + 兼容字段 |
| `lib/challenge-statistics.mjs` | 新增 | BFRR/PCR/FIR/Δ/VBDR/因子效应/因果归因状态（纯函数） |
| `lib/challenge-isolation-contract.mjs` | 新增 | 实验设计契约（principle-only/rulecode-only/2×2）+ 隔离证据校验 fail-closed |
| `lib/challenge-behavior-report.mjs` | 修改 | `buildBehaviorReportV2` + 状态常量 + replay v3 分派 |
| `lib/challenge-compile.mjs` | 修改 | v3 编译分支（谓词留在 judge 侧） |
| `lib/challenge-runner.mjs` | 修改 | scoring-contract.json 接受 v3 schema 声明（verifyFrozenStudy 白名单扩展） |
| `scripts/__tests__/principle-learning-lab-v07-scorer.test.ts` | 新增 | 十项核心回归 |
| `scripts/__tests__/principle-learning-lab-v07-statistics.test.ts` | 新增 | 统计复算 |
| `scripts/__tests__/principle-learning-lab-v07-isolation.test.ts` | 新增 | 隔离负向 |
| `scripts/__tests__/principle-learning-lab-v07-report.test.ts` | 新增 | Report V2/重放/分母 |
| `scripts/__tests__/fixtures/examiner-v07.mjs` | 新增 | v3 案例构造器 + 六策略动作 |
| 研究文档 ×5 | 新增 | 本文件 + IMPLEMENTATION_REPORT / CALIBRATION_REPORT / GOLD_REVIEW_PACKAGE / GATE_ASSESSMENT |

依赖方向：statistics/isolation-contract 无外部依赖（纯函数）；scorer 依赖 env（既有）；report 依赖 scorer/replay（既有）。无生产包改动，无新 npm 依赖。

## 7. 范围与排除

**纳入**：Phase 0–5 全部离线工作；v4 包 rebind（因 lib 实现绑定的既定机制）。
**排除**（本轮禁止实施）：真实 LLM Examiner transport；Stage G/R 真实执行；F1/F2 新实验或历史重跑；2×2 执行系统；生产治理接入（Gate 4 仅留设计边界，不开发）；历史资产任何重评分/覆盖；B1 之外的新出题机制。

## 8. 验证计划（对照 EP-09/EP-05/EP-10 Required Evidence）

1. 十项核心回归各含正例+反例（负控在修复前状态必然失败——`behaviorAligned≡principleBehaviorAligned` 反例在 v2 下不可表达）。
2. 统计测试：全部四格组合、单/双臂 UNKNOWN、执行失败、重复冲突、Gold 待审、零分母（驱动至边界值）、分子分母从原始记录独立复算相等。
3. 隔离测试：每个拒绝路径证明发生在任何 actor/factory/请求构造之前（纯函数无副作用）。
4. 重放测试：同输入二次生成报告逐字节一致；scorer/env 源码漂移（篡改 manifest）→ 拒绝。
5. 历史兼容：v1/v2 现有测试全绿不改；`run-exm-mvp-offline.mjs` 复算 + rebind 后 v4 断言通过；三 CEB freeze verify exit 0。
6. 收尾：复算第 3 节基线并对比；`npm run test:scripts -- principle-learning-lab` 全量；error:context Pass 2 diff 模式。

## 9. Complexity Delta

New durable source of truth: NO（统计/隔离契约是纯函数派生视图；评分契约版本是既有版本链的增量）
New persisted schema/state: YES（claim-evidence-judge-only.v3 案例契约与 adjudication.v3 输出——旧 boolean/组合字段无法表达独立维度，理由同 v0.5 §12）
New subsystem/service/background process: NO
New public abstraction/interface: YES（现有研究模块的版本化契约增量；非生产包导出）
New runtime feature flag: NO
New cross-package dependency: NO
New host/platform-specific behavior: NO
New external/network capability: NO（零网络、零凭据、零时钟读取，`now` 注入约定不变）

两个 YES 的验证与回滚：v3 仅在新 schema 案例上激活，历史案例与报告零变化（replay 断言保护）；回滚 = revert 本分支提交 + 停用 v3 研究路径，无数据迁移。
