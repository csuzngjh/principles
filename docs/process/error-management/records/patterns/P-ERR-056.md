<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-056",
  "displayId": "ERR-056",
  "title": "Redaction pipeline truncates string values without running path/token/env redactors — secrets slip through",
  "status": "archived",
  "category": null,
  "ep": "EP-08",
  "createdAt": "2026-06-01",
  "source": "PRI-285 / PR #767",
  "undatedRecurrences": [
    "Cross-platform portability variant: path op works on Windows dev machine but silently fails on Linux CI."
  ]
}
-->

**Recurrence**: Same class as ERR-014, ERR-016, ERR-017 (previews/serialization not bounded/safe).
