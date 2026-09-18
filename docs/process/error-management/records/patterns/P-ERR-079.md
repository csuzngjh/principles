<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-079",
  "displayId": "ERR-079",
  "title": "Concurrency-primitive hardening gaps (age-based lock eviction, busy-spin retry) silently re-open the data-loss class the primitive was added to prevent",
  "status": "active",
  "category": "Security & Safety",
  "ep": "EP-03",
  "createdAt": "2026-06-25",
  "source": "PRI-459 / PR #1045"
}
-->

**Recurrence**: 2026-07-16 PR #1230 / PRI-516: retry deduplication claimed a run before turn-index resolution and synchronous signal collection completed, so a trajectory or detector failure caused the next retry to be skipped. Fixed by claiming only after successful detection and adding a fail -> retry success -> duplicate skip regression test.
