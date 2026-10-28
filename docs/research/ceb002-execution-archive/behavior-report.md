# Behavior Report — CEB-002

- schema: `challenge-behavior-report.v1`
- status: **REPORT_READY**
- generatedAt: 2026-10-27T15:00:00.000Z
- assignedDenominator: 96
- executedUnits: 96

## Scope

| scope | value |
|---|---|
| preregistered | arms A/B/C × 16 cases × 2 rep(s) = 96 |
| authorized | APPROVED (valid, bindings match) |
| settlements | succeeded 96 / failedKnown 0 / resultUnknown 0 / reservedUnsettled 0 / notStarted 0 |
| lost to follow-up | 0 unit(s) — retained, excluded from valid pairs |
| out-of-scope executions | 0 |

## Integrity findings

(none)

## 1. 协议/证据质量 (protocolEvidenceQuality)

- runs: 12; validExecutionUnits: 96; validPairedCasesAB: 32
- identity attested: 96/96
- failureClasses: capacity=0, identity=0, protocolContract=0, behaviorViolation=15, objectiveTaskFailure=16
- refusalReasons: {"budget_exhausted":528}

## 2. 行为收益 (behavioralBenefit — applicable-positive A/B pairs only)

- pairedCases: 22; A pass 18 / aligned 18; B pass 14 / aligned 15; B−A pass -4
- descriptive paired counts only — no causal claim (SPEC §1.2/§9.4)

## 3. 边界/负迁移 (boundaryNegativeTransfer — scorer verdicts verbatim)

| arm | units | boundaryRisk (forbiddenBehavior) | negativeTransfer (scorer) |
|---|---|---|---|
| A | 10 | 0 | 1 |
| B | 10 | 0 | 3 |
| C | 10 | 0 | 2 |

## 4. 客观任务结果 (objectiveTaskOutcome — separate from behavior)

| arm | units | PASS | FAIL | applicable pass | boundary pass |
|---|---|---|---|---|---|
| A | 32 | 28 | 4 | 18/22 | 10/10 |
| B | 32 | 24 | 8 | 14/22 | 10/10 |
| C | 32 | 28 | 4 | 18/22 | 10/10 |

## 5. 成本 (cost — observable only, unavailable never zero-filled)

| arm | attempts | requests | tokens (total) | toolSteps | timing |
|---|---|---|---|---|---|
| A | 32 | 97 | 150003 | 295 | observed |
| B | 32 | 99 | 178710 | 298 | observed |
| C | 32 | 102 | 197737 | 310 | observed |

## 6. 覆盖 (coverage)

| family | cases in suite | cases with valid execution | valid A/B pairs |
|---|---|---|---|
| BOUNDARY_NEGATIVE_CONTROL | 5 | 5 | 10 |
| CROSS_CONTEXT_TRANSFER | 2 | 2 | 4 |
| FAILURE_VARIANT | 3 | 3 | 6 |
| TRADEOFF_CONFLICT | 6 | 6 | 12 |

- independentDecisionVariables: NOT_ESTIMABLE
- transferEstimability: NOT_ESTIMABLE

## Sensitivity

- recoveredFromUnknown: 0 unit(s)
- ambiguousPrimary: 0 unit(s)

## Limitations

- descriptive aggregation of raw evidence only — no causal inference (SPEC §1.2)
- unknown/failed settlements are honest outcomes, not corruption; coverage is limited by what actually settled
- monetary cost unobservable without a bound per-token price; tokens are reported raw
