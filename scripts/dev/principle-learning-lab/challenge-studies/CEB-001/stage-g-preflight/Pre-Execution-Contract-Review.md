# Pre-Execution Contract Review — Stage G 最终执行前契约复核（增量）

> 执行日期：2026-10-25（无模型、无生产写入）
> 基线：`Owner-Review-Consistency-Check.md`（READY_FOR_OWNER_REVIEW）之上补齐四项必需契约
> 本次变更：validator 增加重放门（+导出领域库）、prereg draft 增补三节、测试 +4；冻结资产/枚举器网格/既有实现零破坏
> 状态裁定：**READY_FOR_OWNER_REVIEW（维持，不升级 READY_TO_RUN）**

---

## §1 Gold 独立性 — `RESOLVED_WITH_EVIDENCE`（发现真实缺口并实现最小修复）+ 新领域核验人 `OWNER_DECISION_REQUIRED`

**缺口确认（复核前现状）**：Stage G 候选信封允许提交方自编 `caseDef`（含 facts/observations/implies 蕴含结构）。原 validator 的 gold 组只做**结构一致性**（可确立性+世界一致性）——Examiner 完全可以自编一组自洽的事实与蕴含再以之为 Gold，结构检查无法证明真值独立。**原状不满足「Gold 必须来自冻结模拟环境/确定性规则/独立权威来源」。**

**最小修复（已实现，`lib/challenge-validator.mjs`）——冻结环境重放门 `verifyGoldIndependence`**：

- **parametric_verified**：候选声明 parameters.{domain, distractor}，由**冻结枚举器**以相同参数重放，`caseDef` canonical **逐字节相等** → Gold 来自冻结模拟环境（领域库 `DOMAIN_LIBRARY`/`DISTRACTOR_LIBRARY` 已导出为权威源）→ `eligibleForValidSet: true`。
- **domain_proposal**：重放失败（无库条目/内容被改写/未声明参数/全新情境）→ tier=domain_proposal，**永不直接进入合格题集**（validator ok=false，gold 组明示『domain proposals require a separately verified frozen library entry』）。自编事实是作者主张，不是权威真值。
- **Examiner 权限边界（现在由代码强制）**：可选可信模板允许的参数（domain/distractor 等）；不得以自编事实充当 Gold（重放门拒绝）；无法建立独立真值的候选不进合格集。**新领域必须先经独立核验并冻结入库（入库核验人待 Owner 指定）后才可成为 parametric 来源。**

**测试证据**（`principle-learning-lab-challenge-stageg.test.ts`，30/30 全绿，exit 0）：
- 枚举候选 → `parametric_verified` + eligible ✓
- 篡改库内容冒充 parametric → 重放不等 → 拒绝 ✓
- 结构完美但无库条目的 Examiner 新情境 → `no frozen library entry` → 拒绝 + 永不 eligible ✓
- B 臂 36 候选全部 replay-eligible（构造即独立）✓

复现：`cd scripts && npx vitest run __tests__/principle-learning-lab-challenge-stageg.test.ts` → 30 passed / 30。

## §2 候选槽位与失败分母 — `RESOLVED_WITH_EVIDENCE`（契约补齐）

已写入 prereg draft 新节 `candidateSlotsAndDenominator`（预注册，不可事后调整）：

- **槽位分配**：两组各 36 槽（共同上限=B 网格全量）；B 槽 ID=`ENUM-<族>-<domain>-<distractor>`（确定性分配）；E 槽 ID=`SLOT-E-001..036`（预分配、与请求顺序绑定）。
- **失败记账**：逐槽类型 ∈ {valid_candidate, format_error, empty_output, refusal, budget_exhausted_unfilled, result_unknown, validator_rejected(带原因), domain_proposal_pending}；全部写入 draft log 追加记录（含失败输出与拒绝原文）。
- **未填满槽**：16 请求（含重试）耗尽 → 剩余槽记 `budget_exhausted_unfilled` 并报告；禁止静默补题、禁止收缩分母。
- **有效率口径**：分母恒 = 36（全部槽位）；分子 = validator + 盲评关键门槛双合格槽数；**绝不对仅成功解析的输出计算有效率**。
- **请求规则**：FAILED_KNOWN 重试 1 次计入 16 上限；RESULT_UNKNOWN 不重试（槽记 result_unknown，费用保留）；预算耗尽即停。
- **未删除任何失败候选**（保留纪律不变）。

如实披露：本节为**契约层**就绪；E 臂槽位记账的运行时执行属 PRI-1034/1035（未实现、未授权），届时按本契约实现并验收。

