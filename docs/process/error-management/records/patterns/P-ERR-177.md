<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-177",
  "displayId": "ERR-177",
  "title": "Evidence allowlist widened beyond the rendered prompt and reserved sentinel accepted from generic data",
  "status": "active",
  "category": "Security & Safety",
  "ep": "EP-01",
  "createdAt": "2026-10-31",
  "source": "PRI-1059 / PR #2244 review"
}
-->

- **What happened**: The first PRI-1059 implementation built the trusted evidence-ref set from `context.contextRefs` plus `payload.sourceRefs`, then added the reserved `owner_correction` sentinel only when correction evidence existed. Review found two widenings of the actual trust boundary: `contextRefs` also contains predecessor task/artifact refs that are never rendered into the Stage A prompt, and the generic `sourceRefs`/`diagnosisTarget.evidence` routes could already contain the literal `owner_correction`, so ordinary pain evidence could impersonate the reserved sentinel even when no Owner correction was supplied.
- **Why it's wrong**: A validator must allow exactly the evidence provenance the untrusted producer was shown. Unioning internal channels that the model never saw creates valid-looking refs outside the prompt contract. Treating a reserved sentinel as an ordinary string lets the data plane forge the semantic condition the sentinel is supposed to represent.
- **Generalized failure mode**: An allowlist is assembled from every internal context channel instead of the exact projection rendered to the untrusted producer; reserved/synthetic references are accepted through generic data fields rather than being enabled only by their owning evidence condition.
- **Correct approach**: Build trusted refs from `payload.sourceRefs` and `payload.diagnosisTarget.evidence` only. Exclude `owner_correction` from all generic routes and add it explicitly, and only when `diagnosisTarget.correctionEvidence` is present. Runner-only predecessor refs must never participate because the prompt does not render them.
- **How to prevent**: For any LLM trust-boundary validator, derive the allowed set from the serialized prompt projection or its authoritative payload, not from the runner's broader context object. Treat reserved sentinels as capabilities: one named condition enables them; ordinary data fields cannot.
- **Regression guard**: `evidence-ref-binding.test.ts` pins (a) refs absent from the rendered payload are rejected, and (b) `owner_correction` smuggled through `sourceRefs`/`evidence` without `correctionEvidence` is rejected while the legitimate correction path still passes.
- **Source**: PR #2244 review (PRI-1059 Stage A evidence binding)
- **Date**: 2026-10-31
- **Recurrence**: First recorded occurrence for this mechanism.
