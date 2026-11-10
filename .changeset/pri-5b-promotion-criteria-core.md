---
"@principles/core": minor
---

Promotion readiness gains an explainable `criteria` projection (5B).

`PromotionReadinessResult` adds an **optional** `criteria:
PromotionReadinessCriterion[]`. Each of the 10 required check ids produces
exactly one entry with `status: 'passed' | 'failed' | 'not_evaluated'`; a check
that never ran is `not_evaluated` rather than being reported as passed.
Failures recorded in `failedChecks` take precedence over gate results, and
non-required failures (e.g. `evidence_binding`) are appended.

Evidence criteria (`shadow_observed`, `shadow_matched`,
`shadow_neutral_control`, `shadow_age`) carry `current / threshold /
shortfall` and are projected only when the shadow summary was actually
observed. No threshold rule or evidence collection changed.

Minor, not patch: a new public projection is exported from the activation
barrel. `criteria` stays optional on purpose — making it required is a separate
breaking change (5C) and is not part of this release, so existing constructors
keep compiling.