## §3 模型级成本核算 — 核算 `RESOLVED_WITH_EVIDENCE` + 三输入 `OWNER_DECISION_REQUIRED`

prereg draft `worstCaseArithmetic` 已按分价模型重写并新增 `costLedgerSeparation`：

- **分价公式**：`worstCaseModelCostUsd ≤ 16 × (8000 × pIn + 4000 × pOut)`；单请求最坏 = `8000×pIn + 4000×pOut`。
- **请求前硬限制 vs 请求后观测**（明文分级）：硬限制=总请求 16（含重试）/max_tokens/槽位 36；观测=响应 usage 与实际费用；**请求前核对「累计观测费用+本请求最坏费用>上限→拒绝发送」**。
- **单请求超支风险披露**：该核对不排除计费口径（缓存/token 计数/微粒度）造成的微小超支——实际口径响应后才可知，硬止损点在下一次请求前；**不得表述为『单次请求绝不超支』的服务端保证**。
- **人工/模型分账**：模型费随 budget-ledger（预留→结算）；人工费=时薪×实测分钟按候选入账；`totalCost = modelCost + humanCost`；`costPerValidQuestion = totalCost / 合格槽数`。
- **$3 维持 PROPOSED_NOT_APPROVED**：缺失输入=①模型与版本选定 ②输入/输出分价公示单价 ③人工时薪。示例演算（DEMONSTRATION_ONLY）：pIn $10/M+pOut $30/M → ≤$1.76；$15/$45 → ≤$2.64。

## §4 盲评统计补充 — `RESOLVED_WITH_EVIDENCE`（规则全部预注册）

prereg draft `blindReview.statsReportingRules` 新增五条（预注册后不得依结果调整）：

1. **undecidable 数量与比例**：双评均 undecidable 与单方 undecidable **分列**报告（逐维度）。
2. **kappa 分母 N**：报告实际进入计算的样本数（= 总候选 − 双方 undecidable − 缺失），逐维度给出。
3. **原始一致率**：与 kappa 并报（raw agreement = 一致对数/N），防低 N 下 kappa 误导。
4. **最低可评估样本比例**：N/总候选 ≥ **0.70** 方可计算并采信该维度 kappa；低于 → 该维度标 INCONCLUSIVE（不换统计量、不放宽）。
5. **缺失数据规则**：评审缺失计 missing（留 validRatio 分母、出 kappa 分母、入 missing 报告）。

kappa 本体维持：无权重 Cohen's kappa，逐维度二值 + 关键门槛三维度合并；评审者人选与人工时薪仍为 `OWNER_DECISION_REQUIRED`。

---

## 执行边界确认

- 无模型调用（重放门/全部测试为确定性本地函数）；无宿主实验；无生产写入；冻结资产零改动（四哈希不变，见下）；未签发授权（generation/run-authorization 均 NOT_AUTHORIZED）；未动 Linear、未建 PR、未 commit；无 pull/merge/rebase/reset/clean/stash/checkout；全部既有工作树修改与未跟踪文件保留。
- 本次变更清单（全部在授权范围）：`lib/challenge-enumerator.mjs`（仅新增 2 个 export，网格零改动）、`lib/challenge-validator.mjs`（新增 verifyGoldIndependence + 接线）、`preregistration.stage-g.draft.json`（+3 节/重写 worstCase）、`principle-learning-lab-challenge-stageg.test.ts`（+4 测试）、本报告。

## 最终验证

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx vitest run __tests__/principle-learning-lab-challenge-stageg.test.ts` | 0 | **30/30** |
| 全量回归（1A/1B/lab×6/卫生×2） | 0 | **298/298** |
| `freeze-challenge-study.mjs --study CEB-001 --verify` | 0 | VERIFY OK（四冻结哈希不变：`213090da`/`eef38484`/`e1f2f5ca`/`01ac054b`） |
| 授权/隔离状态终验 | — | generation=NOT_AUTHORIZED；run=NOT_AUTHORIZED；realHostBaseline=UNKNOWN；PRI-1037=NOT_RUN |

## 结论

**READY_FOR_OWNER_REVIEW（维持）**。四项契约全部补齐并带证据；未决事项（模型/单价/时薪/评审者/新领域核验人/协议与阈值批准/PRI-1034 实现授权/Stage G 签发）全部显式列示。不升级为 READY_TO_RUN；Stage G 未执行、无 Examiner 与枚举的优劣主张。
