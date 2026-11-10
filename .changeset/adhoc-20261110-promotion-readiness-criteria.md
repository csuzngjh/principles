---
"@principles/core": patch
---

Promotion readiness now derives its `status` from one explicit evidence-criteria list instead of four inline threshold comparisons, and exposes that explanation from the activation module (`PROMOTION_EVIDENCE_THRESHOLDS`, `evaluatePromotionEvidenceCriteria`, `explainPromotionReadiness`).

- The four numeric thresholds (observed samples, matched samples, neutral-control samples, shadow age) live in exactly one frozen object, so an explanation can never describe a different number than the one that was judged.
- `ready` / `evidence_insufficient` / `blocked` / `unavailable` semantics are unchanged: the criteria are computed from the same snapshot the status is derived from, and a criterion is satisfied at `current === threshold` with no `shortfall` reported.
- No change to the package barrel surface, persisted contracts or CLI output.
