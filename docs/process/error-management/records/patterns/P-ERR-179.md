<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-179",
  "displayId": "ERR-179",
  "title": "Whitespace-only evidence refs pass structural validation and the binding gate",
  "status": "active",
  "category": "Security & Safety",
  "ep": "EP-01",
  "createdAt": "2026-10-31",
  "source": "PRI-1059 / PR #2244 review"
}
-->

- **What happened**: `DefaultDiagRootCauseValidator` checked only that `causalChain[].evidenceRefs` was a non-empty array, not that each element was a non-empty string. A whitespace-only element (`"   "`) passed structural validation. The new evidence-binding helper trims the value and returns `null` for an empty result, so it also did not report an unbound reference. The Stage A output was therefore accepted with no usable evidence pointer.
- **Why it's wrong**: An evidence ref that resolves to no identifier cannot establish provenance. Passing whitespace defeats both the semantic purpose of the field and the new fail-closed binding gate.
- **Generalized failure mode**: A nested array is validated only at the container level; element contents are assumed valid because the schema says `string`, so whitespace-only or otherwise empty-after-trim values pass both schema and downstream checks.
- **Correct approach**: Validate every `evidenceRefs` element as a non-empty string after trimming, with the same per-index error style used by the evidence array. Keep structural validation responsible for emptiness; the binding helper is responsible only for membership.
- **How to prevent**: Whenever a schema constrains an array of strings, check element content at the same boundary as the array length when downstream logic trims or normalizes the value. A trim in the consumer is a signal that the producer validator is incomplete.
- **Regression guard**: `diag-rootcause-output.test.ts` adds `rejects whitespace-only causalChain evidenceRefs elements`; it failed against the pre-fix validator (`expected true to be false`) and passes after the per-element check.
- **Source**: PR #2244 review follow-up (PRI-1059 Stage A evidence binding), CodeRabbit finding on `evidence-ref-binding.ts`
- **Date**: 2026-10-31
- **Recurrence**: Pre-existing validator gap made reachable by the new binding gate; first structured occurrence.
