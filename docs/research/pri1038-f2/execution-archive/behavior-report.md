# Behavior Report — CEB-001

- schema: `challenge-behavior-report.v1`
- status: **REPORT_READY**
- generatedAt: 2026-10-30T04:59:05.000Z
- assignedDenominator: 36
- executedUnits: 36

## Scope

| scope | value |
|---|---|
| preregistered | arms A/B/C × 12 cases × 1 rep(s) = 36 |
| authorized | APPROVED (valid, bindings match) |
| settlements | succeeded 36 / failedKnown 0 / resultUnknown 0 / reservedUnsettled 0 / notStarted 0 |
| lost to follow-up | 0 unit(s) — retained, excluded from valid pairs |
| out-of-scope executions | 0 |

## Integrity findings

(none)

## 1. 协议/证据质量 (protocolEvidenceQuality)

- runs: 1; validExecutionUnits: 36; validPairedCasesAB: 12
- identity attested: 0/36
- failureClasses: capacity=0, identity=0, protocolContract=0, behaviorViolation=2, objectiveTaskFailure=2
- refusalReasons: {}

## 2. 行为收益 (behavioralBenefit — applicable-positive A/B pairs only)

- pairedCases: 9; A pass 9 / aligned 9; B pass 8 / aligned 8; B−A pass -1
- descriptive paired counts only — no causal claim (SPEC §1.2/§9.4)

## 3. 边界/负迁移 (boundaryNegativeTransfer — scorer verdicts verbatim)

| arm | units | boundaryRisk (forbiddenBehavior) | negativeTransfer (scorer) |
|---|---|---|---|
| A | 3 | 0 | 0 |
| B | 3 | 0 | 0 |
| C | 3 | 0 | 0 |

## 4. 客观任务结果 (objectiveTaskOutcome — separate from behavior)

| arm | units | PASS | FAIL | applicable pass | boundary pass |
|---|---|---|---|---|---|
| A | 12 | 12 | 0 | 9/9 | 3/3 |
| B | 12 | 11 | 1 | 8/9 | 3/3 |
| C | 12 | 11 | 1 | 8/9 | 3/3 |

## 5. 成本 (cost — observable only, unavailable never zero-filled)

| arm | attempts | requests | tokens (total) | toolSteps | timing |
|---|---|---|---|---|---|
| A | 12 | 33 | unavailable | 99 | unavailable |
| B | 12 | 34 | unavailable | 103 | unavailable |
| C | 12 | 30 | unavailable | 91 | unavailable |

## 6. 覆盖 (coverage)

| family | cases in suite | cases with valid execution | valid A/B pairs |
|---|---|---|---|
| BOUNDARY_NEGATIVE_CONTROL | 3 | 3 | 3 |
| CROSS_CONTEXT_TRANSFER | 3 | 3 | 3 |
| FAILURE_VARIANT | 3 | 3 | 3 |
| TRADEOFF_CONFLICT | 3 | 3 | 3 |

- independentDecisionVariables: NOT_ESTIMABLE
- transferEstimability: NOT_ESTIMABLE

## Sensitivity

- recoveredFromUnknown: 0 unit(s)
- ambiguousPrimary: 0 unit(s)

## Limitations

- descriptive aggregation of raw evidence only — no causal inference (SPEC §1.2)
- unknown/failed settlements are honest outcomes, not corruption; coverage is limited by what actually settled
- monetary cost unobservable without a bound per-token price; tokens are reported raw
