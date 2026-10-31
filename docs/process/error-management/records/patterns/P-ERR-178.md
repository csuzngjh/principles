<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-178",
  "displayId": "ERR-178",
  "title": "New fail-closed validator made an E2E test pass for the wrong failure reason",
  "status": "active",
  "category": "Missing Tests & Verification",
  "ep": "EP-09",
  "createdAt": "2026-10-31",
  "source": "PRI-1059 / PR #2244 review"
}
-->

- **What happened**: Adding the Stage A evidence-ref gate changed WHY ATTACK-6 failed. Its pain evidence used `sourceRef: 'test'`, while the mock root-cause fallback returned `sourceRef: 'attack-test'`; the new gate rejected Stage A, the bridge still returned `failed`, and the test's `failed|retried` assertion stayed green — without ever reaching the router's empty-recommendations branch that the test exists to prove.
- **Why it's wrong**: The test asserted only a non-unique terminal signal. A failure at Stage A and a failure at router routing produce the same status and zero candidates, so the test could pass for the new gate's reason while the intended behavior was entirely untested.
- **Generalized failure mode**: A new upstream validation gate converts an existing downstream-path test into a false pass because the fixture refs are inconsistent with the new contract and the assertion accepts any failure.
- **Correct approach**: Make fixture provenance consistent with the gate (`attack-test` in both pain evidence and fallback output), and assert the intended execution path positively: Stage A and Stage B tasks must be `succeeded` before the router fails on empty recommendations.
- **How to prevent**: After adding any fail-closed validator, rerun every fixture-heavy E2E test and ask whether a failure now originates upstream of the claimed path. When a test accepts `failed|retried`, add a companion positive assertion naming which stage must have succeeded first.
- **Regression guard**: ATTACK-6 now asserts `diag_rootcause-*` and `diag_distiller-*` are `succeeded`. Negative control: restoring `sourceRef: 'test'` makes the test fail with `expected 'failed' to be 'succeeded'` on the root-cause task.
- **Source**: PR #2244 review (PRI-1059 Stage A evidence binding), CodeRabbit inline finding on `attack-e2e-pipeline-smoke.test.ts`
- **Date**: 2026-10-31
- **Recurrence**: First recorded occurrence for this mechanism.
