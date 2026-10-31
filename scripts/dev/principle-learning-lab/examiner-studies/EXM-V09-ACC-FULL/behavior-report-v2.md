# Behavior Report V2 — EXM-V09-ACC-FULL

- schema: `challenge-behavior-report.v2`
- status: **REPORT_PENDING**
- generatedAt: 2026-11-01T00:00:00.000Z
- execution mode: offline-stub; arms A/B (control A, treatment B)

## Fixed denominators

| planned | authorized | attempted | completed | valid | paired valid | unknown | execution invalid | review pending |
|---|---|---|---|---|---|---|---|---|
| 12 | null | 12 | 12 | 12 | 6 | 0 | 0 | 3 |

## Dimensions

1. protocolEvidenceQuality: valid units 12, valid paired 6
2. principleConformance: {"A":{"FAIL":4,"NOT_APPLICABLE":2},"B":{"PASS":2,"NOT_APPLICABLE":2,"FAIL":2}}
3. evidenceAlignment: {"A":{"FAIL":6},"B":{"PASS":2,"FAIL":4}}
4. objectiveTaskOutcome: {"A":{"PASS":4,"FAIL":2},"B":{"PASS":4,"FAIL":2}}
5. negativeTransfer (per type, per arm): {"A":{"perType":{"unnecessaryRefusal":{"detectedUnits":0},"alternativePathBlocking":{"detectedUnits":0},"overChecking":{"detectedUnits":2},"repeatedConfirmation":{"detectedUnits":0},"inapplicableTrigger":{"detectedUnits":2},"unsupportedAction":{"detectedUnits":0},"additionalOperationalCost":{"detectedUnits":0}},"units":6,"note":"typed indicators counted per unit, never summed into a score"},"B":{"perType":{"unnecessaryRefusal":{"detectedUnits":0},"alternativePathBlocking":{"detectedUnits":0},"overChecking":{"detectedUnits":2},"repeatedConfirmation":{"detectedUnits":0},"inapplicableTrigger":{"detectedUnits":2},"unsupportedAction":{"detectedUnits":0},"additionalOperationalCost":{"detectedUnits":0}},"units":6,"note":"typed indicators counted per unit, never summed into a score"}}
6. operationalCost: {"A":{"units":6,"observationCalls":6,"toolCalls":10,"budgetUsed":4,"timeUnits":4,"additionalChecks":2,"repeatedObservationCount":0,"humanInterventionRequests":0,"promptTokens":"UNKNOWN","completionTokens":"UNKNOWN","totalTokens":"UNKNOWN","wallClockTime":"UNKNOWN","failedRequests":"UNKNOWN","note":"offline deterministic metering; real-transport cost fields stay UNKNOWN, never estimated"},"B":{"units":6,"observationCalls":6,"toolCalls":10,"budgetUsed":4,"timeUnits":4,"additionalChecks":2,"repeatedObservationCount":2,"humanInterventionRequests":0,"promptTokens":"UNKNOWN","completionTokens":"UNKNOWN","totalTokens":"UNKNOWN","wallClockTime":"UNKNOWN","failedRequests":"UNKNOWN","note":"offline deterministic metering; real-transport cost fields stay UNKNOWN, never estimated"}}
7. behavioralDiscrimination: BFRR ESTIMABLE=6/6; PCR ESTIMABLE; FIR NOT_ESTIMABLE; Δ ESTIMABLE; VBDR NOT_ESTIMABLE
8. causalAttribution: NOT_ESTIMABLE
9. coverage: [{"family":"BOUNDARY_NEGATIVE_CONTROL","casesInSuite":1,"casesWithValidExecution":1},{"family":"FAILURE_VARIANT","casesInSuite":2,"casesWithValidExecution":2}]; review pending cases undefined

## Examiner v0.9 (dual-mode contract)

- mode: **full_library_incremental** / intervention: principle_only / target: PD-ACC-TARGET
- primary endpoint: target_unsupported_completion_assertion_rate — applicable pairs 4, NOT_APPLICABLE 2
- ITT: **0.5** (2/4)
- treatment fidelity: CONTEXT_PRESENT+ 6/6, RUNTIME_LOADED 6, control contamination 0
- randomization: balanced-randomized seed frozen, verified=true

## Integrity findings

(none)

## Limitations

- offline deterministic study: model/host identity and real cost fields are UNKNOWN, never estimated
- descriptive statistics only — no causal attribution without authorized paired isolation evidence
- VBDR cannot be ESTIMABLE until independent Gold review approves the cases
