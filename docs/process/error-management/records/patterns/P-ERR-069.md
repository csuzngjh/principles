<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-069",
  "displayId": "ERR-069",
  "title": "Adapter `runHandle` hardcodes `status:'succeeded'` absent from `RunHandleSchema` (masked by `as RunHandle`); degradation path trusts validator-rejected candidate — two trust-boundary breaches in `ArtificerL2Adapter`",
  "status": "active",
  "category": "Schema & Type Mistakes",
  "ep": "EP-01",
  "createdAt": "2026-06-21",
  "source": "unknown"
}
-->

**Recurrence**: 2026-06-21 PR #993 — Artificer prompt requested retired `implementationPlan` while validator required `implementationSummary` (coding against remembered contract). Fixed by aligning prompt+schema on V2 + negative assertions for retired V1 field. Original found in self-review (commit c396ed92).
