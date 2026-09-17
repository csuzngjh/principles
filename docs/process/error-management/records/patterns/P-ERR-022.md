<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-022",
  "displayId": "ERR-022",
  "title": "process.exit(1) without return allows fallthrough to intake on failed diagnosis",
  "status": "active",
  "category": "Documentation & Spec Drift",
  "ep": "EP-04",
  "createdAt": "2026-05-22",
  "source": "PRI-217 / PR #677",
  "undatedRecurrences": [
    "See git history for full incident detail."
  ]
}
-->

**Recurrence**: Yes — `process.exit(1)` without `return` allows fallthrough when exit is stubbed.
