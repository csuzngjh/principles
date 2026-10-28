# Phase 2a 终局对照指标（B0/B1 v2/E，机器复算）

> 生成者：`stage-g-phase2a-final-metrics.mjs`（确定性离线复算，证据=仓内冻结资产；重跑结果除 generatedAt 外逐字节一致）

| 臂 | 提交 | validator | 网格(/110) 提交/有效 | 完整组合(/31680) 提交/有效 | 实质情境(/3960) 提交/有效 | 重复(e/s/k) | 机制 facets | leak 守卫失败 |
|---|---|---|---|---|---|---|---|---|
| B0 | 36 | 36/36 | 3/110 / 3/110 | 36/31680 / 36/31680 | 36/3960 / 36/3960 | 0/12/0 | 8 | 0 |
| B1v2 | 36 | 36/36 | 36/110 / 36/110 | 36/31680 / 36/31680 | 36/3960 / 36/3960 | 0/0/0 | 8 | 0 |
| E | 60 | 40/60 | 17/110 / 15/110 | 52/31680 / 36/31680 | 52/3960 / 36/3960 | 0/0/8 | 8 | 20 |

## 请求记账（全 10 轮）

结果请求 141｜成功 11｜FAILED_KNOWN 105｜RESULT_UNKNOWN 25｜拒绝 0｜计费口径 {"free_tier_zero_cost":11}｜模型预算费 $0

## 机械×评审失败集收敛（信封级）

修复后 validator OBS-D1 方向守卫失败 20 个，AI-only 评审关键门槛失败 20 个，**集合完全一致=true**（同一 OBS-D1 旧文本根因，两个独立方法交叉证实）。

## AI-only 盲评（OWNER_DELEGATED，2026-10-27 决策记录随行）

关键门槛通过 40/60（20 失败根因=OBS-D1 共享库缺陷，PR #2138 已修）；non_duplication 12/40；结构类（评审自身类定义）36/60；机械 skeleton×constraints 键 52/60（提交全集）与 36/60（有效子集）并列、互不混用；全维通过 11。限制：single-pass、无 kappa。

## PRI-1035 八项必报指标

```json
{
  "validRatio": {
    "B0": "36/36",
    "B1v2": "36/36",
    "E_mechanicalCurrentValidator": "40/60",
    "E_reviewCriticalGate": "40/60",
    "note": "B0/B1 mechanical pass is a structural ceiling (1.0, recomputed post-OBS-D1-fix library). E 的 20 失败=旧库 OBS-D1 答案方向文本（生成时共享库缺陷，PR #2138 已修复）——机械守卫与 AI-only 评审在信封级识别出完全相同的 20 个（见 convergence）；该失败类不代表 Examiner 模型能力差异，两臂生成时同等暴露。"
  },
  "mechanismCoverage": {
    "B0": 8,
    "B1v2": 8,
    "E": 8,
    "facetsList_E": [
      "authorization_gate",
      "budget_triage",
      "deadline_tradeoff",
      "misleading_neutral_evidence",
      "overcheck_restraint",
      "self_output_contradiction",
      "unobservable_downgrade",
      "wrong_object_precision"
    ]
  },
  "decisionVariableDiversity": {
    "B0_paramGrid": {
      "submitted": "3/110",
      "validOnly": "3/110"
    },
    "B1v2_paramGrid": {
      "submitted": "36/110",
      "validOnly": "36/110"
    },
    "E_paramGrid": {
      "submitted": "17/110",
      "validOnly": "15/110"
    },
    "B0_substantive": {
      "submitted": "36/3960",
      "validOnly": "36/3960"
    },
    "B1v2_substantive": {
      "submitted": "36/3960",
      "validOnly": "36/3960"
    },
    "E_substantive": {
      "submitted": "52/3960",
      "validOnly": "36/3960"
    },
    "E_uniqueTaskTexts": "60/60",
    "E_uniqueCandidateIds": "36/60",
    "E_B1_substantiveOverlap": 0
  },
  "nearDuplicateRate": {
    "B0_duplicates": {
      "exact": 0,
      "structural": 12,
      "skeleton": 0
    },
    "B1v2_duplicates": {
      "exact": 0,
      "structural": 0,
      "skeleton": 0
    },
    "E_duplicates": {
      "exact": 0,
      "structural": 0,
      "skeleton": 8
    },
    "E_reviewNonDuplicationPass": "12/40",
    "E_reviewStructureClasses_ownDefinition": "36/60",
    "E_mechanicalStructureClasses_skeletonXConstraints": "52/60 (submitted-all; valid-only 36/60)",
    "note": "判度纪律（SPEC §0.15/附录A）：去重与新颖性不得单独作为 Examiner 增量证据。"
  },
  "goldLeakRate": {
    "B0": 0,
    "B1v2": 0,
    "E_mechanicalLeakGuard": 20,
    "E_reviewGoldIndependenceFail": 20,
    "E_reviewSafetyLeakageFail": 20,
    "note": "E 20/60 = OBS-D1 旧文本答案方向提示（语义泄漏判定）；merge 采纳管线保持 Gold 结构性不可注入（骨架哈希与基线一致）。"
  },
  "compileRejectionRate": {
    "E_requestsFailedKnown": "105/141",
    "E_parsedDraftsRejected": 0,
    "note": "拒绝面全部在请求层（403/404/429/超时/解析失败，见 perRound）；解析成功并入采纳管线的 60 候选 100% 通过当时的骨架门。"
  },
  "humanRevisionMinutes": {
    "status": "NOT_MEASURED",
    "manualRevisionEvents": 0,
    "reason": "Per-candidate start/end times were not measured; human revision-time metrics cannot be estimated from this review."
  },
  "costPerValidCandidate": {
    "modelBudgetCostUsd": 0,
    "meteringEvidence": {
      "free_tier_zero_cost": 11
    },
    "requestsPerAdoptedEnvelope": 2.35,
    "requestsPerReviewValidCandidate": 3.52,
    "candidateProducingSucceededRequests": 10,
    "tokenNote": "usage token counts in ledgers are simulated/formula rehearsal values (simulatedUsage=true) — never real metering; the only hard cost basis is request count and $0 free-tier metering (Owner-confirmed 2026-10-25)."
  }
}
```
