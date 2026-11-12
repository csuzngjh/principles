---
"@principles/core": patch
---

Diagnostician router: fail loudly when Stage B carries no usable principle or when the model emits more than one principle recommendation, instead of duplicating a single upstream principle across recommendations. Report an exhausted retry budget as `runtime_unavailable` instead of claiming `runtime_timeout`, and persist a bounded, redacted preview of the runner-rejected output in `diagnosticJson.output_failure_details` so validation failures stay diagnosable.
