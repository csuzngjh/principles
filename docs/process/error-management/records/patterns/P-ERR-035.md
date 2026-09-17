<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-035",
  "displayId": "ERR-035",
  "title": "Static guard only covers frozen-basename dynamic imports, misses other legacy paths",
  "status": "active",
  "category": "Documentation & Spec Drift",
  "ep": "EP-02",
  "createdAt": "2026-05-24",
  "source": "PRI-227 / PR #701",
  "undatedRecurrences": [
    "Fix: update enforcement check when adding guarded items; match at segment boundaries, never substrings."
  ]
}
-->

**Recurrence**: Same class as ERR-024/ERR-025 — static guard/extractor added but real enforcement path not updated, or pattern matches substring not segment.
