<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-004",
  "displayId": "ERR-004",
  "title": "`sourceTaskId` set to diagnostician task ID instead of located source task ID",
  "status": "active",
  "category": "Schema & Type Mistakes",
  "ep": "EP-07",
  "createdAt": "2026-05-19",
  "source": "PRI-190",
  "undatedRecurrences": [
    "Pattern: lineage from unverified task or non-atomic read-then-write. Fix: verify task kind; atomic writes; mismatch regression tests."
  ]
}
-->

**Recurrence**: Yes — lineage/source fields come from the wrong task or are racy across a read-then-write.
